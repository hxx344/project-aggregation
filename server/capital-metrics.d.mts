export interface CapitalAssumptions {
  longLeverage: number;
  shortLeverage: number;
  marginBufferPercent: number;
  holdingHours: number;
}

export interface PairCapitalEstimate {
  capitalPercent: number | null;
  longMarginPercent: number | null;
  shortNotionalPercent: number | null;
  shortMarginPercent: number | null;
  reason: string;
}

export interface PairRocEstimate {
  expectedNetPercent: number | null;
  rocPercent: number | null;
  annualizedRocPercent: number | null;
  fundingRocAnnualizedPercent: number | null;
  fundingPercent: number | null;
  fundingAvailable: boolean;
  reason: string;
}

export const DEFAULT_CAPITAL_ASSUMPTIONS: Readonly<CapitalAssumptions>;

export function normalizeCapitalAssumptions(value: Partial<CapitalAssumptions> | null | undefined): CapitalAssumptions;
export function parseCapitalAssumptions(raw: string | null | undefined): CapitalAssumptions;

export function estimatePairCapitalFromRatio(input: {
  shortToLongRatio: number | null | undefined;
  longLeverage: number;
  shortLeverage: number;
  marginBufferPercent: number;
}): PairCapitalEstimate;

export function estimatePairCapital(input: {
  longPrice: number | null | undefined;
  shortPrice: number | null | undefined;
  longLeverage: number;
  shortLeverage: number;
  marginBufferPercent: number;
}): PairCapitalEstimate;

export function estimatePairRoc(input: {
  netSpreadPercent: number | null | undefined;
  longFunding8h: number | null | undefined;
  shortFunding8h: number | null | undefined;
  shortNotionalPercent: number | null | undefined;
  capitalPercent: number | null | undefined;
  holdingHours: number;
}): PairRocEstimate;
