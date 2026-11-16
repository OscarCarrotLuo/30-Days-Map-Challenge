"""Build the offline plate data. Run with numpy, scipy, rasterio, Pillow and GDAL.

Usage: python prepare.py [cache directory]. The unmodified archive and georeferenced
raster window stay in the cache. Only the display raster and plate data ship.
"""
import csv
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.gettempdir()) / "moon-zoo-plate"
CACHE.mkdir(parents=True, exist_ok=True)
ASSETS = ROOT / "assets"
ARCHIVE = "https://raw.githubusercontent.com/zooniverse/moonzoodata/3fad914955bdbaca015e6f053dc8ebf2babaa4bc/public/files/MZ_A17_csv_files.zip"
MOSAIC = "https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/EXTRAS/BROWSE/NAC_ROI/APOLLO17LOB/NAC_ROI_APOLLO17LOB_E206N0304.PYR.TIF"
DEG = math.pi * 1737400 / 180
# PDS equirectangular, 20°N standard parallel, 30.2°E central meridian.
EAST = DEG * math.cos(math.radians(20))
# Table 1 in Bugiolacchi et al. (2016), M104311715RE landing module,
# to the LROC landing module control at 30.7723°E, 20.1911°N.
SHIFT_LON = 30.7723 - 30.768
SHIFT_LAT = 20.1911 - 20.195
# (Expert_RB record, Gazetteer feature ID, name). Checked against the Gazetteer's
# current polygons by location and diameter. Only named examples appear in the index.
NAMES = [(32, 984, "Camelot"), (33, 2554, "Horatio"), (8, 5484, "Sherlock"),
         (10, 4814, "Powell"), (2601, 5455, "Shakespeare"), (2600, 1259, "Cochise"),
         (30, 6315, "Van Serg"), (1, 1794, "Emory"), (5, 5698, "Steno-Apollo")]


def read_catalogue(archive, name):
    with archive.open(name) as raw:
        reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"))
        return np.array([[float(row[key].replace(",", "")) for key in ("long", "lat", "radius")]
                         for row in reader])


def overlap(r1, r2, d):
    """Intersection / union of two disks with radii r1 and r2, centres d apart."""
    if d >= r1 + r2:
        return 0.
    if d <= abs(r1 - r2):
        return (min(r1, r2) / max(r1, r2)) ** 2
    alpha = math.acos(np.clip((d*d+r1*r1-r2*r2) / (2*d*r1), -1, 1))
    beta = math.acos(np.clip((d*d+r2*r2-r1*r1) / (2*d*r2), -1, 1))
    lens = r1*r1*alpha + r2*r2*beta - d*r1*math.sin(alpha)
    return lens / (math.pi * (r1*r1+r2*r2) - lens)


def main():
    archive = CACHE / "MZ_A17_csv_files.zip"
    if not archive.exists():
        urllib.request.urlretrieve(ARCHIVE, archive)
    with zipfile.ZipFile(archive) as z:
        expert = read_catalogue(z, "Expert_RB.csv")
        volunteer = read_catalogue(z, "715_871_pre.csv")
    assert (len(expert), len(volunteer)) == (2602, 51597)
    raster = CACHE / "field.tif"
    if not raster.exists():
        subprocess.run(["gdal_translate", "-srcwin", "22227", "34378", "4096", "4096",
                        "/vsicurl/" + MOSAIC, str(raster)], check=True,
                       env={**os.environ, "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR"})
    with rasterio.open(raster) as src:
        pixels = src.read(1)
        left, _, _, top = src.bounds
        pixel_size = src.transform.a
        assert pixels.shape == (4096, 4096) and abs(pixel_size - 1.2) < 1e-8
    # The PDS display product is an 8-bit image. A common tonal curve across
    # the entire crop makes the sunlit walls and the shadow boundary legible.
    lo, hi = np.percentile(pixels, [0.3, 99.85])
    toned = np.clip((pixels.astype(np.float32) - lo) / (hi - lo), 0, 1) ** .79
    Image.fromarray(np.uint8(toned * 237 + 6)).save(ASSETS / "taurus-littrow.webp",
                                                   quality=94, method=6)
    side = pixels.shape[0] * pixel_size

    def project(rows):
        x = (rows[:, 0] + SHIFT_LON - 30.2) * EAST - left
        y = top - (rows[:, 1] + SHIFT_LAT) * DEG
        return np.column_stack([x, y])

    def rings(rows):
        # All published circles that touch the square, including those centered
        # outside it. Do not thin, merge or deduplicate coincident volunteer marks.
        xy = project(rows)
        nearest = np.linalg.norm(xy - np.clip(xy, 0, side), axis=1)
        farthest = np.linalg.norm(np.maximum(abs(xy), abs(xy - side)), axis=1)
        keep = np.where((nearest <= rows[:, 2]) & (farthest >= rows[:, 2]))[0]
        return [[int(i+1), *np.round(xy[i], 3).tolist(), round(float(rows[i, 2]), 5)] for i in keep]

    # Assign a mark to its nearest expert centre only inside half that expert's
    # radius. Deliberately do not filter on diameter or agreement. These matches
    # underlie the register only. Every recorded ring in the crop is displayed.
    local_scale = np.array([DEG * math.cos(math.radians(20.19)), DEG])
    distance, nearest = cKDTree(expert[:, :2] * local_scale).query(volunteer[:, :2] * local_scale)
    areas = []
    for record, feature, name in NAMES:
        idx = record - 1
        match = np.where((nearest == idx) & (distance <= expert[idx, 2] / 2))[0]
        ious = [overlap(expert[idx, 2], volunteer[j, 2], distance[j]) for j in match]
        areas.append(dict(record=record, feature=feature, name=name,
                          marks=(match+1).tolist(), medianOverlap=float(np.median(ious)),
                          medianDiameter=float(np.median(volunteer[match, 2])*2)))
    data = dict(side=side, west=30.2+left/EAST, north=top/DEG, metresLon=EAST,
                metresLat=DEG, expert=rings(expert), volunteer=rings(volunteer), index=areas)
    (ASSETS / "catalogue.js").write_text("window.MOON_ZOO = " + json.dumps(data, separators=(",", ":")) + ";\n")
    for a in areas:
        print(a["name"], len(a["marks"]), round(a["medianOverlap"]*100, 1), round(a["medianDiameter"], 1))
    print("Plate rings", len(data["expert"]), len(data["volunteer"]))


if __name__ == "__main__":
    main()
