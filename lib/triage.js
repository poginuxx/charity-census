// Census-board triage and staleness. Invariant #6 lives here structurally:
// a card's overall color is a pure function of its committed field values,
// computed fresh at render time — the parser has no way to set it because
// there is no stored triage field to set.

import { nihssBand, nihssDirection } from './trends.js';
import { severityForVital } from './diff.js';

export function latestNihss(card) {
  const hist = card.nihssHistory ?? [];
  return hist.length ? hist[hist.length - 1] : null;
}

const LEVEL_RANK = { ok: 0, warn: 1, bad: 2 };

// Returns { level: 'ok'|'warn'|'bad', reasons: [...], needsEyes: bool }.
// Reasons are short human-readable strings shown as chips on the card, so
// the color is never a mystery.
export function computeTriage(card) {
  let level = 'ok';
  const reasons = [];
  let needsEyes = false;

  const bump = (to) => {
    if (LEVEL_RANK[to] > LEVEL_RANK[level]) level = to;
  };

  const nihss = latestNihss(card);
  if (nihss) {
    const band = nihssBand(nihss.value);
    if (band.trayClass === 'bad-crit') {
      bump('bad');
      needsEyes = true;
      reasons.push(`NIHSS ${nihss.value} — ${band.category}`);
    } else if (band.trayClass === 'warn') {
      bump('warn');
      reasons.push(`NIHSS ${nihss.value} — ${band.category}`);
    }
    const direction = nihssDirection(card.nihssHistory);
    if (direction === 'worse') {
      bump('warn');
      reasons.push('NIHSS worsening');
    }
  }

  const v = card.vitals ?? {};
  // The resident's ‼️ is data (invariant #5): it always surfaces as a
  // reason and demands eyes, independent of the numeric thresholds below.
  if (v.tempUrgent) {
    bump('warn');
    needsEyes = true;
    reasons.push('‼️ Temp flagged by resident');
  }
  for (const [key, label, format] of [
    ['temp', 'Temp', (x) => `${x}°C`],
    ['rr', 'RR', (x) => x],
    ['o2', 'O2', (x) => `${x}%`],
  ]) {
    if (v[key] === null || v[key] === undefined) continue;
    const sev = severityForVital(`vitals.${key}`, v[key]);
    if (sev !== 'neutral') {
      bump(sev);
      reasons.push(`${label} ${format(v[key])}`);
    }
  }

  return { level, reasons, needsEyes };
}

// Staleness runs off the referral's own date/time (clinical recency), not
// off when the consultant happened to commit it; updatedAt is only the
// fallback for cards that somehow lack a referral timestamp.
export function hoursSinceUpdate(card, nowMs = Date.now()) {
  const basis = card.lastReferralAt ?? card.updatedAt;
  if (!basis) return Infinity;
  return (nowMs - new Date(basis).getTime()) / 3_600_000;
}

export const STALE_HOURS = 24;

export function isStale(card, nowMs = Date.now()) {
  return hoursSinceUpdate(card, nowMs) >= STALE_HOURS;
}

export function ageLabel(hours) {
  if (!Number.isFinite(hours)) return 'never';
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Board order: sickest first, then stalest first within the same level —
// the two ways a patient gets lost on a messy census.
export function sortCards(cards, nowMs = Date.now()) {
  return [...cards].sort((a, b) => {
    const rankDiff =
      LEVEL_RANK[computeTriage(b).level] - LEVEL_RANK[computeTriage(a).level];
    if (rankDiff !== 0) return rankDiff;
    return hoursSinceUpdate(b, nowMs) - hoursSinceUpdate(a, nowMs);
  });
}
