import archive from '../public/oil/data/binance-2026.json' with { type: 'json' };
import fundingArchive from '../public/oil/data/binance-funding-2026.json' with { type: 'json' };
import { readExchangeQuote } from './exchange-service.ts';
import { marketFromExchangeQuote, fetchDailySnapshot, validateMarket } from '../modules/oil/binance.mjs';
import { fetchFundingSnapshot, validateFundingSnapshot } from '../modules/oil/binance-funding-history.mjs';

let latestMarket = validateMarket(archive.market), latestFunding = validateFundingSnapshot(fundingArchive);
let latestDaily: Awaited<ReturnType<typeof fetchDailySnapshot>> = archive;
export async function fetchOilMarket() { return marketFromExchangeQuote(await readExchangeQuote('binance', 'oil')); }
export async function loadOilMarket() {
  try { latestMarket = await fetchOilMarket(); return { ...latestMarket, status: 'live' }; }
  catch { return { ...latestMarket, status: 'snapshot' }; }
}
export async function loadOilDaily() {
  try { latestDaily = await fetchDailySnapshot(await fetchOilMarket()); return { ...latestDaily, status: 'live' }; }
  catch { return { ...latestDaily, status: 'snapshot' }; }
}
export async function loadOilFunding() {
  try { latestFunding = await fetchFundingSnapshot(latestFunding); return { ...latestFunding, status: 'live' }; }
  catch { return { ...latestFunding, status: 'snapshot' }; }
}
