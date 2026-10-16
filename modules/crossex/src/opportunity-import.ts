import { canonicalBase } from '../../../server/asset-identity.mjs';
import { cleanHubQuery, type HubQuery } from '../../../server/hub-navigation.mjs';
import type { Instrument } from './live-types';

/** The catalog keeps native base names; the picker groups verified 1:1 aliases. */
export const instrumentBase = (instrument: Pick<Instrument, 'exchange' | 'base'>) => canonicalBase(instrument.exchange, instrument.base);

/** Resolve both exact CrossEx contracts, including their own counter currencies. */
export function opportunityImportPair(input: HubQuery, instruments: Instrument[]) {
  const query = cleanHubQuery(input);
  if (!query?.importId || !query.longContract || !query.shortContract) return null;
  const match = (symbol: string, exchange: string | undefined) => {
    const currency = symbol.split('_').at(-1);
    return instruments.find(instrument => instrument.symbol === symbol && instrument.exchange === exchange
      && instrumentBase(instrument) === query.symbol && instrument.quoteCurrency === currency
      && (!instrument.state || instrument.state === 'live'));
  };
  const long = match(query.longContract, query.longExchange), short = match(query.shortContract, query.shortExchange);
  return long && short ? { long, short } : null;
}
