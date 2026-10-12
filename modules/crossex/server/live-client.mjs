import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import Decimal from 'decimal.js';

// Gate CrossEx REST contract, checked 2026-10-08:
// https://www.gate.com/docs/developers/crossex/zh_CN/
// https://www.gate.com/docs/developers/apiv4/en/account/
// Sparse-response compatibility follows your-quantguy/gate-crossex at
// 423356d89e5c8f41d9d9033f4db1f40299774ec0, apps/backend/src/crossex-client.ts.
// All request paths and monetary units are checked against the official contract.
const ORIGIN = 'https://api.gateio.ws', PREFIX = '/api/v4';
const MAX_BYTES = 8 * 1024 * 1024, PAGE_SIZE = 100, MAX_PAGES = 50, MAX_ROWS = 10_000;
export const GATE_ORDER_STATES = Object.freeze(['NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'FAIL', 'REJECT', 'CANCELLED']);
export const GATE_TERMINAL_STATES = Object.freeze(['FILLED', 'FAIL', 'REJECT', 'CANCELLED']);
export const GATE_EXCHANGES = Object.freeze(['BINANCE', 'OKX', 'GATE', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER']);
const SIDES = ['BUY', 'SELL'], POSITION_SIDES = ['NONE', 'LONG', 'SHORT'], TYPES = ['LIMIT', 'MARKET'];
const TIFS = ['GTC', 'IOC', 'FOK', 'POC', 'RPI'], ATTRIBUTES = ['COMMON', 'LIQ', 'REDUCE', 'ADL', 'SETTLEMENT'];
const BOOK_TYPES = ['TRANSACTION', 'TRADING_FEE', 'FUNDING_FEE', 'LIQUIDATION_FEE', 'TRANSFER_IN', 'TRANSFER_OUT', 'BANKRUPT_COMPENSATION', 'AUTO_REPAY', 'INTEREST_ISOLATED', 'ACCOUNT_MODE_CHANGE', 'KRAKEN_CONVERSION', 'OTHER'];
const SAFE_LABELS = new Set(['TRADE_ORDER_NOT_FOUND_ERROR', 'TRADE_ORDER_DUPLICATE_ERROR', 'INVALID_KEY', 'INVALID_CREDENTIALS', 'INVALID_SIGNATURE', 'IP_FORBIDDEN', 'READ_ONLY', 'FORBIDDEN', 'REQUEST_EXPIRED', 'ACCOUNT_LOCKED']);

export class GateClientError extends Error {
  constructor(code, message, { sourceStatus, uncertain = false } = {}) {
    super(message); this.name = 'GateClientError'; this.code = code; this.status = code === 'GATE_INVALID_INPUT' ? 400 : 502; this.uncertain = uncertain;
    if (sourceStatus !== undefined) this.sourceStatus = sourceStatus;
  }
}
const invalid = () => new GateClientError('GATE_INVALID_RESPONSE', 'Gate 返回结构或字段无效，状态尚未确认');
const inputError = () => new GateClientError('GATE_INVALID_INPUT', 'Gate 请求参数无效');
function requireValue(condition, error = invalid) { if (!condition) throw error(); }
function object(value) { requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)); return value; }
function string(value, max = 128) { requireValue(typeof value === 'string' && value.length <= max); return value; }
function id(value) { requireValue(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)); return value; }
function uid(value) { requireValue(typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value)); return value; }
function enumValue(value, values) { requireValue(values.includes(value)); return value; }
function modeValue(value) { requireValue(typeof value === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(value)); return value; }
function money(value, sign = 'signed') {
  requireValue(typeof value === 'string' && value.length <= 128 && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value));
  const decimal = new Decimal(value);
  requireValue(sign === 'signed' || (sign === 'positive' ? decimal.gt(0) : decimal.gte(0)));
  return value;
}
function time(value) { requireValue(typeof value === 'string' && /^[0-9]{1,16}$/.test(value) && Number.isSafeInteger(Number(value))); return value; }
function symbol(value) {
  requireValue(typeof value === 'string' && value.length <= 160 && /^(BINANCE|OKX|GATE|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_(SPOT|FUTURE|MARGIN|CONVERT)_[A-Z0-9][A-Z0-9.-]*_[A-Z0-9][A-Z0-9.-]*$/.test(value));
  return value;
}
function copyFields(row, output, fields, validate) { for (const field of fields) if (row[field] !== undefined) output[field] = row[field] === null ? null : validate(row[field]); }
function optionalUid(row, output) { copyFields(row, output, ['user_id'], uid); }
function optionalText(validate) { return value => value === '' ? '' : validate(value); }
function symbolList(values, max = 50) {
  try {
    requireValue(Array.isArray(values) && values.length <= max && new Set(values).size === values.length);
    return values.map(value => { const result = symbol(value); requireValue(result.includes('_FUTURE_')); return result; });
  } catch { throw inputError(); }
}
function venueQuery(exchangeType) {
  requireValue(exchangeType === undefined || GATE_EXCHANGES.includes(exchangeType), inputError);
  return exchangeType === undefined ? {} : { exchange_type: exchangeType };
}
function list(value, validate, uniqueField, max = MAX_ROWS) {
  requireValue(Array.isArray(value) && value.length < max);
  const rows = value.map(validate), seen = new Set();
  for (const row of rows) {
    const key = typeof uniqueField === 'function' ? uniqueField(row) : row[uniqueField];
    requireValue(!seen.has(key)); seen.add(key);
  }
  return rows;
}
function identity(row) {
  object(row);
  const out = { symbol: symbol(row.symbol) }; optionalUid(row, out);
  const [exchange, business] = out.symbol.split('_');
  for (const [field, expected] of [['exchange_type', exchange], ['business_type', business]]) {
    if (row[field] !== undefined) { requireValue(row[field] == null || row[field] === '' || row[field] === expected); out[field] = row[field]; }
  }
  return out;
}
function order(row) {
  const out = identity(row);
  Object.assign(out, {
    order_id: id(row.order_id), text: string(row.text ?? row.client_order_id), state: enumValue(row.state, GATE_ORDER_STATES),
    side: enumValue(row.side, SIDES), type: enumValue(row.type, TYPES),
    qty: money(row.qty, 'nonnegative'), executed_qty: money(row.executed_qty, 'nonnegative'),
    executed_avg_price: money(row.executed_avg_price, 'nonnegative'), update_time: time(row.update_time),
  });
  if (row.text != null && row.client_order_id != null) requireValue(row.text === row.client_order_id);
  copyFields(row, out, ['client_order_id'], string);
  copyFields(row, out, ['position_side'], optionalText(value => enumValue(value, POSITION_SIDES)));
  copyFields(row, out, ['reduce_only'], optionalText(value => enumValue(value, ['true', 'false'])));
  copyFields(row, out, ['time_in_force'], optionalText(value => enumValue(value, TIFS)));
  copyFields(row, out, ['price', 'executed_amount', 'quote_qty', 'leverage', 'last_executed_qty', 'last_executed_price', 'last_executed_amount'], optionalText(value => money(value, 'nonnegative')));
  copyFields(row, out, ['create_time'], optionalText(time));
  copyFields(row, out, ['fee'], optionalText(money));
  copyFields(row, out, ['fee_coin'], value => { requireValue(typeof value === 'string' && /^[a-zA-Z0-9_-]{0,80}$/.test(value)); return value; });
  // Exchange messages can echo request material; use local descriptions only.
  out.reason = out.state === 'FAIL' ? 'CrossEx 校验未通过' : out.state === 'REJECT' ? '交易所拒绝此订单' : '';
  copyFields(row, out, ['attribute'], optionalText(value => enumValue(value, ATTRIBUTES)));
  if (out.create_time != null && out.create_time !== '') requireValue(Number(out.update_time) >= Number(out.create_time));
  if (out.symbol.includes('_FUTURE_')) requireValue(new Decimal(out.executed_qty).lte(out.qty));
  return out;
}
function position(row) {
  const out = identity(row); requireValue(out.symbol.includes('_FUTURE_'));
  Object.assign(out, { position_id: id(row.position_id), position_side: enumValue(row.position_side, POSITION_SIDES), position_qty: money(row.position_qty) });
  copyFields(row, out, ['entry_price', 'mark_price'], value => money(value, 'nonnegative'));
  copyFields(row, out, ['initial_margin', 'isolated_margin', 'maintenance_margin', 'position_value', 'upnl', 'upnl_rate', 'liq_price', 'leverage', 'max_leverage', 'risk_limit', 'fee', 'funding_fee', 'closed_pnl'], money);
  copyFields(row, out, ['create_time', 'update_time', 'funding_time'], time);
  copyFields(row, out, ['margin_mode'], value => enumValue(value, ['CROSS', 'ISOLATED']));
  return out;
}
function account(row) {
  object(row);
  const out = { assets: [] }; optionalUid(row, out);
  copyFields(row, out, ['position_mode', 'account_mode', 'exchange_type'], modeValue);
  for (const name of ['available_margin', 'margin_balance', 'initial_margin', 'maintenance_margin', 'initial_margin_rate', 'maintenance_margin_rate']) out[name] = money(row[name]);
  copyFields(row, out, ['account_limit'], money); copyFields(row, out, ['create_time', 'update_time'], time);
  out.assets = list(row.assets, asset => {
    object(asset);
    const item = { coin: id(asset.coin), exchange_type: enumValue(asset.exchange_type, ['CROSSEX', ...GATE_EXCHANGES]) };
    if (asset.user_id != null) { item.user_id = uid(asset.user_id); requireValue(out.user_id == null || item.user_id === out.user_id); }
    else if (asset.user_id === null) item.user_id = null;
    copyFields(asset, item, ['balance', 'upnl', 'equity', 'available_balance', 'liability', 'futures_initial_margin', 'futures_maintenance_margin', 'borrowing_initial_margin', 'borrowing_maintenance_margin'], money);
    return item;
  }, item => `${item.exchange_type}:${item.coin}`);
  requireValue(new Set(out.assets.map(asset => asset.user_id).filter(value => value != null)).size <= 1);
  return out;
}
function trade(row) {
  const out = identity(row);
  Object.assign(out, { transaction_id: id(row.transaction_id), order_id: id(row.order_id), side: enumValue(row.side, SIDES), qty: money(row.qty, 'positive'), price: money(row.price, 'positive'), create_time: time(row.create_time) });
  copyFields(row, out, ['text'], string);
  copyFields(row, out, ['fee_coin'], value => { requireValue(typeof value === 'string' && /^[a-zA-Z0-9_-]{0,80}$/.test(value)); return value; });
  copyFields(row, out, ['fee', 'fee_rate', 'rpnl'], money);
  copyFields(row, out, ['match_role'], value => { requireValue(typeof value === 'string' && /^[a-zA-Z_]{0,32}$/.test(value)); return value; });
  copyFields(row, out, ['position_mode'], value => enumValue(value, ['SINGLE', 'DUAL']));
  copyFields(row, out, ['position_side'], value => enumValue(value, POSITION_SIDES));
  return out;
}
function fee(row) {
  object(row); const out = { exchange_type: enumValue(row.exchange_type, GATE_EXCHANGES) };
  copyFields(row, out, ['spot_maker_fee', 'spot_taker_fee', 'spot_rpi_maker_fee', 'future_maker_fee', 'future_taker_fee', 'future_rpi_maker_fee'], optionalText(money));
  if (row.special_fee_list !== undefined) {
    out.special_fee_list = row.special_fee_list === null ? null : list(row.special_fee_list, entry => {
      object(entry); const special = { symbol: symbol(entry.symbol) };
      requireValue(special.symbol.startsWith(`${out.exchange_type}_`));
      copyFields(entry, special, ['maker_fee_rate', 'taker_fee_rate', 'rpi_fee_rate'], optionalText(money));
      return special;
    }, 'symbol');
  }
  return out;
}
function riskLimit(row) {
  object(row); const out = { symbol: symbol(row.symbol) }; requireValue(out.symbol.includes('_FUTURE_'));
  out.tiers = list(row.tiers, tier => {
    object(tier); const result = {};
    for (const field of ['min_risk_limit_value', 'max_risk_limit_value', 'quick_cal_amount', 'maintenance_rate']) result[field] = money(tier[field], 'nonnegative');
    result.leverage_max = money(tier.leverage_max, 'positive'); result.tier = time(tier.tier);
    requireValue(Number(result.tier) > 0 && new Decimal(result.max_risk_limit_value).gte(result.min_risk_limit_value));
    return result;
  }, 'tier', 1001);
  return out;
}
function accountBookRecord(row) {
  object(row);
  const out = { id: id(row.id), statement_type: modeValue(row.statement_type), coin: id(row.coin), change: money(row.change), balance: money(row.balance), create_time: time(row.create_time) };
  optionalUid(row, out); copyFields(row, out, ['business_id'], value => string(value, 160));
  copyFields(row, out, ['exchange_type'], value => enumValue(value, ['CROSSEX', ...GATE_EXCHANGES]));
  copyFields(row, out, ['symbol'], optionalText(symbol));
  if (out.symbol && out.exchange_type && out.exchange_type !== 'CROSSEX') requireValue(out.symbol.startsWith(`${out.exchange_type}_`));
  return out;
}
function adlRank(row) {
  const out = identity(row);
  requireValue(out.symbol.includes('_FUTURE_'));
  out.crossex_adl_rank = enumValue(row.crossex_adl_rank, ['1', '2', '3', '4', '5']);
  out.exchange_adl_rank = time(row.exchange_adl_rank);
  return out;
}
function acknowledgment(row, expected) {
  object(row); const out = { order_id: id(row.order_id), text: string(row.text) };
  if (expected !== undefined) requireValue(out.order_id === expected || out.text === expected);
  return out;
}
function orderPayload(value) {
  try {
    object(value);
    const fields = ['text', 'symbol', 'side', 'type', 'time_in_force', 'qty', 'price', 'quote_qty', 'reduce_only', 'position_side'];
    requireValue(Object.keys(value).every(key => fields.includes(key)));
    requireValue(typeof value.text === 'string' && /^[a-z0-9_-]{1,63}$/.test(value.text));
    const out = { text: value.text, symbol: symbol(value.symbol), side: enumValue(value.side, SIDES), type: enumValue(value.type ?? 'LIMIT', TYPES), time_in_force: enumValue(value.time_in_force ?? 'GTC', TIFS) };
    const [venue, business] = out.symbol.split('_');
    requireValue(business !== 'CONVERT' && !(['KRAKEN', 'HYPERLIQUID', 'LIGHTER'].includes(venue) && business !== 'FUTURE') && !(['BYBIT', 'DERIBIT'].includes(venue) && business === 'MARGIN'));
    const quoteBuy = business !== 'FUTURE' && out.side === 'BUY' && out.type === 'MARKET';
    if (quoteBuy) { out.quote_qty = money(value.quote_qty, 'positive'); requireValue(value.qty === undefined); }
    else { out.qty = money(value.qty, 'positive'); requireValue(value.quote_qty === undefined); }
    if (out.type === 'LIMIT') out.price = money(value.price, 'positive');
    else requireValue(value.price === undefined && !['POC', 'RPI'].includes(out.time_in_force));
    if (value.reduce_only !== undefined) out.reduce_only = enumValue(value.reduce_only, ['true', 'false']);
    if (value.position_side !== undefined) out.position_side = enumValue(value.position_side, POSITION_SIDES);
    if (business === 'MARGIN') requireValue(['LONG', 'SHORT'].includes(out.position_side));
    return out;
  } catch { throw inputError(); }
}

/** Fixed Gate REST endpoints. Credentials stay in this closure; no order is retried. */
export function createGateClient({ apiKey, apiSecret, fetcher = fetch, clock = Date.now, timeoutMs = 8000 } = {}) {
  requireValue(typeof apiKey === 'string' && /^[\x21-\x7e]{1,512}$/.test(apiKey) && typeof apiSecret === 'string' && apiSecret.length > 0 && apiSecret.length <= 2048 && typeof fetcher === 'function' && typeof clock === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, inputError);
  async function request(method, path, query = {}, payload, validate = value => value, { authenticated = true } = {}) {
    const queryString = Object.entries(query).map(([key, value]) => `${key}=${value}`).join('&');
    const body = payload === undefined ? '' : JSON.stringify(payload), pathname = PREFIX + path;
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (authenticated) {
      const at = clock(); requireValue(Number.isSafeInteger(at) && at > 0, inputError);
      const timestamp = String(Math.floor(at / 1000));
      const signature = [method, pathname, queryString, createHash('sha512').update(body).digest('hex'), timestamp].join('\n');
      Object.assign(headers, { KEY: apiKey, Timestamp: timestamp, SIGN: createHmac('sha512', apiSecret).update(signature).digest('hex') });
    }
    const controller = new AbortController(); let timer;
    const work = async () => {
      const response = await fetcher(ORIGIN + pathname + (queryString ? `?${queryString}` : ''), { method, headers, ...(body ? { body } : {}), redirect: 'error', signal: controller.signal });
      let bytes = 0; const chunks = [];
      if (response.body) for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) { controller.abort(); throw invalid(); }
        chunks.push(Buffer.from(chunk));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { if (response.ok) throw invalid(); }
      if (!response.ok) {
        const error = new GateClientError('GATE_HTTP_ERROR', `Gate 请求未成功（${Number.isInteger(response.status) ? response.status : 502}）`, { sourceStatus: response.status, uncertain: method !== 'GET' && (response.status >= 500 || [408, 409, 429].includes(response.status)) });
        if (SAFE_LABELS.has(data?.label)) error.label = data.label;
        if (data?.label === 'TRADE_ORDER_DUPLICATE_ERROR') error.uncertain = method !== 'GET';
        throw error;
      }
      return validate(data);
    };
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new GateClientError('GATE_TIMEOUT', 'Gate 请求超时，结果尚未确认', { uncertain: method !== 'GET' })); }, timeoutMs);
      })]);
    } catch (error) {
      if (error instanceof GateClientError) { if (method !== 'GET' && error.code === 'GATE_INVALID_RESPONSE') error.uncertain = true; throw error; }
      throw new GateClientError('GATE_NETWORK_ERROR', 'Gate 请求连接失败，结果尚未确认', { uncertain: method !== 'GET' });
    } finally { clearTimeout(timer); }
  }
  async function history(path, options = {}, validate, key) {
    requireValue(options !== null && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(name => ['symbol', 'from', 'to', ...(path.endsWith('history_orders') ? ['attributes'] : [])].includes(name)), inputError);
    const query = { ...options, to: options.to ?? clock() };
    try {
      if (query.symbol !== undefined) symbol(query.symbol);
      for (const field of ['from', 'to']) if (query[field] !== undefined) requireValue(Number.isSafeInteger(query[field]) && query[field] >= 0);
      requireValue(query.from === undefined || query.from <= query.to);
      if (query.attributes !== undefined) requireValue(typeof query.attributes === 'string' && query.attributes.split(',').every(value => ATTRIBUTES.includes(value)));
    } catch { throw inputError(); }
    const out = [], seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await request('GET', path, { ...query, page, limit: PAGE_SIZE }, undefined, data => list(data, validate, key, PAGE_SIZE + 1));
      for (const row of rows) {
        requireValue(!seen.has(row[key]) && (query.symbol === undefined || row.symbol === query.symbol));
        // Sparse terminal orders can omit create_time. Keep it unknown instead of
        // fabricating a timestamp or preventing their reconciliation.
        if (row.create_time != null && row.create_time !== '') requireValue(Number(row.create_time) <= query.to && (query.from === undefined || Number(row.create_time) >= query.from));
        seen.add(row[key]); out.push(row);
      }
      if (rows.length < PAGE_SIZE) return out;
    }
    throw new GateClientError('GATE_INCOMPLETE_HISTORY', 'Gate 历史记录超过完整查询上限，请缩小时间范围');
  }
  return Object.freeze({
    async getAccount(exchangeType) {
      return request('GET', '/crossex/accounts', venueQuery(exchangeType), undefined, data => {
        const result = account(data);
        if (exchangeType !== undefined && result.exchange_type != null) requireValue(result.exchange_type === exchangeType);
        return result;
      });
    },
    async getPositions(exchangeType) {
      return request('GET', '/crossex/positions', venueQuery(exchangeType), undefined, data => list(data, row => { const result = position(row); requireValue(exchangeType === undefined || result.symbol.startsWith(`${exchangeType}_`)); return result; }, 'position_id'));
    },
    async getOpenOrders(exchangeType) {
      return request('GET', '/crossex/open_orders', venueQuery(exchangeType), undefined, data => list(data, row => { const result = order(row); requireValue(exchangeType === undefined || result.symbol.startsWith(`${exchangeType}_`)); return result; }, 'order_id', 1001));
    },
    async getOrder(orderId) {
      try { id(orderId); } catch { throw inputError(); }
      return request('GET', `/crossex/orders/${orderId}`, {}, undefined, data => { const result = order(data); requireValue(result.order_id === orderId || result.text === orderId); return result; });
    },
    async createOrder(payload) { const body = orderPayload(payload); return request('POST', '/crossex/orders', {}, body, data => acknowledgment(data, body.text)); },
    async cancelOrder(orderId) {
      try { id(orderId); } catch { throw inputError(); }
      return request('DELETE', `/crossex/orders/${orderId}`, {}, undefined, data => acknowledgment(data, orderId));
    },
    getHistoryOrders: options => history('/crossex/history_orders', options, order, 'order_id'),
    getTrades: options => history('/crossex/history_trades', options, trade, 'transaction_id'),
    async getFees() { return request('GET', '/crossex/fee', {}, undefined, data => list(data, fee, 'exchange_type', GATE_EXCHANGES.length + 1)); },
    async getLeverages(symbols) {
      const requested = symbolList(symbols); if (!requested.length) return {};
      return request('GET', '/crossex/positions/leverage', { symbols: requested.join(',') }, undefined, data => {
        object(data); const result = {};
        for (const [key, value] of Object.entries(data)) { requireValue(requested.includes(symbol(key))); result[key] = money(value, 'positive'); }
        return result;
      });
    },
    async getRiskLimits(symbols) {
      const requested = symbolList(symbols); if (!requested.length) return [];
      return request('GET', '/crossex/rule/risk_limits', { symbols: requested.join(',') }, undefined, data => list(data, row => {
        const result = riskLimit(row); requireValue(requested.includes(result.symbol)); return result;
      }, 'symbol', requested.length + 1), { authenticated: false });
    },
    async getAccountBook(options = {}) {
      let query;
      try {
        object(options); requireValue(Object.keys(options).every(key => ['coin', 'type', 'from', 'to', 'limit'].includes(key)));
        query = { page: 1, limit: options.limit ?? 100 };
        requireValue(Number.isInteger(query.limit) && query.limit > 0 && query.limit <= 1000);
        if (options.coin !== undefined) { requireValue(typeof options.coin === 'string' && /^[A-Z0-9][A-Z0-9_.-]{0,79}$/.test(options.coin)); query.coin = options.coin; }
        if (options.type !== undefined) query.statement_type = enumValue(options.type, BOOK_TYPES);
        if (options.from !== undefined) query.from = options.from;
        query.to = options.to ?? clock();
        for (const field of ['from', 'to']) if (query[field] !== undefined) requireValue(Number.isSafeInteger(query[field]) && query[field] >= 0);
        requireValue(query.from === undefined || query.from <= query.to);
      } catch { throw inputError(); }
      // A bounded recent ledger page, not a claim of complete account history.
      return request('GET', '/crossex/account_book', query, undefined, data => list(data, row => {
        const result = accountBookRecord(row);
        requireValue((query.coin === undefined || result.coin === query.coin) && (query.statement_type === undefined || result.statement_type === query.statement_type));
        requireValue(Number(result.create_time) <= query.to && (query.from === undefined || Number(result.create_time) >= query.from));
        return result;
      }, 'id', query.limit + 1));
    },
    async getAdlRanks(symbols) {
      const requested = symbolList(symbols, 20), results = [];
      for (const selected of requested) {
        const rows = await request('GET', '/crossex/adl_rank', { symbol: selected }, undefined, data => list(Array.isArray(data) ? data : [data], row => {
          const result = adlRank(row); requireValue(result.symbol === selected); return result;
        }, 'symbol', 2));
        results.push(...rows);
      }
      return results;
    },
    async getAccountDetail() {
      return request('GET', '/account/detail', {}, undefined, data => {
        object(data); const result = {};
        copyFields(data, result, ['user_id'], value => { requireValue(Number.isSafeInteger(value) && value > 0); return value; });
        for (const name of ['ip_whitelist', 'currency_pairs']) if (data[name] !== undefined) {
          requireValue(Array.isArray(data[name]) && data[name].length <= 100);
          result[name] = data[name].map(value => { requireValue(typeof value === 'string' && (name === 'ip_whitelist' ? isIP(value) !== 0 : /^[A-Z0-9_.-]+_[A-Z0-9_.-]+$/.test(value))); return value; });
        }
        if (data.key !== undefined) { if (data.key === null) result.key = null; else { object(data.key); result.key = { mode: enumValue(data.key.mode, [1, 2]) }; } }
        copyFields(data, result, ['tier'], value => { requireValue(Number.isSafeInteger(value) && value >= 0); return value; });
        copyFields(data, result, ['copy_trading_role'], value => enumValue(value, [0, 1, 2, 3]));
        // This endpoint has no permission list. A successful GET does not establish write permission.
        return result;
      });
    },
  });
}
