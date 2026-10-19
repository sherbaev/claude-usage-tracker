import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, hashToken, isWellFormedToken, safeEqual } from '../../server/src/auth.js';
import { clientIp } from '../../server/src/http.js';
import { createRateLimiter } from '../../server/src/ratelimit.js';
import { openDatabase } from '../../server/src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('openDatabase upgrades a database from an older schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cut-migrate-'));
  const file = join(dir, 'tracker.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)');
  old.prepare('INSERT INTO users (token_hash, created_at) VALUES (?, ?)').run('h', new Date().toISOString());
  old.close();

  const db = openDatabase(file);
  const iso = new Date(0).toISOString();
  assert.deepEqual(db.prune({ reportsBefore: iso, unusedUsersBefore: iso, inactiveUsersBefore: iso }), { devices: 0, users: 0 });
  assert.ok(db.findUserByTokenHash('h'), 'existing user kept');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('tokens are well-formed, unique and hashed', () => {
  const a = generateToken();
  assert.ok(isWellFormedToken(a));
  assert.notEqual(a, generateToken());
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), a);
  assert.equal(isWellFormedToken('cut_short'), false);
  assert.equal(safeEqual('x', 'x'), true);
  assert.equal(safeEqual('x', 'y'), false);
});

test('rate limiter resets after the window', () => {
  let now = 0;
  const hit = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.deepEqual([hit('k'), hit('k'), hit('k'), hit('other')], [true, true, false, true]);
  now = 1001;
  assert.equal(hit('k'), true);
});

test('rate limiter evicts the oldest key when full', () => {
  const hit = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: () => 0 });
  assert.equal(hit('a'), true);
  assert.equal(hit('b'), true);
  assert.equal(hit('c'), true); // evicts "a"
  assert.equal(hit('a'), true, 'a was evicted, so it starts fresh');
  assert.equal(hit('c'), false);
});

test('clientIp takes the entry appended by trusted proxies, ignoring spoofed ones', () => {
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientIp(req, 1), '1.2.3.4', 'client-supplied 6.6.6.6 is ignored');
  assert.equal(clientIp(req, 2), '6.6.6.6');
  assert.equal(clientIp(req, 3), '10.0.0.1', 'fewer entries than hops falls back to socket');
  assert.equal(clientIp(req, 0), '10.0.0.1');
});
