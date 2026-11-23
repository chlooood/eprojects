// Builds the NGTL inputs for the "NGTL · W1: Corridor Setup" copy in n8n:
//   data/ngtl/ngtl-overpass.json   the OSM-named NGTL lines in Overpass "out geom" shape (what W1's segmenter reads)
//   workflows/ngtl/segment-route.js W1's segmenter, changed to keep every line instead of only the longest
// Then runs the new segmenter on the file, the way n8n would, and prints what W1 will write.
// Usage: node scripts/make-ngtl-w1.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');

// ---- 1. Overpass-shaped route file from the OSM extract
const gj = JSON.parse(fs.readFileSync(path.join(root, 'data/ngtl/osm-ab-ngtl.geojson'), 'utf8'));
const elements = gj.features.map((f) => {
  const p = f.properties;
  const coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat();
  const tags = { man_made: 'pipeline', substance: p.substance || 'gas', operator: p.operator };
  if (p.location) tags.location = p.location;
  if (p.name) tags.name = p.name;
  return { type: 'way', id: p.osm_way, tags, geometry: coords.map(([lon, lat]) => ({ lat, lon })) };
}).sort((a, b) => a.id - b.id);
const overpass = {
  version: 0.6,
  generator: 'TerraCorridor scripts/make-ngtl-w1.js from the Geofabrik Alberta extract dated 2026-11-21',
  osm3s: { copyright: 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.' },
  elements,
};
const routeText = JSON.stringify(overpass);
fs.writeFileSync(path.join(root, 'data/ngtl/ngtl-overpass.json'), routeText);

// ---- 2. Segmenter: the W1 code up to the stitching step, then every chain instead of chains[0]
const w1 = JSON.parse(fs.readFileSync(path.join(root, 'workflows/W1_ Corridor Setup.json'), 'utf8'));
const orig = w1.nodes.find((n) => n.name === 'Segment Route').parameters.jsCode;
const cut = orig.indexOf('chains.sort((a, b) => (b.length - a.length)');
if (cut < 0) throw new Error('W1 segmenter changed: stitching marker not found');
const head = orig.slice(0, cut)
  .replace('// ===== TerraCorridor W1 Segmenter (deterministic, fail-closed) =====',
    '// ===== TerraCorridor NGTL W1 Segmenter (deterministic, fail-closed) =====\n' +
    '// Same as v2 W1 up to the stitching step. v2 keeps only the longest chain; NGTL is a network of separate\n' +
    '// lines, so every chain becomes a line and segment_index runs on across lines (line 1 first, longest first).\n' +
    '// Source of truth: workflows/ngtl/segment-route.js, built by scripts/make-ngtl-w1.js.');
const offsetStart = orig.indexOf('// ---- 5. Offset polygons in a local metric frame ----');
const offsetEnd = orig.indexOf('const segments = [];');
const offsetFns = orig.slice(offsetStart, offsetEnd);
const tail = `chains.sort((a, b) => (b.length - a.length) || (Math.min(...a.wayIds) - Math.min(...b.wayIds)));

${offsetFns}
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
`;
const code = head + tail;
fs.mkdirSync(path.join(root, 'workflows/ngtl'), { recursive: true });
fs.writeFileSync(path.join(root, 'workflows/ngtl/segment-route.js'), code);

// ---- 3. Run it the way n8n would
const cfg = { corridor_id: 'ngtl-ab-osm', segment_length_m: 1000, exclusion_band_m: 30, study_strip_m: 200 };
const input = { data: routeText, source_hash: crypto.createHash('sha256').update(routeText).digest('hex'), source_kind: 'github_pinned', source_url: 'local' };
const $ = (name) => { if (name !== 'Corridor Config') throw new Error('no node ' + name); return { first: () => ({ json: cfg }) }; };
const $input = { first: () => ({ json: input }) };
const out = new Function('$', '$input', code)($, $input)[0].json;
if (out.batch_status !== 'verified') { console.error(out.error_message); process.exit(1); }
const rowBytes = out.segments.reduce((a, s) => a + JSON.stringify(s).length, 0);
console.log(`route file: ${elements.length} ways, ${routeText.length} bytes, sha256 ${input.source_hash}`);
console.log(`segmenter: ${out.line_count} lines, ${out.segment_count} rows, ${Math.round(out.route_length_m / 1000)} km, ~${Math.round(rowBytes / 1024)} KB of rows`);
for (const l of out.lines) console.log(`  line ${l.line}: ways ${l.way_ids.join(',')}  ${(l.length_m / 1000).toFixed(1)} km  rows ${l.first_index}-${l.last_index}`);
