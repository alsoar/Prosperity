import { parseTutorialDataset, SessionFileSet } from './parser.ts';
import { TutorialDataset } from './types.ts';

const FILE_SETS = [
  {
    id: 'round0-day--2',
    label: 'Round 0 · Day -2',
    priceFile: 'prices_round_0_day_-2.csv',
    tradeFile: 'trades_round_0_day_-2.csv',
  },
  {
    id: 'round0-day--1',
    label: 'Round 0 · Day -1',
    priceFile: 'prices_round_0_day_-1.csv',
    tradeFile: 'trades_round_0_day_-1.csv',
  },
] as const;

async function fetchText(path: string): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}tutorial-round-1/${path}`);

  if (!response.ok) {
    throw new Error(`Could not load ${path}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

export async function loadTutorialDataset(): Promise<TutorialDataset> {
  const loadedFiles = await Promise.all(
    FILE_SETS.map(async fileSet => ({
      ...fileSet,
      pricesText: await fetchText(fileSet.priceFile),
      tradesText: await fetchText(fileSet.tradeFile),
    })),
  );

  return parseTutorialDataset(loadedFiles);
}

function normalizeFileStem(fileName: string): string {
  return fileName.replace(/\.csv$/i, '');
}

function extractSessionKey(fileName: string, expectedPrefix: 'prices' | 'trades'): string {
  const stem = normalizeFileStem(fileName);
  const lowerStem = stem.toLowerCase();
  const prefix = `${expectedPrefix}_`;

  if (lowerStem.startsWith(prefix)) {
    return stem.slice(prefix.length);
  }

  return stem;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildUploadedLabel(fileName: string): string {
  const stem = normalizeFileStem(fileName)
    .replace(/^prices_/i, '')
    .replace(/_/g, ' ');

  return `Uploaded · ${stem}`;
}

function emptyTradesCsv(): string {
  return 'timestamp;buyer;seller;symbol;currency;price;quantity\n';
}

export function mergeTutorialDatasets(baseDataset: TutorialDataset, additionalDataset: TutorialDataset): TutorialDataset {
  const sessionMap = new Map(baseDataset.sessions.map(session => [session.id, session]));

  additionalDataset.sessions.forEach(session => {
    sessionMap.set(session.id, session);
  });

  return {
    title: baseDataset.title,
    source: `${baseDataset.source}; plus uploaded CSV sessions`,
    sessions: [...sessionMap.values()].sort((a, b) => a.day - b.day),
  };
}

export async function loadTutorialDatasetFromFiles(files: File[]): Promise<TutorialDataset> {
  const candidateMap = new Map<
    string,
    {
      key: string;
      priceFile?: File;
      tradeFile?: File;
    }
  >();

  files
    .filter(file => file.name.toLowerCase().endsWith('.csv'))
    .forEach(file => {
      const lowerName = file.name.toLowerCase();
      const fileType = lowerName.includes('prices_') ? 'prices' : lowerName.includes('trades_') ? 'trades' : null;

      if (fileType === null) {
        return;
      }

      const key = extractSessionKey(file.name, fileType);
      const candidate = candidateMap.get(key) ?? { key };

      if (fileType === 'prices') {
        candidate.priceFile = file;
      } else {
        candidate.tradeFile = file;
      }

      candidateMap.set(key, candidate);
    });

  const candidates = [...candidateMap.values()].filter(candidate => candidate.priceFile);

  if (candidates.length === 0) {
    throw new Error('No price CSVs were found. Expected files named like prices_round_1_day_0.csv.');
  }

  const fileSets: SessionFileSet[] = await Promise.all(
    candidates.map(async candidate => {
      const priceFile = candidate.priceFile!;
      const tradeFile = candidate.tradeFile;

      return {
        id: `uploaded-${slugify(candidate.key)}`,
        label: buildUploadedLabel(priceFile.name),
        priceFile: priceFile.name,
        tradeFile: tradeFile?.name ?? 'trades_missing.csv',
        pricesText: await priceFile.text(),
        tradesText: tradeFile ? await tradeFile.text() : emptyTradesCsv(),
      };
    }),
  );

  return parseTutorialDataset(fileSets);
}
