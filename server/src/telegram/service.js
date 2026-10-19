// Telegram integration for one server: each account connects its own bot from the dashboard. The server
// configures the bot (name, picture, commands, webhook), links chats with one-time codes, answers
// /usage and sends near-limit / limit-hit alerts after reports.
import { randomBytes } from 'node:crypto';
import { safeEqual } from '../auth.js';
import { HttpError } from '../http.js';
import { alertCandidates, DEFAULT_ALERTS, evaluateAlerts, validateAlertSettings } from './alerts.js';
import { alertText, duration, escapeHtml, usageText } from './format.js';

export const BOT_NAME = 'Claude Usage Tracker';
const BOT_TOKEN_RE = /^\d{5,15}:[\w-]{30,60}$/;
const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_CHATS = 10;
const MAX_CHAT_NAME = 64;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN = 403;
const COMMANDS = [
  { command: 'usage', description: 'Plan usage and every device' },
  { command: 'devices', description: 'Devices and when they last synced' },
  { command: 'alerts', description: 'Your alert settings' },
  { command: 'stop', description: 'Stop messages to this chat' },
  { command: 'help', description: 'What this bot can do' },
];
const DESCRIPTION =
  'Your Claude plan usage across every device: 5-hour and weekly limits, per-device share and caps, Codex and other coding agents. ' +
  'Alerts when you get close to a limit. Open the link from your Claude Usage Tracker dashboard to connect.';
const SHORT_DESCRIPTION = 'Claude plan usage per device, with near-limit alerts.';
const PRIVATE_REPLY =
  'This bot is private. To connect, open <b>Telegram → Link a chat</b> on your Claude Usage Tracker dashboard.';
const HELP =
  '<b>Claude Usage Tracker</b>\n/usage — plan usage and every device\n/devices — devices and last sync\n/alerts — alert settings\n/stop — stop messages here';

const randomId = (bytes) => randomBytes(bytes).toString('hex');
const randomCode = () => randomBytes(12).toString('base64url');
const cleanName = (value) => String(value ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_CHAT_NAME) || 'Telegram chat';
const chatName = (chat) => cleanName(chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username));

/** The public https origin Telegram should call; dev servers on localhost may use http. */
export function webhookBase(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new HttpError(400, 'cannot tell the public URL of this server — set PUBLIC_URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new HttpError(400, 'Telegram needs an https address for this server — open the dashboard over https or set PUBLIC_URL');
  }
  return url.origin;
}

function parseCommand(text) {
  const match = /^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/s.exec(String(text ?? '').trim());
  return match ? { name: match[1].toLowerCase(), arg: (match[2] ?? '').trim() } : null;
}

/**
 * @param {{ db: object, api: object, box: object, avatar?: Buffer|null, publicUrl?: string,
 *           getSummary: (userId: number) => object, log?: (msg: string) => void }} deps
 */
export function createTelegramService({ db, api, box, avatar = null, publicUrl, getSummary, log = () => {} }) {
  const tokenOf = (bot) => box.open(bot.tokenSealed);
  const alertSettings = (userId) => db.getAlertSettings(userId) ?? DEFAULT_ALERTS;

  async function send(bot, chatId, text) {
    try {
      await api.call(tokenOf(bot), 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return true;
    } catch (error) {
      // The user blocked the bot or left the group: stop sending there.
      if (error.code === FORBIDDEN) db.removeChat(bot.userId, chatId);
      log(`telegram send to chat failed: ${error.message}`);
      return false;
    }
  }

  function status(user) {
    const bot = db.getBot(user.id);
    const linkActive = bot?.linkCode && Date.parse(bot.linkExpiresAt) > Date.now();
    return {
      connected: Boolean(bot),
      bot: bot ? { username: bot.username, name: BOT_NAME, url: `https://t.me/${bot.username}` } : null,
      chats: bot ? db.listChats(user.id) : [],
      link: linkActive ? { url: `https://t.me/${bot.username}?start=${bot.linkCode}`, expiresAt: bot.linkExpiresAt } : null,
      alerts: alertSettings(user.id),
    };
  }

  /** Best-effort profile setup: each step reports ok/error, none blocks the connection. */
  async function configureProfile(token) {
    const steps = [
      ['Name', () => api.call(token, 'setMyName', { name: BOT_NAME })],
      ['Description', () => api.call(token, 'setMyDescription', { description: DESCRIPTION })],
      ['Short description', () => api.call(token, 'setMyShortDescription', { short_description: SHORT_DESCRIPTION })],
      ['Commands', () => api.call(token, 'setMyCommands', { commands: COMMANDS })],
      ['Profile photo', () => (avatar ? api.setProfilePhoto(token, avatar) : Promise.reject(new Error('no avatar file')))],
    ];
    const results = [];
    for (const [step, run] of steps) {
      try {
        await run();
        results.push({ step, ok: true });
      } catch (error) {
        results.push({ step, ok: false, error: error.message });
      }
    }
    return results;
  }

  async function connect(user, body, requestOrigin) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!BOT_TOKEN_RE.test(token)) throw new HttpError(400, 'that does not look like a bot token from @BotFather (123456:ABC…)');
    const base = webhookBase(publicUrl || requestOrigin);
    let me;
    try {
      me = await api.call(token, 'getMe');
    } catch (error) {
      throw new HttpError(400, `Telegram rejected this token: ${error.message}`);
    }
    const owner = db.getBotByBotId(me.id);
    if (owner && owner.userId !== user.id) throw new HttpError(409, 'this bot is already connected to another account');
    const previous = db.getBot(user.id);
    const webhookId = randomId(16);
    const webhookSecret = randomCode() + randomCode();
    try {
      await api.call(token, 'setWebhook', {
        url: `${base}/telegram/webhook/${webhookId}`,
        secret_token: webhookSecret,
        allowed_updates: ['message'],
        drop_pending_updates: true,
      });
    } catch (error) {
      throw new HttpError(502, `could not register the webhook with Telegram: ${error.message}`);
    }
    if (previous && previous.botId !== me.id) {
      await api.call(tokenOf(previous), 'deleteWebhook', {}).catch(() => {});
      db.deleteBot(user.id);
    }
    db.saveBot(user.id, { botId: me.id, username: me.username, tokenSealed: box.seal(token), webhookId, webhookSecret, createdAt: new Date().toISOString() });
    const setup = await configureProfile(token);
    return { ...status(user), setup };
  }

  async function disconnect(user) {
    const bot = db.getBot(user.id);
    if (!bot) throw new HttpError(404, 'no bot connected');
    await api.call(tokenOf(bot), 'deleteWebhook', { drop_pending_updates: true }).catch((error) => log(`telegram deleteWebhook failed: ${error.message}`));
    db.deleteBot(user.id);
    return status(user);
  }

  function createLink(user) {
    const bot = db.getBot(user.id);
    if (!bot) throw new HttpError(404, 'connect a bot first');
    db.setLinkCode(user.id, randomCode(), new Date(Date.now() + LINK_TTL_MS).toISOString());
    return status(user).link;
  }

  function unlinkChat(user, rawChatId) {
    const chatId = Number(rawChatId);
    if (!Number.isSafeInteger(chatId) || !db.removeChat(user.id, chatId)) throw new HttpError(404, 'chat not found');
    return status(user);
  }

  function setAlerts(user, body) {
    let settings;
    try {
      settings = validateAlertSettings(body);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    db.setAlertSettings(user.id, settings);
    return status(user);
  }

  async function sendTest(user) {
    const bot = db.getBot(user.id);
    const chats = bot ? db.listChats(user.id) : [];
    if (!chats.length) throw new HttpError(400, 'link a Telegram chat first');
    const results = await Promise.all(chats.map((c) => send(bot, c.id, '✅ Test message from <b>Claude Usage Tracker</b>. Alerts will arrive here.')));
    return { sent: results.filter(Boolean).length, chats: chats.length };
  }

  function devicesText(summary) {
    const devices = summary.devices ?? [];
    if (!devices.length) return 'No devices yet.';
    const lines = devices.map((d) => `• <b>${escapeHtml(d.name)}</b> — synced ${duration(Date.now() - Date.parse(d.reportedAt))} ago`);
    return ['<b>Devices</b>', ...lines].join('\n');
  }

  function alertsText(userId) {
    const s = alertSettings(userId);
    if (!s.enabled) return 'Alerts are <b>off</b>. Turn them on from your dashboard.';
    const parts = [s.near && `near the limit (${s.nearPct}%)`, s.hit && 'limit reached', s.caps && 'per-device caps', s.agents && 'Codex and other agents'];
    return `Alerts are <b>on</b>: ${parts.filter(Boolean).join(', ') || 'nothing selected'}. Change them on your dashboard.`;
  }

  async function linkChat(bot, chat, code) {
    const valid = code && bot.linkCode && safeEqual(code, bot.linkCode) && Date.parse(bot.linkExpiresAt) > Date.now();
    if (!valid) return send(bot, chat.id, PRIVATE_REPLY);
    if (db.listChats(bot.userId).length >= MAX_CHATS) return send(bot, chat.id, `This account already has ${MAX_CHATS} linked chats. Unlink one on the dashboard first.`);
    db.setLinkCode(bot.userId, null, null); // one use only
    db.addChat(bot.userId, chat.id, chatName(chat), new Date().toISOString());
    await send(bot, chat.id, `✅ Linked to <b>${BOT_NAME}</b>. You'll get alerts here.\n\n${usageText(getSummary(bot.userId))}`);
    return true;
  }

  async function handleCommand(bot, chat, command) {
    const isLinked = db.listChats(bot.userId).some((c) => c.id === chat.id);
    if (command?.name === 'start' && !isLinked) return linkChat(bot, chat, command.arg);
    if (!isLinked) return send(bot, chat.id, PRIVATE_REPLY);
    const summary = () => getSummary(bot.userId);
    switch (command?.name) {
      case 'start':
      case 'usage':
      case 'status':
        return send(bot, chat.id, usageText(summary()));
      case 'devices':
        return send(bot, chat.id, devicesText(summary()));
      case 'alerts':
        return send(bot, chat.id, alertsText(bot.userId));
      case 'stop':
        db.removeChat(bot.userId, chat.id);
        return send(bot, chat.id, 'Unlinked. This chat gets no more messages. Link it again from the dashboard any time.');
      default:
        return send(bot, chat.id, HELP);
    }
  }

  /** Telegram → webhook. Verifies the secret header, then answers the command. */
  async function handleWebhook(webhookId, secretHeader, update) {
    const bot = db.getBotByWebhook(webhookId);
    if (!bot) throw new HttpError(404, 'not found');
    if (!safeEqual(String(secretHeader ?? ''), bot.webhookSecret)) throw new HttpError(401, 'bad secret');
    const message = update?.message;
    if (!message?.chat || !Number.isSafeInteger(message.chat.id) || typeof message.text !== 'string') return { ok: true };
    await handleCommand(bot, message.chat, parseCommand(message.text));
    return { ok: true };
  }

  /** After a report: send any new near-limit / limit-hit alerts to the account's linked chats. */
  async function notify(user, summary) {
    const bot = db.getBot(user.id);
    const chats = bot ? db.listChats(user.id) : [];
    if (!chats.length) return;
    const { alerts, state } = evaluateAlerts(alertCandidates(summary), alertSettings(user.id), db.getAlertState(user.id));
    if (!alerts.length) return;
    db.setAlertState(user.id, state);
    const text = alerts.map((a) => alertText(a)).join('\n');
    await Promise.all(chats.map((c) => send(bot, c.id, text)));
  }

  return { status, connect, disconnect, createLink, unlinkChat, setAlerts, sendTest, handleWebhook, notify };
}
