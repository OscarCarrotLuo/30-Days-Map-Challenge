"""Build the chart data and monochrome sky images from the archived source tables.

Run with Python, numpy, Pillow, OpenEXR and shapely. Supply a cache directory
to reuse the downloads. Delete a cached input to refresh it.
"""
import argparse
import csv
import io
import json
import math
import subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import numpy as np
import OpenEXR
from PIL import Image
from shapely import contains_xy, make_valid
from shapely.geometry import Polygon
from shapely.ops import unary_union


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
BORESIGHT = (290 + 2/3, 44.5)
PLANET_QUERY = ("select pl_name,hostname,ra,dec,disc_facility,discoverymethod,disc_year "
                "from pscomppars order by hostname,pl_name")
STAR_NAMES = ("Deneb", "Sadr", "Vega", "Albireo", "Sheliak", "Sulafat", "Aladfar",
              "Rasalhague", "Altair", "Polaris", "Sirius", "Antares", "Alderamin", "Tarazed")
STAR_QUERY = ("SELECT ident.id,basic.ra,basic.dec FROM ident JOIN basic ON ident.oidref=basic.oid "
              "WHERE ident.id IN (" + ",".join(f"'NAME {name}'" for name in STAR_NAMES) + ")")
MAST = "https://archive.stsci.edu/missions/kepler/ffi_footprints/morc_2_ra_dec_4_seasons.txt"
SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_16k.exr"
TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
SIMBAD = "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync"


def cached(directory, name, url):
    path = directory / name
    if not path.exists():
        tmp = path.with_suffix(".download")
        subprocess.run(["curl", "-fsSL", "--retry", "2", "--max-time", "300",
                        url, "-o", str(tmp)], check=True)
        tmp.replace(path)
    return path


def tangent(ra, dec):
    """Project coordinates gnomonically at the Kepler boresight; east is positive."""
    ra0, dec0 = np.deg2rad(BORESIGHT)
    ra, dec = np.deg2rad(ra), np.deg2rad(dec)
    dh = ra - ra0
    cosc = np.sin(dec0)*np.sin(dec) + np.cos(dec0)*np.cos(dec)*np.cos(dh)
    return (np.cos(dec)*np.sin(dh)/cosc,
            (np.cos(dec0)*np.sin(dec) - np.sin(dec0)*np.cos(dec)*np.cos(dh))/cosc)


def sphere_vectors(coords):
    """Invert the tangent plane into unit vectors in the boresight basis."""
    xy = np.asarray(coords)
    xyz = np.column_stack([xy, np.ones(len(xy))])
    return xyz / np.linalg.norm(xyz, axis=1)[:, None]


def signed_solid_angle(ring):
    v = sphere_vectors(ring.coords)
    a, b, c = v[0], v[1:-1], v[2:]
    det = np.cross(b, c) @ a
    den = 1 + b @ a + c @ a + (b*c).sum(axis=1)
    return float(2*np.arctan2(det, den).sum())


def union_area(geometry):
    """Compute square degrees, subtracting detector gaps and interior holes."""
    pieces = [geometry] if geometry.geom_type == "Polygon" else geometry.geoms
    steradians = sum(abs(signed_solid_angle(p.exterior))
                     - sum(abs(signed_solid_angle(r)) for r in p.interiors) for p in pieces)
    return steradians * (180 / math.pi)**2


def footprint(path):
    # The central pixel in each output is an orientation check, not a fifth corner.
    table = np.loadtxt(path, skiprows=4)
    channels = defaultdict(dict)
    for module, output, row, col, *coords in table:
        if row != 535:
            channels[int(module), int(output)][int(row), int(col)] = coords
    order = [(25, 17), (25, 1106), (1038, 1106), (1038, 17)]
    if len(channels) != 84 or any(set(corners) != set(order) for corners in channels.values()):
        raise ValueError("Unexpected layout of the MAST science-channel table")
    polygons = []
    spring = []
    for (module, output), corners in sorted(channels.items()):
        for season in range(4):  # The fifth pair repeats spring.
            radec = np.array([corners[key][2*season:2*season+2] for key in order])
            x, y = tangent(*radec.T)
            polygons.append(Polygon(np.column_stack([x, y])))
            if season == 0:
                spring.append([module, output, radec.tolist()])
    return spring, make_valid(unary_union(polygons))


def build_catalogue(directory):
    planet_url = TAP + "?" + urlencode({"query": PLANET_QUERY, "format": "csv"})
    planets_path = cached(directory, "planets.csv", planet_url)
    planets = list(csv.DictReader(io.StringIO(planets_path.read_text())))
    spring, union = footprint(cached(directory, "footprint.txt", MAST))
    simbad_url = SIMBAD + "?" + urlencode({"query": STAR_QUERY, "request": "doQuery",
                                         "lang": "adql", "format": "csv"})
    stars_path = cached(directory, "navigation-stars.csv", simbad_url)
    stars = [[s["id"].removeprefix("NAME "), float(s["ra"]), float(s["dec"])]
             for s in csv.DictReader(io.StringIO(stars_path.read_text()))]
    if len({p["pl_name"] for p in planets}) != len(planets):
        raise ValueError("Composite table must have one row per planet")
    if not planets or not all(p["hostname"] and p["ra"] and p["dec"] for p in planets):
        raise ValueError("Missing host or sky position in this archive release")
    facilities = sorted({p["disc_facility"] for p in planets})
    methods = sorted({p["discoverymethod"] for p in planets})
    systems = defaultdict(list)
    for p in planets:
        systems[p["hostname"]].append(p)
    hosts, inside_planets, inside_hosts, kepler_hosts = [], 0, 0, 0
    for name, members in systems.items():
        positions = {(float(p["ra"]), float(p["dec"])) for p in members}
        if len(positions) != 1:
            raise ValueError(f"Disagreeing host coordinates for {name}")
        ra, dec = positions.pop()
        # The gnomonic projection has a second, antipodal branch. Only project
        # the neighborhood containing every measured detector corner.
        inside = 275 < ra < 310 and 34 < dec < 55 and bool(contains_xy(union, *tangent(ra, dec)))
        inside_planets += len(members) if inside else 0
        inside_hosts += int(inside)
        kepler_hosts += any(p["disc_facility"] == "Kepler" for p in members)
        entries = [[p["pl_name"], facilities.index(p["disc_facility"]), methods.index(p["discoverymethod"]),
                    int(p["disc_year"])] for p in members]
        hosts.append([name, round(ra, 7), round(dec, 7), int(inside), entries])
    area = union_area(union)
    stats = dict(planets=len(planets), hosts=len(hosts), inField=inside_planets, hostsInField=inside_hosts,
                 area=area, skyPercent=area/(4*math.pi*(180/math.pi)**2)*100,
                 archivePercent=100*inside_planets/len(planets), keplerHosts=kepler_hosts,
                 keplerPlanets=sum(p["disc_facility"] == "Kepler" for p in planets))
    # Timestamp the cached catalogue itself so a later offline rebuild keeps its vintage.
    date = datetime.fromtimestamp(planets_path.stat().st_mtime, ZoneInfo("America/New_York")).date().isoformat()
    data = dict(date=date, stats=stats, boresight=BORESIGHT, facilities=facilities, methods=methods,
                stars=stars, spring=spring, hosts=hosts)
    (ASSETS / "catalogue.js").write_text("window.CELESTIAL_SURVEY=" +
                                         json.dumps(data, ensure_ascii=True, separators=(",", ":")) + ";\n")
    print(json.dumps(stats, indent=2))


def build_atlas(directory):
    path = cached(directory, "starmap_2020_16k.exr", SVS)
    source = OpenEXR.File(str(path))
    rgb = source.channels()["RGB"].pixels
    height, width = rgb.shape[:2]
    # Work in strips. Retain relative stellar brightness, compressing the HDR
    # catalogue to ink values that leave the white host marks legible.
    grey = np.empty((height, width), dtype=np.uint8)
    for j in range(0, height, 128):
        patch = rgb[j:j+128].astype(np.float32)
        lum = patch @ np.array([.2126, .7152, .0722], dtype=np.float32)
        grey[j:j+128] = np.rint(12 + 221*np.minimum(np.arcsinh(110*lum)/np.arcsinh(110), 1))
    atlas = Image.fromarray(grey)
    atlas.resize((4096, 2048), Image.Resampling.LANCZOS).save(ASSETS / "sky.webp", quality=92, method=6)
    # Exact pixel boundaries in the equatorial source; see the chart's asset
    # bounds for inverse mapping. Left edge is larger RA in a view of the sky.
    bounds = (10048, 1024, 12800, 3136)
    atlas.crop(bounds).save(ASSETS / "cygnus.webp", quality=97, method=6)
    coords = [((.5-bounds[i]/width)*360) % 360 for i in (0, 2)]
    print("High-resolution crop RA/Dec edges", coords, [90-bounds[i]/height*180 for i in (1, 3)])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    build_catalogue(args.cache)
    build_atlas(args.cache)
