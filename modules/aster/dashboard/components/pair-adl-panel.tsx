'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Pair } from '@/lib/pairs';
import type { State } from '@/lib/desk-types';
import {
  adlNotificationStatus,
  adlStatus,
  parseAdlReport,
  type AdlReport,
} from '@/lib/pair-adl';

const date = (value?: number | null) =>
  value
    ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false })
    : '尚无记录';

export function PairAdlPanel({
  pair,
  offline,
  notification,
  feishuEnabled,
  onSettings,
  onNotificationSettings,
}: {
  pair: Pair;
  offline: boolean;
  notification?: State['notification'];
  feishuEnabled?: boolean;
  onSettings: () => void;
  onNotificationSettings: () => void;
}) {
  const state = pair.state?.adl;
  const incident = state?.incident;
  const config =
    incident && (incident.status !== 'completed' || incident.hold)
      ? incident.config
      : pair.adl;
  const status = adlStatus(state, offline);
  return (
    <section className="panel pair-adl-panel" aria-label="ADL 应急处理">
      <div className="section-head">
        <div>
          <h2>ADL 应急处理</h2>
          <p
            className={status.attention ? 'amber' : 'muted'}
            aria-live="polite"
          >
            {status.label}
          </p>
        </div>
        <div className="account-controls">
          <Button variant="outline" onClick={onSettings}>
            ADL 设置
          </Button>
          {incident && state?.report_available ? (
            <AdlReportDialog
              key={`${pair.id}:${incident.id}`}
              pairId={pair.id}
              incidentId={incident.id}
              offline={offline}
            />
          ) : null}
        </div>
      </div>
      <div className="pair-adl-summary">
        <div>
          <span className="muted">
            {incident && (incident.status !== 'completed' || incident.hold)
              ? '本次事件固定配置'
              : '已保存配置'}
          </span>
          <strong>自动减仓{(config?.enabled ?? true) ? '开启' : '关闭'}</strong>
        </div>
        <div>
          <span className="muted">单批名义金额上限</span>
          <strong>{config?.batch_notional ?? '1000'} · 各合约计价币种</strong>
        </div>
        <div>
          <span className="muted">最近完整补查</span>
          <strong>{date(state?.monitoring?.checked_at)}</strong>
        </div>
      </div>
      <p className="muted">
        监测绑定两账户的全部原生合约，包含手工仓位。确认真实 ADL
        后暂停策略，重新核实两账户总多空数量，按批次市价关闭多余的腿。每批按现场标记价折算上限，实际成交金额随市价变化。
        已运行的保证金平衡在 ADL 处理、受阻及完成观察期间继续；手动暂停配对组会停止新划转，ADL 应急处理继续。
      </p>
      {!(config?.enabled ?? true) ? (
        <p className="amber">
          自动减仓已关闭：仍监测、暂停策略并告警，等待手工处理；本次处理不下单或撤单。
        </p>
      ) : null}
      {state?.monitoring?.reason ? (
        <p
          className={
            state.monitoring.status === 'monitoring' && !offline
              ? 'muted'
              : 'amber'
          }
        >
          监测：{state.monitoring.reason}
          {offline ? '（最近记录）' : ''}
        </p>
      ) : null}
      {incident ? (
        <div className="pair-adl-incident">
          <p>
            <strong>{incident.symbols.join('、') || '标的待确认'}</strong> ·
            已记录 {incident.batch_count} 批次 · 开始于{' '}
            {date(incident.created_at)}
          </p>
          {incident.reason ? (
            <p className={incident.status === 'completed' ? 'muted' : 'amber'}>
              {incident.reason}
            </p>
          ) : null}
          {incident.halted && incident.status !== 'completed' ? (
            <p className="amber">
              自动处理已停止，仍会核实现场；请按受阻原因处理。
            </p>
          ) : null}
          {incident.status === 'completed' ? (
            <p className="muted">
              完成于 {date(incident.completed_at)}。
              {incident.hold
                ? '策略保持暂停观察；请先核对报告，再决定是否手动启动。'
                : '本次处理记录已归档。'}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted">
          尚无 ADL
          处理记录。处理完成后策略保持暂停，初报、受阻告警与完整报告使用飞书事件机器人。
        </p>
      )}
      <div className="pair-adl-notification">
        <span>{adlNotificationStatus(notification, feishuEnabled)}</span>
        <Button variant="link" onClick={onNotificationSettings}>
          查看通知设置
        </Button>
      </div>
    </section>
  );
}

function AdlReportDialog({
  pairId,
  incidentId,
  offline,
}: {
  pairId: string;
  incidentId: string;
  offline: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<AdlReport | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      const controller = request.current;
      request.current = null;
      controller?.abort();
    },
    [],
  );
  const read = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const response = await fetch(
        `/api/pairs/${encodeURIComponent(pairId)}/adl-report`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? '暂未找到本次 ADL 报告，请刷新配对组状态后重试。'
            : `读取 ADL 报告失败（${response.status}），请重试。`,
        );
      const value = parseAdlReport(await response.json(), pairId, incidentId);
      if (request.current === controller) setReport(value);
    } catch (failure) {
      if (request.current === controller)
        setError(
          controller.signal.aborted
            ? '读取 ADL 报告超时，请重试。'
            : failure instanceof Error
              ? failure.message
              : '读取 ADL 报告失败，请重试。',
        );
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  };
  const close = () => {
    const controller = request.current;
    request.current = null;
    controller?.abort();
    setLoading(false);
    setOpen(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Button
        variant="outline"
        disabled={offline}
        onClick={() => {
          setOpen(true);
          void read();
        }}
      >
        查看处理报告
      </Button>
      <DialogContent className="pair-adl-report">
        <DialogHeader>
          <DialogTitle>ADL 处理报告</DialogTitle>
          <DialogDescription>
            按当前持久化记录生成，包含初始现场、各批次与处理结果。未知回执会保留未知状态。
          </DialogDescription>
        </DialogHeader>
        {loading ? <output>正在读取报告…</output> : null}
        {error ? (
          <p className="message message-error" role="alert">
            {error}
          </p>
        ) : null}
        {report ? (
          <div className="pair-adl-report-content">
            <p className="muted">生成于 {date(report.generated_at)}</p>
            {report.messages.map((message, index) => (
              <pre key={index}>{message}</pre>
            ))}
          </div>
        ) : null}
        <Button
          variant="outline"
          disabled={loading || offline}
          onClick={() => void read()}
        >
          重新读取报告
        </Button>
      </DialogContent>
    </Dialog>
  );
}
