/*
EVE Industry Route Planner (static GH Pages)

Key architecture rules:
- Blueprint recipes come ONLY from bundled SDE subsets in /data.
- Runtime HTTP is used ONLY for live market pricing (ESI or a reputable pricing API).

This build keeps the UI intentionally simple while preserving core behaviors:
- Paste lines like "<name> Blueprint ME10 TE20 x5" or just the product name.
- Resolve blueprints locally.
- Fetch/cache prices with Refresh.
*/

(() => {
  'use strict';

  // ------------------------------
  // Constants / IDs
  // ------------------------------
  const REGION_THE_FORGE = 10000002;
  const JITA_4_4 = 60003760; // Jita IV - Moon 4 - Caldari Navy Assembly Plant

  const PRICE_CACHE_KEY = 'eve_industry_route_planner_price_cache_v1';
  const WATCHLIST_KEY = 'eve_industry_route_planner_watchlist_v1';
  const SETTINGS_KEY = 'eve_industry_route_planner_settings_v1';

  // Cache TTL for prices (ms). Keep conservative; user can hit Refresh any time.
  const PRICE_TTL_MS = 1000 * 60 * 30; // 30 minutes

  // ESI safety limits
  const ESI_MAX_PAGES_PER_TYPE = 200; // safety cap; higher improves reliability for high-volume items
  const ESI_CONCURRENCY = 3;

  // Fuzzwork batching
  const FUZZWORK_BATCH_SIZE = 250;

  // ------------------------------
  // State
  // ------------------------------
  const state = {
    sde: {
      loaded: false,
      blueprintCategoryId: 9,
      types: {}, // typeId -> {name, volume, groupId, categoryId}
      nameIndex: {}, // normalized name -> [typeIds]
      blueprintsByBlueprintTypeId: {}, // blueprintTypeId -> recipe
      blueprintsByProductTypeId: {}, // productTypeId -> recipe
      nameIndexKeys: [],
    },
    prices: {
      // typeId -> { buy, sell, ts, source }
      map: new Map(),
      offlineOnly: false,
      preferFuzzwork: true,
      preferInputBuy: true,
      preferOutputSell: true,
    },
    settings: {
      location: 'HS',
      riskPremiumPct: 5,
      slotUtilPct: 80,
      componentAware: false,
      invention: false,
    },
    results: [],
    watchlist: new Set(),
  };

  // ------------------------------
  // DOM
  // ------------------------------
  const el = {
    input: document.getElementById('input'),
    status: document.getElementById('status'),
    btnAnalyze: document.getElementById('btnAnalyze'),
    btnRefreshPrices: document.getElementById('btnRefreshPrices'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    btnCopyShopping: document.getElementById('btnCopyShopping'),
    btnExportShoppingCsv: document.getElementById('btnExportShoppingCsv'),
    resultsBody: document.getElementById('resultsBody'),
    shoppingList: document.getElementById('shoppingList'),

    chkOffline: document.getElementById('chkOffline'),
    chkUseFuzzwork: document.getElementById('chkUseFuzzwork'),
    chkComponentAware: document.getElementById('chkComponentAware'),
    chkInvention: document.getElementById('chkInvention'),
    chkPreferBuy: document.getElementById('chkPreferBuy'),
    chkPreferSell: document.getElementById('chkPreferSell'),

    selLocation: document.getElementById('selLocation'),
    inpRisk: document.getElementById('inpRisk'),
    inpUtil: document.getElementById('inpUtil'),
  };

  // ------------------------------
  // Utilities
  // ------------------------------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fmtIsk(v) {
    if (v == null || Number.isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
    return v.toFixed(2);
  }

  function fmtTime(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '—';
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${r}s`;
    return `${r}s`;
  }

  function normalizeName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[’‘]/g, "'");
  }

  function stripBlueprintSuffix(norm) {
    return norm.replace(/\s+blueprint$/, '').trim();
  }

  function parseLine(rawLine) {
    const raw = (rawLine || '').trim();
    if (!raw) return null;

    // If the whole line is a number, treat as typeId input.
    if (/^\d+$/.test(raw)) {
      return {
        raw,
        name: '',
        typeId: Number(raw),
        runs: 1,
        me: 0,
        te: 0,
        explicitBlueprint: false,
      };
    }

    // Parse tokens: ME#, TE#, x#, runs#, qty#
    let me = 0;
    let te = 0;
    let runs = 1;

    // split on whitespace, inspect tokens, rebuild name tokens
    const tokens = raw.split(/\s+/).filter(Boolean);
    const nameTokens = [];

    for (const tok of tokens) {
      const m1 = tok.match(/^ME(\d{1,3})$/i);
      if (m1) {
        me = clampInt(Number(m1[1]), 0, 20);
        continue;
      }
      const m2 = tok.match(/^TE(\d{1,3})$/i);
      if (m2) {
        te = clampInt(Number(m2[1]), 0, 20);
        continue;
      }
      const m3 = tok.match(/^x(\d+)$/i);
      if (m3) {
        runs = Math.max(1, Number(m3[1]));
        continue;
      }
      const m4 = tok.match(/^(runs?|qty)[:=]?(\d+)$/i);
      if (m4) {
        runs = Math.max(1, Number(m4[2]));
        continue;
      }
      nameTokens.push(tok);
    }

    const name = nameTokens.join(' ').trim();
    const explicitBlueprint = /\bblueprint\b$/i.test(name);

    return {
      raw,
      name,
      typeId: null,
      runs,
      me,
      te,
      explicitBlueprint,
    };
  }

  function clampInt(v, lo, hi) {
    v = Math.floor(Number(v));
    if (Number.isNaN(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  function createLimit(concurrency) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= concurrency) return;
      const item = queue.shift();
      if (!item) return;
      active++;
      (async () => {
        try {
          const res = await item.fn();
          item.resolve(res);
        } catch (e) {
          item.reject(e);
        } finally {
          active--;
          next();
        }
      })();
    };
    return (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  }

  function safeJsonParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
    }
  }

  function setStatus(kind, message) {
    const cls = kind === 'error' ? 'status status--error'
      : kind === 'warn' ? 'status status--warn'
      : kind === 'ok' ? 'status status--ok'
      : 'status';
    el.status.className = cls;
    el.status.textContent = message || '';
  }

  // ------------------------------
  // Data loading (offline SDE subset)
  // ------------------------------
  async function loadSde() {
    setStatus('ok', 'Loading offline SDE subset…');
    const [typesRes, nameRes, bpRes, mockRes] = await Promise.all([
      fetchJson('./data/types.sde.min.json'),
      fetchJson('./data/name_index.min.json'),
      fetchJson('./data/blueprints.sde.min.json'),
      fetchJson('./data/mock_prices.min.json').catch(() => null),
    ]);

    const { types, blueprintCategoryId } = typesRes;
    const { nameIndex } = nameRes;
    const { blueprints } = bpRes;

    state.sde.types = types || {};
    state.sde.blueprintCategoryId = blueprintCategoryId ?? 9;
    state.sde.nameIndex = nameIndex || {};
    state.sde.nameIndexKeys = Object.keys(state.sde.nameIndex);

    state.sde.blueprintsByBlueprintTypeId = blueprints || {};
    state.sde.blueprintsByProductTypeId = {};
    for (const [bpId, bp] of Object.entries(state.sde.blueprintsByBlueprintTypeId)) {
      if (!bp || !bp.productTypeId) continue;
      state.sde.blueprintsByProductTypeId[String(bp.productTypeId)] = bp;
      state.sde.blueprintsByBlueprintTypeId[String(bpId)] = bp;
    }

    // Load mock prices into an internal map as a fallback source.
    if (mockRes && mockRes.prices) {
      for (const [tid, p] of Object.entries(mockRes.prices)) {
        state.prices.map.set(String(tid), { buy: p.buy ?? null, sell: p.sell ?? null, ts: 0, source: 'mock' });
      }
    }

    state.sde.loaded = true;
    setStatus('ok', `Loaded ${Object.keys(state.sde.blueprintsByBlueprintTypeId).length} blueprints (offline subset).`);
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
    return res.json();
  }

  // ------------------------------
  // Blueprint resolution
  // ------------------------------
  function resolveBlueprint(lineInfo) {
    if (!state.sde.loaded) {
      return { ok: false, reason: 'Offline SDE subset not loaded' };
    }

    // 1) typeId input (optional)
    if (lineInfo.typeId != null) {
      const tid = String(lineInfo.typeId);
      // If it's a blueprintTypeId
      if (state.sde.blueprintsByBlueprintTypeId[tid]) {
        return { ok: true, blueprint: state.sde.blueprintsByBlueprintTypeId[tid], resolvedBy: 'blueprintTypeId' };
      }
      // If it's a productTypeId
      if (state.sde.blueprintsByProductTypeId[tid]) {
        return { ok: true, blueprint: state.sde.blueprintsByProductTypeId[tid], resolvedBy: 'productTypeId' };
      }
      return { ok: false, reason: 'TypeID not included in offline SDE subset' };
    }

    const rawName = lineInfo.name || '';
    const norm = normalizeName(rawName);
    const normNoBp = stripBlueprintSuffix(norm);

    // 2) Explicit blueprint input: try mapping to blueprint type directly.
    if (lineInfo.explicitBlueprint) {
      const bpTypeId = pickBestTypeId(norm, { wantCategory: state.sde.blueprintCategoryId });
      if (bpTypeId != null) {
        const recipe = state.sde.blueprintsByBlueprintTypeId[String(bpTypeId)];
        if (recipe) return { ok: true, blueprint: recipe, resolvedBy: 'blueprintName' };
      }
      // accept "Blueprint" suffix but also allow mapping from product name
      const productTypeId = pickBestTypeId(normNoBp, { excludeCategory: state.sde.blueprintCategoryId });
      if (productTypeId != null) {
        const recipe = state.sde.blueprintsByProductTypeId[String(productTypeId)];
        if (recipe) return { ok: true, blueprint: recipe, resolvedBy: 'productName' };
        return { ok: false, reason: 'Blueprint not included in offline SDE subset' };
      }
      return { ok: false, reason: 'Blueprint not included in offline SDE subset' };
    }

    // 3) Product input first
    const productTypeId = pickBestTypeId(norm, { excludeCategory: state.sde.blueprintCategoryId });
    if (productTypeId != null) {
      const recipe = state.sde.blueprintsByProductTypeId[String(productTypeId)];
      if (recipe) return { ok: true, blueprint: recipe, resolvedBy: 'productName' };
      return { ok: false, reason: 'Blueprint not included in offline SDE subset' };
    }

    // 4) ...then blueprint name fallback
    const bpTypeId = pickBestTypeId(norm, { wantCategory: state.sde.blueprintCategoryId });
    if (bpTypeId != null) {
      const recipe = state.sde.blueprintsByBlueprintTypeId[String(bpTypeId)];
      if (recipe) return { ok: true, blueprint: recipe, resolvedBy: 'blueprintName' };
    }

    return { ok: false, reason: 'Blueprint not included in offline SDE subset' };
  }

  function pickBestTypeId(queryNorm, { wantCategory = null, excludeCategory = null } = {}) {
    const q = normalizeName(queryNorm);
    if (!q) return null;

    // Best match order: exact, startsWith, contains
    const buckets = [
      (k) => k === q,
      (k) => k.startsWith(q),
      (k) => k.includes(q),
    ];

    for (const matchFn of buckets) {
      const matchedKeys = [];
      for (const k of state.sde.nameIndexKeys) {
        if (matchFn(k)) matchedKeys.push(k);
      }
      if (matchedKeys.length === 0) continue;

      // Prefer shorter / closer keys when matching startsWith/contains
      matchedKeys.sort((a, b) => a.length - b.length);

      // Flatten to candidate IDs
      const candidates = [];
      for (const k of matchedKeys) {
        const ids = state.sde.nameIndex[k] || [];
        for (const id of ids) candidates.push(id);
      }

      // Apply category filters
      const filtered = [];
      for (const id of candidates) {
        const t = state.sde.types[String(id)];
        const cat = t ? t.categoryId : null;
        if (wantCategory != null && cat !== wantCategory) continue;
        if (excludeCategory != null && cat === excludeCategory) continue;
        filtered.push(id);
      }

      if (filtered.length === 0) continue;

      // De-dupe
      const uniq = Array.from(new Set(filtered));

      // Prefer exact-name match among candidate types when we have it
      const exactName = uniq.find((id) => normalizeName(state.sde.types[String(id)]?.name) === q);
      return exactName ?? uniq[0];
    }

    return null;
  }

  // ------------------------------
  // Manufacturing math (T1-focused)
  // ------------------------------
  function computeMaterials(recipe, runs, mePct) {
    const mult = Math.max(1, runs);
    const me = clampInt(mePct ?? 0, 0, 20);
    const reduction = 1 - (me / 100);

    // recipe.materials is [ [typeId, qty], ... ] per run.
    const out = new Map();
    for (const [typeId, qty] of recipe.materials) {
      const base = Number(qty) * mult;
      // Minimal approximation: ME is % reduction of base materials.
      const adj = Math.ceil(base * reduction);
      out.set(String(typeId), (out.get(String(typeId)) || 0) + Math.max(0, adj));
    }
    return out;
  }

  function computeTime(recipe, runs, tePct) {
    const mult = Math.max(1, runs);
    const te = clampInt(tePct ?? 0, 0, 20);
    const reduction = 1 - (te / 100);
    return Math.ceil(Number(recipe.time || 0) * mult * reduction);
  }

  // ------------------------------
  // Price fetching + cache
  // ------------------------------
  function loadPriceCache() {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return;
    const data = safeJsonParse(raw, null);
    if (!data || typeof data !== 'object') return;
    for (const [tid, p] of Object.entries(data)) {
      if (!p || typeof p !== 'object') continue;
      state.prices.map.set(String(tid), {
        buy: (p.buy ?? null),
        sell: (p.sell ?? null),
        ts: (p.ts ?? 0),
        source: p.source ?? 'cache',
      });
    }
  }

  function savePriceCache() {
    // Persist only non-mock entries (mock stays bundled)
    const obj = {};
    for (const [tid, p] of state.prices.map.entries()) {
      if (p && p.source === 'mock') continue;
      obj[tid] = { buy: p.buy, sell: p.sell, ts: p.ts, source: p.source };
    }
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(obj));
  }

  function loadWatchlist() {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return;
    const arr = safeJsonParse(raw, []);
    if (!Array.isArray(arr)) return;
    state.watchlist = new Set(arr.map(String));
  }

  function saveWatchlist() {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(Array.from(state.watchlist)));
  }

  function loadSettings() {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s = safeJsonParse(raw, null);
    if (!s || typeof s !== 'object') return;
    state.settings.location = s.location ?? state.settings.location;
    state.settings.riskPremiumPct = s.riskPremiumPct ?? state.settings.riskPremiumPct;
    state.settings.slotUtilPct = s.slotUtilPct ?? state.settings.slotUtilPct;
    state.settings.componentAware = !!s.componentAware;
    state.settings.invention = !!s.invention;
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function getCachedPrice(typeId) {
    const id = String(typeId);
    const p = state.prices.map.get(id);
    if (!p) return null;
    // mock prices don't expire
    if (p.source === 'mock') return p;
    const age = Date.now() - (p.ts || 0);
    if (age > PRICE_TTL_MS) return null;
    return p;
  }

  async function ensurePrices(typeIds, { forceRefresh = false } = {}) {
    const ids = Array.from(new Set(typeIds.map(String))).filter(Boolean);

    if (state.prices.offlineOnly) {
      return;
    }

    const missing = [];
    for (const id of ids) {
      const cached = forceRefresh ? null : getCachedPrice(id);
      if (!cached) missing.push(id);
    }

    if (missing.length === 0) return;

    // First attempt: Fuzzwork aggregates (bulk)
    if (state.prices.preferFuzzwork) {
      try {
        await fetchPricesFromFuzzwork(missing);
        savePriceCache();
        return;
      } catch (e) {
        console.warn('Fuzzwork pricing failed; falling back to ESI', e);
      }
    }

    // Fallback: ESI orderbook scan per type
    await fetchPricesFromEsi(missing);
    savePriceCache();
  }

  async function fetchPricesFromFuzzwork(typeIds) {
    const batches = chunk(typeIds, FUZZWORK_BATCH_SIZE);
    for (const batchIds of batches) {
      const url = `https://market.fuzzwork.co.uk/aggregates/?region=${REGION_THE_FORGE}&types=${batchIds.join(',')}`;
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Fuzzwork ${res.status}`);
      const data = await res.json();
      for (const id of batchIds) {
        const row = data?.[id];
        if (!row) continue;
        const buy = safeNum(row.buy?.max ?? row.buy?.percentile ?? row.buy?.median ?? row.buy?.min);
        const sell = safeNum(row.sell?.min ?? row.sell?.percentile ?? row.sell?.median ?? row.sell?.max);
        if (buy == null && sell == null) continue;
        state.prices.map.set(String(id), { buy, sell, ts: Date.now(), source: 'fuzzwork' });
      }
      // Gentle pacing
      await sleep(120);
    }
  }

  function safeNum(v) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    return null;
  }

  async function fetchPricesFromEsi(typeIds) {
    const limit = createLimit(ESI_CONCURRENCY);
    const tasks = typeIds.map((id) => limit(() => fetchBestPricesEsi(id)));
    await Promise.allSettled(tasks);
  }

  async function fetchBestPricesEsi(typeId) {
    const id = String(typeId);
    const [sell, buy] = await Promise.all([
      fetchBestAtStationEsi(id, 'sell'),
      fetchBestAtStationEsi(id, 'buy'),
    ]);
    if (sell == null && buy == null) return;
    state.prices.map.set(id, { buy, sell, ts: Date.now(), source: 'esi' });
  }

  async function fetchBestAtStationEsi(typeId, orderType) {
    const first = await fetchEsiOrdersPage(typeId, orderType, 1);
    let best = pickBestFromOrders(first.orders, orderType);

    const totalPages = Math.min(first.pages, ESI_MAX_PAGES_PER_TYPE);
    if (totalPages <= 1) return best;

    // Fetch remaining pages in small parallel batches
    const limit = createLimit(4);
    const pages = [];
    for (let p = 2; p <= totalPages; p++) {
      pages.push(p);
    }

    const results = await Promise.allSettled(
      pages.map((p) => limit(() => fetchEsiOrdersPage(typeId, orderType, p)))
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const b = pickBestFromOrders(r.value.orders, orderType);
      if (b == null) continue;
      if (best == null) {
        best = b;
      } else {
        best = orderType === 'sell' ? Math.min(best, b) : Math.max(best, b);
      }
    }

    return best;
  }

  async function fetchEsiOrdersPage(typeId, orderType, page) {
    const url = `https://esi.evetech.net/latest/markets/${REGION_THE_FORGE}/orders/?datasource=tranquility&order_type=${orderType}&type_id=${typeId}&page=${page}`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`ESI ${res.status}`);
    const pages = Number(res.headers.get('x-pages') || '1');
    const orders = await res.json();
    return { pages: Number.isFinite(pages) && pages > 0 ? pages : 1, orders: Array.isArray(orders) ? orders : [] };
  }

  function pickBestFromOrders(orders, orderType) {
    // Prefer Jita 4-4; if we didn't see any orders there (or we truncated pages),
    // fall back to the best price seen in the region so the UI can still compute.
    const atJita = pickBestFromOrdersAtLocation(orders, orderType, JITA_4_4);
    if (atJita != null) return atJita;
    return pickBestFromOrdersAtLocation(orders, orderType, null);
  }

  function pickBestFromOrdersAtLocation(orders, orderType, locationId) {
    let best = null;
    for (const o of orders) {
      if (!o) continue;
      if (locationId != null && o.location_id !== locationId) continue;
      if (o.volume_remain != null && o.volume_remain <= 0) continue;
      const price = Number(o.price);
      if (!Number.isFinite(price)) continue;
      if (best == null) best = price;
      else best = (orderType === 'sell') ? Math.min(best, price) : Math.max(best, price);
    }
    return best;
  }

  function getPriceFor(typeId) {

    const id = String(typeId);
    const cached = getCachedPrice(id) || state.prices.map.get(id); // include mock
    return cached || null;
  }

  function priceForInputs(typeId) {
    const p = getPriceFor(typeId);
    if (!p) return null;
    return state.prices.preferInputBuy ? (p.buy ?? p.sell ?? null) : (p.sell ?? p.buy ?? null);
  }

  function priceForOutputs(typeId) {
    const p = getPriceFor(typeId);
    if (!p) return null;
    return state.prices.preferOutputSell ? (p.sell ?? p.buy ?? null) : (p.buy ?? p.sell ?? null);
  }

  // ------------------------------
  // Analysis / Rendering
  // ------------------------------
  async function analyze({ forcePriceRefresh = false } = {}) {
    if (!state.sde.loaded) {
      setStatus('warn', 'Loading SDE subset…');
      await loadSde();
    }

    const lines = (el.input.value || '').split(/\r?\n/);
    const parsed = lines.map(parseLine).filter(Boolean);

    if (parsed.length === 0) {
      state.results = [];
      render();
      setStatus('warn', 'Paste some blueprints or products first.');
      return;
    }

    // Resolve blueprints and compute required price IDs
    const results = [];
    const neededPriceTypeIds = new Set();

    for (const line of parsed) {
      const res = resolveBlueprint(line);
      if (!res.ok) {
        results.push({
          ...line,
          ok: false,
          status: res.reason,
        });
        continue;
      }

      const recipe = res.blueprint;
      const product = state.sde.types[String(recipe.productTypeId)];
      const productName = product?.name || `Type ${recipe.productTypeId}`;

      const mats = computeMaterials(recipe, line.runs, line.me);
      const time = computeTime(recipe, line.runs, line.te);

      for (const mid of mats.keys()) neededPriceTypeIds.add(mid);
      neededPriceTypeIds.add(String(recipe.productTypeId));

      results.push({
        ...line,
        ok: true,
        resolvedBy: res.resolvedBy,
        blueprintTypeId: recipe.blueprintTypeId,
        productTypeId: recipe.productTypeId,
        productQty: recipe.productQty,
        productName,
        mats,
        time,
        status: 'OK',
      });
    }

    // Fetch prices (live) for all referenced types
    const idsToFetch = Array.from(neededPriceTypeIds);
    if (!state.prices.offlineOnly) {
      setStatus('ok', `Fetching prices for ${idsToFetch.length} types…`);
      await ensurePrices(idsToFetch, { forceRefresh: forcePriceRefresh });
    }

    // Compute costs / profit and apply simple location risk premium
    const riskMult = 1 + (clampInt(state.settings.riskPremiumPct, 0, 200) / 100);

    for (const r of results) {
      if (!r.ok) continue;

      let inputCost = 0;
      let missingInputs = 0;
      for (const [mid, qty] of r.mats.entries()) {
        const px = priceForInputs(mid);
        if (px == null) { missingInputs++; continue; }
        inputCost += px * qty;
      }

      const outPx = priceForOutputs(r.productTypeId);
      const outQty = (r.productQty || 1) * (r.runs || 1);
      const outputValue = outPx == null ? null : outPx * outQty;

      // Apply a very simple risk premium / hauling overhead model.
      const totalCost = inputCost * riskMult;
      const profit = outputValue == null ? null : (outputValue - totalCost);

      r.inputCost = inputCost;
      r.outputValue = outputValue;
      r.totalCost = totalCost;
      r.profit = profit;
      r.missingInputs = missingInputs;
      if (missingInputs > 0 || outPx == null) {
        r.status = `Missing price (${missingInputs > 0 ? 'inputs' : ''}${outPx == null ? (missingInputs > 0 ? '+output' : 'output') : ''})`;
      }
    }

    state.results = results;
    render();

    const missing = results.filter((r) => !r.ok).length;
    if (missing > 0) {
      setStatus('warn', `${results.length} lines processed. ${missing} missing blueprint(s) in offline subset.`);
    } else {
      setStatus('ok', `${results.length} lines processed.`);
    }
  }

  function render() {
    renderResultsTable();
    renderShoppingList();
  }

  function renderResultsTable() {
    el.resultsBody.innerHTML = '';

    for (const row of state.results) {
      const tr = document.createElement('tr');

      // star
      const starTd = document.createElement('td');
      starTd.className = 'col-star';
      const starBtn = document.createElement('button');
      starBtn.className = 'starBtn';

      const key = row.ok ? String(row.productTypeId) : normalizeName(row.name || row.raw);
      const starred = state.watchlist.has(key);
      starBtn.textContent = starred ? '★' : '☆';
      starBtn.title = starred ? 'Remove from watchlist' : 'Add to watchlist';
      starBtn.addEventListener('click', () => {
        if (state.watchlist.has(key)) state.watchlist.delete(key);
        else state.watchlist.add(key);
        saveWatchlist();
        renderResultsTable();
      });
      starTd.appendChild(starBtn);

      const nameTd = document.createElement('td');
      nameTd.textContent = row.ok ? row.productName : (row.name || row.raw);

      const runsTd = document.createElement('td');
      runsTd.className = 'num';
      runsTd.textContent = row.runs ?? '';

      const meTd = document.createElement('td');
      meTd.className = 'num';
      meTd.textContent = row.me ?? '';

      const teTd = document.createElement('td');
      teTd.className = 'num';
      teTd.textContent = row.te ?? '';

      const timeTd = document.createElement('td');
      timeTd.className = 'num';
      timeTd.textContent = row.ok ? fmtTime(row.time) : '—';

      const inputsTd = document.createElement('td');
      inputsTd.className = 'num';
      inputsTd.textContent = row.ok ? fmtIsk(row.totalCost) : '—';

      const outputTd = document.createElement('td');
      outputTd.className = 'num';
      outputTd.textContent = row.ok ? fmtIsk(row.outputValue) : '—';

      const profitTd = document.createElement('td');
      profitTd.className = 'num';
      if (row.ok && row.profit != null) {
        profitTd.textContent = fmtIsk(row.profit);
        profitTd.classList.add(row.profit >= 0 ? 'pos' : 'neg');
      } else {
        profitTd.textContent = '—';
      }

      const statusTd = document.createElement('td');
      statusTd.textContent = row.status;
      statusTd.className = row.ok ? (row.status === 'OK' ? 'ok' : 'warn') : 'bad';

      tr.appendChild(starTd);
      tr.appendChild(nameTd);
      tr.appendChild(runsTd);
      tr.appendChild(meTd);
      tr.appendChild(teTd);
      tr.appendChild(timeTd);
      tr.appendChild(inputsTd);
      tr.appendChild(outputTd);
      tr.appendChild(profitTd);
      tr.appendChild(statusTd);

      el.resultsBody.appendChild(tr);
    }
  }

  function renderShoppingList() {
    const agg = new Map();
    for (const r of state.results) {
      if (!r.ok || !r.mats) continue;
      for (const [mid, qty] of r.mats.entries()) {
        agg.set(mid, (agg.get(mid) || 0) + qty);
      }
    }

    // Sort by type name
    const items = Array.from(agg.entries()).map(([tid, qty]) => {
      const t = state.sde.types[String(tid)];
      return { typeId: String(tid), name: t?.name || `Type ${tid}`, qty };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const lines = [];
    for (const it of items) {
      lines.push(`${it.name}\t${it.qty}`);
    }

    el.shoppingList.textContent = lines.join('\n');
    state.shoppingItems = items;
  }

  // ------------------------------
  // Export helpers
  // ------------------------------
  function downloadText(filename, content, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportResultsCsv() {
    const headers = ['item', 'runs', 'me', 'te', 'time_s', 'input_cost', 'output_value', 'profit', 'status', 'blueprintTypeId', 'productTypeId'];
    const rows = [headers.join(',')];

    for (const r of state.results) {
      const item = csvEscape(r.ok ? r.productName : (r.name || r.raw));
      const cells = [
        item,
        r.runs ?? '',
        r.me ?? '',
        r.te ?? '',
        r.ok ? (r.time ?? '') : '',
        r.ok ? (r.totalCost ?? '') : '',
        r.ok ? (r.outputValue ?? '') : '',
        r.ok ? (r.profit ?? '') : '',
        csvEscape(r.status || ''),
        r.ok ? (r.blueprintTypeId ?? '') : '',
        r.ok ? (r.productTypeId ?? '') : '',
      ];
      rows.push(cells.join(','));
    }

    downloadText('eve-industry-route-planner.csv', rows.join('\n'), 'text/csv');
  }

  function exportShoppingCsv() {
    const headers = ['typeId', 'name', 'quantity'];
    const rows = [headers.join(',')];
    for (const it of (state.shoppingItems || [])) {
      rows.push([it.typeId, csvEscape(it.name), it.qty].join(','));
    }
    downloadText('eve-industry-shopping-list.csv', rows.join('\n'), 'text/csv');
  }

  function csvEscape(s) {
    const str = String(s ?? '');
    if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  // ------------------------------
  // Helpers
  // ------------------------------
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // ------------------------------
  // UI wiring
  // ------------------------------
  function bindUi() {
    el.btnAnalyze.addEventListener('click', () => analyze({ forcePriceRefresh: false }));

    el.btnRefreshPrices.addEventListener('click', async () => {
      setStatus('ok', 'Refreshing live prices…');
      // Purge non-mock cached prices
      for (const [tid, p] of state.prices.map.entries()) {
        if (p && p.source !== 'mock') state.prices.map.delete(tid);
      }
      localStorage.removeItem(PRICE_CACHE_KEY);
      await analyze({ forcePriceRefresh: true });
    });

    el.btnExportCsv.addEventListener('click', exportResultsCsv);

    el.btnCopyShopping.addEventListener('click', async () => {
      const txt = el.shoppingList.textContent || '';
      try {
        await navigator.clipboard.writeText(txt);
        setStatus('ok', 'Shopping list copied to clipboard.');
      } catch {
        downloadText('shopping-list.txt', txt, 'text/plain');
        setStatus('warn', 'Clipboard blocked; downloaded shopping-list.txt instead.');
      }
    });

    el.btnExportShoppingCsv.addEventListener('click', exportShoppingCsv);

    // Settings
    el.chkOffline.addEventListener('change', () => {
      state.prices.offlineOnly = !!el.chkOffline.checked;
      analyze({ forcePriceRefresh: false });
    });

    el.chkUseFuzzwork.addEventListener('change', () => {
      state.prices.preferFuzzwork = !!el.chkUseFuzzwork.checked;
    });

    el.chkPreferBuy.addEventListener('change', () => {
      state.prices.preferInputBuy = !!el.chkPreferBuy.checked;
      analyze({ forcePriceRefresh: false });
    });

    el.chkPreferSell.addEventListener('change', () => {
      state.prices.preferOutputSell = !!el.chkPreferSell.checked;
      analyze({ forcePriceRefresh: false });
    });

    el.chkComponentAware.addEventListener('change', () => {
      state.settings.componentAware = !!el.chkComponentAware.checked;
      saveSettings();
    });

    el.chkInvention.addEventListener('change', () => {
      state.settings.invention = !!el.chkInvention.checked;
      saveSettings();
    });

    el.selLocation.addEventListener('change', () => {
      state.settings.location = el.selLocation.value;
      saveSettings();
      analyze({ forcePriceRefresh: false });
    });

    el.inpRisk.addEventListener('change', () => {
      state.settings.riskPremiumPct = clampInt(el.inpRisk.value, 0, 200);
      el.inpRisk.value = String(state.settings.riskPremiumPct);
      saveSettings();
      analyze({ forcePriceRefresh: false });
    });

    el.inpUtil.addEventListener('change', () => {
      state.settings.slotUtilPct = clampInt(el.inpUtil.value, 0, 100);
      el.inpUtil.value = String(state.settings.slotUtilPct);
      saveSettings();
    });
  }

  function applySettingsToUi() {
    el.chkOffline.checked = state.prices.offlineOnly;
    el.chkUseFuzzwork.checked = state.prices.preferFuzzwork;

    el.selLocation.value = state.settings.location;
    el.inpRisk.value = String(state.settings.riskPremiumPct);
    el.inpUtil.value = String(state.settings.slotUtilPct);
    el.chkComponentAware.checked = state.settings.componentAware;
    el.chkInvention.checked = state.settings.invention;

    el.chkPreferBuy.checked = state.prices.preferInputBuy;
    el.chkPreferSell.checked = state.prices.preferOutputSell;
  }

  // ------------------------------
  // Boot
  // ------------------------------
  (async () => {
    try {
      loadWatchlist();
      loadSettings();
      loadPriceCache();
      applySettingsToUi();
      bindUi();
      await loadSde();
    } catch (e) {
      console.error(e);
      setStatus('error', `Failed to start: ${e.message || e}`);
    }
  })();

})();
