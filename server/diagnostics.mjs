const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

// Observation times belong to the hub, never to upstream source timestamps.
export function reconcileDiagnostics(entries, previous = [], now = Date.now()) {
  const prior = new Map(previous.map(item => [`${item.id}\0${item.kind}`, item]));
  return entries.map(({ id, kind, message }) => {
    const seen = prior.get(`${id}\0${kind}`)?.firstSeenAt;
    return { id, kind, message, firstSeenAt: Number.isFinite(stamp(seen)) && stamp(seen) <= now ? seen : new Date(now).toISOString() };
  });
}

export function snapshotDiagnostics(state, project, now = Date.now()) {
  const entries = [...(state.sourceDiagnostics || [])];
  const sourceState = state.sourceState || state.state;
  if (!Array.isArray(state.sourceDiagnostics) && ['partial', 'stale', 'offline'].includes(sourceState)) {
    entries.push({ id: 'hub:legacy-health', kind: 'fault', message: state.sourceMessage || state.message });
  }
  if (state.transportError || sourceState === 'unauthorized') {
    const unauthorized = state.transportError?.code === 'unauthorized' || sourceState === 'unauthorized';
    entries.push({ id: unauthorized ? 'hub:auth' : 'hub:connection', kind: unauthorized ? 'action' : 'fault', message: state.transportError?.message || state.message });
  }
  // A persisted initial failure is not evidence of a successful data read.
  const hasData = state.lastSuccessAt !== null;
  const ttl = Math.min(project.staleAfterSeconds, state.staleAfterSeconds || project.staleAfterSeconds);
  const at = stamp(state.updatedAt);
  if (hasData && state.freshness !== 'static' && (!Number.isFinite(at) || at > now + 60000 || now - at >= ttl * 1000)) {
    entries.push({ id: 'hub:data-freshness', kind: 'fault', message: Number.isFinite(at) && at <= now + 60000 ? '项目数据已过期，请检查源服务' : '上游未提供有效的数据更新时间，请检查源服务' });
  }
  return reconcileDiagnostics(entries, state.diagnostics, now);
}
