# Round 1 Calibration

This directory contains the first-pass reverse engineering for the Round 1
products:

- `ASH_COATED_OSMIUM`
- `INTARIAN_PEPPER_ROOT`

Method:

1. Use a hold-one submission log to recover the server's hidden fair value.
2. Condition visible book levels on true fair-value offset, not on raw mid.
3. Separate the book into outer wall, inner quote, and rare near-FV one-sided
   events.
4. Fit the simplest deterministic price rule that survives validation.
5. Only then summarize volume laws and presence behavior.

Repro script:

- `scripts/analyze_round1_products.py`

Product summaries:

- [ash_coated_osmium_calibration.md](./ash_coated_osmium_calibration.md)
- [intarian_pepper_root_calibration.md](./intarian_pepper_root_calibration.md)
