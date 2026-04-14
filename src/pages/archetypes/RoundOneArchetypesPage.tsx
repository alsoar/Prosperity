import Highcharts from 'highcharts';
import {
  Alert,
  Badge,
  Box,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconBolt, IconHierarchy3, IconTimeline } from '@tabler/icons-react';
import { ReactNode, startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import classes from './RoundOneArchetypesPage.module.css';
import { Chart } from '../visualizer/Chart.tsx';
import { formatNumber } from '../../utils/format.ts';

const PRODUCT_COLORS: Record<string, string> = {
  SQUID_INK: '#7f3f2a',
  KELP: '#2d7e6f',
  RAINFOREST_RESIN: '#4568a8',
};

const ORIGIN_BADGE_COLORS: Record<string, string> = {
  dense_flow: 'marketBlue',
  sparse_context: 'marketRed',
  both: 'brass',
};

interface ProductSummary {
  product: string;
  actorCount: number;
  eventCount: number;
  topActorId: string | null;
}

interface ActorEventPoint {
  x: number;
  day: number;
  timestamp: number;
  direction: 'buy' | 'sell';
  origin: string;
  quantity: number;
  price: number;
  fingerprintKey: string;
}

interface ScoreBreakdown {
  coherence: number;
  persistence: number;
  edge: number;
  recency: number;
  contradiction: number;
  fragmentationPenalty: number;
}

interface DayBreakdown {
  day: number;
  eventCount: number;
}

interface ActorRecord {
  actorId: string;
  product: string;
  description: string;
  naturalLanguageSummary: string;
  dominantDirectionLabel: string;
  flowStyleLabel: string;
  sizeFamily: string;
  sizeKeys: string[];
  medianQuantity: number;
  round1ConvictionScore: number;
  overallActorScore: number;
  round1EventCount: number;
  round1ActiveDays: number[];
  round1DayBreakdown: DayBreakdown[];
  memberFingerprints: number;
  memberFingerprintKeys: string[];
  directionCounts: {
    buy: number;
    sell: number;
  };
  directionShares: {
    buy: number;
    sell: number;
  };
  originCounts: Record<string, number>;
  originShares: Record<string, number>;
  buyLowStrength: number;
  sellHighStrength: number;
  sessionExtremaFraction: number;
  localExtremaFraction: number;
  forwardReturnBps2000: number;
  hitRate2000: number;
  profitabilityProxyBps2000: number;
  profitableEventShare: number;
  edgePerEventRank: number;
  edgePerEventBand: string;
  scoreBreakdown: ScoreBreakdown;
  latestDay: number;
  latestTimestamp: number;
  eventSeries: ActorEventPoint[];
  recentEvents: ActorEventPoint[];
  rank: number;
  convictionBand: string;
  profitabilityRank: number;
  profitabilityBand: string;
}

interface RoundOneArchetypesPayload {
  round: number;
  scope: string;
  summary: {
    actorCount: number;
    eventCount: number;
    products: ProductSummary[];
    days: number[];
    topConvictionActorId: string | null;
    topProfitabilityActorId: string | null;
    topEdgeActorId: string | null;
  };
  actors: ActorRecord[];
}

interface ArchetypePointMeta {
  actorId: string;
  description: string;
  product: string;
  eventCount: number;
  metricValue: number;
  metricLabel: string;
  flowStyleLabel: string;
}

interface TimelinePointMeta {
  day: number;
  timestamp: number;
  origin: string;
  quantity: number;
  fingerprintKey: string;
}

function formatPercent(value: number, digits: number = 0): string {
  return `${formatNumber(value * 100, digits)}%`;
}

function formatDay(day: number): string {
  return `Day ${day}`;
}

function formatDayRange(days: number[]): string {
  if (days.length === 0) {
    return 'Unknown sessions';
  }

  if (days.length === 1) {
    return formatDay(days[0]);
  }

  if (days.length === 2) {
    return `${formatDay(days[0])} and ${formatDay(days[1])}`;
  }

  return `${days.slice(0, -1).map(formatDay).join(', ')}, and ${formatDay(days[days.length - 1])}`;
}

function flowLabel(value: string): string {
  switch (value) {
    case 'dense recurring':
      return 'Dense recurring';
    case 'sparse context':
      return 'Sparse context';
    case 'reinforced mix':
      return 'Reinforced mix';
    case 'mixed':
      return 'Mixed';
    default:
      return value;
  }
}

function directionLabel(value: string): string {
  switch (value) {
    case 'sell-the-rips':
      return 'Sell the rips';
    case 'buy-the-dips':
      return 'Buy the dips';
    case 'two-sided swing':
      return 'Two-sided swing';
    case 'mixed directional':
      return 'Mixed directional';
    default:
      return value;
  }
}

function convictionColor(value: string): string {
  switch (value) {
    case 'high conviction':
      return 'marketRed';
    case 'watchlist':
      return 'marketBlue';
    default:
      return 'gray';
  }
}

function profitabilityColor(value: string): string {
  switch (value) {
    case 'top earner':
      return 'teal';
    case 'positive edge':
      return 'marketBlue';
    default:
      return 'gray';
  }
}

function edgeColor(value: string): string {
  switch (value) {
    case 'elite edge':
      return 'teal';
    case 'positive edge':
      return 'marketBlue';
    default:
      return 'gray';
  }
}

function focusNote(actor: ActorRecord): string {
  if (actor.flowStyleLabel === 'dense recurring' && actor.round1EventCount > 250) {
    return 'Persistent background flow. Useful for tape bias, but not necessarily unique.';
  }

  if (actor.flowStyleLabel === 'sparse context' && actor.sellHighStrength > actor.buyLowStrength + 0.1) {
    return 'Sparse high-signal seller. Watch for fresh flags near local or session highs.';
  }

  if (actor.flowStyleLabel === 'sparse context' && actor.buyLowStrength > actor.sellHighStrength + 0.1) {
    return 'Sparse high-signal buyer. Watch for fresh flags into weakness.';
  }

  if (actor.buyLowStrength > 0.2 && actor.sellHighStrength > 0.2) {
    return 'Looks like a two-sided swing operator recycling inventory around extremes.';
  }

  return 'Track the linked flagged events rather than reading this as a single clean identity.';
}

function profitabilityNote(actor: ActorRecord): string {
  if (actor.profitabilityProxyBps2000 >= 25_000) {
    return 'This is one of the strongest cumulative edge streams in the current Round 1 screen.';
  }

  if (actor.forwardReturnBps2000 >= 120) {
    return 'This is a high-quality edge stream, even if it fires less often.';
  }

  if (actor.profitabilityProxyBps2000 > 0) {
    return 'Positive, but the edge is thinner or more dependent on recurrence.';
  }

  return 'This actor is more interesting structurally than economically so far.';
}

function memberPreview(keys: string[]): string[] {
  return keys.slice(0, 8);
}

function productOptions(products: ProductSummary[]): { value: string; label: string }[] {
  return [
    { value: 'all', label: 'All products' },
    ...products.map(product => ({
      value: product.product,
      label: `${product.product} (${formatNumber(product.actorCount)})`,
    })),
  ];
}

function buildConvictionSeries(
  actors: ActorRecord[],
  metricMode: 'conviction' | 'profitability' | 'edge_per_event',
  onSelect: (actorId: string) => void,
): Highcharts.SeriesOptionsType[] {
  const grouped = new Map<string, ActorRecord[]>();

  actors.forEach(actor => {
    const productActors = grouped.get(actor.product) ?? [];
    productActors.push(actor);
    grouped.set(actor.product, productActors);
  });

  return [...grouped.entries()].map(([product, productActors]) => ({
    type: 'scatter',
    name: product,
    color: PRODUCT_COLORS[product] ?? '#6d7786',
    data: productActors.map(actor => ({
      x: actor.round1EventCount,
      y:
        metricMode === 'conviction'
          ? actor.round1ConvictionScore
          : metricMode === 'profitability'
          ? actor.profitabilityProxyBps2000
          : actor.forwardReturnBps2000,
      marker: {
        radius: 5 + Math.min(actor.memberFingerprints, 16) * 0.4,
      },
      custom: {
        actorId: actor.actorId,
        description: actor.description,
        product: actor.product,
        eventCount: actor.round1EventCount,
        metricValue:
          metricMode === 'conviction'
            ? actor.round1ConvictionScore
            : metricMode === 'profitability'
            ? actor.profitabilityProxyBps2000
            : actor.forwardReturnBps2000,
        metricLabel:
          metricMode === 'conviction'
            ? 'Conviction'
            : metricMode === 'profitability'
            ? 'Cumulative edge proxy'
            : 'Average edge per event',
        flowStyleLabel: actor.flowStyleLabel,
      } satisfies ArchetypePointMeta,
      events: {
        click() {
          onSelect(actor.actorId);
        },
      },
    })),
  }));
}

function buildTimelineSeries(actor: ActorRecord): Highcharts.SeriesOptionsType[] {
  const buys = actor.eventSeries
    .map((point, index) => ({ point, index }))
    .filter(item => item.point.direction === 'buy')
    .map(({ point, index }) => ({
      x: index + 1,
      y: point.price,
      marker: {
        symbol: point.origin === 'both' ? 'diamond' : 'triangle',
        radius: point.origin === 'both' ? 6 : 5,
      },
      custom: {
        day: point.day,
        timestamp: point.timestamp,
        origin: point.origin,
        quantity: point.quantity,
        fingerprintKey: point.fingerprintKey,
      } satisfies TimelinePointMeta,
    }));

  const sells = actor.eventSeries
    .map((point, index) => ({ point, index }))
    .filter(item => item.point.direction === 'sell')
    .map(({ point, index }) => ({
      x: index + 1,
      y: point.price,
      marker: {
        symbol: point.origin === 'both' ? 'diamond' : 'triangle-down',
        radius: point.origin === 'both' ? 6 : 5,
      },
      custom: {
        day: point.day,
        timestamp: point.timestamp,
        origin: point.origin,
        quantity: point.quantity,
        fingerprintKey: point.fingerprintKey,
      } satisfies TimelinePointMeta,
    }));

  return [
    {
      type: 'scatter',
      name: 'Buy-side flags',
      color: '#167f6a',
      data: buys,
    },
    {
      type: 'scatter',
      name: 'Sell-side flags',
      color: '#b6402c',
      data: sells,
    },
  ];
}

export function RoundOneArchetypesPage(): ReactNode {
  const [payload, setPayload] = useState<RoundOneArchetypesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [productFilter, setProductFilter] = useState('all');
  const [flowFilter, setFlowFilter] = useState('all');
  const [dayFilter, setDayFilter] = useState('all');
  const [sortMode, setSortMode] = useState<'conviction' | 'profitability' | 'edge_per_event'>('conviction');
  const [minEvents, setMinEvents] = useState(8);
  const [maxActors, setMaxActors] = useState(12);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);

  const deferredProductFilter = useDeferredValue(productFilter);
  const deferredFlowFilter = useDeferredValue(flowFilter);
  const deferredDayFilter = useDeferredValue(dayFilter);
  const deferredSortMode = useDeferredValue(sortMode);
  const deferredMinEvents = useDeferredValue(minEvents);
  const deferredMaxActors = useDeferredValue(maxActors);

  useEffect(() => {
    let cancelled = false;

    fetch(`${import.meta.env.BASE_URL}prosperity-3-round-1/actor_archetypes.json`)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Could not load Round 1 archetypes: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<RoundOneArchetypesPayload>;
      })
      .then(data => {
        if (cancelled) {
          return;
        }

        setPayload(data);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }

        setError(reason instanceof Error ? reason.message : 'Could not load Round 1 archetype data.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredActors = useMemo(() => {
    if (!payload) {
      return [];
    }

    return payload.actors.filter(actor => {
      if (deferredProductFilter !== 'all' && actor.product !== deferredProductFilter) {
        return false;
      }

      if (deferredFlowFilter !== 'all' && actor.flowStyleLabel !== deferredFlowFilter) {
        return false;
      }

      if (deferredDayFilter !== 'all' && !actor.round1ActiveDays.includes(Number(deferredDayFilter))) {
        return false;
      }

      if (actor.round1EventCount < deferredMinEvents) {
        return false;
      }

      return true;
    });
  }, [payload, deferredProductFilter, deferredFlowFilter, deferredDayFilter, deferredMinEvents]);

  const sortedActors = useMemo(() => {
    const actors = [...filteredActors];

    actors.sort((left, right) => {
      if (deferredSortMode === 'profitability') {
        return (
          right.profitabilityProxyBps2000 - left.profitabilityProxyBps2000 ||
          right.forwardReturnBps2000 - left.forwardReturnBps2000 ||
          left.actorId.localeCompare(right.actorId)
        );
      }

      if (deferredSortMode === 'edge_per_event') {
        return (
          right.forwardReturnBps2000 - left.forwardReturnBps2000 ||
          right.hitRate2000 - left.hitRate2000 ||
          left.actorId.localeCompare(right.actorId)
        );
      }

      return (
        right.round1ConvictionScore - left.round1ConvictionScore ||
        right.round1EventCount - left.round1EventCount ||
        left.actorId.localeCompare(right.actorId)
      );
    });

    return actors;
  }, [filteredActors, deferredSortMode]);

  const visibleActors = useMemo(
    () => sortedActors.slice(0, deferredMaxActors),
    [sortedActors, deferredMaxActors],
  );

  useEffect(() => {
    if (visibleActors.length === 0) {
      setSelectedActorId(null);
      return;
    }

    if (!selectedActorId || !visibleActors.some(actor => actor.actorId === selectedActorId)) {
      startTransition(() => {
        setSelectedActorId(visibleActors[0].actorId);
      });
    }
  }, [visibleActors, selectedActorId]);

  const selectedActor = useMemo(
    () => visibleActors.find(actor => actor.actorId === selectedActorId) ?? visibleActors[0] ?? null,
    [visibleActors, selectedActorId],
  );

  const filteredEventCount = useMemo(
    () => filteredActors.reduce((runningTotal, actor) => runningTotal + actor.round1EventCount, 0),
    [filteredActors],
  );

  const filteredProfitability = useMemo(
    () => filteredActors.reduce((runningTotal, actor) => runningTotal + actor.profitabilityProxyBps2000, 0),
    [filteredActors],
  );

  const topProduct = useMemo(() => {
    if (filteredActors.length === 0) {
      return null;
    }

    const counts = filteredActors.reduce<Record<string, number>>((result, actor) => {
      result[actor.product] = (result[actor.product] ?? 0) + actor.round1EventCount;
      return result;
    }, {});

    return Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }, [filteredActors]);

  const topProfitActor = useMemo(
    () => [...filteredActors].sort((left, right) => right.profitabilityProxyBps2000 - left.profitabilityProxyBps2000)[0] ?? null,
    [filteredActors],
  );

  const topEdgeActor = useMemo(
    () => [...filteredActors].sort((left, right) => right.forwardReturnBps2000 - left.forwardReturnBps2000)[0] ?? null,
    [filteredActors],
  );

  const datasetTitle = useMemo(() => {
    const roundLabel = payload?.round !== null && payload?.round !== undefined ? `Round ${formatNumber(payload.round, 0)}` : 'Archetype';
    const scopeLabel = payload?.scope === 'anonymous' ? 'Anonymous' : payload?.scope ?? 'Unknown';
    return `${roundLabel} ${scopeLabel} Archetypes`;
  }, [payload?.round, payload?.scope]);

  const datasetSubtitle = useMemo(() => {
    const productList = (payload?.summary.products ?? []).map(product => product.product).join(' · ');
    return productList.length > 0 ? productList : 'No products in scope';
  }, [payload?.summary.products]);

  const daysSummary = useMemo(() => formatDayRange(payload?.summary.days ?? []), [payload?.summary.days]);

  const convictionSeries = useMemo(
    () =>
      buildConvictionSeries(visibleActors, deferredSortMode, actorId => {
        startTransition(() => {
          setSelectedActorId(actorId);
        });
      }),
    [visibleActors, deferredSortMode],
  );

  const timelineSeries = useMemo(
    () => (selectedActor ? buildTimelineSeries(selectedActor) : []),
    [selectedActor],
  );

  if (loading) {
    return (
      <Center mih="70vh">
        <Loader color="marketBlue" size="lg" />
      </Center>
    );
  }

  if (error || !payload) {
    return (
      <Container size="xl" py="xl">
        <Alert color="red" icon={<IconAlertCircle size={16} />} title="Archetypes unavailable">
          {error ?? 'The archetype payload could not be loaded.'}
        </Alert>
      </Container>
    );
  }

  return (
    <Box className={classes.shell}>
      <Container size="xl" className={classes.container}>
        <Stack gap="xl">
          <Paper radius="xl" className={classes.hero}>
            <Text className={classes.eyebrow}>{datasetSubtitle}</Text>
            <Title order={1} className={classes.headline}>
              {datasetTitle}
            </Title>
            <Text className={classes.lede}>
              This view takes the currently bundled detector outputs and assembles them into ranked hidden-trader
              archetypes. Each card is a working hypothesis: product, size family, flow style, and a plain-English read
              of what the screener thinks is happening.
            </Text>

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} mt="lg">
              <Paper className={classes.statCard} radius="lg">
                <Text className={classes.statLabel}>Visible Archetypes</Text>
                <Text className={classes.statValue}>{formatNumber(filteredActors.length)}</Text>
                <Text size="sm" className={classes.subtle}>
                  Filtered from {formatNumber(payload.summary.actorCount)} actor candidates.
                </Text>
              </Paper>
              <Paper className={classes.statCard} radius="lg">
                <Text className={classes.statLabel}>Flagged Events</Text>
                <Text className={classes.statValue}>{formatNumber(filteredEventCount)}</Text>
                <Text size="sm" className={classes.subtle}>
                  {payload.scope} events across {daysSummary}.
                </Text>
              </Paper>
              <Paper className={classes.statCard} radius="lg">
                <Text className={classes.statLabel}>Products In Scope</Text>
                <Text className={classes.statValue}>{formatNumber(payload.summary.products.length)}</Text>
                <Text size="sm" className={classes.subtle}>
                  {payload.summary.products.map(product => product.product).join(' · ')}
                </Text>
              </Paper>
              <Paper className={classes.statCard} radius="lg">
                <Text className={classes.statLabel}>Heaviest Tape</Text>
                <Text className={classes.statValue}>{topProduct ?? 'n/a'}</Text>
                <Text size="sm" className={classes.subtle}>
                  By filtered flagged-event count.
                </Text>
              </Paper>
              <Paper className={classes.statCard} radius="lg">
                <Text className={classes.statLabel}>Edge Proxy</Text>
                <Text className={classes.statValue}>{formatNumber(filteredProfitability, 0)} bps</Text>
                <Text size="sm" className={classes.subtle}>
                  Sum of signed 2s forward returns across the filtered actor set.
                </Text>
              </Paper>
              <Paper className={classes.statCard} radius="lg">
                <Text className={classes.statLabel}>Top Earner</Text>
                <Text className={classes.statValue}>{topProfitActor?.product ?? 'n/a'}</Text>
                <Text size="sm" className={classes.subtle}>
                  {topProfitActor ? `${topProfitActor.actorId} · ${formatNumber(topProfitActor.profitabilityProxyBps2000, 0)} bps` : 'No actor in scope'}
                </Text>
              </Paper>
              <Paper className={classes.statCard} radius="lg">
                <Text className={classes.statLabel}>Top Edge / Event</Text>
                <Text className={classes.statValue}>{topEdgeActor?.product ?? 'n/a'}</Text>
                <Text size="sm" className={classes.subtle}>
                  {topEdgeActor ? `${topEdgeActor.actorId} · ${formatNumber(topEdgeActor.forwardReturnBps2000, 0)} bps` : 'No actor in scope'}
                </Text>
              </Paper>
            </SimpleGrid>
          </Paper>

          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, lg: 4 }}>
              <Paper radius="xl" p="lg" className={classes.panel}>
                <Text className={classes.sectionLabel}>Filters</Text>
                <Stack gap="md">
                  <Select
                    label="Rank by"
                    value={sortMode}
                    data={[
                      { value: 'conviction', label: 'Conviction' },
                      { value: 'profitability', label: 'Profitability proxy' },
                      { value: 'edge_per_event', label: 'Edge per event' },
                    ]}
                    onChange={value => {
                      startTransition(() => {
                        setSortMode((value as 'conviction' | 'profitability' | 'edge_per_event' | null) ?? 'conviction');
                      });
                    }}
                  />
                  <Stack gap={4}>
                    <Group justify="space-between">
                      <Text size="sm">Minimum flagged events</Text>
                      <Text size="sm" className={classes.mono}>
                        {formatNumber(minEvents)}
                      </Text>
                    </Group>
                    <Slider min={1} max={80} step={1} value={minEvents} onChange={setMinEvents} />
                    <Text size="xs" className={classes.subtle}>
                      Applied before ranking so sparse one-off actors do not dominate the edge-per-event view.
                    </Text>
                  </Stack>
                  <Select
                    label="Product"
                    value={productFilter}
                    data={productOptions(payload.summary.products)}
                    onChange={value => {
                      startTransition(() => {
                        setProductFilter(value ?? 'all');
                      });
                    }}
                  />
                  <Select
                    label="Flow style"
                    value={flowFilter}
                    data={[
                      { value: 'all', label: 'All flow styles' },
                      { value: 'dense recurring', label: 'Dense recurring' },
                      { value: 'sparse context', label: 'Sparse context' },
                      { value: 'reinforced mix', label: 'Reinforced mix' },
                      { value: 'mixed', label: 'Mixed' },
                    ]}
                    onChange={value => {
                      startTransition(() => {
                        setFlowFilter(value ?? 'all');
                      });
                    }}
                  />
                  <Select
                    label="Day"
                    value={dayFilter}
                    data={[
                      { value: 'all', label: 'All Round 1 days' },
                      ...payload.summary.days.map(day => ({ value: String(day), label: formatDay(day) })),
                    ]}
                    onChange={value => {
                      startTransition(() => {
                        setDayFilter(value ?? 'all');
                      });
                    }}
                  />
                  <Stack gap={4}>
                    <Group justify="space-between">
                      <Text size="sm">Visible ranks</Text>
                      <Text size="sm" className={classes.mono}>
                        {formatNumber(maxActors)}
                      </Text>
                    </Group>
                    <Slider
                      min={6}
                      max={Math.max(payload.summary.actorCount, 6)}
                      step={1}
                      value={maxActors}
                      onChange={setMaxActors}
                    />
                  </Stack>
                </Stack>
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, lg: 8 }}>
              <Chart
                title={
                  deferredSortMode === 'conviction'
                    ? 'Conviction Map'
                    : deferredSortMode === 'profitability'
                    ? 'Profitability Map'
                    : 'Edge Per Event Map'
                }
                series={convictionSeries}
                options={{
                  chart: {
                    height: 360,
                  },
                  xAxis: {
                    title: {
                      text: 'Round 1 flagged events',
                    },
                    type: 'linear',
                  },
                  yAxis: {
                    title: {
                      text:
                        deferredSortMode === 'conviction'
                          ? 'Round 1 conviction score'
                          : deferredSortMode === 'profitability'
                          ? 'Cumulative edge proxy (bps)'
                          : 'Average edge per flagged event (bps)',
                    },
                  },
                  tooltip: {
                    shared: false,
                    formatter(this: Highcharts.TooltipFormatterContextObject): string {
                      const point = this.point as Highcharts.Point & { options: { custom?: ArchetypePointMeta } };
                      const meta = point.options.custom;

                      if (!meta) {
                        return '';
                      }

                      return [
                        `<div style="font-size:12px"><strong>${meta.actorId}</strong></div>`,
                        `<div>${meta.product}</div>`,
                        `<div>${meta.description}</div>`,
                        `<div>Flow: ${flowLabel(meta.flowStyleLabel)}</div>`,
                        `<div>${meta.metricLabel}: ${formatNumber(meta.metricValue, deferredSortMode === 'conviction' ? 2 : 0)}${deferredSortMode === 'conviction' ? '' : ' bps'}</div>`,
                        `<div>Events: ${formatNumber(meta.eventCount)}</div>`,
                      ].join('');
                    },
                  },
                  legend: {
                    enabled: true,
                  },
                }}
              />
            </Grid.Col>
          </Grid>

          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, xl: 4 }}>
              <Paper radius="xl" p="lg" className={classes.panel}>
                <Group justify="space-between" mb="sm">
                  <div>
                    <Text className={classes.sectionLabel}>Ranked Archetypes</Text>
                    <Text size="sm" className={classes.subtle}>
                      Sorted by{' '}
                      {deferredSortMode === 'conviction'
                        ? 'conviction'
                        : deferredSortMode === 'profitability'
                        ? 'cumulative edge proxy'
                        : 'average edge per flagged event'}
                      , not raw fingerprint count.
                    </Text>
                  </div>
                  <Badge color="brass" variant="light" radius="sm" leftSection={<IconHierarchy3 size={12} />}>
                    Top {formatNumber(visibleActors.length)}
                  </Badge>
                </Group>

                <Stack gap="sm" className={classes.leaderboard}>
                  {visibleActors.map(actor => (
                    <Paper
                      key={actor.actorId}
                      radius="lg"
                      className={`${classes.leaderCard} ${selectedActor?.actorId === actor.actorId ? classes.leaderCardSelected : ''}`}
                      onClick={() => {
                        startTransition(() => {
                          setSelectedActorId(actor.actorId);
                        });
                      }}
                    >
                      <Group align="flex-start" wrap="nowrap">
                        <div className={classes.rankPill}>
                          #
                          {deferredSortMode === 'conviction'
                            ? actor.rank
                            : deferredSortMode === 'profitability'
                            ? actor.profitabilityRank
                            : actor.edgePerEventRank}
                        </div>
                        <Stack gap={8} style={{ flex: 1 }}>
                          <Group justify="space-between" gap="sm" wrap="wrap">
                            <div>
                              <Text fw={700}>{actor.product}</Text>
                              <Text size="sm" className={classes.subtle}>
                                {actor.description}
                              </Text>
                            </div>
                            <div>
                              <Text ta="right" size="xs" className={classes.subtle}>
                                {deferredSortMode === 'conviction'
                                  ? 'Conviction'
                                  : deferredSortMode === 'profitability'
                                  ? 'Cumulative edge proxy'
                                  : 'Average edge / event'}
                              </Text>
                              <Text className={classes.scoreValue} ta="right">
                                {deferredSortMode === 'conviction'
                                  ? formatNumber(actor.round1ConvictionScore, 2)
                                  : deferredSortMode === 'profitability'
                                  ? `${formatNumber(actor.profitabilityProxyBps2000, 0)} bps`
                                  : `${formatNumber(actor.forwardReturnBps2000, 0)} bps`}
                              </Text>
                            </div>
                          </Group>

                          <div className={classes.metaRow}>
                            <Badge
                              color={
                                deferredSortMode === 'conviction'
                                  ? convictionColor(actor.convictionBand)
                                  : deferredSortMode === 'profitability'
                                  ? profitabilityColor(actor.profitabilityBand)
                                  : edgeColor(actor.edgePerEventBand)
                              }
                              variant="light"
                            >
                              {deferredSortMode === 'conviction'
                                ? actor.convictionBand
                                : deferredSortMode === 'profitability'
                                ? actor.profitabilityBand
                                : actor.edgePerEventBand}
                            </Badge>
                            <Badge color="marketBlue" variant="light">
                              {flowLabel(actor.flowStyleLabel)}
                            </Badge>
                            <Badge color="gray" variant="light">
                              {directionLabel(actor.dominantDirectionLabel)}
                            </Badge>
                            <Badge color="brass" variant="light">
                              {actor.sizeFamily}
                            </Badge>
                          </div>

                          <Text size="sm">{focusNote(actor)}</Text>
                          <Group gap="md">
                            <Text size="sm" className={classes.subtle}>
                              Events <span className={classes.mono}>{formatNumber(actor.round1EventCount)}</span>
                            </Text>
                            <Text size="sm" className={classes.subtle}>
                              Edge <span className={classes.mono}>{formatNumber(actor.forwardReturnBps2000, 0)} bps</span>
                            </Text>
                            <Text size="sm" className={classes.subtle}>
                              Profit proxy <span className={classes.mono}>{formatNumber(actor.profitabilityProxyBps2000, 0)} bps</span>
                            </Text>
                            <Text size="sm" className={classes.subtle}>
                              Hit rate <span className={classes.mono}>{formatPercent(actor.hitRate2000)}</span>
                            </Text>
                          </Group>
                        </Stack>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, xl: 8 }}>
              {selectedActor ? (
                <Stack gap="lg">
                  <Paper radius="xl" p="lg" className={classes.panel}>
                    <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
                      <div>
                        <Text className={classes.sectionLabel}>Selected Archetype</Text>
                        <Title order={2}>{selectedActor.description}</Title>
                        <Text size="sm" className={classes.subtle} mt={4}>
                          {selectedActor.actorId} · ranked #
                          {deferredSortMode === 'conviction'
                            ? selectedActor.rank
                            : deferredSortMode === 'profitability'
                            ? selectedActor.profitabilityRank
                            : selectedActor.edgePerEventRank}{' '}
                          by {deferredSortMode === 'conviction' ? 'conviction' : deferredSortMode === 'profitability' ? 'profitability' : 'edge per event'}
                        </Text>
                      </div>
                      <Group gap="xs">
                        <Badge
                          color={
                            deferredSortMode === 'conviction'
                              ? convictionColor(selectedActor.convictionBand)
                              : deferredSortMode === 'profitability'
                              ? profitabilityColor(selectedActor.profitabilityBand)
                              : edgeColor(selectedActor.edgePerEventBand)
                          }
                          variant="light"
                        >
                          {deferredSortMode === 'conviction'
                            ? selectedActor.convictionBand
                            : deferredSortMode === 'profitability'
                            ? selectedActor.profitabilityBand
                            : selectedActor.edgePerEventBand}
                        </Badge>
                        <Badge color="marketBlue" variant="light">
                          {flowLabel(selectedActor.flowStyleLabel)}
                        </Badge>
                        <Badge color="marketRed" variant="light">
                          {directionLabel(selectedActor.dominantDirectionLabel)}
                        </Badge>
                        <Badge color="brass" variant="light">
                          {selectedActor.sizeFamily}
                        </Badge>
                      </Group>
                    </Group>

                    <SimpleGrid cols={{ base: 1, md: 2, xl: 4 }} mt="lg">
                      <Paper className={classes.statCard} radius="lg">
                        <Text className={classes.statLabel}>Conviction</Text>
                        <Text className={classes.statValue}>{formatNumber(selectedActor.round1ConvictionScore, 2)}</Text>
                        <Text size="sm" className={classes.subtle}>
                          Base actor score {formatNumber(selectedActor.overallActorScore, 2)}
                        </Text>
                      </Paper>
                      <Paper className={classes.statCard} radius="lg">
                        <Text className={classes.statLabel}>Profitability Proxy</Text>
                        <Text className={classes.statValue}>{formatNumber(selectedActor.profitabilityProxyBps2000, 0)} bps</Text>
                        <Text size="sm" className={classes.subtle}>
                          Rank #{formatNumber(selectedActor.profitabilityRank)} · {formatPercent(selectedActor.profitableEventShare)} profitable events
                        </Text>
                      </Paper>
                      <Paper className={classes.statCard} radius="lg">
                        <Text className={classes.statLabel}>Flagged Events</Text>
                        <Text className={classes.statValue}>{formatNumber(selectedActor.round1EventCount)}</Text>
                        <Text size="sm" className={classes.subtle}>
                          {selectedActor.round1ActiveDays.map(formatDay).join(' · ')}
                        </Text>
                      </Paper>
                      <Paper className={classes.statCard} radius="lg">
                        <Text className={classes.statLabel}>2s Forward Edge</Text>
                        <Text className={classes.statValue}>{formatNumber(selectedActor.forwardReturnBps2000, 0)} bps</Text>
                        <Text size="sm" className={classes.subtle}>
                          Hit rate {formatPercent(selectedActor.hitRate2000)}
                        </Text>
                      </Paper>
                      <Paper className={classes.statCard} radius="lg">
                        <Text className={classes.statLabel}>Member Fingerprints</Text>
                        <Text className={classes.statValue}>{formatNumber(selectedActor.memberFingerprints)}</Text>
                        <Text size="sm" className={classes.subtle}>
                          Size keys {selectedActor.sizeKeys.join(', ')}
                        </Text>
                      </Paper>
                    </SimpleGrid>

                    <Paper radius="lg" mt="lg" className={classes.narrative}>
                      <Group gap="xs" mb="xs">
                        <Badge variant="light" color="brass" leftSection={<IconBolt size={12} />}>
                          Natural-language read
                        </Badge>
                      </Group>
                      <Text>{selectedActor.naturalLanguageSummary}</Text>
                      <Text mt="sm" size="sm" className={classes.subtle}>
                        {focusNote(selectedActor)}
                      </Text>
                      <Text mt="xs" size="sm" className={classes.subtle}>
                        {profitabilityNote(selectedActor)}
                      </Text>
                    </Paper>

                    <SimpleGrid cols={{ base: 1, md: 2 }} mt="lg">
                      <Paper className={classes.statCard} radius="lg">
                        <Text className={classes.statLabel}>Extrema Tendencies</Text>
                        <Stack gap={8} mt="sm">
                          <Group justify="space-between">
                            <Text size="sm">Buy-low strength</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatPercent(selectedActor.buyLowStrength)}
                            </Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="sm">Sell-high strength</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatPercent(selectedActor.sellHighStrength)}
                            </Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="sm">Session-extrema share</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatPercent(selectedActor.sessionExtremaFraction)}
                            </Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="sm">Local-extrema share</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatPercent(selectedActor.localExtremaFraction)}
                            </Text>
                          </Group>
                        </Stack>
                      </Paper>

                      <Paper className={classes.statCard} radius="lg">
                        <Text className={classes.statLabel}>Score Breakdown</Text>
                        <Stack gap={8} mt="sm">
                          <Group justify="space-between">
                            <Text size="sm">Coherence</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatNumber(selectedActor.scoreBreakdown.coherence, 2)}
                            </Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="sm">Persistence</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatNumber(selectedActor.scoreBreakdown.persistence, 2)}
                            </Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="sm">Edge</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatNumber(selectedActor.scoreBreakdown.edge, 2)}
                            </Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="sm">Recency</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatNumber(selectedActor.scoreBreakdown.recency, 2)}
                            </Text>
                          </Group>
                          <Group justify="space-between">
                            <Text size="sm">Contradiction</Text>
                            <Text size="sm" className={classes.mono}>
                              {formatNumber(selectedActor.scoreBreakdown.contradiction, 2)}
                            </Text>
                          </Group>
                        </Stack>
                      </Paper>
                    </SimpleGrid>

                    <Group mt="lg" gap="xs">
                      {memberPreview(selectedActor.memberFingerprintKeys).map(key => (
                        <Badge key={key} variant="outline" color="gray">
                          {key}
                        </Badge>
                      ))}
                      {selectedActor.memberFingerprintKeys.length > 8 ? (
                        <Badge variant="outline" color="gray">
                          +{formatNumber(selectedActor.memberFingerprintKeys.length - 8)} more
                        </Badge>
                      ) : null}
                    </Group>
                  </Paper>

                  <Chart
                    title="Selected Actor Event Tape"
                    series={timelineSeries}
                    options={{
                      chart: {
                        height: 380,
                      },
                      xAxis: {
                        type: 'linear',
                        title: {
                          text: 'Flagged event order',
                        },
                        labels: {
                          formatter(this: Highcharts.AxisLabelsFormatterContextObject): string {
                            return `#${formatNumber(Number(this.value), 0)}`;
                          },
                        },
                      },
                      yAxis: {
                        title: {
                          text: 'Trade price',
                        },
                      },
                      tooltip: {
                        shared: false,
                        formatter(this: Highcharts.TooltipFormatterContextObject): string {
                          const point = this.point as Highcharts.Point & { options: { custom?: TimelinePointMeta } };
                          const meta = point.options.custom;

                          if (!meta) {
                            return '';
                          }

                          return [
                            `<div style="font-size:12px"><strong>${selectedActor.actorId}</strong></div>`,
                            `<div>${formatDay(meta.day)} · ${formatNumber(meta.timestamp)}</div>`,
                            `<div>Price: ${formatNumber(point.y ?? 0, 1)}</div>`,
                            `<div>Quantity: ${formatNumber(meta.quantity)}</div>`,
                            `<div>Origin: ${meta.origin}</div>`,
                            `<div>${meta.fingerprintKey}</div>`,
                          ].join('');
                        },
                      },
                    }}
                  />

                  <Paper radius="xl" p="lg" className={classes.panel}>
                    <Group justify="space-between" mb="sm">
                      <div>
                        <Text className={classes.sectionLabel}>Recent Supporting Events</Text>
                        <Text size="sm" className={classes.subtle}>
                          These are the latest flagged trades feeding this archetype.
                        </Text>
                      </div>
                      <Badge color="marketBlue" variant="light" leftSection={<IconTimeline size={12} />}>
                        {formatNumber(selectedActor.recentEvents.length)} latest events
                      </Badge>
                    </Group>

                    <ScrollArea className={classes.eventTable}>
                      <div className={classes.eventHeader}>
                        <div>Day</div>
                        <div>Timestamp</div>
                        <div>Side</div>
                        <div>Qty</div>
                        <div>Price</div>
                        <div>Fingerprint</div>
                      </div>

                      {selectedActor.recentEvents.map(event => (
                        <div key={`${event.day}-${event.timestamp}-${event.fingerprintKey}-${event.price}`} className={classes.eventRow}>
                          <Text size="sm">{formatDay(event.day)}</Text>
                          <Text size="sm" className={classes.mono}>
                            {formatNumber(event.timestamp)}
                          </Text>
                          <Badge color={event.direction === 'buy' ? 'teal' : 'marketRed'} variant="light">
                            {event.direction === 'buy' ? 'Buy' : 'Sell'}
                          </Badge>
                          <Text size="sm" className={classes.mono}>
                            {formatNumber(event.quantity)}
                          </Text>
                          <Text size="sm" className={classes.mono}>
                            {formatNumber(event.price, 1)}
                          </Text>
                          <Group gap="xs" wrap="wrap">
                            <Badge color={ORIGIN_BADGE_COLORS[event.origin] ?? 'gray'} variant="light">
                              {event.origin}
                            </Badge>
                            <Text size="sm" className={classes.subtle}>
                              {event.fingerprintKey}
                            </Text>
                          </Group>
                        </div>
                      ))}
                    </ScrollArea>
                  </Paper>
                </Stack>
              ) : (
                <Paper radius="xl" p="lg" className={classes.panel}>
                  <div className={classes.placeholder}>No archetypes match the current filter set.</div>
                </Paper>
              )}
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>
    </Box>
  );
}
