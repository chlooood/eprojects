#!/usr/bin/env node
const fs=require('fs'),path=require('path');
async function main(){
 const u='https://api.open-meteo.com/v1/forecast?latitude=49.4&longitude=-121.3&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,soil_moisture_0_to_7cm_mean&forecast_days=16&timezone=UTC';
 const response=await fetch(u,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Forecast HTTP '+response.status);
 const j=await response.json();if(j.error||j.daily?.time?.length!==16||!j.daily.precipitation_sum.every(Number.isFinite))throw Error('Incomplete daily precipitation');
 fs.writeFileSync(path.join(__dirname,'../data/corridors/bc-coquihalla/forecast-cache.json'),JSON.stringify([{cell_key:'49.40_-121.30',forecast_json:JSON.stringify(j),forecast_fetched_at:new Date().toISOString(),forecast_source_url:u}],null,2)+'\n');
 console.log('BC weather refreshed; regenerate the BC seed and execute it in n8n.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
