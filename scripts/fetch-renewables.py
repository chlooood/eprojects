#!/usr/bin/env python3
"""Fetch and cache the public inputs for the renewable-energy screening assessor.

One run per corridor:  python scripts/fetch-renewables.py --corridor ab-strathcona-demo
Writes data/renewables/<corridor>/inputs.json and raw/ responses with SHA-256 hashes.

Reads corridor geometry only (read-only) from the existing saved assessments. It never writes
pipeline data, risk scores, snapshots, workflows or tables. Nothing is invented: a value that cannot
be read is stored as null with a reason, and the scorer treats it as unknown.

Requires: pip install rasterio==1.4.4 pyshp shapely pyproj numpy   (see scripts/renewables-requirements.txt)
"""
import argparse, datetime as dt, hashlib, io, json, math, os, sys, time, urllib.request, urllib.parse, zipfile
import numpy as np
import rasterio
from rasterio.windows import from_bounds
import shapefile
from shapely.geometry import LineString, Point, Polygon, MultiPolygon, shape, mapping
from shapely.ops import transform as shp_transform, unary_union
import shapely
from pyproj import Transformer

ROOT = os.path.join(os.path.dirname(__file__), '..')
UA = {'User-Agent': 'TerraCorridor-renewables-screening/1.0 (UBC eProjects LOOP; reproducible cache)'}

CORRIDORS = {
    'ab-strathcona-demo': {'snapshot': 'data/snapshot/live-snapshot.json', 'epsg': 32612, 'province': 'AB'},
    'bc-coquihalla': {'snapshot': 'data/corridors/bc-coquihalla/assessment.json', 'epsg': 32610, 'province': 'BC'},
}
# Candidate geometry. Distances are from the mapped pipeline centreline, in metres.
BANDS = {
    'solar': {'from': 30, 'to': 230, 'segments_per_block': 1, 'spacing': 20},
    'wind': {'from': 300, 'to': 2000, 'segments_per_block': 2, 'spacing': 50},
}
GWA_WS = 'https://gwa.cdn.nazkamapps.com/country_tifs_v4/CAN_wind-speed_100m.tif'
GWA_CF = 'https://gwa.cdn.nazkamapps.com/country_tifs_v4/CAN_capacity-factor_IEC2.tif'
GSA_API = 'https://api.globalsolaratlas.info/data/lta?loc={lat:.5f},{lon:.5f}'
CPCAD = 'https://maps-cartes.ec.gc.ca/arcgis/rest/services/CWS_SCF/CPCAD/MapServer/0/query'
CANVEC = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/canvec/shp/Res_MGT/canvec_50K_{p}_Res_MGT_shp.zip'
WORLDCOVER = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif'
DEM = 'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{t}_DEM/Copernicus_DSM_COG_10_{t}_DEM.tif'
WC_CLASSES = {10: 'tree cover', 20: 'shrubland', 30: 'grassland', 40: 'cropland', 50: 'built-up', 60: 'bare / sparse',
              70: 'snow and ice', 80: 'water', 90: 'herbaceous wetland', 95: 'mangroves', 100: 'moss and lichen'}
ELIGIBLE = {'solar': {20, 30, 40, 60}, 'wind': {10, 20, 30, 40, 60}}
MAX_SLOPE = {'solar': 10.0, 'wind': 20.0}
SEARCH_KM = 30

now = lambda: dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
sha = lambda b: hashlib.sha256(b).hexdigest()

def http(url, data=None, timeout=90, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), dict(r.headers)
        except Exception as e:  # retry, then fail loudly; callers decide what unknown means
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

def head(url):
    req = urllib.request.Request(url, method='HEAD', headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        h = dict(r.headers)
    return {k: h.get(k) for k in ('Last-Modified', 'ETag', 'Content-Length') if h.get(k)}

def read_window(url, bounds):
    """Read a lon/lat window from a remote COG. Returns (array, transform, nodata, header)."""
    with rasterio.open('/vsicurl/' + url) as d:
        w = from_bounds(*bounds, d.transform).round_offsets().round_lengths()
        a = d.read(1, window=w, boundless=True, fill_value=d.nodata if d.nodata is not None else 0)
        return a, d.window_transform(w), d.nodata, d.res

def sample(arr, tf, lons, lats):
    inv = ~tf
    cols, rows = inv * (np.asarray(lons), np.asarray(lats))
    rows = np.floor(rows).astype(int); cols = np.floor(cols).astype(int)
    ok = (rows >= 0) & (rows < arr.shape[0]) & (cols >= 0) & (cols < arr.shape[1])
    out = np.full(len(lons), np.nan, dtype='float64')
    out[ok] = arr[rows[ok], cols[ok]]
    return out

def r2(x, n=2):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), n)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--corridor', required=True, choices=sorted(CORRIDORS)); args = ap.parse_args()
    cid = args.corridor; cfg = CORRIDORS[cid]
    out_dir = os.path.join(ROOT, 'data/renewables', cid); raw_dir = os.path.join(out_dir, 'raw'); os.makedirs(raw_dir, exist_ok=True)
    snap = json.load(open(os.path.join(ROOT, cfg['snapshot']), encoding='utf-8'))
    if snap['meta'].get('corridorId') != cid: sys.exit('snapshot corridor mismatch: refusing to mix corridors')
    segs = sorted(snap['segments'], key=lambda s: s['index'])
    to_m = Transformer.from_crs(4326, cfg['epsg'], always_xy=True); to_ll = Transformer.from_crs(cfg['epsg'], 4326, always_xy=True)
    sources = []

    # ---------- candidate polygons (UTM), sample points on one global grid per technology (no double counting)
    candidates = []
    for tech, b in BANDS.items():
        n = b['segments_per_block']; claimed = set()
        for i in range(0, len(segs), n):
            block = segs[i:i + n]
            coords = []
            for s in block:
                for c in s['centreline']:
                    if not coords or coords[-1] != tuple(c): coords.append(tuple(c))
            line = LineString([to_m.transform(x, y) for x, y in coords])
            for side, sign in (('L', 1), ('R', -1)):
                outer = line.buffer(sign * b['to'], single_sided=True)
                inner = line.buffer(sign * b['from'], single_sided=True)
                poly = outer.difference(inner)
                if poly.is_empty: continue
                sp = b['spacing']; x0, y0, x1, y1 = poly.bounds
                xs = np.arange(math.floor(x0 / sp) * sp + sp / 2, x1, sp); ys = np.arange(math.floor(y0 / sp) * sp + sp / 2, y1, sp)
                gx, gy = np.meshgrid(xs, ys); gx = gx.ravel(); gy = gy.ravel()
                inside = shapely.contains_xy(poly, gx, gy)
                # The other corridor side and other blocks never claim the same grid cell twice.
                keys = [(round(x), round(y)) for x, y in zip(gx[inside], gy[inside])]
                keep = np.array([k not in claimed for k in keys], dtype=bool) if keys else np.zeros(0, bool)
                claimed.update(k for k, kp in zip(keys, keep) if kp)
                px = gx[inside][keep]; py = gy[inside][keep]
                lon, lat = to_ll.transform(px, py)
                ids = [s['id'] for s in block]
                cand_id = f"rn_{cid}_{tech}_{ids[0]}_{side}"
                ll_poly = shp_transform(lambda x, y, z=None: to_ll.transform(x, y), poly.simplify(5))
                cen = shp_transform(lambda x, y, z=None: to_ll.transform(x, y), poly.centroid)
                candidates.append({'id': cand_id, 'corridorId': cid, 'tech': tech, 'side': side, 'segmentIds': ids,
                    'kmFrom': block[0]['kmFrom'], 'kmTo': block[-1]['kmTo'], 'polyM': poly, 'lon': np.asarray(lon), 'lat': np.asarray(lat),
                    'px': px, 'py': py, 'spacing': sp, 'centroid': [r2(cen.x, 6), r2(cen.y, 6)], 'geojson': mapping(ll_poly),
                    'bandAreaHa': r2(poly.area / 1e4, 1), 'sampledHa': r2(len(px) * sp * sp / 1e4, 1)})
    all_lon = np.concatenate([c['lon'] for c in candidates]); all_lat = np.concatenate([c['lat'] for c in candidates])
    pad = 0.03
    bbox = (float(all_lon.min()) - pad, float(all_lat.min()) - pad, float(all_lon.max()) + pad, float(all_lat.max()) + pad)
    print(cid, len(candidates), 'candidates; bbox', [round(v, 3) for v in bbox])

    # ---------- rasters
    def raster_source(key, name, url, licence, resolution, arr_hash, hdr, note):
        sources.append({'key': key, 'name': name, 'url': url, 'retrievedAt': now(), 'licence': licence, 'resolution': resolution,
                        'rawSha256': arr_hash, 'httpHeaders': hdr, 'note': note})

    # ESA WorldCover 2021 v200 (10 m), one 3x3 degree tile per corridor.
    t = lambda lat, lon: f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
    wc_tile = t(math.floor(bbox[1] / 3) * 3, math.floor(bbox[0] / 3) * 3)
    if math.floor(bbox[3] / 3) != math.floor(bbox[1] / 3) or math.floor(bbox[2] / 3) != math.floor(bbox[0] / 3): sys.exit('bbox spans two WorldCover tiles; extend script')
    wc_url = WORLDCOVER.format(t=wc_tile); wc, wc_tf, _, wc_res = read_window(wc_url, bbox)
    raster_source('worldcover', 'ESA WorldCover 10 m 2021 v200', wc_url, 'CC BY 4.0. © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
                  '10 m (1/12000 degree)', sha(wc.tobytes()), head(wc_url), 'Land cover in 2021. Classes are satellite-derived, not a land survey.')

    # Copernicus GLO-30 DEM: merge the 1-degree tiles that the bbox touches.
    dem_parts = []
    for la in range(math.floor(bbox[1]), math.floor(bbox[3]) + 1):
        for lo in range(math.floor(bbox[0]), math.floor(bbox[2]) + 1):
            tile = f"{'N' if la >= 0 else 'S'}{abs(la):02d}_00_{'E' if lo >= 0 else 'W'}{abs(lo):03d}_00"
            url = DEM.format(t=tile)
            sub = (max(bbox[0], lo), max(bbox[1], la), min(bbox[2], lo + 1), min(bbox[3], la + 1))
            a, tf, nod, res = read_window(url, sub)
            dem_parts.append((url, a.astype('float64'), tf, res))
    dem_hash = sha(b''.join(p[1].tobytes() for p in dem_parts))
    raster_source('dem', 'Copernicus DEM GLO-30', ';'.join(p[0] for p in dem_parts), 'Copernicus DEM licence (free use with attribution): © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA',
                  '1 arcsecond (~30 m); slope computed per DEM cell', dem_hash, head(dem_parts[0][0]), 'Surface model includes trees and buildings; slope is a screening estimate, not a site survey.')
    def slope_at(lons, lats):
        out = np.full(len(lons), np.nan)
        for url, a, tf, res in dem_parts:
            lat_c = tf.f + tf.e * a.shape[0] / 2
            dx = abs(tf.a) * 111320 * math.cos(math.radians(lat_c)); dy = abs(tf.e) * 110540
            gy, gx = np.gradient(a, dy, dx)
            s = np.hypot(gx, gy) * 100
            v = sample(s, tf, lons, lats)
            out = np.where(np.isnan(out), v, out)
        return out

    # Global Wind Atlas v4 at 100 m (250 m grid).
    ws, ws_tf, _, ws_res = read_window(GWA_WS, bbox); cf, cf_tf, _, _ = read_window(GWA_CF, bbox)
    gwa_lic = 'CC BY 4.0. Global Wind Atlas version 4, a free web-based application developed, owned and operated by the Technical University of Denmark (DTU) in partnership with the World Bank Group, utilizing data provided by Vortex, using funding provided by ESMAP'
    raster_source('gwa_ws100', 'Global Wind Atlas v4 mean wind speed, 100 m above ground', GWA_WS, gwa_lic, '0.0025 degree (~250 m)', sha(ws.tobytes()), head(GWA_WS), 'Modelled long-term mean, not a measurement. Hub height 100 m.')
    raster_source('gwa_cf_iec2', 'Global Wind Atlas v4 capacity factor, IEC class II generic turbine', GWA_CF, gwa_lic, '0.0025 degree (~250 m)', sha(cf.tobytes()), head(GWA_CF), 'Modelled gross capacity factor for a generic turbine; losses are applied as an editable assumption.')

    # ---------- CPCAD protected and conserved areas (ECCC)
    q = {'where': '1=1', 'geometry': ','.join(map(str, bbox)), 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'spatialRel': 'esriSpatialRelIntersects',
         'outFields': 'NAME_E,TYPE_E,IUCN_CAT,OWNER_E,ZONE_ID', 'returnGeometry': 'true', 'outSR': 4326, 'f': 'geojson',
         'maxAllowableOffset': 0.0004, 'geometryPrecision': 6}  # ~30-45 m generalisation; edges are screening-grade
    cp_url = CPCAD + '?' + urllib.parse.urlencode(q); cp_raw, cp_h = http(cp_url)
    cp = json.loads(cp_raw)
    # Province-wide features (e.g. BC Old Growth Management Areas) are huge; keep a copy clipped to the study box.
    box = Polygon.from_bounds(*bbox)
    for f in cp.get('features', []):
        if f.get('geometry'): f['geometry'] = mapping(shape(f['geometry']).buffer(0).intersection(box))
    clipped = json.dumps(cp).encode()
    open(os.path.join(raw_dir, 'cpcad-clipped.geojson'), 'wb').write(clipped)
    if 'features' not in cp: sys.exit('CPCAD query failed: ' + cp_raw[:200].decode('utf8', 'replace'))
    prot = [(f['properties'], shp_transform(lambda x, y, z=None: to_m.transform(x, y), shape(f['geometry']))) for f in cp['features'] if f.get('geometry')]
    sources.append({'key': 'cpcad', 'name': 'Canadian Protected and Conserved Areas Database (CPCAD), ECCC', 'url': cp_url, 'retrievedAt': now(),
                    'licence': 'Open Government Licence - Canada', 'resolution': 'Polygon boundaries generalised by the server to about 0.0004 degree (30-45 m)', 'rawSha256': sha(cp_raw), 'rawBytes': len(cp_raw), 'rawFile': 'raw/cpcad-clipped.geojson', 'clippedSha256': sha(clipped),
                    'note': f"{len(prot)} protected or conserved areas intersect the study box. Absence here does not clear provincial wildlife, wetland or Crown-land rules."})

    # ---------- CanVec power lines and transformer stations (NRCan, 1:50 000)
    cz, ch = http(CANVEC.format(p=cfg['province']), timeout=180)
    z = zipfile.ZipFile(io.BytesIO(cz)); base = f"canvec_50K_{cfg['province']}_Res_MGT/"
    def read_shp(name):
        r = shapefile.Reader(shp=io.BytesIO(z.read(base + name + '.shp')), dbf=io.BytesIO(z.read(base + name + '.dbf')), shx=io.BytesIO(z.read(base + name + '.shx')))
        fields = [f[0] for f in r.fields[1:]]
        return [(dict(zip(fields, rec)), shp) for rec, shp in zip(r.records(), r.shapes())]
    search = Polygon.from_bounds(*bbox).buffer(SEARCH_KM / 111.0)
    lines, stations = [], []
    for props, s in read_shp('power_line_1'):
        g = shape(s.__geo_interface__)
        if g.intersects(search): lines.append((props, g))
    for name in ('transformer_station_0', 'transformer_station_2'):
        if base + name + '.shp' not in z.namelist(): continue
        for props, s in read_shp(name):
            g = shape(s.__geo_interface__)
            if g.intersects(search): stations.append((props, g))
    lines_m = [(p, shp_transform(lambda x, y, z=None: to_m.transform(x, y), g)) for p, g in lines]
    stations_m = [(p, shp_transform(lambda x, y, z=None: to_m.transform(x, y), g)) for p, g in stations]
    sources.append({'key': 'canvec', 'name': 'CanVec 1:50 000 Resource Management (power_line_1, transformer_station_0/2), NRCan', 'url': CANVEC.format(p=cfg['province']),
                    'retrievedAt': now(), 'licence': 'Open Government Licence - Canada. Contains information licensed under the Open Government Licence - Canada',
                    'resolution': '1:50 000 topographic base map (stated horizontal accuracy in haccmin/haccmax, typically 10-20 m)', 'rawSha256': sha(cz), 'httpHeaders': {k: ch.get(k) for k in ('Last-Modified', 'ETag', 'Content-Length') if ch.get(k)},
                    'note': f"{len(lines)} mapped power lines and {len(stations)} transformer stations within {SEARCH_KM} km. Feature source dates (datemin/datemax) are shown per candidate; many are decades old. No voltage, owner or available capacity is attributed. This is mapped infrastructure, not a confirmed interconnection point."})
    if not stations: print('warning: no mapped transformer station within search radius; grid distance will be reported as beyond search radius')

    # ---------- Global Solar Atlas long-term averages at each solar candidate centroid
    gsa_raw = {}
    def gsa(lat, lon):
        url = GSA_API.format(lat=lat, lon=lon); body, h = http(url, timeout=60); time.sleep(0.4)
        d = json.loads(body); a = d.get('annual', {}).get('data', {})
        gsa_raw[url] = {'sha256': sha(body), 'body': d}
        return url, a, d.get('annual', {}).get('metadata', {})

    # ---------- per-candidate inputs
    out_c = []
    for c in candidates:
        tech = c['tech']; lon, lat = c['lon'], c['lat']; n = len(lon); cell_ha = c['spacing'] ** 2 / 1e4
        lc = sample(wc, wc_tf, lon, lat); sl = slope_at(lon, lat)
        in_prot = np.zeros(n, bool); prot_names = set()
        for props, g in prot:
            if not g.intersects(c['polyM']): continue
            hit = shapely.contains_xy(g, c['px'], c['py'])
            if hit.any(): in_prot |= hit; prot_names.add(f"{props.get('NAME_E')} ({props.get('TYPE_E')})")
        lc_ok = ~np.isnan(lc) & (lc > 0); sl_ok = ~np.isnan(sl)
        shares = {WC_CLASSES.get(int(k), str(int(k))): r2(100 * np.mean(lc[lc_ok] == k), 1) for k in np.unique(lc[lc_ok])} if lc_ok.any() else {}
        usable = lc_ok & sl_ok & np.isin(lc, list(ELIGIBLE[tech])) & (sl <= MAX_SLOPE[tech]) & ~in_prot
        coverage_ok = n > 0 and lc_ok.mean() >= 0.95 and sl_ok.mean() >= 0.95
        land = {'samples': int(n), 'spacingM': c['spacing'], 'landCoverPct': shares,
                'eligibleClasses': [WC_CLASSES[k] for k in sorted(ELIGIBLE[tech])], 'maxSlopePct': MAX_SLOPE[tech],
                'slopeMedianPct': r2(np.nanmedian(sl)) if sl_ok.any() else None, 'slopeP90Pct': r2(np.nanpercentile(sl, 90)) if sl_ok.any() else None,
                'protectedPct': r2(100 * in_prot.mean(), 1) if n else None, 'protectedNames': sorted(prot_names),
                'usableHa': r2(usable.sum() * cell_ha, 1) if coverage_ok else None,
                'usableReason': None if coverage_ok else 'land cover or slope missing for more than 5% of sample points'}
        cen = Point(c['polyM'].centroid)
        def nearest(feats):
            if not feats: return None, None
            best = min(feats, key=lambda pg: pg[1].distance(c['polyM']))
            return r2(best[1].distance(c['polyM']) / 1000, 2), {'datemin': best[0].get('datemin'), 'datemax': best[0].get('datemax'), 'featureId': best[0].get('feature_id')}
        st_km, st_meta = nearest(stations_m); ln_km, ln_meta = nearest(lines_m)
        grid = {'stationKm': st_km, 'station': st_meta, 'lineKm': ln_km, 'line': ln_meta, 'searchKm': SEARCH_KM,
                'reason': None if st_km is not None else f'no mapped transformer station within {SEARCH_KM} km'}
        res = {}
        if tech == 'wind':
            w = sample(ws, ws_tf, lon, lat); f = sample(cf, cf_tf, lon, lat)
            res = {'ws100': r2(np.nanmean(w)) if np.isfinite(w).mean() >= 0.95 else None, 'ws100Min': r2(np.nanmin(w)) if np.isfinite(w).any() else None,
                   'ws100Max': r2(np.nanmax(w)) if np.isfinite(w).any() else None, 'cfGross': r2(np.nanmean(f), 3) if np.isfinite(f).mean() >= 0.95 else None,
                   'heightM': 100, 'source': 'gwa_ws100', 'cfSource': 'gwa_cf_iec2', 'gridCells': int(len(set(zip(*np.floor((~ws_tf) * (lon, lat)).astype(int)))))}
            # mean over usable points only, so the wind value describes land that could host a turbine
            if usable.any() and np.isfinite(w[usable]).all(): res['ws100Usable'] = r2(np.mean(w[usable]))
        else:
            url, a, meta = gsa(c['centroid'][1], c['centroid'][0])
            pv = a.get('PVOUT_csi'); ghi = a.get('GHI')
            res = {'pvout': r2(pv, 1) if isinstance(pv, (int, float)) and pv > 0 else None, 'ghi': r2(ghi, 1) if isinstance(ghi, (int, float)) and ghi > 0 else None,
                   'opta': a.get('OPTA'), 'unit': 'kWh/kWp/yr (PVOUT_csi), kWh/m2/yr (GHI)', 'source': 'gsa', 'url': url}
        out_c.append({k: c[k] for k in ('id', 'corridorId', 'tech', 'side', 'segmentIds', 'kmFrom', 'kmTo', 'centroid', 'bandAreaHa', 'sampledHa')} |
                     {'polygon': c['geojson'], 'resource': res, 'land': land, 'grid': grid})
        print(c['id'], tech, 'usable', land['usableHa'], 'ha; res', res.get('ws100') or res.get('pvout'), '; station', st_km, 'km')

    gsa_bytes = json.dumps(gsa_raw, sort_keys=True).encode()
    open(os.path.join(raw_dir, 'global-solar-atlas.json'), 'wb').write(gsa_bytes)
    sources.append({'key': 'gsa', 'name': 'Global Solar Atlas 2.0 long-term averages (Solargis model), point API', 'url': GSA_API.split('?')[0], 'retrievedAt': now(),
                    'licence': 'CC BY 4.0. Global Solar Atlas 2.0, a free, web-based application developed and operated by Solargis s.r.o. on behalf of the World Bank Group, utilizing Solargis data, with funding provided by ESMAP',
                    'resolution': 'Modelled grid, about 9 arcseconds (~250 m) for GHI; one value at each solar candidate centroid', 'rawSha256': sha(gsa_bytes), 'rawFile': 'raw/global-solar-atlas.json',
                    'note': 'PVOUT_csi is Solargis modelled yield for a crystalline-silicon, ground-mounted, optimally tilted system with typical losses. It is a long-term average, not a guarantee.'})

    def feat(props, g, keys):
        return {'type': 'Feature', 'properties': {k: props.get(k) for k in keys}, 'geometry': mapping(g.simplify(0.00005))}
    layers = {
        'pipeline': [{'id': s['id'], 'kmFrom': s['kmFrom'], 'kmTo': s['kmTo'], 'centreline': s['centreline']} for s in segs],
        'powerLines': {'type': 'FeatureCollection', 'features': [feat(p, g, ['feature_id', 'datemin', 'datemax', 'liloc_en']) for p, g in lines if g.intersects(Polygon.from_bounds(*bbox).buffer(0.15))]},
        'stations': {'type': 'FeatureCollection', 'features': [feat(p, g.centroid if g.geom_type != 'Point' else g, ['feature_id', 'datemin', 'datemax']) for p, g in stations]},
        'protected': {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {k: f['properties'].get(k) for k in ('NAME_E', 'TYPE_E', 'IUCN_CAT')}, 'geometry': mapping(shape(f['geometry']).simplify(0.0002))} for f in cp['features'] if f.get('geometry')]},
    }
    doc = {'schema': 'terracorridor.renewables.inputs/1', 'corridorId': cid, 'corridorName': snap['meta'].get('name'), 'generatedAt': now(),
           'geometrySource': cfg['snapshot'] + ' (read only)', 'bands': BANDS, 'eligibleLandCover': {k: [WC_CLASSES[x] for x in sorted(v)] for k, v in ELIGIBLE.items()},
           'maxSlopePct': MAX_SLOPE, 'bbox': [round(v, 5) for v in bbox], 'sources': sources, 'layers': layers, 'candidates': out_c,
           'notAssessed': ['land rights / tenure (parcel ownership, easement terms, consent)', 'interconnection capacity and queue position', 'permitting status and setbacks',
                           'Indigenous rights and consultation', 'agricultural land class rules (Alberta)', 'wildlife, wetland and heritage surveys', 'geotechnical and pipeline-crossing engineering']}
    json.dump(doc, open(os.path.join(out_dir, 'inputs.json'), 'w', encoding='utf-8'), indent=1)
    print('wrote', os.path.join('data/renewables', cid, 'inputs.json'))

if __name__ == '__main__':
    main()
