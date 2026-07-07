// Tray-row construction and commit logic (spec §5 and pipeline steps 4+6).
//
// buildTray(parsed, card) turns a parse result into rows of
// old-value-vs-new-value, each with its own apply toggle. commitTray applies
// only apply:true rows — invariant #3 lives here. Trend fields (NIHSS, and
// labs when that patient's panel is enabled) append a history entry instead
// of overwriting — never a snapshot overwrite.
//
// The parser never sets a triage color and neither does this module
// (invariant #6): severity here is per-row tray classing only; any overall
// patient color is recomputed from committed values at render time.

// Tunable defaults, not invariants (spec §5.2). RR/SpO2 mirror the original
// app's thresholds; temp bands are the spec's suggested defaults — the
// resident's manual ‼️ flag surfaces regardless of these numbers.
export const THRESHOLDS = {
  rrWarn: 24, rrBad: 30,
  o2Warn: 95, o2Bad: 90, // below these
  tempWarn: 38.0, tempBad: 39.0,
};

import { nihssBand } from './trends.js';

export function severityForVital(id, value) {
  switch (id) {
    case 'vitals.rr':
      if (value >= THRESHOLDS.rrBad) return 'bad';
      if (value >= THRESHOLDS.rrWarn) return 'warn';
      return 'neutral';
    case 'vitals.o2':
      if (value < THRESHOLDS.o2Bad) return 'bad';
      if (value < THRESHOLDS.o2Warn) return 'warn';
      return 'neutral';
    case 'vitals.temp':
      if (value >= THRESHOLDS.tempBad) return 'bad';
      if (value >= THRESHOLDS.tempWarn) return 'warn';
      return 'neutral';
    default:
      // BP and HR deliberately get no severity classing (spec §5.2).
      return 'neutral';
  }
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function motorDisplay(m) {
  if (!m) return null;
  return `RUE ${m.rue} | LUE ${m.lue} | RLE ${m.rle} | LLE ${m.lle}`;
}

function gcsDisplay(g) {
  if (!g) return null;
  return g.breakdown ? `${g.total} (${g.breakdown})` : String(g.total);
}

// Rows only exist for fields the parser confidently extracted (invariant
// #2: absent stays absent) AND that actually differ from the card — except
// trend fields, where every new reading is a new observation worth
// recording even if the value repeats.
export function buildTray(parsed, card = null) {
  const rows = [];

  const addSet = (id, label, oldValue, newValue, extras = {}) => {
    if (newValue === null || newValue === undefined) return;
    if (sameValue(oldValue, newValue)) return;
    rows.push({
      id, label, kind: 'set',
      oldValue: oldValue ?? null, newValue,
      oldDisplay: extras.oldDisplay ?? (oldValue ?? null),
      newDisplay: extras.newDisplay ?? newValue,
      severity: extras.severity ?? 'neutral',
      needsEyes: extras.needsEyes ?? false,
      urgentFlag: extras.urgentFlag ?? false,
      apply: true,
    });
  };

  addSet('ward', 'Ward', card?.ward, parsed.ward);
  addSet('assignedResident', 'RIC', card?.assignedResident, parsed.assignedResident);
  addSet('referredBy', 'Referred by', card?.referredBy, parsed.referredBy);
  addSet('lastReferralAt', 'Referral date/time', card?.lastReferralAt, parsed.referralDateTime, {
    oldDisplay: card?.lastReferralAt ?? null,
    newDisplay: parsed.referralDateTimeRaw ?? parsed.referralDateTime,
  });

  const v = parsed.vitals ?? {};
  const cv = card?.vitals ?? {};
  addSet('vitals.bp', 'BP', cv.bp, v.bp);
  addSet('vitals.hr', 'HR', cv.hr, v.hr);
  addSet('vitals.rr', 'RR', cv.rr, v.rr, { severity: severityForVital('vitals.rr', v.rr) });
  addSet('vitals.temp', 'Temp', cv.temp, v.temp, {
    severity: severityForVital('vitals.temp', v.temp),
    // Invariant #5: the resident's ‼️ is carried in addition to — never
    // instead of — the computed band.
    urgentFlag: v.tempUrgent === true,
  });
  addSet('vitals.o2', 'O2', cv.o2, v.o2, {
    severity: severityForVital('vitals.o2', v.o2),
    newDisplay: v.o2Note ? `${v.o2}% ${v.o2Note}` : (v.o2 != null ? `${v.o2}%` : null),
    oldDisplay: cv.o2 != null ? `${cv.o2}%` : null,
  });
  if (v.gcsTotal !== null && v.gcsTotal !== undefined) {
    const oldGcs = cv.gcsTotal != null ? { total: cv.gcsTotal, breakdown: cv.gcsBreakdown } : null;
    const newGcs = { total: v.gcsTotal, breakdown: v.gcsBreakdown };
    addSet('vitals.gcs', 'GCS', oldGcs, newGcs, {
      oldDisplay: gcsDisplay(oldGcs),
      newDisplay: gcsDisplay(newGcs),
    });
  }
  if (v.o2Note) {
    // keep the qualifier alongside the number on the card
    addSet('vitals.o2Note', 'O2 note', cv.o2Note, v.o2Note);
  }

  addSet('motor', 'Motor exam', card?.motor, parsed.motor, {
    oldDisplay: motorDisplay(card?.motor),
    newDisplay: motorDisplay(parsed.motor),
  });

  // NIHSS is a trend: a reading (including a real 0) always makes a row,
  // appended to history on commit — never overwritten.
  if (parsed.nihss !== null && parsed.nihss !== undefined) {
    const band = nihssBand(parsed.nihss);
    const last = card?.nihssHistory?.length
      ? card.nihssHistory[card.nihssHistory.length - 1].value
      : null;
    rows.push({
      id: 'nihss', label: 'NIHSS', kind: 'trend',
      oldValue: last, newValue: parsed.nihss,
      oldDisplay: last, newDisplay: `${parsed.nihss} — ${band.category}`,
      severity: band.trayClass === 'bad-crit' ? 'bad'
        : band.trayClass === 'warn' ? 'warn'
        : band.trayClass === 'good' ? 'good' : 'neutral',
      needsEyes: band.trayClass === 'bad-crit',
      urgentFlag: false,
      apply: true,
    });
  }

  // Opt-in labs trends (spec §4.5/§5.3) — parser only produces these when
  // the patient's labsEnabled flag was passed in.
  if (parsed.labsStructured) {
    for (const key of ['na', 'k', 'crea', 'cbg']) {
      const value = parsed.labsStructured[key];
      if (value === null || value === undefined) continue;
      const hist = card?.labsHistory?.[key] ?? [];
      const last = hist.length ? hist[hist.length - 1].value : null;
      rows.push({
        id: `labs.${key}`, label: key.toUpperCase(), kind: 'trend',
        oldValue: last, newValue: value,
        oldDisplay: last, newDisplay: value,
        severity: 'neutral', needsEyes: false, urgentFlag: false,
        apply: true,
      });
    }
  }

  const textLabels = {
    assessment: 'Assessment', history: 'History', physicalExam: 'Physical exam',
    neuroExam: 'Neuro exam', labsImaging: 'Labs & imaging', meds: 'Meds on board',
    plans: 'Plans',
  };
  for (const [key, label] of Object.entries(textLabels)) {
    const newText = parsed.text?.[key];
    if (!newText) continue;
    const oldText = card?.text?.[key] ?? null;
    if (sameValue(oldText, newText)) continue;
    rows.push({
      id: `text.${key}`, label, kind: 'text',
      oldValue: oldText, newValue: newText,
      oldDisplay: oldText, newDisplay: newText,
      severity: 'neutral', needsEyes: false, urgentFlag: false,
      apply: true,
    });
  }

  return rows;
}

// Applies apply:true rows to a card and returns a new card object.
// Trend rows append { value, at } (at = the referral's own timestamp when
// we have it — clinically that's when the reading happened — else now).
export function commitTray(card, rows, now = new Date().toISOString()) {
  const next = {
    ...card,
    vitals: { ...(card.vitals ?? {}) },
    nihssHistory: [...(card.nihssHistory ?? [])],
    labsHistory: {
      na: [...(card.labsHistory?.na ?? [])],
      k: [...(card.labsHistory?.k ?? [])],
      crea: [...(card.labsHistory?.crea ?? [])],
      cbg: [...(card.labsHistory?.cbg ?? [])],
    },
    text: { ...(card.text ?? {}) },
  };

  const applied = rows.filter((r) => r.apply);
  const referralRow = applied.find((r) => r.id === 'lastReferralAt');
  const readingAt = referralRow?.newValue ?? card.lastReferralAt ?? now;

  for (const row of applied) {
    const { id, newValue } = row;
    if (id === 'ward') next.ward = newValue;
    else if (id === 'assignedResident') next.assignedResident = newValue;
    else if (id === 'referredBy') next.referredBy = newValue;
    else if (id === 'lastReferralAt') next.lastReferralAt = newValue;
    else if (id === 'vitals.gcs') {
      next.vitals.gcsTotal = newValue.total;
      next.vitals.gcsBreakdown = newValue.breakdown;
    } else if (id === 'vitals.temp') {
      next.vitals.temp = newValue;
      next.vitals.tempUrgent = row.urgentFlag;
    } else if (id.startsWith('vitals.')) {
      next.vitals[id.slice('vitals.'.length)] = newValue;
    } else if (id === 'motor') next.motor = newValue;
    else if (id === 'nihss') next.nihssHistory.push({ value: newValue, at: readingAt });
    else if (id.startsWith('labs.')) {
      next.labsHistory[id.slice('labs.'.length)].push({ value: newValue, at: readingAt });
    } else if (id.startsWith('text.')) {
      next.text[id.slice('text.'.length)] = newValue;
    }
  }

  next.updatedAt = now;
  return next;
}
