import { Text } from '@mantine/core';
import { ReactNode } from 'react';
import {
  ActivityLogRow,
  Algorithm,
  AlgorithmDataRow,
  AlgorithmSummary,
  CompressedAlgorithmDataRow,
  CompressedListing,
  CompressedObservations,
  CompressedOrder,
  CompressedOrderDepth,
  CompressedTrade,
  CompressedTradingState,
  ConversionObservation,
  Listing,
  Observation,
  Order,
  OrderDepth,
  Product,
  Position,
  ProsperitySymbol,
  Trade,
  TradingState,
  UserId,
} from '../models.ts';
import { authenticatedAxios } from './axios.ts';

export class AlgorithmParseError extends Error {
  public constructor(public readonly node: ReactNode) {
    super('Failed to parse algorithm logs');
  }
}

interface WrappedLogRow {
  timestamp: number;
  sandboxLog: string;
  lambdaLog: string;
}

interface WrappedTradeHistoryRow {
  timestamp: number;
  buyer: UserId;
  seller: UserId;
  symbol: ProsperitySymbol;
  currency: Product;
  price: number;
  quantity: number;
}

interface WrappedAlgorithmLogFile {
  submissionId: string;
  activitiesLog: string;
  logs: WrappedLogRow[];
  tradeHistory: WrappedTradeHistoryRow[];
}

function getColumnValues(columns: string[], indices: number[]): number[] {
  const values: number[] = [];

  for (const index of indices) {
    const value = columns[index];
    if (value !== '') {
      values.push(parseFloat(value));
    }
  }

  return values;
}

function parseActivityCsv(csv: string): ActivityLogRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) {
    return [];
  }

  const rows: ActivityLogRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      continue;
    }

    const columns = line.split(';');
    rows.push({
      day: Number(columns[0]),
      timestamp: Number(columns[1]),
      product: columns[2],
      bidPrices: getColumnValues(columns, [3, 5, 7]),
      bidVolumes: getColumnValues(columns, [4, 6, 8]),
      askPrices: getColumnValues(columns, [9, 11, 13]),
      askVolumes: getColumnValues(columns, [10, 12, 14]),
      midPrice: Number(columns[15]),
      profitLoss: Number(columns[16]),
    });
  }

  return rows;
}

function getActivityLogs(logLines: string[]): ActivityLogRow[] {
  const headerIndex = logLines.indexOf('Activities log:');
  if (headerIndex === -1) {
    return [];
  }

  const rows: ActivityLogRow[] = [];

  for (let i = headerIndex + 2; i < logLines.length; i++) {
    const line = logLines[i];
    if (line === '') {
      break;
    }

    const columns = line.split(';');

    rows.push({
      day: Number(columns[0]),
      timestamp: Number(columns[1]),
      product: columns[2],
      bidPrices: getColumnValues(columns, [3, 5, 7]),
      bidVolumes: getColumnValues(columns, [4, 6, 8]),
      askPrices: getColumnValues(columns, [9, 11, 13]),
      askVolumes: getColumnValues(columns, [10, 12, 14]),
      midPrice: Number(columns[15]),
      profitLoss: Number(columns[16]),
    });
  }

  return rows;
}

function isWrappedAlgorithmLogFile(value: unknown): value is WrappedAlgorithmLogFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<WrappedAlgorithmLogFile>;
  return (
    typeof candidate.activitiesLog === 'string' &&
    Array.isArray(candidate.logs) &&
    Array.isArray(candidate.tradeHistory)
  );
}

function buildAlgorithmFromWrappedLogFile(
  wrapped: WrappedAlgorithmLogFile,
  summary?: AlgorithmSummary,
): Algorithm {
  const activityLogs = parseActivityCsv(wrapped.activitiesLog);
  if (activityLogs.length === 0) {
    throw new AlgorithmParseError(<Text>Wrapped JSON log contains no activity rows.</Text>);
  }

  const timestamps = [...new Set(activityLogs.map(row => row.timestamp))].sort((a, b) => a - b);
  const products = [...new Set(activityLogs.map(row => row.product))].sort((a, b) => a.localeCompare(b));

  const denominationByProduct: Record<string, string> = {};
  for (const trade of wrapped.tradeHistory) {
    if (!denominationByProduct[trade.symbol]) {
      denominationByProduct[trade.symbol] = trade.currency;
    }
  }

  const listings: Record<ProsperitySymbol, Listing> = {};
  for (const product of products) {
    listings[product] = {
      symbol: product,
      product,
      denomination: denominationByProduct[product] ?? 'SEASHELLS',
    };
  }

  const activityRowsByTimestamp = new Map<number, ActivityLogRow[]>();
  for (const row of activityLogs) {
    const rows = activityRowsByTimestamp.get(row.timestamp) ?? [];
    rows.push(row);
    activityRowsByTimestamp.set(row.timestamp, rows);
  }

  const wrappedLogsByTimestamp = new Map<number, WrappedLogRow>();
  for (const row of wrapped.logs) {
    wrappedLogsByTimestamp.set(row.timestamp, row);
  }

  const tradeHistoryByTimestamp = new Map<number, WrappedTradeHistoryRow[]>();
  for (const trade of wrapped.tradeHistory) {
    const rows = tradeHistoryByTimestamp.get(trade.timestamp) ?? [];
    rows.push(trade);
    tradeHistoryByTimestamp.set(trade.timestamp, rows);
  }

  const runningPosition: Record<Product, Position> = {};
  const data: AlgorithmDataRow[] = timestamps.map(timestamp => {
    const timestampActivityRows = activityRowsByTimestamp.get(timestamp) ?? [];
    const timestampTrades = tradeHistoryByTimestamp.get(timestamp) ?? [];
    const wrappedRow = wrappedLogsByTimestamp.get(timestamp);

    const orderDepths: Record<ProsperitySymbol, OrderDepth> = {};
    for (const row of timestampActivityRows) {
      const buyOrders: Record<number, number> = {};
      const sellOrders: Record<number, number> = {};

      row.bidPrices.forEach((price, index) => {
        buyOrders[price] = row.bidVolumes[index];
      });

      row.askPrices.forEach((price, index) => {
        sellOrders[price] = -Math.abs(row.askVolumes[index]);
      });

      orderDepths[row.product] = {
        buyOrders,
        sellOrders,
      };
    }

    const ownTrades: Record<ProsperitySymbol, Trade[]> = {};
    const marketTrades: Record<ProsperitySymbol, Trade[]> = {};

    for (const trade of timestampTrades) {
      const normalizedTrade: Trade = {
        symbol: trade.symbol,
        price: trade.price,
        quantity: trade.quantity,
        buyer: trade.buyer,
        seller: trade.seller,
        timestamp: trade.timestamp,
      };

      const isOwnTrade = trade.buyer === 'SUBMISSION' || trade.seller === 'SUBMISSION';
      const collection = isOwnTrade ? ownTrades : marketTrades;
      if (collection[trade.symbol] === undefined) {
        collection[trade.symbol] = [];
      }
      collection[trade.symbol].push(normalizedTrade);

      if (trade.buyer === 'SUBMISSION') {
        runningPosition[trade.symbol] = (runningPosition[trade.symbol] ?? 0) + trade.quantity;
      }
      if (trade.seller === 'SUBMISSION') {
        runningPosition[trade.symbol] = (runningPosition[trade.symbol] ?? 0) - trade.quantity;
      }
    }

    return {
      state: {
        timestamp,
        traderData: '',
        listings,
        orderDepths,
        ownTrades,
        marketTrades,
        position: { ...runningPosition },
        observations: {
          plainValueObservations: {},
          conversionObservations: {},
        },
      },
      orders: {},
      conversions: 0,
      traderData: '',
      algorithmLogs: wrappedRow?.lambdaLog ?? '',
      sandboxLogs: wrappedRow?.sandboxLog ?? '',
    };
  });

  return {
    summary,
    activityLogs,
    data,
  };
}

function decompressListings(compressed: CompressedListing[]): Record<ProsperitySymbol, Listing> {
  const listings: Record<ProsperitySymbol, Listing> = {};

  for (const [symbol, product, denomination] of compressed) {
    listings[symbol] = {
      symbol,
      product,
      denomination,
    };
  }

  return listings;
}

function decompressOrderDepths(
  compressed: Record<ProsperitySymbol, CompressedOrderDepth>,
): Record<ProsperitySymbol, OrderDepth> {
  const orderDepths: Record<ProsperitySymbol, OrderDepth> = {};

  for (const [symbol, [buyOrders, sellOrders]] of Object.entries(compressed)) {
    orderDepths[symbol] = {
      buyOrders,
      sellOrders,
    };
  }

  return orderDepths;
}

function decompressTrades(compressed: CompressedTrade[]): Record<ProsperitySymbol, Trade[]> {
  const trades: Record<ProsperitySymbol, Trade[]> = {};

  for (const [symbol, price, quantity, buyer, seller, timestamp] of compressed) {
    if (trades[symbol] === undefined) {
      trades[symbol] = [];
    }

    trades[symbol].push({
      symbol,
      price,
      quantity,
      buyer,
      seller,
      timestamp,
    });
  }

  return trades;
}

function decompressObservations(compressed: CompressedObservations): Observation {
  const conversionObservations: Record<Product, ConversionObservation> = {};

  for (const [
    product,
    [bidPrice, askPrice, transportFees, exportTariff, importTariff, sugarPrice, sunlightIndex],
  ] of Object.entries(compressed[1])) {
    conversionObservations[product] = {
      bidPrice,
      askPrice,
      transportFees,
      exportTariff,
      importTariff,
      sugarPrice,
      sunlightIndex,
    };
  }

  return {
    plainValueObservations: compressed[0],
    conversionObservations,
  };
}

function decompressState(compressed: CompressedTradingState): TradingState {
  return {
    timestamp: compressed[0],
    traderData: compressed[1],
    listings: decompressListings(compressed[2]),
    orderDepths: decompressOrderDepths(compressed[3]),
    ownTrades: decompressTrades(compressed[4]),
    marketTrades: decompressTrades(compressed[5]),
    position: compressed[6],
    observations: decompressObservations(compressed[7]),
  };
}

function decompressOrders(compressed: CompressedOrder[]): Record<ProsperitySymbol, Order[]> {
  const orders: Record<ProsperitySymbol, Order[]> = {};

  for (const [symbol, price, quantity] of compressed) {
    if (orders[symbol] === undefined) {
      orders[symbol] = [];
    }

    orders[symbol].push({
      symbol,
      price,
      quantity,
    });
  }

  return orders;
}

function decompressDataRow(compressed: CompressedAlgorithmDataRow, sandboxLogs: string): AlgorithmDataRow {
  return {
    state: decompressState(compressed[0]),
    orders: decompressOrders(compressed[1]),
    conversions: compressed[2],
    traderData: compressed[3],
    algorithmLogs: compressed[4],
    sandboxLogs,
  };
}

function getAlgorithmData(logLines: string[]): AlgorithmDataRow[] {
  const headerIndex = logLines.indexOf('Sandbox logs:');
  if (headerIndex === -1) {
    return [];
  }

  const rows: AlgorithmDataRow[] = [];
  let nextSandboxLogs = '';

  const sandboxLogPrefix = '  "sandboxLog": ';
  const lambdaLogPrefix = '  "lambdaLog": ';

  for (let i = headerIndex + 1; i < logLines.length; i++) {
    const line = logLines[i];
    if (line.endsWith(':')) {
      break;
    }

    if (line.startsWith(sandboxLogPrefix)) {
      nextSandboxLogs = JSON.parse(line.substring(sandboxLogPrefix.length, line.length - 1)).trim();

      if (nextSandboxLogs.startsWith('Conversion request')) {
        const lastRow = rows[rows.length - 1];
        lastRow.sandboxLogs += (lastRow.sandboxLogs.length > 0 ? '\n' : '') + nextSandboxLogs;

        nextSandboxLogs = '';
      }

      continue;
    }

    if (!line.startsWith(lambdaLogPrefix) || line === '  "lambdaLog": "",') {
      continue;
    }

    const start = line.indexOf('[[');
    const end = line.lastIndexOf(']') + 1;

    try {
      const compressedDataRow = JSON.parse(JSON.parse('"' + line.substring(start, end) + '"'));
      rows.push(decompressDataRow(compressedDataRow, nextSandboxLogs));
    } catch (err) {
      console.log(line);
      console.error(err);

      throw new AlgorithmParseError(
        (
          <>
            <Text>Logs are in invalid format. Could not parse the following line:</Text>
            <Text>{line}</Text>
          </>
        ),
      );
    }
  }

  return rows;
}

export function parseAlgorithmLogs(logs: string, summary?: AlgorithmSummary): Algorithm {
  try {
    const parsed = JSON.parse(logs);
    if (isWrappedAlgorithmLogFile(parsed)) {
      return buildAlgorithmFromWrappedLogFile(parsed, summary);
    }
  } catch {
    // Fall through to the legacy plain-text parser.
  }

  const logLines = logs.trim().split(/\r?\n/);

  const activityLogs = getActivityLogs(logLines);
  const data = getAlgorithmData(logLines);

  if (activityLogs.length === 0 && data.length === 0) {
    throw new AlgorithmParseError(
      (
        <Text>
          Logs are empty, either something went wrong with your submission or your backtester logs in a different format
          than Prosperity&apos;s submission environment.
        </Text>
      ),
    );
  }

  if (activityLogs.length === 0 || data.length === 0) {
    throw new AlgorithmParseError(
      /* prettier-ignore */
      <Text>Logs are in invalid format.</Text>,
    );
  }

  return {
    summary,
    activityLogs,
    data,
  };
}

export async function getAlgorithmLogsUrl(algorithmId: string): Promise<string> {
  const urlResponse = await authenticatedAxios.get(
    `https://bz97lt8b1e.execute-api.eu-west-1.amazonaws.com/prod/submission/logs/${algorithmId}`,
  );

  return urlResponse.data;
}

function downloadFile(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = new URL(url).pathname.split('/').pop()!;
  link.target = '_blank';
  link.rel = 'noreferrer';

  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function downloadAlgorithmLogs(algorithmId: string): Promise<void> {
  const logsUrl = await getAlgorithmLogsUrl(algorithmId);
  downloadFile(logsUrl);
}

export async function downloadAlgorithmResults(algorithmId: string): Promise<void> {
  const detailsResponse = await authenticatedAxios.get(
    `https://bz97lt8b1e.execute-api.eu-west-1.amazonaws.com/prod/results/tutorial/${algorithmId}`,
  );

  downloadFile(detailsResponse.data.algo.summary.activitiesLog);
}
