import Highcharts from 'highcharts';
import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { ReactNode, startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import classes from './DashboardPage.module.css';
import { Chart } from '../visualizer/Chart.tsx';
import { formatNumber } from '../../utils/format.ts';
import { loadTutorialDataset, loadTutorialDatasetFromFiles, mergeTutorialDatasets } from '../../tutorial/loadTutorialDataset.ts';
import { IndicatorKey, TradeClassification, TutorialDataset, TutorialProductData, TutorialSnapshot, TutorialTrade } from '../../tutorial/types.ts';
import { buildStrategyDataset, StrategyDatasetResult, StrategyProductOverlay } from '../../tutorial/strategyDataset.ts';
import { parseAlgorithmLogs } from '../../utils/algorithm.tsx';
import { useStore } from '../../store.ts';

const BID_COLORS = ['#6f94bf', '#355f90', '#153a63'];
const ASK_COLORS = ['#d97966', '#bc553f', '#8f3424'];
const TRADE_COLORS: Record<TradeClassification, string> = {
  'aggressive-buy': '#157f69',
  'aggressive-sell': '#b6402c',
  passive: '#bd8a30',
};
const DOWN_SAMPLE_OPTIONS = ['1', '2', '5', '10', '20'];
const DETAIL_WINDOW = 1_500;

function indicatorLabel(key: IndicatorKey): string {
  switch (key) {
    case 'mid':
      return 'Mid Price';
    case 'wallmid':
      return 'WallMid';
    case 'basemid':
      return 'Base Mid';
    case 'open':
      return 'Session Open';
    case 'rolling':
      return 'Rolling Fair';
    case 'none':
      return 'None';
  }
}

interface MarketPointMeta {
  kind: 'book' | 'trade' | 'indicator' | 'strategy-order' | 'strategy-trade' | 'fill-match';
  label: string;
  price: number;
  timestamp: number;
  quantity?: number;
  classification?: TradeClassification;
  referenceBid?: number | null;
  referenceAsk?: number | null;
  side?: string;
  counterpart?: string | null;
  note?: string;
}

function formatSigned(value: number, decimals: number = 1): string {
  if (value > 0) {
    return `+${formatNumber(value, decimals)}`;
  }

  return formatNumber(value, decimals);
}

function findNearestSnapshotIndex(snapshots: TutorialSnapshot[], timestamp: number): number {
  if (snapshots.length === 0) {
    return -1;
  }

  let low = 0;
  let high = snapshots.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const current = snapshots[mid].timestamp;

    if (current === timestamp) {
      return mid;
    }

    if (current < timestamp) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (low >= snapshots.length) {
    return snapshots.length - 1;
  }

  if (high < 0) {
    return 0;
  }

  return Math.abs(snapshots[low].timestamp - timestamp) < Math.abs(snapshots[high].timestamp - timestamp) ? low : high;
}

function baselineForSnapshot(snapshot: TutorialSnapshot, key: IndicatorKey): number {
  switch (key) {
    case 'mid':
      return snapshot.midPrice;
    case 'wallmid':
      return snapshot.wallMid;
    case 'basemid':
      return snapshot.baseMid;
    case 'open':
      return snapshot.openMid;
    case 'rolling':
      return snapshot.rollingMid;
    case 'none':
      return 0;
  }
}

function baselineForTrade(trade: TutorialTrade, key: IndicatorKey): number {
  switch (key) {
    case 'mid':
      return trade.referenceMid;
    case 'wallmid':
      return trade.referenceWallMid;
    case 'basemid':
      return trade.referenceBaseMid;
    case 'open':
      return trade.referenceOpenMid;
    case 'rolling':
      return trade.referenceRollingMid;
    case 'none':
      return 0;
  }
}

function normalizeSnapshotPrice(snapshot: TutorialSnapshot, price: number, key: IndicatorKey): number {
  return key === 'none' ? price : price - baselineForSnapshot(snapshot, key);
}

function normalizeTradePrice(trade: TutorialTrade, key: IndicatorKey): number {
  return key === 'none' ? trade.price : trade.price - baselineForTrade(trade, key);
}

function normalizeAbsolutePriceAtTimestamp(
  snapshots: TutorialSnapshot[],
  timestamp: number,
  price: number,
  key: IndicatorKey,
): number {
  if (key === 'none') {
    return price;
  }

  const snapshotIndex = findNearestSnapshotIndex(snapshots, timestamp);
  const snapshot = snapshotIndex >= 0 ? snapshots[snapshotIndex] : null;
  return snapshot ? price - baselineForSnapshot(snapshot, key) : price;
}

function downsampleSnapshots(snapshots: TutorialSnapshot[], step: number): TutorialSnapshot[] {
  if (step <= 1) {
    return snapshots;
  }

  return snapshots.filter((_, index) => index % step === 0 || index === snapshots.length - 1);
}

function buildFlowSeries(snapshots: TutorialSnapshot[], trades: TutorialTrade[]): [number, number][] {
  let tradeIndex = 0;
  let runningFlow = 0;

  return snapshots.map(snapshot => {
    while (tradeIndex < trades.length && trades[tradeIndex].timestamp <= snapshot.timestamp) {
      runningFlow += trades[tradeIndex].signedQuantity;
      tradeIndex += 1;
    }

    return [snapshot.timestamp, runningFlow];
  });
}

function aggregateProfitLossByTimestamp(points: { timestamp: number; profitLoss: number }[]): [number, number][] {
  const profitLossByTimestamp = new Map<number, number>();

  points.forEach(point => {
    profitLossByTimestamp.set(point.timestamp, (profitLossByTimestamp.get(point.timestamp) ?? 0) + point.profitLoss);
  });

  return [...profitLossByTimestamp.entries()].sort((left, right) => left[0] - right[0]);
}

function buildTooltip(snapshotMode: IndicatorKey) {
  return function formatter(this: Highcharts.TooltipFormatterContextObject): string {
    const point = this.point as Highcharts.Point & { options: { custom?: MarketPointMeta } };
    const meta = point.options.custom;

    if (!meta) {
      return '';
    }

    const normalizedLabel = snapshotMode === 'none' ? 'Displayed' : `Displayed (vs ${snapshotMode})`;
    const parts = [
      `<div style="font-size:12px"><strong>${meta.label}</strong></div>`,
      `<div>Timestamp: ${formatNumber(meta.timestamp)}</div>`,
      `<div>Price: ${formatNumber(meta.price, 1)}</div>`,
      `<div>${normalizedLabel}: ${formatSigned(point.y ?? 0, 1)}</div>`,
    ];

    if (meta.quantity !== undefined) {
      parts.push(`<div>Quantity: ${formatNumber(meta.quantity)}</div>`);
    }

    if (meta.classification) {
      parts.push(`<div>Class: ${meta.classification}</div>`);
    }

    if (meta.side) {
      parts.push(`<div>Side: ${meta.side}</div>`);
    }

    if (meta.counterpart) {
      parts.push(`<div>Counterparty: ${meta.counterpart}</div>`);
    }

    if (meta.note) {
      parts.push(`<div>${meta.note}</div>`);
    }

    if (meta.referenceBid !== undefined || meta.referenceAsk !== undefined) {
      parts.push(
        `<div>Ref bid/ask: ${meta.referenceBid === null || meta.referenceBid === undefined ? 'n/a' : formatNumber(meta.referenceBid, 1)} / ${
          meta.referenceAsk === null || meta.referenceAsk === undefined ? 'n/a' : formatNumber(meta.referenceAsk, 1)
        }</div>`,
      );
    }

    return parts.join('');
  };
}

function buildMarketSeries(
  productData: TutorialProductData,
  normalization: IndicatorKey,
  indicator: IndicatorKey,
  downsampleStep: number,
  showBook: boolean,
  showTrades: boolean,
  visibleLevels: number[],
  showAggressiveBuys: boolean,
  showAggressiveSells: boolean,
  showPassiveTrades: boolean,
  quantityRange: [number, number],
): Highcharts.SeriesOptionsType[] {
  const sampledSnapshots = downsampleSnapshots(productData.snapshots, downsampleStep);
  const series: Highcharts.SeriesOptionsType[] = [];

  if (showBook) {
    visibleLevels.forEach(level => {
      const bidData = sampledSnapshots.flatMap(snapshot => {
        const row = snapshot.bids[level - 1];
        if (!row) {
          return [];
        }

        return [
          {
            x: snapshot.timestamp,
            y: normalizeSnapshotPrice(snapshot, row.price, normalization),
            marker: {
              radius: 2 + Math.min(row.volume, 16) * 0.2,
            },
            custom: {
              kind: 'book',
              label: `Bid ${level}`,
              price: row.price,
              timestamp: snapshot.timestamp,
              quantity: row.volume,
            } satisfies MarketPointMeta,
          },
        ];
      });

      const askData = sampledSnapshots.flatMap(snapshot => {
        const row = snapshot.asks[level - 1];
        if (!row) {
          return [];
        }

        return [
          {
            x: snapshot.timestamp,
            y: normalizeSnapshotPrice(snapshot, row.price, normalization),
            marker: {
              radius: 2 + Math.min(row.volume, 16) * 0.2,
            },
            custom: {
              kind: 'book',
              label: `Ask ${level}`,
              price: row.price,
              timestamp: snapshot.timestamp,
              quantity: row.volume,
            } satisfies MarketPointMeta,
          },
        ];
      });

      series.push(
        {
          type: 'scatter',
          name: `Bid ${level}`,
          color: BID_COLORS[level - 1],
          data: bidData,
          turboThreshold: 0,
        },
        {
          type: 'scatter',
          name: `Ask ${level}`,
          color: ASK_COLORS[level - 1],
          data: askData,
          turboThreshold: 0,
        },
      );
    });
  }

  if (indicator !== 'none') {
    series.push({
      type: 'line',
      name: indicatorLabel(indicator),
      color: '#c59834',
      dashStyle: indicator === 'open' ? 'ShortDash' : 'Solid',
      lineWidth: 2,
      marker: {
        enabled: false,
      },
      data: sampledSnapshots.map(snapshot => ({
        x: snapshot.timestamp,
        y: normalizeSnapshotPrice(snapshot, baselineForSnapshot(snapshot, indicator), normalization),
        custom: {
          kind: 'indicator',
          label: indicatorLabel(indicator),
          price: baselineForSnapshot(snapshot, indicator),
          timestamp: snapshot.timestamp,
        } satisfies MarketPointMeta,
      })),
      turboThreshold: 0,
    });
  }

  if (showTrades) {
    const tradeVisibility: Record<TradeClassification, boolean> = {
      'aggressive-buy': showAggressiveBuys,
      'aggressive-sell': showAggressiveSells,
      passive: showPassiveTrades,
    };

    (Object.keys(tradeVisibility) as TradeClassification[]).forEach(classification => {
      if (!tradeVisibility[classification]) {
        return;
      }

      const data = productData.trades
        .filter(trade => trade.classification === classification)
        .filter(trade => trade.quantity >= quantityRange[0] && trade.quantity <= quantityRange[1])
        .map(trade => ({
          x: trade.timestamp,
          y: normalizeTradePrice(trade, normalization),
          marker: {
            radius: 3 + Math.min(trade.quantity, 10) * 0.3,
            symbol:
              classification === 'aggressive-buy'
                ? 'triangle'
                : classification === 'aggressive-sell'
                  ? 'triangle-down'
                  : 'square',
          },
          custom: {
            kind: 'trade',
            label:
              classification === 'aggressive-buy'
                ? 'Aggressive Buy'
                : classification === 'aggressive-sell'
                  ? 'Aggressive Sell'
                  : 'Passive Print',
            price: trade.price,
            timestamp: trade.timestamp,
            quantity: trade.quantity,
            classification,
            referenceBid: trade.referenceBestBid,
            referenceAsk: trade.referenceBestAsk,
          } satisfies MarketPointMeta,
        }));

      series.push({
        type: 'scatter',
        name:
          classification === 'aggressive-buy'
            ? 'Aggressive Buys'
            : classification === 'aggressive-sell'
              ? 'Aggressive Sells'
              : 'Passive Prints',
        color: TRADE_COLORS[classification],
        data,
        turboThreshold: 0,
      });
    });
  }

  return series;
}

function buildStrategySeries(
  productData: TutorialProductData,
  strategyOverlay: StrategyProductOverlay,
  normalization: IndicatorKey,
  showStrategyOrders: boolean,
  showOwnFills: boolean,
  showFillMatches: boolean,
): Highcharts.SeriesOptionsType[] {
  const series: Highcharts.SeriesOptionsType[] = [];

  if (showStrategyOrders) {
    const bidData = strategyOverlay.orderEvents
      .filter(order => order.side === 'bid')
      .map(order => ({
        x: order.timestamp,
        y: normalizeAbsolutePriceAtTimestamp(productData.snapshots, order.timestamp, order.price, normalization),
        marker: {
          radius: 3 + Math.min(order.quantity, 12) * 0.25,
          symbol: 'triangle',
        },
        custom: {
          kind: 'strategy-order',
          label: 'Our bid',
          price: order.price,
          timestamp: order.timestamp,
          quantity: order.quantity,
          side: 'bid',
        } satisfies MarketPointMeta,
      }));

    const askData = strategyOverlay.orderEvents
      .filter(order => order.side === 'ask')
      .map(order => ({
        x: order.timestamp,
        y: normalizeAbsolutePriceAtTimestamp(productData.snapshots, order.timestamp, order.price, normalization),
        marker: {
          radius: 3 + Math.min(order.quantity, 12) * 0.25,
          symbol: 'triangle-down',
        },
        custom: {
          kind: 'strategy-order',
          label: 'Our ask',
          price: order.price,
          timestamp: order.timestamp,
          quantity: order.quantity,
          side: 'ask',
        } satisfies MarketPointMeta,
      }));

    series.push(
      {
        type: 'scatter',
        name: 'Our bids',
        color: '#0f8a74',
        data: bidData,
        turboThreshold: 0,
      },
      {
        type: 'scatter',
        name: 'Our asks',
        color: '#cf5c36',
        data: askData,
        turboThreshold: 0,
      },
    );
  }

  if (showOwnFills) {
    const buyFills = strategyOverlay.ownTradeEvents
      .filter(trade => trade.side === 'buy')
      .map(trade => ({
        x: trade.timestamp,
        y: normalizeAbsolutePriceAtTimestamp(productData.snapshots, trade.timestamp, trade.price, normalization),
        marker: {
          radius: 4 + Math.min(trade.quantity, 12) * 0.25,
          symbol: 'diamond',
        },
        custom: {
          kind: 'strategy-trade',
          label: 'Our buy fill',
          price: trade.price,
          timestamp: trade.timestamp,
          quantity: trade.quantity,
          side: trade.side,
          counterpart: trade.counterpart,
        } satisfies MarketPointMeta,
      }));

    const sellFills = strategyOverlay.ownTradeEvents
      .filter(trade => trade.side === 'sell')
      .map(trade => ({
        x: trade.timestamp,
        y: normalizeAbsolutePriceAtTimestamp(productData.snapshots, trade.timestamp, trade.price, normalization),
        marker: {
          radius: 4 + Math.min(trade.quantity, 12) * 0.25,
          symbol: 'diamond',
        },
        custom: {
          kind: 'strategy-trade',
          label: 'Our sell fill',
          price: trade.price,
          timestamp: trade.timestamp,
          quantity: trade.quantity,
          side: trade.side,
          counterpart: trade.counterpart,
        } satisfies MarketPointMeta,
      }));

    const unknownFills = strategyOverlay.ownTradeEvents
      .filter(trade => trade.side === 'unknown')
      .map(trade => ({
        x: trade.timestamp,
        y: normalizeAbsolutePriceAtTimestamp(productData.snapshots, trade.timestamp, trade.price, normalization),
        marker: {
          radius: 4 + Math.min(trade.quantity, 12) * 0.25,
          symbol: 'circle',
        },
        custom: {
          kind: 'strategy-trade',
          label: 'Our fill',
          price: trade.price,
          timestamp: trade.timestamp,
          quantity: trade.quantity,
          side: trade.side,
          counterpart: trade.counterpart,
          note: 'Side inferred with low confidence',
        } satisfies MarketPointMeta,
      }));

    series.push(
      {
        type: 'scatter',
        name: 'Our buy fills',
        color: '#159a6f',
        data: buyFills,
        turboThreshold: 0,
      },
      {
        type: 'scatter',
        name: 'Our sell fills',
        color: '#d94841',
        data: sellFills,
        turboThreshold: 0,
      },
      {
        type: 'scatter',
        name: 'Our fills (unclear side)',
        color: '#8a7d6d',
        data: unknownFills,
        turboThreshold: 0,
      },
    );
  }

  if (showFillMatches) {
    series.push({
      type: 'scatter',
      name: 'Trades that filled us',
      color: '#7a5ccf',
      data: strategyOverlay.fillMatchEvents.map(trade => ({
        x: trade.timestamp,
        y: normalizeAbsolutePriceAtTimestamp(productData.snapshots, trade.timestamp, trade.price, normalization),
        marker: {
          radius: 3 + Math.min(trade.quantity, 12) * 0.2,
          symbol: 'square',
        },
        custom: {
          kind: 'fill-match',
          label: 'Fill-side market trade',
          price: trade.price,
          timestamp: trade.timestamp,
          quantity: trade.quantity,
          side: trade.side,
          counterpart: trade.counterpart,
        } satisfies MarketPointMeta,
      })),
      turboThreshold: 0,
    });
  }

  return series.filter(candidate => {
    const typedCandidate = candidate as Highcharts.SeriesScatterOptions;
    return Array.isArray(typedCandidate.data) ? typedCandidate.data.length > 0 : true;
  });
}

function buildSpreadScreenerSeries(
  productData: TutorialProductData,
  normalization: Extract<IndicatorKey, 'mid' | 'wallmid'>,
): Highcharts.SeriesOptionsType[] {
  const toBps = (value: number, reference: number) => ((value - reference) / reference) * 10_000;

  return [
    {
      type: 'line',
      name: 'Best bid vs ref',
      color: BID_COLORS[2],
      data: productData.snapshots.flatMap(snapshot => {
        const bid = snapshot.bestBid;
        const reference = baselineForSnapshot(snapshot, normalization);

        return bid === null ? [] : [[snapshot.timestamp, toBps(bid, reference)]];
      }),
      marker: { enabled: false },
    },
    {
      type: 'line',
      name: 'Best ask vs ref',
      color: ASK_COLORS[2],
      data: productData.snapshots.flatMap(snapshot => {
        const ask = snapshot.bestAsk;
        const reference = baselineForSnapshot(snapshot, normalization);

        return ask === null ? [] : [[snapshot.timestamp, toBps(ask, reference)]];
      }),
      marker: { enabled: false },
    },
    {
      type: 'line',
      name: 'Wall bid vs ref',
      color: BID_COLORS[0],
      dashStyle: 'ShortDash',
      data: productData.snapshots.flatMap(snapshot => {
        const bid = snapshot.wallBid;
        const reference = baselineForSnapshot(snapshot, normalization);

        return bid === null ? [] : [[snapshot.timestamp, toBps(bid, reference)]];
      }),
      marker: { enabled: false },
    },
    {
      type: 'line',
      name: 'Wall ask vs ref',
      color: ASK_COLORS[0],
      dashStyle: 'ShortDash',
      data: productData.snapshots.flatMap(snapshot => {
        const ask = snapshot.wallAsk;
        const reference = baselineForSnapshot(snapshot, normalization);

        return ask === null ? [] : [[snapshot.timestamp, toBps(ask, reference)]];
      }),
      marker: { enabled: false },
    },
    {
      type: 'line',
      name: 'Best spread',
      color: '#c59834',
      data: productData.snapshots.flatMap(snapshot => {
        const reference = baselineForSnapshot(snapshot, normalization);

        return snapshot.spread === null ? [] : [[snapshot.timestamp, (snapshot.spread / reference) * 10_000]];
      }),
      marker: { enabled: false },
    },
  ];
}

function statCard(label: string, value: string, detail?: string): ReactNode {
  return (
    <Box className={classes.statCard}>
      <Text className={classes.statLabel}>{label}</Text>
      <Text className={classes.statValue}>{value}</Text>
      {detail && (
        <Text size="sm" mt={4} className={classes.subtle}>
          {detail}
        </Text>
      )}
    </Box>
  );
}

function pickDefaultProduct(productNames: string[]): string | null {
  return productNames[0] ?? null;
}

export function DashboardPage(): ReactNode {
  const algorithm = useStore(state => state.algorithm);
  const setAlgorithm = useStore(state => state.setAlgorithm);
  const [bundledDataset, setBundledDataset] = useState<TutorialDataset | null>(null);
  const [marketDataset, setMarketDataset] = useState<TutorialDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
  const [strategySourceLabel, setStrategySourceLabel] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const [normalization, setNormalization] = useState<IndicatorKey>('none');
  const [indicator, setIndicator] = useState<IndicatorKey>('wallmid');
  const [spreadNormalization, setSpreadNormalization] = useState<Extract<IndicatorKey, 'mid' | 'wallmid'>>('wallmid');
  const [downsampleStep, setDownsampleStep] = useState('2');
  const [showBook, setShowBook] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [showAggressiveBuys, setShowAggressiveBuys] = useState(true);
  const [showAggressiveSells, setShowAggressiveSells] = useState(true);
  const [showPassiveTrades, setShowPassiveTrades] = useState(true);
  const [showStrategyOrders, setShowStrategyOrders] = useState(true);
  const [showOwnFills, setShowOwnFills] = useState(true);
  const [showFillMatches, setShowFillMatches] = useState(true);
  const [showLevel1, setShowLevel1] = useState(true);
  const [showLevel2, setShowLevel2] = useState(true);
  const [showLevel3, setShowLevel3] = useState(true);
  const [quantityRange, setQuantityRange] = useState<[number, number]>([1, 8]);
  const [activeTimestamp, setActiveTimestamp] = useState(0);

  const strategyDatasetResult = useMemo<StrategyDatasetResult | null>(() => {
    if (!algorithm) {
      return null;
    }

    return buildStrategyDataset(algorithm, strategySourceLabel ?? algorithm.summary?.fileName ?? 'strategy log');
  }, [algorithm, strategySourceLabel]);

  const dataset = useMemo(() => {
    if (marketDataset && strategyDatasetResult) {
      return mergeTutorialDatasets(marketDataset, strategyDatasetResult.dataset);
    }

    return strategyDatasetResult?.dataset ?? marketDataset;
  }, [marketDataset, strategyDatasetResult]);

  useEffect(() => {
    let cancelled = false;

    loadTutorialDataset()
      .then(loadedDataset => {
        if (cancelled) {
          return;
        }

        setBundledDataset(loadedDataset);
        setMarketDataset(loadedDataset);

        const defaultSession = loadedDataset.sessions[loadedDataset.sessions.length - 1];
        const defaultProduct = pickDefaultProduct(defaultSession.productNames);
        const defaultProductData = defaultProduct ? defaultSession.products[defaultProduct] : null;

        setSelectedSessionId(defaultSession.id);
        setSelectedProduct(defaultProduct);
        if (defaultProductData) {
          setQuantityRange([1, defaultProductData.maxTradeQuantity]);
          setActiveTimestamp(defaultProductData.lastTimestamp);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the sample market dataset');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAdditionalFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0 || !marketDataset) {
      return;
    }

    setUploadError(null);
    setUploading(true);

    try {
      const uploadedDataset = await loadTutorialDatasetFromFiles([...files]);
      const mergedDataset = mergeTutorialDatasets(marketDataset, uploadedDataset);
      const newestSession = uploadedDataset.sessions[uploadedDataset.sessions.length - 1];
      const defaultProduct = pickDefaultProduct(newestSession.productNames);
      const defaultProductData = defaultProduct ? newestSession.products[defaultProduct] : null;

      setMarketDataset(mergedDataset);
      setSelectedSessionId(newestSession.id);
      setSelectedProduct(defaultProduct);
      if (defaultProductData) {
        setQuantityRange([1, defaultProductData.maxTradeQuantity]);
        setActiveTimestamp(defaultProductData.lastTimestamp);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not load the uploaded CSV files.');
    } finally {
      setUploading(false);
    }
  }

  function resetToBundledDataset(): void {
    if (!bundledDataset) {
      return;
    }

    const defaultSession = bundledDataset.sessions[bundledDataset.sessions.length - 1];
    const defaultProduct = pickDefaultProduct(defaultSession.productNames);
    const defaultProductData = defaultProduct ? defaultSession.products[defaultProduct] : null;

    setUploadError(null);
    setMarketDataset(bundledDataset);
    setSelectedSessionId(defaultSession.id);
    setSelectedProduct(defaultProduct);
    if (defaultProductData) {
      setQuantityRange([1, defaultProductData.maxTradeQuantity]);
      setActiveTimestamp(defaultProductData.lastTimestamp);
    }
  }

  async function handleStrategyLog(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }

    setStrategyError(null);
    setLoadingStrategy(true);

    try {
      const file = files[0];
      const logs = await file.text();
      const parsedAlgorithm = parseAlgorithmLogs(logs);
      const result = buildStrategyDataset(parsedAlgorithm, file.name);
      const newestSession = result.dataset.sessions[result.dataset.sessions.length - 1];
      const defaultProduct = pickDefaultProduct(newestSession.productNames);
      const defaultProductData = defaultProduct ? newestSession.products[defaultProduct] : null;

      setStrategySourceLabel(file.name);
      setAlgorithm(parsedAlgorithm);
      setSelectedSessionId(newestSession.id);
      setSelectedProduct(defaultProduct);
      if (defaultProductData) {
        setQuantityRange([1, defaultProductData.maxTradeQuantity]);
        setActiveTimestamp(defaultProductData.lastTimestamp);
      }
    } catch (err) {
      setStrategyError(err instanceof Error ? err.message : 'Could not load the strategy log.');
    } finally {
      setLoadingStrategy(false);
    }
  }

  function clearStrategyLog(): void {
    setStrategyError(null);
    setStrategySourceLabel(null);
    setAlgorithm(null);
  }

  const selectedSession = useMemo(
    () => dataset?.sessions.find(session => session.id === selectedSessionId) ?? dataset?.sessions[0] ?? null,
    [dataset, selectedSessionId],
  );

  const resolvedProduct = useMemo(() => {
    if (!selectedSession) {
      return null;
    }

    return selectedProduct && selectedSession.products[selectedProduct]
      ? selectedProduct
      : selectedSession.productNames[0] ?? null;
  }, [selectedProduct, selectedSession]);

  const productData = useMemo(
    () => (selectedSession && resolvedProduct ? selectedSession.products[resolvedProduct] : null),
    [resolvedProduct, selectedSession],
  );

  const strategySessionOverlay = useMemo(
    () =>
      selectedSession
        ? strategyDatasetResult?.overlaysBySessionId[selectedSession.id] ??
          Object.values(strategyDatasetResult?.overlaysBySessionId ?? {}).find(session => session.day === selectedSession.day) ??
          null
        : null,
    [selectedSession, strategyDatasetResult],
  );

  const strategyProductOverlay = useMemo(
    () => (strategySessionOverlay && resolvedProduct ? strategySessionOverlay.products[resolvedProduct] ?? null : null),
    [resolvedProduct, strategySessionOverlay],
  );

  useEffect(() => {
    if (!selectedSession || !productData) {
      return;
    }

    setSelectedProduct(resolvedProduct);
    setQuantityRange(previousRange => [
      1,
      Math.min(previousRange[1], productData.maxTradeQuantity) < 1 ? productData.maxTradeQuantity : Math.min(previousRange[1], productData.maxTradeQuantity),
    ]);
    setActiveTimestamp(productData.lastTimestamp);
  }, [productData, resolvedProduct, selectedSession]);

  const deferredTimestamp = useDeferredValue(activeTimestamp);

  const activeSnapshotIndex = useMemo(
    () => (productData ? findNearestSnapshotIndex(productData.snapshots, deferredTimestamp) : -1),
    [deferredTimestamp, productData],
  );

  const activeSnapshot = activeSnapshotIndex >= 0 && productData ? productData.snapshots[activeSnapshotIndex] : null;

  const visibleLevels = useMemo(() => {
    const levels: number[] = [];

    if (showLevel1) {
      levels.push(1);
    }
    if (showLevel2) {
      levels.push(2);
    }
    if (showLevel3) {
      levels.push(3);
    }

    return levels.length > 0 ? levels : [1];
  }, [showLevel1, showLevel2, showLevel3]);

  const marketSeries = useMemo(
    () =>
      productData
        ? [
            ...buildMarketSeries(
              productData,
              normalization,
              indicator,
              Number(downsampleStep),
              showBook,
              showTrades,
              visibleLevels,
              showAggressiveBuys,
              showAggressiveSells,
              showPassiveTrades,
              quantityRange,
            ),
            ...(strategyProductOverlay
              ? buildStrategySeries(
                  productData,
                  strategyProductOverlay,
                  normalization,
                  showStrategyOrders,
                  showOwnFills,
                  showFillMatches,
                )
              : []),
          ]
        : [],
    [
      downsampleStep,
      indicator,
      normalization,
      productData,
      quantityRange,
      showAggressiveBuys,
      showAggressiveSells,
      showBook,
      showFillMatches,
      showOwnFills,
      showPassiveTrades,
      showStrategyOrders,
      showTrades,
      strategyProductOverlay,
      visibleLevels,
    ],
  );

  const filteredTrades = useMemo(() => {
    if (!productData) {
      return [];
    }

    const visibleClasses = new Set<TradeClassification>();

    if (showAggressiveBuys) {
      visibleClasses.add('aggressive-buy');
    }
    if (showAggressiveSells) {
      visibleClasses.add('aggressive-sell');
    }
    if (showPassiveTrades) {
      visibleClasses.add('passive');
    }

    return productData.trades.filter(
      trade =>
        visibleClasses.has(trade.classification) &&
        trade.quantity >= quantityRange[0] &&
        trade.quantity <= quantityRange[1],
    );
  }, [productData, quantityRange, showAggressiveBuys, showAggressiveSells, showPassiveTrades]);

  const activeTrades = useMemo(() => {
    if (!activeSnapshot) {
      return [];
    }

    return filteredTrades
      .filter(trade => Math.abs(trade.timestamp - activeSnapshot.timestamp) <= DETAIL_WINDOW)
      .sort((a, b) => Math.abs(a.timestamp - activeSnapshot.timestamp) - Math.abs(b.timestamp - activeSnapshot.timestamp))
      .slice(0, 12);
  }, [activeSnapshot, filteredTrades]);

  const activeStrategyOrders = useMemo(() => {
    if (!activeSnapshot || !strategyProductOverlay) {
      return [];
    }

    return strategyProductOverlay.orderEvents
      .filter(event => Math.abs(event.timestamp - activeSnapshot.timestamp) <= DETAIL_WINDOW)
      .sort((a, b) => Math.abs(a.timestamp - activeSnapshot.timestamp) - Math.abs(b.timestamp - activeSnapshot.timestamp))
      .slice(0, 12);
  }, [activeSnapshot, strategyProductOverlay]);

  const activeOwnFills = useMemo(() => {
    if (!activeSnapshot || !strategyProductOverlay) {
      return [];
    }

    return strategyProductOverlay.ownTradeEvents
      .filter(event => Math.abs(event.timestamp - activeSnapshot.timestamp) <= DETAIL_WINDOW)
      .sort((a, b) => Math.abs(a.timestamp - activeSnapshot.timestamp) - Math.abs(b.timestamp - activeSnapshot.timestamp))
      .slice(0, 12);
  }, [activeSnapshot, strategyProductOverlay]);

  const activeFillMatches = useMemo(() => {
    if (!activeSnapshot || !strategyProductOverlay) {
      return [];
    }

    return strategyProductOverlay.fillMatchEvents
      .filter(event => Math.abs(event.timestamp - activeSnapshot.timestamp) <= DETAIL_WINDOW)
      .sort((a, b) => Math.abs(a.timestamp - activeSnapshot.timestamp) - Math.abs(b.timestamp - activeSnapshot.timestamp))
      .slice(0, 12);
  }, [activeSnapshot, strategyProductOverlay]);

  const strategyPnlPoints = useMemo<[number, number][]>(
    () =>
      algorithm && selectedSession
        ? aggregateProfitLossByTimestamp(
            algorithm.activityLogs
              .filter(row => row.day === selectedSession.day)
              .map(row => ({ timestamp: row.timestamp, profitLoss: row.profitLoss })),
          )
        : [],
    [algorithm, selectedSession],
  );

  const pnlSeries = useMemo<Highcharts.SeriesOptionsType[]>(
    () => {
      if (strategyPnlPoints.length > 0) {
        return [
          {
            type: 'line',
            name: 'Backtest PnL',
            color: '#c59834',
            data: strategyPnlPoints,
            marker: {
              enabled: false,
            },
          },
        ];
      }

      return productData
        ? [
            {
              type: 'line',
              name: 'PnL',
              color: '#c59834',
              data: productData.snapshots.map(snapshot => [snapshot.timestamp, snapshot.profitLoss]),
              marker: {
                enabled: false,
              },
            },
          ]
        : [];
    },
    [productData, strategyPnlPoints],
  );

  const flowSeries = useMemo<Highcharts.SeriesOptionsType[]>(
    () =>
      productData
        ? [
            {
              type: 'line',
              name: 'Signed flow',
              color: '#1e6580',
              data: buildFlowSeries(productData.snapshots, filteredTrades),
              marker: {
                enabled: false,
              },
            },
          ]
        : [],
    [filteredTrades, productData],
  );

  const spreadScreenerSeries = useMemo<Highcharts.SeriesOptionsType[]>(
    () => (productData ? buildSpreadScreenerSeries(productData, spreadNormalization) : []),
    [productData, spreadNormalization],
  );

  const averageSpread = useMemo(() => {
    if (!productData) {
      return 0;
    }

    const spreads = productData.snapshots.flatMap(snapshot => (snapshot.spread === null ? [] : [snapshot.spread]));

    return spreads.length === 0 ? 0 : spreads.reduce((sum, spread) => sum + spread, 0) / spreads.length;
  }, [productData]);

  const latestMid = productData?.snapshots[productData.snapshots.length - 1]?.midPrice ?? 0;
  const latestWallMid = productData?.snapshots[productData.snapshots.length - 1]?.wallMid ?? 0;
  const latestBaseMid = productData?.snapshots[productData.snapshots.length - 1]?.baseMid ?? 0;
  const flowData = ((flowSeries[0] as Highcharts.SeriesLineOptions | undefined)?.data ?? []) as [number, number][];
  const flowNow = flowData.length > 0 ? flowData[flowData.length - 1][1] : 0;
  const activeStrategyPosition = useMemo(() => {
    if (!activeSnapshot || !strategyProductOverlay || strategyProductOverlay.positionSeries.length === 0) {
      return null;
    }

    let currentPosition = strategyProductOverlay.positionSeries[0].position;

    strategyProductOverlay.positionSeries.forEach(point => {
      if (point.timestamp <= activeSnapshot.timestamp) {
        currentPosition = point.position;
      }
    });

    return currentPosition;
  }, [activeSnapshot, strategyProductOverlay]);
  const pnlIsFlat = useMemo(
    () => productData?.snapshots.every(snapshot => snapshot.profitLoss === productData.snapshots[0]?.profitLoss) ?? true,
    [productData],
  );
  const marketTimelineAxis = useMemo<Highcharts.XAxisOptions>(
    () => ({
      min: productData?.snapshots[0]?.timestamp,
      max: productData?.snapshots[productData.snapshots.length - 1]?.timestamp,
      plotLines: [
        {
          value: activeSnapshot?.timestamp ?? 0,
          color: '#c59834',
          width: 1,
          dashStyle: 'ShortDot',
          zIndex: 5,
        },
      ],
    }),
    [activeSnapshot?.timestamp, productData],
  );
  const hasBacktestPnl = strategyPnlPoints.length > 0;
  const pnlDescription = hasBacktestPnl
    ? 'Aggregated across all products from the imported strategy log so the backtest equity curve stays aligned with the market tape above.'
    : pnlIsFlat
      ? 'This dataset keeps the file-level PnL flat, but the chart will move automatically when the imported data includes a richer profit-and-loss field.'
      : 'This chart is reading the file-level profit-and-loss column directly from the imported price data.';

  if (error) {
    return (
      <Container py="xl">
        <Alert color="red" title="Dataset load failed">
          {error}
        </Alert>
      </Container>
    );
  }

  if (!dataset || !selectedSession || !productData || !activeSnapshot) {
    return (
      <Center py="xl">
        <Loader size="lg" />
      </Center>
    );
  }

  const marketOptions: Highcharts.Options = {
    chart: {
      height: 560,
    },
    tooltip: {
      shared: false,
      useHTML: true,
      formatter: buildTooltip(normalization),
    },
    plotOptions: {
      series: {
        turboThreshold: 0,
        stickyTracking: false,
        dataGrouping: {
          enabled: false,
        },
        point: {
          events: {
            mouseOver() {
              if (typeof this.x === 'number') {
                setActiveTimestamp(this.x);
              }
            },
          },
        },
      },
      scatter: {
        states: {
          inactive: {
            enabled: false,
          },
        },
      },
    },
    yAxis: {
      title: {
        text: normalization === 'none' ? 'Price' : `Price delta vs ${normalization}`,
      },
      allowDecimals: true,
      labels: {
        formatter() {
          return formatSigned(Number(this.value), normalization === 'none' ? 1 : 1);
        },
      },
    },
    xAxis: {
      ...marketTimelineAxis,
    },
    legend: {
      enabled: true,
    },
  };

  return (
    <Box className={classes.shell}>
      <Container fluid py="lg" className={classes.container}>
        <Stack gap="lg">
          <Paper radius="xl" className={classes.hero}>
            <Group justify="space-between" align="flex-start" gap="lg">
              <Box>
                <Text className={classes.eyebrow}>Prosperity Desk</Text>
                <Title className={classes.headline}>{dataset.title}</Title>
                <Text size="lg" className={classes.lede}>
                  This desk is built for IMC-style `prices` and `trades` CSVs. It starts from bundled sample sessions,
                  and it can also replay backtest logs in the same view so you can inspect the market, your quotes,
                  your fills, and the trades that hit you in one synchronized chart.
                </Text>
                <Text size="sm" mt="sm" className={classes.subtle}>
                  Source: {dataset.source}
                </Text>
              </Box>
              <Stack gap="xs" align="flex-end">
                <Badge size="lg" radius="sm" variant="filled" color="marketBlue">
                  {selectedSession.label}
                </Badge>
                <Badge size="md" radius="sm" variant="light" color="marketRed">
                  {resolvedProduct}
                </Badge>
                <Text size="sm" className={classes.note}>
                  {selectedSession.priceFile} + {selectedSession.tradeFile}
                </Text>
              </Stack>
            </Group>
          </Paper>

          <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />}>
            Trades are classified by comparing each print to the most recent visible best bid and ask. The “Flow Proxy”
            panel is cumulative signed trade flow when raw files do not expose your own positions. `WallMid` is inferred
            from persistent high-volume bid and ask walls so the same screen works on plain market-data exports. When a
            backtest log includes order state, the main plot can overlay your bids, asks, fills, and matched market
            prints directly on top of the market tape.
          </Alert>

          {uploadError && (
            <Alert color="red" variant="light" title="Upload failed">
              {uploadError}
            </Alert>
          )}

          {strategyError && (
            <Alert color="red" variant="light" title="Strategy log failed">
              {strategyError}
            </Alert>
          )}

          {algorithm && strategyDatasetResult && !strategyDatasetResult.supportsOrders && !strategyDatasetResult.supportsOwnTrades && (
            <Alert color="yellow" variant="light" title="Limited backtest overlay">
              This log supports market replay, but it does not include per-timestamp strategy state. You can inspect the
              market and trade history in the dashboard, but your submitted bids, asks, and own fills are not available
              from this file.
            </Alert>
          )}

          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, lg: 8 }}>
              <Paper withBorder radius="xl" p="md" className={classes.panel}>
                <Text className={classes.sectionLabel}>Market Plot</Text>
                <Chart
                  title={`${resolvedProduct} market structure`}
                  series={marketSeries}
                  options={marketOptions}
                />

                <Box mt="md">
                  <Text className={classes.sectionLabel}>Backtest PnL</Text>
                  <Chart
                    title={hasBacktestPnl ? 'Backtest profit and loss' : 'Provided profit and loss'}
                    series={pnlSeries}
                    options={{
                      chart: {
                        height: 240,
                      },
                      plotOptions: {
                        series: {
                          dataGrouping: {
                            enabled: false,
                          },
                          point: {
                            events: {
                              mouseOver() {
                                if (typeof this.x === 'number') {
                                  setActiveTimestamp(this.x);
                                }
                              },
                            },
                          },
                        },
                      },
                      xAxis: {
                        ...marketTimelineAxis,
                      },
                      yAxis: {
                        title: {
                          text: 'PnL',
                        },
                        allowDecimals: true,
                      },
                      legend: {
                        enabled: false,
                      },
                    }}
                  />
                  <Text size="sm" mt="sm" className={classes.subtle}>
                    {pnlDescription}
                  </Text>
                </Box>

                <Paper withBorder radius="lg" p="md" className={classes.scrubberCard}>
                  <Group justify="space-between" mb="xs">
                    <Text fw={600}>Time scrubber</Text>
                    <Text size="sm" className={classes.mono}>
                      {formatNumber(activeSnapshot.timestamp)}
                    </Text>
                  </Group>
                  <Slider
                    min={0}
                    max={productData.snapshots.length - 1}
                    value={activeSnapshotIndex}
                    step={1}
                    onChange={value => setActiveTimestamp(productData.snapshots[value].timestamp)}
                    label={value => formatNumber(productData.snapshots[value].timestamp)}
                    marks={[
                      { value: 0, label: 'Open' },
                      { value: Math.floor((productData.snapshots.length - 1) / 2), label: 'Mid' },
                      { value: productData.snapshots.length - 1, label: 'Close' },
                    ]}
                  />
                </Paper>
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, lg: 4 }}>
              <Stack gap="lg">
                <Paper withBorder radius="xl" p="md" className={classes.panel}>
                  <Text className={classes.sectionLabel}>Controls</Text>
                  <Stack gap="md">
                    <Stack gap="xs">
                      <Text fw={600}>Data input</Text>
                      <Group>
                        <Button component="label" loading={uploading} variant="filled" color="marketBlue">
                          Import market CSVs
                          <input
                            hidden
                            type="file"
                            accept=".csv,text/csv"
                            multiple
                            onChange={event => {
                              void handleAdditionalFiles(event.currentTarget.files);
                              event.currentTarget.value = '';
                            }}
                          />
                        </Button>
                        <Button variant="light" color="gray" onClick={resetToBundledDataset} disabled={!bundledDataset}>
                          Reset to sample
                        </Button>
                      </Group>
                      <Text size="sm" className={classes.subtle}>
                        Files are classified from their headers and paired using filename hints such as shared session
                        stems. If a trade file is missing, the price session still loads with an empty tape.
                      </Text>
                    </Stack>

                    <Stack gap="xs">
                      <Text fw={600}>Backtest overlay</Text>
                      <Group>
                        <Button component="label" loading={loadingStrategy} variant="filled" color="marketRed">
                          Import strategy log
                          <input
                            hidden
                            type="file"
                            accept=".log,.json,text/plain,application/json"
                            onChange={event => {
                              void handleStrategyLog(event.currentTarget.files);
                              event.currentTarget.value = '';
                            }}
                          />
                        </Button>
                        <Button variant="light" color="gray" onClick={clearStrategyLog} disabled={!algorithm}>
                          Clear strategy
                        </Button>
                      </Group>
                      <Text size="sm" className={classes.subtle}>
                        Supports official Prosperity logs for market replay. Submitted bids, asks, and own fills appear
                        when the log contains per-timestamp strategy state from a compatible backtest/logger format.
                      </Text>
                    </Stack>

                    <Divider />

                    <Select
                      label="Session"
                      value={selectedSession.id}
                      data={dataset.sessions.map(session => ({ value: session.id, label: session.label }))}
                      onChange={value => {
                        if (value) {
                          startTransition(() => {
                            setSelectedSessionId(value);
                          });
                        }
                      }}
                    />
                    <Select
                      label="Product"
                      value={resolvedProduct}
                      data={selectedSession.productNames.map(product => ({ value: product, label: product }))}
                      onChange={value => {
                        if (value) {
                          startTransition(() => {
                            setSelectedProduct(value);
                          });
                        }
                      }}
                    />
                    <SimpleGrid cols={2} spacing="md">
                      <Select
                        label="Normalize by"
                        value={normalization}
                        data={[
                          { value: 'none', label: 'Off' },
                          { value: 'mid', label: 'Mid price' },
                          { value: 'wallmid', label: 'WallMid' },
                          { value: 'basemid', label: 'Base Mid' },
                          { value: 'open', label: 'Session open' },
                          { value: 'rolling', label: 'Rolling fair' },
                        ]}
                        onChange={value => {
                          if (value) {
                            startTransition(() => setNormalization(value as IndicatorKey));
                          }
                        }}
                      />
                      <Select
                        label="Overlay"
                        value={indicator}
                        data={[
                          { value: 'wallmid', label: 'WallMid' },
                          { value: 'basemid', label: 'Base Mid' },
                          { value: 'mid', label: 'Mid price' },
                          { value: 'rolling', label: 'Rolling fair' },
                          { value: 'open', label: 'Session open' },
                          { value: 'none', label: 'None' },
                        ]}
                        onChange={value => {
                          if (value) {
                            startTransition(() => setIndicator(value as IndicatorKey));
                          }
                        }}
                      />
                    </SimpleGrid>

                    <Select
                      label="Quote downsample"
                      value={downsampleStep}
                      data={DOWN_SAMPLE_OPTIONS.map(value => ({ value, label: `${value}x` }))}
                      onChange={value => {
                        if (value) {
                          startTransition(() => setDownsampleStep(value));
                        }
                      }}
                    />

                    <Divider />

                    <Stack gap="xs">
                      <Text fw={600}>Visibility</Text>
                      <Checkbox checked={showBook} onChange={event => setShowBook(event.currentTarget.checked)} label="Order book" />
                      <Checkbox checked={showTrades} onChange={event => setShowTrades(event.currentTarget.checked)} label="Trades" />
                    </Stack>

                    <Stack gap="xs">
                      <Text fw={600}>Book levels</Text>
                      <Group gap="md">
                        <Checkbox checked={showLevel1} onChange={event => setShowLevel1(event.currentTarget.checked)} label="L1" />
                        <Checkbox checked={showLevel2} onChange={event => setShowLevel2(event.currentTarget.checked)} label="L2" />
                        <Checkbox checked={showLevel3} onChange={event => setShowLevel3(event.currentTarget.checked)} label="L3" />
                      </Group>
                    </Stack>

                    <Stack gap="xs">
                      <Text fw={600}>Trade classes</Text>
                      <Checkbox checked={showAggressiveBuys} onChange={event => setShowAggressiveBuys(event.currentTarget.checked)} label="Aggressive buys" />
                      <Checkbox checked={showAggressiveSells} onChange={event => setShowAggressiveSells(event.currentTarget.checked)} label="Aggressive sells" />
                      <Checkbox checked={showPassiveTrades} onChange={event => setShowPassiveTrades(event.currentTarget.checked)} label="Passive prints" />
                    </Stack>

                    <Stack gap="xs">
                      <Text fw={600}>Backtest overlays</Text>
                      <Checkbox
                        checked={showStrategyOrders}
                        onChange={event => setShowStrategyOrders(event.currentTarget.checked)}
                        label="Our bids and asks"
                        disabled={!strategyProductOverlay}
                      />
                      <Checkbox
                        checked={showOwnFills}
                        onChange={event => setShowOwnFills(event.currentTarget.checked)}
                        label="Our fills"
                        disabled={!strategyProductOverlay}
                      />
                      <Checkbox
                        checked={showFillMatches}
                        onChange={event => setShowFillMatches(event.currentTarget.checked)}
                        label="Trades that filled us"
                        disabled={!strategyProductOverlay}
                      />
                    </Stack>

                    <Stack gap="xs">
                      <Group justify="space-between">
                        <Text fw={600}>Trade size filter</Text>
                        <Text size="sm" className={classes.mono}>
                          {quantityRange[0]}-{quantityRange[1]}
                        </Text>
                      </Group>
                      <Slider
                        min={1}
                        max={productData.maxTradeQuantity}
                        value={quantityRange[1]}
                        onChange={value => setQuantityRange([1, value])}
                        label={value => formatNumber(value)}
                      />
                    </Stack>

                    <Select
                      label="Spread screener ref"
                      value={spreadNormalization}
                      data={[
                        { value: 'wallmid', label: 'WallMid' },
                        { value: 'mid', label: 'Mid price' },
                      ]}
                      onChange={value => {
                        if (value) {
                          startTransition(() => setSpreadNormalization(value as Extract<IndicatorKey, 'mid' | 'wallmid'>));
                        }
                      }}
                    />
                  </Stack>
                </Paper>

                <Paper withBorder radius="xl" p="md" className={classes.panel}>
                  <Text className={classes.sectionLabel}>Session Readout</Text>
                  <SimpleGrid cols={2} spacing="md">
                    {statCard('Latest mid', formatNumber(latestMid, 1))}
                    {statCard('Latest wallmid', formatNumber(latestWallMid, 1))}
                    {statCard('Latest base mid', formatNumber(latestBaseMid, 1))}
                    {statCard('Avg spread', formatNumber(averageSpread, 1))}
                    {statCard('Visible trades', formatNumber(filteredTrades.length))}
                    {statCard('Flow proxy', formatSigned(flowNow, 0))}
                    {statCard('Our orders', formatNumber(strategyProductOverlay?.orderEvents.length ?? 0))}
                    {statCard('Our fills', formatNumber(strategyProductOverlay?.ownTradeEvents.length ?? 0))}
                    {statCard('Hovered mid', formatNumber(activeSnapshot.midPrice, 1))}
                    {statCard('Hovered wallmid', formatNumber(activeSnapshot.wallMid, 1))}
                    {statCard('Fill matches', formatNumber(strategyProductOverlay?.fillMatchEvents.length ?? 0))}
                    {statCard('Position', activeStrategyPosition === null ? 'n/a' : formatSigned(activeStrategyPosition, 0))}
                    {statCard('Book imbalance', formatSigned(activeSnapshot.bookImbalance * 100, 1), 'percent of visible depth')}
                  </SimpleGrid>
                </Paper>
              </Stack>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder radius="xl" p="md" className={classes.panel}>
                <Text className={classes.sectionLabel}>Spread Screener</Text>
                <Chart
                  title={`Bid/ask distances vs ${indicatorLabel(spreadNormalization)}`}
                  series={spreadScreenerSeries}
                  options={{
                    chart: {
                      height: 320,
                    },
                    yAxis: {
                      title: {
                        text: 'Basis points vs ref',
                      },
                      allowDecimals: true,
                      labels: {
                        formatter() {
                          return `${formatSigned(Number(this.value), 1)} bps`;
                        },
                      },
                    },
                  }}
                />
                <Text size="sm" mt="sm" className={classes.subtle}>
                  This panel normalizes best and wall quote distances relative to either raw mid or inferred wallmid so
                  skew and undercutting stand out immediately.
                </Text>
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder radius="xl" p="md" className={classes.panel}>
                <Text className={classes.sectionLabel}>Flow Proxy</Text>
                <Chart
                  title="Cumulative signed trade flow"
                  series={flowSeries}
                  options={{
                    chart: {
                      height: 320,
                    },
                    yAxis: {
                      title: {
                        text: 'Signed quantity',
                      },
                      allowDecimals: false,
                    },
                    legend: {
                      enabled: false,
                    },
                  }}
                />
                <Text size="sm" mt="sm" className={classes.subtle}>
                  Positive values mean the inferred aggressor flow is buyer-led; negative values mean seller-led.
                </Text>
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder radius="xl" p="md" className={classes.panel}>
                <Text className={classes.sectionLabel}>Depth Snapshot</Text>
                <Group justify="space-between" mb="md">
                    <Text fw={700}>Timestamp {formatNumber(activeSnapshot.timestamp)}</Text>
                    <Badge variant="light" color="marketBlue">
                      Spread {activeSnapshot.spread === null ? 'n/a' : formatNumber(activeSnapshot.spread, 1)}
                  </Badge>
                </Group>
                <Box className={classes.depthHeader}>
                  <Text>Bid Qty</Text>
                  <Text>Bid Px</Text>
                  <Text ta="center">Lvl</Text>
                  <Text>Ask Px</Text>
                  <Text ta="right">Ask Qty</Text>
                </Box>
                {[0, 1, 2].map(index => {
                  const bid = activeSnapshot.bids[index];
                  const ask = activeSnapshot.asks[index];
                  return (
                    <Box key={index} className={classes.depthRow}>
                      <Text className={`${classes.mono} ${classes.bidCell}`}>{bid ? formatNumber(bid.volume) : '—'}</Text>
                      <Text className={`${classes.mono} ${classes.bidCell}`}>{bid ? formatNumber(bid.price, 1) : '—'}</Text>
                      <Text className={classes.levelCell}>L{index + 1}</Text>
                      <Text className={`${classes.mono} ${classes.askCell}`}>{ask ? formatNumber(ask.price, 1) : '—'}</Text>
                      <Text ta="right" className={`${classes.mono} ${classes.askCell}`}>
                        {ask ? formatNumber(ask.volume) : '—'}
                      </Text>
                    </Box>
                  );
                })}
                <Divider my="md" />
                <SimpleGrid cols={2} spacing="md">
                  <Box>
                    <Text size="sm" fw={600}>
                      Mid price
                    </Text>
                    <Text className={classes.mono}>{formatNumber(activeSnapshot.midPrice, 1)}</Text>
                  </Box>
                  <Box>
                    <Text size="sm" fw={600}>
                      WallMid
                    </Text>
                    <Text className={classes.mono}>{formatNumber(activeSnapshot.wallMid, 1)}</Text>
                  </Box>
                  <Box>
                    <Text size="sm" fw={600}>
                      Base mid
                    </Text>
                    <Text className={classes.mono}>{formatNumber(activeSnapshot.baseMid, 1)}</Text>
                  </Box>
                  <Box>
                    <Text size="sm" fw={600}>
                      Rolling fair
                    </Text>
                    <Text className={classes.mono}>{formatNumber(activeSnapshot.rollingMid, 1)}</Text>
                  </Box>
                  <Box>
                    <Text size="sm" fw={600}>
                      Session drift
                    </Text>
                    <Text className={classes.mono}>{formatSigned(activeSnapshot.midPrice - activeSnapshot.openMid, 1)}</Text>
                  </Box>
                  <Box>
                    <Text size="sm" fw={600}>
                      Visible imbalance
                    </Text>
                    <Text className={classes.mono}>{formatSigned(activeSnapshot.bookImbalance * 100, 1)}%</Text>
                  </Box>
                  <Box>
                    <Text size="sm" fw={600}>
                      Wall bid / ask
                    </Text>
                    <Text className={classes.mono}>
                      {activeSnapshot.wallBid === null ? 'n/a' : formatNumber(activeSnapshot.wallBid, 1)} /{' '}
                      {activeSnapshot.wallAsk === null ? 'n/a' : formatNumber(activeSnapshot.wallAsk, 1)}
                    </Text>
                  </Box>
                </SimpleGrid>
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder radius="xl" p="md" className={classes.panel}>
                <Text className={classes.sectionLabel}>Trade Tape</Text>
                {activeTrades.length === 0 ? (
                  <Box className={classes.placeholder}>
                    No trades fall inside the current timestamp window and quantity filter.
                  </Box>
                ) : (
                  <Stack gap={0} className={classes.tradeTape}>
                    {activeTrades.map((trade, index) => (
                      <Box key={`${trade.timestamp}-${trade.price}-${index}`} className={classes.tradeRow}>
                        <Group justify="space-between" align="flex-start">
                          <Box>
                            <Group gap="xs">
                              <Badge color={trade.classification === 'aggressive-buy' ? 'teal' : trade.classification === 'aggressive-sell' ? 'red' : 'yellow'}>
                                {trade.classification}
                              </Badge>
                              <Text className={classes.mono}>{formatNumber(trade.timestamp)}</Text>
                            </Group>
                            <Text mt={6}>
                              <span className={classes.mono}>{formatNumber(trade.price, 1)}</span> for{' '}
                              <span className={classes.mono}>{formatNumber(trade.quantity)}</span>
                            </Text>
                          </Box>
                          <Text size="sm" className={classes.subtle}>
                            ref {trade.referenceBestBid === null ? 'n/a' : formatNumber(trade.referenceBestBid, 1)} /{' '}
                            {trade.referenceBestAsk === null ? 'n/a' : formatNumber(trade.referenceBestAsk, 1)}
                          </Text>
                        </Group>
                      </Box>
                    ))}
                  </Stack>
                )}
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 6 }}>
              <Paper withBorder radius="xl" p="md" className={classes.panel}>
                <Text className={classes.sectionLabel}>Backtest Activity</Text>
                {!strategyProductOverlay ? (
                  <Box className={classes.placeholder}>
                    Load a strategy log and select a matching backtest session to inspect your quotes, fills, and
                    matched market prints here.
                  </Box>
                ) : (
                  <Stack gap="md">
                    <Box>
                      <Group justify="space-between" mb="xs">
                        <Text fw={700}>Our bids and asks</Text>
                        <Text size="sm" className={classes.subtle}>
                          +/- {formatNumber(DETAIL_WINDOW)} ms
                        </Text>
                      </Group>
                      {activeStrategyOrders.length === 0 ? (
                        <Box className={classes.placeholder}>No submitted quotes fall inside the current time window.</Box>
                      ) : (
                        <Stack gap={0} className={classes.tradeTape}>
                          {activeStrategyOrders.map((event, index) => (
                            <Box key={`${event.timestamp}-${event.price}-${event.side}-${index}`} className={classes.tradeRow}>
                              <Group justify="space-between" align="flex-start">
                                <Box>
                                  <Group gap="xs">
                                    <Badge color={event.side === 'bid' ? 'teal' : 'red'}>{event.side}</Badge>
                                    <Text className={classes.mono}>{formatNumber(event.timestamp)}</Text>
                                  </Group>
                                  <Text mt={6}>
                                    <span className={classes.mono}>{formatNumber(event.price, 1)}</span> for{' '}
                                    <span className={classes.mono}>{formatNumber(event.quantity)}</span>
                                  </Text>
                                </Box>
                              </Group>
                            </Box>
                          ))}
                        </Stack>
                      )}
                    </Box>

                    <Divider />

                    <Box>
                      <Text fw={700} mb="xs">
                        Our fills
                      </Text>
                      {activeOwnFills.length === 0 ? (
                        <Box className={classes.placeholder}>No own fills fall inside the current time window.</Box>
                      ) : (
                        <Stack gap={0} className={classes.tradeTape}>
                          {activeOwnFills.map((event, index) => (
                            <Box key={`${event.timestamp}-${event.price}-${event.quantity}-${index}`} className={classes.tradeRow}>
                              <Group justify="space-between" align="flex-start">
                                <Box>
                                  <Group gap="xs">
                                    <Badge color={event.side === 'buy' ? 'teal' : event.side === 'sell' ? 'red' : 'yellow'}>
                                      {event.side}
                                    </Badge>
                                    <Text className={classes.mono}>{formatNumber(event.timestamp)}</Text>
                                  </Group>
                                  <Text mt={6}>
                                    <span className={classes.mono}>{formatNumber(event.price, 1)}</span> for{' '}
                                    <span className={classes.mono}>{formatNumber(event.quantity)}</span>
                                  </Text>
                                </Box>
                                <Text size="sm" className={classes.subtle}>
                                  {event.counterpart ? `vs ${event.counterpart}` : 'counterparty n/a'}
                                </Text>
                              </Group>
                            </Box>
                          ))}
                        </Stack>
                      )}
                    </Box>

                    <Divider />

                    <Box>
                      <Text fw={700} mb="xs">
                        Trades that filled us
                      </Text>
                      {activeFillMatches.length === 0 ? (
                        <Box className={classes.placeholder}>No matching market prints fall inside the current time window.</Box>
                      ) : (
                        <Stack gap={0} className={classes.tradeTape}>
                          {activeFillMatches.map((event, index) => (
                            <Box key={`${event.timestamp}-${event.price}-${event.quantity}-${event.buyer}-${event.seller}-${index}`} className={classes.tradeRow}>
                              <Group justify="space-between" align="flex-start">
                                <Box>
                                  <Group gap="xs">
                                    <Badge color="violet">fill match</Badge>
                                    <Text className={classes.mono}>{formatNumber(event.timestamp)}</Text>
                                  </Group>
                                  <Text mt={6}>
                                    <span className={classes.mono}>{formatNumber(event.price, 1)}</span> for{' '}
                                    <span className={classes.mono}>{formatNumber(event.quantity)}</span>
                                  </Text>
                                </Box>
                                <Text size="sm" className={classes.subtle}>
                                  {event.buyer || '—'} / {event.seller || '—'}
                                </Text>
                              </Group>
                            </Box>
                          ))}
                        </Stack>
                      )}
                    </Box>
                  </Stack>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>
    </Box>
  );
}
