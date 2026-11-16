// Segment record page. Everything is recomputed in the browser from the inlined data with the same
// modules the tests and the n8n Code nodes run. Decisions and findings are kept in this browser
// (and sent to n8n W7/W9 when the page is opened with ?api=...).
const DATA = window.TC_PLATFORM_DATA, BT = window.TC_BACKTEST;
const { TC_CLASS: CLASS, TC_DECISION: DECISION, TC_LEDGER: LEDGER, TC_FEEDBACK: FEEDBACK, TC_EXPORT: EXPORT, TC_PLATFORM: PLATFORM } = globalThis;
const API = new URLSearchParams(location.search).get('api') || '';
const KEY = 'tc-platform:' + DATA.meta.corridorId;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = EXPORT.money;
let store = { ledger: [], findings: [], orders: [], assumptions: {}, jurisdiction: 'CA' };
try { store = { ...store, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* storage unavailable: keep state in memory */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* in-memory only */ } };
let built = null, selected = null, chosen = {};
const today = () => new Date().toISOString().slice(0, 10);

function compute() {
  const cfg = { classLocation: { jurisdiction: store.jurisdiction }, decision: DECISION.mergeAssumptions(store.assumptions) };
  built = PLATFORM.buildRecords(DATA.segments, { permits: DATA.permits, obligations: DATA.obligations, encroachmentEvents: DATA.encroachmentEvents || undefined, findings: store.findings }, cfg, today());
  built.records.sort((a, b) => (a.openItems[0] ? a.openItems[0].level : 9) - (b.openItems[0] ? b.openItems[0].level : 9) || b.openItems.length - a.openItems.length || a.kmFrom - b.kmFrom);
  if (!selected || !built.records.some((r) => r.id === selected)) selected = built.records[0].id;
}
const rec = () => built.records.find((r) => r.id === selected);
const toast = (m) => { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 4200); };
const chip = (cls, text) => `<span class="chip c-${cls}"><i></i>${esc(text)}</span>`;
const STATUS = { changed: ['red', 'Changed · clock running'], change_committed: ['red', 'Change on the way'], change_possible: ['amber', 'Change possible'], no_change: ['green', 'No change'], unverified: ['grey', 'No data'] };
const TIER = { red: ['red', 'High'], 'red-uncertain': ['red', 'High'], amber: ['amber', 'Medium'], green: ['green', 'Low'], unverified: ['grey', 'No data'] };
const classText = (c) => !c ? 'not loaded' : `Class ${c.class.now}${c.class.isLowerBound ? '+' : ''}${c.change ? ' → ' + c.change.to : ''}`;

function renderList() {
  const s = built.classSummary || {}, open = built.records.reduce((a, r) => a + r.openItems.length, 0), chain = LEDGER.verify(store.ledger);
  $('strip').innerHTML = [[(s.changed || 0) + (s.changeCommitted || 0), 'class changes dated'], [s.changePossible || 0, 'possible, not dated'], [open, 'open items'], [store.ledger.length, chain.ok ? 'decisions, chain intact' : 'CHAIN BROKEN']]
    .map(([n, l]) => `<div><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('');
  $('rows').innerHTML = built.records.map((r) => {
    const c = r.classLocation, st = STATUS[c ? c.status : 'unverified'], g = TIER[r.geohazard.tier] || TIER.unverified;
    return `<tr class="row${r.id === selected ? ' sel' : ''}" data-id="${esc(r.id)}" tabindex="0"><td class="mono">${r.kmFrom}–${r.kmTo}</td>
      <td>${chip(st[0], st[1])}<div class="cap">${esc(classText(c))}${c ? ` · ${c.units.existing} now, ${c.units.committed + c.units.possible} coming` : ''}</div></td>
      <td>${chip(g[0], g[1])}<div class="cap">${esc(r.geohazard.hazard || '')}</div></td><td class="mono">${r.obligations.length || '–'}</td><td class="mono">${r.openItems.length || '–'}</td></tr>`;
  }).join('');
  for (const tr of $('rows').querySelectorAll('tr')) { tr.onclick = () => { selected = tr.dataset.id; render(); }; tr.onkeydown = (e) => { if (e.key === 'Enter') tr.onclick(); }; }
  $('lede').textContent = `${DATA.meta.name}. ${DATA.segments.length} km. Class location, ground, land terms and nearby digging on the same kilometre, with one approval trail. ${DATA.meta.route}`;
  const L = DATA.meta.labels;
  $('labels').innerHTML = [['real', 'Permits: real open data'], ['real', 'Geohazard: real cached run'], ['fake', 'Obligations: invented examples'], ['fake', 'Costs: placeholders']].map(([k, t]) => `<span class="pill ${k}" title="${esc(Object.values(L).join(' | '))}">${esc(t)}</span>`).join(' ');
  $('backtest').innerHTML = BT ? `<div class="box"><p><b>${BT.changes}</b> class change${BT.changes === 1 ? '' : 's'} on this line since ${esc(BT.from.slice(0, 4))}. Issued permits added up to the higher class <b>${esc(BT.medianLeadMonths)} months</b> before the dwellings were estimated to be occupied, in ${BT.flaggedAhead} of ${BT.changes}.</p>
    <table><thead><tr><th>km</th><th>Change</th><th>Permits said so</th><th>Estimated change</th></tr></thead><tbody>${BT.rows.map((r) => `<tr><td class="mono">${r.kmFrom}</td><td>Class ${r.startClass} → ${r.toClass}</td><td class="mono">${esc(r.flagged)}</td><td class="mono">${esc(r.changed || 'not yet')}</td></tr>`).join('')}</tbody></table>
    <p class="cap" style="margin-top:8px">${esc(BT.caveat)}</p></div>` : '<p class="cap">No replay built.</p>';
}

function classBlock(c) {
  if (!c) return '<div class="box">No dwelling or permit data loaded for this corridor. Class location is not assessed here.</div>';
  const t = CLASS.DEFAULTS.thresholds, total = c.units.existing + c.units.committed + c.units.possible, max = Math.max(60, total * 1.15), pct = (n) => (100 * n / max).toFixed(2) + '%';
  const st = STATUS[c.status];
  const say = c.status === 'changed' ? `This window moved from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}.`
    : c.status === 'change_committed' ? `Building permits already issued take this window from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}.`
    : c.status === 'change_possible' ? `Approved development permits could take this window from Class ${c.change.from} to Class ${c.change.to}. No building permits yet, so no date.`
    : c.status === 'unverified' ? 'No dwelling data for this window.' : `No change in sight. ${c.headroom == null ? 'Already Class 3.' : c.headroom + ' more dwellings would reach the next class.'}`;
  return `<p>${chip(st[0], st[1])} <span class="cap">window km ${c.window.kmFrom}–${c.window.kmTo}, 200 m each side</span></p><p>${esc(say)}</p>
    <div class="bar" role="img" aria-label="${c.units.existing} existing, ${c.units.committed} permitted, ${c.units.possible} possible dwellings">
      <span class="ex" style="left:0;width:${pct(c.units.existing)}"></span><span class="co" style="left:${pct(c.units.existing)};width:${pct(c.units.committed)}"></span><span class="po" style="left:${pct(c.units.existing + c.units.committed)};width:${pct(c.units.possible)}"></span>
      <span class="mk" data-l="Class 2 · ${t.class2}" style="left:${pct(t.class2)}"></span><span class="mk" data-l="Class 3 · ${t.class3}" style="left:${pct(t.class3)}"></span></div>
    <p class="cap"><b style="color:#7fb893">${c.units.existing}</b> existing${c.fieldCounted ? ' (counted on site; estimate was ' + c.units.estimatedBeforeCount + ')' : ' (estimate)'} · <b class="c-amber">${c.units.committed}</b> with building permits · <b style="color:#b89545">${c.units.possible}</b> with development permits only. Basis: ${esc(c.basis)}.</p>
    ${c.clock ? `<div class="box ${c.clock.running ? 'bad' : 'warn'}"><b>${c.clock.running ? 'Deadline' : 'Deadline if it changes on that date'}: ${esc(c.clock.due)}</b> (${c.clock.monthsLeft} months). <span class="cap">${esc(c.clock.basis)}</span></div>` : ''}
    ${c.evidence.length ? `<details open><summary>Evidence (${c.evidence.length})</summary><ul>${c.evidence.map((e) => `<li><b>${e.units}</b> unit${e.units === 1 ? '' : 's'} near km ${e.km} · ${esc(e.kind.replace(/_/g, ' '))}${e.note ? ', ' + esc(e.note.replace(/^1 permits/, '1 permit')) : ' issued ' + esc(e.issued)} <span class="mono cap">${esc(e.id)}</span></li>`).join('')}</ul></details>` : ''}
    ${c.plans.length ? `<p class="cap">Plans in effect here: ${c.plans.map((p) => `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join(', ')}</p>` : ''}
    <p class="cap">${esc(c.class4.note)}${c.class4.tallRoofs ? ' Tall roofs in this window: ' + c.class4.tallRoofs + '.' : ''}</p>`;
}

function decisionBlock(r) {
  const d = r.decision; if (!d) return '';
  const pick = chosen[r.id] || (d.lowestCost && d.lowestCost.key);
  return `<h2>Ways to deal with it</h2>${d.pricedWithPlaceholders ? '<div class="box warn">Costs are placeholder assumptions, not operator figures. The ranking is only as good as they are. Edit them under “Cost assumptions”.</div>' : ''}
    <table><thead><tr><th></th><th>Path</th><th class="num">${d.horizonYears}-yr cost</th><th class="num">Months</th><th>In time?</th></tr></thead><tbody>${d.paths.map((p) => `<tr class="${p.eligible ? '' : 'path-off'}"><td>${p.eligible ? `<input type="radio" name="path" value="${p.key}" ${p.key === pick ? 'checked' : ''} aria-label="${esc(p.label)}">` : ''}</td>
      <td><b>${esc(p.label)}</b><div class="cap">${esc(p.why)}${p.materials && p.materials.note ? ' ' + esc(p.materials.note) : ''}${p.obligations.length ? ` Breaks ground: ${p.obligations.length} land obligation${p.obligations.length === 1 ? ' applies' : 's apply'}.` : ''}</div></td>
      <td class="num">${p.eligible ? money(p.total) : '–'}</td><td class="num">${p.eligible ? p.months : '–'}</td><td>${!p.eligible ? '–' : p.meetsDeadline == null ? '<span class="cap">no date yet</span>' : p.meetsDeadline ? chip('green', 'yes') : chip('red', 'no')}</td></tr>`).join('')}</tbody></table>
    ${d.hingesOn.length ? `<p class="cap">The lowest-cost answer flips if: ${d.hingesOn.map((h) => `${esc(h.unit)} were ${esc(Math.round(h.at).toLocaleString('en-US'))} (then ${esc(h.flipsTo.replace(/_/g, ' '))})`).join('; ')}.</p>` : ''}
    ${d.unknowns.length ? `<p class="cap">Still needed from the operator: ${esc(d.unknowns.join('; '))}.</p>` : ''}`;
}

function render() {
  compute(); renderList();
  const r = rec(), g = TIER[r.geohazard.tier] || TIER.unverified, record = LEDGER.decisionRecord(store.ledger, r.id), orders = store.orders.filter((o) => o.segment === r.id);
  $('detail').innerHTML = `<h1>km ${r.kmFrom}–${r.kmTo}</h1><p class="cap mono">${esc(r.id)}</p>
    ${r.openItems.length ? `<div class="box"><b>Open on this kilometre</b><ul>${r.openItems.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ul></div>` : '<div class="box">Nothing open on this kilometre.</div>'}
    <h2>Class location</h2>${classBlock(r.classLocation)}${decisionBlock(r)}
    <h2>Geohazard</h2><p>${chip(g[0], g[1])} ${r.geohazard.score == null ? '' : `<span class="mono">score ${esc(r.geohazard.score)}</span>`} ${esc(r.geohazard.hazard || '')}. <span class="cap">${esc(r.geohazard.why || '')}</span></p>
    <h2>Land obligations on this kilometre</h2>${r.obligations.length ? `<ul>${r.obligations.map((o) => `<li><b>${esc(o.id)}</b> ${esc(o.requirement)}${o.noticeHours ? ` (${o.noticeHours} h notice)` : ''} <span class="cap">${esc(o.source.doc)} ${esc(o.source.ref || '')} · ${o.verified ? 'verified' : 'not verified by a person'}</span></li>`).join('')}</ul>` : '<p class="cap">None on file. That is not the same as none existing.</p>'}
    <h2>Encroachment</h2>${r.encroachment.length ? `<ul>${r.encroachment.map((f) => `<li>${esc(f.kind.replace(/_/g, ' '))} · ${esc(f.source || '')} · ${esc((f.observedAt || '').slice(0, 10))} ${esc(f.note || '')}</li>`).join('')}</ul>` : `<p class="cap">${built.coverage.encroachmentFeed ? 'No flags.' : 'No feed connected. Crew findings below are the only source.'}</p>`}
    <h2>Decide</h2>${r.drafts.length ? `<p class="cap">Each module only drafts. A named person decides, and the decision is chained into the record.</p>
      <label class="f" for="who">Your name</label><input id="who" autocomplete="name" style="width:100%">
      <label class="f" for="why">Reason (required to reject)</label><input id="why" style="width:100%">
      ${r.drafts.map((d, i) => { const s = LEDGER.statusOf(store.ledger, d); return `<div class="btnrow"><span style="flex:1"><b>${esc(d.module.replace(/_/g, ' '))}</b> · ${esc(d.kind.replace(/_/g, ' '))}</span>${s === 'draft' ? `<button class="btn" data-act="approve" data-i="${i}">Approve</button><button class="btn ghost" data-act="reject" data-i="${i}">Reject</button>` : chip(s === 'approved' ? 'green' : 'grey', s)}</div>`; }).join('')}` : '<p class="cap">Nothing drafted for this kilometre.</p>'}
    ${orders.map((o) => `<div class="box"><b class="mono">${esc(o.id)}</b> · ${esc(o.priority)} · due ${esc(o.dueBy)}<br>${esc(o.reason)}<br><span class="cap">Land check: ${esc(o.check.summary)} Status: ${esc(o.check.status.replace(/_/g, ' '))}. Earliest start ${esc(o.check.earliestStart.slice(0, 16).replace('T', ' '))} UTC. Not dispatched: export the CSV.</span></div>`).join('')}
    <h2>Report from the field</h2><p class="cap">A crew walking for one reason reports what it sees. The finding updates every module it touches and is paired with what the system had predicted.</p>
    <div class="grid2"><div><label class="f" for="fk">What was found</label><select id="fk" style="width:100%">${Object.entries(FEEDBACK.KINDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div><div><label class="f" for="fv">Number (for a count)</label><input id="fv" type="number" min="0" style="width:100%"></div></div>
    <label class="f" for="fn">Note</label><input id="fn" style="width:100%"><label class="f"><input type="checkbox" id="fp"> Inside the 30 m prescribed area</label>
    <div class="btnrow"><button class="btn ghost" id="addFinding">Record finding</button></div>
    <h2>Decision record</h2>${record.length ? `<table><tbody>${record.map((e) => `<tr><td class="mono">${e.seq}</td><td>${esc(e.at.slice(0, 16).replace('T', ' '))}</td><td>${esc(e.what)}${e.value != null ? ': ' + esc(e.value) : ''}${e.estimate != null ? ' · est. ' + money(e.estimate) : ''}<div class="cap">${esc(e.by)}${e.reason ? ' · ' + esc(e.reason) : ''}</div></td><td class="mono cap" title="${esc(e.hash)}">${esc(e.hash.slice(0, 10))}…</td></tr>`).join('')}</tbody></table>` : '<p class="cap">Nothing decided or found here yet.</p>'}
    <div class="btnrow"><button class="btn ghost" id="xPack">Evidence pack PDF</button>${r.classLocation && r.classLocation.change ? '<button class="btn ghost" id="xFiling">Draft plan PDF</button>' : ''}</div>`;
  for (const el of $('detail').querySelectorAll('input[name=path]')) el.onchange = () => { chosen[r.id] = el.value; };
  for (const b of $('detail').querySelectorAll('button[data-act]')) b.onclick = () => decide(r, r.drafts[+b.dataset.i], b.dataset.act);
  $('addFinding').onclick = () => addFinding(r);
  $('xPack').onclick = () => download(`evidence-${r.id}.pdf`, EXPORT.pdf('TerraCorridor evidence pack', EXPORT.evidenceLines(LEDGER.evidencePack(r, store.ledger, DATA.sources))), 'application/pdf');
  if ($('xFiling')) $('xFiling').onclick = () => download(`draft-plan-${r.id}.pdf`, EXPORT.pdf('Draft class location plan', EXPORT.draftFilingLines(r, r.decision, chosen[r.id] || (r.decision.lowestCost && r.decision.lowestCost.key))), 'application/pdf');
}

async function send(path, body) {
  if (!API) return 'kept in this browser';
  try { const res = await fetch(API.replace(/\/$/, '') + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return res.ok ? 'recorded in n8n' : 'n8n refused it (' + res.status + '), kept in this browser'; }
  catch (e) { return 'n8n not reachable, kept in this browser'; }
}
async function decide(r, draft, decision) {
  const by = $('who').value, reason = $('why').value, path = draft.module === 'class_location' && r.decision ? (chosen[r.id] || (r.decision.lowestCost && r.decision.lowestCost.key)) : null;
  const est = path && r.decision ? (r.decision.paths.find((p) => p.key === path) || {}).total : null;
  try { store.ledger = LEDGER.decide(store.ledger, draft, { decision, by, reason, chosen: path, estimate: est }); }
  catch (e) { return toast(e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.'); }
  if (decision === 'approve') store.orders.push(PLATFORM.workOrderFor(r, draft, { by, chosen: path }));
  save(); render();
  toast((decision === 'approve' ? 'Approved' : 'Rejected') + ': ' + await send('/decide', { action: { id: draft.id, module: draft.module, segment: draft.segment, kind: draft.kind, inputsHash: draft.inputsHash }, decision, by, reason, chosen: path, estimate: est }) + '.');
}
async function addFinding(r) {
  const raw = { kind: $('fk').value, segment: r.id, value: $('fv').value, note: $('fn').value, withinPrescribedArea: $('fp').checked, by: $('who') ? $('who').value : '' };
  if (!raw.by) raw.by = prompt('Your name') || '';
  const { finding, problems } = FEEDBACK.normalize(raw);
  if (problems.length) return toast('Not recorded: ' + problems.join(', ') + '.');
  store.findings.push(finding);
  store.ledger = LEDGER.recordOutcome(store.ledger, { segment: r.id, module: finding.module, finding: finding.kind, value: finding.value, note: finding.note, by: finding.by, at: finding.at });
  save(); render(); toast('Finding recorded: ' + await send('/finding', raw) + '.');
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

function renderAssumptions() {
  const base = DECISION.DEFAULTS.assumptions;
  $('assume').innerHTML = Object.entries(base).map(([k, a]) => `<div><label class="f" for="a-${k}">${esc(a.unit)}</label><input id="a-${k}" type="number" min="0" value="${esc(store.assumptions[k] != null ? store.assumptions[k] : a.value)}" style="width:100%"></div>`).join('');
  for (const k of Object.keys(base)) $('a-' + k).onchange = (e) => { const v = +e.target.value; if (v >= 0) { store.assumptions[k] = v; save(); render(); } };
}
$('jur').value = store.jurisdiction;
$('jur').onchange = () => { store.jurisdiction = $('jur').value; save(); render(); };
$('resetAssume').onclick = () => { store.assumptions = {}; save(); renderAssumptions(); render(); };
$('xCsv').onclick = () => (store.orders.length ? download('terracorridor-work-orders.csv', EXPORT.workOrdersCsv(store.orders), 'text/csv') : toast('No approved work orders yet.'));
$('xGeo').onclick = () => download('terracorridor-segments.geojson', JSON.stringify(EXPORT.segmentsGeoJSON(built.records, DATA.segments)), 'application/geo+json');
$('xLabels').onclick = () => (built.labels.length ? download('prediction-vs-field.csv', EXPORT.csv(built.labels, ['finding', 'segment', 'module', 'kind', 'predicted', 'observed', 'agreed', 'error', 'at', 'by']), 'text/csv') : toast('No field findings yet.'));
renderAssumptions(); render();
