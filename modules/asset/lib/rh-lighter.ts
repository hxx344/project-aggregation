import type { Balance } from './types';
import type { Position } from './positions-types.ts';
import { positionId } from './positions-values.ts';

export type RhLighterCredential = { walletAddress: string };
type Json = Record<string, unknown>;
type Fetcher = typeof fetch;
type Asset = { symbol: string; balance: number; locked: number };
type Account = { index: number; name: string | null; value: number; assets: Asset[]; positions: Position[]; pooled: boolean; binary: boolean };
/** `at` is when the read started, so a reused snapshot is never presented as newer than its request. */
export type RhLighterSnapshot = { address: string; at: number; accounts: Account[] };
type Slot = { value?: RhLighterSnapshot; pending?: Promise<RhLighterSnapshot> };
type State = { until: number; slots: Map<string, Slot> };

// Lighter on Robinhood Chain is a separate exchange from Lighter mainnet; accounts and balances do not carry over.
const ACCOUNT_URL = 'https://api.rh.lighter.xyz/api/v1/account';
// Two pages at most, each bounded by this timeout, so a read finishes inside the 25-second positions deadline.
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 2;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNTS = 200, MAX_ROWS = 2000, MAX_SLOTS = 32;
// Standard accounts get 60 REST requests per rolling minute, counted per IP and per L1 address, and the monitor and
// trading modules call the same host from this machine. Asset refreshes and the positions view share one account
// read per address for this long; a failed read is never cached.
export const RH_LIGHTER_SNAPSHOT_TTL_MS = 30_000;
// HTTP 429/405 or code 23000 means the firewall blocked this IP for a static 60 seconds; no read is sent until it ends.
export const RH_LIGHTER_COOLDOWN_MS = 60_000;
const RATE_LIMIT_CODE = 23000;
const ACCOUNT_NOT_FOUND_CODE = 21100;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const SYMBOL = /^[\p{L}\p{N}_.:/-]{1,32}$/u;
// Collateral is USDG, a USD stablecoin; balances are taken 1:1 as USD without a separate quote.
const COLLATERAL = 'USDG';
export const NOTE_COIN = '—';

export const RH_LIGHTER_ERRORS = {
  address: 'Lighter RH 地址无效：请填写 0x 开头、40 位十六进制的 L1 钱包地址',
  missing: 'Lighter RH 未找到该地址的账户：请确认填写的是在 Lighter on Robinhood Chain 注册过的 L1 钱包地址',
  network: 'Lighter RH 读取失败：网络请求未完成或超时，请稍后重试；已保留上次数据',
  rateLimited: 'Lighter RH 读取受到限流：60 秒内不再请求，请减少手动刷新；已保留上次数据',
  invalid: 'Lighter RH 返回的账户数据不完整或格式不符；已保留上次数据',
  incomplete: 'Lighter RH 该地址的账户列表未能完整读取；已保留上次数据',
} as const;
const SAFE_ERRORS = new Set<string>(Object.values(RH_LIGHTER_ERRORS));
const HTTP_ERROR = /^Lighter RH 读取失败（HTTP \d{3}）/;
const httpError = (status: number) => `Lighter RH 读取失败（HTTP ${status}）：接口暂时不可用，请稍后重试；已保留上次数据`;

const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) fail(RH_LIGHTER_ERRORS.address);
  return (value as string).trim().toLowerCase();
}
// The API omits fields whose value is zero or empty, so an absent amount means zero; any other malformed value is refused.
function decimalText(value: unknown): string {
  if (value === undefined) return '0';
  if (typeof value !== 'string' || value.length > 64 || !DECIMAL.test(value)) fail(RH_LIGHTER_ERRORS.invalid);
  return value as string;
}
function amount(value: unknown): number {
  const text = decimalText(value), result = Number(text);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(text))) fail(RH_LIGHTER_ERRORS.invalid);
  return result === 0 ? 0 : result;
}
const isZero = (value: string) => !/[1-9]/.test(value);
const symbolOf = (value: unknown) => typeof value === 'string' && SYMBOL.test(value) ? value : fail(RH_LIGHTER_ERRORS.invalid);
function rows(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) fail(RH_LIGHTER_ERRORS.invalid);
  return value as unknown[];
}

function parsePosition(row: unknown, account: number, at: string): Position | null {
  if (!object(row)) return fail(RH_LIGHTER_ERRORS.invalid);
  const quantity = decimalText(row.position);
  if (isZero(quantity)) return null;
  if (quantity.startsWith('-') || !integer(row.market_id)) fail(RH_LIGHTER_ERRORS.invalid);
  const side = row.sign === 1 ? 'long' as const : row.sign === -1 ? 'short' as const : fail(RH_LIGHTER_ERRORS.invalid);
  const symbol = symbolOf(row.symbol);
  const marginMode = row.margin_mode === undefined || row.margin_mode === 0 ? 'cross' : row.margin_mode === 1 ? 'isolated' : fail(RH_LIGHTER_ERRORS.invalid);
  // initial_margin_fraction is a percentage, so the configured leverage is its reciprocal.
  const fraction = amount(row.initial_margin_fraction);
  if (fraction < 0) fail(RH_LIGHTER_ERRORS.invalid);
  const liquidation = decimalText(row.liquidation_price);
  return {
    id: positionId('rh-lighter', String(account), String(row.market_id), side), symbol, instrumentId: symbol, side, positionSide: 'net',
    quantity, quantityUnit: symbol, contractSize: '1',
    entryPrice: row.avg_entry_price === undefined ? null : decimalText(row.avg_entry_price), markPrice: null,
    notional: decimalText(row.position_value).replace(/^-/, ''), unrealizedPnl: decimalText(row.unrealized_pnl),
    leverage: fraction > 0 ? String(Number((100 / fraction).toFixed(4))) : null,
    // Lighter reports 0 when the position has no liquidation price.
    liquidationPrice: isZero(liquidation) ? null : liquidation,
    priceCurrency: COLLATERAL, notionalCurrency: COLLATERAL, pnlCurrency: COLLATERAL, marginMode, sourceUpdatedAt: at,
  };
}

function parseAccount(item: unknown, user: string, at: string): Account {
  if (!object(item)) return fail(RH_LIGHTER_ERRORS.invalid);
  const index = item.index ?? item.account_index;
  if (!integer(index) || (item.account_index !== undefined && item.account_index !== index)) fail(RH_LIGHTER_ERRORS.invalid);
  if (typeof item.l1_address !== 'string' || item.l1_address.toLowerCase() !== user) fail(RH_LIGHTER_ERRORS.invalid);
  const assets = rows(item.assets).map(asset => {
    if (!object(asset)) return fail(RH_LIGHTER_ERRORS.invalid);
    const symbol = typeof asset.symbol === 'string' && SYMBOL.test(asset.symbol) ? asset.symbol : integer(asset.asset_id) ? `资产 #${asset.asset_id}` : fail(RH_LIGHTER_ERRORS.invalid);
    return { symbol, balance: amount(asset.balance), locked: amount(asset.locked_balance) };
  });
  const positions = rows(item.positions).map(row => parsePosition(row, index as number, at)).filter(row => row !== null);
  const name = typeof item.name === 'string' && /^[\p{L}\p{N} _.-]{1,32}$/u.test(item.name.trim()) ? item.name.trim() : null;
  return { index: index as number, name, value: amount(item.total_asset_value), assets, positions,
    pooled: rows(item.shares).length > 0, binary: rows(item.bo_positions).length > 0 };
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if ((length && /^\d+$/.test(length) && Number(length) > MAX_BYTES) || !response.body) {
    void response.body?.cancel().catch(() => {});
    fail(RH_LIGHTER_ERRORS.invalid);
  }
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); fail(RH_LIGHTER_ERRORS.invalid); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return fail(RH_LIGHTER_ERRORS.invalid); }
}

/** One public, unauthenticated GET with no retry; only messages built here may reach the page. */
async function request(url: string, fetcher: Fetcher, state: State): Promise<unknown> {
  const limited = () => { state.until = Math.max(state.until, Date.now() + RH_LIGHTER_COOLDOWN_MS); return fail(RH_LIGHTER_ERRORS.rateLimited); };
  try {
    const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 429 || response.status === 405) { void response.body?.cancel().catch(() => {}); return limited(); }
    if (response.redirected || (!response.ok && response.status !== 400)) { void response.body?.cancel().catch(() => {}); return fail(httpError(response.status)); }
    const data = await boundedJson(response).catch(error => {
      if (response.status === 400 && error instanceof Error && error.message === RH_LIGHTER_ERRORS.invalid) fail(httpError(400));
      throw error;
    });
    if (object(data) && data.code === RATE_LIMIT_CODE) return limited();
    if (response.status === 400) return fail(object(data) && data.code === ACCOUNT_NOT_FOUND_CODE ? RH_LIGHTER_ERRORS.missing : httpError(400));
    return data;
  } catch (error) {
    if (error instanceof Error && (SAFE_ERRORS.has(error.message) || HTTP_ERROR.test(error.message))) throw error;
    throw new Error(RH_LIGHTER_ERRORS.network);
  }
}

async function load(user: string, fetcher: Fetcher, state: State): Promise<RhLighterSnapshot> {
  const startedAt = Date.now(), at = new Date(startedAt).toISOString();
  const accounts: Account[] = [], seen = new Set<number>();
  let cursor = '', total = -1;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) fail(RH_LIGHTER_ERRORS.incomplete);
    // active_only drops markets the account traded before but holds no position in.
    const params = new URLSearchParams({ by: 'l1_address', value: user, active_only: 'true' });
    if (cursor) params.set('cursor', cursor);
    const data = await request(ACCOUNT_URL + '?' + params, fetcher, state);
    if (!object(data) || data.code !== 200 || !integer(data.total) || !Array.isArray(data.accounts) || data.accounts.length > MAX_ACCOUNTS) fail(RH_LIGHTER_ERRORS.invalid);
    const body = data as Json;
    if (page === 0) total = body.total as number;
    for (const item of body.accounts as unknown[]) {
      const account = parseAccount(item, user, at);
      if (seen.has(account.index)) fail(RH_LIGHTER_ERRORS.invalid);
      seen.add(account.index); accounts.push(account);
    }
    const next = body.next_cursor;
    if (next === undefined || next === '') break;
    if (typeof next !== 'string' || next.length > 512 || next === cursor) fail(RH_LIGHTER_ERRORS.invalid);
    cursor = next as string;
  }
  // Every account of the address is summed; a shorter list than the reported total would understate the value.
  if (accounts.length > total) fail(RH_LIGHTER_ERRORS.invalid);
  if (accounts.length < total) fail(RH_LIGHTER_ERRORS.incomplete);
  return { address: user, at: startedAt, accounts };
}

const states = new WeakMap<Fetcher, State>();
function stateOf(fetcher: Fetcher): State {
  let state = states.get(fetcher);
  if (!state) { state = { until: 0, slots: new Map() }; states.set(fetcher, state); }
  return state;
}
const fresh = (snapshot: RhLighterSnapshot | undefined, now: number) => !!snapshot && now >= snapshot.at && now - snapshot.at < RH_LIGHTER_SNAPSHOT_TTL_MS;
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error(RH_LIGHTER_ERRORS.network));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(RH_LIGHTER_ERRORS.network));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * All accounts of one L1 address, shared per address for RH_LIGHTER_SNAPSHOT_TTL_MS (measured from the request start)
 * and joined while in flight. A caller's abort only stops its own wait; the shared read keeps its own timeouts.
 */
export async function readRhLighterSnapshot(walletAddress: unknown, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<RhLighterSnapshot> {
  const user = address(walletAddress), state = stateOf(fetcher), now = Date.now();
  let slot = state.slots.get(user);
  if (slot && fresh(slot.value, now)) return slot.value!;
  if (!slot?.pending) {
    // A clock set back must not stretch the cooldown beyond its length.
    if (now < state.until && state.until - now <= RH_LIGHTER_COOLDOWN_MS) fail(RH_LIGHTER_ERRORS.rateLimited);
    if (state.slots.size >= MAX_SLOTS) for (const [key, item] of state.slots) if (!item.pending && !fresh(item.value, now)) state.slots.delete(key);
    if (!slot) { slot = {}; state.slots.set(user, slot); }
    const current = slot;
    current.pending = load(user, fetcher, state).then(value => { current.value = value; return value; }).finally(() => { current.pending = undefined; });
  }
  return waitFor(slot.pending!, signal);
}

const accountLabel = (account: Account) => `账户 #${account.index}${account.name ? ' ' + account.name : ''}`;

/**
 * The total is the sum of `total_asset_value` over every account of the address: collateral plus unrealized P&L,
 * with margin-eligible assets at the exchange's haircut value. Ordinary spot token balances and public pool shares are
 * outside that value; they are listed unvalued and never added.
 */
export async function syncRhLighter(c: RhLighterCredential, fetcher: Fetcher = fetch): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  const snapshot = await readRhLighterSnapshot(c?.walletAddress, fetcher);
  if (!snapshot.accounts.length) fail(RH_LIGHTER_ERRORS.missing);
  const details: Balance[] = [];
  let total = 0;
  for (const account of snapshot.accounts) {
    total += account.value;
    details.push({ coin: COLLATERAL, account: `${accountLabel(account)} · 账户总值（含未实现盈亏）`, quantity: account.value, price: 1, value: account.value });
  }
  for (const account of snapshot.accounts) for (const asset of account.assets) {
    if (asset.balance !== 0) details.push({ coin: asset.symbol, account: `${accountLabel(account)} · 现货余额（未计入总额）`, quantity: asset.balance, price: 0, value: 0 });
    if (asset.locked !== 0) details.push({ coin: asset.symbol, account: `${accountLabel(account)} · 现货挂单锁定（未计入总额）`, quantity: asset.locked, price: 0, value: 0 });
  }
  const note = (account: string): Balance => ({ coin: NOTE_COIN, account, quantity: 0, price: 0, value: 0 });
  if (snapshot.accounts.some(account => account.pooled)) details.push(note('持有公共池份额，未计入总额'));
  if (snapshot.accounts.some(account => account.binary)) details.push(note('持有二元期权仓位，未单独列出'));
  if (!Number.isFinite(total)) fail(RH_LIGHTER_ERRORS.invalid);
  return { total: total === 0 ? 0 : total, details, updatedAt: new Date(snapshot.at).toISOString() };
}

/** Perpetual positions of every account of the address, read from the same shared snapshot as the balance. */
export async function readRhLighterPositions(c: RhLighterCredential, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<Position[]> {
  const snapshot = await readRhLighterSnapshot(c?.walletAddress, fetcher, signal);
  return snapshot.accounts.flatMap(account => account.positions);
}
