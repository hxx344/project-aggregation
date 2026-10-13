// Verified 1:1 crypto aliases only. Keep native symbols and quantity units intact.
// Terra 2.0, never Terra Classic (LUNC):
// https://www.binance.com/en/support/announcement/detail/2806253154aa4c36bffdfe60c6afc85e
// https://www.gate.com/pt/announcements/article/26708
// https://www.okx.com/en-gb/help/okx-will-list-terra-2-0-luna-token-for-spot-trading
// https://www.okx.com/en-eu/help/okx-to-list-usdt-margined-perpetual-for-luna
// Kraken explicitly uses XBT for Bitcoin in its native perpetual product id:
// https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications
const aliases = new Map([
  ['gate', new Map([['LUNA', 'LUNA2']])],
  ['okx', new Map([['LUNA', 'LUNA2']])],
  ['kraken', new Map([['XBT', 'BTC']])],
]);

export const canonicalBase = (exchange, nativeBase) => aliases.get(exchange)?.get(nativeBase) ?? nativeBase;
export const crossexBase = (exchange, nativeBase) => exchange === 'kraken' ? canonicalBase(exchange, nativeBase) : nativeBase;

// Accept legacy native base values as well as the canonical value. Never accept
// an arbitrary rawBase supplied by a feed as a declaration of equivalence.
export function validBaseMapping(exchange, base, rawBase = base) {
  return typeof base === 'string' && /^[A-Z0-9]{1,30}$/.test(base)
    && typeof rawBase === 'string' && /^[A-Z0-9]{1,30}$/.test(rawBase)
    && (base === rawBase || base === canonicalBase(exchange, rawBase));
}

// Blocklists have no venue field. Either verified spelling blocks the whole
// alias family, including old settings saved before normalization was added.
const blockedAliases = new Map([['LUNA2', ['LUNA']], ['LUNA', ['LUNA2']], ['BTC', ['XBT']], ['XBT', ['BTC']]]);
export function isBaseBlocked(blocked, base) {
  return blocked.has(base) || (blockedAliases.get(base) ?? []).some(alias => blocked.has(alias));
}
