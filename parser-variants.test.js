// Regression suite for the second batch of real messages — these exposed
// the parser being too strict (requiring every section to exist before
// extracting anything) and several format variants the first batch didn't
// cover: a second referral template entirely, alternate section headers,
// a line-wrapped motor exam, trend-arrow labs, and a message with no
// date/time field at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReferral } from './lib/parser.js';
import { normalizeName, resolveIdentity } from './lib/identity.js';
import { buildTray } from './lib/diff.js';
import { newCardShell } from './lib/store.js';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
}

// Pinto — an "Update"-style NeuroReferral message: 📝 UPDATE instead of
// HISTORY, a typo'd BP ("140/o0") that must stay null rather than being
// guessed at, and a bare "ROM" line standing in for MEDS ON BOARD.
test('Pinto: UPDATE header, ROM-as-meds alias, typo BP stays null but visible verbatim', () => {
  const r = parseReferral(fixture('pinto'));
  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'Pinto, Juan', age: 48, sex: 'F' });

  assert.equal(r.text.historyLabel, 'Update');
  assert.match(r.text.history, /fluctuating BP/);

  // Typo'd "140/o0" doesn't match \d+\/\d+ — correctly absent, never guessed.
  assert.equal(r.vitals.bp, null);
  // ...but the raw line is still visible for the consultant to notice and fix.
  assert.match(r.text.vitals, /140\/o0/);

  assert.match(r.text.meds, /Irbesartan/);
  assert.match(r.text.meds, /Dexamethasone/);

  assert.deepEqual(r.motor, { rue: '0/5', lue: '5/5', rle: '2/5', lle: '5/5' });
});

// De Vera (update) — no title header, a consult-list preamble, ⚡ UPDATE /
// EVENT, a motor exam line-wrapped without a pipe, trend-arrow labs, and
// NO date/time field anywhere in the message.
test('De Vera update: line-wrapped motor, trend-arrow labs take the latest value, no date falls back to inferred', () => {
  const r = parseReferral(fixture('de-vera-update'), { labsEnabled: true });
  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'DE VERA, MACKIE', age: 62, sex: 'M' });

  assert.equal(r.text.historyLabel, 'Update / event');

  // Motor line wraps mid-format with no pipe between LUE and RLE — must
  // still extract, not silently drop the whole row.
  assert.deepEqual(r.motor, { rue: '0/5', lue: '5/5', rle: '0/5', lle: '4/5' });

  // "Na 129 → 130.20" etc — take the most recent (last) value in the chain.
  assert.equal(r.labsStructured.na, 130.20);
  assert.equal(r.labsStructured.k, 4.85);
  assert.equal(r.labsStructured.crea, 5.33);

  // No "Date & Time:" anywhere in this message.
  assert.equal(r.referralDateTime, null);

  const card = newCardShell(r.identity);
  const rows = buildTray(r, card);
  const referralRow = rows.find((row) => row.id === 'lastReferralAt');
  assert.equal(referralRow.inferred, true);
  assert.ok(referralRow.newValue, 'should still fall back to a usable timestamp');
});

// Ferrer — the OTHER referral template entirely: PATIENT INFO / REASON FOR
// REFERRAL / CLINICAL INFO / REFERRAL INFO. No RIC, no NIHSS, no neuro
// exam section at all — none of that should trigger a structural mismatch.
test('Ferrer: generic referral-form template parses without structural mismatch', () => {
  const r = parseReferral(fixture('ferrer'));
  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'Consolacion Ferrer', age: 82, sex: 'F' });
  assert.equal(r.ward, 'Main Medical, station 1 rm 9');
  assert.equal(r.assignedResident, null); // this template has no RIC field
  assert.equal(r.referredBy, 'Reedan Cynl B. Gaviola');

  // "GCS: 15" with no parenthetical breakdown.
  assert.equal(r.vitals.gcsTotal, 15);
  assert.equal(r.vitals.gcsBreakdown, null);
  // "O2 Sat:" alias, and the qualifier capture must stop before "| GCS:"
  // rather than swallowing the rest of the pipe-delimited line.
  assert.equal(r.vitals.o2, 98);
  assert.equal(r.vitals.o2Note, null);

  // Numeric "7/2/26 7:15pm" date format.
  assert.ok(r.referralDateTime.startsWith('2026-07-02'));

  assert.equal(r.nihss, null); // this template never has NIHSS — correct absence
  assert.equal(r.motor, null); // no neuro exam section at all in this template
});

// Teniente — same template as Ferrer, confirms the REASON FOR REFERRAL
// section's extra stroke-specific lines (Ictus, CT scan done) stay
// verbatim rather than being (mis)structured.
test('Teniente: stroke-specific Reason-for-Referral fields stay verbatim', () => {
  const r = parseReferral(fixture('teniente'));
  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'Reynald Teniente', age: 40, sex: 'M' });
  assert.equal(r.text.assessmentLabel, 'Reason for referral');
  assert.match(r.text.assessment, /Ictus: Jun 5 2026/);
  assert.match(r.text.assessment, /CT Scan done/);
  assert.ok(r.referralDateTime.startsWith('2026-06-11'));
});

// De Vera (referral) — cross-checks against De Vera (update): same real
// patient, two different referral tools writing the name in opposite
// order. Identity resolution must recognize them as one person.
test('De Vera referral + update: name-order-independent identity match', () => {
  const referral = parseReferral(fixture('de-vera-referral'));
  assert.deepEqual(referral.identity, { name: 'Mackie De Vera', age: 62, sex: 'M' });
  // Placeholder text some tools leave when a field wasn't filled in — kept
  // verbatim, not silently blanked, since guessing the real name isn't ours to do.
  assert.equal(referral.referredBy, '[referring staff]');

  assert.equal(
    normalizeName('DE VERA, MACKIE'),
    normalizeName('Mackie De Vera'),
  );

  const roster = [newCardShell(referral.identity)];
  const update = parseReferral(fixture('de-vera-update'));
  const resolution = resolveIdentity(update.identity, roster);
  assert.equal(resolution.status, 'match');
});
