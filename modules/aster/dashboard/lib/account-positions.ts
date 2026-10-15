import type {
  Account,
  DisplayPosition,
  PositionsDisplay,
  PositionsSnapshot,
} from './desk-types';
import { accountSnapshotView } from './account-modes.ts';
import { pairHasPending, pairMarginOnly, type Pair } from './pairs.ts';
import { pairScheduledMarginWait } from './pair-notices.ts';

export function latestPositionsSnapshot(
  ...candidates: (PositionsSnapshot | null | undefined)[]
): PositionsSnapshot | undefined {
  let latest: PositionsSnapshot | undefined;
  for (const candidate of candidates) {
    if (
      !candidate ||
      !Array.isArray(candidate.positions) ||
      !Number.isFinite(candidate.timestamp) ||
      candidate.timestamp <= 0 ||
      !Number.isFinite(new Date(candidate.timestamp * 1000).getTime())
    )
      continue;
    if (!latest || candidate.timestamp > latest.timestamp) latest = candidate;
  }
  return latest;
}

export function visiblePositions(
  snapshot?: PositionsSnapshot | null,
): DisplayPosition[] {
  return Array.isArray(snapshot?.positions)
    ? snapshot.positions.filter(
        (position) =>
          typeof position.qty !== 'string' ||
          !/^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[eE][+-]?\d+)?$/.test(
            position.qty.trim(),
          ),
      )
    : [];
}

function latestDisplay(...candidates: (PositionsDisplay | null | undefined)[]) {
  let latest: PositionsDisplay | undefined;
  for (const candidate of candidates) {
    if (
      candidate &&
      Number.isFinite(candidate.checked_at) &&
      candidate.checked_at > 0 &&
      (!latest || candidate.checked_at > latest.checked_at)
    )
      latest = candidate;
  }
  return latest;
}

export function accountPositionsView({
  account,
  pair,
  side,
  now,
  connectionError = '',
}: {
  account?: Account;
  pair?: Pair;
  side?: 'long' | 'short';
  now: number;
  connectionError?: string;
}) {
  const pairDisplay = side ? pair?.state?.display_positions?.[side] : undefined;
  const snapshot = latestPositionsSnapshot(
    account?.snapshot,
    side ? pair?.state?.snapshots?.[side] : undefined,
    account?.display_positions?.snapshot,
    pairDisplay?.snapshot,
  );
  const display = latestDisplay(account?.display_positions, pairDisplay);
  const fromDisplay = Boolean(
    snapshot &&
    (snapshot === account?.display_positions?.snapshot ||
      snapshot === pairDisplay?.snapshot),
  );
  const displayError =
    typeof display?.error === 'string' &&
    display.error.trim() &&
    (!snapshot || display.checked_at >= snapshot.timestamp)
      ? `持仓更新失败：${display.error.trim()}`
      : undefined;
  const error =
    displayError ||
    (!fromDisplay && account?.status === 'error' ? account.reason : undefined);
  const marginOnly = Boolean(pair && pairMarginOnly(pair));
  const refresh = marginOnly
    ? { interval_seconds: Math.max(8, pair!.margin.check_interval_seconds) }
    : account?.snapshot_refresh;
  let view = accountSnapshotView(
    snapshot,
    now,
    connectionError,
    refresh,
    error,
  );
  const scheduled =
    pair && marginOnly
      ? pairScheduledMarginWait(pair, now, Boolean(connectionError))
      : null;
  const paused = Boolean(
    pair && marginOnly && !pair.enabled && !pairHasPending(pair),
  );
  if (
    snapshot &&
    view.elapsed !== null &&
    !connectionError &&
    !error &&
    (paused || scheduled)
  ) {
    view = {
      ...view,
      warning: false,
      label: paused
        ? '最近持仓 · 已暂停'
        : scheduled?.coolingDown
          ? '最近持仓 · 冷却中'
          : scheduled?.checking
            ? '正在检查持仓'
            : view.fresh
              ? '已同步'
              : '最近持仓 · 定时更新',
      notice: paused
        ? '配对组已暂停，保留最近读取的持仓。'
        : '仓位随保证金检查更新，当前保留最近记录。',
    };
  }
  const positions = visiblePositions(snapshot);
  return {
    ...view,
    snapshot,
    positions,
    sourceNote: marginOnly
      ? '仓位随保证金检查更新；暂停或冷却期间保留最近记录。'
      : '',
    fieldNotice: positions.some((position) =>
      [
        position.entry,
        position.mark,
        position.leverage,
        position.notional,
        position.occupied_margin,
        position.unrealized,
        position.liquidation,
      ].some((value) => value == null),
    )
      ? '未提供的价格、杠杆或风险字段以“—”显示。'
      : '',
    emptyNotice: marginOnly
      ? snapshot
        ? '最近读取的持仓清单为空；暂停或冷却期间保留该次记录。'
        : '尚未取得完整持仓清单，余额数据不能证明空仓。'
      : view.emptyNotice,
  };
}

export function positionLeverageLabel(value: DisplayPosition['leverage']) {
  return value == null ||
    String(value).trim() === '' ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0
    ? '—'
    : `${value}x`;
}

export function positionProfitClass(value: DisplayPosition['unrealized']) {
  return value == null || value.trim() === '' || !Number.isFinite(Number(value))
    ? ''
    : Number(value) < 0
      ? 'danger'
      : 'mint';
}

export function strategyPositionLabel(
  position: Pick<DisplayPosition, 'symbol' | 'side'>,
  symbol: string,
  direction: 'LONG' | 'SHORT',
  marginOnly = false,
): { symbolLabel: string | null; directionLabel: string | null } {
  const matchesSymbol = position.symbol === symbol;
  return {
    symbolLabel: matchesSymbol
      ? marginOnly
        ? '配置币种'
        : '当前策略币种'
      : null,
    directionLabel:
      matchesSymbol && !marginOnly && position.side === direction
        ? direction === 'LONG'
          ? '本组多仓'
          : '本组空仓'
        : null,
  };
}
