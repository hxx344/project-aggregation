import type { Account, PositionsDisplay } from './desk-types';
import {
  adlConfigurationLock,
  adlStartBlock,
  parseAdlConfig,
  type AdlConfig,
  type PairAdlState,
} from './pair-adl.ts';
import { marginLimitFromPercent, percentFromMarginLimit } from './policy.ts';
import {
  DEFAULT_PAIR_SYMBOL,
  LEGACY_PAIR_SYMBOLS,
  type PairSymbol,
} from './pair-symbols.ts';

export type PairBalance = {
  equity: string;
  available: string;
  wallet: string;
  timestamp: number;
};
export type PairApiNotice = {
  kind: 'budget' | 'cooldown' | 'rate_limit';
  text: string;
};
export type PairTransfer = {
  request_id: string;
  source: 'long' | 'short';
  destination: 'long' | 'short';
  amount: string;
  created_at: number;
  status: string;
  confirmed_at?: number;
  acknowledged_at?: number;
  refreshed_at?: number;
  skipped_at?: number;
  transaction_id?: string;
};
export type PairMarginState = {
  enabled?: boolean;
  running?: boolean;
  status?: string;
  reason?: string;
  error?: string | null;
  api_notice?: PairApiNotice | null;
  blocks_trading?: boolean;
  trading_resume_allowed?: boolean;
  checked_at?: number;
  pending?: PairTransfer | null;
  last_transfer?: PairTransfer | null;
  plan?: Partial<PairTransfer> | null;
  next_check_at?: number;
  cooldown_until?: number;
};
export type Pair = {
  id: string;
  name: string;
  long_account_id: string;
  short_account_id: string;
  symbol: string;
  enabled: boolean;
  revision?: number;
  pause_reason?: string;
  adl?: AdlConfig;
  margin: {
    enabled: boolean;
    master_env_prefix: string;
    check_interval_seconds: number;
    threshold: string;
    min_transfer: string;
    max_transfer: string;
    buffer_ratio: string;
    absolute_reserve_enabled?: boolean;
    long_reserve?: string;
    short_reserve?: string;
    cooldown_seconds: number;
  };
  state?: {
    adl?: PairAdlState;
    phase?: string;
    reason?: string;
    api_notice?: PairApiNotice | null;
    updated_at?: number;
    margin_balances?: { long?: PairBalance | null; short?: PairBalance | null };
    display_positions?: {
      long?: PositionsDisplay | null;
      short?: PositionsDisplay | null;
    };
    // Records left by versions with paired opening. The server keeps such a
    // pair in attention and refuses edits and deletion; never interpret them.
    pending?: unknown;
    recovery_watch?: unknown;
    margin?: PairMarginState;
  };
};
export type PairDraft = {
  id: string;
  name: string;
  long_account_id: string;
  short_account_id: string;
  symbol: string;
  margin_enabled: boolean;
  master_env_prefix: string;
  check_interval_seconds: string;
  balance_threshold: string;
  min_transfer: string;
  max_transfer: string;
  buffer_percent: string;
  absolute_reserve_enabled: boolean;
  long_reserve: string;
  short_reserve: string;
  cooldown_seconds: string;
  adl_enabled: boolean;
  adl_batch_notional: string;
};

export function pairDraft(pair?: Pair): PairDraft {
  return {
    id: pair?.id ?? '',
    name: pair?.name ?? '',
    long_account_id: pair?.long_account_id ?? '',
    short_account_id: pair?.short_account_id ?? '',
    symbol: pair?.symbol ?? DEFAULT_PAIR_SYMBOL.symbol,
    margin_enabled: pair?.margin.enabled ?? false,
    master_env_prefix: pair?.margin.master_env_prefix ?? '',
    check_interval_seconds: String(pair?.margin.check_interval_seconds ?? 5),
    balance_threshold: pair?.margin.threshold ?? '10',
    min_transfer: pair?.margin.min_transfer ?? '1',
    max_transfer: pair?.margin.max_transfer ?? '1000',
    buffer_percent: percentFromMarginLimit(pair?.margin.buffer_ratio ?? '0.05'),
    absolute_reserve_enabled: pair?.margin.absolute_reserve_enabled ?? false,
    long_reserve: pair?.margin.long_reserve ?? '0',
    short_reserve: pair?.margin.short_reserve ?? '0',
    cooldown_seconds: String(pair?.margin.cooldown_seconds ?? 30),
    adl_enabled: pair?.adl?.enabled ?? true,
    adl_batch_notional: pair?.adl?.batch_notional ?? '1000',
  };
}

function amount(
  value: string,
  label: string,
  allowZero = false,
  maxLength = 40,
): string {
  const text = value.trim();
  if (text.length > maxLength)
    throw new Error(`${label}最多支持 ${maxLength} 个字符`);
  const parsed = quantityUnits(text);
  if (
    !/^\d/.test(text) ||
    !parsed ||
    (!allowZero && parsed.units === BigInt(0))
  )
    throw new Error(
      `${label}必须是${allowZero ? '非负' : '大于零的'}金额或数值`,
    );
  return text;
}

// Inputs have already passed amount(); align their decimal places exactly.
function compareAmounts(left: string, right: string): number {
  const a = quantityUnits(left)!;
  const b = quantityUnits(right)!;
  const scale = Math.max(a.scale, b.scale);
  const leftUnits = a.units * BigInt(10) ** BigInt(scale - a.scale);
  const rightUnits = b.units * BigInt(10) ** BigInt(scale - b.scale);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function seconds(value: string, label: string, maximum: number): number {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > maximum
  )
    throw new Error(`${label}必须是 1 至 ${maximum} 的整数秒`);
  return Number(value);
}

export function availablePairAccounts(
  accounts: Account[],
  pairs: Pair[],
  currentId?: string,
): Account[] {
  const occupied = new Set(
    pairs
      .filter((pair) => pair.id !== currentId)
      .flatMap((pair) => [pair.long_account_id, pair.short_account_id]),
  );
  return accounts.filter(
    (account) =>
      !occupied.has(account.id) &&
      (!account.pair_id || account.pair_id === currentId),
  );
}

export function parsePairDraft(
  draft: PairDraft,
  accounts: Account[],
  pairs: Pair[],
  currentId?: string,
  symbols: readonly PairSymbol[] = LEGACY_PAIR_SYMBOLS,
) {
  if (!/^[a-z0-9_-]{1,32}$/.test(draft.id))
    throw new Error('组标识只允许 1–32 位小写字母、数字、下划线或短横线');
  const name = draft.name.trim();
  if (!name || name.length > 50) throw new Error('组名称须为 1–50 个字符');
  const symbol = draft.symbol ?? DEFAULT_PAIR_SYMBOL.symbol;
  const current = pairs.find((pair) => pair.id === currentId);
  const savedSymbol = current?.symbol ?? DEFAULT_PAIR_SYMBOL.symbol;
  if (
    !symbols.some((item) => item.symbol === symbol) &&
    (!current || symbol !== savedSymbol)
  )
    throw new Error('请选择目录中支持的配对标的');
  const available = availablePairAccounts(accounts, pairs, currentId);
  const long = available.find(
    (account) => account.id === draft.long_account_id,
  );
  const short = available.find(
    (account) => account.id === draft.short_account_id,
  );
  if (!long || !short || long.id === short.id)
    throw new Error('请选择两个不同且未被其他组占用的子账户');
  if (long.mode !== short.mode || !['live', 'paper'].includes(long.mode))
    throw new Error('两侧必须使用相同的实盘或模拟环境');
  if (!currentId && (long.enabled || short.enabled))
    throw new Error('请先暂停两侧账户再创建配对组');
  const prefix = draft.master_env_prefix.trim();
  if (prefix && !/^[A-Z][A-Z0-9_]{1,40}$/.test(prefix))
    throw new Error('主账户凭据前缀格式无效');
  if (long.mode === 'live' && !prefix)
    throw new Error(
      '实盘配对组须填写独立主账户凭据环境变量前缀，用于核验两侧共同归属',
    );
  if (
    long.mode === 'live' &&
    [long.env_prefix, short.env_prefix].includes(prefix)
  )
    throw new Error('主账户凭据前缀必须独立，不能使用任一子账户凭据前缀');
  const minTransfer = amount(draft.min_transfer, '最小划转金额');
  const maxTransfer = amount(draft.max_transfer, '最大划转金额');
  if (compareAmounts(minTransfer, '0.00000001') < 0)
    throw new Error('最小划转金额至少为 0.00000001 USD1');
  if (compareAmounts(minTransfer, maxTransfer) > 0)
    throw new Error('最小划转金额不能大于最大划转金额');
  if (compareAmounts(maxTransfer, '1000000000') > 0)
    throw new Error('最大划转金额不能超过 1000000000 USD1');
  const balanceThreshold = amount(
    draft.balance_threshold,
    '可用余额差额门槛',
    true,
  );
  if (compareAmounts(balanceThreshold, '1000000000') > 0)
    throw new Error('可用余额差额门槛不能超过 1000000000 USD1');
  const buffer = amount(draft.buffer_percent, '保留缓冲比例', true, 128);
  const longReserve = amount(draft.long_reserve, 'A 侧绝对保留', true);
  const shortReserve = amount(draft.short_reserve, 'B 侧绝对保留', true);
  if ([longReserve, shortReserve].some(value => compareAmounts(value, '1000000000') > 0))
    throw new Error('绝对保留金额不能超过 1000000000 USD1');
  if (compareAmounts(buffer, '100') >= 0)
    throw new Error('保留缓冲比例须小于 100%');
  return {
    id: draft.id,
    name,
    long_account_id: long.id,
    short_account_id: short.id,
    symbol,
    adl: parseAdlConfig(draft.adl_enabled, draft.adl_batch_notional),
    margin: {
      enabled: draft.margin_enabled,
      master_env_prefix: prefix,
      check_interval_seconds: seconds(
        draft.check_interval_seconds,
        '平衡检查间隔',
        3600,
      ),
      threshold: balanceThreshold,
      min_transfer: minTransfer,
      max_transfer: maxTransfer,
      absolute_reserve_enabled: draft.absolute_reserve_enabled,
      long_reserve: longReserve,
      short_reserve: shortReserve,
      buffer_ratio:
        compareAmounts(buffer, '0') === 0
          ? '0'
          : marginLimitFromPercent(buffer),
      cooldown_seconds: seconds(draft.cooldown_seconds, '划转冷却', 86400),
    },
  };
}

export function pairConfigurationChanges(
  config: ReturnType<typeof parsePairDraft>,
) {
  const { name, symbol, margin, adl } = config;
  return { name, symbol, margin, adl };
}

// Account display cadence does not describe pair balances or runtime health.
// Keep this bound shared by current notices and their history.
export function pairDataFresh(
  timestamp: number | undefined,
  now: number,
  offline = false,
): boolean {
  return (
    !offline &&
    timestamp !== undefined &&
    Number.isFinite(timestamp) &&
    timestamp > 0 &&
    Number.isFinite(now) &&
    now >= timestamp - 1 &&
    now - timestamp < 8
  );
}
// Old ordinary batches or order watches are discarded unreconciled when the
// server starts; until then it refuses start, edits and deletion.
const LEGACY_ORDERS = '旧版配对开仓留下的订单记录未处理';
export function pairLegacyOrders(pair: Pair): boolean {
  // Mirrors require_no_legacy_orders: any non-null record blocks changes.
  return pair.state?.pending != null || pair.state?.recovery_watch != null;
}
export function pairHasPending(pair: Pair): boolean {
  return (
    pairLegacyOrders(pair) ||
    Boolean(pair.state?.margin?.pending) ||
    pair.state?.margin?.status === 'unknown'
  );
}
// Starting resumes durable transfer checks only; it never resubmits a write.
export function pairStartBlock(pair: Pair): string {
  const adlBlock = adlStartBlock(pair);
  if (adlBlock) return adlBlock;
  if (pairLegacyOrders(pair)) return `${LEGACY_ORDERS}，暂不能启动`;
  if (pair.margin?.enabled !== true) return '请先开启保证金平衡，再启动配对组';
  return '';
}
export function pairMarginRunning(pair: Pair): boolean {
  return (
    pair.state?.margin?.running ??
    (pair.enabled === true && pair.margin?.enabled === true)
  );
}
export function pairConfigurationLock(pair: Pair): string {
  const adlBlock = adlConfigurationLock(pair);
  if (adlBlock) return adlBlock;
  if (pair.enabled) return '暂停配对组后可修改设置。';
  if (pairLegacyOrders(pair)) return `${LEGACY_ORDERS}，暂不能修改设置。`;
  if (pairHasPending(pair)) return '划转结果待核对，暂不能修改设置。';
  return '';
}
// Unbinding keeps both accounts' positions; the server re-checks every guard.
export function pairDeletionBlock(pair: Pair, offline = false): string {
  if (offline) return '连接恢复后可删除配对组';
  const adlBlock = adlConfigurationLock(pair);
  if (adlBlock) return adlBlock;
  if (pair.enabled) return '请先暂停配对组';
  if (pairLegacyOrders(pair)) return `${LEGACY_ORDERS}，暂不能删除`;
  const margin = pair.state?.margin;
  if (
    margin?.pending ||
    ['submitting', 'accepted', 'acknowledged', 'unknown'].includes(
      margin?.status ?? '',
    )
  )
    return '保证金划转结果待核实，完成后才能删除';
  return '';
}

// Keep amount comparisons exact; invalid input stays unknown.
function quantityUnits(value: string): { units: bigint; scale: number } | null {
  if (
    typeof value !== 'string' ||
    !/^[+-]?\d+(?:\.\d+)?$/.test(value) ||
    value.length > 128
  )
    return null;
  const [whole, decimal = ''] = value.replace(/^[+-]/, '').split('.');
  return { units: BigInt(whole + decimal), scale: decimal.length };
}

export const PAIR_PHASES: Record<string, string> = {
  paused: '已暂停',
  disabled: '未开启',
  waiting: '等待条件',
  attention: '需要处理',
  error: '执行异常',
  blocked: '条件阻止执行',
  monitoring: '保证金管理中',
  maintenance: '工作台维护中',
  recovering: 'ADL 应急处理中',
  unknown: '结果未知 · 继续查询',
  accepted: '请求已受理 · 等待确认',
  cooldown: '划转冷却中',
  confirmed: '两侧划转流水已核实',
  acknowledged: '交易所已确认 · 等待余额刷新',
  refreshed: '交易所回执确认，余额已刷新',
  paper_confirmed: '模拟划转已确认',
  rejected: '划转被拒绝',
  skipped: '核对已跳过 · 结果未确认',
  margin_wait: '保证金检查阻止新增',
};
export function pairPhaseLabel(phase?: string): string {
  return phase ? (PAIR_PHASES[phase] ?? phase) : '等待状态';
}

export function pairExecutionPhaseLabel(pair: Pair): string {
  const adl = pair.state?.adl?.incident;
  if (adl?.status === 'active') return 'ADL 应急处理中';
  if (adl?.status === 'blocked') return 'ADL 处理受阻';
  if (adl?.status === 'completed' && adl.hold) return 'ADL 处理完成 · 保持暂停';
  return pairPhaseLabel(pair.state?.phase);
}

export function pairTransferStatus(transfer: PairTransfer): string {
  if (transfer.status === 'submitting') return '划转请求提交中 · 等待回执';
  if (
    transfer.status === 'acknowledged' &&
    typeof transfer.refreshed_at === 'number' &&
    Number.isFinite(transfer.refreshed_at) &&
    transfer.refreshed_at > 0
  )
    return PAIR_PHASES.refreshed;
  return pairPhaseLabel(transfer.status);
}

export function pairMarginStatus(margin?: PairMarginState): string {
  if (
    margin?.status === 'unknown' &&
    margin.trading_resume_allowed === true &&
    margin.blocks_trading === false
  )
    return '划转待核对 · 交易已解除阻塞';
  if (margin?.status === 'submitting') return '划转请求提交中 · 等待回执';
  if (
    margin?.status === 'acknowledged' &&
    !margin.pending &&
    margin.last_transfer
  )
    return pairTransferStatus(margin.last_transfer);
  return pairPhaseLabel(margin?.status);
}
