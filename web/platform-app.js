// Segment record page: the alignment sheet. Satellite map on top, a km-indexed strip below, an inspector
// on the right. Everything is recomputed in the browser from the inlined data with the same modules the
// tests and the n8n Code nodes run. Decisions and findings stay in this browser (and go to W7/W9 with ?api=).
const DATA = window.TC_PLATFORM_DATA, BT = window.TC_BACKTEST;
const { TC_SEGMENTS: SEG, TC_CLASS: CLASS, TC_DECISION: DECISION, TC_LEDGER: LEDGER, TC_FEEDBACK: FEEDBACK, TC_EXPORT: EXPORT, TC_PLATFORM: PLATFORM } = globalThis;
const API = new URLSearchParams(location.search).get('api') || '';
const KEY = 'tc-platform:' + DATA.meta.corridorId;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = EXPORT.money;
const C = { red: '#ff5d4f', amber: '#f2a93b', green: '#6fd08f', grey: '#5d625a', bg: '#0a0b0a', ink: '#eceee6', ink2: '#a5aa9f' };
// Esri World Imagery Wayback: dated releases of the same imagery service the geohazard map uses. Free with attribution.
// The date is when Esri published the release; the photo itself can be older.
const WAYBACK = [{ year: '2019', id: 645, date: '26 Jun 2019' }, { year: '2022', id: 4905, date: '29 Jun 2022' }, { year: '2024', id: 39767, date: '27 Jun 2024' }];
const LATEST = { id: 43291, date: '29 Oct 2026' };
const tileUrl = (id) => `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${id}/{z}/{y}/{x}`;

let store = { ledger: [], findings: [], orders: [], assumptions: {}, jurisdiction: 'CA', before: '2019' };
try { store = { ...store, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* storage unavailable: state stays in memory */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* in memory only */ } };
let built = null, selected = null, tab = 'km', chosen = {}, swipe = 0.5;
let map, beforeLayer, lines = {}, bandLayer, dotLayer;
const today = () => new Date().toISOString().slice(0, 10);
const index = SEG.buildIndex(DATA.segments);
const STATUS = { changed: ['red', 'Changed, clock running'], change_committed: ['red', 'Change on the way'], change_possible: ['amber', 'Change possible'], no_change: ['green', 'No change'], unverified: ['grey', 'No data'] };
const TIER = { red: ['red', 'High'], 'red-uncertain': ['red', 'High'], amber: ['amber', 'Medium'], green: ['green', 'Low'], unverified: ['grey', 'No data'] };
const chip = (cls, text) => `<span class="chip c-${cls}"><i></i>${esc(text)}</span>`;
const statusOf = (r) => STATUS[r.classLocation ? r.classLocation.status : 'unverified'];
const rec = () => built.records.find((r) => r.id === selected);
const toast = (m) => { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 4200); };

function compute() {
  const cfg = { classLocation: { jurisdiction: store.jurisdiction }, decision: DECISION.mergeAssumptions(store.assumptions) };
  built = PLATFORM.buildRecords(DATA.segments, { permits: DATA.permits, obligations: DATA.obligations, encroachmentEvents: DATA.encroachmentEvents || undefined, findings: store.findings }, cfg, today());
  if (!selected || !rec()) selected = (urgent()[0] || built.records[0]).id;
}
const urgent = () => built.records.filter((r) => r.openItems.length).sort((a, b) => a.openItems[0].level - b.openItems[0].level || b.openItems.length - a.openItems.length || a.kmFrom - b.kmFrom);

/* ---------- map ---------- */
// A point on the line at a given chainage, and the 200 m band either side of a stretch of it.
function pointAt(ch) {
  const p = index.pieces.find((q) => ch >= q.fromM && ch <= q.fromM + q.len) || index.pieces[index.pieces.length - 1], t = Math.max(0, Math.min(1, (ch - p.fromM) / p.len));
  return { x: p.ax + t * (p.bx - p.ax), y: p.ay + t * (p.by - p.ay), nx: -(p.by - p.ay) / p.len, ny: (p.bx - p.ax) / p.len };
}
const ll = (x, y) => [y / index.ky, x / index.kx];
function bandOf(fromM, toM, halfM) {
  const left = [], right = [];
  for (let ch = Math.max(0, fromM); ch <= Math.min(index.lengthM, toM); ch += 50) { const p = pointAt(ch); left.push(ll(p.x + p.nx * halfM, p.y + p.ny * halfM)); right.push(ll(p.x - p.nx * halfM, p.y - p.ny * halfM)); }
  return [...left, ...right.reverse()];
}
function initMap() {
  map = L.map('map', { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5 });
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.createPane('after').style.zIndex = 210;
  const attribution = 'Imagery: Esri World Imagery (Wayback), Maxar, Earthstar Geographics';
  beforeLayer = L.tileLayer(tileUrl(WAYBACK.find((w) => w.year === store.before).id), { maxZoom: 19, maxNativeZoom: 18, attribution }).addTo(map);
  L.tileLayer(tileUrl(LATEST.id), { pane: 'after', maxZoom: 19, maxNativeZoom: 18 }).addTo(map);
  bandLayer = L.layerGroup().addTo(map); dotLayer = L.layerGroup().addTo(map);
  const all = [];
  for (const s of DATA.segments) { const pts = s.centreline.map((p) => [p[1], p[0]]); all.push(...pts); L.polyline(pts, { color: C.bg, weight: 9, opacity: 0.9, interactive: false }).addTo(map); }
  for (const s of DATA.segments) {
    lines[s.id] = L.polyline(s.centreline.map((p) => [p[1], p[0]]), { color: C.grey, weight: 5, lineCap: 'butt' }).addTo(map).on('click', () => select(s.id))
      .bindTooltip(() => { const r = built.records.find((x) => x.id === s.id); return `<b>km ${r.kmFrom}–${r.kmTo}</b> · ${esc(statusOf(r)[1])}`; }, { sticky: true, className: 'tc', direction: 'top', offset: [0, -8] });
  }
  const fitAll = () => map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [300, 30], paddingBottomRight: [40, 70] });
  fitAll(); requestAnimationFrame(() => { map.invalidateSize(); fitAll(); clip(); });
  map.on('move zoom resize', clip);
  new ResizeObserver(() => { map.invalidateSize(); clip(); }).observe($('mapBox'));
  $('swipe').oninput = (e) => { swipe = e.target.value / 100; clip(); };
  $('years').innerHTML = WAYBACK.map((w) => `<button type="button" data-y="${w.year}" aria-pressed="${w.year === store.before}">${w.year}</button>`).join('');
  for (const b of $('years').querySelectorAll('button')) b.onclick = () => { store.before = b.dataset.y; save(); beforeLayer.setUrl(tileUrl(WAYBACK.find((w) => w.year === store.before).id)); for (const x of $('years').querySelectorAll('button')) x.setAttribute('aria-pressed', x === b); clip(); };
  $('legend').innerHTML = `<div class="eyebrow" style="margin-bottom:4px">Class location</div><div><i style="background:${C.red}"></i>Change dated</div><div><i style="background:${C.amber}"></i>Change possible</div><div><i style="background:${C.green}"></i>No change</div>
    <div class="eyebrow" style="margin:8px 0 4px">Dwellings since 2019, per 200 m</div><div><b style="background:${C.ink}"></b>Built<b style="background:${C.amber}"></b>Permit issued<b style="border:1.5px dashed ${C.amber}"></b>Approved only</div>`;
  clip();
}
// Left of the divider shows the older imagery, right of it shows today.
function clip() {
  const size = map.getSize(), nw = map.containerPointToLayerPoint([0, 0]), x = nw.x + size.x * swipe;
  map.getPane('after').style.clipPath = `polygon(${x}px ${nw.y}px, ${nw.x + size.x}px ${nw.y}px, ${nw.x + size.x}px ${nw.y + size.y}px, ${x}px ${nw.y + size.y}px)`;
  const w = WAYBACK.find((v) => v.year === store.before), d = $('divider');
  d.style.left = size.x * swipe + 'px'; d.dataset.before = 'Imagery published ' + w.date; d.dataset.after = 'Today, ' + LATEST.date;
  $('grip').style.left = size.x * swipe + 'px';
}
// Dwellings added since the 2019 roof survey, drawn on the line at the nearest 200 m (true positions are within 200 m of it).
function paintMap() {
  for (const r of built.records) lines[r.id].setStyle({ color: C[statusOf(r)[0]], weight: r.id === selected ? 8 : 5 });
  dotLayer.clearLayers(); bandLayer.clearLayers();
  const state = CLASS.normalize(DATA.permits, index), base = state.baseline ? state.baseline.date : '0000', now = today(), bins = {};
  for (const e of state.events) {
    if (e.kind === 'building_permit' && e.issued <= base) continue;
    const b = bins[Math.floor(e.chainageM / 200)] || (bins[Math.floor(e.chainageM / 200)] = { built: 0, permit: 0, approved: 0 });
    if (e.kind === 'development_permit') b.approved += e.units; else if (e.occupied <= now) b.built += e.units; else b.permit += e.units;
  }
  const rad = (u) => 2.5 + Math.sqrt(u) * 1.1;
  for (const [k, b] of Object.entries(bins)) {
    const p = pointAt((+k + 0.5) * 200), at = ll(p.x, p.y), tip = `<b>near km ${((+k + 0.5) * 0.2).toFixed(1)}</b><br>${b.built} built since 2019 · ${b.permit} with a building permit · ${b.approved} approved (development permit)`;
    const dot = (o) => L.circleMarker(at, o).addTo(dotLayer).bindTooltip(tip, { className: 'tc', direction: 'top' });
    if (b.approved) dot({ radius: rad(b.approved + b.built + b.permit) + 3, color: C.amber, weight: 1.5, dashArray: '3 3', fill: false });
    if (b.built) dot({ radius: rad(b.built), color: C.bg, weight: 1, fillColor: C.ink, fillOpacity: 0.9 });
    if (b.permit) dot({ radius: rad(b.permit), color: C.bg, weight: 1, fillColor: C.amber, fillOpacity: 0.95 });
  }
  const r = rec(), c = r.classLocation, range = SEG.rangeOf(index, r.id);
  const from = c ? c.window.kmFrom * 1000 : range.fromM, to = c ? c.window.kmTo * 1000 : range.toM;
  L.polygon(bandOf(from, to, 200), { color: C.ink, weight: 1.2, dashArray: '5 5', fillColor: C.ink, fillOpacity: 0.06, interactive: false }).addTo(bandLayer);
  L.polygon(bandOf(from, to, 30), { color: C.ink, weight: 0, fillColor: C.ink, fillOpacity: 0.1, interactive: false }).addTo(bandLayer);
}
function select(id, fly = true) {
  selected = id; tab = 'km'; render();
  if (!fly) return;
  const r = rec(), c = r.classLocation, range = SEG.rangeOf(index, id);
  map.flyToBounds(L.latLngBounds(bandOf(c ? c.window.kmFrom * 1000 : range.fromM, c ? c.window.kmTo * 1000 : range.toM, 320)), { padding: [30, 30], duration: 0.8 });
}

/* ---------- strip and queue ---------- */
function renderStrip() {
  const recs = [...built.records].sort((a, b) => a.kmFrom - b.kmFrom);
  const max = Math.max(...recs.map((r) => (r.classLocation ? r.classLocation.units.existing + r.classLocation.units.committed + r.classLocation.units.possible : 0)), 46), h = (u) => (44 * Math.sqrt(u / max)).toFixed(1);
  const cell = (r, inner, style = '', cls = '') => `<button type="button" class="cell ${cls}${r.id === selected ? ' sel' : ''}" data-id="${esc(r.id)}" style="${style}" aria-label="km ${r.kmFrom} to ${r.kmTo}" title="km ${r.kmFrom}–${r.kmTo}">${inner}</button>`;
  $('strip').innerHTML = `
    <div class="row"><span class="eyebrow">Class</span><div class="cells">${recs.map((r) => { const c = r.classLocation; return cell(r, c ? c.class.now + (c.change ? '→' + c.change.to : '') : '–', `background:${C[statusOf(r)[0]]}`); }).join('')}</div></div>
    <div class="row"><span class="eyebrow">Dwellings</span><div class="cells bars">${recs.map((r) => { const u = r.classLocation ? r.classLocation.units : { existing: 0, committed: 0, possible: 0 }, t = u.existing + u.committed + u.possible || 1, H = h(t);
      return cell(r, `<span style="height:${(H * u.existing / t).toFixed(1)}px;background:${C.ink2}"></span><span style="height:${(H * u.committed / t).toFixed(1)}px;background:${C.amber}"></span><span style="height:${(H * u.possible / t).toFixed(1)}px;background:repeating-linear-gradient(45deg,#8a6a22,#8a6a22 3px,transparent 3px,transparent 6px)"></span>`); }).join('')}</div></div>
    <div class="row"><span class="eyebrow">Geohazard</span><div class="cells">${recs.map((r) => cell(r, '', `background:${C[(TIER[r.geohazard.tier] || TIER.unverified)[0]]};height:10px`)).join('')}</div></div>
    <div class="row"><span class="eyebrow">Land terms</span><div class="cells">${recs.map((r) => cell(r, r.obligations.length || '', 'background:var(--s3);color:var(--ink-2);height:18px')).join('')}</div></div>
    <div class="row ruler"><span class="eyebrow">km</span><div class="cells">${recs.map((r) => `<span>${r.kmFrom % 2 === 0 ? r.kmFrom : ''}</span>`).join('')}</div></div>`;
  for (const b of $('strip').querySelectorAll('button')) b.onclick = () => select(b.dataset.id);
  const u = urgent();
  $('queue').innerHTML = `<div class="eyebrow" style="margin:2px 6px 6px">Needs a decision · ${u.length}</div>` + (u.length ? u.slice(0, 5).map((r) => `<button type="button" data-id="${esc(r.id)}" class="${r.id === selected ? 'on' : ''}"><b class="mono">km ${r.kmFrom}–${r.kmTo}</b><br><span class="cap">${esc(r.openItems[0].text)}</span></button>`).join('') : '<p class="cap" style="margin:6px">Nothing is waiting.</p>');
  for (const b of $('queue').querySelectorAll('button')) b.onclick = () => select(b.dataset.id);
}
/* ---------- inspector ---------- */
function classBlock(c) {
  if (!c) return '<p class="note">No dwelling or permit data is loaded for this corridor, so class location is not assessed here.</p>';
  const t = CLASS.DEFAULTS.thresholds, total = c.units.existing + c.units.committed + c.units.possible, max = Math.max(60, total * 1.15), pct = (n) => (100 * n / max).toFixed(2) + '%';
  return `<div class="kpis"><div><b>${c.units.existing}</b><span>dwellings now${c.fieldCounted ? ', counted on site' : ', estimated'}</span></div><div><b class="c-amber">${c.units.committed}</b><span>with a building permit</span></div><div><b style="color:#b89545">${c.units.possible}</b><span>approved only</span></div></div>
    <div class="bar" role="img" aria-label="${c.units.existing} existing, ${c.units.committed} permitted, ${c.units.possible} approved dwellings">
      <span class="ex" style="left:0;width:${pct(c.units.existing)}"></span><span class="co" style="left:${pct(c.units.existing)};width:${pct(c.units.committed)}"></span><span class="po" style="left:${pct(c.units.existing + c.units.committed)};width:${pct(c.units.possible)}"></span>
      <span class="mk" data-l="Class 2 at ${t.class2}" style="left:${pct(t.class2)}"></span><span class="mk" data-l="Class 3 at ${t.class3}" style="left:${pct(t.class3)}"></span></div>
    ${c.clock ? `<p class="note ${c.clock.running ? 'bad' : 'warn'}"><b>${c.clock.running ? 'Plan due' : 'Plan would be due'} ${esc(c.clock.due)}</b>, ${c.clock.monthsLeft} months from now. ${esc(c.clock.basis)}</p>` : ''}
    <p class="cap">Counted in the dashed band on the map: km ${c.window.kmFrom} to ${c.window.kmTo}, 200 m each side. ${esc(c.basis)}.${c.fieldCounted ? ' The estimate was ' + c.units.estimatedBeforeCount + '.' : ''}</p>
    ${c.evidence.length ? `<details><summary>Evidence: ${c.evidence.length} permit records</summary><ul>${c.evidence.map((e) => `<li><b>${e.units}</b> unit${e.units === 1 ? '' : 's'} near km ${e.km}, ${esc(e.kind.replace(/_/g, ' '))}${e.note ? ', ' + esc(e.note.replace(/^1 permits/, '1 permit')) : ' issued ' + esc(e.issued)} <span class="mono cap">${esc(e.id)}</span></li>`).join('')}</ul></details>` : ''}
    ${c.plans.length ? `<p class="cap">Plans in effect here: ${c.plans.map((p) => `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join(', ')}.</p>` : ''}`;
}
function sentence(r) {
  const c = r.classLocation;
  if (!c) return 'Class location is not assessed on this kilometre.';
  return c.status === 'changed' ? `This stretch moved from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}. The regulator's clock is running.`
    : c.status === 'change_committed' ? `Building permits already issued take this stretch from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}.`
    : c.status === 'change_possible' ? `Approved developments could take this stretch from Class ${c.change.from} to Class ${c.change.to}. No building permits yet, so there is no date.`
    : c.status === 'unverified' ? 'There is no dwelling data for this stretch.' : `Class ${c.class.now}, and nothing on file changes that.${c.headroom == null ? '' : ' ' + c.headroom + ' more dwellings would reach the next class.'}`;
}
function decisionBlock(r) {
  const d = r.decision; if (!d) return '';
  const pick = chosen[r.id] || (d.lowestCost && d.lowestCost.key);
  return `<h2>Ways to deal with it</h2>${d.pricedWithPlaceholders ? '<p class="note warn">Costs are placeholders, not operator figures. Change them under Corridor.</p>' : ''}
    <table><thead><tr><th></th><th>Path</th><th class="num">${d.horizonYears}-yr cost</th><th class="num">Months</th><th>In time</th></tr></thead><tbody>${d.paths.map((p) => `<tr class="${p.eligible ? '' : 'off'}"><td>${p.eligible ? `<input type="radio" name="path" value="${p.key}" ${p.key === pick ? 'checked' : ''} aria-label="${esc(p.label)}">` : ''}</td>
      <td>${esc(p.label)}<div class="cap">${esc(p.why)}${p.materials && p.materials.note ? ' ' + esc(p.materials.note) : ''}${p.obligations.length ? ` Breaks ground: ${p.obligations.length} land obligation${p.obligations.length === 1 ? ' applies' : 's apply'}.` : ''}</div></td>
      <td class="num">${p.eligible ? money(p.total) : ''}</td><td class="num">${p.eligible ? p.months : ''}</td><td>${!p.eligible ? '' : p.meetsDeadline == null ? '<span class="cap">no date</span>' : p.meetsDeadline ? chip('green', 'yes') : chip('red', 'no')}</td></tr>`).join('')}</tbody></table>
    ${d.hingesOn.length ? `<p class="cap">The cheapest answer flips if ${d.hingesOn.map((h) => `${esc(h.unit)} were ${esc(Math.round(h.at).toLocaleString('en-US'))}`).join(', or if ')}.</p>` : ''}
    ${d.unknowns.length ? `<p class="cap">Still needed from the operator: ${esc(d.unknowns.join('; '))}.</p>` : ''}`;
}
function kmTab(r) {
  const g = TIER[r.geohazard.tier] || TIER.unverified, st = statusOf(r), record = LEDGER.decisionRecord(store.ledger, r.id), orders = store.orders.filter((o) => o.segment === r.id);
  return `<div class="eyebrow">Segment record · ${esc(r.id)}</div><h1>km ${r.kmFrom}–${r.kmTo}</h1>
    <p>${chip(st[0], st[1])}</p><p class="lead">${esc(sentence(r))}</p>
    <h2>Class location</h2>${classBlock(r.classLocation)}${decisionBlock(r)}
    <h2>Geohazard</h2><p>${chip(g[0], g[1])} ${esc(r.geohazard.hazard || 'No score on file')}${r.geohazard.score == null ? '' : `, score <span class="mono">${esc(r.geohazard.score)}</span>`}. <span class="cap">${esc(r.geohazard.why || '')}</span></p>
    <h2>Land obligations</h2>${r.obligations.length ? `<ul>${r.obligations.map((o) => `<li>${esc(o.requirement)}${o.noticeHours ? ` (${o.noticeHours} hours' notice)` : ''} <span class="cap">${esc(o.id)}, ${esc(o.source.doc)} ${esc(o.source.ref || '')}, ${o.verified ? 'verified' : 'not yet verified by a person'}</span></li>`).join('')}</ul>` : '<p class="cap">None on file for this kilometre. That is not the same as none existing.</p>'}
    ${r.encroachment.length ? `<h2>Inside the 30 m prescribed area</h2><ul>${r.encroachment.map((f) => `<li>${esc(f.kind.replace(/_/g, ' '))}, ${esc(f.source || '')} ${esc((f.observedAt || '').slice(0, 10))}. ${esc(f.note || '')}</li>`).join('')}</ul>` : ''}
    <h2>Decide</h2>${r.drafts.length ? `<p class="cap">Each module only drafts. A named person decides, and the decision is chained into the record.</p>
      <div class="grid2"><div><label class="f" for="who">Your name</label><input id="who" autocomplete="name" style="width:100%"></div><div><label class="f" for="why">Reason, needed to reject</label><input id="why" style="width:100%"></div></div>
      ${r.drafts.map((d, i) => { const s = LEDGER.statusOf(store.ledger, d); return `<div class="btnrow"><span style="flex:1">${esc(d.module.replace(/_/g, ' '))}: ${esc(d.kind.replace(/_/g, ' '))}</span>${s === 'draft' ? `<button class="btn" data-act="approve" data-i="${i}">Approve</button><button class="btn ghost" data-act="reject" data-i="${i}">Reject</button>` : chip(s === 'approved' ? 'green' : 'grey', s)}</div>`; }).join('')}` : '<p class="cap">Nothing is drafted for this kilometre.</p>'}
    ${orders.map((o) => `<p class="note"><b class="mono">${esc(o.id)}</b>, ${esc(o.priority)}, due ${esc(o.dueBy)}. ${esc(o.reason)}<br>Land check: ${esc(o.check.summary)} Earliest start ${esc(o.check.earliestStart.slice(0, 16).replace('T', ' '))} UTC. Not dispatched; export it from Corridor.</p>`).join('')}
    <h2>Report from the field</h2>
    <div class="grid2"><div><label class="f" for="fk">What was found</label><select id="fk" style="width:100%">${Object.entries(FEEDBACK.KINDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div><div><label class="f" for="fv">Number, for a count</label><input id="fv" type="number" min="0" style="width:100%"></div></div>
    <label class="f" for="fn">Note</label><input id="fn" style="width:100%"><label class="f"><input type="checkbox" id="fp"> Inside the 30 m prescribed area</label>
    <div class="btnrow"><button class="btn ghost" id="addFinding">Record finding</button></div>
    <h2>Decision record</h2>${record.length ? `<table><tbody>${record.map((e) => `<tr><td class="mono cap">${e.seq}</td><td>${esc(e.what)}${e.value != null ? ': ' + esc(e.value) : ''}${e.estimate != null ? ', estimate ' + money(e.estimate) : ''}<div class="cap">${esc(e.by)}, ${esc(e.at.slice(0, 16).replace('T', ' '))}${e.reason ? ', ' + esc(e.reason) : ''}</div></td><td class="mono cap" title="${esc(e.hash)}">${esc(e.hash.slice(0, 8))}</td></tr>`).join('')}</tbody></table>` : '<p class="cap">Nothing decided or found here yet.</p>'}
    <div class="btnrow"><button class="btn ghost" id="xPack">Evidence pack PDF</button>${r.classLocation && r.classLocation.change ? '<button class="btn ghost" id="xFiling">Draft plan PDF</button>' : ''}</div>`;
}
function corridorTab() {
  const s = built.classSummary || {}, open = built.records.reduce((a, r) => a + r.openItems.length, 0), chain = LEDGER.verify(store.ledger), L = DATA.meta.labels, base = DECISION.DEFAULTS.assumptions;
  return `<div class="eyebrow">Corridor</div><h1>${esc(DATA.meta.name)}</h1><p class="cap">${esc(DATA.meta.route)}</p>
    <div class="kpis"><div><b>${(s.changed || 0) + (s.changeCommitted || 0)}</b><span>class changes dated</span></div><div><b>${s.changePossible || 0}</b><span>possible, no date</span></div><div><b>${open}</b><span>open items</span></div></div>
    <h2>Would permits have warned us?</h2>${BT ? `<p>${BT.changes} class change${BT.changes === 1 ? '' : 's'} on this line since ${esc(BT.from.slice(0, 4))}. In ${BT.flaggedAhead} of ${BT.changes}, issued permits already added up to the higher class ${esc(BT.medianLeadMonths)} months before the dwellings were estimated to be occupied.</p>
      <table><tbody>${BT.rows.map((r) => `<tr><td class="mono">km ${r.kmFrom}</td><td>Class ${r.startClass} to ${r.toClass}</td><td class="mono">permits ${esc(r.flagged)}</td><td class="mono">change ${esc(r.changed || 'not yet')}</td></tr>`).join('')}</tbody></table><p class="note warn">${esc(BT.caveat)}</p>
      <p class="cap">Slide the divider on the map over km 7 to 8 with 2019 selected to see it in the imagery.</p>` : ''}
    <h2>Exports</h2><div class="btnrow"><button class="btn ghost" id="xCsv">Work orders CSV</button><button class="btn ghost" id="xGeo">Segments GeoJSON</button><button class="btn ghost" id="xLabels">Prediction vs field CSV</button></div><p class="cap">Files a coordinator imports into Maximo, SAP or ArcGIS. Nothing is written back to those systems.</p>
    <h2>What is real here</h2><ul>${Object.entries(L).map(([k, v]) => `<li><span class="cap">${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</span> ${esc(v)}</li>`).join('')}<li><span class="cap">imagery</span> Esri World Imagery Wayback. Dates are when Esri published each release; the photos can be older.</li><li><span class="cap">decision chain</span> ${store.ledger.length} entries, ${chain.ok ? 'intact' : 'BROKEN at entry ' + chain.brokenAt}</li></ul>
    <h2>Cost assumptions</h2><div class="grid2">${Object.entries(base).map(([k, a]) => `<div><label class="f" for="a-${k}">${esc(a.unit)}</label><input id="a-${k}" data-k="${k}" type="number" min="0" value="${esc(store.assumptions[k] != null ? store.assumptions[k] : a.value)}" style="width:100%"></div>`).join('')}</div><div class="btnrow"><button class="btn ghost" id="resetAssume">Reset to placeholders</button></div>`;
}
function renderInspector() {
  const r = rec();
  $('inspector').innerHTML = `<div class="tabs" role="tablist"><button role="tab" aria-selected="${tab === 'km'}" data-tab="km">This kilometre</button><button role="tab" aria-selected="${tab === 'all'}" data-tab="all">Corridor</button></div>` + (tab === 'km' ? kmTab(r) : corridorTab());
  const q = (s) => $('inspector').querySelectorAll(s);
  for (const b of q('[data-tab]')) b.onclick = () => { tab = b.dataset.tab; renderInspector(); $('inspector').scrollTop = 0; };
  for (const el of q('input[name=path]')) el.onchange = () => { chosen[r.id] = el.value; };
  for (const b of q('button[data-act]')) b.onclick = () => decide(r, r.drafts[+b.dataset.i], b.dataset.act);
  for (const el of q('input[data-k]')) el.onchange = () => { const v = +el.value; if (v >= 0) { store.assumptions[el.dataset.k] = v; save(); render(); } };
  const on = (id, fn) => { if ($(id)) $(id).onclick = fn; };
  on('addFinding', () => addFinding(r));
  on('xPack', () => download(`evidence-${r.id}.pdf`, EXPORT.pdf('TerraCorridor evidence pack', EXPORT.evidenceLines(LEDGER.evidencePack(r, store.ledger, DATA.sources))), 'application/pdf'));
  on('xFiling', () => download(`draft-plan-${r.id}.pdf`, EXPORT.pdf('Draft class location plan', EXPORT.draftFilingLines(r, r.decision, chosen[r.id] || (r.decision.lowestCost && r.decision.lowestCost.key))), 'application/pdf'));
  on('resetAssume', () => { store.assumptions = {}; save(); render(); });
  on('xCsv', () => (store.orders.length ? download('terracorridor-work-orders.csv', EXPORT.workOrdersCsv(store.orders), 'text/csv') : toast('No approved work orders yet.')));
  on('xGeo', () => download('terracorridor-segments.geojson', JSON.stringify(EXPORT.segmentsGeoJSON(built.records, DATA.segments)), 'application/geo+json'));
  on('xLabels', () => (built.labels.length ? download('prediction-vs-field.csv', EXPORT.csv(built.labels, ['finding', 'segment', 'module', 'kind', 'predicted', 'observed', 'agreed', 'error', 'at', 'by']), 'text/csv') : toast('No field findings yet.')));
}
function render() { compute(); renderStrip(); paintMap(); renderInspector(); }

/* ---------- actions ---------- */
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
  const { finding, problems } = FEEDBACK.normalize(raw);
  if (problems.length) return toast('Not recorded: ' + problems.join(', ').replace('no name', 'enter your name under Decide') + '.');
  store.findings.push(finding);
  store.ledger = LEDGER.recordOutcome(store.ledger, { segment: r.id, module: finding.module, finding: finding.kind, value: finding.value, note: finding.note, by: finding.by, at: finding.at });
  save(); render(); toast('Finding recorded: ' + await send('/finding', raw) + '.');
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

$('jur').value = store.jurisdiction;
$('jur').onchange = () => { store.jurisdiction = $('jur').value; save(); render(); };
compute(); initMap(); render();
