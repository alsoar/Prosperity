from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent.parent / ".mplconfig"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import ks_2samp, wasserstein_distance


MASK_NAMES = ("inner_bid", "outer_bid", "inner_ask", "outer_ask")


def percentile_rank(reference: np.ndarray, value: float) -> float:
    return float(np.mean(reference <= value))


def ecdf(values: np.ndarray, grid: np.ndarray) -> np.ndarray:
    ordered = np.sort(values)
    return np.searchsorted(ordered, grid, side="right") / len(ordered)


def summarize(values: np.ndarray) -> dict[str, float]:
    return {
        "count": float(len(values)),
        "mean": float(np.mean(values)),
        "std": float(np.std(values)),
        "q05": float(np.quantile(values, 0.05)),
        "q25": float(np.quantile(values, 0.25)),
        "q50": float(np.quantile(values, 0.50)),
        "q75": float(np.quantile(values, 0.75)),
        "q95": float(np.quantile(values, 0.95)),
        "min": float(np.min(values)),
        "max": float(np.max(values)),
        "zero_rate": float(np.mean(values == 0.0)),
    }


def band_summary(values: np.ndarray) -> dict[str, float]:
    return {
        "p05": float(np.quantile(values, 0.05)),
        "p25": float(np.quantile(values, 0.25)),
        "p50": float(np.quantile(values, 0.50)),
        "p75": float(np.quantile(values, 0.75)),
        "p95": float(np.quantile(values, 0.95)),
        "mean": float(np.mean(values)),
    }


def within_band(value: float, lo: float, hi: float) -> bool:
    return lo <= value <= hi


def infer_best_interval(row: pd.Series) -> tuple[float, float, float, tuple[bool, bool, bool, bool], int] | None:
    bid_levels = [(int(row[f"bid_price_{idx}"]), int(row[f"bid_volume_{idx}"])) for idx in (1, 2, 3) if pd.notna(row[f"bid_price_{idx}"])]
    ask_levels = [(int(row[f"ask_price_{idx}"]), int(row[f"ask_volume_{idx}"])) for idx in (1, 2, 3) if pd.notna(row[f"ask_price_{idx}"])]

    bid_assignments: list[tuple[int | None, int | None]] = []
    for inner in [None, *range(len(bid_levels))]:
        for outer in [None, *range(len(bid_levels))]:
            if inner is not None and outer is not None and inner == outer:
                continue
            if inner is not None and not (10 <= bid_levels[inner][1] <= 15):
                continue
            if outer is not None and not (20 <= bid_levels[outer][1] <= 30):
                continue
            if inner is not None and outer is not None and not (bid_levels[inner][0] > bid_levels[outer][0]):
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
            if inner is not None and outer is not None and not (ask_levels[inner][0] < ask_levels[outer][0]):
                continue
            ask_assignments.append((inner, outer))

    best: tuple[tuple[float, int], tuple[float, float, float, tuple[bool, bool, bool, bool], int]] | None = None
    for bid_inner, bid_outer in bid_assignments:
        for ask_inner, ask_outer in ask_assignments:
            lower = -1e18
            upper = 1e18
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

            if used < 2 or not (lower < upper):
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


def extract_observable_proxy(day_prices: pd.DataFrame) -> dict[str, np.ndarray]:
    mids = np.full(len(day_prices), np.nan, dtype=np.float64)
    widths = np.full(len(day_prices), np.nan, dtype=np.float64)
    valid = np.zeros(len(day_prices), dtype=bool)
    strong = np.zeros(len(day_prices), dtype=bool)
    masks = np.zeros((len(day_prices), 4), dtype=bool)

    for pos, (_, row) in enumerate(day_prices.iterrows()):
        best = infer_best_interval(row)
        if best is None:
            continue
        lower, upper, midpoint, mask, _ = best
        width = upper - lower
        mids[pos] = midpoint
        widths[pos] = width
        valid[pos] = True
        strong[pos] = math.isclose(width, 0.5)
        masks[pos] = mask

    return {
        "midpoint": mids,
        "width": widths,
        "valid": valid,
        "strong": strong,
        "masks": masks,
        "timestamps": day_prices["timestamp"].to_numpy(dtype=np.int32),
    }


def simulate_fv_paths(
    start_fv: float,
    n_ticks: int,
    n_sessions: int,
    mu: float,
    phi: float,
    sigma: float,
    seed: int,
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    paths = np.empty((n_sessions, n_ticks), dtype=np.float32)
    paths[:, 0] = np.float32(start_fv)
    for idx in range(1, n_ticks):
        shocks = rng.normal(0.0, sigma, size=n_sessions)
        updated = mu + phi * (paths[:, idx - 1].astype(np.float64) - mu) + shocks
        paths[:, idx] = updated.astype(np.float32)
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


def build_simulated_proxy(simulated_fv: np.ndarray, masks: np.ndarray, strong: np.ndarray) -> np.ndarray:
    sessions, ticks = simulated_fv.shape
    proxy = np.full((sessions, ticks), np.nan, dtype=np.float64)
    for idx in np.flatnonzero(strong):
        midpoint, valid = midpoint_from_masked_quotes(simulated_fv[:, idx], tuple(bool(value) for value in masks[idx]))
        proxy[valid, idx] = midpoint[valid]
    return proxy


def collect_non_overlapping_returns(midpoint: np.ndarray, valid: np.ndarray, horizon: int) -> np.ndarray:
    starts = np.arange(0, len(midpoint) - horizon, horizon, dtype=np.int32)
    keep = valid[starts] & valid[starts + horizon]
    return midpoint[starts[keep] + horizon] - midpoint[starts[keep]]


def collect_simulated_non_overlapping_returns(midpoint: np.ndarray, valid: np.ndarray, horizon: int) -> np.ndarray:
    starts = np.arange(0, midpoint.shape[1] - horizon, horizon, dtype=np.int32)
    keep = valid[starts] & valid[starts + horizon]
    keep &= np.all(np.isfinite(midpoint[:, starts]), axis=0)
    keep &= np.all(np.isfinite(midpoint[:, starts + horizon]), axis=0)
    return midpoint[:, starts[keep] + horizon] - midpoint[:, starts[keep]]


def pmf_bands(actual: np.ndarray, simulated: np.ndarray) -> dict[str, np.ndarray]:
    support = np.unique(np.concatenate([actual, simulated.reshape(-1)]))
    actual_freq = np.array([np.mean(actual == value) for value in support], dtype=np.float64)
    simulated_freq = np.stack(
        [np.array([np.mean(path == value) for value in support], dtype=np.float64) for path in simulated],
        axis=0,
    )
    return {
        "support": support,
        "actual": actual_freq,
        "p05": np.quantile(simulated_freq, 0.05, axis=0),
        "p25": np.quantile(simulated_freq, 0.25, axis=0),
        "p50": np.quantile(simulated_freq, 0.50, axis=0),
        "p75": np.quantile(simulated_freq, 0.75, axis=0),
        "p95": np.quantile(simulated_freq, 0.95, axis=0),
    }


def cdf_bands(actual: np.ndarray, simulated: np.ndarray, points: int = 250) -> dict[str, np.ndarray | float]:
    lower = float(min(actual.min(), simulated.min()))
    upper = float(max(actual.max(), simulated.max()))
    grid = np.linspace(lower, upper, points)
    actual_cdf = ecdf(actual, grid)
    simulated_cdf = np.stack([ecdf(path, grid) for path in simulated], axis=0)
    p05 = np.quantile(simulated_cdf, 0.05, axis=0)
    p25 = np.quantile(simulated_cdf, 0.25, axis=0)
    p50 = np.quantile(simulated_cdf, 0.50, axis=0)
    p75 = np.quantile(simulated_cdf, 0.75, axis=0)
    p95 = np.quantile(simulated_cdf, 0.95, axis=0)
    return {
        "grid": grid,
        "actual": actual_cdf,
        "p05": p05,
        "p25": p25,
        "p50": p50,
        "p75": p75,
        "p95": p95,
        "iqr_coverage": float(np.mean((actual_cdf >= p25) & (actual_cdf <= p75))),
        "band90_coverage": float(np.mean((actual_cdf >= p05) & (actual_cdf <= p95))),
    }


def compare_horizon(actual_returns: np.ndarray, simulated_returns: np.ndarray, horizon: int) -> dict:
    stat_names = ("mean", "std", "q05", "q25", "q50", "q75", "q95", "zero_rate")
    actual_stats = summarize(actual_returns)
    simulated_stats_by_session = {name: np.array([summarize(path)[name] for path in simulated_returns]) for name in stat_names}
    stat_bands = {
        name: {
            **band_summary(values),
            "actual": actual_stats[name],
            "inside_iqr": within_band(actual_stats[name], float(np.quantile(values, 0.25)), float(np.quantile(values, 0.75))),
            "inside_90": within_band(actual_stats[name], float(np.quantile(values, 0.05)), float(np.quantile(values, 0.95))),
        }
        for name, values in simulated_stats_by_session.items()
    }

    actual_wasserstein = np.array([wasserstein_distance(actual_returns, path) for path in simulated_returns])
    actual_ks = np.array([ks_2samp(actual_returns, path, method="auto").statistic for path in simulated_returns])
    pair_count = simulated_returns.shape[0] // 2
    baseline_wasserstein = np.array(
        [wasserstein_distance(simulated_returns[2 * idx], simulated_returns[2 * idx + 1]) for idx in range(pair_count)]
    )
    baseline_ks = np.array(
        [ks_2samp(simulated_returns[2 * idx], simulated_returns[2 * idx + 1], method="auto").statistic for idx in range(pair_count)]
    )

    pmf = pmf_bands(actual_returns, simulated_returns)
    cdf = cdf_bands(actual_returns, simulated_returns)

    return {
        "horizon": horizon,
        "actual_return_count": int(len(actual_returns)),
        "actual_stats": actual_stats,
        "stat_bands": stat_bands,
        "cdf_coverage": {
            "iqr": cdf["iqr_coverage"],
            "band90": cdf["band90_coverage"],
        },
        "wasserstein": {
            "actual_vs_sim": band_summary(actual_wasserstein),
            "sim_vs_sim": band_summary(baseline_wasserstein),
            "actual_median_percentile_vs_sim_baseline": percentile_rank(baseline_wasserstein, float(np.median(actual_wasserstein))),
        },
        "ks": {
            "actual_vs_sim": band_summary(actual_ks),
            "sim_vs_sim": band_summary(baseline_ks),
            "actual_median_percentile_vs_sim_baseline": percentile_rank(baseline_ks, float(np.median(actual_ks))),
        },
        "plot_data": {
            "pmf": {key: value.tolist() for key, value in pmf.items()},
            "cdf": {key: (value.tolist() if isinstance(value, np.ndarray) else value) for key, value in cdf.items()},
        },
    }


def plot_results(results: list[dict], output: Path, model_label: str) -> None:
    fig, axes = plt.subplots(len(results), 2, figsize=(13.5, 4.2 * len(results)), constrained_layout=True)
    if len(results) == 1:
        axes = np.array([axes])

    for row_axes, result in zip(axes, results):
        pmf_ax, cdf_ax = row_axes
        pmf = result["plot_data"]["pmf"]
        support = np.asarray(pmf["support"])
        actual = np.asarray(pmf["actual"])
        p05 = np.asarray(pmf["p05"])
        p25 = np.asarray(pmf["p25"])
        p50 = np.asarray(pmf["p50"])
        p75 = np.asarray(pmf["p75"])
        p95 = np.asarray(pmf["p95"])
        spacing = float(np.min(np.diff(support))) if len(support) > 1 else 0.5
        outer_width = 0.82 * spacing
        inner_width = 0.56 * spacing
        actual_width = 0.26 * spacing

        pmf_ax.bar(support, p95 - p05, width=outer_width, bottom=p05, color="#d5e2ea", alpha=0.85, label="sim 5%-95%")
        pmf_ax.bar(support, p75 - p25, width=inner_width, bottom=p25, color="#97b7c8", alpha=0.95, label="sim 25%-75%")
        pmf_ax.scatter(support, p50, color="#20506d", s=16, label="sim median", zorder=3)
        pmf_ax.bar(support, actual, width=actual_width, color="#b33a3a", alpha=0.96, label="actual", zorder=4)
        pmf_ax.set_title(f"{result['horizon']}-tick discrete midpoint-return PMF")
        pmf_ax.set_xlabel("Return")
        pmf_ax.set_ylabel("Probability")
        pmf_ax.grid(axis="y", alpha=0.22)
        pmf_ax.legend(frameon=False, fontsize=8)

        cdf = result["plot_data"]["cdf"]
        grid = np.asarray(cdf["grid"])
        actual_cdf = np.asarray(cdf["actual"])
        p05 = np.asarray(cdf["p05"])
        p25 = np.asarray(cdf["p25"])
        p50 = np.asarray(cdf["p50"])
        p75 = np.asarray(cdf["p75"])
        p95 = np.asarray(cdf["p95"])
        cdf_ax.fill_between(grid, p05, p95, color="#d5e2ea", alpha=0.7, step="post", label="sim 5%-95%")
        cdf_ax.fill_between(grid, p25, p75, color="#97b7c8", alpha=0.9, step="post", label="sim 25%-75%")
        cdf_ax.step(grid, p50, where="post", color="#20506d", linewidth=1.8, label="sim median")
        cdf_ax.step(grid, actual_cdf, where="post", color="#b33a3a", linewidth=1.8, label="actual")
        cdf_ax.set_title(
            f"{result['horizon']}-tick ECDF bands"
            f"\nIQR cover={result['cdf_coverage']['iqr']:.1%}, 90% cover={result['cdf_coverage']['band90']:.1%}"
        )
        cdf_ax.set_xlabel("Return")
        cdf_ax.set_ylabel("CDF")
        cdf_ax.set_ylim(0.0, 1.0)
        cdf_ax.grid(alpha=0.22)
        cdf_ax.legend(frameon=False, fontsize=8)

    fig.suptitle(f"ASH_COATED_OSMIUM observable-space check: {model_label}", fontsize=15)
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=180)
    plt.close(fig)


def print_summary(dataset_summary: dict, results: list[dict]) -> None:
    for key, value in dataset_summary.items():
        print(f"{key}={value}")
    print()

    for result in results:
        print(f"horizon={result['horizon']}")
        print(f"actual_return_count={result['actual_return_count']}")
        print(
            "cdf_coverage"
            f" iqr={result['cdf_coverage']['iqr']:.6f}"
            f" band90={result['cdf_coverage']['band90']:.6f}"
        )
        for name in ("std", "q05", "q50", "q95"):
            stats = result["stat_bands"][name]
            print(
                f"stat={name}"
                f" actual={stats['actual']:.9f}"
                f" p25={stats['p25']:.9f}"
                f" p75={stats['p75']:.9f}"
                f" p05={stats['p05']:.9f}"
                f" p95={stats['p95']:.9f}"
                f" inside_iqr={int(stats['inside_iqr'])}"
                f" inside_90={int(stats['inside_90'])}"
            )
        for name in ("wasserstein", "ks"):
            stats = result[name]
            print(
                f"{name}"
                f" actual_median={stats['actual_vs_sim']['p50']:.9f}"
                f" baseline_p50={stats['sim_vs_sim']['p50']:.9f}"
                f" baseline_p95={stats['sim_vs_sim']['p95']:.9f}"
                f" actual_median_percentile={stats['actual_median_percentile_vs_sim_baseline']:.6f}"
            )
        print()


def load_full_osmium_prices(data_root: Path) -> dict[int, pd.DataFrame]:
    out: dict[int, pd.DataFrame] = {}
    for day in (-2, -1, 0):
        frame = pd.read_csv(data_root / f"prices_round_1_day_{day}.csv", sep=";")
        out[day] = frame[frame["product"] == "ASH_COATED_OSMIUM"].sort_values("timestamp").reset_index(drop=True)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Observable-space posterior predictive check for ASH_COATED_OSMIUM using all visible round-1 data.")
    parser.add_argument(
        "--data-root",
        type=Path,
        default=Path("/Users/alexsod/prosperity/prosperity-analysis/hidden_trader_detector/data/imc_round1/round1"),
    )
    parser.add_argument("--mu", type=float, default=10000.0)
    parser.add_argument("--phi", type=float, default=0.99)
    parser.add_argument("--sigma", type=float, default=0.310738)
    parser.add_argument("--sessions", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=20260414)
    parser.add_argument("--horizons", type=int, nargs="+", default=[5, 10, 20])
    parser.add_argument(
        "--plot-output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_observable_ppc.png",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_observable_ppc.json",
    )
    args = parser.parse_args()

    day_frames = load_full_osmium_prices(args.data_root)
    proxies = {day: extract_observable_proxy(frame) for day, frame in day_frames.items()}

    simulated_returns_by_horizon: dict[int, list[np.ndarray]] = {horizon: [] for horizon in args.horizons}
    actual_returns_by_horizon: dict[int, list[np.ndarray]] = {horizon: [] for horizon in args.horizons}
    strong_counts = 0
    valid_counts = 0
    total_counts = 0
    start_values: dict[int, float] = {}

    for day_index, day in enumerate(sorted(day_frames)):
        proxy = proxies[day]
        strong = proxy["strong"]
        midpoint = proxy["midpoint"]
        valid = proxy["valid"]
        masks = proxy["masks"]
        strong_counts += int(np.sum(strong))
        valid_counts += int(np.sum(valid))
        total_counts += len(midpoint)

        first_strong = float(midpoint[np.flatnonzero(strong)[0]])
        start_values[day] = first_strong
        simulated_fv = simulate_fv_paths(
            start_fv=first_strong,
            n_ticks=len(midpoint),
            n_sessions=args.sessions,
            mu=args.mu,
            phi=args.phi,
            sigma=args.sigma,
            seed=args.seed + day_index,
        )
        simulated_proxy = build_simulated_proxy(simulated_fv, masks=masks, strong=strong)

        for horizon in args.horizons:
            actual_returns_by_horizon[horizon].append(collect_non_overlapping_returns(midpoint, strong, horizon))
            simulated_returns_by_horizon[horizon].append(collect_simulated_non_overlapping_returns(simulated_proxy, strong, horizon))

    results = []
    for horizon in args.horizons:
        actual_returns = np.concatenate(actual_returns_by_horizon[horizon])
        simulated_returns = np.concatenate(simulated_returns_by_horizon[horizon], axis=1)
        results.append(compare_horizon(actual_returns, simulated_returns, horizon))

    dataset_summary = {
        "days": len(day_frames),
        "ticks_total": total_counts,
        "observable_valid_ticks": valid_counts,
        "observable_strong_ticks": strong_counts,
        "observable_strong_rate": round(strong_counts / total_counts, 6),
        "sessions": args.sessions,
        "mu": args.mu,
        "phi": args.phi,
        "sigma": args.sigma,
        **{f"day_{day}_start_proxy": start for day, start in start_values.items()},
    }
    payload = {
        "model": {
            "kind": "single_normal",
            "mu": args.mu,
            "phi": args.phi,
            "sigma": args.sigma,
            "quantization": "float32",
            "observable_proxy": "midpoint of the 0.5-wide feasible FV interval implied by visible inner/outer quotes",
            "conditioning": "uses the actual per-tick inner/outer visibility mask; does not model the presence process",
        },
        "dataset_summary": dataset_summary,
        "results": results,
    }

    print_summary(dataset_summary, results)
    plot_results(
        results,
        output=args.plot_output,
        model_label=f"mu={args.mu:.0f}, phi={args.phi:.2f}, sigma={args.sigma:.6f}, strong proxy only",
    )
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
