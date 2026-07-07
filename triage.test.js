import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReferral } from './lib/parser.js';
import { buildTray, commitTray } from './lib/diff.js';
import { newCardShell } from './lib/store.js';
import {
  computeTriage, hoursSinceUpdate, isStale, ageLabel, sortCards,
} from './lib/triage.js';

function commitFixture(name, labsEnabled = false) {
  const text = readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
  const parsed = parseReferral(text, { labsEnabled });
  const card = { ...newCardShell(parsed.identity), labsEnabled };
  return commitTray(card, buildTray(parsed, card));
}

test('Aquino card triages bad + needs eyes, with reasons for both NIHSS and ‼️', () => {
  const t = computeTriage(commitFixture('aquino'));
  assert.equal(t.level, 'bad');
  assert.equal(t.needsEyes, true);
  assert.ok(t.reasons.some((r) => r.includes('NIHSS 32')));
  assert.ok(t.reasons.some((r) => r.includes('‼️')));
  assert.ok(t.reasons.some((r) => r.includes('39.2')));
});

test('Santos card triages warn (NIHSS 17, RR 28) — bradycardia contributes nothing', () => {
  const t = computeTriage(commitFixture('santos'));
  assert.equal(t.level, 'warn');
  assert.equal(t.needsEyes, false);
  assert.ok(t.reasons.some((r) => r.includes('NIHSS 17')));
  assert.ok(t.reasons.some((r) => r.includes('RR 28')));
  assert.ok(!t.reasons.some((r) => r.includes('46')), 'HR must not appear as a reason');
});

test('Dela Cruz card triages ok with no reasons', () => {
  const t = computeTriage(commitFixture('dela-cruz'));
  assert.equal(t.level, 'ok');
  assert.deepEqual(t.reasons, []);
});

test('a worsening NIHSS trend surfaces as a reason', () => {
  let card = commitFixture('reyes'); // NIHSS 0
  card = { ...card, nihssHistory: [...card.nihssHistory, { value: 6, at: '2026-07-05T00:00:00Z' }] };
  const t = computeTriage(card);
  assert.ok(t.reasons.includes('NIHSS worsening'));
  assert.equal(t.level, 'warn');
});

test('staleness runs off the referral timestamp with a 24h threshold', () => {
  const card = commitFixture('santos'); // referral June 29, 2026 11:31 AM
  const now = new Date('2026-06-30T11:00:00+08:00').getTime(); // 23.5h later
  assert.equal(isStale(card, now), false);
  const later = new Date('2026-06-30T12:00:00+08:00').getTime(); // 24.5h later
  assert.equal(isStale(card, later), true);
});

test('ageLabel formats hours and days sensibly', () => {
  assert.equal(ageLabel(0.5), 'just now');
  assert.equal(ageLabel(30), '30h ago');
  assert.equal(ageLabel(72), '3d ago');
  assert.equal(ageLabel(Infinity), 'never');
});

test('board sort: sickest first, then stalest within a level', () => {
  const aquino = commitFixture('aquino');     // bad
  const santos = commitFixture('santos');     // warn
  const delaCruz = commitFixture('dela-cruz'); // ok, June 18 (very stale)
  const reyes = commitFixture('reyes');       // ok, July 3 (fresher)

  const now = new Date('2026-07-07T12:00:00+08:00').getTime();
  const order = sortCards([reyes, delaCruz, santos, aquino], now)
    .map((c) => c.identity.name.split(',')[0]);
  assert.deepEqual(order, ['Aquino', 'Santos', 'Dela Cruz', 'Reyes']);
});
