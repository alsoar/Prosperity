import { parseTutorialDataset } from './parser.ts';
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
