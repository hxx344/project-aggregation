// Versioned execution seam. This module has no transport, credentials or signing.
// A future asynchronous adapter must deliver the same cumulative order/fill facts;
// its authorization, durable submission and reconciliation belong outside the cost math.
export const EXECUTION_CONTRACT = Object.freeze({
  version: 1, mode: 'paper', liveAvailable: false,
  methods: Object.freeze(['submitOrder', 'cancelOrder', 'queryOrder', 'observeTrade', 'executeTaker']),
  orderIdentity: 'clientOrderId', fillIdentity: 'id',
  capabilities: Object.freeze({ maker: true, partialFills: true, ioc: true, realOrders: false }),
});
const SCALE = 10n ** 18n;
export function units(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) throw new TypeError('invalid_decimal');
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match || String(value).length > 80) throw new TypeError('invalid_decimal');
  const digits = BigInt(match[2] + (match[3] || ''));
  const shift = 18 + Number(match[4] || 0) - (match[3] || '').length;
  if (Math.abs(shift) > 60) throw new TypeError('decimal_precision');
  const magnitude = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return match[1] ? -magnitude : magnitude;
}
export const numberOf = value => Number(value) / 1e18;
export const cashUnits = (quantity, price) => quantity * units(price) / SCALE;
export const feeUnits = (cash, bps) => cash * units(bps) / (10000n * SCALE);
const min = (a, b) => a < b ? a : b;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
export const validCostSequence = value => typeof value === 'string' && value.length > 0 && value.length <= 40 && /^\d+$/.test(value);

export function createCostExecution(options = {}) {
  if (!options || Object.keys(options).some(key => key !== 'mode') || options.mode && options.mode !== 'paper') throw new Error('live_execution_unavailable');
  return new PaperExecutionAdapter();
}

export class PaperExecutionAdapter {
  constructor() { this.orders = new Map(); this.serial = 0; this.capabilities = EXECUTION_CONTRACT; }
  submitOrder(intent) {
    if (!intent || intent.version !== 1 || typeof intent.clientOrderId !== 'string' || !intent.clientOrderId || intent.clientOrderId.length > 180
      || !['binance', 'lighter'].includes(intent.venue) || !['BTC', 'ETH'].includes(intent.symbol)
      || !['buy', 'sell'].includes(intent.side) || !['entry', 'exit'].includes(intent.phase)
      || !positive(intent.quantity) || !positive(intent.limitPrice) || !Number.isFinite(intent.submittedAt)
      || !Number.isFinite(intent.submittedMono) || !Number.isFinite(intent.sourceAfter)
      || (intent.venue === 'binance' ? intent.type !== 'limit_maker' : intent.type !== 'ioc')) throw new TypeError('invalid_order_intent');
    if (this.orders.has(intent.clientOrderId)) throw new Error('duplicate_client_order_id');
    if (this.orders.size >= 1024) throw new Error('paper_order_limit');
    const quantity = units(intent.quantity);
    if (quantity <= 0n) throw new TypeError('invalid_order_quantity');
    const order = { ...structuredClone(intent), quantityUnits: quantity, remaining: quantity, filled: 0n,
      queue: units(intent.queueAhead || 0), status: 'open', lastSequence: null };
    if (order.queue < 0n) throw new TypeError('invalid_queue');
    this.orders.set(intent.clientOrderId, order);
    return this.queryOrder(intent.clientOrderId);
  }
  queryOrder(id) {
    const order = this.orders.get(id);
    if (!order) return null;
    return { clientOrderId: id, status: order.status, filledQuantity: numberOf(order.filled),
      remainingQuantity: numberOf(order.remaining), queueAhead: numberOf(order.queue) };
  }
  cancelOrder(id) {
    const order = this.orders.get(id);
    if (order?.status === 'open') order.status = 'cancelled';
    return this.queryOrder(id);
  }
  forgetOrder(id) { this.orders.delete(id); }
  fill(order, quantity, cash, sourceAt, receivedAt, model) {
    if (quantity <= 0n) return null;
    order.remaining -= quantity; order.filled += quantity;
    if (order.remaining === 0n) order.status = 'filled';
    return { id: `${order.clientOrderId}:fill:${++this.serial}`, clientOrderId: order.clientOrderId,
      venue: order.venue, symbol: order.symbol, side: order.side, phase: order.phase,
      quantity: numberOf(quantity), price: numberOf(cash) / numberOf(quantity), notional: numberOf(cash),
      at: receivedAt, sourceAt, model, quantityUnits: quantity, cashUnits: cash };
  }
  observeTrade(id, trade) {
    const order = this.orders.get(id);
    if (!order || order.status !== 'open' || order.type !== 'limit_maker' || trade.venue !== order.venue || trade.symbol !== order.symbol) return null;
    if (!validCostSequence(trade.sequence)) { order.status = 'invalidated'; return null; }
    if (!positive(trade.quantity) || !positive(trade.price)
      || typeof trade.buyerMaker !== 'boolean') return null;
    if (order.lastSequence !== null && BigInt(trade.sequence) <= BigInt(order.lastSequence)) return null;
    order.lastSequence = trade.sequence;
    if (trade.receivedMono <= order.submittedMono || trade.receivedAt <= order.submittedAt || trade.sourceAt <= order.sourceAfter
      || (order.side === 'buy' ? !trade.buyerMaker || trade.price > order.limitPrice : trade.buyerMaker || trade.price < order.limitPrice)) return null;
    let available = units(trade.quantity);
    const ahead = min(available, order.queue); order.queue -= ahead; available -= ahead;
    const quantity = min(available, order.remaining);
    return this.fill(order, quantity, cashUnits(quantity, order.limitPrice), trade.sourceAt, trade.receivedAt, 'public_trade_queue_proxy');
  }
  executeTaker(id, book) {
    const order = this.orders.get(id);
    if (!order || order.status !== 'open' || order.type !== 'ioc' || book.venue !== order.venue || book.symbol !== order.symbol) return null;
    let quantity = 0n, cash = 0n;
    const consumedDepth = [];
    for (const [index, [price, size]] of book[order.side === 'buy' ? 'asks' : 'bids'].entries()) {
      if (order.side === 'buy' ? price > order.limitPrice : price < order.limitPrice) break;
      const step = units(order.quantityStep || '0.000000000000000001');
      const take = min(order.remaining - quantity, units(size)) / step * step;
      quantity += take; cash += cashUnits(take, price);
      if (take) consumedDepth.push({ index, quantity: numberOf(take) });
      if (quantity === order.remaining) break;
    }
    const fill = this.fill(order, quantity, cash, book.sourceAt, book.receivedAt, 'delayed_visible_depth_ioc');
    if (order.status === 'open') order.status = 'cancelled'; // Unfilled IOC quantity never reappears later.
    return { fill, remainingQuantity: numberOf(order.remaining), consumedDepth };
  }
}
