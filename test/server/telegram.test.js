import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, startServer } from '../../server/src/server.js';
import { deviceKey } from '../../server/src/telegram/views.js';

const BOT_TOKEN = `424242:${'A'.repeat(35)}`;
const ORIGIN = 'https://usage.example.com';
const BLOCKED_CHAT = 333;
let dataDir;
const servers = [];

/** Fake Bot API: records calls, answers like Telegram. `overrides[method]` replaces a result. */
function fakeTelegram(overrides = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const [, token, method] = new URL(url).pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    const params = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
    calls.push({ token, method, params });
    if (token !== BOT_TOKEN) return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 });
    if (method === 'sendMessage' && params.chat_id === BLOCKED_CHAT) {
      return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
    }
    const results = { getMe: { id: 4242, is_bot: true, first_name: 'x', username: 'my_usage_bot' }, sendMessage: { message_id: calls.length }, ...overrides };
    return Response.json({ ok: true, result: results[method] ?? true });
  };
  const of = (method, chatId) => calls.filter((c) => c.method === method && (chatId === undefined || c.params.chat_id === chatId));
  return { calls, fetch, of, sent: (chatId) => of('sendMessage', chatId).map((c) => c.params.text) };
}

async function boot({ dir, overrides } = {}) {
  const dataPath = dir ?? (await mkdtemp(join(dataDir, 'srv-')));
  const tg = fakeTelegram(overrides);
  const settings = { ...readSettings({ DATA_DIR: dataPath }), port: 0, outsideSettleMs: 0, telegram: { fetch: tg.fetch, avatar: Buffer.from('jpg') } };
  const server = await startServer(settings);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  const register = async () => (await call('POST', '/api/register')).json.data.token;
  return { tg, call, register, server, dataPath };
}

/** Connects the bot and returns helpers that act like Telegram delivering updates. */
async function connected(ctx, token) {
  await ctx.call('POST', '/api/telegram', { token, body: { token: BOT_TOKEN }, headers: { Origin: ORIGIN } });
  const hook = ctx.tg.of('setWebhook').at(-1).params;
  const path = new URL(hook.url).pathname;
  const headers = { 'X-Telegram-Bot-Api-Secret-Token': hook.secret_token };
  const chat = (id) => ({ id, type: 'private', first_name: 'Javo' });
  const send = (chatId, text, hdrs = headers) => ctx.call('POST', path, { body: { update_id: 1, message: { message_id: 1, chat: chat(chatId), text } }, headers: hdrs });
  const tap = (chatId, data) =>
    ctx.call('POST', path, { body: { update_id: 2, callback_query: { id: `cb${Math.random()}`, data, message: { message_id: 77, chat: chat(chatId) } } }, headers });
  const link = async (chatId) => {
    const { url } = (await ctx.call('POST', '/api/telegram/link', { token })).json.data;
    return send(chatId, `/start ${new URL(url).searchParams.get('start')}`);
  };
  return { hook, path, send, tap, link };
}

const report = (fivePct, { device = 'Work Mac', share, surfaces } = {}) => ({
  device,
  reportedAt: new Date().toISOString(),
  surfaces,
  account: {
    fiveHour: { pct: fivePct, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    sevenDay: { pct: 20, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
  },
  local: { fiveHour: { costUSD: share ?? 1, tokens: 10 }, sevenDay: { costUSD: 5, tokens: 50 } },
});

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cut-tg-'));
});

after(async () => {
  await Promise.all(servers.filter((s) => s.listening).map((s) => new Promise((r) => s.close(r))));
  await rm(dataDir, { recursive: true, force: true });
});

test('connect configures the bot; linking shows the button keyboard', async () => {
  const ctx = await boot();
  const token = await ctx.register();
  assert.equal((await ctx.call('GET', '/api/telegram', { token })).json.data.connected, false);
  assert.equal((await ctx.call('POST', '/api/telegram', { token, body: { token: 'nope' }, headers: { Origin: ORIGIN } })).status, 400);
  const rejected = await ctx.call('POST', '/api/telegram', { token, body: { token: `424242:${'B'.repeat(35)}` }, headers: { Origin: ORIGIN } });
  assert.match(rejected.json.error, /Telegram rejected/);

  const res = await ctx.call('POST', '/api/telegram', { token, body: { token: BOT_TOKEN }, headers: { Origin: ORIGIN } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.data.setup.every((s) => s.ok), JSON.stringify(res.json.data.setup));
  assert.doesNotMatch(JSON.stringify(res.json), /AAAAAAAAAA/, 'the bot token never comes back');
  const byMethod = Object.fromEntries(ctx.tg.calls.filter((c) => c.token === BOT_TOKEN).map((c) => [c.method, c.params]));
  assert.equal(byMethod.setMyName.name, 'Claude Usage Tracker');
  assert.deepEqual(byMethod.setMyCommands.commands.map((c) => c.command), ['start'], 'buttons replace slash commands');
  assert.match(byMethod.setMyProfilePhoto.photo, /"type":"static"/);
  assert.match(byMethod.setWebhook.url, /^https:\/\/usage\.example\.com\/telegram\/webhook\/[a-f0-9]{32}$/);
  assert.deepEqual(byMethod.setWebhook.allowed_updates, ['message', 'callback_query']);

  const bot = await connected(ctx, token);
  const { url } = (await ctx.call('POST', '/api/telegram/link', { token })).json.data;
  const code = new URL(url).searchParams.get('start');
  assert.equal((await bot.send(111, `/start ${code}`, {})).status, 401, 'webhook needs the secret');
  await bot.send(111, `/start ${code}`);
  const welcome = ctx.tg.of('sendMessage', 111).at(-1).params;
  assert.match(welcome.text, /✅ Linked/);
  assert.deepEqual(welcome.reply_markup.keyboard.flat().map((b) => b.text), ['📊 Usage', '💻 Devices', '🔔 Alerts', '❓ Help']);
  await bot.send(222, `/start ${code}`); // codes work once
  await bot.send(222, '📊 Usage');
  assert.ok(ctx.tg.sent(222).every((t) => /private/i.test(t)), 'unlinked chats get no data');
});

test('keyboard buttons, per-device alert toggles and alert settings from Telegram', async () => {
  const ctx = await boot();
  const token = await ctx.register();
  const bot = await connected(ctx, token);
  await ctx.call('POST', '/api/report', { token, body: report(10) });
  await ctx.call('POST', '/api/report', { token, body: report(10, { device: 'Home PC' }) });
  await ctx.call('PUT', '/api/devices/Work%20Mac/limits', { token, body: { fiveHour: 50, sevenDay: 50, enforce: false } });
  await bot.link(111);

  await bot.send(111, '📊 Usage');
  const usage = ctx.tg.of('sendMessage', 111).at(-1).params;
  assert.match(usage.text, /📊 <b>Claude plan<\/b>/);
  assert.match(usage.text, /🔕 <b>Work Mac<\/b>/);

  await bot.send(111, '💻 Devices');
  const devices = ctx.tg.of('sendMessage', 111).at(-1).params;
  assert.deepEqual(devices.reply_markup.inline_keyboard.flat().map((b) => b.text), ['🔕 Home PC', '🔕 Work Mac', '⚙️ Alert settings']);

  // Tap the Work Mac bell: alerts on, toast, message edited in place.
  await bot.tap(111, `d:${deviceKey('Work Mac')}`);
  assert.match(ctx.tg.of('answerCallbackQuery').at(-1).params.text, /🔔 Alerts on for Work Mac/);
  const edited = ctx.tg.of('editMessageText', 111).at(-1).params;
  assert.equal(edited.message_id, 77);
  assert.ok(edited.reply_markup.inline_keyboard.flat().some((b) => b.text === '🔔 Work Mac'));
  // A device without caps: subscribed, with a hint to set a cap.
  await bot.tap(111, `d:${deviceKey('Home PC')}`);
  assert.match(ctx.tg.of('answerCallbackQuery').at(-1).params.text, /no cap/i);
  await bot.tap(111, `d:${deviceKey('Home PC')}`);
  assert.match(ctx.tg.of('answerCallbackQuery').at(-1).params.text, /🔕 Alerts off for Home PC/);
  assert.deepEqual((await ctx.call('GET', '/api/telegram', { token })).json.data.alerts.devices, ['Work Mac']);

  // Alert settings via inline toggles.
  await bot.send(111, '🔔 Alerts');
  assert.match(ctx.tg.sent(111).at(-1), /🔔 <b>Alerts are on<\/b>/);
  await bot.tap(111, 'a:p90');
  await bot.tap(111, 'a:agents');
  const alerts = (await ctx.call('GET', '/api/telegram', { token })).json.data.alerts;
  assert.equal(alerts.nearPct, 90);
  assert.equal(alerts.agents, false);
  await bot.tap(111, 'a:p80');

  // Work Mac nears its 5h cap → alert. Home PC (not subscribed) has no cap alerts.
  const before = ctx.tg.sent(111).length;
  await ctx.call('POST', '/api/report', { token, body: report(50, { share: 9 }) }); // Work Mac ≈ 45% of 5h plan
  const fresh = ctx.tg.sent(111).slice(before);
  assert.equal(fresh.length, 1, fresh.join('\n'));
  assert.match(fresh[0], /⚠️.*Work Mac.*of its 50% 5-hour cap/s);

  // Unlinked chats can't press buttons.
  await bot.tap(222, `d:${deviceKey('Work Mac')}`);
  assert.match(ctx.tg.of('answerCallbackQuery').at(-1).params.text, /private/i);
  assert.deepEqual((await ctx.call('GET', '/api/telegram', { token })).json.data.alerts.devices, ['Work Mac']);

  // Dashboard view of the same subscriptions.
  const status = (await ctx.call('GET', '/api/telegram', { token })).json.data;
  assert.deepEqual(status.devices, [
    { name: 'Home PC', subscribed: false, caps: { fiveHour: null, sevenDay: null } },
    { name: 'Work Mac', subscribed: true, caps: { fiveHour: 50, sevenDay: 50 } },
  ]);
  assert.equal((await ctx.call('PUT', '/api/telegram/alerts', { token, body: { ...status.alerts, devices: ['<bad>'] } })).status, 400);
  const saved = (await ctx.call('PUT', '/api/telegram/alerts', { token, body: { ...status.alerts, devices: ['Home PC'] } })).json.data;
  assert.deepEqual(saved.devices.filter((d) => d.subscribed).map((d) => d.name), ['Home PC']);
});

test('help, refresh, /stop, blocked chats, test message, disconnect and account deletion', async () => {
  const ctx = await boot();
  const token = await ctx.register();
  const bot = await connected(ctx, token);
  await ctx.call('POST', '/api/report', { token, body: report(10) });
  await bot.link(111);
  await bot.send(111, 'hello');
  assert.match(ctx.tg.sent(111).at(-1), /📊 Usage/);
  await bot.tap(111, 'u:refresh');
  assert.match(ctx.tg.of('editMessageText', 111).at(-1).params.text, /Claude plan/);
  assert.equal((await ctx.call('POST', '/api/telegram/test', { token })).status, 200);
  assert.match(ctx.tg.sent(111).at(-1), /Test message/);
  await bot.send(111, '/stop');
  const stop = ctx.tg.of('sendMessage', 111).at(-1).params;
  assert.match(stop.text, /Unlinked/);
  assert.deepEqual(stop.reply_markup, { remove_keyboard: true });
  assert.deepEqual((await ctx.call('GET', '/api/telegram', { token })).json.data.chats, []);

  await bot.link(BLOCKED_CHAT);
  assert.deepEqual((await ctx.call('GET', '/api/telegram', { token })).json.data.chats, [], 'a chat that blocked the bot is removed');
  assert.equal((await ctx.call('POST', '/api/telegram/test', { token })).status, 400);

  const otherToken = await ctx.register();
  assert.equal((await ctx.call('POST', '/api/telegram', { token: otherToken, body: { token: BOT_TOKEN }, headers: { Origin: ORIGIN } })).status, 409);
  const plain = await ctx.call('POST', '/api/telegram', { token: otherToken, body: { token: BOT_TOKEN }, headers: { Origin: 'http://usage.example.com' } });
  assert.match(plain.json.error, /https/);
  assert.equal((await ctx.call('GET', '/api/telegram')).status, 401);

  assert.equal((await ctx.call('DELETE', '/api/me', { token })).status, 200);
  assert.ok(ctx.tg.of('deleteWebhook').length >= 1, 'deleting the account removes the webhook');
  assert.equal((await bot.send(111, '/usage')).status, 404);
});

test('on start, bots connected before buttons existed are switched to receive button taps', async () => {
  const first = await boot();
  const token = await first.register();
  await connected(first, token);
  await new Promise((r) => first.server.close(r));
  const hookUrl = first.tg.of('setWebhook').at(-1).params.url;

  const second = await boot({ dir: first.dataPath, overrides: { getWebhookInfo: { url: hookUrl, allowed_updates: ['message'] } } });
  await new Promise((r) => setTimeout(r, 100));
  const upgrade = second.tg.of('setWebhook').at(-1)?.params;
  assert.equal(upgrade?.url, hookUrl);
  assert.deepEqual(upgrade.allowed_updates, ['message', 'callback_query']);
  assert.deepEqual(second.tg.of('setMyCommands').at(-1)?.params.commands.map((c) => c.command), ['start']);
});

test('usage outside Claude Code: the bot asks whose it was and the answer moves the share', async () => {
  const ctx = await boot();
  const token = await ctx.register();
  const bot = await connected(ctx, token);
  await ctx.call('POST', '/api/report', { token, body: report(10) });
  await ctx.call('POST', '/api/report', { token, body: report(10, { device: 'Home PC' }) });
  await bot.link(111);
  const summary = async () => (await ctx.call('GET', '/api/summary', { token })).json.data;
  const row = (s, device) => s.windows.fiveHour.find((r) => r.device === device);

  // The plan went up 6 points while no device's Claude Code cost moved (Claude Desktop, claude.ai, …).
  await ctx.call('POST', '/api/report', { token, body: report(16) });
  const question = ctx.tg.of('sendMessage', 111).at(-1).params;
  assert.match(question.text, /🧭 <b>Usage outside Claude Code<\/b>/);
  assert.match(question.text, /5h \+6\.0%/);
  const buttons = question.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.text), ['💻 Home PC', '💻 Work Mac', '🙈 Not sure — split by usage']);
  let s = await summary();
  assert.equal(s.outside.fiveHour.unassignedPct, 6);
  assert.equal(row(s, 'Work Mac').sharePct + row(s, 'Home PC').sharePct, 10, 'devices keep only the Claude Code part');

  await bot.tap(111, buttons[0].callback_data);
  assert.match(ctx.tg.of('answerCallbackQuery').at(-1).params.text, /Home PC/);
  assert.match(ctx.tg.of('editMessageText', 111).at(-1).params.text, /✅ Counted for <b>Home PC<\/b>/);
  s = await summary();
  assert.equal(s.outside.fiveHour.unassignedPct, 0);
  assert.equal(row(s, 'Home PC').outsidePct, 6);
  assert.equal(row(s, 'Home PC').sharePct, 11);

  await bot.tap(111, 'o:ask');
  assert.match(ctx.tg.of('answerCallbackQuery').at(-1).params.text, /Nothing to assign/);

  await bot.tap(111, buttons[2].callback_data);
  assert.match(ctx.tg.of('editMessageText', 111).at(-1).params.text, /🙈 Split across devices/);
  s = await summary();
  assert.equal(row(s, 'Home PC').outsidePct, 0);
  assert.equal(row(s, 'Work Mac').sharePct + row(s, 'Home PC').sharePct, 16);

  await bot.tap(111, 'o:deadbeef:x');
  assert.match(ctx.tg.of('editMessageText', 111).at(-1).params.text, /Already answered/);

  // A later unanswered rise: 📊 Usage shows it with an Assign button that re-asks.
  await ctx.call('POST', '/api/report', { token, body: report(20) });
  await bot.send(111, '📊 Usage');
  const usage = ctx.tg.of('sendMessage', 111).at(-1).params;
  assert.match(usage.text, /not assigned/);
  const sentBefore = ctx.tg.sent(111).length;
  await bot.tap(111, 'o:ask');
  assert.equal(ctx.tg.sent(111).length, sentBefore + 1);
  assert.match(ctx.tg.sent(111).at(-1), /Whose was it\?/);
});

test('backfill: unanswered outside usage goes to a device through the API; GET /api/outside shows the rate', async () => {
  const ctx = await boot();
  const token = await ctx.register();
  await ctx.call('POST', '/api/report', { token, body: report(10, { share: 20 }) }); // 0.5 % per dollar
  await ctx.call('POST', '/api/report', { token, body: report(14, { share: 20 }) }); // 4 points more, no Claude Code
  const before = (await ctx.call('GET', '/api/outside', { token })).json.data;
  assert.equal(before.rates.fiveHour, 0.5);
  assert.equal(before.pending.length, 1);

  assert.equal((await ctx.call('POST', '/api/outside/assign', { token, body: { device: 'Nope' } })).status, 404);
  assert.equal((await ctx.call('POST', '/api/outside/assign', { token, body: {} })).status, 400);
  const res = await ctx.call('POST', '/api/outside/assign', { token, body: { device: 'Work Mac' } });
  assert.equal(res.json.data.assigned, 1);
  const s = (await ctx.call('GET', '/api/summary', { token })).json.data;
  assert.equal(s.windows.fiveHour[0].outsidePct, 4);
  assert.equal(s.outside.fiveHour.unassignedPct, 0);
  assert.equal((await ctx.call('GET', '/api/outside')).status, 401);
});

test('outside usage is put on the device where Claude Desktop was just used, and the bot says so', async () => {
  const ctx = await boot();
  const token = await ctx.register();
  const bot = await connected(ctx, token);
  await bot.link(111);
  await ctx.call('POST', '/api/report', { token, body: report(10, { share: 20, surfaces: {} }) }); // reports activity: none
  const desktop = { desktop: new Date().toISOString() };
  await ctx.call('POST', '/api/report', { token, body: report(14, { device: 'Home PC', share: 0, surfaces: desktop }) });
  const message = ctx.tg.of('sendMessage', 111).at(-1).params;
  assert.match(message.text, /Counted for <b>Home PC<\/b> automatically — Claude Desktop was used there/);
  assert.ok(message.reply_markup.inline_keyboard.flat().some((b) => b.text === '✅ Home PC'), 'can still be changed');
  const s = (await ctx.call('GET', '/api/summary', { token })).json.data;
  assert.equal(s.windows.fiveHour.find((r) => r.device === 'Home PC').outsidePct, 4);
});

test('backfill with explicit amounts puts them on a device in the current windows', async () => {
  const ctx = await boot();
  const token = await ctx.register();
  await ctx.call('POST', '/api/report', { token, body: report(10) });
  const assign = (body) => ctx.call('POST', '/api/outside/assign', { token, body: { device: 'Work Mac', ...body } });
  assert.equal((await assign({ amounts: { fiveHour: 11 } })).status, 400, 'more than the plan shows');
  assert.equal((await assign({ amounts: { fiveHour: -1 } })).status, 400);
  const res = await assign({ amounts: { fiveHour: 3, sevenDay: 1.5 } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const s = (await ctx.call('GET', '/api/summary', { token })).json.data;
  assert.equal(s.windows.fiveHour[0].outsidePct, 3);
  assert.equal(s.windows.sevenDay[0].outsidePct, 1.5);
});
