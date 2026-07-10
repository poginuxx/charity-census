// UI glue (spec §8's main.js role): paste box → identity-resolution prompt
// → review tray → explicit commit. Nothing in this file writes to a card
// except the commit handler, and that only applies rows left checked.

import { parseReferral } from '../lib/parser.js';
import { resolveIdentity, requireEpisodeDecision } from '../lib/identity.js';
import { buildTray, commitTray } from '../lib/diff.js';
import {
  loadRoster, saveRoster, newCardShell, startNewEpisode,
  archiveCard, restoreCard, exportRoster, importRoster,
} from '../lib/store.js';
import {
  computeTriage, latestNihss, hoursSinceUpdate, isStale, ageLabel, sortCards,
} from '../lib/triage.js';
import { nihssDirection } from '../lib/trends.js';

let roster = loadRoster();

// One in-flight intake at a time: everything about the current paste lives
// here and is thrown away on reset — nothing touches the roster until commit.
let pending = null;

const $ = (sel) => document.querySelector(sel);

// In-page replacement for confirm(): <dialog> gives us focus trapping and
// Esc-to-cancel for free, and doesn't look like a browser popup inside the
// installed app. Esc/cancel resolves false (returnValue stays '').
function confirmDialog(message, okLabel = 'Confirm') {
  const dlg = $('#confirm-dialog');
  const okBtn = $('#confirm-ok');
  const cancelBtn = dlg.querySelector('[value="cancel"]');
  $('#confirm-message').textContent = message;
  okBtn.textContent = okLabel;

  return new Promise((resolve) => {
    // Resolve from the button clicks themselves — some Chromium builds
    // (e.g. Electron) close a method="dialog" form without ever firing the
    // dialog's close event. close/cancel stay wired as the Esc-key path.
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onClose = () => done(dlg.returnValue === 'confirm');

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('cancel', onCancel);
    dlg.returnValue = '';
    dlg.showModal();
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- intake flow ---------- */

function onParse() {
  const text = $('#paste-box').value.trim();
  if (!text) return;

  const parsed = parseReferral(text);
  if (parsed.structuralMismatch) {
    renderMismatch(parsed);
    return;
  }

  const resolution = resolveIdentity(parsed.identity, roster);
  pending = { rawText: text, parsed, resolution, decision: null, rows: null };

  if (resolution.status === 'match') {
    renderIdentityPrompt();
  } else {
    showTray();
  }
}

function onDecision(decision) {
  pending.decision = decision;
  showTray();
}

function showTray() {
  const { resolution, decision } = pending;

  // Baseline for old-vs-new: the existing card only when continuing the
  // same episode. A new episode diffs against a blank card on purpose —
  // it's a fresh admission, not an update to the old one.
  const baseline =
    resolution.status === 'match' && decision === 'same-episode'
      ? resolution.card
      : null;

  // Labs panel is per-patient opt-in: re-parse with extraction on only if
  // the matched card has it enabled and we're continuing that episode.
  if (baseline?.labsEnabled) {
    pending.parsed = parseReferral(pending.rawText, { labsEnabled: true });
  }

  pending.rows = buildTray(pending.parsed, baseline);
  renderTray(baseline);
}

function onCommit() {
  const { parsed, resolution, decision, rows } = pending;

  // Invariant #4's structural guard, live in the real commit path: a match
  // without an explicit episode decision throws before anything is touched.
  requireEpisodeDecision(resolution, decision);

  const now = new Date().toISOString();
  let committed;

  if (resolution.status === 'new') {
    committed = commitTray(newCardShell(parsed.identity, now), rows, now);
    roster = [...roster, committed];
  } else if (decision === 'same-episode') {
    committed = commitTray(resolution.card, rows, now);
    roster = roster.map((c) => (c.id === committed.id ? committed : c));
  } else {
    const result = startNewEpisode(roster, resolution.card.id, parsed.identity, now);
    committed = commitTray(result.card, rows, now);
    roster = result.roster.map((c) => (c.id === committed.id ? committed : c));
  }

  saveRoster(roster);
  const appliedCount = rows.filter((r) => r.apply).length;
  resetIntake();
  $('#intake-result').innerHTML = `
    <div class="notice success">
      Committed ${appliedCount} field${appliedCount === 1 ? '' : 's'} to
      <strong>${esc(committed.identity.name)}</strong>
      (${esc(committed.identity.age)}/${esc(committed.identity.sex)}).
    </div>`;
  renderCensus();
}

function resetIntake() {
  pending = null;
  $('#paste-box').value = '';
  $('#intake-result').innerHTML = '';
}

/* ---------- rendering ---------- */

function renderMismatch(parsed) {
  $('#intake-result').innerHTML = `
    <div class="notice warn-box">
      <strong>This doesn't look like a NeuroReferral message.</strong>
      Missing section${parsed.missingSections.length === 1 ? '' : 's'}:
      ${parsed.missingSections.map(esc).join(', ')}.
      <p class="fine-print">Nothing was parsed and nothing leaves this device
      (the cloud fallback is stubbed by design). Check that the whole message
      was copied — including the emoji section headers — and paste again.</p>
    </div>
    <pre class="raw-text">${esc(parsed.rawText)}</pre>`;
}

function renderIdentityPrompt() {
  const { card, cardIsArchived } = pending.resolution;
  const p = pending.parsed.identity;
  $('#intake-result').innerHTML = `
    <div class="identity-prompt">
      <p><strong>${esc(p.name)} (${esc(p.age)}/${esc(p.sex)})</strong> looks like
      an existing ${cardIsArchived ? 'archived ' : ''}card:
      <strong>${esc(card.identity.name)} (${esc(card.identity.age)}/${esc(card.identity.sex)})</strong>
      ${card.ward ? ` · Ward ${esc(card.ward)}` : ''}
      ${card.assignedResident ? ` · RIC ${esc(card.assignedResident)}` : ''}</p>
      <p>Is this the <em>same admission episode</em> continuing, or a
      <em>new episode</em> for this patient?</p>
      <div class="prompt-actions">
        <button class="btn primary" data-decision="same-episode">Same episode — update this card</button>
        <button class="btn" data-decision="new-episode">New episode — archive old card, start fresh</button>
      </div>
    </div>`;

  document.querySelectorAll('[data-decision]').forEach((btn) => {
    btn.addEventListener('click', () => onDecision(btn.dataset.decision));
  });
}

function trayRowHtml(row, i) {
  const sevChip = row.severity !== 'neutral'
    ? `<span class="chip sev-${row.severity}">${esc(row.severity)}</span>` : '';
  const eyesBadge = row.needsEyes
    ? '<span class="chip needs-eyes">needs eyes</span>' : '';
  const urgent = row.urgentFlag ? '<span class="chip urgent">‼️ resident-flagged</span>' : '';
  const inferredChip = row.inferred
    ? '<span class="chip inferred">inferred, not stated</span>' : '';

  const oldPart = row.oldDisplay !== null && row.oldDisplay !== undefined
    ? `<span class="old-value">${esc(row.oldDisplay)}</span><span class="arrow">→</span>` : '';

  const valueHtml = row.kind === 'text'
    ? `<details class="text-row"><summary>${oldPart ? 'updated text' : 'view text'}</summary>
         <pre>${esc(row.newDisplay)}</pre></details>`
    : `${oldPart}<span class="new-value">${esc(row.newDisplay)}</span>`;

  return `
    <label class="tray-row">
      <input type="checkbox" data-row="${i}" ${row.apply ? 'checked' : ''}>
      <span class="row-label">${esc(row.label)}</span>
      <span class="row-value">${valueHtml}</span>
      <span class="row-chips">${urgent}${inferredChip}${sevChip}${eyesBadge}</span>
    </label>`;
}

function renderTray(baseline) {
  const { parsed, resolution, decision, rows } = pending;
  const p = parsed.identity;

  const contextNote =
    resolution.status === 'new'
      ? 'New patient — a new census card will be created.'
      : decision === 'same-episode'
        ? 'Updating the existing card for this admission.'
        : 'New episode — the old card will be archived and linked.';

  $('#intake-result').innerHTML = `
    <div class="tray">
      <div class="tray-header">
        <strong>${esc(p.name)} (${esc(p.age)}/${esc(p.sex)})</strong>
        <span class="context-note">${esc(contextNote)}</span>
      </div>
      ${rows.length === 0
        ? '<p class="empty-state">No changes — every parsed field matches the card.</p>'
        : rows.map(trayRowHtml).join('')}
      <div class="tray-actions">
        <button id="commit-btn" class="btn primary" ${rows.length === 0 ? 'disabled' : ''}>
          Commit checked fields</button>
        <button id="cancel-btn" class="btn">Cancel</button>
      </div>
    </div>`;

  // Scoped to #intake-result: the census board (a hidden tab, not unmounted)
  // can simultaneously have its own [data-row] checkboxes open for a card
  // correction — a document-wide selector here would wire up the wrong rows.
  document.querySelectorAll('#intake-result [data-row]').forEach((cb) => {
    cb.addEventListener('change', () => {
      rows[Number(cb.dataset.row)].apply = cb.checked;
    });
  });
  $('#commit-btn')?.addEventListener('click', onCommit);
  $('#cancel-btn').addEventListener('click', resetIntake);
}

/* ---------- census board ---------- */

// View state only — never persisted, never written by the parser.
const boardState = { staleOnly: false, resident: '', grouped: true };

// Manual field correction (spec-adjacent addition): at most one card is
// ever in edit mode at a time. `editingCardId` = showing the input form;
// `cardEditReview` = form submitted, showing the proposed diff for
// confirmation — same two-step "nothing changes without review" shape as
// the intake tray, just scoped to one card instead of a whole message.
let editingCardId = null;
let cardEditReview = null; // { cardId, rows }

function nihssTrendHtml(card) {
  const latest = latestNihss(card);
  if (!latest) return '';
  const direction = nihssDirection(card.nihssHistory);
  const arrow =
    direction === 'worse' ? '<span class="trend worse">▲ worse</span>'
    : direction === 'better' ? '<span class="trend better">▼ better</span>'
    : direction === 'unchanged' ? '<span class="trend">— unchanged</span>' : '';
  return `<span class="vital-bit"><strong>NIHSS ${esc(latest.value)}</strong> ${arrow}</span>`;
}

function vitalsSummaryHtml(card) {
  const v = card.vitals ?? {};
  const bits = [];
  if (v.gcsTotal != null) bits.push(`GCS ${esc(v.gcsTotal)}`);
  if (v.bp) bits.push(`BP ${esc(v.bp)}`);
  if (v.hr != null) bits.push(`HR ${esc(v.hr)}`);
  if (v.rr != null) bits.push(`RR ${esc(v.rr)}`);
  if (v.temp != null) bits.push(`${v.tempUrgent ? '‼️ ' : ''}T ${esc(v.temp)}°`);
  if (v.o2 != null) bits.push(`O2 ${esc(v.o2)}%`);
  return bits.map((b) => `<span class="vital-bit">${b}</span>`).join('');
}

function historyListHtml(entries, format = (v) => v) {
  return entries.map((e) =>
    `<li>${esc(format(e.value))} <span class="fine-print">— ${esc(new Date(e.at).toLocaleString())}</span></li>`
  ).join('');
}

function cardDetailsHtml(card) {
  const labsRows = ['na', 'k', 'crea', 'cbg']
    .filter((k) => card.labsHistory?.[k]?.length)
    .map((k) => `<p><strong>${k.toUpperCase()}</strong></p><ul>${historyListHtml(card.labsHistory[k])}</ul>`)
    .join('');
  const textBlocks = Object.entries({
    assessment: card.text?.assessmentLabel ?? 'Assessment',
    history: card.text?.historyLabel ?? 'History',
    vitals: card.text?.vitalsLabel ?? 'Vitals (verbatim)',
    physicalExam: 'Physical exam', neuroExam: 'Neuro exam',
    labsImaging: 'Labs & imaging', meds: 'Meds on board', plans: 'Plans',
  })
    .filter(([k]) => card.text?.[k])
    .map(([k, label]) => `<p><strong>${label}</strong></p><pre>${esc(card.text[k])}</pre>`)
    .join('');

  return `
    ${card.nihssHistory?.length ? `<p><strong>NIHSS history</strong></p><ul>${historyListHtml(card.nihssHistory)}</ul>` : ''}
    ${labsRows}
    ${textBlocks}`;
}

function censusCardHtml(card, nowMs) {
  if (cardEditReview?.cardId === card.id) return cardEditReviewHtml(card);
  if (editingCardId === card.id) return cardEditFormHtml(card);

  const triage = computeTriage(card);
  const hours = hoursSinceUpdate(card, nowMs);
  const stale = isStale(card, nowMs);

  return `
    <div class="patient-card triage-${triage.level}">
      <div class="card-top">
        <strong>${esc(card.identity.name)}</strong>
        <span>(${esc(card.identity.age)}/${esc(card.identity.sex)})</span>
        ${triage.needsEyes ? '<span class="chip needs-eyes">needs eyes</span>' : ''}
        <span class="age-badge ${stale ? 'stale' : ''}">${esc(ageLabel(hours))}</span>
      </div>
      <div class="card-sub">
        ${card.ward ? `${esc(card.ward)} · ` : ''}RIC ${esc(card.assignedResident ?? '—')}
      </div>
      <div class="card-vitals">${nihssTrendHtml(card)}${vitalsSummaryHtml(card)}</div>
      ${triage.reasons.length
        ? `<div class="card-reasons">${triage.reasons.map((r) => `<span class="chip sev-${triage.level}">${esc(r)}</span>`).join('')}</div>`
        : ''}
      <div class="card-foot">
        <label class="labs-toggle">
          <input type="checkbox" data-labs-toggle="${esc(card.id)}" ${card.labsEnabled ? 'checked' : ''}>
          Track labs (Na/K/Crea/CBG)
        </label>
        <details class="card-details"><summary>Details</summary>${cardDetailsHtml(card)}</details>
      </div>
      <div class="card-actions">
        <button class="btn tiny" data-edit-card="${esc(card.id)}">Edit</button>
        <button class="btn tiny" data-archive="${esc(card.id)}" data-reason="discharged">Discharged</button>
        <button class="btn tiny" data-archive="${esc(card.id)}" data-reason="transferred">Transferred</button>
      </div>
    </div>`;
}

// Manual correction, step 1: a plain form pre-filled with the card's
// current snapshot values. Deliberately limited to snapshot fields (ward,
// RIC, referred-by, vitals, motor exam) — NIHSS/labs are trend histories,
// and editing a past reading is a different, more delicate operation than
// fixing a garbled current value, so it's left out of this feature.
function cardEditFormHtml(card) {
  const v = card.vitals ?? {};
  const m = card.motor ?? {};
  const id = esc(card.id);
  const field = (fieldId, label, value, type = 'text') => `
    <label class="edit-field">
      <span>${label}</span>
      <input type="${type}" id="edit-${fieldId}-${id}" value="${esc(value ?? '')}">
    </label>`;

  return `
    <div class="patient-card edit-card">
      <div class="card-top">
        <strong>${esc(card.identity.name)}</strong>
        <span>(${esc(card.identity.age)}/${esc(card.identity.sex)})</span>
        <span class="fine-print">— editing</span>
      </div>
      <p class="fine-print">Correcting a value here doesn't count as a new
      referral — it won't move the "last updated" clock, and you'll still
      review the change before it's saved.</p>
      <div class="edit-grid">
        ${field('ward', 'Ward', card.ward)}
        ${field('ric', 'RIC', card.assignedResident)}
        ${field('referredby', 'Referred by', card.referredBy)}
        ${field('bp', 'BP', v.bp)}
        ${field('hr', 'HR', v.hr, 'number')}
        ${field('rr', 'RR', v.rr, 'number')}
        ${field('temp', 'Temp', v.temp, 'number')}
        ${field('o2', 'O2 %', v.o2, 'number')}
        ${field('o2note', 'O2 note', v.o2Note)}
        ${field('gcstotal', 'GCS total', v.gcsTotal, 'number')}
        ${field('gcsbreakdown', 'GCS breakdown', v.gcsBreakdown)}
        ${field('rue', 'Motor RUE', m.rue)}
        ${field('lue', 'Motor LUE', m.lue)}
        ${field('rle', 'Motor RLE', m.rle)}
        ${field('lle', 'Motor LLE', m.lle)}
      </div>
      <label class="labs-toggle">
        <input type="checkbox" id="edit-tempurgent-${id}" ${v.tempUrgent ? 'checked' : ''}>
        ‼️ Flag temperature as urgent
      </label>
      <div class="tray-actions">
        <button class="btn primary" data-review-edit="${id}">Review changes</button>
        <button class="btn" data-cancel-edit="${id}">Cancel</button>
      </div>
    </div>`;
}

// Manual correction, step 2: the proposed changes as the exact same
// old-value/new-value tray rows the intake flow uses — same review
// discipline, same per-row toggles, just triggered from a card instead of
// a pasted message.
function cardEditReviewHtml(card) {
  const { rows } = cardEditReview;
  return `
    <div class="patient-card edit-card">
      <div class="card-top">
        <strong>${esc(card.identity.name)}</strong>
        <span>(${esc(card.identity.age)}/${esc(card.identity.sex)})</span>
        <span class="fine-print">— reviewing correction</span>
      </div>
      ${rows.length === 0
        ? '<p class="empty-state">No changes from what\'s already on the card.</p>'
        : rows.map(trayRowHtml).join('')}
      <div class="tray-actions">
        <button class="btn primary" data-confirm-edit="${esc(card.id)}" ${rows.length === 0 ? 'disabled' : ''}>
          Confirm correction</button>
        <button class="btn" data-cancel-review-edit="${esc(card.id)}">Back</button>
      </div>
    </div>`;
}

function readEditForm(card) {
  const id = card.id;
  const raw = (fieldId) => document.getElementById(`edit-${fieldId}-${id}`)?.value.trim() ?? '';
  const str = (fieldId) => { const v = raw(fieldId); return v === '' ? null : v; };
  const num = (fieldId) => { const v = raw(fieldId); return v === '' ? null : Number(v); };

  const rue = str('rue'), lue = str('lue'), rle = str('rle'), lle = str('lle');

  return {
    structuralMismatch: false,
    identity: card.identity,
    ward: str('ward'),
    assignedResident: str('ric'),
    referredBy: str('referredby'),
    referralDateTime: null,
    referralDateTimeRaw: null,
    vitals: {
      bp: str('bp'),
      hr: num('hr'),
      rr: num('rr'),
      temp: num('temp'),
      tempUrgent: document.getElementById(`edit-tempurgent-${id}`)?.checked ?? false,
      o2: num('o2'),
      o2Note: str('o2note'),
      gcsTotal: num('gcstotal'),
      gcsBreakdown: str('gcsbreakdown'),
    },
    motor: (rue || lue || rle || lle) ? { rue, lue, rle, lle } : null,
    nihss: null,
    labsStructured: null,
    text: {},
  };
}

function renderCensus() {
  const nowMs = Date.now();
  const active = roster.filter((c) => !c.archived);
  const staleCount = active.filter((c) => isStale(c, nowMs)).length;
  const residents = [...new Set(active.map((c) => c.assignedResident).filter(Boolean))].sort();

  let shown = active;
  if (boardState.staleOnly) shown = shown.filter((c) => isStale(c, nowMs));
  if (boardState.resident) shown = shown.filter((c) => c.assignedResident === boardState.resident);
  shown = sortCards(shown, nowMs);

  const toolbar = `
    <div class="census-toolbar">
      <button id="stale-filter" class="btn stale-btn ${boardState.staleOnly ? 'active' : ''}">
        ⏰ Not updated &gt;24h <span class="stale-count">${staleCount}</span>
      </button>
      <select id="resident-filter">
        <option value="">All residents</option>
        ${residents.map((r) => `<option value="${esc(r)}" ${r === boardState.resident ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select>
      <label class="group-toggle">
        <input type="checkbox" id="group-toggle" ${boardState.grouped ? 'checked' : ''}> Group by resident
      </label>
    </div>`;

  let body;
  if (active.length === 0) {
    body = `<p class="empty-state">No patients yet. Paste a referral in the
      <strong>Intake</strong> tab to add your first card.</p>`;
  } else if (shown.length === 0) {
    body = '<p class="empty-state">No patients match the current filters.</p>';
  } else if (boardState.grouped && !boardState.resident) {
    const groups = new Map();
    for (const card of shown) {
      const key = card.assignedResident ?? '(no resident)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }
    body = [...groups.keys()].sort().map((resident) => `
      <div class="resident-group">
        <h2 class="resident-heading">${esc(resident)}
          <span class="fine-print">${groups.get(resident).length} patient${groups.get(resident).length === 1 ? '' : 's'}</span></h2>
        ${groups.get(resident).map((c) => censusCardHtml(c, nowMs)).join('')}
      </div>`).join('');
  } else {
    body = shown.map((c) => censusCardHtml(c, nowMs)).join('');
  }

  $('#census-list').innerHTML = toolbar + body;

  $('#stale-filter').addEventListener('click', () => {
    boardState.staleOnly = !boardState.staleOnly;
    renderCensus();
  });
  $('#resident-filter').addEventListener('change', (e) => {
    boardState.resident = e.target.value;
    renderCensus();
  });
  $('#group-toggle').addEventListener('change', (e) => {
    boardState.grouped = e.target.checked;
    renderCensus();
  });
  // Per-patient labs opt-in (spec §5.3) — a consultant judgment recorded on
  // the card; subsequent parses for this patient extract Na/K/Crea/CBG.
  document.querySelectorAll('[data-labs-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      roster = roster.map((c) =>
        c.id === cb.dataset.labsToggle ? { ...c, labsEnabled: cb.checked } : c
      );
      saveRoster(roster);
    });
  });
  // Discharge/transfer archives the card (never deletes it) — reversible
  // from the Archive tab if this was a mis-click.
  document.querySelectorAll('[data-archive]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { archive: cardId, reason } = btn.dataset;
      const card = roster.find((c) => c.id === cardId);
      const ok = await confirmDialog(
        `Mark ${card.identity.name} as ${reason}? You can restore this from the Archive tab.`,
        `Mark ${reason}`
      );
      if (!ok) return;
      roster = archiveCard(roster, cardId, reason);
      saveRoster(roster);
      renderCensus();
    });
  });

  // Manual field correction: form → review diff → confirm. Same
  // two-step review discipline as the intake tray (spec invariant #3),
  // just scoped to one card instead of a whole pasted message.
  document.querySelectorAll('[data-edit-card]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingCardId = btn.dataset.editCard;
      cardEditReview = null;
      renderCensus();
    });
  });
  document.querySelectorAll('[data-cancel-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingCardId = null;
      renderCensus();
    });
  });
  document.querySelectorAll('[data-review-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cardId = btn.dataset.reviewEdit;
      const card = roster.find((c) => c.id === cardId);
      const correction = readEditForm(card);
      const rows = buildTray(correction, card, { skipReferralTimestamp: true });
      editingCardId = null;
      cardEditReview = { cardId, rows };
      renderCensus();
    });
  });
  document.querySelectorAll('[data-cancel-review-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cardEditReview = null;
      renderCensus();
    });
  });
  document.querySelectorAll('[data-confirm-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cardId = btn.dataset.confirmEdit;
      const card = roster.find((c) => c.id === cardId);
      const committed = commitTray(card, cardEditReview.rows);
      roster = roster.map((c) => (c.id === cardId ? committed : c));
      saveRoster(roster);
      cardEditReview = null;
      renderCensus();
    });
  });
  // Scoped to #census-list, mirroring the #intake-result scoping above —
  // both this board and the intake tray can have [data-row] checkboxes
  // present in the DOM at once (hidden tabs aren't unmounted).
  document.querySelectorAll('#census-list [data-row]').forEach((cb) => {
    cb.addEventListener('change', () => {
      cardEditReview.rows[Number(cb.dataset.row)].apply = cb.checked;
    });
  });
}

/* ---------- archive ---------- */

const REASON_LABELS = {
  discharged: 'Discharged',
  transferred: 'Transferred',
  'new-episode': 'Superseded by readmission',
};

function archiveCardHtml(card) {
  const supersededBy = roster.find((c) => c.previousEpisodeId === card.id);
  const continuesFrom = card.previousEpisodeId
    ? roster.find((c) => c.id === card.previousEpisodeId)
    : null;

  return `
    <div class="patient-card archived-card">
      <div class="card-top">
        <strong>${esc(card.identity.name)}</strong>
        <span>(${esc(card.identity.age)}/${esc(card.identity.sex)})</span>
        <span class="chip archive-reason">${esc(REASON_LABELS[card.archivedReason] ?? card.archivedReason ?? 'archived')}</span>
      </div>
      <div class="card-sub">
        ${card.ward ? `${esc(card.ward)} · ` : ''}RIC ${esc(card.assignedResident ?? '—')}
        <span class="fine-print"> · archived ${esc(new Date(card.updatedAt).toLocaleString())}</span>
      </div>
      ${continuesFrom ? `<p class="fine-print">Continues from an earlier admission (${esc(new Date(continuesFrom.updatedAt).toLocaleDateString())}).</p>` : ''}
      ${supersededBy ? `<p class="fine-print">A newer episode for this patient exists on the census.</p>` : ''}
      <div class="card-foot">
        <details class="card-details"><summary>Details</summary>${cardDetailsHtml(card)}</details>
      </div>
      <div class="card-actions">
        <button class="btn tiny" data-restore="${esc(card.id)}">Restore to active census</button>
      </div>
    </div>`;
}

function renderArchive() {
  const archived = roster
    .filter((c) => c.archived)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  $('#archive-list').innerHTML = archived.length === 0
    ? `<p class="empty-state">Archived episodes (discharged, transferred, or
       superseded by a readmission) will appear here.</p>`
    : archived.map(archiveCardHtml).join('');

  document.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      roster = restoreCard(roster, btn.dataset.restore);
      saveRoster(roster);
      renderArchive();
      renderCensus();
    });
  });
}

/* ---------- backup ---------- */

function backupFilename() {
  const d = new Date().toISOString().slice(0, 10);
  return `charity-census-backup-${d}.json`;
}

function onExport() {
  const blob = new Blob([exportRoster(roster)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFilename();
  a.click();
  URL.revokeObjectURL(url);
  $('#backup-status').textContent = `Exported ${roster.length} patient record${roster.length === 1 ? '' : 's'}.`;
}

function onImportFile(e) {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file later
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    const ok = await confirmDialog(
      'Importing replaces the ENTIRE current census with this backup file. ' +
      'This cannot be undone unless you have another backup. Continue?',
      'Replace census'
    );
    if (!ok) return;
    try {
      roster = importRoster(reader.result);
      saveRoster(roster);
      renderCensus();
      renderArchive();
      $('#backup-status').textContent = `Imported ${roster.length} patient record${roster.length === 1 ? '' : 's'}.`;
    } catch (err) {
      $('#backup-status').textContent = `Import failed: ${err.message}`;
    }
  };
  reader.readAsText(file);
}

/* ---------- shell ---------- */

function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')];

  function activate(tab) {
    tabs.forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById(`view-${tab.dataset.view}`).classList.add('active');
    if (tab.dataset.view === 'archive') renderArchive();
    if (tab.dataset.view === 'census') renderCensus();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      activate(next);
    });
  });
}

// "Add to Home Screen": Chromium fires beforeinstallprompt, so we stash the
// event and offer a real Install button. iOS Safari never fires it — there
// we show the manual Share → Add to Home Screen path instead. Either way
// the banner is one-time: dismissing it is remembered, and it never shows
// once the app is already running standalone.
function initInstallPrompt() {
  const DISMISS_KEY = 'census-install-dismissed';
  const banner = $('#install-banner');
  const installed =
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (installed || localStorage.getItem(DISMISS_KEY)) return;

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#install-action').hidden = false;
    banner.hidden = false;
  });

  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('#install-text').textContent =
      'Add this app to your home screen: tap Share, then “Add to Home Screen”.';
    banner.hidden = false;
  }

  $('#install-action').addEventListener('click', async () => {
    banner.hidden = true;
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === 'dismissed') localStorage.setItem(DISMISS_KEY, '1');
  });

  $('#install-dismiss').addEventListener('click', () => {
    banner.hidden = true;
    localStorage.setItem(DISMISS_KEY, '1');
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }
}

initTabs();
initInstallPrompt();
registerServiceWorker();
renderCensus();
$('#parse-btn').addEventListener('click', onParse);
$('#reset-btn').addEventListener('click', resetIntake);
$('#export-btn').addEventListener('click', onExport);
$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', onImportFile);
