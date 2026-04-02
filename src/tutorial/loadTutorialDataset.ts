import { parseTutorialDataset, SessionFileSet } from './parser.ts';
import { TutorialDataset } from './types.ts';
import { hasColumns, parseImcCsv } from '../utils/imcCsv.ts';

interface BundledDatasetManifest {
  title?: string;
  source?: string;
  basePath?: string;
  sessions: Array<{
    id: string;
    label: string;
    priceFile: string;
    tradeFile?: string;
  }>;
}

type CsvKind = 'prices' | 'trades';

interface UploadedCsvFile {
  file: File;
  text: string;
  kind: CsvKind;
  key: string;
}

const DEFAULT_BUNDLED_MANIFEST_PATH = 'sample-data/manifest.json';

async function fetchText(path: string): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`);

  if (!response.ok) {
    throw new Error(`Could not load ${path}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function loadBundledManifest(): Promise<BundledDatasetManifest> {
  const response = await fetch(`${import.meta.env.BASE_URL}${DEFAULT_BUNDLED_MANIFEST_PATH}`);

  if (!response.ok) {
    throw new Error(`Could not load bundled dataset manifest: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function emptyTradesCsv(): string {
  return 'timestamp;buyer;seller;symbol;currency;price;quantity\n';
}

function normalizeFileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/i, '');
}

function humanizeSessionKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function detectCsvKind(text: string): CsvKind | null {
  const parsed = parseImcCsv(text);

  if (
    hasColumns(parsed, [
      ['timestamp'],
      ['product', 'symbol'],
      ['mid_price', 'midprice'],
    ])
  ) {
    return 'prices';
  }

  if (
    hasColumns(parsed, [
      ['timestamp'],
      ['symbol', 'product'],
      ['price'],
      ['quantity', 'volume'],
    ])
  ) {
    return 'trades';
  }

  return null;
}

function buildSessionKey(fileName: string, kind: CsvKind): string {
  const stem = normalizeFileStem(fileName);
  const normalized = stem
    .replace(/\b(price|prices|trade|trades)\b/gi, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length > 0) {
    return normalized;
  }

  return kind === 'prices' ? `prices ${stem}` : `trades ${stem}`;
}

function buildUploadedLabel(key: string, priceFileName: string): string {
  const humanKey = humanizeSessionKey(key);
  const fallback = humanizeSessionKey(normalizeFileStem(priceFileName));

  return `Imported · ${humanKey.length > 0 ? humanKey : fallback}`;
}

function sortSessions(a: { day: number; label: string }, b: { day: number; label: string }): number {
  if (a.day !== b.day) {
    return a.day - b.day;
  }

  return a.label.localeCompare(b.label);
}

export async function loadTutorialDataset(): Promise<TutorialDataset> {
  const manifest = await loadBundledManifest();
  const basePath = manifest.basePath ? `${manifest.basePath.replace(/^\/+|\/+$/g, '')}/` : '';
  const loadedFiles = await Promise.all(
    manifest.sessions.map(async fileSet => ({
      ...fileSet,
      tradeFile: fileSet.tradeFile ?? 'trades_missing.csv',
      pricesText: await fetchText(`${basePath}${fileSet.priceFile}`),
      tradesText: fileSet.tradeFile ? await fetchText(`${basePath}${fileSet.tradeFile}`) : emptyTradesCsv(),
    })),
  );

  return parseTutorialDataset(loadedFiles, {
    title: manifest.title ?? 'Sample Market Data',
    source: manifest.source ?? 'Bundled sample IMC-style CSV sessions',
  });
}

export function mergeTutorialDatasets(baseDataset: TutorialDataset, additionalDataset: TutorialDataset): TutorialDataset {
  const sessionMap = new Map(baseDataset.sessions.map(session => [session.id, session]));

  additionalDataset.sessions.forEach(session => {
    sessionMap.set(session.id, session);
  });

  return {
    title: baseDataset.title,
    source: `${baseDataset.source}; plus imported CSV sessions`,
    sessions: [...sessionMap.values()].sort(sortSessions),
  };
}

export async function loadTutorialDatasetFromFiles(files: File[]): Promise<TutorialDataset> {
  const csvFiles = files.filter(file => file.name.toLowerCase().endsWith('.csv'));
  const parsedFiles = await Promise.all(
    csvFiles.map(async file => {
      const text = await file.text();
      const kind = detectCsvKind(text);

      return kind
        ? ({
            file,
            text,
            kind,
            key: buildSessionKey(file.name, kind),
          } satisfies UploadedCsvFile)
        : null;
    }),
  );

  const recognizedFiles = parsedFiles.filter((file): file is UploadedCsvFile => file !== null);
  const priceFiles = recognizedFiles.filter(file => file.kind === 'prices');
  const tradeFiles = recognizedFiles.filter(file => file.kind === 'trades');

  if (priceFiles.length === 0) {
    throw new Error(
      'No price CSVs were found. Expected IMC-style market data with columns like timestamp, product, and mid_price.',
    );
  }

  const tradeFileByKey = new Map(tradeFiles.map(file => [file.key, file]));
  const remainingTrades = new Set(tradeFiles.map(file => file.key));

  const fileSets: SessionFileSet[] = priceFiles.map((priceFile, index) => {
    let pairedTrade = tradeFileByKey.get(priceFile.key);

    if (!pairedTrade && priceFiles.length === 1 && tradeFiles.length === 1) {
      pairedTrade = tradeFiles[0];
    }

    if (pairedTrade) {
      remainingTrades.delete(pairedTrade.key);
    }

    const sessionKey = priceFile.key || normalizeFileStem(priceFile.file.name) || `session-${index + 1}`;

    return {
      id: `imported-${slugify(sessionKey)}`,
      label: buildUploadedLabel(sessionKey, priceFile.file.name),
      priceFile: priceFile.file.name,
      tradeFile: pairedTrade?.file.name ?? 'trades_missing.csv',
      pricesText: priceFile.text,
      tradesText: pairedTrade?.text ?? emptyTradesCsv(),
    };
  });

  return parseTutorialDataset(fileSets, {
    title: 'Imported Market Data',
    source:
      remainingTrades.size > 0
        ? 'Loaded from imported CSV files; some trade files could not be paired and were skipped'
        : 'Loaded from imported CSV files',
  });
}
