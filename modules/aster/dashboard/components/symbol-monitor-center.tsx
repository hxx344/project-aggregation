'use client';
import { useRef, useState } from 'react';
import type { DeskAction, State } from '@/lib/desk-types';
import { computeFreshness, computeSymbolView } from '@/lib/monitoring-status';
import type { SymbolMonitorStatus } from '@/lib/monitoring-status';
import { fmt } from '@/lib/desk-format';
import { notificationChannel } from '@/lib/notification-channels';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  SymbolStatusBadge,
  symbolStatusLabels,
} from '@/components/symbol-status-badge';
import {
  FreshnessIndicator,
  monitoringDate,
} from '@/components/freshness-indicator';
import { NotificationTypesPicker } from '@/components/notification-types-picker';
import {
  MonitorChannels,
  MonitorSettings,
} from '@/components/monitor-settings';
import { MonitorCapacityTable } from '@/components/monitor-capacity-table';

const exchangeStatuses: Record<string, string> = {
  TRADING: '交易中',
  PENDING_TRADING: '待上线',
  PRE_SETTLE: '预结算',
  SETTLING: '结算中',
  CLOSE: '已下架',
  MISSING: '本次列表未返回',
};

export function SymbolMonitorCenter({
  state,
  now,
  busy,
  connectionError,
  action,
  refresh,
}: {
  state?: State | null;
  now: number;
  busy: boolean;
  connectionError: string;
  action: DeskAction;
  refresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SymbolMonitorStatus | 'all'>('all');
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const monitoring = state?.monitoring;
  if (!monitoring)
    return (
      <section className="panel empty-state">
        <p>
          {connectionError
            ? '监控设置读取失败，请恢复连接后重试。'
            : '正在读取监控设置…'}
        </p>
      </section>
    );
  const listings = state?.listings;
  const settings = monitoring.settings;
  const demo = Boolean(state?.demo);
  const disabled = busy || pending || Boolean(connectionError) || demo;
  const save = async (body: object, symbol?: string) => {
    if (disabled || saving.current) return false;
    saving.current = true;
    setPending(true);
    try {
      return await action(
        symbol
          ? `/api/monitoring/symbols/${encodeURIComponent(symbol)}`
          : '/api/monitoring',
        body,
        'PATCH',
      );
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  const controls = new Map(monitoring.symbols.map((row) => [row.symbol, row]));
  const symbols = [
    ...new Set([...controls.keys(), ...Object.keys(listings?.rows ?? {})]),
  ];
  const rows = symbols
    .map((symbol) => {
      const control = controls.get(symbol);
      const listing = listings?.rows[symbol];
      return {
        symbol,
        control,
        listing,
        view: computeSymbolView(
          control ?? { monitor_enabled: true },
          listing,
          listings,
          now,
          {
            monitoringEnabled: settings.monitoring_enabled,
            demo,
            connectionError: Boolean(connectionError),
          },
        ),
      };
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.listing?.is_new)) -
          Number(Boolean(a.listing?.is_new)) ||
        (b.listing?.onboard_at ?? 0) - (a.listing?.onboard_at ?? 0) ||
        a.symbol.localeCompare(b.symbol),
    );
  const normalizedQuery = query.trim().toUpperCase();
  const filtered = rows.filter(
    (row) =>
      row.symbol.includes(normalizedQuery) &&
      (filter === 'all' || row.view.status === filter),
  );
  const eventChannel = notificationChannel(state?.notification, 'event');
  return (
    <div className="monitoring-workspace symbol-monitor-center">
      <MonitorCapacityTable
        monitoring={monitoring}
        listings={listings}
        now={now}
        demo={demo}
        connectionError={connectionError}
      />
      <MonitorSettings
        monitoring={monitoring}
        notification={state?.notification}
        demo={demo}
        disabled={disabled}
        pending={pending}
        save={save}
      />
      <section className="panel monitor-list">
        <div className="section-head">
          <div>
            <h2>USD1 币种</h2>
            <p>
              公开可用额度为最大杠杆下公开剩余额度与档位上限的较小值，单位
              USD1。
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy || pending}
            onClick={refresh}
          >
            刷新数据
          </Button>
        </div>
        <div className="monitor-filter">
          <Input
            aria-label="搜索监控币种"
            placeholder="搜索币种，例如 XAU、BTC"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="monitor-status-filter">
            状态
            <select
              aria-label="筛选监控状态"
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as SymbolMonitorStatus | 'all')
              }
            >
              <option value="all">全部状态</option>
              {(
                Object.entries(symbolStatusLabels) as [
                  SymbolMonitorStatus,
                  string,
                ][]
              ).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <output className="small-note">
            {filtered.length} / {rows.length} 个币种
          </output>
        </div>
        <div className="monitor-catalog-status">
          <span>
            {!settings.monitoring_enabled
              ? '独立监控已暂停'
              : !settings.auto_discover
                ? '目录扫描已暂停，已有币种仍按设置采样'
                : `目录每 ${listings?.poll_seconds ?? 60} 秒检查`}
          </span>
          <FreshnessIndicator
            freshness={computeFreshness(
              listings?.checked_at,
              now,
              listings?.stale_seconds,
            )}
            label="目录"
          />
          {listings?.error ? (
            <span className="amber">{listings.error}</span>
          ) : null}
          {connectionError ? (
            <span className="amber">
              连接中断，显示上次数据；配置不可修改。
            </span>
          ) : null}
        </div>
        <div
          className="table-scroll"
          aria-label="币种监控、通知与公开额度，可横向滚动"
        >
          <Table className="monitor-center-table">
            <TableHeader>
              <TableRow>
                <TableHead>币种 / 状态</TableHead>
                <TableHead>监控</TableHead>
                <TableHead>通知</TableHead>
                <TableHead className="number">
                  最大杠杆 / 公开额度 · USD1
                </TableHead>
                <TableHead>数据新鲜度</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(({ symbol, control, listing, view }) => (
                <TableRow key={symbol} data-symbol={symbol}>
                  <TableCell>
                    <strong>{symbol}</strong>
                    <small>
                      {listing?.is_new ? '新发现 · ' : ''}
                      {control?.strategy_market ? '策略品种' : 'USD1 永续'}
                    </small>
                    <SymbolStatusBadge status={view.status} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`${symbol} 监控`}
                      checked={Boolean(control?.monitor_enabled)}
                      disabled={disabled || !control}
                      onCheckedChange={(value) =>
                        void save({ monitor_enabled: value }, symbol)
                      }
                    />
                    {control?.required_by.length ? (
                      <small
                        title={`关联账户：${control.required_by.join('、')}`}
                      >
                        交易保留采样
                      </small>
                    ) : null}
                  </TableCell>
                  <TableCell className="monitor-notification-cell">
                    {control ? (
                      <NotificationTypesPicker
                        label={`${symbol} 配置通知`}
                        value={control.notification_types}
                        disabled={disabled}
                        strategyMarket={control.strategy_market}
                        canWatch={control.can_watch}
                        hint="上新与额度提醒需要监控开启；成交汇总与仓位不平衡不受采样开关影响。"
                        save={(value) =>
                          save({ notification_types: value }, symbol)
                        }
                      />
                    ) : (
                      <span className="muted">等待配置同步</span>
                    )}
                    {!settings.feishu_enabled ? (
                      <small>通知总开关已关闭</small>
                    ) : !eventChannel.configured ? (
                      <small>事件机器人未配置</small>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className={`number ${view.dataAvailable ? '' : 'muted'}`}
                  >
                    <strong>
                      {listing?.max_leverage == null
                        ? '—'
                        : `${listing.max_leverage}x`}
                    </strong>
                    <span className="monitor-public-capacity">
                      {fmt(listing?.capacity)}
                    </span>
                    {listing?.capacity != null && !view.dataAvailable ? (
                      <small className="amber">上次采样</small>
                    ) : null}
                    {listing?.max_leverage != null &&
                    computeFreshness(
                      listing.brackets_checked_at,
                      now,
                      listings?.stale_seconds,
                    ).status === 'stale' ? (
                      <small className="amber">上次档位</small>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <FreshnessIndicator
                      freshness={view.freshness}
                      label="来源"
                    />
                    <small>额度 {monitoringDate(listing?.checked_at)}</small>
                    {listing?.error ? (
                      <small className="amber monitor-row-error">
                        {listing.error}
                      </small>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <details className="monitor-row-details">
                      <summary aria-label={`${symbol} 数据详情`}>
                        数据详情
                      </summary>
                      <dl>
                        <div>
                          <dt>交易所状态</dt>
                          <dd>
                            {exchangeStatuses[
                              listing?.status ?? control?.status ?? ''
                            ] ??
                              listing?.status ??
                              control?.status ??
                              '未知'}
                          </dd>
                        </div>
                        <div>
                          <dt>公开剩余 · USD1</dt>
                          <dd>{fmt(listing?.remaining)}</dd>
                        </div>
                        <div>
                          <dt>档位上限 · USD1</dt>
                          <dd>{fmt(listing?.bracket_cap)}</dd>
                        </div>
                        <div>
                          <dt>上线时间</dt>
                          <dd>{monitoringDate(listing?.onboard_at)}</dd>
                        </div>
                        <div>
                          <dt>发现时间</dt>
                          <dd>{monitoringDate(listing?.detected_at)}</dd>
                        </div>
                        <div>
                          <dt>额度采样</dt>
                          <dd>
                            <FreshnessIndicator
                              freshness={computeFreshness(
                                listing?.checked_at,
                                now,
                                listings?.stale_seconds,
                              )}
                              label="额度"
                            />
                          </dd>
                        </div>
                        <div>
                          <dt>杠杆档位</dt>
                          <dd>
                            <FreshnessIndicator
                              freshness={computeFreshness(
                                listing?.brackets_checked_at,
                                now,
                                listings?.stale_seconds,
                              )}
                              label="档位"
                            />
                          </dd>
                        </div>
                        <div>
                          <dt>交易依赖</dt>
                          <dd>
                            {control?.required_by.length
                              ? `关联账户：${control.required_by.join('、')}。即使独立监控暂停，交易仍保留所需采样。`
                              : '无关联账户'}
                          </dd>
                        </div>
                      </dl>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
              {!filtered.length ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <p className="muted">
                      {rows.length
                        ? '没有匹配的币种，请调整搜索或状态筛选。'
                        : demo
                          ? '模拟环境不运行上新监控。'
                          : '正在等待首次 USD1 交易对目录。'}
                    </p>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <p className="monitor-status">
          来源时间取额度、杠杆档位与启用中的目录扫描里最早的时间。暂停后保留上次数据；通知选择不代表采样或发送成功。
        </p>
      </section>
      <MonitorChannels
        notification={state?.notification}
        demo={demo}
        connectionError={connectionError}
      />
    </div>
  );
}
