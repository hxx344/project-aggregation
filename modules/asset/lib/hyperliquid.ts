import type { Balance } from './types';
import { mapConcurrent } from './concurrency.ts';

export type HyperliquidCredential = { walletAddress: string };
type Json = Record<string, unknown>;
type Fetcher = typeof fetch;
type StaticMeta = { at: number; dexes: string[]; collateral: Map<string, number> };
type SpotMarket = { names: Map<number, string>; prices: Map<number, number> };

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd&include_last_updated_at=true';
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const TIMEOUT_MS = 12_000;
// One sync must finish well inside the page's 60-second request timeout, including the role check on connect.
const SYNC_BUDGET_MS = 40_000;
const DEX_CONCURRENCY = 4;
const MAX_BYTES = 4 * 1024 * 1024;
const QUOTE_MAX_BYTES = 128 * 1024;
// The DEX list and each DEX's collateral token change only when Hyperliquid deploys a DEX.
// Entries expire after this TTL; a DEX that is not yet cached is always read on demand.
const STATIC_TTL_MS = 10 * 60_000;
const VALUE_MAX_AGE_MS = 5 * 60_000, FUTURE_TOLERANCE_MS = 60_000, QUOTE_MAX_AGE_MS = 900_000;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
// Unified account and portfolio margin keep all balances in the spot clearinghouse; their
// per-DEX perp states repeat that collateral and must not be listed as separate equity.
// DEX abstraction moves collateral into each HIP-3 DEX, so those balances stay separate.
const SHARED_BALANCE_MODES = new Set(['unifiedAccount', 'portfolioMargin']);
const SEPARATE_BALANCE_MODES = new Set(['default', 'disabled', 'dexAbstraction']);
const DEX_LABELS: Record<string, string> = { '': '主站', io: 'io（Entropy）', xyz: 'xyz（trade.xyz）' };
const VAULT_LABELS: Record<string, string> = { '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303': 'HLP' };
export const NOTE_COIN = '—';

export const HYPERLIQUID_ERRORS = {
  address: 'Hyperliquid 地址无效：请填写 0x 开头、40 位十六进制的主账户地址',
  agent: 'Hyperliquid 地址是 API 钱包（agent）地址：请改填它所属的主账户地址',
  missing: 'Hyperliquid 未找到该地址的账户：请确认填写的是有资金记录的主账户或子账户地址',
  network: 'Hyperliquid 读取失败：网络请求未完成或超时，请稍后重试；已保留上次数据',
  rateLimited: 'Hyperliquid 读取受到限流（HTTP 429）：请稍后重试并减少手动刷新；已保留上次数据',
  invalid: 'Hyperliquid 返回的账户数据不完整或格式不符；已保留上次数据',
  stale: 'Hyperliquid 账户总值的时间已过期或异常；已保留上次数据',
  quote: 'Hyperliquid USDC/USD 汇率读取失败或已过期；已保留上次数据',
} as const;
const SAFE_ERRORS = new Set<string>(Object.values(HYPERLIQUID_ERRORS));
const httpError = (status: number) => `Hyperliquid 读取失败（HTTP ${status}）：接口暂时不可用，请稍后重试；已保留上次数据`;

const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };

function decimal(value: unknown, message: string = HYPERLIQUID_ERRORS.invalid): number {
  if (typeof value !== 'string' || value.length > 64 || !DECIMAL.test(value)) fail(message);
  const result = Number(value);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(value as string))) fail(message);
  return result === 0 ? 0 : result;
}
function optionalDecimal(value: unknown): number | null {
  try { return decimal(value); } catch { return null; }
}
function usd(quantity: number, price: number): number {
  const value = quantity * price;
  if (!Number.isFinite(value) || (value === 0 && quantity !== 0 && price !== 0)) fail(HYPERLIQUID_ERRORS.invalid);
  return value === 0 ? 0 : value;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) fail(HYPERLIQUID_ERRORS.address);
  return (value as string).trim().toLowerCase();
}
const coinName = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9+@._:-]{1,24}$/.test(value) ? value : '未知代币';
function dexLabel(dex: string, index: number) {
  if (Object.hasOwn(DEX_LABELS, dex)) return DEX_LABELS[dex];
  return /^[a-z0-9]{1,16}$/i.test(dex) ? dex : `其他 DEX ${index}`;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if ((length && /^\d+$/.test(length) && Number(length) > limit) || !response.body) {
    void response.body?.cancel().catch(() => {});
    fail(HYPERLIQUID_ERRORS.invalid);
  }
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); fail(HYPERLIQUID_ERRORS.invalid); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return fail(HYPERLIQUID_ERRORS.invalid); }
}

/** Public, unauthenticated reads from the fixed official info endpoint; no request carries a key or signature. */
async function info(body: Json, fetcher: Fetcher, deadline: AbortSignal): Promise<unknown> {
  try {
    const response = await fetcher(INFO_URL, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), deadline]),
    });
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new Error(response.status === 429 ? HYPERLIQUID_ERRORS.rateLimited : httpError(response.status));
    }
    return await boundedJson(response, MAX_BYTES);
  } catch (error) {
    // Only messages built here may reach the page; transport and body text never do.
    if (error instanceof Error && (SAFE_ERRORS.has(error.message) || /^Hyperliquid 读取失败（HTTP \d{3}）/.test(error.message))) throw error;
    throw new Error(HYPERLIQUID_ERRORS.network);
  }
}
type Read = (body: Json) => Promise<unknown>;
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
// Reads start together; settling each one keeps a later failure from going unhandled while an earlier result is checked.
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> => promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const unwrap = <T>(result: Settled<T>): T => { if (!result.ok) throw result.error; return result.value; };

async function verifyRole(user: string, read: Read) {
  const data = await read({ type: 'userRole', user });
  const role = object(data) ? data.role : undefined;
  if (role === 'agent') fail(HYPERLIQUID_ERRORS.agent);
  if (role === 'missing') fail(HYPERLIQUID_ERRORS.missing);
  if (role !== 'user' && role !== 'subAccount' && role !== 'vault') fail(HYPERLIQUID_ERRORS.invalid);
}

/** Hyperliquid's own account value: the latest point of the `day` portfolio series. */
function accountValue(data: unknown, fetchedAt: number): { quantity: number; at: number } {
  const day = Array.isArray(data) ? data.find(entry => Array.isArray(entry) && entry[0] === 'day') : undefined;
  const history = Array.isArray(day) && object(day[1]) ? day[1].accountValueHistory : undefined;
  const last = Array.isArray(history) && history.length ? history[history.length - 1] : undefined;
  if (!Array.isArray(last) || last.length !== 2) fail(HYPERLIQUID_ERRORS.invalid);
  const at = (last as unknown[])[0];
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) fail(HYPERLIQUID_ERRORS.invalid);
  if (fetchedAt - (at as number) > VALUE_MAX_AGE_MS || (at as number) - fetchedAt > FUTURE_TOLERANCE_MS) fail(HYPERLIQUID_ERRORS.stale);
  return { quantity: decimal((last as unknown[])[1]), at: at as number };
}

function spotBalances(data: unknown) {
  if (!object(data) || !Array.isArray(data.balances) || data.balances.length > 2000) fail(HYPERLIQUID_ERRORS.invalid);
  return ((data as Json).balances as unknown[]).map(item => {
    if (!object(item)) return fail(HYPERLIQUID_ERRORS.invalid);
    const token = typeof item.token === 'number' && Number.isSafeInteger(item.token) && item.token >= 0 ? item.token : null;
    return { token, coin: coinName(item.coin), quantity: decimal(item.total) };
  }).filter(row => row.quantity !== 0);
}
function vaultEquities(data: unknown) {
  if (!Array.isArray(data) || data.length > 500) fail(HYPERLIQUID_ERRORS.invalid);
  return (data as unknown[]).map(item => {
    if (!object(item) || typeof item.vaultAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(item.vaultAddress)) return fail(HYPERLIQUID_ERRORS.invalid);
    const vault = item.vaultAddress.toLowerCase();
    return { label: VAULT_LABELS[vault] ?? `${vault.slice(0, 6)}…${vault.slice(-4)}`, equity: decimal(item.equity) };
  }).filter(row => row.equity !== 0);
}
/** Staked HYPE in every state the account value counts: delegated, undelegated and pending withdrawal. */
function stakedHype(data: unknown): number {
  if (!object(data)) fail(HYPERLIQUID_ERRORS.invalid);
  const summary = data as Json;
  return decimal(summary.delegated) + decimal(summary.undelegated) + decimal(summary.totalPendingWithdrawal);
}

const metaCache = new WeakMap<Fetcher, StaticMeta>();
// Spot token indexes never change name, so names stay known even when a later market read fails.
const tokenNames = new WeakMap<Fetcher, Map<number, string>>();
async function perpDexes(fetcher: Fetcher, read: Read, now: number): Promise<StaticMeta> {
  const cached = metaCache.get(fetcher);
  if (cached && now - cached.at >= 0 && now - cached.at < STATIC_TTL_MS) return cached;
  const data = await read({ type: 'perpDexs' });
  if (!Array.isArray(data) || data.length === 0 || data.length > 200 || data[0] !== null) fail(HYPERLIQUID_ERRORS.invalid);
  const dexes = [''];
  for (const item of (data as unknown[]).slice(1)) {
    if (!object(item) || typeof item.name !== 'string' || !item.name || item.name.length > 64) fail(HYPERLIQUID_ERRORS.invalid);
    dexes.push((item as Json).name as string);
  }
  if (new Set(dexes).size !== dexes.length) fail(HYPERLIQUID_ERRORS.invalid);
  const meta = { at: now, dexes, collateral: new Map<string, number>() };
  metaCache.set(fetcher, meta);
  return meta;
}
async function collateralOf(meta: StaticMeta, dex: string, read: Read): Promise<number> {
  const cached = meta.collateral.get(dex);
  if (cached !== undefined) return cached;
  const data = await read({ type: 'meta', dex });
  const token = object(data) ? data.collateralToken : undefined;
  if (typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0) fail(HYPERLIQUID_ERRORS.invalid);
  meta.collateral.set(dex, token as number);
  return token as number;
}

/** Per-DEX perp equity for modes whose DEX balances are separate; accountValue already includes unrealized P&L. */
async function perpEquity(user: string, meta: StaticMeta, read: Read) {
  const states = await mapConcurrent(meta.dexes, DEX_CONCURRENCY, dex => read({ type: 'clearinghouseState', user, dex }));
  const active = states.map((state, index) => {
    if (!object(state) || !object(state.marginSummary) || !Array.isArray(state.assetPositions)) return fail(HYPERLIQUID_ERRORS.invalid);
    return { dex: meta.dexes[index], index, value: decimal(state.marginSummary.accountValue), positions: state.assetPositions.length };
  }).filter(row => row.value !== 0 || row.positions > 0);
  return mapConcurrent(active, DEX_CONCURRENCY, async row => ({ ...row, collateral: await collateralOf(meta, row.dex, read) }));
}

/** Spot mid prices in USDC, used only to show detail rows; the account total never depends on them. */
async function spotMarket(read: Read, known: Map<number, string>): Promise<SpotMarket> {
  const data = await read({ type: 'spotMetaAndAssetCtxs' });
  if (!Array.isArray(data) || data.length !== 2 || !object(data[0]) || !Array.isArray(data[0].tokens) || !Array.isArray(data[0].universe) || !Array.isArray(data[1])) fail(HYPERLIQUID_ERRORS.invalid);
  const [meta, contexts] = data as [Json, unknown[]];
  const names = new Map<number, string>();
  for (const token of meta.tokens as unknown[]) if (object(token) && typeof token.index === 'number' && Number.isSafeInteger(token.index)) names.set(token.index, coinName(token.name));
  for (const [index, name] of names) known.set(index, name);
  // Contexts are keyed by pair name; their order does not follow the universe.
  const byPair = new Map<string, Json>();
  for (const context of contexts) if (object(context) && typeof context.coin === 'string') byPair.set(context.coin, context);
  const best = new Map<number, { price: number; canonical: boolean; volume: number }>();
  for (const pair of meta.universe as unknown[]) {
    if (!object(pair) || typeof pair.name !== 'string' || !Array.isArray(pair.tokens) || pair.tokens.length !== 2 || pair.tokens[1] !== 0) continue;
    const token = pair.tokens[0], context = byPair.get(pair.name);
    if (typeof token !== 'number' || !Number.isSafeInteger(token) || !context) continue;
    const price = optionalDecimal(context.midPx) ?? optionalDecimal(context.markPx);
    if (price === null || price <= 0) continue;
    const canonical = pair.isCanonical === true, volume = optionalDecimal(context.dayNtlVlm) ?? 0, previous = best.get(token);
    if (!previous || (canonical && !previous.canonical) || (canonical === previous.canonical && volume > previous.volume)) best.set(token, { price, canonical, volume });
  }
  return { names, prices: new Map([...best].map(([token, entry]) => [token, entry.price])) };
}

async function quoteJson(url: string, fetcher: Fetcher, deadline: AbortSignal): Promise<Json> {
  // Public pricing requests are separate and never carry the account address.
  const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), deadline]) });
  if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); fail(HYPERLIQUID_ERRORS.quote); }
  const data = await boundedJson(response, QUOTE_MAX_BYTES);
  return object(data) ? data : fail(HYPERLIQUID_ERRORS.quote);
}
async function usdcQuote(fetcher: Fetcher, deadline: AbortSignal): Promise<{ price: number; at: number }> {
  try {
    const coin = (await quoteJson(COINGECKO, fetcher, deadline))['usd-coin'];
    if (!object(coin) || typeof coin.usd !== 'number' || !Number.isFinite(coin.usd) || coin.usd <= 0 || typeof coin.last_updated_at !== 'number') fail(HYPERLIQUID_ERRORS.quote);
    const at = (coin as Json).last_updated_at as number * 1000;
    if (!Number.isSafeInteger(at) || at <= 0 || Date.now() - at > QUOTE_MAX_AGE_MS || at - Date.now() > FUTURE_TOLERANCE_MS) fail(HYPERLIQUID_ERRORS.quote);
    return { price: (coin as Json).usd as number, at };
  } catch {
    try {
      const data = await quoteJson(COINBASE, fetcher, deadline);
      if (!object(data.data) || data.data.currency !== 'USDC' || !object(data.data.rates)) fail(HYPERLIQUID_ERRORS.quote);
      const price = decimal(((data.data as Json).rates as Json).USD, HYPERLIQUID_ERRORS.quote);
      if (price <= 0) fail(HYPERLIQUID_ERRORS.quote);
      // Coinbase publishes no rate timestamp here; keep the retrieval time.
      return { price, at: Date.now() };
    } catch { return fail(HYPERLIQUID_ERRORS.quote); }
  }
}

/**
 * The total is Hyperliquid's account value (spot, every perp DEX, vault equity and staked HYPE) converted once.
 * Only the portfolio value and the USDC quote decide whether a sync succeeds; detail reads that fail leave a note row instead.
 */
export async function syncHyperliquid(c: HyperliquidCredential, fetcher: Fetcher = fetch, options: { verifyRole?: boolean; budgetMs?: number } = {}): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  const user = address(c?.walletAddress);
  // Aborting on exit stops reads that no longer matter once the outcome is decided, sparing the shared rate limit.
  const done = new AbortController();
  const deadline = AbortSignal.any([done.signal, AbortSignal.timeout(options.budgetMs ?? SYNC_BUDGET_MS)]);
  try { return await collect(user, fetcher, deadline, !!options.verifyRole); } finally { done.abort(); }
}
async function collect(user: string, fetcher: Fetcher, deadline: AbortSignal, checkRole: boolean): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  const read: Read = body => info(body, fetcher, deadline);
  const startedAt = Date.now();
  const role = checkRole ? settle(verifyRole(user, read)) : null;
  const portfolio = settle(read({ type: 'portfolio', user })), quoteRead = settle(usdcQuote(fetcher, deadline));
  const modeRead = settle(read({ type: 'userAbstraction', user }));
  const spotRead = settle(read({ type: 'spotClearinghouseState', user }).then(spotBalances));
  const vaultRead = settle(read({ type: 'userVaultEquities', user }).then(vaultEquities));
  const stakeRead = settle(read({ type: 'delegatorSummary', user }).then(stakedHype));
  const dexRead = settle(perpDexes(fetcher, read, startedAt));
  // userRole is a heavier request, so it runs when a connection is saved rather than on every refresh.
  if (role) unwrap(await role);
  const portfolioData = unwrap(await portfolio);
  const fetchedAt = Date.now();
  const value = accountValue(portfolioData, fetchedAt);
  const quote = unwrap(await quoteRead);

  const [mode, spot, vaults, staked, dexes] = await Promise.all([modeRead, spotRead, vaultRead, stakeRead, dexRead]);
  const modeName = mode.ok && typeof mode.value === 'string' ? mode.value : null;
  const shared = modeName !== null && SHARED_BALANCE_MODES.has(modeName);
  const separate = modeName !== null && SEPARATE_BALANCE_MODES.has(modeName);
  const perpRead = separate && dexes.ok ? await settle(perpEquity(user, dexes.value, read)) : null;
  const perps = perpRead?.ok ? perpRead.value : [];
  const balances = spot.ok ? spot.value : [];
  const stake = staked.ok ? staked.value : 0;
  const needsMarket = balances.some(row => row.token !== 0) || perps.some(row => row.collateral !== 0) || stake !== 0;
  const known = tokenNames.get(fetcher) ?? new Map<number, string>();
  tokenNames.set(fetcher, known);
  const marketRead = needsMarket ? await settle(spotMarket(read, known)) : null;
  const market = marketRead?.ok ? marketRead.value : null;
  const hypeToken = market ? [...market.names].find(([, name]) => name === 'HYPE')?.[0] ?? null : null;
  const tokenName = (token: number) => known.get(token) ?? `代币 #${token}`;

  const priced = (token: number | null) => token === 0 ? quote.price : token === null ? null : market?.prices.has(token) ? usd(market.prices.get(token)!, quote.price) : null;
  // An unpriced row keeps its account and coin so it stays the same line once a quote appears; price 0 marks it as unvalued.
  const row = (coin: string, account: string, quantity: number, token: number | null): Balance => {
    const price = priced(token);
    return price === null ? { coin, account, quantity, price: 0, value: 0 } : { coin, account, quantity, price, value: usd(quantity, price) };
  };
  const note = (account: string): Balance => ({ coin: NOTE_COIN, account, quantity: 0, price: 0, value: 0 });
  const spotAccount = modeName === 'portfolioMargin' ? '组合保证金账户余额' : shared ? '统一账户余额（现货与永续共用）' : '现货余额';
  const details: Balance[] = [
    ...perps.map(perp => row(perp.collateral === 0 ? 'USDC' : tokenName(perp.collateral), `永续 · ${dexLabel(perp.dex, perp.index)} · 账户权益（含未实现盈亏）`, perp.value, perp.collateral)),
    ...balances.map(balance => row(balance.coin, spotAccount, balance.quantity, balance.token)),
    ...(vaults.ok ? vaults.value.map(vault => row('USDC', `金库 · ${vault.label}`, vault.equity, 0)) : []),
    ...(stake !== 0 ? [row('HYPE', '质押（含未委托与待提取）', stake, hypeToken)] : []),
    ...(modeName === null || (!shared && !separate) ? [note('账户模式未识别，未列出永续明细；总额不受影响')] : []),
    ...((separate && !perpRead?.ok) || !spot.ok || !vaults.ok || !staked.ok ? [note('部分明细读取失败；总额不受影响')] : []),
    ...(marketRead && !marketRead.ok ? [note('现货报价读取失败，非 USDC 代币未估值；总额不受影响')] : []),
  ];
  return { total: usd(value.quantity, quote.price), details, updatedAt: new Date(Math.min(fetchedAt, value.at, quote.at)).toISOString() };
}
