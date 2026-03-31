from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
ACTOR_CANDIDATES_PATH = ROOT / 'prosperity-analysis' / 'hidden_trader_detector' / 'outputs' / 'actor_candidates.csv'
ACTOR_EVENTS_PATH = ROOT / 'prosperity-analysis' / 'hidden_trader_detector' / 'outputs' / 'actor_event_streams.csv'
OUTPUT_PATH = ROOT / 'imc-prosperity-3-visualizer' / 'public' / 'prosperity-3-round-1' / 'actor_archetypes.json'
ROUND_VALUE = 1


def _as_float(value: Any, default: float = 0.0) -> float:
    if value is None:
        return default

    if isinstance(value, str) and value.strip() == '':
        return default

    if pd.isna(value):
        return default

    return float(value)


def _as_int(value: Any, default: int = 0) -> int:
    if value is None:
        return default

    if isinstance(value, str) and value.strip() == '':
        return default

    if pd.isna(value):
        return default

    return int(float(value))


def _split_list(value: Any) -> list[str]:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return []

    if isinstance(value, str):
        return [item.strip() for item in value.split(';') if item.strip()]

    return [str(value)]


def _flow_style_label(dense_share: float, sparse_share: float, both_share: float) -> str:
    if dense_share >= 0.7:
        return 'dense recurring'

    if sparse_share >= 0.7:
        return 'sparse context'

    if both_share >= 0.22 or (dense_share >= 0.18 and sparse_share >= 0.18):
        return 'reinforced mix'

    return 'mixed'


def _directional_label(buy_low_strength: float, sell_high_strength: float) -> str:
    if buy_low_strength >= 0.2 and sell_high_strength >= 0.2:
        return 'two-sided swing'

    if sell_high_strength > buy_low_strength + 0.1:
        return 'sell-the-rips'

    if buy_low_strength > sell_high_strength + 0.1:
        return 'buy-the-dips'

    return 'mixed directional'


def _conviction_band(score: float, q50: float, q80: float) -> str:
    if score >= q80:
        return 'high conviction'

    if score >= q50:
        return 'watchlist'

    return 'speculative'


def _profitability_band(score: float, q50: float, q80: float) -> str:
    if score >= q80:
        return 'top earner'

    if score >= q50:
        return 'positive edge'

    return 'thin edge'


def _edge_band(score: float, q50: float, q80: float) -> str:
    if score >= q80:
        return 'elite edge'

    if score >= q50:
        return 'positive edge'

    return 'modest edge'


def _days_text(days: list[int]) -> str:
    if not days:
        return 'unknown sessions'

    if len(days) == 1:
        return f'Day {days[0]}'

    return ', '.join(f'Day {day}' for day in days[:-1]) + f' and Day {days[-1]}'


def _natural_language_summary(
    product: str,
    size_family: str,
    flow_style: str,
    directional_label: str,
    round1_event_count: int,
    active_days: list[int],
    origin_shares: dict[str, float],
) -> str:
    flow_text = {
        'dense recurring': f'a dense recurring {size_family}-size stream',
        'sparse context': f'a sparse, context-triggered {size_family}-size stream',
        'reinforced mix': f'a reinforced {size_family}-size stream backed by both recurring and contextual flags',
        'mixed': f'a mixed {size_family}-size stream',
    }[flow_style]

    direction_text = {
        'two-sided swing': 'It tends to buy lows and recycle risk into highs rather than staying one-way.',
        'sell-the-rips': 'It leans toward selling strength and showing up near local or session highs.',
        'buy-the-dips': 'It leans toward buying weakness and showing up near local or session lows.',
        'mixed directional': 'It is directionally mixed, so the repeated setup matters more than pure side bias.',
    }[directional_label]

    origin_parts = []
    if origin_shares.get('sparse_context', 0.0) >= 0.65:
        origin_parts.append('Most of its flags are coming from the sparse-context path.')
    elif origin_shares.get('dense_flow', 0.0) >= 0.65:
        origin_parts.append('Most of its flags are coming from the dense recurring-flow path.')
    elif origin_shares.get('both', 0.0) >= 0.15:
        origin_parts.append('A meaningful chunk of its events are confirmed by both detector paths.')

    activity_text = (
        'It is persistent enough to keep on-screen continuously.'
        if round1_event_count >= 120
        else 'It is active enough to keep on the watchlist.'
        if round1_event_count >= 20
        else 'It is sparse, so each event matters more as a setup than as constant background flow.'
    )

    parts = [
        f'This looks like {flow_text} in {product}.',
        direction_text,
        f'It fired {round1_event_count} flagged times across {_days_text(active_days)} in Round 1.',
        activity_text,
    ]
    parts.extend(origin_parts)
    return ' '.join(parts)


def _serialize_recent_events(group: pd.DataFrame) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ordered = group.sort_values(['day', 'timestamp', 'price']).copy()
    series = []
    recent = []

    for row in ordered.itertuples():
        x_value = (_as_int(row.day) + 2) * 1_100_000 + _as_int(row.timestamp)
        item = {
            'x': x_value,
            'day': _as_int(row.day),
            'timestamp': _as_int(row.timestamp),
            'direction': 'buy' if _as_int(row.predicted_direction) > 0 else 'sell',
            'origin': str(row.candidate_origin),
            'quantity': _as_int(row.quantity),
            'price': _as_float(row.price),
            'fingerprintKey': str(row.fingerprint_key),
        }
        series.append(item)

    for item in reversed(series[-12:]):
        recent.append(item)

    return series, recent


def build_payload() -> dict[str, Any]:
    actor_candidates = pd.read_csv(ACTOR_CANDIDATES_PATH, low_memory=False)
    actor_events = pd.read_csv(ACTOR_EVENTS_PATH, low_memory=False)

    round_events = actor_events[
        (actor_events['assembly_scope'] == 'anonymous') & (actor_events['round'] == ROUND_VALUE)
    ].copy()
    round_actor_ids = set(round_events['actor_id'].dropna().astype(str))
    round_candidates = actor_candidates[
        (actor_candidates['assembly_scope'] == 'anonymous') & (actor_candidates['actor_id'].astype(str).isin(round_actor_ids))
    ].copy()

    event_count_cap = float(round_events.groupby('actor_id').size().quantile(0.75))
    day_count_total = max(round_events['day'].nunique(), 1)

    actor_rows: list[dict[str, Any]] = []
    for row in round_candidates.itertuples():
        actor_id = str(row.actor_id)
        actor_group = round_events[round_events['actor_id'] == actor_id].copy()
        if actor_group.empty:
            continue

        round1_event_count = len(actor_group)
        active_days = sorted(int(day) for day in actor_group['day'].dropna().astype(int).unique().tolist())
        day_counts = (
            actor_group.groupby('day')
            .size()
            .sort_index()
            .items()
        )
        origin_counts = actor_group['candidate_origin'].fillna('unknown').value_counts().to_dict()
        direction_counts = {
            'buy': int((actor_group['predicted_direction'] > 0).sum()),
            'sell': int((actor_group['predicted_direction'] < 0).sum()),
        }
        origin_shares = {
            origin: count / round1_event_count
            for origin, count in origin_counts.items()
        }
        direction_shares = {
            key: value / round1_event_count
            for key, value in direction_counts.items()
        }
        directional_forward_bps = actor_group["predicted_direction"] * actor_group["forward_return_bps_2000"]
        profitability_proxy_bps = float(directional_forward_bps.sum())
        profitable_event_share = float((directional_forward_bps > 0).mean()) if round1_event_count else 0.0
        dense_share = origin_shares.get('dense_flow', 0.0)
        sparse_share = origin_shares.get('sparse_context', 0.0)
        both_share = origin_shares.get('both', 0.0)
        flow_style = _flow_style_label(dense_share, sparse_share, both_share)
        buy_low_strength = _as_float(row.buy_low_strength)
        sell_high_strength = _as_float(row.sell_high_strength)
        directional_label = _directional_label(buy_low_strength, sell_high_strength)
        activity_ratio = min(1.0, round1_event_count / event_count_cap) if event_count_cap else 0.0
        day_ratio = len(active_days) / day_count_total
        presence_score = 0.65 * activity_ratio + 0.35 * day_ratio
        round1_conviction_score = _as_float(row.overall_actor_score) * (0.2 + 0.8 * presence_score)
        event_series, recent_events = _serialize_recent_events(actor_group)

        actor_rows.append(
            {
                'actorId': actor_id,
                'product': str(row.symbols),
                'description': str(row.dominant_pattern_description),
                'naturalLanguageSummary': _natural_language_summary(
                    product=str(row.symbols),
                    size_family=str(row.dominant_size_family),
                    flow_style=flow_style,
                    directional_label=directional_label,
                    round1_event_count=round1_event_count,
                    active_days=active_days,
                    origin_shares=origin_shares,
                ),
                'dominantDirectionLabel': directional_label,
                'flowStyleLabel': flow_style,
                'sizeFamily': str(row.dominant_size_family),
                'sizeKeys': _split_list(row.dominant_size_keys),
                'medianQuantity': _as_float(row.median_quantity),
                'round1ConvictionScore': round(round1_conviction_score, 6),
                'overallActorScore': round(_as_float(row.overall_actor_score), 6),
                'round1EventCount': round1_event_count,
                'round1ActiveDays': active_days,
                'round1DayBreakdown': [{'day': int(day), 'eventCount': int(count)} for day, count in day_counts],
                'memberFingerprints': _as_int(row.member_fingerprints),
                'memberFingerprintKeys': _split_list(row.member_fingerprint_keys),
                'directionCounts': direction_counts,
                'directionShares': direction_shares,
                'originCounts': origin_counts,
                'originShares': origin_shares,
                'buyLowStrength': round(buy_low_strength, 6),
                'sellHighStrength': round(sell_high_strength, 6),
                'sessionExtremaFraction': round(_as_float(row.session_extrema_fraction), 6),
                'localExtremaFraction': round(_as_float(row.local_extrema_fraction), 6),
                'forwardReturnBps2000': round(_as_float(row.mean_forward_return_bps_2000), 6),
                'hitRate2000': round(_as_float(row.hit_rate_2000), 6),
                'profitabilityProxyBps2000': round(profitability_proxy_bps, 6),
                'profitableEventShare': round(profitable_event_share, 6),
                'scoreBreakdown': {
                    'coherence': round(_as_float(row.coherence_score), 6),
                    'persistence': round(_as_float(row.persistence_score), 6),
                    'edge': round(_as_float(row.edge_score), 6),
                    'recency': round(_as_float(row.recency_score), 6),
                    'contradiction': round(_as_float(row.contradiction_score), 6),
                    'fragmentationPenalty': round(_as_float(row.fragmentation_penalty), 6),
                },
                'latestDay': _as_int(actor_group['day'].max()),
                'latestTimestamp': _as_int(actor_group['timestamp'].max()),
                'eventSeries': event_series,
                'recentEvents': recent_events,
            }
        )

    actor_rows.sort(key=lambda item: (-item['round1ConvictionScore'], -item['round1EventCount'], item['actorId']))
    q50 = pd.Series([row['round1ConvictionScore'] for row in actor_rows]).quantile(0.5) if actor_rows else 0.0
    q80 = pd.Series([row['round1ConvictionScore'] for row in actor_rows]).quantile(0.8) if actor_rows else 0.0
    profitability_q50 = pd.Series([row['profitabilityProxyBps2000'] for row in actor_rows]).quantile(0.5) if actor_rows else 0.0
    profitability_q80 = pd.Series([row['profitabilityProxyBps2000'] for row in actor_rows]).quantile(0.8) if actor_rows else 0.0
    edge_q50 = pd.Series([row['forwardReturnBps2000'] for row in actor_rows]).quantile(0.5) if actor_rows else 0.0
    edge_q80 = pd.Series([row['forwardReturnBps2000'] for row in actor_rows]).quantile(0.8) if actor_rows else 0.0

    for rank, actor in enumerate(actor_rows, start=1):
        actor['rank'] = rank
        actor['convictionBand'] = _conviction_band(actor['round1ConvictionScore'], q50, q80)

    profitability_sorted = sorted(
        actor_rows,
        key=lambda item: (-item['profitabilityProxyBps2000'], -item['forwardReturnBps2000'], item['actorId']),
    )

    for rank, actor in enumerate(profitability_sorted, start=1):
        actor['profitabilityRank'] = rank
        actor['profitabilityBand'] = _profitability_band(actor['profitabilityProxyBps2000'], profitability_q50, profitability_q80)

    edge_sorted = sorted(
        actor_rows,
        key=lambda item: (-item['forwardReturnBps2000'], -item['hitRate2000'], item['actorId']),
    )

    for rank, actor in enumerate(edge_sorted, start=1):
        actor['edgePerEventRank'] = rank
        actor['edgePerEventBand'] = _edge_band(actor['forwardReturnBps2000'], edge_q50, edge_q80)

    product_summary = []
    for product, product_group in round_events.groupby('symbol'):
        actor_count = int(product_group['actor_id'].nunique())
        product_summary.append(
            {
                'product': str(product),
                'actorCount': actor_count,
                'eventCount': int(len(product_group)),
                'topActorId': next((actor['actorId'] for actor in actor_rows if actor['product'] == product), None),
            }
        )

    product_summary.sort(key=lambda item: (-item['eventCount'], item['product']))

    return {
        'round': ROUND_VALUE,
        'scope': 'anonymous',
        'summary': {
            'actorCount': len(actor_rows),
            'eventCount': int(len(round_events)),
            'products': product_summary,
            'days': sorted(int(day) for day in round_events['day'].dropna().astype(int).unique().tolist()),
            'topConvictionActorId': actor_rows[0]['actorId'] if actor_rows else None,
            'topProfitabilityActorId': profitability_sorted[0]['actorId'] if actor_rows else None,
            'topEdgeActorId': edge_sorted[0]['actorId'] if actor_rows else None,
        },
        'actors': actor_rows,
    }


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = build_payload()
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2), encoding='utf-8')
    print(f'Wrote {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
