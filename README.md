# EVE Industry Route Planner (Static GitHub Pages)

A static (HTML/CSS/Vanilla JS) industry planner for EVE Online that lets you paste a list of blueprints (BPO/BPC) and ranks build opportunities using **live Jita prices**.

This version is designed to work reliably on **GitHub Pages** without special browser settings.

---

## Why blueprint recipes are bundled (offline SDE subset)

**ESI does not provide** blueprint manufacturing materials / times / invention chains.

Historically, many community apps fetch blueprint recipes from third‑party SDE APIs (EVE Ref / Fuzzwork) from the browser. That approach is **not reliable on GitHub Pages** because those endpoints may not send permissive **CORS** headers, and browser-side fetches will fail.

**Solution:** all blueprint manufacturing recipes used by the app are resolved **locally** from JSON subsets bundled in `/data/`.

✅ Runtime HTTP calls are used **only** for live market pricing (Jita).  
❌ Blueprint recipe resolution never depends on runtime web calls.

---

## Included offline data coverage

The bundled subset is intentionally minimal, but broad enough for common **Tech I** analysis:

- **Tech I modules** (category “Module”): armor/shield mods, weapons, propulsion, ewar, capacitor modules, etc.
- **Tech I rigs**
- **Tech I ammo/charges**
- **Tech I drones**

If an input blueprint isn’t present in the subset, the UI will clearly report:

> **“Blueprint not included in offline SDE subset.”**

---

## Bundled data files

All required recipe/type resolution data lives in `/data/`:

- `data/blueprints.sde.min.json`  
  Manufacturing recipe subset:
  - `blueprintTypeId`
  - `productTypeId` + `productQty`
  - manufacturing `time`
  - `materials`: `[typeId, qty]` pairs

- `data/types.sde.min.json`  
  Type mapping:
  - `typeId` → `name`, packaged `volume`, `groupId`, `categoryId`

- `data/name_index.min.json`  
  Name resolution:
  - normalized name → typeId(s)
  - supports resolving both **blueprint names** and **product names**

- `data/mock_prices.min.json`  
  Offline fallback prices for development / no-internet mode.

---

## Input resolution rules

The parser accepts any of:

- `Multispectrum Energized Membrane I Blueprint ME10 TE20`
- `Multispectrum Energized Membrane I` (product name)
- `11268` (typeID)

Resolution logic:

1. Normalize input: trim, lowercase, collapse whitespace.
2. Accept both with a `Blueprint` suffix or without.
3. If the user enters a **product name**, resolve product `typeId` → map to blueprint via the local blueprint dataset.
4. If the user enters a **blueprint name**, resolve directly to the blueprint `typeId`.
5. If multiple matches exist, prefer: **exact** → **startsWith** → **contains**.

---

## Expanding the offline SDE subset

If you want more coverage (more blueprints, more categories, Tech II, invention chains, etc.), regenerate the JSON subset and commit it to `/data/`.

A small helper script is provided:

`tools/build_sde_subset.py`

### 1) Obtain SDE-derived reference data

Download EVE Ref “reference-data” (or an equivalent SDE-derived dump) and either:

- extract it to a directory, or
- keep it as a tarball (`reference-data-latest.tar.xz`)

### 2) Run the generator

From the repo root:

```bash
python3 tools/build_sde_subset.py --refdata /path/to/reference-data --outdir ./data
# OR
python3 tools/build_sde_subset.py --tar /path/to/reference-data-latest.tar.xz --outdir ./data
```

The script will rewrite:

- `data/blueprints.sde.min.json`
- `data/types.sde.min.json`
- `data/name_index.min.json`

Then commit and redeploy your static site.

---

## Acceptance tests

These must work on GitHub Pages in Chrome:

- Paste: `Multispectrum Energized Membrane I Blueprint` → resolves (no missing row).
- Paste: `Multispectrum Energized Membrane I` → resolves via product → blueprint mapping.
- With internet: live Jita pricing works, caching works, **Refresh** forces refresh.
