import Decimal from 'decimal.js';

const D = Decimal.clone({ precision: 100 });
export type HistoryRecord = Record<string, unknown>;
export type HistoryAmount = { currency: string; value: string | null };
export const historyText = (row: HistoryRecord, key: string): string => typeof row[key] === 'string' ? row[key] as string : '';
export function historyDecimal(row: HistoryRecord, key: string): string | null {
  const value = historyText(row, key);
  try { return value.trim() && new D(value).isFinite() ? new D(value).toFixed() : null; } catch { return null; }
}
export function historyTime(row: HistoryRecord): number | null {
  for (const key of ['create_time', 'time', 'update_time']) {
    const value = row[key];
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed < 1e12 ? parsed * 1000 : parsed;
  }
  return null;
}
function sum(rows: HistoryRecord[], field: string): string | null {
  let total = new D(0);
  for (const row of rows) {
    const value = historyDecimal(row, field);
    if (value === null) return null;
    total = total.add(value);
  }
  return total.toFixed();
}
function amounts(rows: HistoryRecord[], field: string, currency: (row: HistoryRecord) => string): HistoryAmount[] {
  const currencies = new Map<string, HistoryRecord[]>();
  for (const row of rows) {
    const coin = currency(row) || '币种未知';
    const entries = currencies.get(coin) || []; entries.push(row); currencies.set(coin, entries);
  }
  return Array.from(currencies, ([currency, entries]) => ({ currency, value: sum(entries, field) }));
}
function weightedPrice(rows: HistoryRecord[]): string | null {
  let quantity = new D(0), notional = new D(0);
  for (const row of rows) {
    const qty = historyDecimal(row, 'qty'), price = historyDecimal(row, 'price');
    if (qty === null || price === null || !new D(qty).gt(0) || !new D(price).gt(0)) return null;
    quantity = quantity.add(qty); notional = notional.add(new D(qty).mul(price));
  }
  return quantity.gt(0) ? notional.div(quantity).toFixed() : null;
}
export type HistoryGroup = {
  key: string; orderId: string | null; symbol: string; exchange: string; side: string;
  rows: HistoryRecord[]; firstAt: number | null; lastAt: number | null;
  quantity: string | null; price: string | null; fees: HistoryAmount[]; realizedPnl: string | null;
  changes: HistoryAmount[]; statements: { type: string; amounts: HistoryAmount[] }[];
};
const orderStatements = new Set(['TRANSACTION', 'TRADING_FEE', 'LIQUIDATION_FEE']);
const bookCurrency = (row: HistoryRecord) => historyText(row, 'coin') || historyText(row, 'currency');

/** Gate business_id is an order ID only for these three statement types.
 * https://www.gate.com/docs/developers/apiv4/en/crossex/#query-account-book
 * Funding settlements, transfers and absent IDs remain independent records.
 */
export function groupAccountHistory(records: HistoryRecord[], kind: 'trades' | 'book'): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  records.forEach((row, index) => {
    const trade = kind === 'trades', symbol = historyText(row, 'symbol'), exchange = historyText(row, 'exchange_type');
    const orderId = (trade ? historyText(row, 'order_id') : orderStatements.has(historyText(row, 'statement_type')) ? historyText(row, 'business_id') : '') || null;
    const side = trade ? historyText(row, 'side') : '';
    const aggregatable = Boolean(orderId && symbol);
    let key = JSON.stringify([kind, historyText(row, 'user_id'), exchange, symbol, side,
      trade ? historyText(row, 'position_side') : '', aggregatable ? ['order', orderId] : ['record', historyText(row, trade ? 'transaction_id' : 'id') || index]]);
    // Stable record IDs preserve expansion when new settlements arrive. Even
    // malformed duplicate IDs must not merge records without an order identity.
    if (!aggregatable && groups.has(key)) key = JSON.stringify([key, index]);
    let group = groups.get(key);
    if (!group) {
      group = { key, orderId, symbol, exchange, side, rows: [], firstAt: null, lastAt: null,
        quantity: null, price: null, fees: [], realizedPnl: null, changes: [], statements: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
    const at = historyTime(row);
    if (at !== null) { group.firstAt = Math.min(group.firstAt ?? at, at); group.lastAt = Math.max(group.lastAt ?? at, at); }
  });
  for (const group of groups.values()) {
    group.rows.sort((a, b) => (historyTime(b) ?? 0) - (historyTime(a) ?? 0));
    if (kind === 'trades') {
      group.quantity = sum(group.rows, 'qty'); group.price = weightedPrice(group.rows);
      group.fees = amounts(group.rows, 'fee', row => historyText(row, 'fee_coin'));
      group.realizedPnl = sum(group.rows, 'rpnl');
    } else {
      group.changes = amounts(group.rows, 'change', bookCurrency);
      const types = new Map<string, HistoryRecord[]>();
      for (const row of group.rows) { const type = historyText(row, 'statement_type') || 'UNKNOWN'; const entries = types.get(type) || []; entries.push(row); types.set(type, entries); }
      group.statements = Array.from(types, ([type, entries]) => ({ type, amounts: amounts(entries, 'change', bookCurrency) }));
    }
  }
  return Array.from(groups.values()).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}
