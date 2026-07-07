// parseReferral(text, options) — on-device extraction of a pasted
// NeuroReferral message (spec §4). Regex is the primary path; if the
// message doesn't have all the expected section headers, we bail out with
// structuralMismatch:true rather than guessing at a different layout.
//
// Guiding rule throughout (spec invariant #2): a field we can't confidently
// extract comes back null and is simply missing from the result — never
// guessed at.

const HEADERS = [
  { key: 'patient', re: /^👤\s*PATIENT\s*$/m },
  { key: 'assessment', re: /^🩺\s*ASSESSMENT\s*$/m },
  { key: 'history', re: /^📝\s*HISTORY\s*$/m },
  { key: 'vitals', re: /^📊\s*VITAL SIGNS\s*$/m },
  { key: 'physicalExam', re: /^🔬\s*PHYSICAL EXAM\s*$/m },
  { key: 'neuroExam', re: /^🧠\s*NEURO EXAM\s*$/m },
  { key: 'labs', re: /^🧪\s*LABS\s*(?:&|AND)\s*IMAGING\s*$/m },
  { key: 'meds', re: /^💊\s*MEDS ON BOARD\s*$/m },
  { key: 'plans', re: /^📋\s*PLANS\s*$/m },
];

// All of these must be present for the message to be considered
// well-structured. MEDS ON BOARD is intentionally excluded — spec §4 notes
// it's optional, only present when meds are already running.
const REQUIRED_KEYS = [
  'patient', 'assessment', 'history', 'vitals',
  'physicalExam', 'neuroExam', 'labs', 'plans',
];

function splitSections(text) {
  const found = [];
  for (const { key, re } of HEADERS) {
    const m = text.match(re);
    if (m) found.push({ key, start: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);

  const sections = {};
  found.forEach((entry, i) => {
    const next = found[i + 1];
    const body = text.slice(entry.end, next ? next.start : text.length);
    sections[entry.key] = body.trim();
  });
  return sections;
}

function parsePatientBlock(block) {
  const idMatch = block.match(/^(.+?)\s*\|\s*(\d{1,3})\s*\/?\s*([MFmf])\s*$/m);
  const wardMatch = block.match(/Ward:\s*(.+)/);
  const ricMatch = block.match(/RIC:\s*(.+)/);
  const referredByMatch = block.match(/Referred by:\s*(.+)/);
  const dateTimeMatch = block.match(/Date\s*&\s*Time:\s*(.+)/);

  return {
    identity: {
      name: idMatch ? idMatch[1].trim() : null,
      age: idMatch ? Number(idMatch[2]) : null,
      sex: idMatch ? idMatch[3].toUpperCase() : null,
    },
    ward: wardMatch ? wardMatch[1].trim() : null,
    assignedResident: ricMatch ? ricMatch[1].trim() : null,
    referredBy: referredByMatch ? referredByMatch[1].trim() : null,
    referralDateTimeRaw: dateTimeMatch ? dateTimeMatch[1].trim() : null,
    referralDateTime: dateTimeMatch ? parseDateTime(dateTimeMatch[1]) : null,
  };
}

// Real messages separate date and time with "·" or "|", and write time as
// "9:40pm" (no space, lowercase) or "2:47 PM" (spaced, uppercase). We
// normalize just enough for the JS Date constructor to parse it reliably,
// rather than hand-rolling a date parser.
function parseDateTime(raw) {
  const dateMatch = raw.match(/([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/);
  const timeMatch = raw.match(/(\d{1,2}:\d{2})\s*([APap][Mm])/);
  if (!dateMatch || !timeMatch) return null;
  const normalizedTime = `${timeMatch[1]} ${timeMatch[2].toUpperCase()}`;
  const d = new Date(`${dateMatch[1]} ${normalizedTime}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractVitals(section) {
  const bp = section.match(/BP:\s*(\d+\/\d+)/);
  const hr = section.match(/HR:\s*(\d+)/);
  const rr = section.match(/RR:\s*(\d+)/);
  // Spec invariant #5: a resident's ‼️ flag is carried through as-is,
  // in addition to any computed severity — so we record it independent of
  // the numeric value.
  const temp = section.match(/(‼️\s*)?Temp:\s*([\d.]+)/);
  const o2 = section.match(/O2:\s*(\d+)%[ \t]*(.*)/);
  const gcs = section.match(/GCS:\s*(\d+)\s*\(([^)]+)\)/i);

  return {
    bp: bp ? bp[1] : null,
    hr: hr ? Number(hr[1]) : null,
    rr: rr ? Number(rr[1]) : null,
    temp: temp ? Number(temp[2]) : null,
    tempUrgent: temp ? Boolean(temp[1]) : false,
    o2: o2 ? Number(o2[1]) : null,
    o2Note: o2 && o2[2].trim() ? o2[2].trim() : null,
    gcsTotal: gcs ? Number(gcs[1]) : null,
    gcsBreakdown: gcs ? gcs[2] : null,
  };
}

// Only extracts the labeled RUE/LUE/RLE/LLE format (spec §4.4). The
// unlabeled positional grid variant is left null on purpose — guessing
// which number belongs to which limb from position alone is exactly the
// silent data corruption invariant #2 exists to prevent.
function extractMotor(section) {
  const m = section.match(
    /RUE\s*(\d\/5)\s*\|\s*LUE\s*(\d\/5)\s*\|\s*RLE\s*(\d\/5)\s*\|\s*LLE\s*(\d\/5)/i
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

// Opt-in only (spec §4.5, §5.3) — caller passes labsEnabled:true for
// patients the consultant has explicitly flagged as "track labs". Word
// boundaries matter: Reyes' fixture has "Na 130.80" inside a multi-value
// electrolytes line, exactly the kind of text a loose substring match
// could misfire on (e.g. matching inside "NaCl").
function extractLabsStructured(labsSection) {
  const na = labsSection.match(/\bNa\b\s+([\d.]+)/i);
  const k = labsSection.match(/\bK\b\s+([\d.]+)/i);
  const crea = labsSection.match(/\bCrea\b\s+([\d.]+)/i);
  const cbg = labsSection.match(/\bCBG\b[:\s]+([\d.]+)/i);
  return {
    na: na ? Number(na[1]) : null,
    k: k ? Number(k[1]) : null,
    crea: crea ? Number(crea[1]) : null,
    cbg: cbg ? Number(cbg[1]) : null,
  };
}

export function parseReferral(text, options = {}) {
  const labsEnabled = Boolean(options.labsEnabled);
  const sections = splitSections(text);

  const missingSections = REQUIRED_KEYS.filter((k) => !sections[k] && sections[k] !== '');
  if (missingSections.length > 0) {
    return { structuralMismatch: true, missingSections, rawText: text };
  }

  const patientFields = parsePatientBlock(sections.patient);

  return {
    structuralMismatch: false,
    ...patientFields,
    vitals: extractVitals(sections.vitals),
    motor: extractMotor(sections.neuroExam),
    nihss: extractNihss(sections.assessment),
    labsStructured: labsEnabled ? extractLabsStructured(sections.labs) : null,
    text: {
      assessment: sections.assessment,
      history: sections.history,
      physicalExam: sections.physicalExam,
      neuroExam: sections.neuroExam,
      labsImaging: sections.labs,
      meds: sections.meds || null,
      plans: sections.plans,
    },
  };
}
