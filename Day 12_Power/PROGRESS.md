# Day 12 · Power — Who Powers Zaatari? (progress note)

## Done
- `scripts/build_data.py` → `data/zaatari_data.js` (window.ZD, ~1.5 MB, local metres, origin 36.32E 32.294N, y north).
  Contains: countries, lakes, national contours (100 m), camp contours (4 m), OSM 400/230/132 kV lines, 137 Jordan plants,
  8 illustrative routes to Zaatari (+ South Amman→Azraq), places, camps, substations (Mafraq, Sabha),
  camp: extent (UNOSAT 2014, 533 ha), extents over time, 12 districts (REACH 2016 key map fitted, IoU 0.965),
  roads (mk = market streets), amenities, 132 kV line + towers, PV plant polygon (20.3 ha) + panel rows,
  92,215 UNOSAT shelters base64 (int16 x, int16 y, u8 first-month|admin<<7, u8 close-month, 255 = standing Aug 2016).
- Raw downloads + venv live in the session scratchpad (re-download if lost; sources listed below).

## Status (12 Nov 2026)
- DONE: `zaatari_power.html` (artifact body, 8 chapters, dial + timebar, light/dark, mobile) and `index.html`
  (standalone wrapper, regenerate with `python3 scripts/make_index.py`).
- Published: https://claude.ai/artifact/SdoMf3wTVZLZGAqDxsSEtG (private until shared from its Share menu).
- Local preview: `python3 -m http.server 8712 --directory Day12_Power` from the challenge folder.

## Key facts (with sources)
- Pop.: >47,000 (Jul 2026), ~51,000 (Jan 2026), ~65,000 (Jun 2025), 80,970 (2022). 10,500 prefab shelters; 12 districts; 11 km to Syria.
- PV: 12.9 MWp, KfW EUR 15 m, Nov 2017; 22.3 GWh/yr avg 2018–21; 22.7 GWh in 2021 = 113 % of camp supply; 15,600 t CO2/yr;
  first net-metering project in Jordan; 33 kV line financed by Japan; ~150 electricians trained; O&M USD 725,735/yr (UNHCR).
- UNHCR power bill USD 4.33 m → 0.37 m first year; 2021 at 16 h/day: USD 2.18 m. Hours 6 → 11.5 (KfW); 9 h (2022, 2024: 12–15 & 17–23);
  up to 11 h (Jun 2025), up to 15 h (Jan 2026), 9–15 h (Jul 2026). Avg use 2.6 kWh/household/day.
- 12 main transformers + separate 3-transformer market-street network. Shops: car batteries, diesel generators, few rooftop PV.
- South Amman Solar 46.33 MWp (Green Deal for Jordan, KfW) allocation to Zaatari + Azraq; UNHCR pays O&M.
- Energy dispensers: 24 h, 7 kWh/household/day, ~6,500 refugees, 5–6 districts, ~90 % installed (Jul 2026).
- Jordan 2024 mix: gas 58 %, renewables 26.9 %, oil shale ~15 % (Attarat). 83 % of 2024 gas imports from Israel (Enerdata);
  65 km pipeline to Mafraq governorate; LNG via Aqaba FSRU backup.

Sources: UNHCR Zaatari factsheets (data.unhcr.org docs 124044, 121706, 119325); KfW ex-post evaluation 2022;
KfW story "solar-plant-zaatari"; Jordan Times (2024 mix; 2022 nine hours); Enerdata Jordan; World Oil 2018;
UNOSAT/HDX shelters 2016; REACH district map Dec 2016; OpenStreetMap; Natural Earth; AWS Terrain Tiles.
