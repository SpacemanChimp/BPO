# EVE Industry Route Planner

Static GitHub Pages web app (HTML/CSS/Vanilla JS) that ranks industry "routes" based on:

**Acquire materials (local or import) → manufacture at your chosen build location → haul finished goods to Jita → sell in Jita**

It models **two distinct markets**:

- **Costs:** local build market **buy** (or sell) prices (falls back to **Jita buy** if missing)
- **Revenue:** **live/current Jita prices** (sell by default; buy optional)

It then computes profit **including logistics and risk**.

> Not affiliated with CCP Games. EVE Online and ESI are trademarks/technology of CCP.

---

## Live price requirement (how it works)

At runtime the app pulls market data using public APIs:

- **Primary:** ESI market orders per type
  - Region orders: `GET https://esi.evetech.net/latest/markets/{region_id}/orders/?type_id={type_id}&datasource=tranquility&page={n}`
  - Jita is filtered to station **Jita 4-4** (stationID **60003760**) inside **The Forge** (regionID **10000002**)
- **Caching:** results cached in `localStorage` with timestamps
- **Refresh Prices:** clears price cache and refetches
- **Graceful degradation:** if APIs fail → uses cached data; if no cache → uses `/data/mock_prices.min.json`

**Default Jita:** The Forge / Jita IV - Moon 4 - Caldari Navy Assembly Plant.

---

## Blueprint + industry data

This repo includes tiny, offline-friendly SDE subsets in `/data/`:

- `data/blueprints.min.json` – a few sample blueprints
- `data/types.min.json` – type IDs + packaged volumes for common materials
- `data/category_map.min.json` – minimal mapping for invention constraints

**When online**, the app will also try to auto-fill missing blueprint details from the public EVE Ref reference dataset:

- `https://ref-data.everef.net/blueprints/{blueprintTypeId}`

This dramatically improves coverage without bundling a full SDE.

---

## Features checklist (mapped to your requirements)

### Per BPO outputs
For each blueprint, the app generates opportunities and picks the best:

- ✅ **Build & ship to Jita**
- ✅ **Copy & sell BPC** (estimated with configurable heuristics; see Assumptions)
- ✅ **Research ME/TE first** (heuristic ROI vs horizon)
- ✅ **Copy → Invention → Build → ship to Jita** (only when invention is allowed + invention activity exists)

Metrics shown:

- ✅ Profit/run, profit/hour, profit/day
- ✅ Profit per m³ (packaged volume)
- ✅ Margin %
- ✅ Capital required (materials + fees + invention expected cost + hauling/risk)
- ✅ Total time (copy + invention + manufacturing where applicable)

Expanded row:

- ✅ Step-by-step checklist
- ✅ Full material list with qty + price + market used
- ✅ Invention inputs, success chance, expected cost per successful BPC
- ✅ Taxes/fees + hauling + risk line items
- ✅ Buttons: copy shopping list, export CSV, add to watchlist

### Build location selection
- ✅ Highsec / Lowsec / Nullsec / Wormhole presets
- ✅ Optional build market scope: **Region ID / System ID / Station ID**
- ✅ Configurable **system cost index multiplier**
- ✅ Toggle: **Sell locally instead of Jita** (removes hauling)

### Invention constraint
- ✅ Default: only consider invention for **Rigs / Ammo / Drones**
- ✅ Toggle: enable invention for other categories

### Sourcing mode (ore/ice reprocessing)
- ✅ Checkbox: “I source minerals from reprocessing my own ore/ice”
- ✅ Reprocessing efficiency input
- ✅ Minerals are costed at **opportunity cost** (local buy or Jita buy)
- ✅ Optional stockpile quantities (if blank → unlimited stockpile)

### Build-slot realism & profit/slot
- ✅ Manufacturing/copy/invention slots + utilization %
- ✅ Widgets:
  - Top 10 per manufacturing slot
  - Top 10 per copy slot
  - Top 10 per invention slot
- ✅ Bottleneck indicator

### Haul constraints & trip planning
- ✅ Haul method (JF / DST / BR / Not sure)
- ✅ ISK per m³ shipping cost
- ✅ Risk premium % + estimated loss rate %
- ✅ Optional max m³ per trip
- ✅ Production horizon days
- ✅ If max m³/trip is set: trips/week + profit/m³ ranking support

### Industry trap filters
- ✅ Min margin %, min profit/run, capital ceiling (optional), max competition score
- ✅ Competition score (approx): spread + order count/depth (when order data is available)

### Component awareness (T2) – optional
- ✅ Toggle exists (default OFF)
- ℹ️ The scaffolding is present, but full component build-vs-buy requires more bundled blueprint coverage.

---

## How to run locally

Option A – simplest (recommended):

```bash
python3 -m http.server 8080 --directory .
```

Then open:

- `http://localhost:8080/eve-industry-route-planner/`

Option B – serve only the app directory:

```bash
cd eve-industry-route-planner
python3 -m http.server 8080
```

---

## Deploy to GitHub Pages

1. Create a repo (e.g. `eve-industry-route-planner`)
2. Put these files at the repo root (or in `/docs` if you prefer)
3. In GitHub:
   - Settings → Pages
   - Source: `Deploy from a branch`
   - Branch: `main` / root (or `/docs`)
4. Visit the Pages URL.

---

## Using the app

1. Paste your BPO list (one per line). Examples:

```
Hobgoblin I Blueprint ME10 TE20
Antimatter Charge S (ME 10 / TE 20)
Small Core Defense Field Extender I, ME8, TE14
Damage Control I ME0 TE0
```

2. Choose your build space (HS/LS/NS/WH)
3. (Optional) Set build market region/system/station IDs
4. Click **Analyze Opportunities**
5. Expand rows for the step-by-step plan and shopping list.

---

## IDs & defaults

Hardcoded defaults:

- **The Forge region:** `10000002`
- **Jita system:** `30000142`
- **Jita 4-4 station:** `60003760`

Build market scope fields:

- **Region ID**: used for local market order queries
- **System ID**: client-side filter (after fetching region orders)
- **Station ID**: client-side filter for NPC stations

> Player structure markets are not accessible via public ESI without auth, so structure IDs may yield “no local orders” and fall back to Jita.

---

## Assumptions & limitations (important)

This is meant to be a fast “what should I build next?” planner, not a perfect clone of the in-game Industry window.

### ME/TE modeling
- **TE:** `manufacturing_time * (1 - 0.02 * TE)` (clamped)
- **ME:** material “waste” approximation based on ME level.

### Installation fees & taxes
- Manufacturing installation fee is approximated as:
  - `input_cost * manufacturingJobFeeRate% * systemIndexMultiplier`
- Selling uses:
  - `brokerFeeRate% + salesTaxRate%` of revenue

You can tweak the fee constants in `app.js` (`FEE_DEFAULTS`).

### BPC selling
There is no universal public “BPC sell price” market feed (most trade via contracts). The **Copy & sell BPC** opportunity uses a configurable heuristic:

- `BPC value ≈ product_jita_price * runs_on_copy * 1.5%`

Adjust in `app.js` (`estimateBpcSellValue`).

### Competition score
Competition score is a rough proxy computed from:

- spread (best sell vs best buy)
- number of sell orders

### Data coverage
- Offline mode only supports a small demo subset.
- Online mode can fetch many missing blueprints from EVE Ref’s reference dataset.
- Some blueprints/invention chains may still be missing or require additional data sources.

---

## Files

- `index.html` – UI
- `styles.css` – styling
- `app.js` – all logic (pricing, caching, calculations)
- `/data/*.json` – minimal offline datasets + mock prices

---

## Extending blueprint coverage (optional)

If you want the app to work fully offline:

1. Gather blueprint JSON for the IDs you care about (from EVE Ref’s `/blueprints/{id}` endpoint)
2. Add those entries to `data/blueprints.min.json`
3. Add any new type IDs to `data/types.min.json`

---

## License

MIT (suggested). If you want a different license, drop a `LICENSE` file in the repo.
