// Segment record page: the alignment sheet. Satellite map on top, a km-indexed strip below, an inspector
// on the right. Everything is recomputed in the browser from the inlined data with the same modules the
// tests and the n8n Code nodes run. Decisions and findings stay in this browser (and go to W7/W9 with ?api=).
const DATA = window.TC_PLATFORM_DATA, BT = window.TC_BACKTEST;
const { TC_SEGMENTS: SEG, TC_CLASS: CLASS, TC_DECISION: DECISION, TC_LEDGER: LEDGER, TC_FEEDBACK: FEEDBACK, TC_EXPORT: EXPORT, TC_PLATFORM: PLATFORM } = globalThis;
const API = new URLSearchParams(location.search).get('api') || '';
// Key for POSTs to n8n (Header Auth credential "TerraCorridor v2 webhook key"). Open the page once with ?key=...;
// it is kept in this browser and removed from the address bar so a copied link never carries it.
const N8N_KEY = (() => {
  const q = new URLSearchParams(location.search), k = q.get('key');
  try {
    if (k) { localStorage.setItem('tc-key', k); q.delete('key'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); }
    return k || localStorage.getItem('tc-key') || '';
  } catch (e) { return k || ''; }
})();
const KEY = 'tc-platform:' + DATA.meta.corridorId;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = EXPORT.money;
const C = { red: '#ff5d4f', amber: '#f2a93b', green: '#6fd08f', grey: '#5d625a', sand: '#d9c48c', bg: '#0a0b0a', ink: '#eceee6', ink2: '#a5aa9f' };
// Esri World Imagery Wayback: dated releases of the same imagery service the geohazard map uses. Free with attribution.
// The date is when Esri published the release; the photo itself can be older.
const WAYBACK = [{ year: '2019', id: 645, date: '26 Jun 2019' }, { year: '2022', id: 4905, date: '29 Jun 2022' }, { year: '2024', id: 39767, date: '27 Jun 2024' }];
const LATEST = { id: 43291, date: '29 Oct 2026' };
const tileUrl = (id) => `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${id}/{z}/{y}/{x}`;

let store = { ledger: [], findings: [], orders: [], assumptions: {}, jurisdiction: 'CA', before: '2019', ahead: '2035' };
try { store = { ...store, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* storage unavailable: state stays in memory */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* in memory only */ } };
let built = null, selected = null, step = 'changed', chosen = {}, swipe = 0.26;
let map, beforeLayer, lines = {}, bandLayer, dotLayer, futureLayer, fitAll = () => {}, proofMode = false, playTimer = null;
// Looking ahead to 2035 with a growth model run 1000 times (src/growth.js, precomputed at build): land goes
// planned -> building -> built in stages, each stage timed from City of Edmonton records. The page shows
// chances and ranges, never one date.
const AHEAD = ['2028', '2030', '2035'];
const GROWTH = window.TC_GROWTH_RESULT, FUT = GROWTH && GROWTH.forecast, HIND = GROWTH && GROWTH.hindcast;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (t) => { const y = Math.floor(t); return MONTHS[Math.min(11, Math.floor((t - y) * 12))] + ' ' + y; };
const decimalYear = (d) => { const t = new Date(d + 'T00:00:00Z'), y = t.getUTCFullYear(); return y + (t - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)); };
const pct = (p) => (p >= 0.995 ? '99%+' : p > 0 && p < 0.01 ? 'under 1%' : Math.round(p * 100) + '%');
// The chance this kilometre reaches its next class by the end of a year. null when it is already Class 3.
function ahead(r, year = store.ahead) {
  const s = FUT && FUT.bySegment[r.id];
  if (!s || !year) return null;
  if (s.next == null) return { top: true, s };
  return { s, to: s.next, p: s.byYear[year] ? s.byYear[year][s.next] : 0, c: s.cross[s.next] };
}
const band = (p) => (p >= 0.7 ? 'red' : p >= 0.3 ? 'amber' : p >= 0.05 ? 'sand' : 'green');
// One status vocabulary for the whole page: the strip, the line on the map, the panel and the corridor list.
//   Coming: building permits already push it over a class line, or 30%+ of the simulated futures cross it.
//   Watch: 5 to 30% of futures, or approved homes with no building permit yet.
//   Changed since 2019: more homes now than the 2019 roof survey had for that class (the proof stretch).
//   Stable: nothing on file moves it. No data: no dwelling data for the stretch.
const DONE = '#aab6c4';
const ST = { changed: 'Changed, plan clock running', coming: 'Coming', watch: 'Watch', done: 'Changed since 2019', stable: 'Stable', nodata: 'No data' };
const horizon = () => store.ahead || '2035';
function statusFor(r) {
  const c = r.classLocation;
  if (!c || c.status === 'unverified') return { k: 'nodata', col: C.grey };
  if (c.status === 'changed') return { k: 'changed', col: C.red };
  if (c.status === 'change_committed') return { k: 'coming', col: C.red, firm: true };
  const o = ahead(r, horizon()), live = o && !o.top ? o : null;
  if (live && live.p >= 0.3) return { k: 'coming', col: live.p >= 0.7 ? C.red : C.amber, o: live };
  if ((live && live.p >= 0.05) || c.status === 'change_possible') return { k: 'watch', col: C.sand, o: live && live.p >= 0.05 ? live : null };
  const base = CLASS.classOf(c.units.roofsAtBaseline || 0, CLASS.DEFAULTS);
  if (c.class.now > base) return { k: 'done', col: DONE, from: base, to: c.class.now };
  return { k: 'stable', col: C.green };
}
const stLabel = (st) => ST[st.k];
function cellText(r, st) {
  const c = r.classLocation;
  if (!c || st.k === 'nodata') return '–';
  if (st.k === 'changed') return `${c.change.from}→${c.change.to}`;
  if (st.k === 'coming' || st.k === 'watch') return `${c.class.now}→${st.o ? st.o.to : c.change ? c.change.to : c.class.possible}${st.k === 'watch' ? '?' : ''}`;
  if (st.k === 'done') return `${st.to} ✓`;
  return String(c.class.now);
}
const tipOf = (st) => stLabel(st) + (st.o ? `: ${pct(st.o.p)} chance of Class ${st.o.to} by ${horizon()}` : '');
const addedBy = (year) => { const b = FUT && FUT.bins.find((x) => x.year === +year); return b ? b.added : []; };
// The chance by year, 2026 to 2035, with the years and the 0, 50 and 100% lines labelled.
function spark(s, cls) {
  const ys = FUT.years, w = 300, h = 104, L = 36, B = 20, T = 8, R = 8;
  const x = (i) => L + (i / (ys.length - 1)) * (w - L - R), y = (p) => T + (1 - p) * (h - T - B);
  const pts = ys.map((yr, i) => `${x(i).toFixed(1)},${y(s.byYear[yr][cls]).toFixed(1)}`).join(' ');
  const sel = ys.indexOf(+horizon()), mid = Math.floor((ys.length - 1) / 2);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Chance of Class ${cls} by year, ${ys[0]} to ${ys[ys.length - 1]}">`
    + [0, 0.5, 1].map((p) => `<line x1="${L}" x2="${w - R}" y1="${y(p)}" y2="${y(p)}" stroke="currentColor" stroke-opacity="${p === 0.5 ? 0.4 : 0.14}"${p === 0.5 ? ' stroke-dasharray="3 3"' : ''}/><text x="${L - 7}" y="${y(p) + 4}" text-anchor="end">${p * 100}%</text>`).join('')
    + `<polyline points="${pts}" fill="none" stroke="${C.amber}" stroke-width="2.2" stroke-linejoin="round"/>`
    + (sel >= 0 ? `<circle cx="${x(sel)}" cy="${y(s.byYear[ys[sel]][cls])}" r="4.5" fill="${C.amber}" stroke="${C.bg}" stroke-width="1.5"/>` : '')
    + [0, mid, ys.length - 1].map((i) => `<text x="${x(i)}" y="${h - 4}" text-anchor="${i === 0 ? 'start' : i === ys.length - 1 ? 'end' : 'middle'}">${ys[i]}</text>`).join('')
    + `</svg>`;
}
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
  if (store.ahead && !AHEAD.includes(store.ahead)) store.ahead = '2035';
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
      .bindTooltip(() => { const r = built.records.find((x) => x.id === s.id); return `<b>km ${r.kmFrom}–${r.kmTo}</b> · ${esc(tipOf(statusFor(r)))}`; }, { sticky: true, className: 'tc', direction: 'top', offset: [0, -8] });
  }
  fitAll = () => map.fitBounds(L.latLngBounds(all), pad());
  const frame = () => { const r = rec(), c = r.classLocation, rg = SEG.rangeOf(index, r.id); map.fitBounds(L.latLngBounds(bandOf((c ? c.window.kmFrom * 1000 : rg.fromM) - 1500, (c ? c.window.kmTo * 1000 : rg.toM) + 1500, 900)), { ...pad(), maxZoom: 15 }); };
  frame(); requestAnimationFrame(() => { map.invalidateSize(); frame(); clip(); });
  map.on('move zoom resize', clip);
  // Zoomed out, the per-200 m dots pile up on top of each other: show them from street scale in.
  map.on('zoomend', () => { if (map.getZoom() < 13) map.removeLayer(dotLayer); else if (!map.hasLayer(dotLayer)) dotLayer.addTo(map); paintFuture(); });
  new ResizeObserver(() => { map.invalidateSize(); clip(); }).observe($('mapBox'));
  $('swipe').oninput = (e) => { swipe = e.target.value / 100; clip(); };
  // Drag anywhere on the line. The hidden range input keeps it usable from the keyboard.
  const drag = $('drag'); let dragging = false;
  const move = (e) => { const box = $('mapBox').getBoundingClientRect(); swipe = Math.max(0.02, Math.min(0.98, (e.clientX - box.left) / box.width)); $('swipe').value = swipe * 100; clip(); };
  drag.addEventListener('pointerdown', (e) => { dragging = true; drag.setPointerCapture(e.pointerId); map.dragging.disable(); move(e); });
  drag.addEventListener('pointermove', (e) => { if (dragging) move(e); });
  const end = () => { dragging = false; map.dragging.enable(); };
  drag.addEventListener('pointerup', end); drag.addEventListener('pointercancel', end);
  $('years').innerHTML = `<span class="yl">Left: photo from</span>` + WAYBACK.map((w) => `<button type="button" data-y="${w.year}" aria-pressed="${w.year === store.before}">${w.year}</button>`).join('');
  for (const b of $('years').querySelectorAll('button')) b.onclick = () => setBefore(b.dataset.y);
  $('ahead').innerHTML = `<span class="yl">Forecast</span><button type="button" data-y="">Off</button>` + AHEAD.map((y) => `<button type="button" class="fut" data-y="${y}">${y}</button>`).join('');
  for (const b of $('ahead').querySelectorAll('button')) b.onclick = () => { store.ahead = b.dataset.y; save(); render(); };
  clip();
}
function setBefore(y) {
  store.before = y; save(); beforeLayer.setUrl(tileUrl(WAYBACK.find((w) => w.year === y).id));
  for (const x of $('years').querySelectorAll('button')) x.setAttribute('aria-pressed', x.dataset.y === y);
  clip();
}
function setSwipe(v) { swipe = v; $('swipe').value = v * 100; clip(); }
// Left of the divider shows the older imagery, right of it shows today.
function clip() {
  const size = map.getSize(), nw = map.containerPointToLayerPoint([0, 0]), x = nw.x + size.x * swipe;
  map.getPane('after').style.clipPath = `polygon(${x}px ${nw.y}px, ${nw.x + size.x}px ${nw.y}px, ${nw.x + size.x}px ${nw.y + size.y}px, ${x}px ${nw.y + size.y}px)`;
  const px = size.x * swipe;
  $('divider').style.left = px + 'px'; $('drag').style.left = px + 'px';
  $('years').style.left = Math.max(12, px - $('years').offsetWidth - 14) + 'px';
  map.getPane('future').style.clipPath = map.getPane('after').style.clipPath;
  $('ahead').style.left = px + 14 + 'px';
  $('aheadNote').style.left = px + 14 + 'px';
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
  for (const r of built.records) lines[r.id].setStyle({ color: statusFor(r).col, weight: r.id === selected ? 8 : 5 });
  dotLayer.clearLayers(); bandLayer.clearLayers(); futureLayer.clearLayers();
  for (const b of $('ahead').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.y === store.ahead);
  $('aheadNote').textContent = proofMode ? "Right: today's photo." : store.ahead ? `Right: today's photo. Shaded where homes are expected by ${store.ahead} (average of ${(FUT ? FUT.runs : 1000).toLocaleString('en-CA')} simulated futures).` : "Right: today's photo.";
  const bins = binsNow();
  // One quiet dot per 200 m: white for homes added since 2019, amber where permits are issued, a ring where only approved.
  const rad = (u) => 2.5 + Math.sqrt(u) * 0.9;
  for (const [k, b] of Object.entries(bins)) {
    const p = pointAt((+k + 0.5) * 200), at = ll(p.x, p.y), tip = `<b>Near km ${((+k + 0.5) * 0.2).toFixed(1)}</b><br>${b.built} homes added since 2019<br>${b.permit} more with a building permit<br>${b.approved} more approved`;
    const dot = (o) => L.circleMarker(at, o).addTo(dotLayer).bindTooltip(tip, { className: 'tc', direction: 'top' });
    if (b.approved) dot({ radius: rad(b.approved + b.built + b.permit) + 4, color: C.amber, weight: 1.2, fill: false, opacity: 0.9 });
    if (b.built + b.permit) dot({ radius: rad(b.built + b.permit), stroke: false, fillColor: b.permit ? C.amber : C.ink, fillOpacity: 0.92 });
  }
  if (map.getZoom() < 13) map.removeLayer(dotLayer);
  paintFuture();
  const r = rec(), c = r.classLocation, range = SEG.rangeOf(index, r.id);
  const from = c ? c.window.kmFrom * 1000 : range.fromM, to = c ? c.window.kmTo * 1000 : range.toM;
  L.polygon(bandOf(from, to, 200), { color: C.ink, weight: 1.2, dashArray: '5 5', fillColor: C.ink, fillOpacity: 0.06, interactive: false }).addTo(bandLayer);
  L.polygon(bandOf(from, to, 30), { color: C.ink, weight: 0, fillColor: C.ink, fillOpacity: 0.1, interactive: false }).addTo(bandLayer);
}
// The outlook, drawn only right of the line: homes the simulated futures add by the chosen year, averaged over
// all of them, per 200 m. Zoomed out, one label per neighbourhood plan; zoomed in, one per 400 m.
function paintFuture() {
  futureLayer.clearLayers();
  if (!store.ahead || !FUT || proofMode) return;
  const added = addedBy(store.ahead);
  const tag = (at, n, anchorLeft) => L.marker(at, { pane: 'future', interactive: false, icon: L.divIcon({ className: 'plus maybe', html: n, iconSize: [null, 22], iconAnchor: anchorLeft ? [0, 11] : undefined }) }).addTo(futureLayer);
  added.forEach((n, k) => {
    if (n < 0.5) return;
    L.polygon(bandOf(k * 200, (k + 1) * 200, 200), { pane: 'future', color: C.sand, weight: 0.8, dashArray: '3 4', fillColor: C.amber, fillOpacity: Math.min(0.55, 0.1 + n / 90), interactive: false }).addTo(futureLayer);
  });
  if (map.getZoom() >= 14) {
    for (let k = 0; k < added.length; k += 2) {
      const n = Math.round((added[k] || 0) + (added[k + 1] || 0));
      if (n >= 10) { const p = pointAt((k + 1) * 200); tag(ll(p.x + p.nx * 280, p.y + p.ny * 280), `~${n} homes`); }
    }
    return;
  }
  // Zoomed out: one label per neighbourhood plan, stacked in a column beside the line so none overlap,
  // each tied to its stretch by a thin leader line.
  const items = DATA.permits.plans.rows.filter((q) => q.residential && / NSP$/.test(q.name)).map((pl) => {
    const n = Math.round(pl.bins.reduce((t, k) => t + (added[k] || 0), 0)), p = pointAt(((pl.bins[0] + pl.bins[pl.bins.length - 1]) / 2 + 0.5) * 200);
    return { n, at: ll(p.x, p.y), text: `${esc(pl.name.replace(/ NSP$/, ''))}: ~${n} homes` };
  }).filter((x) => x.n >= 10).map((x) => ({ ...x, pt: map.latLngToContainerPoint(x.at) })).sort((a, b) => a.pt.y - b.pt.y);
  if (!items.length) return;
  const colX = Math.max(...items.map((q) => q.pt.x)) + 90;
  let lastY = -Infinity;
  for (const q of items) {
    const yy = Math.max(q.pt.y, lastY + 30); lastY = yy;
    const at = map.containerPointToLatLng([colX, yy]);
    L.polyline([q.at, at], { pane: 'future', color: C.sand, weight: 1, opacity: 0.85, interactive: false }).addTo(futureLayer);
    L.circleMarker(q.at, { pane: 'future', radius: 3, stroke: false, fillColor: C.sand, fillOpacity: 1, interactive: false }).addTo(futureLayer);
    tag(at, q.text, true);
  }
}
function select(id, fly = true) {
  selected = id; if (step === 'corridor' || step === 'proof') step = 'changed'; leaveProof(); render();
  if (!fly) return;
  const r = rec(), c = r.classLocation, range = SEG.rangeOf(index, id);
  map.flyToBounds(L.latLngBounds(bandOf(c ? c.window.kmFrom * 1000 : range.fromM, c ? c.window.kmTo * 1000 : range.toM, 320)), { ...pad(), duration: 0.9, maxZoom: 16 });
}

/* ---------- strip and queue ---------- */
function renderStrip() {
  const recs = [...built.records].sort((x, y) => x.kmFrom - y.kmFrom), u = urgent(), pr = proofRecord();
  $('strip').innerHTML = `<div class="head"><b>${esc(DATA.meta.name)}</b><span>${recs.length} km</span>
      <span class="need">${u.length ? `${u.length} need${u.length === 1 ? 's' : ''} a decision:${u.map((x) => ` <button type="button" class="kmchip${x.id === selected ? ' on' : ''}" data-id="${esc(x.id)}">km ${x.kmFrom}–${x.kmTo}</button>`).join('')}` : 'Nothing needs a decision'}</span>
      <span class="tools">${pr ? `<button type="button" id="proofBtn" class="hi">See it happen: km ${pr.kmFrom}–${pr.kmTo}</button>` : ''}<button type="button" id="wholeLine">Whole line</button></span></div>
    <div class="cells">${recs.map((x) => { const st = statusFor(x), tip = tipOf(st); return `<button type="button" class="cell st-${st.k}${x.id === selected ? ' sel' : ''}${x.openItems.length ? ' open' : ''}" data-id="${esc(x.id)}" style="--c:${st.col}" aria-label="km ${x.kmFrom} to ${x.kmTo}, ${esc(tip)}${x.openItems.length ? ', needs a decision' : ''}" title="km ${x.kmFrom}–${x.kmTo}: ${esc(tip)}">${esc(cellText(x, st))}</button>`; }).join('')}</div>
    <div class="cells ruler">${recs.map((x) => `<span>${x.kmFrom % 2 === 0 ? x.kmFrom : ''}</span>`).join('')}</div>
    <div class="key"><span><i style="background:${C.red}"></i>Coming</span><span><i class="hatch"></i>Watch</span><span><i style="background:${DONE}"></i>Changed since 2019 ✓</span><span><i style="background:${C.green}"></i>Stable</span><span><i class="ring"></i>Needs a decision</span>
      <span class="why">Coming: building permits issued, or 30%+ of ${FUT ? FUT.runs.toLocaleString('en-CA') : ''} simulated futures by ${horizon()}. Watch: 5 to 30%.</span></div>`;
  for (const b of $('strip').querySelectorAll('[data-id]')) b.onclick = () => select(b.dataset.id);
  if ($('proofBtn')) $('proofBtn').onclick = openProof;
  $('wholeLine').onclick = () => fitAll();
}
/* ---------- inspector: one kilometre, one step at a time ---------- */
const STEPS = [['changed', "What's coming"], ['options', 'Options'], ['decide', 'Decide'], ['record', 'Record']];
// The pipe-order date in one line, for the lead. Uses every simulated change date (decision.orderSignal).
function orderSig(r) {
  const o = ahead(r, '2035');
  if (!o || o.top || !o.c.samples || !o.c.samples.length) return null;
  const a = (k) => (store.assumptions[k] != null ? store.assumptions[k] : DECISION.DEFAULTS.assumptions[k].value);
  const lead = a('pipeLeadMonths'), build = a('replaceMonths'), clock = store.jurisdiction === 'US' ? 24 : 6, thr = store.orderAt != null ? store.orderAt : 50;
  return { o, lead, build, clock, thr, sig: DECISION.orderSignal(o.c.samples, FUT.runs, { now: decimalYear(today()), leadMonths: lead, buildMonths: build, clockMonths: clock, threshold: thr / 100 }) };
}
function headline(r, st) {
  const c = r.classLocation, y = horizon();
  if (!c || st.k === 'nodata') return { lead: 'There is no dwelling data for this stretch.' };
  if (st.k === 'changed') return { lead: sentence(r) };
  if (st.k === 'coming' && st.firm) return { lead: `Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}.`, why: 'Building permits already issued push the count over the line.' };
  if (st.o) {
    const o = st.o, range = `8 in 10 of those futures land between ${when(o.c.q10)} and ${when(o.c.q90)}`;
    const why = `${pct(o.p)} chance by ${y}, out of ${FUT.runs.toLocaleString('en-CA')} simulated futures. ${c.units.possible ? `${c.units.possible} homes are approved nearby with no building permit yet, so the date is a range: ` : 'No building permits yet, so the date is a range: '}${range}.`;
    const os = orderSig(r), act = !os || !os.sig.needed ? null : os.sig.orderNow ? 'If replacing the pipe is the answer, order it now.' : os.sig.orderBy != null ? `If replacing the pipe is the answer, order it by ${when(os.sig.orderBy)}.` : null;
    return { lead: st.k === 'coming' ? `Likely Class ${o.to} by ${when(o.c.q50)}.` : `Could reach Class ${o.to}. Worth watching.`, why, act };
  }
  if (st.k === 'watch') return { lead: `Could reach Class ${c.class.possible} if the approved homes are built.`, why: 'No building permits yet, so there is no date.' };
  if (st.k === 'done') return { lead: `Went from Class ${st.from} to Class ${st.to} since 2019.`, why: 'Building permits showed it months before people moved in.', proof: true };
  return { lead: `Class ${c.class.now}. Nothing on file changes that.` };
}
function sentence(r) {
  const c = r.classLocation;
  if (!c) return 'Class location is not assessed on this kilometre.';
  return c.status === 'changed' ? `This stretch moved from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}. The regulator's clock is running.`
    : c.status === 'change_committed' ? `Building permits already issued take this stretch from Class ${c.change.from} to Class ${c.change.to} around ${c.change.date}.`
    : c.status === 'change_possible' ? `Approved developments could take this stretch from Class ${c.change.from} to Class ${c.change.to}. No building permits yet, so there is no date.`
    : c.status === 'unverified' ? 'There is no dwelling data for this stretch.' : `Class ${c.class.now}, and nothing on file changes that.`;
}
function changedStep(r) {
  const c = r.classLocation, g = TIER[r.geohazard.tier] || TIER.unverified, st = statusFor(r), hl = headline(r, st);
  let body = '';
  if (c) {
    const t = CLASS.DEFAULTS.thresholds, total = c.units.existing + c.units.committed + c.units.possible, max = Math.max(60, total * 1.15), pct = (n) => (100 * n / max).toFixed(2) + '%';
    body = `<div class="trio"><div><b>${c.units.existing}</b><span>dwellings today${c.fieldCounted ? ', counted on site' : ''}</span></div><div><b class="c-amber">${c.units.committed}</b><span>more with a building permit</span></div><div><b class="c-amber" style="opacity:.7">${c.units.possible}</b><span>more approved, no permit yet</span></div></div>
      <div class="bar" role="img" aria-label="${c.units.existing} existing, ${c.units.committed} permitted, ${c.units.possible} approved dwellings, against class lines at ${t.class2} and ${t.class3}">
        <span class="ex" style="left:0;width:${pct(c.units.existing)}"></span><span class="co" style="left:${pct(c.units.existing)};width:${pct(c.units.committed)}"></span><span class="po" style="left:${pct(c.units.existing + c.units.committed)};width:${pct(c.units.possible)}"></span>
        ${max > 250 ? '' : `<span class="mk" data-l="Class 2 at ${t.class2}" style="left:${pct(t.class2)}"></span><span class="mk" data-l="Class 3 at ${t.class3}" style="left:${pct(t.class3)}"></span>`}</div>
      ${max > 250 ? `<p class="cap" style="margin-top:-18px">Far past the Class 3 line of ${t.class3} dwellings.</p>` : ''}
      ${c.clock ? `<p class="note ${c.clock.running ? 'bad' : 'warn'}"><b>${c.clock.running ? 'Plan due' : 'Plan would be due'} ${esc(c.clock.due)}</b>, ${c.clock.monthsLeft} month${c.clock.monthsLeft === 1 ? '' : 's'} from now.</p>` : ''}`;
  }
  return `<h1>km ${r.kmFrom}–${r.kmTo}</h1>
    <div class="status" style="color:${st.col}"><i></i>${esc(stLabel(st))}</div><p class="lead">${esc(hl.lead)}</p>${hl.why ? `<p class="why">${esc(hl.why)}</p>` : ''}${hl.act ? `<p class="note warn"><b>${esc(hl.act)}</b> <span class="cap">Details under Options.</span></p>` : ''}${hl.proof ? `<div class="btnrow"><button class="btn" id="proofBtn2">See it happen</button></div>` : ''}${body}
    <div class="facts">
      ${(() => { const y = horizon(), o = ahead(r, y); if (!o) return '';
        if (o.top) return `<div><span class="k">By ${y}</span><span>Already Class ${o.s.classNow}, the highest.</span></div>`;
        if (!o.c.p) return `<div><span class="k">By ${y}</span><span>None of ${FUT.runs.toLocaleString('en-CA')} simulated futures reach Class ${o.to} by ${FUT.years[FUT.years.length - 1]}. <span class="cap">No planned land close enough to fill the window.</span></span></div>`;
        return `<div class="wide"><span class="k">Chance of Class ${o.to}, by year${o.s.cross[3] && !o.s.cross[3].already && o.to === 2 ? ` <span class="cap">(Class 3: ${pct(o.s.byYear[y][3])} by ${y})</span>` : ''}</span>${spark(o.s, o.to)}</div>`; })()}
      <div><span class="k">Ground, 2031–35</span><span><span class="c-${g[0]}">${esc(g[1])}</span>, ${esc(r.geohazard.hazard || 'no score on file')}. <span class="cap">${esc(r.geohazard.why || '')}</span></span></div>
      <div><span class="k">Land terms</span><span>${r.obligations.length ? `${r.obligations.length} on this kilometre${r.obligations.some((o) => !o.verified) ? ', not all verified' : ''}` : 'None on file'}</span></div>
      <div><span class="k">Digging nearby</span><span>${r.encroachment.length ? `${r.encroachment.length} report${r.encroachment.length === 1 ? '' : 's'} inside 30 m` : 'Nothing reported'}</span></div>
      ${c ? `<div><span class="k">Counted in</span><span>The dashed band on the map: km ${c.window.kmFrom} to ${c.window.kmTo}, 200 m each side. <span class="cap">${esc(c.basis)}.</span></span></div>` : ''}
    </div>
    ${c && c.evidence.length ? `<details open style="margin-top:14px"><summary>Yet to be built here: ${c.evidence.length} permit records</summary><ul>${c.evidence.map((e) => `<li><b>${e.units}</b> unit${e.units === 1 ? '' : 's'} near km ${e.km}, ${esc(e.kind.replace(/_/g, ' '))}${e.note ? ', ' + esc(e.note.replace(/^1 permits/, '1 permit')) : ' issued ' + esc(e.issued)}</li>`).join('')}</ul>${c.plans.length ? `<p class="cap">Plans in effect: ${c.plans.map((p) => `<a href="${esc(p.pdf)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join(', ')}.</p>` : ''}</details>` : ''}`;
}
// When to order pipe: the chance the class changes within the window that still leaves time to get pipe and
// replace before the regulator's deadline. Uses every simulated date, not just the median.
function orderStep(r) {
  const os = orderSig(r);
  if (!os) return '';
  const { o, lead, build, clock, thr, sig } = os;
  const rule = `Order when the chance of Class ${o.to} within ${sig.windowMonths} months is ${thr}% or more`;
  const verdict = !sig.needed ? `<p class="note">${esc(sig.note)}</p>`
    : sig.orderNow ? `<p class="note bad"><b>Order pipe now.</b> ${pct(sig.pWithin)} chance of Class ${o.to} within ${sig.windowMonths} months.</p>`
    : sig.orderBy == null ? `<p class="note">${esc(sig.note)}</p>`
    : `<p class="note warn"><b>Order by ${when(sig.orderBy)}.</b> Today the chance within ${sig.windowMonths} months is ${pct(sig.pWithin)}.</p>`;
  return `<h2>When to order pipe</h2>
    <p>This matters if replacing the pipe is the answer. Pipe takes ${lead} months to arrive and ${build} to permit and lay. The ${store.jurisdiction === 'US' ? 'PHMSA' : 'CER'} clock gives ${clock} months after the change. So the order has to go in ${sig.windowMonths > 0 ? sig.windowMonths + ' months before the change' : 'after the change, not before'}.</p>
    ${verdict}
    <div class="grid2"><div><label class="f" for="thr">Order at this chance or above</label><input id="thr" type="number" min="5" max="95" step="5" value="${thr}"></div><div><span class="cap" style="display:block;padding-top:24px">${esc(rule)}. Lower it to order earlier and risk buying pipe for a change that does not come.</span></div></div>`;
}
// Options as a choice: the ones that fit inside the regulator's plan window first, cheapest first, the best one
// tagged; each with a bar of how long it takes against the plan deadline; options that do not apply folded away.
function optionsStep(r) {
  const d = r.decision;
  if (!d) return `<h1 class="t">Options</h1><p class="lead">Nothing to choose on this kilometre yet. Nothing on file changes the class today.</p>${orderStep(r)}`;
  const clock = store.jurisdiction === 'US' ? 24 : 6, reg = store.jurisdiction === 'US' ? 'PHMSA' : 'CER';
  const fits = (p) => (p.meetsDeadline != null ? p.meetsDeadline : p.months <= clock);
  const ok = d.paths.filter((p) => p.eligible).sort((a, b) => (fits(b) - fits(a)) || (a.total - b.total)), off = d.paths.filter((p) => !p.eligible);
  const best = ok.find(fits) || ok[0], pick = chosen[r.id] || (best && best.key);
  const maxM = Math.max(clock, ...ok.map((p) => p.months)) * 1.08, X = (m) => (100 * m / maxM).toFixed(1) + '%';
  return `<h1 class="t">Options <span class="sub">Class ${d.change.from} to Class ${d.change.to}</span></h1>
    <p class="cap">Sorted: done inside the ${clock}-month ${reg} plan window first, then cheapest.</p>
    ${d.pricedWithPlaceholders ? '<p class="note warn">Costs are placeholders, not operator figures. Change them under Corridor.</p>' : ''}
    ${ok.map((p) => `<label class="path${p === best ? ' best' : ''}"><input type="radio" name="path" value="${p.key}" ${p.key === pick ? 'checked' : ''}><span>${esc(p.label)}${p === best ? ' <span class="tagbest">Best fit</span>' : ''}</span>
      <span class="n">${money(p.total)}</span>
      <span class="dl" role="img" aria-label="About ${p.months} months, ${fits(p) ? 'inside' : 'longer than'} the ${clock}-month plan window"><i style="width:${X(p.months)};background:${fits(p) ? C.green : C.red}"></i><b style="left:${X(clock)}"></b></span>
      <span class="cap">About ${p.months} month${p.months === 1 ? '' : 's'}${fits(p) ? '' : ', <b class="c-red">longer than the plan window</b>'}. ${esc(p.why)}${p.materials && p.materials.note ? ' ' + esc(p.materials.note) : ''}${p.obligations.length ? ` Breaks ground, so ${p.obligations.length} land term${p.obligations.length === 1 ? ' applies' : 's apply'}.` : ''}</span></label>`).join('')}
    <p class="dlkey cap"><i></i>Plan due ${clock} months after the change. Bars show how long each option takes.</p>
    ${off.length ? `<details class="off"><summary>Not available here (${off.length})</summary>${off.map((p) => `<p class="cap"><b>${esc(p.label)}.</b> ${esc(p.why)}</p>`).join('')}</details>` : ''}
    <p class="cap" style="margin-top:14px">Cost over ${d.horizonYears} years.${d.hingesOn.length ? ` The cheapest answer flips if ${d.hingesOn.map((h) => `${esc(h.unit)} were ${esc(Math.round(h.at).toLocaleString('en-US'))}`).join(', or if ')}.` : ''}</p>
    ${d.unknowns.length ? `<p class="cap">Still needed from the operator: ${esc(d.unknowns.join('; '))}.</p>` : ''}${orderStep(r)}`;
}
function decideStep(r) {
  const orders = store.orders.filter((o) => o.segment === r.id);
  return `<h1 class="t">Decide <span class="sub">km ${r.kmFrom}–${r.kmTo}</span></h1>
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
  return `<h1 class="t">Record <span class="sub">km ${r.kmFrom}–${r.kmTo}</span></h1>
    ${record.length ? `<table><tbody>${record.map((e) => `<tr><td class="mono cap">${e.seq}</td><td>${esc(e.what)}${e.value != null ? ': ' + esc(e.value) : ''}${e.estimate != null ? ', estimate ' + money(e.estimate) : ''}<div class="cap">${esc(e.by)}, ${esc(e.at.slice(0, 16).replace('T', ' '))}${e.reason ? ', ' + esc(e.reason) : ''}</div></td><td class="mono cap" title="${esc(e.hash)}">${esc(e.hash.slice(0, 8))}</td></tr>`).join('')}</tbody></table>` : '<p class="lead">Nothing decided or found here yet.</p>'}
    <p class="cap">Every entry is chained to the one before it with SHA-256, so an edit made afterwards shows.</p>
    <div class="btnrow"><button class="btn ghost" id="xPack">Evidence pack PDF</button>${r.classLocation && r.classLocation.change ? '<button class="btn ghost" id="xFiling">Draft plan PDF</button>' : ''}</div>`;
}
function corridorStep() {
  const s = built.classSummary || {}, open = built.records.reduce((a, r) => a + r.openItems.length, 0), chain = LEDGER.verify(store.ledger), L = DATA.meta.labels, base = DECISION.DEFAULTS.assumptions;
  const sts = built.records.map(statusFor), cnt = (k) => sts.filter((x) => x.k === k).length, pr = proofRecord();
  return `<h1 class="t">${esc(DATA.meta.name)} <span class="sub">${built.records.length} km</span></h1>
    <div class="trio"><div><b>${cnt('coming') + cnt('changed')}</b><span>coming by ${horizon()}</span></div><div><b>${cnt('watch')}</b><span>to watch</span></div><div><b>${cnt('done')}</b><span>changed since 2019</span></div></div>
    <p class="cap">${open} open item${open === 1 ? '' : 's'} across the line.</p>
    ${pr ? `<h2>Did the permits warn us?</h2><p>Yes, on km ${pr.kmFrom}–${pr.kmTo}: building permits crossed the class lines months before people moved in.</p><div class="btnrow"><button class="btn" id="proofBtn3">See it happen</button></div>` : ''}
    ${FUT ? (() => { const y = store.ahead || '2035', added = addedBy(y), total = Math.round(added.reduce((a, n) => a + n, 0)), f = FUT.fit;
      const byPlan = DATA.permits.plans.rows.filter((p) => p.residential && / NSP$/.test(p.name)).map((p) => ({ p, n: Math.round(p.bins.reduce((a, k) => a + (added[k] || 0), 0)) })).filter((x) => x.n >= 1).sort((a, b) => b.n - a.n);
      const perYear = FUT.years.slice(1).map((yr) => ({ yr, n: Math.round(addedBy(yr).reduce((a, n) => a + n, 0)) })), top = Math.max(1, ...perYear.map((x) => x.n));
      const watch = built.records.map((r) => ({ r, o: ahead(r, y) })).filter((x) => x.o && !x.o.top && x.o.p >= 0.05).sort((a, b) => b.o.p - a.o.p);
      return `<h2>Yet to be built by ${y}</h2><p class="lead">About ${total} homes added within 200 m of the line, averaged over ${FUT.runs} simulated futures.</p>
      <div class="years" role="img" aria-label="Homes added by end of each year">${perYear.map((x) => `<div><i style="height:${(100 * x.n / top).toFixed(0)}%"${String(x.yr) === y ? ' class="on"' : ''}></i><span>${String(x.yr).slice(2)}</span></div>`).join('')}</div>
      <div class="facts">${byPlan.map(({ p, n }) => `<div><span class="k">${esc(p.name.replace(/ NSP$/, ''))}</span><span><b>~${n}</b> homes, km ${p.kmFrom}–${p.kmTo} <button class="btn ghost" style="padding:3px 12px;margin-left:8px" data-go="${esc(SEG.segmentAt(index, (p.bins[0] + 0.5) * 200))}">Show</button> <a class="cap" href="${esc(p.pdf)}" target="_blank" rel="noopener">plan</a></span></div>`).join('')}
        ${watch.map(({ r, o }) => `<div><span class="k">km ${r.kmFrom}–${r.kmTo}</span><span><b class="c-${band(o.p)}">${pct(o.p)}</b> chance of Class ${o.to} by ${y}, most likely ${when(o.c.q50)} <button class="btn ghost" style="padding:3px 12px;margin-left:8px" data-go="${esc(r.id)}">Show</button></span></div>`).join('')}</div>
      <h2>How the futures are made</h2>
      <p>Land moves in stages: planned, building, built. Each stage is timed from City of Edmonton records across the city, not guessed.</p>
      <div class="facts">
        <div><span class="k">Starts</span><span>A planned 4 ha block next to one that started recently has about a ${pct(FUT.hazard.adjRecent.perYear)} chance of starting each year; with no building nearby, ${pct(FUT.hazard.none.perYear)}. <span class="cap">${f.blocksStarted} block starts, 2009 on. ${pct(f.neverShare)} of land in ${f.curedFromPlans} mature plans never built, so it is left out of these rates.</span></span></div>
        <div><span class="k">Build-out</span><span>90% of a block's homes are built within ${f.medianYearsTo90} years of its first permit, about ${f.medianUnitsPerBlock} homes a block. <span class="cap">${f.finishedBlocks} finished blocks.</span></span></div>
        <div><span class="k">Approval to permit</span><span>${pct(f.devToBuildingRate)} of approved homes got a building permit, median ${f.devToBuildingMedianMonths} months later.</span></div>
        <div><span class="k">Permit to move-in</span><span>Median ${f.moveInMedianMonths} months for houses. Apartments use an assumed ${20} months.</span></div>
      </div>
      ${HIND ? `<h2>Would it have worked in 2016?</h2><p>Fitted only on records up to the end of 2016, then run forward to mid 2026 and compared with what happened.</p>
      <div class="facts">${HIND.segmentChanges.map((x) => `<div><span class="k">km ${x.kmFrom}, Class ${x.toClass}</span><span>Predicted ${pct(x.predicted)}. ${x.happened ? '<b class="c-green">It happened.</b>' : '<b class="c-amber">It did not.</b>'}</span></div>`).join('')}
        <div><span class="k">Per kilometre</span><span>Brier score ${HIND.segmentBrier} over ${HIND.segmentsScored} kilometres. <span class="cap">0 is perfect.</span></span></div>
        <div><span class="k">Per block</span><span>${HIND.blocks.planned} planned blocks; it expected ${HIND.blocks.expectedStarts} to start and ${HIND.blocks.startedSince} did. Brier ${HIND.blocks.brier}, against ${HIND.blocks.baselineBrier} for one flat rate.</span></div></div>
      <p class="note warn">Which kilometre changes, it called well. Which block starts first, it does no better than a flat rate yet. One line and one hindcast is a small test.</p>` : ''}
      <p class="cap">${esc(FUT.note)}</p>`; })() : ''}
    <h2>Take it with you</h2><div class="btnrow"><button class="btn ghost" id="xCsv">Work orders CSV</button><button class="btn ghost" id="xGeo">GeoJSON for Esri</button><button class="btn ghost" id="xLabels">Prediction vs field</button></div>
    <h2>What is real here</h2><div class="facts">${Object.entries(L).map(([k, v]) => `<div><span class="k">${esc(k.replace(/([A-Z])/g, ' $1').replace(/^./, (x) => x.toUpperCase()))}</span><span>${esc(v)}</span></div>`).join('')}<div><span class="k">Imagery</span><span>Esri World Imagery Wayback. Years are when Esri published each release; the photos can be older.</span></div><div><span class="k">Route</span><span>${esc(DATA.meta.route)}</span></div><div><span class="k">Record</span><span>${store.ledger.length} entries, chain ${chain.ok ? 'intact' : 'BROKEN at entry ' + chain.brokenAt}</span></div></div>
    <details style="margin-top:18px"><summary>Cost assumptions</summary><div class="grid2">${Object.entries(base).map(([k, a]) => `<div><label class="f" for="a-${k}">${esc(a.unit)}</label><input id="a-${k}" data-k="${k}" type="number" min="0" value="${esc(store.assumptions[k] != null ? store.assumptions[k] : a.value)}"></div>`).join('')}</div><div class="btnrow"><button class="btn ghost" id="resetAssume">Reset to placeholders</button></div></details>`;
}
/* ---------- proof: the permits saw it first ---------- */
// The stretch that went up a class since the 2019 roof survey, and the building permits that got it there.
function proofRecord() {
  const done = built.records.filter((r) => statusFor(r).k === 'done');
  return done.sort((a, b) => (b.classLocation.units.builtSinceBaseline || 0) - (a.classLocation.units.builtSinceBaseline || 0))[0] || null;
}
function proofSeries(r) {
  const c = r.classLocation, st = CLASS.normalize(DATA.permits, index), base = st.baseline ? st.baseline.date : '2019-12-31', t = CLASS.DEFAULTS.thresholds;
  const from = c.window.kmFrom * 1000, to = c.window.kmTo * 1000;
  const ev = st.events.filter((e) => e.kind === 'building_permit' && e.chainageM >= from && e.chainageM < to && e.issued > base).sort((a, b) => a.issued.localeCompare(b.issued));
  let n = c.units.roofsAtBaseline || 0; const pts = [{ t: '2019-06-26', n }], cross = {};
  for (const e of ev) { const before = n; n += e.units; pts.push({ t: e.issued, n }); if (before < t.class2 && n >= t.class2 && !cross[2]) cross[2] = e.issued; if (before < t.class3 && n >= t.class3 && !cross[3]) cross[3] = e.issued; }
  return { pts, cross, total: n, base, t };
}
const monthYear = (iso) => when(decimalYear(iso));
const PHOTOS = [{ k: '2019', label: '2019 photo', date: '2019-06-26' }, { k: '2022', label: '2022 photo', date: '2022-06-29' }, { k: '2024', label: '2024 photo', date: '2024-06-27' }, { k: 'now', label: 'Today', date: '2026-10-29' }];
// Homes with a building permit in the counting window, by issue date, against the two class lines and the photo dates.
function proofChart(ps, at) {
  const w = 360, h = 190, L = 34, R = 10, T = 10, B = 24, t0 = decimalYear('2019-01-01'), t1 = decimalYear('2027-01-01');
  const ymax = Math.max(60, Math.min(ps.total, 120)), x = (iso) => L + (decimalYear(iso) - t0) / (t1 - t0) * (w - L - R), y = (n) => T + (1 - Math.min(n, ymax) / ymax) * (h - T - B);
  let d = `M${x(ps.pts[0].t).toFixed(1)},${y(ps.pts[0].n).toFixed(1)}`;
  for (let i = 1; i < ps.pts.length; i++) d += `H${x(ps.pts[i].t).toFixed(1)}V${y(ps.pts[i].n).toFixed(1)}`;
  d += `H${x('2026-11-22').toFixed(1)}`;
  const line = (n, l) => `<line x1="${L}" x2="${w - R}" y1="${y(n)}" y2="${y(n)}" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="3 3"/><text x="${w - R}" y="${y(n) - 5}" text-anchor="end">${l}</text>`;
  const cross = (k, col) => (ps.cross[k] ? `<circle cx="${x(ps.cross[k])}" cy="${y(k === 2 ? ps.t.class2 : ps.t.class3)}" r="4.5" fill="${col}" stroke="${C.bg}" stroke-width="1.5"/>` : '');
  return `<svg class="proofchart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Homes with a building permit near km ${ps.label}, 2019 to 2026, crossing the Class 2 line in ${ps.cross[2] ? monthYear(ps.cross[2]) : 'no date'} and the Class 3 line in ${ps.cross[3] ? monthYear(ps.cross[3]) : 'no date'}">`
    + PHOTOS.map((p) => `<line x1="${x(p.date)}" x2="${x(p.date)}" y1="${T}" y2="${h - B}" stroke="${p.k === at ? C.ink : 'currentColor'}" stroke-opacity="${p.k === at ? 0.9 : 0.15}" stroke-width="${p.k === at ? 1.5 : 1}"/>`).join('')
    + line(ps.t.class2, `Class 2 at ${ps.t.class2}`) + line(ps.t.class3, `Class 3 at ${ps.t.class3}`)
    + `<path d="${d}" fill="none" stroke="${C.amber}" stroke-width="2.2"/>` + cross(2, C.amber) + cross(3, C.red)
    + (ps.total > ymax ? `<text x="${w - R}" y="${T + 10}" text-anchor="end">${ps.total} by 2026, off the top</text>` : '')
    + [0, ymax].map((n) => `<text x="${L - 6}" y="${y(n) + 4}" text-anchor="end">${n}</text>`).join('')
    + ['2019', '2021', '2023', '2025'].map((yr) => `<text x="${x(yr + '-01-01')}" y="${h - 6}" text-anchor="middle">${yr}</text>`).join('')
    + `</svg>`;
}
let proofAt = '2019';
function showPhoto(k) {
  proofAt = k;
  if (k === 'now') setSwipe(0.02); else { setBefore(k); setSwipe(0.98); }
  if (step === 'proof') renderInspector();
}
function openProof() {
  const r = proofRecord(); if (!r) return;
  selected = r.id; step = 'proof'; proofMode = true; render();
  const c = r.classLocation;
  map.flyToBounds(L.latLngBounds(bandOf(c.window.kmFrom * 1000 - 300, c.window.kmTo * 1000 + 300, 450)), { ...pad(), duration: 0.9, maxZoom: 16 });
  showPhoto('2019');
}
function leaveProof() { if (playTimer) { clearTimeout(playTimer); playTimer = null; } if (proofMode) { proofMode = false; setSwipe(0.26); } }
function playProof() {
  const seq = ['2019', '2022', '2024', 'now']; let i = 0;
  const tick = () => { showPhoto(seq[i]); i += 1; playTimer = i < seq.length ? setTimeout(tick, 1800) : null; };
  if (playTimer) clearTimeout(playTimer); tick();
}
function proofStep() {
  const r = proofRecord(); if (!r) return '<p class="lead">No stretch on this line has changed class since 2019.</p>';
  const c = r.classLocation, ps = proofSeries(r); ps.label = `${c.window.kmFrom} to ${c.window.kmTo}`;
  const lag = FUT && FUT.fit ? FUT.fit.moveInMedianMonths : null;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return `<h1 class="t">Permits saw it first <span class="sub">km ${r.kmFrom}–${r.kmTo}, homes counted from km ${c.window.kmFrom} to ${c.window.kmTo}</span></h1>
    <p class="lead">In 2019 this stretch had ${c.units.roofsAtBaseline ? c.units.roofsAtBaseline + ' homes' : 'no homes'} within 200 m of the line. It is Class ${c.class.now} today${c.units.existing ? `, with about ${c.units.existing} homes` : ''}.</p>
    ${lag != null ? `<div class="bignum"><b>${String(lag).replace('.5', '½')} months</b><span>of warning: the median wait from building permit to move-in, measured across Edmonton. The class changes when people move in; the permits are public months before.</span></div>` : ''}
    <div class="photos" role="group" aria-label="Show the photo from">${PHOTOS.map((p) => `<button type="button" data-photo="${p.k}" aria-pressed="${p.k === proofAt}">${p.label}</button>`).join('')}${reduced ? '' : '<button type="button" id="playProof" class="play">Play</button>'}</div>
    ${proofChart(ps, proofAt)}
    <div class="facts">
      ${ps.cross[2] ? `<div><span class="k">Class 2 line</span><span>Crossed by building permits in <b>${monthYear(ps.cross[2])}</b>.</span></div>` : ''}
      ${ps.cross[3] ? `<div><span class="k">Class 3 line</span><span>Crossed by building permits in <b>${monthYear(ps.cross[3])}</b>.</span></div>` : ''}
      <div><span class="k">Photos</span><span>Esri releases of ${PHOTOS.slice(0, 3).map((p) => p.k).join(', ')} and today. The release date can be later than the photo.</span></div>
    </div>
    <p class="note warn">Permit dates are real City of Edmonton records, grouped by quarter. Move-in dates on this stretch are estimated from the city-wide median, not observed one by one.</p>
    <div class="btnrow"><button type="button" class="btn ghost" data-go="${esc(r.id)}">Back to km ${r.kmFrom}–${r.kmTo}</button></div>`;
}
function renderInspector() {
  const r = rec(), view = { changed: changedStep, options: optionsStep, decide: decideStep, record: recordStep, proof: proofStep }[step];
  $('inspector').innerHTML = `<div class="steps" role="tablist">${STEPS.map(([k, l]) => `<button role="tab" aria-selected="${step === k}" data-step="${k}">${l}</button>`).join('')}<button role="tab" class="corr" aria-selected="${step === 'corridor'}" data-step="corridor">Corridor</button></div>` + (view ? view(r) : corridorStep());
  const q = (s) => $('inspector').querySelectorAll(s), on = (id, fn) => { if ($(id)) $(id).onclick = fn; };
  for (const b of q('[data-step]')) b.onclick = () => { step = b.dataset.step; if (proofMode) { leaveProof(); paintMap(); } renderInspector(); $('inspector').scrollTop = 0; };
  for (const b of q('[data-photo]')) b.onclick = () => { if (playTimer) { clearTimeout(playTimer); playTimer = null; } showPhoto(b.dataset.photo); };
  on('playProof', playProof); on('proofBtn2', openProof); on('proofBtn3', openProof);
  for (const b of q('[data-go]')) b.onclick = () => select(b.dataset.go);
  for (const el of q('input[name=path]')) el.onchange = () => { chosen[r.id] = el.value; };
  for (const b of q('button[data-act]')) b.onclick = () => decide(r, r.drafts[+b.dataset.i], b.dataset.act);
  for (const el of q('input[data-k]')) el.onchange = () => { const v = +el.value; if (v >= 0) { store.assumptions[el.dataset.k] = v; save(); render(); } };
  on('addFinding', () => addFinding(r));
  if ($('thr')) $('thr').onchange = () => { const v = +$('thr').value; if (v >= 5 && v <= 95) { store.orderAt = v; save(); renderInspector(); } };
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
  try { const res = await fetch(API.replace(/\/$/, '') + path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, N8N_KEY ? { 'X-TerraCorridor-Key': N8N_KEY } : {}), body: JSON.stringify(body) }); return res.ok ? 'recorded in n8n' : res.status === 403 ? 'n8n refused it: missing or wrong key (open the page once with ?key=...), kept in this browser' : 'n8n refused it (' + res.status + '), kept in this browser'; }
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
