import { canonicalBase } from '../../../server/asset-identity.mjs';
import { cleanHubQuery, type HubQuery } from '../../../server/hub-navigation.mjs';
import type { Instrument } from './live-types';

/** The catalog keeps native base names; the picker groups verified 1:1 aliases. */
export const instrumentBase = (instrument: Pick<Instrument, 'exchange' | 'base'>) => canonicalBase(instrument.exchange, instrument.base);

export interface MissingImportLeg { side: 'long' | 'short'; exchange: string; symbol: string }
export interface OpportunityImportResolution { long: Instrument | null; short: Instrument | null; missing: MissingImportLeg[] }

function matchInstrument(instruments: Instrument[], query: HubQuery, symbol: string, exchange: string | undefined) {
  const currency = symbol.split('_').at(-1);
  return instruments.find(instrument => instrument.symbol === symbol && instrument.exchange === exchange
    && instrumentBase(instrument) === query.symbol && instrument.quoteCurrency === currency
    && (!instrument.state || instrument.state === 'live')) ?? null;
}

/**
 * Resolve each exact CrossEx contract independently. A leg that CrossEx does not
 * list stays missing; the other leg is still reported so the caller can keep it
 * selected without inventing a substitute.
 */
export function resolveOpportunityImport(input: HubQuery, instruments: Instrument[]): OpportunityImportResolution | null {
  const query = cleanHubQuery(input);
  if (!query?.importId || !query.longContract || !query.shortContract) return null;
  const long = matchInstrument(instruments, query, query.longContract, query.longExchange);
  const short = matchInstrument(instruments, query, query.shortContract, query.shortExchange);
  const missing: MissingImportLeg[] = [];
  if (!long) missing.push({ side: 'long', exchange: query.longExchange ?? '', symbol: query.longContract });
  if (!short) missing.push({ side: 'short', exchange: query.shortExchange ?? '', symbol: query.shortContract });
  return { long, short, missing };
}

/** Resolve both exact CrossEx contracts, including their own counter currencies. */
export function opportunityImportPair(input: HubQuery, instruments: Instrument[]) {
  const resolution = resolveOpportunityImport(input, instruments);
  return resolution?.long && resolution.short ? { long: resolution.long, short: resolution.short } : null;
}

/** Name the unlisted legs and the venues CrossEx does list for this base. */
export function importStatusMessage(input: HubQuery, resolution: OpportunityImportResolution | null, instruments: Instrument[], catalogError: string,
  venueLabel: (exchange: string) => string = exchange => exchange) {
  const base = input.symbol || '—';
  const requested = `${input.longContract || '多腿合约缺失'} / ${input.shortContract || '空腿合约缺失'}`;
  if (catalogError) return `导入尚未完成：合约目录读取失败。已保留导入请求 ${base}：${requested}；目录恢复后会按精确合约重新匹配。`;
  if (!instruments.length) return `导入尚未完成：正在等待合约目录。已保留导入请求 ${base}：${requested}；目录到达后会按精确合约重新匹配。`;
  const missing = resolution?.missing ?? [];
  if (!missing.length) return `导入尚未完成：目录中未找到完整的精确双腿合约。已保留导入请求 ${base}：${requested}；也可手动重新选择币种。`;
  const missingText = missing.map(leg => `${venueLabel(leg.exchange)} 的 ${leg.symbol}`).join('、');
  const available = Array.from(new Set(instruments.filter(instrument => instrumentBase(instrument) === base && (!instrument.state || instrument.state === 'live')).map(instrument => venueLabel(instrument.exchange))));
  const kept = [resolution?.long, resolution?.short].filter((instrument): instrument is Instrument => !!instrument)
    .map(instrument => `${venueLabel(instrument.exchange)} ${instrument.symbol}`);
  const availableText = !available.length ? `CrossEx 目录中没有 ${base} 合约。`
    : available.length === 1 ? `CrossEx 目录中只有 ${available[0]} 的 ${base} 合约，暂时无法组成双腿。`
    : `CrossEx 可交易的 ${base}：${available.join('、')}。`;
  const keptText = available.length > 1 ? kept.length ? `已选中 ${kept.join('、')}，请为另一腿重新选择受支持的合约。` : '请手动重新选择币种。' : '';
  return `导入尚未完成：CrossEx 未上架 ${missingText}。${availableText}${keptText}`;
}
