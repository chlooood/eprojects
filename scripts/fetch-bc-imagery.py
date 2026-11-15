#!/usr/bin/env python3
"""Fetch reproducible Sentinel-2 Collection-1 observations for the prepared BC route.
Requires rasterio, fsspec, aiohttp, requests, numpy. Cached outputs make normal builds Node-only.
Uses C1 assets' explicit scale/offset (the older collection has documented offset inconsistencies).
"""
import os,json,ssl,hashlib,time,calendar,sys
from pathlib import Path
from datetime import datetime,timezone
import requests,numpy as np,fsspec,rasterio
from rasterio.warp import transform,reproject,Resampling
from rasterio.windows import from_bounds
ROOT=Path(__file__).resolve().parents[1];D=ROOT/'data/corridors/bc-coquihalla';RAW=D/'raw';RAW.mkdir(exist_ok=True,parents=True)
route=json.loads((D/'route.json').read_text())
ctx=ssl.create_default_context()
if os.environ.get('NODE_EXTRA_CA_CERTS'):ctx.load_verify_locations(os.environ['NODE_EXTRA_CA_CERTS'])
remote=fsspec.filesystem('http',client_kwargs={'trust_env':True},ssl=ctx,block_size=1024*1024)
http=requests.Session()
if os.environ.get('REQUESTS_CA_BUNDLE'):http.verify=os.environ['REQUESTS_CA_BUNDLE']
def get_json(url,params):
 for attempt in range(3):
  try:
   r=http.get(url,params=params,timeout=60);r.raise_for_status();return r.json(),r.url
  except Exception:
   if attempt==2:raise
   time.sleep(2)

def observations(item):
 if item.get('collection')!='sentinel-2-c1-l2a':raise ValueError('Only reprocessed Collection 1 is accepted')
 assets=item['assets'];p=[p for s in route['segments'] for p in s['centreline']]
 with rasterio.open(assets['red']['href'],opener=remote) as red:
  px,py=transform('EPSG:4326',red.crs,[v[0] for v in p],[v[1] for v in p])
  window=from_bounds(min(px)-250,min(py)-250,max(px)+250,max(py)+250,red.transform).round_offsets().round_lengths()
  red_dn=red.read(1,window=window);tr=red.window_transform(window);crs=red.crs
 with rasterio.open(assets['nir']['href'],opener=remote) as nir:nir_dn=nir.read(1,window=window)
 if red_dn.shape!=nir_dn.shape:raise ValueError('Band grids differ')
 with rasterio.open(assets['scl']['href'],opener=remote) as scl:
  bounds=rasterio.windows.bounds(window,red.transform)
  sw=from_bounds(*bounds,scl.transform).round_offsets().round_lengths();src=scl.read(1,window=sw)
  classes=np.zeros(red_dn.shape,dtype='uint8');reproject(src,classes,src_transform=scl.window_transform(sw),src_crs=scl.crs,dst_transform=tr,dst_crs=crs,resampling=Resampling.nearest)
 def physical(dn,key):
  band=assets[key]['raster:bands'][0]
  return dn.astype('float64')*band['scale']+band.get('offset',0)
 r=physical(red_dn,'red');n=physical(nir_dn,'nir');valid=(red_dn!=0)&(nir_dn!=0)&np.isin(classes,[4,5])&(r>=0)&(n>=0)&((r+n)>0)
 ndvi=np.divide(n-r,n+r,out=np.zeros_like(r),where=(r+n)>0)
 yy,xx=np.indices(r.shape);X=tr.c+(xx+0.5)*tr.a;Y=tr.f+(yy+0.5)*tr.e
 out=[]
 for seg in route['segments']:
  sx,sy=transform('EPSG:4326',crs,[p[0] for p in seg['centreline']],[p[1] for p in seg['centreline']]);distance=np.full(r.shape,np.inf)
  for i in range(1,len(sx)):
   dx=sx[i]-sx[i-1];dy=sy[i]-sy[i-1];den=dx*dx+dy*dy
   if den<=0:continue
   t=np.clip(((X-sx[i-1])*dx+(Y-sy[i-1])*dy)/den,0,1)
   distance=np.minimum(distance,np.hypot(X-(sx[i-1]+t*dx),Y-(sy[i-1]+t*dy)))
  mask=(distance>=30)&(distance<=230);good=mask&valid;total=int(mask.sum());count=int(good.sum());coverage=count/total if total else 0
  out.append({'segment_id':seg['id'],'month':item['properties']['datetime'][:7],'mean':round(float(ndvi[good].mean()),6) if count>=100 and coverage>=0.6 else None,'validPixels':count,'studyPixels':total,'validFraction':round(coverage,4),'scene':item['id']})
 return out,{'red':hashlib.sha256(red_dn.tobytes()).hexdigest(),'nir':hashlib.sha256(nir_dn.tobytes()).hexdigest(),'scl':hashlib.sha256(classes.tobytes()).hexdigest()}

results=[];sources=[]
for year in range(2021,2026):
 for month in [6,7,8]:
  key=f'{year}-{month:02d}';cache=RAW/f'ndvi-{key}.json'
  if cache.exists() and '--refresh' not in sys.argv:record=json.loads(cache.read_text())
  else:
   params={'collections':'sentinel-2-c1-l2a','bbox':'-121.355,49.375,-121.26,49.455','datetime':f'{key}-01T00:00:00Z/{key}-{calendar.monthrange(year,month)[1]}T23:59:59Z','limit':100}
   search,url=get_json('https://earth-search.aws.element84.com/v1/search',params)
   features=[f for f in search.get('features',[]) if f['properties'].get('grid:code')=='MGRS-10UFV']
   if not features:
    print(key,'C1 scene unavailable; left missing',flush=True);continue
   scene=min(features,key=lambda f:(f['properties']['eo:cloud_cover'],f['id']))
   obs,hashes=observations(scene)
   record={'searchUrl':url,'scene':scene,'windowHashes':hashes,'observations':obs,'fetchedAt':datetime.now(timezone.utc).isoformat()};cache.write_text(json.dumps(record,indent=2)+'\n')
  results.extend(record['observations']);sources.append({'month':key,'scene':record['scene']['id'],'url':record['searchUrl'],'windowHashes':record['windowHashes']});print(key,record['scene']['id'],'valid',sum(o['mean'] is not None for o in record['observations']),flush=True)
(D/'ndvi.json').write_text(json.dumps({'source':'Copernicus Sentinel-2 L2A Collection 1 via Element84 Earth Search, 10m red/NIR and 20m scene classification','method':'Lowest tile cloud-cover scene per June/July/August, 2021–2025; scale and offset from C1 asset metadata. Cloud/shadow/water/snow excluded using SCL 4/5. Mean NDVI 30–230m from mapped line, >=60% valid pixels, >=100 samples. Acquisition dates vary: screening trend, not field evidence of movement.','sources':sources,'observations':results},indent=2)+'\n')
