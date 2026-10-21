// Telegram integration: each account connects its own bot from the dashboard. The server configures the
// bot (name, picture, menu, webhook), links chats with one-time codes, answers the button keyboard and
// inline buttons, sends near-limit / limit-hit alerts after reports, and on request asks whose usage outside Claude Code was.
import { randomBytes } from 'node:crypto';
import { safeEqual } from '../auth.js';
import { HttpError } from '../http.js';
import { assignEvent, claimOutside, EMPTY_OUTSIDE, ignoreEvent, pendingEvents } from '../outside.js';
import { alertCandidates, evaluateAlerts, normalizeAlertSettings, validateAlertSettings } from './alerts.js';
import { alertText } from './format.js';
import { alertsView, deviceKey, devicesView, helpView, MAIN_KEYBOARD, menuAction, OUTSIDE_SPLIT, outsideView, usageView } from './views.js';

export const BOT_NAME = 'Claude Usage Tracker';
const BOT_TOKEN_RE = /^\d{5,15}:[\w-]{30,60}$/;
const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_CHATS = 10;
const MAX_CHAT_NAME = 64;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN = 403;
const ALLOWED_UPDATES = ['message', 'callback_query'];
const COMMANDS = [{ command: 'start', description: 'Open the menu' }];
const NEAR_CHOICES = new Set([70, 80, 90]);
const TOGGLE_KEYS = new Set(['enabled', 'near', 'hit', 'agents']);
const DESCRIPTION =
  '📊 Your Claude plan usage across every device: 5-hour and weekly limits, each device\'s share and caps, Codex and other coding agents.\n' +
  '🔔 Alerts when a device gets close to its limit.\nOpen the link from your Claude Usage Tracker dashboard to connect.';
const SHORT_DESCRIPTION = '📊 Claude plan usage per device, with 🔔 near-limit alerts.';
const PRIVATE_REPLY = '🔒 This bot is private.\nTo connect, open <b>Telegram → Link a chat</b> on your Claude Usage Tracker dashboard.';
const PRIVATE_TOAST = '🔒 This bot is private and this chat is not linked. Use Link a chat on the dashboard.';

const randomId = (bytes) => randomBytes(bytes).toString('hex');
const randomCode = () => randomBytes(12).toString('base64url');
const cleanName = (value) => String(value ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_CHAT_NAME) || 'Telegram chat';
const chatName = (chat) => cleanName(chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username));
const startCode = (text) => /^\/start(?:@\w+)?\s+([\w-]+)/.exec(String(text ?? '').trim())?.[1] ?? '';
const NOT_MODIFIED = /message is not modified/i;

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

/**
 * @param {{ db: object, api: object, box: object, avatar?: Buffer|null, publicUrl?: string,
 *           getSummary: (userId: number) => object, log?: (msg: string) => void }} deps
 */
export function createTelegramService({ db, api, box, avatar = null, publicUrl, getSummary, log = () => {} }) {
  const tokenOf = (bot) => box.open(bot.tokenSealed);
  const alertSettings = (userId) => normalizeAlertSettings(db.getAlertSettings(userId));
  const isLinked = (bot, chatId) => db.listChats(bot.userId).some((c) => c.id === chatId);
  const outsideState = (userId) => db.getOutsideState(userId) ?? EMPTY_OUTSIDE;
  const deviceNames = (userId) => (getSummary(userId).devices ?? []).map((d) => d.name);

  async function send(bot, chatId, { text, reply_markup: replyMarkup }) {
    try {
      await api.call(tokenOf(bot), 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: replyMarkup });
      return true;
    } catch (error) {
      // The user blocked the bot or left the group: stop sending there.
      if (error.code === FORBIDDEN) db.removeChat(bot.userId, chatId);
      log(`telegram send to chat failed: ${error.message}`);
      return false;
    }
  }

  async function edit(bot, chatId, messageId, { text, reply_markup: replyMarkup }) {
    try {
      await api.call(tokenOf(bot), 'editMessageText', {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: replyMarkup,
      });
    } catch (error) {
      if (!NOT_MODIFIED.test(error.message)) log(`telegram edit failed: ${error.message}`);
    }
  }

  const toast = (bot, callbackId, text, showAlert = false) =>
    api.call(tokenOf(bot), 'answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: showAlert }).catch((error) => log(`telegram answer failed: ${error.message}`));

  function deviceList(userId, settings) {
    return (getSummary(userId).devices ?? []).map((d) => ({
      name: d.name,
      subscribed: settings.devices.includes(d.name),
      caps: { fiveHour: d.limits?.fiveHour ?? null, sevenDay: d.limits?.sevenDay ?? null },
    }));
  }

  function status(user) {
    const bot = db.getBot(user.id);
    const alerts = alertSettings(user.id);
    const linkActive = bot?.linkCode && Date.parse(bot.linkExpiresAt) > Date.now();
    return {
      connected: Boolean(bot),
      bot: bot ? { username: bot.username, name: BOT_NAME, url: `https://t.me/${bot.username}` } : null,
      chats: bot ? db.listChats(user.id) : [],
      link: linkActive ? { url: `https://t.me/${bot.username}?start=${bot.linkCode}`, expiresAt: bot.linkExpiresAt } : null,
      alerts,
      devices: deviceList(user.id, alerts),
    };
  }

  /** Best-effort profile setup: each step reports ok/error, none blocks the connection. */
  async function configureProfile(token) {
    const steps = [
      ['Name', () => api.call(token, 'setMyName', { name: BOT_NAME })],
      ['Description', () => api.call(token, 'setMyDescription', { description: DESCRIPTION })],
      ['Short description', () => api.call(token, 'setMyShortDescription', { short_description: SHORT_DESCRIPTION })],
      ['Menu', () => api.call(token, 'setMyCommands', { commands: COMMANDS })],
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
      await api.call(token, 'setWebhook', { url: `${base}/telegram/webhook/${webhookId}`, secret_token: webhookSecret, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: true });
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
    if (!db.getBot(user.id)) throw new HttpError(404, 'connect a bot first');
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
    const message = { text: '✅ <b>Test message</b> from Claude Usage Tracker.\n🔔 Your alerts will arrive in this chat.' };
    const results = await Promise.all(chats.map((c) => send(bot, c.id, message)));
    return { sent: results.filter(Boolean).length, chats: chats.length };
  }

  async function linkChat(bot, chat, code) {
    const valid = code && bot.linkCode && safeEqual(code, bot.linkCode) && Date.parse(bot.linkExpiresAt) > Date.now();
    if (!valid) return send(bot, chat.id, { text: PRIVATE_REPLY });
    if (db.listChats(bot.userId).length >= MAX_CHATS) {
      return send(bot, chat.id, { text: `⚠️ This account already has ${MAX_CHATS} linked chats. Unlink one on the dashboard first.` });
    }
    db.setLinkCode(bot.userId, null, null); // one use only
    db.addChat(bot.userId, chat.id, chatName(chat), new Date().toISOString());
    const usage = usageView(getSummary(bot.userId), alertSettings(bot.userId));
    return send(bot, chat.id, { text: `✅ Linked to <b>${BOT_NAME}</b>!\nUse the buttons below. Alerts will arrive here.\n\n${usage.text}`, reply_markup: MAIN_KEYBOARD });
  }

  async function handleMessage(bot, chat, text) {
    const action = menuAction(text);
    if (!isLinked(bot, chat.id)) return action === 'start' ? linkChat(bot, chat, startCode(text)) : send(bot, chat.id, { text: PRIVATE_REPLY });
    const settings = () => alertSettings(bot.userId);
    switch (action) {
      case 'usage':
        return send(bot, chat.id, usageView(getSummary(bot.userId), settings()));
      case 'devices':
        return send(bot, chat.id, devicesView(getSummary(bot.userId), settings()));
      case 'alerts':
        return send(bot, chat.id, alertsView(settings(), getSummary(bot.userId)));
      case 'stop':
        db.removeChat(bot.userId, chat.id);
        return send(bot, chat.id, { text: '👋 Unlinked. This chat gets no more messages.\nLink it again from the dashboard any time.', reply_markup: { remove_keyboard: true } });
      default:
        return send(bot, chat.id, helpView());
    }
  }

  function toggleDevice(bot, key) {
    const summary = getSummary(bot.userId);
    const device = (summary.devices ?? []).find((d) => deviceKey(d.name) === key);
    if (!device) return { note: '⚠️ That device is gone — tap 🔄 Refresh.' };
    const settings = alertSettings(bot.userId);
    const isOn = settings.devices.includes(device.name);
    const devices = isOn ? settings.devices.filter((n) => n !== device.name) : [...settings.devices, device.name];
    db.setAlertSettings(bot.userId, { ...settings, devices });
    if (isOn) return { note: `🔕 Alerts off for ${device.name}` };
    const hasCap = device.limits?.fiveHour != null || device.limits?.sevenDay != null;
    return { note: hasCap ? `🔔 Alerts on for ${device.name}` : `🔔 Alerts on for ${device.name} — it has no cap yet. Set one on the dashboard.`, warn: !hasCap };
  }

  function changeSetting(bot, name) {
    const settings = alertSettings(bot.userId);
    const threshold = /^p(\d+)$/.exec(name)?.[1];
    if (threshold && NEAR_CHOICES.has(Number(threshold))) {
      db.setAlertSettings(bot.userId, { ...settings, nearPct: Number(threshold) });
      return `✅ Near-limit alerts at ${threshold}%`;
    }
    if (!TOGGLE_KEYS.has(name)) return null;
    db.setAlertSettings(bot.userId, { ...settings, [name]: !settings[name] });
    return '✅ Saved';
  }

  /** Assigns usage outside Claude Code to a device, or splits it by usage (OUTSIDE_SPLIT). Returns the toast. */
  async function answerOutside(bot, chatId, messageId, id, key) {
    const state = outsideState(bot.userId);
    const names = deviceNames(bot.userId);
    const event = state.events.find((e) => e.id === id);
    if (!event) {
      await edit(bot, chatId, messageId, outsideView(null, names, 'expired'));
      return '⌛ Already answered, or its window has reset';
    }
    if (key === OUTSIDE_SPLIT) {
      db.setOutsideState(bot.userId, ignoreEvent(state, id));
      await edit(bot, chatId, messageId, outsideView(event, names, 'split'));
      return '🙈 Split by Claude Code usage';
    }
    const device = names.find((n) => deviceKey(n) === key);
    if (!device) return '⚠️ That device is gone — tap 🔄 Refresh.';
    const assigned = assignEvent(state, id, device);
    db.setOutsideState(bot.userId, assigned.state);
    await edit(bot, chatId, messageId, outsideView(assigned.event, names));
    // The device's share just grew: it may now be near or over its cap.
    await notify({ id: bot.userId }, getSummary(bot.userId)).catch((error) => log(`telegram alerts failed: ${error.message}`));
    return `✅ Counted for ${device}`;
  }

  /** 🧭 "o:ask" re-asks about every unanswered usage outside Claude Code; "o:<event>:<device key>" answers. */
  async function handleOutside(bot, chatId, messageId, id, key) {
    if (id !== 'ask') return answerOutside(bot, chatId, messageId, id, key);
    const state = outsideState(bot.userId);
    let pending = pendingEvents(state);
    if (!pending.length) {
      // Not asked about yet (below the threshold): make it a question now.
      const claimed = claimOutside(state, db.listReports(bot.userId), null);
      if (!claimed?.event) return '✅ Nothing to assign';
      db.setOutsideState(bot.userId, claimed.state);
      pending = [claimed.event];
    }
    const names = deviceNames(bot.userId);
    for (const event of pending) await send(bot, chatId, outsideView(event, names));
    return '';
  }

  /** Inline button taps. Every tap gets an answer (Telegram shows a spinner until then). */
  async function handleCallback(bot, query) {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (!Number.isSafeInteger(chatId) || !isLinked(bot, chatId)) return toast(bot, query.id, PRIVATE_TOAST, true);
    const [scope, value = '', extra = ''] = String(query.data ?? '').split(':');
    const summary = () => getSummary(bot.userId);
    const settings = () => alertSettings(bot.userId);
    if (scope === 'u') {
      if (value === 'show') await send(bot, chatId, usageView(summary(), settings()));
      else await edit(bot, chatId, messageId, usageView(summary(), settings()));
      return toast(bot, query.id, '🔄 Updated');
    }
    if (scope === 'd' && value === 'show') {
      await edit(bot, chatId, messageId, devicesView(summary(), settings()));
      return toast(bot, query.id, '');
    }
    if (scope === 'd') {
      const { note, warn } = toggleDevice(bot, value);
      await edit(bot, chatId, messageId, devicesView(summary(), settings()));
      return toast(bot, query.id, note, Boolean(warn));
    }
    if (scope === 'o') return toast(bot, query.id, await handleOutside(bot, chatId, messageId, value, extra));
    if (scope === 'a') {
      const note = value === 'show' ? '' : changeSetting(bot, value);
      await edit(bot, chatId, messageId, alertsView(settings(), summary()));
      return toast(bot, query.id, note ?? '');
    }
    return toast(bot, query.id, '');
  }

  /** Telegram → webhook. Verifies the secret header, then handles a message or a button tap. */
  async function handleWebhook(webhookId, secretHeader, update) {
    const bot = db.getBotByWebhook(webhookId);
    if (!bot) throw new HttpError(404, 'not found');
    if (!safeEqual(String(secretHeader ?? ''), bot.webhookSecret)) throw new HttpError(401, 'bad secret');
    if (update?.callback_query?.id) {
      await handleCallback(bot, update.callback_query);
      return { ok: true };
    }
    const message = update?.message;
    if (message?.chat && Number.isSafeInteger(message.chat.id) && typeof message.text === 'string') await handleMessage(bot, message.chat, message.text);
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
    const message = { text: alerts.map((a) => alertText(a)).join('\n\n'), reply_markup: { inline_keyboard: [[{ text: '📊 Open usage', callback_data: 'u:show' }]] } };
    await Promise.all(chats.map((c) => send(bot, c.id, message)));
  }

  /** Bots connected before inline buttons existed only receive messages: also subscribe them to button taps. */
  async function upgradeWebhooks() {
    for (const bot of db.listBots()) {
      try {
        const token = tokenOf(bot);
        const info = await api.call(token, 'getWebhookInfo');
        if (!info?.url || (info.allowed_updates ?? []).includes('callback_query')) continue;
        await api.call(token, 'setWebhook', { url: info.url, secret_token: bot.webhookSecret, allowed_updates: ALLOWED_UPDATES });
        await api.call(token, 'setMyCommands', { commands: COMMANDS });
      } catch (error) {
        log(`telegram webhook upgrade failed for @${bot.username}: ${error.message}`);
      }
    }
  }

  return { status, connect, disconnect, createLink, unlinkChat, setAlerts, sendTest, handleWebhook, notify, upgradeWebhooks };
}
