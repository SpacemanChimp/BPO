# EVE Industry Route Planner (Static GitHub Pages)

A static (HTML/CSS/Vanilla JS) industry planner for EVE Online that lets you paste a list of blueprints (BPO/BPC) and ranks build opportunities using **live market prices** (Jita by default).

This build is designed to work reliably on **GitHub Pages** without special browser settings.

---

## Why blueprint recipes are bundled (offline SDE subset)

**ESI does not provide** blueprint manufacturing materials, job times, copy/research times, or invention chain data.

Many community tools pull recipe data from third‑party SDE APIs (EVE Ref / Fuzzwork) directly from the browser. That approach is **not reliable on GitHub Pages** because those endpoints may not send permissive **CORS** headers, so browser-side fetches can fail.

**Solution:** all blueprint/type resolution and recipe data is bundled locally in `/data/` as small JSON files derived from SDE.

✅ Runtime HTTP is used **only** for live market pricing + caching.

❌ Blueprint recipe resolution never depends on runtime web calls.

---

## Included offline data coverage (this repo)

This repo ships with **mode: full** offline data, which covers:

- **All manufacturing blueprints** present in the SDE-derived dataset (Tech I + Tech II), including:
  - modules (and rigs)
  - ammo/charges
  - drones
  - ships
  - components
  - structures (where represented as manufacturing blueprints)
- For each included blueprint, when present in SDE:
  - **manufacturing** (time + material list + output)
  - **copying** time
  - **invention** (time + datacore/material list + possible T2 blueprint outputs)
  - **research_material** time/materials
  - **research_time** time/materials

Notes:

- Blueprints that *do not* have a **manufacturing** activity (e.g., some non-manufacturing formulas) are intentionally not included because the app currently models manufacturing/copy/invention/research paths.
- If an input blueprint isn’t present, the UI will clearly report:

> **“Blueprint not included in offline SDE subset.”**

---

## Bundled data files

All recipe/type resolution data lives in `/data/`:

- `data/blueprints.sde.min.json`
  - `blueprintTypeId`
  - `productTypeId` + `productQty`
  - manufacturing `time`
  - manufacturing `materials`: `[typeId, qty]` pairs
  - optional: `copyTime`, `invTime`, `invMaterials`, `invProducts`, `rmTime`, `rmMaterials`, `rtTime`, `rtMaterials`, `maxRuns`

- `data/types.sde.min.json`
  - `typeId` → `name`, packaged `volume`, `groupId`, `categoryId`

- `data/name_index.min.json`
  - normalized name → typeId(s)
  - supports resolving both **blueprint names** and **product names**

- `data/mock_prices.min.json`
  - offline fallback prices for development / no-internet mode.

---

## Input resolution rules

The parser accepts:

- `Multispectrum Energized Membrane I Blueprint ME10 TE20`
- `Multispectrum Energized Membrane I` (product name)
- `11268` (typeID)

Resolution logic:

1. Normalize input: trim, lowercase, collapse whitespace.
2. Accept both with a `Blueprint` suffix or without.
3. If the user enters a **product name**, resolve product `typeId` → map to blueprint via the bundled blueprint dataset.
4. If the user enters a **blueprint name**, resolve directly to the blueprint `typeId`.
5. If multiple matches exist, prefer: **exact** → **startsWith** → **contains**.

---

## Expanding / regenerating the offline data

A helper script is included:

`tools/build_sde_subset.py`

It consumes EVE Ref “reference-data” (SDE-derived) and regenerates the three bundled JSON files.

### 1) Download reference data

Download the EVE Ref reference-data tarball and keep it locally (no browser/CORS involvement):

- `reference-data-latest.tar.xz`

### 2) Run the generator

From the repo root:

```bash
# Full coverage (recommended)
python3 tools/build_sde_subset.py --tar ./reference-data-latest.tar.xz --outdir ./data --mode full

# Smaller Tech I-focused subset (faster load)
python3 tools/build_sde_subset.py --tar ./reference-data-latest.tar.xz --outdir ./data --mode t1
```

Then commit the regenerated `/data/*.json` files and redeploy GitHub Pages.

---

## Acceptance tests

These must work on GitHub Pages in Chrome:

- Paste: `Multispectrum Energized Membrane I Blueprint` → resolves (no missing row).
- Paste: `Multispectrum Energized Membrane I` → resolves via product → blueprint mapping.
- With internet: live Jita pricing works, caching works, and **Refresh** forces a refresh.
