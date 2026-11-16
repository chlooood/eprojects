// TerraCorridor land obligations module.
// Agreements already live in a land system (Pandell and others). This does not replace it. It reads
// obligations out, pins each one to the kilometres it covers, and checks them every time work is
// planned there: "km 12 needs 48 hours' landowner notice and a crop damage assessment".
// An AI may extract obligations from a document, but an extracted obligation is a draft until a
// person verifies it, and it is thrown out unless its quote is found word for word in the source.
(function (root) {
  const SEG = root.TC_SEGMENTS || require('./segments.js');

  const TYPES = ['landowner_notice', 'crop_damage_assessment', 'access_restriction', 'timing_window', 'indigenous_monitoring', 'payment', 'reclamation', 'regulatory_commitment', 'other'];
  // What kind of work wakes an obligation up.
  const TRIGGERS = ['any_entry', 'ground_disturbance', 'vegetation_clearing', 'scheduled_date'];
  // Work order kinds and the triggers they set off. An inspection walks on; a dig breaks ground.
  const WORK_TRIGGERS = { inspection: ['any_entry'], walkdown: ['any_entry'], pressure_test: ['any_entry', 'ground_disturbance'], dig: ['any_entry', 'ground_disturbance'], replace_pipe: ['any_entry', 'ground_disturbance', 'vegetation_clearing'], clearing: ['any_entry', 'vegetation_clearing'] };

  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function normalize(raw) {
    const problems = [];
    const o = {
      id: String(raw.id || '').trim(),
      type: TYPES.includes(raw.type) ? raw.type : 'other',
      requirement: String(raw.requirement || '').trim(),
      triggers: (Array.isArray(raw.triggers) ? raw.triggers : [raw.triggers || 'any_entry']).filter((t) => TRIGGERS.includes(t)),
      noticeHours: raw.noticeHours == null || raw.noticeHours === '' ? 0 : +raw.noticeHours,
      kmFrom: raw.kmFrom == null || raw.kmFrom === '' ? null : +raw.kmFrom,
      kmTo: raw.kmTo == null || raw.kmTo === '' ? (raw.kmFrom == null || raw.kmFrom === '' ? null : +raw.kmFrom) : +raw.kmTo,
      window: raw.window || null,            // { noWorkFrom: 'MM-DD', noWorkTo: 'MM-DD' } for timing windows
      party: raw.party || null,
      source: { doc: (raw.source && raw.source.doc) || raw.doc || null, ref: (raw.source && raw.source.ref) || raw.ref || null, quote: (raw.source && raw.source.quote) || raw.quote || null, system: (raw.source && raw.source.system) || raw.system || null },
      extractedBy: raw.extractedBy || 'person',
      verified: raw.verified === true || raw.verified === 'true',
      verifiedBy: raw.verifiedBy || null,
    };
    if (!o.id) problems.push('no id');
    if (!o.requirement) problems.push('no requirement text');
    if (!o.triggers.length) problems.push('no valid trigger');
    if (o.kmFrom == null || Number.isNaN(o.kmFrom) || Number.isNaN(o.kmTo)) problems.push('no location on the line');
    if (Number.isNaN(o.noticeHours) || o.noticeHours < 0) problems.push('bad notice period');
    if (!o.source.doc) problems.push('no source document');
    return { obligation: o, problems };
  }

  // The guard on AI extraction. Keeps an item only if it is well formed AND its quote appears in the document.
  // Everything kept is still unverified: a person has to confirm it before it counts as checked.
  function validateExtraction(items, sourceText, doc) {
    const hay = squash(sourceText), accepted = [], rejected = [];
    for (const raw of items || []) {
      const { obligation: o, problems } = normalize({ ...raw, doc: raw.doc || doc, extractedBy: 'ai', verified: false });
      const quote = squash(o.source.quote);
      if (!quote) problems.push('no quote from the source');
      else if (quote.length < 12) problems.push('quote too short to check');
      else if (!hay.includes(quote)) problems.push('quote not found in the source document');
      if (problems.length) rejected.push({ id: o.id || null, problems }); else accepted.push(o);
    }
    return { accepted, rejected };
  }

  // The prompt for the extraction node. The model may only return what it can quote.
  function extractionPrompt(text, doc) {
    return `You extract land and commitment obligations from a pipeline document for a right-of-way team.
Return a JSON array. Each item: {"id","type","requirement","triggers","noticeHours","kmFrom","kmTo","party","ref","quote"}.
type is one of: ${TYPES.join(', ')}. triggers is a list from: ${TRIGGERS.join(', ')}.
"quote" must be copied word for word from the document and must contain the obligation. If you cannot quote it, leave it out.
Do not infer locations. If the document gives no kilometre post, set kmFrom and kmTo to null.
Document: ${doc || 'untitled'}
---
${text}`;
  }

  // Minimal CSV reader (quoted fields, commas, CRLF) for exports from a land system.
  function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
    const head = (rows.shift() || []).map((h) => h.trim());
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
  }

  // Reads obligations from a land-system export. The column names differ by system and by customer,
  // so the mapping is passed in. The default is this project's own template (data/obligations/TEMPLATE.csv).
  // UNVERIFIED: Pandell's real export layout has not been seen; map its columns here once a customer shares one.
  const DEFAULT_MAPPING = { id: 'obligation_id', type: 'type', requirement: 'requirement', triggers: 'triggers', noticeHours: 'notice_hours', kmFrom: 'km_from', kmTo: 'km_to', party: 'party', doc: 'agreement', ref: 'clause', quote: 'quote', verified: 'verified' };
  function fromCsv(text, mapping = DEFAULT_MAPPING, system = 'land system export') {
    const ok = [], bad = [];
    for (const r of parseCsv(text)) {
      const raw = {}; for (const [k, col] of Object.entries(mapping)) raw[k] = r[col];
      raw.triggers = String(raw.triggers || '').split(/[;|]/).map((t) => t.trim()).filter(Boolean);
      raw.system = system; raw.extractedBy = 'import';
      const { obligation, problems } = normalize(raw);
      (problems.length ? bad : ok).push(problems.length ? { id: obligation.id || null, problems } : obligation);
    }
    return { obligations: ok, rejected: bad };
  }

  // Which obligations sit on which kilometre.
  function pinToSegments(obligations, index) {
    const out = {};
    for (const r of index.ranges) out[r.id] = [];
    for (const o of obligations || []) for (const id of SEG.overlapping(index, o.kmFrom * 1000, o.kmTo * 1000)) out[id].push(o);
    return out;
  }

  const inWindow = (mmdd, w) => (w.noWorkFrom <= w.noWorkTo ? mmdd >= w.noWorkFrom && mmdd <= w.noWorkTo : mmdd >= w.noWorkFrom || mmdd <= w.noWorkTo);

  // The check that runs on every work order. Says what applies, the earliest the crew can start,
  // and refuses to call it clear while an obligation on that kilometre is unverified.
  function checkWorkOrder(wo, segmentObligations, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();
    const fired = WORK_TRIGGERS[wo.kind] || WORK_TRIGGERS.inspection;
    const applies = (segmentObligations || []).filter((o) => o.triggers.some((t) => fired.includes(t)));
    const notice = applies.reduce((m, o) => Math.max(m, o.noticeHours || 0), 0);
    const earliestStart = new Date(now.getTime() + notice * 3600000).toISOString();
    const planned = wo.plannedStart ? new Date(wo.plannedStart) : null;
    const problems = [];
    if (planned && planned < new Date(earliestStart)) problems.push(`Planned start is before the ${notice}-hour notice period ends (${earliestStart.slice(0, 16).replace('T', ' ')} UTC).`);
    for (const o of applies) if (o.window && planned && inWindow(planned.toISOString().slice(5, 10), o.window)) problems.push(`${o.id}: no work between ${o.window.noWorkFrom} and ${o.window.noWorkTo}.`);
    const unverified = applies.filter((o) => !o.verified);
    const steps = applies.map((o) => ({ id: o.id, type: o.type, do: o.requirement, noticeHours: o.noticeHours || 0, party: o.party, source: o.source, verified: o.verified }));
    const km = wo.kmFrom != null ? `km ${wo.kmFrom}` : wo.segment;
    const parts = applies.map((o) => (o.noticeHours ? `${o.noticeHours} hours' notice (${o.type.replace(/_/g, ' ')})` : o.type.replace(/_/g, ' ')));
    return {
      workOrder: wo.id || null, segment: wo.segment || null, kind: wo.kind || 'inspection',
      status: !applies.length ? 'none_on_file' : problems.length ? 'blocked' : unverified.length ? 'needs_verification' : 'clear_to_schedule',
      earliestStart, noticeHours: notice, steps, problems,
      unverified: unverified.map((o) => o.id),
      summary: applies.length ? `${km} needs ${[...new Set(parts)].join(', ')}.` : `${km}: no obligation on file for this kind of work. That is not the same as none existing.`,
    };
  }

  const api = { TYPES, TRIGGERS, WORK_TRIGGERS, DEFAULT_MAPPING, normalize, validateExtraction, extractionPrompt, parseCsv, fromCsv, pinToSegments, checkWorkOrder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_OBLIGATIONS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
