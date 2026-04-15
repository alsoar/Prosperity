from __future__ import annotations

import argparse
import csv
import json
import math
import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent.parent / ".mplconfig"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.optimize import minimize_scalar

from analyze_round1_products import PRODUCTS, load_rows
from check_osmium_observable_space import extract_observable_proxy, load_full_osmium_prices


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[4]


def build_observation_series(data_root: Path) -> dict[int, dict[str, np.ndarray]]:
    frames = load_full_osmium_prices(data_root)
    series: dict[int, dict[str, np.ndarray]] = {}
    for day, frame in frames.items():
        proxy = extract_observable_proxy(frame)
        observation = proxy["midpoint"].copy()
        variance = np.full(len(observation), np.inf, dtype=np.float64)
        valid = proxy["valid"]
        variance[valid] = (proxy["width"][valid] ** 2) / 12.0
        series[day] = {
            "observation": observation,
            "variance": variance,
            "valid": valid,
            "strong": proxy["strong"],
            "width": proxy["width"],
            "timestamp": proxy["timestamps"].astype(np.int32),
        }
    return series


def kalman_log_likelihood(series: dict[int, dict[str, np.ndarray]], mu: float, phi: float, sigma: float) -> float:
    q = sigma * sigma
    if q <= 0.0:
        return float("-inf")

    stationary_var = q / max(1.0 - phi * phi, 1e-12)
    log_likelihood = 0.0
    for day in sorted(series):
        observation = series[day]["observation"]
        variance = series[day]["variance"]
        mean = mu
        cov = stationary_var
        for observed, obs_var in zip(observation, variance):
            if np.isfinite(obs_var):
                innovation = observed - mean
                innovation_var = cov + obs_var
                log_likelihood += -0.5 * (
                    math.log(2.0 * math.pi * innovation_var) + (innovation * innovation) / innovation_var
                )
                gain = cov / innovation_var
                mean = mean + gain * innovation
                cov = (1.0 - gain) * cov
            mean = mu + phi * (mean - mu)
            cov = phi * phi * cov + q
    return log_likelihood


def fit_sigma(series: dict[int, dict[str, np.ndarray]], mu: float, phi: float, sigma_lo: float, sigma_hi: float) -> dict[str, float]:
    result = minimize_scalar(
        lambda log_sigma: -kalman_log_likelihood(series, mu=mu, phi=phi, sigma=math.exp(log_sigma)),
        bounds=(math.log(sigma_lo), math.log(sigma_hi)),
        method="bounded",
        options={"xatol": 1e-6},
    )
    sigma = math.exp(result.x)
    return {
        "sigma": sigma,
        "log_likelihood": -result.fun,
        "success": result.success,
        "iterations": result.nit,
    }


def kalman_smoother(observation: np.ndarray, variance: np.ndarray, mu: float, phi: float, sigma: float) -> dict[str, np.ndarray]:
    q = sigma * sigma
    n = len(observation)
    stationary_var = q / max(1.0 - phi * phi, 1e-12)

    pred_mean = np.zeros(n, dtype=np.float64)
    pred_cov = np.zeros(n, dtype=np.float64)
    filt_mean = np.zeros(n, dtype=np.float64)
    filt_cov = np.zeros(n, dtype=np.float64)

    mean = mu
    cov = stationary_var
    for idx, (observed, obs_var) in enumerate(zip(observation, variance)):
        pred_mean[idx] = mean
        pred_cov[idx] = cov
        if np.isfinite(obs_var):
            innovation = observed - mean
            innovation_var = cov + obs_var
            gain = cov / innovation_var
            filt_mean[idx] = mean + gain * innovation
            filt_cov[idx] = (1.0 - gain) * cov
        else:
            filt_mean[idx] = mean
            filt_cov[idx] = cov
        mean = mu + phi * (filt_mean[idx] - mu)
        cov = phi * phi * filt_cov[idx] + q

    smooth_mean = filt_mean.copy()
    smooth_cov = filt_cov.copy()
    for idx in range(n - 2, -1, -1):
        gain = filt_cov[idx] * phi / pred_cov[idx + 1]
        smooth_mean[idx] = filt_mean[idx] + gain * (smooth_mean[idx + 1] - pred_mean[idx + 1])
        smooth_cov[idx] = filt_cov[idx] + gain * gain * (smooth_cov[idx + 1] - pred_cov[idx + 1])

    return {
        "pred_mean": pred_mean,
        "pred_cov": pred_cov,
        "filt_mean": filt_mean,
        "filt_cov": filt_cov,
        "smooth_mean": smooth_mean,
        "smooth_cov": smooth_cov,
    }


def summarize_smoothed_residuals(smoothed_paths: dict[int, np.ndarray], mu: float, phi: float) -> dict[str, float]:
    residuals = []
    for day in sorted(smoothed_paths):
        path = smoothed_paths[day]
        residuals.append(path[1:] - (mu + phi * (path[:-1] - mu)))
    merged = np.concatenate(residuals)
    return {
        "count": float(len(merged)),
        "mean": float(np.mean(merged)),
        "std": float(np.std(merged)),
        "q05": float(np.quantile(merged, 0.05)),
        "q50": float(np.quantile(merged, 0.50)),
        "q95": float(np.quantile(merged, 0.95)),
    }


def collect_smoothed_residual_rows(
    series: dict[int, dict[str, np.ndarray]],
    smoothed_paths: dict[int, np.ndarray],
    mu: float,
    phi: float,
) -> list[dict[str, float | int]]:
    rows: list[dict[str, float | int]] = []
    for day in sorted(smoothed_paths):
        path = smoothed_paths[day]
        timestamps = series[day]["timestamp"]
        residuals = path[1:] - (mu + phi * (path[:-1] - mu))
        for tick_index, residual in enumerate(residuals, start=1):
            rows.append(
                {
                    "day": int(day),
                    "tick_index": int(tick_index),
                    "timestamp": int(timestamps[tick_index]),
                    "eps_hat": float(residual),
                }
            )
    return rows


def compare_to_hold_one(day_zero_path: np.ndarray, log_path: Path) -> dict[str, float]:
    _, rows = load_rows(log_path, PRODUCTS["osmium"].product)
    true_path = np.array([row["fv"] for row in rows], dtype=np.float64)
    estimate = day_zero_path[1 : 1 + len(true_path)]
    errors = estimate - true_path
    return {
        "count": float(len(errors)),
        "rmse": float(np.sqrt(np.mean(errors * errors))),
        "mae": float(np.mean(np.abs(errors))),
        "mean_error": float(np.mean(errors)),
    }


def sigma_profile(series: dict[int, dict[str, np.ndarray]], mu: float, phi: float, sigma_grid: np.ndarray) -> np.ndarray:
    return np.array([kalman_log_likelihood(series, mu=mu, phi=phi, sigma=float(sigma)) for sigma in sigma_grid], dtype=np.float64)


def plot_fit(
    sigma_grid: np.ndarray,
    profile: np.ndarray,
    sigma_mle: float,
    old_sigma: float,
    hold_one_true: np.ndarray,
    hold_one_estimate: np.ndarray,
    output: Path,
) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8), constrained_layout=True)
    profile_ax, overlap_ax = axes

    profile_ax.plot(sigma_grid, profile, color="#1d5f8c", linewidth=2.0)
    profile_ax.axvline(sigma_mle, color="#b33a3a", linewidth=2.0, label=f"all-data MLE = {sigma_mle:.4f}")
    profile_ax.axvline(old_sigma, color="#7a8b99", linewidth=1.5, linestyle="--", label=f"hold-one sigma = {old_sigma:.4f}")
    profile_ax.set_title("Visible-data likelihood profile for sigma")
    profile_ax.set_xlabel("sigma")
    profile_ax.set_ylabel("Kalman log-likelihood")
    profile_ax.grid(alpha=0.22)
    profile_ax.legend(frameon=False)

    x = np.arange(len(hold_one_true), dtype=np.int32)
    overlap_ax.plot(x, hold_one_true, color="#173042", linewidth=1.5, label="hold-one hidden FV")
    overlap_ax.plot(x, hold_one_estimate, color="#b33a3a", linewidth=1.35, alpha=0.9, label="all-data smoothed estimate")
    overlap_ax.set_title("Day 0 overlap with hold-one hidden path")
    overlap_ax.set_xlabel("Post-fill tick index")
    overlap_ax.set_ylabel("FV")
    overlap_ax.grid(alpha=0.22)
    overlap_ax.legend(frameon=False)

    fig.suptitle("ASH_COATED_OSMIUM all-data visible-book innovation fit", fontsize=15)
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=180)
    plt.close(fig)


def plot_residual_histogram(residuals: np.ndarray, sigma: float, output: Path) -> None:
    x_lo = min(float(np.min(residuals)), -4.0 * sigma)
    x_hi = max(float(np.max(residuals)), 4.0 * sigma)
    x_grid = np.linspace(x_lo, x_hi, 500)
    normal_pdf = np.exp(-0.5 * (x_grid / sigma) ** 2) / (sigma * math.sqrt(2.0 * math.pi))

    fig, ax = plt.subplots(figsize=(8.0, 4.8), constrained_layout=True)
    ax.hist(
        residuals,
        bins=60,
        density=True,
        color="#9bbdd1",
        edgecolor="#486272",
        linewidth=0.6,
        alpha=0.85,
        label="smoothed inferred eps",
    )
    ax.plot(x_grid, normal_pdf, color="#b33a3a", linewidth=2.0, label=f"Normal(0, {sigma:.4f}^2)")
    ax.axvline(0.0, color="#7a8b99", linestyle="--", linewidth=1.0)
    ax.set_title("All-data inferred innovation sample vs fitted normal")
    ax.set_xlabel("eps")
    ax.set_ylabel("density")
    ax.grid(alpha=0.22)
    ax.legend(frameon=False)

    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=180)
    plt.close(fig)


def write_residual_csv(rows: list[dict[str, float | int]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["day", "tick_index", "timestamp", "eps_hat"])
        writer.writeheader()
        writer.writerows(rows)


def print_summary(dataset_summary: dict[str, float], fit_summary: dict[str, float], residual_summary: dict[str, float], hold_one_summary: dict[str, float]) -> None:
    for key, value in dataset_summary.items():
        print(f"{key}={value}")
    print()
    for key, value in fit_summary.items():
        print(f"fit_{key}={value}")
    print()
    for key, value in residual_summary.items():
        print(f"smoothed_residual_{key}={value}")
    print()
    for key, value in hold_one_summary.items():
        print(f"hold_one_{key}={value}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit ASH_COATED_OSMIUM latent innovation scale from all visible round-1 data.")
    parser.add_argument(
        "--data-root",
        type=Path,
        default=workspace_root() / "prosperity-analysis" / "hidden_trader_detector" / "data" / "imc_round1" / "round1",
    )
    parser.add_argument("--mu", type=float, default=10000.0)
    parser.add_argument("--phi", type=float, default=0.99)
    parser.add_argument("--sigma-lo", type=float, default=0.05)
    parser.add_argument("--sigma-hi", type=float, default=1.0)
    parser.add_argument("--hold-one-log", type=Path, default=PRODUCTS["osmium"].default_log)
    parser.add_argument(
        "--plot-output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_visible_innovation_fit.png",
    )
    parser.add_argument(
        "--residual-plot-output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_visible_innovation_residuals.png",
    )
    parser.add_argument(
        "--residual-csv-output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_visible_innovation_residuals.csv",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_visible_innovation_fit.json",
    )
    args = parser.parse_args()

    series = build_observation_series(args.data_root)
    dataset_summary = {
        "days": float(len(series)),
        "ticks_total": float(sum(len(day["observation"]) for day in series.values())),
        "observable_valid_ticks": float(sum(np.sum(day["valid"]) for day in series.values())),
        "observable_strong_ticks": float(sum(np.sum(day["strong"]) for day in series.values())),
        "observable_strong_rate": float(sum(np.sum(day["strong"]) for day in series.values()) / sum(len(day["observation"]) for day in series.values())),
    }

    fit_summary = fit_sigma(series, mu=args.mu, phi=args.phi, sigma_lo=args.sigma_lo, sigma_hi=args.sigma_hi)
    smoothed = {
        day: kalman_smoother(
            day_data["observation"],
            day_data["variance"],
            mu=args.mu,
            phi=args.phi,
            sigma=fit_summary["sigma"],
        )["smooth_mean"]
        for day, day_data in series.items()
    }
    residual_summary = summarize_smoothed_residuals(smoothed, mu=args.mu, phi=args.phi)
    hold_one_summary = compare_to_hold_one(smoothed[0], args.hold_one_log)
    _, hold_one_rows = load_rows(args.hold_one_log, PRODUCTS["osmium"].product)
    hold_one_true = np.array([row["fv"] for row in hold_one_rows], dtype=np.float64)
    hold_one_estimate = smoothed[0][1 : 1 + len(hold_one_true)]

    sigma_grid = np.linspace(max(args.sigma_lo, 0.20), min(args.sigma_hi, 0.45), 220)
    profile = sigma_profile(series, mu=args.mu, phi=args.phi, sigma_grid=sigma_grid)
    residual_rows = collect_smoothed_residual_rows(series, smoothed, mu=args.mu, phi=args.phi)
    residual_values = np.array([row["eps_hat"] for row in residual_rows], dtype=np.float64)

    payload = {
        "dataset": dataset_summary,
        "model": {
            "mu": args.mu,
            "phi": args.phi,
            "sigma_mle": fit_summary["sigma"],
            "observation_model": "visible-book interval midpoint with variance width^2 / 12",
        },
        "fit": fit_summary,
        "smoothed_residual_summary": residual_summary,
        "hold_one_alignment": hold_one_summary,
    }

    print_summary(dataset_summary, fit_summary, residual_summary, hold_one_summary)
    plot_fit(
        sigma_grid=sigma_grid,
        profile=profile,
        sigma_mle=fit_summary["sigma"],
        old_sigma=0.310738,
        hold_one_true=hold_one_true,
        hold_one_estimate=hold_one_estimate,
        output=args.plot_output,
    )
    plot_residual_histogram(
        residuals=residual_values,
        sigma=fit_summary["sigma"],
        output=args.residual_plot_output,
    )
    write_residual_csv(residual_rows, args.residual_csv_output)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
