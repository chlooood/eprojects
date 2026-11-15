// Builds deploy/demo.html and dist/demo.html: a self-contained, offline walkthrough for judges.
// Every number is read from the repo at build time (snapshots, workflow exports, renewables inputs). No network.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const R = require('../src/renewables.js');

const tiers = (snap, h) => {
  const c = { High: 0, Medium: 0, Low: 0, 'Missing data': 0 };
  for (const s of snap.segments) { const t = (s.risk && s.risk[h] && s.risk[h].tier) || 'unverified';
    c[t === 'red' || t === 'red-uncertain' ? 'High' : t === 'amber' ? 'Medium' : t === 'green' ? 'Low' : 'Missing data']++; }
  return c;
};
const corridors = [
  { id: 'ab-strathcona-demo', name: 'Edmonton', snap: json('data/snapshot/live-snapshot.json') },
  { id: 'bc-coquihalla', name: 'Coquihalla', snap: json('data/corridors/bc-coquihalla/assessment.json') },
].map((c) => {
  const a = R.assessCorridor(json(`data/renewables/${c.id}/inputs.json`));
  const km = c.snap.segments.reduce((t, s) => t + (s.lengthM || 0), 0) / 1000;
  const crossings = c.snap.segments.filter((s) => Array.isArray(s.crossings) && s.crossings.length).length;
  const top = c.snap.segments.filter((s) => s.risk && s.risk.y10 && s.risk.y10.score != null).sort((x, y) => y.risk.y10.score - x.risk.y10.score)[0];
  return { id: c.id, name: c.name, km: Math.round(km * 10) / 10, segments: c.snap.segments.length, crossings, y5: tiers(c.snap, 'y5'), y10: tiers(c.snap, 'y10'),
    top: top ? { km: `${top.kmFrom}–${top.kmTo}`, score: top.risk.y10.score, hazard: top.risk.y10.hazard || 'ground' } : null,
    renew: { byStatus: a.totals.byStatus, solar: a.pooled.solar, wind: a.pooled.wind, price: a.assumptions.priceCadPerMwh } };
});
const wf = fs.readdirSync(path.join(root, 'workflows')).filter((f) => f.endsWith('.json') && f !== 'wiring.json').map((f) => {
  const w = json('workflows/' + f);
  const trig = w.nodes.filter((n) => /trigger|webhook/i.test(n.type)).map((n) => n.type.split('.').pop().replace('Trigger', '').replace('executeWorkflow', 'called by workflow') + (n.parameters.path ? ' /' + n.parameters.path : ''));
  return { file: f, name: w.name, nodes: w.nodes.length, triggers: [...new Set(trig)] };
});
const DATA = { corridors, workflows: wf, builtAt: new Date().toISOString().slice(0, 10) };

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TerraCorridor · demo walkthrough</title>
<style>
:root{--bg:#0a0b0a;--s1:#101210;--s2:#161916;--s3:#1d211d;--line:#252925;--line-2:#323732;--ink:#eceee6;--ink-2:#a5aa9f;--ink-3:#7a7f75;--green:#6fd08f;--amber:#f2a93b;--red:#ff5d4f;--grey:#5d625a;--build:#d6f35f;--sub:#82c8ff;--wind:#b9a4ff;
--sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;--mono:ui-monospace,'Cascadia Mono',Consolas,monospace;--serif:Georgia,serif;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans)}a{color:inherit}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:4px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
header{position:sticky;top:0;z-index:10;background:var(--s1);border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;padding:10px 20px;flex-wrap:wrap}
.mark{font:600 16px/1 var(--sans)}.mark em{font:italic 400 21px/1 var(--serif)}
nav{display:flex;gap:2px;flex-wrap:wrap}nav button{background:none;border:0;color:var(--ink-2);padding:7px 11px;border-radius:8px;cursor:pointer;font:500 14px var(--sans)}
nav button[aria-current=true]{background:var(--s3);color:var(--ink)}
.pill{font:500 12px var(--sans);border:1px solid var(--line-2);border-radius:999px;padding:5px 10px;color:var(--ink-2)}
main{max-width:1100px;margin:0 auto;padding:32px 20px 80px}
section{display:none}section.on{display:block}
.eyebrow{font:500 10.5px/1.2 var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--ink-3);margin:0 0 8px}
h1{font:600 28px/1.2 var(--sans);letter-spacing:-.02em;margin:0 0 10px}h2{font:600 17px/1.3 var(--sans);margin:28px 0 10px}
p.dek{color:var(--ink-2);max-width:72ch;margin:0 0 20px}
.grid{display:grid;gap:16px}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.card{background:var(--s1);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card .v{font:500 26px/1.1 var(--mono);letter-spacing:-.03em;margin:4px 0}
.card p{margin:4px 0 0;color:var(--ink-2);font-size:13.5px}
.btn{background:var(--ink);color:var(--s1);border:0;border-radius:6px;padding:9px 14px;font:600 14px var(--sans);cursor:pointer}
.btn.o{background:none;color:var(--ink);border:1px solid var(--line-2)}
.flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:10px}
.node{background:var(--s2);border:1px solid var(--line-2);border-radius:10px;padding:12px;cursor:pointer;text-align:left;color:var(--ink);font:inherit;position:relative}
.node[aria-pressed=true]{border-color:var(--ink)}.node.run{animation:pulse 1s ease}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(236,238,230,.5)}100%{box-shadow:0 0 0 12px rgba(236,238,230,0)}}
.node b{display:block;font-size:14px}.node small{color:var(--ink-3);font:11px var(--mono)}
.detail{margin-top:14px}
table{border-collapse:collapse;width:100%;font-size:13.5px}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}th{color:var(--ink-3);font-weight:500}
.ok{color:var(--green)}.part{color:var(--amber)}.no{color:var(--ink-3)}
.strip{display:flex;gap:2px;height:34px;margin:8px 0}.strip i{flex:1;border-radius:2px}
.seg{display:inline-flex;border:1px solid var(--line-2);border-radius:6px;overflow:hidden}.seg button{background:none;border:0;color:var(--ink-2);padding:6px 12px;cursor:pointer;font:inherit}.seg button[aria-pressed=true]{background:var(--s3);color:var(--ink)}
.note{border-left:2px solid var(--line-2);padding-left:12px;color:var(--ink-2);font-size:13.5px;margin:14px 0}
.wo{font-family:var(--mono);font-size:13px;background:var(--s2);border:1px solid var(--line-2);border-radius:8px;padding:12px;white-space:pre-wrap}
input[type=range]{width:100%}
@media (max-width:820px){.g2,.g3,.g4{grid-template-columns:1fr 1fr}h1{font-size:23px}}
@media (max-width:520px){.g2,.g3,.g4{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<header><span class="mark">Terra<em>Corridor</em></span>
<nav id="nav" aria-label="Demo steps"></nav><span style="flex:1"></span><span class="pill">Offline demo · numbers from the repo, built ${DATA.builtAt}</span></header>
<main id="main"></main>
<script>
const D=${JSON.stringify(DATA).replace(/</g, '\\u003c')};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,d=0)=>v==null||!isFinite(v)?'—':Number(v).toLocaleString('en-CA',{maximumFractionDigits:d,minimumFractionDigits:d});
const money=v=>v==null||!isFinite(v)?'—':(Math.abs(v)>=1e6?'$'+fmt(v/1e6,1)+'M':'$'+fmt(v/1e3,0)+'k');
const E=D.corridors[0],B=D.corridors[1];
const STEPS=[
['problem','1 · Problem',()=>\`
<p class="eyebrow">The problem</p><h1>Pipelines are inspected on a calendar. Climate hazards are not.</h1>
<p class="dek">Heavy rain, river flooding, freeze-thaw, wildfire weather and drought already stop pipelines, and Canada's climate report projects more extreme daily rain. Most crews still inspect on fixed cycles, and the land beside the pipe mostly earns nothing.</p>
<div class="grid g3">
<div class="card"><p class="eyebrow">Nov 2021 · B.C.</p><div class="v">3 weeks</div><p>Floods and mudslides shut Trans Mountain, its longest shutdown in its history. <a href="https://www.cbc.ca/lite/story/1.6274482">CBC</a></p></div>
<div class="card"><p class="eyebrow">Jun 2012 · Alberta</p><div class="v">River crossing</div><p>High flow on the Red Deer River broke a pipeline crossing; the regulator found it was not inspected often enough. <a href="https://globalnews.ca/news/1187196/alberta-regulator-criticizes-pipeline-company-for-2012-oil-leak">Global News</a></p></div>
<div class="card"><p class="eyebrow">Projection · Canada</p><div class="v">More extreme rain</div><p>Daily extreme precipitation projected to increase, high confidence. <a href="https://changingclimate.ca/CCCR2019/chapter/4-0/">CCCR 2019, ch. 4</a></p></div></div>
<h2>Who it is for and the decision it changes</h2>
<p class="dek">The integrity manager and the inspection coordinator. With a fixed budget: which kilometres get a crew first, and which stable land beside the pipe could earn something.</p>
<p><button class="btn" onclick="go(1)">See the solution →</button></p>\`],
['solution','2 · Solution',()=>\`
<p class="eyebrow">The solution</p><h1>n8n scores every kilometre for four climate hazards, then a person decides.</h1>
<p class="dek">AI explains. Rules decide. People approve. Two real corridors, scored with the same thresholds:</p>
<div class="grid g2">\${D.corridors.map(c=>\`<div class="card"><p class="eyebrow">\${esc(c.name)} · \${fmt(c.km,1)} km · \${c.segments} segments · \${c.crossings} with a mapped stream crossing</p>
<div class="seg" role="group" aria-label="Window"><button aria-pressed="true" data-c="\${c.id}" data-h="y5">2026–30</button><button aria-pressed="false" data-c="\${c.id}" data-h="y10">2031–35</button></div>
<div class="strip" id="strip-\${c.id}"></div><div id="tiers-\${c.id}" class="num" style="font-size:13px"></div>
\${c.top?\`<p>Highest 2031–35 score: km \${esc(c.top.km)}, \${fmt(c.top.score,1)}, worst hazard \${esc(c.top.hazard)}.</p>\`:''}</div>\`).join('')}</div>
<p class="note">Projected windows are five-year climate-frequency averages from three CMIP6 models, not weather forecasts. A kilometre's level is its worst hazard, never a blend. Missing data shows as missing, never as Low.</p>
<p><button class="btn" onclick="go(2)">How n8n runs it →</button></p>\`,()=>{for(const c of D.corridors)strip(c,'y5');document.querySelectorAll('.seg button[data-h]').forEach(b=>b.onclick=()=>{b.parentNode.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));strip(D.corridors.find(c=>c.id===b.dataset.c),b.dataset.h)})}],
['workflows','3 · Workflows',()=>\`
<p class="eyebrow">n8n does the real work</p><h1>\${D.workflows.length} workflow exports, \${D.workflows.reduce((t,w)=>t+w.nodes,0)} nodes</h1>
<p class="dek">Click a workflow to see its trigger and job, or press Run to step through the weekly loop. This page animates the order of the exported workflows. It does not execute n8n.</p>
<p><button class="btn" id="runBtn">Run the weekly loop</button></p>
<div class="flow" id="flow">\${FLOW.map((f,i)=>\`<button class="node" data-i="\${i}" aria-pressed="false"><small>\${esc(f.k)}</small><b>\${esc(f.t)}</b><small>\${esc(trig(f.file))}</small></button>\`).join('')}</div>
<div class="card detail" id="wfDetail"><p class="muted" style="color:var(--ink-2)">Select a workflow.</p></div>
<h2>All exports in the repo</h2><table><tr><th>Workflow</th><th>Nodes</th><th>Triggers</th></tr>\${D.workflows.map(w=>\`<tr><td>\${esc(w.name)}</td><td class="num">\${w.nodes}</td><td>\${esc(w.triggers.join(', ')||'—')}</td></tr>\`).join('')}</table>\`,()=>{
 const show=i=>{document.querySelectorAll('.node').forEach(n=>n.setAttribute('aria-pressed',String(+n.dataset.i===i)));const f=FLOW[i];document.getElementById('wfDetail').innerHTML=\`<p class="eyebrow">\${esc(f.k)} · \${esc(trig(f.file))}</p><h2 style="margin-top:0">\${esc(f.t)}</h2><p>\${esc(f.d)}</p><p style="color:var(--ink-2);font-size:13.5px">Writes: \${esc(f.w)}</p>\`};
 document.querySelectorAll('.node').forEach(n=>n.onclick=()=>show(+n.dataset.i));
 document.getElementById('runBtn').onclick=async()=>{for(let i=0;i<FLOW.length;i++){const n=document.querySelector('.node[data-i="'+i+'"]');n.classList.remove('run');void n.offsetWidth;n.classList.add('run');show(i);await new Promise(r=>setTimeout(r,matchMedia('(prefers-reduced-motion: reduce)').matches?50:900))}}}],
['approve','4 · People approve',()=>\`
<p class="eyebrow">Human in the loop</p><h1>A person approves every inspection.</h1>
<p class="dek">Long-range tiers never create work orders on their own. WF3 proposes one only when heavy weather is forecast on flagged ground, ships in dry-run, and caps drafts at 3. In the real app, Approve posts to WF4, which stores the work order and the audit row in n8n Data Tables.</p>
<div class="grid g2"><div class="card"><p class="eyebrow">\${esc(B.name)} · highest 2031–35 kilometre</p><div class="v">km \${esc(B.top?B.top.km:'—')}</div><p>Score \${fmt(B.top&&B.top.score,1)} · worst hazard \${esc(B.top&&B.top.hazard)}</p>
<p style="margin-top:12px"><button class="btn" id="apr">Approve inspection</button> <button class="btn o" id="rej">Reject with reason</button></p>
<p id="rejWrap" hidden><input id="reason" placeholder="Reason (required)" style="width:100%;margin-top:8px;padding:7px;background:var(--s2);border:1px solid var(--line-2);border-radius:6px;color:var(--ink)"><button class="btn o" id="rejGo" style="margin-top:6px">Log rejection</button></p></div>
<div class="card"><p class="eyebrow">What n8n records (simulated here)</p><div class="wo" id="wo">Nothing yet. Choose an action.</div></div></div>
<p class="note">This page only simulates the record so it works offline. Live delivery depends on the WF4 and email workflows being imported and credentialed; the dashboard labels which mode it is in.</p>\`,()=>{
 const due=new Date(Date.now()+14*864e5).toISOString().slice(0,10);
 document.getElementById('apr').onclick=()=>{document.getElementById('wo').textContent=\`corridor_work_orders\\n  status: approved (simulated)\\n  corridor: bc-coquihalla, km \${B.top.km}\\n  priority: P1, due by \${due}\\n  worst hazard: \${B.top.hazard}\\n  checklist: built from the score's drivers\\ncorridor_audit\\n  action: approve · actor: integrity manager\`};
 document.getElementById('rej').onclick=()=>{document.getElementById('rejWrap').hidden=false};
 document.getElementById('rejGo').onclick=()=>{const r=document.getElementById('reason').value.trim();document.getElementById('wo').textContent=r?\`corridor_audit\\n  action: reject (simulated)\\n  reason: \${r}\\n  no work order created\`:'A reason is required to reject.'}}],
['renewables','5 · Renewables',()=>\`
<p class="eyebrow">Put the corridor land to work</p><h1>Solar and wind screening beside the pipe, kept apart from risk.</h1>
<p class="dek">The renewables page scores land next to each pipeline on public data: Global Wind Atlas at 100 m, Global Solar Atlas, ESA WorldCover, Copernicus slope, CPCAD protected areas and CanVec substations. Unknown inputs are never treated as zero cost, and nothing is called feasible: land rights, grid capacity and permits are not assessed.</p>
<div class="grid g2">\${D.corridors.map(c=>\`<div class="card"><p class="eyebrow">\${esc(c.name)}</p>
<p>\${Object.entries(c.renew.byStatus).map(([k,v])=>v+' '+k).join(' · ')}</p>
<div class="grid g2" style="margin-top:8px"><div><div class="v" style="color:var(--build)">\${fmt(c.renew.solar.mw,0)} MW</div><p>solar scenario · \${money(c.renew.solar.revenue)}/yr gross</p></div>
<div><div class="v" style="color:var(--wind)">\${fmt(c.renew.wind.mw,0)} MW</div><p>wind scenario · \${money(c.renew.wind.revenue)}/yr gross</p></div></div></div>\`).join('')}</div>
<h2>Does it pay? Drag the price.</h2>
<div class="card"><label>Electricity price for \${esc(E.name)}: <b class="num" id="pv">$\${fmt(E.renew.price,2)}</b>/MWh</label>
<input type="range" id="price" min="20" max="200" step="1" value="\${Math.round(E.renew.price)}" aria-label="Electricity price">
<div class="grid g2" id="payout" style="margin-top:10px"></div></div>
<p class="note">Defaults: AESO 2025 average pool price for Alberta, NREL ATB wind costs, labelled placeholders for the rest. Pooled into one project per technology with one connection to the nearest mapped substation, before land cost. A scenario, not a prediction.</p>
<p><a class="btn o" href="./renewables.html" style="text-decoration:none;display:inline-block">Open the renewables map</a> <a class="btn o" href="./" style="text-decoration:none;display:inline-block">Open the pipeline dashboard</a></p>\`,()=>{
 const upd=()=>{const p=+document.getElementById('price').value;document.getElementById('pv').textContent='$'+fmt(p,2);
  document.getElementById('payout').innerHTML=['solar','wind'].map(t=>{const x=E.renew[t];if(!x||!x.mwh)return '';
   const rev=x.mwh*p*(t==='solar'?1:1),net=rev-x.opex,pay=net>0?x.capex/net:null;
   return \`<div><p class="eyebrow">\${t} · \${fmt(x.mw,0)} MW</p><div class="v">\${money(rev)}</div><p>gross per year · net \${money(net)} · payback \${pay?fmt(pay,1)+' yr':'never'} · break-even about $\${fmt(x.breakEvenPriceCadPerMwh,0)}/MWh</p></div>\`}).join('')};
 document.getElementById('price').oninput=upd;upd()}],
['judging','6 · Requirements',()=>\`
<p class="eyebrow">Buildathon requirements and tracks</p><h1>What judges asked for, and where it is.</h1>
<table><tr><th>Requirement</th><th>Status</th><th>Where</th></tr>
<tr><td>Demo video, 3 minutes max: problem, solution, working product</td><td class="part">Team to record</td><td>Use steps 1 to 5 on this page as the script order</td></tr>
<tr><td>Project link: n8n workflow exports</td><td class="ok">In repo</td><td><span class="num">workflows/</span> (\${D.workflows.length} exports)</td></tr>
<tr><td>Summary: problem, how it works, what's next</td><td class="part">Draft in team brief</td><td>Devpost page</td></tr>
<tr><td>Team members and tracks entered</td><td class="part">Team to fill</td><td>Devpost page</td></tr>
<tr><td>Disclose outside services, models, templates</td><td class="part">List below; add the AI model name</td><td>Devpost page</td></tr>
<tr><td>Built during the event; no edits after the deadline</td><td class="part">Team to confirm</td><td>Stop editing the repo and Devpost before 2:45 PM</td></tr></table>
<h2>Tracks</h2><div class="grid g3">
<div class="card"><p class="eyebrow">Overall</p><p>Judged on the Devpost page and video.</p></div>
<div class="card"><p class="eyebrow">n8n Track</p><p>Requires n8n doing real work: schedules, API calls, hashing, scoring, approvals, audit and the dashboard feed all run in n8n workflows.</p></div>
<div class="card"><p class="eyebrow">Investly Track</p><p>Expectations not stated in the rules; ask the delegate. The renewables money scenarios are the closest fit.</p></div></div>
<h2>Judging criteria, 25% each</h2><table>
<tr><td>Technical depth and execution</td><td>Four-hazard engine, delta-method CMIP6 projections, fail-closed data, source hashes, tests</td></tr>
<tr><td>Innovation and impact</td><td>Inspection priority by projected hazard frequency, plus renewables screening on corridor land</td></tr>
<tr><td>Design and UX</td><td>Map-first dashboard, plain-language explanations, mobile layout, offline mode</td></tr>
<tr><td>Demo</td><td>This walkthrough, then the live dashboard</td></tr></table>
<h2>Disclosures</h2><p class="dek">n8n; Open-Meteo archive, climate, forecast, flood and elevation APIs; CMIP6 HighResMIP via Open-Meteo; Sentinel-2 via Element84 Earth Search and Copernicus; Copernicus DEM; OpenStreetMap; NASA POWER; Global Wind Atlas; Global Solar Atlas (Solargis); ESA WorldCover; CPCAD (ECCC); CanVec (NRCan); Esri World Imagery; Leaflet; AI model used in n8n (add its name); Claude for coding help. No operator is involved or endorses this.</p>\`],
];
const FLOW=[
{k:'W1',file:'W1_ Corridor Setup.json',t:'Corridor setup',d:'Pulls the mapped pipeline route and cuts it into 1 km segments with a 30 m exclusion band and a study strip.',w:'corridor_segments'},
{k:'W2',file:'W2_ Long-Range Engine.json',t:'Long-range engine',d:'30-year baseline, three CMIP6 models for 2026–30 and 2031–35, Sentinel-2 NDVI and slope. Scores ground failure, river crossing, wildfire weather and drought; AI explains flagged kilometres using only the computed numbers.',w:'corridor_baselines, corridor_predictions'},
{k:'WF3',file:'TerraCorridor WF3 - Near-term watch.json',t:'Near-term watch',d:'16-day forecast on flagged ground. Proposes at most 3 work orders and ships in dry-run.',w:'corridor_watch'},
{k:'WF4',file:'TerraCorridor WF4 - Work orders and approvals.json',t:'Work orders and approvals',d:'Receives the dashboard Approve/Reject/Override, validates it, stores the work order and the audit row.',w:'corridor_work_orders, corridor_audit'},
{k:'Email',file:'TerraCorridor Email - Approved inspection handoff.json',t:'Inspection handoff',d:'Queues approved inspections for email once SMTP is configured; records the delivery state.',w:'corridor_work_orders (delivery state)'},
{k:'W5',file:'TerraCorridor W5 - Solar + Storage Build Layer and Weekly Report.json',t:'Build layer and weekly report',d:'Solar plus storage on stable strips outside the 30 m band, and the weekly report draft.',w:'corridor_build, corridor_reports'},
{k:'API',file:'TerraCorridor API - Dashboard feed.json',t:'Dashboard feed',d:'GET webhook that joins the Data Tables into the JSON the dashboard reads, per corridor.',w:'read only'}];
const trig=f=>{const w=D.workflows.find(x=>x.file===f);return w?w.triggers.join(', ')+' · '+w.nodes+' nodes':'not in repo'};
const COL={High:'#ff5d4f',Medium:'#f2a93b',Low:'#6fd08f','Missing data':'#5d625a'};
function strip(c,h){const t=c[h];const el=document.getElementById('strip-'+c.id);el.innerHTML='';for(const k of ['High','Medium','Low','Missing data'])for(let i=0;i<t[k];i++){const x=document.createElement('i');x.style.background=COL[k];x.title=k;el.appendChild(x)}
 document.getElementById('tiers-'+c.id).textContent=Object.entries(t).filter(([,v])=>v).map(([k,v])=>v+' '+k).join(' · ')}
const nav=document.getElementById('nav'),main=document.getElementById('main');
nav.innerHTML=STEPS.map((s,i)=>'<button data-i="'+i+'">'+esc(s[1])+'</button>').join('');
function go(i){i=Math.max(0,Math.min(STEPS.length-1,i));nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',String(+b.dataset.i===i)));main.innerHTML='<section class="on">'+STEPS[i][2]()+'</section>';if(STEPS[i][3])STEPS[i][3]();history.replaceState(null,'','#'+STEPS[i][0]);scrollTo(0,0)}
nav.onclick=e=>{const b=e.target.closest('button');if(b)go(+b.dataset.i)};
addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;const c=+nav.querySelector('[aria-current=true]').dataset.i;if(e.key==='ArrowRight')go(c+1);if(e.key==='ArrowLeft')go(c-1)});
go(Math.max(0,STEPS.findIndex(s=>s[0]===location.hash.slice(1))));
</script></body></html>`;
fs.writeFileSync(path.join(root, 'deploy/demo.html'), html);
fs.writeFileSync(path.join(root, 'dist/demo.html'), html);
console.log('built deploy/demo.html and dist/demo.html', JSON.stringify(corridors.map((c) => [c.name, c.y5, c.y10, c.top])));
