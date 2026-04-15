# Round 1 Robust Monte Carlo Methodology

This note describes the methodology implemented in the round-1 Monte Carlo
backtester for `ASH_COATED_OSMIUM` uncertainty.

The goal is not to pretend that the osmium latent process is known exactly.
Instead, we:

1. keep a nominal osmium DGP for standard Monte Carlo runs,
2. build a confidence region of plausible `(phi, sigma)` pairs from the actual
   round-1 book data,
3. optionally rerun the strategy over that plausible family, and
4. report tail-risk metrics, especially 5th-percentile outcomes.

The implementation lives primarily in:

- `backtester/prosperity3bt/monte_carlo.py`
- `backtester/prosperity4mcbt/__main__.py`
- `rust_simulator/src/main.rs`

## 1. Nominal Osmium Model

The nominal latent fair-value generator used by the simulator is:

```text
x_{t+1} = f32(10000 + phi * (x_t - 10000) + eps_t)
eps_t ~ Normal(0, sigma^2)
```

with default point estimate:

- `phi = 0.99778`
- `sigma = 0.312`

Additional modeling choices:

- the state is quantized through `float32`, which matches the reverse
  engineering evidence for osmium,
- day starts are anchored to observed proxy starts:
  - day `-2`: `10000.25`
  - day `-1`: `9992.25`
  - day `0`: `10002.75`
- the visible book uses the calibrated round-1 bot rules implemented in the
  Rust simulator.

This point estimate is still useful as the default Monte Carlo setting, but it
should be treated as a center, not as ground truth.

## 2. Why Robustness Is Needed

The round-1 data does not pin down a unique `(phi, sigma)` pair.

Reasons:

- the clean hidden-fair reconstruction comes from a limited hold-one window,
- the all-data observable proxy is quantized,
- multiple `(phi, sigma)` pairs can generate similar medium-horizon behavior,
- the visible book introduces measurement noise because the latent fair value is
  only partially revealed through inner/outer quotes.

So the robust mode does not optimize against a single calibrated point. It
optimizes against a family of parameter pairs that are statistically consistent
with the round-1 observable data.

## 3. Observable-Space Calibration Target

The plausibility test uses the real round-1 osmium price files and works in
observable space, not just on one recovered hidden path.

For every tick:

1. infer the feasible latent-FV interval implied by the visible inner/outer
   quotes,
2. keep the strong cases where the interval width is exactly `0.5`,
3. record the midpoint of that interval as the empirical observable proxy,
4. record the visible-mask pattern that produced it.

This is effectively the same calibration logic used in the round-1 osmium
analysis scripts, but pulled into the backtester so the plausibility region is
generated automatically at run time.

## 4. Candidate Parameter Grid

Robust mode evaluates a user-configurable grid of `(phi, sigma)` values.

CLI controls:

- `--dro`
- `--dro-phi-min`
- `--dro-phi-max`
- `--dro-phi-steps`
- `--dro-sigma-min`
- `--dro-sigma-max`
- `--dro-sigma-steps`

If bounds are not supplied, the backtester builds a default box around the
nominal point:

- `phi in [phi_0 - 0.0015, phi_0 + 0.0015]`
- `sigma in [sigma_0 - 0.06, sigma_0 + 0.06]`

with clipping to keep parameters sensible.

The nominal point is forced into the grid even if it does not land exactly on
the linspace.

## 5. Feature Matching Statistic

For each candidate `(phi, sigma)`:

1. simulate osmium latent paths with the candidate parameters,
2. pass those simulated paths through the actual observed mask pattern from the
   round-1 book,
3. build simulated observable proxies under exactly the same strong ticks,
4. compare actual and simulated non-overlapping return summaries at horizons:

```text
k in {5, 10, 20, 30, 100}
```

For each horizon, the implementation compares:

- return standard deviation,
- 5th percentile,
- median,
- 95th percentile.

Two related statistics are stored:

### 5.1 Calibration Score

The calibration score is a weighted sum of squared z-scores:

```text
score(phi, sigma) = sum_j w_j * z_j(phi, sigma)^2
```

where each feature discrepancy is standardized by the cross-path dispersion of
that same feature under the candidate model.

This score is used as a ranking statistic.

### 5.2 Confidence Statistic

The plausibility region itself uses an unweighted quadratic form:

```text
T(phi, sigma) = sum_j z_j(phi, sigma)^2
```

where `j` runs over all selected return features.

This is treated as an approximate chi-square-type statistic over the feature
vector.

## 6. Confidence Region Construction

The plausible family is defined as:

```text
Theta_hat(alpha) = { (phi, sigma) : T(phi, sigma) <= c_alpha }
```

where:

- `alpha` is the user-selected confidence level (`--dro-confidence`),
- `c_alpha` is an approximate chi-square cutoff with
  `df = number_of_features`.

The implementation uses a Wilson-Hilferty approximation to map the requested
confidence level to a chi-square cutoff:

```text
ChiSq_k^{-1}(alpha) ≈ k * (1 - 2/(9k) + z_alpha * sqrt(2/(9k)))^3
```

This is not exact inference, but it provides a clear confidence-region
interpretation:

- points inside the region are treated as plausible,
- points outside are excluded from the robust family.

If no point lands inside the requested region, the best confidence-statistic
point is kept as a fallback so robust mode remains usable.

## 7. Scenario Weights Inside The Region

After the confidence region is built, accepted scenarios are weighted by:

```text
relative_weight(phi, sigma) = exp(-0.5 * T(phi, sigma))
```

These weights are normalized across accepted scenarios only.

Interpretation:

- the confidence region defines plausibility,
- the exponential weighting defines how much emphasis to place on each
  plausible point.

So the robust mode is:

- confidence-region based for acceptance,
- likelihood-style inside the accepted set for aggregation.

## 8. Full Robust Monte Carlo Pass

Once the plausible family is identified, the backtester reruns the full Rust
Monte Carlo simulator on the accepted parameter points.

Important implementation choice:

- the nominal scenario still writes the full dashboard bundle and sample paths,
- robust scenarios are written under `dro_runs/`,
- robust scenarios use `sample_sessions = 0` to avoid unnecessary large trace
  outputs.

This keeps robust mode inspectable without exploding output size.

## 9. Tail-Risk Outputs

Every Monte Carlo run now writes explicit tail-risk summaries:

- `P05`
- `CVaR95`
- `P01`
- `CVaR99`

for:

- total PnL,
- osmium PnL,
- root PnL.

This is true even when robust mode is off.

When robust mode is on, additional objects are produced:

### 9.1 Weighted Mixture Distribution

All accepted scenarios are pooled into a weighted mixture distribution. Each
session in a scenario receives:

```text
scenario_weight / number_of_sessions_in_that_scenario
```

The dashboard reports weighted:

- mean,
- standard deviation,
- quantiles,
- `P05`,
- `CVaR95`.

### 9.2 Scenario-Level P05 Distribution

For each accepted scenario, the backtester records that scenario's final
`P05(total_pnl)`. The dashboard then summarizes the distribution of those
scenario-level 5th percentiles.

This answers:

> "How much does the 5th-percentile outcome move as the osmium DGP changes
> within the plausible region?"

### 9.3 Worst-Case Scenarios

The dashboard also identifies:

- the accepted scenario with worst total `P05`,
- the accepted scenario with worst total mean.

These are the main robust stress-test points for strategy comparison.

## 10. Dashboard Fields

Nominal runs now include:

- `tailRisk`

Robust runs additionally include:

- `robust.grid`
- `robust.acceptedScenarios`
- `robust.allScenarios`
- `robust.weightedMixture`
- `robust.p05Distributions`
- `robust.p05Histograms`
- `robust.worstCase`
- `robust.bestFit`

The visualizer surfaces:

- nominal tail-risk tables,
- robust summary tables,
- a histogram of accepted-scenario total `P05`,
- a table of accepted `(phi, sigma)` scenarios.

## 11. Practical Interpretation

The robust mode is not claiming:

- exact statistical coverage,
- exact Bayesian posterior weights,
- exact DRO optimality.

It is intended as a pragmatic research tool:

1. construct a confidence-style region from actual observable data,
2. test strategies across that region,
3. inspect how much tail risk moves,
4. avoid over-optimizing to a single osmium parameter guess.

That is the right level of rigor for round-1 strategy development.

## 12. Recommended Usage

Nominal run:

```bash
PYTHONPATH=backtester python3 -m prosperity4mcbt my_strategy.py
```

Robust run:

```bash
PYTHONPATH=backtester python3 -m prosperity4mcbt my_strategy.py \
  --dro \
  --dro-phi-steps 5 \
  --dro-sigma-steps 5 \
  --dro-confidence 0.90 \
  --dro-calibration-paths 96 \
  --dro-max-scenarios 9
```

For quick iteration, reduce:

- `--dro-calibration-paths`
- `--dro-phi-steps`
- `--dro-sigma-steps`
- `--dro-max-scenarios`

For final evaluation, increase them.

## 13. Current Limitations

The present robust layer only treats osmium `(phi, sigma)` as uncertain.

It does not yet put ambiguity sets around:

- osmium near-bot presence rate,
- visible mask frequencies,
- trade-arrival intensity,
- day-start anchors,
- root book microstructure parameters.

Those can be added later if strategy sensitivity analysis suggests they matter.
