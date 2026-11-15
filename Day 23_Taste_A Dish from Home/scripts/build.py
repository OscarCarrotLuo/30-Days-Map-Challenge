"""Build the square map plates and the offline sheet.

Run with a cache directory as the sole argument. Requires NumPy, Pillow, pyproj,
Shapely and GeoPandas. The Earth mosaic and fonts come from the series' Day 1
and Day 2 sheets. The two Natural Earth downloads are cached outside the atlas.
"""
import base64
import json
import math
import re
import subprocess
import sys
from html import escape
from pathlib import Path

import geopandas as gpd
import numpy as np
from PIL import Image
from pyproj import Geod, Transformer
from shapely import affinity
from shapely.geometry import LineString, Point, box
from shapely.ops import clip_by_rect

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
DAY_ONE = ROOT.parent / "Day 1_Point_Meteorite Landings" / "assets"
CACHE = Path(sys.argv[1])
CACHE.mkdir(parents=True, exist_ok=True)
SOURCE = "https://www.unhcr.ca/wp-content/uploads/2026/09/UNHCR-Canada-Cookbook-TastesFromHome-English-2026.pdf"
NASA = "https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/"
NATURAL_EARTH = "https://www.naturalearthdata.com/downloads/"
TITLE = "How Does a Dish from Home Reach a Canadian Table?"
STEM = "A Dish from Home_Oscar Luo"
W, H = 1000, 1000
METRES_PER_UNIT = 14_400
RADIUS = 6_371_008.8
GEOD = Geod(a=RADIUS, f=0)
CLIP = box(-1, -1, W + 1, H + 1)


def dataset(file, category, name):
    archive = CACHE / file
    if not archive.exists():
        url = f"https://naturalearth.s3.amazonaws.com/{category}/{name}.zip"
        subprocess.run(["curl", "-fsSL", "--retry", "2", url, "-o", str(archive)], check=True)
    return gpd.read_file(archive)


countries = dataset("countries.zip", "50m_cultural", "ne_50m_admin_0_countries").set_index("ADM0_A3")
cities = dataset("cities.zip", "10m_cultural", "ne_10m_populated_places_simple")
earth = np.asarray(Image.open(DAY_ONE / "world.webp").convert("L"))
stories = json.loads((ROOT / "scripts/stories.json").read_text())


def resolve_place(place):
    if "country" in place:
        record = countries.loc[place["country"]]
        point = Point(record.LABEL_X, record.LABEL_Y)
        assert record.geometry.covers(point), place["name"]
        return (point.x, point.y)
    hits = cities[(cities.name == place["name"]) & (cities.adm0name == place["city_in"])]
    assert len(hits) == 1, place
    return (float(hits.iloc[0].longitude), float(hits.iloc[0].latitude))


class Projection:
    """Spherical azimuthal equidistant, rotated in its own plane."""
    def __init__(self, coordinates, tilt):
        origin, landing = coordinates[0], coordinates[2]
        self.centre = GEOD.npts(*origin, *landing, 1)[0]
        lon, lat = self.centre
        crs = f"+proj=aeqd +lon_0={lon} +lat_0={lat} +R={RADIUS} +units=m"
        self.forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self.inverse = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        a, b = (np.array(self.forward.transform(*p)) for p in [origin, landing])
        direction = b - a if b[0] > a[0] else a - b
        angle = math.radians(tilt) - math.atan2(direction[1], direction[0])
        self.c, self.s = math.cos(angle), math.sin(angle)

    def project(self, lon, lat):
        east, north = self.forward.transform(lon, lat)
        u = (self.c * east - self.s * north) / METRES_PER_UNIT + W / 2
        v = H / 2 - (self.s * east + self.c * north) / METRES_PER_UNIT
        return u, v

    def unproject(self, u, v):
        x = (u - W / 2) * METRES_PER_UNIT
        y = (H / 2 - v) * METRES_PER_UNIT
        return self.inverse.transform(self.c * x + self.s * y, -self.s * x + self.c * y)


def rasterize_map(projection, slug):
    # Inverse-map pixel centres, then bilinearly sample the real global raster.
    factor = 2
    cols = (np.arange(round(W * factor)) + .5) / factor
    rows = (np.arange(round(H * factor)) + .5) / factor
    u, v = np.meshgrid(cols, rows)
    lon, lat = projection.unproject(u, v)
    height, width = earth.shape
    x = (lon + 180) * width / 360 - .5
    y = np.clip((90 - lat) * height / 180 - .5, 0, height - 1)
    left, top = np.floor(x).astype(int), np.floor(y).astype(int)
    dx, dy = x - left, y - top
    right, bottom = (left + 1) % width, np.minimum(top + 1, height - 1)
    left %= width
    upper = earth[top, left] * (1 - dx) + earth[top, right] * dx
    lower = earth[bottom, left] * (1 - dx) + earth[bottom, right] * dx
    result = Image.fromarray(np.rint(upper * (1 - dy) + lower * dy).astype("uint8"))
    exif = Image.Exif()
    exif[270] = "NASA Blue Marble Next Generation, November 2004. " + NASA
    result.save(ASSETS / f"{slug}.webp", quality=91, method=5, exif=exif)


def line_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type in ("LinearRing", "LineString"):
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [part for g in geometry.geoms for part in line_parts(g)]
    return []


def coordinates_path(coords, close=False):
    return "M" + "L".join(f"{x:.2f},{y:.2f}" for x, y in coords) + ("Z" if close else "")


def path_of_lines(geometry):
    return "".join(coordinates_path(g.coords) for g in line_parts(geometry))


def polygons(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    return [p for g in getattr(geometry, "geoms", []) for p in polygons(g)]


def path_of_area(geometry):
    return "".join(coordinates_path(r.coords, True) for p in polygons(geometry)
                   for r in [p.exterior, *p.interiors])


def region_shape(projection, code):
    # Project the full national extent. No capital or inferred town is plotted.
    local = gpd.GeoSeries([countries.loc[code].geometry], crs=4326).to_crs(projection.forward.target_crs).iloc[0]
    c, s, unit = projection.c, projection.s, METRES_PER_UNIT
    transform = [c / unit, -s / unit, -s / unit, -c / unit, W / 2, H / 2]
    screen = affinity.affine_transform(local, transform).simplify(.15, preserve_topology=False)
    assert screen.is_valid and not screen.is_empty
    assert CLIP.covers(screen), f"{code} country outline exceeds the map frame"
    return screen


def project_line(projection, longitude, latitude):
    x, y = projection.project(longitude, latitude)
    coords = np.column_stack((x, y))
    # Azimuthal projections have a discontinuity at the antipode. Never join
    # its two sides and accidentally send a seam across the mapped field.
    cuts = np.flatnonzero(np.linalg.norm(np.diff(coords, axis=0), axis=1) > 220) + 1
    parts = []
    for run in np.split(coords, cuts):
        if len(run) > 1:
            clipped = clip_by_rect(LineString(run), -1, -1, W + 1, H + 1)
            parts.extend(line_parts(clipped.simplify(.14, preserve_topology=False)))
    return parts


def graticule(projection):
    lines = []
    lat = np.linspace(-89.999, 89.999, 721)
    lon = np.linspace(-180, 180, 1441)
    for kind, degrees, lons, lats in (
        [("lon", d, np.full_like(lat, d), lat) for d in range(-180, 180, 15)]
        + [("lat", d, lon, np.full_like(lon, d)) for d in range(-75, 90, 15)]
    ):
        for line in project_line(projection, lons, lats):
            label = f"{abs(degrees)}°" + ((("W" if degrees < 0 else "E") if kind == "lon"
                    else ("S" if degrees < 0 else "N")) if degrees and abs(degrees) != 180 else "")
            lines.append(f'<path data-axis="{kind}" data-value="{label}" d="{path_of_lines(line)}"/>')
    return "".join(lines)


def border_point(line, area):
    # The line starts in the named country. Walk to its first exit and bisect
    # that small interval so the dash joins the outline rather than a centroid.
    length = line.length
    previous = 0
    for distance in np.linspace(0, length, 240)[1:]:
        if area.covers(line.interpolate(distance)):
            previous = distance
            continue
        lo, hi = previous, distance
        for _ in range(23):
            mid = (lo + hi) / 2
            if area.covers(line.interpolate(mid)):
                lo = mid
            else:
                hi = mid
        return line.interpolate((lo + hi) / 2)
    raise ValueError("The connection did not exit its country extent")


def connection(projection, a, b, start_area, end_area):
    lonlat = [a, *GEOD.npts(*a, *b, 100), b]
    lon, lat = np.array(lonlat).T
    x, y = projection.project(lon, lat)
    line = LineString(np.column_stack([x, y]))
    first = border_point(line, start_area) if start_area is not None else Point(line.coords[0])
    last = border_point(LineString(line.coords[::-1]), end_area) if end_area is not None else Point(line.coords[-1])
    lo, hi = line.project(first), line.project(last)
    keep = [p for p in line.coords if lo < line.project(Point(p)) < hi]
    line = LineString([first.coords[0], *keep, last.coords[0]])
    return path_of_lines(line.simplify(.075))


def plotting_label(place, number, x, y, area):
    lx, ly, align = place["label"]
    ax, ay = x, y
    if area is not None:
        leader = LineString([(x, y), (lx, ly)])
        if not area.covers(Point(lx, ly)):
            edge = border_point(leader, area)
            ax, ay = edge.x, edge.y
    kind = "country" if area is not None else "city"
    label = escape(place["name"])
    return (f'<g class="annotation" data-index="{number}" data-kind="{kind}" data-x="{x:.2f}" data-y="{y:.2f}" '
            f'data-ax="{ax:.2f}" data-ay="{ay:.2f}" data-lx="{lx}" data-ly="{ly}" data-align="{align}">'
            f'<path class="leader"/><text class="map-label" text-anchor="{align}">'
            f'<tspan class="long-name">{label}</tspan></text></g>')


def figure(story):
    points = story["places"]
    coords = [resolve_place(p) for p in points]
    projection = Projection(coords, story["tilt"])
    slug = story["id"]
    rasterize_map(projection, slug)
    regions, marks, labels, connections = [], [], [], []
    for index, (place, coord) in enumerate(zip(points, coords)):
        x, y = projection.project(*coord)
        assert 0 < x < W and 0 < y < H
        area = region_shape(projection, place["country"]) if "country" in place else None
        regions.append(area)
        if area is not None:
            marks.append(f'<path class="region-mark" data-index="{index}" d="{path_of_area(area)}"/>')
        else:
            marks.append(f'<g class="city-mark" data-index="{index}" transform="translate({x:.2f} {y:.2f})">'
                         '<circle class="point-case" r="4"/><circle class="point-core" r="3"/></g>')
        labels.append(plotting_label(place, index, x, y, area))
    for i in range(len(coords) - 1):
        d = connection(projection, coords[i], coords[i + 1], regions[i], regions[i + 1])
        connections.append(f'<path class="link-case" d="{d}"/><path class="connection" d="{d}"/>')
        # A small directional mark belongs on the long leg, never between nearly
        # coincident towns. The full sequence is also printed in each register.
        if i == 1:
            path = LineString([tuple(map(float, pair.split(","))) for pair in d[1:].split("L")])
            mid = path.interpolate(.50, normalized=True)
            next_pos = path.interpolate(.505, normalized=True)
            angle = math.degrees(math.atan2(next_pos.y - mid.y, next_pos.x - mid.x))
            connections.append(f'<g transform="translate({mid.x:.2f} {mid.y:.2f}) rotate({angle:.2f})">'
                               '<path class="direction" d="M-6,-3.4L3,0L-6,3.4Z"/></g>')
    extent = f'viewBox="0 0 {W} {H}"'
    # Screen-space annotation and frame axes are set by sheet.js at every zoom.
    return f'''<figure class="plate" aria-label="{story['name']}’s map">
      <div class="map" role="region" tabindex="0" aria-label="Explore {story['name']}’s map" aria-describedby="map-help">
        <svg class="drawing" {extent} aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <defs><clipPath id="clip-{slug}"><rect width="{W}" height="{H}"/></clipPath></defs>
          <g clip-path="url(#clip-{slug})">
            <g class="geography"><image href="assets/{slug}.webp" width="{W}" height="{H}"/>
              <g class="graticule">{graticule(projection)}</g>
              <g class="connections">{''.join(connections)}</g>
              <g class="marks">{''.join(marks)}</g>
            </g>
            <g class="annotations">{''.join(labels)}</g>
          </g>
          <g class="axes"></g>
        </svg>
      </div>
    </figure>'''


def register(story):
    rows = []
    for i, p in enumerate(story["places"]):
        kind = "country" if "country" in p else "city"
        name = escape(p["name"])
        rows.append(f'<tr data-index="{i}"><td><button type="button" aria-label="Locate {name}, {kind}" '
                    f'aria-pressed="false"><span class="order">{i + 1}</span>{name}</button></td>'
                    f'<td>{escape(p["detail"])}</td></tr>')
    return f'''<div class="register"><table aria-label="{story['name']}’s places in story order">
      
      <thead><tr><th scope="col">Place</th><th scope="col">Story detail</th></tr></thead>
      <tbody>{''.join(rows)}</tbody></table></div>'''


def references(story):
    links = []
    for page_range in story["pages"].split(", "):
        page = int(page_range.split("–")[0]) // 2 + 1
        label = ("Cookbook pp. " if not links else "") + page_range
        links.append(f'<a href="{SOURCE}#page={page}">{label}</a>')
    source = ", ".join(links)
    if "interview" in story:
        source += f' · <a href="{story["interview"]}">Aya’s interview</a>'
    return source


def narrative(story, poster=False):
    heading = f'{story["name"]} · {story["dish"]}' if poster else story["dish"]
    return f'''<section class="story" aria-label="{story['name']}’s family memory">
      <h2>{heading}</h2><p class="memory">{escape(story["memory"])}</p>
      <p class="reference">{references(story)}</p></section>'''


def contributor_index():
    rows = []
    for i, story in enumerate(stories):
        current = ' aria-current="true"' if i == 0 else ''
        rows.append(f'<tr><td><a href="#{story["id"]}"{current}>{story["name"]}</a></td><td>{story["dish"]}</td></tr>')
    return ('<nav class="chooser" aria-label="Choose a contributor"><table><caption>Index of contributors</caption>'
            '<thead><tr><th scope="col">Contributor</th><th scope="col">Dish</th></tr></thead><tbody>'
            + "".join(rows) + '</tbody></table></nav>')


def account(story):
    return f'''<article class="account" data-id="{story['id']}" data-name="{story['name']}" aria-label="{story['name']}">
      {figure(story)}<div class="print-note">{narrative(story, True)}</div></article>'''


def marginalia(story):
    return f'''<div class="story-notes" data-id="{story['id']}">
      {narrative(story)}<details><summary>Places in story order</summary>{register(story)}</details></div>'''


maps = "".join(account(s) for s in stories)
notes = "".join(marginalia(s) for s in stories)
html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#ffffff"><title>{TITLE} · Day 23, Taste · Peirong Luo Oscar</title>
  <link rel="icon" href="data:,"><link rel="stylesheet" href="sheet.css"><script defer src="sheet.js"></script></head>
<body><main class="sheet" aria-label="Day 23, Taste. {TITLE}">
  <p class="sr-only" id="map-help">Choose a contributor in the index. Choose a place on the map or open Places in story order for a closer view. Drag or use the arrow keys to pan a magnified map. Plus and minus zoom. Home restores the map.</p>
  <div class="composition"><div class="plates">{maps}</div><aside class="rail" aria-label="Map notes">
    <div class="measurement"><h3>Kilometres at map centre</h3><svg class="scale" aria-hidden="true"></svg></div>
    <div class="note-grid"><div class="narratives">{notes}</div>{contributor_index()}</div>
    <div class="symbols"><span><i class="city-key"></i>City</span><span><i class="country-key"></i>Country extent</span><span><i class="link-key"></i>Schematic connection</span></div>
    <div class="sources"><a href="{SOURCE}">UNHCR Canada · Tastes from Home</a> / <a href="{NASA}">NASA Blue Marble</a> / <a href="{NATURAL_EARTH}">Natural Earth</a></div>
    <footer class="colophon"><h1>{TITLE}</h1><p>Peirong Luo Oscar</p></footer>
  </aside></div><output class="sr-only" id="status" aria-live="polite"></output></main></body></html>
'''
(ROOT / "index.html").write_text(html)


def embed(relative, mime):
    data = base64.b64encode((ROOT / relative).read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def pack():
    css = (ROOT / "sheet.css").read_text()
    css = re.sub(r'url\("(assets/[^"]+\.ttf)"\)', lambda m: 'url("' + embed(m[1], "font/ttf") + '")', css)
    packed = html.replace('<link rel="stylesheet" href="sheet.css">', '<style>' + css + '</style>')
    packed = packed.replace('<script defer src="sheet.js"></script>', '')
    packed = re.sub(r'href="(assets/[^"]+\.(webp|png))"', lambda m: 'href="' + embed(m[1], "image/" + m[2]) + '"', packed)
    licence = (ASSETS / "fonts/barlow-license.txt").read_text()
    script = (ROOT / "sheet.js").read_text()
    packed = packed.replace("</body>", f'<script type="text/plain" id="font-license">{licence}</script>'
                            f'<script>{script}</script></body>')
    (ROOT / f"{STEM}.html").write_text(packed)


pack()
