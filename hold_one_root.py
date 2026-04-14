"""
Buy exactly one INTARIAN_PEPPER_ROOT, then hold it for the rest of the replay.

This is a fair-value probe. Once the entry fill happens, the per-product PnL
path on backtest day is:

    pnl_t = fair_t - entry_price

So after you know the entry price, you can reconstruct the backtester mark as:

    fair_t = entry_price + pnl_t
"""

try:
    from datamodel import Order, TradingState
except ImportError:
    try:
        from prosperity3bt.datamodel import Order, TradingState
    except ImportError:
        from prosperity4mcbt.datamodel import Order, TradingState


PRODUCT = "INTARIAN_PEPPER_ROOT"
TARGET_POSITION = 1


class Trader:
    def run(self, state: TradingState):
        orders = {product: [] for product in state.order_depths}
        conversions = 0
        trader_data = ""

        position = state.position.get(PRODUCT, 0)
        if position >= TARGET_POSITION:
            return orders, conversions, trader_data

        order_depth = state.order_depths.get(PRODUCT)
        if order_depth is None or not order_depth.sell_orders:
            return orders, conversions, trader_data

        best_ask = min(order_depth.sell_orders)
        visible_volume = abs(order_depth.sell_orders[best_ask])
        buy_quantity = min(TARGET_POSITION - position, visible_volume)

        if buy_quantity > 0:
            # Cross the visible best ask so we get the probe position as soon as possible.
            orders[PRODUCT] = [Order(PRODUCT, best_ask, buy_quantity)]

        return orders, conversions, trader_data
