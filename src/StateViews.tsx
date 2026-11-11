import { CircleAlert, CircleCheck, Info, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

// 工作台通用的状态展示：提示条（Callout）与整块状态（StatePanel、LoadingFallback）。
// 只负责外观与无障碍角色，文案、重试与数据时效判断仍由各页面决定。

export type CalloutTone = 'info' | 'success' | 'warning' | 'error';

const toneIcon: Record<CalloutTone, ReactNode> = {
  info: <Info size={16} aria-hidden="true" />,
  success: <CircleCheck size={16} aria-hidden="true" />,
  warning: <CircleAlert size={16} aria-hidden="true" />,
  error: <CircleAlert size={16} aria-hidden="true" />,
};

// 默认角色：warning、error 用 alert，其余用 status；需要静默时由调用方传 role。
export function Callout({ tone = 'info', role, action, className, children }: { tone?: CalloutTone; role?: 'alert' | 'status'; action?: { label: string; onClick: () => void }; className?: string; children: ReactNode }) {
  return <div className={`callout ${tone}${className ? ` ${className}` : ''}`} role={role ?? (tone === 'warning' || tone === 'error' ? 'alert' : 'status')}>
    {toneIcon[tone]}<div className="callout-body">{children}</div>
    {action ? <button type="button" className="callout-action" onClick={action.onClick}>{action.label}</button> : null}
  </div>;
}

export function StatePanel({ kind, title, detail, children }: { kind: 'loading' | 'empty' | 'error'; title: string; detail?: ReactNode; children?: ReactNode }) {
  return <section className={`empty-state loading-state state-panel ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    {kind === 'loading' ? <LoaderCircle className="spin" aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
    <h2>{title}</h2>{detail ? <p>{detail}</p> : null}{children}
  </section>;
}

export function LoadingFallback({ label }: { label: string }) {
  return <div className="empty-state loading-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><p>{label}</p></div>;
}

export function TableEmpty({ children }: { children: ReactNode }) {
  return <p className="table-empty">{children}</p>;
}
