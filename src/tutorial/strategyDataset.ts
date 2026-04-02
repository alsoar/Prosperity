import { Algorithm, Order, Product, ProsperitySymbol, Trade } from '../models.ts';
import { parseTutorialDataset, SessionFileSet } from './parser.ts';
import { TutorialDataset } from './types.ts';

export interface StrategyOrderEvent {
  timestamp: number;
  price: number;
  quantity: number;
  side: 'bid' | 'ask';
}

export interface StrategyTradeEvent {
  timestamp: number;
  price: number;
  quantity: number;
  side: 'buy' | 'sell' | 'unknown';
  buyer: string;
  seller: string;
  counterpart: string | null;
  source: 'own' | 'fill-match';
}

export interface StrategyPositionPoint {
  timestamp: number;
  position: number;
}

export interface StrategyProductOverlay {
  product: string;
  orderEvents: StrategyOrderEvent[];
  ownTradeEvents: StrategyTradeEvent[];
  fillMatchEvents: StrategyTradeEvent[];
  positionSeries: StrategyPositionPoint[];
}

export interface StrategySessionOverlay {
  sessionId: string;
  label: string;
  day: number;
  products: Record<string, StrategyProductOverlay>;
}

export interface StrategyDatasetResult {
  dataset: TutorialDataset;
  overlaysBySessionId: Record<string, StrategySessionOverlay>;
  sourceLabel: string;
  supportsOrders: boolean;
  supportsOwnTrades: boolean;
}

const PRICE_HEADER =
  'day;timestamp;product;bid_price_1;bid_volume_1;bid_price_2;bid_volume_2;bid_price_3;bid_volume_3;ask_price_1;ask_volume_1;ask_price_2;ask_volume_2;ask_price_3;ask_volume_3;mid_price;profit_and_loss';
const TRADE_HEADER = 'timestamp;buyer;seller;symbol;currency;price;quantity';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueDaysInOrder(algorithm: Algorithm): number[] {
  const days: number[] = [];
  const seen = new Set<number>();

  algorithm.activityLogs.forEach(row => {
    if (!seen.has(row.day)) {
      seen.add(row.day);
      days.push(row.day);
    }
  });

  return days;
}

function inferDataRowDays(algorithm: Algorithm): number[] {
  const orderedDays = uniqueDaysInOrder(algorithm);
  if (orderedDays.length === 0) {
    return algorithm.data.map(() => 0);
  }

  let currentDayIndex = 0;
  let previousTimestamp = -Infinity;

  return algorithm.data.map(row => {
    if (row.state.timestamp < previousTimestamp && currentDayIndex < orderedDays.length - 1) {
      currentDayIndex += 1;
    }

    previousTimestamp = row.state.timestamp;
    return orderedDays[currentDayIndex];
  });
}

function serializeActivityLogRowsForDay(algorithm: Algorithm, day: number): string {
  const lines = algorithm.activityLogs
    .filter(row => row.day === day)
    .map(row => {
      const bidPrices = [row.bidPrices[0] ?? '', row.bidPrices[1] ?? '', row.bidPrices[2] ?? ''];
      const bidVolumes = [row.bidVolumes[0] ?? '', row.bidVolumes[1] ?? '', row.bidVolumes[2] ?? ''];
      const askPrices = [row.askPrices[0] ?? '', row.askPrices[1] ?? '', row.askPrices[2] ?? ''];
      const askVolumes = [row.askVolumes[0] ?? '', row.askVolumes[1] ?? '', row.askVolumes[2] ?? ''];

      return [
        row.day,
        row.timestamp,
        row.product,
        bidPrices[0],
        bidVolumes[0],
        bidPrices[1],
        bidVolumes[1],
        bidPrices[2],
        bidVolumes[2],
        askPrices[0],
        askVolumes[0],
        askPrices[1],
        askVolumes[1],
        askPrices[2],
        askVolumes[2],
        row.midPrice,
        row.profitLoss,
      ].join(';');
    });

  return [PRICE_HEADER, ...lines].join('\n');
}

function buildListingDenominations(algorithm: Algorithm): Record<ProsperitySymbol, Product> {
  const denominations: Record<ProsperitySymbol, Product> = {};

  algorithm.data.forEach(row => {
    Object.values(row.state.listings).forEach(listing => {
      if (!denominations[listing.symbol]) {
        denominations[listing.symbol] = listing.denomination;
      }
    });
  });

  return denominations;
}

function flattenUniqueTradesFromState(
  algorithm: Algorithm,
  inferredDays: number[],
  source: 'marketTrades' | 'ownTrades',
): Map<number, Trade[]> {
  const tradesByDay = new Map<number, Map<string, Trade>>();

  algorithm.data.forEach((row, rowIndex) => {
    const day = inferredDays[rowIndex] ?? 0;
    const dayMap = tradesByDay.get(day) ?? new Map<string, Trade>();
    const tradeMap = row.state[source];

    Object.entries(tradeMap).forEach(([symbol, trades]) => {
      trades.forEach(trade => {
        const key = [symbol, trade.timestamp, trade.price, trade.quantity, trade.buyer, trade.seller].join('|');
        dayMap.set(key, trade);
      });
    });

    tradesByDay.set(day, dayMap);
  });

  return new Map(
    [...tradesByDay.entries()].map(([day, tradeMap]) => [
      day,
      [...tradeMap.values()].sort((left, right) => left.timestamp - right.timestamp || left.price - right.price),
    ]),
  );
}

function serializeMarketTradesForDay(trades: Trade[], denominations: Record<ProsperitySymbol, Product>): string {
  const lines = trades.map(trade =>
    [trade.timestamp, trade.buyer, trade.seller, trade.symbol, denominations[trade.symbol] ?? 'SEASHELLS', trade.price, trade.quantity].join(
      ';',
    ),
  );

  return [TRADE_HEADER, ...lines].join('\n');
}

function inferTradeSide(
  trade: Trade,
  orders: Order[],
  midPrice: number | null,
): 'buy' | 'sell' | 'unknown' {
  const buyer = trade.buyer.trim().toUpperCase();
  const seller = trade.seller.trim().toUpperCase();

  if (buyer === 'SUBMISSION') {
    return 'buy';
  }

  if (seller === 'SUBMISSION') {
    return 'sell';
  }

  const matchingOrder = orders.find(order => order.symbol === trade.symbol && order.price === trade.price);
  if (matchingOrder) {
    return matchingOrder.quantity > 0 ? 'buy' : 'sell';
  }

  if (midPrice !== null) {
    if (trade.price > midPrice) {
      return 'buy';
    }

    if (trade.price < midPrice) {
      return 'sell';
    }
  }

  return 'unknown';
}

function buildMidPriceLookup(algorithm: Algorithm): Map<string, number> {
  const lookup = new Map<string, number>();

  algorithm.activityLogs.forEach(row => {
    lookup.set([row.day, row.timestamp, row.product].join('|'), row.midPrice);
  });

  return lookup;
}

function getCounterparty(trade: Trade, side: 'buy' | 'sell' | 'unknown'): string | null {
  if (side === 'buy') {
    return trade.seller || null;
  }

  if (side === 'sell') {
    return trade.buyer || null;
  }

  return trade.buyer || trade.seller || null;
}

function buildStrategyOverlay(
  algorithm: Algorithm,
  inferredDays: number[],
  sessionIdsByDay: Map<number, string>,
): Record<string, StrategySessionOverlay> {
  const overlays = new Map<string, StrategySessionOverlay>();
  const midPriceLookup = buildMidPriceLookup(algorithm);
  const marketTradesByDay = flattenUniqueTradesFromState(algorithm, inferredDays, 'marketTrades');

  const matchedFillKeys = new Set<string>();

  algorithm.data.forEach((row, rowIndex) => {
    const day = inferredDays[rowIndex] ?? 0;
    const sessionId = sessionIdsByDay.get(day);
    if (!sessionId) {
      return;
    }

    const sessionOverlay =
      overlays.get(sessionId) ??
      {
        sessionId,
        label: `Backtest · Day ${day}`,
        day,
        products: {},
      };

    const products = new Set<string>([
      ...Object.keys(row.state.orderDepths),
      ...Object.keys(row.orders),
      ...Object.keys(row.state.ownTrades),
      ...Object.keys(row.state.marketTrades),
      ...Object.keys(row.state.position),
    ]);

    products.forEach(product => {
      const productOverlay =
        sessionOverlay.products[product] ??
        {
          product,
          orderEvents: [],
          ownTradeEvents: [],
          fillMatchEvents: [],
          positionSeries: [],
        };

      const orderEvents = row.orders[product] ?? [];
      orderEvents.forEach(order => {
        productOverlay.orderEvents.push({
          timestamp: row.state.timestamp,
          price: order.price,
          quantity: Math.abs(order.quantity),
          side: order.quantity >= 0 ? 'bid' : 'ask',
        });
      });

      const positionValue = row.state.position[product];
      if (positionValue !== undefined) {
        const previousPoint = productOverlay.positionSeries[productOverlay.positionSeries.length - 1];
        if (!previousPoint || previousPoint.timestamp !== row.state.timestamp || previousPoint.position !== positionValue) {
          productOverlay.positionSeries.push({
            timestamp: row.state.timestamp,
            position: positionValue,
          });
        }
      }

      const ownTrades = row.state.ownTrades[product] ?? [];
      const midPrice = midPriceLookup.get([day, row.state.timestamp, product].join('|')) ?? null;
      const marketTradesForDay = marketTradesByDay.get(day) ?? [];

      ownTrades.forEach(trade => {
        const side = inferTradeSide(trade, orderEvents, midPrice);
        const ownTradeKey = ['own', day, product, trade.timestamp, trade.price, trade.quantity, trade.buyer, trade.seller].join('|');

        if (!productOverlay.ownTradeEvents.some(event => ['own', day, product, event.timestamp, event.price, event.quantity, event.buyer, event.seller].join('|') === ownTradeKey)) {
          productOverlay.ownTradeEvents.push({
            timestamp: trade.timestamp,
            price: trade.price,
            quantity: trade.quantity,
            side,
            buyer: trade.buyer,
            seller: trade.seller,
            counterpart: getCounterparty(trade, side),
            source: 'own',
          });
        }

        marketTradesForDay
          .filter(
            marketTrade =>
              marketTrade.symbol === product &&
              marketTrade.timestamp === trade.timestamp &&
              marketTrade.price === trade.price,
          )
          .forEach(marketTrade => {
            const fillKey = ['fill', day, product, marketTrade.timestamp, marketTrade.price, marketTrade.quantity, marketTrade.buyer, marketTrade.seller].join('|');
            if (matchedFillKeys.has(fillKey)) {
              return;
            }

            matchedFillKeys.add(fillKey);
            productOverlay.fillMatchEvents.push({
              timestamp: marketTrade.timestamp,
              price: marketTrade.price,
              quantity: marketTrade.quantity,
              side,
              buyer: marketTrade.buyer,
              seller: marketTrade.seller,
              counterpart: marketTrade.buyer || marketTrade.seller || null,
              source: 'fill-match',
            });
          });
      });

      sessionOverlay.products[product] = productOverlay;
    });

    overlays.set(sessionId, sessionOverlay);
  });

  return Object.fromEntries(
    [...overlays.entries()].map(([sessionId, overlay]) => [
      sessionId,
      {
        ...overlay,
        products: Object.fromEntries(
          Object.entries(overlay.products).map(([product, productOverlay]) => [
            product,
            {
              ...productOverlay,
              orderEvents: productOverlay.orderEvents.sort((left, right) => left.timestamp - right.timestamp || left.price - right.price),
              ownTradeEvents: productOverlay.ownTradeEvents.sort(
                (left, right) => left.timestamp - right.timestamp || left.price - right.price,
              ),
              fillMatchEvents: productOverlay.fillMatchEvents.sort(
                (left, right) => left.timestamp - right.timestamp || left.price - right.price,
              ),
              positionSeries: productOverlay.positionSeries.sort((left, right) => left.timestamp - right.timestamp),
            },
          ]),
        ),
      },
    ]),
  );
}

export function buildStrategyDataset(
  algorithm: Algorithm,
  sourceLabel: string = algorithm.summary?.fileName ?? 'strategy log',
): StrategyDatasetResult {
  const days = uniqueDaysInOrder(algorithm);
  const inferredDays = inferDataRowDays(algorithm);
  const denominations = buildListingDenominations(algorithm);
  const marketTradesByDay = flattenUniqueTradesFromState(algorithm, inferredDays, 'marketTrades');

  const sessionIdsByDay = new Map<number, string>();
  const fileSets: SessionFileSet[] = days.map(day => {
    const sessionId = `strategy-${slugify(sourceLabel)}-day-${day}`;
    sessionIdsByDay.set(day, sessionId);

    return {
      id: sessionId,
      label: `Backtest · Day ${day}`,
      priceFile: sourceLabel,
      tradeFile: sourceLabel,
      pricesText: serializeActivityLogRowsForDay(algorithm, day),
      tradesText: serializeMarketTradesForDay(marketTradesByDay.get(day) ?? [], denominations),
    };
  });

  const overlaysBySessionId = buildStrategyOverlay(algorithm, inferredDays, sessionIdsByDay);
  const overlayProducts = Object.values(overlaysBySessionId).flatMap(session => Object.values(session.products));

  return {
    dataset: parseTutorialDataset(fileSets, {
      title: 'Backtest Market Replay',
      source: `Derived from ${sourceLabel}`,
    }),
    overlaysBySessionId,
    sourceLabel,
    supportsOrders: overlayProducts.some(product => product.orderEvents.length > 0),
    supportsOwnTrades: overlayProducts.some(product => product.ownTradeEvents.length > 0),
  };
}
