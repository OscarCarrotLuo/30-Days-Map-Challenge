"""Build the Jezero survey plate from mission data and the published EDL recording.

Python dependencies: rasterio with GDAL HTTPS support, numpy, scipy, Pillow,
contourpy, soundfile (with MP3 support) and segno. Pass a cache directory as
an optional argument. The two USGS rasters are windowed over HTTP.
"""
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import contourpy
import numpy as np
import rasterio
import segno
import soundfile as sf
from PIL import Image, ImageFilter
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from scipy.ndimage import gaussian_filter, map_coordinates

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
CACHE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / 'jezero-sound-data'
CACHE.mkdir(parents=True, exist_ok=True)
GIS = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/'
USGS = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/'
ORTHO = 'JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120.tif'
DEM = 'JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif'
MOLA = 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm'
MP3 = 'https://assets.science.nasa.gov/content/dam/science/psd/mars/downloadable_items/4/5/45857_FILTERED_HIGHLIGHTS_-_Sol16RoverDriveHighlights.mp3'
LISTEN = 'https://science.nasa.gov/?p=326486'  # NASA's own short link, used on the printed postcard.
RADIUS = 3396190.0  # m, Mars 2000 sphere used by the source GeoTIFFs
WEST, NORTH, COVERAGE = -132, 176, 320  # Local east/north metres relative to the first fix


def fetch(url, path):
    if not path.exists():
        part = path.with_suffix(path.suffix + '.part')
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--retry', '2',
                        '--max-time', '120', '--output', str(part), url], check=True)
        part.replace(path)
    return path


# The first fix is the rover's pre-drive position. Sol 16 begins at the Sol 15 end fix.
traverse = json.loads(fetch(GIS + 'M20_traverse.json', CACHE / 'traverse').read_text())['features']
fixes = json.loads(fetch(GIS + 'M20_waypoints.json', CACHE / 'waypoints').read_text())['features']
segments = [f for f in traverse if f['properties']['sol'] in (14, 15, 16, 20)]
assert [f['properties']['sol'] for f in segments] == [14, 15, 16, 20]
lon0, lat0 = segments[0]['geometry']['coordinates'][0][:2]
metres_lat = math.radians(RADIUS)
metres_lon = metres_lat * math.cos(math.radians(lat0))
local_crs = f'+proj=eqc +lat_ts={lat0} +lat_0={lat0} +lon_0={lon0} +R={RADIUS} +units=m +type=crs'
fixes = {f['properties']['RMC']: f['properties'] for f in fixes}
drives = []
for feature in segments:
    p, ll = feature['properties'], feature['geometry']['coordinates']
    fix = fixes[p['toRMC']]
    assert np.allclose(ll[-1][:2], [fix['lon'], fix['lat']], rtol=0, atol=2e-8)
    xy = [[round((lon - lon0) * metres_lon, 3), round((lat - lat0) * metres_lat, 3)] for lon, lat, *_ in ll]
    drives.append(dict(sol=p['sol'], metres=p['length'], total=fix['dist_total_m'],
                       xy=xy, end=[fix['lon'], fix['lat']]))


def raster(name, resolution):
    local = CACHE / ('crop-' + name)
    if local.exists():
        with rasterio.open(local) as src:
            if src.crs == rasterio.crs.CRS.from_string(local_crs) and src.transform == from_origin(WEST, NORTH, resolution, resolution):
                return src.read(1)
    n = round(COVERAGE / resolution)
    transform = from_origin(WEST, NORTH, resolution, resolution)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='45', GDAL_HTTP_MAX_RETRY='2'):
        with rasterio.open('/vsicurl/' + USGS + name) as src:
            with WarpedVRT(src, crs=local_crs, transform=transform, width=n, height=n,
                           resampling=Resampling.bilinear) as projected:
                pixels = projected.read(1, masked=True)
                assert not np.any(np.ma.getmaskarray(pixels)), 'Missing source coverage over the traverse'
                with rasterio.open(local, 'w', driver='GTiff', count=1, dtype=pixels.dtype,
                                   crs=local_crs, transform=transform, width=n, height=n) as out:
                    out.write(pixels.data, 1)
    return pixels.data


# Stretch the photographic tones for print. The data retain the original 25 cm sampling.
photo = raster(ORTHO, .25)
lo, hi = np.percentile(photo, [.4, 99.65])
photo = np.clip(25 + (photo.astype(float) - lo) * 211 / (hi - lo), 14, 246).astype('uint8')
Image.fromarray(photo).filter(ImageFilter.UnsharpMask(radius=1.25, percent=65, threshold=3)).save(
    ASSETS / 'jezero.webp', quality=94, method=6)

heights = gaussian_filter(raster(DEM, 1), .8)
# Coordinates lie at the *centres* of the reprojected one-metre DEM samples.
lin = contourpy.contour_generator(x=WEST + np.arange(heights.shape[1]) + .5,
                                  y=NORTH - np.arange(heights.shape[0]) - .5, z=heights, line_type='Separate')
contours = []
for twice_level in range(math.ceil(heights.min() * 2), math.floor(heights.max() * 2) + 1):
    level = twice_level / 2
    for points in lin.lines(level):
        if len(points) >= 4:
            contours.append([level, np.round(points, 2).ravel().tolist()])


# A real MOLA relief globe and an orthographic, north-up Jezero locator from Mars Trek tiles.
# The same WMTS uses a -180..180 longitude grid at every zoom.
def relief(lon, lat, zoom):
    side = 256 * 2 ** zoom
    px = ((lon + 180) % 360) / 180 * side - .5
    py = (90 - lat) / 180 * side - .5
    left, right = math.floor(px.min() / 256), math.floor(px.max() / 256)
    top, bottom = math.floor(py.min() / 256), math.floor(py.max() / 256)
    tiles = Image.new('L', ((right - left + 1) * 256, (bottom - top + 1) * 256))
    for row in range(top, bottom + 1):
        for col in range(left, right + 1):
            r = min(max(row, 0), 2**zoom - 1)
            c = col % (2**(zoom + 1))
            path = fetch(f'{MOLA}/{zoom}/{r}/{c}.jpg', CACHE / f'mola-{zoom}-{r}-{c}.jpg')
            with Image.open(path) as tile:
                tiles.paste(tile.convert('L'), (256 * (col - left), 256 * (row - top)))
    return map_coordinates(np.asarray(tiles, dtype=float), [py - top * 256, px - left * 256], order=1, mode='nearest')


n = 240
rows, cols = np.indices((n, n))
x, y = (cols + .5 - n / 2) / (n / 2), (n / 2 - rows - .5) / (n / 2)
z = np.sqrt(np.maximum(0, 1 - x*x - y*y))
visible = x*x + y*y <= 1
# Orthographic view looking at 65 E, 8 N; Jezero lies just NE of the centre.
b = math.radians(8)
lat = np.degrees(np.arcsin(np.clip(y * math.cos(b) + z * math.sin(b), -1, 1)))
lon = 65 + np.degrees(np.arctan2(x, z * math.cos(b) - y * math.sin(b)))
tex = relief(np.where(visible, lon, 65), np.where(visible, lat, 8), 1)
light = .53 + .47 * np.clip(.84*z - .35*x + .32*y, 0, 1)
small = np.clip((30 + tex * 1.04) * light, 0, 242).astype('uint8')
globe = Image.fromarray(small).convert('RGBA'); globe.putalpha(Image.fromarray(np.uint8(visible)*255)); globe.save(ASSETS / 'mars.webp', lossless=True)
lat_r, phi = math.radians(lat0), math.radians(lon0 - 65)
globe_fix = [.5 + .5*math.cos(lat_r)*math.sin(phi),
             .5 - .5*(math.cos(b)*math.sin(lat_r) - math.sin(b)*math.cos(lat_r)*math.cos(phi))]
# A 72 km square around the IAU Jezero centre. At this size a local cylindrical metric grid is adequate.
crater_lon, crater_lat, crater_span = 77.69, 18.41, 72000
rscale = metres_lat * math.cos(math.radians(crater_lat))
llon = crater_lon + x * crater_span / (2 * rscale)
llat = crater_lat + y * crater_span / (2 * metres_lat)
crater = relief(llon, llat, 6)
a, b = np.percentile(crater, [1, 99]); crater = np.clip(39 + (crater - a) * 179 / (b - a), 18, 243)
Image.fromarray(crater.astype('uint8')).save(ASSETS / 'crater.webp', quality=92)
crater_fix = [.5 + (lon0 - crater_lon) * rscale / crater_span, .5 - (lat0 - crater_lat) * metres_lat / crater_span]

# True min/max of the exact distributed stereo file in 1,024 equal time windows.
audio_path = fetch(MP3, ASSETS / 'sol16.mp3')
wave, rate = sf.read(audio_path, dtype='float32', always_2d=True)
bins = np.array_split(wave, 1024)
waveform = [[int(round(float(chunk.min())*32767)), int(round(float(chunk.max())*32767))] for chunk in bins]
assert 84.9 < len(wave)/rate < 85.1
segno.make(LISTEN, error='m', micro=False).save(ASSETS / 'listen.png', scale=8, border=4,
                                                  dark='#232321', light='#ffffff')
bundle = dict(origin=[lon0, lat0], metresPerDegree=[metres_lon, metres_lat], west=WEST, north=NORTH,
              span=COVERAGE, interval=.5, drives=drives, contours=contours, globeFix=globe_fix,
              craterFix=crater_fix, waveform=waveform, seconds=round(len(wave)/rate, 5))
(ASSETS / 'survey.js').write_text('const survey = ' + json.dumps(bundle, separators=(',', ':'), allow_nan=False) + ';\n')
print(f"4 drives, {len(contours)} contours, {len(wave)/rate:.3f} s of audio at {rate} Hz, {len(waveform)} bins")
