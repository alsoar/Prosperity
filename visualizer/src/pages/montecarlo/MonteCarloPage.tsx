import { Badge, Container, Grid, Group, Select, Table, Text, Title } from '@mantine/core';
import axios from 'axios';
import Highcharts from 'highcharts';
import { ReactNode, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MonteCarloDashboard } from '../../models.ts';
import { useStore } from '../../store.ts';
import { parseVisualizerInput } from '../../utils/algorithm.tsx';
import { formatNumber } from '../../utils/format.ts';
import { VisualizerCard } from '../visualizer/VisualizerCard.tsx';
import {
  buildBandChartSeries,
  distributionLineSeries,
  ErrorMonteCarloView,
  formatSlope,
  histogramSeries,
  lineSeries,
  LoadingMonteCarloView,
  normalFitSeries,
  SessionRankingTable,
  SimpleChart,
  SummaryTable,
} from './MonteCarloComponents.tsx';

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

function withVersion(url: string, version: string | null): string {
  if (version === null || version.length === 0) {
    return url;
  }

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(version)}`;
}

function monteCarloProductLabel(dashboard: MonteCarloDashboard, product: string): string {
  return dashboard.meta.productLabels?.[product] ?? product;
}

function monteCarloProductColor(product: string): string {
  return product === 'EMERALDS' ? '#12b886' : '#fd7e14';
}

type LocalDashboardStatus = {
  dashboardExists: boolean;
  dashboardMtimeMs: number | null;
  dashboardSizeBytes: number | null;
  root: string;
  currentRunId?: string | null;
  runs?: Array<{
    id: string;
    label: string;
    mtimeMs: number;
    dashboardUrl: string;
  }>;
};

export function MonteCarloPage(): ReactNode {
  const storedDashboard = useStore(state => state.monteCarlo);
  const { search } = useLocation();
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [status, setStatus] = useState('Loading Monte Carlo dashboard');
  const [localDashboard, setLocalDashboard] = useState<MonteCarloDashboard | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [dashboardVersion, setDashboardVersion] = useState<string | null>(null);
  const [availableRuns, setAvailableRuns] = useState<
    Array<{
      id: string;
      label: string;
      mtimeMs: number;
      dashboardUrl: string;
    }>
  >([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('latest');
  const [bandProduct, setBandProduct] = useState('TOMATOES');
  const searchParams = new URLSearchParams(search);
  const explicitOpenUrl = searchParams.get('open');
  const localMode = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const latestRun = availableRuns[0] ?? null;
  const selectedRun =
    selectedRunId === 'latest'
      ? latestRun
      : availableRuns.find(run => run.id === selectedRunId) ?? latestRun;
  const localFallbackOpenUrl = localMode ? selectedRun?.dashboardUrl ?? '/dashboard.json' : null;
  const localStatusUrl = localMode ? '/__prosperity4mcbt__/status.json' : null;
  const openUrl = explicitOpenUrl ?? localFallbackOpenUrl;
  const effectiveOpenUrl = openUrl === null ? null : withVersion(openUrl, explicitOpenUrl === null ? dashboardVersion : null);
  const dashboard = effectiveOpenUrl === null ? storedDashboard : loadedUrl === effectiveOpenUrl ? localDashboard : null;

  useEffect(() => {
    if (localStatusUrl === null || explicitOpenUrl !== null) {
      return;
    }

    let cancelled = false;
    let previousVersion: string | null = null;

    const poll = async (): Promise<void> => {
      try {
        const response = await axios.get<LocalDashboardStatus>(localStatusUrl, {
          headers: {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
        });

        if (cancelled) {
          return;
        }

        const runs = response.data.runs ?? [];
        setAvailableRuns(runs);

        if (runs.length === 0) {
          setSelectedRunId('latest');
        } else {
          setSelectedRunId(previous => {
            if (previous === 'latest') {
              return 'latest';
            }
            return runs.some(run => run.id === previous) ? previous : 'latest';
          });
        }

        if (!response.data.dashboardExists || response.data.dashboardMtimeMs === null) {
          setLocalDashboard(null);
          setLoadedUrl(null);
          setDashboardVersion(null);
          return;
        }

        const currentRun =
          response.data.currentRunId === undefined || response.data.currentRunId === null
            ? runs[0]
            : runs.find(run => run.id === response.data.currentRunId) ?? runs[0];
        const selectedForVersion = selectedRunId === 'latest' ? currentRun : runs.find(run => run.id === selectedRunId) ?? currentRun;
        const nextVersion = selectedForVersion === undefined ? String(response.data.dashboardMtimeMs) : String(selectedForVersion.mtimeMs);
        if (previousVersion !== nextVersion) {
          previousVersion = nextVersion;
          setDashboardVersion(nextVersion);
        }
      } catch {
        if (!cancelled) {
          setStatus('Waiting for local dashboard');
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [explicitOpenUrl, localStatusUrl, selectedRunId]);

  useEffect(() => {
    if (effectiveOpenUrl === null) {
      setLoadError(null);
      setStatus('Loading Monte Carlo dashboard');
      setLocalDashboard(null);
      setLoadedUrl(null);
      return;
    }

    if (effectiveOpenUrl.trim().length === 0) {
      return;
    }

    let cancelled = false;
    setLoadError(null);
    setStatus('Fetching dashboard');
    setLocalDashboard(null);
    setLoadedUrl(null);
    const load = async (): Promise<void> => {
      try {
        const response = await axios.get(effectiveOpenUrl, {
          headers: {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
        });
        const parsed = parseVisualizerInput(response.data);

        if (cancelled) {
          return;
        }

        if (parsed.kind === 'monteCarlo') {
          setLocalDashboard(parsed.monteCarlo);
          setLoadedUrl(effectiveOpenUrl);
          setStatus('Dashboard loaded');
          return;
        }

        setLoadError(new Error('This visualizer build only supports Monte Carlo dashboard bundles.'));
      } catch (error) {
        if (cancelled) {
          return;
        }
        setLoadError(error as Error);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [effectiveOpenUrl]);

  useEffect(() => {
    if (dashboard?.bandSeries?.[bandProduct] !== undefined) {
      return;
    }
    if (dashboard?.bandSeries !== undefined) {
      const fallback = Object.keys(dashboard.bandSeries)[0];
      if (fallback !== undefined) {
        setBandProduct(fallback);
      }
    }
  }, [bandProduct, dashboard]);

  if (dashboard === null) {
    if (loadError !== null) {
      return <ErrorMonteCarloView error={loadError} />;
    }

    if (openUrl !== null) {
      return <LoadingMonteCarloView status={status} />;
    }
    return <LoadingMonteCarloView status={status} />;
  }

  const strategyName = basename(dashboard.meta.algorithmPath);
  const emeraldLabel = monteCarloProductLabel(dashboard, 'EMERALDS');
  const tomatoLabel = monteCarloProductLabel(dashboard, 'TOMATOES');
  const selectedBandLabel = monteCarloProductLabel(dashboard, bandProduct);
  const tailRisk = dashboard.tailRisk;
  const robust = dashboard.robust;
  const totalTrend = dashboard.trendFits.TOTAL;
  const emeraldTrend = dashboard.trendFits.EMERALDS;
  const tomatoTrend = dashboard.trendFits.TOMATOES;
  const scatterFit = dashboard.scatterFit;
  const selectedBandSeries = dashboard.bandSeries?.[bandProduct];
  const bandOptions = Object.keys(dashboard.bandSeries ?? {}).map(product => ({
    value: product,
    label: monteCarloProductLabel(dashboard, product),
  }));

  const totalHistogramSeries: Highcharts.SeriesOptionsType[] = [
    histogramSeries(dashboard.histograms.totalPnl, 'Total PnL', '#4c6ef5'),
    normalFitSeries(dashboard.normalFits.totalPnl),
  ];
  const emeraldHistogramSeries: Highcharts.SeriesOptionsType[] = [
    histogramSeries(dashboard.histograms.emeraldPnl, `${emeraldLabel} PnL`, '#12b886'),
    normalFitSeries(dashboard.normalFits.emeraldPnl),
  ];
  const tomatoHistogramSeries: Highcharts.SeriesOptionsType[] = [
    histogramSeries(dashboard.histograms.tomatoPnl, `${tomatoLabel} PnL`, '#fd7e14'),
    normalFitSeries(dashboard.normalFits.tomatoPnl),
  ];
  const scatterSeries: Highcharts.SeriesOptionsType[] = [
    {
      type: 'scatter',
      name: 'Sessions',
      color: '#4c6ef5',
      data: dashboard.sessions.map(row => [row.emeraldPnl, row.tomatoPnl]),
    },
    {
      type: 'line',
      name: 'Linear fit',
      color: '#fa5252',
      lineWidth: 2,
      data: scatterFit.line,
    },
  ];
  const profitabilitySeries: Highcharts.SeriesOptionsType[] = [
    distributionLineSeries(dashboard.histograms.totalProfitability, 'Total', '#4c6ef5'),
    distributionLineSeries(dashboard.histograms.emeraldProfitability, emeraldLabel, '#12b886'),
    distributionLineSeries(dashboard.histograms.tomatoProfitability, tomatoLabel, '#fd7e14'),
  ];
  const stabilitySeries: Highcharts.SeriesOptionsType[] = [
    distributionLineSeries(dashboard.histograms.totalStability, 'Total', '#4c6ef5'),
    distributionLineSeries(dashboard.histograms.emeraldStability, emeraldLabel, '#12b886'),
    distributionLineSeries(dashboard.histograms.tomatoStability, tomatoLabel, '#fd7e14'),
  ];
  const robustP05Series: Highcharts.SeriesOptionsType[] =
    robust === undefined
      ? []
      : [histogramSeries(robust.p05Histograms.totalPnl, 'Accepted scenario total P05', '#fa5252')];

  return (
    <Container fluid py="md">
      <Grid>
        <Grid.Col span={12}>
          <VisualizerCard>
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={2}>Monte Carlo Results</Title>
                <Text c="dimmed">{strategyName}</Text>
              </div>
              <Group gap="xs" align="flex-start">
                {explicitOpenUrl === null && localMode && availableRuns.length > 0 && (
                  <Select
                    w={260}
                    label="Run"
                    value={selectedRunId}
                    onChange={value => setSelectedRunId(value ?? 'latest')}
                    allowDeselect={false}
                    data={[
                      {
                        value: 'latest',
                        label: `Latest (${latestRun?.label ?? 'none'})`,
                      },
                      ...availableRuns.map(run => ({
                        value: run.id,
                        label: run.label,
                      })),
                    ]}
                  />
                )}
                <Badge variant="light">{dashboard.meta.sessionCount} sessions</Badge>
                <Badge variant="light">{dashboard.meta.bandSessionCount ?? dashboard.meta.sampleSessions} path traces</Badge>
                <Badge variant="light">{dashboard.meta.fvMode}</Badge>
                <Badge variant="light">{dashboard.meta.tradeMode}</Badge>
              </Group>
            </Group>
          </VisualizerCard>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 6 }}>
          <VisualizerCard title="Mean Total PnL">
            <Title order={2}>{formatNumber(dashboard.overall.totalPnl.mean)}</Title>
            <Text c="dimmed" size="sm">
              95% mean CI {formatNumber(dashboard.overall.totalPnl.meanConfidenceLow95)} to{' '}
              {formatNumber(dashboard.overall.totalPnl.meanConfidenceHigh95)}
            </Text>
          </VisualizerCard>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <VisualizerCard title="Total PnL 1σ">
            <Title order={2}>{formatNumber(dashboard.overall.totalPnl.std)}</Title>
            <Text c="dimmed" size="sm">
              P05 {formatNumber(dashboard.overall.totalPnl.p05)} · P95 {formatNumber(dashboard.overall.totalPnl.p95)}
            </Text>
          </VisualizerCard>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 8 }}>
          <VisualizerCard title="Profitability And Statistics">
            <Table striped withTableBorder withColumnBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Metric</Table.Th>
                  <Table.Th>Meaning</Table.Th>
                  <Table.Th>Total</Table.Th>
                  <Table.Th>{emeraldLabel}</Table.Th>
                  <Table.Th>{tomatoLabel}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>Profitability</Table.Td>
                  <Table.Td>Mean fitted MTM slope in dollars per step.</Table.Td>
                  <Table.Td>{formatSlope(totalTrend.profitability.mean)}</Table.Td>
                  <Table.Td>{formatSlope(emeraldTrend.profitability.mean)}</Table.Td>
                  <Table.Td>{formatSlope(tomatoTrend.profitability.mean)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>Stability</Table.Td>
                  <Table.Td>Mean linear-fit R². Higher means steadier PnL paths.</Table.Td>
                  <Table.Td>{formatNumber(totalTrend.stability.mean, 3)}</Table.Td>
                  <Table.Td>{formatNumber(emeraldTrend.stability.mean, 3)}</Table.Td>
                  <Table.Td>{formatNumber(tomatoTrend.stability.mean, 3)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>Profitability 1σ</Table.Td>
                  <Table.Td>Cross-session spread of profitability.</Table.Td>
                  <Table.Td>{formatSlope(totalTrend.profitability.std)}</Table.Td>
                  <Table.Td>{formatSlope(emeraldTrend.profitability.std)}</Table.Td>
                  <Table.Td>{formatSlope(tomatoTrend.profitability.std)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>Stability 1σ</Table.Td>
                  <Table.Td>Cross-session spread of stability.</Table.Td>
                  <Table.Td>{formatNumber(totalTrend.stability.std, 3)}</Table.Td>
                  <Table.Td>{formatNumber(emeraldTrend.stability.std, 3)}</Table.Td>
                  <Table.Td>{formatNumber(tomatoTrend.stability.std, 3)}</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </VisualizerCard>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 4 }}>
          <VisualizerCard title="Fair Value Models">
            <Table withTableBorder withColumnBorders>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>{emeraldLabel}</Table.Td>
                  <Table.Td>
                    <Text fw={500}>{dashboard.generatorModel.EMERALDS.formula}</Text>
                    <Text size="sm" c="dimmed">
                      {dashboard.generatorModel.EMERALDS.notes[0]}
                    </Text>
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>{tomatoLabel}</Table.Td>
                  <Table.Td>
                    <Text fw={500}>{dashboard.generatorModel.TOMATOES.formula}</Text>
                    <Text size="sm" c="dimmed">
                      {dashboard.generatorModel.TOMATOES.notes[0]}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </VisualizerCard>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <SummaryTable title="Total PnL Summary" stats={dashboard.overall.totalPnl} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <SummaryTable title={`${emeraldLabel} PnL Summary`} stats={dashboard.products.EMERALDS.pnl} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <SummaryTable title={`${tomatoLabel} PnL Summary`} stats={dashboard.products.TOMATOES.pnl} />
        </Grid.Col>

        {tailRisk !== undefined && (
          <Grid.Col span={12}>
            <VisualizerCard title="Tail Risk">
              <Table striped withTableBorder withColumnBorders>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Product</Table.Th>
                    <Table.Th>P05</Table.Th>
                    <Table.Th>CVaR95</Table.Th>
                    <Table.Th>P01</Table.Th>
                    <Table.Th>CVaR99</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>Total</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.totalPnl.p05, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.totalPnl.cvar95, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.totalPnl.p01, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.totalPnl.cvar99, 2)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>{emeraldLabel}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.emeraldPnl.p05, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.emeraldPnl.cvar95, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.emeraldPnl.p01, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.emeraldPnl.cvar99, 2)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>{tomatoLabel}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.tomatoPnl.p05, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.tomatoPnl.cvar95, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.tomatoPnl.p01, 2)}</Table.Td>
                    <Table.Td>{formatNumber(tailRisk.tomatoPnl.cvar99, 2)}</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </VisualizerCard>
          </Grid.Col>
        )}

        <Grid.Col span={{ base: 12, md: 6 }}>
          <SimpleChart
            title="Total PnL Distribution"
            subtitle={`Normal fit μ ${formatNumber(dashboard.normalFits.totalPnl.mean)} · σ ${formatNumber(dashboard.normalFits.totalPnl.std)} · R² ${formatNumber(dashboard.normalFits.totalPnl.r2, 3)}`}
            series={totalHistogramSeries}
            options={{
              xAxis: { title: { text: 'Final total pnl' } },
              yAxis: { title: { text: 'Session count' } },
            }}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <SimpleChart
            title="Cross Product Scatter"
            subtitle={`corr ${formatNumber(scatterFit.correlation, 3)} · fit R² ${formatNumber(scatterFit.r2, 3)} · ${scatterFit.diagnosis}`}
            series={scatterSeries}
            options={{
              xAxis: { title: { text: `${emeraldLabel} pnl` } },
              yAxis: { title: { text: `${tomatoLabel} pnl` } },
            }}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <SimpleChart
            title={`${emeraldLabel} PnL Distribution`}
            subtitle={`Normal fit μ ${formatNumber(dashboard.normalFits.emeraldPnl.mean)} · σ ${formatNumber(dashboard.normalFits.emeraldPnl.std)} · R² ${formatNumber(dashboard.normalFits.emeraldPnl.r2, 3)}`}
            series={emeraldHistogramSeries}
            options={{
              xAxis: { title: { text: `${emeraldLabel} final pnl` } },
              yAxis: { title: { text: 'Session count' } },
            }}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <SimpleChart
            title={`${tomatoLabel} PnL Distribution`}
            subtitle={`Normal fit μ ${formatNumber(dashboard.normalFits.tomatoPnl.mean)} · σ ${formatNumber(dashboard.normalFits.tomatoPnl.std)} · R² ${formatNumber(dashboard.normalFits.tomatoPnl.r2, 3)}`}
            series={tomatoHistogramSeries}
            options={{
              xAxis: { title: { text: `${tomatoLabel} final pnl` } },
              yAxis: { title: { text: 'Session count' } },
            }}
          />
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 6 }}>
          <SimpleChart
            title="Profitability Distribution"
            subtitle="Per-session fitted MTM slope in dollars per step"
            series={profitabilitySeries}
            options={{
              xAxis: {
                title: { text: '$ / step' },
                labels: {
                  formatter(this: Highcharts.AxisLabelsFormatterContextObject) {
                    return formatNumber(Number(this.value), 4);
                  },
                },
              },
              yAxis: { title: { text: 'Density proxy' } },
            }}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <SimpleChart
            title="Stability Distribution"
            subtitle="Per-session linear-fit R²"
            series={stabilitySeries}
            options={{
              xAxis: {
                title: { text: 'R²' },
                labels: {
                  formatter(this: Highcharts.AxisLabelsFormatterContextObject) {
                    return formatNumber(Number(this.value), 3);
                  },
                },
              },
              yAxis: { title: { text: 'Density proxy' } },
            }}
          />
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 6 }}>
          <SessionRankingTable title="Best Sessions" rows={dashboard.topSessions} productLabels={dashboard.meta.productLabels} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <SessionRankingTable title="Worst Sessions" rows={dashboard.bottomSessions} productLabels={dashboard.meta.productLabels} />
        </Grid.Col>

        {robust !== undefined && robust.enabled && (
          <>
            <Grid.Col span={{ base: 12, lg: 6 }}>
              <VisualizerCard title="Robust Summary">
                <Table striped withTableBorder withColumnBorders>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td>Confidence region</Table.Td>
                      <Table.Td>{formatNumber(100 * robust.grid.confidenceLevel, 1)}%</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Accepted scenarios</Table.Td>
                      <Table.Td>
                        {robust.grid.acceptedCount} / {robust.grid.totalCount}
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Weighted total mean</Table.Td>
                      <Table.Td>{formatNumber(robust.weightedMixture.totalPnl.mean, 2)}</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Weighted total P05</Table.Td>
                      <Table.Td>{formatNumber(robust.weightedMixture.totalPnl.p05, 2)}</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Weighted total CVaR95</Table.Td>
                      <Table.Td>{formatNumber(robust.weightedMixture.totalPnl.cvar95, 2)}</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Worst-case total P05</Table.Td>
                      <Table.Td>
                        {formatNumber(robust.worstCase.totalP05.totalPnl.p05, 2)} at
                        {' '}
                        φ={formatNumber(robust.worstCase.totalP05.phi, 6)}, σ={formatNumber(robust.worstCase.totalP05.sigma, 3)}
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Best-fit point</Table.Td>
                      <Table.Td>
                        φ={formatNumber(robust.bestFit.phi, 6)}, σ={formatNumber(robust.bestFit.sigma, 3)}
                      </Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
              </VisualizerCard>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 6 }}>
              <SimpleChart
                title="Scenario Total P05 Distribution"
                subtitle={`Accepted confidence-region scenarios · mean ${formatNumber(robust.p05Distributions.totalPnl.mean, 2)} · std ${formatNumber(robust.p05Distributions.totalPnl.std, 2)}`}
                series={robustP05Series}
                options={{
                  xAxis: { title: { text: 'Scenario total P05' } },
                  yAxis: { title: { text: 'Scenario count' } },
                }}
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <VisualizerCard title="Accepted Robust Scenarios">
                <Table striped withTableBorder withColumnBorders stickyHeader stickyHeaderOffset={0}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Phi</Table.Th>
                      <Table.Th>Sigma</Table.Th>
                      <Table.Th>Confidence Stat</Table.Th>
                      <Table.Th>Weight</Table.Th>
                      <Table.Th>Total Mean</Table.Th>
                      <Table.Th>Total P05</Table.Th>
                      <Table.Th>Total CVaR95</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {robust.acceptedScenarios.map(row => (
                      <Table.Tr key={row.id}>
                        <Table.Td>{formatNumber(row.phi, 6)}</Table.Td>
                        <Table.Td>{formatNumber(row.sigma, 3)}</Table.Td>
                        <Table.Td>{formatNumber(row.confidenceStatistic, 3)}</Table.Td>
                        <Table.Td>{formatNumber(100 * row.normalizedWeight, 1)}%</Table.Td>
                        <Table.Td>{formatNumber(row.totalPnl.mean, 2)}</Table.Td>
                        <Table.Td>{formatNumber(row.totalPnl.p05, 2)}</Table.Td>
                        <Table.Td>{formatNumber(row.totalPnl.cvar95, 2)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </VisualizerCard>
            </Grid.Col>
          </>
        )}

        {selectedBandSeries && (
          <>
            <Grid.Col span={12}>
              <VisualizerCard title="Path Boards">
                <Group justify="space-between" align="center">
                  <Text c="dimmed" size="sm">
                    Mean path with ±1σ and ±3σ bands across {dashboard.meta.bandSessionCount ?? dashboard.meta.sampleSessions} sessions.
                  </Text>
                  <Select
                    w={220}
                    data={bandOptions}
                    value={bandProduct}
                    onChange={value => setBandProduct(value ?? 'EMERALDS')}
                    allowDeselect={false}
                  />
                </Group>
              </VisualizerCard>
            </Grid.Col>
            <Grid.Col span={12}>
              <SimpleChart
                title={`${selectedBandLabel} Fair Value`}
                series={buildBandChartSeries(selectedBandSeries.fair, monteCarloProductColor(bandProduct))}
                options={{
                  xAxis: {
                    title: { text: 'Step' },
                  },
                  yAxis: { title: { text: 'Fair value' } },
                }}
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <SimpleChart
                title={`${selectedBandLabel} MTM PnL`}
                series={[
                  ...buildBandChartSeries(selectedBandSeries.mtmPnl, monteCarloProductColor(bandProduct)),
                  lineSeries('Zero', '#868e96', selectedBandSeries.mtmPnl.timestamps, selectedBandSeries.mtmPnl.timestamps.map(() => 0), 'ShortDash'),
                ]}
                options={{
                  xAxis: {
                    title: { text: 'Step' },
                  },
                  yAxis: { title: { text: 'MTM pnl' } },
                }}
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <SimpleChart
                title={`${selectedBandLabel} Position`}
                series={[
                  ...buildBandChartSeries(selectedBandSeries.position, monteCarloProductColor(bandProduct)),
                  lineSeries('Zero', '#868e96', selectedBandSeries.position.timestamps, selectedBandSeries.position.timestamps.map(() => 0), 'ShortDash'),
                ]}
                options={{
                  xAxis: {
                    title: { text: 'Step' },
                  },
                  yAxis: { title: { text: 'Position' } },
                }}
              />
            </Grid.Col>
          </>
        )}
      </Grid>
    </Container>
  );
}
