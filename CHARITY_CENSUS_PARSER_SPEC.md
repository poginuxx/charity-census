# Charity Census Intake Parser — Specification

Scope note: this document describes the intake pipeline for a **new, solo-use
PWA** ("Charity Census") that tracks charity patients managed by residents at
a tertiary training hospital. It is a sibling of the existing Rounds Cockpit
app's Intake Parser (`INTAKE_PARSER_SPEC.md`), reusing the same trust-boundary
philosophy (de-identify → parse → review → commit, nothing auto-applied), but
re-scoped around a structurally different input: **NeuroReferral-formatted
referrals** pasted in from Viber, one patient per message, instead of a
nurse's free-text multi-patient handover.

This app is single-device, single-user (the consultant only — residents never
open it), always-online. There is no multi-user sync, no auth model, and no
offline mode to design for.

---

## 1. Purpose

Every referral a resident sends via Viber has already been run through a
separate tool (NeuroReferral) that reformats their free text into a
consistent, emoji-delimited structure. Today the consultant reads each
message and has no structured, queryable census — patients get lost, updates
get missed, and there's no easy view of "who hasn't been updated in 24
hours" or "which charity patients need my attention right now."

The Charity Census Intake Parser takes one pasted NeuroReferral message and
produces a **proposed** set of changes to one patient's census card — never
committed automatically, always confirmed by the consultant first, exactly
like the existing Intake Parser's review-tray model.

```
[pasted NeuroReferral text]
        │
        ▼
1. De-identify   — redacts patient name + ward/bed + long IDs before any
   (on-device)     cloud call. Resident names (RIC/Referred by) are NOT
                    redacted — they're structured fields the parser needs,
                    and are not patient-identifying on their own.
        │
        ▼
2. Parse         — on-device regex is PRIMARY (not fallback) because the
   (on-device       NeuroReferral format is already highly structured and
   primary,         consistent across messages. Cloud LLM is an optional
   cloud             fallback only for messages that don't match the
   fallback)         expected section structure. This is the inverse of the
                    original Intake Parser, where cloud was primary and
                    on-device regex was the conservative fallback — here the
                    input is structured enough that regex can be trusted as
                    the default path.
        │
        ▼
3. Identity resolution — match parsed (name, age, sex) against the existing
   census roster.
     - No match          → treated as a new patient card.
     - Match found        → consultant is shown an explicit prompt:
                             "Same admission episode, or new episode for
                             this patient?" No silent merge, ever.
        │
        ▼
4. Build review tray — same shape as the existing app: one row per changed
   field, old value vs. new value, severity class, "needs eyes" badge,
   per-row apply toggle.
        │
        ▼
5. Human review        — consultant taps through, nothing pre-applied that
   (UI)                  they haven't seen.
        │
        ▼
6. Commit               — only apply:true rows land on the patient's card;
                           trend fields (NIHSS, and Na/K/Crea/CBG if that
                           patient's labs panel is enabled) get a new history
                           entry, not an overwrite.
```

---

## 2. Hard invariants (carried over from the existing app's philosophy)

1. **De-identify before network.** Only the on-device parser sees raw text
   by default. If the cloud-fallback path is ever invoked, it receives only
   the de-identified payload (patient name, ward/bed, and any long ID
   scrubbed) — never the raw pasted message.
2. **Under-report, never fabricate.** A field the parser can't confidently
   extract stays `null` and is simply absent from the tray — it is never
   guessed at. This applies with extra force to the motor-exam grid (see
   §4.4) and to labs, both of which vary in format across real messages.
3. **Nothing commits without explicit confirmation.** Every parsed field is
   one tray row with its own on/off toggle. `commitPatient`-equivalent logic
   only applies rows the consultant left checked.
4. **No silent identity merges.** A name+age/sex match against an existing
   card always surfaces the same-episode-vs-new-episode prompt (§3) rather
   than assuming either answer.
5. **Manual urgency markers are preserved, not re-derived.** If a resident
   flags a value with ‼️ (seen in real messages, e.g. `‼️ Temp: 39.2`), that
   flag is carried through to the tray as-is, in addition to — not instead
   of — any computed severity band. A resident's judgment call about
   urgency is data, not noise to be overwritten by a threshold.
6. **The parser never sets a patient's overall triage/status color
   directly.** Same as the original app's invariant #4 — triage is always
   recomputed from committed field values, never written directly by the
   parser.

---

## 3. Identity resolution

- **Join key:** `name + age/sex`. There is no hospital ID field anywhere in
  the NeuroReferral format, so this is the practical key.
- **Known limitation, accepted as a v1 tradeoff:** two different charity
  patients could theoretically share both a common surname and the same
  age/sex (not rare given common Filipino surnames in a public hospital
  census). This is not solved automatically — it's mitigated by putting a
  human decision in front of every match (see below), not by a smarter
  matching algorithm.
- **Behavior on match:** when a new referral's (name, age/sex) matches an
  existing card, the consultant is asked, before anything is added to the
  tray: *"This looks like [existing card] — is this the same admission
  episode continuing, or a new episode for this patient?"*
  - **Same episode** → updates flow into the existing card's history.
  - **New episode** → a new card is created; the old card is archived (see
    Rounds Cockpit's archive philosophy — not hard-deleted).
- Worked example: Lim, Juan (30/M) is explicitly a readmission — "previously
  admitted... last june 20, 2026" — a real case this exact prompt is built
  for.

---

## 4. Field extraction rules

The NeuroReferral format uses consistent emoji section headers across all
sampled messages: `👤 PATIENT`, `🩺 ASSESSMENT`, `📝 HISTORY`, `📊 VITAL
SIGNS`, `🔬 PHYSICAL EXAM`, `🧠 NEURO EXAM`, `🧪 LABS & IMAGING`, `💊 MEDS ON
BOARD` (optional — only present when meds are already running), `📋 PLANS`.
Parsing should locate these section markers first, then apply field rules
within each section's text block.

### 4.1 `👤 PATIENT` block — structured, high confidence

| field | source line | notes |
|---|---|---|
| `name` | `Dela Cruz, Juan \| 50/F` (first segment) | de-identified before any cloud call |
| `age` / `sex` | same line, second segment | combined with name as the join key |
| `ward` | `Ward: 311` | redacted to `[WARD]` before cloud call |
| `assignedResident` | `RIC: Cleo Casongsong` | this is the census "owner" field — no separate data entry needed |
| `referredBy` | `Referred by: ...` | often identical to RIC but not always; keep both |
| `referralDateTime` | `Date & Time: ...` | used for "last updated" and staleness filters |

### 4.2 `🩺 ASSESSMENT` block

| field | rule | notes |
|---|---|---|
| `assessmentText` | entire section, verbatim | free prose, no consistent internal structure across samples — do not attempt further extraction, same philosophy as the original app's `note` field |
| `nihss` | look for `NIHSS:\s*(\d{1,2})` on its own line within this section | tracked as a **trend**, not a snapshot (§5) |

### 4.3 `📊 VITAL SIGNS` block — the most reliable section

Consistent format across every sample: `BP: X/Y | HR: X | RR: X | Temp:
X°C | O2: X%` followed by `GCS: X (EaVbMc)` on its own line.

| field | rule | notes |
|---|---|---|
| `bp` | text after `BP:` up to `\|` | store as string, e.g. `"90/60"` |
| `hr`, `rr` | number after `HR:` / `RR:` | plain integer |
| `temp` | number after `Temp:` | **check for a leading ‼️ on this line** — if present, carry an `urgentFlag: true` on this field regardless of the numeric value (invariant #5) |
| `o2` | number+`%` after `O2:` | note some messages qualify this ("via FM @ 10 lpm") — capture the qualifier as a suffix note, don't discard it |
| `gcs` | number + parenthetical breakdown after `GCS:` | keep both the total and the E/V/M breakdown string |

### 4.4 `🧠 NEURO EXAM` block — format is NOT fully consistent, under-report on mismatch

Four of five sampled messages use a labeled format:
```
Motor: RUE 5/5 | LUE 5/5 | RLE 5/5 | LLE 5/5
```
One sampled message (Aquino) uses an unlabeled positional grid instead:
```
  R    L
0/5 | 2/5
0/5 | 0/5
```
**Rule:** only extract structured motor-exam values when the labeled
`RUE/LUE/RLE/LLE` format matches. On the unlabeled grid variant, leave the
structured motor field `null` and surface the whole Neuro Exam section
verbatim in the tray instead — guessing which number belongs to which limb
from position alone risks exactly the kind of silent data corruption
invariant #2 exists to prevent. This is a direct regression-test case,
equivalent in spirit to the original app's "finally" bug fixture — any
future change to this parser must keep both formats as test fixtures.

Other fields in this section (sensory, pupils, facial asymmetry, meningeal
signs, Babinski) stay in the verbatim Neuro Exam text block for v1 rather
than being individually structured — they don't currently have a clear
consuming use case the way motor and NIHSS do. Revisit if that changes.

### 4.5 `🧪 LABS & IMAGING` block — verbatim by default, opt-in structured panel

Labs appear in free-flowing, inconsistent layouts across samples (sometimes
one line, sometimes multi-line, sometimes absent). Default behavior:
capture the whole section verbatim, same as Assessment/Plans.

**Opt-in exception:** for a patient the consultant has explicitly flagged as
"track labs" (a per-patient setting, not a global default — see §5.3), the
parser additionally attempts to pull out `Na`, `K`, `Crea`, and `CBG` as
structured, trended values, using the same word-boundary discipline as the
original app (`\bna\b`, not a bare substring match — Reyes' example shows
`Na 130.80` inside a multi-value electrolytes line, which is exactly the
kind of context a loose match could misfire on).

### 4.6 `📋 PLANS` (and `💊 MEDS ON BOARD` when present)

Verbatim, same as Assessment. Formatting varies too much across samples
(bullets, `Dx`/`Tx` sub-headers, plain sentences) to justify structured
extraction for v1.

---

## 5. Severity bands and tray semantics

### 5.1 NIHSS bands (tracked trend, mirrors the original app's sodium trend)

| NIHSS | Category | Tray class |
|---|---|---|
| 0 | No stroke symptoms | neutral/good |
| 1–4 | Minor | good |
| 5–15 | Moderate | warn |
| 16–20 | Moderate–severe | warn |
| 21–42 | Severe | **bad + crit ("needs eyes")** |

Each new NIHSS reading appends to that patient's NIHSS history (same shape
as the original app's `p.na` — keep a short trailing history, compute
direction — worse/better/unchanged — from the last two readings) rather
than overwriting a single value.

### 5.2 Vitals severity (reuse original app's thresholds where they apply)

- RR ≥ 24 or SpO₂ < 95 → `warn`/`crit`, same as the existing app.
- Temp: no hard-coded fever threshold is mandated here — the resident's
  manual ‼️ flag (§4.3) always surfaces regardless of value. A sensible
  default in addition to that (e.g. ≥38.0°C → warn, ≥39.0°C → bad) is
  reasonable but should be treated as a tunable default, not an invariant,
  since a resident's manual flag already covers the "this matters" signal
  editorially.
- BP/HR: no severity classing for v1, consistent with the original app's
  stance that not every vital needs a computed color.

### 5.3 Labs mini-panel (opt-in, per patient)

Not every charity patient needs Na/K/Crea/CBG tracked as trends — most
census entries won't. This is a per-patient toggle the consultant sets
explicitly (e.g. a patient with AKI or DKA where trending Crea/CBG matters).
Once enabled for a patient, subsequent parses attempt structured extraction
for that patient only, per §4.5; before it's enabled, that patient's labs
stay verbatim-only, same as everyone else.

---

## 6. Worked examples (regression fixtures)

These five real (identifying details as sent by residents) messages are the
basis for the parser's test suite. Recommended fixture set, mirroring the
original app's regression-coverage philosophy — each one exercises a
different edge case:

1. **Dela Cruz, Juan (50/F)** — clean baseline case. Labeled motor exam
   format, no labs, no NIHSS (not a stroke case), no urgency flags. Confirms
   the parser handles a well-formed message with several fields legitimately
   absent (this assessment isn't a stroke, so no NIHSS line exists at all —
   `nihss: null` is correct, not a bug).
2. **Aquino, Juan (68/M)** — the critical/urgent case. NIHSS 32 (must band
   as severe+crit), manual ‼️ on Temp (must carry `urgentFlag: true`
   independent of any computed band), **unlabeled motor-exam grid** (must
   leave motor `null` per §4.4 — this is the pinned regression case for that
   rule), refused-intubation/refused-NGT noted in Plans (verbatim only, no
   attempt to structure "refusal" as a field).
3. **Santos, Juan (84/F)** — NIHSS 17 (moderate–severe band), bradycardic
   HR 46 despite acute stroke context (confirms no HR severity classing
   incorrectly fires), AFib noted only in imaging text (verbatim, not
   structured).
4. **Reyes, Juan (39/F)** — NIHSS 0 (confirms a real, valid zero is not
   confused with "field absent/null" — these must be distinguishable
   states), Na 130.80 present inside a multi-value electrolytes line (tests
   the word-boundary discipline for the opt-in labs panel), labeled motor
   exam format present alongside labs (confirms both extractions can
   coexist without interfering).
5. **Lim, Juan (30/M)** — explicit readmission language in HPI ("previously
   admitted... last june 20, 2026") — the canonical trigger case for the
   same-episode-vs-new-episode prompt in §3. Also has asymmetric motor exam
   in labeled format (`RUE 0/5 | LUE 5/5 | RLE 0/5 | LLE 5/5`) — a real
   right hemiparesis, useful as a "motor deficit present" fixture distinct
   from Dela Cruz's all-5/5 baseline.

---

## 7. Explicit non-goals for v1

- No multi-patient splitting logic — the NeuroReferral format is always
  one-patient-per-message, unlike the original app's nurse-handover input.
- No structured extraction of sensory/pupils/facial-asymmetry/meningeal-sign
  fields — verbatim only, revisit later if a real use case demands it.
- No discharge-blocker checklist (explicitly dropped for v1, may revisit).
- No multi-user access, sync, or auth — single device, single user, always
  online.
- No automatic re-identification-risk scoring — same limitation the
  original app documents: de-identification reduces but doesn't eliminate
  risk, and the final judgment call on what's safe to send to the cloud
  fallback stays with the consultant.
- No teaching-case tagging in v1 (mentioned as an idea, not committed to
  scope).

---

## 8. Suggested file map (for Claude Code to adapt as needed)

| file | role |
|---|---|
| `lib/deid.js` | Redacts patient name, ward/bed, long IDs before any cloud call. Resident names are NOT redacted. |
| `lib/parser.js` | `parseReferral(text)` — on-device section-based extraction is primary; cloud fallback only on structural mismatch. |
| `lib/identity.js` | Matches (name, age, sex) against existing roster; surfaces same-episode/new-episode decision — never merges silently. |
| `lib/trends.js` | Appends NIHSS (and opt-in labs) readings to per-patient history; computes direction. |
| `lib/diff.js` | Tray-row construction, severity banding (§5), commit logic — apply:true rows only. |
| `main.js` | UI glue: paste box, identity-resolution prompt, review tray, commit action, census board rendering. |
| `parser.test.js` | Regression suite built from the five worked examples in §6 — each is a required fixture. |
