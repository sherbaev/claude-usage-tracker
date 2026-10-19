import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, startServer } from '../../server/src/server.js';

let dataDir;
const servers = [];

async function boot(env = {}) {
  const dir = await mkdtemp(join(dataDir, 'srv-'));
  const settings = { ...readSettings({ DATA_DIR: dir, ...env }), port: 0 };
  const server = await startServer(settings);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, raw } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const isJson = res.headers.get('content-type')?.includes('json');
    return { status: res.status, headers: res.headers, json: isJson ? await res.json() : null };
  };
  const register = async (body) => (await call('POST', '/api/register', { body })).json.data.token;
  return { server, base, call, register };
}

const report = (device, cost) => ({
  device,
  reportedAt: new Date().toISOString(),
  account: {
    fiveHour: { pct: 20, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    sevenDay: { pct: 50, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
  },
  local: { fiveHour: { costUSD: cost, tokens: 10 }, sevenDay: { costUSD: cost * 10, tokens: 100 } },
});

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cut-test-'));
});

after(async () => {
  await Promise.all(servers.filter((s) => s.listening).map((s) => new Promise((r) => s.close(r))));
  await rm(dataDir, { recursive: true, force: true });
});

test('readSettings validates registration and limits', () => {
  assert.equal(readSettings({}).registration.mode, 'open');
  assert.equal(readSettings({ REGISTRATION_CODE: 'secret-code' }).registration.mode, 'code');
  assert.throws(() => readSettings({ REGISTRATION: 'code', REGISTRATION_CODE: 'short' }), /REGISTRATION_CODE/);
  assert.throws(() => readSettings({ REGISTRATION: 'maybe' }), /REGISTRATION must be/);
  assert.throws(() => readSettings({ MAX_DEVICES_PER_USER: '0' }), /MAX_DEVICES_PER_USER/);
  assert.throws(() => readSettings({ TRUST_PROXY: 'yes' }), /TRUST_PROXY/);
  assert.equal(readSettings({ TRUST_PROXY: '1' }).proxyHops, 1);
  assert.equal(readSettings({ TRUST_PROXY: 'true' }).proxyHops, 1);
  assert.equal(readSettings({}).proxyHops, 0);
});

test('malformed request URLs get 400 instead of crashing the server', async () => {
  const { server, call } = await boot();
  const { port } = server.address();
  const raw = await new Promise((resolve, reject) => {
    import('node:net').then(({ connect }) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('GET //a:b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
  });
  assert.match(raw, /^HTTP\/1\.1 400/);
  assert.equal((await call('GET', '/health')).status, 200, 'server still alive');
});

test('per-device limits: set on the website, reflected in summary and in the report response', async () => {
  const { call, register } = await boot();
  const token = await register();
  await call('POST', '/api/report', { token, body: report('mac', 3) });
  await call('POST', '/api/report', { token, body: report('linux', 1) });

  assert.equal((await call('PUT', '/api/devices/ghost/limits', { token, body: { fiveHour: 5 } })).status, 404);
  assert.equal((await call('PUT', '/api/devices/mac/limits', { token, body: { fiveHour: 150 } })).status, 400);
  const set = await call('PUT', '/api/devices/mac/limits', { token, body: { fiveHour: 10, sevenDay: null, enforce: true } });
  assert.equal(set.status, 200);

  const summary = (await call('GET', '/api/summary', { token })).json.data;
  const mac = summary.windows.fiveHour.find((r) => r.device === 'mac');
  assert.deepEqual([mac.sharePct, mac.limitPct, mac.overLimit], [15, 10, true]);
  assert.deepEqual(summary.devices.find((d) => d.name === 'mac').limits, { fiveHour: 10, sevenDay: null, enforce: true });
  assert.equal(summary.windows.fiveHour.find((r) => r.device === 'linux').overLimit, false);

  const pushed = (await call('POST', '/api/report', { token, body: report('mac', 3) })).json.data;
  assert.equal(pushed.status.enforce, true);
  assert.equal(pushed.status.windows.fiveHour.overLimit, true);
  assert.equal(pushed.status.windows.sevenDay.limitPct, null);

  await call('DELETE', '/api/devices/mac', { token });
  await call('POST', '/api/report', { token, body: report('mac', 3) });
  const after = (await call('GET', '/api/summary', { token })).json.data;
  assert.equal(after.devices.find((d) => d.name === 'mac').limits.fiveHour, null, 'removing a device clears its limits');
});

test('limits are isolated per account', async () => {
  const { call, register } = await boot();
  const alice = await register();
  const bob = await register();
  await call('POST', '/api/report', { token: alice, body: report('mac', 1) });
  assert.equal((await call('PUT', '/api/devices/mac/limits', { token: bob, body: { fiveHour: 1 } })).status, 404);
});

test('serves the website with a strict CSP and health check', async () => {
  const { base, call } = await boot();
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /Claude Usage Tracker/);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('GET', '/api/config')).json.data.registration, 'open');
  assert.equal((await call('GET', '/nope')).status, 404);
});

test('each registration gets its own account; devices are grouped per token', async () => {
  const { call, register } = await boot();
  const alice = await register();
  const bob = await register();
  assert.match(alice, /^cut_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(alice, bob);

  assert.equal((await call('POST', '/api/report', { token: alice, body: report('mac', 3) })).status, 200);
  assert.equal((await call('POST', '/api/report', { token: alice, body: report('linux', 1) })).status, 200);
  assert.equal((await call('POST', '/api/report', { token: bob, body: report('bob-pc', 5) })).status, 200);

  const summary = (await call('GET', '/api/summary', { token: alice })).json.data;
  assert.deepEqual(summary.windows.fiveHour.map((r) => [r.device, r.sharePct]), [['mac', 15], ['linux', 5]]);
  assert.deepEqual(summary.devices.map((d) => d.name), ['linux', 'mac']);

  const bobMe = (await call('GET', '/api/me', { token: bob })).json.data;
  assert.deepEqual(bobMe.devices.map((d) => d.name), ['bob-pc']);
});

test('rejects missing, malformed and unknown tokens', async () => {
  const { call } = await boot();
  assert.equal((await call('GET', '/api/summary')).status, 401);
  assert.equal((await call('GET', '/api/summary', { token: 'garbage' })).status, 401);
  const unknown = `cut_${'A'.repeat(43)}`;
  assert.equal((await call('POST', '/api/report', { token: unknown, body: report('x', 1) })).status, 401);
});

test('validates reports and body size', async () => {
  const { call, register } = await boot();
  const token = await register();
  assert.equal((await call('POST', '/api/report', { token, raw: '{bad' })).status, 400);
  const bad = await call('POST', '/api/report', { token, body: { ...report('x', 1), device: '../etc' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /device/);
  const big = await call('POST', '/api/report', { token, raw: JSON.stringify({ pad: 'x'.repeat(20_000) }) }).catch(() => null);
  assert.ok(big === null || big.status === 413);
});

test('enforces the per-user device limit, and devices can be removed', async () => {
  const { call, register } = await boot({ MAX_DEVICES_PER_USER: '2' });
  const token = await register();
  await call('POST', '/api/report', { token, body: report('a', 1) });
  await call('POST', '/api/report', { token, body: report('b', 1) });
  const third = await call('POST', '/api/report', { token, body: report('c', 1) });
  assert.equal(third.status, 403);
  assert.match(third.json.error, /device limit/);
  assert.equal((await call('POST', '/api/report', { token, body: report('a', 2) })).status, 200, 'existing device can update');

  assert.equal((await call('DELETE', '/api/devices/b', { token })).status, 200);
  assert.equal((await call('DELETE', '/api/devices/b', { token })).status, 404);
  assert.equal((await call('DELETE', '/api/devices/%E0%A4%A', { token })).status, 400);
  assert.equal((await call('POST', '/api/report', { token, body: report('c', 1) })).status, 200);
});

test('account deletion removes the token and its devices', async () => {
  const { call, register } = await boot();
  const token = await register();
  await call('POST', '/api/report', { token, body: report('a', 1) });
  assert.equal((await call('DELETE', '/api/me', { token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token })).status, 401);
});

test('registration modes: code and closed', async () => {
  const coded = await boot({ REGISTRATION: 'code', REGISTRATION_CODE: 'let-me-in-please' });
  assert.equal((await coded.call('POST', '/api/register', { body: { code: 'wrong' } })).status, 403);
  assert.equal((await coded.call('POST', '/api/register', { body: { code: 'let-me-in-please' } })).status, 201);

  const closed = await boot({ REGISTRATION: 'closed' });
  const res = await closed.call('POST', '/api/register', { body: {} });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /closed/);
});

test('registration is rate limited per client IP', async () => {
  const { call } = await boot();
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await call('POST', '/api/register', { body: {} })).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
});

test('data persists across restarts', async () => {
  const dir = await mkdtemp(join(dataDir, 'persist-'));
  const first = await startServer({ ...readSettings({ DATA_DIR: dir }), port: 0 });
  const url = `http://127.0.0.1:${first.address().port}`;
  const { data } = await (await fetch(`${url}/api/register`, { method: 'POST' })).json();
  await fetch(`${url}/api/report`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${data.token}` },
    body: JSON.stringify(report('mac', 1)),
  });
  await new Promise((r) => first.close(r));

  const second = await startServer({ ...readSettings({ DATA_DIR: dir }), port: 0 });
  const res = await fetch(`http://127.0.0.1:${second.address().port}/api/me`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  assert.deepEqual((await res.json()).data.devices.map((d) => d.name), ['mac']);
  await new Promise((r) => second.close(r));
});
