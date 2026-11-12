// Quote placement for resting liquidity rewards. Pure functions over exact
// fixed-point units (value × 10^18, see trading-decimal.mjs): prices, sizes,
// USD amounts and basis points are all BigInt units. Book levels are
// [price, size]; bids descend, asks ascend.
const SCALE = 10n ** 18n, BPS = 10_000n;
const FIXUP = 64;

export const floorStep = (value, step) => value - value % step;
export const ceilStep = (value, step) => (value % step ? value - value % step + step : value);
export const notional = (price, size) => price * size / SCALE;

// The book without the given resting orders of this account.
export function withoutOrders(book, orders) {
  if (!orders.length) return book;
  const strip = (levels, side) => {
    const own = new Map();
    for (const order of orders) if (order.side === side) own.set(order.price, (own.get(order.price) ?? 0n) + order.remaining);
    if (!own.size) return levels;
    const rest = [];
    for (const [price, size] of levels) { const left = size - (own.get(price) ?? 0n); if (left > 0n) rest.push([price, left]); }
    return rest;
  };
  return { ...book, bids: strip(book.bids, 'buy'), asks: strip(book.asks, 'sell') };
}

// Distances are measured from the mid the book has once the quote rests at
// its price: a quote inside the spread moves the mid it is scored against.
function band(side, ref, tick) {
  const bid = ref.bids[0]?.[0], ask = ref.asks[0]?.[0];
  if (bid === undefined || ask === undefined || bid >= ask || tick <= 0n) return null;
  const buy = side === 'buy', toward = buy ? tick : -tick;
  const mid2 = price => (buy ? (price > bid ? price : bid) + ask : bid + (price < ask ? price : ask));
  const gap = price => { const mid = mid2(price); return [buy ? mid - 2n * price : 2n * price - mid, mid]; };
  const far = (price, bps) => { const [distance, mid] = gap(price); return distance * BPS * SCALE >= bps * mid; };
  const near = (price, bps) => { const [distance, mid] = gap(price); return distance >= 0n && distance * BPS * SCALE <= bps * mid; };
  const resting = price => price > 0n && (buy ? price < ask : price > bid);
  const round = (value, inward) => (buy === inward ? floorStep(value, tick) : ceilStep(value, tick));
  // Closed forms for a quote outside the spread and one that becomes the best price.
  function start(bps, inward) {
    const outside = round((bid + ask) * (BPS * SCALE + (buy ? -bps : bps)) / (2n * BPS * SCALE), inward);
    if (buy ? outside <= bid : outside >= ask) return outside;
    const inside = buy ? round(ask * (BPS * SCALE - bps) / (BPS * SCALE + bps), inward) : round(bid * (BPS * SCALE + bps) / (BPS * SCALE - bps), inward);
    return buy ? (inside < bid ? floorStep(bid, tick) : inside) : (inside > ask ? ceilStep(ask, tick) : inside);
  }
  // The price nearest the mid that is at least bps away and still rests.
  function closest(bps) {
    let price = start(bps, true);
    for (let i = 0; i < FIXUP && (!resting(price) || !far(price, bps)); i++) price -= toward;
    if (!resting(price) || !far(price, bps)) return null;
    for (let i = 0; i < FIXUP && resting(price + toward) && far(price + toward, bps); i++) price += toward;
    return price;
  }
  // The price farthest from the mid that is at most bps away.
  function farthest(bps) {
    let price = start(bps, false);
    for (let i = 0; i < FIXUP && price > 0n && !near(price, bps) && resting(price + toward); i++) price += toward;
    if (!resting(price) || !near(price, bps)) return null;
    for (let i = 0; i < FIXUP && resting(price - toward) && near(price - toward, bps); i++) price -= toward;
    return price;
  }
  const bps = price => { const [distance, mid] = gap(price); return Number(distance * BPS * 1000n / mid) / 1000; };
  return { buy, bid, ask, toward, far, near, resting, closest, farthest, bps };
}

// External size resting at prices better than `price` on its own side: what
// a taker has to trade through before reaching the quote.
function protectionOf(buy, ext, price) {
  let total = 0n;
  for (const [level, size] of buy ? ext.bids : ext.asks) {
    if (buy ? level <= price : level >= price) break;
    total += notional(level, size);
  }
  return total;
}

// ref: the book without this quote's own order. ext: the book without any
// order of this account. limit: the nearest own order on the opposite side,
// which the quote must not reach. Returns { price, mode, protection, bps } or
// { price: null, reason }.
export function planQuote(side, ref, ext, tick, config, limit) {
  const range = band(side, ref, tick);
  if (!range) return { price: null, reason: 'no_book' };
  const { buy, toward } = range;
  let target = range.closest(config.target);
  const outer = range.farthest(config.max);
  if (target === null) return { price: null, reason: 'no_price' };
  if (outer === null) return { price: null, reason: 'no_tick_in_band' };
  // No tick between target and max: the tick just inside the target is used while it keeps the minimum distance.
  if (buy ? target < outer : target > outer) {
    if (!range.far(outer, config.min)) return { price: null, reason: 'no_tick_in_band' };
    target = outer;
  }
  if (limit !== undefined && (buy ? target >= limit : target <= limit)) {
    target = buy ? floorStep(limit - 1n, tick) : ceilStep(limit + 1n, tick);
    if (buy ? target < outer : target > outer) return { price: null, reason: 'own_order_in_way' };
  }
  const result = (price, mode) => ({ price, mode, protection: protectionOf(buy, ext, price), bps: range.bps(price) });
  if (!config.wallEnabled) return result(target, 'fixed');
  if (protectionOf(buy, ext, target) >= config.wallMin) return result(target, 'wall');
  // One tick behind a level, walking away from the mid, until enough rests in front.
  for (const [level] of buy ? ext.bids : ext.asks) {
    const price = level - toward;
    if (buy ? price >= target : price <= target) continue;
    if (buy ? price < outer : price > outer) break;
    if (protectionOf(buy, ext, price) >= config.wallMin) return result(price, 'wall');
  }
  return result(target, 'fixed');
}

// Whether a resting quote may stay. `urgent` replacements skip the dwell time.
export function assessQuote(side, price, ref, ext, tick, config, limit) {
  const range = band(side, ref, tick);
  if (!range) return { keep: false, reason: 'no_book', urgent: true };
  const { buy } = range;
  if (!range.resting(price) || !range.far(price, config.min)) return { keep: false, reason: 'too_close', urgent: true };
  if (limit !== undefined && (buy ? price >= limit : price <= limit)) return { keep: false, reason: 'own_order_in_way', urgent: true };
  if (!range.near(price, config.max)) return { keep: false, reason: 'too_far', urgent: false };
  if (config.wallEnabled && protectionOf(buy, ext, price) * 2n < config.wallMin) {
    const plan = planQuote(side, ref, ext, tick, config, limit);
    if (plan.price !== null && plan.mode === 'wall' && plan.price !== price) return { keep: false, reason: 'unprotected', urgent: false };
  }
  return { keep: true, bps: range.bps(price), protection: protectionOf(buy, ext, price) };
}

// A reduce-only close joins the best external price on its side and never crosses.
export function closePrice(side, ext, tick) {
  const bid = ext.bids[0]?.[0], ask = ext.asks[0]?.[0];
  if (side === 'sell') {
    if (ask === undefined && bid === undefined) return null;
    return ask !== undefined && (bid === undefined || ask > bid) ? ask : bid + tick;
  }
  if (ask === undefined && bid === undefined) return null;
  const price = bid !== undefined && (ask === undefined || bid < ask) ? bid : ask - tick;
  return price > 0n ? price : null;
}

// A close follows the market only toward the touch; being the best price is kept.
export function closeMoves(side, price, desired) {
  return side === 'sell' ? desired < price : desired > price;
}

export const quoteSize = (usd, price, step) => floorStep(usd * SCALE / price, step);
