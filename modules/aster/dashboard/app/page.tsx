'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Bell,
  CirclePause,
  CirclePlay,
  Layers3,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTradingDesk } from '@/lib/use-trading-desk';
import { useAccountDraft } from '@/lib/use-account-draft';
import { fmt, pct, clock } from '@/lib/desk-format';
import { cycleDraft, cycleRecoveryReason } from '@/lib/cycle';
import { accountRunScope } from '@/lib/account-scope';
import { accountSummaryView } from '@/lib/account-summary';
import { cycleMarginLimit } from '@/lib/policy';
import { CyclePanel } from '@/components/cycle-panel';
import { CycleRecovery } from '@/components/cycle-recovery';
import { OrdinaryWorkspace } from '@/components/ordinary-workspace';
import { MigrationPanel } from '@/components/migration-panel';
import { AccountOverview } from '@/components/account-overview';
import { RecordsWorkspace } from '@/components/records-workspace';
import { AddAccountDialog } from '@/components/add-account-dialog';
import { SymbolMonitorCenter } from '@/components/symbol-monitor-center';
import { PairsWorkspace } from '@/components/pairs-workspace';
import { CapacityRelayPanel } from '@/components/capacity-relay-panel';
import { notificationOverview } from '@/lib/notification-channels';

export default function Home() {
  const desk = useTradingDesk();
  // Session changes unmount the feature workspace and discard its private drafts.
  return (
    <Desk key={desk.needsLogin ? 'signed-out' : 'signed-in'} desk={desk} />
  );
}
function Desk({ desk }: { desk: ReturnType<typeof useTradingDesk> }) {
  const {
    state,
    selected,
    selectAccount,
    error,
    setError,
    errorAccountId,
    connectionError,
    needsLogin,
    busy,
    serverNow,
    notice,
    setNotice,
    action,
    refresh,
  } = desk;
  const [workspace, setWorkspace] = useState('pairs');
  const selectedAccount = state?.accounts.find(
    (account) => account.id === selected,
  );
  const binding = state?.pairs?.find(
    (pair) =>
      pair.long_account_id === selected || pair.short_account_id === selected,
  );
  const account =
    selectedAccount && binding
      ? { ...selectedAccount, pair_id: binding.id }
      : selectedAccount;
  const pairBound = Boolean(account?.pair_id);
  const pairProps = {
    pairs: state?.pairs,
    notification: state?.notification,
    feishuEnabled: state?.monitoring?.settings.feishu_enabled,
    onNotificationSettings: () => setWorkspace('monitoring'),
    accounts: state?.accounts ?? [],
    events: state?.events ?? [],
    busy,
    ready: Boolean(state?.ready),
    now: serverNow,
    connectionError,
    error,
    action,
    setError,
    setNotice,
  };
  const monitoringProps = {
    state,
    now: serverNow,
    refresh,
    busy,
    connectionError,
    action,
  };
  const cycle = useAccountDraft(selected, cycleDraft(account?.cycle));
  const recoveryReason = cycleRecoveryReason(account, {
    accountId: errorAccountId,
    message: error,
  });
  const accountMessage =
    recoveryReason ||
    (account && ['error', 'attention'].includes(account.status)
      ? account.reason
      : '');
  const separateError = error === accountMessage ? '' : error;
  const canStart = Boolean(
    account &&
    !pairBound &&
    !account.enabled &&
    state?.ready &&
    !connectionError &&
    !cycle.dirty,
  );
  const stale =
    Boolean(connectionError) ||
    !state?.updated_at ||
    serverNow - state.updated_at >= 8;
  const snapshotView = accountSummaryView(
    account,
    binding,
    serverNow,
    connectionError,
  );
  const snapshot = snapshotView.snapshot;
  const events =
    state?.events.filter(
      (event) =>
        !selected ||
        event.account_id === selected ||
        event.account_id === binding?.id ||
        !event.account_id,
    ) ?? [];
  const featureProps = account
    ? { account, busy: busy || pairBound, action, setError, setNotice }
    : null;
  const modes = account ? accountRunScope(account) : '';
  const riskLimit = account?.cycle?.enabled
    ? cycleMarginLimit(account.risk_limits)
    : (account?.risk_limits?.high_leverage ?? account?.policy.margin_limit);
  const marginTone =
    snapshot?.ratio == null || riskLimit == null
      ? ''
      : Number(snapshot.ratio) > Number(riskLimit)
        ? 'danger'
        : Number(snapshot.ratio) > Number(account?.policy.margin_limit)
          ? 'amber'
          : '';
  return (
    <main className="desk focused-desk">
      <header className="topbar">
        <div className="brand">
          <Layers3 size={22} />
          <span>
            ASTER<span className="brand-separator">/</span>
            <small>交易管理</small>
          </span>
        </div>
      </header>
      <div className="workspace">
        <div className="page-heading">
          <div className="flex items-center gap-3">
            <h1>交易工作台</h1>
            {desk.hubConnected && (
              <Button variant="ghost" onClick={desk.openAssets}>
                查看资产账本
              </Button>
            )}
          </div>
          <div className="account-controls">
            <div className="toolbar">
              <span
                className={`connection ${connectionError ? 'danger' : ''}`}
              >
                <i />
                {connectionError
                  ? '连接异常'
                  : state?.demo
                    ? '模拟环境'
                    : state
                      ? '服务已连接'
                      : '等待连接'}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新数据"
                disabled={busy}
                onClick={refresh}
              >
                <RefreshCw size={17} />
              </Button>
            </div>
            {account && workspace !== 'pairs' && (
              <Select
                value={selected}
                disabled={busy}
                onValueChange={(v) => {
                  if (!v) return;
                  selectAccount(v);
                  setError('');
                  setNotice('');
                }}
              >
                <SelectTrigger className="account-select" aria-label="选择账户">
                  <Wallet size={16} />
                  <SelectValue>{account.name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {state?.accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} · {a.mode === 'live' ? '实盘' : '模拟'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <AddAccountDialog
              busy={busy}
              action={action}
              selectAccount={selectAccount}
              available={Boolean(state)}
            />
          </div>
        </div>
        {state && !needsLogin ? (
          <CapacityRelayPanel
            relay={state.capacity_relay}
            now={serverNow}
            updatedAt={state.updated_at}
            connectionError={connectionError}
            demo={state.demo}
          />
        ) : null}
        {(separateError || connectionError || notice) && (
          <output
            className={`message ${separateError || connectionError ? 'message-error' : ''}`}
          >
            {separateError || connectionError || notice}
          </output>
        )}
        {account && accountMessage && workspace !== 'pairs' && (
          <div className="message message-error cycle-recovery-message">
            <output>{accountMessage}</output>
            {recoveryReason ? (
              <CycleRecovery
                key={account.id}
                accountId={account.id}
                accountName={account.name}
                disabled={busy || pairBound || Boolean(connectionError)}
                action={action}
                setNotice={setNotice}
              />
            ) : null}
          </div>
        )}
        {needsLogin && (
          <section className="login-panel panel">
            <ShieldCheck size={27} />
            <h2>工作台会话已过期</h2>
            <p className="muted">请回到工作台重新登录，再打开 Aster 5x。</p>
          </section>
        )}

        {!needsLogin && account && featureProps ? (
          <>
            {workspace !== 'pairs' ? (
              <>
                <section className="account-bar" aria-label="账户状态与总开关">
                  <div className="account-run-state">
                    <span
                      className={`run-indicator ${(binding ? binding.enabled : account.enabled) ? 'mint' : 'muted'}`}
                    >
                      <i />
                      {binding
                        ? binding.enabled
                          ? '配对组已启用'
                          : '配对组已暂停'
                        : account.enabled
                          ? '账户执行已启用'
                          : '账户执行已暂停'}
                    </span>
                    <p>
                      {pairBound
                        ? `由配对组「${binding?.name ?? account.pair_id}」统一管理，旧账户交易入口已禁用。`
                        : `已保存的执行范围：${modes}；是否下单以各功能检查结果为准。`}
                    </p>
                  </div>
                  <div className="account-run-actions">
                    <Button
                      disabled={busy || !canStart}
                      title={
                        pairBound
                          ? '请到配对组管理此账户'
                          : cycle.dirty
                            ? '请先保存或撤销循环草稿'
                            : '按已保存配置启动账户的全部已启用功能'
                      }
                      onClick={() =>
                        void action(`/api/accounts/${account.id}/enable`)
                      }
                    >
                      <CirclePlay size={16} />
                      启动账户
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || pairBound || !account.enabled}
                      onClick={() =>
                        void action(`/api/accounts/${account.id}/pause`)
                      }
                    >
                      <CirclePause size={16} />
                      暂停账户
                    </Button>
                    {account.status === 'attention' ? (
                      <Button
                        variant="outline"
                        disabled={busy || pairBound}
                        onClick={() =>
                          void action(`/api/accounts/${account.id}/retry`)
                        }
                      >
                        核对未完成批次
                      </Button>
                    ) : null}
                  </div>
                  {cycle.dirty ? (
                    <p className="draft-notice amber">
                      循环设置有未保存修改，请到「多空循环」保存或撤销。
                    </p>
                  ) : null}
                </section>
                <section className="account-strip" aria-label="账户关键数据">
                  <dl>
                    <div>
                      <dt>权益 · USD1</dt>
                      <dd>{fmt(snapshot?.equity)}</dd>
                    </div>
                    <div>
                      <dt>可用 · USD1</dt>
                      <dd>{fmt(snapshot?.available)}</dd>
                    </div>
                    <div>
                      <dt
                        title={
                          snapshotView.fundsOnly
                            ? '仅保证金模式只检查账户余额，不重新计算持仓占用率'
                            : undefined
                        }
                      >
                        保证金占用率{snapshotView.fundsOnly ? ' · 未采集' : ''}
                      </dt>
                      <dd className={marginTone}>{pct(snapshot?.ratio)}</dd>
                    </div>
                  </dl>
                  <span
                    className={`snapshot-stamp ${snapshotView.warning ? 'amber' : ''}`}
                    title={snapshotView.notice}
                  >
                    {snapshot && snapshotView.elapsed !== null
                      ? `${snapshotView.label} ${new Date(snapshot.timestamp * 1000).toLocaleString('zh-CN', { hour12: false })}${snapshotView.elapsed ? ` · ${snapshotView.elapsed}` : ''}`
                      : snapshotView.label}
                    {state?.demo ? ' · 模拟环境' : ''}
                  </span>
                </section>
              </>
            ) : null}
            <Tabs
              value={workspace}
              onValueChange={(value) => setWorkspace(String(value))}
              className="workspace-tabs"
            >
              <TabsList
                variant="line"
                aria-label="工作台功能"
                className="workspace-navigation"
              >
                <TabsTrigger value="pairs">配对组</TabsTrigger>
                <TabsTrigger value="cycle" disabled={pairBound}>
                  多空循环{pairBound ? ' · 组管理' : ''}
                </TabsTrigger>
                <TabsTrigger value="ordinary" disabled={pairBound}>
                  普通开仓{pairBound ? ' · 组管理' : ''}
                </TabsTrigger>
                <TabsTrigger value="migration" disabled={pairBound}>
                  仓位迁移{pairBound ? ' · 组管理' : ''}
                </TabsTrigger>
                <TabsTrigger value="monitoring">币种监控中心</TabsTrigger>
                <TabsTrigger value="account">账户</TabsTrigger>
                <TabsTrigger value="records">记录</TabsTrigger>
              </TabsList>
              <TabsContent value="pairs" keepMounted>
                <PairsWorkspace {...pairProps} />
              </TabsContent>
              <TabsContent value="cycle" keepMounted>
                <CyclePanel
                  {...featureProps}
                  draft={cycle.value}
                  setDraft={cycle.setValue}
                  clearDraft={cycle.clear}
                  now={serverNow}
                  dataTimestamp={state?.updated_at}
                  connectionError={connectionError}
                />
              </TabsContent>
              <TabsContent value="ordinary" keepMounted>
                <OrdinaryWorkspace
                  {...featureProps}
                  markets={state?.markets ?? {}}
                  now={serverNow}
                  connectionError={connectionError}
                />
              </TabsContent>
              <TabsContent value="migration" keepMounted>
                <MigrationPanel
                  {...featureProps}
                  connectionError={connectionError}
                />
              </TabsContent>
              <TabsContent value="account" keepMounted>
                <AccountOverview
                  {...featureProps}
                  now={serverNow}
                  connectionError={connectionError}
                  pair={binding}
                />
              </TabsContent>
              <TabsContent value="monitoring">
                <SymbolMonitorCenter {...monitoringProps} />
              </TabsContent>
              <TabsContent value="records">
                <RecordsWorkspace
                  account={account}
                  pair={binding}
                  events={events}
                  now={serverNow}
                  stale={stale}
                />
              </TabsContent>
            </Tabs>
            <footer className="footer">
              <span>
                <Bell size={13} /> {notificationOverview(state?.notification)}
              </span>
              <span>
                {state?.accounts.length} 个账户 · 更新{' '}
                {clock(state?.updated_at)}
              </span>
            </footer>
          </>
        ) : !needsLogin ? (
          <>
            <Tabs
              value={workspace}
              onValueChange={(value) => setWorkspace(String(value))}
              className="workspace-tabs"
            >
              <TabsList
                variant="line"
                aria-label="监控功能"
                className="workspace-navigation"
              >
                <TabsTrigger value="pairs">配对组</TabsTrigger>
                <TabsTrigger value="monitoring">币种监控中心</TabsTrigger>
              </TabsList>
              <TabsContent value="pairs" keepMounted>
                <PairsWorkspace {...pairProps} />
              </TabsContent>
              <TabsContent value="monitoring">
                <SymbolMonitorCenter {...monitoringProps} />
              </TabsContent>
            </Tabs>
            <section className="panel empty-state">
              <h2>{state ? '添加账户以管理交易' : '正在连接交易服务'}</h2>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
