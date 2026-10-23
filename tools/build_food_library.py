#!/usr/bin/env python3
"""Build the compact offline food catalog used by the mini program.

The raw datasets stay outside the mini program package. This script normalizes
the Chinese composition table and USDA Foundation Foods into the small schema
used by the local matcher, while preserving source metadata on every row.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

import requests


CFCT_URL = "https://raw.githubusercontent.com/ruffood/cn-food-mcp/main/data2026.csv"
USDA_FOUNDATION_URL = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip"
DEFAULT_OUTPUT = Path("miniprogram/data/foods.json")
DEFAULT_RUNTIME_OUTPUT = Path("miniprogram/data/foods.js")
DEFAULT_OVERRIDES = Path("miniprogram/data/food-overrides.json")


def normalize_name(value: str) -> str:
    return re.sub(r"[\s·＋+、,，。/\\_\-()（）【】\[\]]", "", value.strip().lower())


def safe_number(value: str | None) -> float | None:
    if value is None or not value.strip():
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) and number >= 0 else None


def rounded(value: float) -> int:
    return max(0, int(round(value)))


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha1(normalize_name(value).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{digest}"


def simple_aliases(name: str) -> list[str]:
    base = re.sub(r"\s*[（(].*?[）)]", "", name).strip()
    return [base] if base and base != name else []


def generic_portions(calorie_per_100g: int) -> list[dict[str, int | str]]:
    return [
        {"label": "100克", "calorie": calorie_per_100g},
        {"label": "150克", "calorie": rounded(calorie_per_100g * 1.5)},
        {"label": "200克", "calorie": calorie_per_100g * 2},
    ]


def generated_item(
    *,
    prefix: str,
    name: str,
    calorie: int,
    source: str,
    category: str = "",
) -> dict:
    portions = generic_portions(calorie)
    item = {
        "id": stable_id(prefix, name),
        "name": name,
        "aliases": simple_aliases(name),
        "calorieRange": [portions[0]["calorie"], portions[-1]["calorie"]],
        "defaultPortion": "100克",
        "portions": portions,
        "per100g": calorie,
        "source": source,
    }
    if category:
        item["category"] = category
    return item


def read_cfct(path: Path) -> Iterable[dict]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle)
        name_column = next(column for column in rows.fieldnames or [] if "食物" in column)
        energy_column = next(column for column in rows.fieldnames or [] if "能量" in column)
        for row in rows:
            name = (row.get(name_column) or "").strip()
            energy = safe_number(row.get(energy_column))
            if name and energy is not None:
                yield generated_item(prefix="cfct", name=name, calorie=rounded(energy), source="cfct-2026")


def find_csv(root: Path, name: str) -> Path:
    matches = list(root.rglob(name))
    if not matches:
        raise FileNotFoundError(f"USDA archive is missing {name}")
    return matches[0]


def read_usda_foundation(root: Path) -> Iterable[dict]:
    food_path = find_csv(root, "food.csv")
    nutrient_path = find_csv(root, "nutrient.csv")
    food_nutrient_path = find_csv(root, "food_nutrient.csv")

    energy_ids: list[str] = []
    with nutrient_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("unit_name", "").upper() == "KCAL" and row.get("name", "").startswith("Energy"):
                energy_ids.append(row["id"])
    energy_priority = {value: index for index, value in enumerate(["1008", "2047", "2048"])}
    energy_ids.sort(key=lambda value: energy_priority.get(value, 99))
    energy_set = set(energy_ids)

    foundation_ids: dict[str, tuple[str, str]] = {}
    with food_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("data_type") == "foundation_food" and row.get("description", "").strip():
                foundation_ids[row["fdc_id"]] = (row["description"].strip(), row.get("food_category_id", ""))

    energies: dict[str, tuple[int, int]] = {}
    with food_nutrient_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            fdc_id = row.get("fdc_id", "")
            nutrient_id = row.get("nutrient_id", "")
            amount = safe_number(row.get("amount"))
            if fdc_id not in foundation_ids or nutrient_id not in energy_set or amount is None:
                continue
            priority = energy_priority.get(nutrient_id, 99)
            previous = energies.get(fdc_id)
            if previous is None or priority < previous[1]:
                energies[fdc_id] = (rounded(amount), priority)

    for fdc_id, (name, category) in foundation_ids.items():
        if fdc_id not in energies:
            continue
        yield generated_item(
            prefix="usda",
            name=name,
            calorie=energies[fdc_id][0],
            source="usda-foundation-2026-04-30",
            category=category,
        )


def download(url: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    response = requests.get(url, headers={"User-Agent": "unhungry-food-library/1.0"}, timeout=120)
    response.raise_for_status()
    destination.write_bytes(response.content)
    return destination


def load_overrides(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        values = json.load(handle)
    if not isinstance(values, list):
        raise ValueError("food overrides must be a JSON array")
    return values


def build(output: Path, runtime_output: Path, overrides_path: Path, cfct_path: Path, usda_root: Path) -> dict[str, int]:
    rows: list[dict] = []
    known_names: set[str] = set()

    def append(item: dict, default_source: str) -> None:
        name = str(item.get("name", "")).strip()
        if not name:
            return
        key = normalize_name(name)
        if key in known_names:
            return
        item = dict(item)
        item["id"] = str(item.get("id") or stable_id("food", name))
        item["aliases"] = list(dict.fromkeys(str(alias).strip() for alias in item.get("aliases", []) if str(alias).strip()))
        item["source"] = str(item.get("source") or default_source)
        rows.append(item)
        known_names.add(key)

    for item in load_overrides(overrides_path):
        append(item, "curated")
    cfct_count = 0
    for item in read_cfct(cfct_path):
        before = len(rows)
        append(item, "cfct-2026")
        cfct_count += len(rows) - before
    usda_count = 0
    for item in read_usda_foundation(usda_root):
        before = len(rows)
        append(item, "usda-foundation-2026-04-30")
        usda_count += len(rows) - before

    rows.sort(key=lambda item: (item.get("source", ""), normalize_name(item["name"])))
    output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n"
    output.write_text(serialized, encoding="utf-8")
    runtime_output.parent.mkdir(parents=True, exist_ok=True)
    runtime_output.write_text(f"module.exports = {serialized}", encoding="utf-8")
    return {"total": len(rows), "curated": len(load_overrides(overrides_path)), "cfct": cfct_count, "usda": usda_count}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfct", type=Path, help="中国食物成分表 CSV")
    parser.add_argument("--usda-dir", type=Path, help="已解压的 USDA Foundation Foods CSV 目录")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--runtime-output", type=Path, default=DEFAULT_RUNTIME_OUTPUT)
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES)
    parser.add_argument("--download-dir", type=Path, default=Path("/tmp/unhungry-food-sources"))
    args = parser.parse_args()

    download_dir = args.download_dir
    cfct_path = args.cfct or download(CFCT_URL, download_dir / "cn-food-data2026.csv")
    usda_dir = args.usda_dir
    temporary_dir: Path | None = None
    if usda_dir is None:
        archive = download(USDA_FOUNDATION_URL, download_dir / "usda-foundation.zip")
        temporary_dir = Path(tempfile.mkdtemp(prefix="unhungry-usda-"))
        with zipfile.ZipFile(archive) as zip_file:
            zip_file.extractall(temporary_dir)
        usda_dir = temporary_dir
    counts = build(args.output, args.runtime_output, args.overrides, cfct_path, usda_dir)
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == "__main__":
    main()
