"""Generalize the original CAD vectors and measure access on the January 2018 sheet.

Requires PyMuPDF and Shapely 2. Optional positional arguments are local copies of
the UNHCR PDF and the Natural Earth GeoJSON. Output is used by both editions.
"""
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.request import urlopen

import pymupdf
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, unary_union


ROOT = Path(__file__).resolve().parents[1]
PLAN_URL = "https://data.unhcr.org/en/documents/download/74221"
NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_admin_0_countries.geojson"
PLAN_SHA = "4f4a0e34cf20139c0749046f95fefc28330b4f8a6dcef9ed852f74cdc2c4d4b1"
# Page points, measured from the top left. Four black/white scale divisions
# place 0 and 4 km at these x coordinates on the original page.
METRES_PER_POINT = 4000 / (495.6017150878906 - 314.9239501953125)
# A square cut from the original plan, centred on the twelve Yangani villages.
BBOX = (439.5, 1423.5, 607.5, 1591.5)
# x/y of 31.30°E, 3.35°N on the printed graticule, then point spacing per degree.
GRID = (517.73, 1416.85, 5033.6)
SITE = (492.2, 1476.8)
# PDF paint sequence IDs identify the symbols in this exact edition. The two
# CFS pictograms share the primary-school shape but have a different label.
FACILITIES = [
    ("health", "Yangani Health Centre", [52132]),
    ("cfs", "Child-friendly space", range(49738, 49743)),
    ("cfs", "Child-friendly space", range(49743, 49748)),
    ("recreation", "Recreation facility", [9111]),
    ("recreation", "Recreation facility", [9119]),
]


def read_source(index, url):
    if len(sys.argv) > index:
        return Path(sys.argv[index]).read_bytes()
    with urlopen(url, timeout=120) as response:
        return response.read()


def rgb(c):
    return tuple(round(channel * 255) for channel in c) if c else None


def coordinates(coords):
    return [[round(x, 3), round(y, 3)] for x, y in coords]


def residential_outline(page):
    # The original Yangani crosshatch is clipped to the residential space, with
    # a separate hole for host land. Recover its exact two even-odd subpaths.
    stream = page.read_contents()
    hatch = stream.index(b"1 0.4 1 RG")
    clip = stream.rindex(b"W*\rn", 0, hatch)
    i = clip
    path = []
    while i:
        previous = stream.rfind(b"\r", 0, i - 1) + 1
        match = re.fullmatch(rb"([\d.]+) ([\d.]+) ([ml])", stream[previous:i - 1])
        if not match:
            break
        x, y, op = match.groups()
        path.append((float(x) * 2.83465, float(y) * 2.83465, op))
        i = previous
    rings = []
    for x, y, op in reversed(path):
        if op == b"m":
            rings.append([])
        rings[-1].append((x, y))
    assert len(rings) == 2
    polygon = Polygon(rings[0], rings[1:])
    assert polygon.is_valid and 460 < polygon.bounds[0] < 462
    return polygon


def plan_linework(drawings):
    layers = defaultdict(list)
    villages = []
    symbols = {}
    region = box(*BBOX)
    wanted = set(range(47133, 47138)) | set(range(52138, 52143))
    for _, _, ids in FACILITIES:
        wanted.update(ids)
    for d in drawings:
        r = d["rect"]
        if d["seqno"] in wanted:
            symbols[d["seqno"]] = tuple(r)
        # Include zero-width and zero-height paths when filtering the page.
        if r.x1 < BBOX[0] or r.x0 > BBOX[2] or r.y1 < BBOX[1] or r.y0 > BBOX[3]:
            continue
        color, fill = rgb(d["color"]), rgb(d["fill"])
        if fill == (255, 250, 140) and 7 < r.width < 8 and 7 < r.height < 8:
            villages.append(((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))
        if color == (153, 153, 153) and d["width"] < .4:
            # Omit printed graticule dashes; responsive axes share their control points.
            if (r.width < .001 and 2.6 < r.height < 2.8) or (r.height < .001 and 2.6 < r.width < 2.8):
                continue
            key = "contours"
        elif color == (128, 64, 64):
            key = "roads"
        elif color == (64, 165, 255):
            key = "streams"
        elif color == (0, 0, 0) and .70 < d["width"] < .72:
            key = "blocks"
        else:
            continue
        for item in d["items"]:
            if item[0] != "l":
                continue
            ends = coordinates(item[1:])
            if ends[0] != ends[1]:
                layers[key].append(LineString(ends))
    drawing = {}
    for key, segments in layers.items():
        # CAD draws many segments twice. Dissolve them before exporting at print size.
        merged = unary_union(segments).intersection(region)
        if merged.geom_type == "MultiLineString":
            merged = linemerge(merged)
        parts = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
        drawing[key] = [coordinates(p.simplify(.075).coords) for p in parts
                        if p.geom_type == "LineString" and p.length > .11]
    return drawing, villages, symbols


def symbol_center(symbols, ids):
    parts = [symbols[i] for i in ids]
    return [(min(r[0] for r in parts) + max(r[2] for r in parts)) / 2,
            (min(r[1] for r in parts) + max(r[3] for r in parts)) / 2]


def village_rows(page, centres, schools):
    rows = []
    for x0, y0, x1, y1, text, *_ in page.get_text("words", clip=pymupdf.Rect(*BBOX)):
        match = re.fullmatch(r"V(1[0-2]|[1-9])", text)
        if not match:
            continue
        label_center = ((x0 + x1) / 2, (y0 + y1) / 2)
        origin = min(centres, key=lambda p: math.dist(p, label_center))
        # Road annotations also mention villages (e.g. "T163 - V4 - V6").
        # Only map text printed inside a village badge identifies an origin.
        if math.dist(origin, label_center) >= 1:
            continue
        old = min(schools, key=lambda s: math.dist(origin, s["xy"]))
        before = math.dist(origin, old["xy"]) * METRES_PER_POINT
        new_distance = math.dist(origin, SITE) * METRES_PER_POINT
        after = min(before, new_distance)
        rows.append(dict(id=int(match[1]), xy=coordinates([origin])[0],
                         school=old["id"], before=round(before, 3),
                         after=round(after, 3), gain=round(before - after, 3)))
    rows.sort(key=lambda v: v["id"])
    assert [v["id"] for v in rows] == list(range(1, 13))
    assert len(set(tuple(v["xy"]) for v in rows)) == len(centres) == 12
    # All other explicitly primary-labelled symbols on the plan are farther
    # away. Kumia to the west is the only one near this search envelope.
    assert max(v["before"] for v in rows) < 2000
    return rows


def closer_land(housing, schools):
    """Intersect residential space with the half-plane closer to SITE than each school."""
    nearer = housing
    for school in schools:
        sx, sy = school["xy"]
        dx, dy = sx - SITE[0], sy - SITE[1]
        length = math.hypot(dx, dy)
        nx, ny = dx / length, dy / length
        mx, my = (sx + SITE[0]) / 2, (sy + SITE[1]) / 2
        reach = max(math.dist((mx, my), corner) for corner in box(*BBOX).exterior.coords) + 1
        a, b = (mx - ny * reach, my + nx * reach), (mx + ny * reach, my - nx * reach)
        nearer = nearer.intersection(Polygon([a, b, (b[0]-nx*reach, b[1]-ny*reach),
                                              (a[0]-nx*reach, a[1]-ny*reach)]))
    return nearer


def printed_details(page, symbols):
    details = []
    facility_parts = dict(symbols)
    for block in page.get_text("dict", flags=0, clip=pymupdf.Rect(*BBOX))["blocks"]:
        for line in block.get("lines", []):
            text = "".join(s["text"] for s in line["spans"]).strip()
            x0, y0, x1, y1 = line["bbox"]
            centre = [round((x0+x1)/2, 3), round((y0+y1)/2, 3)]
            angle = round(math.degrees(math.atan2(line["dir"][1], line["dir"][0])), 2)
            if text == "H" and 507 < x0 < 510 and 1490 < y0 < 1492:
                # The HC icon consists of a vector roof plus a typeset H.
                roof = pymupdf.Rect(facility_parts[52132])
                facility_parts[52132] = tuple(roof | pymupdf.Rect(line["bbox"]))
            elif text in {"Yangani", "Okuyo"}:
                details.append(dict(kind="place", label=text, xy=centre, angle=angle))
            elif text in {"775", "780", "795"} and line["spans"][0]["color"] == 0x6A6A6A:
                details.append(dict(kind="elevation", label=f"{text} m", xy=centre, angle=angle))
            elif text.startswith("Yangane Roads ("):
                details.append(dict(kind="road", label="Yangane Roads", xy=centre, angle=angle))
    # The source prints "Obongi Rd" twice just outside the crop. This in-frame
    # bend is on the same road; interpolate the label along its two drawn edges.
    details.append(dict(kind="road", label="Obongi Rd", xy=[598.24, 1527.05], angle=52.9))
    for kind, name, ids in FACILITIES:
        details.append(dict(kind=kind, label=name, xy=symbol_center(facility_parts, ids)))
    assert sum(d["kind"] == "elevation" for d in details) == 3
    assert sum(d["kind"] == "road" for d in details) == 2
    return details


def main():
    pdf = read_source(1, PLAN_URL)
    if hashlib.sha256(pdf).hexdigest() != PLAN_SHA:
        raise ValueError("The source edition has changed; recheck its symbols and scale.")
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        page = doc[0]
        poly = residential_outline(page)
        layers, centres, symbols = plan_linework(page.get_drawings())
        schools = [
            dict(id="yangani", label="Primary school", xy=symbol_center(symbols, range(52138, 52143))),
            dict(id="kumia", label="Kumia Primary School", xy=symbol_center(symbols, range(47133, 47138))),
        ]
        rows = village_rows(page, centres, schools)
        details = printed_details(page, symbols)
    assert poly.contains(Point(SITE))
    nearer = closer_land(poly, schools)
    assert nearer.is_valid and 0 < nearer.area < poly.area
    assert all(nearer.covers(Point(v["xy"])) == (v["gain"] > 0) for v in rows)
    parts = list(nearer.geoms) if nearer.geom_type == "MultiPolygon" else [nearer]
    # Draw only the equidistance edge; the other edges already belong to the
    # residential outline. A 0.001-point tolerance removes coincident lines.
    change_edge = nearer.boundary.difference(poly.boundary.buffer(.001))
    boundaries = list(change_edge.geoms) if change_edge.geom_type == "MultiLineString" else [change_edge]
    countries = json.loads(read_source(2, NE_URL))
    uganda = next(x for x in countries["features"] if x["properties"]["ADMIN"] == "Uganda")
    data = dict(plan=PLAN_URL, bbox=BBOX, metresPerPoint=METRES_PER_POINT,
                grid=GRID, site=SITE, schools=schools, villages=rows, layers=layers,
                housing=[coordinates(poly.exterior.coords),
                         *[coordinates(r.coords) for r in poly.interiors]],
                closerLand=[coordinates(ring.coords) for part in parts
                            for ring in [part.exterior, *part.interiors]],
                equidistance=[coordinates(line.coords) for line in boundaries if line.length > .01],
                details=details,
                uganda=uganda["geometry"]["coordinates"][0])
    (ROOT / "assets" / "plan.js").write_text(
        "const PLAN = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print("Twelve villages. Changes in metres:", [(v["id"], round(v["gain"])) for v in rows if v["gain"]])


if __name__ == "__main__":
    main()
