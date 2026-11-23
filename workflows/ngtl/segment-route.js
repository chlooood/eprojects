// ===== TerraCorridor NGTL W1 Segmenter (deterministic, fail-closed) =====
// Same as v2 W1 up to the stitching step. v2 keeps only the longest chain; NGTL is a network of separate
// lines, so every chain becomes a line and segment_index runs on across lines (line 1 first, longest first).
// Source of truth: workflows/ngtl/segment-route.js, built by scripts/make-ngtl-w1.js.
const input = $input.first().json;
const cfg = $('Corridor Config').first().json;

const SEGMENT_LENGTH_M = Number(cfg.segment_length_m) || 1000;
const EXCLUSION_M = Number(cfg.exclusion_band_m) || 30;
const STUDY_M = Number(cfg.study_strip_m) || 200;
const R = 6371e3;

const fetchedAt = new Date().toISOString();
const sourceKind = input.source_kind || 'overpass_live';
const sourceUrl = input.source_url || cfg.overpass_url;
const sourceHash = input.source_hash;

function deg2rad(deg) { return deg * (Math.PI / 180); }
function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function r7(n) { return Math.round(n * 1e7) / 1e7; }
function key(p) { return p.lat.toFixed(6) + ',' + p.lon.toFixed(6); }

// Deterministic 64-bit FNV-1a style hash (two 32-bit lanes) -> 16 hex chars
function stableHash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function failClosed(message, extra) {
  return [{ json: Object.assign({
    batch_status: 'unverified',
    error_message: message,
    corridor_id: cfg.corridor_id,
    source_hash: sourceHash || '',
    source_url: sourceUrl,
    source_kind: sourceKind,
    fallback_reason: input.fallback_reason || '',
    fetched_at: fetchedAt,
    way_count: 0,
    route_length_m: 0,
    segment_count: 0,
    segments: [],
  }, extra || {}) }];
}

// ---- 1. Provenance + parse validation ----
if (typeof sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(sourceHash)) {
  return failClosed('Missing or invalid SHA-256 hash of the raw response');
}
let parsed;
try {
  parsed = typeof input.data === 'string' ? JSON.parse(input.data) : input.data;
} catch (e) {
  return failClosed('Raw response is not valid JSON: ' + e.message);
}
if (!parsed || !Array.isArray(parsed.elements)) {
  return failClosed('Response has no elements array' + (parsed && parsed.remark ? ' (remark: ' + parsed.remark + ')' : ''));
}

const ways = parsed.elements
  .filter(el => el && el.type === 'way' && el.tags && el.tags.man_made === 'pipeline')
  .sort((a, b) => a.id - b.id);
if (ways.length === 0) {
  return failClosed('No man_made=pipeline ways found in the corridor bbox');
}

// ---- 2. Strict coordinate validation (any bad coordinate fails the batch) ----
const cleanWays = [];
for (const w of ways) {
  if (!Array.isArray(w.geometry) || w.geometry.length < 2) {
    return failClosed('Way ' + w.id + ' has no usable geometry (need out geom)');
  }
  const pts = [];
  for (const g of w.geometry) {
    const lat = Number(g && g.lat), lon = Number(g && g.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return failClosed('Way ' + w.id + ' contains an invalid coordinate');
    }
    const p = { lat, lon };
    if (pts.length === 0 || key(pts[pts.length - 1]) !== key(p)) pts.push(p);
  }
  const t = w.tags || {};
  const ident = String(t.name || t.ref || ((t.operator || '') + '|' + (t.substance || '')) || 'unnamed').toLowerCase();
  if (pts.length >= 2) cleanWays.push({ id: w.id, pts, ident });
}
if (cleanWays.length === 0) return failClosed('All pipeline ways collapsed to fewer than 2 points');

function lineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += getDistanceFromLatLonInMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  return d;
}

// ---- 3. Stitch ways into continuous chains, keep the longest as the corridor ----
// Only join ways of the same pipeline identity, and only through simple (degree-2) joints,
// so separate pipelines or branches in a dense network are never chained together.
const degree = {};
for (const w of cleanWays) {
  for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
    const k = w.ident + '#' + key(p);
    degree[k] = (degree[k] || 0) + 1;
  }
}
function joinable(ident, p) { return degree[ident + '#' + key(p)] === 2; }
const used = new Set();
const chains = [];
const byLen = cleanWays.slice().sort((a, b) => (lineLength(b.pts) - lineLength(a.pts)) || (a.id - b.id));
for (const seed of byLen) {
  if (used.has(seed.id)) continue;
  used.add(seed.id);
  let chain = seed.pts.slice();
  const wayIds = [seed.id];
  let extended = true;
  while (extended) {
    extended = false;
    for (const w of cleanWays) {
      if (used.has(w.id) || w.ident !== seed.ident) continue;
      const head = key(chain[0]), tail = key(chain[chain.length - 1]);
      const ws = key(w.pts[0]), we = key(w.pts[w.pts.length - 1]);
      const tailOk = joinable(seed.ident, chain[chain.length - 1]);
      const headOk = joinable(seed.ident, chain[0]);
      if (!tailOk && !headOk) break;
      if (tailOk && ws === tail) chain = chain.concat(w.pts.slice(1));
      else if (tailOk && we === tail) chain = chain.concat(w.pts.slice().reverse().slice(1));
      else if (headOk && we === head) chain = w.pts.slice(0, -1).concat(chain);
      else if (headOk && ws === head) chain = w.pts.slice().reverse().slice(0, -1).concat(chain);
      else continue;
      used.add(w.id); wayIds.push(w.id); extended = true;
    }
  }
  chains.push({ pts: chain, wayIds, ident: seed.ident, length: lineLength(chain) });
}
chains.sort((a, b) => (b.length - a.length) || (Math.min(...a.wayIds) - Math.min(...b.wayIds)));

// ---- 5. Offset polygons in a local metric frame ----
function offsetLine(pts, d) {
  const lat0 = pts[0].lat, lon0 = pts[0].lon, k = Math.cos(deg2rad(lat0));
  const xy = pts.map(p => ({ x: deg2rad(p.lon - lon0) * R * k, y: deg2rad(p.lat - lat0) * R }));
  const out = [];
  for (let i = 0; i < xy.length; i++) {
    const prev = xy[Math.max(0, i - 1)], next = xy[Math.min(xy.length - 1, i + 1)];
    const a = i > 0 ? norm(xy[i].x - prev.x, xy[i].y - prev.y) : null;
    const b = i < xy.length - 1 ? norm(next.x - xy[i].x, next.y - xy[i].y) : null;
    let nx, ny, scale = 1;
    if (a && b) {
      const n1 = { x: -a.y, y: a.x }, n2 = { x: -b.y, y: b.x };
      const m = norm(n1.x + n2.x, n1.y + n2.y) || n2;
      const cosHalf = m.x * n2.x + m.y * n2.y;
      scale = Math.min(1 / Math.max(cosHalf, 1e-6), 4); // clamp sharp miters
      nx = m.x; ny = m.y;
    } else {
      const t = a || b;
      nx = -t.y; ny = t.x;
    }
    const ox = xy[i].x + nx * d * scale, oy = xy[i].y + ny * d * scale;
    out.push([r7(lon0 + (ox / (R * k)) * 180 / Math.PI), r7(lat0 + (oy / R) * 180 / Math.PI)]);
  }
  return out;
}
function norm(x, y) { const l = Math.hypot(x, y); return l > 0 ? { x: x / l, y: y / l } : null; }
function ring(inner, outer) { // inner forward + outer reversed, closed
  const r = inner.concat(outer.slice().reverse());
  r.push(r[0]);
  return r;
}


const segments = [];
const lines = [];
let total = 0;
for (let c = 0; c < chains.length; c++) {
  let route = chains[c].pts;
  // Canonical orientation: west -> east (then south -> north) so IDs are stable between runs
  const s0 = route[0], e0 = route[route.length - 1];
  if (s0.lon > e0.lon || (s0.lon === e0.lon && s0.lat > e0.lat)) route = route.slice().reverse();

  // ---- 4. Cumulative haversine distance + 1 km cuts, per line ----
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + getDistanceFromLatLonInMeters(route[i - 1].lat, route[i - 1].lon, route[i].lat, route[i].lon));
  const lineLen = cum[cum.length - 1];
  if (!(lineLen > 0)) continue;
  const pointAt = (dist) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dist) i++;
    const span = cum[i] - cum[i - 1];
    const t = span > 0 ? (dist - cum[i - 1]) / span : 0;
    return { lat: route[i - 1].lat + t * (route[i].lat - route[i - 1].lat), lon: route[i - 1].lon + t * (route[i].lon - route[i - 1].lon) };
  };
  const sliceLine = (d0, d1) => {
    const pts = [pointAt(d0)];
    for (let i = 0; i < route.length; i++) if (cum[i] > d0 && cum[i] < d1) pts.push(route[i]);
    pts.push(pointAt(d1));
    return pts;
  };
  const firstIndex = segments.length;
  const nSeg = Math.ceil(lineLen / SEGMENT_LENGTH_M - 1e-9);
  for (let s = 0; s < nSeg; s++) {
    const d0 = s * SEGMENT_LENGTH_M;
    const d1 = Math.min((s + 1) * SEGMENT_LENGTH_M, lineLen);
    if (d1 - d0 < 1) continue; // drop sub-metre slivers
    const line = sliceLine(d0, d1);
    const leftEx = offsetLine(line, EXCLUSION_M), rightEx = offsetLine(line, -EXCLUSION_M);
    const leftSt = offsetLine(line, EXCLUSION_M + STUDY_M), rightSt = offsetLine(line, -(EXCLUSION_M + STUDY_M));
    const all = leftSt.concat(rightSt);
    const bbox = {
      west: Math.min(...all.map(c => c[0])), east: Math.max(...all.map(c => c[0])),
      south: Math.min(...all.map(c => c[1])), north: Math.max(...all.map(c => c[1])),
    };
    const a = line[0], b = line[line.length - 1];
    const idSeed = [cfg.corridor_id, a.lat.toFixed(6), a.lon.toFixed(6), b.lat.toFixed(6), b.lon.toFixed(6)].join('|');
    const geometry = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { zone: 'centreline', line: c + 1, line_km_from: s }, geometry: { type: 'LineString', coordinates: line.map(p => [r7(p.lon), r7(p.lat)]) } },
        { type: 'Feature', properties: { zone: 'cer_exclusion_band', half_width_m: EXCLUSION_M }, geometry: { type: 'Polygon', coordinates: [ring(leftEx, rightEx)] } },
        { type: 'Feature', properties: { zone: 'study_strip', inner_offset_m: EXCLUSION_M, outer_offset_m: EXCLUSION_M + STUDY_M }, geometry: { type: 'MultiPolygon', coordinates: [[ring(leftEx, leftSt)], [ring(rightEx, rightSt)]] } },
      ],
    };
    segments.push({
      segment_id: 'seg_' + stableHash(idSeed),
      corridor_id: cfg.corridor_id,
      segment_index: segments.length,
      lat_start: r7(a.lat), lon_start: r7(a.lon),
      lat_end: r7(b.lat), lon_end: r7(b.lon),
      length_m: Math.round((d1 - d0) * 100) / 100,
      polygon_geometry_json: JSON.stringify(geometry),
      bbox_south: bbox.south, bbox_west: bbox.west, bbox_north: bbox.north, bbox_east: bbox.east,
      status: 'active',
      source_hash: sourceHash,
      source_kind: sourceKind,
      generated_at: fetchedAt,
    });
  }
  total += lineLen;
  lines.push({ line: c + 1, way_ids: chains[c].wayIds.slice().sort((x, y) => x - y), identity: chains[c].ident,
    length_m: Math.round(lineLen * 100) / 100, first_index: firstIndex, last_index: segments.length - 1 });
}
if (segments.length === 0) return failClosed('Segmentation produced no segments');
const ids = new Set(segments.map(x => x.segment_id));
if (ids.size !== segments.length) return failClosed('Segment ID collision detected');
const allWays = chains.flatMap(ch => ch.wayIds).sort((x, y) => x - y);

return [{ json: {
  batch_status: 'verified',
  error_message: '',
  corridor_id: cfg.corridor_id,
  source_hash: sourceHash,
  source_url: sourceUrl,
  source_kind: sourceKind,
  fallback_reason: input.fallback_reason || '',
  fetched_at: fetchedAt,
  way_count: allWays.length,
  route_identity: [...new Set(chains.map(ch => ch.ident))].join(' + '),
  route_way_ids: allWays,
  route_length_m: Math.round(total * 100) / 100,
  segment_count: segments.length,
  line_count: lines.length,
  lines,
  segments,
} }];
