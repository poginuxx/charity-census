// Identity resolution (spec §3). Join key is name + age/sex — there is no
// hospital ID anywhere in the NeuroReferral format. Two different patients
// sharing surname + age/sex is a known, accepted v1 limitation, mitigated
// by putting a human decision in front of every match rather than by a
// smarter algorithm.

// Case-, comma-, period- and whitespace-insensitive name comparison, so
// "Dela Cruz, Juan" and "dela cruz juan" resolve to the same person. Tokens
// are also sorted before comparing: different referral tools write the
// same patient as "Last, First" or "First Last", and since we deliberately
// never guess which word is the surname (invariant #2), the only reliable
// way to recognize "DE VERA, MACKIE" and "Mackie De Vera" as one person is
// to ignore word order entirely.
export function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

// Age matches within ±1 year: a readmission months later can cross a
// birthday, and erring toward a match is safe here because a match never
// merges anything — it only surfaces the human prompt.
function identityMatches(a, b) {
  return (
    normalizeName(a.name) === normalizeName(b.name) &&
    a.sex === b.sex &&
    a.age !== null && b.age !== null &&
    Math.abs(a.age - b.age) <= 1
  );
}

// Returns { status: 'new' } when nobody on the roster matches, or
// { status: 'match', card, cardIsArchived, allMatches } when someone does.
// Active cards win over archived ones; ties go to the most recently
// updated. A match is never acted on here — the caller must collect an
// explicit episode decision first (see requireEpisodeDecision).
export function resolveIdentity(parsedIdentity, roster) {
  const matches = roster.filter((c) => identityMatches(c.identity, parsedIdentity));
  if (matches.length === 0) return { status: 'new' };

  const sorted = [...matches].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
  const best = sorted[0];
  return {
    status: 'match',
    card: best,
    cardIsArchived: best.archived,
    allMatches: sorted,
  };
}

export const EPISODE_DECISIONS = ['same-episode', 'new-episode'];

// Invariant #4 enforced structurally: any commit path must call this before
// touching a matched card. No decision (or an unrecognized one) throws —
// there is no code path that merges silently.
export function requireEpisodeDecision(resolution, decision) {
  if (resolution.status !== 'match') return;
  if (!EPISODE_DECISIONS.includes(decision)) {
    throw new Error(
      'Identity match requires an explicit episode decision ' +
      `("same-episode" or "new-episode"), got: ${JSON.stringify(decision)}`
    );
  }
}
