'use client';
import {
  AccountPositionsTable,
  type PositionStrategy,
} from '@/components/account-positions-table';
import { Button } from '@/components/ui/button';
import {
  ConfigurationField,
  SettingsForm,
} from '@/components/configuration-fields';
import type { FeatureProps } from '@/lib/desk-types';
import { useAccountDraft } from '@/lib/use-account-draft';
import { Layers3, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { fmt, pct, clock } from '@/lib/desk-format';
import { accountModeView, accountSnapshotView } from '@/lib/account-modes';
import { accountConfigurationLock } from '@/lib/account-config';
import {
  accountPositionsView,
  visiblePositions,
} from '@/lib/account-positions';
import { pairMarginOnly, type Pair } from '@/lib/pairs';
import { DEFAULT_PAIR_SYMBOL } from '@/lib/pair-symbols';
import { DeleteAccountDialog } from '@/components/delete-account-dialog';
import { marginLimitFromPercent } from '@/lib/policy';
import { accountRiskView } from '@/lib/account-risk';
export function AccountOverview({
  account,
  busy,
  action,
  setError,
  setNotice,
  now,
  connectionError,
  pair,
}: FeatureProps & { now: number; connectionError: string; pair?: Pair }) {
  const snapshot = account.snapshot;
  const configurationLock = accountConfigurationLock(account);
  const locked = busy || Boolean(configurationLock);
  const direction =
    pair?.long_account_id === account.id
      ? 'LONG'
      : pair?.short_account_id === account.id
        ? 'SHORT'
        : undefined;
  const positionsView = accountPositionsView({
    account,
    pair,
    side:
      direction === 'LONG'
        ? 'long'
        : direction === 'SHORT'
          ? 'short'
          : undefined,
    now,
    connectionError,
  });
  const { snapshot: positionsSnapshot, positions } = positionsView;
  const positionsTime = positionsSnapshot
    ? new Date(positionsSnapshot.timestamp * 1000).toLocaleString('zh-CN', {
        hour12: false,
      })
    : '—';
  const positionStrategy: PositionStrategy | undefined =
    pair && direction
      ? {
          symbol: pair.symbol ?? DEFAULT_PAIR_SYMBOL.symbol,
          direction,
          marginOnly: pairMarginOnly(pair),
        }
      : undefined;
  const ratio =
    snapshot?.ratio == null || pct(snapshot.ratio) === '—'
      ? null
      : Number(snapshot.ratio);
  const modeView = accountModeView(snapshot, now, connectionError);
  const snapshotView = accountSnapshotView(
    snapshot,
    now,
    connectionError,
    account.snapshot_refresh,
    account.status === 'error' ? account.reason : undefined,
  );
  const {
    marginLimit,
    marginPercent,
    marginDraft,
    highMarginPercent,
    migrationMarginPercent,
    cycleMarginPercent,
    cycleMode,
    upperRiskLimit,
    upperRiskPercent,
    riskAccent,
  } = accountRiskView(account, ratio);
  const {
    value: riskDraft,
    setValue: setRiskDraft,
    clear,
  } = useAccountDraft(account.id, marginDraft);
  return (
    <div className="feature-stack">
      {' '}
      <section className="metrics">
        <Metric
          label="总名义持仓金额"
          value={fmt(snapshot?.total_notional)}
          sub="USD1 · 全部仓位按标记价格计，多空累加"
          icon={<Layers3 size={17} />}
        />
        <Metric
          label="账户保证金比率"
          value={pct(snapshot?.margin_ratio)}
          sub="维持保证金 ÷ 账户总权益"
          icon={<ShieldCheck size={17} />}
        />
        <Metric
          label="未实现盈亏"
          value={fmt(snapshot?.unrealized)}
          sub={
            snapshot
              ? `${visiblePositions(snapshot).length} 个方向持仓 · 风险快照 ${clock(snapshot.timestamp)}`
              : '等待账户仓位数据'
          }
          accent={Number(snapshot?.unrealized) < 0 ? 'danger' : 'mint'}
          icon={<ArrowUpRight size={17} />}
        />
      </section>
      {snapshot &&
      positionsSnapshot &&
      snapshot.timestamp !== positionsSnapshot.timestamp ? (
        <p className="small-note">
          风险汇总仍为 {modeView.recordedAt ?? '—'} 记录，以下持仓清单更新于{' '}
          {positionsTime}。
        </p>
      ) : null}
      <div className="feature-grid">
        <div className="panel positions-panel">
          <div className="section-head">
            <h2>当前持仓 · {positionsSnapshot ? positions.length : '—'}</h2>
            <span
              className={
                positionsView.warning ? 'small-note amber' : 'small-note'
              }
              title={positionsView.notice}
            >
              {positionsView.label} {positionsTime}
            </span>
          </div>
          {positionsView.sourceNote ? (
            <p className="muted">{positionsView.sourceNote}</p>
          ) : null}
          {positionsView.fieldNotice ? (
            <p className="muted">{positionsView.fieldNotice}</p>
          ) : null}
          {positionsView.notice ? (
            <p
              className={
                positionsView.warning ? 'small-note amber' : 'small-note'
              }
            >
              {positionsView.notice}
            </p>
          ) : null}
          <AccountPositionsTable
            positions={positions}
            strategy={positionStrategy}
            stale={Boolean(positionsSnapshot) && positionsView.warning}
          />
          {!positions.length && (
            <div className="empty-state">
              <Layers3 size={27} />
              <h3>{positionsView.emptyTitle}</h3>
              <p>{positionsView.emptyNotice}</p>
            </div>
          )}
        </div>
        <div className="feature-stack">
          {' '}
          <section className="panel risk-panel">
            <div className="section-head">
              <h2>风险约束</h2>
              <ShieldCheck className="mint" size={18} />
            </div>
            <div className="risk-value">
              <span className={riskAccent}>
                {snapshot ? pct(snapshot.ratio) : '—'}
              </span>
              <small>
                {cycleMode
                  ? cycleMarginPercent === null
                    ? '循环上限待服务确认'
                    : `循环 ≤ ${cycleMarginPercent}%`
                  : marginPercent === null
                    ? '普通 5x 上限待确认'
                    : `普通 5x ≤ ${marginPercent}%`}
              </small>
            </div>
            <div className="risk-track">
              {ratio === null ? (
                <p className="muted">保证金占用率尚未提供</p>
              ) : (
                <Progress
                  value={Math.min(100, ratio * 100)}
                  aria-label="当前保证金占用率"
                />
              )}
              {ratio !== null && marginPercent !== null && (
                <i
                  className="limit-marker"
                  style={{ left: `${marginPercent}%` }}
                  title={`普通 5x 基础上限 ${marginPercent}%`}
                />
              )}
              {ratio !== null &&
                marginLimit !== null &&
                upperRiskLimit !== null &&
                upperRiskLimit > marginLimit && (
                  <i
                    className="limit-marker high-limit-marker"
                    style={{ left: `${upperRiskPercent}%` }}
                    title={`${cycleMode ? '循环全部持仓' : '普通 10x / 20x'}上限 ${upperRiskPercent}%`}
                  />
                )}
            </div>
            <div className="scale">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
            <details className="disclosure inset">
              <summary>各功能风险上限与计算口径</summary>
              <div className="risk-explanation muted">
                <p className="risk-bonus">
                  <span>普通 10x / 20x 加仓上限</span>
                  <strong>
                    {highMarginPercent === null
                      ? '待确认'
                      : `${highMarginPercent}%`}
                  </strong>
                </p>
                <p className="risk-bonus">
                  <span>迁移上限 · 含 5x</span>
                  <strong>
                    {migrationMarginPercent === null
                      ? '待确认'
                      : `${migrationMarginPercent}%`}
                  </strong>
                </p>
                <p className="risk-bonus">
                  <span>循环上限 · 全部持仓</span>
                  <strong>
                    {cycleMarginPercent === null
                      ? '待服务确认'
                      : `${cycleMarginPercent}%`}
                  </strong>
                </p>
                <p>共用额外 5 个百分点，最高 100%。</p>
                <p>每仓占用 = |数量| × 标记价格 ÷ 实际杠杆；多空分别累加。</p>
              </div>
            </details>
            <dl className="details">
              <div>
                <dt>总占用保证金 · USD1</dt>
                <dd>{fmt(snapshot?.occupied_margin)}</dd>
              </div>
              {modeView.rows.map((mode) => (
                <div key={mode.key}>
                  <dt>{mode.label}</dt>
                  <dd className={mode.failed ? 'danger' : ''}>{mode.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mode-check-note">
              <p title="模式结果来自这次账户快照">
                {modeView.recordedAt
                  ? `账户快照 ${modeView.recordedAt}${modeView.elapsed ? ` · ${modeView.elapsed}` : ''}`
                  : modeView.hasSnapshot
                    ? '账户快照时间未知'
                    : '等待首次账户核验'}
              </p>
              {snapshotView.notice && (
                <p className={snapshotView.warning ? 'amber' : ''}>
                  {snapshotView.notice}
                </p>
              )}
            </div>
            <div className="risk-caption">
              三项账户模式必须满足。程序只核验，不自动修改；不符合时请在交易所调整，并等待新快照重新核验。下单前与成交后均检查风险。
            </div>
          </section>
          <details className="disclosure panel settings-panel">
            <summary>账户基础风险设置</summary>
            <SettingsForm
              {...{ account, action, locked, setNotice, setError }}
              clearDraft={clear}
              changes={() => ({
                margin_limit: marginLimitFromPercent(riskDraft),
              })}
              success="账户风险上限已保存"
              errorFallback="风险上限无效"
              clearNoticeOnError={false}
            >
              <ConfigurationField
                id="margin-percent"
                label="基础保证金占用上限 · %"
                max="100"
                placeholder={
                  marginPercent === null ? '待确认，请输入上限' : undefined
                }
                disabled={locked}
                value={riskDraft}
                onValueChange={(value) => setRiskDraft(value)}
              />
              <p className="muted">
                此设置由普通开仓、循环和迁移共用。
                {configurationLock || '各功能适用上限见上方风险约束。'}
              </p>
              <Button
                type="submit"
                variant="outline"
                disabled={locked || !riskDraft.trim()}
              >
                保存账户风险上限
              </Button>
            </SettingsForm>
          </details>
        </div>
      </div>
      <DeleteAccountDialog
        key={account.id}
        account={account}
        busy={busy}
        action={action}
        setNotice={setNotice}
        connectionError={connectionError}
      />
    </div>
  );
}
function Metric({
  label,
  value,
  sub,
  icon,
  accent = '',
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <article className="metric">
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <div className={`metric-value ${accent}`}>{value}</div>
      <p>{sub}</p>
    </article>
  );
}
