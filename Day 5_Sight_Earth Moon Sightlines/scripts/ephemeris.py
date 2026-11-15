"""Build the November 2026 quarter-hour table. Requires SpiceyPy.
Usage: python scripts/ephemeris.py /path/to/kernel/cache
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import urlretrieve

import spiceypy as spice

KERNELS = [
    "lsk/naif0012.tls",
    "spk/planets/de440s.bsp",
    "pck/moon_pa_de440_200625.bpc",
    "fk/satellites/moon_de440_250416.tf",
    "pck/earth_000101_270207_261111.bpc",
]
START = datetime(2026, 11, 1, tzinfo=timezone.utc)
cache = Path(sys.argv[1])
cache.mkdir(parents=True, exist_ok=True)
for name in KERNELS:
    target = cache / Path(name).name
    if not target.exists():
        tmp = target.with_suffix(target.suffix + ".part")
        urlretrieve("https://naif.jpl.nasa.gov/pub/naif/generic_kernels/" + name, tmp)
        tmp.replace(target)
    spice.furnsh(str(target))

# Each pair is the target-centre position in the observer's rotating frame,
# in kilometres. The viewer samples these epochs directly, without interpolation.
rows = []
for index in range(30 * 24 * 4):
    instant = START + timedelta(minutes=15 * index)
    et = spice.str2et(instant.strftime("%Y-%m-%d %H:%M:%S UTC"))
    lunar, _ = spice.spkpos("EARTH", et, "MOON_ME", "NONE", "MOON")
    terrestrial, _ = spice.spkpos("MOON", et, "ITRF93", "NONE", "EARTH")
    rows.append([round(float(x), 3) for x in (*lunar, *terrestrial)])
out = Path(__file__).resolve().parents[1] / "assets" / "ephemeris.js"
out.write_text("window.sightEphemeris = " + json.dumps(rows, separators=(",", ":")) + ";\n")
print(f"{len(rows)} epochs; 5 Nov 12:00 UTC: {rows[432]}")
