import type { Adapter, Snapshot } from '../types';
import { statusText } from '../check-notice';

export default function Status({ state, adapter, diagnostics }: { state: Snapshot['state']; adapter?: Adapter; diagnostics?: Snapshot['diagnostics'] }) {
  if (adapter === 'link' && state === 'online') return <span className="status unconfigured">网页入口</span>;
  if (state === 'partial' && diagnostics?.length && diagnostics.every(issue => issue.kind === 'notice')) return <span className="status unconfigured"><span aria-hidden="true" />运行提示</span>;
  return <span className={`status ${state}`}><span aria-hidden="true" />{statusText[state]}</span>;
}
