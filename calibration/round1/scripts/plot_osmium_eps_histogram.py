from __future__ import annotations

import argparse
import math
import os
import statistics
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent.parent / ".mplconfig"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from analyze_round1_products import PRODUCTS, load_rows


@dataclass(frozen=True)
class NormalFit:
    mean: float
    std: float
    log_likelihood: float
    aic: float
    bic: float


@dataclass(frozen=True)
class MixtureFit:
    weights: tuple[float, float]
    means: tuple[float, float]
    stds: tuple[float, float]
    soft_counts: tuple[float, float]
    log_likelihood: float
    aic: float
    bic: float


def compute_eps(rows: list[dict], mu: float, phi: float) -> list[float]:
    fvs = [row["fv"] for row in rows]
    return [next_fv - (mu + phi * (fv - mu)) for fv, next_fv in zip(fvs[:-1], fvs[1:])]


def normal_pdf(x: np.ndarray, mean: float, std: float) -> np.ndarray:
    return np.exp(-0.5 * ((x - mean) / std) ** 2) / (math.sqrt(2.0 * math.pi) * std)


def fit_single_normal(values: list[float]) -> NormalFit:
    mean = statistics.mean(values)
    std = statistics.pstdev(values)
    n = len(values)
    log_likelihood = -0.5 * n * (math.log(2.0 * math.pi * std * std) + 1.0)
    return NormalFit(
        mean=mean,
        std=std,
        log_likelihood=log_likelihood,
        aic=2 * 2 - 2 * log_likelihood,
        bic=2 * math.log(n) - 2 * log_likelihood,
    )


def fit_two_normal_mixture(values: list[float], max_iter: int = 1000, tol: float = 1e-10) -> MixtureFit:
    x = np.asarray(values, dtype=float)
    n = len(x)
    overall_std = float(x.std())
    min_std = 1e-3
    min_weight = 1e-6

    starts: list[tuple[float, float, float, float, float]] = []
    quantiles = np.quantile(x, [0.10, 0.25, 0.40, 0.60, 0.75, 0.90])
    for mean1 in quantiles:
        for mean2 in quantiles:
            if mean1 >= mean2:
                continue
            starts.append((0.5, float(mean1), float(mean2), max(overall_std / 2.0, min_std), max(overall_std / 2.0, min_std)))

    rng = np.random.default_rng(0)
    for _ in range(128):
        starts.append(
            (
                float(rng.uniform(0.10, 0.90)),
                float(rng.choice(x)),
                float(rng.choice(x)),
                float(rng.uniform(min_std, overall_std)),
                float(rng.uniform(min_std, overall_std)),
            )
        )

    best: tuple[float, float, float, float, float, np.ndarray] | None = None
    for weight1, mean1, mean2, std1, std2 in starts:
        previous_log_likelihood: float | None = None
        for _ in range(max_iter):
            comp1 = weight1 * normal_pdf(x, mean1, std1)
            comp2 = (1.0 - weight1) * normal_pdf(x, mean2, std2)
            total = np.maximum(comp1 + comp2, 1e-300)
            responsibilities = comp1 / total

            count1 = float(responsibilities.sum())
            count2 = float(n - count1)
            if count1 <= 0.0 or count2 <= 0.0:
                break

            weight1 = min(max(count1 / n, min_weight), 1.0 - min_weight)
            mean1 = float((responsibilities * x).sum() / count1)
            mean2 = float((((1.0 - responsibilities) * x).sum()) / count2)
            std1 = math.sqrt(max(float((responsibilities * (x - mean1) ** 2).sum() / count1), min_std**2))
            std2 = math.sqrt(max(float((((1.0 - responsibilities) * (x - mean2) ** 2).sum()) / count2), min_std**2))

            log_likelihood = float(np.log(np.maximum(weight1 * normal_pdf(x, mean1, std1) + (1.0 - weight1) * normal_pdf(x, mean2, std2), 1e-300)).sum())
            if previous_log_likelihood is not None and abs(log_likelihood - previous_log_likelihood) < tol:
                break
            previous_log_likelihood = log_likelihood

        candidate = (log_likelihood, weight1, mean1, std1, mean2, std2, responsibilities)
        if best is None or candidate[0] > best[0]:
            best = candidate

    assert best is not None
    log_likelihood, weight1, mean1, std1, mean2, std2, responsibilities = best
    weight2 = 1.0 - weight1
    count1 = float(responsibilities.sum())
    count2 = float(n - count1)

    if mean1 > mean2:
        weight1, weight2 = weight2, weight1
        mean1, mean2 = mean2, mean1
        std1, std2 = std2, std1
        count1, count2 = count2, count1

    return MixtureFit(
        weights=(weight1, weight2),
        means=(mean1, mean2),
        stds=(std1, std2),
        soft_counts=(count1, count2),
        log_likelihood=log_likelihood,
        aic=2 * 5 - 2 * log_likelihood,
        bic=5 * math.log(n) - 2 * log_likelihood,
    )


def summarize(values: list[float]) -> dict[str, float]:
    mean = statistics.mean(values)
    std = statistics.pstdev(values)
    centered = [value - mean for value in values]
    if std == 0.0:
        skew = 0.0
        excess_kurtosis = -3.0
    else:
        skew = sum(value**3 for value in centered) / (len(values) * std**3)
        excess_kurtosis = sum(value**4 for value in centered) / (len(values) * std**4) - 3.0
    return {
        "mean": mean,
        "std": std,
        "min": min(values),
        "max": max(values),
        "skew": skew,
        "excess_kurtosis": excess_kurtosis,
    }


def quantile(sorted_values: list[float], q: float) -> float:
    index = int(q * (len(sorted_values) - 1))
    return sorted_values[index]


def print_summary(eps: list[float]) -> None:
    stats = summarize(eps)
    ordered = sorted(eps)
    print(f"count={len(eps)}")
    print(f"mean={stats['mean']:.9f}")
    print(f"std={stats['std']:.9f}")
    print(f"min={stats['min']:.9f}")
    print(f"max={stats['max']:.9f}")
    print(f"skew={stats['skew']:.6f}")
    print(f"excess_kurtosis={stats['excess_kurtosis']:.6f}")
    for q in (0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99):
        print(f"q{int(q * 100):02d}={quantile(ordered, q):.9f}")


def print_fit_summary(normal_fit: NormalFit, mixture_fit: MixtureFit) -> None:
    print(
        "single_normal"
        f" mean={normal_fit.mean:.9f}"
        f" std={normal_fit.std:.9f}"
        f" loglik={normal_fit.log_likelihood:.9f}"
        f" aic={normal_fit.aic:.6f}"
        f" bic={normal_fit.bic:.6f}"
    )
    print(
        "mixture2"
        f" w1={mixture_fit.weights[0]:.9f}"
        f" mean1={mixture_fit.means[0]:.9f}"
        f" std1={mixture_fit.stds[0]:.9f}"
        f" w2={mixture_fit.weights[1]:.9f}"
        f" mean2={mixture_fit.means[1]:.9f}"
        f" std2={mixture_fit.stds[1]:.9f}"
        f" loglik={mixture_fit.log_likelihood:.9f}"
        f" aic={mixture_fit.aic:.6f}"
        f" bic={mixture_fit.bic:.6f}"
        f" delta_aic={mixture_fit.aic - normal_fit.aic:.6f}"
        f" delta_bic={mixture_fit.bic - normal_fit.bic:.6f}"
        f" soft_n1={mixture_fit.soft_counts[0]:.3f}"
        f" soft_n2={mixture_fit.soft_counts[1]:.3f}"
    )


def plot_histogram(eps: list[float], output: Path, mu: float, phi: float, normal_fit: NormalFit, mixture_fit: MixtureFit) -> None:
    stats = summarize(eps)
    fig, ax = plt.subplots(figsize=(9, 5.5), constrained_layout=True)
    _, bins, _ = ax.hist(
        eps,
        bins="fd",
        color="#5b7c8d",
        edgecolor="#173042",
        linewidth=0.9,
    )
    bin_width = bins[1] - bins[0]
    grid = np.linspace(min(eps), max(eps), 800)
    scale = len(eps) * bin_width

    ax.axvline(stats["mean"], color="#b33a3a", linewidth=2, label=f"mean = {stats['mean']:.4f}")
    ax.axvline(stats["mean"] - stats["std"], color="#7a8b99", linewidth=1.25, linestyle="--")
    ax.axvline(stats["mean"] + stats["std"], color="#7a8b99", linewidth=1.25, linestyle="--", label=f"std = {stats['std']:.4f}")
    ax.plot(grid, scale * normal_pdf(grid, normal_fit.mean, normal_fit.std), color="#b33a3a", linewidth=2.0, label="single normal")
    mixture_curve = mixture_fit.weights[0] * normal_pdf(grid, mixture_fit.means[0], mixture_fit.stds[0]) + mixture_fit.weights[1] * normal_pdf(grid, mixture_fit.means[1], mixture_fit.stds[1])
    ax.plot(grid, scale * mixture_curve, color="#1d5f8c", linewidth=2.2, label="2-normal mixture")
    ax.plot(
        grid,
        scale * mixture_fit.weights[0] * normal_pdf(grid, mixture_fit.means[0], mixture_fit.stds[0]),
        color="#1d5f8c",
        linewidth=1.2,
        linestyle=":",
        label=f"component 1 ({mixture_fit.weights[0]:.1%})",
    )
    ax.plot(
        grid,
        scale * mixture_fit.weights[1] * normal_pdf(grid, mixture_fit.means[1], mixture_fit.stds[1]),
        color="#0f2f46",
        linewidth=1.2,
        linestyle=":",
        label=f"component 2 ({mixture_fit.weights[1]:.1%})",
    )

    ax.set_title("ASH_COATED_OSMIUM empirical innovation histogram")
    ax.set_xlabel(f"eps_t under fv_(t+1) = {mu:.0f} + {phi:.2f} * (fv_t - {mu:.0f}) + eps_t")
    ax.set_ylabel("Count")
    ax.grid(axis="y", alpha=0.22)
    ax.legend(frameon=False)

    stats_text = "\n".join(
        (
            f"n = {len(eps)}",
            f"min = {stats['min']:.3f}",
            f"max = {stats['max']:.3f}",
            f"skew = {stats['skew']:.3f}",
            f"ex. kurtosis = {stats['excess_kurtosis']:.3f}",
            f"dAIC (mix - normal) = {mixture_fit.aic - normal_fit.aic:.2f}",
            f"dBIC (mix - normal) = {mixture_fit.bic - normal_fit.bic:.2f}",
            f"bins = {len(bins) - 1}",
        )
    )
    ax.text(
        0.985,
        0.97,
        stats_text,
        transform=ax.transAxes,
        ha="right",
        va="top",
        fontsize=9,
        bbox={"facecolor": "white", "alpha": 0.88, "edgecolor": "#cbd5dc"},
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=180)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot the empirical epsilon histogram for ASH_COATED_OSMIUM.")
    parser.add_argument("--log", type=Path, default=PRODUCTS["osmium"].default_log)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent.parent / "artifacts" / "ash_coated_osmium_eps_histogram.png")
    parser.add_argument("--mu", type=float, default=10000.0)
    parser.add_argument("--phi", type=float, default=0.99)
    args = parser.parse_args()

    _, rows = load_rows(args.log, PRODUCTS["osmium"].product)
    eps = compute_eps(rows, mu=args.mu, phi=args.phi)
    normal_fit = fit_single_normal(eps)
    mixture_fit = fit_two_normal_mixture(eps)
    print_summary(eps)
    print_fit_summary(normal_fit, mixture_fit)
    plot_histogram(eps, output=args.output, mu=args.mu, phi=args.phi, normal_fit=normal_fit, mixture_fit=mixture_fit)


if __name__ == "__main__":
    main()
