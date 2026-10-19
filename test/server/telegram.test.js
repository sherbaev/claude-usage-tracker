import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, startServer } from '../../server/src/server.js';

const BOT_TOKEN = `424242:${'A'.repeat(35)}`;
const ORIGIN = 'https://usage.example.com';
const BLOCKED_CHAT = 333;
let dataDir;
const servers = [];

/** Fake Bot API: records calls, answers like Telegram. */
function fakeTelegram() {
  const calls = [];
  const fetch = async (url, init) => {
    const [, token, method] = new URL(url).pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    const params = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
    calls.push({ token, method, params });
    if (token !== BOT_TOKEN) return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 });
    if (method === 'sendMessage' && params.chat_id === BLOCKED_CHAT) {
      return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, { status: 403 });
    }
    const results = { getMe: { id: 4242, is_bot: true, first_name: 'x', username: 'my_usage_bot' }, sendMessage: { message_id: calls.length } };
    return Response.json({ ok: true, result: results[method] ?? true });
  };
  return { calls, fetch, sent: (chatId) => calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === chatId).map((c) => c.params.text) };
}

async function boot() {
  const dir = await mkdtemp(join(dataDir, 'srv-'));
  const tg = fakeTelegram();
  const settings = { ...readSettings({ DATA_DIR: dir }), port: 0, telegram: { fetch: tg.fetch, avatar: Buffer.from('jpg') } };
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
  const token = (await call('POST', '/api/register')).json.data.token;
  return { tg, call, token };
}

const report = (fivePct) => ({
  device: 'Work Mac',
  reportedAt: new Date().toISOString(),
  account: {
    fiveHour: { pct: fivePct, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    sevenDay: { pct: 20, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
  },
  local: { fiveHour: { costUSD: 1, tokens: 10 }, sevenDay: { costUSD: 5, tokens: 50 } },
});

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cut-tg-'));
});

after(async () => {
  await Promise.all(servers.filter((s) => s.listening).map((s) => new Promise((r) => s.close(r))));
  await rm(dataDir, { recursive: true, force: true });
});

test('connect configures the bot, then link → /usage → alerts → disconnect', async () => {
  const { tg, call, token } = await boot();
  assert.equal((await call('GET', '/api/telegram', { token })).json.data.connected, false);
  assert.equal((await call('POST', '/api/telegram', { token, body: { token: 'nope' }, headers: { Origin: ORIGIN } })).status, 400);
  const rejected = await call('POST', '/api/telegram', { token, body: { token: `424242:${'B'.repeat(35)}` }, headers: { Origin: ORIGIN } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error, /Telegram rejected/);

  const connected = await call('POST', '/api/telegram', { token, body: { token: BOT_TOKEN }, headers: { Origin: ORIGIN } });
  assert.equal(connected.status, 200, JSON.stringify(connected.json));
  assert.equal(connected.json.data.bot.username, 'my_usage_bot');
  assert.ok(connected.json.data.setup.every((s) => s.ok), JSON.stringify(connected.json.data.setup));
  assert.doesNotMatch(JSON.stringify(connected.json), /AAAAAAAAAA/, 'the bot token never comes back');
  const byMethod = Object.fromEntries(tg.calls.filter((c) => c.token === BOT_TOKEN).map((c) => [c.method, c.params]));
  assert.equal(byMethod.setMyName.name, 'Claude Usage Tracker');
  assert.ok(byMethod.setMyDescription.description && byMethod.setMyShortDescription.short_description);
  assert.deepEqual(byMethod.setMyCommands.commands.map((c) => c.command), ['usage', 'devices', 'alerts', 'stop', 'help']);
  assert.match(byMethod.setMyProfilePhoto.photo, /"type":"static"/);
  assert.match(byMethod.setWebhook.url, /^https:\/\/usage\.example\.com\/telegram\/webhook\/[a-f0-9]{32}$/);
  assert.deepEqual(byMethod.setWebhook.allowed_updates, ['message']);
  const webhookPath = new URL(byMethod.setWebhook.url).pathname;
  const secret = byMethod.setWebhook.secret_token;

  const link = (await call('POST', '/api/telegram/link', { token })).json.data;
  const code = link.url.match(/^https:\/\/t\.me\/my_usage_bot\?start=([\w-]+)$/)[1];
  const send = (chatId, text, hdrs = { 'X-Telegram-Bot-Api-Secret-Token': secret }) =>
    call('POST', webhookPath, { body: { update_id: 1, message: { message_id: 1, chat: { id: chatId, type: 'private', first_name: 'Javo' }, text } }, headers: hdrs });

  assert.equal((await send(111, `/start ${code}`, {})).status, 401, 'webhook needs the secret');
  assert.equal((await send(111, `/start ${code}`)).status, 200);
  assert.match(tg.sent(111).at(-1), /Linked/);
  assert.deepEqual((await call('GET', '/api/telegram', { token })).json.data.chats.map((c) => [c.id, c.name]), [[111, 'Javo']]);

  await send(222, `/start ${code}`); // codes work once
  await send(222, '/usage');
  assert.ok(tg.sent(222).every((t) => /private/i.test(t)), 'unlinked chats get no data');

  await call('POST', '/api/report', { token, body: report(40) });
  await send(111, '/usage');
  assert.match(tg.sent(111).at(-1), /Work Mac/);

  const before85 = tg.sent(111).length;
  await call('POST', '/api/report', { token, body: report(85) });
  await call('POST', '/api/report', { token, body: report(86) });
  const alerts = tg.sent(111).slice(before85);
  assert.equal(alerts.length, 1, alerts.join('\n'));
  assert.match(alerts[0], /Claude 5-hour window.*85%/s);

  assert.equal((await call('PUT', '/api/telegram/alerts', { token, body: { nearPct: 500 } })).status, 400);
  const settings = { enabled: true, nearPct: 90, near: true, hit: true, caps: false, agents: true };
  assert.deepEqual((await call('PUT', '/api/telegram/alerts', { token, body: settings })).json.data.alerts, settings);
  assert.equal((await call('POST', '/api/telegram/test', { token })).status, 200);
  assert.match(tg.sent(111).at(-1), /Test/);

  assert.equal((await call('DELETE', '/api/telegram/chats/111', { token })).status, 200);
  assert.deepEqual((await call('GET', '/api/telegram', { token })).json.data.chats, []);
  assert.equal((await call('DELETE', '/api/telegram', { token })).status, 200);
  assert.ok(tg.calls.some((c) => c.method === 'deleteWebhook'));
  assert.equal((await call('GET', '/api/telegram', { token })).json.data.connected, false);
  assert.equal((await send(111, '/usage')).status, 404, 'webhook of a removed bot is gone');
});

test('a bot can belong to one account only, and Telegram routes need a token', async () => {
  const first = await boot();
  assert.equal((await first.call('POST', '/api/telegram', { token: first.token, body: { token: BOT_TOKEN }, headers: { Origin: ORIGIN } })).status, 200);
  const otherToken = (await first.call('POST', '/api/register')).json.data.token;
  const taken = await first.call('POST', '/api/telegram', { token: otherToken, body: { token: BOT_TOKEN }, headers: { Origin: ORIGIN } });
  assert.equal(taken.status, 409);
  assert.equal((await first.call('GET', '/api/telegram')).status, 401);
  // Telegram only delivers webhooks to https URLs.
  const plain = await first.call('POST', '/api/telegram', { token: otherToken, body: { token: BOT_TOKEN }, headers: { Origin: 'http://usage.example.com' } });
  assert.equal(plain.status, 400);
  assert.match(plain.json.error, /https/);
});

test('bot commands: /devices, /alerts, /help, /stop, and chats that blocked the bot are dropped', async () => {
  const { tg, call, token } = await boot();
  await call('POST', '/api/telegram', { token, body: { token: BOT_TOKEN }, headers: { Origin: ORIGIN } });
  const setWebhook = tg.calls.find((c) => c.method === 'setWebhook').params;
  const path = new URL(setWebhook.url).pathname;
  const send = (chatId, text) =>
    call('POST', path, { body: { message: { chat: { id: chatId, type: 'group', title: 'Team <chat>' }, text } }, headers: { 'X-Telegram-Bot-Api-Secret-Token': setWebhook.secret_token } });
  const link = async (chatId) => {
    const { url } = (await call('POST', '/api/telegram/link', { token })).json.data;
    await send(chatId, `/start@my_usage_bot ${new URL(url).searchParams.get('start')}`);
  };
  await call('POST', '/api/report', { token, body: report(10) });
  await link(111);
  assert.equal((await call('GET', '/api/telegram', { token })).json.data.chats[0].name, 'Team <chat>');

  await send(111, '/devices');
  assert.match(tg.sent(111).at(-1), /Work Mac.*synced/s);
  await send(111, '/alerts');
  assert.match(tg.sent(111).at(-1), /Alerts are <b>on<\/b>.*near the limit \(80%\)/s);
  await send(111, '/whatever');
  assert.match(tg.sent(111).at(-1), /\/usage/);
  await send(111, 'hello');
  await send(111, '/stop');
  assert.match(tg.sent(111).at(-1), /Unlinked/);
  assert.deepEqual((await call('GET', '/api/telegram', { token })).json.data.chats, []);
  assert.equal((await send(111, '/usage')).status, 200);
  assert.match(tg.sent(111).at(-1), /private/i);

  await link(BLOCKED_CHAT);
  assert.deepEqual((await call('GET', '/api/telegram', { token })).json.data.chats, [], 'a chat that blocked the bot is removed');
  assert.equal((await call('POST', '/api/telegram/test', { token })).status, 400);

  // Deleting the account also removes the bot's webhook.
  const deletesBefore = tg.calls.filter((c) => c.method === 'deleteWebhook').length;
  assert.equal((await call('DELETE', '/api/me', { token })).status, 200);
  assert.equal(tg.calls.filter((c) => c.method === 'deleteWebhook').length, deletesBefore + 1);
});
