export type OndoMmConfig = {
  mode: 'observe' | 'live'; markets: string[]; orderUsd: string; targetBps: string; minBps: string; maxBps: string;
  wallEnabled: boolean; wallUsd: string; maxPositionUsd: string; maxTotalUsd: string; dwellMs: number; rps: number;
};
export type OndoMmSide = {
  role: 'quote' | 'close'; state: 'none' | 'planned' | 'sending' | 'open' | 'canceling' | 'unknown';
  price?: string; size?: string; bps?: number; mode?: 'fixed' | 'wall' | 'close' | null; protection?: string; reason?: string;
};
export type OndoMmMarket = {
  market: string; hold: string | null; listed: boolean; trading: boolean | null; tick: string | null; bid: string | null; ask: string | null; bookAt: number | null;
  position: string | null; synced: boolean; buy: OndoMmSide; sell: OndoMmSide; lastCancel: string | null; error: string | null;
};
export type OndoMmEvent = { at: string; market: string | null; kind: string; text: string };
export type OndoMmSnapshot = {
  schema: 1; phase: 'stopped' | 'running' | 'stopping'; live: boolean; startedAt: string | null;
  config: OndoMmConfig; revision: number; activeConfig: OndoMmConfig | null;
  credentials: { configured: boolean; hint: string | null; error: string | null };
  paused: boolean; pauseReason: string | null; halt: string | null; lastError: string | null; cooldownUntil: number | null;
  stream: { connected: boolean; publicReady: boolean; privateReady: boolean; lastFrameAt: number | null; error: string | null } | null;
  syncError: string | null; rulesError: string | null;
  totals: { placed: number; canceled: number; rejected: number; postOnly: number; fills: number } | null;
  markets: OndoMmMarket[];
  leftPositions: { market: string; position: string }[];
  recovery: { startedAt: string | null; error: string | null; cleaning: boolean } | null;
  events: OndoMmEvent[]; loadError: string | null; serverNow: number;
};
