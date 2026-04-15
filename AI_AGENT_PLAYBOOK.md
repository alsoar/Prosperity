# Prosperity 4 — AI Agent Playbook

> **Competition**: IMC Prosperity 4: A Trading Challenge of Cosmic Proportions
> **Team**: CMU Physics (7th global, 1st USA in Prosperity 3)
> **Timeline**: Tutorial (Mar 16 – Apr 13) → Rounds 1–5 (Apr 14–30, 2026)
> **Prize**: $50,000 total ($25k/10k/5k/3.5k/1.5k + $5k Best Manual)
> **Currency**: XIRECs (replaces P3's SeaShells)

---

## Table of Contents

1. [Current Products & Data Sources](#1-current-products--data-sources)
2. [Active Alphas](#2-active-alphas)
3. [Experiment Log](#3-experiment-log)
4. [Backtester Guide](#4-backtester-guide)
5. [Competition Rules & Mechanics](#5-competition-rules--mechanics)
6. [Prosperity 3 Knowledge Base](#6-prosperity-3-knowledge-base)
7. [Frankfurt Hedgehogs Knowledge (2nd Place P3)](#7-frankfurt-hedgehogs-knowledge-2nd-place-p3)
8. [Strategy Playbook](#8-strategy-playbook)

---

## 1. Current Products & Data Sources

### Tutorial Round (Round 0) — ACTIVE

| Product | Fair Value | Behavior | Position Limit | Spread | Volatility | P3 Analog |
|---------|-----------|----------|----------------|--------|-----------|-----------|
| **EMERALDS** | ~10,000 XIRECs | Stationary (mean-reverting) | ±80 | ~16 (occasionally 8) | Std 0.7 | RAINFOREST_RESIN |
| **TOMATOES** | ~5,000 XIRECs | Drifting (random walk) | ±80 | ~13 (range 5–14) | Std 12.4 | KELP |

**Key Statistics:**

| Metric | EMERALDS | TOMATOES |
|--------|----------|----------|
| Mean mid | 10,000.0 | 4,992.8 |
| Std dev | 0.7 | 12.4 |
| Avg spread | 15.7 | 13.0 |
| Kurtosis | 13.5 | 4.2 |
| Lag-1 ACF | -0.45 (strong mean reversion) | -0.28 (weaker mean reversion) |
| Daily trades | ~200 | ~400 |
| Trade sizes | 3–8 (uniform) | 2–5 (uniform), rare qty=6 |

### Data Files

**Local paths:**
```
prosperity4/data/round0/
├── prices_round_0_day_-2.csv     # ~10,000 rows, semicolon-delimited
├── prices_round_0_day_-1.csv     # ~10,000 rows
├── trades_round_0_day_-2.csv     # ~200 trades
└── trades_round_0_day_-1.csv     # ~400 trades

prosperity4/TUTORIAL_ROUND_1/     # Duplicate + analysis scripts
├── prices_round_0_day_-2.csv
├── prices_round_0_day_-1.csv
├── trades_round_0_day_-2.csv
├── trades_round_0_day_-1.csv
├── alpha_analysis.py             # Imbalance signal research
├── alpha_deep_dive.py            # Deep dive on imbalance signals
├── alpha_part2.py                # Order flow research
├── fv_analysis.py                # Fair value formula comparison
├── fv_correct.py                 # Mid-price verification
└── fv_final.py                   # Final fair value experiments
```

### Future Round Data (Not Yet Released)

> **NOTE**: As each round launches, download data from https://prosperity.imc.com and place it in:
> ```
> prosperity4/data/round{N}/
> ├── prices_round_{N}_day_{D}.csv
> ├── trades_round_{N}_day_{D}.csv
> └── observations_round_{N}_day_{D}.csv   # if applicable
> ```
> Then update this section with new products, position limits, and behavior notes.

**Expected round cadence (based on P3 patterns):**

| Round | Dates | Expected Products | Expected Mechanics |
|-------|-------|-------------------|-------------------|
| 1 | Apr 14–17 | +Volatile product (P3: SQUID_INK) | Market making + trend following |
| 2 | Apr 17–20 | +Basket/ETF products | Statistical arbitrage, basket hedging |
| 3 | Apr 24–26 | +Options/derivatives | IV surface fitting, volatility trading |
| 4 | Apr 26–28 | +Cross-market product | Cross-island arbitrage with fees/tariffs |
| 5 | Apr 28–30 | All products + bot IDs revealed | Signal following, Olivia detection |

---

## 2. Active Alphas

> This section tracks every alpha we are currently trading. Update as alphas are found.

### Currently Deployed (Tutorial Round)

| # | Alpha | Product | Mechanism | PnL Impact | Source |
|---|-------|---------|-----------|-----------|--------|
| A1 | Tactical Taking (depth=3) | ALL | Sweep mispriced orders 3 levels deep before posting passive quotes | Large | P3 port |
| A2 | Penny Jumping | ALL | Post 1 tick inside other MM quotes to be best-in-book | Large | P3 port |
| A3 | Worst-Mid Fair Value | TOMATOES | Use (worst_bid + worst_ask)/2 instead of (best_bid + best_ask)/2 for stability | +2,013 vs best_mid | [tutorial_experiments.md §5](tutorial_experiments.md#5-fair-value-experiments) |
| A4 | Position-Based Skew | TOMATOES | Lean quotes toward reducing inventory; linear skew, 3 ticks at limit | Part of v2 gains | [tutorial_experiments.md §2.4](tutorial_experiments.md#24-v2-spread--skew--soft-limit) |
| A5 | Wider Spread (3 vs 2) | TOMATOES | Eliminates most negative-edge fills (was losing 10.7k to adverse selection) | Part of v2 gains | [tutorial_experiments.md §4.2](tutorial_experiments.md#42-tomatoes-trading-profile-pre-v2-optimization) |
| A6 | Soft Position Limit (50) | TOMATOES | Suppress accumulating-side quotes beyond position 50 | Part of v2 gains | [tutorial_experiments.md §2.4](tutorial_experiments.md#24-v2-spread--skew--soft-limit) |
| A7 | Fair-Value Book Clearing | ALL | When |pos| < 10% of limit, take AT fair value to clear book and expose passive quotes | +581 | [tutorial_experiments.md §2.5](tutorial_experiments.md#25-fair-value-taking-opt-10) |
| A8 | Overshoot Protection | ALL | Cap edge-of-fair taking at neutral (don't flip to opposite side) | +167 | [tutorial_experiments.md §2.3](tutorial_experiments.md#23-overshoot-protection) |

### Backtest Performance

| Trader | Day -2 | Day -1 | Total | vs IMC Starter |
|--------|--------|--------|-------|---------------|
| IMC Starter | -1,612 | 2,817 | 1,204 | — |
| Simple MM (`test_algo.py`) | 8,379 | 8,403 | 16,782 | 14x |
| v1 (P3 port) | 17,424 | 13,907 | 31,331 | 26x |
| **v2 (final, `trader_v2.py`)** | **17,541** | **14,668** | **32,209** | **27x** |

Server PnL: 2,767 XIRECs (evaluation data differs from training data).

### Future Alphas (Waiting for Data)

| # | Alpha | Trigger | Expected Round | Based On |
|---|-------|---------|---------------|----------|
| F1 | Olivia Bot Detection | Trader IDs revealed OR qty-15 trades at daily extrema | R5 (or earlier if detectable) | P3 R5 — Olivia bought at daily lows, sold at daily highs |
| F2 | Basket Premium Mean-Reversion | Basket/ETF products launched | R2 | P3 R2 — Z-score > 20 entry on premium differences |
| F3 | IV Surface Fitting + Scalping | Options products launched | R3 | P3 R3 / FH R3 — Quadratic moneyness-IV fit, trade deviations |
| F4 | Cross-Island Arbitrage | Conversion product launched | R4 | P3 R4 — Pure arb between local and external markets |
| F5 | Hidden Taker Bot | Macaron-like product with conversion | R4 | FH R4 — Bot fills at `int(externalBid + 0.5)` with ~60% rate |
| F6 | Informed Trader Signal (Cross-Product) | Bot behavior detected on components | R2+ | FH R2 — Olivia on Croissants shifted basket thresholds |

---

## 3. Experiment Log

> Every research avenue gets documented here. Each entry links to the research log with full details.

### Tutorial Round Experiments

| ID | Experiment | Result | Impact | Log |
|----|-----------|--------|--------|-----|
| E1 | Data Exploration (EDA) | Characterized EMERALDS as stationary, TOMATOES as drifting | Foundation for all strategies | [tutorial_experiments.md §1](tutorial_experiments.md#1-data-exploration) |
| E2 | P3 Port (trader_v1) | 31,331 total — 26x starter | Baseline established | [tutorial_experiments.md §2.1](tutorial_experiments.md#21-v1-port-from-p3) |
| E3 | Edge-of-fair-value bug fix | Sign error in position reduction check | -197 (bug was accidentally profitable) | [tutorial_experiments.md §2.2](tutorial_experiments.md#22-edge-of-fair-value-bug-fix) |
| E4 | Overshoot protection | Cap fair-value taking at neutral | +167 | [tutorial_experiments.md §2.3](tutorial_experiments.md#23-overshoot-protection) |
| E5 | Spread + Skew + Soft limit (v2) | Three TOMATOES optimizations combined | +297 combined | [tutorial_experiments.md §2.4](tutorial_experiments.md#24-v2-spread--skew--soft-limit) |
| E6 | Fair-value taking threshold sweep | 0%, 10%, 15%, 25%, 50% tested | 10% optimal (+581) | [tutorial_experiments.md §2.5](tutorial_experiments.md#25-fair-value-taking-opt-10) |
| E7 | PnL formula derivation | Confirmed: PnL = cash_flow + pos × mid_price | Foundational | [tutorial_experiments.md §3](tutorial_experiments.md#3-pnl-formula-derivation) |
| E8 | Mid-price verification | Server uses (best_bid + best_ask)/2, verified 100% on 44k rows | Critical: our worst_mid differs from server mark | [tutorial_experiments.md §3.2](tutorial_experiments.md#32-server-mid-price-verification) |
| E9 | EMERALDS trade profile | Buys at 9993, sells at 10007, 100% from order book | Confirmed working perfectly | [tutorial_experiments.md §4.1](tutorial_experiments.md#41-emeralds-trading-profile) |
| E10 | TOMATOES trade profile | 227 negative-edge buys (-4,956), 217 negative-edge sells (-5,731) | Drove v2 optimizations | [tutorial_experiments.md §4.2](tutorial_experiments.md#42-tomatoes-trading-profile-pre-v2-optimization) |
| E11 | Fair value formula comparison | worst_mid, best_mid, blends, microprice — 5 formulas tested | worst_mid wins by +2,013 | [tutorial_experiments.md §5](tutorial_experiments.md#5-fair-value-experiments) |
| E12 | Imbalance → worst_mid prediction | 3 constructions × 50 lookaheads | r ≈ 0, NOT usable | [tutorial_experiments.md §6.1](tutorial_experiments.md#61-does-imbalance-predict-worst_mid-no) |
| E13 | Imbalance → best_mid prediction | Same constructions | r = 0.445 but economically unexploitable (0.35 XIRECs << 6 XIRECs spread) | [tutorial_experiments.md §6.2](tutorial_experiments.md#62-does-imbalance-predict-best_mid-yes--r0445) |
| E14 | Imbalance-based quote skew | Shift quotes 1–5 ticks in predicted direction | +91 at best, inconsistent | [tutorial_experiments.md §6.3](tutorial_experiments.md#63-can-we-exploit-it-no) |
| E15 | Imbalance-based directional taking | Take at fair in predicted direction | -1,172 to -1,427 | [tutorial_experiments.md §6.3](tutorial_experiments.md#63-can-we-exploit-it-no) |
| E16 | Cumulative imbalance regime indicator | Correlated with price level (r=0.45–0.58) | SPURIOUS — inverts between days | [tutorial_experiments.md §6.4](tutorial_experiments.md#64-cumulative-imbalance-as-regime-indicator) |
| E17 | Competing bid/ask pressure (CVD, rate_diff, net_conf) | 53–58% directional accuracy at 100-tick horizon | Consistent but unexploitable: signal magnitude << spread | [tutorial_experiments.md §7](tutorial_experiments.md#7-cumulative-order-flow-research) |
| E18 | Net confidence quote skew | conf100_skew2, conf100_skew4, conf200_skew2 | +91 at best, not worth complexity | [tutorial_experiments.md §7.3](tutorial_experiments.md#73-can-we-exploit-it-no) |
| E19 | Net confidence side suppression | Suppress MM on one side based on signal | -2,464 to -2,729 CATASTROPHIC | [tutorial_experiments.md §7.3](tutorial_experiments.md#73-can-we-exploit-it-no) |

### Key Conclusions from Tutorial Experiments

1. **Market making beats direction** — Spread income dominates. Any signal that disrupts the MM engine costs more than it gains.
2. **Server marks to best_mid** — Confirmed 100% across 44k rows. Our worst_mid is better for trading decisions despite differing from server PnL mark.
3. **Imbalance predicts best_mid (r=0.445) but not worst_mid** — Real signal, economically unexploitable in MM context.
4. **Position management is the second biggest lever** — Skew, soft limits, overshoot protection add ~900 XIRECs combined.
5. **Fair-value taking works through a second-order effect** — Trades themselves break even; value is in exposing passive quotes.
6. **Only 2 days of data** — Regime-dependent signals can't be validated. Need more data from competition rounds.

### Research Scripts Reference

| Script | Purpose | Location |
|--------|---------|----------|
| `tutorial_analysis.py` | Comprehensive EDA (10 plots) | `prosperity4/tutorial_analysis.py` |
| `tomato_trades_analysis.py` | TOMATOES trade deep dive (4 plots) | `prosperity4/tomato_trades_analysis.py` |
| `alpha_analysis.py` | Imbalance signal research | `prosperity4/TUTORIAL_ROUND_1/alpha_analysis.py` |
| `alpha_deep_dive.py` | Deep dive on imbalance signals | `prosperity4/TUTORIAL_ROUND_1/alpha_deep_dive.py` |
| `alpha_part2.py` | Cumulative order flow research | `prosperity4/TUTORIAL_ROUND_1/alpha_part2.py` |
| `fv_analysis.py` | Fair value formula comparison | `prosperity4/TUTORIAL_ROUND_1/fv_analysis.py` |
| `fv_correct.py` | Mid-price formula verification | `prosperity4/TUTORIAL_ROUND_1/fv_correct.py` |
| `fv_final.py` | Final fair value experiments | `prosperity4/TUTORIAL_ROUND_1/fv_final.py` |
| `zscore_gridsearch.py` | Hyperparameter optimization | `prosperity4/zscore_gridsearch.py` |

---

## 4. Backtester Guide

### Setup

We use [jmerle's P3 backtester](https://github.com/jmerle/imc-prosperity-3-backtester), patched for P4:
- Added `EMERALDS: 80` and `TOMATOES: 80` to position limits
- Added `DEFAULT_LIMIT = 50` fallback for unknown future products

```bash
cd prosperity4/backtester
uv sync   # installs all deps into .venv
```

Alternative: [kevin-fu1's P4 backtester](https://github.com/kevin-fu1/imc-prosperity-4-backtester) (native P4 support).

### Running a Backtest

**Quick command** (run from `prosperity4/backtester/`):
```bash
.venv/bin/python -m prosperity3bt ../trader_v3.py 0 --data ../data --no-out
```

**All options:**
```bash
# Alias for convenience (add to your shell profile):
alias bt='cd /Users/christopherberman/Desktop/prosperity\ prez/prosperity4/backtester && .venv/bin/python -m prosperity3bt'

# Run on ALL tutorial round days
bt ../trader_v3.py 0 --data ../data --no-out

# Run specific day
bt ../trader_v3.py 0--2 --data ../data --no-out
bt ../trader_v3.py 0--1 --data ../data --no-out

# With output log (for visualizer)
bt ../trader_v3.py 0 --data ../data

# Print trader stdout (debugging)
bt ../trader_v3.py 0 --data ../data --print --no-out

# Merge PnL across days
bt ../trader_v3.py 0 --data ../data --merge-pnl --no-out
```

### Trade Matching Modes

```bash
# Default: match market trades at prices equal to or worse than your quotes
prosperity3bt algo.py 0 --data data --match-trades all

# Conservative: only match trades at prices WORSE than your quotes
prosperity3bt algo.py 0 --data data --match-trades worse

# Order book only: never match market trades
prosperity3bt algo.py 0 --data data --match-trades none
```

**Recommendation**: Use `--match-trades worse` for conservative estimates. Server results often differ from local backtests (our v2 scores 32,209 locally but 2,767 on server due to different evaluation data).

### Adding New Round Data

When a new round launches:

1. **Download data** from https://prosperity.imc.com (CSV exports)
2. **Create directory**: `prosperity4/data/round{N}/`
3. **Place files** with exact naming convention:
   ```
   prices_round_{N}_day_{D}.csv      # Order book snapshots
   trades_round_{N}_day_{D}.csv      # Trade data
   observations_round_{N}_day_{D}.csv # External data (if applicable)
   ```
4. **Update position limits** in `backtester/prosperity3bt/data.py`:
   ```python
   LIMITS = {
       "EMERALDS": 80,
       "TOMATOES": 80,
       "NEW_PRODUCT": XX,   # <-- add here
   }
   ```
5. **Run backtest** on new round: `prosperity3bt algo.py {N} --data data`

### CSV File Formats

**Prices** (semicolon-delimited):
```
day;timestamp;product;bid_price_1;bid_volume_1;bid_price_2;bid_volume_2;bid_price_3;bid_volume_3;ask_price_1;ask_volume_1;ask_price_2;ask_volume_2;ask_price_3;ask_volume_3;mid_price;profit_and_loss
```

**Trades** (semicolon-delimited):
```
timestamp;buyer;seller;symbol;currency;price;quantity
```

**Observations** (comma-delimited — NOTE different delimiter!):
```
timestamp,bidPrice,askPrice,transportFees,exportTariff,importTariff,sugarPrice,sunlightIndex
```

### Visualizer

- **Community visualizer**: http://ctdash.xyz/vis/ (upload output log)
- Requires the `Logger` class in your trader — see `trader_v2.py` for the complete implementation
- The Logger compresses state and orders into JSON for the visualizer to parse

### Submission to Server

**Automated** (use our custom submitter):
```bash
# From prosperity4/ directory:
python submit.py trader_v3.py

# Submit with custom output path:
python submit.py trader_v3.py --out submissions/my_test.zip

# Re-enter auth token:
python submit.py --token

# Auto-refresh token (no browser needed, lasts 30 days):
python grab_token.py
```

**What `submit.py` does:**
1. Auto-refreshes Cognito token via refresh token (no interaction for ~30 days)
2. Detects current open round
3. Uploads algo to `POST /submission/algo`
4. Polls `GET /submissions/algo/{round}` every 5s until FINISHED
5. Downloads logs from `GET /submissions/algo/{id}/zip`
6. Prints terminal dashboard with PnL, per-product breakdown, sparkline, positions

**API base**: `https://3dzqiahkw1.execute-api.eu-west-1.amazonaws.com/prod`

**Token setup** (first time only):
1. Go to https://prosperity.imc.com (logged in)
2. Browser console: `document.cookie.match(/\.idToken=([^;]+)/)[1]`
3. Run `python submit.py --token`, paste it
4. Refresh token also saved — auto-refreshes for 30 days

**Code requirements for server:**
- Import with try/except (server has no `prosperity3bt`):
  ```python
  try:
      from datamodel import Order, OrderDepth, TradingState, ...
  except ImportError:
      from prosperity3bt.datamodel import Order, OrderDepth, TradingState, ...
  ```
- Include Logger class (copy from `trader_v3.py`)
- Validate: `pip install imc-prospector && imc-prospector your_algo.py`

**Analyzing server results:**
```python
# Print dashboard from a saved submission zip:
from submit import print_terminal_dashboard
with open('submissions/25121.zip', 'rb') as f:
    print_terminal_dashboard(f.read())
```
- Logs zip contains: `{id}.json` (PnL + activities), `{id}.log` (visualizer-compatible), `{id}.py` (submitted code)
- Upload `.log` file to https://jmerle.github.io/imc-prosperity-3-visualizer/ for charts

### Environment Variables (Backtester Only)

- `PROSPERITY3BT_ROUND` — current round number
- `PROSPERITY3BT_DAY` — current day number
- These do NOT exist on the server — never depend on them in submitted code

---

## 5. Competition Rules & Mechanics

### Team Eligibility

- 1–5 players per team, university students, 18+
- Team composition locks after Round 2
- Top 25 must prove enrollment; Top 5 + Manual Winners need specific residency
- **Disqualified**: Prior Top 10 P3 finalists, IMC employees, multiple memberships, plagiarism

### Two Challenges Per Round

**Algorithmic**: Upload a Python `Trader` class. Algorithm trades against bots in isolation (no player-vs-player). New products each round.

**Manual**: One-off puzzles (auctions, optimization, game theory). Small fraction of total PnL. Separate $5k prize. **Inactive during Tutorial Round.**

### The Trader Class

```python
class Trader:
    def run(self, state: TradingState) -> tuple[dict[str, list[Order]], int, str]:
        """
        Called every iteration (every 100ms of simulated time).

        Args:
            state: TradingState with order books, positions, trades, observations

        Returns:
            orders: dict mapping product symbol -> list of Order objects
            conversions: int (number of conversions to execute, 0 if none)
            trader_data: str (serialized state for next iteration)
        """
        orders = {}
        conversions = 0
        trader_data = ""
        return orders, conversions, trader_data
```

### TradingState Object

| Attribute | Type | Description |
|-----------|------|-------------|
| `traderData` | `str` | Your serialized state from previous iteration (only persistence mechanism) |
| `timestamp` | `int` | Current iteration (0 to 999,900 in steps of 100; 10,000 iterations per day) |
| `listings` | `dict[Symbol, Listing]` | All tradable instruments |
| `order_depths` | `dict[Symbol, OrderDepth]` | Order book with buy/sell orders |
| `own_trades` | `dict[Symbol, list[Trade]]` | Your trades since last iteration |
| `market_trades` | `dict[Symbol, list[Trade]]` | All market trades since last iteration |
| `position` | `dict[Product, int]` | Your current net position per product |
| `observations` | `Observation` | External data (conversion observations) |

### Order Depth Structure

```python
class OrderDepth:
    buy_orders: dict[int, int]    # {price: positive_volume}
    sell_orders: dict[int, int]   # {price: NEGATIVE_volume}  <-- IMPORTANT: negative!
```

**Critical**: `sell_orders` volumes are **negative** in the data structure. When iterating:
```python
for ask_price, neg_vol in sell_orders.items():
    actual_volume = -neg_vol  # flip the sign
```

### Order Execution Model

**THIS IS THE SINGLE MOST IMPORTANT THING TO UNDERSTAND.**

Each iteration (timestamp), the execution order is:

1. Market state initialized from CSV order book data
2. `TradingState` created and passed to your `Trader.run()`
3. Your function returns orders (must complete in < 900ms)
4. Orders type-checked
5. **Position limit enforcement** (CRITICAL — see below)
6. Your orders matched against historical order book
7. Remaining orders matched against market trades (if applicable)
8. Position and cash flow updated
9. Next timestamp

### Position Limit Enforcement (CRITICAL)

**This is the most common source of bugs.**

- Limits checked BEFORE any matching occurs
- If the SUM of all your buy orders for a product would push position above limit (or sum of sells below -limit), **ALL orders for that product are CANCELLED** — not just the excess
- You must track pending order volume yourself to avoid this

```python
# BAD: might exceed limit and cancel ALL orders
orders.append(Order("EMERALDS", 9996, 50))
orders.append(Order("EMERALDS", 9998, 50))  # total 100 > limit 80!

# GOOD: track remaining capacity
remaining = LIMIT - position - buy_orders_placed
orders.append(Order("EMERALDS", 9996, min(50, remaining)))
```

### Order Matching Priority

1. **Order depth first**: Your orders matched against resting book orders (best price first)
2. **Market trades second**: Only if order depth insufficient. Matched at YOUR quote price, not the trade price
3. Market trade matching modes: `all` (default), `worse` (conservative), `none`

### PnL Calculation (Mark-to-Market)

```
PnL(t) = cash_flow(t) + position(t) × mid_price(t)

where:
  cash_flow(t) = Σ(sell_price × qty) - Σ(buy_price × qty)   [cumulative]
  position(t)  = net units held                                [signed]
  mid_price(t) = (best_bid + best_ask) / 2                    [mark-to-market]
```

**Verified 100% across 44,000 rows**: Mid-price uses `(bid_price_1 + ask_price_1) / 2` — the BEST prices, not worst.

Holding a position in a rising market counts as profit even without selling.

### Allowed Imports

```python
import pandas
import numpy
import statistics
import math
import typing
import jsonpickle
```

Nothing else. No `time.sleep()`, no network calls, no infinite loops.

### State Persistence

- Instance variables (`self.x`) reset every iteration — the `Trader` class is re-instantiated
- **Only persistence**: the `traderData` string returned from `run()`, passed back as `state.traderData` next iteration
- Use `json.dumps()` / `json.loads()` or `jsonpickle` to serialize state

### Conversion Mechanics (Later Rounds)

- Some products tradable on multiple exchanges (e.g., P3's Macarons on local + Pristine Island)
- `ConversionObservation` provides: bidPrice, askPrice, transportFees, exportTariff, importTariff, sugarPrice, sunlightIndex
- Return a non-zero `conversions` int to execute cross-market trades
- Conversion limit per timestamp (e.g., 10 units in P3 R4)

### Scoring

- **Algo**: Cumulative PnL across all products, across evaluation days
- **Manual**: Points from puzzle solutions
- **Total**: Algo PnL + Manual PnL (algo dominates)
- **Ranking**: By total PnL across all rounds

---

## 6. Prosperity 3 Knowledge Base

> This section contains PROVEN strategies and lessons from our 7th-place P3 finish AND analysis of what we should have done differently. This is our most valuable competitive advantage for P4.

### Round 1: Market Making (RESIN / KELP / SQUID_INK)

**What worked:**
- **RESIN** (stationary at 10,000): Simple MM with fixed fair value. Buy below 10k, sell above 10k. Exploit standing orders at fair to balance position. ~39k SeaShells/round (FH figure).
- **KELP** (drifting): Same MM logic but with dynamic fair value from worst-mid. ~5k/round.
- Key optimizations: tactical taking (depth=3), penny jumping, worst-mid fair value, position-aware quote suppression, max-size quoting.

**What failed:**
- **SQUID_INK** (volatile): Z-scores, MACD, volatility breakouts all failed. 100-seashell swings with no pattern. We used spike detection (rolling std > 20) with opposite-direction entry at 10% position size. High variance — lucky on rerun.

**Lesson**: Stationary products are free money with MM. Volatile products are dangerous without a structural edge.

**Result**: Initially 771st (hardcoded sample data). After rerun: **9th place, 107,237 SeaShells**.

### Round 2: Basket Arbitrage (BASKETS / CROISSANTS / JAMS / DJEMBES)

**What worked:**
- PICNIC_BASKET1 = 6×CROISSANTS + 3×JAMS + 1×DJEMBE
- PICNIC_BASKET2 = 4×CROISSANTS + 2×JAMS
- Premium mean-reversion: hardcoded premium means (Basket1=18.63, Basket2=48.83), z-score window=30, entry at |z| > 20
- Position allocation: 100% Basket1, 60% Basket2 for z-score, 32% constrained hedge, 8% MM on spreads (~5k/day)

**What we missed:**
- Chris spotted qty-15 patterns at highs/lows (Squid Ink & Croissants) — deferred investigation. **This was the Olivia signal** that could have been exploited 3 rounds earlier.
- FH's approach was better: reverse-engineer data generation (constituents independent, baskets mean-revert to synthetic), use fixed thresholds instead of z-scores, integrate Olivia's Croissant signal to shift basket thresholds.

**Manual**: Container game theory. Our player behavior model underestimated Nash following. Picked 80x multiplier (suboptimal). FH picked 50 (safer, +40k).

**Result**: **7th place, 243,083 SeaShells** (102,758 algo + 33,087 manual).

### Round 3: Options (VOLCANIC_ROCK / VOUCHERS)

**What worked in backtesting (but failed on submission day):**
- IV smile fitting: moneyness m_t = ln(K/S_t) / √TTE, quadratic fit v_t = a·m² + b·m + c
- Bid params: a=0.1436, b=-0.00155, c=0.1504
- Ask params: a=0.2386, b=-0.00196, c=0.1516
- Expected: ~80k/day from vouchers + ~100k from other products

**What went catastrophically wrong:**
1. AWS Lambda memory issue (Jasper's visualizer exceeded 100MB) — lost all rolling windows mid-trade
2. Quadratic IV fit broke on submission day — model severely mis-estimated IV
3. **Post-mortem discovery**: Rolling window mean IV beats quadratic by 2.5x (200k/day vs 80k)
4. **Post-mortem discovery**: Not hedging beats hedging (spread cost 40k/day > realistic max loss 16k)

**FH's superior approach:**
- IV scalping: construct volatility smile → fit parabola → detrend → convert deviations to price space → trade mispricings
- 100k–150k/round from IV scalping alone
- Key insight: check for negative autocorrelation in option returns — confirms exploitable inefficiency
- Also ran lightweight mean reversion on underlying as hedge (not for pure profit)

**Result**: **241st place, 75,755 SeaShells**. Post-analysis shows 200–250k/day was achievable.

### Round 4: Cross-Island Arbitrage (MACARONS)

**What worked:**
- Pure arbitrage: buy on local island, sell via conversion to Pristine Island (or vice versa)
- Break-even: conversion ask + import tariff + transport fee
- Position size: 10 per conversion, aggressive local buying near Pristine mid-price

**What FH discovered that we missed:**
- Hidden taker bot at `int(externalBid + 0.5)` with ~60% fill rate
- This bot existed in P2 as well (Orchids) — discoverable from studying past writeups
- Conservative sizing (10 units) → 80–100k. Optimal (20–30 units) → 160k+

**Our post-mortem:**
- Traded 56,000 Macarons across 10,000 timestamps = only 5.6/trade
- 44,000 unrealized = 132k left on table
- Increasing to 30/trade would nearly double PnL

**Manual**: Suitcase game theory. Used Discord data from R2 to calibrate player behavior. Picked 83 and 47.

**Result**: **8th place, 447,251 SeaShells** (364,992 algo + 82,259 manual). **BEST ROUND.**

### Round 5: Signal Following + YOLO (ALL PRODUCTS + BOT IDs)

**What worked:**
- **Olivia Detection**: Bot 'Olivia' buys at daily lows, sells at daily highs on multiple products
- **Croissant YOLO**: Go max long Croissants via baskets when Olivia signals bullish (up to 1050 effective position through baskets)
- Risk analysis: worst-case premium loss 45k SeaShells, but Olivia days yield 120k+
- Stationarity testing: 90–95% confidence that premium differences are stationary
- Market made baskets while waiting for Olivia signal (~10k/day)

**FH's Olivia detection method (without trader IDs):**
- Track daily running min/max
- Flag trades at daily extrema in expected direction (buy at min, sell at max)
- Manage false positives by monitoring for contradicting new extrema
- Works even without trader IDs (pre-R5)

**Manual**: Goldberg portfolio optimization. Used CVXPY for 9-product allocation with quadratic fees. Played conservatively — left profits on table but avoided catastrophe.

**Result**: **7th globally, 1st USA, 383,014 SeaShells** (244,740 algo + 138,274 manual).

### Cross-Round Lessons

| Lesson | Evidence | Action for P4 |
|--------|----------|---------------|
| Post-hoc analysis reveals 2–3x more PnL | R3: 80k actual → 250k possible | Always run thorough post-mortem between rounds |
| Simple arbitrage > complex models | R4: pure arb = highest PnL round | Start with structural edges, not predictions |
| Bot behavior is predictable & discoverable | Olivia, hidden taker bot, persistent MM walls | Study ALL historical writeups; test for bot patterns immediately |
| Position management is a major lever | Tutorial: +900 from skew/limits alone | Always implement inventory management |
| Wider spreads often beat tighter spreads | Tutorial: spread 3 beats spread 2 on TOMATOES | Test wider spreads first — adverse selection is the enemy |
| Hardcoded values are fragile | R3: quadratic fit broke on new data | Use robust methods (rolling means, EMAs) not curve fits |
| Lambda memory limits kill | R3: visualizer exceeded 100MB | Strip all unnecessary code from submissions |
| Human behavior in manual rounds is hard to predict | R2 & R4 manual: models were wrong | Don't over-engineer manual predictions |
| Study past competition writeups | FH found bot patterns from P2 writeups | Read every public Prosperity writeup before rounds start |

---

## 7. Frankfurt Hedgehogs Knowledge (2nd Place P3)

> The Frankfurt Hedgehogs (Timo Diehm, Arne Witt, Marvin Schuster) placed 2nd globally in P3 with 1,433,876 SeaShells. Their writeup is at `timo-writeup/README.md` and their complete algorithm at `timo-writeup/FrankfurtHedgehogs_polished.py`.

### Their Key Innovations

**1. Wall Mid Concept (Critical)**
- Deep liquidity levels ("walls") in the order book represent the true market maker's knowledge
- Walls sit ±2 ticks from the true underlying value
- `wall_mid = (min(bid_prices) + max(ask_prices)) / 2` — uses WORST prices, not best
- More stable than raw mid-price, which gets distorted by overbidding/undercutting
- **This matches our worst-mid approach** — independently discovered the same principle

**2. Reverse-Engineering Data Generation (Baskets)**
- Their key insight: constituent prices are independently randomized, baskets have mean-reverting noise added
- Implication: baskets revert to constituent synthetic value, NOT vice versa
- Therefore: use fixed thresholds on (basket_price - synthetic_value), not z-scores
- Z-scores add complexity and overfitting risk without benefit when volatility is stable
- **Choose flat parameter landscapes over performance peaks** for robustness

**3. Olivia Detection Without Trader IDs**
- Detected Olivia's pattern on Squid Ink without knowing who was trading
- Method: track daily running min/max, flag trades at extrema in expected direction
- Also detected Olivia on Croissants → used as cross-product signal for basket trading
- Signal: If Olivia short Croissants, shift basket long entry from -50 to -80 (asymmetric threshold)

**4. IV Scalping (Options)**
- Construct volatility smile across strikes
- Fit parabola to get fair IV per moneyness level
- Detrend: isolate deviations (v_t - v̂_t) independent of moneyness
- Convert to price space via Black-Scholes with smile-implied IV
- Trade deviations — confirmed by 1-lag negative autocorrelation
- **100k–150k/round**, their most profitable alpha

**5. Hidden Taker Bot (Macarons)**
- Discovered through experimentation: offers at `int(externalBid + 0.5)` get filled ~60% of the time
- Same pattern existed in P2 (Orchids) — discoverable from studying Jasper's P2 writeup
- Conservative sizing: 80–100k/round. Optimal: 160k+

**6. Risk Management Philosophy**
- Never optimize purely for backtest score (overfitting trap)
- Consider RELATIVE risk vs competitors (game-theoretic)
- 95% VaR as position limit (maintained 200k lead with 50k max drawdown)
- Have fallback strategies if bot behavior changes mid-competition
- 50% hedge compromise on baskets (rather than 0% or 100%)

### Their Signal Quality Hierarchy

1. **High confidence**: Structural arbitrage (baskets vs. constituents)
2. **Medium confidence**: Bot behavior patterns (visible in data)
3. **Low confidence**: Complex time-series models with limited data

### Their Code Architecture

```python
# Base class with utilities
class ProductTrader:
    # prices, volumes, walls, position limits, orders
    # bidding, asking, wall detection, informed trader checking

# Specialized per product
class StaticTrader(ProductTrader):     # Rainforest Resin
class DynamicTrader(ProductTrader):    # Kelp
class InkTrader(ProductTrader):        # Squid Ink (Olivia detection)
class EtfTrader(ProductTrader):        # Picnic Baskets (multi-product)
class OptionTrader(ProductTrader):     # Volcanic Rock Vouchers (Black-Scholes)
class CommodityTrader(ProductTrader):  # Macarons (conversion logic)
```

### What They Tried That Failed
- Random seed reverse-engineering (24hrs on Raspberry Pi, no match)
- ML-heavy approaches (rejected as overfitting without theoretical grounding)
- Complex hedging optimization (50% compromise worked better)
- Hardcoding exploit (reported to IMC, who fixed it from R3 onward)

---

## 8. Strategy Playbook

### Core Philosophy: Breadth-First Search for Alpha

**DO NOT** dive deep into one approach. Instead:

1. **Start simple** — implement the obvious strategy first (market making for stationary, basic arb for baskets)
2. **Measure** — backtest thoroughly, decompose PnL by source
3. **Look for structural edges** — patterns in data that arise from HOW the simulation was built
4. **Test cheap hypotheses first** — 30-minute experiments that either work or don't
5. **Only go deep when a signal is confirmed** — don't spend hours tuning a signal that isn't there

### The Alpha Discovery Process

```
For each new round/product:
  1. EXPLORE: Run EDA. Plot prices, spreads, returns, autocorrelation, trade sizes.
  2. CHARACTERIZE: Is it stationary? Drifting? Volatile? Mean-reverting?
  3. MATCH TO P3: Which P3 product does it resemble? Port that strategy first.
  4. LOOK FOR BOTS: Are there quantity-15 trades? Trades at daily extrema?
     Consistent fills at specific price levels? Named traders?
  5. TEST STRUCTURAL EDGES:
     - For baskets: compute synthetic value, plot premium, test stationarity
     - For options: compute IV, plot smile, check autocorrelation of returns
     - For conversion products: compute break-even, look for hidden taker bots
  6. ITERATE: Widen/narrow spreads, test position limits, tune thresholds
  7. VALIDATE: Use --match-trades worse for conservative estimate
```

### Decision Framework for Each Product Type

**Stationary product** (like EMERALDS / RESIN):
→ Market make at fixed fair value, tactical taking, penny jumping. Done.

**Drifting product** (like TOMATOES / KELP):
→ Market make with dynamic worst-mid fair value, position skew, soft limits.

**Volatile product** (like SQUID_INK):
→ First check for Olivia pattern. If found, follow. If not, conservative MM or avoid.

**Basket/ETF** (like PICNIC_BASKETs):
→ Compute premium to synthetic. Test mean-reversion with fixed thresholds.
→ Integrate Olivia signal from constituents if available.
→ Leftover capacity → market make on basket spreads.

**Options/Derivatives** (like VOLCANIC_ROCK_VOUCHERs):
→ Construct IV smile across strikes. Fit parabola. Trade deviations.
→ Use rolling mean IV rather than one-time curve fit (more robust).
→ Consider going unhedged if hedging spread cost > expected delta loss.
→ Check for negative autocorrelation in option returns to confirm exploitability.

**Conversion/Cross-Market** (like MACARONS):
→ Compute arbitrage break-even (conversion price + all fees).
→ Test for hidden taker bot at `int(externalBid + 0.5)`.
→ Maximize conversion rate per timestamp.
→ Ignore price prediction models (sunlight, sugar) unless clear statistical edge.

### What To Do Each Round

**Immediately (first hour):**
1. Download data, add to `data/round{N}/`
2. Update position limits in backtester
3. Run EDA on new products (plot prices, spreads, autocorrelation)
4. Identify P3 analogs for each product
5. Port relevant P3 strategy, run backtest

**Next (hours 2–4):**
6. Look for bot patterns (Olivia, hidden takers, qty-15 trades)
7. Test structural edges (baskets→synthetic, options→IV smile)
8. Tune key parameters (spread width, skew rate, entry thresholds)
9. Run conservative backtest (`--match-trades worse`)

**Before submission:**
10. Strip unnecessary code (Logger stays, but remove debug prints)
11. Test import compatibility (try/except for server vs local)
12. Validate with `imc-prospector`
13. Submit and check server results
14. If server PnL << local PnL, investigate matching assumptions

### Things That Almost Never Work in Prosperity

Based on our P3 experience and FH's writeup:

| Approach | Why It Fails |
|----------|-------------|
| ML/deep learning on price prediction | Not enough data, overfits, no theoretical basis |
| Complex momentum indicators (MACD, RSI) | Prosperity prices don't follow real-market patterns |
| High-frequency signal exploitation | Predicted moves (0.3–0.5 XIRECs) are smaller than spread (6+) |
| Z-score normalization on baskets | Adds complexity without benefit when volatility is stable |
| Delta hedging options | Spread cost often exceeds expected delta loss |
| Aggressive directional bets | Inventory risk dominates unless you have a strong structural signal |
| Side suppression based on weak signals | Destroys more spread income than the signal recovers |

### Things That Almost Always Work

| Approach | Why It Works |
|----------|-------------|
| Market making at fair value | Spread capture is the dominant PnL source |
| Tactical taking (depth > 1) | Other bots only look at best bid/ask — sweep deeper |
| Penny jumping | Being best-in-book maximizes fill probability |
| Position management (skew, soft limits) | Reduces adverse selection, the #1 PnL killer |
| Structural arbitrage (baskets, conversions) | Mathematical edge, doesn't depend on prediction |
| Following informed bots (Olivia) | Proven pattern across P2 and P3, likely in P4 |
| Post-round analysis | Always reveals 2–3x more PnL than what was captured |

### External Resources

- **Official Platform**: https://prosperity.imc.com
- **P3 Backtester (jmerle)**: https://github.com/jmerle/imc-prosperity-3-backtester
- **P4 Backtester (kevin-fu1)**: https://github.com/kevin-fu1/imc-prosperity-4-backtester
- **Visualizer**: http://ctdash.xyz/vis/
- **Validator**: `pip install imc-prospector && imc-prospector algo.py`
- **FH Writeup**: `timo-writeup/README.md` (992 lines, extremely detailed)
- **Our P3 Writeup**: `readme.md` (in repo root)
- **P3 Round Code**: `ROUND 1/` through `ROUND5/` directories
- **Stanford Cardinal P2 Writeup**: Referenced by FH as source for bot pattern discovery
- **Jasper's P2 Writeup**: Referenced by FH as source for Olivia and hidden taker bot patterns
- **LinearUtility's P2 Writeup**: Referenced by FH (GitHub: ericcccsliu/imc-prosperity-2)
- **FH Competition Philosophy**: https://medium.com/@td.timodiehm/how-to-almost-win-against-thousands-of-other-teams-in-competitive-environments-bc31387e4b26

---

## 9. Operating Philosophy

> Source: Frankfurt Hedgehogs (2nd place, Prosperity 3) — "How to Almost Win Against Thousands of Other Teams in Competitive Environments"
> This is not optional reading. This is the operating system. Every decision, every experiment, every line of code must be filtered through these principles.

### Principle 1: Question Your Assumptions — Start With None

Do NOT assume the goal is "predict price direction." Do NOT assume standard trading strategies apply. Do NOT assume the market works like a real market. Ask: **what am I actually optimizing? What is actually within my control? What evidence do I have for every belief?**

In practice:
- Prosperity's price generation is often near-random. Forecasting effort is wasted.
- Success comes from understanding **liquidity dynamics and order fill mechanics**, not from better price predictions.
- Every "obvious" approach (MACD, z-scores, ML) is an assumption. Test it. If it doesn't survive first-principles scrutiny, kill it.
- The winning strategy is often "a completely different path" from what everyone else attempts.

**Before writing any code, ask: "What assumption am I making? What if it's wrong?"**

### Principle 2: Understand the Problem Deeper Than Anyone Else

"The most decisive advantages came not from better algorithms, but from better models of reality."

Replace assumptions with **measured ground truth**:
- Run controlled experiments on the server to understand bot behavior (we did this — probed fill rates, hidden takers, Poisson processes).
- Build tools that reveal what's actually happening (our submit.py, probe scripts, fill analysis).
- Study the simulation's mechanics: order matching, position limits, PnL calculation. Know EXACTLY how the engine works.
- Parse the data generation process: is this product stationary? Drifting? Mean-reverting? What drives the bots?

"Once you truly understand a problem, the solution becomes trivial."

Our tutorial round example: we probed the server, discovered the hidden taker bot, proved fills are Poisson with constant rate regardless of price, proved position naturally mean-reverts, and concluded the optimal strategy is dead simple — penny jump both sides, max size, no skew. Understanding the system made the solution obvious.

### Principle 3: Go the Extra Mile

Deep understanding doesn't happen by accident. It requires:
- **Preparation before the competition starts.** Build tools, study past competitions, read every public writeup.
- **Willingness to do work others won't.** Custom dashboards, automated submission pipelines, systematic probe experiments.
- **Persistence through dead ends.** We tested imbalance signals, order flow signals, cumulative pressure — all failed. That's not wasted work, that's eliminated assumptions.
- **Relentless iteration.** v1 → v2 → v3, each informed by new data, each tested on the server.

"Early preparation creates an edge that cannot be recovered later."

### How These Principles Apply to Every Decision

| Decision Point | Wrong Approach | Right Approach |
|---------------|---------------|---------------|
| New product appears | "Looks like X, use strategy Y" | Probe it. Measure spreads, fill rates, bot behavior. Understand first. |
| Strategy idea | "This should work because..." | "Does this work? Here's the experiment. Here's the data." |
| Parameter tuning | Grid search backtest scores | Understand WHY a parameter works. Derive it from fill distributions. |
| Post-round analysis | "We did well enough" | "What did we miss? What's the theoretical max? Where did PnL leak?" |
| Something fails | "Try a different approach" | "WHY did it fail? What does the failure teach us about the system?" |
| Competitor approaches | "They must know something" | "What assumptions are they making? Are those assumptions correct?" |

**This philosophy is not aspirational. It is mandatory. Every experiment in this repo exists because of these principles. Every strategy was derived from understanding, not guessing.**

---

## 10. Calibration Methodology — How We Reverse-Engineered the TOMATOES DGP

> This section documents the full methodology used to extract the true data-generating process for TOMATOES from 2 days of tutorial data + 1 server submission. Every step, every wrong turn, and every correction is recorded so the same process can be applied to new products in future rounds.

### The Core Philosophy: Occam's Razor + Relentless Conditioning

**Start with the simplest possible model. Test it. When it fails, ask WHY it fails, not what to add.** Every complication must earn its place by explaining a specific, measured discrepancy.

**Never look at marginal distributions.** Always condition on every known variable. A "uniform [2,12]" volume distribution is actually two processes (aggressive [5,12] + passive [2,6]) that only become visible when you condition on price relative to FV.

**Never trust eyeballed distributions.** When something looks 55/45 instead of 50/50, run the stat test. With n=242, a 55/45 split has p=0.14 — pure noise. Don't hardcode parameters from noise.

**Verify on held-out data.** Split by days. If a pattern only appears in 1 day, it's suspect. If it appears in all days, it's real.

### The Investigation (Chronological)

#### Phase 1: Is the fair value a random walk?

**Starting question**: Can we predict the direction of TOMATOES over the next 10-1000 timestamps?

**Tests run**:
1. Ljung-Box on returns at multiple horizons — detected serial correlation, but realized overlapping returns inflate this (artifact)
2. Book features → future return correlation — microprice deviation r=0.06 at k=10 (real but economically worthless against 13-tick spread)
3. Non-overlapping block returns (past k → future k) — the honest test. No signal on TOMATOES (2 days)
4. BDS test for nonlinear structure — zero (z ≈ 0 everywhere). Returns are i.i.d.
5. Out-of-sample directional accuracy — 50% ± noise on TOMATOES
6. Variance ratio at multiple horizons — drops to 0.6 and stays there

**Key bias from the user**: "Is it REALLY mean-reverting, or is that an artifact? Dig deeper." This pushed investigation of the wall_mid construction artifacts.

#### Phase 2: Compare TOMATOES to KELP (P3 analog)

**User's insight**: KELP had 8 unique days of data across P3, not 29 (most were duplicates across rounds). Forced thorough deduplication — hash the actual price data, check containment, check if round 6 short series are prefixes of full-length days.

**Result**: 8 unique KELP days. Non-overlapping r = -0.19 at k=20, pooled across all 8 days, p ≈ 0. KELP IS mean-reverting. TOMATOES (2 days) showed no signal.

**Key bias**: "You have WAY more KELP data — use it all." Also: "Use the rerun data for day 1." Forced careful reconstruction of the chronological data.

#### Phase 3: Is KELP's mean-reversion real or an artifact?

**User's challenge**: "Is this actually the FV, or just the order book construction?"

**Tests run**:
1. Discretization check — 77% of 1-step returns are zero (wall_mid is quantized to 0.5)
2. Book depth analysis — 24-32% of wall_mid moves happen when best_mid doesn't move (depth level appearing/disappearing)
3. Wall_mid vs best_mid comparison — best_mid shows STRONGER mean-reversion (r = -0.38 vs -0.13)

**User's correction**: "Wall mid IS our proxy for fair value. Best mid is NOT." The fact that best_mid shows more mean-reversion means it has more microstructure noise, not that the true FV is more mean-reverting.

**User's hypothesis**: "The FV the bots receive is quantized. When FV is near X.5, price fluctuates up and down by 1 — that's what we're seeing." This is the rounding boundary artifact.

#### Phase 4: Extract the true fair value

**User's key insight**: "If we buy 1 tomato and hold, the PnL over time IS the server's fair value."

**Experiment**: Submitted `trader_hold1.py` (buys 1 TOMATO at t=0, holds forever). Server PnL at each tick = `server_FV(t) - buy_price`.

**Discovery**: The server PnL values are fractional (like -6.24365234375) — NOT computed from the half-integer order book mid. The server uses a **continuous internal fair value**, quantized to 1/2048.

**Definitive test on the true FV**:
- ACF of FV returns: all within ±0.04. Zero serial correlation.
- Non-overlapping r: dead zero at every horizon (k=10: r=+0.005, k=20: r=+0.006)
- Variance ratio: 1.0 at all horizons. Textbook random walk.
- Returns: 1537 unique values out of 1998. Truly continuous Gaussian, σ=0.496, kurtosis=-0.08.

**Conclusion**: The true FV is a pure random walk. ALL mean-reversion in the wall_mid is from order book quantization.

#### Phase 5: Reverse-engineer the 3 bots

With the true FV in hand, decomposed the order book into 3 bots by offset distance from FV:

**Bot 1 (Wall, |offset| > 7)**: `bid = round(FV) - 8, ask = round(FV) + 8, vol = U(15,25)`. 96.8% exact match on both bid and ask. Misses (3.2%) are ±1 tick at the X.5 rounding boundary.

**Bot 2 (Inner, 4 < |offset| < 7.5)**: `bid = floor(FV+0.75)-7, ask = ceil(FV+0.25)+6, vol = U(5,10)`. 97.7% exact match. Key discovery: bid and ask round at DIFFERENT thresholds (0.25 and 0.75), not both at 0.5. This was wrong in the existing Rust sim.

**Bot 3 (Near-FV, |offset| ≤ 4)**: 6.3% presence, single-sided, 1 tick duration.

**Key user corrections during Bot 3 calibration**:

1. **"Did you condition volume on price?"** — No, and when we did, we found crossing orders (bid>FV, ask<FV) have vol U(5,12) while passive orders have vol U(2,6). A 2x difference invisible in the marginal.

2. **"Is the 46/54 bid/ask split real?"** — Stat test: p=0.47. No. It's 50/50.

3. **"Is the delta distribution really uniform?"** — Pooled chi²=1.43, p=0.70. Yes, uniform {-2,-1,0,+1}. But then...

4. **"Check on the tutorial data orderbook."** — With 1450 events (6x more data), the PER-SIDE distribution is NOT uniform (chi²=27-53, massively rejected). Bids favor negative offsets (passive), asks favor positive (passive). The POOLED distribution is uniform because the asymmetries cancel.

5. **"Is it 2/3 passive, 1/3 aggressive, then 50/50 within?"** — Yes, exactly. Passive/aggressive split: 65.9%/34.1% across 1450 events (matches 2/3:1/3 perfectly). Within-group splits: all 49-51% (matches 50/50). The 55/45 outlier in one cell? p=0.14 with n=242. Noise.

6. **"The Rust sim had WEIGHTED offsets — those were wrong?"** — Yes. The old weights were fit to the marginal per-side distribution without recognizing it's just uniform + passive/aggressive structure. We proved the underlying mechanism is simpler.

### The Biases That Guided Discovery

| User bias / question | What it forced | What we found |
|---|---|---|
| "Is it REALLY mean-reverting or artifact?" | Deep artifact analysis | Wall_mid mean-reversion is 100% quantization artifact on TOMATOES |
| "Use Occam's razor" | Simplest model first | FV = pure RW. Bots = round(FV) ± offset. That's it. |
| "What if the mean is just the original price?" | Test fixed-mean OU | Doesn't work — price drifts too far. But led to EWMA model. |
| "What if EWMA over last K timestamps?" | Calibrate EWMA-OU | Better fit but still wrong — real FV is just a RW |
| "Can we use PnL as the fair value?" | Hold-1-unit experiment | **THE breakthrough** — extracted true FV, proved RW, solved everything |
| "You didn't condition volume on price!" | Conditioning analysis | Found crossing vs passive vol split (2x difference) |
| "Is 46/54 really not 50/50?" | Binomial test | p=0.47, it's noise. Don't hardcode. |
| "Check on the tutorial data orderbook" | Larger sample analysis | Found 2/3-1/3 passive-aggressive structure that was invisible in n=125 |
| "Is it 2/3 passive, 1/3 aggressive?" | Clean model | Yes, exactly. Simplest model that explains all the data. |
| "What about the quantization the server uses?" | Check FV precision | 1/2048 — effectively continuous. Changed default from quarter to continuous. |
| "Use the Rust MC, not Python!" | Proper benchmarking | 100 sessions in seconds vs minutes. Server result z=-0.91. |

### Rules for Future Product Calibration

1. **Submit a hold-1-unit trader first.** Extract the true FV from PnL. This is step zero for any new product.
2. **Test if FV is a random walk.** ACF, non-overlapping r, variance ratio, BDS. If it's RW, stop looking for signals.
3. **Decompose the book by offset from FV.** Cluster into distinct bots by distance bands.
4. **For each bot, brute-force the quote formula.** Try every combination of floor/ceil/round(FV + shift) + offset.
5. **Condition everything on everything.** Volume | price. Volume | side. Volume | (side, price). Price | side.
6. **Stat-test every distribution.** Chi-squared for uniformity, z-test for proportions, Bonferroni for multiple tests.
7. **Use more data when available.** Tutorial orderbook has ~360 events/day vs ~125 from a single server submission. Use both.
8. **Validate the model.** Run MC at the correct number of steps. Compare to server. Z-score should be < 2.
