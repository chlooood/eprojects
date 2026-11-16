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

let store = { ledger: [], findings: [], orders: [], assumptions: {}, jurisdiction: 'CA', before: '2019', ahead: String(new Date().getFullYear() + 2) };
try { store = { ...store, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* storage unavailable: state stays in memory */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* in memory only */ } };
let built = null, selected = null, step = 'changed', chosen = {}, swipe = 0.38;
let map, beforeLayer, lines = {}, bandLayer, dotLayer, futureLayer, aheadMap = null;
// Looking ahead: the same class location rules run as of the end of a future year. Permits already issued are
// assumed built by their lag; approved developments are shown as "if they go ahead". A forecast, not imagery.
const AHEAD = [1, 2].map((n) => String(new Date().getFullYear() + n));
const forecastAt = (year) => CLASS.forecast(DATA.segments, DATA.permits, { ...CLASS.DEFAULTS, jurisdiction: store.jurisdiction }, year + '-12-31').bySegment;
function outlook(r, map = aheadMap) {
  const c = r.classLocation, f = map && map[r.id];
  if (!c || !f) return null;
  return { now: c.class.now, built: Math.max(c.class.now, f.class.now), all: Math.max(c.class.now, f.class.possible) };
}
const tone = (r) => { const o = outlook(r); return o ? (o.built > o.now ? 'red' : o.all > o.now ? 'amber' : 'green') : statusOf(r)[0]; };
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
  aheadMap = store.ahead ? forecastAt(store.ahead) : null;
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
// Leave room for the panel and the strip on a wide screen; on a narrow one they sit below the map.
const pad = () => (window.innerWidth > 900 ? { paddingTopLeft: [40, 110], paddingBottomRight: [480, 160] } : { padding: [24, 24] });
function initMap() {
  map = L.map('map', { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5 });
  map.createPane('after').style.zIndex = 210;
  map.createPane('future').style.zIndex = 350;
  const attribution = 'Imagery: Esri World Imagery (Wayback), Maxar, Earthstar Geographics';
  beforeLayer = L.tileLayer(tileUrl(WAYBACK.find((w) => w.year === store.before).id), { maxZoom: 19, maxNativeZoom: 18, attribution }).addTo(map);
  L.tileLayer(tileUrl(LATEST.id), { pane: 'after', maxZoom: 19, maxNativeZoom: 18 }).addTo(map);
  futureLayer = L.layerGroup().addTo(map); bandLayer = L.layerGroup().addTo(map); dotLayer = L.layerGroup().addTo(map);
  const all = [];
  for (const s of DATA.segments) { const pts = s.centreline.map((p) => [p[1], p[0]]); all.push(...pts); L.polyline(pts, { color: C.bg, weight: 9, opacity: 0.9, interactive: false }).addTo(map); }
  for (const s of DATA.segments) {
    lines[s.id] = L.polyline(s.centreline.map((p) => [p[1], p[0]]), { color: C.grey, weight: 5, lineCap: 'butt' }).addTo(map).on('click', () => select(s.id))
      .bindTooltip(() => { const r = built.records.find((x) => x.id === s.id); return `<b>km ${r.kmFrom}–${r.kmTo}</b> · ${esc(statusOf(r)[1])}`; }, { sticky: true, className: 'tc', direction: 'top', offset: [0, -8] });
  }
  const fitAll = () => map.fitBounds(L.latLngBounds(all), pad());
  fitAll(); requestAnimationFrame(() => { map.invalidateSize(); fitAll(); clip(); });
  map.on('move zoom resize', clip);
  new ResizeObserver(() => { map.invalidateSize(); clip(); }).observe($('mapBox'));
  $('swipe').oninput = (e) => { swipe = e.target.value / 100; clip(); };
  // Drag anywhere on the line. The hidden range input keeps it usable from the keyboard.
  const drag = $('drag'); let dragging = false;
  const move = (e) => { const box = $('mapBox').getBoundingClientRect(); swipe = Math.max(0.02, Math.min(0.98, (e.clientX - box.left) / box.width)); $('swipe').value = swipe * 100; clip(); };
  drag.addEventListener('pointerdown', (e) => { dragging = true; drag.setPointerCapture(e.pointerId); map.dragging.disable(); move(e); });
  drag.addEventListener('pointermove', (e) => { if (dragging) move(e); });
  const end = () => { dragging = false; map.dragging.enable(); };
  drag.addEventListener('pointerup', end); drag.addEventListener('pointercancel', end);
  $('years').innerHTML = WAYBACK.map((w) => `<button type="button" data-y="${w.year}" aria-pressed="${w.year === store.before}">${w.year}</button>`).join('');
  for (const b of $('years').querySelectorAll('button')) b.onclick = () => { store.before = b.dataset.y; save(); beforeLayer.setUrl(tileUrl(WAYBACK.find((w) => w.year === store.before).id)); for (const x of $('years').querySelectorAll('button')) x.setAttribute('aria-pressed', x === b); clip(); };
  $('ahead').innerHTML = `<button type="button" data-y="">Today</button>` + AHEAD.map((y) => `<button type="button" class="fut" data-y="${y}">${y} forecast</button>`).join('');
  for (const b of $('ahead').querySelectorAll('button')) b.onclick = () => { store.ahead = b.dataset.y; save(); render(); };
  clip();
}
// Left of the divider shows the older imagery, right of it shows today.
function clip() {
  const size = map.getSize(), nw = map.containerPointToLayerPoint([0, 0]), x = nw.x + size.x * swipe;
  map.getPane('after').style.clipPath = `polygon(${x}px ${nw.y}px, ${nw.x + size.x}px ${nw.y}px, ${nw.x + size.x}px ${nw.y + size.y}px, ${x}px ${nw.y + size.y}px)`;
  const px = size.x * swipe;
  $('divider').style.left = px + 'px'; $('drag').style.left = px + 'px';
  $('years').style.left = Math.max(12, px - $('years').offsetWidth - 14) + 'px';
  map.getPane('future').style.clipPath = map.getPane('after').style.clipPath;
  $('ahead').style.left = px + 14 + 'px';
}
// Per 200 m of line: homes built since the 2019 roof survey, homes with a building permit that are not finished,
// and homes approved by development permit. "coming" is what has yet to be built.
function binsNow() {
  const state = CLASS.normalize(DATA.permits, index), base = state.baseline ? state.baseline.date : '0000', now = today(), bins = {};
  for (const e of state.events) {
    if (e.kind === 'building_permit' && e.issued <= base) continue;
    const k = Math.floor(e.chainageM / 200), b = bins[k] || (bins[k] = { built: 0, permit: 0, approved: 0 });
    if (e.kind === 'development_permit') b.approved += e.units; else if (e.occupied <= now) b.built += e.units; else b.permit += e.units;
  }
  for (const b of Object.values(bins)) { b.approvedOnly = Math.max(0, b.approved - b.built - b.permit); b.coming = b.permit + b.approvedOnly; }
  return bins;
}
// Dwellings added since the 2019 roof survey, drawn on the line at the nearest 200 m (true positions are within 200 m of it).
function paintMap() {
  for (const r of built.records) lines[r.id].setStyle({ color: C[tone(r)], weight: r.id === selected ? 8 : 5 });
  dotLayer.clearLayers(); bandLayer.clearLayers(); futureLayer.clearLayers();
  for (const b of $('ahead').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.y === store.ahead);
  const bins = binsNow();
  // One quiet dot per 200 m: white for homes added since 2019, amber where permits are issued, a ring where only approved.
  const rad = (u) => 2.5 + Math.sqrt(u) * 0.9;
  for (const [k, b] of Object.entries(bins)) {
    const p = pointAt((+k + 0.5) * 200), at = ll(p.x, p.y), tip = `<b>Near km ${((+k + 0.5) * 0.2).toFixed(1)}</b><br>${b.built} homes added since 2019<br>${b.permit} more with a building permit<br>${b.approved} more approved`;
    const dot = (o) => L.circleMarker(at, o).addTo(dotLayer).bindTooltip(tip, { className: 'tc', direction: 'top' });
    if (b.approved) dot({ radius: rad(b.approved + b.built + b.permit) + 4, color: C.amber, weight: 1.2, fill: false, opacity: 0.9 });
    if (b.built + b.permit) dot({ radius: rad(b.built + b.permit), stroke: false, fillColor: b.permit ? C.amber : C.ink, fillOpacity: 0.92 });
  }
  // The forecast, drawn only right of the line: an amber wash over each 200 m where homes are permitted or approved.
  if (store.ahead) for (const [k, b] of Object.entries(bins)) {
    const coming = b.coming;
    if (!coming) continue;
    L.polygon(bandOf(+k * 200, (+k + 1) * 200, 200), { pane: 'future', stroke: false, fillColor: C.amber, fillOpacity: Math.min(0.6, 0.16 + coming / 50), interactive: false }).addTo(futureLayer);
    if (coming >= 5) { const p = pointAt((+k + 0.5) * 200); L.marker(ll(p.x + p.nx * 260, p.y + p.ny * 260), { pane: 'future', interactive: false, icon: L.divIcon({ className: 'plus', html: '+' + coming, iconSize: [42, 20] }) }).addTo(futureLayer); }
  }
  const r = rec(), c = r.classLocation, range = SEG.rangeOf(index, r.id);
  const from = c ? c.window.kmFrom * 1000 : range.fromM, to = c ? c.window.kmTo * 1000 : range.toM;
  L.polygon(bandOf(from, to, 200), { color: C.ink, weight: 1.2, dashArray: '5 5', fillColor: C.ink, fillOpacity: 0.06, interactive: false }).addTo(bandLayer);
  L.polygon(bandOf(from, to, 30), { color: C.ink, weight: 0, fillColor: C.ink, fillOpacity: 0.1, interactive: false }).addTo(bandLayer);
}
function select(id, fly = true) {
  selected = id; if (step === 'corridor') step = 'changed'; render();
  if (!fly) return;
  const r = rec(), c = r.classLocation, range = SEG.rangeOf(index, id);
  map.flyToBounds(L.latLngBounds(bandOf(c ? c.window.kmFrom * 1000 : range.fromM, c ? c.window.kmTo * 1000 : range.toM, 320)), { ...pad(), duration: 0.9 });
}

/* ---------- strip and queue ---------- */
function renderStrip() {
  const recs = [...built.records].sort((x, y) => x.kmFrom - y.kmFrom), u = urgent(), r = rec();
  const next = u.find((x) => x.id !== selected) || null;
  $('strip').innerHTML = `<div class="head"><b>${esc(DATA.meta.name)}</b><span>${recs.length} km. ${u.length} need a decision.${store.ahead ? ' Showing the ' + store.ahead + ' forecast.' : ''}</span>${next ? `<button type="button" id="next">Next: km ${next.kmFrom}–${next.kmTo}</button>` : ''}</div>
    <div class="cells">${recs.map((x) => { const c = x.classLocation, o = outlook(x); return `<button type="button" class="cell${x.id === selected ? ' sel' : ''}${x.openItems.length ? ' open' : ''}" data-id="${esc(x.id)}" style="background:${C[tone(x)]}" aria-label="km ${x.kmFrom} to ${x.kmTo}, ${esc(statusOf(x)[1])}" title="km ${x.kmFrom}–${x.kmTo}: ${esc(statusOf(x)[1])}">${o ? o.now + (o.all > o.now ? '→' + o.all : '') : c ? c.class.now + (c.change ? '→' + c.change.to : '') : ''}</button>`; }).join('')}</div>
    <div class="cells ruler">${recs.map((x) => `<span>${x.kmFrom % 2 === 0 ? x.kmFrom : ''}</span>`).join('')}</div>
    <div class="key"><span>${store.ahead ? 'Class today, then by ' + store.ahead + '.' : 'Number is the class today.'}</span><span><i style="background:${C.green}"></i>No change</span><span><i style="background:${C.amber}"></i>Change possible</span><span><i style="background:${C.red}"></i>Change dated</span><span><i style="background:${C.ink}"></i>Dot above: needs a decision</span></div>`;
  for (const b of $('strip').querySelectorAll('button.cell')) b.onclick = () => select(b.dataset.id);
  if ($('next')) $('next').onclick = () => select(next.id);
}
/* ---------- inspector: one kilometre, one step at a time ---------- */
const STEPS = [['changed', "What's coming"], ['options', 'Options'], ['decide', 'Decide'], ['record', 'Record']];
function sentence(r) {
  const c = r.classLocation;
  if (!c) return 'Class location is not assessed on this kilometre.';
  return c.status === 'changed' ? `This stretch moved from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}. The regulator's clock is running.`
    : c.status === 'change_committed' ? `Building permits already issued take this stretch from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}.`
    : c.status === 'change_possible' ? `Approved developments could take this stretch from Class ${c.change.from} to Class ${c.change.to}. No building permits yet, so there is no date.`
    : c.status === 'unverified' ? 'There is no dwelling data for this stretch.' : `Class ${c.class.now}, and nothing on file changes that.`;
}
function changedStep(r) {
  const c = r.classLocation, g = TIER[r.geohazard.tier] || TIER.unverified, st = statusOf(r);
  let body = '';
  if (c) {
    const t = CLASS.DEFAULTS.thresholds, total = c.units.existing + c.units.committed + c.units.possible, max = Math.max(60, total * 1.15), pct = (n) => (100 * n / max).toFixed(2) + '%';
    body = `<div class="trio"><div><b>${c.units.existing}</b><span>dwellings today${c.fieldCounted ? ', counted on site' : ''}</span></div><div><b class="c-amber">${c.units.committed}</b><span>more with a building permit</span></div><div><b class="c-amber" style="opacity:.7">${c.units.possible}</b><span>more approved, no permit yet</span></div></div>
      <div class="bar" role="img" aria-label="${c.units.existing} existing, ${c.units.committed} permitted, ${c.units.possible} approved dwellings, against class lines at ${t.class2} and ${t.class3}">
        <span class="ex" style="left:0;width:${pct(c.units.existing)}"></span><span class="co" style="left:${pct(c.units.existing)};width:${pct(c.units.committed)}"></span><span class="po" style="left:${pct(c.units.existing + c.units.committed)};width:${pct(c.units.possible)}"></span>
        ${max > 250 ? '' : `<span class="mk" data-l="Class 2 at ${t.class2}" style="left:${pct(t.class2)}"></span><span class="mk" data-l="Class 3 at ${t.class3}" style="left:${pct(t.class3)}"></span>`}</div>
      ${max > 250 ? `<p class="cap" style="margin-top:-18px">Far past the Class 3 line of ${t.class3} dwellings.</p>` : ''}
      ${c.clock ? `<p class="note ${c.clock.running ? 'bad' : 'warn'}"><b>${c.clock.running ? 'Plan due' : 'Plan would be due'} ${esc(c.clock.due)}</b>, ${c.clock.monthsLeft} months from now.</p>` : ''}`;
  }
  return `<div class="where">KM ${r.kmFrom} TO ${r.kmTo}</div><h1>km ${r.kmFrom}–${r.kmTo}</h1>
    <div class="status c-${st[0]}"><i></i>${esc(st[1])}</div><p class="lead">${esc(sentence(r))}</p>${body}
    <div class="facts">
      ${(() => { const y = store.ahead || AHEAD[1], o = outlook(r, store.ahead ? aheadMap : forecastAt(y)); return o ? `<div><span class="k">Looking ahead</span><span>By the end of ${y}: ${o.built > o.now ? `<b class="c-red">Class ${o.built}</b> from permits already issued` : `still Class ${o.built} from permits already issued`}${o.all > o.built ? `, and <b class="c-amber">Class ${o.all}</b> if the approved homes are built` : ''}. <span class="cap">A forecast from permits on file, not from imagery.</span></span></div>` : ''; })()}
      <div><span class="k">Ground</span><span><span class="c-${g[0]}">${esc(g[1])}</span>, ${esc(r.geohazard.hazard || 'no score on file')}. <span class="cap">${esc(r.geohazard.why || '')}</span></span></div>
      <div><span class="k">Land terms</span><span>${r.obligations.length ? `${r.obligations.length} on this kilometre${r.obligations.some((o) => !o.verified) ? ', not all verified' : ''}` : 'None on file'}</span></div>
      <div><span class="k">Digging nearby</span><span>${r.encroachment.length ? `${r.encroachment.length} report${r.encroachment.length === 1 ? '' : 's'} inside 30 m` : 'Nothing reported'}</span></div>
      ${c ? `<div><span class="k">Counted in</span><span>The dashed band on the map: km ${c.window.kmFrom} to ${c.window.kmTo}, 200 m each side. <span class="cap">${esc(c.basis)}.</span></span></div>` : ''}
    </div>
    ${c && c.evidence.length ? `<details open style="margin-top:14px"><summary>Yet to be built here: ${c.evidence.length} permit records</summary><ul>${c.evidence.map((e) => `<li><b>${e.units}</b> unit${e.units === 1 ? '' : 's'} near km ${e.km}, ${esc(e.kind.replace(/_/g, ' '))}${e.note ? ', ' + esc(e.note.replace(/^1 permits/, '1 permit')) : ' issued ' + esc(e.issued)}</li>`).join('')}</ul>${c.plans.length ? `<p class="cap">Plans in effect: ${c.plans.map((p) => `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join(', ')}.</p>` : ''}</details>` : ''}`;
}
function optionsStep(r) {
  const d = r.decision;
  if (!d) return `<h1>Options</h1><p class="lead">Nothing to choose on this kilometre. The class is not changing.</p>`;
  const pick = chosen[r.id] || (d.lowestCost && d.lowestCost.key);
  return `<div class="where">CLASS ${d.change.from} TO CLASS ${d.change.to}</div><h1>Options</h1>
    ${d.pricedWithPlaceholders ? '<p class="note warn">Costs are placeholders, not operator figures. Change them under Corridor.</p>' : ''}
    ${d.paths.map((p) => `<label class="path ${p.eligible ? '' : 'off'}">${p.eligible ? `<input type="radio" name="path" value="${p.key}" ${p.key === pick ? 'checked' : ''}>` : '<span></span>'}<span>${esc(p.label)}</span>
      <span class="n">${p.eligible ? money(p.total) : 'n/a'}</span><span class="cap">${p.eligible ? `About ${p.months} months${p.meetsDeadline == null ? '' : p.meetsDeadline ? ', in time' : ', <b class="c-red">misses the deadline</b>'}. ` : ''}${esc(p.why)}${p.materials && p.materials.note ? ' ' + esc(p.materials.note) : ''}${p.obligations.length ? ` Breaks ground, so ${p.obligations.length} land term${p.obligations.length === 1 ? ' applies' : 's apply'}.` : ''}</span></label>`).join('')}
    <p class="cap" style="margin-top:14px">Cost over ${d.horizonYears} years.${d.hingesOn.length ? ` The cheapest answer flips if ${d.hingesOn.map((h) => `${esc(h.unit)} were ${esc(Math.round(h.at).toLocaleString('en-US'))}`).join(', or if ')}.` : ''}</p>
    ${d.unknowns.length ? `<p class="cap">Still needed from the operator: ${esc(d.unknowns.join('; '))}.</p>` : ''}`;
}
function decideStep(r) {
  const orders = store.orders.filter((o) => o.segment === r.id);
  return `<div class="where">KM ${r.kmFrom} TO ${r.kmTo}</div><h1>Decide</h1>
    ${r.drafts.length ? `<p>The system only drafts. A named person decides, and the decision is chained into the record.</p>
      <div class="grid2"><div><label class="f" for="who">Your name</label><input id="who" autocomplete="name"></div><div><label class="f" for="why">Reason, needed to reject</label><input id="why"></div></div>
      ${r.drafts.map((d, i) => { const s = LEDGER.statusOf(store.ledger, d); return `<div class="btnrow" style="border-top:1px solid var(--line);padding-top:12px"><span style="flex:1">${esc(({ class_location: 'Class location', geohazard: 'Ground', land_obligations: 'Land terms', encroachment: 'Digging nearby' })[d.module])}<br><span class="cap">${esc(d.kind.replace(/_/g, ' '))}</span></span>${s === 'draft' ? `<button class="btn" data-act="approve" data-i="${i}">Approve</button><button class="btn ghost" data-act="reject" data-i="${i}">Reject</button>` : `<span class="status c-${s === 'approved' ? 'green' : 'grey'}" style="margin:0"><i></i>${esc(s)}</span>`}</div>`; }).join('')}` : '<p class="lead">Nothing is waiting for a decision here.</p>'}
    ${orders.map((o) => `<p class="note"><b class="mono">${esc(o.id)}</b><br>${esc(o.reason)}. Due ${esc(o.dueBy)}.<br>${esc(o.check.summary)} Earliest start ${esc(o.check.earliestStart.slice(0, 16).replace('T', ' '))} UTC.</p>`).join('')}
    <h2>Report from the field</h2>
    <div class="grid2"><div><label class="f" for="fk">What was found</label><select id="fk">${Object.entries(FEEDBACK.KINDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div><div><label class="f" for="fv">Number, for a count</label><input id="fv" type="number" min="0"></div></div>
    <label class="f" for="fn">Note</label><input id="fn"><label class="f"><input type="checkbox" id="fp" style="width:auto"> Inside the 30 m prescribed area</label>
    <div class="btnrow"><button class="btn ghost" id="addFinding">Record finding</button></div>`;
}
function recordStep(r) {
  const record = LEDGER.decisionRecord(store.ledger, r.id);
  return `<div class="where">KM ${r.kmFrom} TO ${r.kmTo}</div><h1>Record</h1>
    ${record.length ? `<table><tbody>${record.map((e) => `<tr><td class="mono cap">${e.seq}</td><td>${esc(e.what)}${e.value != null ? ': ' + esc(e.value) : ''}${e.estimate != null ? ', estimate ' + money(e.estimate) : ''}<div class="cap">${esc(e.by)}, ${esc(e.at.slice(0, 16).replace('T', ' '))}${e.reason ? ', ' + esc(e.reason) : ''}</div></td><td class="mono cap" title="${esc(e.hash)}">${esc(e.hash.slice(0, 8))}</td></tr>`).join('')}</tbody></table>` : '<p class="lead">Nothing decided or found here yet.</p>'}
    <p class="cap">Every entry is chained to the one before it with SHA-256, so an edit made afterwards shows.</p>
    <div class="btnrow"><button class="btn ghost" id="xPack">Evidence pack PDF</button>${r.classLocation && r.classLocation.change ? '<button class="btn ghost" id="xFiling">Draft plan PDF</button>' : ''}</div>`;
}
function corridorStep() {
  const s = built.classSummary || {}, open = built.records.reduce((a, r) => a + r.openItems.length, 0), chain = LEDGER.verify(store.ledger), L = DATA.meta.labels, base = DECISION.DEFAULTS.assumptions;
  return `<div class="where">CORRIDOR</div><h1 style="font-size:44px">${esc(DATA.meta.name)}</h1>
    <div class="trio"><div><b>${(s.changed || 0) + (s.changeCommitted || 0)}</b><span>class changes with a date</span></div><div><b>${s.changePossible || 0}</b><span>possible, no date yet</span></div><div><b>${open}</b><span>open items</span></div></div>
    ${(() => { const bins = binsNow(), rows = Object.entries(bins).filter(([, b]) => b.coming).sort((x, y) => y[1].coming - x[1].coming), sum = (f) => rows.reduce((t, [, b]) => t + b[f], 0);
      return `<h2>Yet to be built along the line</h2><p class="lead">${sum('permit') === 1 ? '1 home has a building permit and is not finished' : sum('permit') + ' homes have a building permit and are not finished'}. ${sum('approvedOnly')} more are approved and not started.</p>
      <div class="facts">${rows.slice(0, 5).map(([k, b]) => `<div><span class="k">Near km ${((+k + 0.5) * 0.2).toFixed(1)}</span><span><b>+${b.coming}</b> homes <button class="btn ghost" style="padding:3px 12px;margin-left:8px" data-go="${esc(SEG.segmentAt(index, (+k + 0.5) * 200))}">Show</button></span></div>`).join('')}</div>
      <p class="cap">Plans in effect along the line, where more will follow: ${DATA.permits.plans.rows.map((p) => `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join(', ')}.</p>`; })()}
    ${BT ? `<h2>Would permits have warned us?</h2><p>${BT.changes} class change${BT.changes === 1 ? '' : 's'} on this line since ${esc(BT.from.slice(0, 4))}. Issued permits added up to the higher class ${esc(BT.medianLeadMonths)} months before the homes were estimated to be lived in.</p><p class="note warn">${esc(BT.caveat)}</p><p class="cap">Pick 2019 and drag the line over km 7 to 8 to see it happen.</p>` : ''}
    <h2>Take it with you</h2><div class="btnrow"><button class="btn ghost" id="xCsv">Work orders CSV</button><button class="btn ghost" id="xGeo">GeoJSON for Esri</button><button class="btn ghost" id="xLabels">Prediction vs field</button></div>
    <h2>What is real here</h2><div class="facts">${Object.entries(L).map(([k, v]) => `<div><span class="k">${esc(k.replace(/([A-Z])/g, ' $1').replace(/^./, (x) => x.toUpperCase()))}</span><span>${esc(v)}</span></div>`).join('')}<div><span class="k">Imagery</span><span>Esri World Imagery Wayback. Years are when Esri published each release; the photos can be older.</span></div><div><span class="k">Route</span><span>${esc(DATA.meta.route)}</span></div><div><span class="k">Record</span><span>${store.ledger.length} entries, chain ${chain.ok ? 'intact' : 'BROKEN at entry ' + chain.brokenAt}</span></div></div>
    <details style="margin-top:18px"><summary>Cost assumptions</summary><div class="grid2">${Object.entries(base).map(([k, a]) => `<div><label class="f" for="a-${k}">${esc(a.unit)}</label><input id="a-${k}" data-k="${k}" type="number" min="0" value="${esc(store.assumptions[k] != null ? store.assumptions[k] : a.value)}"></div>`).join('')}</div><div class="btnrow"><button class="btn ghost" id="resetAssume">Reset to placeholders</button></div></details>`;
}
function renderInspector() {
  const r = rec(), view = { changed: changedStep, options: optionsStep, decide: decideStep, record: recordStep }[step];
  $('inspector').innerHTML = `<div class="steps" role="tablist">${STEPS.map(([k, l]) => `<button role="tab" aria-selected="${step === k}" data-step="${k}">${l}</button>`).join('')}<button role="tab" class="corr" aria-selected="${step === 'corridor'}" data-step="corridor">Corridor</button></div>` + (view ? view(r) : corridorStep());
  const q = (s) => $('inspector').querySelectorAll(s);
  for (const b of q('[data-step]')) b.onclick = () => { step = b.dataset.step; renderInspector(); $('inspector').scrollTop = 0; };
  for (const b of q('[data-go]')) b.onclick = () => select(b.dataset.go);
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
