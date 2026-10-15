'use client';
import type { Monitoring, State } from '@/lib/desk-types';
import { notificationChannel } from '@/lib/notification-channels';
import { Switch } from '@/components/ui/switch';
import { SummaryIntervalForm } from '@/components/summary-interval-form';
import { NotificationTypesPicker } from '@/components/notification-types-picker';
import { monitoringDate } from '@/components/freshness-indicator';

function SettingSwitch({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="monitor-setting">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export function MonitorSettings({
  monitoring,
  notification,
  demo,
  disabled,
  pending,
  save,
}: {
  monitoring: Monitoring;
  notification?: State['notification'];
  demo: boolean;
  disabled: boolean;
  pending: boolean;
  save: (body: object) => Promise<boolean>;
}) {
  const settings = monitoring.settings;
  const interval = settings.hourly_summary_interval_minutes ?? 60;
  const summary = notification?.hourly_summary;
  const channel = notificationChannel(notification, 'scheduled');
  const scheduled =
    !demo &&
    settings.feishu_enabled &&
    settings.hourly_summary_alerts &&
    channel.configured;
  return (
    <section className="panel monitor-controls">
      <div className="section-head">
        <div>
          <h2>币种监控中心</h2>
          <p>
            统一管理 USD1 交易对与通知。服务器运行期间，关闭网页后仍按设置运行。
          </p>
        </div>
        <output className="small-note" aria-live="polite">
          {pending ? '保存中…' : '开关修改即保存'}
        </output>
      </div>
      <div className="monitor-master-grid">
        <SettingSwitch
          title="独立币种监控"
          description="控制后台独立采样；交易与订单核对所需数据仍会保留。"
          checked={settings.monitoring_enabled}
          disabled={disabled}
          onChange={(value) => void save({ monitoring_enabled: value })}
        />
        <SettingSwitch
          title="飞书通知总开关"
          description="关闭会取消待发通知，重新开启不补发关闭期间的历史。"
          checked={settings.feishu_enabled}
          disabled={disabled}
          onChange={(value) => void save({ feishu_enabled: value })}
        />
        <SettingSwitch
          title="自动发现新币"
          description="定期更新 USD1 目录；重新开启先建立基线。"
          checked={settings.auto_discover}
          disabled={disabled}
          onChange={(value) => void save({ auto_discover: value })}
        />
        <SettingSwitch
          title="自动监控新币"
          description="仅影响以后发现的币种，不会自动加入交易策略。"
          checked={settings.auto_monitor_new}
          disabled={disabled}
          onChange={(value) => void save({ auto_monitor_new: value })}
        />
      </div>
      {!settings.monitoring_enabled || !settings.feishu_enabled || demo ? (
        <p className="monitor-status amber">
          {demo ? (
            '模拟环境仅展示，监控与通知配置不可修改。'
          ) : (
            <>
              {!settings.monitoring_enabled
                ? '独立监控已暂停，可使用上方总开关恢复；交易依赖采样继续保留。 '
                : ''}
              {!settings.feishu_enabled
                ? '飞书通知已关闭，币种通知选择仍会保留。'
                : ''}
            </>
          )}
        </p>
      ) : null}
      <details className="monitor-options">
        <summary>
          默认通知与定时设置{' '}
          <span className="muted">
            摘要
            {settings.hourly_summary_alerts ? `每 ${interval} 分钟` : '已关闭'}
          </span>
        </summary>
        <div className="monitor-options-content">
          <div className="monitor-default-notifications">
            <div>
              <strong>新币默认通知</strong>
              <p>仅供以后新发现的币种继承，不会修改已有币种。</p>
            </div>
            <NotificationTypesPicker
              label="配置默认通知"
              buttonText="配置默认通知"
              value={settings.default_notification_types}
              disabled={disabled}
              save={(value) => save({ default_notification_types: value })}
            />
          </div>
          <div className="monitor-options-grid">
            <SettingSwitch
              title="发送定时摘要"
              description="涵盖全部账户与配对组；只遵循飞书总开关与本开关。"
              checked={settings.hourly_summary_alerts}
              disabled={disabled}
              onChange={(value) => void save({ hourly_summary_alerts: value })}
            />
            <SettingSwitch
              title="副服务器 WS 异常告警"
              description="发送到事件机器人；只遵循飞书总开关与本开关。"
              checked={settings.relay_health_alerts}
              disabled={disabled}
              onChange={(value) => void save({ relay_health_alerts: value })}
            />
            <SummaryIntervalForm
              savedMinutes={interval}
              disabled={disabled}
              save={save}
            />
          </div>
          <p className="monitor-options-note">
            上次摘要成功发送：
            {monitoringDate(demo ? null : summary?.last_sent_at)}
            <br />
            下次计划：{monitoringDate(scheduled ? summary?.next_due_at : null)}
            {summary?.pending ? '；本次摘要待发送' : ''}
          </p>
          <p className="monitor-options-note">
            保存新间隔、重新启用或通道恢复后，等待完整周期，不补发历史摘要；保存相同间隔不改变安排。
          </p>
        </div>
      </details>
      {!monitoring.strategy_capacity_environment_enabled ? (
        <p className="monitor-status amber">
          服务器环境配置已关闭策略额度提醒，选中该通知类型后仍不会发送。
        </p>
      ) : null}
    </section>
  );
}

export function MonitorChannels({
  notification,
  demo,
  connectionError,
}: {
  notification?: State['notification'];
  demo: boolean;
  connectionError: string;
}) {
  return (
    <section className="panel monitor-channels" aria-label="通知通道状态">
      <div className="monitor-channels-grid">
        {(['event', 'scheduled'] as const).map((key) => {
          const channel = notificationChannel(notification, key);
          return (
            <div key={key}>
              <strong>{key === 'event' ? '事件机器人' : '定时机器人'}</strong>
              <span className={channel.error ? 'amber' : 'muted'}>
                {channel.error ||
                  (channel.configured ? '已配置' : '未配置，暂停发送')}
                {channel.source === 'legacy' ? '（沿用旧机器人）' : ''}
              </span>
              <span className="muted">
                {channel.pending == null
                  ? '待发数量未提供'
                  : `${channel.pending} 条待发送`}
              </span>
            </div>
          );
        })}
        <div className="monitor-pending-total">
          <strong>{notification?.pending ?? '—'}</strong>
          <span className="muted">条通知待发送</span>
        </div>
      </div>
      {connectionError || demo ? (
        <p className="monitor-options-note amber">
          {demo
            ? '模拟环境不发送通知。'
            : '连接中断，以上为上次获取的发送状态。'}
        </p>
      ) : null}
      <details className="monitor-help">
        <summary>通知说明与配置帮助</summary>
        <p>
          「USD1
          上新」与「监控与告警」已合并。原独立监控对应每币种监控开关；原飞书告警和通知类型合并为该币种的通知选择。旧设置自动保留，默认通知只影响未来新币。
        </p>
        <p>
          上新与额度提醒需要独立监控和该币种监控开启；成交汇总与仓位不平衡不依赖独立监控。关闭监控不会关闭账户或平仓。
        </p>
        <p>
          最大杠杆额度持续大于零不重复提醒；归零后恢复、最大杠杆变化或重新选择该通知时再次提醒。公开额度不代表账户可开额度。
        </p>
        <p>
          WS 连续失败 3 次、断连持续 60 秒，或连接后 2
          分钟没有有效额度样本时告警。故障通知送达后，稳定恢复 30
          秒通知一次；HTTP 补取成功不代表 WS 恢复。
        </p>
        <p>
          仓位不平衡在实盘同币种多空数量差超过 0.1%，且新快照持续确认 60
          秒后提醒；交易、核对或回退中暂缓，恢复稳定 30 秒后通知一次。
        </p>
        <p>
          在主服务器运行 <code>sudo aster-desk feishu-configure</code>{' '}
          绑定两个机器人。启用双通道后，未配置的通道不会转发到另一机器人。已配置只表示配置可用，实际发送错误与待发数量见上方。
        </p>
      </details>
    </section>
  );
}
