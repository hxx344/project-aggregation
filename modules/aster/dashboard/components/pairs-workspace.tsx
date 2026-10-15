'use client';
import { useState } from 'react';
import { CirclePause, CirclePlay, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { PairSettings } from '@/components/pair-settings';
import { PairCycleCostsPanel } from '@/components/pair-cycle-costs';
import { PairNotices } from '@/components/pair-notices';
import { PairOrderDiagnostics } from '@/components/pair-order-diagnostics';
import { PairOrderRecovery } from '@/components/pair-order-recovery';
import { PairBaselineRecovery } from '@/components/pair-baseline-recovery';
import { PairAccountPositions } from '@/components/pair-account-positions';
import { CycleQualityHistoryPanel } from '@/components/cycle-quality-history';
import {
  pairScheduledMarginWait,
  type PairNoticeState,
} from '@/lib/pair-notices';
import { usePairNotices } from '@/lib/use-pair-notices';
import { ExecutionEvents } from '@/components/execution-events';
import type { Account, DeskAction } from '@/lib/desk-types';
import type { ExecutionEvent } from '@/lib/cycle-events';
import { useAccountDraft } from '@/lib/use-account-draft';
import { usePairSymbols } from '@/lib/use-pair-symbols';
import { DEFAULT_PAIR_SYMBOL } from '@/lib/pair-symbols';
import { clock, fmt, pct } from '@/lib/desk-format';
import { migrationMarginLimit } from '@/lib/policy';
import {
  availablePairAccounts,
  pairConfigurationChanges,
  pairConfigurationLock,
  pairDataFresh,
  pairDeletionBlock,
  pairDraft,
  pairExecutionPhaseLabel,
  pairHasPending,
  pairMarginStatus,
  pairMarginOnly,
  pairNetQuantity,
  pairPhaseLabel,
  pairSnapshotStatus,
  pairStartRecoveryBlock,
  pairTransferStatus,
  parsePairDraft,
  type Pair,
  type PairBalance,
  type PairSnapshot,
  type PairTransfer,
} from '@/lib/pairs';

type Props = {
  pairs?: Pair[];
  accounts: Account[];
  events?: ExecutionEvent[];
  busy: boolean;
  ready: boolean;
  now: number;
  connectionError: string;
  error?: string;
  action: DeskAction;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
};
const EMPTY_PAIRS: Pair[] = [];
type PairSymbolsProps = {
  catalog: ReturnType<typeof usePairSymbols>;
  loadSymbols: () => void;
};

export function PairsWorkspace({ pairs, ...props }: Props) {
  const [selected, setSelected] = useState('');
  const [symbolsRequested, setSymbolsRequested] = useState(false);
  const catalog = usePairSymbols(symbolsRequested && !props.connectionError);
  const loadSymbols = () => setSymbolsRequested(true);
  const items = pairs ?? EMPTY_PAIRS;
  const pair = items.find((item) => item.id === selected) ?? items[0];
  const offline = Boolean(props.connectionError);
  const notices = usePairNotices(items, props.now, offline);
  return (
    <div className="feature-stack pair-workspace">
      <div className="pair-workspace-heading">
        <div>
          <h2>
            两子账户配对
            {pair ? ` · ${pair.symbol ?? DEFAULT_PAIR_SYMBOL.symbol}` : ''}
          </h2>
          <p className="muted">两子账户共同交易 · 保证金余额独立平衡</p>
        </div>
        <div className="account-controls">
          {pair ? (
            <Select
              value={pair.id}
              disabled={props.busy}
              onValueChange={(id) => {
                if (id) {
                  setSelected(id);
                  props.setError('');
                  props.setNotice('');
                }
              }}
            >
              <SelectTrigger aria-label="选择配对组">
                <SelectValue>
                  {pair.name} · {pair.symbol ?? DEFAULT_PAIR_SYMBOL.symbol}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {item.symbol ?? DEFAULT_PAIR_SYMBOL.symbol} ·{' '}
                    {item.enabled ? '执行已启用' : '执行已暂停'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <CreatePair
            {...props}
            pairs={items}
            catalog={catalog}
            loadSymbols={loadSymbols}
            supported={pairs !== undefined}
            selectPair={setSelected}
          />
        </div>
      </div>
      {pair ? (
        <PairDetail
          {...props}
          pairs={items}
          pair={pair}
          catalog={catalog}
          loadSymbols={loadSymbols}
          noticeObservation={notices.observations.get(pair.id)}
          clearNotices={() => notices.clear(pair.id)}
        />
      ) : (
        <section className="panel empty-state">
          <h3>{pairs === undefined ? '等待配对组服务' : '尚未创建配对组'}</h3>
          <p>
            {pairs === undefined
              ? '连接完成后将显示配对组；旧版服务需先更新。'
              : '先添加同一主账户下的两个子账户，再创建 A 只多、B 只空的配对组。'}
          </p>
        </section>
      )}
    </div>
  );
}

function CreatePair({
  accounts,
  pairs,
  busy,
  connectionError,
  error,
  action,
  setError,
  setNotice,
  supported,
  selectPair,
  catalog,
  loadSymbols,
}: Omit<Props, 'pairs'> &
  PairSymbolsProps & {
    pairs: Pair[];
    supported: boolean;
    selectPair: (id: string) => void;
  }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(pairDraft);
  const canCreate =
    supported && availablePairAccounts(accounts, pairs).length >= 2;
  const locked = busy || Boolean(connectionError);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          if (next) loadSymbols();
          setError('');
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="outline"
            disabled={locked || !canCreate}
            title={
              canCreate
                ? '创建暂停的配对组'
                : '需要两个未绑定的子账户与配对组服务'
            }
          />
        }
      >
        <Plus size={16} />
        新建配对组
      </DialogTrigger>
      <DialogContent className="pair-settings-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>新建配对组</DialogTitle>
          <DialogDescription>
            选择同一主账户下两个已暂停的子账户。其他标的和非本组方向的仓位可保留，创建后需单独启动。
          </DialogDescription>
        </DialogHeader>
        {error || connectionError ? (
          <p className="message message-error" role="alert">
            {error || connectionError}
          </p>
        ) : null}
        {catalog.loading ? (
          <output className="muted">正在读取可用配对标的…</output>
        ) : catalog.error ? (
          <div className="message message-error" role="alert">
            <p>{catalog.error}</p>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={catalog.retry}
            >
              重试读取标的
            </Button>
          </div>
        ) : null}
        <PairSettings
          draft={draft}
          setDraft={setDraft}
          accounts={accounts}
          pairs={pairs}
          editing={false}
          locked={locked || catalog.loading || !catalog.symbols.length}
          symbols={catalog.symbols}
          cancel={() => setDraft(pairDraft())}
          submit={async () => {
            try {
              const config = parsePairDraft(
                draft,
                accounts,
                pairs,
                undefined,
                catalog.symbols,
              );
              if (await action('/api/pairs', config)) {
                selectPair(config.id);
                setOpen(false);
                setDraft(pairDraft());
                setNotice('配对组已创建并保持暂停；核对两侧数据后可启动。');
              }
            } catch (error) {
              setError(
                error instanceof Error ? error.message : '配对组设置无效',
              );
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PairDetail({
  pair,
  pairs,
  accounts,
  events,
  busy,
  ready,
  now,
  connectionError,
  error,
  action,
  setError,
  setNotice,
  noticeObservation,
  clearNotices,
  catalog,
  loadSymbols,
}: Omit<Props, 'pairs'> &
  PairSymbolsProps & {
    pairs: Pair[];
    pair: Pair;
    noticeObservation?: PairNoticeState;
    clearNotices: () => void;
  }) {
  const draft = useAccountDraft(pair.id, pairDraft(pair));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const snapshots = pair.state?.snapshots;
  const marginOnly = pairMarginOnly(pair);
  const displayedBalances = marginOnly
    ? (pair.state?.margin_balances ?? snapshots)
    : snapshots;
  const symbol = pair.symbol ?? DEFAULT_PAIR_SYMBOL.symbol;
  const long = accounts.find((account) => account.id === pair.long_account_id);
  const short = accounts.find(
    (account) => account.id === pair.short_account_id,
  );
  const offline = Boolean(connectionError);
  const scheduledMarginWait = pairScheduledMarginWait(pair, now, offline);
  const dataWarning = noticeObservation?.data.group.confirmed ?? false;
  const net = pairNetQuantity(snapshots, symbol);
  const pending = pairHasPending(pair);
  const margin = pair.state?.margin;
  const reservedTransferOnly =
    !pair.state?.pending &&
    margin?.status === 'unknown' &&
    margin.trading_resume_allowed === true &&
    margin.blocks_trading === false;
  const configurationLock = pairConfigurationLock(pair);
  const deletionBlock = pairDeletionBlock(pair, now, offline);
  const locked = busy || offline || Boolean(configurationLock);
  const mode = pair.ordinary.enabled
    ? '普通市价共同开仓'
    : pair.cycle.enabled
      ? '两子账户多空循环'
      : '保证金管理（不开仓）';
  const progress =
    pair.cycle.enabled ||
    Object.values(pair.state?.progress?.quantities ?? {}).some(
      (quantity) => Number(quantity) !== 0,
    )
      ? pair.state?.progress
      : null;
  const utcDate =
    now > 0 && Number.isFinite(now)
      ? new Date(now * 1000).toISOString().slice(0, 10)
      : '';
  const dayVolume = pair.state?.daily_volume?.[utcDate];
  const lastBatch = pair.state?.last_batch;
  const startBlock = pair.enabled
    ? '配对组执行已启用；实际进度见下方状态'
    : !ready
      ? '等待服务就绪'
      : draft.dirty
        ? '请先保存或撤销设置草稿'
        : pairStartRecoveryBlock(pair);
  const reason = pair.state?.reason || pair.pause_reason;
  return (
    <>
      <section className="panel pair-status-panel" aria-label="配对组运行状态">
        <div className="section-head">
          <div>
            <h2>
              <span
                className={`run-indicator ${pair.enabled ? 'mint' : 'muted'}`}
              >
                <i />
                {pair.enabled ? '配对组执行已启用' : '配对组执行已暂停'}
              </span>
            </h2>
            <p className="muted">
              {mode} ·{' '}
              {long?.mode === 'live'
                ? '实盘'
                : long?.mode === 'paper'
                  ? '模拟'
                  : '环境待确认'}{' '}
              ·{' '}
              {pair.margin.enabled
                ? '自动保证金平衡已配置，组启用后可按条件划转'
                : '自动保证金平衡未开启'}
            </p>
          </div>
          <div className="account-run-actions">
            <Button
              disabled={busy || offline || Boolean(startBlock)}
              title={
                startBlock ||
                (marginOnly
                  ? '核验账户归属与余额后启动保证金平衡'
                  : '自动核对原订单与实际持仓；核验通过后保留实际平衡底仓，再按已保存配置启动')
              }
              onClick={() => void action(`/api/pairs/${pair.id}/enable`)}
            >
              <CirclePlay size={16} />
              启动配对组
            </Button>
            <Button
              variant="outline"
              disabled={busy || !pair.enabled}
              onClick={() => void action(`/api/pairs/${pair.id}/pause`)}
            >
              <CirclePause size={16} />
              暂停配对组
            </Button>
            {pair.state?.recovery_watch && !pair.state?.pending ? (
              <PairBaselineRecovery
                key={pair.id}
                pair={pair}
                disabled={busy || offline || !ready || draft.dirty}
                now={now}
                action={action}
                setNotice={setNotice}
              />
            ) : (
              <PairOrderRecovery
                pair={pair}
                disabled={busy || offline || !ready || draft.dirty}
                now={now}
                action={action}
                setNotice={setNotice}
              />
            )}
            <Button
              variant="outline"
              disabled={busy || offline || Boolean(configurationLock)}
              title="手动平仓后核对本组指定方向为空，并清除本组底仓记录"
              onClick={async () => {
                if (await action(`/api/pairs/${pair.id}/reconcile-flat`)) {
                  setNotice('本组仓位为空已核实，底仓记录已清除。');
                }
              }}
            >
              核对空仓
            </Button>
          </div>
        </div>
        <div className="cycle-live-state">
          <p className={pending ? 'amber' : ''} aria-live="polite">
            {pairExecutionPhaseLabel(pair)}
            {reason ? ` · ${reason}` : ''}
          </p>
          <PairOrderDiagnostics pair={pair} />
          <PairNotices
            pair={pair}
            now={now}
            offline={offline}
            observation={noticeObservation}
            dataPending={Boolean(
              noticeObservation &&
              noticeObservation.data.group.since !== null &&
              !dataWarning,
            )}
            clear={clearNotices}
          />
          {draft.dirty ? (
            <p className="amber">设置有未保存修改，请保存或撤销后启动。</p>
          ) : null}
          <p className="muted">
            组暂停会阻止新开仓和新划转；已成交循环继续减回本轮基线，既有订单与划转请求继续查询。
          </p>
          {!pair.enabled ? (
            <p className="muted">
              {marginOnly
                ? '启动时核验两个账户的归属与 USD1 余额；之后按余额差自动平衡，持仓标的和方向不影响划转。已有订单和划转记录继续按原编号核对。'
                : '启动会自动核对遗留普通开仓批次；订单全部结束且两侧数量一致时保留实际底仓，包括手动加仓。启动和核对不下单或划转，后续循环仅处理新增部分。未知划转重新读取两侧余额后自动归档跳过，不再额外预留旧金额；其他未决请求或循环仓位仍须先恢复。'}
            </p>
          ) : null}
        </div>
      </section>
      <div className="pair-sides">
        <PairSide
          side="long"
          symbol={symbol}
          account={long}
          snapshot={snapshots?.long}
          balance={displayedBalances?.long}
          marginOnly={marginOnly}
          now={now}
          offline={offline}
          baseLimit={pair.ordinary.margin_limit}
          cycle={pair.cycle.enabled}
          scheduledWait={Boolean(scheduledMarginWait)}
          dataWarning={noticeObservation?.data.long.confirmed ?? false}
        />
        <PairSide
          side="short"
          symbol={symbol}
          account={short}
          snapshot={snapshots?.short}
          balance={displayedBalances?.short}
          marginOnly={marginOnly}
          now={now}
          offline={offline}
          baseLimit={pair.ordinary.margin_limit}
          cycle={pair.cycle.enabled}
          scheduledWait={Boolean(scheduledMarginWait)}
          dataWarning={noticeObservation?.data.short.confirmed ?? false}
        />
      </div>
      <PairAccountPositions
        pair={pair}
        side="long"
        account={long}
        now={now}
        connectionError={connectionError}
      />
      <PairAccountPositions
        pair={pair}
        side="short"
        account={short}
        now={now}
        connectionError={connectionError}
      />
      <section className="panel" aria-label="配对数量与执行进度">
        <div className="section-head">
          <h2>配对执行</h2>
          <span className={`small-note ${dataWarning ? 'amber' : ''}`}>
            组状态 {clock(pair.state?.updated_at)}
            {scheduledMarginWait
              ? ' · 按计划检查'
              : dataWarning
                ? ' · 过期或不完整'
                : ''}
          </span>
        </div>
        <dl className="cycle-key-values">
          {!marginOnly ? (
            <div>
              <dt>{symbol} 净数量 · 多 − 空</dt>
              <dd className={net !== null && Number(net) !== 0 ? 'amber' : ''}>
                {net ?? '—'}
              </dd>
              <small>本组指定方向的实际仓位；缺失不按零计算</small>
            </div>
          ) : null}
          <div>
            <dt>本轮循环状态</dt>
            <dd>
              {progress
                ? pairPhaseLabel(progress.phase)
                : pair.state
                  ? '无活动循环'
                  : '循环状态尚未提供'}
            </dd>
            <small>
              {progress?.opened_at
                ? `开仓确认 ${clock(progress.opened_at)}`
                : pair.cycle.enabled
                  ? '尚无本轮开仓确认记录，执行进度见上方状态'
                  : '普通底仓不参与循环减回'}
            </small>
          </div>
          <div>
            <dt>订单与风险恢复</dt>
            <dd className={pending ? 'amber' : ''}>
              {pending
                ? reservedTransferOnly
                  ? '划转待核对'
                  : '继续查询 / 恢复'
                : pair.state
                  ? '无待确认请求'
                  : '等待状态'}
            </dd>
            <small>
              {marginOnly
                ? pending
                  ? '保证金管理可独立启动；已有请求继续核对，划转按最新余额单独评估'
                  : '按两个账户的 USD1 可用余额独立平衡'
                : pending
                  ? reservedTransferOnly
                    ? pair.enabled
                      ? '交易按新余额及预留金额继续检查；原划转保留，不重复或新增划转'
                      : '可重新启动并核验账户；交易继续预留未知转出金额'
                    : !pair.enabled && !pairStartRecoveryBlock(pair)
                      ? '可直接点击启动自动核对；原单全部结束后，保留已核验的实际平衡底仓'
                      : '结果未明时停止新增，继续核对原订单与恢复状态'
                  : '单侧异常时由配对组统一处理'}
            </small>
          </div>
        </dl>
        {progress ? (
          <dl className="saved-settings">
            <div>
              <dt>本轮新增数量 · A 多 / B 空</dt>
              <dd>
                {progress.quantities?.LONG ?? '—'} /{' '}
                {progress.quantities?.SHORT ?? '—'}
              </dd>
            </div>
            <div>
              <dt>本轮基线数量 · A 多 / B 空</dt>
              <dd>
                {progress.baseline?.LONG ?? '—'} /{' '}
                {progress.baseline?.SHORT ?? '—'}
              </dd>
            </div>
          </dl>
        ) : null}
        <dl className="saved-settings">
          <div>
            <dt>普通底仓数量 · A 多 / B 空</dt>
            <dd>
              {pair.state?.owned?.LONG ?? '—'} /{' '}
              {pair.state?.owned?.SHORT ?? '—'}
            </dd>
          </div>
          <div>
            <dt>最近批次</dt>
            <dd>
              {lastBatch
                ? `${lastBatch.kind === 'cycle' ? '循环' : '普通'}${lastBatch.phase === 'open' ? '开仓' : '减回'} · ${lastBatch.resolution === 'manual_skip' ? '已手动跳过，启动时核实底仓' : lastBatch.completed ? '成交与持仓已核实' : '本批跟踪已结束，实际底仓已核实'} · ${clock(lastBatch.at)}`
                : '暂无记录'}
            </dd>
          </div>
        </dl>
      </section>
      <PairCycleCostsPanel
        report={pair.state?.cycle_costs}
        stale={noticeObservation?.data.costs.confirmed ?? false}
      />
      <section className="panel" aria-label="配对组当日成交量">
        <div className="section-head">
          <h2>两侧当日成交量</h2>
          <span className="small-note">{utcDate || '日期待确认'} · UTC</span>
        </div>
        <dl className="saved-settings">
          <div>
            <dt>A 多账户 · USD1</dt>
            <dd>{fmt(dayVolume?.long)}</dd>
          </div>
          <div>
            <dt>B 空账户 · USD1</dt>
            <dd>{fmt(dayVolume?.short)}</dd>
          </div>
        </dl>
        <div className="cycle-live-state">
          <p className="muted">
            仅计本组普通、循环及风险恢复的实际成交；两个子账户分别累计。
          </p>
          {pair.state?.volume_unknown ? (
            <p className="amber">
              部分成交时间或日期归属未知，已显示成交量可能不完整，等待核对。
            </p>
          ) : null}
        </div>
      </section>
      <section className="panel" aria-label="保证金平衡状态">
        <div className="section-head">
          <h2>保证金平衡</h2>
          <span
            className={`small-note ${margin?.blocks_trading ? 'amber' : ''}`}
          >
            {pairMarginStatus(margin)}
          </span>
        </div>
        <div className="cycle-live-state" aria-live="polite">
          <p>
            {margin?.reason ||
              (pair.margin.enabled ? '等待平衡检查' : '未开启自动保证金平衡')}
          </p>
          {margin?.pending ? (
            <p className="amber">
              {pairTransferStatus(margin.pending)}：
              <TransferSummary transfer={margin.pending} />
              {margin.trading_resume_allowed && !margin.blocks_trading
                ? '。等待重新读取两侧余额后自动跳过；读取成功前仍预留旧金额，原请求不重发。'
                : margin.pending.status === 'acknowledged'
                  ? '。继续读取两侧余额，刷新完成前不重新划转或开始新开仓。'
                  : margin.pending.status === 'unknown' ||
                      margin.pending.status === 'submitting'
                    ? '。重新读取两侧余额后自动归档跳过，不再额外预留旧金额；原请求不重发，也不标记成功。'
                    : '。只读核对，缺少可靠结果时保留待确认状态，不重新划转或开始新开仓。'}
            </p>
          ) : null}
        </div>
        <dl className="saved-settings">
          <div>
            <dt>最后划转</dt>
            <dd>
              {margin?.last_transfer ? (
                <>
                  <TransferSummary transfer={margin.last_transfer} />
                  <small>
                    {pairTransferStatus(margin.last_transfer)} ·{' '}
                    {clock(
                      margin.last_transfer.skipped_at ??
                        margin.last_transfer.refreshed_at ??
                        margin.last_transfer.confirmed_at ??
                        margin.last_transfer.acknowledged_at ??
                        margin.last_transfer.created_at,
                    )}
                  </small>
                </>
              ) : (
                '暂无已记录划转'
              )}
            </dd>
          </div>
          <div>
            <dt>最近平衡检查</dt>
            <dd>
              {clock(margin?.checked_at)}
              <small>
                {pair.margin.check_interval_seconds} 秒检查 ·{' '}
                {pair.margin.cooldown_seconds} 秒冷却
                {margin?.cooldown_until && margin.cooldown_until > now
                  ? ` · 剩余 ${Math.ceil(margin.cooldown_until - now)} 秒`
                  : ''}
              </small>
            </dd>
          </div>
          <div>
            <dt>触发可用余额差额 / 单次划转范围</dt>
            <dd>
              {fmt(pair.margin.threshold)} / {fmt(pair.margin.min_transfer)}–
              {fmt(pair.margin.max_transfer)} USD1
            </dd>
          </div>
          <div>
            <dt>转出侧现金保留</dt>
            <dd>
              正权益 × {pct(pair.margin.buffer_ratio)}
              <small>
                按交易所可划额度平衡 USD1 可用余额，与持仓标的和开仓占用上限无关
              </small>
            </dd>
          </div>
        </dl>
      </section>
      <details className="disclosure panel">
        <summary>配对循环成交质量</summary>
        <CycleQualityHistoryPanel
          key={pair.id}
          scope="pair"
          accountName={`配对组 · ${pair.name}`}
          quality={pair.state?.execution_quality}
          history={pair.state?.execution_quality_history}
          stale={noticeObservation?.data.runtime.confirmed ?? false}
        />
      </details>
      <details className="disclosure panel">
        <summary>配对执行记录</summary>
        <ExecutionEvents
          events={(events ?? []).filter(
            (event) =>
              event.account_id === pair.id ||
              event.account_id === pair.long_account_id ||
              event.account_id === pair.short_account_id,
          )}
        />
      </details>
      <details
        className="disclosure panel settings-panel pair-config"
        onToggle={(event) => {
          if (event.currentTarget.open) loadSymbols();
        }}
      >
        <summary>配对组设置{draft.dirty ? ' · 未保存' : ''}</summary>
        {configurationLock ? (
          <p className="settings-lock amber">{configurationLock}</p>
        ) : null}
        {error ? (
          <p className="message message-error" role="alert">
            {error}
          </p>
        ) : null}
        {catalog.loading ? (
          <output className="muted">正在读取可用配对标的…</output>
        ) : catalog.error ? (
          <div className="message message-error" role="alert">
            <p>{catalog.error}；仍可保留原标的并保存其他设置。</p>
            <Button
              type="button"
              variant="outline"
              disabled={busy || offline}
              onClick={catalog.retry}
            >
              重试读取标的
            </Button>
          </div>
        ) : null}
        <PairSettings
          draft={draft.value}
          setDraft={draft.setValue}
          accounts={accounts}
          pairs={pairs}
          editing
          locked={locked}
          symbols={catalog.symbols}
          cancel={draft.clear}
          submit={async () => {
            try {
              const config = pairConfigurationChanges(
                parsePairDraft(
                  draft.value,
                  accounts,
                  pairs,
                  pair.id,
                  catalog.symbols,
                ),
              );
              if (await action(`/api/pairs/${pair.id}`, config, 'PATCH')) {
                draft.clear();
                setNotice('配对组设置已保存并保持暂停。');
              }
            } catch (error) {
              setError(
                error instanceof Error ? error.message : '配对组设置无效',
              );
            }
          }}
        />
      </details>
      <details className="disclosure panel">
        <summary>解除配对组</summary>
        <div className="pair-delete-content">
          <p className="muted">
            删除配对组后释放两个账户，保留账户与历史记录。服务会重新读取两侧账户，确认组已暂停、本组仓位为空，且无待确认订单或划转。仍保留旧订单观察时，还需核实两账户完全空仓后才能解除绑定。
          </p>
          {deletionBlock ? <p className="amber">{deletionBlock}</p> : null}
          <Button
            variant="destructive"
            disabled={busy || Boolean(deletionBlock)}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={16} />
            删除配对组
          </Button>
        </div>
      </details>
      <Dialog
        open={deleteOpen}
        onOpenChange={(value) => !busy && setDeleteOpen(value)}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>删除配对组“{pair.name}”？</DialogTitle>
            <DialogDescription>
              解除 A 与 B 的配对绑定，保留账户及历史记录。
            </DialogDescription>
          </DialogHeader>
          {deletionBlock ? <p className="amber">{deletionBlock}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || Boolean(deletionBlock)}
              onClick={async () => {
                if (
                  await action(`/api/pairs/${pair.id}`, undefined, 'DELETE')
                ) {
                  setDeleteOpen(false);
                  setNotice('配对组已删除，两侧账户已解除绑定。');
                }
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PairSide({
  side,
  symbol,
  account,
  snapshot,
  balance,
  marginOnly,
  now,
  offline,
  baseLimit,
  cycle,
  scheduledWait,
  dataWarning,
}: {
  side: 'long' | 'short';
  symbol: string;
  account?: Account;
  snapshot?: PairSnapshot | null;
  balance?: PairBalance | null;
  marginOnly: boolean;
  now: number;
  offline: boolean;
  baseLimit: string;
  cycle: boolean;
  scheduledWait: boolean;
  dataWarning: boolean;
}) {
  if (marginOnly) {
    const fresh = pairDataFresh(balance?.timestamp, now, offline);
    return (
      <section
        className="panel pair-side"
        aria-label={side === 'long' ? 'A 账户保证金' : 'B 账户保证金'}
      >
        <div className="section-head">
          <div>
            <h2>
              {side === 'long' ? 'A' : 'B'} · {account?.name ?? '账户待确认'}
            </h2>
            <p className={dataWarning ? 'amber' : 'muted'}>
              {scheduledWait
                ? '上次余额检查'
                : fresh
                  ? '余额已更新'
                  : dataWarning || !balance
                    ? '等待余额检查'
                    : '上次余额检查'}{' '}
              · {clock(balance?.timestamp)}
            </p>
          </div>
        </div>
        <dl className="pair-risk-values">
          <div>
            <dt>权益 · USD1</dt>
            <dd>{fmt(balance?.equity)}</dd>
          </div>
          <div>
            <dt>可用 · USD1</dt>
            <dd>{fmt(balance?.available)}</dd>
          </div>
        </dl>
        <p className="muted">按账户可用余额平衡，不限制持仓标的和方向。</p>
      </section>
    );
  }
  const fresh = pairDataFresh(snapshot?.timestamp, now, offline);
  const positions = snapshot?.positions.filter(
    (position) => position.symbol === symbol && Number(position.qty) !== 0,
  );
  const reverse = positions?.some(
    (position) => position.side !== (side === 'long' ? 'LONG' : 'SHORT'),
  );
  const highLimit = migrationMarginLimit(baseLimit);
  const limit =
    cycle || positions?.some((position) => [10, 20].includes(position.leverage))
      ? highLimit
      : baseLimit;
  return (
    <section
      className="panel pair-side"
      aria-label={side === 'long' ? 'A 多仓账户风险' : 'B 空仓账户风险'}
    >
      <div className="section-head">
        <div>
          <h2>
            {side === 'long' ? 'A · 本组做多' : 'B · 本组做空'}{' '}
            <span className="muted">{account?.name ?? '账户待确认'}</span>
          </h2>
          <p className={dataWarning ? 'amber' : 'muted'}>
            {scheduledWait
              ? '上次检查快照'
              : !fresh && !dataWarning && snapshot
                ? '最近记录'
                : pairSnapshotStatus(snapshot, now, offline)}{' '}
            · {clock(snapshot?.timestamp)}
          </p>
        </div>
      </div>
      <dl className="pair-risk-values">
        <div>
          <dt>权益 · USD1</dt>
          <dd>{fmt(snapshot?.equity)}</dd>
        </div>
        <div>
          <dt>可用 · USD1</dt>
          <dd>{fmt(snapshot?.available)}</dd>
        </div>
        <div>
          <dt>保证金占用率</dt>
          <dd
            className={
              snapshot?.ratio != null && Number(snapshot.ratio) > Number(limit)
                ? 'danger'
                : ''
            }
          >
            {pct(snapshot?.ratio)}
          </dd>
          <small>
            {cycle
              ? `循环上限 ${pct(highLimit)}`
              : `5x ≤ ${pct(baseLimit)} · 10x / 20x ≤ ${pct(highLimit)}`}
          </small>
        </div>
        <div>
          <dt>维持保证金率</dt>
          <dd>{pct(snapshot?.margin_ratio)}</dd>
          <small>维持保证金 ÷ 本侧权益</small>
        </div>
      </dl>
      <div className="cycle-live-state">
        <p className="muted">
          {symbol} 持仓：
          {positions === undefined
            ? '等待数据'
            : positions.length
              ? positions
                  .map(
                    (position) =>
                      `${position.side === 'LONG' ? '多' : '空'} ${position.qty} · ${position.leverage}x`,
                  )
                  .join(' / ')
              : '无持仓'}
        </p>
        {reverse ? (
          <p className="muted">
            本组只管理指定方向；反向仓位保留，存在时不会自动升杠杆。
          </p>
        ) : null}
        {snapshot && !snapshot.mode_checks?.hedge ? (
          <p className="amber">
            {snapshot.mode_checks?.hedge === false
              ? '最近快照未通过双向持仓模式（Hedge Mode）核验。请在交易所调整后重新核对，程序不会自动切换。'
              : '双向持仓模式（Hedge Mode）结果尚未提供，等待账户核验；程序不会自动切换。'}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TransferSummary({ transfer }: { transfer: PairTransfer }) {
  return (
    <>
      {transfer.source === 'long' ? 'A' : 'B'} →{' '}
      {transfer.destination === 'long' ? 'A' : 'B'} · {fmt(transfer.amount)}{' '}
      USD1
    </>
  );
}
