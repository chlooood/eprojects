#!/usr/bin/env node
// Pull every pipeline out of a Geofabrik OpenStreetMap extract (.osm.pbf), with no dependencies.
// Usage: node scripts/osm-pipelines-extract.js <file.osm.pbf> <out-prefix>
// Writes <out-prefix>-summary.json (length by operator, substance, name) and <out-prefix>-ngtl.geojson
// (lines whose operator or route relation names NOVA / NGTL / TC Energy / TransCanada, or a known NGTL line name).
// OSM data © OpenStreetMap contributors, ODbL 1.0.
'use strict';
const fs = require('fs'), zlib = require('zlib');
const [, , file, outPrefix] = process.argv;
if (!file || !outPrefix) { console.error('usage: osm-pipelines-extract.js <file.osm.pbf> <out-prefix>'); process.exit(1); }

/* ---- minimal protobuf reader ---- */
function rd(buf) { return { b: buf, p: 0, end: buf.length }; }
function varint(r) { let x = 0, m = 1, c; do { c = r.b[r.p++]; x += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return x; }
const zz = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
function fields(buf, fn) { const r = rd(buf); while (r.p < r.end) { const key = varint(r), f = Math.floor(key / 8), t = key & 7;
  if (t === 0) fn(f, varint(r), null); else if (t === 2) { const l = varint(r); fn(f, null, r.b.subarray(r.p, r.p + l)); r.p += l; }
  else if (t === 5) { fn(f, r.b.readInt32LE(r.p), null); r.p += 4; } else if (t === 1) { r.p += 8; } else throw new Error('wire type ' + t); } }
function packed(buf) { const out = [], r = rd(buf); while (r.p < r.end) out.push(varint(r)); return out; }

/* ---- block iterator ---- */
function* blocks(path) {
  const fd = fs.openSync(path, 'r'), size = fs.fstatSync(fd).size; let pos = 0; const lenBuf = Buffer.alloc(4);
  while (pos < size) {
    fs.readSync(fd, lenBuf, 0, 4, pos); const hl = lenBuf.readUInt32BE(0); pos += 4;
    const hb = Buffer.alloc(hl); fs.readSync(fd, hb, 0, hl, pos); pos += hl;
    let type = '', ds = 0; fields(hb, (f, v, b) => { if (f === 1) type = b.toString(); if (f === 3) ds = v; });
    const bb = Buffer.alloc(ds); fs.readSync(fd, bb, 0, ds, pos); pos += ds;
    if (type !== 'OSMData') continue;
    let raw = null; fields(bb, (f, v, b) => { if (f === 1) raw = b; if (f === 3) raw = zlib.inflateSync(b); });
    yield raw;
  }
  fs.closeSync(fd);
}
function parseBlock(raw, onGroup) {
  let strings = [], gran = 100, latOff = 0, lonOff = 0; const groups = [];
  fields(raw, (f, v, b) => { if (f === 1) { strings = []; fields(b, (ff, vv, bb) => { if (ff === 1) strings.push(bb.toString('utf8')); }); }
    else if (f === 2) groups.push(b); else if (f === 17) gran = v; else if (f === 19) latOff = v; else if (f === 20) lonOff = v; });
  for (const g of groups) onGroup(g, strings, gran, latOff, lonOff);
}
const tagsOf = (keys, vals, s) => { const t = {}; for (let i = 0; i < keys.length; i++) t[s[keys[i]]] = s[vals[i]]; return t; };

/* ---- pass 1: pipeline ways and pipeline route relations ---- */
const t0 = Date.now(), ways = new Map(), rels = [];
for (const raw of blocks(file)) parseBlock(raw, (g, s) => {
  fields(g, (f, v, b) => {
    if (f === 3) { let id = 0, keys = [], vals = [], refs = [];
      fields(b, (ff, vv, bb) => { if (ff === 1) id = vv; else if (ff === 2) keys = packed(bb); else if (ff === 3) vals = packed(bb); else if (ff === 8) refs = packed(bb); });
      const t = tagsOf(keys, vals, s);
      if (t.man_made === 'pipeline') { let acc = 0; ways.set(id, { tags: t, refs: refs.map((d) => (acc += zz(d))) }); } }
    else if (f === 4) { let id = 0, keys = [], vals = [], memids = [], types = [];
      fields(b, (ff, vv, bb) => { if (ff === 1) id = vv; else if (ff === 2) keys = packed(bb); else if (ff === 3) vals = packed(bb); else if (ff === 9) memids = packed(bb); else if (ff === 10) types = packed(bb); });
      const t = tagsOf(keys, vals, s);
      if (t.route === 'pipeline' || t.man_made === 'pipeline' || (t.type === 'route' && t.route === 'pipeline')) { let acc = 0; const ids = memids.map((d) => (acc += zz(d))); rels.push({ id, tags: t, ways: ids.filter((_, i) => types[i] === 1) }); } }
  });
});
console.error(`pass 1: ${ways.size} pipeline ways, ${rels.length} pipeline relations, ${((Date.now() - t0) / 1000).toFixed(0)} s`);

/* ---- pass 2: coordinates of every node those ways use ---- */
const need = new Set(); for (const w of ways.values()) for (const r of w.refs) need.add(r);
const coord = new Map();
for (const raw of blocks(file)) parseBlock(raw, (g, s, gran, latOff, lonOff) => {
  fields(g, (f, v, b) => {
    if (f !== 2) return; let ids = [], lats = [], lons = [];
    fields(b, (ff, vv, bb) => { if (ff === 1) ids = packed(bb); else if (ff === 8) lats = packed(bb); else if (ff === 9) lons = packed(bb); });
    let id = 0, la = 0, lo = 0;
    for (let i = 0; i < ids.length; i++) { id += zz(ids[i]); la += zz(lats[i]); lo += zz(lons[i]);
      if (need.has(id)) coord.set(id, [+((lonOff + gran * lo) * 1e-9).toFixed(6), +((latOff + gran * la) * 1e-9).toFixed(6)]); }
  });
});
console.error(`pass 2: ${coord.size} of ${need.size} nodes, ${((Date.now() - t0) / 1000).toFixed(0)} s`);

/* ---- lengths, operators, NGTL match ---- */
const R = 6371.0088, rad = (d) => d * Math.PI / 180;
const km = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) { const [x1, y1] = pts[i - 1], [x2, y2] = pts[i]; const a = Math.sin(rad(y2 - y1) / 2) ** 2 + Math.cos(rad(y1)) * Math.cos(rad(y2)) * Math.sin(rad(x2 - x1) / 2) ** 2; s += 2 * R * Math.asin(Math.sqrt(a)); } return s; };
// NOVA / NGTL by name; TC Energy and TransCanada only on gas lines (they also own Keystone, an oil line).
const NGTL_OP = /nova gas|ngtl/i, TC_OP = /tc energy|transcanada|trans canada/i;
const isGas = (t) => /gas/i.test(t.substance || '') && !/keystone|northern border/i.test(t.name || '');
const NGTL_NAME = /ngtl|nova gas|alberta system|north montney|groundbirch|edson mainline|grande prairie mainline|north central corridor|western alberta (system )?mainline|eastern alberta (system )?mainline|peace river mainline|central alberta system/i;
const relOf = new Map(); for (const r of rels) for (const w of r.ways) { if (!relOf.has(w)) relOf.set(w, []); relOf.get(w).push(r); }
const sum = { file: file.split('/').pop(), pipelineWays: ways.size, pipelineRelations: rels.length, km: 0, byOperator: {}, bySubstance: {}, ngtl: { ways: 0, km: 0, byOperator: {}, byName: {}, byDiameter: {}, matchedBy: {} } };
const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
const features = [];
for (const [id, w] of ways) {
  const pts = w.refs.map((r) => coord.get(r)).filter(Boolean); if (pts.length < 2) continue;
  const L = km(pts), t = w.tags, rs = relOf.get(id) || [];
  const op = t.operator || (rs.find((r) => r.tags.operator) || { tags: {} }).tags.operator || '(no operator)';
  sum.km += L; add(sum.byOperator, op, L); add(sum.bySubstance, t.substance || '(none)', L);
  const relName = rs.map((r) => r.tags.name).filter(Boolean).join('; ');
  if (/gas/i.test(t.substance || '') && op === '(no operator)') sum.gasNoOperatorKm = (sum.gasNoOperatorKm || 0) + L;
  if (/gas/i.test(t.substance || '')) sum.gasKm = (sum.gasKm || 0) + L;
  const how = NGTL_OP.test(t.operator || '') || (TC_OP.test(t.operator || '') && isGas(t)) ? 'way operator' : rs.some((r) => NGTL_OP.test(r.tags.operator || '')) ? 'route operator' : NGTL_NAME.test(t.name || '') ? 'way name' : NGTL_NAME.test(relName) ? 'route name' : null;
  if (!how) continue;
  const g = sum.ngtl; g.ways++; g.km += L; add(g.byOperator, op, L); add(g.byName, t.name || relName || '(unnamed)', L); add(g.byDiameter, t.diameter || '(none)', L); add(g.matchedBy, how, L);
  features.push({ type: 'Feature', properties: { osm_way: id, operator: op, name: t.name || null, route: relName || null, substance: t.substance || null, diameter: t.diameter || null, location: t.location || null, km: +L.toFixed(3), matched_by: how }, geometry: { type: 'LineString', coordinates: pts } });
}
const round = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(1)]));
sum.km = +sum.km.toFixed(1); sum.byOperator = Object.fromEntries(Object.entries(round(sum.byOperator)).slice(0, 40)); sum.bySubstance = round(sum.bySubstance);
for (const k of ['byOperator', 'byName', 'byDiameter', 'matchedBy']) sum.ngtl[k] = round(sum.ngtl[k]); sum.ngtl.km = +sum.ngtl.km.toFixed(1);
sum.gasKm = +(sum.gasKm || 0).toFixed(1); sum.gasNoOperatorKm = +(sum.gasNoOperatorKm || 0).toFixed(1);
sum.seconds = Math.round((Date.now() - t0) / 1000);
fs.writeFileSync(outPrefix + '-summary.json', JSON.stringify(sum, null, 1));
fs.writeFileSync(outPrefix + '-ngtl.geojson', JSON.stringify({ type: 'FeatureCollection', attribution: 'OpenStreetMap contributors, ODbL 1.0', features }));
console.log(JSON.stringify({ pipelineWays: sum.pipelineWays, km: sum.km, gasKm: sum.gasKm, gasNoOperatorKm: sum.gasNoOperatorKm, ngtl: { ways: sum.ngtl.ways, km: sum.ngtl.km, matchedBy: sum.ngtl.matchedBy } }));
