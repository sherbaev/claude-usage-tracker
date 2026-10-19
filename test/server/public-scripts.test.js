import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The dashboard loads app.js and telegram.js as classic scripts: they share one global scope, so a
// top-level name declared in both makes the second script fail to load.
const topLevelNames = (file) =>
  [...readFileSync(new URL(`../../server/public/${file}`, import.meta.url), 'utf8').matchAll(/^(?:const|let|var|function|async function|class) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);

test('dashboard scripts do not redeclare each other\'s top-level names', () => {
  const app = new Set(topLevelNames('app.js'));
  const clashes = topLevelNames('telegram.js').filter((name) => app.has(name));
  assert.deepEqual(clashes, []);
});
