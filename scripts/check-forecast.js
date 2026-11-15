// Read-only: runs WF3's actual rule node with the real corridor and downloaded forecasts.
// This verifies rules and data, not the n8n schedule or Wait/resume execution.
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
async function main(){
 const base=process.argv[2] || require('../workflows/wiring.json').apiBase;
 const response=await fetch(base+'/corridor',{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error('feed HTTP '+response.status);
 const feed=await response.json();
 const cache=require('../data/cache/forecasts/latest.json');
 const cells={};
 for(const s of feed.segments){
  const horizons=['y5','y10'].filter(h=>['amber','red','red-uncertain'].includes(s.override?.horizon===Number(h.slice(1))?s.override.tier:s.risk[h].tier));
  if(!horizons.length)continue;
  const h=horizons.includes('y10')?'y10':'y5';
  const a=s.centreline[0],b=s.centreline.at(-1),lat=(a[1]+b[1])/2,lon=(a[0]+b[0])/2;
  const key=(Math.round(lat*10)/10).toFixed(2)+'_'+(Math.round(lon*10)/10).toFixed(2);
  const cell=cells[key] ||= {cell:key,annual:{extreme_mm:s.baseline.extremeMm,soil_wet_threshold:s.baseline.soilWetThreshold},monthly:{},segments:[]};
  cell.segments.push({segment_id:s.id,score:s.risk[h].score,tier:s.risk[h].tier,horizon:h});
 }
 const items=arr=>arr.map(json=>({json}));
 const $=name=>({all:()=>items(name==='Select flagged segments'?Object.values(cells):cache)});
 const workflow=require('../workflows/TerraCorridor WF3 - Near-term watch.json');
 const js=workflow.nodes.find(n=>n.name==='Apply escalation rules').parameters.jsCode;
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const result=(await new AsyncFunction('$','$input',js)($,{all:()=>items(Object.values(cells).map(()=>({error:{message:'exercising the cache fallback'}})))})).map(x=>x.json);
 const report={checkedAt:new Date().toISOString(),kind:'local execution of exported WF3 rule node with real data',liveN8nExecution:false,feedGeneratedAt:feed.meta.generatedAt,results:result};
 fs.mkdirSync(path.join(root,'data/verification'),{recursive:true});fs.writeFileSync(path.join(root,'data/verification/forecast-check.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
