import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_EXTENSION_ID, surfaceActivity } from '../../plugin/scripts/surfaces.js';

async function touch(path, isoTime) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'x');
  const t = new Date(isoTime);
  await utimes(path, t, t);
}

test('surfaceActivity: newest write of Claude Desktop, claude.ai and the Claude extension storage (macOS)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cut-surf-'));
  try {
    const support = join(home, 'Library', 'Application Support');
    await touch(join(support, 'Claude', 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb', '000003.log'), '2026-10-21T19:17:22Z');
    const chrome = join(support, 'Google', 'Chrome');
    await touch(join(chrome, 'Default', 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb', '000005.log'), '2026-10-21T14:56:55Z');
    await touch(join(chrome, 'Profile 12', 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb', '000001.log'), '2026-10-06T19:24:05Z');
    await touch(join(support, 'BraveSoftware', 'Brave-Browser', 'Default', 'Local Extension Settings', CLAUDE_EXTENSION_ID, '000009.log'), '2026-10-21T17:50:36Z');
    await touch(join(chrome, 'Default', 'Local Storage', 'leveldb', '000099.log'), '2026-10-21T20:00:00Z'); // every site: ignored

    assert.deepEqual(await surfaceActivity({ home, platform: 'darwin' }), {
      desktop: '2026-10-21T19:17:22.000Z',
      web: '2026-10-21T14:56:55.000Z',
      extension: '2026-10-21T17:50:36.000Z',
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('surfaceActivity: nothing installed → all null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cut-surf-'));
  try {
    assert.deepEqual(await surfaceActivity({ home, platform: 'darwin' }), { desktop: null, web: null, extension: null });
    assert.deepEqual(await surfaceActivity({ home, platform: 'linux' }), { desktop: null, web: null, extension: null });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
