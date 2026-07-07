import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReferral } from './lib/parser.js';
import { nihssBand, nihssDirection } from './lib/trends.js';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
}

// 1. Dela Cruz — clean baseline: labeled motor, no labs, no NIHSS line at
// all (not a stroke case), no urgency flags.
test('Dela Cruz: clean baseline case', () => {
  const r = parseReferral(fixture('dela-cruz'));

  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'Dela Cruz, Juan', age: 50, sex: 'F' });
  assert.equal(r.ward, '311');
  assert.equal(r.assignedResident, 'Cleo Casongsong');
  assert.equal(r.referredBy, 'Cleo Casongsong');
  assert.equal(r.referralDateTime, new Date('June 18, 2026 2:47 PM').toISOString());

  assert.equal(r.vitals.bp, '90/60');
  assert.equal(r.vitals.hr, 110);
  assert.equal(r.vitals.rr, 20);
  assert.equal(r.vitals.temp, 36.8);
  assert.equal(r.vitals.tempUrgent, false);
  assert.equal(r.vitals.o2, 98);
  assert.equal(r.vitals.o2Note, null);
  assert.equal(r.vitals.gcsTotal, 15);
  assert.equal(r.vitals.gcsBreakdown, 'E4V5M6');

  assert.deepEqual(r.motor, { rue: '5/5', lue: '5/5', rle: '5/5', lle: '5/5' });

  // Not a stroke case — nihss:null is correct, not a bug (spec §6.1).
  assert.equal(r.nihss, null);
  assert.equal(r.labsStructured, null);

  assert.match(r.text.assessment, /Bell.s Palsy/);
  assert.match(r.text.plans, /Cranial MRI/);
});

// 2. Aquino — the critical/urgent case: NIHSS 32 (severe+crit band),
// manual ‼️ on Temp carried independent of any computed band, unlabeled
// motor grid must stay null, refusal language stays verbatim in Plans.
test('Aquino: critical case with urgent flag and unlabeled motor grid', () => {
  const r = parseReferral(fixture('aquino'));

  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'Aquino, Juan', age: 68, sex: 'M' });
  assert.equal(r.ward, 'MICU Bed 8');
  assert.equal(r.assignedResident, 'Dr. J. Domalanta');
  assert.equal(r.referredBy, 'M. Cuison');

  // NIHSS 32 written inline mid-sentence, no colon, no own-line — the real
  // format that forced relaxing the spec's literal extraction regex.
  assert.equal(r.nihss, 32);
  assert.deepEqual(nihssBand(r.nihss), { category: 'Severe', trayClass: 'bad-crit' });

  // ‼️ flag must be carried regardless of numeric value (invariant #5).
  assert.equal(r.vitals.temp, 39.2);
  assert.equal(r.vitals.tempUrgent, true);
  assert.equal(r.vitals.o2, 97);
  assert.equal(r.vitals.o2Note, 'via FM @ 10 lpm');

  // Unlabeled positional grid — must NOT be guessed at (spec §4.4, the
  // pinned regression case for this rule).
  assert.equal(r.motor, null);

  assert.match(r.text.plans, /refused NGT/);
  assert.match(r.text.plans, /refused intubation/);
  assert.match(r.text.meds, /Lactulose/);
});

// 3. Santos — moderate-severe NIHSS band, bradycardic HR with no severity
// classing firing incorrectly, AFib only in verbatim imaging text.
test('Santos: moderate-severe NIHSS, bradycardia not misclassed', () => {
  const r = parseReferral(fixture('santos'));

  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'Santos, Juan', age: 84, sex: 'F' });

  assert.equal(r.nihss, 17);
  assert.deepEqual(nihssBand(r.nihss), { category: 'Moderate-severe', trayClass: 'warn' });

  assert.equal(r.vitals.hr, 46);
  assert.deepEqual(r.motor, { rue: '4/5', lue: '2/5', rle: '4/5', lle: '2/5' });

  assert.match(r.text.labsImaging, /AFIB/);
});

// 4. Reyes — NIHSS 0 must be a real, distinguishable zero (not confused
// with "absent"), Na 130.80 in a multi-value line tests word-boundary
// discipline, labeled motor and labs coexist without interfering.
test('Reyes: real NIHSS zero, word-boundary labs extraction, opt-in gating', () => {
  const withoutLabs = parseReferral(fixture('reyes'));
  assert.equal(withoutLabs.structuralMismatch, false);

  // A real zero must not collapse to null.
  assert.equal(withoutLabs.nihss, 0);
  assert.notEqual(withoutLabs.nihss, null);
  assert.deepEqual(nihssBand(withoutLabs.nihss), { category: 'No stroke symptoms', trayClass: 'neutral-good' });

  assert.deepEqual(withoutLabs.motor, { rue: '5/5', lue: '5/5', rle: '5/5', lle: '5/5' });

  // Labs stay verbatim-only until the patient's labsEnabled flag is set.
  assert.equal(withoutLabs.labsStructured, null);

  const withLabs = parseReferral(fixture('reyes'), { labsEnabled: true });
  assert.equal(withLabs.labsStructured.na, 130.80);
  assert.equal(withLabs.labsStructured.k, 3.68);
});

// 5. Lim — the readmission trigger case (§3), plus an asymmetric labeled
// motor exam distinct from Dela Cruz's all-5/5 baseline.
test('Lim: readmission language present, asymmetric motor deficit', () => {
  const r = parseReferral(fixture('lim'));

  assert.equal(r.structuralMismatch, false);
  assert.deepEqual(r.identity, { name: 'Lim, Juan', age: 30, sex: 'M' });

  assert.match(r.text.history, /previously admitted/i);
  assert.match(r.text.history, /june 20, 2026/i);

  assert.deepEqual(r.motor, { rue: '0/5', lue: '5/5', rle: '0/5', lle: '5/5' });

  // Not an acute stroke re-scoring in this referral — no NIHSS line.
  assert.equal(r.nihss, null);
});

test('nihssDirection: computed from the last two readings only', () => {
  assert.equal(nihssDirection([{ value: 10, at: '2026-01-01' }]), null);
  assert.equal(
    nihssDirection([
      { value: 10, at: '2026-01-01' },
      { value: 17, at: '2026-01-02' },
    ]),
    'worse'
  );
  assert.equal(
    nihssDirection([
      { value: 17, at: '2026-01-02' },
      { value: 10, at: '2026-01-03' },
    ]),
    'better'
  );
  assert.equal(
    nihssDirection([
      { value: 10, at: '2026-01-01' },
      { value: 10, at: '2026-01-02' },
    ]),
    'unchanged'
  );
});

test('structural mismatch: message missing required sections is flagged, not guessed at', () => {
  const r = parseReferral('👤 PATIENT\nJust a name, no other sections');
  assert.equal(r.structuralMismatch, true);
  assert.ok(r.missingSections.length > 0);
  assert.equal(r.rawText, '👤 PATIENT\nJust a name, no other sections');
});
