"""
Hillshade plates for the Day 12 sheet (orthophoto-like grey relief).
Resamples AWS Terrain Tiles (terrarium, Web Mercator) onto the same local
equirectangular grid used by build_data.py, so the images align linearly.

Usage: python build_hillshade.py RAW_DIR OUT_DIR
Writes OUT_DIR/hs_nat.jpg, OUT_DIR/hs_camp.jpg and OUT_DIR/hillshade.js (bounds).
"""
import sys, os, glob, math, json
import numpy as np
from PIL import Image

RAW, OUT = sys.argv[1], sys.argv[2]
LON0, LAT0 = 36.3200, 32.2940
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110880.0

def mosaic(zdir):
    fs = glob.glob(os.path.join(zdir, '*.png'))
    xy = [tuple(map(int, os.path.basename(f)[:-4].split('_'))) for f in fs]
    xs = sorted(set(a for a, b in xy)); ys = sorted(set(b for a, b in xy))
    E = np.zeros((len(ys) * 256, len(xs) * 256), dtype=np.float32)
    for f, (x, y) in zip(fs, xy):
        a = np.asarray(Image.open(f).convert('RGB')).astype(np.float32)
        E[(y - ys[0]) * 256:(y - ys[0] + 1) * 256, (x - xs[0]) * 256:(x - xs[0] + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    return E, xs[0], ys[0]

def resample(E, tx0, ty0, z, lon_a, lon_b, lat_a, lat_b, W):
    """Bilinear sample the mercator mosaic on a regular lon/lat grid (north up)."""
    H = int(round(W * (lat_b - lat_a) * KY / ((lon_b - lon_a) * KX)))
    lons = lon_a + (np.arange(W) + 0.5) / W * (lon_b - lon_a)
    lats = lat_b - (np.arange(H) + 0.5) / H * (lat_b - lat_a)
    n = 256 * 2 ** z
    px = (lons + 180) / 360 * n - tx0 * 256 - 0.5
    py = (1 - np.arcsinh(np.tan(np.radians(lats))) / np.pi) / 2 * n - ty0 * 256 - 0.5
    PX, PY = np.meshgrid(px, py)
    x0 = np.clip(np.floor(PX).astype(int), 0, E.shape[1] - 2); y0 = np.clip(np.floor(PY).astype(int), 0, E.shape[0] - 2)
    fx = np.clip(PX - x0, 0, 1); fy = np.clip(PY - y0, 0, 1)
    v = (E[y0, x0] * (1 - fx) * (1 - fy) + E[y0, x0 + 1] * fx * (1 - fy) +
         E[y0 + 1, x0] * (1 - fx) * fy + E[y0 + 1, x0 + 1] * fx * fy)
    return v, H

def blur(a, r):
    k = 2 * r + 1
    P = np.pad(a, r, mode='edge')
    out = np.zeros_like(a)
    for dy in range(k):
        for dx in range(k):
            out += P[dy:dy + a.shape[0], dx:dx + a.shape[1]]
    return out / (k * k)

def hillshade(E, cell_x, cell_y, zf, az=315.0, alt=42.0):
    gy, gx = np.gradient(E * zf, cell_y, cell_x)
    gy = -gy  # rows run north to south
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(gy, -gx)
    zen = math.radians(90 - alt); azr = math.radians(360 - az + 90)
    hs = np.cos(zen) * np.cos(slope) + np.sin(zen) * np.sin(slope) * np.cos(azr - aspect)
    return np.clip(hs, 0, 1)

def plate(zdir, z, box, W, zf, r, name, gamma, contrast=1.6):
    E, tx0, ty0 = mosaic(zdir)
    lon_a, lat_a, lon_b, lat_b = box
    v, H = resample(E, tx0, ty0, z, lon_a, lon_b, lat_a, lat_b, W)
    if r: v = blur(v, r)
    cx = (lon_b - lon_a) * KX / W; cy = (lat_b - lat_a) * KY / H
    hs = hillshade(v, cx, cy, zf)
    flat = math.cos(math.radians(90 - 42))   # value of flat ground
    img = np.clip(0.5 + (hs - flat) * contrast, 0, 1) ** gamma   # flat ground -> mid grey
    Image.fromarray((img * 255).astype(np.uint8), 'L').save(os.path.join(OUT, name), quality=82, optimize=True)
    return {'src': 'data/' + name, 'x0': round((lon_a - LON0) * KX), 'x1': round((lon_b - LON0) * KX),
            'y0': round((lat_a - LAT0) * KY), 'y1': round((lat_b - LAT0) * KY), 'w': W, 'h': H}

meta = {
    'nat': plate(os.path.join(RAW, 'dem', 'z8'), 8, (34.25, 28.65, 39.75, 33.95), 1100, 2.2, 1, 'hs_nat.jpg', 0.9),
    'camp': plate(os.path.join(RAW, 'dem', 'z13'), 13, (36.262, 32.252, 36.378, 32.328), 1100, 2.6, 7, 'hs_camp.jpg', 1.0, 1.3),
}
open(os.path.join(OUT, 'hillshade.js'), 'w').write('window.ZH=' + json.dumps(meta, separators=(',', ':')) + ';\n')
for k, m in meta.items():
    print(k, m, os.path.getsize(os.path.join(OUT, m['src'].split('/')[-1])) // 1024, 'KB')
