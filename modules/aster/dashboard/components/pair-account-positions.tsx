import type { ReactNode } from 'react';
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
  notes,
}: {
  pair: Pair;
  side: 'long' | 'short';
  account?: Account;
  now: number;
  connectionError: string;
  notes?: ReactNode;
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
        <div className="pair-positions-title">
          <h2>
            {name} ·{' '}
            {marginOnly
              ? '账户持仓'
              : side === 'long'
                ? '本组做多'
                : '本组做空'}
          </h2>
          <span className="muted">{account?.name ?? '账户待确认'}</span>
          <span className="count">
            完整持仓 {snapshot ? positions.length : '—'}
          </span>
        </div>
        <span className={view.warning ? 'small-note amber' : 'small-note'}>
          {snapshot
            ? `${view.label} · ${new Date(snapshot.timestamp * 1000).toLocaleString('zh-CN', { hour12: false })}`
            : view.label}
        </span>
      </div>
      <div className="pair-positions-notes">
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
      {positions.length ? (
        <AccountPositionsTable
          positions={positions}
          strategy={{
            symbol,
            direction: side === 'long' ? 'LONG' : 'SHORT',
            marginOnly,
          }}
          label={label}
          stale={Boolean(snapshot) && view.warning}
        />
      ) : (
        <p className="pair-positions-empty">{view.emptyNotice}</p>
      )}
      {notes ? <div className="pair-positions-foot">{notes}</div> : null}
    </section>
  );
}
