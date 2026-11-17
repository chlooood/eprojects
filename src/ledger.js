// TerraCorridor ledger: the one approval gate every module goes through, and the evidence pack.
// A module only ever drafts. A named person approves, rejects or overrides. Each decision is
// chained to the one before it with SHA-256, so a record that was edited afterwards shows.
// This is the part a competitor cannot scrape: what changed, what the operator chose, what it
// cost, what the crew found, one history per kilometre.
(function (root) {
  // Synchronous SHA-256 in plain JS so the same code runs in Node, a browser and an n8n Code node.
  const K = [];
  (function () { let n = 2, i = 0; const frac = (x) => ((x - Math.floor(x)) * 4294967296) | 0; while (i < 64) { let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; } if (p) K[i++] = frac(Math.cbrt(n)); n++; } })();
  function utf8(s) { const o = []; for (const ch of String(s)) { let c = ch.codePointAt(0); if (c < 0x80) o.push(c); else if (c < 0x800) o.push(0xc0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) o.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else o.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); } return o; }
  function sha256(text) {
    const b = utf8(text), bits = b.length * 8;
    b.push(0x80); while (b.length % 64 !== 56) b.push(0);
    const hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
    b.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64), r = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < b.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (b[o + i * 4] << 24) | (b[o + i * 4 + 1] << 16) | (b[o + i * 4 + 2] << 8) | b[o + i * 4 + 3];
      for (let i = 16; i < 64; i++) { const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  // Same object, same text, whatever order its keys were written in.
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  const hashOf = (v) => sha256(typeof v === 'string' ? v : canonical(v));

  const MODULES = ['class_location', 'geohazard', 'land_obligations', 'encroachment'];
  const GENESIS = '0'.repeat(64);

  // A module proposes something. It is a draft until a person decides.
  function draft(module, segmentId, kind, payload, opts = {}) {
    if (!MODULES.includes(module)) throw new Error('unknown module: ' + module);
    if (!segmentId) throw new Error('a draft needs a segment');
    const at = opts.at || new Date().toISOString();
    const inputsHash = hashOf(payload);
    return { id: `${module}:${segmentId}:${kind}:${inputsHash.slice(0, 10)}`, module, segment: segmentId, kind, payload, inputsHash, status: 'draft', draftedAt: at, draftedBy: opts.by || 'system' };
  }

  // Appends one entry and returns the new ledger. Rejecting or overriding needs a reason; nobody approves anonymously.
  function append(ledger, entry) {
    const prev = ledger.length ? ledger[ledger.length - 1].hash : GENESIS;
    const body = { ...entry, seq: ledger.length + 1, prev };
    return [...ledger, { ...body, hash: hashOf(body) }];
  }
  function decide(ledger, action, d) {
    const decision = d && d.decision;
    if (!['approve', 'reject', 'override'].includes(decision)) throw new Error('decision must be approve, reject or override');
    if (!d.by || !String(d.by).trim()) throw new Error('a decision needs the name of the person making it');
    if (decision !== 'approve' && !(d.reason && String(d.reason).trim())) throw new Error(decision + ' needs a reason');
    if (ledger.some((e) => e.type === 'decision' && e.action === action.id)) throw new Error('already decided: ' + action.id);
    return append(ledger, { type: 'decision', action: action.id, module: action.module, segment: action.segment, kind: action.kind, inputsHash: action.inputsHash,
      decision, by: String(d.by).trim(), reason: d.reason || null, chosen: d.chosen || null, estimate: d.estimate == null ? null : d.estimate, at: d.at || new Date().toISOString() });
  }
  // What happened afterwards: a crew finding, or what the work really cost. Same chain.
  function recordOutcome(ledger, o) {
    if (!o || !o.segment) throw new Error('an outcome needs a segment');
    if (!o.by) throw new Error('an outcome needs the name of the person reporting it');
    return append(ledger, { type: o.type === 'actual_cost' ? 'actual_cost' : 'finding', action: o.action || null, module: o.module || null, segment: o.segment, finding: o.finding || null, value: o.value == null ? null : o.value, note: o.note || null, by: o.by, at: o.at || new Date().toISOString() });
  }

  function verify(ledger) {
    let prev = GENESIS;
    for (let i = 0; i < ledger.length; i++) {
      const { hash, ...body } = ledger[i];
      if (body.prev !== prev || body.seq !== i + 1 || hashOf(body) !== hash) return { ok: false, brokenAt: i + 1 };
      prev = hash;
    }
    return { ok: true, entries: ledger.length, head: prev };
  }

  const statusOf = (ledger, action) => { const e = ledger.find((x) => x.type === 'decision' && x.action === action.id); return e ? (e.decision === 'approve' ? 'approved' : e.decision === 'reject' ? 'rejected' : 'overridden') : 'draft'; };

  // One kilometre's history, oldest first: the decision record.
  function decisionRecord(ledger, segmentId) {
    return ledger.filter((e) => e.segment === segmentId).map((e) => ({ seq: e.seq, at: e.at, type: e.type, module: e.module, what: e.type === 'decision' ? `${e.decision} ${e.kind}${e.chosen ? ': ' + e.chosen : ''}` : e.type === 'actual_cost' ? 'actual cost reported' : (e.finding || 'finding'),
      by: e.by, reason: e.reason || e.note || null, estimate: e.estimate == null ? null : e.estimate, value: e.value == null ? null : e.value, hash: e.hash }));
  }

  // Everything an auditor needs for one kilometre: the inputs with their hashes, every decision, and whether the chain is intact.
  function evidencePack(record, ledger, sources = [], opts = {}) {
    const check = verify(ledger);
    return {
      segment: record.id, km: [record.kmFrom, record.kmTo], generatedAt: opts.at || new Date().toISOString(),
      recordHash: hashOf(record),
      sources: sources.map((s) => ({ name: s.name, dataset: s.dataset || null, url: s.url || null, fetchedAt: s.fetchedAt || null, sha256: s.sha256 || (s.content != null ? hashOf(s.content) : null) })),
      decisions: decisionRecord(ledger, record.id),
      chain: { ok: check.ok, entries: ledger.length, head: check.head || null, brokenAt: check.brokenAt || null },
    };
  }

  const api = { sha256, canonical, hashOf, MODULES, GENESIS, draft, append, decide, recordOutcome, verify, statusOf, decisionRecord, evidencePack };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TC_LEDGER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
