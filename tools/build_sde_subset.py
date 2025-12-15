#!/usr/bin/env python3
"""Build offline SDE subsets for the static GitHub Pages app.

This script is OPTIONAL for developers.

Why it exists
-------------
ESI does NOT provide blueprint manufacturing materials/times/invention chains.
Fetching SDE-derived blueprint recipes from third-party APIs in the browser is
unreliable on GitHub Pages due to CORS. So we bundle recipe/type data locally in
/data/.

This script consumes EVE Ref "reference-data" (SDE-derived) and produces small,
browser-friendly JSON files:
  - data/blueprints.sde.min.json
  - data/types.sde.min.json
  - data/name_index.min.json

Input formats
-------------
You can point the script at either:
  * an extracted reference-data directory (contains types.json, blueprints.json, ...)
  * the tarball itself (reference-data-latest.tar.xz)

Modes
-----
Two modes are supported:
  * t1   (default): keep common Tech I industry coverage (modules/rigs/ammo/drones)
  * full          : include ALL manufacturing blueprints + copy/invention/research

Usage
-----
  python3 tools/build_sde_subset.py --tar reference-data-latest.tar.xz --outdir ./data --mode full

Notes
-----
- Output is minified JSON (no whitespace) for faster transfer.
- We only keep the type fields the app needs (name/volume/group/category).
- Invention outputs are blueprint type IDs (as in the SDE).
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import re
import tarfile
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

try:
    import orjson

    def jloads(b: bytes) -> Any:
        return orjson.loads(b)

    def jdumps(obj: Any) -> bytes:
        # Option: OPT_NON_STR_KEYS not needed; all keys are strings
        return orjson.dumps(obj)

except Exception:

    def jloads(b: bytes) -> Any:
        return json.loads(b.decode("utf-8"))

    def jdumps(obj: Any) -> bytes:
        return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# ---------------------------
# Filtering settings (mode=t1)
# ---------------------------
FILTER_PRODUCT_CATEGORIES_T1 = {7, 8, 18}  # Module (incl rigs via group), Charge, Drone
FILTER_REQUIRE_META_GROUP_ID_T1 = 1  # meta_groups: 1=Tech I
FILTER_EXCLUDE_ROMAN_NUMERALS = re.compile(r"\b(II|III|IV|V|VI|VII|VIII|IX|X)\b")


def normalize_name(name: str) -> str:
    """Normalize names for name_index.min.json and runtime lookup."""
    s = (name or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    # Normalize Unicode apostrophes to ASCII
    s = s.replace("’", "'").replace("‘", "'")
    return s


def read_json_from_dir(refdir: str, filename: str) -> Dict[str, Any]:
    path = os.path.join(refdir, filename)
    with open(path, "rb") as f:
        return jloads(f.read())


def read_json_from_tar(tar_path: str, member_name: str) -> Dict[str, Any]:
    with tarfile.open(tar_path, "r:*") as tf:
        member = tf.getmember(member_name)
        f = tf.extractfile(member)
        if f is None:
            raise FileNotFoundError(member_name)
        return jloads(f.read())


def get_en_name(type_row: Dict[str, Any]) -> str:
    name_obj = type_row.get("name") or {}
    if isinstance(name_obj, dict):
        return name_obj.get("en") or ""
    return str(name_obj)


def packaged_volume(type_row: Dict[str, Any]) -> float:
    # EVE Ref types.json includes both volume and packaged_volume.
    pv = type_row.get("packaged_volume")
    if pv is None:
        pv = type_row.get("volume")
    try:
        return float(pv) if pv is not None else 0.0
    except Exception:
        return 0.0


def _list_from_materials_blob(materials: Any) -> List[List[int]]:
    """Convert a materials blob to [[typeId, qty], ...].

    EVE Ref blueprints.json can represent materials as either:
      * dict of {"<typeId>": {type_id, quantity}, ...}
      * list of {type_id, quantity}
    """

    out: List[List[int]] = []
    if not materials:
        return out

    if isinstance(materials, dict):
        for _k, v in materials.items():
            try:
                tid = int(v.get("type_id"))
                qty = int(v.get("quantity"))
                if tid and qty:
                    out.append([tid, qty])
            except Exception:
                continue
    elif isinstance(materials, list):
        for v in materials:
            if not isinstance(v, dict):
                continue
            try:
                tid = int(v.get("type_id"))
                qty = int(v.get("quantity"))
                if tid and qty:
                    out.append([tid, qty])
            except Exception:
                continue

    out.sort(key=lambda x: x[0])
    return out


def _pick_first_product(products: Any) -> Optional[Tuple[int, int]]:
    """Return (typeId, qty) for the primary manufacturing product."""

    if not products:
        return None

    if isinstance(products, dict):
        # Deterministic selection by key order
        for k in sorted(products.keys(), key=lambda s: int(s) if str(s).isdigit() else str(s)):
            v = products.get(k)
            if not isinstance(v, dict):
                continue
            try:
                tid = int(v.get("type_id"))
                qty = int(v.get("quantity", 1))
                if tid:
                    return tid, max(1, qty)
            except Exception:
                continue
        return None

    if isinstance(products, list):
        for v in products:
            if not isinstance(v, dict):
                continue
            try:
                tid = int(v.get("type_id"))
                qty = int(v.get("quantity", 1))
                if tid:
                    return tid, max(1, qty)
            except Exception:
                continue

    return None


def _list_from_invention_products(products: Any) -> List[List[Any]]:
    """Convert invention products to [[typeId, qty, probability?], ...]."""

    out: List[List[Any]] = []
    if not products:
        return out

    if isinstance(products, list):
        for v in products:
            if not isinstance(v, dict):
                continue
            try:
                tid = int(v.get("type_id"))
                qty = int(v.get("quantity", 1))
                prob = v.get("probability")
                if prob is not None:
                    try:
                        prob = float(prob)
                    except Exception:
                        prob = None
                if tid:
                    row: List[Any] = [tid, max(1, qty)]
                    if prob is not None:
                        row.append(prob)
                    out.append(row)
            except Exception:
                continue

    elif isinstance(products, dict):
        # Rare, but handle similarly.
        for _k, v in products.items():
            if not isinstance(v, dict):
                continue
            try:
                tid = int(v.get("type_id"))
                qty = int(v.get("quantity", 1))
                prob = v.get("probability")
                if prob is not None:
                    try:
                        prob = float(prob)
                    except Exception:
                        prob = None
                if tid:
                    row: List[Any] = [tid, max(1, qty)]
                    if prob is not None:
                        row.append(prob)
                    out.append(row)
            except Exception:
                continue

    # Deterministic
    out.sort(key=lambda x: x[0])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--refdata", help="Path to extracted EVE Ref reference-data directory")
    src.add_argument("--tar", help="Path to reference-data-latest.tar.xz")
    ap.add_argument("--outdir", required=True, help="Output directory (project /data)")
    ap.add_argument(
        "--mode",
        choices=["t1", "full"],
        default="t1",
        help="t1: common Tech I subset (fast/small). full: all manufacturing blueprints + copy/invention/research.",
    )
    args = ap.parse_args()

    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)

    if args.refdata:
        refdir = args.refdata
        # NOTE: types.json is large; we only keep a small subset of fields in output.
        types = read_json_from_dir(refdir, "types.json")
        blueprints = read_json_from_dir(refdir, "blueprints.json")
        categories = read_json_from_dir(refdir, "categories.json")
        meta = read_json_from_dir(refdir, "meta.json") if os.path.exists(os.path.join(refdir, "meta.json")) else {}
    else:
        tar_path = args.tar
        types = read_json_from_tar(tar_path, "types.json")
        blueprints = read_json_from_tar(tar_path, "blueprints.json")
        categories = read_json_from_tar(tar_path, "categories.json")
        meta = read_json_from_tar(tar_path, "meta.json")

    # Find the category ID for "Blueprint" (stable but we include it for completeness)
    blueprint_category_id = None
    for cid, c in categories.items():
        nm = (c.get("name") or {}).get("en") if isinstance(c.get("name"), dict) else c.get("name")
        if nm == "Blueprint":
            blueprint_category_id = int(cid)
            break

    mode = args.mode

    subset_blueprints: Dict[str, Any] = {}
    needed_type_ids: Set[int] = set()

    def include_by_t1_policy(prod_row: Dict[str, Any]) -> bool:
        # Only keep Tech I outputs in target categories.
        try:
            cat_id = int(prod_row.get("category_id"))
        except Exception:
            return False
        if cat_id not in FILTER_PRODUCT_CATEGORIES_T1:
            return False

        prod_name = get_en_name(prod_row)

        meta_group_id = prod_row.get("meta_group_id")
        if meta_group_id is not None:
            try:
                if int(meta_group_id) != FILTER_REQUIRE_META_GROUP_ID_T1:
                    return False
            except Exception:
                pass
        else:
            if FILTER_EXCLUDE_ROMAN_NUMERALS.search(prod_name):
                return False

        return True

    for _bid, bp in blueprints.items():
        acts = bp.get("activities") or {}
        mfg = acts.get("manufacturing")
        if not mfg:
            # Skip non-manufacturing blueprints in both modes.
            # (Reaction formulas exist, but the app currently models manufacturing/copy/invention/research.)
            continue

        bp_type_id = int(bp.get("blueprint_type_id"))
        bp_type_row = types.get(str(bp_type_id))
        if not bp_type_row or not bp_type_row.get("published", True):
            continue

        # Products/materials
        prod = _pick_first_product(mfg.get("products"))
        if not prod:
            continue
        prod_type_id, prod_qty = prod

        prod_row = types.get(str(prod_type_id))
        if not prod_row or not prod_row.get("published", True):
            continue

        if mode == "t1" and not include_by_t1_policy(prod_row):
            continue

        # Manufacturing mats
        mats_list = _list_from_materials_blob(mfg.get("materials"))
        if not mats_list:
            continue

        time_s = int(mfg.get("time", 0) or 0)

        # Optional activities
        copy_time = 0
        inv_time = 0
        inv_mats: List[List[int]] = []
        inv_prods: List[List[Any]] = []
        rm_time = 0
        rm_mats: List[List[int]] = []
        rt_time = 0
        rt_mats: List[List[int]] = []

        cpy = acts.get("copying") or {}
        if isinstance(cpy, dict):
            copy_time = int(cpy.get("time", 0) or 0)

        inv = acts.get("invention") or {}
        if isinstance(inv, dict):
            inv_time = int(inv.get("time", 0) or 0)
            inv_mats = _list_from_materials_blob(inv.get("materials"))
            inv_prods = _list_from_invention_products(inv.get("products"))

        rm = acts.get("research_material") or {}
        if isinstance(rm, dict):
            rm_time = int(rm.get("time", 0) or 0)
            rm_mats = _list_from_materials_blob(rm.get("materials"))

        rt = acts.get("research_time") or {}
        if isinstance(rt, dict):
            rt_time = int(rt.get("time", 0) or 0)
            rt_mats = _list_from_materials_blob(rt.get("materials"))

        max_runs = int(bp.get("max_production_limit", 0) or 0)

        entry: Dict[str, Any] = {
            "blueprintTypeId": bp_type_id,
            "productTypeId": prod_type_id,
            "productQty": prod_qty,
            "time": time_s,
            "materials": mats_list,
            "maxRuns": max_runs,
        }

        if copy_time:
            entry["copyTime"] = copy_time
        if inv_time and (inv_mats or inv_prods):
            entry["invTime"] = inv_time
            if inv_mats:
                entry["invMaterials"] = inv_mats
            if inv_prods:
                entry["invProducts"] = inv_prods
        if rm_time or rm_mats:
            entry["rmTime"] = rm_time
            if rm_mats:
                entry["rmMaterials"] = rm_mats
        if rt_time or rt_mats:
            entry["rtTime"] = rt_time
            if rt_mats:
                entry["rtMaterials"] = rt_mats

        subset_blueprints[str(bp_type_id)] = entry

        # Track needed type IDs
        needed_type_ids.add(bp_type_id)
        needed_type_ids.add(prod_type_id)
        for mid, _qty in mats_list:
            needed_type_ids.add(int(mid))
        for mid, _qty in inv_mats:
            needed_type_ids.add(int(mid))
        for row in inv_prods:
            if row:
                needed_type_ids.add(int(row[0]))
        for mid, _qty in rm_mats:
            needed_type_ids.add(int(mid))
        for mid, _qty in rt_mats:
            needed_type_ids.add(int(mid))

    # Build minimal types map for everything referenced in the subset
    subset_types: Dict[str, Any] = {}
    for tid in sorted(needed_type_ids):
        row = types.get(str(tid))
        if not row:
            continue
        subset_types[str(tid)] = {
            "typeId": int(row.get("type_id", tid)),
            "name": get_en_name(row),
            "volume": packaged_volume(row),
            "groupId": int(row.get("group_id", 0) or 0),
            "categoryId": int(row.get("category_id", 0) or 0),
        }

    # Build name index: normalized name -> [typeId, ...]
    name_index: Dict[str, List[int]] = {}
    for tid_str, t in subset_types.items():
        nm = normalize_name(t.get("name", ""))
        if not nm:
            continue
        name_index.setdefault(nm, []).append(int(tid_str))

    # Add a second key without trailing " blueprint" to support inputs with/without suffix.
    for nm, ids in list(name_index.items()):
        if nm.endswith(" blueprint"):
            nm2 = nm[: -len(" blueprint")].strip()
            if nm2:
                name_index.setdefault(nm2, []).extend(ids)

    # De-dupe and sort id lists
    for nm in list(name_index.keys()):
        name_index[nm] = sorted(set(name_index[nm]))

    generated = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

    bp_out = {
        "generated": generated,
        "mode": mode,
        "source": {
            "dataset": "EVE Ref reference-data",
            "meta": meta,
        },
        "blueprints": subset_blueprints,
    }

    types_out = {
        "generated": generated,
        "mode": mode,
        "source": {
            "dataset": "EVE Ref reference-data",
            "meta": meta,
        },
        "blueprintCategoryId": blueprint_category_id,
        "types": subset_types,
    }

    # Write minified JSON
    with open(os.path.join(outdir, "blueprints.sde.min.json"), "wb") as f:
        f.write(jdumps(bp_out))
    with open(os.path.join(outdir, "types.sde.min.json"), "wb") as f:
        f.write(jdumps(types_out))
    with open(os.path.join(outdir, "name_index.min.json"), "wb") as f:
        f.write(jdumps({"generated": generated, "mode": mode, "nameIndex": name_index}))

    print(f"Mode: {mode}")
    print(f"Wrote {len(subset_blueprints)} blueprints")
    print(f"Wrote {len(subset_types)} types")
    print(f"Wrote {len(name_index)} name index keys")


if __name__ == "__main__":
    main()
