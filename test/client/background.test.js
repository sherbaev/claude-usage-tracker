import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backgroundStatus,
  cronLine,
  disableBackground,
  enableBackground,
  launchAgentPlist,
  refreshBackground,
} from '../../plugin/scripts/background.js';

const NODE = '/Users/me/.nvm/versions/node/v24.13.1/bin/node';
const CLI = '/Users/me/.claude/plugins/cache/usage-tracker/0.8.1/scripts/cli.js';

async function withAgents(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cut-bg-'));
  const calls = [];
  const run = async (args) => calls.push(args);
  try {
    return await fn({ dir, calls, run });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('launchAgentPlist runs a throttled push every 5 minutes with a usable PATH', () => {
  const xml = launchAgentPlist({ node: NODE, cli: CLI, pluginData: '/data & more', logPath: '/tmp/bg.log' });
  assert.match(xml, /<string>com\.claude-usage-tracker\.push<\/string>/);
  assert.match(xml, new RegExp(`<string>${NODE}</string>\\s*<string>${CLI}</string>\\s*<string>push</string>\\s*<string>--throttle</string>\\s*<string>240</string>`));
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<string>\/Users\/me\/\.nvm\/versions\/node\/v24\.13\.1\/bin:\/opt\/homebrew\/bin:/);
  assert.match(xml, /<key>CLAUDE_PLUGIN_DATA<\/key>\s*<string>\/data &amp; more<\/string>/, 'paths are XML-escaped');
  assert.doesNotMatch(launchAgentPlist({ node: NODE, cli: CLI, logPath: '/tmp/bg.log' }), /CLAUDE_PLUGIN_DATA/);
});

test('enable installs and loads the LaunchAgent; status and disable', () =>
  withAgents(async ({ dir, calls, run }) => {
    assert.deepEqual(await backgroundStatus({ dir }), { installed: false });
    const { path } = await enableBackground({ node: NODE, cli: CLI, dir, run, uid: 501 });
    assert.ok((await readFile(path, 'utf8')).includes(CLI));
    assert.deepEqual(calls, [
      ['bootout', 'gui/501/com.claude-usage-tracker.push'],
      ['bootstrap', 'gui/501', path],
    ]);
    assert.deepEqual(await backgroundStatus({ dir }), { installed: true, cli: CLI, node: NODE });

    assert.equal(await disableBackground({ dir, run, uid: 501 }), true);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.deepEqual(calls.at(-1), ['bootout', 'gui/501/com.claude-usage-tracker.push']);
    assert.equal(await disableBackground({ dir, run, uid: 501 }), false);
  }));

test('a failing bootout (nothing loaded yet) does not stop enable', () =>
  withAgents(async ({ dir }) => {
    const calls = [];
    const run = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'bootout') throw new Error('No such process');
    };
    await enableBackground({ node: NODE, cli: CLI, dir, run, uid: 501 });
    assert.deepEqual(calls, ['bootout', 'bootstrap']);
  }));

test('refreshBackground follows a plugin update or a new node, and leaves it alone otherwise', () =>
  withAgents(async ({ dir, calls, run }) => {
    assert.equal(await refreshBackground({ node: NODE, cli: CLI, dir, run, uid: 501 }), false, 'not installed: not turned on');
    assert.deepEqual(calls, []);
    await enableBackground({ node: NODE, cli: CLI, dir, run, uid: 501 });
    const before = calls.length;
    assert.equal(await refreshBackground({ node: NODE, cli: CLI, dir, run, uid: 501 }), false);
    assert.equal(calls.length, before);
    const updated = CLI.replace('0.8.1', '0.9.0');
    assert.equal(await refreshBackground({ node: NODE, cli: updated, dir, run, uid: 501 }), true);
    assert.equal((await backgroundStatus({ dir })).cli, updated);
  }));

test('cronLine for systems without launchd', () => {
  assert.equal(cronLine({ node: NODE, cli: CLI }), `*/5 * * * * "${NODE}" "${CLI}" push --throttle 240`);
});
