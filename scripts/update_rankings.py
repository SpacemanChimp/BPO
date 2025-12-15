#!/usr/bin/env python3
"""
update_rankings.py

Reads recipe data (data/recipes.json.gz), fetches market prices, computes rankings,
and writes docs/data/rankings.json for GitHub Pages.

Price sources:
- Fuzzwork market aggregates CSV dump (region aggregates):
    https://market.fuzzwork.co.uk/aggregatecsv.csv.gz
  (updated about every 30 minutes, contains "5% average" aka fivepercent).
- Station-level aggregates for shortlisted candidates:
    https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=34,35,...

Notes:
- This is a decision-support tool. It does not include:
  - industry job installation fees (system cost index)
  - hauling, risk, liquidity depth modelling (beyond basic order-count filters)
  - structure/rig bonuses, skills, ME/TE rounding
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import requests


AGGREGATECSV_URL = "https://market.fuzzwork.co.uk/aggregatecsv.csv.gz"

DEFAULT_REGION_ID = 10000002  # The Forge (Jita's region)
DEFAULT_STATION_ID = 60003760  # Jita IV - Moon 4 - Caldari Navy Assembly Plant

RECIPES_PATH = Path("data/recipes.json.gz")
RANKINGS_PATH = Path("docs/data/rankings.json")
CACHE_DIR = Path(".cache")
CACHE_AGGCSV = CACHE_DIR / "aggregatecsv.csv.gz"

# When using station-level, query in chunks to avoid URL limits.
STATION_CHUNK = 200


# -------------------------
# Utilities
# -------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def ensure_parent(p: Path) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)


def load_recipes(recipes_path: Path) -> Dict[str, Any]:
    with gzip.open(recipes_path, "rt", encoding="utf-8") as f:
        return json.load(f)


def maybe_build_recipes(recipes_path: Path, force: bool = False) -> None:
    if recipes_path.exists() and not force:
        return
    print("[update_rankings] recipes.json.gz missing or forced; building from SDE (one-time-ish)…")
    cmd = [sys.executable, "scripts/build_recipes.py", "--out", str(recipes_path)]
    if force:
        cmd.append("--force")
    subprocess.check_call(cmd)


def download_to(url: str, dest: Path, timeout: int = 120) -> Dict[str, str]:
    ensure_parent(dest)
    with requests.get(url, stream=True, timeout=timeout, headers={"User-Agent": "eve-money-button/1.0"}) as r:
        r.raise_for_status()
        headers = {k: v for k, v in r.headers.items()}
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
    return headers


def _to_int(x: Any) -> Optional[int]:
    try:
        if x is None:
            return None
        return int(x)
    except Exception:
        try:
            return int(float(x))
        except Exception:
            return None


def _to_float(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        return float(x)
    except Exception:
        return None


# -------------------------
# Price loading
# -------------------------

def load_region_prices_from_aggregatecsv(cache_path: Path, region_id: int, refresh: bool = False) -> Tuple[Dict[int, Dict[str, Any]], Dict[str, str]]:
    """
    Returns:
      prices[type_id] = {"buy": {...}, "sell": {...}}
      headers (HTTP response headers from download if we downloaded)
    """
    headers: Dict[str, str] = {}
    if refresh or not cache_path.exists():
        print(f"[update_rankings] Downloading region aggregates CSV: {AGGREGATECSV_URL}")
        headers = download_to(AGGREGATECSV_URL, cache_path)

    prices: Dict[int, Dict[str, Any]] = {}
    with gzip.open(cache_path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        # Expect columns like:
        # what, weightedaverage, maxval, minval, stddev, median, volume, numorders, fivepercent, orderSet
        for row in reader:
            what = row.get("what") or ""
            parts = what.split("|")
            if len(parts) != 3:
                continue
            try:
                rid = int(parts[0])
                if rid != region_id:
                    continue
                tid = int(parts[1])
                is_buy = parts[2].lower() == "true"
            except ValueError:
                continue

            def fnum(k: str) -> float:
                v = row.get(k)
                try:
                    return float(v) if v not in (None, "") else 0.0
                except ValueError:
                    return 0.0

            def inum(k: str) -> int:
                v = row.get(k)
                try:
                    return int(float(v)) if v not in (None, "") else 0
                except ValueError:
                    return 0

            side = "buy" if is_buy else "sell"
            prices.setdefault(tid, {})
            prices[tid][side] = {
                "weightedAverage": fnum("weightedaverage"),
                "max": fnum("maxval"),
                "min": fnum("minval"),
                "stddev": fnum("stddev"),
                "median": fnum("median"),
                "volume": fnum("volume"),
                "orderCount": inum("numorders"),
                "percentile": fnum("fivepercent"),
            }

    return prices, headers


def _normalize_side_stats(d: Dict[str, Any]) -> Dict[str, Any]:
    # Map a few common key variations into our canonical schema.
    def pick(*keys: str, default: float = 0.0) -> float:
        for k in keys:
            if k in d and d[k] not in (None, ""):
                try:
                    return float(d[k])
                except Exception:
                    pass
        return float(default)

    def pick_int(*keys: str, default: int = 0) -> int:
        for k in keys:
            if k in d and d[k] not in (None, ""):
                try:
                    return int(float(d[k]))
                except Exception:
                    pass
        return int(default)

    out = {
        "weightedAverage": pick("weightedAverage", "weightedaverage", "weighted_avg"),
        "max": pick("max", "maxval", "maxVal"),
        "min": pick("min", "minval", "minVal"),
        "stddev": pick("stddev", "stdDev"),
        "median": pick("median"),
        "volume": pick("volume"),
        "orderCount": pick_int("orderCount", "numorders", "numOrders", "ordercount"),
        "percentile": pick("percentile", "fivepercent", "fivePercent", "five_percent", "5Percent"),
    }
    return out


def fetch_station_aggregates(station_id: int, type_ids: List[int], sleep_s: float = 0.15) -> Dict[int, Dict[str, Any]]:
    """
    Fetches station-level aggregates from market.fuzzwork.co.uk for a list of typeIDs.
    Returns dict keyed by type_id int, value includes normalized "buy"/"sell" dicts.
    """
    out: Dict[int, Dict[str, Any]] = {}
    base = f"https://market.fuzzwork.co.uk/aggregates/?station={station_id}&types="

    for i in range(0, len(type_ids), STATION_CHUNK):
        chunk = type_ids[i : i + STATION_CHUNK]
        url = base + ",".join(str(x) for x in chunk)
        r = requests.get(url, timeout=120, headers={"User-Agent": "eve-money-button/1.0"})
        r.raise_for_status()
        data = r.json()  # keys are typeIDs as strings
        for k, v in data.items():
            try:
                tid = int(k)
            except Exception:
                continue
            if not isinstance(v, dict):
                continue

            buy_raw = v.get("buy") or {}
            sell_raw = v.get("sell") or {}
            out[tid] = {
                "buy": _normalize_side_stats(buy_raw if isinstance(buy_raw, dict) else {}),
                "sell": _normalize_side_stats(sell_raw if isinstance(sell_raw, dict) else {}),
            }

        # be a polite consumer
        if sleep_s:
            time.sleep(sleep_s)

    return out


def fuzz_price(stats: Dict[str, Any], side: str, mode: str) -> float:
    """
    side: "buy" or "sell"
    mode:
      - "minmax": buy=max buy, sell=min sell (fast execution)
      - "percentile": use 5% average (percentile) when available, else fallback
      - "weighted": weightedAverage
    """
    if not stats or side not in stats:
        return 0.0
    s = stats[side] or {}
    if mode == "weighted":
        return float(s.get("weightedAverage") or 0.0)
    if mode == "percentile":
        p = float(s.get("percentile") or 0.0)
        if p > 0:
            return p
        # fallback
        if side == "sell":
            return float(s.get("min") or 0.0)
        return float(s.get("max") or 0.0)
    # minmax
    if side == "sell":
        return float(s.get("min") or 0.0)
    return float(s.get("max") or 0.0)


def safe_price(prices: Dict[int, Dict[str, Any]], type_id: int, side: str, mode: str) -> Optional[float]:
    """Returns a usable price or None. Never returns 0 for missing data."""
    stats = prices.get(type_id)
    if not stats:
        return None
    v = fuzz_price(stats, side, mode)
    if v and v > 0:
        return float(v)
    return None


def safe_order_count(prices: Dict[int, Dict[str, Any]], type_id: int, side: str) -> int:
    stats = prices.get(type_id) or {}
    s = stats.get(side) or {}
    try:
        return int(s.get("orderCount") or 0)
    except Exception:
        return 0


# -------------------------
# Recipe parsing
# -------------------------

@dataclass(frozen=True)
class Mat:
    type_id: int
    name: str
    qty: float


@dataclass(frozen=True)
class IndustryRecipe:
    blueprint_type_id: int
    blueprint_name: str
    product_type_id: int
    product_name: str
    output_qty: float
    time_s: int
    materials: List[Mat]


@dataclass(frozen=True)
class ReprocessRecipe:
    input_type_id: int
    input_name: str
    batch_units: int
    batch_m3: float
    outputs: List[Mat]


def _type_name(types_map: Dict[Any, Any], tid: int) -> str:
    # types_map might be keyed by str or int
    return (
        types_map.get(tid)
        or types_map.get(str(tid))
        or (types_map.get(str(tid), {}).get("name") if isinstance(types_map.get(str(tid)), dict) else None)
        or (types_map.get(tid, {}).get("name") if isinstance(types_map.get(tid), dict) else None)
        or f"type {tid}"
    )


def _extract_mats(raw_list: Any, types_map: Dict[Any, Any]) -> List[Mat]:
    mats: List[Mat] = []
    if not raw_list or not isinstance(raw_list, list):
        return mats
    for m in raw_list:
        if not isinstance(m, dict):
            continue
        tid = _to_int(m.get("type_id") or m.get("typeID") or m.get("type") or m.get("id"))
        qty = _to_float(m.get("qty") or m.get("quantity") or m.get("count") or m.get("amount"))
        if tid is None or qty is None or qty <= 0:
            continue
        name = m.get("name") or _type_name(types_map, tid)
        mats.append(Mat(type_id=tid, name=str(name), qty=float(qty)))
    return mats


def parse_recipes(recipes: Dict[str, Any]) -> Tuple[List[IndustryRecipe], List[IndustryRecipe], List[ReprocessRecipe], Dict[Any, Any]]:
    """
    Attempts to parse recipes.json.gz produced by scripts/build_recipes.py.

    Expected (most common) structure:
      {
        "types": { "<type_id>": {"name": "...", "volume": ...}, ... } OR { "<type_id>": "Name", ... }
        "manufacturing": [ { blueprint_type_id, product_type_id, time_s, output_qty, materials:[...] }, ...]
        "reactions":     [ ... ]
        "refining":      [ { input_type_id, batch_units, batch_m3, outputs:[...] }, ...]
      }

    If your recipes.json differs, this function tries a few key variants, but you may need to
    align build_recipes.py and this parser.
    """
    types_map = recipes.get("types") or recipes.get("type_names") or recipes.get("typeName") or {}
    mfg_raw = recipes.get("manufacturing") or recipes.get("mfg") or []
    rx_raw = recipes.get("reactions") or recipes.get("reaction") or []

    ref_raw = recipes.get("refining") or recipes.get("reprocess") or recipes.get("reprocessing") or []

    def parse_industry_list(raw_list: Any) -> List[IndustryRecipe]:
        out: List[IndustryRecipe] = []
        if not raw_list or not isinstance(raw_list, list):
            return out
        for e in raw_list:
            if not isinstance(e, dict):
                continue
            bpid = _to_int(e.get("blueprint_type_id") or e.get("blueprintTypeID") or e.get("blueprint_id") or e.get("blueprint"))
            pid = _to_int(e.get("product_type_id") or e.get("productTypeID") or e.get("product_id") or e.get("product"))
            time_s = _to_int(e.get("time_s") or e.get("time") or e.get("duration_s") or e.get("duration"))
            out_qty = _to_float(e.get("output_qty") or e.get("product_qty") or e.get("qty") or e.get("quantity") or e.get("outputQuantity"))
            mats = _extract_mats(e.get("materials") or e.get("inputs"), types_map)

            # Some schemas store products list
            if pid is None and isinstance(e.get("products"), list) and e["products"]:
                pid = _to_int(e["products"][0].get("type_id") or e["products"][0].get("typeID") or e["products"][0].get("type"))
                if out_qty is None:
                    out_qty = _to_float(e["products"][0].get("qty") or e["products"][0].get("quantity") or 1)

            if bpid is None or pid is None or time_s is None:
                continue
            if out_qty is None or out_qty <= 0:
                out_qty = 1.0

            bp_name = e.get("blueprint_name") or e.get("blueprintName") or _type_name(types_map, bpid)
            prod_name = e.get("product_name") or e.get("productName") or _type_name(types_map, pid)

            out.append(
                IndustryRecipe(
                    blueprint_type_id=int(bpid),
                    blueprint_name=str(bp_name),
                    product_type_id=int(pid),
                    product_name=str(prod_name),
                    output_qty=float(out_qty),
                    time_s=int(time_s),
                    materials=mats,
                )
            )
        return out

    def parse_ref_list(raw_list: Any) -> List[ReprocessRecipe]:
        out: List[ReprocessRecipe] = []
        if not raw_list or not isinstance(raw_list, list):
            return out
        for e in raw_list:
            if not isinstance(e, dict):
                continue
            iid = _to_int(e.get("input_type_id") or e.get("inputTypeID") or e.get("type_id") or e.get("typeID") or e.get("input"))
            batch_units = _to_int(e.get("batch_units") or e.get("batch") or e.get("quantity") or e.get("units"))
            batch_m3 = _to_float(e.get("batch_m3") or e.get("batchVolume") or e.get("m3"))
            outs = _extract_mats(e.get("outputs") or e.get("materials") or e.get("yields"), types_map)

            if iid is None or batch_units is None:
                continue
            if batch_units <= 0:
                continue

            name = e.get("input_name") or e.get("name") or _type_name(types_map, iid)

            # If batch volume not provided, try to compute from types_map volume
            if (batch_m3 is None or batch_m3 <= 0) and isinstance(types_map.get(str(iid)), dict):
                vol = _to_float(types_map.get(str(iid), {}).get("volume"))
                if vol:
                    batch_m3 = float(vol) * int(batch_units)

            if batch_m3 is None or batch_m3 <= 0:
                batch_m3 = float(batch_units)  # fallback

            out.append(
                ReprocessRecipe(
                    input_type_id=int(iid),
                    input_name=str(name),
                    batch_units=int(batch_units),
                    batch_m3=float(batch_m3),
                    outputs=outs,
                )
            )
        return out

    mfg = parse_industry_list(mfg_raw)
    rx = parse_industry_list(rx_raw)
    ref = parse_ref_list(ref_raw)

    return mfg, rx, ref, types_map


# -------------------------
# Ranking computations
# -------------------------

def compute_industry_row(
    r: IndustryRecipe,
    prices: Dict[int, Dict[str, Any]],
    price_mode: str,
    fee_rate: float,
    require_all_input_prices: bool,
) -> Optional[Dict[str, Any]]:
    # Output value: instant liquidation uses buy side
    out_unit = safe_price(prices, r.product_type_id, "buy", price_mode)
    if out_unit is None:
        return None

    # Input cost: buy from sell side
    mats_out: List[Dict[str, Any]] = []
    cost = 0.0
    missing = False
    for m in r.materials:
        unit = safe_price(prices, m.type_id, "sell", price_mode)
        if unit is None:
            missing = True
            continue
        ext = float(m.qty) * float(unit)
        mats_out.append({"type_id": m.type_id, "name": m.name, "qty": m.qty, "unit_price": unit, "extended": ext})
        cost += ext

    if require_all_input_prices and missing:
        return None
    if cost <= 0:
        return None

    revenue = float(r.output_qty) * float(out_unit)
    fees = revenue * float(fee_rate)
    profit = revenue - fees - cost
    roi = (profit / cost) if cost > 0 else None
    t = max(0, int(r.time_s))
    if t <= 0:
        return None
    profit_per_hour = profit / (t / 3600.0)

    row = {
        "blueprint_type_id": r.blueprint_type_id,
        "blueprint_name": r.blueprint_name,
        "product_type_id": r.product_type_id,
        "product_name": r.product_name,
        "time_s": t,
        "output_qty": r.output_qty,
        "cost": cost,
        "revenue": revenue,
        "fees": fees,
        "profit": profit,
        "roi": roi,
        "profit_per_hour": profit_per_hour,
        "materials": mats_out,
    }
    return row


def compute_reprocess_row(
    r: ReprocessRecipe,
    prices: Dict[int, Dict[str, Any]],
    price_mode: str,
    fee_rate: float,
    reprocess_yield: float,
    require_all_output_prices: bool,
) -> Optional[Dict[str, Any]]:
    in_unit = safe_price(prices, r.input_type_id, "sell", price_mode)
    if in_unit is None:
        return None

    cost = float(r.batch_units) * float(in_unit)
    if cost <= 0:
        return None

    outs_out: List[Dict[str, Any]] = []
    revenue = 0.0
    missing = False
    for o in r.outputs:
        unit = safe_price(prices, o.type_id, "buy", price_mode)
        if unit is None:
            missing = True
            continue
        qty_eff = float(o.qty) * float(reprocess_yield)
        ext = qty_eff * float(unit)
        outs_out.append({"type_id": o.type_id, "name": o.name, "qty": qty_eff, "unit_price": unit, "extended": ext})
        revenue += ext

    if require_all_output_prices and missing:
        return None

    fees = revenue * float(fee_rate)
    profit = revenue - fees - cost
    roi = (profit / cost) if cost > 0 else None
    profit_per_m3 = profit / float(r.batch_m3) if r.batch_m3 > 0 else None

    return {
        "input_type_id": r.input_type_id,
        "input_name": r.input_name,
        "batch_units": r.batch_units,
        "batch_m3": r.batch_m3,
        "cost": cost,
        "revenue": revenue,
        "fees": fees,
        "profit": profit,
        "roi": roi,
        "profit_per_m3": profit_per_m3,
        # For the UI's "Materials / Breakdown", show outputs
        "materials": outs_out,
    }


def shortlist(rows: List[Dict[str, Any]], key: str, limit: int, factor: int, cap: int, descending: bool = True) -> List[Dict[str, Any]]:
    if not rows:
        return []
    # filter out nonsense keys first
    rows2 = [r for r in rows if r.get(key) is not None]
    rows2.sort(key=lambda r: float(r.get(key) or 0.0), reverse=descending)
    n = min(len(rows2), max(limit * factor, limit), cap)
    return rows2[:n]


def gather_type_ids_from_industry_rows(rows: Iterable[Dict[str, Any]]) -> Set[int]:
    s: Set[int] = set()
    for r in rows:
        for k in ("blueprint_type_id", "product_type_id"):
            tid = r.get(k)
            if isinstance(tid, int):
                s.add(tid)
        for m in r.get("materials") or []:
            tid = m.get("type_id")
            if isinstance(tid, int):
                s.add(tid)
    return s


def gather_type_ids_from_ref_rows(rows: Iterable[Dict[str, Any]]) -> Set[int]:
    s: Set[int] = set()
    for r in rows:
        tid = r.get("input_type_id")
        if isinstance(tid, int):
            s.add(tid)
        for m in r.get("materials") or []:
            tid2 = m.get("type_id")
            if isinstance(tid2, int):
                s.add(tid2)
    return s


# -------------------------
# Main
# -------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region-id", type=int, default=DEFAULT_REGION_ID)
    ap.add_argument("--station-id", type=int, default=DEFAULT_STATION_ID)
    ap.add_argument("--price-mode", choices=["minmax", "percentile", "weighted"], default="minmax")
    ap.add_argument("--fee-rate", type=float, default=0.015, help="Approx. sales tax + broker fee on output revenue (e.g. 0.015 = 1.5%).")
    ap.add_argument("--reprocess-yield", type=float, default=0.82)
    ap.add_argument("--limit-mfg", type=int, default=60)
    ap.add_argument("--limit-rx", type=int, default=60)
    ap.add_argument("--limit-ref", type=int, default=60)

    # New: sanity filters so the results are "buildable today"
    ap.add_argument("--min-bpo-sell-orders", type=int, default=5, help="Minimum sell orders for the blueprint/formula at the station.")
    ap.add_argument("--min-output-buy-orders", type=int, default=5, help="Minimum buy orders for the output at the station.")
    ap.add_argument("--min-job-time-sec", type=int, default=60, help="Minimum industry job duration to avoid 0s/bug/conversion entries.")
    ap.add_argument("--require-all-input-prices", action="store_true", default=True, help="Skip recipes if any input lacks price.")
    ap.add_argument("--shortlist-factor", type=int, default=15, help="How many rows to consider before station-level refinement.")
    ap.add_argument("--shortlist-cap", type=int, default=1000, help="Absolute cap for station-level shortlist per category.")
    ap.add_argument("--refresh-cache", action="store_true", help="Force re-download of the region aggregate CSV.")
    ap.add_argument("--force-recipes", action="store_true", help="Force rebuild recipes.json.gz from SDE.")
    args = ap.parse_args()

    maybe_build_recipes(RECIPES_PATH, force=args.force_recipes)
    recipes = load_recipes(RECIPES_PATH)
    mfg_recipes, rx_recipes, ref_recipes, _types_map = parse_recipes(recipes)

    print(f"[update_rankings] Loaded recipes: mfg={len(mfg_recipes)}, rx={len(rx_recipes)}, ref={len(ref_recipes)}")

    region_prices, headers = load_region_prices_from_aggregatecsv(CACHE_AGGCSV, args.region_id, refresh=args.refresh_cache)
    print(f"[update_rankings] Loaded region prices for {len(region_prices)} typeIDs (region={args.region_id}).")

    # 1) Fast pass (region) to get a shortlist
    mfg_rows_region: List[Dict[str, Any]] = []
    for r in mfg_recipes:
        # pre-filter 0s / empty mats
        if r.time_s is None or int(r.time_s) < args.min_job_time_sec:
            continue
        if not r.materials:
            continue
        row = compute_industry_row(r, region_prices, args.price_mode, args.fee_rate, require_all_input_prices=args.require_all_input_prices)
        if row is None:
            continue
        mfg_rows_region.append(row)

    rx_rows_region: List[Dict[str, Any]] = []
    for r in rx_recipes:
        if r.time_s is None or int(r.time_s) < args.min_job_time_sec:
            continue
        if not r.materials:
            continue
        row = compute_industry_row(r, region_prices, args.price_mode, args.fee_rate, require_all_input_prices=args.require_all_input_prices)
        if row is None:
            continue
        rx_rows_region.append(row)

    ref_rows_region: List[Dict[str, Any]] = []
    for r in ref_recipes:
        if not r.outputs:
            continue
        row = compute_reprocess_row(
            r, region_prices, args.price_mode, args.fee_rate, args.reprocess_yield, require_all_output_prices=True
        )
        if row is None:
            continue
        ref_rows_region.append(row)

    # Shortlists (region) - big enough so station filtering doesn't leave you empty
    mfg_short = shortlist(mfg_rows_region, "profit_per_hour", args.limit_mfg, args.shortlist_factor, args.shortlist_cap, descending=True)
    rx_short = shortlist(rx_rows_region, "profit_per_hour", args.limit_rx, args.shortlist_factor, args.shortlist_cap, descending=True)
    ref_short = shortlist(ref_rows_region, "profit_per_m3", args.limit_ref, args.shortlist_factor, args.shortlist_cap, descending=True)

    type_ids: Set[int] = set()
    type_ids |= gather_type_ids_from_industry_rows(mfg_short)
    type_ids |= gather_type_ids_from_industry_rows(rx_short)
    type_ids |= gather_type_ids_from_ref_rows(ref_short)

    type_id_list = sorted(type_ids)
    print(f"[update_rankings] Station refresh for {len(type_id_list)} unique typeIDs…")
    station_prices = fetch_station_aggregates(args.station_id, type_id_list)

    # 2) Recompute final using station prices ONLY (if a type isn't in station_prices, we treat it as unavailable in Jita 4-4)
    def compute_blueprint_cost_and_payback(row: Dict[str, Any]) -> None:
        bp_id = int(row["blueprint_type_id"])
        bp_cost = safe_price(station_prices, bp_id, "sell", args.price_mode)
        if bp_cost is None:
            row["blueprint_cost"] = None
            row["payback_runs"] = None
            return
        row["blueprint_cost"] = bp_cost
        p = float(row.get("profit") or 0.0)
        if p > 0:
            row["payback_runs"] = bp_cost / p
        else:
            row["payback_runs"] = None

    final_mfg: List[Dict[str, Any]] = []
    for r in mfg_recipes:
        if r.time_s is None or int(r.time_s) < args.min_job_time_sec:
            continue
        if not r.materials:
            continue

        # blueprint must be buyable (BPO) in Jita
        bp_sell_orders = safe_order_count(station_prices, r.blueprint_type_id, "sell")
        bp_cost = safe_price(station_prices, r.blueprint_type_id, "sell", args.price_mode)
        if bp_cost is None or bp_sell_orders < args.min_bpo_sell_orders:
            continue

        # output must be liquidatable in Jita
        out_buy_orders = safe_order_count(station_prices, r.product_type_id, "buy")
        out_buy_price = safe_price(station_prices, r.product_type_id, "buy", args.price_mode)
        if out_buy_price is None or out_buy_orders < args.min_output_buy_orders:
            continue

        row = compute_industry_row(r, station_prices, args.price_mode, args.fee_rate, require_all_input_prices=args.require_all_input_prices)
        if row is None:
            continue

        # Attach blueprint info
        row["blueprint_cost"] = bp_cost
        row["payback_runs"] = (bp_cost / row["profit"]) if row["profit"] > 0 else None

        # (Optional) extra sanity: cost must be reasonably > 0 already
        final_mfg.append(row)

    final_rx: List[Dict[str, Any]] = []
    for r in rx_recipes:
        if r.time_s is None or int(r.time_s) < args.min_job_time_sec:
            continue
        if not r.materials:
            continue

        # formula must be buyable in Jita (treat as "blueprint_cost" for UI)
        bp_sell_orders = safe_order_count(station_prices, r.blueprint_type_id, "sell")
        bp_cost = safe_price(station_prices, r.blueprint_type_id, "sell", args.price_mode)
        if bp_cost is None or bp_sell_orders < args.min_bpo_sell_orders:
            continue

        # output must be liquidatable in Jita
        out_buy_orders = safe_order_count(station_prices, r.product_type_id, "buy")
        out_buy_price = safe_price(station_prices, r.product_type_id, "buy", args.price_mode)
        if out_buy_price is None or out_buy_orders < args.min_output_buy_orders:
            continue

        row = compute_industry_row(r, station_prices, args.price_mode, args.fee_rate, require_all_input_prices=args.require_all_input_prices)
        if row is None:
            continue

        row["blueprint_cost"] = bp_cost
        row["payback_runs"] = (bp_cost / row["profit"]) if row["profit"] > 0 else None
        final_rx.append(row)

    final_ref: List[Dict[str, Any]] = []
    for r in ref_recipes:
        if not r.outputs:
            continue
        # require input is buyable at station (sell orders)
        in_sell_orders = safe_order_count(station_prices, r.input_type_id, "sell")
        if in_sell_orders < args.min_bpo_sell_orders:  # reuse threshold as "must exist"
            continue
        # require outputs liquidatable (buy orders)
        ok = True
        for o in r.outputs:
            if safe_order_count(station_prices, o.type_id, "buy") < args.min_output_buy_orders:
                ok = False
                break
        if not ok:
            continue

        row = compute_reprocess_row(
            r, station_prices, args.price_mode, args.fee_rate, args.reprocess_yield, require_all_output_prices=True
        )
        if row is None:
            continue
        final_ref.append(row)

    # Final sort + truncate
    final_mfg.sort(key=lambda r: float(r.get("profit_per_hour") or -1e99), reverse=True)
    final_rx.sort(key=lambda r: float(r.get("profit_per_hour") or -1e99), reverse=True)
    final_ref.sort(key=lambda r: float(r.get("profit_per_m3") or -1e99), reverse=True)

    final_mfg = final_mfg[: args.limit_mfg]
    final_rx = final_rx[: args.limit_rx]
    final_ref = final_ref[: args.limit_ref]

    out = {
        "generated_at": utc_now_iso(),
        "market": {"region_id": args.region_id, "station_id": args.station_id},
        "assumptions": {
            "price_mode": args.price_mode,
            "fee_rate": args.fee_rate,
            "reprocess_yield": args.reprocess_yield,
            "min_bpo_sell_orders": args.min_bpo_sell_orders,
            "min_output_buy_orders": args.min_output_buy_orders,
            "min_job_time_sec": args.min_job_time_sec,
            "require_all_input_prices": args.require_all_input_prices,
        },
        "manufacturing": final_mfg,
        "reactions": final_rx,
        "refining": final_ref,
    }

    ensure_parent(RANKINGS_PATH)
    RANKINGS_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"[update_rankings] Wrote {RANKINGS_PATH} (mfg={len(final_mfg)}, rx={len(final_rx)}, ref={len(final_ref)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
