from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path


CASH_SYMBOL = "XIRECS"


def infer_probe_position(positions: list[dict]) -> tuple[str, int, float]:
    held_entries = [entry for entry in positions if entry["symbol"] != CASH_SYMBOL and entry["quantity"] > 0]
    if len(held_entries) != 1:
        raise ValueError(f"expected exactly one positive held product position, found {held_entries!r}")

    cash_entries = [entry for entry in positions if entry["symbol"] == CASH_SYMBOL]
    if len(cash_entries) != 1:
        raise ValueError(f"expected exactly one cash position, found {cash_entries!r}")

    product = held_entries[0]["symbol"]
    quantity = int(held_entries[0]["quantity"])
    cash_quantity = int(cash_entries[0]["quantity"])
    average_entry_price = -cash_quantity / quantity

    return product, quantity, average_entry_price


def main() -> None:
    parser = argparse.ArgumentParser(description="Recover hidden true price from a hold-one submission log JSON.")
    parser.add_argument("log_json", type=Path, help="Path to the submission log JSON.")
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional CSV output path. Defaults next to the input log with *_true_price.csv suffix.",
    )
    args = parser.parse_args()

    payload = json.loads(args.log_json.read_text())
    product, quantity, entry_price = infer_probe_position(payload["positions"])

    rows = list(csv.DictReader(io.StringIO(payload["activitiesLog"]), delimiter=";"))
    product_rows = [row for row in rows if row["product"] == product]
    if not product_rows:
        raise ValueError(f"did not find any activity rows for {product}")

    # The activity log row for the earliest timestamp is emitted before orders at
    # that timestamp are matched, so a hold-one probe has not been filled yet.
    first_timestamp = min(int(row["timestamp"]) for row in product_rows)

    output_path = args.output or args.log_json.with_name(f"{args.log_json.stem}_true_price.csv")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "timestamp",
                "product",
                "visible_mid_price",
                "profit_and_loss",
                "derived_true_price",
                "best_bid",
                "best_ask",
                "true_minus_mid",
            ],
        )
        writer.writeheader()

        for row in product_rows:
            timestamp = int(row["timestamp"])
            if timestamp == first_timestamp:
                continue

            pnl = float(row["profit_and_loss"])
            mid_price = float(row["mid_price"])
            true_price = entry_price + pnl / quantity
            writer.writerow(
                {
                    "timestamp": timestamp,
                    "product": product,
                    "visible_mid_price": row["mid_price"],
                    "profit_and_loss": row["profit_and_loss"],
                    "derived_true_price": f"{true_price:.12f}",
                    "best_bid": row["bid_price_1"],
                    "best_ask": row["ask_price_1"],
                    "true_minus_mid": f"{(true_price - mid_price):.12f}",
                }
            )

    print(f"product={product}")
    print(f"quantity={quantity}")
    print(f"average_entry_price={entry_price:.12f}")
    print(f"wrote={output_path}")


if __name__ == "__main__":
    main()
