export interface BookLevel {
  price: number;
  volume: number;
}

export interface TutorialSnapshot {
  day: number;
  timestamp: number;
  product: string;
  bids: BookLevel[];
  asks: BookLevel[];
  midPrice: number;
  profitLoss: number;
  bestBid: number | null;
  bestAsk: number | null;
  wallBid: number | null;
  wallAsk: number | null;
  baseBid: number | null;
  baseAsk: number | null;
  spread: number | null;
  bookImbalance: number;
  openMid: number;
  rollingMid: number;
  wallMid: number;
  baseMid: number;
}

export type TradeClassification = 'aggressive-buy' | 'aggressive-sell' | 'passive';

export interface TutorialTrade {
  timestamp: number;
  buyer: string | null;
  seller: string | null;
  symbol: string;
  currency: string;
  price: number;
  quantity: number;
  classification: TradeClassification;
  signedQuantity: number;
  referenceTimestamp: number;
  referenceBestBid: number | null;
  referenceBestAsk: number | null;
  referenceMid: number;
  referenceWallMid: number;
  referenceBaseMid: number;
  referenceOpenMid: number;
  referenceRollingMid: number;
}

export interface TutorialProductData {
  product: string;
  snapshots: TutorialSnapshot[];
  trades: TutorialTrade[];
  lastTimestamp: number;
  maxTradeQuantity: number;
}

export interface TutorialSession {
  id: string;
  label: string;
  priceFile: string;
  tradeFile: string;
  day: number;
  products: Record<string, TutorialProductData>;
  productNames: string[];
  lastTimestamp: number;
}

export interface TutorialDataset {
  title: string;
  source: string;
  sessions: TutorialSession[];
}

export type IndicatorKey = 'none' | 'mid' | 'wallmid' | 'basemid' | 'open' | 'rolling';
