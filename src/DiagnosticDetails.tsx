import { diagnosticLabel, snapshotDiagnostics } from './hub-state';
import type { Snapshot } from './types';

export default function DiagnosticDetails({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const issues = snapshotDiagnostics(snapshot);
  if (!issues.length) return null;
  return <details className="diagnostic-details">
    <summary>运行详情 <span>{issues.length} 项</span></summary>
    <ul>{issues.map(issue => <li key={issue.id}>
      <span className={`diagnostic-kind ${issue.kind}`}>{diagnosticLabel(issue, now)}</span>
      <p>{issue.message}</p>
      {Number.isFinite(Date.parse(issue.firstSeenAt)) ? <small>首次发现 {new Date(issue.firstSeenAt).toLocaleString('zh-CN')}</small> : null}
    </li>)}</ul>
  </details>;
}
