import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReferral } from './lib/parser.js';
import {
  normalizeName,
  resolveIdentity,
  requireEpisodeDecision,
} from './lib/identity.js';
import {
  loadRoster,
  saveRoster,
  newCardShell,
  startNewEpisode,
  archiveCard,
} from './lib/store.js';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
}

// The canonical §3 scenario: Lim, Juan (30/M) was admitted June 20 for a
// CVD infarct; his fixture referral is the readmission (AKI/sepsis) that
// must trigger the same-episode-vs-new-episode prompt.
test('Lim readmission: match surfaces, new-episode archives and links', () => {
  const priorAdmission = newCardShell(
    { name: 'Lim, Juan', age: 30, sex: 'M' },
    '2026-06-20T08:00:00.000Z'
  );
  let roster = [priorAdmission];

  const parsed = parseReferral(fixture('lim'));
  const resolution = resolveIdentity(parsed.identity, roster);

  assert.equal(resolution.status, 'match');
  assert.equal(resolution.card.id, priorAdmission.id);
  assert.equal(resolution.cardIsArchived, false);

  // Consultant chooses "new episode" → old card archived (not deleted),
  // new card linked back to it.
  const now = '2026-06-28T16:12:00.000Z';
  const result = startNewEpisode(roster, priorAdmission.id, parsed.identity, now);
  roster = result.roster;

  const oldCard = roster.find((c) => c.id === priorAdmission.id);
  assert.equal(oldCard.archived, true);
  assert.equal(oldCard.archivedReason, 'new-episode');

  assert.equal(result.card.previousEpisodeId, priorAdmission.id);
  assert.equal(result.card.archived, false);
  assert.equal(roster.length, 2);
});

test('no silent merge: acting on a match without a decision throws', () => {
  const roster = [newCardShell({ name: 'Lim, Juan', age: 30, sex: 'M' })];
  const resolution = resolveIdentity({ name: 'Lim, Juan', age: 30, sex: 'M' }, roster);

  assert.throws(() => requireEpisodeDecision(resolution, undefined), /explicit episode decision/);
  assert.throws(() => requireEpisodeDecision(resolution, 'merge'), /explicit episode decision/);
  assert.doesNotThrow(() => requireEpisodeDecision(resolution, 'same-episode'));
  assert.doesNotThrow(() => requireEpisodeDecision(resolution, 'new-episode'));

  // A genuinely new patient needs no decision.
  const fresh = resolveIdentity({ name: 'Torres, Ana', age: 55, sex: 'F' }, roster);
  assert.equal(fresh.status, 'new');
  assert.doesNotThrow(() => requireEpisodeDecision(fresh, undefined));
});

test('name matching is case/comma/whitespace-insensitive', () => {
  assert.equal(normalizeName('Dela Cruz, Juan'), normalizeName('dela cruz juan'));
  assert.equal(normalizeName('  Santos,  Juan '), normalizeName('Santos, Juan'));
  assert.notEqual(normalizeName('Dela Cruz, Juan'), normalizeName('Dela Cruz, Juana'));
});

test('age tolerance: ±1 year matches (birthday between admissions), ±2 does not', () => {
  const roster = [newCardShell({ name: 'Lim, Juan', age: 30, sex: 'M' })];

  assert.equal(resolveIdentity({ name: 'Lim, Juan', age: 31, sex: 'M' }, roster).status, 'match');
  assert.equal(resolveIdentity({ name: 'Lim, Juan', age: 32, sex: 'M' }, roster).status, 'new');
});

test('sex must match exactly', () => {
  const roster = [newCardShell({ name: 'Reyes, Juan', age: 39, sex: 'F' })];
  assert.equal(resolveIdentity({ name: 'Reyes, Juan', age: 39, sex: 'M' }, roster).status, 'new');
});

test('active card preferred over archived; archived-only match is flagged', () => {
  const identity = { name: 'Aquino, Juan', age: 68, sex: 'M' };
  const archived = { ...newCardShell(identity, '2026-05-01T00:00:00.000Z') };
  let roster = archiveCard([archived], archived.id, 'discharged');

  // Only an archived card exists → still a match (returning patient), but
  // flagged so the UI can word the prompt accordingly.
  const r1 = resolveIdentity(identity, roster);
  assert.equal(r1.status, 'match');
  assert.equal(r1.cardIsArchived, true);

  // An active card for the same identity wins over the archived one.
  const active = newCardShell(identity, '2026-07-01T00:00:00.000Z');
  roster = [...roster, active];
  const r2 = resolveIdentity(identity, roster);
  assert.equal(r2.card.id, active.id);
  assert.equal(r2.cardIsArchived, false);
});

test('labsEnabled opt-in carries across episodes', () => {
  const identity = { name: 'Reyes, Juan', age: 39, sex: 'F' };
  const oldCard = { ...newCardShell(identity), labsEnabled: true };
  const { card } = startNewEpisode([oldCard], oldCard.id, identity);
  assert.equal(card.labsEnabled, true);
});

test('roster round-trips through storage', () => {
  const fakeStorage = {
    data: {},
    getItem(k) { return this.data[k] ?? null; },
    setItem(k, v) { this.data[k] = v; },
  };

  assert.deepEqual(loadRoster(fakeStorage), []);

  const roster = [newCardShell({ name: 'Santos, Juan', age: 84, sex: 'F' })];
  saveRoster(roster, fakeStorage);
  assert.deepEqual(loadRoster(fakeStorage), roster);

  // Corrupt data degrades to an empty roster instead of crashing the app.
  fakeStorage.setItem('charity-census-roster-v1', '{not json');
  assert.deepEqual(loadRoster(fakeStorage), []);
});
