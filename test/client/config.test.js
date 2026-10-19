import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, normalizeServerUrl, pluginOptionConfig, saveConfig } from '../../plugin/scripts/config.js';

const TOKEN = `cut_${'a'.repeat(43)}`;

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cut-cfg-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loadConfig: plugin options beat env vars beat the config file', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'config.json');
    await saveConfig({ serverUrl: 'https://file.example', token: 'file-token', device: 'file-dev' }, path);

    assert.deepEqual(await loadConfig({}, path), { serverUrl: 'https://file.example', token: 'file-token', device: 'file-dev' });

    const env = { USAGE_TRACKER_SERVER_URL: 'https://env.example/', USAGE_TRACKER_DEVICE: 'env-dev' };
    assert.deepEqual(await loadConfig(env, path), { serverUrl: 'https://env.example', token: 'file-token', device: 'env-dev' });

    const options = { ...env, CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://opt.example', CLAUDE_PLUGIN_OPTION_TOKEN: TOKEN, CLAUDE_PLUGIN_OPTION_DEVICE_NAME: '  ' };
    const fromOptions = await loadConfig(options, path);
    assert.equal(fromOptions.serverUrl, 'https://opt.example');
    assert.equal(fromOptions.token, TOKEN);
    assert.equal(fromOptions.device, 'env-dev', 'blank option falls through');
  }));

test('loadConfig: no file means local-only mode; url without token is an error', () =>
  withTempDir(async (dir) => {
    const empty = await loadConfig({}, join(dir, 'missing.json'));
    assert.equal(empty.serverUrl, null);
    assert.ok(empty.device.length > 0);
    await assert.rejects(loadConfig({ USAGE_TRACKER_SERVER_URL: 'https://x.example' }, join(dir, 'missing.json')), /token is missing/);
  }));

test('saveConfig writes a 0600 file', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'config.json');
    await saveConfig({ serverUrl: 'https://x.example', token: TOKEN, device: 'mac' }, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).device, 'mac');
  }));

test('pluginOptionConfig requires url and token', () => {
  assert.equal(pluginOptionConfig({}), null);
  assert.equal(pluginOptionConfig({ CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://x.example' }), null);
  const cfg = pluginOptionConfig({ CLAUDE_PLUGIN_OPTION_SERVER_URL: 'https://x.example/', CLAUDE_PLUGIN_OPTION_TOKEN: TOKEN });
  assert.equal(cfg.serverUrl, 'https://x.example');
  assert.ok(cfg.device);
});

test('normalizeServerUrl requires https except on localhost', () => {
  assert.equal(normalizeServerUrl('http://localhost:8787///'), 'http://localhost:8787');
  assert.equal(normalizeServerUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeServerUrl('https://usage.example.com/tracker/'), 'https://usage.example.com/tracker');
  assert.throws(() => normalizeServerUrl('http://usage.example.com'), /https/);
  assert.throws(() => normalizeServerUrl('usage.example.com'), /invalid server URL/);
  assert.throws(() => normalizeServerUrl('javascript:alert(1)'), /https/);
});
