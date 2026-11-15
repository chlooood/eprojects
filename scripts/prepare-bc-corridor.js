#!/usr/bin/env node
// Rebuild BC table rows, dashboard assessment, and manual seed from cached real inputs. No network.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.join(__dirname,'..'),DIR=path.join(ROOT,'data/corridors/bc-coquihalla');
const read=p=>JSON.parse(fs.readFileSync(path.join(DIR,p),'utf8'));
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const E=require('../src/engine'),{buildCorridor}=require('../src/dashboard-api');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const CID='bc-coquihalla';
function statsProfile(values,lengthM){
 if(!Array.isArray(values)||values.length<2||!values.every(Number.isFinite)||!(lengthM>0))throw Error('Invalid elevation profile');
 const step=lengthM/(values.length-1),grades=values.slice(1).map((v,i)=>100*Math.abs(v-values[i])/step);
 const r=x=>Math.round(x*10)/10;
 return {source:'Copernicus DEM GLO-30 surface elevation',netGradePct:r(100*Math.abs(values.at(-1)-values[0])/lengthM),maxSampleGradePct:r(Math.max(...grades)),reliefM:r(Math.max(...values)-Math.min(...values)),sampleSpacingM:r(step),samples:values.map((e,i)=>({distanceM:r(i*step),elevationM:r(e)}))};
}
function studyGeometry(seg,terrain){
 // Study strips follow the mapped polyline. Each edge has 30–230 m lateral offsets.
 const strips=[];const move=(p,dx,dy)=>[p[0]+dx/(111320*Math.cos(p[1]*Math.PI/180)),p[1]+dy/110540];
 const line=seg.centreline;
 for(let i=1;i<line.length;i++){
  const a=line[i-1],b=line[i],lat=(a[1]+b[1])/2,dx=(b[0]-a[0])*111320*Math.cos(lat*Math.PI/180),dy=(b[1]-a[1])*110540,L=Math.hypot(dx,dy);
  if(!L)continue;const nx=-dy/L,ny=dx/L;
  for(const sign of [-1,1]){const ring=[move(a,nx*30*sign,ny*30*sign),move(b,nx*30*sign,ny*30*sign),move(b,nx*230*sign,ny*230*sign),move(a,nx*230*sign,ny*230*sign)];ring.push(ring[0]);strips.push([ring]);}
 }
 return {type:'FeatureCollection',features:[{type:'Feature',properties:{zone:'centreline',terrain},geometry:{type:'LineString',coordinates:line}},{type:'Feature',properties:{zone:'study_strip',area_method:'sum of per-edge strips, overlaps possible near bends; not parcel area'},geometry:{type:'MultiPolygon',coordinates:strips}}]};
}
async function main(){
 require('child_process').execFileSync(process.execPath,[path.join(ROOT,'scripts/verify-bc-inputs.js')],{stdio:'inherit'});
 const route=read('route.json'),climate=read('climate-cells.json'),elevation=read('elevation.json'),ndvi=read('ndvi.json'),crossings=read('crossings.json'),evidence=read('evidence.json');
 if(route.meta.corridorId!==CID||route.segments.length!==12)throw Error('Unexpected route');
 if(elevation.values.length!==route.segments.length*11||!elevation.values.every(Number.isFinite))throw Error('Incomplete elevation profile');
 const W2=require('../workflows/W2_ Long-Range Engine.json');const cfg=Object.fromEntries(W2.nodes.find(n=>n.name==='W2 Config').parameters.assignments.assignments.filter(a=>typeof a.value!=='string'||!a.value.startsWith('=')).map(a=>[a.name,a.value]));
 cfg.corridor_id=CID;cfg.ndvi_url='https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a';
 const inputSegments=[],elevInputs=[],segmentRows=[];
 // Input timestamps derive from cached measurements, so rebuilding cannot imply a new observation.
 const fetchedAt=route.meta.fetchedAt;
 for(let i=0;i<route.segments.length;i++){
  const s=route.segments[i],values=elevation.values.slice(i*11,i*11+11),terrain=statsProfile(values,s.lengthM),series=ndvi.observations.filter(o=>o.segment_id===s.id&&Number.isFinite(o.mean)).map(o=>({month:o.month,mean:o.mean,valid_frac:o.validFraction}));
  const years={};for(const o of series)(years[o.month.slice(0,4)]||=[]).push(o);
  if(Object.values(years).filter(v=>v.length>=2).length<4)throw Error('Insufficient independent growing seasons: '+s.id);
  const centroid=[(s.centreline[0][0]+s.centreline.at(-1)[0])/2,(s.centreline[0][1]+s.centreline.at(-1)[1])/2];
  const cell=(Math.round(centroid[1]*10)/10).toFixed(2)+'_'+(Math.round(centroid[0]*10)/10).toFixed(2);
  if(!climate.some(c=>c.cell_key===cell))throw Error('Missing climate cell '+cell);
  const xs=crossings.segments[s.id];if(!Array.isArray(xs))throw Error('Crossing evidence missing');
  inputSegments.push({segment_id:s.id,corridor_id:CID,segment_index:i,length_m:s.lengthM,centroid_lat:centroid[1],centroid_lon:centroid[0],cell_key:cell,valid:true,validation_errors:[],elevation_url:elevation.url,segment_source_hash:sha(s.centreline),crossings_json:JSON.stringify(xs.map(x=>({...x,peakFlowM3s:null}))),prior_ndvi_series_json:JSON.stringify(series),prior_ndvi_hash:sha(series),prior_ndvi_source:'earthsearch_c1_sentinel2_cached'});
  const raw=JSON.stringify({elevation:[values[0],values.at(-1)]});elevInputs.push({data:raw,raw_hash:sha(raw)});
  const pts=s.centreline;segmentRows.push({segment_id:s.id,corridor_id:CID,segment_index:i,lat_start:pts[0][1],lon_start:pts[0][0],lat_end:pts.at(-1)[1],lon_end:pts.at(-1)[0],length_m:s.lengthM,polygon_geometry_json:JSON.stringify(studyGeometry(s,terrain)),bbox_south:Math.min(...pts.map(p=>p[1])),bbox_west:Math.min(...pts.map(p=>p[0])),bbox_north:Math.max(...pts.map(p=>p[1])),bbox_east:Math.max(...pts.map(p=>p[0])),status:'active',source_hash:sha(s.centreline),source_kind:'osm_cached_bc',generated_at:fetchedAt});
 }
 const wrap=a=>a.map(json=>({json}));const mocks={'W2 Config':[cfg],'Select Batch Segments':inputSegments,'Hash NDVI':inputSegments.map(()=>({error:{message:'Prepared assessment uses audited Collection-1 observations; no CDSE request made'}})),'Hash Elevation':elevInputs};
 const $=name=>({all:()=>wrap(mocks[name]),first:()=>wrap(mocks[name])[0]});
 const cells=climate.map(c=>({cell_key:c.cell_key,cache_status:'cached',archive:JSON.parse(c.archive_metrics_json),climate:JSON.parse(c.climate_metrics_json),archive_hash:c.archive_hash,climate_hash:c.climate_hash}));
 const scored=(await new AsyncFunction('$','$input',W2.nodes.find(n=>n.name==='Score Segments').parameters.jsCode)($,{all:()=>wrap(cells)})).map(i=>i.json);
 const bad=scored.filter(r=>r.status!=='verified');if(bad.length)throw Error('Unverified: '+bad[0].error_message);
 const now=new Date().toISOString();for(const row of scored){row.computed_at=now;if(row.baseline_row)row.baseline_row.computed_at=now;row.explanation='';}
 const manifest={corridorId:CID,name:'Coquihalla mountain corridor',note:route.meta.note+' Mapped OSM oil-pipeline way 103560579; ownership/alignment not independently verified. One shared climate cell. Discharge excluded: nearest GloFAS point was 2.7 km away and the river match was not verified.',assessmentMethod:'Prepared locally using the unmodified W2 priority formula and thresholds, cached Open-Meteo climate, real Sentinel-2 Collection-1 observations and Copernicus DEM. This is an exposure screening index, not a validated failure probability or reconstruction of the 2021 event.',dataSources:{ndvi:'Copernicus Sentinel-2 Collection 1 via Element84 Earth Search; not CDSE live',terrain:elevation.source},evidence};
 const sources=[{source_hash:sha(manifest),source_url:route.meta.sourceUrl,source_kind:'corridor_manifest',fetched_at:now,corridor_id:CID,batch_status:'prepared_real_data',segment_count:segmentRows.length,error_message:'',fallback_reason:JSON.stringify(manifest)}];
 if(fs.existsSync(path.join(DIR,'forecast-cache.json'))){const weather=read('forecast-cache.json');for(const row of climate){const f=weather.find(x=>x.cell_key===row.cell_key);if(f)Object.assign(row,f);}}
 const tables={segments:segmentRows,baselines:scored.filter(r=>r.baseline_row).map(r=>({...r.baseline_row,crossings_json:inputSegments.find(s=>s.segment_id===r.segment_id).crossings_json})),predictions:scored.map(({baseline_row,source_rows,...r})=>r),build:[],buildConfig:[{corridor_id:CID,config_json:JSON.stringify({buildStripM:60,leaseRatePerAcreYr:400}),saved_at:now,source:'prepared_bc_screening'}],watch:[],workOrders:[],audit:[],sources,climateCells:climate};
 // NASA inputs are optional. Absence leaves solar unverified, never a synthetic estimate.
 if(fs.existsSync(path.join(DIR,'solar.json'))){const solar=read('solar.json');for(const s of segmentRows){const terrain=JSON.parse(s.polygon_geometry_json).features[0].properties.terrain;tables.build.push({segment_id:s.segment_id,corridor_id:CID,irradiance:solar.irradiance,slope_pct:terrain.netGradePct,substation_km:null,data_status:'provisional',data_labels:JSON.stringify({irradiance:solar.url,substation:'not measured'}),calculated_at:now});}}
 const W5=require('../workflows/TerraCorridor W5 - Solar + Storage Build Layer and Weekly Report.json');
 const code=W5.nodes.find(n=>n.name==='Compute Build Layer').parameters.jsCode;
 const {calcBuild,defaults}=new Function(code.slice(0,code.indexOf('// ================== END SHARED PRELUDE'))+'; return {calcBuild,defaults:DEFAULT_CONFIG};')();
 tables.build=tables.build.map(row=>calcBuild({seg:segmentRows.find(s=>s.segment_id===row.segment_id),irradiance:row.irradiance,irrLabel:'cached_nasa_power',slope:row.slope_pct,slopeLabel:'copernicus_dem_glo30',risk10_tier:tables.predictions.find(p=>p.segment_id===row.segment_id&&p.horizon_years===10).tier,riskLabel:'exported_w2_rules',substation_km:null,subLabel:'not_measured',geomLabel:'osm_public_mapping'},{...defaults,buildStripM:60,leaseRatePerAcreYr:400}));
 const assessment=buildCorridor(tables,{corridorId:CID,name:manifest.name,now});Object.assign(assessment.meta,{source:'Prepared real-data assessment',assessmentMethod:manifest.assessmentMethod,evidence,dataSources:manifest.dataSources,snapshot:{savedAt:now,recomputed:true,note:'Computed locally from audited real data using the exported W2 code. Import the BC seed to store it in n8n. Offline approvals are local demonstrations only.'}});
 fs.writeFileSync(path.join(DIR,'tables.json'),JSON.stringify(tables,null,2)+'\n');fs.writeFileSync(path.join(DIR,'assessment.json'),JSON.stringify(assessment)+'\n');
 const summary={corridorId:CID,segments:12,km:12,climateCells:climate.map(c=>c.cell_key),ndviMonths:ndvi.sources.map(s=>s.month),thresholds:{amber:cfg.amber_min,red:cfg.red_above,ratioFull:cfg.ratio_full_score_increase},tiers:{},sourceHashes:{route:sha(route),climate:sha(read('climate-cells.json')),elevation:sha(elevation),ndvi:sha(ndvi),crossings:sha(crossings)}};
 for(const h of ['y5','y10']){summary.tiers[h]={};for(const s of assessment.segments)summary.tiers[h][s.risk[h].tier]=(summary.tiers[h][s.risk[h].tier]||0)+1;}
 fs.writeFileSync(path.join(DIR,'verification.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
module.exports={statsProfile,studyGeometry};
