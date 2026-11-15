#!/usr/bin/env node
const fs=require('fs'),path=require('path'),W3=require('../workflows/TerraCorridor WF3 - Near-term watch.json'),t=require('../data/corridors/bc-coquihalla/tables.json');
const cached=require('../data/corridors/bc-coquihalla/forecast-cache.json');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function run(name,mocks,input=[]){const wrap=a=>a.map(json=>({json}));return new AsyncFunction('$','$input',W3.nodes.find(n=>n.name===name).parameters.jsCode)(n=>({all:()=>wrap(mocks[n])}),{all:()=>wrap(input)});}
(async()=>{
 const cells=(await run('Select flagged segments',{'Get predictions':t.predictions,'Get baselines':t.baselines,'Get watch state':[]})).map(i=>i.json);
 const out=(await run('Apply escalation rules',{'Select flagged segments':cells,'Get forecast cache':cached},cells.map(()=>({error:{message:'Read-only cache verification'}})))).map(i=>i.json);
 if(out.some(r=>r.escalate))throw Error('Dry run must not execute WF4');
 const report={checkedAt:new Date().toISOString(),liveN8nExecution:false,method:'Actual exported WF3 rule code, prepared BC baselines and fresh real Open-Meteo forecast; no table writes or WF4 calls',results:out};
 fs.writeFileSync(path.join(__dirname,'../data/corridors/bc-coquihalla/forecast-verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({segments:out.length,state:out[0]?.state,summary:out[0]?.summary,routes:out.map(r=>r.route)},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
