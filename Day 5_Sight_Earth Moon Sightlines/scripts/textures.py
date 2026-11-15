"""Prepare Blue Marble and the small global rasters used by the locator globes.
Requires Pillow. The lunar mosaic in assets/moon.webp comes from the Day 2 plate.
"""
import base64
import json
import sys
from pathlib import Path
from urllib.request import urlretrieve

from PIL import Image

root = Path(__file__).resolve().parents[1] / 'assets'
url = ('https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/'
       'bmng-topography-bathymetry/november/world.topo.bathy.200411.3x5400x2700.jpg')
cache = Path(sys.argv[1])
cache.mkdir(parents=True, exist_ok=True)
photo = cache / 'blue-marble.jpg'
if not photo.exists():
    urlretrieve(url, photo)
image = Image.open(photo).resize((3600, 1800), Image.Resampling.LANCZOS)
image = image.convert('L', (.32, .46, .22, 0))
# Preserve bathymetric contrast in the deep ocean without clipping snow and ice.
stops = [(0,15), (8,31), (16,51), (28,75), (45,101), (65,125), (97,153),
         (140,181), (190,204), (237,220), (255,228)]
curve = []
for (x0, y0), (x1, y1) in zip(stops, stops[1:]):
    curve.extend(round(y0 + (v-x0)*(y1-y0)/(x1-x0)) for v in range(x0,x1))
image.point(curve + [stops[-1][1]]).save(root/'earth.webp', quality=90, method=5)

# Plain grayscale arrays are readable from file:// even where browsers isolate
# local image origins. Both globes can be reprojected without canvas readback.
textures = {}
for body in ['earth', 'moon']:
    small = Image.open(root/f'{body}.webp').convert('L').resize((360,180),Image.Resampling.LANCZOS)
    textures[body] = base64.b64encode(small.tobytes()).decode()
(root/'locator-textures.js').write_text('window.locatorTextures = ' + json.dumps(textures) + ';\n')
