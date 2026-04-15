from __future__ import annotations

import csv
import json
import math
import os
import shutil
import statistics
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np


DAY_OFFSETS = {-2: 0, -1: 1_000_000, 0: 2_000_000}
LEGACY_PRODUCT_KEYS = {
    "ASH_COATED_OSMIUM": "EMERALDS",
    "INTARIAN_PEPPER_ROOT": "TOMATOES",
}
PRODUCT_LABELS = {
    "EMERALDS": "ASH_COATED_OSMIUM",
    "TOMATOES": "INTARIAN_PEPPER_ROOT",
}
ROUND1_GENERATOR_MODELS = {
    "EMERALDS": {
        "name": "Float32 Mean-Reverting OU",
        "formula": "x_{t+1} = f32(10000 + 0.99778 * (x_t - 10000) + ε_t), ε_t ~ N(0, 0.312^2)",
        "notes": [
            "Calibrated to the round-1 osmium proxy with float32 quantization and replay-anchored day starts.",
            "Visible book uses empirical visibility masks with outer ±10, inner ±8, and a one-sided near bot around ±2.",
        ],
    },
    "TOMATOES": {
        "name": "Deterministic Day Ramp",
        "formula": "FV(day, t) = f32(12000 + 1000 * day + timestamp / 1000)",
        "notes": [
            "Round-1 pepper root fair value is deterministic once day and timestamp are fixed.",
            "Visible book uses calibrated mask frequencies with outer ±10, inner ±7, and an empirical one-sided near bot.",
        ],
    },
}
OSMIUM_MU = 10_000.0
OSMIUM_PRODUCT = "ASH_COATED_OSMIUM"
DRO_HORIZONS = (5, 10, 20, 30, 100)
DRO_FEATURE_SPECS = (
    (5, "std", 1.5),
    (5, "q05", 1.0),
    (5, "q50", 0.4),
    (5, "q95", 1.0),
    (10, "std", 1.7),
    (10, "q05", 1.1),
    (10, "q50", 0.5),
    (10, "q95", 1.1),
    (20, "std", 2.0),
    (20, "q05", 1.4),
    (20, "q50", 0.6),
    (20, "q95", 1.4),
    (30, "std", 1.9),
    (30, "q05", 1.2),
    (30, "q50", 0.5),
    (30, "q95", 1.2),
    (100, "std", 1.4),
    (100, "q05", 0.9),
    (100, "q50", 0.4),
    (100, "q95", 0.9),
)
CHART_POINTS_PER_SERIES = 1500
STATIC_CHART_POINTS = 600
GENERATED_OUTPUT_FILES = {
    "dashboard.json",
    "session_summary.csv",
    "run_summary.csv",
    "run.log",
}
GENERATED_OUTPUT_DIRS = {
    "sample_paths",
    "sessions",
    "static_charts",
}


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def rust_dir() -> Path:
    return project_root() / "rust_simulator"


def default_dashboard_path() -> Path:
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    return Path.cwd() / "backtests" / f"{timestamp}_monte_carlo" / "dashboard.json"


def normalize_dashboard_path(out: Optional[Path], no_out: bool) -> Optional[Path]:
    if no_out:
        return None

    if out is None:
        return default_dashboard_path()

    if out.suffix.lower() == ".json":
        return out

    return out / "dashboard.json"


def resolve_actual_dir(data_root: Optional[Path]) -> Path:
    default_round1 = project_root().parent / "prosperity-analysis" / "hidden_trader_detector" / "data" / "imc_round1" / "round1"

    if data_root is None:
        return default_round1

    if data_root.name == "round1":
        return data_root

    round1 = data_root / "round1"
    if round1.is_dir():
        return round1

    nested_round1 = data_root / "imc_round1" / "round1"
    if nested_round1.is_dir():
        return nested_round1

    return data_root


def product_key(product: str) -> str:
    return LEGACY_PRODUCT_KEYS.get(product, product)


def product_label(product: str) -> str:
    return PRODUCT_LABELS.get(product, product)


def session_round_files(session_dir: Path) -> tuple[Path, str, str]:
    round1_dir = session_dir / "round1"
    if round1_dir.is_dir():
        return round1_dir, "trace_round_1_day_*.csv", "round_1"

    round0_dir = session_dir / "round0"
    if round0_dir.is_dir():
        return round0_dir, "trace_round_0_day_*.csv", "round_0"

    raise FileNotFoundError(f"No round output directory found in {session_dir}")


def osmium_scenario_id(phi: float, sigma: float) -> str:
    def format_part(value: float) -> str:
        text = f"{value:.6f}".replace("-", "m").replace(".", "p")
        return text.rstrip("0").rstrip("p")

    return f"phi_{format_part(phi)}__sigma_{format_part(sigma)}"


def parse_optional_int(value: str | None) -> int | None:
    if value in (None, ""):
        return None
    return int(value)


def weighted_quantile(values: list[float], weights: list[float], q: float) -> float:
    if not values or not weights:
        return float("nan")

    order = sorted(range(len(values)), key=lambda index: values[index])
    sorted_values = [values[index] for index in order]
    sorted_weights = [weights[index] for index in order]
    total_weight = sum(sorted_weights)
    if total_weight <= 0:
        return float("nan")

    threshold = q * total_weight
    cumulative = 0.0
    for value, weight in zip(sorted_values, sorted_weights):
        cumulative += weight
        if cumulative >= threshold:
            return value
    return sorted_values[-1]


def weighted_tail_mean(values: list[float], weights: list[float], tail_probability: float) -> float:
    if not values or not weights:
        return float("nan")

    order = sorted(range(len(values)), key=lambda index: values[index])
    sorted_values = [values[index] for index in order]
    sorted_weights = [weights[index] for index in order]
    total_weight = sum(sorted_weights)
    if total_weight <= 0:
        return float("nan")

    target_weight = tail_probability * total_weight
    if target_weight <= 0:
        return sorted_values[0]

    consumed = 0.0
    tail_sum = 0.0
    for value, weight in zip(sorted_values, sorted_weights):
        if consumed >= target_weight:
            break
        take = min(weight, target_weight - consumed)
        tail_sum += value * take
        consumed += take

    if consumed <= 0:
        return sorted_values[0]
    return tail_sum / consumed


def summarize_weighted_distribution(values: list[float], weights: list[float]) -> dict[str, float]:
    if not values or not weights:
        return {}

    total_weight = sum(weights)
    if total_weight <= 0:
        return {}

    mean = sum(value * weight for value, weight in zip(values, weights)) / total_weight
    variance = sum(weight * (value - mean) ** 2 for value, weight in zip(values, weights)) / total_weight
    std = math.sqrt(max(variance, 0.0))
    downside = math.sqrt(sum(weight * min(value, 0.0) ** 2 for value, weight in zip(values, weights)) / total_weight)
    q01 = weighted_quantile(values, weights, 0.01)
    q05 = weighted_quantile(values, weights, 0.05)

    return {
        "count": float(len(values)),
        "mean": mean,
        "std": std,
        "min": min(values),
        "p01": q01,
        "p05": q05,
        "p10": weighted_quantile(values, weights, 0.10),
        "p25": weighted_quantile(values, weights, 0.25),
        "p50": weighted_quantile(values, weights, 0.50),
        "p75": weighted_quantile(values, weights, 0.75),
        "p90": weighted_quantile(values, weights, 0.90),
        "p95": weighted_quantile(values, weights, 0.95),
        "p99": weighted_quantile(values, weights, 0.99),
        "max": max(values),
        "positiveRate": sum(weight for value, weight in zip(values, weights) if value > 0) / total_weight,
        "negativeRate": sum(weight for value, weight in zip(values, weights) if value < 0) / total_weight,
        "zeroRate": sum(weight for value, weight in zip(values, weights) if value == 0) / total_weight,
        "var95": q05,
        "cvar95": weighted_tail_mean(values, weights, 0.05),
        "var99": q01,
        "cvar99": weighted_tail_mean(values, weights, 0.01),
        "meanConfidenceLow95": mean - 1.96 * std,
        "meanConfidenceHigh95": mean + 1.96 * std,
        "sharpeLike": mean / std if std > 0 else 0.0,
        "sortinoLike": mean / downside if downside > 0 else 0.0,
        "skewness": 0.0 if std <= 0 else sum(weight * ((value - mean) / std) ** 3 for value, weight in zip(values, weights)) / total_weight,
    }


def approximate_chi_square_cutoff(confidence_level: float, degrees_of_freedom: int) -> float:
    if degrees_of_freedom <= 0:
        return 0.0
    confidence_level = min(max(confidence_level, 1e-6), 1.0 - 1e-6)
    z_value = statistics.NormalDist().inv_cdf(confidence_level)
    base = 1.0 - 2.0 / (9.0 * degrees_of_freedom) + z_value * math.sqrt(2.0 / (9.0 * degrees_of_freedom))
    return max(degrees_of_freedom * (base ** 3), 0.0)


def infer_osmium_interval(row: dict[str, str]) -> tuple[float, float, float, tuple[bool, bool, bool, bool], int] | None:
    bid_levels = [
        (price, volume)
        for idx in (1, 2, 3)
        for price, volume in [(
            parse_optional_int(row.get(f"bid_price_{idx}")),
            parse_optional_int(row.get(f"bid_volume_{idx}")),
        )]
        if price is not None and volume is not None
    ]
    ask_levels = [
        (price, volume)
        for idx in (1, 2, 3)
        for price, volume in [(
            parse_optional_int(row.get(f"ask_price_{idx}")),
            parse_optional_int(row.get(f"ask_volume_{idx}")),
        )]
        if price is not None and volume is not None
    ]

    bid_assignments: list[tuple[int | None, int | None]] = []
    for inner in [None, *range(len(bid_levels))]:
        for outer in [None, *range(len(bid_levels))]:
            if inner is not None and outer is not None and inner == outer:
                continue
            if inner is not None and not (10 <= bid_levels[inner][1] <= 15):
                continue
            if outer is not None and not (20 <= bid_levels[outer][1] <= 30):
                continue
            if inner is not None and outer is not None and bid_levels[inner][0] <= bid_levels[outer][0]:
                continue
            bid_assignments.append((inner, outer))

    ask_assignments: list[tuple[int | None, int | None]] = []
    for inner in [None, *range(len(ask_levels))]:
        for outer in [None, *range(len(ask_levels))]:
            if inner is not None and outer is not None and inner == outer:
                continue
            if inner is not None and not (10 <= ask_levels[inner][1] <= 15):
                continue
            if outer is not None and not (20 <= ask_levels[outer][1] <= 30):
                continue
            if inner is not None and outer is not None and ask_levels[inner][0] >= ask_levels[outer][0]:
                continue
            ask_assignments.append((inner, outer))

    best: tuple[tuple[float, int], tuple[float, float, float, tuple[bool, bool, bool, bool], int]] | None = None
    for bid_inner, bid_outer in bid_assignments:
        for ask_inner, ask_outer in ask_assignments:
            lower = float("-inf")
            upper = float("inf")
            used = 0

            if bid_inner is not None:
                price = bid_levels[bid_inner][0]
                lower = max(lower, price + 7.5)
                upper = min(upper, price + 8.5)
                used += 1
            if bid_outer is not None:
                price = bid_levels[bid_outer][0]
                lower = max(lower, price + 10.0)
                upper = min(upper, price + 11.0)
                used += 1
            if ask_inner is not None:
                price = ask_levels[ask_inner][0]
                lower = max(lower, price - 8.5)
                upper = min(upper, price - 7.5)
                used += 1
            if ask_outer is not None:
                price = ask_levels[ask_outer][0]
                lower = max(lower, price - 11.0)
                upper = min(upper, price - 10.0)
                used += 1

            if used < 2 or lower >= upper:
                continue

            width = upper - lower
            score = (width, -used)
            payload = (
                lower,
                upper,
                0.5 * (lower + upper),
                (bid_inner is not None, bid_outer is not None, ask_inner is not None, ask_outer is not None),
                used,
            )
            if best is None or score < best[0]:
                best = (score, payload)

    return None if best is None else best[1]


def round1_price_stub(actual_dir: Path) -> str:
    if any(actual_dir.glob("prices_round_1_day_*.csv")):
        return "round_1"
    if any(actual_dir.glob("prices_round_0_day_*.csv")):
        return "round_0"
    raise FileNotFoundError(f"Could not find round price files in {actual_dir}")


def load_osmium_observable_proxy(actual_dir: Path) -> dict[str, Any]:
    round_stub = round1_price_stub(actual_dir)
    day_paths = sorted(actual_dir.glob(f"prices_{round_stub}_day_*.csv"))
    by_day: dict[int, dict[str, Any]] = {}

    for path in day_paths:
        day = int(path.stem.split("_")[-1])
        rows = [row for row in read_csv_dicts(path, ";") if row.get("product") == OSMIUM_PRODUCT]
        rows.sort(key=lambda row: int(row["timestamp"]))

        midpoint = np.full(len(rows), np.nan, dtype=np.float64)
        strong = np.zeros(len(rows), dtype=bool)
        masks = np.zeros((len(rows), 4), dtype=bool)
        timestamps = np.array([int(row["timestamp"]) for row in rows], dtype=np.int32)

        for index, row in enumerate(rows):
            interval = infer_osmium_interval(row)
            if interval is None:
                continue
            lower, upper, candidate_midpoint, mask, _ = interval
            masks[index] = mask
            if math.isclose(upper - lower, 0.5, abs_tol=1e-9):
                midpoint[index] = candidate_midpoint
                strong[index] = True

        by_day[day] = {
            "timestamps": timestamps,
            "midpoint": midpoint,
            "strong": strong,
            "masks": masks,
        }

    return {
        "days": sorted(by_day),
        "byDay": by_day,
    }


def simulate_osmium_paths(day: int, n_ticks: int, n_paths: int, phi: float, sigma: float, seed: int) -> np.ndarray:
    if n_ticks <= 0 or n_paths <= 0:
        return np.empty((n_paths, n_ticks), dtype=np.float64)

    rng = np.random.default_rng(seed)
    paths = np.empty((n_paths, n_ticks), dtype=np.float32)
    start = np.float32({-2: 10000.25, -1: 9992.25, 0: 10002.75}.get(day, OSMIUM_MU))
    paths[:, 0] = start
    for index in range(1, n_ticks):
        shocks = rng.normal(0.0, sigma, size=n_paths)
        updated = OSMIUM_MU + phi * (paths[:, index - 1].astype(np.float64) - OSMIUM_MU) + shocks
        paths[:, index] = updated.astype(np.float32)
    return paths.astype(np.float64)


def midpoint_from_masked_quotes(fv_values: np.ndarray, mask: tuple[bool, bool, bool, bool]) -> tuple[np.ndarray, np.ndarray]:
    lower = np.full(len(fv_values), -1e18, dtype=np.float64)
    upper = np.full(len(fv_values), 1e18, dtype=np.float64)
    used = 0

    if mask[0]:
        price = np.rint(fv_values).astype(np.int32) - 8
        lower = np.maximum(lower, price + 7.5)
        upper = np.minimum(upper, price + 8.5)
        used += 1
    if mask[1]:
        price = np.floor(fv_values).astype(np.int32) - 10
        lower = np.maximum(lower, price + 10.0)
        upper = np.minimum(upper, price + 11.0)
        used += 1
    if mask[2]:
        price = np.rint(fv_values).astype(np.int32) + 8
        lower = np.maximum(lower, price - 8.5)
        upper = np.minimum(upper, price - 7.5)
        used += 1
    if mask[3]:
        price = np.ceil(fv_values).astype(np.int32) + 10
        lower = np.maximum(lower, price - 11.0)
        upper = np.minimum(upper, price - 10.0)
        used += 1

    valid = (used >= 2) & (lower <= upper)
    midpoint = np.full(len(fv_values), np.nan, dtype=np.float64)
    midpoint[valid] = 0.5 * (lower[valid] + upper[valid])
    return midpoint, valid


def build_simulated_observable_proxy(simulated_fv: np.ndarray, masks: np.ndarray, strong: np.ndarray) -> np.ndarray:
    sessions, ticks = simulated_fv.shape
    proxy = np.full((sessions, ticks), np.nan, dtype=np.float64)
    for index in np.flatnonzero(strong):
        midpoint, valid = midpoint_from_masked_quotes(simulated_fv[:, index], tuple(bool(value) for value in masks[index]))
        proxy[valid, index] = midpoint[valid]
    return proxy


def collect_non_overlapping_returns(midpoint: np.ndarray, valid: np.ndarray, horizon: int) -> np.ndarray:
    if len(midpoint) <= horizon:
        return np.empty(0, dtype=np.float64)
    starts = np.arange(0, len(midpoint) - horizon, horizon, dtype=np.int32)
    keep = valid[starts] & valid[starts + horizon]
    if not np.any(keep):
        return np.empty(0, dtype=np.float64)
    return midpoint[starts[keep] + horizon] - midpoint[starts[keep]]


def collect_simulated_non_overlapping_returns(midpoint: np.ndarray, strong: np.ndarray, horizon: int) -> np.ndarray:
    if midpoint.shape[1] <= horizon:
        return np.empty((midpoint.shape[0], 0), dtype=np.float64)
    starts = np.arange(0, midpoint.shape[1] - horizon, horizon, dtype=np.int32)
    keep = strong[starts] & strong[starts + horizon]
    if not np.any(keep):
        return np.empty((midpoint.shape[0], 0), dtype=np.float64)
    selected_starts = starts[keep]
    valid = np.all(np.isfinite(midpoint[:, selected_starts]), axis=0)
    valid &= np.all(np.isfinite(midpoint[:, selected_starts + horizon]), axis=0)
    selected_starts = selected_starts[valid]
    if len(selected_starts) == 0:
        return np.empty((midpoint.shape[0], 0), dtype=np.float64)
    return midpoint[:, selected_starts + horizon] - midpoint[:, selected_starts]


def np_quantile(values: np.ndarray, q: float) -> float:
    if values.size == 0:
        return float("nan")
    return float(np.quantile(values, q))


def summarize_return_family(returns: np.ndarray) -> dict[str, np.ndarray]:
    if returns.size == 0:
        return {
            "std": np.empty(0, dtype=np.float64),
            "q05": np.empty(0, dtype=np.float64),
            "q50": np.empty(0, dtype=np.float64),
            "q95": np.empty(0, dtype=np.float64),
        }

    return {
        "std": np.std(returns, axis=1),
        "q05": np.quantile(returns, 0.05, axis=1),
        "q50": np.quantile(returns, 0.50, axis=1),
        "q95": np.quantile(returns, 0.95, axis=1),
    }


def calibrate_osmium_parameter_family(
    actual_dir: Path,
    phi_values: list[float],
    sigma_values: list[float],
    calibration_paths: int,
    seed: int,
    confidence_level: float,
    max_scenarios: int,
) -> dict[str, Any]:
    observable = load_osmium_observable_proxy(actual_dir)
    empirical_returns: dict[int, np.ndarray] = {}
    empirical_stats: dict[int, dict[str, float]] = {}

    for horizon in DRO_HORIZONS:
        day_returns: list[np.ndarray] = []
        for day in observable["days"]:
            day_data = observable["byDay"][day]
            returns = collect_non_overlapping_returns(day_data["midpoint"], day_data["strong"], horizon)
            if returns.size > 0:
                day_returns.append(returns)
        combined = np.concatenate(day_returns) if day_returns else np.empty(0, dtype=np.float64)
        empirical_returns[horizon] = combined
        empirical_stats[horizon] = {
            "std": float(np.std(combined)) if combined.size > 0 else float("nan"),
            "q05": np_quantile(combined, 0.05),
            "q50": np_quantile(combined, 0.50),
            "q95": np_quantile(combined, 0.95),
        }

    scenario_rows: list[dict[str, Any]] = []
    for sigma_index, sigma in enumerate(sigma_values):
        for phi_index, phi in enumerate(phi_values):
            simulated_returns_by_horizon: dict[int, list[np.ndarray]] = {horizon: [] for horizon in DRO_HORIZONS}
            scenario_seed = seed + sigma_index * 10_000 + phi_index * 101

            for day_index, day in enumerate(observable["days"]):
                day_data = observable["byDay"][day]
                simulated_fv = simulate_osmium_paths(
                    day=day,
                    n_ticks=len(day_data["timestamps"]),
                    n_paths=calibration_paths,
                    phi=phi,
                    sigma=sigma,
                    seed=scenario_seed + day_index,
                )
                simulated_proxy = build_simulated_observable_proxy(simulated_fv, day_data["masks"], day_data["strong"])
                for horizon in DRO_HORIZONS:
                    day_returns = collect_simulated_non_overlapping_returns(simulated_proxy, day_data["strong"], horizon)
                    if day_returns.size > 0:
                        simulated_returns_by_horizon[horizon].append(day_returns)

            score = 0.0
            diagnostics: list[dict[str, float | int | str]] = []
            for horizon, metric, weight in DRO_FEATURE_SPECS:
                pieces = simulated_returns_by_horizon[horizon]
                if not pieces or empirical_returns[horizon].size == 0:
                    continue
                simulated_returns = np.concatenate(pieces, axis=1)
                summary = summarize_return_family(simulated_returns)
                simulated_metric = summary[metric]
                if simulated_metric.size == 0:
                    continue
                actual_value = empirical_stats[horizon][metric]
                simulated_mean = float(np.mean(simulated_metric))
                simulated_std = float(np.std(simulated_metric, ddof=1)) if simulated_metric.size > 1 else 0.0
                scale = max(simulated_std, 1e-6)
                z_score = (actual_value - simulated_mean) / scale
                score += weight * z_score * z_score
                diagnostics.append(
                    {
                        "horizon": horizon,
                        "metric": metric,
                        "weight": weight,
                        "actual": actual_value,
                        "simMean": simulated_mean,
                        "simStd": simulated_std,
                        "zScore": z_score,
                    }
                )

            scenario_rows.append(
                {
                    "id": osmium_scenario_id(phi, sigma),
                    "phi": phi,
                    "sigma": sigma,
                    "calibrationScore": score,
                    "diagnostics": diagnostics,
                }
            )

    if not scenario_rows:
        return {
            "phiValues": phi_values,
            "sigmaValues": sigma_values,
            "points": [],
            "accepted": [],
        }

    degrees_of_freedom = len(DRO_FEATURE_SPECS)
    confidence_cutoff = approximate_chi_square_cutoff(confidence_level, degrees_of_freedom)

    for row in scenario_rows:
        confidence_statistic = sum(float(diagnostic["zScore"]) ** 2 for diagnostic in row["diagnostics"])
        row["confidenceStatistic"] = confidence_statistic
        row["withinConfidenceRegion"] = confidence_statistic <= confidence_cutoff
        row["relativeWeight"] = math.exp(-0.5 * confidence_statistic)

    accepted = sorted(
        [row for row in scenario_rows if row["withinConfidenceRegion"]],
        key=lambda row: (row["confidenceStatistic"], row["calibrationScore"], row["phi"], row["sigma"]),
    )[:max_scenarios]

    if not accepted:
        accepted = [min(scenario_rows, key=lambda row: row["confidenceStatistic"])]

    accepted_weight_sum = sum(row["relativeWeight"] for row in accepted)
    for row in scenario_rows:
        row["accepted"] = any(row["id"] == accepted_row["id"] for accepted_row in accepted)
    for row in accepted:
        row["normalizedWeight"] = row["relativeWeight"] / accepted_weight_sum if accepted_weight_sum > 0 else 0.0

    return {
        "phiValues": phi_values,
        "sigmaValues": sigma_values,
        "empiricalStats": empirical_stats,
        "points": scenario_rows,
        "accepted": accepted,
        "confidenceLevel": confidence_level,
        "confidenceCutoff": confidence_cutoff,
        "degreesOfFreedom": degrees_of_freedom,
        "maxScenarios": max_scenarios,
        "calibrationPaths": calibration_paths,
    }

def quantile(values: list[float], q: float) -> float:
    if not values:
        return float("nan")

    sorted_values = sorted(values)
    if len(sorted_values) == 1:
        return sorted_values[0]

    index = (len(sorted_values) - 1) * q
    lo = math.floor(index)
    hi = math.ceil(index)
    if lo == hi:
        return sorted_values[lo]

    weight = index - lo
    return sorted_values[lo] * (1.0 - weight) + sorted_values[hi] * weight


def sample_std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return statistics.stdev(values)


def downside_deviation(values: list[float]) -> float:
    downside = [min(value, 0.0) ** 2 for value in values]
    if not downside:
        return 0.0
    return math.sqrt(sum(downside) / len(downside))


def skewness(values: list[float]) -> float:
    if len(values) < 3:
        return 0.0
    mean = statistics.fmean(values)
    std = sample_std(values)
    if std == 0:
        return 0.0
    return sum(((value - mean) / std) ** 3 for value in values) / len(values)


def correlation(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or len(a) < 2:
        return 0.0
    mean_a = statistics.fmean(a)
    mean_b = statistics.fmean(b)
    std_a = sample_std(a)
    std_b = sample_std(b)
    if std_a == 0 or std_b == 0:
        return 0.0
    cov = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b)) / (len(a) - 1)
    return cov / (std_a * std_b)


def summarize_distribution(values: list[float]) -> dict[str, float]:
    if not values:
        return {}

    mean = statistics.fmean(values)
    std = sample_std(values)
    downside = downside_deviation(values)
    q05 = quantile(values, 0.05)
    q01 = quantile(values, 0.01)
    tail_5 = [value for value in values if value <= q05] or [min(values)]
    tail_1 = [value for value in values if value <= q01] or [min(values)]
    ci_half_width = 1.96 * std / math.sqrt(len(values)) if len(values) > 1 else 0.0

    return {
        "count": float(len(values)),
        "mean": mean,
        "std": std,
        "min": min(values),
        "p01": q01,
        "p05": q05,
        "p10": quantile(values, 0.10),
        "p25": quantile(values, 0.25),
        "p50": quantile(values, 0.50),
        "p75": quantile(values, 0.75),
        "p90": quantile(values, 0.90),
        "p95": quantile(values, 0.95),
        "p99": quantile(values, 0.99),
        "max": max(values),
        "positiveRate": sum(value > 0 for value in values) / len(values),
        "negativeRate": sum(value < 0 for value in values) / len(values),
        "zeroRate": sum(value == 0 for value in values) / len(values),
        "var95": q05,
        "cvar95": statistics.fmean(tail_5),
        "var99": q01,
        "cvar99": statistics.fmean(tail_1),
        "meanConfidenceLow95": mean - ci_half_width,
        "meanConfidenceHigh95": mean + ci_half_width,
        "sharpeLike": mean / std if std > 0 else 0.0,
        "sortinoLike": mean / downside if downside > 0 else 0.0,
        "skewness": skewness(values),
    }


def histogram(values: list[float], bins: int = 40) -> dict[str, list[float] | list[int]]:
    if not values:
        return {"binEdges": [], "counts": []}

    lo = min(values)
    hi = max(values)
    if lo == hi:
        lo -= 0.5
        hi += 0.5

    width = (hi - lo) / bins
    edges = [lo + i * width for i in range(bins + 1)]
    counts = [0 for _ in range(bins)]
    for value in values:
        idx = min(int((value - lo) / width), bins - 1)
        counts[idx] += 1

    return {"binEdges": edges, "counts": counts}


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def normal_pdf(x: float, mu: float, sigma: float) -> float:
    if sigma <= 0:
        return 0.0
    z = (x - mu) / sigma
    return math.exp(-0.5 * z * z) / (sigma * math.sqrt(2.0 * math.pi))


def fit_r_squared(actual: list[float], predicted: list[float]) -> float:
    if not actual or len(actual) != len(predicted):
        return 0.0
    actual_mean = mean(actual)
    sst = sum((value - actual_mean) ** 2 for value in actual)
    if sst <= 1e-12:
        return 0.0
    sse = sum((a - b) ** 2 for a, b in zip(actual, predicted))
    return max(0.0, 1.0 - sse / sst)


def normal_fit(values: list[float], bins: int = 40, points: int = 200) -> dict[str, Any]:
    hist = histogram(values, bins)
    bin_edges = hist["binEdges"]
    counts = hist["counts"]
    mu = mean(values)
    sigma = sample_std(values)

    if len(bin_edges) < 2:
        return {"mean": mu, "std": sigma, "r2": 0.0, "line": []}

    bin_width = float(bin_edges[1] - bin_edges[0])
    centers = [(bin_edges[index] + bin_edges[index + 1]) / 2.0 for index in range(len(counts))]
    expected_counts = [normal_pdf(center, mu, sigma) * len(values) * bin_width for center in centers]
    lo = float(bin_edges[0])
    hi = float(bin_edges[-1])
    line = []
    if points <= 1:
        points = 2
    for index in range(points):
        x = lo + (hi - lo) * index / (points - 1)
        y = normal_pdf(x, mu, sigma) * len(values) * bin_width
        line.append([x, y])

    return {
        "mean": mu,
        "std": sigma,
        "r2": fit_r_squared([float(count) for count in counts], expected_counts),
        "line": line,
    }


def linear_regression(x_values: list[float], y_values: list[float]) -> dict[str, Any]:
    if len(x_values) != len(y_values) or len(x_values) < 2:
        return {
            "slope": 0.0,
            "intercept": 0.0,
            "r2": 0.0,
            "correlation": 0.0,
            "line": [],
            "diagnosis": "insufficient data",
        }

    x_mean = mean(x_values)
    y_mean = mean(y_values)
    sxx = sum((x - x_mean) ** 2 for x in x_values)
    sxy = sum((x - x_mean) * (y - y_mean) for x, y in zip(x_values, y_values))
    slope = sxy / sxx if sxx > 1e-12 else 0.0
    intercept = y_mean - slope * x_mean
    corr = correlation(x_values, y_values)
    r2 = corr * corr
    x_min = min(x_values)
    x_max = max(x_values)
    line = [[x_min, intercept + slope * x_min], [x_max, intercept + slope * x_max]]
    strength = abs(corr)
    if strength < 0.1:
        diagnosis = "no meaningful correlation"
    elif strength < 0.3:
        diagnosis = "weak correlation"
    elif strength < 0.6:
        diagnosis = "moderate correlation"
    else:
        diagnosis = "strong correlation"

    return {
        "slope": slope,
        "intercept": intercept,
        "r2": r2,
        "correlation": corr,
        "line": line,
        "diagnosis": diagnosis,
    }


def read_csv_dicts(path: Path, delimiter: str = ",") -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8") as handle:
        return list(csv.DictReader(handle, delimiter=delimiter))


def downsample_indices(length: int, max_points: int) -> list[int]:
    if length <= max_points:
        return list(range(length))

    if max_points <= 1:
        return [length - 1]

    indices = [min(round(i * (length - 1) / (max_points - 1)), length - 1) for i in range(max_points)]
    deduped: list[int] = []
    seen: set[int] = set()
    for index in indices:
        if index not in seen:
            deduped.append(index)
            seen.add(index)
    if deduped[-1] != length - 1:
        deduped[-1] = length - 1
    return deduped


def downsample_path_node(node: dict[str, list[float] | list[int]], max_points: int) -> dict[str, list[float] | list[int]]:
    indices = downsample_indices(len(node["timestamps"]), max_points)
    return {key: [values[index] for index in indices] for key, values in node.items()}


def svg_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )



def load_session_summaries(output_dir: Path) -> list[dict[str, Any]]:
    rows = read_csv_dicts(output_dir / "session_summary.csv", ",")
    parsed = []
    for row in rows:
        parsed.append(
            {
                "sessionId": int(row["session_id"]),
                "totalPnl": float(row["total_pnl"]),
                "emeraldPnl": float(row["emerald_pnl"]),
                "tomatoPnl": float(row["tomato_pnl"]),
                "emeraldPosition": int(row["emerald_position"]),
                "tomatoPosition": int(row["tomato_position"]),
                "emeraldCash": float(row["emerald_cash"]),
                "tomatoCash": float(row["tomato_cash"]),
                "totalSlopePerStep": float(row.get("total_slope_per_step", 0.0) or 0.0),
                "totalR2": float(row.get("total_r2", 0.0) or 0.0),
                "emeraldSlopePerStep": float(row.get("emerald_slope_per_step", 0.0) or 0.0),
                "emeraldR2": float(row.get("emerald_r2", 0.0) or 0.0),
                "tomatoSlopePerStep": float(row.get("tomato_slope_per_step", 0.0) or 0.0),
                "tomatoR2": float(row.get("tomato_r2", 0.0) or 0.0),
            }
        )
    return parsed


def load_run_summaries(output_dir: Path) -> list[dict[str, Any]]:
    rows = read_csv_dicts(output_dir / "run_summary.csv", ",")
    parsed = []
    for row in rows:
        parsed.append(
            {
                "sessionId": int(row["session_id"]),
                "day": int(row["day"]),
                "totalPnl": float(row["total_pnl"]),
                "emeraldPnl": float(row["emerald_pnl"]),
                "tomatoPnl": float(row["tomato_pnl"]),
                "totalSlopePerStep": float(row.get("total_slope_per_step", 0.0) or 0.0),
                "totalR2": float(row.get("total_r2", 0.0) or 0.0),
                "emeraldSlopePerStep": float(row.get("emerald_slope_per_step", 0.0) or 0.0),
                "emeraldR2": float(row.get("emerald_r2", 0.0) or 0.0),
                "tomatoSlopePerStep": float(row.get("tomato_slope_per_step", 0.0) or 0.0),
                "tomatoR2": float(row.get("tomato_r2", 0.0) or 0.0),
            }
        )
    return parsed


def build_tail_risk_summary(total: dict[str, float], emerald: dict[str, float], tomato: dict[str, float]) -> dict[str, dict[str, float]]:
    return {
        "totalPnl": {
            "p05": total.get("p05", 0.0),
            "cvar95": total.get("cvar95", 0.0),
            "p01": total.get("p01", 0.0),
            "cvar99": total.get("cvar99", 0.0),
        },
        "emeraldPnl": {
            "p05": emerald.get("p05", 0.0),
            "cvar95": emerald.get("cvar95", 0.0),
            "p01": emerald.get("p01", 0.0),
            "cvar99": emerald.get("cvar99", 0.0),
        },
        "tomatoPnl": {
            "p05": tomato.get("p05", 0.0),
            "cvar95": tomato.get("cvar95", 0.0),
            "p01": tomato.get("p01", 0.0),
            "cvar99": tomato.get("cvar99", 0.0),
        },
    }


def summarize_output_dir(output_dir: Path) -> dict[str, Any]:
    session_rows = load_session_summaries(output_dir)
    run_rows = load_run_summaries(output_dir)

    total = [row["totalPnl"] for row in session_rows]
    emerald = [row["emeraldPnl"] for row in session_rows]
    tomato = [row["tomatoPnl"] for row in session_rows]
    total_stats = summarize_distribution(total)
    emerald_stats = summarize_distribution(emerald)
    tomato_stats = summarize_distribution(tomato)

    return {
        "sessionRows": session_rows,
        "runRows": run_rows,
        "totalPnl": total_stats,
        "emeraldPnl": emerald_stats,
        "tomatoPnl": tomato_stats,
        "tailRisk": build_tail_risk_summary(total_stats, emerald_stats, tomato_stats),
    }


def robust_scenario_payload(
    row: dict[str, Any],
    summary: dict[str, Any],
    normalized_weight: float,
) -> dict[str, Any]:
    return {
        "id": row["id"],
        "phi": row["phi"],
        "sigma": row["sigma"],
        "calibrationScore": row["calibrationScore"],
        "confidenceStatistic": row["confidenceStatistic"],
        "relativeWeight": row["relativeWeight"],
        "normalizedWeight": normalized_weight,
        "accepted": True,
        "totalPnl": summary["totalPnl"],
        "emeraldPnl": summary["emeraldPnl"],
        "tomatoPnl": summary["tomatoPnl"],
        "tailRisk": summary["tailRisk"],
    }


def aggregate_robust_results(
    calibration: dict[str, Any],
    output_dir: Path,
    base_summary: dict[str, Any],
    base_phi: float,
    base_sigma: float,
    algorithm: Path,
    data_root: Optional[Path],
    sessions: int,
    fv_mode: str,
    trade_mode: str,
    seed: int,
    python_bin: str,
    ticks_per_day: int,
) -> dict[str, Any]:
    scenarios_dir = output_dir / "dro_runs"
    scenarios_dir.mkdir(parents=True, exist_ok=True)

    accepted_payloads: list[dict[str, Any]] = []
    p05_total_values: list[float] = []
    p05_emerald_values: list[float] = []
    p05_tomato_values: list[float] = []
    weighted_total_values: list[float] = []
    weighted_emerald_values: list[float] = []
    weighted_tomato_values: list[float] = []
    weighted_total_weights: list[float] = []
    weighted_emerald_weights: list[float] = []
    weighted_tomato_weights: list[float] = []

    base_id = osmium_scenario_id(base_phi, base_sigma)

    for accepted_row in calibration["accepted"]:
        scenario_weight = accepted_row.get("normalizedWeight", 0.0)
        if accepted_row["id"] == base_id and math.isclose(accepted_row["phi"], base_phi) and math.isclose(accepted_row["sigma"], base_sigma):
            scenario_summary = base_summary
        else:
            scenario_dir = scenarios_dir / accepted_row["id"]
            scenario_dir.mkdir(parents=True, exist_ok=True)
            run_rust_monte_carlo(
                algorithm=algorithm,
                output_dir=scenario_dir,
                data_root=data_root,
                sessions=sessions,
                fv_mode=fv_mode,
                trade_mode=trade_mode,
                osmium_phi=accepted_row["phi"],
                osmium_sigma=accepted_row["sigma"],
                seed=seed,
                python_bin=python_bin,
                sample_sessions=0,
                ticks_per_day=ticks_per_day,
            )
            scenario_summary = summarize_output_dir(scenario_dir)

        payload = robust_scenario_payload(accepted_row, scenario_summary, scenario_weight)
        accepted_payloads.append(payload)
        p05_total_values.append(payload["totalPnl"]["p05"])
        p05_emerald_values.append(payload["emeraldPnl"]["p05"])
        p05_tomato_values.append(payload["tomatoPnl"]["p05"])

        sample_weight = scenario_weight / max(len(scenario_summary["sessionRows"]), 1)
        for session_row in scenario_summary["sessionRows"]:
            weighted_total_values.append(session_row["totalPnl"])
            weighted_emerald_values.append(session_row["emeraldPnl"])
            weighted_tomato_values.append(session_row["tomatoPnl"])
            weighted_total_weights.append(sample_weight)
            weighted_emerald_weights.append(sample_weight)
            weighted_tomato_weights.append(sample_weight)

    accepted_payloads.sort(key=lambda row: (-row["normalizedWeight"], row["calibrationScore"], row["phi"], row["sigma"]))
    worst_case_p05 = min(accepted_payloads, key=lambda row: row["totalPnl"]["p05"])
    worst_case_mean = min(accepted_payloads, key=lambda row: row["totalPnl"]["mean"])
    best_fit = min(accepted_payloads, key=lambda row: row["calibrationScore"])

    points = []
    payload_by_id = {payload["id"]: payload for payload in accepted_payloads}
    for point in calibration["points"]:
        accepted_payload = payload_by_id.get(point["id"])
        points.append(
            {
                "id": point["id"],
                "phi": point["phi"],
                "sigma": point["sigma"],
                "calibrationScore": point["calibrationScore"],
                "confidenceStatistic": point["confidenceStatistic"],
                "relativeWeight": point["relativeWeight"],
                "withinConfidenceRegion": point["withinConfidenceRegion"],
                "accepted": point["accepted"],
                "normalizedWeight": accepted_payload["normalizedWeight"] if accepted_payload is not None else 0.0,
                "meanTotalPnl": accepted_payload["totalPnl"]["mean"] if accepted_payload is not None else None,
                "p05TotalPnl": accepted_payload["totalPnl"]["p05"] if accepted_payload is not None else None,
                "cvar95TotalPnl": accepted_payload["totalPnl"]["cvar95"] if accepted_payload is not None else None,
            }
        )

    weighted_total = summarize_weighted_distribution(weighted_total_values, weighted_total_weights)
    weighted_emerald = summarize_weighted_distribution(weighted_emerald_values, weighted_emerald_weights)
    weighted_tomato = summarize_weighted_distribution(weighted_tomato_values, weighted_tomato_weights)

    return {
        "enabled": True,
        "grid": {
            "phiValues": calibration["phiValues"],
            "sigmaValues": calibration["sigmaValues"],
            "calibrationPaths": calibration["calibrationPaths"],
            "confidenceLevel": calibration["confidenceLevel"],
            "confidenceCutoff": calibration["confidenceCutoff"],
            "degreesOfFreedom": calibration["degreesOfFreedom"],
            "maxScenarios": calibration["maxScenarios"],
            "acceptedCount": len(accepted_payloads),
            "totalCount": len(calibration["points"]),
        },
        "acceptedScenarios": accepted_payloads,
        "allScenarios": points,
        "weightedMixture": {
            "totalPnl": weighted_total,
            "emeraldPnl": weighted_emerald,
            "tomatoPnl": weighted_tomato,
            "tailRisk": build_tail_risk_summary(weighted_total, weighted_emerald, weighted_tomato),
        },
        "p05Distributions": {
            "totalPnl": summarize_distribution(p05_total_values),
            "emeraldPnl": summarize_distribution(p05_emerald_values),
            "tomatoPnl": summarize_distribution(p05_tomato_values),
        },
        "p05Histograms": {
            "totalPnl": histogram(p05_total_values),
            "emeraldPnl": histogram(p05_emerald_values),
            "tomatoPnl": histogram(p05_tomato_values),
        },
        "worstCase": {
            "totalP05": worst_case_p05,
            "totalMean": worst_case_mean,
        },
        "bestFit": best_fit,
    }


def load_sample_session(session_dir: Path) -> dict[str, Any]:
    round_dir, trace_glob, round_stub = session_round_files(session_dir)
    traces_by_product: dict[str, dict[str, list[float]]] = {}
    prices_by_product: dict[str, dict[str, list[float]]] = {}
    day_files = sorted(
        int(path.stem.split("_")[-1])
        for path in round_dir.glob(trace_glob)
    )

    for day_index, day in enumerate(day_files):
        trace_rows = read_csv_dicts(round_dir / f"trace_{round_stub}_day_{day}.csv", ";")
        price_rows = read_csv_dicts(round_dir / f"prices_{round_stub}_day_{day}.csv", ";")
        day_offset = DAY_OFFSETS.get(day, day_index * 1_000_000)

        for row in trace_rows:
            product = product_key(row["product"])
            if product not in traces_by_product:
                traces_by_product[product] = {
                    "timestamps": [],
                    "fair": [],
                    "position": [],
                    "cash": [],
                    "mtmPnl": [],
                }
            ts = day_offset + int(row["timestamp"])
            traces_by_product[product]["timestamps"].append(ts)
            traces_by_product[product]["fair"].append(float(row["fair_value"]))
            traces_by_product[product]["position"].append(int(row["position"]))
            traces_by_product[product]["cash"].append(float(row["cash"]))
            traces_by_product[product]["mtmPnl"].append(float(row["mtm_pnl"]))

        for row in price_rows:
            product = product_key(row["product"])
            if product not in prices_by_product:
                prices_by_product[product] = {
                    "timestamps": [],
                    "mid": [],
                    "bid1": [],
                    "ask1": [],
                }
            ts = day_offset + int(row["timestamp"])
            prices_by_product[product]["timestamps"].append(ts)
            prices_by_product[product]["mid"].append(float(row["mid_price"]))
            prices_by_product[product]["bid1"].append(
                float(row["bid_price_1"]) if row["bid_price_1"] not in ("", None) else math.nan
            )
            prices_by_product[product]["ask1"].append(
                float(row["ask_price_1"]) if row["ask_price_1"] not in ("", None) else math.nan
            )

    products = {}
    for product, trace in traces_by_product.items():
        price = prices_by_product.get(product, {"mid": [], "bid1": [], "ask1": []})
        products[product] = {
            "timestamps": trace["timestamps"],
            "fair": trace["fair"],
            "mid": price["mid"],
            "bid1": price["bid1"],
            "ask1": price["ask1"],
            "position": trace["position"],
            "cash": trace["cash"],
            "mtmPnl": trace["mtmPnl"],
        }

    timestamps = products["EMERALDS"]["timestamps"] if "EMERALDS" in products else next(iter(products.values()))["timestamps"]
    total_pnl = []
    for idx in range(len(timestamps)):
        total_pnl.append(sum(products[product]["mtmPnl"][idx] for product in products))

    return {
        "sessionId": int(session_dir.name.split("_")[-1]),
        "products": products,
        "total": {
            "timestamps": timestamps,
            "mtmPnl": total_pnl,
        },
    }


def sampled_chart_path(sample: dict[str, Any]) -> dict[str, Any]:
    return {
        "sessionId": sample["sessionId"],
        "products": {
            product: downsample_path_node(node, CHART_POINTS_PER_SERIES)
            for product, node in sample["products"].items()
        },
        "total": downsample_path_node(sample["total"], CHART_POINTS_PER_SERIES),
    }


def write_sample_path_sidecars(output_dir: Path, sample_session_dirs: list[Path]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    refs: list[dict[str, Any]] = []
    sampled_paths: list[dict[str, Any]] = []
    sidecar_dir = output_dir / "sample_paths"
    sidecar_dir.mkdir(parents=True, exist_ok=True)

    for session_dir in sample_session_dirs:
        sample = load_sample_session(session_dir)
        sampled = sampled_chart_path(sample)
        sampled_paths.append(sampled)
        relative_path = Path("sample_paths") / f"{session_dir.name}.json"
        sidecar_path = output_dir / relative_path
        with sidecar_path.open("w", encoding="utf-8") as handle:
            json.dump(sampled, handle, separators=(",", ":"))
        refs.append(
            {
                "sessionId": sampled["sessionId"],
                "url": relative_path.as_posix(),
            }
        )

    return refs, sampled_paths


def quantile_series(sample_paths: list[dict[str, Any]], value_getter) -> dict[str, list[float]]:
    if not sample_paths:
        return {}

    base_values = value_getter(sample_paths[0])
    indices = downsample_indices(len(base_values), STATIC_CHART_POINTS)
    timestamps = [sample_paths[0]["total"]["timestamps"][index] for index in indices]

    p05: list[float] = []
    p25: list[float] = []
    p50: list[float] = []
    p75: list[float] = []
    p95: list[float] = []
    mean: list[float] = []

    for index in indices:
        values = [value_getter(path)[index] for path in sample_paths]
        p05.append(quantile(values, 0.05))
        p25.append(quantile(values, 0.25))
        p50.append(quantile(values, 0.50))
        p75.append(quantile(values, 0.75))
        p95.append(quantile(values, 0.95))
        mean.append(statistics.fmean(values))

    return {
        "timestamps": timestamps,
        "p05": p05,
        "p25": p25,
        "p50": p50,
        "p75": p75,
        "p95": p95,
        "mean": mean,
    }


def mean_std_band_series(sample_paths: list[dict[str, Any]], value_getter) -> dict[str, list[float]]:
    if not sample_paths:
        return {}

    base_values = value_getter(sample_paths[0])
    indices = downsample_indices(len(base_values), STATIC_CHART_POINTS)
    timestamps = [sample_paths[0]["total"]["timestamps"][index] for index in indices]

    mean_values: list[float] = []
    std1_low: list[float] = []
    std1_high: list[float] = []
    std3_low: list[float] = []
    std3_high: list[float] = []

    for index in indices:
        values = [value_getter(path)[index] for path in sample_paths]
        mu = statistics.fmean(values)
        sigma = sample_std(values)
        mean_values.append(mu)
        std1_low.append(mu - sigma)
        std1_high.append(mu + sigma)
        std3_low.append(mu - 3.0 * sigma)
        std3_high.append(mu + 3.0 * sigma)

    return {
        "timestamps": timestamps,
        "mean": mean_values,
        "std1Low": std1_low,
        "std1High": std1_high,
        "std3Low": std3_low,
        "std3High": std3_high,
    }


def overlay_series(sample_paths: list[dict[str, Any]], value_getter, overlay_count: int = 10) -> dict[str, Any]:
    overlays = []
    for path in sample_paths[:overlay_count]:
        values = value_getter(path)
        indices = downsample_indices(len(values), STATIC_CHART_POINTS)
        overlays.append(
            {
                "sessionId": path["sessionId"],
                "timestamps": [path["total"]["timestamps"][index] for index in indices],
                "values": [values[index] for index in indices],
            }
        )
    return {"overlays": overlays}


def path_chart_svg(
    title: str,
    subtitle: str,
    timestamps: list[float],
    bands: dict[str, list[float]],
    overlays: list[dict[str, Any]] | None = None,
) -> str:
    width = 1200
    height = 420
    left = 64
    right = 24
    top = 56
    bottom = 36
    plot_width = width - left - right
    plot_height = height - top - bottom

    y_values = bands["p05"] + bands["p95"] + bands["mean"]
    if overlays:
        for overlay in overlays:
            y_values.extend(overlay["values"])
    y_min = min(y_values)
    y_max = max(y_values)
    if y_min == y_max:
        y_min -= 1.0
        y_max += 1.0

    x_min = timestamps[0]
    x_max = timestamps[-1]
    x_range = x_max - x_min if x_max != x_min else 1.0
    y_range = y_max - y_min

    def x_pos(ts: float) -> float:
        return left + (ts - x_min) / x_range * plot_width

    def y_pos(value: float) -> float:
        return top + (1.0 - (value - y_min) / y_range) * plot_height

    def polyline(ts_values: list[float], values: list[float]) -> str:
        return " ".join(f"{x_pos(ts):.2f},{y_pos(value):.2f}" for ts, value in zip(ts_values, values))

    def band_polygon(lower: list[float], upper: list[float]) -> str:
        forward = [f"{x_pos(ts):.2f},{y_pos(value):.2f}" for ts, value in zip(timestamps, upper)]
        backward = [f"{x_pos(ts):.2f},{y_pos(value):.2f}" for ts, value in zip(reversed(timestamps), reversed(lower))]
        return " ".join(forward + backward)

    tick_labels = [timestamps[0], timestamps[len(timestamps) // 2], timestamps[-1]]
    y_ticks = [y_min, (y_min + y_max) / 2.0, y_max]

    svg_parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#101113"/>',
        f'<text x="{left}" y="28" fill="#f3f4f6" font-size="22" font-family="system-ui, sans-serif">{svg_escape(title)}</text>',
        f'<text x="{left}" y="46" fill="#9ca3af" font-size="13" font-family="system-ui, sans-serif">{svg_escape(subtitle)}</text>',
        f'<rect x="{left}" y="{top}" width="{plot_width}" height="{plot_height}" fill="#141517" stroke="#2c2e33"/>',
    ]

    for tick in y_ticks:
        y = y_pos(tick)
        svg_parts.append(f'<line x1="{left}" y1="{y:.2f}" x2="{left + plot_width}" y2="{y:.2f}" stroke="#25262b" stroke-width="1"/>')
        svg_parts.append(
            f'<text x="{left - 10}" y="{y + 4:.2f}" fill="#9ca3af" font-size="12" text-anchor="end" font-family="system-ui, sans-serif">{tick:.2f}</text>'
        )

    for tick in tick_labels:
        x = x_pos(tick)
        svg_parts.append(f'<line x1="{x:.2f}" y1="{top}" x2="{x:.2f}" y2="{top + plot_height}" stroke="#25262b" stroke-width="1"/>')
        svg_parts.append(
            f'<text x="{x:.2f}" y="{top + plot_height + 18}" fill="#9ca3af" font-size="12" text-anchor="middle" font-family="system-ui, sans-serif">{int(tick)}</text>'
        )

    svg_parts.append(f'<polygon points="{band_polygon(bands["p05"], bands["p95"])}" fill="#60a5fa" opacity="0.18"/>')
    svg_parts.append(f'<polygon points="{band_polygon(bands["p25"], bands["p75"])}" fill="#3b82f6" opacity="0.28"/>')
    svg_parts.append(f'<polyline points="{polyline(timestamps, bands["p50"])}" fill="none" stroke="#f8fafc" stroke-width="2"/>')
    svg_parts.append(f'<polyline points="{polyline(timestamps, bands["mean"])}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 4"/>')

    if overlays:
        for overlay in overlays:
            svg_parts.append(
                f'<polyline points="{polyline(overlay["timestamps"], overlay["values"])}" fill="none" stroke="#34d399" stroke-width="1.1" opacity="0.24"/>'
            )

    legend_x = left + 12
    legend_y = top + 18
    svg_parts.extend(
        [
            f'<rect x="{legend_x}" y="{legend_y - 10}" width="16" height="10" fill="#60a5fa" opacity="0.18"/>',
            f'<text x="{legend_x + 22}" y="{legend_y}" fill="#d1d5db" font-size="12" font-family="system-ui, sans-serif">P05-P95</text>',
            f'<rect x="{legend_x + 96}" y="{legend_y - 10}" width="16" height="10" fill="#3b82f6" opacity="0.28"/>',
            f'<text x="{legend_x + 118}" y="{legend_y}" fill="#d1d5db" font-size="12" font-family="system-ui, sans-serif">P25-P75</text>',
            f'<line x1="{legend_x + 194}" y1="{legend_y - 5}" x2="{legend_x + 210}" y2="{legend_y - 5}" stroke="#f8fafc" stroke-width="2"/>',
            f'<text x="{legend_x + 216}" y="{legend_y}" fill="#d1d5db" font-size="12" font-family="system-ui, sans-serif">Median</text>',
            f'<line x1="{legend_x + 278}" y1="{legend_y - 5}" x2="{legend_x + 294}" y2="{legend_y - 5}" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 4"/>',
            f'<text x="{legend_x + 300}" y="{legend_y}" fill="#d1d5db" font-size="12" font-family="system-ui, sans-serif">Mean</text>',
        ]
    )

    svg_parts.append("</svg>")
    return "".join(svg_parts)


def write_static_chart_svgs(output_dir: Path, sampled_paths: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    if not sampled_paths:
        return {}

    charts_dir = output_dir / "static_charts"
    charts_dir.mkdir(parents=True, exist_ok=True)

    chart_specs = {
        "EMERALDS": [
            ("fair_bands", "Fair Price Bands", lambda path: path["products"]["EMERALDS"]["fair"]),
            ("mtm_bands", "MTM PnL Bands", lambda path: path["products"]["EMERALDS"]["mtmPnl"]),
            ("position_bands", "Position Bands", lambda path: path["products"]["EMERALDS"]["position"]),
        ],
        "TOMATOES": [
            ("fair_bands", "Fair Price Bands", lambda path: path["products"]["TOMATOES"]["fair"]),
            ("mtm_bands", "MTM PnL Bands", lambda path: path["products"]["TOMATOES"]["mtmPnl"]),
            ("position_bands", "Position Bands", lambda path: path["products"]["TOMATOES"]["position"]),
        ],
    }

    refs: dict[str, list[dict[str, str]]] = {}
    for product, specs in chart_specs.items():
        display_name = product_label(product)
        product_refs: list[dict[str, str]] = []
        product_dir = charts_dir / product.lower()
        product_dir.mkdir(parents=True, exist_ok=True)
        for slug, title, getter in specs:
            bands = quantile_series(sampled_paths, getter)
            overlays = overlay_series(sampled_paths, getter)["overlays"]
            svg = path_chart_svg(
                title=f"{display_name} {title}",
                subtitle=f"{len(sampled_paths)} persisted session traces • overlays show first {min(10, len(overlays))} sessions",
                timestamps=bands["timestamps"],
                bands=bands,
                overlays=overlays,
            )
            relative_path = Path("static_charts") / product.lower() / f"{slug}.svg"
            chart_path = output_dir / relative_path
            chart_path.write_text(svg, encoding="utf-8")
            product_refs.append({"title": title, "url": relative_path.as_posix()})
        refs[product] = product_refs

    return refs


def build_band_series(sampled_paths: list[dict[str, Any]]) -> dict[str, dict[str, dict[str, list[float]]]]:
    if not sampled_paths:
        return {}

    return {
        "EMERALDS": {
            "fair": mean_std_band_series(sampled_paths, lambda path: path["products"]["EMERALDS"]["fair"]),
            "mtmPnl": mean_std_band_series(sampled_paths, lambda path: path["products"]["EMERALDS"]["mtmPnl"]),
            "position": mean_std_band_series(sampled_paths, lambda path: path["products"]["EMERALDS"]["position"]),
        },
        "TOMATOES": {
            "fair": mean_std_band_series(sampled_paths, lambda path: path["products"]["TOMATOES"]["fair"]),
            "mtmPnl": mean_std_band_series(sampled_paths, lambda path: path["products"]["TOMATOES"]["mtmPnl"]),
            "position": mean_std_band_series(sampled_paths, lambda path: path["products"]["TOMATOES"]["position"]),
        },
    }


def build_dashboard(output_dir: Path, algorithm: Path, sessions: int, config: dict[str, Any]) -> dict[str, Any]:
    session_rows = load_session_summaries(output_dir)
    run_rows = load_run_summaries(output_dir)
    total = [row["totalPnl"] for row in session_rows]
    emerald = [row["emeraldPnl"] for row in session_rows]
    tomato = [row["tomatoPnl"] for row in session_rows]
    emerald_pos = [row["emeraldPosition"] for row in session_rows]
    tomato_pos = [row["tomatoPosition"] for row in session_rows]
    emerald_cash = [row["emeraldCash"] for row in session_rows]
    tomato_cash = [row["tomatoCash"] for row in session_rows]
    total_profitability = [row["totalSlopePerStep"] for row in run_rows]
    total_stability = [row["totalR2"] for row in run_rows]
    emerald_profitability = [row["emeraldSlopePerStep"] for row in run_rows]
    emerald_stability = [row["emeraldR2"] for row in run_rows]
    tomato_profitability = [row["tomatoSlopePerStep"] for row in run_rows]
    tomato_stability = [row["tomatoR2"] for row in run_rows]
    session_total_profitability = [row["totalSlopePerStep"] for row in session_rows]
    session_total_stability = [row["totalR2"] for row in session_rows]
    session_emerald_profitability = [row["emeraldSlopePerStep"] for row in session_rows]
    session_emerald_stability = [row["emeraldR2"] for row in session_rows]
    session_tomato_profitability = [row["tomatoSlopePerStep"] for row in session_rows]
    session_tomato_stability = [row["tomatoR2"] for row in session_rows]

    sample_session_dirs = sorted((output_dir / "sessions").glob("session_*")) if (output_dir / "sessions").exists() else []
    sample_path_refs, sampled_paths = write_sample_path_sidecars(output_dir, sample_session_dirs) if sample_session_dirs else ([], [])
    band_chart_refs = write_static_chart_svgs(output_dir, sampled_paths) if sampled_paths else {}
    band_series = build_band_series(sampled_paths) if sampled_paths else {}

    runs_by_session: dict[int, list[dict[str, Any]]] = {}
    for run in run_rows:
        runs_by_session.setdefault(run["sessionId"], []).append(run)
    for row in session_rows:
        session_runs = runs_by_session.get(row["sessionId"], [])
        if session_runs:
            row["runMeanTotalSlopePerStep"] = statistics.fmean(run["totalSlopePerStep"] for run in session_runs)
            row["runMeanTotalR2"] = statistics.fmean(run["totalR2"] for run in session_runs)
        else:
            row["runMeanTotalSlopePerStep"] = row["totalSlopePerStep"]
            row["runMeanTotalR2"] = row["totalR2"]

    top_sessions = sorted(session_rows, key=lambda row: row["totalPnl"], reverse=True)[:10]
    bottom_sessions = sorted(session_rows, key=lambda row: row["totalPnl"])[:10]
    scatter_fit = linear_regression(emerald, tomato)
    total_normal_fit = normal_fit(total)
    emerald_normal_fit = normal_fit(emerald)
    tomato_normal_fit = normal_fit(tomato)
    total_stats = summarize_distribution(total)
    emerald_stats = summarize_distribution(emerald)
    tomato_stats = summarize_distribution(tomato)

    return {
        "kind": "monte_carlo_dashboard",
        "meta": {
            "algorithmPath": str(algorithm),
            "sessionCount": sessions,
            "bandSessionCount": len(sample_session_dirs),
            "productLabels": PRODUCT_LABELS,
            **config,
        },
        "overall": {
            "totalPnl": total_stats,
            "emeraldPnl": emerald_stats,
            "tomatoPnl": tomato_stats,
            "emeraldTomatoCorrelation": correlation(emerald, tomato),
        },
        "trendFits": {
            "TOTAL": {
                "profitability": summarize_distribution(total_profitability),
                "stability": summarize_distribution(total_stability),
            },
            "EMERALDS": {
                "profitability": summarize_distribution(emerald_profitability),
                "stability": summarize_distribution(emerald_stability),
            },
            "TOMATOES": {
                "profitability": summarize_distribution(tomato_profitability),
                "stability": summarize_distribution(tomato_stability),
            },
        },
        "aggregateTrendFits": {
            "TOTAL": {
                "profitability": summarize_distribution(session_total_profitability),
                "stability": summarize_distribution(session_total_stability),
            },
            "EMERALDS": {
                "profitability": summarize_distribution(session_emerald_profitability),
                "stability": summarize_distribution(session_emerald_stability),
            },
            "TOMATOES": {
                "profitability": summarize_distribution(session_tomato_profitability),
                "stability": summarize_distribution(session_tomato_stability),
            },
        },
        "normalFits": {
            "totalPnl": total_normal_fit,
            "emeraldPnl": emerald_normal_fit,
            "tomatoPnl": tomato_normal_fit,
        },
        "scatterFit": scatter_fit,
        "generatorModel": {
            "EMERALDS": ROUND1_GENERATOR_MODELS["EMERALDS"],
            "TOMATOES": ROUND1_GENERATOR_MODELS["TOMATOES"],
        },
        "products": {
            "EMERALDS": {
                "pnl": emerald_stats,
                "finalPosition": summarize_distribution([float(value) for value in emerald_pos]),
                "cash": summarize_distribution(emerald_cash),
            },
            "TOMATOES": {
                "pnl": tomato_stats,
                "finalPosition": summarize_distribution([float(value) for value in tomato_pos]),
                "cash": summarize_distribution(tomato_cash),
            },
        },
        "tailRisk": build_tail_risk_summary(total_stats, emerald_stats, tomato_stats),
        "histograms": {
            "totalPnl": histogram(total),
            "emeraldPnl": histogram(emerald),
            "tomatoPnl": histogram(tomato),
            "totalProfitability": histogram(total_profitability),
            "totalStability": histogram(total_stability),
            "emeraldProfitability": histogram(emerald_profitability),
            "emeraldStability": histogram(emerald_stability),
            "tomatoProfitability": histogram(tomato_profitability),
            "tomatoStability": histogram(tomato_stability),
        },
        "sessions": session_rows,
        "runs": run_rows,
        "topSessions": top_sessions,
        "bottomSessions": bottom_sessions,
        "samplePaths": [],
        "samplePathRefs": sample_path_refs,
        "bandChartRefs": band_chart_refs,
        "bandSeries": band_series,
    }


def run_rust_monte_carlo(
    algorithm: Path,
    output_dir: Path,
    data_root: Optional[Path],
    sessions: int,
    fv_mode: str,
    trade_mode: str,
    osmium_phi: float,
    osmium_sigma: float,
    seed: int,
    python_bin: str,
    sample_sessions: int,
    ticks_per_day: int = 10000,
) -> None:
    actual_dir = resolve_actual_dir(data_root)
    simulator_dir = rust_dir()
    if not simulator_dir.is_dir():
        raise RuntimeError(
            f"Rust simulator directory not found at {simulator_dir}. "
            "prosperity4mcbt currently expects a full repository checkout."
        )
    cmd = [
        "cargo",
        "run",
        "--release",
        "--",
        "--strategy",
        str(algorithm.resolve()),
        "--sessions",
        str(sessions),
        "--output",
        str(output_dir.resolve()),
        "--fv-mode",
        fv_mode,
        "--trade-mode",
        trade_mode,
        "--osmium-phi",
        str(osmium_phi),
        "--osmium-sigma",
        str(osmium_sigma),
        "--seed",
        str(seed),
        "--python-bin",
        python_bin,
        "--write-session-limit",
        str(sample_sessions),
        "--actual-dir",
        str(actual_dir.resolve()),
        "--ticks-per-day",
        str(ticks_per_day),
    ]
    env = {**os.environ, "PROSPERITY4MCBT_ROOT": str(project_root().resolve())}
    subprocess.run(cmd, cwd=simulator_dir, env=env, check=True)


def run_monte_carlo_mode(
    algorithm: Path,
    dashboard_path: Path,
    data_root: Optional[Path],
    sessions: int,
    fv_mode: str,
    trade_mode: str,
    osmium_phi: float,
    osmium_sigma: float,
    seed: int,
    python_bin: str,
    sample_sessions: int,
    ticks_per_day: int = 10000,
    dro: bool = False,
    dro_phi_min: Optional[float] = None,
    dro_phi_max: Optional[float] = None,
    dro_phi_steps: int = 5,
    dro_sigma_min: Optional[float] = None,
    dro_sigma_max: Optional[float] = None,
    dro_sigma_steps: int = 5,
    dro_confidence: float = 0.90,
    dro_calibration_paths: int = 96,
    dro_max_scenarios: int = 9,
) -> dict[str, Any]:
    output_dir = dashboard_path.parent
    if output_dir.exists():
        for name in GENERATED_OUTPUT_FILES:
            path = output_dir / name
            if path.is_file():
                path.unlink()
        for name in GENERATED_OUTPUT_DIRS:
            path = output_dir / name
            if path.is_dir():
                shutil.rmtree(path)
    output_dir.mkdir(parents=True, exist_ok=True)

    run_rust_monte_carlo(
        algorithm=algorithm,
        output_dir=output_dir,
        data_root=data_root,
        sessions=sessions,
        fv_mode=fv_mode,
        trade_mode=trade_mode,
        osmium_phi=osmium_phi,
        osmium_sigma=osmium_sigma,
        seed=seed,
        python_bin=python_bin,
        sample_sessions=sample_sessions,
        ticks_per_day=ticks_per_day,
    )

    dashboard = build_dashboard(
        output_dir,
        algorithm,
        sessions,
        {
            "fvMode": fv_mode,
            "tradeMode": trade_mode,
            "tomatoSupport": "deterministic",
            "osmiumPhi": osmium_phi,
            "osmiumSigma": osmium_sigma,
            "droEnabled": dro,
            "seed": seed,
            "sampleSessions": sample_sessions,
        },
    )

    if dro:
        phi_min = max(0.0, dro_phi_min if dro_phi_min is not None else osmium_phi - 0.0015)
        phi_max = min(0.99995, dro_phi_max if dro_phi_max is not None else osmium_phi + 0.0015)
        sigma_min = max(0.05, dro_sigma_min if dro_sigma_min is not None else osmium_sigma - 0.06)
        sigma_max = max(sigma_min, dro_sigma_max if dro_sigma_max is not None else osmium_sigma + 0.06)
        phi_steps = max(dro_phi_steps, 1)
        sigma_steps = max(dro_sigma_steps, 1)

        phi_values = [float(value) for value in np.linspace(phi_min, phi_max, phi_steps)]
        sigma_values = [float(value) for value in np.linspace(sigma_min, sigma_max, sigma_steps)]
        if not any(math.isclose(value, osmium_phi, rel_tol=0.0, abs_tol=1e-9) for value in phi_values):
            phi_values.append(float(osmium_phi))
            phi_values.sort()
        if not any(math.isclose(value, osmium_sigma, rel_tol=0.0, abs_tol=1e-9) for value in sigma_values):
            sigma_values.append(float(osmium_sigma))
            sigma_values.sort()

        calibration = calibrate_osmium_parameter_family(
            actual_dir=resolve_actual_dir(data_root),
            phi_values=phi_values,
            sigma_values=sigma_values,
            calibration_paths=dro_calibration_paths,
            seed=seed,
            confidence_level=dro_confidence,
            max_scenarios=dro_max_scenarios,
        )
        robust = aggregate_robust_results(
            calibration=calibration,
            output_dir=output_dir,
            base_summary=summarize_output_dir(output_dir),
            base_phi=osmium_phi,
            base_sigma=osmium_sigma,
            algorithm=algorithm,
            data_root=data_root,
            sessions=sessions,
            fv_mode=fv_mode,
            trade_mode=trade_mode,
            seed=seed,
            python_bin=python_bin,
            ticks_per_day=ticks_per_day,
        )
        dashboard["robust"] = robust

    with dashboard_path.open("w", encoding="utf-8") as handle:
        json.dump(dashboard, handle, indent=2)

    return dashboard
