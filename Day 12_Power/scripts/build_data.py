"""
Day 12 · Power — Who powers Zaatari?
Builds the compact data file (data/zaatari_data.js) used by index.html.

Inputs (downloaded separately into RAW):
  osm/q1.json, q4.json, q6.json, q7.json   Overpass API extracts (OpenStreetMap, ODbL)
  unosat/shelters/Al_Zaatari_Shelters.shp   UNOSAT shelter points, Aug 2016 (via HDX)
  unosat/gdb/Al_Zaatari_20160812.gdb        UNOSAT camp extents 2012-2014
  reach/reach2016.pdf                       REACH/UNHCR district map Dec 2016 (key map vectors)
  ne/*.geojson                              Natural Earth 10m
  dem/z8, dem/z13                           AWS Terrain Tiles (terrarium PNG)

Usage:  python build_data.py RAW_DIR OUT_JS
All coordinates are written as integer metres in a local equirectangular
projection centred on the camp (x east, y north).
"""
import json, math, sys, glob, os, re, base64, heapq, struct
from collections import defaultdict
import numpy as np
from PIL import Image
import contourpy
import shapely
from shapely.geometry import shape, Polygon, MultiPolygon, LineString, Point, box, mapping
from shapely.ops import unary_union
from shapely import affinity
import pyogrio
from shapely import wkb

RAW, OUT = sys.argv[1], sys.argv[2]
LON0, LAT0 = 36.3200, 32.2940
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110880.0

def P(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)

def proj_geom(g):
    return shapely.transform(g, lambda c: np.column_stack([(c[:, 0] - LON0) * KX, (c[:, 1] - LAT0) * KY]))

def flat(coords, q=1):
    out = []
    for x, y in coords:
        out += [int(round(x / q) * q), int(round(y / q) * q)]
    return out

def rings_of(g, q=1, min_area=0):
    res = []
    polys = [g] if g.geom_type == 'Polygon' else list(getattr(g, 'geoms', []))
    for p in polys:
        if p.is_empty or p.area < min_area:
            continue
        r = [flat(p.exterior.coords, q)]
        for h in p.interiors:
            if Polygon(h).area > min_area:
                r.append(flat(h.coords, q))
        res.append(r)
    return res

def lines_of(g):
    if g.is_empty: return []
    if g.geom_type == 'LineString': return [g]
    if g.geom_type in ('MultiLineString', 'GeometryCollection'):
        out = []
        for x in g.geoms: out += lines_of(x)
        return out
    return []

def load(name):
    return json.load(open(os.path.join(RAW, 'osm', name)))

D = {'meta': {'lon0': LON0, 'lat0': LAT0, 'kx': round(KX, 3), 'ky': KY}}

# ------------------------------------------------------------------ national frame
NB = box(33.6, 28.3, 40.6, 34.6)  # lon/lat clip
NBp = proj_geom(NB)

# Natural Earth countries
ne = json.load(open(os.path.join(RAW, 'ne', 'ne_10m_admin_0_countries.geojson')))
countries = []
jordan_ll = None
for f in ne['features']:
    g = shape(f['geometry'])
    if not g.intersects(NB):
        continue
    nm = f['properties'].get('NAME_EN') or f['properties'].get('NAME')
    if nm == 'Jordan':
        jordan_ll = g
    gp = proj_geom(g.intersection(NB)).simplify(250)
    countries.append({'n': nm, 'r': rings_of(gp, 10, 2e6)})
D['countries'] = countries
lakes = []
nel = json.load(open(os.path.join(RAW, 'ne', 'ne_10m_lakes.geojson')))
for f in nel['features']:
    g = shape(f['geometry'])
    if g.intersects(NB):
        nm = f['properties'].get('name_en') or f['properties'].get('name')
        lakes.append({'n': nm, 'r': rings_of(proj_geom(g).simplify(120), 10)})
D['lakes'] = lakes

# ------------------------------------------------------------------ DEM contours
def mosaic(zdir, z):
    fs = glob.glob(os.path.join(zdir, '*.png'))
    xy = [tuple(map(int, os.path.basename(f)[:-4].split('_'))) for f in fs]
    xs = sorted(set(a for a, b in xy)); ys = sorted(set(b for a, b in xy))
    W, H = len(xs) * 256, len(ys) * 256
    E = np.zeros((H, W), dtype=np.float32)
    for f, (x, y) in zip(fs, xy):
        a = np.asarray(Image.open(f).convert('RGB')).astype(np.float32)
        e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
        E[(y - ys[0]) * 256:(y - ys[0] + 1) * 256, (x - xs[0]) * 256:(x - xs[0] + 1) * 256] = e
    n = 256 * 2 ** z
    X = (np.arange(W) + xs[0] * 256 + 0.5) / n * 360 - 180
    Yg = np.arange(H) + ys[0] * 256 + 0.5
    LAT = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * Yg / n))))
    return E, X, LAT

def blur(E, r=1):
    k = 2 * r + 1
    P_ = np.pad(E, r, mode='edge')
    out = np.zeros_like(E)
    for dy in range(k):
        for dx in range(k):
            out += P_[dy:dy + E.shape[0], dx:dx + E.shape[1]]
    return out / (k * k)

def contours(E, LON, LAT, levels, tol, minlen, q, clip=None):
    gx = (LON - LON0) * KX
    gy = (LAT - LAT0) * KY
    Xg, Yg = np.meshgrid(gx, gy)
    gen = contourpy.contour_generator(Xg, Yg, E, line_type=contourpy.LineType.Separate)
    res = []
    for lv in levels:
        for seg in gen.lines(lv):
            if len(seg) < 3: continue
            ls = LineString(seg).simplify(tol)
            if clip is not None:
                ls = ls.intersection(clip)
            for l in lines_of(ls):
                if l.length < minlen: continue
                res.append({'e': int(lv), 'c': flat(l.coords, q)})
    return res

E8, LON8, LAT8 = mosaic(os.path.join(RAW, 'dem', 'z8'), 8)
E8 = blur(E8, 1)
lv_land = list(range(-400, 2000, 100))
lv_sea = [-1500, -1000, -600, -300, -100]
D['contours'] = contours(E8, LON8, LAT8, [l for l in lv_land if l != 0] + lv_sea, 380, 7000, 50, NBp)

E13, LON13, LAT13 = mosaic(os.path.join(RAW, 'dem', 'z13'), 13)
E13 = blur(E13, 2)
camp_clip = proj_geom(box(36.262, 32.252, 36.378, 32.328))
D['campContours'] = contours(E13, LON13, LAT13, list(range(624, 730, 4)), 9, 450, 3, camp_clip)

# ------------------------------------------------------------------ national grid (OSM)
q4 = load('q4.json')
lines = {'400': [], '230': [], '132': []}
graph_ways = []
for e in q4['elements']:
    t = e.get('tags', {})
    if t.get('power') != 'line':
        continue
    v = t.get('voltage', '').split(';')[0]
    vk = v[:3]
    if vk not in lines:
        continue
    coords = [P(p['lon'], p['lat']) for p in e['geometry']]
    graph_ways.append((vk, coords))
    l = LineString(coords).simplify(60)
    lines[vk].append(flat(l.coords, 10))
D['lines'] = lines

# plants
def centroid_ll(e):
    pts = []
    if 'geometry' in e:
        pts = [(p['lon'], p['lat']) for p in e['geometry']]
    for m in e.get('members', []):
        pts += [(p['lon'], p['lat']) for p in m.get('geometry', [])]
    if not pts:
        b = e.get('bounds')
        return ((b['minlon'] + b['maxlon']) / 2, (b['minlat'] + b['maxlat']) / 2), []
    if len(pts) >= 4:
        try:
            pg = Polygon(pts)
            if pg.is_valid and pg.area > 0:
                c = pg.centroid
                return (c.x, c.y), pts
        except Exception:
            pass
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)), pts

def mw(s):
    if not s: return None
    m = re.match(r'\s*([\d.]+)\s*(MW|kW|GW)?', s)
    if not m: return None
    v = float(m.group(1)); u = m.group(2) or 'MW'
    return v / 1000 if u == 'kW' else v * 1000 if u == 'GW' else v

SRC_OVERRIDE = {'Attarat Power Plant': 'oilshale'}
NAME_FIX = {
    'Attarat Power Plant': 'Attarat Oil Shale Plant',
    'Samra Power Station': 'Samra Power Station',
    'Shams Ma\'an Solar Power Plant': 'Shams Ma’an Solar',
    '5MW Photovoltaic Solar Plant @ Azraq': 'Azraq Camp PV',
}
plants = []
jordan_p = proj_geom(jordan_ll) if jordan_ll is not None else None
for e in q4['elements']:
    t = e.get('tags', {})
    if t.get('power') != 'plant':
        continue
    (lon, lat), pts = centroid_ll(e)
    if jordan_ll is None or not jordan_ll.buffer(0.01).contains(Point(lon, lat)):
        continue
    nm = t.get('name:en') or t.get('name')
    src = (t.get('plant:source') or '').split(';')[0]
    if nm in SRC_OVERRIDE: src = SRC_OVERRIDE[nm]
    x, y = P(lon, lat)
    rec = {'x': int(x), 'y': int(y), 's': src or 'other'}
    if nm: rec['n'] = NAME_FIX.get(nm, nm)
    m_ = mw(t.get('plant:output:electricity'))
    if m_: rec['mw'] = round(m_, 1)
    rec['id'] = e['id']
    plants.append(rec)
# drop border leaks (Israeli plants next to the Jordan line) and duplicate tags
EXCL = ('Ketura', 'Grofit', 'Kfar Rupin', '\u05e4')
plants = [p for p in plants if not any(x in p.get('n', '') for x in EXCL)]
best_by_name = {}
for p in plants:
    if 'n' in p:
        q = best_by_name.get(p['n'])
        if q is None or p.get('mw', 0) > q.get('mw', 0):
            best_by_name[p['n']] = p
plants = [p for p in plants if 'n' not in p or best_by_name[p['n']] is p]
# the on-site Zaatari plant is tagged without a name
for p in plants:
    if p['id'] == 900996141:
        p['n'] = 'Zaatari Camp PV'; p['mw'] = 12.9
D['plants'] = plants

# graph for illustrative routing along the transmission network
nodes = {}
adj = defaultdict(list)
def nid(x, y):
    k = (round(x / 5), round(y / 5))
    if k not in nodes:
        nodes[k] = (len(nodes), x, y)
    return nodes[k][0]
coords_by_id = {}
endpoints = []
for vk, cs in graph_ways:
    ids = [nid(x, y) for x, y in cs]
    for (a, b), (p1, p2) in zip(zip(ids, ids[1:]), zip(cs, cs[1:])):
        d = math.dist(p1, p2) * (1.0 if vk == '400' else 1.15)
        adj[a].append((b, d)); adj[b].append((a, d))
    for i, (x, y) in zip(ids, cs):
        coords_by_id[i] = (x, y)
    endpoints += [(ids[0], cs[0]), (ids[-1], cs[-1])]
# bridge gaps at substations: connect endpoints to nearby vertices of other lines
grid = defaultdict(list)
G = 2500
for i, (x, y) in coords_by_id.items():
    grid[(int(x // G), int(y // G))].append(i)
for i, (x, y) in endpoints:
    best = []
    gx, gy = int(x // G), int(y // G)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for j in grid[(gx + dx, gy + dy)]:
                if j == i: continue
                d = math.dist((x, y), coords_by_id[j])
                if 1 < d < 2500:
                    best.append((d, j))
    best.sort()
    for d, j in best[:4]:
        adj[i].append((j, d * 1.5)); adj[j].append((i, d * 1.5))

def nearest(x, y):
    return min(coords_by_id, key=lambda i: math.dist((x, y), coords_by_id[i]))

def dijkstra(src, dst):
    dist = {src: 0}; prev = {}
    pq = [(0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst: break
        if d > dist.get(u, 1e18): continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    if dst not in dist: return None
    path = [dst]
    while path[-1] != src:
        path.append(prev[path[-1]])
    return [coords_by_id[i] for i in reversed(path)]

camp_xy = (0, 0)
# grid entry point near the camp: the 132 kV line that passes the east edge
entry = nearest(*P(36.3375, 32.2985))
azraq_xy = P(36.5785, 31.9022)
azraq_entry = nearest(*azraq_xy)
ROUTES = [
    ('samra', 'Samra Power Station', 'gas'),
    ('rehab', 'Rehab Power Station', 'gas'),
    ('aqaba', 'Aqaba Thermal Power Station', 'gas'),
    ('attarat', 'Attarat Oil Shale Plant', 'oilshale'),
    ('tafila', 'Tafila Wind Farm', 'wind'),
    ('maan', 'Shams Ma’an Solar', 'solar'),
    ('baynouna', 'Baynouna Solar Power Plant', 'solar'),
    ('southamman', 'South Amman Solar Power Plant', 'wheel'),
]
routes = []
for rid, name, kind in ROUTES:
    cand = [p for p in plants if p.get('n') == name]
    if not cand:
        print('!! plant not found', name); continue
    p = max(cand, key=lambda r: r.get('mw', 0))
    s = nearest(p['x'], p['y'])
    path = dijkstra(s, entry)
    if not path:
        print('!! no path', name); continue
    full = [(p['x'], p['y'])] + path + [camp_xy]
    l = LineString(full).simplify(120)
    routes.append({'id': rid, 'n': name, 'k': kind, 'to': 'zaatari', 'c': flat(l.coords, 10)})
    if rid == 'southamman':
        path2 = dijkstra(s, azraq_entry)
        if path2:
            l2 = LineString([(p['x'], p['y'])] + path2 + [azraq_xy]).simplify(120)
            routes.append({'id': 'southamman_azraq', 'n': name, 'k': 'wheel', 'to': 'azraq', 'c': flat(l2.coords, 10)})
    print('route', rid, round(l.length / 1000, 1), 'km')
D['routes'] = routes

# context places
PLACES = [
    ('Amman', 35.924, 31.9516, 1), ('Zarqa', 36.0886, 32.0668, 2), ('Irbid', 35.8493, 32.5556, 2),
    ('Mafraq', 36.2075, 32.3424, 2), ('Aqaba', 35.0075, 29.5266, 2), ('Ma’an', 35.7333, 30.2, 3),
    ('Karak', 35.7047, 31.1847, 3), ('Tafila', 35.6, 30.8333, 3), ('Azraq', 36.8167, 31.8833, 3),
    ('Ramtha', 36.0069, 32.5592, 3), ('Madaba', 35.7944, 31.7166, 3), ('Damascus', 36.2913, 33.5131, 1),
    ('Jerusalem', 35.2258, 31.7788, 1), ('Haifa', 34.9984, 32.8191, 2), ('Daraa', 36.1068, 32.6228, 2),
    ('Za’atari town', 36.2857, 32.3026, 4),
]
D['places'] = [{'n': n, 'x': int(P(lo, la)[0]), 'y': int(P(lo, la)[1]), 'r': r} for n, lo, la, r in PLACES]
D['camps'] = [
    {'n': 'Zaatari', 'x': 0, 'y': 0},
    {'n': 'Azraq', 'x': int(azraq_xy[0]), 'y': int(azraq_xy[1])},
]
D['subs'] = [
    {'n': 'Mafraq 132 kV', 'x': int(P(36.2704, 32.3872)[0]), 'y': int(P(36.2704, 32.3872)[1])},
    {'n': 'Sabha 132 kV', 'x': int(P(36.4788, 32.262)[0]), 'y': int(P(36.4788, 32.262)[1])},
]

# ------------------------------------------------------------------ camp scale
q6 = load('q6.json')
q1 = load('q1.json')
camp_poly = None
roads = []
amen = []
camp_lines = []
towers = []
town = None
for e in q6['elements'] + q1['elements']:
    t = e.get('tags', {})
    if e['type'] == 'way' and t.get('amenity') == 'refugee_site' and 'geometry' in e and camp_poly is None:
        camp_poly = Polygon([P(p['lon'], p['lat']) for p in e['geometry']])
    if e['type'] == 'way' and e['id'] == 614565737:
        town = Polygon([P(p['lon'], p['lat']) for p in e['geometry']])
print('camp area ha', round(camp_poly.area / 1e4, 1))
seen = set()
RK = {'trunk': 1, 'trunk_link': 1, 'primary': 1, 'secondary': 1, 'tertiary': 2, 'unclassified': 2,
      'residential': 3, 'living_street': 3, 'service': 4, 'track': 4, 'path': 5, 'footway': 5}
for e in q6['elements']:
    if e['id'] in seen and e['type'] == 'way': continue
    t = e.get('tags', {})
    if e['type'] == 'way': seen.add(e['id'])
    if e['type'] == 'way' and 'highway' in t and 'geometry' in e:
        k = RK.get(t['highway'], 4)
        l = LineString([P(p['lon'], p['lat']) for p in e['geometry']]).simplify(1.5)
        r = {'k': k, 'c': flat(l.coords)}
        if t.get('name') and re.match(r'[A-Za-z]', t['name']): r['n'] = t['name']
        roads.append(r)
    if 'amenity' in t:
        a = t['amenity']
        typ = {'hospital': 'H', 'clinic': 'H', 'school': 'S', 'kindergarten': 'S', 'community_centre': 'C',
               'social_facility': 'C', 'police': 'P', 'place_of_worship': 'M', 'water_point': 'W',
               'shop': 'B', 'restaurant': 'B', 'fast_food': 'B', 'cafe': 'B', 'bureau_de_change': 'B'}.get(a)
        if not typ: continue
        if e['type'] == 'node':
            x, y = P(e['lon'], e['lat'])
        elif 'geometry' in e:
            pts = [P(p['lon'], p['lat']) for p in e['geometry']]
            x = sum(p[0] for p in pts) / len(pts); y = sum(p[1] for p in pts) / len(pts)
        else:
            continue
        r = {'t': typ, 'x': int(x), 'y': int(y)}
        nm = t.get('name:en') or t.get('name')
        if nm and typ in 'HSCP' and re.match(r'[A-Za-z]', nm): r['n'] = nm[:48]
        amen.append(r)
    if e['type'] == 'way' and t.get('power') == 'line' and 'geometry' in e:
        camp_lines.append({'v': t.get('voltage', ''), 'c': flat([P(p['lon'], p['lat']) for p in e['geometry']])})
    if e['type'] == 'node' and t.get('power') == 'tower':
        x, y = P(e['lon'], e['lat']); towers += [int(x), int(y)]
# flag market streets: named "Souq" or lined with shops/restaurants (OSM)
shop_pts = [Point(a['x'], a['y']) for a in amen if a['t'] == 'B']
for r in roads:
    if r['k'] > 3: continue
    l = LineString(np.array(r['c']).reshape(-1, 2))
    n = sum(1 for p in shop_pts if l.distance(p) < 18)
    if n >= 5 or 'Souq' in r.get('n', ''):
        r['mk'] = 1
print('market roads', sum(1 for r in roads if r.get('mk')))
D['camp'] = {
    'extent': rings_of(camp_poly, 1)[0][0],
    'area_ha': round(camp_poly.area / 1e4, 1),
    'town': rings_of(town.simplify(4), 2)[0][0] if town is not None else [],
    'roads': roads, 'amen': amen, 'lines': camp_lines, 'towers': towers,
}
print('roads', len(roads), 'amen', len(amen))

# solar plant + generated panel rows (east-west rows, ~8.5 m pitch)
plant_poly = None
for e in q1['elements']:
    if e['type'] == 'way' and e['id'] == 900996141:
        plant_poly = Polygon([P(p['lon'], p['lat']) for p in e['geometry']])
inner = plant_poly.buffer(-12)
minx, miny, maxx, maxy = inner.bounds
rows = []
y = miny + 6
while y < maxy:
    seg = inner.intersection(LineString([(minx - 5, y), (maxx + 5, y)]))
    for l in lines_of(seg):
        if l.length > 15:
            (x1, y1), (x2, y2) = l.coords[0], l.coords[-1]
            rows += [int(x1), int(round(y1)), int(x2), int(round(y2))]
    y += 8.5
D['camp']['plant'] = flat(plant_poly.exterior.coords)
D['camp']['plantArea_ha'] = round(plant_poly.area / 1e4, 1)
D['camp']['panels'] = rows
pc = plant_poly.centroid
D['camp']['plantC'] = [int(pc.x), int(pc.y)]
print('plant ha', round(plant_poly.area / 1e4, 1), 'rows', len(rows) // 4)

# camp extents through time (UNOSAT)
g = os.path.join(RAW, 'unosat', 'gdb', 'Al_Zaatari_20160812.gdb')
meta, fids, geom, fields = pyogrio.raw.read(g, layer='Al_Zaatari_Camp_Extent', columns=['Sensor_Date', 'Area_ha'])
ext = []
for i in range(len(geom)):
    gg = proj_geom(wkb.loads(bytes(geom[i]))).simplify(3)
    ext.append({'d': str(fields[0][i])[:10], 'ha': round(float(fields[1][i])), 'r': rings_of(gg, 1, 500)})
ext.sort(key=lambda r: r['d'])
dedup = []
for r in ext:
    if dedup and dedup[-1]['ha'] == r['ha']:
        continue
    dedup.append(r)
D['camp']['extents'] = dedup
g_last = proj_geom(wkb.loads(bytes(geom[[str(v)[:10] for v in fields[0]].index(dedup[-1]['d'])])))
camp_poly = max(g_last.geoms, key=lambda x: x.area) if g_last.geom_type == 'MultiPolygon' else g_last
camp_poly = camp_poly.simplify(2)
D['camp']['extent'] = flat(camp_poly.exterior.coords)
D['camp']['area_ha'] = round(camp_poly.area / 1e4, 1)
print('camp outline (UNOSAT latest) ha', D['camp']['area_ha'])

# shelters (UNOSAT): x,y int16 (m), first-seen month, closed month (255 = still standing Aug 2016)
s = os.path.join(RAW, 'unosat', 'shelters', 'Al_Zaatari_Shelters.shp')
meta, fids, geom, fields = pyogrio.raw.read(s, columns=['Sensor_Dat', 'ShelterClo', 'Shelter_St', 'Structure_'])
names = list(meta['fields'])
sd, sc, st, ss = (fields[names.index(n)] for n in ['Sensor_Dat', 'ShelterClo', 'Shelter_St', 'Structure_'])
def month(v):
    v = str(v)
    if not v or v in ('NaT', 'None', 'nan'): return None
    y, m = int(v[:4]), int(v[5:7])
    return (y - 2012) * 12 + (m - 7)
buf = bytearray()
nopen = 0
mon_hist = defaultdict(int)
for i in range(len(geom)):
    pt = wkb.loads(bytes(geom[i]))
    x, y = P(pt.x, pt.y)
    m0 = month(sd[i]); m1 = month(sc[i])
    if m0 is None: continue
    is_open = str(st[i]) == 'Open'
    if is_open: nopen += 1; m1 = 255
    elif m1 is None: m1 = m0 + 1
    admin = 1 if str(ss[i]).startswith('Admin') else 0
    buf += struct.pack('<hhBB', int(round(x)), int(round(y)), max(0, min(127, m0)) | (admin << 7), min(255, m1))
D['camp']['shelters'] = base64.b64encode(bytes(buf)).decode()
D['camp']['shelterCount'] = len(buf) // 6
D['camp']['shelterOpen'] = nopen
print('shelters', len(buf) // 6, 'open', nopen)

# districts from the REACH key map, fitted to the camp extent
import pymupdf
doc = pymupdf.open(os.path.join(RAW, 'reach', 'reach2016.pdf'))
pg = doc[0]
polys = []
for d in pg.get_drawings():
    r = d['rect']
    if d.get('type') == 'fs' and r.x0 >= 30 and r.x1 <= 420 and r.y0 >= 2120 and d.get('color') == (1.0, 0.0, 0.0):
        pts = []
        for it in d['items']:
            if it[0] == 'l':
                pts += [(it[1].x, -it[1].y), (it[2].x, -it[2].y)]
            elif it[0] == 'c':
                pts += [(it[1].x, -it[1].y), (it[4].x, -it[4].y)]
        polys.append(Polygon(pts).buffer(0))
labels = [(w[4], ((w[0] + w[2]) / 2, -(w[1] + w[3]) / 2)) for w in pg.get_text('words')
          if w[0] >= 30 and w[2] <= 420 and w[1] >= 2120 and re.fullmatch(r'D\d+', w[4])]
named = {}
for lab, (lx, ly) in labels:
    for p in polys:
        if p.buffer(2).contains(Point(lx, ly)):
            named[int(lab[1:])] = p
print('districts from key map', sorted(named))
U = unary_union(list(named.values()))
ux0, uy0, ux1, uy1 = U.bounds
cx0, cy0, cx1, cy1 = camp_poly.bounds
best = None
for rot in np.arange(-20, 20.01, 1.0):
    Ur = affinity.rotate(U, rot, origin='centroid')
    a0, b0, a1, b1 = Ur.bounds
    sx = (cx1 - cx0) / (a1 - a0); sy = (cy1 - cy0) / (b1 - b0)
    Ut = affinity.translate(affinity.scale(Ur, sx, sy, origin=(a0, b0)), cx0 - a0, cy0 - b0)
    iou = Ut.intersection(camp_poly).area / Ut.union(camp_poly).area
    if best is None or iou > best[0]:
        best = (iou, rot)
# refine a full similarity+stretch transform by coordinate descent on IoU
rot0 = best[1]
Ur = affinity.rotate(U, rot0, origin='centroid')
a0, b0, a1, b1 = Ur.bounds
params = [rot0, (cx1 - cx0) / (a1 - a0), (cy1 - cy0) / (b1 - b0), 0.0, 0.0]
uc = U.centroid
def make(pr):
    rot, sx, sy, tx, ty = pr
    g = affinity.rotate(U, rot, origin=uc)
    g = affinity.scale(g, sx, sy, origin=uc)
    c = camp_poly.centroid
    return affinity.translate(g, c.x - uc.x + tx, c.y - uc.y + ty)
def score(pr):
    g = make(pr)
    return g.intersection(camp_poly).area / g.union(camp_poly).area
cur = score(params)
steps = [0.5, 0.2, 0.2, 20, 20]
for it in range(60):
    improved = False
    for k in range(5):
        for sgn in (1, -1):
            trial = list(params); trial[k] += sgn * steps[k]
            if k in (1, 2): trial[k] = params[k] * (1 + sgn * 0.01 * steps[k] / 0.2)
            sc_ = score(trial)
            if sc_ > cur:
                cur, params, improved = sc_, trial, True
    if not improved:
        steps = [x * 0.5 for x in steps]
        if steps[0] < 0.01: break
print('district fit IoU', round(cur, 3), 'params', [round(p, 3) for p in params])
def fit(g):
    rot, sx, sy, tx, ty = params
    g = affinity.rotate(g, rot, origin=uc)
    g = affinity.scale(g, sx, sy, origin=uc)
    c = camp_poly.centroid
    return affinity.translate(g, c.x - uc.x + tx, c.y - uc.y + ty)
# shelter counts per district (standing in Aug 2016)
open_pts = []
for i in range(0, len(buf), 6):
    x, y, m0, m1 = struct.unpack('<hhBB', buf[i:i + 6])
    if m1 == 255 and not (m0 >> 7): open_pts.append(Point(x, y))
districts = []
for k in sorted(named):
    g = fit(named[k]).intersection(camp_poly).simplify(2)
    if g.geom_type != 'Polygon':
        g = max(g.geoms, key=lambda x: x.area)
    n = sum(1 for p in open_pts if g.contains(p))
    c = g.representative_point()
    districts.append({'id': k, 'c': flat(g.exterior.coords), 'cx': int(c.x), 'cy': int(c.y),
                      'ha': round(g.area / 1e4, 1), 'n': n})
D['camp']['districts'] = districts

js = 'window.ZD=' + json.dumps(D, separators=(',', ':')) + ';\n'
open(OUT, 'w').write(js)
print('wrote', OUT, round(len(js) / 1024), 'KB')
for k, v in D.items():
    print('  ', k, round(len(json.dumps(v, separators=(',', ':'))) / 1024), 'KB')
for k, v in D['camp'].items():
    print('    camp.', k, round(len(json.dumps(v, separators=(',', ':'))) / 1024), 'KB')
