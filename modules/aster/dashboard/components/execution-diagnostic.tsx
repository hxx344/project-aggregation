import type { ExecutionDiagnostic as Diagnostic } from '@/lib/execution-diagnostic';
import { executionDiagnosticView } from '@/lib/execution-diagnostic';
import { utcTime } from '@/lib/format-time';

export function ExecutionDiagnostic({
  diagnostic,
}: {
  diagnostic?: Diagnostic | null;
}) {
  const view = executionDiagnosticView(diagnostic);
  if (!view) return null;
  return (
    <section className="execution-diagnostic" aria-label="执行检查详情">
      <div className="execution-diagnostic-heading">
        <h3>上次检查结果</h3>
        <span>
          {view.symbol} · {view.phase}
        </span>
      </div>
      <p className="execution-diagnostic-title">{view.title}</p>
      <p className="execution-diagnostic-time">
        上次失败检查：<time>{utcTime(view.checkedAt)}</time>
      </p>
      <p className="execution-diagnostic-note">未列出的条件不代表已通过。</p>
      {view.checks.length ? (
        <ul className="execution-diagnostic-checks">
          {view.checks.map((check) => (
            <li key={check.key}>
              <div className="execution-diagnostic-check-head">
                <strong>{check.label}</strong>
                <span className={check.tone}>{check.status}</span>
              </div>
              <dl className="execution-diagnostic-values">
                <div>
                  <dt>实际值{check.unit ? ` · ${check.unit}` : ''}</dt>
                  <dd>{check.actual}</dd>
                </div>
                <div>
                  <dt>要求值{check.unit ? ` · ${check.unit}` : ''}</dt>
                  <dd>{check.required}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">此次诊断未提供具体检查项。</p>
      )}
      {view.context.length ? (
        <dl className="execution-diagnostic-context execution-diagnostic-values">
          {view.context.map((item) => (
            <div key={item.key}>
              <dt>
                {item.label}
                {item.unit ? ` · ${item.unit}` : ''}
              </dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.note ? <p className="execution-diagnostic-note">{view.note}</p> : null}
    </section>
  );
}
