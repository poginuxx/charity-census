import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReferral } from './lib/parser.js';
import { buildTray, commitTray } from './lib/diff.js';
import { newCardShell } from './lib/store.js';
import { deidentify } from './lib/deid.js';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
}

function row(rows, id) {
  return rows.find((r) => r.id === id);
}

test('Aquino tray: severity bands, needs-eyes, and ‼️ flag coexist', () => {
  const parsed = parseReferral(fixture('aquino'));
  const rows = buildTray(parsed, null);

  const nihss = row(rows, 'nihss');
  assert.equal(nihss.newValue, 32);
  assert.equal(nihss.severity, 'bad');
  assert.equal(nihss.needsEyes, true);

  // Temp 39.2 computes 'bad' AND carries the resident's ‼️ — both, not
  // either (invariant #5).
  const temp = row(rows, 'vitals.temp');
  assert.equal(temp.severity, 'bad');
  assert.equal(temp.urgentFlag, true);

  // RR 21 is below the warn threshold; HR/BP never get classed.
  assert.equal(row(rows, 'vitals.rr').severity, 'neutral');
  assert.equal(row(rows, 'vitals.hr').severity, 'neutral');
  assert.equal(row(rows, 'vitals.bp').severity, 'neutral');

  // Unlabeled motor grid → no motor row at all (absent, not guessed).
  assert.equal(row(rows, 'motor'), undefined);
  // ...but the verbatim neuro exam text row carries the grid for the eye.
  assert.match(row(rows, 'text.neuroExam').newValue, /0\/5 \| 2\/5/);

  // Meds section present in this fixture → verbatim row exists.
  assert.match(row(rows, 'text.meds').newValue, /Lactulose/);
});

test('Santos tray: RR 28 warns, bradycardic HR 46 stays neutral', () => {
  const rows = buildTray(parseReferral(fixture('santos')), null);
  assert.equal(row(rows, 'vitals.rr').severity, 'warn');
  assert.equal(row(rows, 'vitals.hr').severity, 'neutral');
  assert.equal(row(rows, 'nihss').severity, 'warn'); // 17 = moderate-severe
  assert.equal(row(rows, 'nihss').needsEyes, false);
});

test('Reyes tray: NIHSS 0 makes a real row', () => {
  const rows = buildTray(parseReferral(fixture('reyes')), null);
  const nihss = row(rows, 'nihss');
  assert.ok(nihss, 'NIHSS 0 must produce a row, not be treated as absent');
  assert.equal(nihss.newValue, 0);
  assert.equal(nihss.severity, 'neutral');
});

test('commit applies only apply:true rows', () => {
  const parsed = parseReferral(fixture('dela-cruz'));
  const rows = buildTray(parsed, null);
  row(rows, 'ward').apply = false;

  const card = newCardShell(parsed.identity);
  const committed = commitTray(card, rows);

  assert.equal(committed.ward, null); // toggled off → never landed
  assert.equal(committed.assignedResident, 'Cleo Casongsong');
  assert.equal(committed.vitals.bp, '90/60');
});

test('NIHSS commits append to history, never overwrite', () => {
  const parsed = parseReferral(fixture('santos'));
  let card = newCardShell(parsed.identity);

  card = commitTray(card, buildTray(parsed, card));
  assert.equal(card.nihssHistory.length, 1);
  assert.equal(card.nihssHistory[0].value, 17);
  // Trend entries are timestamped with the referral's own date/time.
  assert.equal(card.nihssHistory[0].at, parsed.referralDateTime);

  // A second identical reading still appends — it's a new observation.
  card = commitTray(card, buildTray(parsed, card));
  assert.equal(card.nihssHistory.length, 2);
});

test('re-parsing an identical message yields only trend rows', () => {
  const parsed = parseReferral(fixture('santos'));
  let card = newCardShell(parsed.identity);
  card = commitTray(card, buildTray(parsed, card));

  const secondTray = buildTray(parsed, card);
  assert.ok(secondTray.every((r) => r.kind === 'trend'),
    `expected only trend rows, got: ${secondTray.map((r) => r.id).join(', ')}`);
});

test('opt-in labs commit as trends', () => {
  const parsed = parseReferral(fixture('reyes'), { labsEnabled: true });
  let card = { ...newCardShell(parsed.identity), labsEnabled: true };
  const rows = buildTray(parsed, card);

  assert.equal(row(rows, 'labs.na').newValue, 130.8);
  card = commitTray(card, rows);
  assert.equal(card.labsHistory.na.length, 1);
  assert.equal(card.labsHistory.na[0].value, 130.8);
  assert.equal(card.labsHistory.k[0].value, 3.68);
  // CBG absent from the message → no entry fabricated.
  assert.equal(card.labsHistory.cbg.length, 0);
});

test('deidentify: patient name and ward redacted, resident names kept', () => {
  const raw = fixture('dela-cruz');
  const clean = deidentify(raw, parseReferral(raw));

  assert.doesNotMatch(clean, /Dela Cruz/i);
  assert.match(clean, /\[PATIENT\]/);
  assert.doesNotMatch(clean, /Ward: 311/);
  assert.match(clean, /Ward: \[WARD\]/);
  // Resident names are structured fields the parser needs — NOT redacted.
  assert.match(clean, /Cleo Casongsong/);
});

test('deidentify: long digit runs redacted, clinical values preserved', () => {
  const clean = deidentify('Case no. 2026114532\nBP: 180/80\nNa 130.80', null);
  assert.doesNotMatch(clean, /2026114532/);
  assert.match(clean, /\[ID\]/);
  assert.match(clean, /180\/80/);
  assert.match(clean, /130\.80/);
});
