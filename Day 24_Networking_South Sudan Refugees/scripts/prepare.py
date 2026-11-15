"""Prepare the fixed 2025-12 UNHCR snapshot and registered, offline map assets.

Usage: python scripts/prepare.py <cache directory>
Requires requests, NumPy, Pillow, rasterio and Shapely. Downloaded originals stay in the cache.
"""
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from zipfile import ZipFile

import numpy as np
import requests
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely.geometry import Point, box, shape

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets'
CACHE = Path(sys.argv[1])
CACHE.mkdir(parents=True, exist_ok=True)
OUT.mkdir(exist_ok=True)
NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/'
NASA = ('https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/'
        'bmng-topography-bathymetry/november/world.topo.bathy.200411.3x5400x2700.jpg')
UNHCR = 'https://api-data.unhcr.org/api/v0/data/PopStatsOfficial'
PERIOD = '2025-12'
REGION = (2, -12, 68, 36)  # Raster coverage, larger than the initial detail view.
WORLD = (-180, -90, 180, 90)


def cached(name, url):
    path = CACHE / name
    if not path.exists():
        response = requests.get(url, timeout=100)
        response.raise_for_status()
        tmp = path.with_suffix(path.suffix + '.part')
        tmp.write_bytes(response.content)
        tmp.replace(path)
    return path


def features(name, dataset):
    return json.loads(cached(name, NE + dataset + '.geojson').read_text())['features']


countries = features('countries.geojson', 'ne_50m_admin_0_countries')
lakes = features('lakes.geojson', 'ne_50m_lakes')
borders = features('borders.geojson', 'ne_50m_admin_0_boundary_lines_land')
rivers = features('rivers.geojson', 'ne_10m_rivers_lake_centerlines')
country_index = {f['properties']['ADM0_A3']: f for f in countries}


def observations(dimensions, cache_key):
    params = {'c[pop_type]': 'REF_UNHCR', 'c[area_ori_adm0]': 'SSD',
              'time_period': 'eq:' + PERIOD, 'dimensions': dimensions,
              'page_size': 100, 'sort': 'obs_value:desc'}
    url = UNHCR + '?' + urlencode(params)
    page = 1
    result = []
    while True:
        data = json.loads(cached(f'{cache_key}-{page}.json', url + f'&page={page}').read_text())
        for row in data['data']:
            assert (row['pop_type'], row['area_ori_adm0'], row['time_period'], row['unit_measure'],
                    row['unit_mult'], row['unit_comp']) == ('REF_UNHCR', 'SSD', PERIOD, 'IND', 1, 'TOT')
            result.append(row)
        if not data['pagination']['has_next']:
            break
        page += 1
        time.sleep(1)
    return result, url


def node(code):
    # A territory may share Australia's ISO code. Use the distinct Natural Earth
    # admin code, translating South Sudan's ISO SSD to its Natural Earth SDS.
    f = country_index['SDS' if code == 'SSD' else code]
    p = f['properties']
    assert p['ISO_A3_EH'] == code
    lon, lat = p['LABEL_X'], p['LABEL_Y']
    assert shape(f['geometry']).covers(Point(lon, lat)), f'Label point outside {code}'
    name = {'COD': 'DR Congo', 'USA': 'United States'}.get(code, p['NAME_EN'])
    return {'code': code, 'name': name, 'lon': round(lon, 4), 'lat': round(lat, 4)}


rows, source = observations('pop_type,ref_area_adm0,area_ori_adm0', 'hosts-2025-12')
world_rows, _ = observations('pop_type,area_ori_adm0', 'total-2025-12')
assert len(world_rows) == 1
hosts = []
for row in rows:
    if row['obs_value'] > 0:
        host = node(row['ref_area_adm0'])
        host['people'] = row['obs_value']
        hosts.append(host)
hosts.sort(key=lambda h: (-h['people'], h['code']))
total = world_rows[0]['obs_value']
assert len({h['code'] for h in hosts}) == len(hosts)
assert sum(h['people'] for h in hosts) == total


def parts(geom, kind):
    if geom.is_empty:
        return []
    if geom.geom_type == kind:
        return [geom]
    return [part for g in getattr(geom, 'geoms', ()) for part in parts(g, kind)]


def coords(ring):
    return [[round(x, 3), round(y, 3)] for x, y, *_ in ring.coords]


# All export geometries and texture grids use longitude/latitude in degrees.
# Political lines retain the source's disputed / indefinite classification.
linework = []
region = box(*REGION)
for feature in borders:
    geom = shape(feature['geometry'])
    tolerance = .012 if geom.intersects(region) else .055
    disputed = feature['properties']['FEATURECLA'] != 'International boundary (verify)'
    for line in parts(geom.simplify(tolerance), 'LineString'):
        linework.append([int(disputed), coords(line)])
waterways = []
for feature in rivers:
    if feature['properties']['scalerank'] > 5:
        continue
    clipped = shape(feature['geometry']).intersection(region)
    for line in parts(clipped.simplify(.018), 'LineString'):
        if line.length >= .32:
            waterways.append(coords(line))

areas = {}
for n in [node('SSD'), *hosts]:
    key = 'SDS' if n['code'] == 'SSD' else n['code']
    geom = shape(country_index[key]['geometry']).simplify(.045, preserve_topology=True)
    areas[n['code']] = [[coords(p.exterior), *[coords(r) for r in p.interiors]]
                        for p in parts(geom, 'Polygon') if p.area > .018]

plate = {'period': PERIOD, 'category': 'REF_UNHCR', 'source': source, 'total': total,
         'origin': node('SSD'), 'hosts': hosts, 'regionRaster': REGION,
         'boundaries': linework, 'rivers': waterways, 'areas': areas}
(OUT / 'network.js').write_text('window.ASYLUM_ATLAS=' +
    json.dumps(plate, ensure_ascii=False, separators=(',', ':')) + ';\n')

# Register NASA's surface mosaic and Natural Earth's relief to the same pixel centres.
# A land/lake mask gives water and land independent grey scales.
Image.MAX_IMAGE_PIXELS = 260_000_000
satellite = Image.open(cached('blue-marble.jpg', NASA)).convert('L', (.32, .46, .22, 0))
tif = CACHE / 'SR_HR.tif'
if not tif.exists():
    with ZipFile(cached('sr.zip', 'https://naturalearth.s3.amazonaws.com/10m_raster/SR_HR.zip')) as archive:
        with archive.open('SR_HR.tif') as original, tif.open('wb') as out:
            import shutil
            shutil.copyfileobj(original, out)
relief = Image.open(tif)
assert relief.size == (21600, 10800) and satellite.size == (5400, 2700)
land_water = [(shape(f['geometry']), 1) for f in countries] + [(shape(f['geometry']), 0) for f in lakes]


def raster_crop(image, bounds, size):
    west, south, east, north = bounds
    x = image.width / 360
    y = image.height / 180
    pixels = ((west + 180) * x, (90 - north) * y, (east + 180) * x, (90 - south) * y)
    return np.asarray(image.resize(size, Image.Resampling.LANCZOS, box=pixels), dtype=np.float32)


def texture(name, bounds, size):
    mask = rasterize([(geom, v) for geom, v in land_water if geom.intersects(box(*bounds))],
                     out_shape=(size[1], size[0]), transform=from_bounds(*bounds, *size), dtype='uint8')
    photo = raster_crop(satellite, bounds, size)
    shade = raster_crop(relief, bounds, size)
    land = 145 + .35 * (photo - 80) + 1.65 * (shade - 206)
    sea = 46 + .63 * photo
    values = np.clip(np.where(mask, land, sea), 38, 229).astype('uint8')
    image = Image.fromarray(values)
    image.save(OUT / (name + '.webp'), quality=88, method=6)
    return image


world_img = texture('world', WORLD, (3600, 1800))
texture('east-africa', REGION, (3300, 2400))

# Orthographic locator globes share the main plate's surface and country positions.
for name, lon0, lat0 in [('world-locator', -55, 20), ('africa-locator', 32, 9)]:
    d = 240
    grid = 2 * (np.arange(d) + .5) / d - 1
    x, y = np.meshgrid(grid, -grid)
    rho = np.hypot(x, y)
    z = np.sqrt(np.maximum(0, 1 - rho**2))
    phi = np.radians(lat0)
    lat = np.arcsin(np.clip(y * np.cos(phi) + z * np.sin(phi), -1, 1))
    lon = np.radians(lon0) + np.arctan2(x, z * np.cos(phi) - y * np.sin(phi))
    gx = ((np.degrees(lon) + 180) * world_img.width / 360).astype(int) % world_img.width
    gy = np.clip(((90 - np.degrees(lat)) * world_img.height / 180).astype(int), 0, world_img.height-1)
    rgba = np.empty((d, d, 4), dtype='uint8')
    rgba[:, :, :3] = np.asarray(world_img)[gy, gx, None]
    rgba[:, :, 3] = (np.clip((1-rho)*d/2+.5, 0, 1)*255).astype('uint8')
    Image.fromarray(rgba).save(OUT / (name + '.png'))
print(f'{PERIOD}: {len(hosts)} host countries, {total:,} refugees')
