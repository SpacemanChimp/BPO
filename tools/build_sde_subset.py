#!/usr/bin/env python3
"""Build minimal offline SDE subsets for the static GitHub Pages app.

This script is OPTIONAL for developers.

It consumes the EVE Ref "reference-data" tarball (or an extracted directory)
containing at least:
  - blueprints.json
  - types.json
  - categories.json
  - groups.json

And emits:
  - data/blueprints.sde.min.json
  - data/types.sde.min.json
  - data/name_index.min.json

The produced files are designed for browser-side blueprint resolution and
manufacturing bill-of-materials calculations without any runtime SDE/API calls.

Filtering policy (default):
  * Keep Tech I blueprints whose manufactured *product* is in categories:
      Module (7), Charge (8), Drone (18)
    and whose product name does NOT include roman numerals II+ as a whole word.

You can broaden/narrow coverage by changing the FILTER_* settings below.

Usage:
  python3 tools/build_sde_subset.py \
    --refdata /path/to/extracted/reference-data \
    --outdir  /path/to/project/data

Or pass the tarball directly:
  python3 tools/build_sde_subset.py --tar reference-data-latest.tar.xz --outdir data
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import re
import tarfile
from typing import Dict, Any, Iterable, Tuple, Set

# ---------------------------
# Filtering settings
# ---------------------------
FILTER_PRODUCT_CATEGORIES = {7, 8, 18}  # Module, Charge, Drone
# Prefer filtering by meta group (Tech I vs Tech II, etc.).
FILTER_REQUIRE_META_GROUP_ID = 1  # meta_groups: 1=Tech I, 2=Tech II, ...
# Fallback exclusion for items that do not have a meta_group_id (rare).
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
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_json_from_tar(tar_path: str, member_name: str) -> Dict[str, Any]:
    with tarfile.open(tar_path, "r:*") as tf:
        member = tf.getmember(member_name)
        f = tf.extractfile(member)
        if f is None:
            raise FileNotFoundError(member_name)
        data = f.read()
        return json.loads(data.decode("utf-8"))


def get_en_name(type_row: Dict[str, Any]) -> str:
    name_obj = type_row.get("name") or {}
    if isinstance(name_obj, dict):
        return name_obj.get("en") or ""
    # Some datasets may already be flattened
    return str(name_obj)


def packaged_volume(type_row: Dict[str, Any]) -> float:
    # EVE Ref types.json includes both volume and packaged_volume.
    # Prefer packaged_volume when present.
    pv = type_row.get("packaged_volume")
    if pv is None:
        pv = type_row.get("volume")
    try:
        return float(pv) if pv is not None else 0.0
    except Exception:
        return 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--refdata", help="Path to extracted EVE Ref reference-data directory")
    src.add_argument("--tar", help="Path to reference-data-latest.tar.xz")
    ap.add_argument("--outdir", required=True, help="Output directory (project /data)")
    args = ap.parse_args()

    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)

    if args.refdata:
        refdir = args.refdata
        types = read_json_from_dir(refdir, "types.json")
        blueprints = read_json_from_dir(refdir, "blueprints.json")
        categories = read_json_from_dir(refdir, "categories.json")
        groups = read_json_from_dir(refdir, "groups.json")
        meta = read_json_from_dir(refdir, "meta.json") if os.path.exists(os.path.join(refdir, "meta.json")) else {}
    else:
        tar_path = args.tar
        types = read_json_from_tar(tar_path, "types.json")
        blueprints = read_json_from_tar(tar_path, "blueprints.json")
        categories = read_json_from_tar(tar_path, "categories.json")
        groups = read_json_from_tar(tar_path, "groups.json")
        meta = read_json_from_tar(tar_path, "meta.json")

    # Find the category ID for "Blueprint" to help runtime resolution
    blueprint_category_id = None
    for cid, c in categories.items():
        if (c.get("name") or {}).get("en") == "Blueprint":
            blueprint_category_id = int(cid)
            break

    # Build manufacturing subset
    subset_blueprints: Dict[str, Any] = {}
    needed_type_ids: Set[int] = set()

    for _bid, bp in blueprints.items():
        mfg = (bp.get("activities") or {}).get("manufacturing")
        if not mfg:
            continue

        bp_type_id = int(bp.get("blueprint_type_id"))
        bp_type_row = types.get(str(bp_type_id))
        if not bp_type_row or not bp_type_row.get("published", True):
            continue

        # Products/materials in this dataset are keyed dicts with {type_id, quantity}
        products = mfg.get("products") or {}
        if not products:
            continue

        # Most manufacturing blueprints have a single product; keep the first.
        first_prod = next(iter(products.values()))
        prod_type_id = int(first_prod.get("type_id"))
        prod_qty = int(first_prod.get("quantity", 1))
        prod_row = types.get(str(prod_type_id))
        if not prod_row or not prod_row.get("published", True):
            continue

        cat_id = int(prod_row.get("category_id"))
        if cat_id not in FILTER_PRODUCT_CATEGORIES:
            continue

        prod_name = get_en_name(prod_row)

        # Filter to Tech I outputs.
        meta_group_id = prod_row.get("meta_group_id")
        if meta_group_id is not None:
            try:
                if int(meta_group_id) != FILTER_REQUIRE_META_GROUP_ID:
                    continue
            except Exception:
                # If it can't be parsed, keep going with fallback below.
                pass
        else:
            # Fallback: if meta group isn't present, at least strip obvious Tech II+ roman numerals.
            if FILTER_EXCLUDE_ROMAN_NUMERALS.search(prod_name):
                continue

        mats = mfg.get("materials") or {}
        if not mats:
            continue

        materials_list = []
        for mat in mats.values():
            mid = int(mat.get("type_id"))
            qty = int(mat.get("quantity"))
            materials_list.append([mid, qty])

        time_s = int(mfg.get("time", 0))

        subset_blueprints[str(bp_type_id)] = {
            "blueprintTypeId": bp_type_id,
            "productTypeId": prod_type_id,
            "productQty": prod_qty,
            "time": time_s,
            "materials": materials_list,
        }

        needed_type_ids.add(bp_type_id)
        needed_type_ids.add(prod_type_id)
        for mid, _qty in materials_list:
            needed_type_ids.add(int(mid))

    # Build minimal types map for everything referenced in the subset (products, blueprints, and materials)
    subset_types: Dict[str, Any] = {}
    for tid in sorted(needed_type_ids):
        row = types.get(str(tid))
        if not row:
            continue
        subset_types[str(tid)] = {
            "typeId": int(row.get("type_id", tid)),
            "name": get_en_name(row),
            "volume": packaged_volume(row),
            "groupId": int(row.get("group_id", 0)),
            "categoryId": int(row.get("category_id", 0)),
        }

    # Build name index
    name_index: Dict[str, list] = {}
    for tid_str, t in subset_types.items():
        nm = normalize_name(t.get("name", ""))
        if not nm:
            continue
        name_index.setdefault(nm, []).append(int(tid_str))

    # Helpful: add a second key without a trailing " blueprint" so
    # users can paste blueprint names with or without the suffix.
    # (This does NOT override product-name resolution; runtime code decides how to interpret.)
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
        "source": {
            "dataset": "EVE Ref reference-data",
            "meta": meta,
        },
        "blueprints": subset_blueprints,
    }

    types_out = {
        "generated": generated,
        "source": {
            "dataset": "EVE Ref reference-data",
            "meta": meta,
        },
        "blueprintCategoryId": blueprint_category_id,
        "types": subset_types,
    }

    # Write minified JSON for fast load on GH Pages
    with open(os.path.join(outdir, "blueprints.sde.min.json"), "w", encoding="utf-8") as f:
        json.dump(bp_out, f, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(outdir, "types.sde.min.json"), "w", encoding="utf-8") as f:
        json.dump(types_out, f, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(outdir, "name_index.min.json"), "w", encoding="utf-8") as f:
        json.dump({"generated": generated, "nameIndex": name_index}, f, separators=(",", ":"), ensure_ascii=False)

    print(f"Wrote {len(subset_blueprints)} blueprints")
    print(f"Wrote {len(subset_types)} types")
    print(f"Wrote {len(name_index)} name index keys")


if __name__ == "__main__":
    main()
