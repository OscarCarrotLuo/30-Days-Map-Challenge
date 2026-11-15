"""Make the offline ephemeris. Requires numpy and scipy. All epochs are TDB.

The Sun-centred geometric states and J2000 ecliptic axes come from Horizons.
The Voyager 2 solution before 1989-08-29 is a mission-design reconstruction.
Table turns compare the two 3-D planet-relative velocities at CA +/- 7 days.
The illustrative comparison coasts in the Sun's point-mass field from CA - 30 d.
"""
from datetime import datetime, timedelta
from pathlib import Path
import csv
import hashlib
import json
import subprocess
import tempfile
import time
from urllib.parse import urlencode

import numpy as np
from scipy.integrate import solve_ivp
from scipy.interpolate import CubicHermiteSpline
from scipy.optimize import minimize_scalar

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(tempfile.gettempdir()) / "voyager-map13" / "horizons"
CACHE.mkdir(exist_ok=True, parents=True)
AU = 149597870.7
MU = 132712440041.279419 * 86400**2 / AU**3
START = "1977-08-20 16:00"
END = "1992-01-01 00:00"
ORIGIN = 2443375.5
PLANETS = ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]
RADII = [2439.4, 6051.8, 6371.0, 3389.5, 69911, 58232, 25362, 24622]
FLYBYS = [(4, "1979-07-09"), (5, "1981-08-26"), (6, "1986-01-24"), (7, "1989-08-25")]
# A small, named selection of numbered minor planets. Curves, not epoch positions.
MINOR = [1, 2, 3, 4, 7, 10, 15, 16, 24, 31, 52, 65, 87, 88, 107, 121, 130, 153, 216,
         433, 887, 1036, 1566, 1862, 2060, 5145, 5335, 7066, 8405, 10199, 10370,
         31824, 32532, 52872, 54598, 55576, 63252, 83982, 95626, 99942,
         90482, 134340, 136108, 136472, 28978, 50000]

def stamp(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")

def query(target, start, stop, step, kind="VECTORS", center=10):
    params = dict(COMMAND=target, CENTER=f"500@{center}", START_TIME=start, STOP_TIME=stop,
                  STEP_SIZE=step, EPHEM_TYPE=kind, REF_PLANE="ECLIPTIC", REF_SYSTEM="ICRF",
                  OUT_UNITS="AU-D", CSV_FORMAT="YES", OBJ_DATA="NO", VEC_TABLE="2", VEC_CORR="NONE")
    url = "https://ssd.jpl.nasa.gov/api/horizons.api?" + urlencode(
        {"format":"text", **{k:f"'{v}'" for k,v in params.items()}})
    dest = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".txt")
    if not dest.exists():
        # Sequential requests respect the Horizons fair-use policy.
        raw = subprocess.check_output(["curl", "-fsSL", "--retry", "3", "--max-time", "120", url]).decode()
        if "$$SOE" not in raw:
            raise ValueError(f"{target} {start}: {raw[-1800:]}")
        dest.write_text(raw)
        time.sleep(.12)
    raw = dest.read_text()
    table = csv.reader(raw.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines())
    rows = np.array([[float(row[0])-ORIGIN, *map(float, row[2:-1])] for row in table])
    name = raw.split("Target body name:")[1].split("{")[0].strip().split(" (")[0]
    return rows, name

def pack(rows):
    return np.round(rows, 12).tolist()

def spline(rows):
    return CubicHermiteSpline(rows[:,0], rows[:,1:4], rows[:,4:7])

def main():
    planets = []
    for i, name in enumerate(PLANETS):
        # Include the last day with a sample beyond the displayed date range.
        rows, _ = query(100*(i+1)+99, "1977-08-20", "1992-01-09", "8 d")
        planets.append(dict(name=name, radius=RADII[i], states=pack(rows)))
    voyage, _ = query(-32, START, END, "4 d")
    extras = [query(-32, "1991-12-31", END, "1 d")[0],
              query(-32, START, "1977-08-23 16:00", "1 h")[0]]
    events = []
    for i, date in FLYBYS:
        day = datetime.fromisoformat(date)
        start, end = [stamp(day + timedelta(days=n)) for n in (-9, 10)]
        ship, _ = query(-32, start, end, "15 m")
        planet, _ = query(100*(i+1)+99, start, end, "15 m")
        extras.append(ship)
        ship_at, planet_at = spline(ship), spline(planet)
        dist = lambda t: np.linalg.norm(ship_at(t)-planet_at(t))
        approx = ship[np.argmin([dist(t) for t in ship[:,0]]),0]
        ca = minimize_scalar(dist, bounds=(approx-0.03, approx+0.03), method="bounded",
                             options={"xatol":1e-11}).x
        relv = lambda t: ship_at(t,1)-planet_at(t,1)
        v0,v1 = relv(ca-7),relv(ca+7)
        turn = np.rad2deg(np.arccos(np.clip(np.dot(v0,v1)/np.linalg.norm(v0)/np.linalg.norm(v1),-1,1)))
        anchor = datetime(1977,8,20)+timedelta(days=float(ca)-30)
        first, _ = query(-32, stamp(anchor), stamp(anchor+timedelta(hours=1)), "1 h")
        t0 = first[0,0]
        extras.append(first)
        def accel(t, y):
            r = y[:3]
            return np.r_[y[3:], -MU*r/np.linalg.norm(r)**3]
        ts = np.r_[0:761:1.] + t0
        sol = solve_ivp(accel, (ts[0], ts[-1]), first[0,1:], t_eval=ts,
                        method="DOP853", rtol=2e-13, atol=1e-15)
        assert sol.success
        # Store both tracks in the moving planet frame at the same epochs.
        local_times = ship[:,0]
        coast_at = CubicHermiteSpline(ts,sol.y[:3].T,sol.y[3:].T)
        local = np.column_stack((local_times, ship[:,1:4]-planet[:,1:4],
                                 coast_at(local_times)-planet[:,1:4]))
        moons = []
        satellite_ids = [[501,502,503,504], [601,602,603,604,605,606,608],
                         [701,702,703,704,705], [801,802,808]][i-4]
        # Round the snapshot to the second. Longitudes are projected from
        # J2000 ecliptic orbital elements around the parent, including retrogrades.
        snap = datetime(1977,8,20)+timedelta(days=float(ca))
        for target in satellite_ids:
            row,name = query(target, stamp(snap), stamp(snap+timedelta(minutes=1)), "1 m",
                             "ELEMENTS", center=100*(i+1)+99)
            e,q,inc,node,peri = row[0,1:6]
            moons.append([name, *np.round([q/(1-e),e,inc,node,peri,row[0,9]],12)])
        events.append(dict(local=pack(local), moons=moons, body=i, ca=round(float(ca),10), turn=round(float(turn),3),
                           rangeKm=round(float(dist(ca)*AU)), modelStart=t0,
                           model=pack(sol.y[:3].T)))
        print(date, PLANETS[i], 'CA TDB', datetime(1977,8,20)+timedelta(days=float(ca)),
              'range km', events[-1]['rangeKm'], 'turn',events[-1]['turn'],
              'position',ship_at(ca),flush=True)
    combined = np.concatenate([voyage, *extras])
    combined = combined[np.argsort(combined[:,0])]
    combined = combined[np.r_[True, np.diff(combined[:,0])>1e-7]]
    # Keep high cadence around the encounter, where curvature is greatest.
    minor = []
    for n in MINOR:
        el,name = query(f"{n};", "1989-08-25", "1989-08-26", "1 d", "ELEMENTS")
        e,q,inc,node,peri = el[0,1:6]
        minor.append([name, *np.round([q/(1-e),e,inc,node,peri],8)])
    # The full orbital ellipse of each major planet is generated live from its
    # position/velocity and GM. The flight tracks use the Horizons state samples.
    data = dict(originJD=ORIGIN, au=AU, mu=MU, planets=planets, route=pack(combined),
                encounters=events, minor=minor, minorEpoch="1989-08-25")
    (ROOT/"ephemeris.js").write_text("const VOYAGER = "+json.dumps(data,separators=(",",":"))+";\n")
    print("Saved",len(combined),"trajectory samples and", len(minor),"minor orbits",flush=True)

if __name__ == "__main__":
    main()
