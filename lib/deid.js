// De-identification before any network call (invariant #1). Redacts the
// patient's name, ward/bed, and long digit runs. Resident names (RIC /
// Referred by) are deliberately NOT redacted — they're structured fields
// the parser needs, and are not patient-identifying on their own.
//
// v1 note: the cloud-fallback path is stubbed (no actual network call is
// ever made), but this module is built and tested for real so the day a
// cloud call is wired in, the redaction step already exists in front of it.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `parsed` is the parseReferral result when available — knowing the exact
// name string lets us redact every occurrence, not just the PATIENT line.
export function deidentify(text, parsed = null) {
  let out = text;

  if (parsed?.identity?.name) {
    const name = parsed.identity.name;
    out = out.replace(new RegExp(escapeRegex(name), 'gi'), '[PATIENT]');
    // Also catch the name without the comma ("Dela Cruz Juan") and the
    // surname-only form residents use in running prose ("Pt Dela Cruz ...").
    const noComma = name.replace(/,/g, '');
    out = out.replace(new RegExp(escapeRegex(noComma), 'gi'), '[PATIENT]');
    const surname = name.split(',')[0].trim();
    if (surname.length >= 3) {
      out = out.replace(new RegExp(`\\b${escapeRegex(surname)}\\b`, 'gi'), '[PATIENT]');
    }
  } else {
    // No parse available (e.g. structural mismatch): redact the whole
    // name/age/sex line pattern instead.
    out = out.replace(/^(.+?)\s*\|\s*\d{1,3}\s*\/?\s*[MFmf]\s*$/gm, '[PATIENT] | [AGE/SEX]');
  }

  out = out.replace(/^(Ward:).*$/gm, '$1 [WARD]');
  // Long digit runs (5+) — hospital/case numbers, phone numbers. Clinical
  // values never run that long undelimited.
  out = out.replace(/\d{5,}/g, '[ID]');

  return out;
}
