import { FIRST_FULL_HOUR } from "./market.ts";

export const FUNDING_HOUR = 3_600_000;
export const FIRST_FUNDING_SETTLEMENT = FIRST_FULL_HOUR + FUNDING_HOUR;
export const FUNDING_COINS = { adr: "xyz:SKHY", ordinary: "xyz:SKHX" } as const;
export type SettledFundingRow = { time: number; adr: number | null; ordinary: number | null };
export type FundingSnapshot = {
  metadata: { source: string; fetchedAt: string; firstSettlementTime: number; lastSettlementTime: number; pairedHours: number };
  rows: SettledFundingRow[];
};
export type FundingHistoryData = FundingSnapshot & { status: "live" | "snapshot"; error?: string };
type FundingRecord = { coin: string; time: number; fundingRate: number };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function numeric(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value))) throw new Error("Invalid historical funding value");
  return Number(value);
}
function readRecord(value: unknown, coin: string): FundingRecord {
  if (!value || typeof value !== "object" || !("coin" in value) || value.coin !== coin || !("time" in value) || !("fundingRate" in value)) throw new Error("Unexpected historical funding record");
  const time = numeric(value.time), fundingRate = numeric(value.fundingRate);
  if (!Number.isSafeInteger(time)) throw new Error("Invalid funding settlement timestamp");
  return { coin, time, fundingRate };
}

export function pairHynixFunding(adrRecords: unknown[], ordinaryRecords: unknown[], now = Date.now()): SettledFundingRow[] {
  const collect = (records: unknown[], coin: string) => {
    const collected = new Map<number, number>();
    for (const record of records) {
      const { time, fundingRate } = readRecord(record, coin);
      if (time < FIRST_FUNDING_SETTLEMENT || time > now) continue;
      // Settlement blocks may arrive milliseconds after the UTC hour.
      const hour = Math.floor(time / FUNDING_HOUR) * FUNDING_HOUR;
      if (collected.has(hour) && collected.get(hour) !== fundingRate) throw new Error("Conflicting funding rates in one settlement hour");
      collected.set(hour, fundingRate);
    }
    return collected;
  };
  const adr = collect(adrRecords, FUNDING_COINS.adr), ordinary = collect(ordinaryRecords, FUNDING_COINS.ordinary);
  return [...new Set([...adr.keys(), ...ordinary.keys()])].sort((a, b) => a - b).map(time => ({ time, adr: adr.get(time) ?? null, ordinary: ordinary.get(time) ?? null }));
}

export function createHynixFundingSnapshot(rows: SettledFundingRow[], fetchedAt: string): FundingSnapshot {
  const received = Date.parse(fetchedAt);
  if (!Number.isFinite(received)) throw new Error("Invalid funding fetch timestamp");
  let previous = -Infinity;
  const validated = rows.map(row => {
    if (!Number.isSafeInteger(row.time) || row.time < FIRST_FUNDING_SETTLEMENT || row.time > received || row.time % FUNDING_HOUR || row.time <= previous) throw new Error("Invalid or unordered funding settlement hour");
    previous = row.time;
    const adr = row.adr === null ? null : numeric(row.adr), ordinary = row.ordinary === null ? null : numeric(row.ordinary);
    if (adr === null && ordinary === null) throw new Error("Funding settlement has neither leg");
    return { time: row.time, adr, ordinary };
  });
  const paired = validated.filter(row => row.adr !== null && row.ordinary !== null);
  if (!paired.length) throw new Error("No paired funding settlements");
  return { metadata: { source: "Hyperliquid fundingHistory · xyz:SKHY / xyz:SKHX · UTC hourly settlements", fetchedAt, firstSettlementTime: paired[0].time, lastSettlementTime: paired.at(-1)!.time, pairedHours: paired.length }, rows: validated };
}

export async function fetchHynixFundingRecords(coin: string, startTime: number, endTime: number, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<FundingRecord[]> {
  if (![FUNDING_COINS.adr, FUNDING_COINS.ordinary].some(value => value === coin)) throw new Error("Unsupported funding coin");
  const records = new Map<number, FundingRecord>();
  let cursor = startTime;
  for (let page = 0; page < 100 && cursor <= endTime; page++) {
    const response = await fetcher("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "fundingHistory", coin, startTime: cursor, endTime }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("Invalid funding history response");
    if (!body.length) return [...records.values()].sort((a, b) => a.time - b.time);
    let last = -Infinity;
    for (const value of body) {
      const record = readRecord(value, coin);
      if (record.time > endTime) throw new Error("Future funding settlement in API response");
      const old = records.get(record.time);
      if (old && old.fundingRate !== record.fundingRate) throw new Error("Conflicting funding records across pages");
      if (record.time >= startTime) records.set(record.time, record);
      last = Math.max(last, record.time);
    }
    if (last < cursor) throw new Error("Funding pagination did not advance");
    cursor = last + 1;
  }
  if (cursor <= endTime) throw new Error("Funding pagination exceeded limit");
  return [...records.values()].sort((a, b) => a.time - b.time);
}

export async function fetchHynixFundingSnapshot(existing: FundingSnapshot | null, { fetcher = fetch, now = Date.now(), signal }: { fetcher?: Fetcher; now?: number; signal?: AbortSignal } = {}): Promise<FundingSnapshot> {
  const previous = existing ? createHynixFundingSnapshot(existing.rows, existing.metadata.fetchedAt) : null;
  // Backfill the first incomplete hour too, so an old one-sided observation is not forgotten.
  let expected = FIRST_FUNDING_SETTLEMENT, missingHour = Infinity;
  for (const row of previous?.rows ?? []) {
    if (row.time > expected || row.adr === null || row.ordinary === null) { missingHour = Math.min(expected, row.time); break; }
    expected = row.time + FUNDING_HOUR;
  }
  const start = previous ? Math.max(FIRST_FUNDING_SETTLEMENT, Math.min(previous.metadata.lastSettlementTime - 48 * FUNDING_HOUR, missingHour)) : FIRST_FUNDING_SETTLEMENT;
  const [adr, ordinary] = await Promise.all([fetchHynixFundingRecords(FUNDING_COINS.adr, start, now, fetcher, signal), fetchHynixFundingRecords(FUNDING_COINS.ordinary, start, now, fetcher, signal)]);
  const merged = new Map((previous?.rows ?? []).map(row => [row.time, row]));
  for (const row of pairHynixFunding(adr, ordinary, now)) {
    const old = merged.get(row.time);
    merged.set(row.time, { time: row.time, adr: row.adr ?? old?.adr ?? null, ordinary: row.ordinary ?? old?.ordinary ?? null });
  }
  return createHynixFundingSnapshot([...merged.values()].sort((a, b) => a.time - b.time), new Date(now).toISOString());
}
