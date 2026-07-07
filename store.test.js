import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newCardShell, archiveCard, restoreCard, exportRoster, importRoster,
} from './lib/store.js';

test('restoreCard undoes an archive without touching other fields', () => {
  const card = newCardShell({ name: 'Torres, Ana', age: 55, sex: 'F' });
  let roster = archiveCard([card], card.id, 'discharged');
  assert.equal(roster[0].archived, true);

  roster = restoreCard(roster, card.id);
  assert.equal(roster[0].archived, false);
  assert.equal(roster[0].archivedReason, null);
  assert.equal(roster[0].identity.name, 'Torres, Ana');
});

test('exportRoster produces a versioned, re-importable backup', () => {
  const roster = [
    newCardShell({ name: 'Torres, Ana', age: 55, sex: 'F' }),
    newCardShell({ name: 'Cruz, Ben', age: 40, sex: 'M' }),
  ];
  const json = exportRoster(roster, '2026-07-07T00:00:00.000Z');
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.exportedAt, '2026-07-07T00:00:00.000Z');
  assert.equal(parsed.roster.length, 2);

  const reimported = importRoster(json);
  assert.deepEqual(reimported, roster);
});

test('importRoster also accepts a bare array (hand-edited or older file)', () => {
  const roster = [newCardShell({ name: 'Torres, Ana', age: 55, sex: 'F' })];
  const reimported = importRoster(JSON.stringify(roster));
  assert.deepEqual(reimported, roster);
});

test('importRoster fails loudly on garbage rather than silently emptying the census', () => {
  assert.throws(() => importRoster('not json'), /not valid JSON/);
  assert.throws(() => importRoster('{"hello":"world"}'), /does not look like/);
  assert.throws(() => importRoster('[{"foo":"bar"}]'), /does not look like/);
});
