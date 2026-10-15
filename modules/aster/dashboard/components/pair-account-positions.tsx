import { AccountPositionsTable } from '@/components/account-positions-table';
import type { Account } from '@/lib/desk-types';
import type { Pair } from '@/lib/pairs';
import { pairMarginOnly } from '@/lib/pairs';
import { DEFAULT_PAIR_SYMBOL } from '@/lib/pair-symbols';
import { accountPositionsView } from '@/lib/account-positions';

export function PairAccountPositions({
  pair,
  side,
  account,
  now,
  connectionError,
}: {
  pair: Pair;
  side: 'long' | 'short';
  account?: Account;
  now: number;
  connectionError: string;
}) {
  const view = accountPositionsView({
    account,
    pair,
    side,
    now,
    connectionError,
  });
  const { snapshot, positions } = view;
  const symbol = pair.symbol ?? DEFAULT_PAIR_SYMBOL.symbol;
  const marginOnly = pairMarginOnly(pair);
  const name = side === 'long' ? 'A' : 'B';
  const label = `${name} 账户完整持仓`;
  return (
    <section className="panel pair-account-positions" aria-label={label}>
      <div className="section-head">
        <div>
          <h2>
            {name} · {account?.name ?? '账户待确认'}
            <span className="count">
              完整持仓 {snapshot ? positions.length : '—'}
            </span>
          </h2>
          <p>
            {marginOnly ? '配置币种' : '当前策略币种'}：{symbol} ·{' '}
            {marginOnly
              ? '仅保证金管理，当前不开仓'
              : `本组管理${side === 'long' ? '多仓' : '空仓'}，其余仓位保留`}
          </p>
          {view.sourceNote ? <p>{view.sourceNote}</p> : null}
          {view.fieldNotice ? <p>{view.fieldNotice}</p> : null}
          {view.notice ? (
            <p className={view.warning ? 'amber' : ''}>{view.notice}</p>
          ) : null}
        </div>
        <span className={view.warning ? 'small-note amber' : 'small-note'}>
          {snapshot
            ? `${view.label} · ${new Date(snapshot.timestamp * 1000).toLocaleString('zh-CN', { hour12: false })}`
            : view.label}
        </span>
      </div>
      {positions.length ? (
        <AccountPositionsTable
          positions={positions}
          strategy={{
            symbol,
            direction: side === 'long' ? 'LONG' : 'SHORT',
            marginOnly,
          }}
          label={label}
        />
      ) : (
        <p className="pair-positions-empty">{view.emptyNotice}</p>
      )}
    </section>
  );
}
