// Builds deploy/demo.html and dist/demo.html: an offline slide deck for judges with interactive slides.
// Every number, map and workflow graph is read from the repo at build time. No network requests at runtime.
// The workflow "Run" is a replay of the exported graph with sample data from saved runs, not an n8n execution.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const R = require('../src/renewables.js');
const r1 = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

// ---------- corridors: tiers per window, map geometry, renewables
const tierOf = (t) => (t === 'red' || t === 'red-uncertain' ? 'High' : t === 'amber' ? 'Medium' : t === 'green' ? 'Low' : 'Missing data');
const corridors = [
  { id: 'ab-strathcona-demo', name: 'Edmonton', snap: json('data/snapshot/live-snapshot.json') },
  { id: 'bc-coquihalla', name: 'Coquihalla', snap: json('data/corridors/bc-coquihalla/assessment.json') },
].map((c) => {
  const inp = json(`data/renewables/${c.id}/inputs.json`), a = R.assessCorridor(inp);
  const segs = c.snap.segments.map((s) => ({ km: `${s.kmFrom}–${s.kmTo}`, line: s.centreline.map(([x, y]) => [r1(x, 5), r1(y, 5)]),
    crossing: Array.isArray(s.crossings) && s.crossings.length > 0,
    y5: { t: tierOf(s.risk.y5 && s.risk.y5.tier), s: s.risk.y5 && s.risk.y5.score, h: s.risk.y5 && s.risk.y5.hazard },
    y10: { t: tierOf(s.risk.y10 && s.risk.y10.tier), s: s.risk.y10 && s.risk.y10.score, h: s.risk.y10 && s.risk.y10.hazard } }));
  const count = (w) => segs.reduce((o, s) => ((o[s[w].t] = (o[s[w].t] || 0) + 1), o), {});
  const polys = a.rows.map((r) => { const g = inp.candidates.find((x) => x.id === r.id).polygon;
    const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((p) => p[0].filter((_, i) => i % 2 === 0 || p[0].length < 40).map(([x, y]) => [r1(x, 5), r1(y, 5)]));
    return { tech: r.tech, status: r.status, score: r.score, km: `${r.kmFrom}–${r.kmTo}`, side: r.side, rings }; });
  const stations = inp.layers.stations.features.map((f) => f.geometry.coordinates).filter(([x, y]) => x >= inp.bbox[0] && x <= inp.bbox[2] && y >= inp.bbox[1] && y <= inp.bbox[3]);
  const top = c.snap.segments.filter((s) => s.risk.y10 && s.risk.y10.score != null).sort((x, y) => y.risk.y10.score - x.risk.y10.score)[0];
  return { id: c.id, name: c.name, km: r1(c.snap.segments.reduce((t, s) => t + s.lengthM, 0) / 1000), segs, y5: count('y5'), y10: count('y10'),
    crossings: segs.filter((s) => s.crossing).length, top: { km: `${top.kmFrom}–${top.kmTo}`, score: top.risk.y10.score, hazard: top.risk.y10.hazard },
    bbox: inp.bbox, rbox: (() => { const xs = segs.flatMap((s) => s.line.map((p) => p[0])), ys = segs.flatMap((s) => s.line.map((p) => p[1])); const px = (Math.max(...xs) - Math.min(...xs)) * 0.12 + 0.004, py = (Math.max(...ys) - Math.min(...ys)) * 0.12 + 0.004; return [Math.min(...xs) - px, Math.min(...ys) - py, Math.max(...xs) + px, Math.max(...ys) + py]; })(), polys, stations, renew: { byStatus: a.totals.byStatus, solar: a.pooled.solar, wind: a.pooled.wind, price: a.assumptions.priceCadPerMwh } };
});

// ---------- workflows: real graph from the exports, with a one-line summary of each node's settings
const short = (t) => t.split('.').pop();
function summary(n) {
  const p = n.parameters || {}, t = short(n.type);
  if (t === 'httpRequest') return 'GET/POST ' + String(p.url || '').replace(/^=/, '').slice(0, 120);
  if (t === 'dataTable') return `${p.operation || 'get'} · ${(p.dataTableId && (p.dataTableId.cachedResultName || p.dataTableId.value)) || ''}`;
  if (t === 'scheduleTrigger') return 'Schedule: ' + JSON.stringify((p.rule && p.rule.interval) || p.rule || {}).replace(/[{}"\[\]]/g, ' ').trim();
  if (t === 'webhook') return `Webhook ${p.httpMethod || 'GET'} /${p.path || ''}`;
  if (t === 'code') { const m = String(p.jsCode || '').split('\n').find((l) => /^\s*\/\/\s*\S/.test(l)); return m ? m.replace(/^\s*\/\/\s*/, '').slice(0, 160) : 'JavaScript'; }
  if (t === 'set') return 'Sets ' + ((p.assignments && p.assignments.assignments) || []).map((a) => a.name).slice(0, 6).join(', ');
  if (t === 'if' || t === 'switch' || t === 'filter') return 'Branches on a condition';
  if (t === 'executeWorkflow') return 'Calls another workflow';
  if (/lmChat|openAi|agent|chainLlm/i.test(t)) return 'AI writes a short explanation from the computed numbers only';
  if (t === 'emailSend') return 'Sends email (needs SMTP credential)';
  if (t === 'crypto') return 'SHA-256 of the raw response';
  return t;
}
function order(w) {
  const names = w.nodes.map((n) => n.name), start = w.nodes.filter((n) => /trigger|webhook/i.test(n.type)).map((n) => n.name);
  const seen = new Set(), out = [], q = [...start];
  while (q.length) { const n = q.shift(); if (seen.has(n)) continue; seen.add(n); out.push(n);
    for (const branch of ((w.connections[n] || {}).main || [])) for (const e of branch || []) if (!seen.has(e.node)) q.push(e.node); }
  return out.concat(names.filter((n) => !seen.has(n)));
}
const bc = corridors[1], ed = json('data/snapshot/live-snapshot.json'), bcs = json('data/corridors/bc-coquihalla/assessment.json');
const bcTop = bcs.segments.find((s) => `${s.kmFrom}–${s.kmTo}` === bc.top.km);
let fv = null; try { fv = json('data/corridors/bc-coquihalla/forecast-verification.json'); } catch (e) {}
let solarRow = null; try { solarRow = json('data/cache/solar/latest.json').rows[0]; } catch (e) {}
const SAMPLES = {
  W1: { label: 'One segment written to corridor_segments (Edmonton, saved run)', data: { segment_id: ed.segments[0].id, km: `${ed.segments[0].kmFrom}–${ed.segments[0].kmTo}`, length_m: ed.segments[0].lengthM, centreline: ed.segments[0].centreline.slice(0, 2).concat(['…']) } },
  W2: { label: `Coquihalla km ${bc.top.km}, 2031–35 result (saved rescore)`, data: { segment_id: bcTop.id, score: bcTop.risk.y10.score, worst_hazard: bcTop.risk.y10.hazard,
    hazards: Object.fromEntries(Object.entries(bcTop.risk.y10.hazards).map(([k, v]) => [k, { score: v.score, why: v.why }])), model_agreement: bcTop.risk.y10.agreement } },
  WF3: { label: 'Forecast check on flagged Coquihalla ground (saved verification)', data: fv ? JSON.parse(JSON.stringify(fv, (k, v) => (Array.isArray(v) && v.length > 4 ? v.slice(0, 3).concat(['…' + (v.length - 3) + ' more']) : v))) : { note: 'no saved verification' } },
  WF4: { label: 'Example request from the dashboard Approve button, and the shape of the reply', data: { request: { action: 'approve', corridor: 'bc-coquihalla', segment: bcTop.id, actor: 'integrity manager' },
    reply: { ok: true, status: 'approved', work_order_id: 'WO-…', priority: 'P1', note: 'stored in corridor_work_orders; decision logged in corridor_audit' } } },
  Email: { label: 'Delivery states the handoff workflow can record', data: { delivery_state: ['queued', 'sending', 'provider_accepted', 'needs_review', 'cancelled'], note: 'Provider accepted is not inbox receipt or crew dispatch.' } },
  W5: { label: 'One solar build row (Edmonton, NASA POWER sunlight, saved)', data: solarRow || { note: 'no saved row' } },
  API: { label: 'Top of the corridor JSON the dashboard reads (Edmonton saved feed)', data: { meta: { corridorId: ed.meta.corridorId, segmentsTotal: ed.segments.length, source: ed.meta.source || 'n8n Data Tables', generatedAt: ed.meta.generatedAt }, segments: ['…' + ed.segments.length + ' segments with scores, drivers and work orders'] } },
};
const FLOW = [
  ['W1', 'W1_ Corridor Setup.json', 'Corridor setup', 'Turns the mapped pipeline into 1 km segments with a 30 m no-build band and a study strip.'],
  ['W2', 'W2_ Long-Range Engine.json', 'Long-range engine', 'Weekly. Pulls 30 years of weather, three climate models and satellite plant cover, scores four hazards, and has AI explain flagged kilometres from the numbers.'],
  ['WF3', 'TerraCorridor WF3 - Near-term watch.json', 'Near-term watch', 'Daily. Checks the 16-day forecast on flagged ground. Can draft at most 3 work orders, in dry-run.'],
  ['WF4', 'TerraCorridor WF4 - Work orders and approvals.json', 'Work orders and approvals', 'Receives Approve, Reject or Override from the dashboard, checks it, saves the work order and logs who decided.'],
  ['Email', 'TerraCorridor Email - Approved inspection handoff.json', 'Inspection handoff', 'Sends approved inspections by email once SMTP is set up, and records what happened.'],
  ['W5', 'TerraCorridor W5 - Solar + Storage Build Layer and Weekly Report.json', 'Solar build layer and report', 'Prices solar and storage on stable strips beside the pipe and drafts the weekly report.'],
  ['API', 'TerraCorridor API - Dashboard feed.json', 'Dashboard feed', 'Joins the Data Tables into the JSON the dashboard reads, one corridor at a time.'],
].map(([k, file, t, d]) => {
  const w = json('workflows/' + file);
  const nodes = w.nodes.filter((n) => short(n.type) !== 'stickyNote').map((n) => ({ n: n.name, t: short(n.type), x: n.position[0], y: n.position[1], s: summary(n) }));
  const edges = []; for (const [from, c] of Object.entries(w.connections)) for (const br of c.main || []) for (const e of br || []) edges.push([from, e.node]);
  return { k, file, t, d, name: w.name, nodes, edges, order: order(w).filter((n) => nodes.some((x) => x.n === n)), sample: SAMPLES[k] };
});
const DATA = { corridors, flow: FLOW, builtAt: new Date().toISOString().slice(0, 10) };

const HERO = `<svg viewBox="0 0 800 360" role="img" aria-label="Illustration: a pipeline crossing hills and a river under rain, with solar panels and a wind turbine on flat land beside it" style="width:100%;height:auto;display:block">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141814"/><stop offset="1" stop-color="#0a0b0a"/></linearGradient>
<linearGradient id="h1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f2a1f"/><stop offset="1" stop-color="#121612"/></linearGradient>
<linearGradient id="h2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a362a"/><stop offset="1" stop-color="#161b16"/></linearGradient></defs>
<rect width="800" height="360" fill="url(#sky)"/>
<path d="M0 210 L90 150 L170 190 L260 120 L350 185 L430 140 L520 200 L800 200 L800 360 L0 360Z" fill="url(#h1)"/>
<path d="M0 260 Q120 200 230 240 T470 245 T800 250 L800 360 L0 360Z" fill="url(#h2)"/>
<g class="rain" stroke="#82c8ff" stroke-width="1.6" stroke-linecap="round" opacity=".7">${Array.from({ length: 22 }, (_, i) => `<line x1="${150 + (i % 11) * 12}" y1="${70 + Math.floor(i / 11) * 22}" x2="${144 + (i % 11) * 12}" y2="${84 + Math.floor(i / 11) * 22}" style="animation-delay:${(i % 7) * 0.15}s"/>`).join('')}</g>
<path d="M140 70 q10 -26 40 -20 q14 -24 44 -10 q30 -6 34 22 q20 4 14 22 h-138 q-14 -6 6 -14z" fill="#2a2f2a" stroke="#3a403a"/>
<path d="M330 360 Q350 300 395 268 Q430 245 470 252" fill="none" stroke="#2f6d9e" stroke-width="16" opacity=".55"/>
<path d="M0 238 C90 230 150 212 205 222 S330 270 400 262 S560 238 800 244" fill="none" stroke="#eceee6" stroke-width="5" stroke-linecap="round"/>
<path d="M150 214 C175 214 190 218 205 222 S250 236 262 242" fill="none" stroke="#ff5d4f" stroke-width="7" stroke-linecap="round"/>
<path d="M372 262 C390 264 405 262 420 260" fill="none" stroke="#f2a93b" stroke-width="7" stroke-linecap="round"/>
<circle cx="205" cy="222" r="9" fill="none" stroke="#ff5d4f" stroke-width="2"><animate attributeName="r" values="9;18;9" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0;1" dur="2.4s" repeatCount="indefinite"/></circle>
<g transform="translate(560 262)">${Array.from({ length: 4 }, (_, i) => `<g transform="translate(${i * 44} ${i % 2 ? 4 : 0})"><path d="M0 18 L34 6 L40 18 L6 30Z" fill="#d6f35f" opacity=".85"/><line x1="20" y1="26" x2="20" y2="38" stroke="#7a7f75" stroke-width="2"/></g>`).join('')}</g>
<g transform="translate(720 120)"><line x1="0" y1="0" x2="0" y2="124" stroke="#b9a4ff" stroke-width="4"/><g class="blades"><path d="M0 0 L-6 -52 L0 -58 L6 -52Z M0 0 L48 22 L48 30 L42 30Z M0 0 L-44 30 L-48 26 L-42 20Z" fill="#b9a4ff"/><circle r="5" fill="#eceee6"/></g></g>
<text x="20" y="342" fill="#7a7f75" font-family="ui-monospace,Consolas,monospace" font-size="11">Illustration. Red: inspect first. Amber: plan a visit. Lime and violet: land that could host solar or wind.</text></svg>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TerraCorridor · demo</title>
<style>
:root{--bg:#0a0b0a;--s1:#101210;--s2:#161916;--s3:#1d211d;--line:#252925;--line-2:#323732;--ink:#eceee6;--ink-2:#a5aa9f;--ink-3:#7a7f75;--green:#6fd08f;--amber:#f2a93b;--red:#ff5d4f;--grey:#5d625a;--build:#d6f35f;--sub:#82c8ff;--wind:#b9a4ff;
--sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--mono:ui-monospace,'Cascadia Mono',Consolas,monospace;--serif:Georgia,'Times New Roman',serif;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans);overflow:hidden}a{color:inherit}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:4px}.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
#deck{position:fixed;inset:0 0 56px 0}
.slide{position:absolute;inset:0;overflow:auto;padding:48px max(28px,6vw) 40px;opacity:0;visibility:hidden;transform:translateX(24px);transition:opacity .35s cubic-bezier(.2,.7,.1,1),transform .35s cubic-bezier(.2,.7,.1,1),visibility 0s .35s}
.slide.on{opacity:1;visibility:visible;transform:none;transition-delay:0s}
.slide{display:flex}.wrap{max-width:1180px;width:100%;margin:auto}
.eyebrow{font:500 11px/1.2 var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--ink-3);margin:0 0 12px}
h1{font:600 clamp(28px,4.2vw,48px)/1.12 var(--sans);letter-spacing:-.025em;margin:0 0 14px;max-width:22ch}
h1 em{font:italic 400 1.1em/1 var(--serif);letter-spacing:0}
h2{font:600 19px/1.3 var(--sans);margin:26px 0 10px}
.lead{font-size:clamp(16px,1.6vw,19px);color:var(--ink-2);max-width:62ch;margin:0 0 24px}
.grid{display:grid;gap:16px}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:36px;align-items:center}
.card{background:var(--s1);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.card .v{font:500 30px/1.1 var(--mono);letter-spacing:-.03em;margin:6px 0}.card p{margin:4px 0 0;color:var(--ink-2);font-size:14.5px}
.btn{background:var(--ink);color:var(--s1);border:0;border-radius:8px;padding:10px 16px;font:600 14.5px var(--sans);cursor:pointer;text-decoration:none;display:inline-block}
.btn.o{background:none;color:var(--ink);border:1px solid var(--line-2)}
.seg{display:inline-flex;border:1px solid var(--line-2);border-radius:8px;overflow:hidden}.seg button{background:none;border:0;color:var(--ink-2);padding:7px 13px;cursor:pointer;font:inherit;font-size:14px}.seg button[aria-pressed=true]{background:var(--s3);color:var(--ink)}
.note{border-left:2px solid var(--line-2);padding-left:12px;color:var(--ink-2);font-size:14px;margin:16px 0;max-width:80ch}
.tag{display:inline-block;font:500 11px/1 var(--mono);border:1px solid var(--line-2);border-radius:999px;padding:4px 8px;color:var(--ink-2);margin-right:6px}
footer{position:fixed;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;gap:14px;padding:0 20px;background:var(--s1);border-top:1px solid var(--line);z-index:5}
footer .mark{font:600 15px var(--sans)}footer .mark em{font:italic 400 19px var(--serif)}
#bar{position:absolute;left:0;top:-2px;height:2px;background:var(--ink);transition:width .35s}
#dots{display:flex;gap:6px;flex:1;justify-content:center;flex-wrap:wrap}#dots button{width:9px;height:9px;border-radius:50%;border:0;background:var(--line-2);cursor:pointer;padding:0}#dots button[aria-current=true]{background:var(--ink)}
.navb{background:var(--s2);border:1px solid var(--line-2);color:var(--ink);border-radius:8px;width:40px;height:36px;cursor:pointer;font-size:16px}
.map{background:#0e120e;border:1px solid var(--line);border-radius:12px;overflow:hidden;position:relative}
.map svg{display:block;width:100%;height:auto;max-height:54vh}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--ink-2);margin-top:10px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.tip{position:absolute;pointer-events:none;background:rgba(16,18,16,.96);border:1px solid var(--line-2);border-radius:8px;padding:6px 9px;font-size:12.5px;display:none;white-space:nowrap}
.loop{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:stretch;margin-top:8px}
.loop .st{background:var(--s1);border:1px solid var(--line);border-radius:12px;padding:14px;position:relative}.loop .st b{display:block;margin:6px 0 2px}.loop .st p{margin:0;color:var(--ink-2);font-size:13.5px}
.loop .st:not(:last-child)::after{content:'→';position:absolute;right:-13px;top:42%;color:var(--ink-3);font-size:18px}
.ico{width:34px;height:34px}
.wf{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px}.wf>*,.split>*,.grid>*{min-width:0}
.tabsr{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.tabsr button{background:var(--s1);border:1px solid var(--line-2);color:var(--ink-2);border-radius:999px;padding:6px 12px;cursor:pointer;font:500 13.5px var(--sans)}.tabsr button[aria-pressed=true]{background:var(--ink);color:var(--s1);border-color:var(--ink)}
.canvas{background:#0d0f0d radial-gradient(#252925 1px,transparent 1px) 0 0/18px 18px;border:1px solid var(--line);border-radius:12px;overflow:auto;max-height:58vh;min-height:260px}
.canvas svg{display:block}
.nd rect{fill:#1a1d1a;stroke:#3a403a;stroke-width:1.5;transition:fill .25s,stroke .25s}.nd text{fill:#eceee6;font:500 12px var(--sans)}.nd .ty{fill:#7a7f75;font:10px var(--mono)}
.nd{cursor:pointer}.nd.run rect{stroke:#f2a93b;fill:#2a2412}.nd.done rect{stroke:#6fd08f}.nd.sel rect{stroke:#eceee6;stroke-width:2.5}
.nd .ok{opacity:0}.nd.done .ok{opacity:1}
.ed{fill:none;stroke:#3a403a;stroke-width:1.6}.ed.done{stroke:#6fd08f}
.side{background:var(--s1);border:1px solid var(--line);border-radius:12px;padding:16px;max-height:58vh;overflow:auto}
pre{font:12px/1.5 var(--mono);background:var(--s2);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;margin:8px 0 0;color:#cfd3c8}
.log{font:12px/1.6 var(--mono);color:var(--ink-2);margin-top:10px;max-height:120px;overflow:auto}
.wo{font:13px/1.6 var(--mono);background:var(--s2);border:1px solid var(--line-2);border-radius:10px;padding:14px;white-space:pre-wrap;min-height:150px}
table{border-collapse:collapse;width:100%;font-size:14.5px}td,th{border-bottom:1px solid var(--line);padding:9px 6px;text-align:left;vertical-align:top}th{color:var(--ink-3);font-weight:500}
.ok-t{color:var(--green)}.todo{color:var(--amber)}
input[type=range]{width:100%;accent-color:#eceee6}
.rain line{animation:fall 1.1s linear infinite}@keyframes fall{from{transform:translateY(-6px);opacity:0}30%{opacity:1}to{transform:translateY(22px);opacity:0}}
.blades{animation:spin 6s linear infinite;transform-origin:0 0}@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:900px){body{overflow:auto}.split,.wf,.g3,.g2{grid-template-columns:1fr}.loop{grid-template-columns:1fr 1fr}.loop .st::after{display:none}.slide{padding:28px 18px 30px}}
@media (max-width:560px){#dots{display:none}footer .mark{display:none}footer{justify-content:space-between}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div id="deck"></div>
<footer><div id="bar"></div><span class="mark">Terra<em>Corridor</em></span><button class="navb" id="prev" aria-label="Previous slide">←</button><div id="dots" role="tablist" aria-label="Slides"></div><button class="navb" id="next" aria-label="Next slide">→</button><span class="num" id="cnt" style="color:var(--ink-3);font-size:13px;min-width:48px;text-align:right"></span></footer>
<script>
const D=${JSON.stringify(DATA).replace(/</g, '\\u003c')};
const HERO=${JSON.stringify(HERO)};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,d=0)=>v==null||!isFinite(v)?'n/a':Number(v).toLocaleString('en-CA',{maximumFractionDigits:d,minimumFractionDigits:d});
const money=v=>v==null||!isFinite(v)?'n/a':(Math.abs(v)>=1e6?'$'+fmt(v/1e6,1)+'M':'$'+fmt(v/1e3,0)+'k');
const RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
const TC={High:'#ff5d4f',Medium:'#f2a93b',Low:'#6fd08f','Missing data':'#5d625a'};
const E=D.corridors[0],B=D.corridors[1];
const ICON={data:'<svg class="ico" viewBox="0 0 34 34"><ellipse cx="17" cy="8" rx="11" ry="4" fill="none" stroke="#82c8ff" stroke-width="2"/><path d="M6 8v18c0 2 5 4 11 4s11-2 11-4V8M6 17c0 2 5 4 11 4s11-2 11-4" fill="none" stroke="#82c8ff" stroke-width="2"/></svg>',
 n8n:'<svg class="ico" viewBox="0 0 34 34"><circle cx="7" cy="17" r="4" fill="none" stroke="#eceee6" stroke-width="2"/><circle cx="27" cy="9" r="4" fill="none" stroke="#eceee6" stroke-width="2"/><circle cx="27" cy="25" r="4" fill="none" stroke="#eceee6" stroke-width="2"/><path d="M11 16l12-6M11 18l12 6" stroke="#eceee6" stroke-width="2"/></svg>',
 score:'<svg class="ico" viewBox="0 0 34 34"><rect x="5" y="20" width="5" height="9" fill="#6fd08f"/><rect x="14" y="13" width="5" height="16" fill="#f2a93b"/><rect x="23" y="6" width="5" height="23" fill="#ff5d4f"/></svg>',
 person:'<svg class="ico" viewBox="0 0 34 34"><circle cx="17" cy="11" r="6" fill="none" stroke="#eceee6" stroke-width="2"/><path d="M6 30c1-7 6-10 11-10s10 3 11 10" fill="none" stroke="#eceee6" stroke-width="2"/></svg>',
 crew:'<svg class="ico" viewBox="0 0 34 34"><path d="M4 22h18v-8h6l3 5v3h-3" fill="none" stroke="#f2a93b" stroke-width="2"/><circle cx="9" cy="24" r="3" fill="#f2a93b"/><circle cx="25" cy="24" r="3" fill="#f2a93b"/></svg>'};

// ---------- map drawing from real geometry
function proj(c,W,bb){const [x0,y0,x1,y1]=bb||c.bbox,k=Math.cos((y0+y1)/2*Math.PI/180),w=(x1-x0)*k,h=(y1-y0),H=440,sc=Math.min(W/w,H/h),ox=(W-w*sc)/2,oy=(H-h*sc)/2;return {W,H,p:([x,y])=>[ox+(x-x0)*k*sc,oy+(y1-y)*sc],kmPx:sc/111.32}}
function routeMap(c,win,opts={}){const P=proj(c,620,opts.renew?null:c.rbox);let s='<svg viewBox="0 0 '+P.W+' '+fmt(P.H,0).replace(/,/g,'')+'" role="img" aria-label="Map of the '+esc(c.name)+' route">';
 if(opts.renew){for(const q of c.polys){const col=q.status==='excluded'||q.status==='incomplete'?'#5d625a':q.tech==='solar'?'#d6f35f':'#b9a4ff';const op=q.status==='excluded'||q.status==='incomplete'?.15:(q.tech==='wind'?.08:.25)+(q.tech==='wind'?.3:.55)*(q.score||0)/100;
  for(const r of q.rings)s+='<polygon data-tip="'+esc((q.tech==='solar'?'Solar':'Wind')+' · km '+q.km+' '+(q.side==='L'?'left':'right')+' · '+(q.status==='excluded'?'ruled out':q.status)+(q.score!=null?' · '+q.score:''))+'" points="'+r.map(P.p).map(a=>a.map(v=>v.toFixed(1)).join(',')).join(' ')+'" fill="'+col+'" fill-opacity="'+op.toFixed(2)+'" stroke="'+col+'" stroke-opacity=".6" stroke-width=".6"/>'}
  for(const st of c.stations){const [x,y]=P.p(st);s+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="4.5" fill="#82c8ff" data-tip="Mapped substation (CanVec)"/>'}}
 for(const g of c.segs){const pts=g.line.map(P.p).map(a=>a.map(v=>v.toFixed(1)).join(',')).join(' ');const col=opts.renew?'#eceee6':TC[g[win].t];
  s+='<polyline points="'+pts+'" fill="none" stroke="#0a0b0a" stroke-width="'+(opts.renew?5:11)+'" stroke-linecap="round"/><polyline class="sg" data-tip="'+esc('km '+g.km+' · '+g[win].t+(g[win].s!=null?' · score '+g[win].s:'')+(g[win].h?' · worst: '+g[win].h:''))+'" points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="'+(opts.renew?2.5:7)+'" stroke-linecap="round"/>';
  if(g.crossing&&!opts.renew){const [x,y]=P.p(g.line[0]);s+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="4" fill="#5aa9ff" stroke="#0a0b0a" data-tip="River or stream crossing"/>'}}
 const sb=P.kmPx*(c.km>15?2:1);s+='<g transform="translate(16 '+(P.H-18).toFixed(0)+')"><rect width="'+sb.toFixed(1)+'" height="4" fill="#eceee6"/><text y="-6" fill="#a5aa9f" font-size="11" font-family="ui-monospace,Consolas,monospace">'+(c.km>15?2:1)+' km</text></g><g transform="translate('+(P.W-24)+' 30)"><path d="M0 -14 L6 4 L0 0 L-6 4Z" fill="#eceee6"/><text y="18" text-anchor="middle" fill="#a5aa9f" font-size="11">N</text></g></svg>';return s}
function hookTips(el){const tip=el.querySelector('.tip');el.querySelectorAll('[data-tip]').forEach(n=>{n.addEventListener('mousemove',e=>{const r=el.getBoundingClientRect();tip.style.display='block';tip.textContent=n.dataset.tip;tip.style.left=Math.min(e.clientX-r.left+12,r.width-220)+'px';tip.style.top=(e.clientY-r.top+12)+'px'});n.addEventListener('mouseleave',()=>tip.style.display='none')})}
const tierLine=t=>Object.entries(t).sort((a,b)=>['High','Medium','Low','Missing data'].indexOf(a[0])-['High','Medium','Low','Missing data'].indexOf(b[0])).map(([k,v])=>'<span class="tag" style="border-color:'+TC[k]+'55;color:'+TC[k]+'">'+v+' '+k+'</span>').join('');

// ---------- n8n canvas replay
function canvas(f){const xs=f.nodes.map(n=>n.x),ys=f.nodes.map(n=>n.y),x0=Math.min(...xs)-30,y0=Math.min(...ys)-40,W=Math.max(...xs)-x0+230,H=Math.max(...ys)-y0+90;
 const at=n=>f.nodes.find(x=>x.n===n);let s='<svg width="'+Math.max(W*0.82,560)+'" viewBox="'+x0+' '+y0+' '+W+' '+H+'">';
 f.edges.forEach(([a,b],i)=>{const A=at(a),Bn=at(b);if(!A||!Bn)return;const ax=A.x+180,ay=A.y+24,bx=Bn.x,by=Bn.y+24,m=Math.max(40,(bx-ax)/2);s+='<path class="ed" data-e="'+i+'" d="M'+ax+' '+ay+' C'+(ax+m)+' '+ay+' '+(bx-m)+' '+by+' '+bx+' '+by+'"/>'});
 f.nodes.forEach((n,i)=>{s+='<g class="nd" data-n="'+i+'" tabindex="0" role="button" aria-label="'+esc(n.n)+'" transform="translate('+n.x+' '+n.y+')"><rect width="180" height="48" rx="9"/><text x="12" y="20">'+esc(n.n.length>24?n.n.slice(0,23)+'…':n.n)+'</text><text class="ty" x="12" y="37">'+esc(n.t)+'</text><circle class="ok" cx="166" cy="14" r="5" fill="#6fd08f"/></g>'});
 return s+'</svg>'}

const SL=[
{t:'Title',h:()=>\`<div class="wrap split"><div><p class="eyebrow">UBC eProjects × n8n LOOP buildathon</p><h1>Terra<em>Corridor</em></h1>
<p class="lead">Send pipeline inspection crews where the climate is getting worse first. Then check whether the land next to the pipe could earn money from solar or wind.</p>
<p class="lead" style="color:var(--ink)"><b>AI explains. Rules decide. People approve.</b></p>
<p><button class="btn" onclick="go(1)">Start →</button> <span style="color:var(--ink-3);font-size:13px;margin-left:8px">Use ← → or the dots below</span></p></div><div class="map">\${HERO}</div></div>\`},
{t:'Problem',h:()=>\`<div class="wrap"><p class="eyebrow">The problem</p><h1>Pipelines get inspected on a schedule. Floods and landslides don't follow it.</h1>
<p class="lead">Every kilometre gets the same visit cycle, even though a few of them carry most of the risk. And the land beside the pipe earns nothing.</p>
<div class="grid g3"><div class="card"><p class="eyebrow">Nov 2021 · B.C.</p><div class="v">3 weeks</div><p>Floods and mudslides shut Trans Mountain, the longest shutdown in its history. B.C. rationed fuel. <a href="https://www.cbc.ca/lite/story/1.6274482">CBC</a></p></div>
<div class="card"><p class="eyebrow">Jun 2012 · Alberta</p><div class="v">1 river crossing</div><p>High water on the Red Deer River broke a pipeline crossing. The regulator said it wasn't inspected often enough. <a href="https://globalnews.ca/news/1187196/alberta-regulator-criticizes-pipeline-company-for-2012-oil-leak">Global News</a></p></div>
<div class="card"><p class="eyebrow">Canada's climate report</p><div class="v">More extreme rain</div><p>Days of extreme rain are expected to increase, with high confidence. <a href="https://changingclimate.ca/CCCR2019/chapter/4-0/">CCCR 2019, ch. 4</a></p></div></div>
<p class="note">Who uses TerraCorridor: the integrity manager and the person who books crews. The question it answers: with this year's budget, which kilometres do we visit first?</p></div>\`},
{t:'How it works',h:()=>\`<div class="wrap"><p class="eyebrow">How it works</p><h1>One loop, run by n8n every week</h1>
<div class="loop"><div class="st">\${ICON.data}<b>Public data</b><p>30 years of weather, three climate models, satellite plant cover, slope, rivers.</p></div>
<div class="st">\${ICON.n8n}<b>n8n pulls and scores</b><p>Four hazard scores per kilometre, for 2026–30 and 2031–35. Every source is hashed.</p></div>
<div class="st">\${ICON.score}<b>Ranked list</b><p>Each kilometre takes its worst hazard. AI explains it in plain words, using only the numbers.</p></div>
<div class="st">\${ICON.person}<b>A person decides</b><p>Approve, reject or override with a reason. Nothing is automatic.</p></div>
<div class="st">\${ICON.crew}<b>Work order</b><p>Saved in n8n with a due date and a checklist, then exported for the crew.</p></div></div>
<h2>The four hazards</h2><div class="grid g3" style="grid-template-columns:repeat(4,minmax(0,1fr))">
<div class="card"><b>Ground failure</b><p>Heavy rain, freeze-thaw, soaked soil, plant loss, slope.</p></div><div class="card"><b>River crossings</b><p>Only where the pipe crosses water: river size, past peak flow, rain change.</p></div>
<div class="card"><b>Wildfire weather</b><p>Hot, dry, rainless days and fuel.</p></div><div class="card"><b>Drought</b><p>Dry-soil days and the longest dry spell each year.</p></div></div></div>\`},
{t:'Two real routes',h:()=>\`<div class="wrap"><p class="eyebrow">Results on real routes</p><h1>Same rules, two very different pipelines</h1>
<p class="lead">Mapped routes from OpenStreetMap, scored from saved runs. Hover a kilometre for its score. Switch the window to watch the climate shift.</p>
<div class="seg" role="group" aria-label="Climate window" id="winSeg"><button aria-pressed="true" data-w="y5">2026–30</button><button aria-pressed="false" data-w="y10">2031–35</button></div>
<div class="grid g2" style="margin-top:14px">\${D.corridors.map(c=>\`<div><div class="map" id="m-\${c.id}"><div class="tip"></div></div><p style="margin:10px 0 4px"><b>\${esc(c.name)}</b> <span style="color:var(--ink-2)">· \${fmt(c.km,1)} km · \${c.segs.length} segments · \${c.crossings} cross water</span></p><div id="t-\${c.id}"></div></div>\`).join('')}</div>
<div class="legend"><span><i style="background:#ff5d4f"></i>High: inspect first</span><span><i style="background:#f2a93b"></i>Medium: plan a visit</span><span><i style="background:#6fd08f"></i>Low: normal cycle</span><span><i style="background:#5aa9ff;border-radius:50%"></i>Water crossing</span></div>
<p class="note">Coquihalla's worst kilometre in 2031–35 is km \${esc(B.top.km)}: score \${fmt(B.top.score,1)}, driven by its \${esc(B.top.hazard)}. The windows are five-year averages of how often risky weather happens, not forecasts.</p></div>\`,
 init:()=>{const draw=w=>{for(const c of D.corridors){const el=document.getElementById('m-'+c.id);el.innerHTML='<div class="tip"></div>'+routeMap(c,w);hookTips(el);document.getElementById('t-'+c.id).innerHTML=tierLine(c[w])}};draw('y5');
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{document.querySelectorAll('#winSeg button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));draw(b.dataset.w)})}},
{t:'n8n workflows',h:()=>\`<div class="wrap"><p class="eyebrow">n8n does the work · \${D.flow.length} workflows · \${D.flow.reduce((t,f)=>t+f.nodes.length,0)} nodes</p><h1>Watch each workflow run</h1>
<p class="lead" style="margin-bottom:14px">Pick a workflow and press Run. The canvas is the real graph from the exported file. Click any node to see what it's set to do.</p>
<div class="tabsr" id="wfTabs">\${D.flow.map((f,i)=>\`<button data-i="\${i}" aria-pressed="\${i===1}">\${esc(f.k)} · \${esc(f.t)}</button>\`).join('')}</div>
<div class="wf"><div><div class="canvas" id="cv"></div><div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap"><button class="btn" id="run">▶ Run</button><button class="btn o" id="reset">Reset</button><span id="wfMeta" style="color:var(--ink-3);font-size:13px"></span></div></div>
<div class="side" id="side"></div></div>
<p class="note">Replay, not a live execution. The nodes, settings and wiring come from the export in <span class="num">workflows/</span>. The sample output is from the saved runs in the repo. Import the exports into n8n to run them for real.</p></div>\`,
 init:()=>{let cur=1,timer=null;const side=document.getElementById('side');
  const sel=(f,i)=>{document.querySelectorAll('.nd').forEach(g=>g.classList.toggle('sel',+g.dataset.n===i));const n=f.nodes[i];side.innerHTML='<p class="eyebrow">Node · '+esc(n.t)+'</p><h2 style="margin-top:0">'+esc(n.n)+'</h2><p style="color:var(--ink-2);font-size:14px">'+esc(n.s)+'</p>'+out(f)};
  const out=(f,done)=>'<p class="eyebrow" style="margin-top:16px">'+(done?'Run finished · sample output':'Sample output')+'</p><p style="color:var(--ink-2);font-size:13.5px;margin:0">'+esc(f.sample.label)+'</p><pre>'+esc(JSON.stringify(f.sample.data,null,2))+'</pre>';
  const show=i=>{cur=i;clearTimeout(timer);const f=D.flow[i];document.querySelectorAll('#wfTabs button').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.i===i)));
   document.getElementById('cv').innerHTML=canvas(f);document.getElementById('wfMeta').textContent=f.nodes.length+' nodes · '+f.edges.length+' connections · '+f.file;
   side.innerHTML='<p class="eyebrow">'+esc(f.k)+'</p><h2 style="margin-top:0">'+esc(f.t)+'</h2><p style="color:var(--ink-2)">'+esc(f.d)+'</p><div class="log" id="log"></div>';
   document.querySelectorAll('.nd').forEach(g=>{g.onclick=()=>sel(f,+g.dataset.n);g.onkeydown=e=>{if(e.key==='Enter')sel(f,+g.dataset.n)}})};
  document.querySelectorAll('#wfTabs button').forEach(b=>b.onclick=()=>show(+b.dataset.i));
  document.getElementById('reset').onclick=()=>show(cur);
  document.getElementById('run').onclick=()=>{show(cur);const f=D.flow[cur],idx=Object.fromEntries(f.nodes.map((n,i)=>[n.n,i]));let k=0;const log=document.getElementById('log');const t0=Date.now();
   const step=()=>{if(k>0){const prev=document.querySelector('.nd[data-n="'+idx[f.order[k-1]]+'"]');prev&&prev.classList.replace('run','done');
     f.edges.forEach(([a,b],ei)=>{if(a===f.order[k-1]){const e=document.querySelector('.ed[data-e="'+ei+'"]');e&&e.classList.add('done')}})}
    if(k>=f.order.length){side.insertAdjacentHTML('beforeend',out(f,true));log.insertAdjacentHTML('beforeend','<div style="color:#6fd08f">✓ '+f.order.length+' nodes, replay finished</div>');return}
    const g=document.querySelector('.nd[data-n="'+idx[f.order[k]]+'"]');if(g){g.classList.add('run');const cv=document.getElementById('cv'),r=g.getBoundingClientRect(),cb=cv.getBoundingClientRect();cv.scrollTo({left:cv.scrollLeft+r.left-cb.left-cb.width/2+r.width/2,top:cv.scrollTop+r.top-cb.top-cb.height/2+r.height/2,behavior:RM?'auto':'smooth'})}
    log.insertAdjacentHTML('beforeend','<div>'+String(k+1).padStart(2,'0')+'  '+esc(f.order[k])+'</div>');log.scrollTop=1e6;k++;timer=setTimeout(step,RM?20:Math.max(60,3000/f.order.length))};step()};
  show(1)}},
{t:'People approve',h:()=>\`<div class="wrap"><p class="eyebrow">Human in the loop</p><h1>Nothing goes to a crew until a person approves it</h1>
<p class="lead">A high score never creates a work order on its own. The daily forecast check can draft one when heavy rain is coming on flagged ground, at most 3 at a time. Try it on Coquihalla's worst kilometre.</p>
<div class="grid g2"><div class="card"><p class="eyebrow">Coquihalla · 2031–35</p><div class="v">km \${esc(B.top.km)}</div><p>Score \${fmt(B.top.score,1)} · worst hazard: \${esc(B.top.hazard)}</p>
<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap"><button class="btn" id="apr">Approve inspection</button><button class="btn o" id="rej">Reject</button><button class="btn o" id="ovr">Override tier</button></div>
<div id="why" hidden style="margin-top:12px"><input id="reason" placeholder="Reason (required)" style="width:100%;padding:9px;background:var(--s2);border:1px solid var(--line-2);border-radius:8px;color:var(--ink);font:inherit"><button class="btn o" id="go" style="margin-top:8px">Save decision</button></div></div>
<div><p class="eyebrow">What WF4 saves in n8n (shown here offline)</p><div class="wo" id="wo">Waiting for a decision.</div></div></div>
<p class="note">On this slide the record is shown locally so the deck works offline. In the live dashboard the same buttons call WF4, and the dashboard says whether you're live or offline.</p></div>\`,
 init:()=>{let mode=null;const due=new Date(Date.now()+14*864e5).toISOString().slice(0,10),wo=document.getElementById('wo');
  const type=async t=>{wo.textContent='';for(const ch of t){wo.textContent+=ch;if(!RM)await new Promise(r=>setTimeout(r,6))}};
  document.getElementById('apr').onclick=()=>{document.getElementById('why').hidden=true;type('POST /webhook/terracorridor/action\\n  action: approve · segment: km '+B.top.km+'\\n\\ncorridor_work_orders\\n  status: approved\\n  priority: P1 · due '+due+'\\n  worst hazard: '+B.top.hazard+'\\n  checklist: from what drives the score\\n\\ncorridor_audit\\n  approve · by integrity manager · '+new Date().toISOString().slice(0,16).replace('T',' '))};
  const ask=m=>{mode=m;document.getElementById('why').hidden=false;document.getElementById('reason').focus()};
  document.getElementById('rej').onclick=()=>ask('reject');document.getElementById('ovr').onclick=()=>ask('override');
  document.getElementById('go').onclick=()=>{const r=document.getElementById('reason').value.trim();if(!r){wo.textContent='A reason is required. WF4 rejects decisions without one.';return}
   type('corridor_audit\\n  '+mode+' · km '+B.top.km+'\\n  reason: '+r+(mode==='override'?'\\n  tier changed, original kept for the record':'\\n  no work order created'))}}},
{t:'Renewables',h:()=>\`<div class="wrap"><p class="eyebrow">The land next to the pipe</p><h1>Where could solar or wind go, and would it pay?</h1>
<div class="split" style="align-items:start"><div><div class="map" id="rmap"><div class="tip"></div></div>
<div class="legend"><span><i style="background:#d6f35f"></i>Solar area</span><span><i style="background:#b9a4ff"></i>Wind area</span><span><i style="background:#5d625a"></i>Ruled out</span><span><i style="background:#82c8ff;border-radius:50%"></i>Mapped substation</span></div>
<p style="color:var(--ink-2);font-size:14px">Edmonton. Brighter means a higher score. Hover an area for details.</p></div>
<div><div class="grid g2"><div class="card"><p class="eyebrow">Solar · Edmonton</p><div class="v" style="color:var(--build)">\${fmt(E.renew.solar.mw,0)} MW</div><p>on land rated strong or moderate</p></div><div class="card"><p class="eyebrow">Wind · Edmonton</p><div class="v" style="color:var(--wind)">\${fmt(E.renew.wind.mw,0)} MW</div><p>\${fmt(E.renew.wind.mw/4.5,0)} turbines of 4.5 MW</p></div></div>
<div class="card" style="margin-top:16px"><label>Power price: <b class="num" id="pv"></b> per MWh</label><input type="range" id="price" min="20" max="200" step="0.01" value="\${E.renew.price}" aria-label="Power price"><div class="grid g2" id="pay" style="margin-top:12px"></div></div>
<p class="note">Starts at Alberta's 2025 average power price ($\${fmt(E.renew.price,2)}, AESO). At that price neither pays back. Coquihalla: every solar strip and most wind areas are ruled out (steep, forested, protected land). Land ownership, grid room and permits aren't checked.</p></div></div></div>\`,
 init:()=>{const el=document.getElementById('rmap');el.innerHTML='<div class="tip"></div>'+routeMap(E,'y10',{renew:true});hookTips(el);
  const upd=()=>{const p=+document.getElementById('price').value;document.getElementById('pv').textContent='$'+fmt(p,2);
   document.getElementById('pay').innerHTML=['solar','wind'].map(t=>{const x=E.renew[t];const rev=x.mwh*p,net=rev-x.opex,pay=net>0?x.capex/net:null;
    return '<div><p class="eyebrow">'+t+'</p><div class="v" style="font-size:24px">'+money(rev)+'</div><p>sales per year<br>payback: <b style="color:'+(pay&&pay<15?'#6fd08f':'#eceee6')+'">'+(pay?fmt(pay,1)+' years':'never')+'</b><br>pays off from about $'+fmt(x.breakEvenPriceCadPerMwh,0)+'/MWh</p></div>'}).join('')};
  document.getElementById('price').oninput=upd;upd()}},
{t:'Checklist',h:()=>\`<div class="wrap"><p class="eyebrow">Buildathon requirements and tracks</p><h1>Submission checklist</h1>
<div class="split" style="align-items:start"><table><tr><th>Requirement</th><th>Status</th></tr>
<tr><td>Demo video, 3 minutes max: problem, solution, working product</td><td class="todo">Record it. Follow these slides in order.</td></tr>
<tr><td>Project link: n8n workflow exports</td><td class="ok-t">In <span class="num">workflows/</span></td></tr>
<tr><td>Summary: problem, how it works, what's next</td><td class="todo">Devpost page</td></tr>
<tr><td>Team and tracks</td><td class="todo">Devpost page</td></tr>
<tr><td>Disclose services, models, templates</td><td class="todo">List on the right. Add the AI model name.</td></tr>
<tr><td>No edits after the deadline</td><td class="todo">Stop before 2:45 PM</td></tr></table>
<div><div class="card"><p class="eyebrow">Tracks</p><p><b style="color:var(--ink)">Overall.</b> Judged on the Devpost page and video.</p><p><b style="color:var(--ink)">n8n Track.</b> n8n has to do real work. Ours runs the schedules, data pulls, scoring, approvals, audit log and dashboard feed.</p><p><b style="color:var(--ink)">Investly Track.</b> The rules don't say what it wants. Ask the delegate; the renewables money slide is the closest fit.</p></div>
<div class="card" style="margin-top:14px"><p class="eyebrow">Judging, 25% each</p><p>Technical depth · Innovation and impact · Design and UX · Demo</p></div>
<div class="card" style="margin-top:14px"><p class="eyebrow">Disclosures</p><p>n8n; Open-Meteo (archive, climate, forecast, flood, elevation); CMIP6 via Open-Meteo; Sentinel-2 (Element84, Copernicus); Copernicus DEM; OpenStreetMap; NASA POWER; Global Wind Atlas; Global Solar Atlas; ESA WorldCover; CPCAD; CanVec; Esri imagery; Leaflet; the AI model used in n8n; Claude for coding help. No pipeline operator is involved.</p></div></div></div></div>\`},
{t:'Close',h:()=>\`<div class="wrap" style="text-align:center;padding-top:6vh"><p class="eyebrow">TerraCorridor</p><h1 style="margin:0 auto 18px;max-width:none">AI explains. Rules decide. <em>People approve.</em></h1>
<p class="lead" style="margin:0 auto 28px">Crews go where the climate is getting worse first. The land beside the pipe gets a fair look for solar and wind, with the money laid out honestly.</p>
<p><a class="btn" href="./">Open the dashboard</a> <a class="btn o" href="./renewables.html">Open the renewables map</a></p>
<p style="color:var(--ink-3);font-size:13px;margin-top:30px">Built \${D.builtAt} from the repo. Works offline. Numbers come from saved runs and public data.</p></div>\`},
];
const deck=document.getElementById('deck'),dots=document.getElementById('dots');let cur=-1;
deck.innerHTML=SL.map((s,i)=>'<section class="slide" data-i="'+i+'" aria-label="'+esc(s.t)+'"></section>').join('');
dots.innerHTML=SL.map((s,i)=>'<button data-i="'+i+'" aria-label="'+esc(s.t)+'" title="'+esc(s.t)+'"></button>').join('');
function go(i){i=Math.max(0,Math.min(SL.length-1,i));if(i===cur)return;cur=i;const secs=deck.querySelectorAll('.slide');secs.forEach(s=>s.classList.toggle('on',+s.dataset.i===i));
 const s=secs[i];s.innerHTML=SL[i].h();s.scrollTop=0;if(SL[i].init)SL[i].init();dots.querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',String(+b.dataset.i===i)));
 document.getElementById('cnt').textContent=(i+1)+' / '+SL.length;document.getElementById('bar').style.width=((i+1)/SL.length*100)+'%';history.replaceState(null,'','#'+(i+1))}
dots.onclick=e=>{const b=e.target.closest('button');if(b)go(+b.dataset.i)};
document.getElementById('prev').onclick=()=>go(cur-1);document.getElementById('next').onclick=()=>go(cur+1);
addEventListener('keydown',e=>{if(/INPUT|TEXTAREA/.test(e.target.tagName))return;if(e.key==='ArrowRight'||e.key==='PageDown'){go(cur+1);e.preventDefault()}if(e.key==='ArrowLeft'||e.key==='PageUp'){go(cur-1);e.preventDefault()}if(e.key==='Home')go(0);if(e.key==='End')go(SL.length-1);if(e.key==='f')document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()});
go((parseInt(location.hash.slice(1))||1)-1);
</script></body></html>`;
for (const p of ['deploy/demo.html', 'dist/demo.html']) fs.writeFileSync(path.join(root, p), html);
console.log('built deploy/demo.html and dist/demo.html', Math.round(html.length / 1024) + ' KB', FLOW.map((f) => f.k + ':' + f.nodes.length).join(' '));
