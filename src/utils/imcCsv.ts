export interface ParsedImcCsv {
  header: string[];
  normalizedHeader: string[];
  rows: string[][];
}

function normalizeHeaderValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseImcCsv(text: string): ParsedImcCsv {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length === 0) {
    return {
      header: [],
      normalizedHeader: [],
      rows: [],
    };
  }

  const header = lines[0].split(';');

  return {
    header,
    normalizedHeader: header.map(normalizeHeaderValue),
    rows: lines.slice(1).map(line => line.split(';')),
  };
}

function findColumnIndex(parsed: ParsedImcCsv, candidates: string[]): number {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeHeaderValue(candidate);
    const index = parsed.normalizedHeader.indexOf(normalizedCandidate);
    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

export function hasColumns(parsed: ParsedImcCsv, candidates: string[][]): boolean {
  return candidates.every(group => findColumnIndex(parsed, group) !== -1);
}

export function getCsvString(row: string[], parsed: ParsedImcCsv, candidates: string[], fallbackIndex?: number): string {
  const index = findColumnIndex(parsed, candidates);

  if (index !== -1) {
    return row[index] ?? '';
  }

  if (fallbackIndex !== undefined) {
    return row[fallbackIndex] ?? '';
  }

  return '';
}

export function getCsvOptionalNumber(
  row: string[],
  parsed: ParsedImcCsv,
  candidates: string[],
  fallbackIndex?: number,
): number | null {
  const rawValue = getCsvString(row, parsed, candidates, fallbackIndex);
  if (rawValue === '') {
    return null;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

export function getCsvNumber(row: string[], parsed: ParsedImcCsv, candidates: string[], fallbackIndex?: number): number {
  return getCsvOptionalNumber(row, parsed, candidates, fallbackIndex) ?? 0;
}

function parseCellNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const numericValue = Number(trimmed);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function extractBookSide(
  row: string[],
  parsed: ParsedImcCsv,
  side: 'bid' | 'ask',
  fallbackPriceIndices: number[],
  fallbackVolumeIndices: number[],
): { prices: number[]; volumes: number[] } {
  const levels = new Map<number, { price?: number; volume?: number }>();

  parsed.normalizedHeader.forEach((header, index) => {
    const match = header.match(new RegExp(`^${side}_(price|volume)_(\\d+)$`));
    if (!match) {
      return;
    }

    const [, field, levelRaw] = match;
    const level = Number(levelRaw);
    const value = parseCellNumber(row[index]);

    if (value === null) {
      return;
    }

    const entry = levels.get(level) ?? {};
    if (field === 'price') {
      entry.price = value;
    } else {
      entry.volume = value;
    }
    levels.set(level, entry);
  });

  if (levels.size === 0) {
    fallbackPriceIndices.forEach((priceIndex, idx) => {
      const volumeIndex = fallbackVolumeIndices[idx];
      const price = parseCellNumber(row[priceIndex]);
      const volume = parseCellNumber(row[volumeIndex]);

      if (price !== null && volume !== null) {
        levels.set(idx + 1, { price, volume });
      }
    });
  }

  return [...levels.entries()]
    .sort((a, b) => a[0] - b[0])
    .reduce(
      (accumulator, [, level]) => {
        if (level.price !== undefined && level.volume !== undefined) {
          accumulator.prices.push(level.price);
          accumulator.volumes.push(level.volume);
        }

        return accumulator;
      },
      { prices: [] as number[], volumes: [] as number[] },
    );
}
