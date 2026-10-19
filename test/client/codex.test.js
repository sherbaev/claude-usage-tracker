import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexSnapshot } from '../../plugin/scripts/codex.js';

let home;
const line = (pct, timestamp) =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: 1800000000 } } } });

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'cut-codex-'));
  await mkdir(join(home, 'sessions', '2026', '10', '19'), { recursive: true });
  await mkdir(join(home, 'archived_sessions'), { recursive: true });
  const older = join(home, 'archived_sessions', 'rollout-a.jsonl');
  await writeFile(older, line(90, '2026-10-18T10:00:00Z'));
  await utimes(older, new Date('2026-10-18T10:00:00Z'), new Date('2026-10-18T10:00:00Z'));
  await writeFile(join(home, 'sessions', '2026', '10', '19', 'rollout-b.jsonl'), [line(10, '2026-10-19T05:00:00Z'), '{"type":"x"}', line(12, '2026-10-19T06:00:00Z')].join('\n'));
});

after(() => rm(home, { recursive: true, force: true }));

test('readCodexSnapshot returns the latest rate-limit snapshot from the newest session', async () => {
  const snap = await readCodexSnapshot({ home, sinceMs: Date.parse('2026-10-12T00:00:00Z') });
  assert.equal(snap.observedAt, '2026-10-19T06:00:00.000Z');
  assert.equal(snap.plan.fiveHour.pct, 12);
});

test('readCodexSnapshot returns null without Codex data', async () => {
  assert.equal(await readCodexSnapshot({ home: join(home, 'missing'), sinceMs: 0 }), null);
});
