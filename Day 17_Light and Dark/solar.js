// Solar geometry shared by the surface map, the two globes and the year plot.
(() => {
  'use strict';
  const eph = window.solarEphemeris;
  const rad = Math.PI / 180;
  const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
  const wrap = x => ((x + 180) % 360 + 360) % 360 - 180;
  const start = Date.UTC(eph.year, 0, 1);
  const slotMs = 15 * 60000;
  const count = (Date.UTC(eph.year + 1, 0, 1) - start) / slotMs;
  const earthRadius = 6378.137;
  const moonRadius = 1737.4;
  const sunRadius = 695700;
  const bodies = {
    earth: {radius: earthRadius, eccentricity2: 0.0066943799901413165, blockerRadius: moonRadius},
    moon: {radius: moonRadius, eccentricity2: 0, blockerRadius: earthRadius}
  };

  function direction(body, slot) {
    const table = eph[body].sun;
    const i = Math.floor(slot / eph.stride);
    const f = slot % eph.stride / eph.stride;
    const a = table[i], b = table[i + 1];
    const lon = wrap(a[0] + f * wrap(b[0] - a[0]));
    const lat = a[1] + f * (b[1] - a[1]);
    const range = a[2] + f * (b[2] - a[2]);
    const c = Math.cos(lat * rad);
    const x = c * Math.cos(lon * rad), y = c * Math.sin(lon * rad), z = Math.sin(lat * rad);
    return {lon, lat, range, x, y, z, blocker:eph[body].occultors[slot]};
  }

  // Surface normal uses geodetic latitude on Earth and selenographic latitude on the Moon.
  function observer(body, lon, lat) {
    const {radius, eccentricity2} = bodies[body];
    const c = Math.cos(lat * rad), z = Math.sin(lat * rad);
    const x = c * Math.cos(lon * rad), y = c * Math.sin(lon * rad);
    const n = radius / Math.sqrt(1 - eccentricity2 * z * z);
    const px = n * x, py = n * y, pz = n * (1 - eccentricity2) * z;
    return {x, y, z, px, py, pz, up:px*x + py*y + pz*z, radius2:px*px + py*py + pz*pz};
  }

  // Fraction of the solar disc covered by the other body, from this surface point.
  // The occulting silhouette is spherical. The atmosphere and local relief are omitted.
  function eclipse(body, sun, site) {
    if (!sun.blocker) return 0;
    const [ox, oy, oz] = sun.blocker;
    const bx = ox - site.px, by = oy - site.py, bz = oz - site.pz;
    const sx = sun.x * sun.range - site.px, sy = sun.y * sun.range - site.py, sz = sun.z * sun.range - site.pz;
    const ds = Math.hypot(sx, sy, sz), db = Math.hypot(bx, by, bz);
    const radius = Math.asin(sunRadius / ds), block = Math.asin(bodies[body].blockerRadius / db);
    const cosDistance = (sx*bx + sy*by + sz*bz) / (ds*db);
    if (cosDistance <= Math.cos(radius + block)) return 0;
    const d = Math.acos(clamp(cosDistance, -1, 1));
    if (d <= Math.abs(radius - block)) return Math.min(1, (block/radius)**2);
    const d2 = d*d, r2 = radius*radius, b2 = block*block;
    const angle = Math.acos(clamp((d2 + r2 - b2) / (2*d*radius), -1, 1));
    const other = Math.acos(clamp((d2 + b2 - r2) / (2*d*block), -1, 1));
    const chord = Math.sqrt(Math.max(0, (-d+radius+block)*(d+radius-block)*(d-radius+block)*(d+radius+block)));
    return clamp((r2*angle + b2*other - chord/2) / (Math.PI*r2), 0, 1);
  }

  function reading(body, sun, site) {
    const dot = site.x*sun.x + site.y*sun.y + site.z*sun.z;
    const distance = Math.sqrt(sun.range**2 + site.radius2 -
      2*sun.range*(site.px*sun.x + site.py*sun.y + site.pz*sun.z));
    const altitude = Math.asin(clamp((dot*sun.range - site.up)/distance, -1, 1)) / rad;
    const covered = altitude > 0 ? eclipse(body, sun, site) : 0;
    const light = altitude <= 0 ? 'Dark' : covered >= 1 - 1e-8 ? 'Eclipse' : covered > 0.0001 ? 'Partial' : 'Sunlit';
    return {altitude, covered, light};
  }

  const annualSamples = {};
  function calendar(body, site) {
    // Reuse the same physical directions for all locations in a body.
    const samples = annualSamples[body] ??= Array.from({length:count}, (_, i) => direction(body, i));
    const values = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const sun = samples[i];
      const up = sun.x*site.x + sun.y*site.y + sun.z*site.z - site.up/sun.range;
      const open = up > 0 ? 1 - eclipse(body, sun, site) : 0;
      values[i] = open <= 1e-8 ? 48 : Math.max(49, Math.round(48 + 192 * open));
    }
    return values;
  }
  window.Solar = {rad, wrap, clamp, start, slotMs, count, bodies, direction, observer, reading, eclipse, calendar};
})();
