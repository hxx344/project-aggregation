'use client';
import { useId, useState } from 'react';
import type { ListingCapacityRule, NotificationType } from '@/lib/desk-types';
import {
  applicableNotificationTypes,
  capacityRuleDraft,
  capacityRuleLabel,
  notificationTypes,
  parseCapacityRuleDraft,
} from '@/lib/monitoring-notifications';
import type { CapacityRuleDraft } from '@/lib/monitoring-notifications';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export function NotificationTypesPicker({
  label,
  buttonText = '配置通知',
  value,
  disabled,
  strategyMarket = true,
  canWatch = true,
  capacityRule,
  hint,
  save,
}: {
  label: string;
  buttonText?: string;
  value: NotificationType[];
  disabled: boolean;
  strategyMarket?: boolean;
  canWatch?: boolean;
  capacityRule?: ListingCapacityRule;
  hint?: string;
  save: (
    value: NotificationType[],
    rule?: ListingCapacityRule,
  ) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<{
    types: NotificationType[];
    capacity?: CapacityRuleDraft;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const hasExistingWatch = value.includes('listing_capacity');
  const applicable = (types: readonly NotificationType[]) =>
    applicableNotificationTypes(
      types,
      strategyMarket,
      canWatch,
      hasExistingWatch,
    );
  const available = applicable(notificationTypes.map((type) => type.key));
  const selected = draft?.types ?? applicable(value);
  const locked = disabled || pending;
  return (
    <div className="notification-picker">
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (pending || (open && disabled)) return;
          setDraft(
            open
              ? {
                  types: applicable(value),
                  capacity: capacityRule
                    ? capacityRuleDraft(capacityRule)
                    : undefined,
                }
              : null,
          );
          setError('');
        }}
      >
        <DialogTrigger
          render={
            <Button variant="outline" aria-label={label} disabled={locked} />
          }
        >
          {buttonText}{' '}
          <span className="muted">
            {applicable(value).length}/{available.length}
          </span>
        </DialogTrigger>
        {capacityRule && hasExistingWatch ? (
          <p className="notification-capacity-summary">
            {capacityRuleLabel(capacityRule)}
          </p>
        ) : null}
        {draft !== null ? (
          <DialogContent
            className="notification-picker-dialog"
            showCloseButton={!pending}
          >
            <DialogTitle>{label}</DialogTitle>
            <form
              id={id}
              className="notification-picker-editor"
              aria-label={label}
              onSubmit={async (event) => {
                event.preventDefault();
                if (locked) return;
                let rule: ListingCapacityRule | undefined;
                if (selected.includes('listing_capacity') && draft.capacity) {
                  const parsed = parseCapacityRuleDraft(draft.capacity);
                  if (parsed.error) {
                    setError(parsed.error);
                    return;
                  }
                  rule = parsed.rule ?? undefined;
                }
                setPending(true);
                setError('');
                try {
                  if (await save(applicable(selected), rule)) setDraft(null);
                  else setError('保存未完成，选择已保留，请重试。');
                } catch {
                  setError('保存未完成，选择已保留，请重试。');
                } finally {
                  setPending(false);
                }
              }}
            >
              <fieldset disabled={locked}>
                <legend className="sr-only">通知类型与条件</legend>
                {notificationTypes.map((type) => (
                  <label key={type.key} className="notification-type-option">
                    <input
                      type="checkbox"
                      disabled={!available.includes(type.key)}
                      checked={selected.includes(type.key)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                types: checked
                                  ? [...current.types, type.key]
                                  : current.types.filter(
                                      (key) => key !== type.key,
                                    ),
                              }
                            : current,
                        );
                        setError('');
                      }}
                    />
                    <span>
                      <strong>{type.title}</strong>
                      <span>{type.description}</span>
                      {type.key === 'strategy_capacity' && !strategyMarket ? (
                        <span className="muted">仅策略品种可选。</span>
                      ) : null}
                      {type.key === 'listing_capacity' && !canWatch ? (
                        <span className="muted">
                          {hasExistingWatch
                            ? '尚无交易对目录，可保留或清除已有选择。'
                            : '等待交易对目录收录后可选。'}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
                {draft.capacity && selected.includes('listing_capacity') ? (
                  <div className="notification-capacity-fields">
                    <label htmlFor={`${id}-mode`}>通知杠杆</label>
                    <select
                      id={`${id}-mode`}
                      value={draft.capacity.mode}
                      onChange={(event) => {
                        const mode =
                          event.target.value === 'fixed' ? 'fixed' : 'maximum';
                        setDraft((current) =>
                          current?.capacity
                            ? {
                                ...current,
                                capacity: { ...current.capacity, mode },
                              }
                            : current,
                        );
                        setError('');
                      }}
                    >
                      <option value="maximum">最大杠杆</option>
                      <option value="fixed">指定杠杆</option>
                    </select>
                    {draft.capacity.mode === 'fixed' ? (
                      <>
                        <label htmlFor={`${id}-leverage`}>指定杠杆倍数</label>
                        <Input
                          id={`${id}-leverage`}
                          inputMode="numeric"
                          value={draft.capacity.leverage}
                          maxLength={5}
                          placeholder="例如 20"
                          onChange={(event) => {
                            const leverage = event.target.value;
                            setDraft((current) =>
                              current?.capacity
                                ? {
                                    ...current,
                                    capacity: { ...current.capacity, leverage },
                                  }
                                : current,
                            );
                            setError('');
                          }}
                        />
                      </>
                    ) : null}
                    <label htmlFor={`${id}-threshold`}>
                      公开额度超过（USD1）
                    </label>
                    <Input
                      id={`${id}-threshold`}
                      inputMode="decimal"
                      value={draft.capacity.threshold}
                      maxLength={128}
                      placeholder="例如 5000"
                      onChange={(event) => {
                        const threshold = event.target.value;
                        setDraft((current) =>
                          current?.capacity
                            ? {
                                ...current,
                                capacity: { ...current.capacity, threshold },
                              }
                            : current,
                        );
                        setError('');
                      }}
                    />
                    <p>
                      每分钟检查；严格超过才通知。回落至阈值或以下后，再次超过会重新通知。所选档位缺失时等待有效数据。
                    </p>
                  </div>
                ) : null}
              </fieldset>
              {hint ? <p className="notification-picker-hint">{hint}</p> : null}
              <div className="notification-picker-actions">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={() =>
                    setDraft((current) =>
                      current ? { ...current, types: available } : current,
                    )
                  }
                >
                  全选
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={locked}
                  onClick={() =>
                    setDraft((current) =>
                      current ? { ...current, types: [] } : current,
                    )
                  }
                >
                  清空
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setDraft(null);
                    setError('');
                  }}
                >
                  取消
                </Button>
                <Button type="submit" disabled={locked}>
                  {pending ? '保存中…' : '应用'}
                </Button>
              </div>
              {error ? (
                <output className="notification-picker-error" role="alert">
                  {error}
                </output>
              ) : null}
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
