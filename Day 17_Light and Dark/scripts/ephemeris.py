"""Build the 2026 solar ephemeris. Run with SpiceyPy and a NAIF kernel cache."""

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import urlretrieve

import spiceypy as spice


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
KERNELS = (
    "lsk/naif0012.tls",
    "spk/planets/de440s.bsp",
    "pck/moon_pa_de440_200625.bpc",
    "fk/satellites/moon_de440_250416.tf",
    "pck/earth_000101_270207_261111.bpc",
)
START = datetime(2026, 1, 1, tzinfo=timezone.utc)
SLOTS = (datetime(2027, 1, 1, tzinfo=timezone.utc) - START).days * 96
STRIDE = 12  # Three hours of rotation are less than 180° on either body.
BODIES = (
    ("earth", "ITRF93", "MOON", 6378.137, 1737.4),
    ("moon", "MOON_ME", "EARTH", 1737.4, 6378.137),
)


def spherical(vector):
    radius, longitude, latitude = spice.reclat(vector)
    return [round(math.degrees(longitude), 6), round(math.degrees(latitude), 6), round(radius, 2)]


def build(cache):
    cache.mkdir(parents=True, exist_ok=True)
    for name in KERNELS:
        path = cache / Path(name).name
        if not path.exists():
            temporary = path.with_suffix(".part")
            # Dated Earth orientation kernels move to a_old_versions when superseded.
            try:
                urlretrieve(BASE + name, temporary)
            except OSError:
                directory, filename = name.rsplit("/", 1)
                urlretrieve(BASE + directory + "/a_old_versions/" + filename, temporary)
            temporary.replace(path)
        spice.furnsh(str(path))

    data = {"year": START.year, "stride": STRIDE}
    for body, frame, occultor, radius, blocking_radius in BODIES:
        samples, occultors = [], {}
        for slot in range(SLOTS + 1):
            instant = START + timedelta(minutes=15 * slot)
            et = spice.str2et(instant.strftime("%Y-%m-%dT%H:%M:%S"))
            sun, _ = spice.spkpos("SUN", et, frame, "CN+S", body)
            if slot % STRIDE == 0:
                samples.append(spherical(sun))
            if slot == SLOTS:
                break
            other, _ = spice.spkpos(occultor, et, frame, "CN+S", body)
            # Conservative angular test includes the full parallax of a surface site.
            # Only plausible occultations need a second vector in the offline sheet.
            ds, do = spice.vnorm(sun), spice.vnorm(other)
            limit = math.asin((695700 + radius) / ds) + math.asin((blocking_radius + radius) / do)
            if spice.vsep(sun, other) <= limit:
                occultors[slot] = [round(float(x), 3) for x in other]
        data[body] = {"sun": samples, "occultors": occultors}
        print(f"{body}: {len(samples)} solar anchors, {len(occultors)} candidate eclipse epochs")
    destination = ROOT / "assets" / "ephemeris.js"
    destination.write_text("window.solarEphemeris=" + json.dumps(data, separators=(",", ":")) + ";\n")


if __name__ == "__main__":
    build(Path(sys.argv[1]))
