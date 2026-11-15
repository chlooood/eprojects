#!/usr/bin/env python3
"""Refresh the 132 BC surface-elevation samples from the public Copernicus GLO-30 COG."""
import os,ssl,json,hashlib
from pathlib import Path
from datetime import datetime,timezone
import fsspec,rasterio
D=Path(__file__).resolve().parents[1]/'data/corridors/bc-coquihalla'
ctx=ssl.create_default_context()
if os.environ.get('NODE_EXTRA_CA_CERTS'):ctx.load_verify_locations(os.environ['NODE_EXTRA_CA_CERTS'])
remote=fsspec.filesystem('http',client_kwargs={'trust_env':True},ssl=ctx,block_size=1024*1024)
u='https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_10_N49_00_W122_00_DEM/Copernicus_DSM_COG_10_N49_00_W122_00_DEM.tif'
route=json.loads((D/'route.json').read_text());points=[p for s in route['segments'] for p in s['profilePoints']]
with rasterio.open(u,opener=remote) as dem:values=[float(v[0]) for v in dem.sample(points)]
if len(values)!=132 or not all(__import__('math').isfinite(v) for v in values):raise ValueError('Incomplete elevation samples')
(D/'elevation.json').write_text(json.dumps({'source':'Copernicus DEM GLO-30 (surface elevations, not surveyed pipe elevations)','url':u,'fetchedAt':datetime.now(timezone.utc).isoformat(),'samplesPerSegment':11,'values':values},indent=2)+'\n')
print('Saved 132 real surface-elevation samples. Rebuild the assessment with npm run prepare-bc.')
