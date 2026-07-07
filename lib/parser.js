// parseReferral(text, options) — on-device extraction of a pasted
// referral/update message. Regex is the primary path.
//
// Real messages come from at least two different referral tools and vary
// in section wording message-to-message (see fixtures: dela-cruz..lim were
// the original NeuroReferral samples; pinto/de-vera-update/ferrer/
// teniente/de-vera-referral are the follow-up batch that exposed real
// format drift). The only thing structurally required to proceed is being
// able to identify the patient (name + age/sex) — every other section is
// optional and extracted opportunistically. This mirrors invariant #2's
// spirit at the message level, not just the field level: a section that
// isn't there stays absent, but its absence doesn't block extracting
// everything that IS there.
//
// Guiding rule throughout (spec invariant #2): a field we can't confidently
// extract comes back null and is simply missing from the result — never
// guessed at.

// Multiple header spellings can map to the same canonical key — real
// residents (and at least one other referral tool) don't all write
// "HISTORY" or "PLANS" the same way. `label` is the human-readable name
// actually used in that message, carried through so the tray/board show
// what the resident wrote instead of a mismatched hardcoded label.
const HEADERS = [
  { key: 'patient', label: 'Patient', re: /^👤\s*PATIENT(?:\s+INFO)?\s*$/m },
  { key: 'assessment', label: 'Assessment', re: /^🩺\s*ASSESSMENT\s*$/m },
  { key: 'assessment', label: 'Reason for referral', re: /^🧠\s*REASON FOR REFERRAL\s*$/m },
  { key: 'history', label: 'History', re: /^📝\s*HISTORY\s*$/m },
  { key: 'history', label: 'Update', re: /^📝\s*UPDATE\s*$/m },
  { key: 'history', label: 'Update / event', re: /^⚡\s*UPDATE\s*\/?\s*EVENT\s*$/m },
  { key: 'vitals', label: 'Vital signs', re: /^📊\s*VITAL SIGNS\s*$/m },
  { key: 'vitals', label: 'Clinical info', re: /^🩺\s*CLINICAL INFO\s*$/m },
  { key: 'physicalExam', label: 'Physical exam', re: /^🔬\s*PHYSICAL EXAM\s*$/m },
  { key: 'neuroExam', label: 'Neuro exam', re: /^🧠\s*NEURO EXAM\s*$/m },
  { key: 'labs', label: 'Labs & imaging', re: /^🧪\s*LABS\s*(?:&|AND|\/)\s*IMAGING\s*$/m },
  { key: 'meds', label: 'Meds on board', re: /^💊\s*MEDS ON BOARD\s*$/m },
  { key: 'meds', label: 'Meds', re: /^ROM\s*$/im },
  { key: 'plans', label: 'Plans', re: /^📋\s*(?:NEURO\s*)?PLANS\s*$/m },
  { key: 'referralInfo', label: 'Referral info', re: /^📍\s*REFERRAL INFO\s*$/m },
];

function splitSections(text) {
  const found = [];
  for (const { key, label, re } of HEADERS) {
    const m = text.match(re);
    if (m) found.push({ key, label, start: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);

  const sections = {};
  const labels = {};
  found.forEach((entry, i) => {
    const next = found[i + 1];
    const body = text.slice(entry.end, next ? next.start : text.length);
    sections[entry.key] = body.trim();
    labels[entry.key] = entry.label;
  });
  return { sections, labels };
}

// Two known identity-line shapes: "Surname, First | 50/F" (NeuroReferral)
// and "First Last | Age: 50 | Sex: Female" (the generic hospital referral
// form). Name order/format is stored verbatim either way — reformatting
// "First Last" into "Last, First" would mean guessing which word is the
// surname, exactly the kind of guess invariant #2 forbids.
function parseIdentityLine(patientBody) {
  const combined = patientBody.match(/^(.+?)\s*\|\s*(\d{1,3})\s*\/?\s*([MFmf])\s*$/m);
  if (combined) {
    return { name: combined[1].trim(), age: Number(combined[2]), sex: combined[3].toUpperCase() };
  }
  const labeled = patientBody.match(/^(.+?)\s*\|\s*Age:\s*(\d{1,3})\s*\|\s*Sex:\s*(\w+)/mi);
  if (labeled) {
    return { name: labeled[1].trim(), age: Number(labeled[2]), sex: labeled[3].trim()[0].toUpperCase() };
  }
  return { name: null, age: null, sex: null };
}

// Ward/RIC/Referred-by/Date&Time can live inside the Patient block
// (NeuroReferral) or be split out into a separate "Referral Info" section
// at the end of the message (the other template) — search both.
function parsePatientBlock(patientBody, referralInfoBody = '') {
  const identity = parseIdentityLine(patientBody);
  const context = `${patientBody}\n${referralInfoBody}`;

  const wardMatch = patientBody.match(/Ward:\s*(.+)/);
  const ricMatch = context.match(/RIC:\s*(.+)/);
  const referredByMatch = context.match(/Referred by:\s*(.+)/i);
  const dateTimeMatch = context.match(/Date\s*&\s*Time:\s*(.+)/i);

  return {
    identity,
    ward: wardMatch ? wardMatch[1].trim() : null,
    assignedResident: ricMatch ? ricMatch[1].trim() : null,
    referredBy: referredByMatch ? referredByMatch[1].trim() : null,
    referralDateTimeRaw: dateTimeMatch ? dateTimeMatch[1].trim() : null,
    referralDateTime: dateTimeMatch ? parseDateTime(dateTimeMatch[1]) : null,
  };
}

// Real messages separate date and time with "·" or "|", write time as
// "9:40pm" (no space, lowercase) or "2:47 PM" (spaced, uppercase), and use
// either "June 18, 2026" or numeric "7/2/26" for the date. We normalize
// just enough for the JS Date constructor to parse it reliably, rather
// than hand-rolling a full date parser.
function parseDateTime(raw) {
  const timeMatch = raw.match(/(\d{1,2}:\d{2})\s*([APap][Mm])/);
  if (!timeMatch) return null;
  const normalizedTime = `${timeMatch[1]} ${timeMatch[2].toUpperCase()}`;

  const monthNameMatch = raw.match(/([A-Za-z]+\.?\s+\d{1,2},?\s*\d{4})/);
  if (monthNameMatch) {
    const d = new Date(`${monthNameMatch[1]} ${normalizedTime}`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const numericMatch = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (numericMatch) {
    const [, m, day, yRaw] = numericMatch;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    const d = new Date(`${m}/${day}/${y} ${normalizedTime}`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

function extractVitals(section) {
  const bp = section.match(/BP:\s*(\d+\/\d+)/);
  const hr = section.match(/HR:\s*(\d+)/);
  const rr = section.match(/RR:\s*(\d+)/);
  // Spec invariant #5: a resident's ‼️ flag is carried through as-is,
  // in addition to any computed severity — so we record it independent of
  // the numeric value.
  const temp = section.match(/(‼️\s*)?Temp:\s*([\d.]+)/);
  // "O2:" or "O2 Sat:" (the generic referral form's wording). The note
  // capture stops at a "|" as well as a newline — some messages pack GCS
  // onto the same pipe-delimited line right after O2.
  const o2 = section.match(/O2(?:\s*Sat)?:\s*(\d+)%[ \t]*([^|\n]*)/i);
  // Breakdown (E/V/M) is optional — the generic referral form only ever
  // gives the total ("GCS: 15", no parenthetical).
  const gcs = section.match(/GCS:?\s*(\d+)(?:\s*\(([^)]+)\))?/i);

  return {
    bp: bp ? bp[1] : null,
    hr: hr ? Number(hr[1]) : null,
    rr: rr ? Number(rr[1]) : null,
    temp: temp ? Number(temp[2]) : null,
    tempUrgent: temp ? Boolean(temp[1]) : false,
    o2: o2 ? Number(o2[1]) : null,
    o2Note: o2 && o2[2].trim() ? o2[2].trim() : null,
    gcsTotal: gcs ? Number(gcs[1]) : null,
    gcsBreakdown: gcs ? gcs[2] || null : null,
  };
}

// Only extracts the labeled RUE/LUE/RLE/LLE format (spec §4.4). The
// unlabeled positional grid variant is left null on purpose — guessing
// which number belongs to which limb from position alone is exactly the
// silent data corruption invariant #2 exists to prevent.
//
// The "|" between limbs is optional (not just optional whitespace): a real
// message wrapped this line so RUE/LUE sit on one line and RLE/LLE on the
// next, with no pipe at the wrap point — "RUE 0/5 | LUE 5/5\nRLE 0/5 | LLE
// 4/5". Requiring a literal pipe there would silently drop the whole row.
function extractMotor(section) {
  const m = section.match(
    /RUE\s*(\d\/5)\s*\|?\s*LUE\s*(\d\/5)\s*\|?\s*RLE\s*(\d\/5)\s*\|?\s*LLE\s*(\d\/5)/i
  );
  if (!m) return null;
  return { rue: m[1], lue: m[2], rle: m[3], lle: m[4] };
}

// Deliberately relaxed from the spec's literal "NIHSS:\s*(\d{1,2}) on its
// own line": real messages (e.g. the Aquino fixture) write it inline,
// mid-sentence, with no colon — "...LMCA Territory NIHSS 32, prob...".
// Matching only the strict form would silently drop the exact case §6
// requires to band as severe+crit.
function extractNihss(assessmentSection) {
  const m = assessmentSection.match(/NIHSS:?\s*(\d{1,2})\b/i);
  return m ? Number(m[1]) : null;
}

// Grabs the numeric chain immediately after a lab label — "3.52", or
// "3.52 → 5.33" when a resident has already trended it themselves inside
// one message — and returns the LAST (most recent) value. Deliberately
// bounded to only digits/dots/arrows so it stops at the next label instead
// of bleeding into it (Lim's fixture has "Crea 1.59 Bun 49.5" on one line —
// unbounded matching would wrongly grab Bun's 49.5 as Crea's value).
function extractLastLabValue(section, labelPattern) {
  const re = new RegExp(
    `\\b${labelPattern}\\b\\s*:?\\s*([\\d.]+(?:\\s*(?:→|->)\\s*[\\d.]+)*)`, 'i'
  );
  const m = section.match(re);
  if (!m) return null;
  const nums = m[1].match(/[\d.]+/g);
  return nums ? Number(nums[nums.length - 1]) : null;
}

// Opt-in only (spec §4.5, §5.3) — caller passes labsEnabled:true for
// patients the consultant has explicitly flagged as "track labs".
function extractLabsStructured(labsSection) {
  return {
    na: extractLastLabValue(labsSection, 'Na'),
    k: extractLastLabValue(labsSection, 'K'),
    crea: extractLastLabValue(labsSection, 'Crea'),
    cbg: extractLastLabValue(labsSection, 'CBG'),
  };
}

export function parseReferral(text, options = {}) {
  const labsEnabled = Boolean(options.labsEnabled);
  const { sections, labels } = splitSections(text);

  // The only hard requirement: we can identify who this message is about.
  // Everything else is extracted opportunistically — a section that's
  // missing (or a message from a template that never had it) just leaves
  // the corresponding fields null, per invariant #2.
  const identity = sections.patient ? parseIdentityLine(sections.patient) : { name: null };
  if (!identity.name) {
    return { structuralMismatch: true, missingSections: ['patient'], rawText: text };
  }

  const patientFields = parsePatientBlock(sections.patient, sections.referralInfo);
  const vitalsSection = sections.vitals ?? '';
  const neuroExamSection = sections.neuroExam ?? '';
  const assessmentSection = sections.assessment ?? '';
  const labsSection = sections.labs ?? '';

  return {
    structuralMismatch: false,
    ...patientFields,
    vitals: extractVitals(vitalsSection),
    motor: extractMotor(neuroExamSection),
    nihss: extractNihss(assessmentSection),
    labsStructured: labsEnabled ? extractLabsStructured(labsSection) : null,
    text: {
      assessment: sections.assessment || null,
      assessmentLabel: labels.assessment ?? null,
      history: sections.history || null,
      historyLabel: labels.history ?? null,
      vitals: sections.vitals || null,
      vitalsLabel: labels.vitals ?? null,
      physicalExam: sections.physicalExam || null,
      neuroExam: sections.neuroExam || null,
      labsImaging: sections.labs || null,
      meds: sections.meds || null,
      plans: sections.plans || null,
    },
  };
}
