#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd


ROOT = Path("/Users/alexsod/prosperity/imc-prosperity-4")
WORKSPACE = Path("/Users/alexsod/prosperity")
RUST_SIM = ROOT / "rust_simulator" / "target" / "release" / "rust_simulator"
DATA_DIR = ROOT / "data" / "round0"
DEFAULT_OUTPUT_ROOT = ROOT / "tmp" / "accuracy_edge_benchmark"

REFERENCE_STRATEGIES = {
    "baseline": WORKSPACE / "wallmidtest.py",
    "wallmid_sensitive": WORKSPACE / "wallmid_sensitive.py",
    "fallback_sensitive": WORKSPACE / "fallback_sensitive.py",
}

CANDIDATE_STRATEGY = WORKSPACE / "bot2_edge_lab.py"
CANDIDATES = [
    "balanced_mu",
    "signal_linear",
    "signal_narrow_only",
    "mean_edge_split",
    "worst_edge_split",
    "common_edge_scale",
    "width_confidence_scale",
    "weak_side_haircut",
    "phase_halfband",
    "spread13_specialist",
    "bot3_contamination_filter",
    "inventory_shadow_mean",
    "inventory_agree_only",
    "inventory_crossfade",
    "flow_capped_weak_side",
    "flow_capped_both",
    "discrete_conviction_buckets",
    "wallmid_gap_guard",
    "consensus_vwap_tilt",
    "hybrid_regime_patch",
]

SCREEN_SEED = 20260406
SCREEN_SESSIONS = 250
FULL_SEEDS = [20260406, 20260407, 20260408, 20260409, 20260410, 20260411]
FULL_SESSIONS = 1000
SURVIVOR_COUNT = 6


def run_simulation(
    name: str,
    strategy_path: Path,
    output_dir: Path,
    seed: int,
    sessions: int,
    extra_env: dict[str, str] | None,
    rerun: bool,
) -> pd.DataFrame:
    summary_path = output_dir / "session_summary.csv"
    if summary_path.exists() and not rerun:
        print(f"[skip] {name} seed={seed} sessions={sessions}")
        return pd.read_csv(summary_path)

    output_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    cmd = [
        str(RUST_SIM),
        "--strategy",
        str(strategy_path),
        "--sessions",
        str(sessions),
        "--output",
        str(output_dir),
        "--fv-mode",
        "simulate",
        "--trade-mode",
        "simulate",
        "--tomato-support",
        "quarter",
        "--seed",
        str(seed),
        "--actual-dir",
        str(DATA_DIR),
        "--write-session-limit",
        "0",
    ]
    print(f"[run] {name} seed={seed} sessions={sessions}")
    subprocess.run(cmd, cwd=ROOT / "rust_simulator", env=env, check=True)
    return pd.read_csv(summary_path)


def summarize_frame(name: str, seed: int, sessions: int, frame: pd.DataFrame) -> dict[str, object]:
    return {
        "name": name,
        "seed": seed,
        "sessions": sessions,
        "mean_total_pnl": frame["total_pnl"].mean(),
        "median_total_pnl": frame["total_pnl"].median(),
        "std_total_pnl": frame["total_pnl"].std(ddof=1),
        "mean_tomato_pnl": frame["tomato_pnl"].mean(),
        "mean_emerald_pnl": frame["emerald_pnl"].mean(),
    }


def run_task(task: dict[str, object], rerun: bool) -> dict[str, object]:
    frame = run_simulation(
        task["name"],
        task["strategy_path"],
        task["output_dir"],
        task["seed"],
        task["sessions"],
        task.get("extra_env"),
        rerun,
    )
    return summarize_frame(task["name"], task["seed"], task["sessions"], frame)


def run_tasks(tasks: list[dict[str, object]], jobs: int, rerun: bool) -> list[dict[str, object]]:
    if jobs <= 1:
        return [run_task(task, rerun) for task in tasks]

    rows: list[dict[str, object]] = []
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = {executor.submit(run_task, task, rerun): task for task in tasks}
        for future in as_completed(futures):
            rows.append(future.result())
    return rows


def run_screen(output_root: Path, rerun: bool, jobs: int) -> list[str]:
    rows: list[dict[str, object]] = []
    screen_dir = output_root / "screen"
    tasks: list[dict[str, object]] = []

    for name, strategy_path in REFERENCE_STRATEGIES.items():
        tasks.append(
            {
                "name": name,
                "strategy_path": strategy_path,
                "output_dir": screen_dir / f"{name}_seed_{SCREEN_SEED}",
                "seed": SCREEN_SEED,
                "sessions": SCREEN_SESSIONS,
                "extra_env": None,
            }
        )

    for candidate in CANDIDATES:
        tasks.append(
            {
                "name": candidate,
                "strategy_path": CANDIDATE_STRATEGY,
                "output_dir": screen_dir / f"{candidate}_seed_{SCREEN_SEED}",
                "seed": SCREEN_SEED,
                "sessions": SCREEN_SESSIONS,
                "extra_env": {"EDGE_LAB_CANDIDATE": candidate},
            }
        )

    rows.extend(run_tasks(tasks, jobs, rerun))

    summary = pd.DataFrame(rows).sort_values("mean_total_pnl", ascending=False).reset_index(drop=True)
    screen_path = output_root / "screen_rankings.csv"
    screen_path.parent.mkdir(parents=True, exist_ok=True)
    summary.to_csv(screen_path, index=False)

    candidate_summary = summary[summary["name"].isin(CANDIDATES)].reset_index(drop=True)
    survivors = candidate_summary.head(SURVIVOR_COUNT)["name"].tolist()
    if "balanced_mu" not in survivors:
        survivors.append("balanced_mu")

    with open(output_root / "screen_survivors.txt", "w", newline="") as f:
        for candidate in survivors:
            f.write(candidate + "\n")

    print("\n[screen] top candidates")
    print(candidate_summary.head(SURVIVOR_COUNT + 2)[["name", "mean_total_pnl", "mean_tomato_pnl"]].to_string(index=False))
    print(f"[screen] survivors: {', '.join(survivors)}")
    return survivors


def run_full(output_root: Path, survivors: list[str], rerun: bool, jobs: int) -> None:
    full_dir = output_root / "full"
    tasks: list[dict[str, object]] = []

    for seed in FULL_SEEDS:
        for name, strategy_path in REFERENCE_STRATEGIES.items():
            tasks.append(
                {
                    "name": name,
                    "strategy_path": strategy_path,
                    "output_dir": full_dir / f"{name}_seed_{seed}",
                    "seed": seed,
                    "sessions": FULL_SESSIONS,
                    "extra_env": None,
                }
            )

        for candidate in survivors:
            tasks.append(
                {
                    "name": candidate,
                    "strategy_path": CANDIDATE_STRATEGY,
                    "output_dir": full_dir / f"{candidate}_seed_{seed}",
                    "seed": seed,
                    "sessions": FULL_SESSIONS,
                    "extra_env": {"EDGE_LAB_CANDIDATE": candidate},
                }
            )

    rows = run_tasks(tasks, jobs, rerun)

    seed_summary = pd.DataFrame(rows)
    seed_summary.to_csv(output_root / "full_seed_strategy_summary.csv", index=False)

    overall = (
        seed_summary.groupby("name", as_index=False)
        .agg(
            seeds=("seed", "nunique"),
            mean_total_pnl=("mean_total_pnl", "mean"),
            mean_tomato_pnl=("mean_tomato_pnl", "mean"),
            mean_std_total_pnl=("std_total_pnl", "mean"),
            worst_seed_total_pnl=("mean_total_pnl", "min"),
            best_seed_total_pnl=("mean_total_pnl", "max"),
        )
        .sort_values("mean_total_pnl", ascending=False)
        .reset_index(drop=True)
    )
    overall.to_csv(output_root / "full_overall_rankings.csv", index=False)

    pairwise_rows: list[dict[str, object]] = []
    pivot = seed_summary.pivot(index="seed", columns="name", values="mean_total_pnl")
    for candidate in survivors:
        for reference in ["baseline", "wallmid_sensitive", "fallback_sensitive"]:
            diff = pivot[candidate] - pivot[reference]
            pairwise_rows.append(
                {
                    "candidate": candidate,
                    "reference": reference,
                    "mean_delta": diff.mean(),
                    "median_delta": diff.median(),
                    "wins": int((diff > 0).sum()),
                    "losses": int((diff < 0).sum()),
                    "ties": int((diff == 0).sum()),
                }
            )
    pairwise = pd.DataFrame(pairwise_rows).sort_values(["reference", "mean_delta"], ascending=[True, False])
    pairwise.to_csv(output_root / "full_pairwise_vs_references.csv", index=False)

    print("\n[full] overall rankings")
    print(overall.to_string(index=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["screen", "full", "all"], default="all")
    parser.add_argument("--rerun", action="store_true")
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--survivor-file", type=Path)
    args = parser.parse_args()

    output_root = args.output_root
    output_root.mkdir(parents=True, exist_ok=True)

    survivors: list[str] = []
    if args.phase in {"screen", "all"}:
        survivors = run_screen(output_root, args.rerun, args.jobs)

    if args.phase in {"full", "all"}:
        if not survivors:
            survivor_file = args.survivor_file or (output_root / "screen_survivors.txt")
            if survivor_file.exists():
                survivors = [line.strip() for line in survivor_file.read_text().splitlines() if line.strip()]
            else:
                raise SystemExit("screen survivors not found; run --phase screen or --phase all first")
        run_full(output_root, survivors, args.rerun, args.jobs)


if __name__ == "__main__":
    main()
