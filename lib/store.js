// Storage layer — the approved data model (one card = one admission
// episode) plus episode transitions. All functions here are pure data-in,
// data-out; only loadRoster/saveRoster touch localStorage, and they accept
// an injectable storage object so the same code runs in Node tests.

const STORAGE_KEY = 'charity-census-roster-v1';

export function loadRoster(storage = globalThis.localStorage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRoster(roster, storage = globalThis.localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(roster));
}

function randomId() {
  return 'pt_' + Math.random().toString(36).slice(2, 10);
}

// A fresh, empty card in the shape agreed in Phase 2. Parsed fields land on
// it only through the review tray's commit step (Phase 5) — never here.
export function newCardShell(identity, now = new Date().toISOString()) {
  return {
    id: randomId(),
    createdAt: now,
    updatedAt: now,
    lastReferralAt: null,
    archived: false,
    archivedReason: null,
    previousEpisodeId: null,

    identity: { ...identity },
    ward: null,
    assignedResident: null,
    referredBy: null,

    vitals: null,
    nihssHistory: [],
    motor: null,

    labsEnabled: false,
    labsHistory: { na: [], k: [], crea: [], cbg: [] },

    text: {},
  };
}

// The "new episode" decision (spec §3): the old card is archived — never
// hard-deleted — and the new card links back to it via previousEpisodeId,
// so admission-episode history stays walkable.
export function startNewEpisode(roster, oldCardId, identity, now = new Date().toISOString()) {
  const oldCard = roster.find((c) => c.id === oldCardId);
  if (!oldCard) throw new Error(`startNewEpisode: no card with id ${oldCardId}`);

  const archivedOld = {
    ...oldCard,
    archived: true,
    archivedReason: 'new-episode',
    updatedAt: now,
  };
  const newCard = {
    ...newCardShell(identity, now),
    previousEpisodeId: oldCard.id,
    // labs tracking is a judgment about the patient, not the admission —
    // carry the opt-in across episodes rather than silently resetting it
    labsEnabled: oldCard.labsEnabled,
  };

  const nextRoster = roster.map((c) => (c.id === oldCardId ? archivedOld : c));
  nextRoster.push(newCard);
  return { roster: nextRoster, card: newCard };
}

export function archiveCard(roster, cardId, reason, now = new Date().toISOString()) {
  return roster.map((c) =>
    c.id === cardId
      ? { ...c, archived: true, archivedReason: reason, updatedAt: now }
      : c
  );
}

// Undoes an archive (e.g. a discharge marked by mistake). Not in the spec
// explicitly, but falls directly out of "archive, never delete" — if
// nothing is ever destroyed, reversing a mis-click should always be
// possible from the UI, not just from editing storage by hand.
export function restoreCard(roster, cardId, now = new Date().toISOString()) {
  return roster.map((c) =>
    c.id === cardId
      ? { ...c, archived: false, archivedReason: null, updatedAt: now }
      : c
  );
}

const BACKUP_VERSION = 1;

// Human-readable, versioned export — a plain JSON file the consultant can
// save anywhere, independent of the browser (mitigates the one real risk
// of localStorage-only storage: the browser clearing its own data).
export function exportRoster(roster, now = new Date().toISOString()) {
  return JSON.stringify({ version: BACKUP_VERSION, exportedAt: now, roster }, null, 2);
}

// Accepts either a wrapped export ({ version, roster }) or a bare array,
// so a hand-edited or older file still loads. Throws on anything else —
// importing is destructive (replaces the whole roster), so a vague or
// corrupt file must fail loudly rather than silently emptying the census.
export function importRoster(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const roster = Array.isArray(parsed) ? parsed : parsed?.roster;
  if (!Array.isArray(roster)) {
    throw new Error('That file does not look like a Charity Census backup.');
  }
  const valid = roster.every((c) => c && typeof c === 'object' && c.identity?.name);
  if (!valid) {
    throw new Error('That file does not look like a Charity Census backup.');
  }
  return roster;
}
