// TerraCorridor segment core. One record per kilometre is the platform: every module pins its facts to
// a position along the line (chainage, in metres from the start) and reads them back per segment.
// Pure functions, no imports, [lon, lat] order like src/engine.js.
(function (root) {
  const toRad = (d) => (d * Math.PI) / 180;

  // Builds a lookup from the ordered segments: a flat list of line pieces with their chainage,
  // and the chainage range each segment covers. Uses a local flat projection, good to well under
  // a metre over a corridor of this size.
  function buildIndex(segments) {
    const segs = (segments || []).filter((s) => Array.isArray(s.centreline) && s.centreline.length >= 2);
    if (!segs.length) throw new Error('no segments with a centreline');
    const lats = segs.flatMap((s) => s.centreline.map((p) => p[1]));
    const lat0 = lats.reduce((a, b) => a + b, 0) / lats.length;
    const kx = 111320 * Math.cos(toRad(lat0)), ky = 110574;
    const pieces = [], ranges = [];
    let acc = 0;
    for (const s of segs) {
      const fromM = acc;
      for (let i = 1; i < s.centreline.length; i++) {
        const a = s.centreline[i - 1], b = s.centreline[i];
        const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue;
        pieces.push({ ax, ay, bx, by, len, fromM: acc });
        acc += len;
      }
      ranges.push({ id: s.id, kmFrom: s.kmFrom, kmTo: s.kmTo, fromM, toM: acc });
    }
    return { kx, ky, pieces, ranges, lengthM: acc };
  }

  // Nearest point on the line: how far off the centreline, and how far along it.
  function locate(index, lonLat) {
    const x = lonLat[0] * index.kx, y = lonLat[1] * index.ky;
    let best = Infinity, chainageM = 0;
    for (const p of index.pieces) {
      const dx = p.bx - p.ax, dy = p.by - p.ay;
      const t = Math.max(0, Math.min(1, ((x - p.ax) * dx + (y - p.ay) * dy) / (p.len * p.len)));
      const d = Math.hypot(x - (p.ax + t * dx), y - (p.ay + t * dy));
      if (d < best) { best = d; chainageM = p.fromM + t * p.len; }
    }
    return { offsetM: best, chainageM };
  }

  function segmentAt(index, chainageM) {
    const r = index.ranges.find((q) => chainageM >= q.fromM && chainageM < q.toM) || (chainageM >= index.lengthM ? index.ranges[index.ranges.length - 1] : null);
    return r ? r.id : null;
  }

  // Segments that a stretch of line touches. A point obligation (fromM === toM) touches one segment.
  function overlapping(index, fromM, toM) {
    const lo = Math.min(fromM, toM), hi = Math.max(fromM, toM);
    if (lo === hi) { const id = segmentAt(index, lo); return id ? [id] : []; }
    return index.ranges.filter((r) => r.fromM < hi && r.toM > lo).map((r) => r.id);
  }

  const rangeOf = (index, id) => index.ranges.find((r) => r.id === id) || null;

  // Dates as ISO strings (YYYY-MM-DD). Month arithmetic is all the modules need.
  function addMonths(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }
  const addHours = (isoDateTime, h) => new Date(new Date(isoDateTime).getTime() + h * 3600000).toISOString();
  const monthsBetween = (a, b) => Math.round(((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000 / 30.4375) * 10) / 10;
  const day = (x) => (x instanceof Date ? x.toISOString() : String(x)).slice(0, 10);

  const api = { buildIndex, locate, segmentAt, overlapping, rangeOf, addMonths, addHours, monthsBetween, day };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_SEGMENTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
