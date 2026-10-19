// Reads per-message usage (model, effort, speed, tokens) from Claude Code transcripts:
// <config dir>/projects/**/*.jsonl, including subagent transcripts. Only metadata is kept, never content.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseTranscriptLine } from './models.js';

/** Same lookup as ccusage: CLAUDE_CONFIG_DIR (comma-separated), else ~/.config/claude and ~/.claude. */
export function projectDirs(env = process.env) {
  const roots = env.CLAUDE_CONFIG_DIR
    ? env.CLAUDE_CONFIG_DIR.split(',').map((dir) => dir.trim()).filter(Boolean)
    : [join(homedir(), '.config', 'claude'), join(homedir(), '.claude')];
  return roots.map((root) => join(root, 'projects'));
}

async function recentTranscripts(dir, sinceMs) {
  let names;
  try {
    names = await readdir(dir, { recursive: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const candidates = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const path = join(dir, name);
        const info = await stat(path).catch(() => null); // deleted while scanning
        return info && info.mtimeMs >= sinceMs ? path : null;
      }),
  );
  return candidates.filter(Boolean);
}

async function readFileEntries(path, sinceMs, seen) {
  const entries = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (!entry || entry.timestampMs < sinceMs) continue;
    // Claude Code writes one line per content block, repeating the same message and usage.
    if (entry.key && seen.has(entry.key)) continue;
    if (entry.key) seen.add(entry.key);
    entries.push(entry);
  }
  return entries;
}

/** Usage entries at or after `sinceMs`, deduplicated across all transcripts. */
export async function readUsageEntries({ sinceMs, dirs = projectDirs() }) {
  const files = (await Promise.all(dirs.map((dir) => recentTranscripts(dir, sinceMs)))).flat();
  const seen = new Set();
  const entries = [];
  // Sequential on purpose: keeps memory flat and the dedupe set consistent.
  for (const file of files) entries.push(...(await readFileEntries(file, sinceMs, seen)));
  return entries;
}
