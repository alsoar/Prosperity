# Fallback Statistic Session Summary

This document summarizes the work from the point where the adaptive fallback statistic was developed through the later Monte Carlo and strategy-sweep work.

## Executive Summary

- The fallback statistic was discovered by diagnosing rare but sharp VWAP errors in inferred-true-price TOMATOES data. Those spikes were caused by one-sided level-3 visibility.
- On the inferred-truth TOMATOES sample, fallback was the best simple estimator we tested. On KELP, it was not. So it is a regime-dependent fix, not a universal winner.
- In the tutorial Monte Carlo simulator, plain fallback did not change behavior versus wallmid. The profitable variant was `fallback_sensitive`, which used a small passive-size tilt derived from `vwap - wallmid`.
- A much more accurate latent fair-value estimator, `bot2_quarter_center`, did not beat `fallback_sensitive` once we tried to monetize it.
- A later 20-candidate strategy sweep confirmed that `fallback_sensitive` remained the best performer in this simulator.

## 1. Why The Fallback Statistic Was Created

### The original issue

The TOMATOES inferred-truth analysis showed that many estimators shared `max_abs_deviation = 7.0`. That turned out to be an initialization artifact from the first row of the dataset, not a meaningful model distinction.

After excluding the first 100 rows, the rankings became more meaningful and the focus shifted to the VWAP spikes.

### What caused the VWAP spikes

On the trimmed TOMATOES sample:

- There were `26` VWAP spike rows with `|vwap_mid_top3 - true| > 1`.
- All `26` spikes lasted exactly `1` tick.
- In `100%` of spike rows, exactly one side had level-3 visibility and the other side did not.
- Positive spikes always had bid-side L3 only.
- Negative spikes always had ask-side L3 only.
- The top-3 book span itself did not widen materially on spike rows.

The conclusion was that VWAP itself was not failing in normal conditions. It was being distorted by asymmetric visible support.

### The fallback definition

The adaptive fallback statistic was defined as:

```text
fallback =
    wallmid_3      if exactly one side has level-3 visible
    vwap_mid_top3  otherwise
```

Interpretation:

- Use VWAP in the normal, symmetric-support regime.
- Snap back to wallmid only when one-sided L3 visibility contaminates the VWAP estimate.

### Inferred-truth TOMATOES performance

On the TOMATOES `exclude-first-100` inferred-truth sample, fallback beat all previously tested estimators:

| Estimator | MAE | RMSE | Huber(1) | Max Abs |
| --- | ---: | ---: | ---: | ---: |
| `fallback` | `0.1761` | `0.2020` | `0.0204` | `0.4771` |
| best previous blend (`blend_wallmid3_vwapmid3`) | `0.2162` | `0.2547` | `0.0324` | `1.0801` |
| best previous simple (`vwap_mid_top3` on MAE) | `0.2027` | `0.2691` | `0.0356` | `1.7217` |
| `wallmid_3` | `0.2409` | `0.2812` | `0.0395` | `0.4932` |

This was a strong in-sample win on the inferred hidden-price reconstruction.

## 2. KELP: Why The Same Idea Did Not Transfer

I parsed an official KELP round-1 submission log and inferred the internal mark price from backtest bookkeeping:

```text
true_price_t = (pnl_t - cash_t) / position_t
```

This was not an official hidden truth feed. It was reconstructed from position, cash, and mark-to-market PnL.

### What happened

- KELP had visible one-tick spikes in the inferred series, but those were traced to same-timestamp fill alignment issues.
- On spike rows, large fills changed cash and position sharply while PnL barely moved on the same row.
- That made the inferred truth jump mechanically even though the visible-book estimators were stable.

### Clean-stretch analysis

To remove reconstruction artifacts, I isolated conservative clean rows:

- no fill on current tick
- no fill on previous tick
- no fill on next tick
- no large inferred-true jump

On that clean KELP subset, rankings were clear:

1. `wallmid`
2. `blend`
3. `vwap`
4. `fallback`

So the fallback rule was not universal. It helped TOMATOES because the relevant failure mode was one-sided visible depth contamination. On clean KELP, that was not the main issue.

## 3. Monte Carlo: Plain Fallback Did Not Matter

The next step was to test the strategy effect directly in the tutorial Monte Carlo simulator.

Files compared:

- `wallmidtest.py`
- `Fallbacktest.py`

### Result

On the same seed:

- `300` sessions: exactly identical PnL
- `1000` sessions: exactly identical PnL

There was no behavioral difference at all.

### Why

The tutorial TOMATOES book structure was:

- `18,557` rows with `2x2` visible levels
- `729` rows with `3x2`
- `714` rows with `2x3`
- `0` rows with `3x3`

So in this dataset:

- fallback equals wallmid on asymmetric `3x2` or `2x3` rows
- fallback equals VWAP on common `2x2` rows

But on `2x2` rows:

- `vwap == wallmid` exactly on `9,821` rows
- `vwap != wallmid` on `8,736` rows
- the maximum gap was only `0.2`

That gap was too small to change:

- taking thresholds
- passive quote prices
- clearing decisions

So better fair-value accuracy did not automatically produce different trades.

## 4. The Sensitive Inventory-Management Phase

To make estimator differences actionable, I created two new traders:

- `wallmid_sensitive.py`
- `fallback_sensitive.py`

Both kept the same core market-making structure but added:

- edge-scaled taking
- inventory-aware quote sizing
- fair-value-based clearing
- soft-limit style inventory management

### The first result

On seed `20260406`, `300` sessions:

| Strategy | Mean Total PnL |
| --- | ---: |
| baseline `wallmidtest.py` | `15818.13` |
| `wallmid_sensitive.py` | `16312.58` |
| `fallback_sensitive.py` | `16352.47` |

`fallback_sensitive` beat `wallmid_sensitive` by about `+39.89`.

### The important correction

That first comparison was not a clean estimator-only test.

`fallback_sensitive.py` included an extra confidence channel:

```text
confidence = fallback_fv - wallmid_fv
```

That confidence term altered passive quote size asymmetrically. This used only current observable book data, not future information, but it was still a design-time bet that fallback disagreement was informative.

### Clean rerun

I then reran with two clean files:

- `wallmid_sensitive_clean.py`
- `fallback_sensitive_clean.py`

Those files used identical logic except for the fair-value source itself.

Result:

- exact tie across all `300` sessions
- exact tie in mean total PnL
- `0/300` wins for fallback over wallmid

Conclusion:

- pure FV swap still did nothing in the simulator
- the earlier edge came from the confidence mechanism, not from direct threshold changes

## 5. What The Fallback Confidence Channel Was Actually Doing

A later correction was important here:

- fallback reverts to wallmid on asymmetric rows
- therefore the profitable simulator signal was not coming from the asymmetric regime
- it was mostly coming from the common symmetric `2x2` regime, where fallback = VWAP

So in practice the profitable confidence signal was:

```text
vwap - wallmid
```

It was:

- small
- bounded
- mild enough not to disrupt two-sided market making

This is why `fallback_sensitive` looked more like a tiny passive size nudge than a wholesale strategy change.

## 6. Bot 2 Posterior: A Better Estimator That Did Not Monetize

Using the calibration docs and actual simulator code, I derived a better latent fair-value estimator from the visible book:

- reconstruct the Bot 2 quotes on each side
- derive the implied fair-value interval
- use the quarter-band center when Bot 1 disambiguates the half-interval

That led to:

- `bot2_mid`
- `bot2_quarter_center`

### Accuracy on inferred-truth TOMATOES

These were materially better than fallback as point estimators:

| Estimator | MAE | RMSE | Max Abs |
| --- | ---: | ---: | ---: |
| `fallback` | `0.1761` | `0.2020` | `0.4771` |
| `bot2_mid` | `0.1242` | `0.1439` | `0.2725` |
| `bot2_quarter_center` | `0.0877` | `0.1082` | `0.2529` |

Coverage was also strong:

- `bot2_mid ± 0.25` covered the inferred truth on `97.68%` of rows
- `±0.30` gave `100%` coverage on that sample

### Monetization attempts

Despite the stronger estimator, three attempts failed to beat `fallback_sensitive`:

1. `bot2_quarter_center_sensitive.py`
2. tuned `bot2_quarter_center_sensitive.py`
3. `bot2_quarter_center_posterior_split.py`

They all beat the baseline, but none beat `fallback_sensitive`.

The main lesson:

- better latent fair-value estimation is not the same thing as a better monetizable side signal
- the old fallback confidence term happened to fit the simulator economics better

## 7. Theory-First Candidate Sweep

Since parameter sweeps were not enough, I switched to a broader strategy search.

### New files

- `ACCURACY_EDGE_METHODOLOGY.md`
- `bot2_edge_lab.py`
- `scripts/run_accuracy_edge_benchmarks.py`

### Method

I generated about 20 distinct passive-quoting mechanisms intended to monetize accuracy edge through:

- side-specific mean markout
- worst-side protection
- common-edge scaling
- width-aware conviction
- contamination filtering
- inventory interaction
- discrete conviction buckets
- hybrid regime patches

The point was to test genuinely different mechanisms, not just tune constants.

### Screening pass

A screening pass was run on:

- seed `20260406`
- `250` sessions

Top screen results:

1. `inventory_agree_only`
2. `inventory_crossfade`
3. `signal_linear`
4. `mean_edge_split`
5. `worst_edge_split`
6. `discrete_conviction_buckets`

`balanced_mu` was carried forward as a control.

### Full benchmark

The survivors were benchmarked on:

- 6 seeds: `20260406` to `20260411`
- `1000` sessions per seed

Overall ranking:

| Strategy | Mean Total PnL |
| --- | ---: |
| `fallback_sensitive` | `16357.23` |
| `inventory_crossfade` | `16318.19` |
| `wallmid_sensitive` | `16316.42` |
| `inventory_agree_only` | `16316.03` |
| `signal_linear` | `16315.35` |
| `mean_edge_split` | `16315.27` |
| `worst_edge_split` | `16315.27` |
| `discrete_conviction_buckets` | `16315.12` |
| `balanced_mu` | `16041.46` |
| baseline | `15856.66` |

Main result:

- none of the 20 new candidates beat `fallback_sensitive`
- the best new candidate did not establish a meaningful edge over `wallmid_sensitive`

## 8. Final Statistical Result: Fallback Sensitive vs Wallmid Sensitive

Across the 6-seed benchmark:

- `fallback_sensitive` beat `wallmid_sensitive` on `6/6` seeds
- mean seed-level delta: `+40.81`

Per-seed deltas:

- `20260406`: `+42.1990`
- `20260407`: `+36.6913`
- `20260408`: `+41.0585`
- `20260409`: `+47.5718`
- `20260410`: `+35.5775`
- `20260411`: `+41.7528`

A combined 6000-session paired histogram was then built.

Across all `6000` paired sessions:

- mean delta: `+40.81`
- median delta: `+35.5`
- positive: `4298`
- negative: `1682`
- zero: `20`

Within the simulator, this effect is statistically significant.

## 9. What We Actually Learned

### What seems true

- Fallback is a real improvement as an inferred-truth estimator on the TOMATOES hidden-price reconstruction.
- Fallback is not a universal estimator winner. KELP clean stretches favored wallmid.
- In the tutorial simulator, pure estimator swaps do not change trades enough to matter.
- A small VWAP-vs-wallmid passive-size tilt does matter, and it is robust across the tested simulator seeds.
- Stronger latent-FV estimators like `bot2_quarter_center` did not automatically produce better PnL.

### What remains unresolved

- Why exactly the small `vwap - wallmid` passive-size tilt helps in the simulator.
- Why that mild signal monetizes better than the more accurate Bot 2 posterior signal.
- Whether the simulator-specific advantage will generalize to future out-of-sample competition data.

## 10. Current Best Position

As of the end of this session:

- best inferred-truth TOMATOES estimator: `bot2_quarter_center`
- best simulator trading policy tested: `fallback_sensitive.py`
- best practical conclusion: keep `fallback_sensitive.py` as the current simulator winner, but treat its edge as simulator-specific until validated on new real competition data

