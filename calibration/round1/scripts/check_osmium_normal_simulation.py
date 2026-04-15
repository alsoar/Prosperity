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
from scipy.stats import ks_2samp, wasserstein_distance

from analyze_round1_products import PRODUCTS, load_rows


def compute_block_returns(path: np.ndarray, horizon: int) -> np.ndarray:
    block_count = (len(path) - 1) // horizon
    starts = np.arange(block_count) * horizon
    ends = starts + horizon
    return path[ends] - path[starts]


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


def percentile_rank(reference: np.ndarray, value: float) -> float:
    return float(np.mean(reference <= value))


def ecdf(values: np.ndarray, grid: np.ndarray) -> np.ndarray:
    ordered = np.sort(values)
    return np.searchsorted(ordered, grid, side="right") / len(ordered)


def simulate_paths(
    start_fv: float,
    n_points: int,
    n_paths: int,
    mu: float,
    phi: float,
    sigma: float,
    seed: int,
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    paths = np.empty((n_paths, n_points), dtype=np.float32)
    paths[:, 0] = np.float32(start_fv)
    for idx in range(1, n_points):
        shocks = rng.normal(0.0, sigma, size=n_paths)
        updated = mu + phi * (paths[:, idx - 1].astype(np.float64) - mu) + shocks
        paths[:, idx] = updated.astype(np.float32)
    return paths.astype(np.float64)


def histogram_bands(actual: np.ndarray, simulated: np.ndarray, bins: int) -> dict[str, np.ndarray]:
    lo = float(min(actual.min(), simulated.min()))
    hi = float(max(actual.max(), simulated.max()))
    if math.isclose(lo, hi):
        lo -= 0.5
        hi += 0.5
    edges = np.linspace(lo, hi, bins + 1)
    actual_hist, _ = np.histogram(actual, bins=edges)
    actual_freq = actual_hist / len(actual)
    simulated_freq = np.stack([np.histogram(path, bins=edges)[0] / len(path) for path in simulated], axis=0)
    centers = 0.5 * (edges[:-1] + edges[1:])
    return {
        "edges": edges,
        "centers": centers,
        "actual": actual_freq,
        "p05": np.quantile(simulated_freq, 0.05, axis=0),
        "p25": np.quantile(simulated_freq, 0.25, axis=0),
        "p50": np.quantile(simulated_freq, 0.50, axis=0),
        "p75": np.quantile(simulated_freq, 0.75, axis=0),
        "p95": np.quantile(simulated_freq, 0.95, axis=0),
    }


def cdf_bands(actual: np.ndarray, simulated: np.ndarray, points: int = 250) -> dict[str, np.ndarray | float]:
    lo = float(min(actual.min(), simulated.min()))
    hi = float(max(actual.max(), simulated.max()))
    grid = np.linspace(lo, hi, points)
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


def compare_horizon(actual_path: np.ndarray, simulated_paths: np.ndarray, horizon: int) -> dict:
    actual_returns = compute_block_returns(actual_path, horizon)
    simulated_returns = np.stack([compute_block_returns(path, horizon) for path in simulated_paths], axis=0)

    stat_names = ("mean", "std", "q05", "q25", "q50", "q75", "q95", "zero_rate")
    actual_stats = summarize(actual_returns)
    simulated_stats_by_path = {name: np.array([summarize(path)[name] for path in simulated_returns]) for name in stat_names}
    stat_bands = {
        name: {
            **band_summary(values),
            "actual": actual_stats[name],
            "inside_iqr": within_band(actual_stats[name], float(np.quantile(values, 0.25)), float(np.quantile(values, 0.75))),
            "inside_90": within_band(actual_stats[name], float(np.quantile(values, 0.05)), float(np.quantile(values, 0.95))),
        }
        for name, values in simulated_stats_by_path.items()
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

    hist = histogram_bands(actual_returns, simulated_returns, bins=min(28, max(12, int(math.sqrt(len(actual_returns)) * 2))))
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
            "histogram": {key: value.tolist() for key, value in hist.items()},
            "cdf": {key: (value.tolist() if isinstance(value, np.ndarray) else value) for key, value in cdf.items()},
        },
    }


def plot_results(results: list[dict], output: Path, model_label: str) -> None:
    fig, axes = plt.subplots(len(results), 2, figsize=(13.5, 4.2 * len(results)), constrained_layout=True)
    if len(results) == 1:
        axes = np.array([axes])

    for row_axes, result in zip(axes, results):
        hist_ax, cdf_ax = row_axes
        hist = result["plot_data"]["histogram"]
        centers = np.asarray(hist["centers"])
        actual = np.asarray(hist["actual"])
        p05 = np.asarray(hist["p05"])
        p25 = np.asarray(hist["p25"])
        p50 = np.asarray(hist["p50"])
        p75 = np.asarray(hist["p75"])
        p95 = np.asarray(hist["p95"])
        hist_ax.fill_between(centers, p05, p95, color="#c8d8e2", alpha=0.7, label="sim 5%-95%")
        hist_ax.fill_between(centers, p25, p75, color="#8fb1c3", alpha=0.9, label="sim 25%-75%")
        hist_ax.plot(centers, p50, color="#20506d", linewidth=1.8, label="sim median")
        hist_ax.plot(centers, actual, color="#b33a3a", linewidth=1.8, label="actual")
        hist_ax.set_title(f"{result['horizon']}-tick non-overlapping return frequencies")
        hist_ax.set_xlabel("Return")
        hist_ax.set_ylabel("Frequency")
        hist_ax.grid(axis="y", alpha=0.22)
        hist_ax.legend(frameon=False, fontsize=8)

        cdf = result["plot_data"]["cdf"]
        grid = np.asarray(cdf["grid"])
        actual_cdf = np.asarray(cdf["actual"])
        p05 = np.asarray(cdf["p05"])
        p25 = np.asarray(cdf["p25"])
        p50 = np.asarray(cdf["p50"])
        p75 = np.asarray(cdf["p75"])
        p95 = np.asarray(cdf["p95"])
        cdf_ax.fill_between(grid, p05, p95, color="#c8d8e2", alpha=0.7, label="sim 5%-95%")
        cdf_ax.fill_between(grid, p25, p75, color="#8fb1c3", alpha=0.9, label="sim 25%-75%")
        cdf_ax.plot(grid, p50, color="#20506d", linewidth=1.8, label="sim median")
        cdf_ax.plot(grid, actual_cdf, color="#b33a3a", linewidth=1.8, label="actual")
        cdf_ax.set_title(
            f"{result['horizon']}-tick ECDF bands"
            f"\nIQR cover={result['cdf_coverage']['iqr']:.1%}, 90% cover={result['cdf_coverage']['band90']:.1%}"
        )
        cdf_ax.set_xlabel("Return")
        cdf_ax.set_ylabel("CDF")
        cdf_ax.set_ylim(0.0, 1.0)
        cdf_ax.grid(alpha=0.22)
        cdf_ax.legend(frameon=False, fontsize=8)

    fig.suptitle(f"ASH_COATED_OSMIUM posterior predictive check: {model_label}", fontsize=15)
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=180)
    plt.close(fig)


def print_summary(results: list[dict]) -> None:
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Posterior predictive check for ASH_COATED_OSMIUM with the original normal innovation model.")
    parser.add_argument("--log", type=Path, default=PRODUCTS["osmium"].default_log)
    parser.add_argument("--mu", type=float, default=10000.0)
    parser.add_argument("--phi", type=float, default=0.99)
    parser.add_argument("--sigma", type=float, default=0.310738)
    parser.add_argument("--paths", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=20260414)
    parser.add_argument("--horizons", type=int, nargs="+", default=[5, 10, 20])
    parser.add_argument("--plot-output", type=Path, default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_normal_ppc.png")
    parser.add_argument("--json-output", type=Path, default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_normal_ppc.json")
    args = parser.parse_args()

    _, rows = load_rows(args.log, PRODUCTS["osmium"].product)
    actual_path = np.array([row["fv"] for row in rows], dtype=np.float64)
    simulated_paths = simulate_paths(
        start_fv=float(actual_path[0]),
        n_points=len(actual_path),
        n_paths=args.paths,
        mu=args.mu,
        phi=args.phi,
        sigma=args.sigma,
        seed=args.seed,
    )
    results = [compare_horizon(actual_path, simulated_paths, horizon) for horizon in args.horizons]
    payload = {
        "model": {
            "kind": "single_normal",
            "mu": args.mu,
            "phi": args.phi,
            "sigma": args.sigma,
            "quantization": "float32",
        },
        "sample": {
            "points": int(len(actual_path)),
            "transitions": int(len(actual_path) - 1),
            "paths": args.paths,
            "seed": args.seed,
        },
        "results": results,
    }

    print_summary(results)
    plot_results(results, output=args.plot_output, model_label=f"mu={args.mu:.0f}, phi={args.phi:.2f}, sigma={args.sigma:.6f}")
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
