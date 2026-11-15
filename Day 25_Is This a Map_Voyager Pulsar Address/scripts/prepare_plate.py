"""Rebuild the registered cover photograph and the 14 radial engravings.

Run with Pillow installed. Supply --cache DIR to reuse the downloaded originals.
The periods are rounded H-cycle counts from Sagan, Sagan & Drake (1972),
Table 1, https://doi.org/10.1126/science.175.4024.881. The plaque and cover
use the same 1970/71 pulsar measurements. Mark orientations below are read
from the drawing and checked against those counts in outward reading order.
"""
import argparse
import json
import math
import re
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageOps

ASSETS = Path(__file__).resolve().parents[1] / 'assets'
PHOTO = 'https://science.nasa.gov/wp-content/uploads/2024/03/voyager-record-cover-446eb9.jpg'
DRAWING = 'https://upload.wikimedia.org/wikipedia/commons/e/ed/Voyager_Golden_Record_Cover_Explanation.svg'
# Path indices in the public-domain Pulsars group of the 2015 cover drawing.
# J. Taylor et al.'s B1950 names are used on the plate, including B0329+54
# (labelled 0328 in Table 1). Each slice includes its non-period drafting marks.
RAYS = [
    ('B1642−03', 550675372, 219, 251), ('B1929+10', 321746104, 284, 314),
    ('B1933+16', 509549854, 34, 65),   ('B2016+28', 792520205, 251, 284),
    ('B2217+47', 764842161, 97, 129),  ('B0329+54', 1014906390, 2, 34),
    ('B0525+21', 5320116676, 409, 444), ('B0531+21', 47057538, 162, 190),
    ('B0823+26', 753751947, 376, 409), ('B0950+08', 359455043, 346, 376),
    ('B0833−45', 126726823, 190, 219), ('B1240−64', 551117432, 65, 97),
    ('B1451−68', 374101871, 314, 346), ('B1727−47', 1178486506, 129, 162),
]
# A single affine registration of the NASA/JPL photograph to the drawing.
# The unaltered axis aspect is retained in the redrawn geometry. The field
# spans 1.46 times the length of the cover's Galactic-centre baseline.
ORIGIN = (261.943, 434.715)
BASE = 472.121 - ORIGIN[0]
SUN = (291.0, 524.0)
SCALE = 1000 / (1.46 * BASE)
PHOTO_ORIGIN = (778.605485, 1700.69300)
MATRIX = (4.42536859, 0.0317693176, 0.0435286434, 4.37407750)


def source(cache, fname, url):
    path = cache / fname
    if not path.is_file():
        req = urllib.request.Request(url, headers={'User-Agent': 'VoyagerPulsarPlate/1.0'})
        with urllib.request.urlopen(req, timeout=45) as response:
            path.write_bytes(response.read())
    return path


def polyline_groups(d):
    """The source uses absolute moves with relative straight segments only."""
    groups = []
    x = y = 0
    for part in re.findall(r'[A-Za-z][^A-Za-z]*', d):
        cmd = part[0]
        values = list(map(float, re.findall(r'[-+]?(?:\d*\.\d+|\d+)', part[1:])))
        if cmd == 'M':
            x, y = values
            groups.append([])
        elif cmd == 'l':
            dx, dy = values
            x, y = x + dx, y + dy
        elif cmd == 'h':
            x += values[0]
        elif cmd == 'v':
            y += values[0]
        else:
            raise ValueError(f'Unexpected path command {cmd!r}')
        groups[-1].append((x, y))
    return groups


def field(point):
    return tuple(round(center + (value - origin) * SCALE, 2)
                 for value, origin, center in zip(point, ORIGIN, SUN))


def distance(p):
    return math.dist(p, ORIGIN)


def take_ray(source_paths, count):
    strokes, symbols, vertices = [], [], []
    for path_index, element in enumerate(source_paths):
        groups = polyline_groups(element.attrib['d'])
        for points in groups:
            vertices.extend(points)
            strokes.append((path_index, points))
        if len(groups) != 1:
            continue
        a, b = groups[0][0], groups[0][-1]
        length = math.dist(a, b)
        center = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if length > 1.65:
            continue
        # A long principal stroke and a displaced height tick can adjoin
        # the bit string. Direction plus the published count identifies the run.
        projection = abs(sum((b[i] - a[i]) * (center[i] - ORIGIN[i]) for i in (0, 1)))
        digit = int(projection / (length * distance(center)) < 0.5)
        symbols.append((distance(center), digit, path_index, center))
    symbols.sort()
    expected = format(count, 'b')
    encoded = ''.join(str(s[1]) for s in symbols)
    if encoded.count(expected) != 1:
        raise ValueError(f'Published word not uniquely present in engraving: {count}')
    start = encoded.index(expected)
    word = symbols[start:start + len(expected)]
    word_indices = {s[2] for s in word}
    selected, structure = [], []
    for index, points in strokes:
        p = [field(p) for p in points]
        command = 'M' + ' '.join(f'{x:g},{y:g}' for x, y in p)
        (selected if index in word_indices else structure).append(command)
    tip = field(max(vertices, key=distance))
    return dict(tip=tip, word=''.join(selected), structure=''.join(structure),
                bitCenters=[field(s[3]) for s in word])


def prepare(cache):
    cache.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(exist_ok=True)
    root = ET.parse(source(cache, 'explanation.svg', DRAWING)).getroot()
    paths = list(root.find('.//*[@id="Pulsars"]'))
    if len(paths) != 444:
        raise ValueError('Unexpected edition of the source drawing')
    rays = []
    for name, count, first, last in RAYS:
        ray = take_ray(paths[first:last], count)
        # Only the worked ray needs per-mark positions at runtime.
        if name != 'B0833−45':
            del ray['bitCenters']
        rays.append(dict(name=name, count=count, **ray))
    data = dict(origin=SUN, baselineEnd=field((472.121, ORIGIN[1])), rays=rays)
    (ASSETS / 'engraving.js').write_text('const ENGRAVING = ' + json.dumps(data, ensure_ascii=False, indent=2) + ';\n')

    original = Image.open(source(cache, 'cover.jpg', PHOTO)).convert('L')
    if original.size != (2389, 2389):
        raise ValueError('Unexpected dimensions for the NASA photograph')
    a, b, d, e = MATRIX
    side = 1600
    k = 1000 / (side * SCALE)
    ox = PHOTO_ORIGIN[0] - (a * SUN[0] + b * SUN[1]) / SCALE
    oy = PHOTO_ORIGIN[1] - (d * SUN[0] + e * SUN[1]) / SCALE
    crop = original.transform((side, side), Image.Transform.AFFINE,
                              (a*k, b*k, ox, d*k, e*k, oy), Image.Resampling.BICUBIC)
    # Hold photographic highlights below the overprinted white linework.
    crop.point(lambda v: round(19 + .67 * v)).save(ASSETS / 'cover-field.webp', quality=88, method=6)
    overview = ImageOps.autocontrast(original, cutoff=.2).resize((260, 260), Image.Resampling.LANCZOS)
    overview.save(ASSETS / 'cover-locator.webp', quality=86)
    # Fractions of the full photograph locate the map origin in the margin figure.
    print(f'14 binary words verified; photograph origin at {PHOTO_ORIGIN[0]/2389:.5f}, {PHOTO_ORIGIN[1]/2389:.5f}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as temp:
        prepare(args.cache if args.cache else Path(temp))
