'use client';
import { useId, useState } from 'react';
import type { NotificationType } from '@/lib/desk-types';
import {
  applicableNotificationTypes,
  notificationTypes,
} from '@/lib/monitoring-notifications';
import { Button } from '@/components/ui/button';

export function NotificationTypesPicker({
  label,
  buttonText = '配置通知',
  value,
  disabled,
  strategyMarket = true,
  canWatch = true,
  hint,
  save,
}: {
  label: string;
  buttonText?: string;
  value: NotificationType[];
  disabled: boolean;
  strategyMarket?: boolean;
  canWatch?: boolean;
  hint?: string;
  save: (value: NotificationType[]) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<NotificationType[] | null>(null);
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
  const selected = draft ?? applicable(value);
  const locked = disabled || pending;
  return (
    <div className="notification-picker">
      <Button
        variant="outline"
        aria-label={label}
        aria-expanded={draft !== null}
        aria-controls={id}
        disabled={locked}
        onClick={() => {
          if (draft !== null) return;
          setDraft(applicable(value));
          setError('');
        }}
      >
        {buttonText}{' '}
        <span className="muted">
          {applicable(value).length}/{available.length}
        </span>
      </Button>
      {draft !== null ? (
        <form
          id={id}
          className="notification-picker-editor"
          aria-label={label}
          onSubmit={async (event) => {
            event.preventDefault();
            if (locked) return;
            setPending(true);
            setError('');
            try {
              if (await save(applicable(selected))) setDraft(null);
              else setError('保存未完成，选择已保留，请重试。');
            } catch {
              setError('保存未完成，选择已保留，请重试。');
            } finally {
              setPending(false);
            }
          }}
        >
          <fieldset disabled={locked}>
            <legend>{label}</legend>
            {notificationTypes.map((type) => (
              <label key={type.key} className="notification-type-option">
                <input
                  type="checkbox"
                  disabled={!available.includes(type.key)}
                  checked={selected.includes(type.key)}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setDraft((current) =>
                      checked
                        ? [...(current ?? value), type.key]
                        : (current ?? value).filter((key) => key !== type.key),
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
          </fieldset>
          {hint ? <p className="notification-picker-hint">{hint}</p> : null}
          <div className="notification-picker-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => setDraft(available)}
            >
              全选
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => setDraft([])}
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
      ) : null}
    </div>
  );
}
