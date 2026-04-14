# INTARIAN_PEPPER_ROOT Calibration

## Inputs

- Hold-one submission log: `~/Downloads/Root/113602.json`
- True price reconstruction: `true_price_t = 12006 + pnl_t`
  - `12006` is inferred from the cash leg in the final positions.
  - The first activity row is pre-fill, so valid hidden-price points start at
    `t=100`.

## Hidden Fair Value

This product is much simpler than osmium.

Recovered fair value is:

```python
FV(t) = 12000 + t / 1000
```

up to the server's `1/1024` style floating-point grid. Validation against the
recovered path gives max absolute error `0.000390625`.

Interpretation:

- the server mark is a deterministic linear ramp
- no stochastic fair-value model is needed here for the held-out day

## Outer Wall

Conditional on a visible level with `8.5 < |price - FV| < 10.5`:

```python
bid = ceil(FV) - 10
ask = floor(FV) + 10
vol = randint(15, 25)   # same value on both sides when both sides are present
```

Validation on extracted wall events:

- bid match: `804 / 804` (`100.0%`)
- ask match: `795 / 796` (`99.9%`)
- both match: `639 / 640` (`99.8%`)
- spreads: `19` on `573` rows, `20` on `67` rows
- volume support: `15..25`
- uniformity check over `15..25`: chi-squared `15.84` (consistent with uniform)
- bid / ask volume equality on same tick: `640 / 640`

## Inner Quote

Conditional on a visible level with `5.5 < |price - FV| < 7.5`:

```python
bid = ceil(FV) - 7
ask = floor(FV) + 7
vol = randint(8, 12)    # same value on both sides when both sides are present
```

Validation on extracted inner-layer events:

- bid match: `807 / 807` (`100.0%`)
- ask match: `772 / 773` (`99.9%`)
- both match: `618 / 619` (`99.8%`)
- spreads: `13` on `555` rows, `14` on `64` rows
- volume support: `8..12`
- uniformity check over `8..12`: chi-squared `7.08` (consistent with uniform)
- bid / ask volume equality on same tick: `619 / 619`

This is a clean `ceil` / `floor` architecture:

- when `FV` is non-integer, `ceil(FV) - floor(FV) = 1`, so spreads narrow to
  `13` and `19`
- when `FV` is integer, spreads widen to `14` and `20`

## Near-FV One-Sided Bot

This bot is rarer than the osmium near-FV bot and more asymmetric.

Observed behavior:

- presence: `45 / 999` timestamps (`4.5%`)
- events: `45` total
- side split: `21` bid, `24` ask
- run lengths: `37` runs of length `1`, `4` runs of length `2`

The side-conditioned rule is:

```python
# passive quotes are larger
passive_bid = round(FV) - 3   # vol about 5..12
passive_ask = round(FV) + 2   # vol about 5..12

# aggressive quotes are smaller
aggressive_bid = round(FV) + 3   # occasional +4 boundary noise
aggressive_ask = round(FV) - 4
vol = randint(3, 8) if aggressive else randint(5, 12)
```

Observed conditional deltas:

- passive ask: `round(FV) + 2` on `11 / 11`
- aggressive ask: `round(FV) - 4` on `13 / 13`
- passive bid: `round(FV) - 3` on `8 / 8`
- aggressive bid: `round(FV) + 3` on `11 / 13`, with `+4` on the remaining `2`

This is precise enough to simulate, but it is less elegant than the inner and
outer layers and should still be treated as provisional.

## Open Question

As with osmium, the inner and outer layers are often only partially visible.
The price laws are essentially exact conditional on visibility, but the
side-presence process is not yet fully modeled.
