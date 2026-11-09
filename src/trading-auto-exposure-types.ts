export type AutoExposureTotal = { quantity: string | null; knownQuantity: string; unknownCount: number; notional: string | null };
export type AutoExposureGroup = {
  id: string; exchange: string; symbol: string; accountKey: string; accountLabel: string;
  instrumentId: string | null; unit: string; contractSize: string | null; quoteAsset: string | null;
  side: 'long' | 'short'; currentAccount: boolean; accountAt: string | null; quoteAt: string | null;
  target: AutoExposureTotal; held: AutoExposureTotal; actual: { quantity: string | null; notional: string | null };
  rules: { id: string; title: string; mode: 'live' | 'observe'; enabled: boolean; observing: boolean; phase: string; quantity: string | null; heldQuantity: string | null; waitingFor: string[] }[];
  jobs: { id: string; ruleId: string | null; status: string; action: 'open' | 'close'; accountMatches: boolean; remainingQuantity: string | null }[];
  sharedRuleIds: string[]; gaps: string[];
  orders: { buyQuantity: string | null; sellQuantity: string | null; unknownCount: number;
    items: { id: string | null; kind: string; side: 'buy' | 'sell' | null; remainingQuantity: string | null; positionSide: string | null; reduceOnly: boolean | null }[] };
};
export type AutoExposure = {
  generatedAt: string; startedAt: string; expiresAt: string; maxAgeMs: number; rulesVersion: string;
  complete: boolean; scope: string; groups: AutoExposureGroup[]; gaps: string[];
};
