// Reads the latest Codex plan snapshot (5h / weekly %) from Codex session files:
// $CODEX_HOME (default ~/.codex)/{sessions,archived_sessions}/**/*.jsonl. Only rate-limit fields are kept.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseCodexSnapshot } from './agents.js';

const SESSION_DIRS = ['sessions', 'archived_sessions'];

export const codexHome = (env = process.env) => env.CODEX_HOME ?? join(homedir(), '.codex');

async function sessionFiles(dir, sinceMs) {
  let names;
  try {
    names = await readdir(dir, { recursive: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path).catch(() => null);
        return info && info.mtimeMs >= sinceMs ? { path, mtimeMs: info.mtimeMs } : null;
      }),
  );
  return files.filter(Boolean);
}

async function latestInFile(path) {
  let latest = null;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const snap = parseCodexSnapshot(line);
    if (snap && (!latest || snap.observedAt > latest.observedAt)) latest = snap;
  }
  return latest;
}

/** The newest Codex plan snapshot written at or after `sinceMs`, or null. */
export async function readCodexSnapshot({ home = codexHome(), sinceMs }) {
  const files = (await Promise.all(SESSION_DIRS.map((d) => sessionFiles(join(home, d), sinceMs)))).flat();
  // The most recently written session holds the latest snapshot; older files are only a fallback.
  for (const { path } of files.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const snap = await latestInFile(path);
    if (snap) return snap;
  }
  return null;
}
