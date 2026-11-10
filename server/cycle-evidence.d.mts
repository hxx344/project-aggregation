export type CycleEvidenceRow = {
  id: string; time: string; kind: 'fill' | 'funding' | 'realized'; status: 'included' | 'partial' | 'excluded';
  quantity: string | null; price: string | null; fraction: string | null;
  /** Absent from earlier v1 evidence; absence is unknown, not zero. */
  side?: 'buy' | 'sell' | null; closingQuantity?: string | null;
  realizedPnl: string | null; fee: string | null; feeCurrency: string | null;
  amount: string | null; currency: string | null; reason: string | null;
};
export type CycleEvidence = {
  version: 1; coverageStart: string; coverageEnd: string; openingFound: boolean;
  totalRows: number; truncated: boolean; rows: CycleEvidenceRow[];
};
export function parseCycleEvidence(value: unknown): CycleEvidence | null;
