import {
  BookLevel,
  TutorialDataset,
  TutorialProductData,
  TutorialSession,
  TutorialSnapshot,
  TutorialTrade,
} from './types.ts';

interface RawPriceRow {
  day: number;
  timestamp: number;
  product: string;
  bids: BookLevel[];
  asks: BookLevel[];
  midPrice: number;
  profitLoss: number;
}

interface RawTradeRow {
  timestamp: number;
  buyer: string | null;
  seller: string | null;
  symbol: string;
  currency: string;
  price: number;
  quantity: number;
}

interface SessionFileSet {
  id: string;
  label: string;
  priceFile: string;
  tradeFile: string;
  pricesText: string;
  tradesText: string;
}

const WALL_HISTORY = 40;

function parseCsv(text: string): string[][] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => line.split(';'));
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }

  return Number(value);
}

function parsePriceCsv(text: string): RawPriceRow[] {
  const rows = parseCsv(text);

  return rows.slice(1).map(columns => {
    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];

    for (let level = 0; level < 3; level++) {
      const bidPrice = parseOptionalNumber(columns[3 + level * 2]);
      const bidVolume = parseOptionalNumber(columns[4 + level * 2]);
      const askPrice = parseOptionalNumber(columns[9 + level * 2]);
      const askVolume = parseOptionalNumber(columns[10 + level * 2]);

      if (bidPrice !== null && bidVolume !== null) {
        bids.push({ price: bidPrice, volume: bidVolume });
      }

      if (askPrice !== null && askVolume !== null) {
        asks.push({ price: askPrice, volume: askVolume });
      }
    }

    return {
      day: Number(columns[0]),
      timestamp: Number(columns[1]),
      product: columns[2],
      bids,
      asks,
      midPrice: Number(columns[15]),
      profitLoss: Number(columns[16]),
    };
  });
}

function parseTradeCsv(text: string): RawTradeRow[] {
  const rows = parseCsv(text);

  return rows.slice(1).map(columns => ({
    timestamp: Number(columns[0]),
    buyer: columns[1] || null,
    seller: columns[2] || null,
    symbol: columns[3],
    currency: columns[4],
    price: Number(columns[5]),
    quantity: Number(columns[6]),
  }));
}

function updateRollingCounts(history: number[], counts: Map<number, number>, value: number): void {
  history.push(value);
  counts.set(value, (counts.get(value) ?? 0) + 1);

  if (history.length > WALL_HISTORY) {
    const removed = history.shift();

    if (removed !== undefined) {
      const nextCount = (counts.get(removed) ?? 1) - 1;

      if (nextCount <= 0) {
        counts.delete(removed);
      } else {
        counts.set(removed, nextCount);
      }
    }
  }
}

function detectWallPrice(
  levels: BookLevel[],
  counts: Map<number, number>,
  side: 'bid' | 'ask',
): number | null {
  if (levels.length === 0) {
    return null;
  }

  let bestLevel = levels[0];
  let bestScore = -Infinity;
  const topPrice = levels[0].price;

  levels.forEach((level, index) => {
    const persistence = counts.get(level.price) ?? 0;
    const depthBias = side === 'bid' ? topPrice - level.price : level.price - topPrice;
    const score = level.volume * 3 + persistence * 5 + depthBias * 0.25 + index * 0.5;

    if (score > bestScore) {
      bestScore = score;
      bestLevel = level;
      return;
    }

    if (score === bestScore) {
      if (level.volume > bestLevel.volume) {
        bestLevel = level;
        return;
      }

      if (level.volume === bestLevel.volume) {
        if (side === 'bid' ? level.price < bestLevel.price : level.price > bestLevel.price) {
          bestLevel = level;
        }
      }
    }
  });

  return bestLevel.price;
}

function findBaseBid(bids: BookLevel[], wallMid: number): number | null {
  const candidates = bids.filter(level => level.price <= wallMid);

  if (candidates.length > 0) {
    return candidates.reduce((best, level) => (level.price > best ? level.price : best), candidates[0].price);
  }

  return bids[0]?.price ?? null;
}

function findBaseAsk(asks: BookLevel[], wallMid: number): number | null {
  const candidates = asks.filter(level => level.price >= wallMid);

  if (candidates.length > 0) {
    return candidates.reduce((best, level) => (level.price < best ? level.price : best), candidates[0].price);
  }

  return asks[0]?.price ?? null;
}

function buildSnapshots(rawRows: RawPriceRow[]): TutorialSnapshot[] {
  const sortedRows = [...rawRows].sort((a, b) => a.timestamp - b.timestamp);
  const openMid = sortedRows[0]?.midPrice ?? 0;
  const rollingWindow: number[] = [];
  let rollingSum = 0;
  const bidWallHistory: number[] = [];
  const askWallHistory: number[] = [];
  const bidWallCounts = new Map<number, number>();
  const askWallCounts = new Map<number, number>();

  return sortedRows.map(row => {
    rollingWindow.push(row.midPrice);
    rollingSum += row.midPrice;

    if (rollingWindow.length > 25) {
      rollingSum -= rollingWindow.shift() ?? 0;
    }

    const bestBid = row.bids[0]?.price ?? null;
    const bestAsk = row.asks[0]?.price ?? null;
    const wallBid = detectWallPrice(row.bids, bidWallCounts, 'bid');
    const wallAsk = detectWallPrice(row.asks, askWallCounts, 'ask');
    const wallMid =
      wallBid !== null && wallAsk !== null ? (wallBid + wallAsk) / 2 : bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : row.midPrice;
    const baseBid = findBaseBid(row.bids, wallMid);
    const baseAsk = findBaseAsk(row.asks, wallMid);
    const baseMid =
      baseBid !== null && baseAsk !== null ? (baseBid + baseAsk) / 2 : wallMid;
    const bidVolume = row.bids.reduce((sum, level) => sum + level.volume, 0);
    const askVolume = row.asks.reduce((sum, level) => sum + level.volume, 0);
    const totalVisibleVolume = bidVolume + askVolume;

    if (wallBid !== null) {
      updateRollingCounts(bidWallHistory, bidWallCounts, wallBid);
    }

    if (wallAsk !== null) {
      updateRollingCounts(askWallHistory, askWallCounts, wallAsk);
    }

    return {
      ...row,
      bestBid,
      bestAsk,
      wallBid,
      wallAsk,
      baseBid,
      baseAsk,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      bookImbalance: totalVisibleVolume === 0 ? 0 : (bidVolume - askVolume) / totalVisibleVolume,
      openMid,
      rollingMid: rollingSum / rollingWindow.length,
      wallMid,
      baseMid,
    };
  });
}

function buildTrades(rawTrades: RawTradeRow[], snapshots: TutorialSnapshot[]): TutorialTrade[] {
  const sortedTrades = [...rawTrades].sort((a, b) => a.timestamp - b.timestamp);
  let snapshotIndex = 0;

  return sortedTrades.map(trade => {
    while (snapshotIndex + 1 < snapshots.length && snapshots[snapshotIndex + 1].timestamp <= trade.timestamp) {
      snapshotIndex += 1;
    }

    const referenceSnapshot = snapshots[snapshotIndex];
    const bestBid = referenceSnapshot?.bestBid ?? null;
    const bestAsk = referenceSnapshot?.bestAsk ?? null;
    let classification: TutorialTrade['classification'] = 'passive';
    let signedQuantity = 0;

    if (bestAsk !== null && trade.price >= bestAsk) {
      classification = 'aggressive-buy';
      signedQuantity = trade.quantity;
    } else if (bestBid !== null && trade.price <= bestBid) {
      classification = 'aggressive-sell';
      signedQuantity = -trade.quantity;
    } else if (referenceSnapshot) {
      signedQuantity = trade.price > referenceSnapshot.midPrice ? trade.quantity : trade.price < referenceSnapshot.midPrice ? -trade.quantity : 0;
    }

    return {
      ...trade,
      classification,
      signedQuantity,
      referenceTimestamp: referenceSnapshot?.timestamp ?? trade.timestamp,
      referenceBestBid: bestBid,
      referenceBestAsk: bestAsk,
      referenceMid: referenceSnapshot?.midPrice ?? trade.price,
      referenceWallMid: referenceSnapshot?.wallMid ?? trade.price,
      referenceBaseMid: referenceSnapshot?.baseMid ?? trade.price,
      referenceOpenMid: referenceSnapshot?.openMid ?? trade.price,
      referenceRollingMid: referenceSnapshot?.rollingMid ?? trade.price,
    };
  });
}

function groupByProduct<T extends { product?: string; symbol?: string }>(
  rows: T[],
  selector: (row: T) => string,
): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};

  rows.forEach(row => {
    const product = selector(row);
    grouped[product] ??= [];
    grouped[product].push(row);
  });

  return grouped;
}

function buildProductData(rawPrices: RawPriceRow[], rawTrades: RawTradeRow[]): TutorialProductData[] {
  const pricesByProduct = groupByProduct(rawPrices, row => row.product);
  const tradesByProduct = groupByProduct(rawTrades, row => row.symbol);

  return Object.keys(pricesByProduct)
    .sort((a, b) => a.localeCompare(b))
    .map(product => {
      const snapshots = buildSnapshots(pricesByProduct[product]);
      const trades = buildTrades(tradesByProduct[product] ?? [], snapshots);

      return {
        product,
        snapshots,
        trades,
        lastTimestamp: snapshots[snapshots.length - 1]?.timestamp ?? 0,
        maxTradeQuantity: trades.reduce((max, trade) => Math.max(max, trade.quantity), 1),
      };
    });
}

function buildSession(fileSet: SessionFileSet): TutorialSession {
  const rawPrices = parsePriceCsv(fileSet.pricesText);
  const rawTrades = parseTradeCsv(fileSet.tradesText);
  const products = buildProductData(rawPrices, rawTrades);
  const day = rawPrices[0]?.day ?? 0;
  const productMap = Object.fromEntries(products.map(product => [product.product, product]));

  return {
    id: fileSet.id,
    label: fileSet.label,
    priceFile: fileSet.priceFile,
    tradeFile: fileSet.tradeFile,
    day,
    products: productMap,
    productNames: products.map(product => product.product),
    lastTimestamp: Math.max(...products.map(product => product.lastTimestamp)),
  };
}

export function parseTutorialDataset(fileSets: SessionFileSet[]): TutorialDataset {
  return {
    title: 'Tutorial Round 1 Dashboard',
    source: 'Bundled from attached CSV files',
    sessions: fileSets.map(buildSession).sort((a, b) => a.day - b.day),
  };
}
