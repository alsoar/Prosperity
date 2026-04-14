from __future__ import annotations

import argparse
import csv
import io
import json
import math
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


CASH_SYMBOL = "XIRECS"


@dataclass(frozen=True)
class LayerConfig:
    name: str
    band_lo: float
    band_hi: float
    bid_formula: Callable[[float], int]
    ask_formula: Callable[[float], int]
    bid_formula_text: str
    ask_formula_text: str
    volume_lo: int
    volume_hi: int


@dataclass(frozen=True)
class ProductConfig:
    key: str
    product: str
    default_log: Path
    near_bound: float
    layers: tuple[LayerConfig, ...]


PRODUCTS: dict[str, ProductConfig] = {
    "osmium": ProductConfig(
        key="osmium",
        product="ASH_COATED_OSMIUM",
        default_log=Path.home() / "Downloads" / "one_osmium" / "113498.json",
        near_bound=4.5,
        layers=(
            LayerConfig(
                name="Outer wall",
                band_lo=9.5,
                band_hi=11.5,
                bid_formula=lambda fv: math.floor(fv) - 10,
                ask_formula=lambda fv: math.ceil(fv) + 10,
                bid_formula_text="floor(FV) - 10",
                ask_formula_text="ceil(FV) + 10",
                volume_lo=20,
                volume_hi=30,
            ),
            LayerConfig(
                name="Inner quote",
                band_lo=7.0,
                band_hi=9.0,
                bid_formula=lambda fv: round(fv) - 8,
                ask_formula=lambda fv: round(fv) + 8,
                bid_formula_text="round(FV) - 8",
                ask_formula_text="round(FV) + 8",
                volume_lo=10,
                volume_hi=15,
            ),
        ),
    ),
    "root": ProductConfig(
        key="root",
        product="INTARIAN_PEPPER_ROOT",
        default_log=Path.home() / "Downloads" / "Root" / "113602.json",
        near_bound=4.5,
        layers=(
            LayerConfig(
                name="Outer wall",
                band_lo=8.5,
                band_hi=10.5,
                bid_formula=lambda fv: math.ceil(fv) - 10,
                ask_formula=lambda fv: math.floor(fv) + 10,
                bid_formula_text="ceil(FV) - 10",
                ask_formula_text="floor(FV) + 10",
                volume_lo=15,
                volume_hi=25,
            ),
            LayerConfig(
                name="Inner quote",
                band_lo=5.5,
                band_hi=7.5,
                bid_formula=lambda fv: math.ceil(fv) - 7,
                ask_formula=lambda fv: math.floor(fv) + 7,
                bid_formula_text="ceil(FV) - 7",
                ask_formula_text="floor(FV) + 7",
                volume_lo=8,
                volume_hi=12,
            ),
        ),
    ),
}


def infer_probe(payload: dict) -> tuple[str, int, float]:
    held = [entry for entry in payload["positions"] if entry["symbol"] != CASH_SYMBOL and entry["quantity"] > 0]
    if len(held) != 1:
        raise ValueError(f"expected exactly one positive held position, found {held!r}")

    cash = [entry for entry in payload["positions"] if entry["symbol"] == CASH_SYMBOL]
    if len(cash) != 1:
        raise ValueError(f"expected exactly one cash position, found {cash!r}")

    product = held[0]["symbol"]
    quantity = int(held[0]["quantity"])
    entry_price = -int(cash[0]["quantity"]) / quantity
    return product, quantity, entry_price


def load_rows(log_json: Path, product: str) -> tuple[float, list[dict]]:
    payload = json.loads(log_json.read_text())
    probe_product, quantity, entry_price = infer_probe(payload)
    if probe_product != product:
        raise ValueError(f"{log_json} holds {probe_product}, expected {product}")
    if quantity != 1:
        raise ValueError(f"expected hold-one probe, found quantity={quantity}")

    rows = [row for row in csv.DictReader(io.StringIO(payload["activitiesLog"]), delimiter=";") if row["product"] == product]
    first_timestamp = min(int(row["timestamp"]) for row in rows)

    parsed_rows: list[dict] = []
    for row in rows:
        timestamp = int(row["timestamp"])
        if timestamp == first_timestamp:
            continue

        fv = entry_price + float(row["profit_and_loss"])
        bids = [(int(row[f"bid_price_{i}"]), int(row[f"bid_volume_{i}"])) for i in (1, 2, 3) if row[f"bid_price_{i}"]]
        asks = [(int(row[f"ask_price_{i}"]), int(row[f"ask_volume_{i}"])) for i in (1, 2, 3) if row[f"ask_price_{i}"]]
        parsed_rows.append(
            {
                "timestamp": timestamp,
                "fv": fv,
                "bids": bids,
                "asks": asks,
                "mid_price": float(row["mid_price"]),
            }
        )

    return entry_price, parsed_rows


def chi2_uniform(counter: Counter[int], lo: int, hi: int) -> float:
    total = sum(counter.values())
    expected = total / (hi - lo + 1)
    return sum((counter.get(value, 0) - expected) ** 2 / expected for value in range(lo, hi + 1))


def summarize_fv(rows: list[dict]) -> dict:
    fvs = [row["fv"] for row in rows]
    mean = statistics.mean(fvs)
    x0 = [fv - mean for fv in fvs[:-1]]
    x1 = [fv - mean for fv in fvs[1:]]
    phi = sum(a * b for a, b in zip(x0, x1)) / sum(a * a for a in x0)
    residuals = [b - phi * a for a, b in zip(x0, x1)]

    timestamps = [row["timestamp"] for row in rows]
    mean_t = statistics.mean(timestamps)
    cov = sum((timestamp - mean_t) * (fv - mean) for timestamp, fv in zip(timestamps, fvs))
    var = sum((timestamp - mean_t) ** 2 for timestamp in timestamps)
    slope = cov / var
    intercept = mean - slope * mean_t
    rmse = math.sqrt(sum((fv - (intercept + slope * timestamp)) ** 2 for timestamp, fv in zip(timestamps, fvs)) / len(fvs))

    return {
        "min": min(fvs),
        "max": max(fvs),
        "mean": mean,
        "phi": phi,
        "resid_std": math.sqrt(sum(error * error for error in residuals) / len(residuals)),
        "linear_slope": slope,
        "linear_intercept": intercept,
        "linear_rmse": rmse,
    }


def extract_side(rows: list[dict], side: str, band_lo: float, band_hi: float) -> list[tuple[float, int, int]]:
    out = []
    for row in rows:
        levels = row["bids"] if side == "bid" else row["asks"]
        matches = [(price, volume) for price, volume in levels if band_lo < abs(price - row["fv"]) < band_hi]
        if not matches:
            continue
        price, volume = (max(matches, key=lambda item: item[0]) if side == "bid" else min(matches, key=lambda item: item[0]))
        out.append((row["fv"], price, volume))
    return out


def validate_layer(rows: list[dict], layer: LayerConfig) -> dict:
    bid_rows = extract_side(rows, "bid", layer.band_lo, layer.band_hi)
    ask_rows = extract_side(rows, "ask", layer.band_lo, layer.band_hi)
    bid_match = sum(1 for fv, price, _ in bid_rows if layer.bid_formula(fv) == price)
    ask_match = sum(1 for fv, price, _ in ask_rows if layer.ask_formula(fv) == price)

    both_match = 0
    both_count = 0
    same_vol = 0
    spreads: Counter[int] = Counter()
    volumes: Counter[int] = Counter()
    for row in rows:
        bid_matches = [(price, volume) for price, volume in row["bids"] if layer.band_lo < abs(price - row["fv"]) < layer.band_hi]
        ask_matches = [(price, volume) for price, volume in row["asks"] if layer.band_lo < abs(price - row["fv"]) < layer.band_hi]
        if not bid_matches or not ask_matches:
            continue

        both_count += 1
        bid_price, bid_volume = max(bid_matches, key=lambda item: item[0])
        ask_price, ask_volume = min(ask_matches, key=lambda item: item[0])
        if layer.bid_formula(row["fv"]) == bid_price and layer.ask_formula(row["fv"]) == ask_price:
            both_match += 1
        if bid_volume == ask_volume:
            same_vol += 1
        spreads[ask_price - bid_price] += 1
        volumes[bid_volume] += 1

    return {
        "bid_match": bid_match,
        "bid_total": len(bid_rows),
        "ask_match": ask_match,
        "ask_total": len(ask_rows),
        "both_match": both_match,
        "both_total": both_count,
        "same_vol": same_vol,
        "spreads": spreads,
        "volumes": volumes,
        "chi2_uniform": chi2_uniform(volumes, layer.volume_lo, layer.volume_hi) if volumes else None,
    }


def summarize_near(rows: list[dict], bound: float) -> dict:
    events = []
    presence = 0
    present_sequence = []
    for row in rows:
        current_events = []
        for side, levels in (("bid", row["bids"]), ("ask", row["asks"])):
            for price, volume in levels:
                if abs(price - row["fv"]) <= bound:
                    crossing = (side == "bid" and price > row["fv"]) or (side == "ask" and price < row["fv"])
                    current_events.append(
                        {
                            "side": side,
                            "price": price,
                            "volume": volume,
                            "crossing": crossing,
                            "delta_round": price - round(row["fv"]),
                            "delta_floor": price - math.floor(row["fv"]),
                        }
                    )
        if current_events:
            presence += 1
        present_sequence.append(bool(current_events))
        events.extend(current_events)

    runs = []
    if present_sequence:
        current = present_sequence[0]
        run_length = 1
        for state in present_sequence[1:]:
            if state == current:
                run_length += 1
            else:
                runs.append((current, run_length))
                current = state
                run_length = 1
        runs.append((current, run_length))

    by_side_crossing: dict[tuple[str, bool], list[dict]] = defaultdict(list)
    for event in events:
        by_side_crossing[(event["side"], event["crossing"])].append(event)

    return {
        "presence": presence,
        "total_rows": len(rows),
        "side_counts": Counter(event["side"] for event in events),
        "delta_round": Counter(event["delta_round"] for event in events),
        "delta_floor": Counter(event["delta_floor"] for event in events),
        "present_run_lengths": Counter(length for state, length in runs if state),
        "by_side_crossing": {
            key: {
                "count": len(items),
                "volumes": Counter(item["volume"] for item in items),
                "delta_round": Counter(item["delta_round"] for item in items),
                "delta_floor": Counter(item["delta_floor"] for item in items),
            }
            for key, items in by_side_crossing.items()
        },
    }


def print_product_report(config: ProductConfig, log_json: Path) -> None:
    entry_price, rows = load_rows(log_json, config.product)
    fv_summary = summarize_fv(rows)
    near_summary = summarize_near(rows, config.near_bound)

    print(f"\n=== {config.product} ===")
    print(f"log: {log_json}")
    print(f"entry price: {entry_price:.6f}")
    print(
        "fv summary:"
        f" min={fv_summary['min']:.6f}"
        f" max={fv_summary['max']:.6f}"
        f" mean={fv_summary['mean']:.6f}"
        f" ar1_phi={fv_summary['phi']:.6f}"
        f" resid_std={fv_summary['resid_std']:.6f}"
        f" linear_slope={fv_summary['linear_slope']:.9f}"
        f" linear_rmse={fv_summary['linear_rmse']:.6f}"
    )

    for layer in config.layers:
        stats = validate_layer(rows, layer)
        print(f"\n{layer.name}:")
        print(f"  bid formula: {layer.bid_formula_text}")
        print(f"  ask formula: {layer.ask_formula_text}")
        print(f"  bid match: {stats['bid_match']}/{stats['bid_total']}")
        print(f"  ask match: {stats['ask_match']}/{stats['ask_total']}")
        print(f"  both match: {stats['both_match']}/{stats['both_total']}")
        print(f"  same-side volume match: {stats['same_vol']}/{stats['both_total']}")
        print(f"  spreads: {dict(stats['spreads'])}")
        print(f"  volumes: {dict(sorted(stats['volumes'].items()))}")
        print(f"  chi2 uniform: {stats['chi2_uniform']:.3f}")

    print("\nNear-FV one-sided bot:")
    print(f"  presence: {near_summary['presence']}/{near_summary['total_rows']}")
    print(f"  side counts: {dict(near_summary['side_counts'])}")
    print(f"  delta round: {dict(near_summary['delta_round'])}")
    print(f"  delta floor: {dict(near_summary['delta_floor'])}")
    print(f"  present run lengths: {dict(near_summary['present_run_lengths'])}")
    for key, stats in sorted(near_summary["by_side_crossing"].items()):
        print(f"  {key}: count={stats['count']} delta_round={dict(stats['delta_round'])} volumes={dict(sorted(stats['volumes'].items()))}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate Round 1 bot formulas against hold-one submission logs.")
    parser.add_argument("--product", choices=["osmium", "root", "all"], default="all")
    parser.add_argument("--osmium-log", type=Path, default=PRODUCTS["osmium"].default_log)
    parser.add_argument("--root-log", type=Path, default=PRODUCTS["root"].default_log)
    args = parser.parse_args()

    targets = ["osmium", "root"] if args.product == "all" else [args.product]
    for target in targets:
        config = PRODUCTS[target]
        log_json = args.osmium_log if target == "osmium" else args.root_log
        print_product_report(config, log_json)


if __name__ == "__main__":
    main()
