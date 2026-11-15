// Integrity and coverage audit for the pinned BC inputs. No network calls or table writes.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const D=path.join(__dirname,'../data/corridors/bc-coquihalla'),file=path.join(D,'integrity.json');
const inputNames=['route.json','climate-cells.json','elevation.json','ndvi.json','crossings.json','solar.json','raw/osm-way.json','raw/waterways.json',...fs.readdirSync(path.join(D,'raw')).filter(n=>n.startsWith('ndvi-')).map(n=>'raw/'+n)];
const sums=Object.fromEntries(inputNames.sort().map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(D,n))).digest('hex')]));
if(process.argv.includes('--record')){fs.writeFileSync(file,JSON.stringify({recordedAt:new Date().toISOString(),method:'SHA-256 of cached source records; audit URLs and raster-window hashes are retained separately',files:sums},null,2)+'\n');console.log('Recorded source integrity manifest.');}
else{const expected=JSON.parse(fs.readFileSync(file));for(const [n,sum]of Object.entries(expected.files))if(sums[n]!==sum)throw Error('BC source changed: '+n+'; review the refresh and explicitly record new hashes.');console.log('BC source integrity verified: '+Object.keys(sums).length+' files.');}
