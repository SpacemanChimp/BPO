/*
  EVE Industry Route Planner
  - Static GitHub Pages (HTML/CSS/Vanilla JS)
  - Live Jita pricing via ESI market orders (region 10000002, station 60003760)
  - Cache in localStorage with timestamp + refresh button
  - Graceful degradation: cached → mocked prices

  Notes:
  - This app bundles a tiny offline /data subset, but will dynamically enrich blueprint data
    from EVE Ref reference JSON when available (no auth required).
*/

(function () {
  'use strict';

  // -----------------------------
  // Constants
  // -----------------------------

  const APP_VERSION = '1.0.2';

  const ESI_BASE = 'https://esi.evetech.net/latest';
  const ESI_DATASOURCE = 'datasource=tranquility';

  const JITA = {
    regionId: 10000002, // The Forge
    systemId: 30000142, // Jita
    stationId: 60003760, // Jita IV - Moon 4 - Caldari Navy Assembly Plant
    label: 'The Forge / Jita 4-4',
  };

  // Blueprint recipes are resolved locally from bundled SDE subsets in /data/.
  // We deliberately do NOT fetch blueprint recipes at runtime (ESI limitation + CORS/reliability on GitHub Pages).

  const STORAGE_KEYS = {
    settings: 'evirp.settings.v1',
    priceCache: 'evirp.prices.v1',
    typeCache: 'evirp.types.v1',
    blueprintCache: 'evirp.blueprints.v1',
    watchlist: 'evirp.watchlist.v1',
    lastInput: 'evirp.lastInput.v1',
  };

  const DEFAULTS = {
    buildSec: 'HS',
    rankingMode: 'profit_day',
    buildRegionId: '',
    buildSystemId: '',
    buildStationId: '',
    costPriceBasis: 'buy',
    revenuePriceBasis: 'sell',
    sellLocalToggle: false,
    systemIndexMultiplier: 1.0,

    sourceFromReprocessing: false,
    reprocEff: 78,
    mineralOpportunityBasis: 'local_buy',
    mineralStockpile: '',

    mfgSlots: 10,
    copySlots: 3,
    invSlots: 3,
    utilPct: 70,

    haulMethod: 'NOT_SURE',
    iskPerM3: 800,
    riskPremium: 2.0,
    lossRate: 0.5,
    maxM3: '',
    horizonDays: 7,

    minMargin: 8,
    minProfit: 250000,
    capitalCeiling: '',
    maxCompetition: 70,

    enableOtherInvention: false,
    invChanceAmmo: 40,
    invChanceDrone: 35,
    invChanceRig: 40,
    decryptorCost: 0,
    inventionFeeRate: 1.5,

    componentAwareness: false,
  };

  // Defaults by security space for risk/logistics and job cost index multiplier.
  const SECURITY_PRESETS = {
    HS: { riskPremium: 1.0, lossRate: 0.15, iskPerM3: 350, systemIndexMultiplier: 1.0 },
    LS: { riskPremium: 2.5, lossRate: 0.4, iskPerM3: 650, systemIndexMultiplier: 0.92 },
    NS: { riskPremium: 4.0, lossRate: 0.8, iskPerM3: 1100, systemIndexMultiplier: 0.80 },
    WH: { riskPremium: 6.0, lossRate: 1.2, iskPerM3: 1500, systemIndexMultiplier: 0.75 },
  };

  // Tax/fees (configurable in code; surfaced in breakdown output)
  const FEE_DEFAULTS = {
    manufacturingJobFeeRate: 2.0, // % of input cost, scaled by systemIndexMultiplier
    brokerFeeRate: 2.0, // % of revenue
    salesTaxRate: 1.5, // % of revenue
  };

  const CACHE_TTL_MS = {
    prices: 15 * 60 * 1000, // 15 min
    types: 7 * 24 * 60 * 60 * 1000, // 7 days
    blueprints: 30 * 24 * 60 * 60 * 1000, // 30 days
  };

  const REQUEST_TIMEOUT_MS = 9000;
  const CONCURRENCY = 5;
  const MAX_PAGES_PER_TYPE = 20; // safety; most types will be far less

  // -----------------------------
  // Tiny offline fallbacks (the /data folder is the canonical source; these are last-resort)
  // -----------------------------

  const OFFLINE_FALLBACK = {
    typesByName: {
      Tritanium: { typeId: 34, packaged_volume: 0.01 },
      Pyerite: { typeId: 35, packaged_volume: 0.01 },
      Mexallon: { typeId: 36, packaged_volume: 0.01 },
      Isogen: { typeId: 37, packaged_volume: 0.01 },
      Nocxium: { typeId: 38, packaged_volume: 0.01 },
      Morphite: { typeId: 11399, packaged_volume: 0.01 },

      'Tripped Power Circuit': { typeId: 25598, packaged_volume: 0.01 },
      'Burned Logic Circuit': { typeId: 25600, packaged_volume: 0.01 },
      'Ward Console': { typeId: 25606, packaged_volume: 0.01 },
      'Power Circuit': { typeId: 25617, packaged_volume: 0.01 },
      'Logic Circuit': { typeId: 25619, packaged_volume: 0.01 },
      'Enhanced Ward Console': { typeId: 25625, packaged_volume: 0.01 },

      Robotics: { typeId: 9848, packaged_volume: 3 },
      'Guidance Systems': { typeId: 9834, packaged_volume: 0.01 },
      'Particle Accelerator Unit': { typeId: 11688, packaged_volume: 0.04 },
      'R.A.M.- Robotics': { typeId: 11481, packaged_volume: 0.04 },
      'R.A.M.- Shield Tech': { typeId: 11484, packaged_volume: 0.04 },
      'R.A.M.- Ammunition Tech': { typeId: 11476, packaged_volume: 0.04 },
      'Crystalline Carbonide': { typeId: 16670, packaged_volume: 0.01 },
      Fullerides: { typeId: 16679, packaged_volume: 0.01 },

      'Datacore - Quantum Physics': { typeId: 20414, packaged_volume: 0.1 },
      'Datacore - Plasma Physics': { typeId: 20412, packaged_volume: 0.1 },
      'Datacore - Hydromagnetic Physics': { typeId: 20171, packaged_volume: 0.1 },
      'Datacore - Electronic Engineering': { typeId: 20418, packaged_volume: 0.1 },
      'Datacore - Mechanical Engineering': { typeId: 20424, packaged_volume: 0.1 },
      'Datacore - Gallentean Starship Engineering': { typeId: 20410, packaged_volume: 0.1 },

      'Antimatter Charge S': { typeId: 222, packaged_volume: 0.005 },
      'Void S': { typeId: 12612, packaged_volume: 0.005 },
      'Hobgoblin I': { typeId: 2454, packaged_volume: 5 },
      'Hobgoblin II': { typeId: 2456, packaged_volume: 5 },
      'Small Core Defense Field Extender I': { typeId: 31788, packaged_volume: 5 },
      'Small Core Defense Field Extender II': { typeId: 31794, packaged_volume: 5 },
      'Damage Control I': { typeId: 2046, packaged_volume: 5 },

      'Antimatter Charge S Blueprint': { typeId: 1137, packaged_volume: 0.01 },
      'Void S Blueprint': { typeId: 12613, packaged_volume: 0.01 },
      'Hobgoblin I Blueprint': { typeId: 2455, packaged_volume: 0.01 },
      'Hobgoblin II Blueprint': { typeId: 2457, packaged_volume: 0.01 },
      'Small Core Defense Field Extender I Blueprint': { typeId: 31789, packaged_volume: 0.01 },
      'Small Core Defense Field Extender II Blueprint': { typeId: 31795, packaged_volume: 0.01 },
      'Damage Control I Blueprint': { typeId: 2047, packaged_volume: 0.01 },
    },
    // Ultra-minimal offline blueprint subset (enough for the "Load Example" button).
    blueprintsByTypeId: {
      1137: {
        blueprintTypeId: 1137,
        name: 'Antimatter Charge S Blueprint',
        maxRuns: 600,
        activities: {
          manufacturing: {
            time: 300,
            product: { typeId: 222, quantity: 100 },
            materials: [
              { typeId: 34, name: 'Tritanium', quantity: 204 },
              { typeId: 35, name: 'Pyerite', quantity: 17 },
              { typeId: 38, name: 'Nocxium', quantity: 1 },
            ],
          },
          copying: { time: 240 },
          invention: {
            time: 22800,
            products: [{ typeId: 12613, quantity: 1 }],
            materials: [
              { typeId: 20414, name: 'Datacore - Quantum Physics', quantity: 1 },
              { typeId: 20412, name: 'Datacore - Plasma Physics', quantity: 1 },
            ],
          },
        },
      },
      12613: {
        blueprintTypeId: 12613,
        name: 'Void S Blueprint',
        maxRuns: 10,
        activities: {
          manufacturing: {
            time: 4800,
            product: { typeId: 12612, quantity: 5000 },
            materials: [
              { typeId: 11399, name: 'Morphite', quantity: 1 },
              { typeId: 11476, name: 'R.A.M.- Ammunition Tech', quantity: 1 },
              { typeId: 16670, name: 'Crystalline Carbonide', quantity: 60 },
              { typeId: 16679, name: 'Fullerides', quantity: 60 },
            ],
          },
          copying: { time: 3840 },
        },
      },
      31789: {
        blueprintTypeId: 31789,
        name: 'Small Core Defense Field Extender I Blueprint',
        maxRuns: 60,
        activities: {
          manufacturing: {
            time: 1500,
            product: { typeId: 31788, quantity: 1 },
            materials: [
              { typeId: 25598, name: 'Tripped Power Circuit', quantity: 4 },
              { typeId: 25600, name: 'Burned Logic Circuit', quantity: 4 },
              { typeId: 25606, name: 'Ward Console', quantity: 2 },
            ],
          },
          copying: { time: 2400 },
          invention: {
            time: 30000,
            products: [{ typeId: 31795, quantity: 1 }],
            materials: [
              { typeId: 20171, name: 'Datacore - Hydromagnetic Physics', quantity: 1 },
              { typeId: 20414, name: 'Datacore - Quantum Physics', quantity: 1 },
            ],
          },
        },
      },
      31795: {
        blueprintTypeId: 31795,
        name: 'Small Core Defense Field Extender II Blueprint',
        maxRuns: 1,
        activities: {
          manufacturing: {
            time: 15000,
            product: { typeId: 31794, quantity: 1 },
            materials: [
              { typeId: 11484, name: 'R.A.M.- Shield Tech', quantity: 1 },
              { typeId: 25617, name: 'Power Circuit', quantity: 1 },
              { typeId: 25619, name: 'Logic Circuit', quantity: 1 },
              { typeId: 25625, name: 'Enhanced Ward Console', quantity: 1 },
            ],
          },
          copying: { time: 12000 },
        },
      },
    },
    mockPricesByTypeId: {
      34: { buy: 5.2, sell: 5.4 },
      35: { buy: 8.6, sell: 9.2 },
      36: { buy: 63.0, sell: 66.0 },
      37: { buy: 155.0, sell: 165.0 },
      38: { buy: 680.0, sell: 720.0 },
      11399: { buy: 11500, sell: 12100 },
      25598: { buy: 2600, sell: 2900 },
      25600: { buy: 31000, sell: 33000 },
      25606: { buy: 38000, sell: 41000 },
      25617: { buy: 90000, sell: 97000 },
      25619: { buy: 93000, sell: 99000 },
      25625: { buy: 160000, sell: 175000 },
      9834: { buy: 10500, sell: 11200 },
      9848: { buy: 65000, sell: 70000 },
      11476: { buy: 39000, sell: 42000 },
      11484: { buy: 39000, sell: 42000 },
      11481: { buy: 39000, sell: 42000 },
      11688: { buy: 120000, sell: 130000 },
      16670: { buy: 18000, sell: 19000 },
      16679: { buy: 21000, sell: 22500 },
      20414: { buy: 86000, sell: 94000 },
      20412: { buy: 72000, sell: 80000 },
      20171: { buy: 85000, sell: 92000 },
      20418: { buy: 64000, sell: 70000 },
      20424: { buy: 60000, sell: 66000 },
      20410: { buy: 52000, sell: 60000 },

      222: { buy: 950, sell: 1020 },
      12612: { buy: 6800, sell: 7400 },
      2454: { buy: 145000, sell: 160000 },
      2456: { buy: 830000, sell: 900000 },
      31788: { buy: 260000, sell: 290000 },
      31794: { buy: 6000000, sell: 6500000 },
      2046: { buy: 430000, sell: 470000 },
    },
    categoryTagByTypeId: {
      222: 'ammo',
      12612: 'ammo',
      2454: 'drone',
      2456: 'drone',
      31788: 'rig',
      31794: 'rig',
      2046: 'module',
    },
  };

  // -----------------------------
  // State
  // -----------------------------

  const state = {
    settings: { ...DEFAULTS },
    data: {
      // Offline SDE subset (bundled in /data). Runtime HTTP is used ONLY for market pricing.
      typesById: new Map(), // typeId -> { typeId, name, volume, groupId, categoryId }
      typesByName: new Map(), // exact name -> same info (convenience)
      nameIndex: {}, // normalized name -> [typeId...]

      blueprintsByTypeId: new Map(), // blueprintTypeId -> normalized blueprint record (internal shape)
      blueprintTypeIdByProductTypeId: new Map(), // productTypeId -> blueprintTypeId

      mockPricesByTypeId: new Map(), // typeId -> { buy, sell }
    },
    caches: {
      prices: {},
      types: {},
      blueprints: {},
    },
    ui: {},
    lastPriceSource: '—',
    lastPriceUpdatedAt: null,
  };

  // -----------------------------
  // Utils
  // -----------------------------

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function nowMs() {
    return Date.now();
  }

  function safeNum(v, fallback = 0) {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }

  function round(n, digits = 2) {
    const p = 10 ** digits;
    return Math.round(n * p) / p;
  }

  function fmtIsk(n) {
    const num = safeNum(n, 0);
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
    return `${sign}${Math.round(abs)}`;
  }

  function fmtPct(n, digits = 1) {
    return `${round(n, digits)}%`;
  }

  function fmtTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m || !parts.length) parts.push(`${m}m`);
    return parts.join(' ');
  }

  function normalizeName(s) {
    return String(s || '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\u2013|\u2014/g, '-')
      .toLowerCase();
  }

  function isNumericTypeIdInput(s) {
    return /^\d+$/.test(String(s || '').trim());
  }

  function isBlueprintCategoryId(categoryId) {
    return Number(categoryId) === 9; // SDE "Blueprint" category
  }

  function getLocalTypeRow(typeId) {
    return state.data.typesById.get(Number(typeId)) || null;
  }

  function isBlueprintType(typeId) {
    const row = getLocalTypeRow(typeId);
    return isBlueprintCategoryId(row?.categoryId);
  }

  function getNameIndex() {
    return state.data.nameIndex || {};
  }

  // Best match by: exact > startsWith > contains
  function findBestNameIndexKey(queryNorm) {
    const idx = getNameIndex();
    if (!queryNorm) return null;
    if (idx[queryNorm]) return queryNorm;

    const keys = Object.keys(idx);

    // startsWith
    let bestKey = null;
    let bestScore = -Infinity;
    for (const key of keys) {
      if (!key.startsWith(queryNorm)) continue;
      // prefer the shortest completion
      const score = 1000 - (key.length - queryNorm.length);
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    if (bestKey) return bestKey;

    // contains
    for (const key of keys) {
      const pos = key.indexOf(queryNorm);
      if (pos === -1) continue;
      const score = 500 - pos - (key.length - queryNorm.length) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
    return bestKey;
  }

  function pickBlueprintTypeId(typeIds) {
    const ids = (Array.isArray(typeIds) ? typeIds : []).map(Number).filter((n) => Number.isFinite(n));
    if (!ids.length) return null;

    // Prefer a blueprint that we actually have recipe data for
    const withRecipe = ids.find((id) => state.data.blueprintsByTypeId.has(id));
    if (withRecipe) return withRecipe;

    // Else any blueprint category type
    const bpCat = ids.find((id) => isBlueprintType(id));
    return bpCat || ids[0];
  }

  function pickProductTypeId(typeIds) {
    const ids = (Array.isArray(typeIds) ? typeIds : []).map(Number).filter((n) => Number.isFinite(n));
    if (!ids.length) return null;

    // Prefer a product that maps to a blueprint we have
    const withBlueprint = ids.find((id) => state.data.blueprintTypeIdByProductTypeId.has(id));
    if (withBlueprint) return withBlueprint;

    // Else prefer non-blueprint category
    const nonBp = ids.find((id) => !isBlueprintType(id));
    return nonBp || ids[0];
  }


  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(text, kind = 'info') {
    const bar = state.ui.statusBar;
    if (!bar) return;
    bar.textContent = text;
    bar.dataset.kind = kind;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function withTimeout(promise, ms, label = 'request') {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }

  function deepMerge(base, patch) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const cur = idx++;
        results[cur] = await fn(items[cur], cur);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
  }

  // -----------------------------
  // Input parsing
  // -----------------------------

  function parseBpoList(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const out = [];
    for (const line of lines) {
      const meMatch = line.match(/\bME\s*[:=]?\s*(\d{1,2})\b/i) || line.match(/\bME(\d{1,2})\b/i);
      const teMatch = line.match(/\bTE\s*[:=]?\s*(\d{1,2})\b/i) || line.match(/\bTE(\d{1,2})\b/i);
      const me = clamp(meMatch ? Number(meMatch[1]) : 0, 0, 10);
      const te = clamp(teMatch ? Number(teMatch[1]) : 0, 0, 20);

      let name = line
        .replace(/\(.*?\)/g, ' ')
        .replace(/\bME\s*[:=]?\s*\d{1,2}\b/gi, ' ')
        .replace(/\bTE\s*[:=]?\s*\d{1,2}\b/gi, ' ')
        .replace(/\bME\d{1,2}\b/gi, ' ')
        .replace(/\bTE\d{1,2}\b/gi, ' ')
        .replace(/[\s,;]+/g, ' ')
        .trim();

      // If user pasted a product name, leave as-is; if blueprint name, we can handle both.
      out.push({ raw: line, name, me, te });
    }
    return out;
  }

  // -----------------------------
  // Data loading
  // -----------------------------

  async function loadJson(path) {
    const res = await withTimeout(fetch(path, { cache: 'no-cache' }), REQUEST_TIMEOUT_MS, `fetch ${path}`);
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
    return res.json();
  }

  async function loadBundledData() {
    // Load from localStorage caches
    state.caches.prices = lsGet(STORAGE_KEYS.priceCache, {});
    state.caches.types = lsGet(STORAGE_KEYS.typeCache, {});
    state.caches.blueprints = lsGet(STORAGE_KEYS.blueprintCache, {});

    // Load /data subsets (offline-friendly). Blueprint recipes are ALWAYS local.
    // Runtime HTTP is used ONLY for live market pricing.
    try {
      const [typesSde, nameIndex, blueprintsSde, mocks] = await Promise.all([
        loadJson('data/types.sde.min.json'),
        loadJson('data/name_index.min.json'),
        loadJson('data/blueprints.sde.min.json'),
        loadJson('data/mock_prices.min.json'),
      ]);
      hydrateData(typesSde, nameIndex, blueprintsSde, mocks);
    } catch (e) {
      console.warn('Data folder load failed; using offline fallback.', e);
      hydrateDataFromFallback();
    }
  }

  function hydrateDataFromFallback() {
    // Back-compat with the baked-in tiny fallback used for dev/offline demos.
    // This is only used if /data JSON files fail to load.
    state.data.typesById.clear();
    state.data.typesByName.clear();
    for (const [name, info] of Object.entries(OFFLINE_FALLBACK.typesByName || {})) {
      const row = {
        typeId: Number(info.typeId),
        name,
        volume: info.packaged_volume ?? info.volume ?? null,
        groupId: info.group_id ?? null,
        categoryId: null,
      };
      state.data.typesById.set(row.typeId, row);
      state.data.typesByName.set(name, row);
    }

    state.data.nameIndex = {};
    for (const [name, info] of Object.entries(OFFLINE_FALLBACK.typesByName || {})) {
      const key = normalizeName(name);
      state.data.nameIndex[key] = state.data.nameIndex[key] || [];
      state.data.nameIndex[key].push(Number(info.typeId));
    }

    state.data.mockPricesByTypeId.clear();
    for (const [typeId, price] of Object.entries(OFFLINE_FALLBACK.mockPricesByTypeId || OFFLINE_FALLBACK.mockPrices || {})) {
      state.data.mockPricesByTypeId.set(Number(typeId), price);
    }

    state.data.blueprintsByTypeId.clear();
    state.data.blueprintTypeIdByProductTypeId.clear();
    for (const [typeId, bp] of Object.entries(OFFLINE_FALLBACK.blueprintsByTypeId || {})) {
      const bpid = Number(typeId);
      const normalized = normalizeBlueprintRecord(bp);
      state.data.blueprintsByTypeId.set(bpid, normalized);
      const prodId = normalized?.activities?.manufacturing?.product?.typeId;
      if (prodId) state.data.blueprintTypeIdByProductTypeId.set(Number(prodId), bpid);
    }
  }

  function hydrateData(typesSde, nameIndex, blueprintsSde, mocks) {
    // --- Types ---
    state.data.typesById.clear();
    state.data.typesByName.clear();

    for (const [typeId, row] of Object.entries(typesSde?.types || {})) {
      const id = Number(typeId);
      const info = {
        typeId: id,
        name: row?.name || `Type ${id}`,
        volume: row?.volume ?? null,
        groupId: row?.groupId ?? null,
        categoryId: row?.categoryId ?? null,
      };
      state.data.typesById.set(id, info);
      // Keep exact-name map for convenience (UI + exact match)
      if (info.name) state.data.typesByName.set(info.name, info);
    }

    // --- Name index (normalized name -> typeId(s)) ---
    // Expected file shape: { generated, nameIndex: { "<normalized name>": [typeId, ...] } }
    state.data.nameIndex = (nameIndex && typeof nameIndex === 'object' ? nameIndex.nameIndex : null) || {};
    if (!state.data.nameIndex || typeof state.data.nameIndex !== 'object') state.data.nameIndex = {};

    // --- Blueprints (manufacturing recipes) ---
    state.data.blueprintsByTypeId.clear();
    state.data.blueprintTypeIdByProductTypeId.clear();

    for (const [bpTypeId, bp] of Object.entries(blueprintsSde?.blueprints || {})) {
      const blueprintTypeId = Number(bpTypeId);
      const productTypeId = Number(bp?.productTypeId);
      const productQty = Number(bp?.productQty ?? 1);
      const time = Number(bp?.time ?? 0);
      const mats = Array.isArray(bp?.materials) ? bp.materials : [];

      const blueprintName = state.data.typesById.get(blueprintTypeId)?.name || `Blueprint ${blueprintTypeId}`;

      const normalized = normalizeBlueprintRecord({
        blueprintTypeId,
        name: blueprintName,
        activities: {
          manufacturing: {
            time,
            product: { typeId: productTypeId, quantity: productQty },
            materials: mats.map(([t, q]) => ({ typeId: Number(t), quantity: Number(q) })),
          },
        },
      });

      state.data.blueprintsByTypeId.set(blueprintTypeId, normalized);
      if (productTypeId) state.data.blueprintTypeIdByProductTypeId.set(productTypeId, blueprintTypeId);
    }

    // --- Mock prices ---
    state.data.mockPricesByTypeId.clear();
    const mockMap = mocks?.mockPricesByTypeId || mocks?.jita || {};
    for (const [typeId, price] of Object.entries(mockMap)) {
      state.data.mockPricesByTypeId.set(Number(typeId), price);
    }
  }

  // -----------------------------
  // Settings
  // -----------------------------

  function loadSettings() {
    const saved = lsGet(STORAGE_KEYS.settings, {});
    state.settings = deepMerge(DEFAULTS, saved);
    // Apply preset defaults for sec space if not explicitly customized
    applySecurityPreset(state.settings.buildSec, false);
  }

  function saveSettings() {
    lsSet(STORAGE_KEYS.settings, state.settings);
  }

  function applySecurityPreset(sec, overwrite = true) {
    const preset = SECURITY_PRESETS[sec];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) {
      if (overwrite || state.settings[k] === DEFAULTS[k]) {
        state.settings[k] = v;
      }
    }
  }

  // -----------------------------
  // Type resolution and caching
  // -----------------------------

  function getCachedEntry(cache, key) {
    const entry = cache[key];
    if (!entry) return null;
    const age = nowMs() - entry.ts;
    return age <= entry.ttlMs ? entry.value : null;
  }

  function setCachedEntry(cache, key, value, ttlMs) {
    cache[key] = { ts: nowMs(), ttlMs, value };
  }

  
  async function resolveTypeIdByName(name) {
    if (!name) return null;

    // Exact match in bundled subset (original casing)
    const exact = state.data.typesByName.get(name);
    if (exact?.typeId) return exact.typeId;

    const norm = normalizeName(name);
    const cacheKey = `typeIdByName:${norm}`;
    const cached = getCachedEntry(state.caches.types, cacheKey);
    if (cached) return cached;

    // Local name index match: exact > startsWith > contains
    const bestKey = findBestNameIndexKey(norm);
    if (bestKey) {
      const ids = state.data.nameIndex?.[bestKey] || [];
      const preferBlueprint = /\bblueprint\b/i.test(name) || /\sblueprint\s*$/i.test(name);
      const typeId = preferBlueprint ? pickBlueprintTypeId(ids) : pickProductTypeId(ids);
      if (typeId) {
        setCachedEntry(state.caches.types, cacheKey, typeId, CACHE_TTL_MS.types);
        return typeId;
      }
    }

    // As a small convenience: if the user didn't include "Blueprint", try appending it.
    if (!/\bblueprint\b/i.test(name)) {
      const withBp = `${norm} blueprint`;
      const key2 = findBestNameIndexKey(withBp);
      if (key2) {
        const ids2 = state.data.nameIndex?.[key2] || [];
        const typeId2 = pickBlueprintTypeId(ids2);
        if (typeId2) {
          setCachedEntry(state.caches.types, cacheKey, typeId2, CACHE_TTL_MS.types);
          return typeId2;
        }
      }
    }

    return null;
  }

  async function getTypeInfo(typeId) {
    if (!typeId) return null;

    const id = Number(typeId);
    const cacheKey = `typeInfo:${id}`;
    const cached = getCachedEntry(state.caches.types, cacheKey);
    if (cached) return cached;

    const row = state.data.typesById.get(id);
    if (row) {
      const info = {
        typeId: id,
        name: row?.name || `Type ${id}`,
        volume: row?.volume ?? null,
        packaged_volume: row?.volume ?? null,
        group_id: row?.groupId ?? null,
        category_id: row?.categoryId ?? null,

        // Keep the SDE-style names too (handy for debugging)
        groupId: row?.groupId ?? null,
        categoryId: row?.categoryId ?? null,
      };
      setCachedEntry(state.caches.types, cacheKey, info, CACHE_TTL_MS.types);
      return info;
    }

    // last resort: return something stable (no network calls)
    const info = { typeId: id, name: `Type ${id}`, packaged_volume: null, group_id: null, category_id: null };
    setCachedEntry(state.caches.types, cacheKey, info, 60 * 60 * 1000);
    return info;
  }

  async function inferCategoryTagByTypeId(typeId) {
    if (!typeId) return 'other';

    const cacheKey = `categoryTag:${typeId}`;
    const cached = getCachedEntry(state.caches.types, cacheKey);
    if (cached) return cached;

    const info = await getTypeInfo(typeId);
    const name = String(info?.name || '').toLowerCase();
    const catId = Number(info?.category_id ?? info?.categoryId ?? NaN);
    const groupId = Number(info?.group_id ?? info?.groupId ?? NaN);

    let tag = 'other';

    // Prefer numeric IDs (stable), then fall back to name heuristics.
    if (isBlueprintCategoryId(catId)) tag = 'blueprint';
    else if (catId === 8) tag = 'ammo'; // "Charge" category
    else if (catId === 18) tag = 'drone';
    else if (catId === 7) {
      // Category 7 covers modules & rigs. Rigs are groups ~773-782 in SDE.
      if (Number.isFinite(groupId) && groupId >= 773 && groupId <= 782) tag = 'rig';
      else tag = 'module';
    } else {
      // Heuristic fallback (only when categoryId isn't present in subset)
      if (name.includes('rig')) tag = 'rig';
      else if (name.includes('drone')) tag = 'drone';
      else if (name.includes('charge') || name.includes('ammo') || name.includes('ammunition')) tag = 'ammo';
      else if (name.includes('blueprint')) tag = 'blueprint';
    }

    setCachedEntry(state.caches.types, cacheKey, tag, CACHE_TTL_MS.types);
    return tag;
  }

  // -----------------------------
  // Blueprint recipe handling (local-only)
  // -----------------------------

  function normalizeBlueprintRecord(bp) {
    // Accept both local-bundled format and converted API formats.
    if (!bp) return null;
    if (bp.activities?.manufacturing?.product) return bp;
    return bp;
  }


  async function getBlueprintByProductTypeId(productTypeId, { blueprintTypeIdHint = null } = {}) {
    // Local-only: resolve blueprint by productTypeId using bundled SDE subset.
    if (!productTypeId) return null;

    const id = Number(productTypeId);
    const cacheKey = `blueprintByProduct:${id}`;
    const cached = getCachedEntry(state.caches.blueprints, cacheKey);
    if (cached) return cached;

    const direct = state.data.blueprintTypeIdByProductTypeId.get(id);
    const bpTypeId = Number(blueprintTypeIdHint) || direct;
    if (bpTypeId) {
      const bp = state.data.blueprintsByTypeId.get(bpTypeId) || null;
      if (bp) {
        setCachedEntry(state.caches.blueprints, cacheKey, bp, CACHE_TTL_MS.blueprints);
        return bp;
      }
    }

    return null;
  }

  async function getBlueprintByTypeId(typeId) {
    if (!typeId) return null;

    const id = Number(typeId);
    const cacheKey = `blueprint:${id}`;
    const cached = getCachedEntry(state.caches.blueprints, cacheKey);
    if (cached) return cached;

    const bundled = state.data.blueprintsByTypeId.get(id) || null;
    if (bundled) {
      setCachedEntry(state.caches.blueprints, cacheKey, bundled, CACHE_TTL_MS.blueprints);
      return bundled;
    }

    return null;
  }

  async function resolveBlueprintConsiderProductName(name) {
    // Local-only resolution.
    // Returns: { name, blueprintTypeId, productTypeId, blueprint, reason? }
    if (!name) return null;

    const raw = String(name).trim();
    const nm = normalizeName(raw);

    // --- TypeID input (optional) ---
    if (isNumericTypeIdInput(raw)) {
      const typeId = Number(raw);

      // If they pasted a blueprint typeId
      const bp = await getBlueprintByTypeId(typeId);
      if (bp?.activities?.manufacturing?.product?.typeId) {
        return {
          name: raw,
          blueprintTypeId: typeId,
          productTypeId: bp.activities.manufacturing.product.typeId,
          blueprint: bp,
        };
      }

      // If they pasted a product typeId
      const bp2 = await getBlueprintByProductTypeId(typeId);
      if (bp2?.activities?.manufacturing?.product?.typeId) {
        const bpid = bp2.blueprintTypeId ?? state.data.blueprintTypeIdByProductTypeId.get(typeId) ?? null;
        return {
          name: raw,
          blueprintTypeId: bpid,
          productTypeId: bp2.activities.manufacturing.product.typeId,
          blueprint: bp2,
        };
      }

      // Known type but not in blueprint subset
      if (state.data.typesById.has(typeId)) {
        return {
          name: raw,
          blueprintTypeId: isBlueprintType(typeId) ? typeId : null,
          productTypeId: isBlueprintType(typeId) ? null : typeId,
          blueprint: null,
          reason: 'Blueprint not included in offline SDE subset.',
        };
      }

      return { name: raw, blueprint: null, reason: 'Blueprint not included in offline SDE subset.' };
    }

    const wantsBlueprint = /\bblueprint\b/i.test(raw) || /\sblueprint\s*$/i.test(raw);

    // --- Blueprint name input ---
    if (wantsBlueprint) {
      const stripped = nm.replace(/\s*blueprint\s*$/i, '').trim();
      const q1 = nm.endsWith(' blueprint') ? nm : `${nm} blueprint`;
      const q2 = stripped ? `${stripped} blueprint` : null;

      const queries = [q1, q2, nm, stripped].filter(Boolean);

      for (const q of queries) {
        const key = findBestNameIndexKey(q);
        if (!key) continue;
        const ids = state.data.nameIndex?.[key] || [];
        const bpTypeId = pickBlueprintTypeId(ids);
        if (!bpTypeId) continue;

        const bp = await getBlueprintByTypeId(bpTypeId);
        if (bp?.activities?.manufacturing?.product?.typeId) {
          return {
            name: raw,
            blueprintTypeId: bpTypeId,
            productTypeId: bp.activities.manufacturing.product.typeId,
            blueprint: bp,
          };
        }

        // Type exists, but recipe isn't bundled
        return {
          name: raw,
          blueprintTypeId: bpTypeId,
          productTypeId: null,
          blueprint: null,
          reason: 'Blueprint not included in offline SDE subset.',
        };
      }

      return { name: raw, blueprint: null, reason: 'Blueprint not included in offline SDE subset.' };
    }

    // --- Product name input ---
    const key = findBestNameIndexKey(nm);
    if (key) {
      const ids = state.data.nameIndex?.[key] || [];
      const prodTypeId = pickProductTypeId(ids);

      if (prodTypeId) {
        const bp = await getBlueprintByProductTypeId(prodTypeId);
        if (bp?.activities?.manufacturing?.product?.typeId) {
          const bpid = bp.blueprintTypeId ?? state.data.blueprintTypeIdByProductTypeId.get(prodTypeId) ?? null;
          return {
            name: raw,
            blueprintTypeId: bpid,
            productTypeId: bp.activities.manufacturing.product.typeId,
            blueprint: bp,
          };
        }

        // If they pasted a blueprint name without the suffix, try the blueprint candidate too.
        const maybeBpTypeId = pickBlueprintTypeId(ids);
        const bp2 = await getBlueprintByTypeId(maybeBpTypeId);
        if (bp2?.activities?.manufacturing?.product?.typeId) {
          return {
            name: raw,
            blueprintTypeId: maybeBpTypeId,
            productTypeId: bp2.activities.manufacturing.product.typeId,
            blueprint: bp2,
          };
        }

        return {
          name: raw,
          blueprintTypeId: null,
          productTypeId: prodTypeId,
          blueprint: null,
          reason: 'Blueprint not included in offline SDE subset.',
        };
      }
    }

    // As a last convenience: treat it like they forgot the suffix.
    const key2 = findBestNameIndexKey(`${nm} blueprint`);
    if (key2) {
      const ids2 = state.data.nameIndex?.[key2] || [];
      const bpTypeId2 = pickBlueprintTypeId(ids2);
      const bp3 = await getBlueprintByTypeId(bpTypeId2);
      if (bp3?.activities?.manufacturing?.product?.typeId) {
        return {
          name: raw,
          blueprintTypeId: bpTypeId2,
          productTypeId: bp3.activities.manufacturing.product.typeId,
          blueprint: bp3,
        };
      }
    }

    return { name: raw, blueprint: null, reason: 'Blueprint not included in offline SDE subset.' };
  }
// -----------------------------
  // Live pricing (ESI orders) + caching + fallback
  // -----------------------------

  function priceCacheKey({ regionId, systemId, stationId, typeId }) {
    return `p:${regionId || 'x'}:${systemId || 'x'}:${stationId || 'x'}:${typeId}`;
  }

  function isFresh(ts, ttlMs) {
    return typeof ts === 'number' && nowMs() - ts <= ttlMs;
  }

  function getMockPrice(typeId) {
    return state.data.mockPricesByTypeId.get(typeId) || null;
  }

  async function fetchAllOrdersForType(regionId, typeId) {
    // ESI endpoint is paginated. We'll fetch pages 1..X-Pages.
    const orders = [];
    let pages = 1;
    try {
      const firstUrl = `${ESI_BASE}/markets/${regionId}/orders/?${ESI_DATASOURCE}&type_id=${typeId}&page=1`;
      const firstRes = await withTimeout(fetch(firstUrl, { cache: 'no-cache' }), REQUEST_TIMEOUT_MS, 'ESI orders');
      if (!firstRes.ok) throw new Error(`ESI orders failed: ${firstRes.status}`);
      const firstData = await firstRes.json();
      orders.push(...firstData);
      const xpages = firstRes.headers.get('X-Pages');
      pages = clamp(Number(xpages || '1'), 1, MAX_PAGES_PER_TYPE);
    } catch (e) {
      throw e;
    }

    for (let page = 2; page <= pages; page++) {
      const url = `${ESI_BASE}/markets/${regionId}/orders/?${ESI_DATASOURCE}&type_id=${typeId}&page=${page}`;
      const res = await withTimeout(fetch(url, { cache: 'no-cache' }), REQUEST_TIMEOUT_MS, 'ESI orders page');
      if (!res.ok) break; // stop on failure; partial data is better than none
      const data = await res.json();
      orders.push(...data);
      // small delay to be nice
      if (page % 4 === 0) await sleep(50);
    }
    return orders;
  }

  function computeBestPricesFromOrders(orders, { systemId, stationId }) {
    let bestBuy = 0;
    let bestSell = Infinity;
    let buyCount = 0;
    let sellCount = 0;
    let sellVolume = 0;
    let buyVolume = 0;

    for (const o of orders || []) {
      if (systemId && o.system_id !== Number(systemId)) continue;
      if (stationId && o.location_id !== Number(stationId)) continue;
      const price = o.price;
      if (o.is_buy_order) {
        buyCount++;
        buyVolume += o.volume_remain || 0;
        if (price > bestBuy) bestBuy = price;
      } else {
        sellCount++;
        sellVolume += o.volume_remain || 0;
        if (price < bestSell) bestSell = price;
      }
    }

    if (!Number.isFinite(bestSell)) bestSell = 0;
    const spread = bestSell > 0 && bestBuy > 0 ? (bestSell - bestBuy) / bestSell : 1;

    // Competition score: tight spread + lots of sell orders = higher score.
    const spreadScore = 1 - clamp(spread / 0.15, 0, 1);
    const orderScore = clamp(Math.log10(sellCount + 1) / Math.log10(2000 + 1), 0, 1);
    const competition = Math.round(clamp(100 * (0.6 * spreadScore + 0.4 * orderScore), 0, 100));

    return {
      bestBuy,
      bestSell,
      buyCount,
      sellCount,
      buyVolume,
      sellVolume,
      spread,
      competition,
    };
  }

  async function getLivePrices({ regionId, systemId, stationId, typeId }) {
    const key = priceCacheKey({ regionId, systemId, stationId, typeId });
    const cached = state.caches.prices[key];

    // prefer fresh cache
    if (cached && isFresh(cached.ts, CACHE_TTL_MS.prices)) {
      return { ...cached.value, source: cached.source || 'cache' };
    }

    // try live ESI
    try {
      const orders = await fetchAllOrdersForType(regionId, typeId);
      const stats = computeBestPricesFromOrders(orders, { systemId, stationId });
      const value = {
        buy: stats.bestBuy,
        sell: stats.bestSell,
        meta: {
          buyCount: stats.buyCount,
          sellCount: stats.sellCount,
          spread: stats.spread,
          competition: stats.competition,
        },
      };
      state.caches.prices[key] = { ts: nowMs(), source: 'ESI', value };
      state.lastPriceSource = 'ESI';
      state.lastPriceUpdatedAt = nowMs();
      return { ...value, source: 'ESI' };
    } catch (e) {
      console.warn('Live price fetch failed; will fallback:', { regionId, typeId }, e);
    }

    // fallback: stale cache
    if (cached?.value) {
      return { ...cached.value, source: 'stale-cache' };
    }

    // fallback: mocked
    const mock = getMockPrice(typeId);
    if (mock) {
      return { buy: mock.buy, sell: mock.sell, meta: { competition: 50 }, source: 'mock' };
    }
    return { buy: 0, sell: 0, meta: { competition: 50 }, source: 'missing' };
  }

  function clearCaches() {
    state.caches.prices = {};
    state.caches.types = {};
    state.caches.blueprints = {};
    lsSet(STORAGE_KEYS.priceCache, state.caches.prices);
    lsSet(STORAGE_KEYS.typeCache, state.caches.types);
    lsSet(STORAGE_KEYS.blueprintCache, state.caches.blueprints);
  }

  function persistCaches() {
    lsSet(STORAGE_KEYS.priceCache, state.caches.prices);
    lsSet(STORAGE_KEYS.typeCache, state.caches.types);
    lsSet(STORAGE_KEYS.blueprintCache, state.caches.blueprints);
  }

  // -----------------------------
  // Computation
  // -----------------------------

  function meWasteMultiplier(me) {
    // Rough approximation for T1 BPOs: default waste 10% scaled down by ME.
    // (In-game math is more nuanced with rounding; we document this approximation.)
    const m = clamp(me, 0, 10);
    return 0.10 / (1 + m);
  }

  function teTimeMultiplier(te) {
    const t = clamp(te, 0, 20);
    return 1 - 0.02 * t;
  }

  function chooseSellPrice(pr, basis) {
    return basis === 'buy' ? pr.buy : pr.sell;
  }

  async function priceForInput(typeId, localCtx, jitaCtx) {
    const local = await getLivePrices({ ...localCtx, typeId });
    const jita = await getLivePrices({ ...jitaCtx, typeId });
    return { local, jita };
  }

  async function computeMaterialCost(materials, opts) {
    const {
      localCtx,
      jitaCtx,
      costBasis,
      sourceFromReprocessing,
      mineralOpportunityBasis,
      mineralNames,
      reprocEff,
      componentAwareness,
      componentStage,
      componentCompareBudget,
      settings,
    } = opts;

    const rows = [];
    let total = 0;
    const usedSources = new Set();

    for (const m of materials) {
      const typeId = m.typeId;
      const qty = m.quantity;
      const type = await getTypeInfo(typeId);
      const name = type?.name || m.name || `Type ${typeId}`;

      const isMineral = mineralNames.has(normalizeName(name));
      const pr = await priceForInput(typeId, localCtx, jitaCtx);

      let marketUsed = 'local';
      let priceUsed = chooseSellPrice(pr.local, costBasis);
      let priceSource = pr.local.source;

      // If local missing, fallback to Jita
      if (!priceUsed || priceUsed <= 0) {
        marketUsed = 'jita';
        priceUsed = chooseSellPrice(pr.jita, costBasis);
        priceSource = pr.jita.source;
      }

      // If sourcing minerals from reprocessing, optionally override to opportunity basis
      if (sourceFromReprocessing && isMineral) {
        if (mineralOpportunityBasis === 'jita_buy') {
          marketUsed = 'jita';
          priceUsed = pr.jita.buy;
          priceSource = pr.jita.source;
        } else if (mineralOpportunityBasis === 'local_buy') {
          marketUsed = 'local';
          priceUsed = pr.local.buy || pr.jita.buy;
          priceSource = pr.local.buy ? pr.local.source : pr.jita.source;
        }
        // show a hint: more ore needed if efficiency < 100
        // (does not change the ISK opportunity cost; included as informational only)
      }

      // Optional: component sourcing comparison (T2)
      // - Only kicks in when explicitly enabled and we still have "budget" left.
      // - This is intentionally 1-level deep: component build uses market-priced inputs.
      let componentDecision = null;
      if (
        componentAwareness &&
        componentStage === 't2' &&
        settings &&
        componentCompareBudget &&
        componentCompareBudget.remaining > 0
      ) {
        componentDecision = await maybeCheaperBuildCostForType({
          typeId,
          typeName: name,
          localCtx,
          jitaCtx,
          settings,
          buyUnitPrice: priceUsed || 0,
        });
        if (componentDecision?.choice === 'build') {
          marketUsed = 'build';
          priceUsed = componentDecision.buildUnitCost;
          priceSource = componentDecision.buildSource;
          componentCompareBudget.remaining -= 1;
        }
      }

      const line = qty * (priceUsed || 0);
      total += line;
      usedSources.add(priceSource);
      rows.push({ typeId, name, qty, price: priceUsed || 0, line, marketUsed, priceSource, isMineral, reprocEff, componentDecision });
    }

    return { total, rows, sources: Array.from(usedSources) };
  }

  async function maybeCheaperBuildCostForType({ typeId, typeName, localCtx, jitaCtx, settings, buyUnitPrice }) {
    // Guard rails: only try for plausible "component-like" items.
    // Skip minerals, very cheap items, or if name is already a blueprint.
    const nm = normalizeName(typeName);
    if (!typeName || nm.includes('blueprint')) return null;
    if (buyUnitPrice > 0 && buyUnitPrice < 1000) return null; // don't waste calls on tiny stuff

    // Cached decision
    const cacheKey = `cmpBuild:${typeId}`;
    const cached = getCachedEntry(state.caches.types, cacheKey);
    if (cached) return cached;

    // Try to find the component's blueprint on the public market (ESI search) and fetch its blueprint JSON.
    const bpTypeId = await resolveTypeIdByName(`${typeName} Blueprint`);
    if (!bpTypeId) {
      const decision = {
        blueprintTypeId: null,
        buyUnitCost: buyUnitPrice,
        buildUnitCost: null,
        buildSource: null,
        choice: 'insufficient',
        reason: 'No public blueprint found (or offline).',
      };
      setCachedEntry(state.caches.types, cacheKey, decision, 12 * 60 * 60 * 1000);
      return decision;
    }

    const bp = await getBlueprintByTypeId(bpTypeId);
    const act = bp?.activities?.manufacturing;
    if (!act?.product?.typeId || act.product.typeId !== typeId) {
      const decision = {
        blueprintTypeId: bpTypeId,
        buyUnitCost: buyUnitPrice,
        buildUnitCost: null,
        buildSource: null,
        choice: 'insufficient',
        reason: 'Blueprint data missing or does not produce this item.',
      };
      setCachedEntry(state.caches.types, cacheKey, decision, 12 * 60 * 60 * 1000);
      return decision;
    }

    const mineralNames = new Set(['tritanium', 'pyerite', 'mexallon', 'isogen', 'nocxium', 'zydrine', 'megacyte', 'morphite']);
    const mCost = await computeMaterialCost(act.materials || [], {
      localCtx,
      jitaCtx,
      costBasis: settings.costPriceBasis,
      sourceFromReprocessing: false,
      mineralOpportunityBasis: 'local_buy',
      mineralNames,
      reprocEff: settings.reprocEff,
      componentAwareness: false,
      componentStage: null,
      componentCompareBudget: null,
      settings: null,
    });

    const jobFee = computeManufacturingJobFee(mCost.total, settings.systemIndexMultiplier);
    const outQty = act.product.quantity || 1;
    const buildUnitCost = outQty > 0 ? (mCost.total + jobFee) / outQty : Infinity;

    const decision = {
      blueprintTypeId: bpTypeId,
      buyUnitCost: buyUnitPrice,
      buildUnitCost,
      buildSource: 'build(1-level)',
      choice: buildUnitCost > 0 && buildUnitCost < buyUnitPrice ? 'build' : 'buy',
      buildBreakdown: {
        materials: mCost,
        jobFee,
        timeSec: act.time || 0,
        outQty,
      },
    };

    setCachedEntry(state.caches.types, cacheKey, decision, 24 * 60 * 60 * 1000);
    return decision;
  }

  function computeHauling({ volumeM3, iskPerM3, riskPremiumPct, lossRatePct, sellLocally }) {
    if (sellLocally) {
      return { haulingCost: 0, riskCost: 0, lossExpected: 0, notes: 'Sell locally: hauling removed.' };
    }
    const haulingCost = volumeM3 * iskPerM3;
    const baseAtRisk = haulingCost;
    const riskCost = baseAtRisk * (riskPremiumPct / 100);
    const lossExpected = baseAtRisk * (lossRatePct / 100);
    return { haulingCost, riskCost, lossExpected, notes: '' };
  }

  function computeSellFees(revenue, brokerFeeRate, salesTaxRate) {
    const broker = revenue * (brokerFeeRate / 100);
    const tax = revenue * (salesTaxRate / 100);
    return { broker, tax, total: broker + tax };
  }

  function computeManufacturingJobFee(materialCost, systemIndexMultiplier) {
    const base = materialCost * (FEE_DEFAULTS.manufacturingJobFeeRate / 100);
    return base * safeNum(systemIndexMultiplier, 1);
  }

  function computeInventionJobFee(inventionInputsCost, inventionFeeRatePct, systemIndexMultiplier) {
    const base = inventionInputsCost * (inventionFeeRatePct / 100);
    return base * safeNum(systemIndexMultiplier, 1);
  }

  async function buildOpportunity_T1Manufacture({ bpo, bp, productTypeId, localCtx, jitaCtx, settings }) {
    const act = bp.activities.manufacturing;
    if (!act?.product?.typeId) throw new Error('Blueprint has no manufacturing product');

    const productInfo = await getTypeInfo(productTypeId);
    const productName = productInfo?.name || 'Unknown product';
    const productQty = act.product.quantity || 1;

    const mMult = 1 + meWasteMultiplier(bpo.me);
    const adjustedMaterials = act.materials.map((m) => ({ ...m, quantity: Math.ceil(m.quantity * mMult) }));

    const mineralNames = new Set(['tritanium', 'pyerite', 'mexallon', 'isogen', 'nocxium', 'zydrine', 'megacyte', 'morphite']);
    const materialCost = await computeMaterialCost(adjustedMaterials, {
      localCtx,
      jitaCtx,
      costBasis: settings.costPriceBasis,
      sourceFromReprocessing: settings.sourceFromReprocessing,
      mineralOpportunityBasis: settings.mineralOpportunityBasis,
      mineralNames,
      reprocEff: settings.reprocEff,
    });

    const baseTime = act.time || 0;
    const time = baseTime * teTimeMultiplier(bpo.te);

    const jobFee = computeManufacturingJobFee(materialCost.total, settings.systemIndexMultiplier);

    const productVol = safeNum(productInfo?.packaged_volume ?? productInfo?.volume, 0);
    const totalVol = productVol * productQty;

    const outputCtx = settings.sellLocalToggle ? localCtx : jitaCtx;
    const outputPrice = await getLivePrices({ ...outputCtx, typeId: productTypeId });
    const revenueUnitPrice = chooseSellPrice(outputPrice, settings.revenuePriceBasis);
    const revenue = revenueUnitPrice * productQty;

    const haul = computeHauling({
      volumeM3: totalVol,
      iskPerM3: settings.iskPerM3,
      riskPremiumPct: settings.riskPremium,
      lossRatePct: settings.lossRate,
      sellLocally: settings.sellLocalToggle,
    });

    const sellFees = computeSellFees(revenue, FEE_DEFAULTS.brokerFeeRate, FEE_DEFAULTS.salesTaxRate);

    const totalCost = materialCost.total + jobFee + haul.haulingCost + haul.riskCost + haul.lossExpected + sellFees.total;
    const profit = revenue - totalCost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : -100;

    const timeHours = time / 3600;
    const profitPerHour = timeHours > 0 ? profit / timeHours : profit;
    const profitPerDay = profitPerHour * 24;
    const profitPerM3 = totalVol > 0 ? profit / totalVol : 0;
    const capital = materialCost.total + jobFee + haul.haulingCost;

    return {
      id: 'build_ship',
      label: settings.sellLocalToggle ? 'Build & sell locally' : 'Build & ship to Jita',
      productTypeId,
      productName,
      kind: 'manufacturing',
      slotProfile: { mfgHrs: timeHours, copyHrs: 0, invHrs: 0 },
      metrics: {
        profitRun: profit,
        profitHour: profitPerHour,
        profitDay: profitPerDay,
        profitM3: profitPerM3,
        marginPct: margin,
        capital,
        timeSec: time,
        volumeM3: totalVol,
        competition: outputPrice?.meta?.competition ?? 50,
      },
      breakdown: {
        materials: materialCost,
        jobFee,
        revenue: { unitPrice: revenueUnitPrice, qty: productQty, total: revenue, source: outputPrice.source },
        hauling: haul,
        sellFees,
      },
      steps: buildHowToSteps(settings.sellLocalToggle),
    };
  }

  function buildHowToSteps(sellLocal) {
    const steps = [
      'Price-check inputs (local buy, fallback to Jita buy).',
      'Acquire materials (buy locally or import).',
      'Start manufacturing job at your build location.',
    ];
    if (!sellLocal) {
      steps.push('Package finished goods; compute haul volume; plan hauling method.', 'Haul finished goods to Jita 4-4.', 'List on Jita sell orders (or instant-sell to buy orders).');
    } else {
      steps.push('List on local sell orders (or instant-sell to local buy).');
    }
    return steps;
  }

  async function buildOpportunity_CopySell({ bpo, bp, productTypeId, localCtx, jitaCtx, settings }) {
    // BPC sales aren’t in ESI market; we use a configurable heuristic.
    const copyAct = bp.activities.copying;
    if (!copyAct?.time) return null;

    const productInfo = await getTypeInfo(productTypeId);
    const productName = productInfo?.name || 'Unknown product';
    const maxRuns = bp.maxRuns || 10;

    const outputCtx = settings.sellLocalToggle ? localCtx : jitaCtx;
    const productPrice = await getLivePrices({ ...outputCtx, typeId: productTypeId });
    const unitSell = chooseSellPrice(productPrice, settings.revenuePriceBasis);

    // Heuristic: BPC value ~ X% of full-run output value.
    const bpcFactor = 0.07; // 7% by default (documented in README)
    const estRevenue = unitSell * maxRuns * bpcFactor;

    // Copy job fee: we approximate as a small fraction of output value (or zero).
    const jobFee = estRevenue * 0.01;
    const profit = estRevenue - jobFee;

    const time = copyAct.time;
    const timeHours = time / 3600;
    const profitPerHour = timeHours > 0 ? profit / timeHours : profit;
    const profitPerDay = profitPerHour * 24;
    const volume = 0.01; // BPC volume negligible

    return {
      id: 'copy_sell',
      label: 'Copy & sell BPC (estimate)',
      productTypeId,
      productName,
      kind: 'copying',
      slotProfile: { mfgHrs: 0, copyHrs: timeHours, invHrs: 0 },
      metrics: {
        profitRun: profit,
        profitHour: profitPerHour,
        profitDay: profitPerDay,
        profitM3: volume ? profit / volume : 0,
        marginPct: estRevenue > 0 ? (profit / estRevenue) * 100 : 0,
        capital: jobFee,
        timeSec: time,
        volumeM3: volume,
        competition: productPrice?.meta?.competition ?? 50,
      },
      breakdown: {
        materials: { total: 0, rows: [], sources: [] },
        jobFee,
        revenue: { unitPrice: unitSell, qty: maxRuns, total: estRevenue, source: productPrice.source },
        hauling: { haulingCost: 0, riskCost: 0, lossExpected: 0, notes: 'BPC sale assumed via contracts; hauling ignored.' },
        sellFees: { broker: 0, tax: 0, total: 0 },
      },
      steps: [
        'Start a blueprint copy job (choose #runs per copy for your target buyer).',
        'List BPC via contract (recommended) or advertise in trade channels.',
        'Price is estimated by heuristic — adjust in code/README if you want.'
      ],
      notes: 'BPC markets are primarily contract-based; this is a heuristic estimate.',
    };
  }

  async function buildOpportunity_ResearchFirst({ bpo, bp, productTypeId, localCtx, jitaCtx, settings }) {
    // Uses blueprint research activities when available; otherwise returns null.
    const rm = bp.activities.research_material;
    const rt = bp.activities.research_time;
    if (!rm?.time && !rt?.time) return null;

    // Simple heuristic: check profit improvement from +1 ME / +2 TE (or +1 TE if small)
    const current = await buildOpportunity_T1Manufacture({ bpo, bp, productTypeId, localCtx, jitaCtx, settings });
    if (!current) return null;

    const next = {
      me: clamp(bpo.me + 1, 0, 10),
      te: clamp(bpo.te + 2, 0, 20),
    };
    const improved = await buildOpportunity_T1Manufacture({ bpo: { ...bpo, ...next }, bp, productTypeId, localCtx, jitaCtx, settings });
    if (!improved) return null;

    const deltaProfit = improved.metrics.profitRun - current.metrics.profitRun;
    if (deltaProfit <= 0) return null;

    const horizonDays = safeNum(settings.horizonDays, 7);
    const util = clamp(safeNum(settings.utilPct, 70) / 100, 0.05, 1);
    const mfgTimeHrs = (bp.activities.manufacturing?.time || 1) * teTimeMultiplier(bpo.te) / 3600;
    const runsPerSlotPerDay = mfgTimeHrs > 0 ? (24 * util) / mfgTimeHrs : 0;
    const expectedRuns = runsPerSlotPerDay * horizonDays;

    const roi = deltaProfit * expectedRuns;

    // Research time: use whichever exists; scale roughly by level.
    const researchTime = (rm?.time || 0) + (rt?.time || 0);
    const researchHours = researchTime / 3600;

    // Research material cost
    const mineralNames = new Set(['tritanium', 'pyerite', 'mexallon', 'isogen', 'nocxium', 'zydrine', 'megacyte', 'morphite']);
    const rmCost = rm?.materials?.length
      ? await computeMaterialCost(rm.materials, {
          localCtx,
          jitaCtx,
          costBasis: settings.costPriceBasis,
          sourceFromReprocessing: settings.sourceFromReprocessing,
          mineralOpportunityBasis: settings.mineralOpportunityBasis,
          mineralNames,
          reprocEff: settings.reprocEff,
        })
      : { total: 0, rows: [], sources: [] };

    const cost = rmCost.total;
    const net = roi - cost;

    // Only recommend if within horizon and net positive.
    const viable = net > 0 && researchHours / (24 * util) < horizonDays;
    if (!viable) return null;

    return {
      id: 'research_first',
      label: `Research ME/TE first (to ME${next.me} TE${next.te})`,
      productTypeId,
      productName: current.productName,
      kind: 'research',
      slotProfile: { mfgHrs: 0, copyHrs: researchHours, invHrs: 0 },
      metrics: {
        profitRun: net,
        profitHour: researchHours > 0 ? net / researchHours : net,
        profitDay: researchHours > 0 ? (net / researchHours) * 24 : net,
        profitM3: 0,
        marginPct: 0,
        capital: cost,
        timeSec: researchTime,
        volumeM3: 0,
        competition: current.metrics.competition,
      },
      breakdown: {
        materials: rmCost,
        jobFee: 0,
        revenue: { unitPrice: 0, qty: 0, total: roi, source: 'computed' },
        hauling: { haulingCost: 0, riskCost: 0, lossExpected: 0, notes: '' },
        sellFees: { broker: 0, tax: 0, total: 0 },
      },
      steps: [
        `Start ME research to reach ME${next.me} (estimated).`,
        `Start TE research to reach TE${next.te} (estimated).`,
        `Then manufacture as normal for the next ~${horizonDays} days.`
      ],
      notes: `Heuristic ROI over ${horizonDays} days of 1-slot production: +${fmtIsk(deltaProfit)} per run → ${fmtIsk(roi)} gain.`,
    };
  }

  function inventionAllowed(tag, settings) {
    const baseAllowed = tag === 'rig' || tag === 'ammo' || tag === 'drone';
    return baseAllowed || !!settings.enableOtherInvention;
  }

  function defaultInventionChance(tag, settings) {
    if (tag === 'ammo') return clamp(safeNum(settings.invChanceAmmo, 40), 1, 99) / 100;
    if (tag === 'drone') return clamp(safeNum(settings.invChanceDrone, 35), 1, 99) / 100;
    if (tag === 'rig') return clamp(safeNum(settings.invChanceRig, 40), 1, 99) / 100;
    return 0.3;
  }

  async function buildOpportunity_InventionChain({ bpo, bp, productTypeId, localCtx, jitaCtx, settings }) {
    const inv = bp.activities.invention;
    const copyAct = bp.activities.copying;
    if (!inv?.materials?.length || !inv?.products?.length || !copyAct?.time) return null;

    const productInfo = await getTypeInfo(productTypeId);
    const productName = productInfo?.name || 'Unknown product';
    const tag = await inferCategoryTagByTypeId(productTypeId);
    if (!inventionAllowed(tag, settings)) return null;

    // Invention result is a T2 blueprint type
    const t2BlueprintTypeId = inv.products[0].typeId;
    const t2Blueprint = await getBlueprintByTypeId(t2BlueprintTypeId);
    if (!t2Blueprint?.activities?.manufacturing?.product?.typeId) return null;

    const t2ProductTypeId = t2Blueprint.activities.manufacturing.product.typeId;
    const t2ProductInfo = await getTypeInfo(t2ProductTypeId);
    const t2Name = t2ProductInfo?.name || `T2 type ${t2ProductTypeId}`;

    // Copy time (for the invented BPC seed) — we assume one copy job per invention attempt.
    const copyTime = copyAct.time * teTimeMultiplier(bpo.te);

    // Invention inputs cost (use Jita buy by default)
    const mineralNames = new Set(['tritanium', 'pyerite', 'mexallon', 'isogen', 'nocxium', 'zydrine', 'megacyte', 'morphite']);
    const invInputsCost = await computeMaterialCost(inv.materials, {
      localCtx,
      jitaCtx,
      costBasis: 'buy',
      sourceFromReprocessing: false,
      mineralOpportunityBasis: 'jita_buy',
      mineralNames,
      reprocEff: settings.reprocEff,
    });

    const decryptorCost = safeNum(settings.decryptorCost, 0);
    const invFee = computeInventionJobFee(invInputsCost.total + decryptorCost, safeNum(settings.inventionFeeRate, 1.5), settings.systemIndexMultiplier);
    const invChance = defaultInventionChance(tag, settings);
    const expectedInvCostPerSuccess = invChance > 0 ? (invInputsCost.total + decryptorCost + invFee) / invChance : Infinity;

    // Manufacture T2
    const t2Act = t2Blueprint.activities.manufacturing;
    const t2Materials = t2Act.materials.map((m) => ({ ...m }));
    const componentBudget = settings.componentAwareness ? { remaining: 6 } : null;
    const t2MaterialCost = await computeMaterialCost(t2Materials, {
      localCtx,
      jitaCtx,
      costBasis: settings.costPriceBasis,
      sourceFromReprocessing: settings.sourceFromReprocessing,
      mineralOpportunityBasis: settings.mineralOpportunityBasis,
      mineralNames,
      reprocEff: settings.reprocEff,
      componentAwareness: !!settings.componentAwareness,
      componentStage: 't2',
      componentCompareBudget: componentBudget,
      settings,
    });

    const t2Time = (t2Act.time || 0) * teTimeMultiplier(bpo.te);
    const t2JobFee = computeManufacturingJobFee(t2MaterialCost.total, settings.systemIndexMultiplier);

    // Revenue in Jita or local
    const outCtx = settings.sellLocalToggle ? localCtx : jitaCtx;
    const outPrice = await getLivePrices({ ...outCtx, typeId: t2ProductTypeId });
    const unitRev = chooseSellPrice(outPrice, settings.revenuePriceBasis);
    const outQty = t2Act.product.quantity || 1;
    const revenue = unitRev * outQty;
    const sellFees = computeSellFees(revenue, FEE_DEFAULTS.brokerFeeRate, FEE_DEFAULTS.salesTaxRate);

    const prodVol = safeNum(t2ProductInfo?.packaged_volume ?? t2ProductInfo?.volume, 0);
    const totalVol = prodVol * outQty;
    const haul = computeHauling({
      volumeM3: totalVol,
      iskPerM3: settings.iskPerM3,
      riskPremiumPct: settings.riskPremium,
      lossRatePct: settings.lossRate,
      sellLocally: settings.sellLocalToggle,
    });

    const totalTime = copyTime + (inv.time || 0) + t2Time;
    const totalCosts = expectedInvCostPerSuccess + t2MaterialCost.total + t2JobFee + haul.haulingCost + haul.riskCost + haul.lossExpected + sellFees.total;
    const profit = revenue - totalCosts;

    const timeHours = totalTime / 3600;
    const profitPerHour = timeHours > 0 ? profit / timeHours : profit;
    const profitPerDay = profitPerHour * 24;
    const profitPerM3 = totalVol > 0 ? profit / totalVol : 0;
    const margin = revenue > 0 ? (profit / revenue) * 100 : -100;
    const capital = expectedInvCostPerSuccess + t2MaterialCost.total + t2JobFee + haul.haulingCost;

    return {
      id: 'copy_invent_build_ship',
      label: settings.sellLocalToggle ? 'Copy → Invention → Build (T2) → sell local' : 'Copy → Invention → Build (T2) → ship to Jita',
      productTypeId: t2ProductTypeId,
      productName: t2Name,
      kind: 'invention',
      slotProfile: { mfgHrs: t2Time / 3600, copyHrs: copyTime / 3600, invHrs: (inv.time || 0) / 3600 },
      metrics: {
        profitRun: profit,
        profitHour: profitPerHour,
        profitDay: profitPerDay,
        profitM3: profitPerM3,
        marginPct: margin,
        capital,
        timeSec: totalTime,
        volumeM3: totalVol,
        competition: outPrice?.meta?.competition ?? 50,
      },
      breakdown: {
        materials: t2MaterialCost,
        jobFee: t2JobFee,
        revenue: { unitPrice: unitRev, qty: outQty, total: revenue, source: outPrice.source },
        hauling: haul,
        sellFees,
        invention: {
          chance: invChance,
          timeSec: inv.time || 0,
          decryptorCost,
          inputs: invInputsCost,
          fee: invFee,
          expectedCostPerSuccess: expectedInvCostPerSuccess,
          t2BlueprintTypeId,
        },
      },
      steps: [
        `Copy ${productName} BPC (for invention).`,
        `Run invention job (expected success: ${fmtPct(invChance * 100, 0)}).`,
        `Manufacture ${t2Name}.`,
        settings.sellLocalToggle ? 'Sell locally.' : 'Haul to Jita 4-4 and sell.',
      ],
    };
  }

  function effectiveProfitPerDay(op, settings) {
    // Profit/day per bottleneck slot (mfg/copy/inv) with utilization.
    const util = clamp(safeNum(settings.utilPct, 70) / 100, 0.05, 1);
    const slots = {
      mfg: Math.max(1, safeNum(settings.mfgSlots, 10)),
      copy: Math.max(1, safeNum(settings.copySlots, 3)),
      inv: Math.max(1, safeNum(settings.invSlots, 3)),
    };

    const p = safeNum(op.metrics.profitRun, 0);
    const mfgHrs = safeNum(op.slotProfile.mfgHrs, 0);
    const copyHrs = safeNum(op.slotProfile.copyHrs, 0);
    const invHrs = safeNum(op.slotProfile.invHrs, 0);

    // units per day per stage
    const mfgUnitsDay = mfgHrs > 0 ? (24 * util * slots.mfg) / mfgHrs : Infinity;
    const copyUnitsDay = copyHrs > 0 ? (24 * util * slots.copy) / copyHrs : Infinity;
    const invUnitsDay = invHrs > 0 ? (24 * util * slots.inv) / invHrs : Infinity;

    const unitsDay = Math.min(mfgUnitsDay, copyUnitsDay, invUnitsDay);
    const profitDayTotal = unitsDay * p;

    // bottleneck
    const bottleneck = unitsDay === mfgUnitsDay ? 'manufacturing' : unitsDay === copyUnitsDay ? 'copying' : unitsDay === invUnitsDay ? 'invention' : '—';
    return { profitDayTotal, bottleneck, unitsDay };
  }

  function rankScore(op, settings) {
    const mode = settings.rankingMode;
    if (mode === 'profit_run') return safeNum(op.metrics.profitRun, -Infinity);
    if (mode === 'profit_m3') return safeNum(op.metrics.profitM3, -Infinity);
    if (mode === 'margin') return safeNum(op.metrics.marginPct, -Infinity);
    // profit_day (default)
    return effectiveProfitPerDay(op, settings).profitDayTotal;
  }

  function passesFilters(op, settings) {
    const m = safeNum(op.metrics.marginPct, -100);
    const pr = safeNum(op.metrics.profitRun, -Infinity);
    const cap = safeNum(op.metrics.capital, Infinity);
    const comp = safeNum(op.metrics.competition, 50);

    if (m < safeNum(settings.minMargin, 8)) return false;
    if (pr < safeNum(settings.minProfit, 250000)) return false;
    const ceiling = String(settings.capitalCeiling || '').trim();
    if (ceiling) {
      const c = safeNum(ceiling, Infinity);
      if (cap > c) return false;
    }
    if (comp > safeNum(settings.maxCompetition, 70)) return false;
    return true;
  }

  async function computeOpportunitiesForBpo(bpo) {
    const settings = state.settings;

    const localCtx = {
      regionId: settings.buildRegionId ? Number(settings.buildRegionId) : JITA.regionId,
      systemId: settings.buildSystemId ? Number(settings.buildSystemId) : null,
      stationId: settings.buildStationId ? Number(settings.buildStationId) : null,
    };
    const jitaCtx = { regionId: JITA.regionId, systemId: JITA.systemId, stationId: JITA.stationId };

    // resolve blueprint + product
    const resolved = await resolveBlueprintConsiderProductName(bpo.name);
    if (!resolved?.blueprint) {
      return {
        bpo,
        missing: true,
        error: resolved?.reason || 'Blueprint not included in offline SDE subset.',
        opportunities: [],
      };
    }

    const bp = normalizeBlueprintRecord(resolved.blueprint);
    const productTypeId = resolved.productTypeId;

    const ops = [];
    try {
      ops.push(await buildOpportunity_T1Manufacture({ bpo, bp, productTypeId, localCtx, jitaCtx, settings }));
    } catch (e) {
      console.warn('Failed to compute manufacturing opp:', e);
    }

    try {
      const c = await buildOpportunity_CopySell({ bpo, bp, productTypeId, localCtx, jitaCtx, settings });
      if (c) ops.push(c);
    } catch (e) {
      console.warn('Failed to compute copy opp:', e);
    }

    try {
      const r = await buildOpportunity_ResearchFirst({ bpo, bp, productTypeId, localCtx, jitaCtx, settings });
      if (r) ops.push(r);
    } catch (e) {
      console.warn('Failed to compute research opp:', e);
    }

    try {
      const inv = await buildOpportunity_InventionChain({ bpo, bp, productTypeId, localCtx, jitaCtx, settings });
      if (inv) ops.push(inv);
    } catch (e) {
      console.warn('Failed to compute invention opp:', e);
    }

    // Rank + filter
    const ranked = ops
      .filter(Boolean)
      .map((op) => ({ op, score: rankScore(op, settings), passes: passesFilters(op, settings) }))
      .sort((a, b) => b.score - a.score);

    const best = ranked.find((r) => r.passes)?.op || ranked[0]?.op || null;

    return {
      bpo,
      missing: false,
      blueprintTypeId: resolved.blueprintTypeId,
      productTypeId,
      productName: best?.productName || '—',
      opportunities: ranked.map((r) => r.op),
      best,
    };
  }

  // -----------------------------
  // Rendering
  // -----------------------------

  function clearResults() {
    state.ui.resultsBody.innerHTML = `<tr><td colspan="11" class="muted">Run an analysis to see results.</td></tr>`;
    state.ui.topMfg.innerHTML = '';
    state.ui.topCopy.innerHTML = '';
    state.ui.topInv.innerHTML = '';
    state.ui.priceSource.textContent = '—';
    state.ui.cacheFreshness.textContent = '—';
    state.ui.bottleneck.textContent = '—';
    state.ui.tripsWeek.textContent = '—';
  }

  function setSummaryCards({ bottleneck, tripsPerWeek }) {
    const src = state.lastPriceSource || '—';
    state.ui.priceSource.textContent = src;
    if (state.lastPriceUpdatedAt) {
      const mins = Math.round((nowMs() - state.lastPriceUpdatedAt) / 60000);
      state.ui.cacheFreshness.textContent = mins <= 1 ? 'just now' : `${mins}m ago`;
    } else {
      state.ui.cacheFreshness.textContent = '—';
    }
    state.ui.bottleneck.textContent = bottleneck || '—';
    state.ui.tripsWeek.textContent = tripsPerWeek != null ? String(tripsPerWeek) : '—';
  }

  function pill(text, kind) {
    const span = document.createElement('span');
    span.className = `pill ${kind || ''}`.trim();
    span.textContent = text;
    return span;
  }

  function fmtSignedISK(n) {
    const v = safeNum(n, 0);
    const sign = v >= 0 ? '+' : '-';
    return `${sign}${fmtIsk(Math.abs(v))}`;
  }

  function metricCell(n, positiveGood = true) {
    const v = safeNum(n, 0);
    const kind = v === 0 ? 'warn' : (v > 0 ? (positiveGood ? 'good' : 'bad') : (positiveGood ? 'bad' : 'good'));
    return pill(fmtSignedISK(v), kind);
  }

  function toggleDetailsRow(mainRow, detailRow) {
    const expanded = mainRow.dataset.expanded === '1';
    mainRow.dataset.expanded = expanded ? '0' : '1';
    if (expanded) {
      detailRow.remove();
      mainRow.querySelector('.row-btn').textContent = 'Details';
    } else {
      mainRow.after(detailRow);
      mainRow.querySelector('.row-btn').textContent = 'Hide';
    }
  }

  function renderMaterialList(rows) {
    const wrap = document.createElement('div');
    for (const r of rows) {
      const line = document.createElement('div');
      line.className = 'mrow';
      const left = document.createElement('div');
      const right = document.createElement('div');
      left.textContent = `${r.name} × ${r.qty}`;
      let suffix = r.marketUsed;
      if (r.componentDecision && (r.componentDecision.choice === 'build' || r.componentDecision.choice === 'buy' || r.componentDecision.choice === 'insufficient')) {
        const b = r.componentDecision;
        if (b.choice === 'build') {
          suffix = `build (saved ${fmtIsk(Math.max(0, (b.buyUnitCost - b.buildUnitCost) * r.qty))})`;
        } else if (b.choice === 'buy') {
          suffix = 'buy';
        } else {
          suffix = 'buy (insufficient build data)';
        }
      }
      right.textContent = `${fmtIsk(r.line)}  @ ${fmtIsk(r.price)} (${suffix})`;
      line.append(left, right);
      wrap.appendChild(line);
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No materials.';
      wrap.appendChild(empty);
    }
    return wrap;
  }

  function renderBreakdown(op) {
    const rows = [];
    const m = safeNum(op.breakdown.materials?.total, 0);
    const job = safeNum(op.breakdown.jobFee, 0);
    const haul = safeNum(op.breakdown.hauling?.haulingCost, 0);
    const risk = safeNum(op.breakdown.hauling?.riskCost, 0) + safeNum(op.breakdown.hauling?.lossExpected, 0);
    const fees = safeNum(op.breakdown.sellFees?.total, 0);
    rows.push(['Materials', m]);
    rows.push(['Manufacturing fees', job]);
    if (haul) rows.push(['Hauling', haul]);
    if (risk) rows.push(['Risk (premium+loss)', risk]);
    if (fees) rows.push(['Sell fees (broker+tax)', fees]);
    if (op.breakdown.invention) {
      rows.push(['Invention expected cost', safeNum(op.breakdown.invention.expectedCostPerSuccess, 0)]);
    }
    if (op.metrics && Number.isFinite(op.metrics.haulScore)) {
      rows.push(['Haul efficiency score', `${Math.round(op.metrics.haulScore)}/100`]);
    }
    rows.push(['Revenue', -safeNum(op.breakdown.revenue?.total, 0)]);

    const wrap = document.createElement('div');
    for (const [label, val] of rows) {
      const line = document.createElement('div');
      line.className = 'mrow';
      const left = document.createElement('div');
      const right = document.createElement('div');
      left.textContent = label;
      right.textContent = typeof val === 'string' ? val : fmtIsk(val);
      line.append(left, right);
      wrap.appendChild(line);
    }
    return wrap;
  }

  function buildShoppingListText(materialRows) {
    const agg = new Map();
    for (const r of materialRows || []) {
      const key = r.name;
      agg.set(key, (agg.get(key) || 0) + r.qty);
    }
    const lines = Array.from(agg.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, qty]) => `${name} x ${qty}`);
    return lines.join('\n');
  }

  function renderOpportunityRow(result) {
    const { bpo, best, missing, error } = result;
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.innerHTML = `<div><b>${escapeHtml(bpo.name)}</b></div><div class="muted">ME${bpo.me} TE${bpo.te}</div>`;

    const actionTd = document.createElement('td');
    if (missing) {
      actionTd.innerHTML = `<span class="pill warn">Missing data</span><div class="muted" style="margin-top:6px">${escapeHtml(error || '')}</div>`;
      tr.append(nameTd, actionTd);
      for (let i = 0; i < 9; i++) tr.appendChild(document.createElement('td'));
      return { tr, detail: null };
    }

    actionTd.innerHTML = `<b>${escapeHtml(best.label)}</b><div class="muted" style="margin-top:6px">${escapeHtml(best.productName)}</div>`;

    const profitRunTd = document.createElement('td');
    profitRunTd.className = 'num';
    profitRunTd.appendChild(metricCell(best.metrics.profitRun));

    const profitHrTd = document.createElement('td');
    profitHrTd.className = 'num';
    profitHrTd.appendChild(metricCell(best.metrics.profitHour));

    const eff = effectiveProfitPerDay(best, state.settings);
    const profitDayTd = document.createElement('td');
    profitDayTd.className = 'num';
    profitDayTd.appendChild(metricCell(eff.profitDayTotal));

    const profitM3Td = document.createElement('td');
    profitM3Td.className = 'num';
    profitM3Td.appendChild(pill(fmtIsk(best.metrics.profitM3), best.metrics.profitM3 > 0 ? 'good' : 'bad'));

    const marginTd = document.createElement('td');
    marginTd.className = 'num';
    marginTd.appendChild(pill(fmtPct(best.metrics.marginPct), best.metrics.marginPct > 0 ? 'good' : 'bad'));

    const capTd = document.createElement('td');
    capTd.className = 'num';
    capTd.appendChild(pill(fmtIsk(best.metrics.capital), ''));

    const timeTd = document.createElement('td');
    timeTd.className = 'num';
    timeTd.appendChild(pill(fmtTime(best.metrics.timeSec), ''));

    const compTd = document.createElement('td');
    compTd.className = 'num';
    const comp = safeNum(best.metrics.competition, 50);
    compTd.appendChild(pill(`${comp}/100`, comp > 80 ? 'bad' : comp > 60 ? 'warn' : 'good'));

    const btnTd = document.createElement('td');
    btnTd.className = 'num';
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost row-btn';
    btn.textContent = 'Details';
    btn.type = 'button';
    btnTd.appendChild(btn);

    tr.append(nameTd, actionTd, profitRunTd, profitHrTd, profitDayTd, profitM3Td, marginTd, capTd, timeTd, compTd, btnTd);

    // Detail row (template)
    const tpl = state.ui.rowDetailTemplate;
    const frag = tpl.content.cloneNode(true);
    const detailRow = frag.querySelector('tr');
    const stepsOl = detailRow.querySelector('.steps');
    const matsDiv = detailRow.querySelector('.materials');
    const breakdownDiv = detailRow.querySelector('.breakdown');
    const inventionDiv = detailRow.querySelector('.invention');

    stepsOl.innerHTML = '';
    for (const s of best.steps || []) {
      const li = document.createElement('li');
      li.textContent = s;
      stepsOl.appendChild(li);
    }

    matsDiv.innerHTML = '';
    matsDiv.appendChild(renderMaterialList(best.breakdown.materials?.rows || []));

    breakdownDiv.innerHTML = '';
    breakdownDiv.appendChild(renderBreakdown(best));

    inventionDiv.innerHTML = '';
    if (best.breakdown.invention) {
      const inv = best.breakdown.invention;
      const p = document.createElement('div');
      p.innerHTML = `<div class="mrow"><div>Success chance</div><div>${fmtPct(inv.chance * 100, 0)}</div></div>
                     <div class="mrow"><div>Expected cost / success</div><div>${fmtIsk(inv.expectedCostPerSuccess)}</div></div>
                     <div class="mrow"><div>Invention time</div><div>${fmtTime(inv.timeSec)}</div></div>`;
      inventionDiv.appendChild(p);
      // show inputs
      const inputs = document.createElement('div');
      inputs.style.marginTop = '8px';
      inputs.appendChild(renderMaterialList(inv.inputs?.rows || []));
      inventionDiv.appendChild(inputs);
    } else {
      inventionDiv.innerHTML = `<div class="muted">No invention step in this path.</div>`;
    }

    // detail row buttons
    const btnCopy = detailRow.querySelector('.btn-copy-list');
    btnCopy.addEventListener('click', () => {
      const txt = buildShoppingListText(best.breakdown.materials?.rows || []);
      copyToClipboard(txt);
      toast('Copied shopping list');
    });

    const btnWatch = detailRow.querySelector('.btn-add-watch');
    btnWatch.addEventListener('click', () => {
      addToWatchlist({
        bpoName: bpo.name,
        me: bpo.me,
        te: bpo.te,
        action: best.label,
        product: best.productName,
        profitRun: best.metrics.profitRun,
        addedAt: new Date().toISOString(),
      });
      toast('Added to watchlist');
    });

    btn.addEventListener('click', () => toggleDetailsRow(tr, detailRow));

    return { tr, detail: detailRow, best };
  }

  function escapeHtml(s) {
    return String(s || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function toast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.position = 'fixed';
    t.style.bottom = '14px';
    t.style.left = '50%';
    t.style.transform = 'translateX(-50%)';
    t.style.background = 'rgba(10,16,32,.95)';
    t.style.border = '1px solid rgba(255,255,255,.12)';
    t.style.padding = '10px 12px';
    t.style.borderRadius = '12px';
    t.style.boxShadow = '0 10px 30px rgba(0,0,0,.35)';
    t.style.zIndex = '99';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1400);
  }

  function renderTopLists(results) {
    const bestOps = results
      .filter((r) => !r.missing && r.best)
      .map((r) => ({ bpo: r.bpo, op: r.best }));

    // manufacturing slot
    const mfg = bestOps
      .filter((x) => x.op.slotProfile.mfgHrs > 0)
      .map((x) => ({
        label: x.bpo.name,
        value: effectiveProfitPerDay(x.op, state.settings).profitDayTotal / Math.max(1, safeNum(state.settings.mfgSlots, 10)),
        op: x.op,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const copy = bestOps
      .filter((x) => x.op.slotProfile.copyHrs > 0)
      .map((x) => ({
        label: x.bpo.name,
        value: effectiveProfitPerDay(x.op, state.settings).profitDayTotal / Math.max(1, safeNum(state.settings.copySlots, 3)),
        op: x.op,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const inv = bestOps
      .filter((x) => x.op.slotProfile.invHrs > 0)
      .map((x) => ({
        label: x.bpo.name,
        value: effectiveProfitPerDay(x.op, state.settings).profitDayTotal / Math.max(1, safeNum(state.settings.invSlots, 3)),
        op: x.op,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    function renderList(target, arr) {
      target.innerHTML = '';
      if (!arr.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = 'No entries (yet).';
        target.appendChild(li);
        return;
      }
      for (const it of arr) {
        const li = document.createElement('li');
        li.innerHTML = `<b>${escapeHtml(it.label)}</b> — ${fmtIsk(it.value)}/day/slot`;
        target.appendChild(li);
      }
    }

    renderList(state.ui.topMfg, mfg);
    renderList(state.ui.topCopy, copy);
    renderList(state.ui.topInv, inv);
  }

  function computeTripsPerWeek(results) {
    const maxM3 = String(state.settings.maxM3 || '').trim();
    if (!maxM3) return null;
    const max = safeNum(maxM3, 0);
    if (max <= 0) return null;

    const horizonDays = safeNum(state.settings.horizonDays, 7);
    const util = clamp(safeNum(state.settings.utilPct, 70) / 100, 0.05, 1);
    const mfgSlots = Math.max(1, safeNum(state.settings.mfgSlots, 10));

    // assume you fill all manufacturing slots with the top manufacturing-per-day item
    const candidates = results.filter((r) => !r.missing && r.best && r.best.slotProfile.mfgHrs > 0);
    if (!candidates.length) return null;
    const best = candidates
      .map((r) => {
        const op = r.best;
        const hrs = op.slotProfile.mfgHrs;
        const unitsDay = hrs > 0 ? (24 * util * mfgSlots) / hrs : 0;
        const volDay = unitsDay * safeNum(op.metrics.volumeM3, 0);
        return { op, volDay };
      })
      .sort((a, b) => b.volDay - a.volDay)[0];

    const totalVol = best.volDay * horizonDays;
    const trips = Math.ceil(totalVol / max);
    const tripsPerWeek = Math.round((trips / horizonDays) * 7 * 10) / 10;
    return tripsPerWeek;
  }

  function assignHaulEfficiencyScores(results, settings) {
    // Haul efficiency: normalized profit per m³ → 0..100 for the "best" opportunity per BPO.
    // Only meaningful when the user sets a max m³/trip, but we compute regardless for display.
    const vals = results
      .map((r) => r.best)
      .filter(Boolean)
      .map((op) => safeNum(op.metrics.profitM3, 0))
      .filter((v) => Number.isFinite(v));
    if (!vals.length) return;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    for (const r of results) {
      if (!r.best) continue;
      const v = safeNum(r.best.metrics.profitM3, 0);
      const score = Math.round(clamp(((v - min) / span) * 100, 0, 100));
      r.best.metrics.haulScore = score;
    }

    // Auto-prioritize ranking when a max m³/trip is set.
    const maxM3 = parseFloat(String(settings.maxM3 || '').replace(/,/g, ''));
    if (Number.isFinite(maxM3) && maxM3 > 0 && settings.rankingMode !== 'profit_m3') {
      settings.rankingMode = 'profit_m3';
    }
  }

  function computeGlobalBottleneck(results) {
    const bestOps = results.filter((r) => !r.missing && r.best).map((r) => r.best);
    if (!bestOps.length) return '—';
    // Evaluate bottleneck of the highest-ranked item
    const top = bestOps.sort((a, b) => rankScore(b, state.settings) - rankScore(a, state.settings))[0];
    return effectiveProfitPerDay(top, state.settings).bottleneck;
  }

  // -----------------------------
  // Watchlist
  // -----------------------------

  function loadWatchlist() {
    return lsGet(STORAGE_KEYS.watchlist, []);
  }

  function saveWatchlist(items) {
    lsSet(STORAGE_KEYS.watchlist, items);
  }

  function addToWatchlist(item) {
    const cur = loadWatchlist();
    cur.unshift(item);
    saveWatchlist(cur.slice(0, 200));
  }

  function renderWatchlistDialog() {
    const items = loadWatchlist();
    const wrap = state.ui.watchlistItems;
    wrap.innerHTML = '';
    if (!items.length) {
      wrap.innerHTML = `<div class="muted">No watchlist entries yet.</div>`;
      return;
    }
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'watch-item';
      card.innerHTML = `<b>${escapeHtml(it.bpoName)}</b>
        <div class="small">ME${it.me} TE${it.te} • ${escapeHtml(it.action)}</div>
        <div style="margin-top:8px">Profit/run: <b>${fmtSignedISK(it.profitRun)}</b></div>
        <div class="small" style="margin-top:6px">Added: ${escapeHtml(it.addedAt || '')}</div>`;
      wrap.appendChild(card);
    }
  }

  // -----------------------------
  // Export helpers
  // -----------------------------

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportCsv(results) {
    const cols = [
      'Blueprint',
      'ME',
      'TE',
      'Best Action',
      'Product',
      'Profit/run',
      'Profit/hour',
      'Profit/day (bottleneck)',
      'Profit/m3',
      'Margin %',
      'Capital',
      'Time (sec)',
      'Competition',
    ];

    const rows = [cols];
    for (const r of results) {
      if (r.missing || !r.best) {
        rows.push([r.bpo.name, r.bpo.me, r.bpo.te, 'MISSING', '', '', '', '', '', '', '', '', '']);
        continue;
      }
      const op = r.best;
      const eff = effectiveProfitPerDay(op, state.settings);
      rows.push([
        r.bpo.name,
        r.bpo.me,
        r.bpo.te,
        op.label,
        op.productName,
        Math.round(op.metrics.profitRun),
        Math.round(op.metrics.profitHour),
        Math.round(eff.profitDayTotal),
        round(op.metrics.profitM3, 2),
        round(op.metrics.marginPct, 2),
        Math.round(op.metrics.capital),
        Math.round(op.metrics.timeSec),
        op.metrics.competition,
      ]);
    }

    const csv = rows
      .map((r) => r.map((v) => {
        const s = String(v ?? '');
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replaceAll('"', '""')}"`;
        return s;
      }).join(','))
      .join('\n');

    downloadText('eve-industry-route-planner.csv', csv);
  }

  function copyShoppingListAll(results) {
    const agg = new Map();
    for (const r of results) {
      if (r.missing || !r.best) continue;
      for (const m of r.best.breakdown.materials?.rows || []) {
        const key = m.name;
        agg.set(key, (agg.get(key) || 0) + m.qty);
      }
    }
    const lines = Array.from(agg.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, qty]) => `${name} x ${qty}`);
    copyToClipboard(lines.join('\n'));
    toast('Copied combined shopping list');
  }

  // -----------------------------
  // UI wiring
  // -----------------------------

  function readSettingsFromUI() {
    const s = state.settings;
    s.buildSec = state.ui.buildSec.value;
    s.rankingMode = state.ui.rankingMode.value;
    s.buildRegionId = state.ui.buildRegionId.value.trim();
    s.buildSystemId = state.ui.buildSystemId.value.trim();
    s.buildStationId = state.ui.buildStationId.value.trim();
    s.costPriceBasis = state.ui.costPriceBasis.value;
    s.revenuePriceBasis = state.ui.revenuePriceBasis.value;
    s.sellLocalToggle = state.ui.sellLocalToggle.checked;
    s.systemIndexMultiplier = safeNum(state.ui.systemIndexMultiplier.value, 1);

    s.sourceFromReprocessing = state.ui.sourceFromReprocessing.checked;
    s.reprocEff = safeNum(state.ui.reprocEff.value, 78);
    s.mineralOpportunityBasis = state.ui.mineralOpportunityBasis.value;
    s.mineralStockpile = state.ui.mineralStockpile.value;

    s.mfgSlots = safeNum(state.ui.mfgSlots.value, 10);
    s.copySlots = safeNum(state.ui.copySlots.value, 3);
    s.invSlots = safeNum(state.ui.invSlots.value, 3);
    s.utilPct = safeNum(state.ui.utilPct.value, 70);

    s.haulMethod = state.ui.haulMethod.value;
    s.iskPerM3 = safeNum(state.ui.iskPerM3.value, 800);
    s.riskPremium = safeNum(state.ui.riskPremium.value, 2);
    s.lossRate = safeNum(state.ui.lossRate.value, 0.5);
    s.maxM3 = state.ui.maxM3.value.trim();
    s.horizonDays = safeNum(state.ui.horizonDays.value, 7);

    s.minMargin = safeNum(state.ui.minMargin.value, 8);
    s.minProfit = safeNum(state.ui.minProfit.value, 250000);
    s.capitalCeiling = state.ui.capitalCeiling.value.trim();
    s.maxCompetition = safeNum(state.ui.maxCompetition.value, 70);

    s.enableOtherInvention = state.ui.enableOtherInvention.checked;
    s.invChanceAmmo = safeNum(state.ui.invChanceAmmo.value, 40);
    s.invChanceDrone = safeNum(state.ui.invChanceDrone.value, 35);
    s.invChanceRig = safeNum(state.ui.invChanceRig.value, 40);
    s.decryptorCost = safeNum(state.ui.decryptorCost.value, 0);
    s.inventionFeeRate = safeNum(state.ui.inventionFeeRate.value, 1.5);

    s.componentAwareness = state.ui.componentAwareness.checked;
  }

  function writeSettingsToUI() {
    const s = state.settings;
    state.ui.buildSec.value = s.buildSec;
    state.ui.rankingMode.value = s.rankingMode;
    state.ui.buildRegionId.value = s.buildRegionId;
    state.ui.buildSystemId.value = s.buildSystemId;
    state.ui.buildStationId.value = s.buildStationId;
    state.ui.costPriceBasis.value = s.costPriceBasis;
    state.ui.revenuePriceBasis.value = s.revenuePriceBasis;
    state.ui.sellLocalToggle.checked = !!s.sellLocalToggle;
    state.ui.systemIndexMultiplier.value = String(s.systemIndexMultiplier);

    state.ui.sourceFromReprocessing.checked = !!s.sourceFromReprocessing;
    state.ui.reprocEff.value = String(s.reprocEff);
    state.ui.mineralOpportunityBasis.value = s.mineralOpportunityBasis;
    state.ui.mineralStockpile.value = s.mineralStockpile || '';

    state.ui.mfgSlots.value = String(s.mfgSlots);
    state.ui.copySlots.value = String(s.copySlots);
    state.ui.invSlots.value = String(s.invSlots);
    state.ui.utilPct.value = String(s.utilPct);

    state.ui.haulMethod.value = s.haulMethod;
    state.ui.iskPerM3.value = String(s.iskPerM3);
    state.ui.riskPremium.value = String(s.riskPremium);
    state.ui.lossRate.value = String(s.lossRate);
    state.ui.maxM3.value = String(s.maxM3 || '');
    state.ui.horizonDays.value = String(s.horizonDays);

    state.ui.minMargin.value = String(s.minMargin);
    state.ui.minProfit.value = String(s.minProfit);
    state.ui.capitalCeiling.value = String(s.capitalCeiling || '');
    state.ui.maxCompetition.value = String(s.maxCompetition);

    state.ui.enableOtherInvention.checked = !!s.enableOtherInvention;
    state.ui.invChanceAmmo.value = String(s.invChanceAmmo);
    state.ui.invChanceDrone.value = String(s.invChanceDrone);
    state.ui.invChanceRig.value = String(s.invChanceRig);
    state.ui.decryptorCost.value = String(s.decryptorCost);
    state.ui.inventionFeeRate.value = String(s.inventionFeeRate);

    state.ui.componentAwareness.checked = !!s.componentAwareness;
  }

  function wireSecurityPresetAuto() {
    state.ui.buildSec.addEventListener('change', () => {
      readSettingsFromUI();
      applySecurityPreset(state.settings.buildSec, true);
      writeSettingsToUI();
      saveSettings();
    });
  }

  async function handleAnalyze() {
    readSettingsFromUI();
    // If max m³/trip is set, we default to ranking by profit per m³ (haul-constrained mode).
    const maxM3 = parseFloat(String(state.settings.maxM3 || '').replace(/,/g, ''));
    const haulConstrained = Number.isFinite(maxM3) && maxM3 > 0;
    if (haulConstrained && state.settings.rankingMode !== 'profit_m3') {
      state.settings.rankingMode = 'profit_m3';
      state.ui.rankingMode.value = 'profit_m3';
    }
    saveSettings();
    lsSet(STORAGE_KEYS.lastInput, state.ui.bpoInput.value);

    setStatus('Analyzing… (fetching prices as needed)', 'info');
    state.ui.btnAnalyze.disabled = true;

    const bpos = parseBpoList(state.ui.bpoInput.value);
    if (!bpos.length) {
      clearResults();
      setStatus('Paste at least one BPO line.', 'warn');
      state.ui.btnAnalyze.disabled = false;
      return;
    }

    // First pass: resolve blueprints + product IDs, and collect type IDs we’ll need prices for
    const resolved = await mapLimit(bpos, CONCURRENCY, async (bpo) => {
      return computeOpportunitiesForBpo(bpo);
    });

    // Assign haul-efficiency scores (0..100) to the chosen/best opportunity per blueprint
    assignHaulEfficiencyScores(resolved, state.settings);

    // Assign haul-efficiency scores (normalized profit/m³) and render
    assignHaulEfficiencyScores(resolved, state.settings);

    // Render
    state.ui.resultsBody.innerHTML = '';
    const renderedRows = [];
    for (const r of resolved) {
      const { tr } = renderOpportunityRow(r);
      state.ui.resultsBody.appendChild(tr);
      renderedRows.push({ result: r, row: tr });
    }

    renderTopLists(resolved);
    const tripsWeek = computeTripsPerWeek(resolved);
    const bottleneck = computeGlobalBottleneck(resolved);
    setSummaryCards({ bottleneck, tripsPerWeek: tripsWeek });

    setStatus(`Done • ${resolved.length} BPO(s) evaluated`, 'info');
    state.ui.btnAnalyze.disabled = false;

    // Persist caches after a run
    persistCaches();

    // stash for export/copy
    state._lastResults = resolved;
  }

  async function handleRefreshPrices() {
    // Clears only price cache, keeps types/blueprints.
    state.caches.prices = {};
    lsSet(STORAGE_KEYS.priceCache, state.caches.prices);
    state.lastPriceSource = '—';
    state.lastPriceUpdatedAt = null;
    toast('Price cache cleared. Next analysis will refetch.');
  }

  function handleClearCacheAll() {
    clearCaches();
    toast('All caches cleared (prices, type lookups, blueprints).');
  }

  function loadExample() {
    state.ui.bpoInput.value = [
      'Antimatter Charge S Blueprint ME10 TE20',
      'Hobgoblin I Blueprint ME8 TE14',
      'Small Core Defense Field Extender I, ME8, TE14',
      'Multispectrum Energized Membrane I Blueprint ME10 TE20',
    ].join('\n');
  }

  function bindUI() {
    state.ui = {
      // inputs
      bpoInput: el('bpoInput'),
      buildSec: el('buildSec'),
      rankingMode: el('rankingMode'),
      buildRegionId: el('buildRegionId'),
      buildSystemId: el('buildSystemId'),
      buildStationId: el('buildStationId'),
      costPriceBasis: el('costPriceBasis'),
      revenuePriceBasis: el('revenuePriceBasis'),
      sellLocalToggle: el('sellLocalToggle'),
      systemIndexMultiplier: el('systemIndexMultiplier'),

      sourceFromReprocessing: el('sourceFromReprocessing'),
      reprocEff: el('reprocEff'),
      mineralOpportunityBasis: el('mineralOpportunityBasis'),
      mineralStockpile: el('mineralStockpile'),

      mfgSlots: el('mfgSlots'),
      copySlots: el('copySlots'),
      invSlots: el('invSlots'),
      utilPct: el('utilPct'),

      haulMethod: el('haulMethod'),
      iskPerM3: el('iskPerM3'),
      riskPremium: el('riskPremium'),
      lossRate: el('lossRate'),
      maxM3: el('maxM3'),
      horizonDays: el('horizonDays'),

      minMargin: el('minMargin'),
      minProfit: el('minProfit'),
      capitalCeiling: el('capitalCeiling'),
      maxCompetition: el('maxCompetition'),

      enableOtherInvention: el('enableOtherInvention'),
      invChanceAmmo: el('invChanceAmmo'),
      invChanceDrone: el('invChanceDrone'),
      invChanceRig: el('invChanceRig'),
      decryptorCost: el('decryptorCost'),
      inventionFeeRate: el('inventionFeeRate'),
      componentAwareness: el('componentAwareness'),

      // actions
      btnAnalyze: el('btnAnalyze'),
      btnLoadExample: el('btnLoadExample'),
      btnRefreshPrices: el('btnRefreshPrices'),
      btnClearCache: el('btnClearCache'),
      btnExportCsv: el('btnExportCsv'),
      btnCopyShopping: el('btnCopyShopping'),
      btnViewWatchlist: el('btnViewWatchlist'),

      // results
      resultsBody: el('resultsBody'),
      topMfg: el('topMfg'),
      topCopy: el('topCopy'),
      topInv: el('topInv'),
      priceSource: el('priceSource'),
      cacheFreshness: el('cacheFreshness'),
      bottleneck: el('bottleneck'),
      tripsWeek: el('tripsWeek'),

      // dialogs
      watchlistDialog: el('watchlistDialog'),
      watchlistItems: el('watchlistItems'),
      btnClearWatchlist: el('btnClearWatchlist'),

      // templates
      rowDetailTemplate: el('rowDetailTemplate'),
      statusBar: el('statusBar'),
    };

    // Some fields that were added in JS must exist
    if (!state.ui.systemIndexMultiplier) {
      console.warn('Missing #systemIndexMultiplier input. Add it in index.html');
    }

    state.ui.btnAnalyze.addEventListener('click', handleAnalyze);
    state.ui.btnLoadExample.addEventListener('click', () => {
      loadExample();
      toast('Loaded example');
    });
    state.ui.btnRefreshPrices.addEventListener('click', handleRefreshPrices);
    state.ui.btnClearCache.addEventListener('click', handleClearCacheAll);

    state.ui.btnExportCsv.addEventListener('click', () => {
      const res = state._lastResults || [];
      if (!res.length) return toast('Nothing to export yet.');
      exportCsv(res);
    });
    state.ui.btnCopyShopping.addEventListener('click', () => {
      const res = state._lastResults || [];
      if (!res.length) return toast('Nothing to copy yet.');
      copyShoppingListAll(res);
    });

    state.ui.btnViewWatchlist.addEventListener('click', () => {
      renderWatchlistDialog();
      state.ui.watchlistDialog.showModal();
    });
    state.ui.btnClearWatchlist.addEventListener('click', (e) => {
      e.preventDefault();
      saveWatchlist([]);
      renderWatchlistDialog();
      toast('Watchlist cleared');
    });

    // Save settings on change (debounced-ish)
    let saveTimer;
    const watchIds = [
      'rankingMode',
      'buildRegionId',
      'buildSystemId',
      'buildStationId',
      'costPriceBasis',
      'revenuePriceBasis',
      'sellLocalToggle',
      'systemIndexMultiplier',
      'sourceFromReprocessing',
      'reprocEff',
      'mineralOpportunityBasis',
      'mfgSlots',
      'copySlots',
      'invSlots',
      'utilPct',
      'haulMethod',
      'iskPerM3',
      'riskPremium',
      'lossRate',
      'maxM3',
      'horizonDays',
      'minMargin',
      'minProfit',
      'capitalCeiling',
      'maxCompetition',
      'enableOtherInvention',
      'invChanceAmmo',
      'invChanceDrone',
      'invChanceRig',
      'decryptorCost',
      'inventionFeeRate',
      'componentAwareness',
    ];
    for (const id of watchIds) {
      const node = el(id);
      if (!node) continue;
      node.addEventListener('change', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          readSettingsFromUI();
          saveSettings();
        }, 150);
      });
    }

    wireSecurityPresetAuto();
  }

  // -----------------------------
  // Boot
  // -----------------------------

  async function boot() {
    bindUI();
    setStatus('Loading data…', 'info');
    loadSettings();

    // Add missing inputs (small UI patch): system index multiplier
    if (!el('systemIndexMultiplier')) {
      // Inject into Build Location accordion if older HTML is used.
      // (In this project, index.html already includes it, but this keeps it resilient.)
      console.warn('systemIndexMultiplier input missing; skipping injection.');
    }

    writeSettingsToUI();

    await loadBundledData();

    // Restore last input
    const last = lsGet(STORAGE_KEYS.lastInput, '');
    if (last && !state.ui.bpoInput.value.trim()) state.ui.bpoInput.value = last;

    // If fields are empty, seed some sane defaults
    if (!state.ui.buildRegionId.value.trim()) state.ui.buildRegionId.value = String(JITA.regionId);
    if (!state.ui.reprocEff.value.trim()) state.ui.reprocEff.value = String(DEFAULTS.reprocEff);
    if (!state.ui.minMargin.value.trim()) state.ui.minMargin.value = String(DEFAULTS.minMargin);
    if (!state.ui.minProfit.value.trim()) state.ui.minProfit.value = String(DEFAULTS.minProfit);
    if (!state.ui.maxCompetition.value.trim()) state.ui.maxCompetition.value = String(DEFAULTS.maxCompetition);
    if (!state.ui.systemIndexMultiplier.value.trim()) state.ui.systemIndexMultiplier.value = String(state.settings.systemIndexMultiplier);

    setStatus('Ready. Paste BPOs and click “Analyze Opportunities”.', 'info');
    clearResults();

    // persist caches on unload
    window.addEventListener('beforeunload', () => {
      persistCaches();
      saveSettings();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => {
      console.error(e);
      setStatus(`Boot error: ${e.message}`, 'bad');
    });
  });
})();
