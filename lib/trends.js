// NIHSS banding (spec §5.1) and trend direction — mirrors the original
// Rounds Cockpit app's sodium-trend pattern: each new reading appends to a
// short history rather than overwriting a single value.

const BANDS = [
  { min: 0, max: 0, category: 'No stroke symptoms', trayClass: 'neutral-good' },
  { min: 1, max: 4, category: 'Minor', trayClass: 'good' },
  { min: 5, max: 15, category: 'Moderate', trayClass: 'warn' },
  { min: 16, max: 20, category: 'Moderate-severe', trayClass: 'warn' },
  { min: 21, max: 42, category: 'Severe', trayClass: 'bad-crit' },
];

// Returns null for a genuinely absent reading (value is null/undefined) —
// never for a real 0, which is a valid NIHSS score meaning no deficit.
export function nihssBand(value) {
  if (value === null || value === undefined) return null;
  const band = BANDS.find((b) => value >= b.min && value <= b.max);
  return band ? { category: band.category, trayClass: band.trayClass } : null;
}

// Compares the two most recent readings in a patient's NIHSS history
// (each entry shaped { value, at }) to say whether the trend is worsening.
// Lower NIHSS = fewer deficits = better.
export function nihssDirection(history) {
  if (!history || history.length < 2) return null;
  const sorted = [...history].sort((a, b) => new Date(a.at) - new Date(b.at));
  const [prev, curr] = sorted.slice(-2);
  if (curr.value > prev.value) return 'worse';
  if (curr.value < prev.value) return 'better';
  return 'unchanged';
}
