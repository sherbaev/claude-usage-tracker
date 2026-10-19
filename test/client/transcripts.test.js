import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDirs, readUsageEntries } from '../../plugin/scripts/transcripts.js';

let root;

const assistant = (id, timestamp, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp, requestId: `r${id}`, effort: 'high', message: { id, model, usage: { output_tokens: 10 } } });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'cut-transcripts-'));
  const project = join(root, 'projects', '-Users-me-app');
  await mkdir(join(project, 'session-1', 'subagents'), { recursive: true });
  // Claude Code writes one line per content block; the same message repeats.
  await writeFile(
    join(project, 'session-1.jsonl'),
    [assistant('a', '2026-10-19T06:00:00Z'), assistant('a', '2026-10-19T06:00:00Z'), '{"type":"user"}', 'not json', assistant('old', '2026-10-01T00:00:00Z')].join('\n'),
  );
  await writeFile(join(project, 'session-1', 'subagents', 'agent-1.jsonl'), `${assistant('b', '2026-10-19T06:05:00Z', 'claude-haiku-5-5')}\n`);
  const stale = join(project, 'stale.jsonl');
  await writeFile(stale, assistant('c', '2026-10-19T06:10:00Z'));
  await utimes(stale, new Date('2026-09-01'), new Date('2026-09-01'));
});

after(() => rm(root, { recursive: true, force: true }));

test('readUsageEntries reads recent transcripts recursively, dedupes and drops entries before `since`', async () => {
  const entries = await readUsageEntries({ sinceMs: Date.parse('2026-10-12T00:00:00Z'), dirs: [join(root, 'projects'), join(root, 'missing')] });
  assert.deepEqual(entries.map((e) => [e.key, e.model]).sort(), [['a:ra', 'claude-opus-5-5'], ['b:rb', 'claude-haiku-5-5']]);
});

test('projectDirs honours CLAUDE_CONFIG_DIR (comma-separated) and defaults to both config roots', () => {
  assert.deepEqual(projectDirs({ CLAUDE_CONFIG_DIR: '/a, /b' }), ['/a/projects', '/b/projects']);
  const defaults = projectDirs({});
  assert.equal(defaults.length, 2);
  assert.ok(defaults.every((d) => d.endsWith('projects')));
});
