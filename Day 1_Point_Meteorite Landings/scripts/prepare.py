"""Build the plotted catalogue and registered rasters. Requires Pillow and NumPy."""
import csv
import json
import sys
from pathlib import Path
from urllib.request import urlretrieve

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
CACHE = Path(sys.argv[1])
CACHE.mkdir(parents=True, exist_ok=True)
SOURCES = {
    'landings.csv': 'https://data.nasa.gov/docs/legacy/meteorite_landings/Meteorite_Landings.csv',
    'blue-marble.jpg': 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/november/world.topo.bathy.200411.3x5400x2700.jpg',
}
for filename, url in SOURCES.items():
    if not (CACHE / filename).exists():
        urlretrieve(url, CACHE / filename)

# Each row keeps the catalogue ID. Several distinct meteorites can share coordinates.
featured = ['Allende', 'Chelyabinsk', 'Hoba', 'Murchison', 'Tissint', 'Campo del Cielo',
            'Allan Hills 84001', 'Tagish Lake', 'Sikhote-Alin', 'Ensisheim', 'Yamato 000593',
            'Bendegó', 'Orgueil', 'Abee', 'Peekskill', 'Sylacauga']
rank = {name: i for i, name in enumerate(featured)}
rows = []
with (CACHE / 'landings.csv').open(encoding='utf-8-sig', newline='') as source:
    for row in csv.DictReader(source):
        if row['nametype'] != 'Valid' or not row['reclat'] or not row['reclong']:
            continue
        lat, lon = float(row['reclat']), float(row['reclong'])
        if (lat, lon) == (0, 0) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        mass = float(row['mass (g)']) if row['mass (g)'] else None
        if mass is not None and mass.is_integer():
            mass = int(mass)
        rows.append([row['name'], lat, lon, int(row['fall'] == 'Fell'), row['year'],
                     row['recclass'], mass, int(row['id'])])
rows.sort(key=lambda row: (rank.get(row[0], len(rank)), row[0].casefold(), row[-1]))
(ASSETS / 'landings.js').write_text('window.METEORITES=' + json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + ';\n')
print('Mapped records:', len(rows), 'observed falls:', sum(row[3] for row in rows))

# Blue Marble is plate carrée: 360° by 180°, with equal pixel spacing per degree.
im = Image.open(CACHE / 'blue-marble.jpg').convert('L', (.32, .46, .22, 0))
levels = [(0, 27), (8, 42), (16, 63), (28, 83), (45, 102), (65, 123), (97, 145),
          (140, 167), (190, 189), (237, 204), (255, 215)]
im = im.point(np.interp(np.arange(256), *zip(*levels)).round().astype(np.uint8).tolist())
assert im.width == 2 * im.height, 'Expected a global 2:1 plate carrée raster'
im.save(ASSETS / 'world.webp', quality=90, method=5)

# Locator images use an orthographic equatorial view of each hemisphere.
diameter = 200
v = 2*(np.arange(diameter)+.5)/diameter-1
x, y = np.meshgrid(v, -v)
r2 = x*x+y*y
z = np.sqrt(np.maximum(0, 1-r2))
lat = np.degrees(np.arcsin(y))
for side_name, central_meridian in [('west', -90), ('east', 90)]:
    lon = central_meridian + np.degrees(np.arctan2(x, z))
    col = (((lon+180)/360*im.width).astype(int)) % im.width
    row = np.clip(((90-lat)/180*im.height).astype(int), 0, im.height-1)
    rgba = np.zeros((diameter, diameter, 4), dtype=np.uint8)
    rgba[:, :, :3] = np.asarray(im)[row, col, None]
    rgba[:, :, 3] = np.clip((1 - np.sqrt(r2)) * diameter/2 + .5, 0, 1)*255
    Image.fromarray(rgba).save(ASSETS / (side_name+'.png'))
