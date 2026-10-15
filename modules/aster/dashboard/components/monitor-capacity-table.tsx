'use client';

import { useState } from 'react';
import type { Listings, Monitoring } from '@/lib/desk-types';
import { fmt } from '@/lib/desk-format';
import {
  monitoredCapacityRows,
  monitoredCapacityTiers,
  nextMonitoredCapacitySort,
  sortMonitoredCapacityRows,
} from '@/lib/monitoring-capacities';
import type {
  MonitoredCapacitySort,
  MonitoredCapacitySortKey,
  MonitoredCapacityStatus,
} from '@/lib/monitoring-capacities';
import {
  FreshnessIndicator,
  monitoringDate,
} from '@/components/freshness-indicator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const statusLabels: Record<MonitoredCapacityStatus, string> = {
  active: '有效采样',
  waiting: '等待首次采样',
  stale: '数据过期',
  paused: '已暂停',
  unavailable: '非交易中',
  error: '采样失败',
};

const columns: { key: MonitoredCapacitySortKey; label: string }[] = [
  { key: 'symbol', label: '币种' },
  ...monitoredCapacityTiers.map((tier) => ({ key: tier, label: `${tier}x` })),
  { key: 'sampleTime', label: '采样时间' },
];

export function MonitorCapacityTable({
  monitoring,
  listings,
  now,
  demo,
  connectionError,
}: {
  monitoring: Monitoring;
  listings?: Listings;
  now: number;
  demo: boolean;
  connectionError: string;
}) {
  const [sort, setSort] = useState<MonitoredCapacitySort>({
    key: 'symbol',
    direction: 'ascending',
  });
  const rows = sortMonitoredCapacityRows(
    monitoredCapacityRows(monitoring.symbols, listings, now, {
      monitoringEnabled: monitoring.settings.monitoring_enabled,
      demo,
      connectionError: Boolean(connectionError),
    }),
    sort,
  );
  return (
    <section className="panel monitor-tier-panel" aria-label="监控额度">
      <div className="section-head">
        <div>
          <h2>监控额度</h2>
          <p>10x / 20x / 50x 公开可用额度，每 1 分钟更新，单位 USD1。</p>
        </div>
        <span className="small-note">{rows.length} 个已开启监控的币种</span>
      </div>
      {connectionError || demo || !monitoring.settings.monitoring_enabled ? (
        <p className="monitor-tier-notice amber">
          {demo
            ? '模拟环境，显示示例或上次数据。'
            : connectionError
              ? '连接中断，保留上次采样数据。'
              : '独立监控已暂停，可在下方总开关恢复。'}
        </p>
      ) : null}
      {rows.length ? (
        <div className="table-scroll">
          <Table className="monitor-tier-table">
            <TableHeader>
              <TableRow>
                {columns.map(({ key, label }) => (
                  <TableHead
                    key={key}
                    scope="col"
                    className={
                      key !== 'symbol' && key !== 'sampleTime'
                        ? 'number'
                        : undefined
                    }
                    aria-sort={sort.key === key ? sort.direction : undefined}
                  >
                    {key === 'sampleTime' ? '状态 / ' : null}
                    <button
                      type="button"
                      className="monitor-tier-sort"
                      title={`${key === 'sampleTime' ? '额度采样时间' : label}：点击${nextMonitoredCapacitySort(sort, key).direction === 'ascending' ? '升序' : '降序'}排列`}
                      onClick={() =>
                        setSort((current) =>
                          nextMonitoredCapacitySort(current, key),
                        )
                      }
                    >
                      {label}
                      <span aria-hidden="true">
                        {sort.key === key
                          ? sort.direction === 'ascending'
                            ? '↑'
                            : '↓'
                          : '↕'}
                      </span>
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ symbol, listing, view }) => (
                <TableRow
                  key={symbol}
                  data-symbol={symbol}
                  data-status={view.status}
                >
                  <TableCell>
                    <strong>{symbol}</strong>
                  </TableCell>
                  {monitoredCapacityTiers.map((tier) => (
                    <TableCell
                      key={tier}
                      data-tier={tier}
                      className={`number ${view.dataAvailable ? '' : 'muted'}`}
                    >
                      {view.capacities[tier] === null ? (
                        <span className="monitor-tier-unavailable">
                          暂不可用
                        </span>
                      ) : (
                        fmt(view.capacities[tier])
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="monitor-tier-sample">
                    <div className="monitor-tier-state">
                      <span
                        className={`symbol-status symbol-status-${view.status}`}
                      >
                        <i aria-hidden="true" />
                        {statusLabels[view.status]}
                      </span>
                      {view.hasSample && !view.dataAvailable ? (
                        <span className="amber">上次采样</span>
                      ) : null}
                    </div>
                    {view.hasSample ? (
                      <>
                        <FreshnessIndicator
                          freshness={view.freshness}
                          label="来源"
                        />
                        <small>
                          额度 {monitoringDate(listing?.tier_checked_at)}
                        </small>
                        <small>
                          档位{' '}
                          {monitoringDate(listing?.tier_brackets_checked_at)}
                        </small>
                      </>
                    ) : null}
                    {listing?.tier_error ? (
                      <small className="amber monitor-tier-error">
                        {listing.tier_error}
                      </small>
                    ) : listings?.discovery_enabled !== false &&
                      listings?.error ? (
                      <small className="amber monitor-tier-error">
                        目录：{listings.error}
                      </small>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="monitor-tier-empty">
          暂无已开启监控的币种，请在下方币种列表开启监控。
        </p>
      )}
      <p className="monitor-tier-footnote">
        点击列名切换升降序；采样时间按额度来源时间排序，缺失值始终放末尾。各档额度取公开剩余与该档位上限的较小值，不代表账户实际可开额度。
      </p>
    </section>
  );
}
