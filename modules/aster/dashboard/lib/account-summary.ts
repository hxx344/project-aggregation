import type { Account } from './desk-types';
import { accountSnapshotView } from './account-modes.ts';
import { pairHasPending, pairMarginOnly, type Pair } from './pairs.ts';
import { pairScheduledMarginWait } from './pair-notices.ts';

type SummarySnapshot = {
  timestamp: number;
  equity?: string;
  available?: string;
  ratio?: string | null;
};

const message = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const amount = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  Number.isFinite(Number(value));

// A header projection only. Trading and risk consumers keep their full snapshot.
export function accountSummaryView(
  account: Account | undefined,
  pair: Pair | undefined,
  now: number,
  connectionError = '',
) {
  const side =
    account && pair
      ? account.id === pair.long_account_id
        ? 'long'
        : account.id === pair.short_account_id
          ? 'short'
          : undefined
      : undefined;
  const fundsOnly = Boolean(side && pair && pairMarginOnly(pair));
  if (!fundsOnly) {
    return {
      fundsOnly,
      snapshot: account?.snapshot as SummarySnapshot | undefined,
      ...accountSnapshotView(
        account?.snapshot,
        now,
        connectionError,
        account?.snapshot_refresh,
        account?.status === 'error' ? account.reason : undefined,
      ),
    };
  }

  const margin = pair!.state?.margin;
  const balance = pair!.state?.margin_balances?.[side!];
  // Never fill missing funds fields from a historical trading snapshot.
  const snapshot: SummarySnapshot | undefined = balance
    ? {
        timestamp: balance.timestamp,
        equity: amount(balance.equity) ? balance.equity : undefined,
        available: amount(balance.available) ? balance.available : undefined,
        ratio: null,
      }
    : undefined;
  const error =
    message(margin?.error) ||
    message(margin?.api_notice?.text) ||
    message(pair!.state?.api_notice?.text) ||
    (['blocked', 'error', 'rejected', 'unknown'].includes(margin?.status ?? '')
      ? message(margin?.reason) || '保证金检查尚未完成，请查看配对组状态'
      : undefined) ||
    (['error', 'attention'].includes(pair!.state?.phase ?? '')
      ? message(pair!.state?.reason) || '配对组需要核对'
      : undefined) ||
    (balance && (!amount(balance.equity) || !amount(balance.available))
      ? '资金余额数据不完整，等待重新读取'
      : undefined);
  const view = accountSnapshotView(
    snapshot,
    now,
    connectionError,
    undefined,
    error,
  );
  const paused = !pair!.enabled && !pairHasPending(pair!);
  const scheduled = pairScheduledMarginWait(
    pair!,
    now,
    Boolean(connectionError),
  );
  const retained = Boolean(
    snapshot &&
    view.elapsed !== null &&
    !connectionError &&
    !error &&
    (paused || scheduled),
  );
  const label = connectionError
    ? '最近余额 · 连接异常'
    : error
      ? '最近余额 · 检查异常'
      : !snapshot
        ? '等待保证金余额'
        : view.elapsed === null
          ? '余额时间异常'
          : retained && paused
            ? '最近余额 · 配对组已暂停'
            : retained && scheduled?.coolingDown
              ? '最近余额 · 冷却中'
              : retained && scheduled?.checking
                ? '正在检查余额'
                : view.fresh
                  ? '余额已同步'
                  : retained
                    ? '最近余额 · 定时检查'
                    : '最近余额 · 更新延迟';
  const notice = connectionError
    ? '连接异常，保留最近余额'
    : error ||
      (!snapshot
        ? '等待配对组首次读取该账户余额'
        : view.elapsed === null
          ? '余额读取时间异常'
          : retained && paused
            ? '配对组已暂停，保留最近读取的余额'
            : retained
              ? '余额随保证金检查更新，冷却期间保留最近记录'
              : view.fresh
                ? ''
                : '保证金余额长时间未更新，请查看配对组检查状态');
  return {
    ...view,
    fundsOnly,
    snapshot,
    label,
    notice,
    warning: retained ? false : view.warning,
  };
}
