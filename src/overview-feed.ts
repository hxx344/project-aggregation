import type { Overview, Snapshot } from './types';

// Reject gaps instead of applying a delta to data from a different connection.
export function createOverviewDecoder() {
  let current: Overview | null = null, sequence = -1;
  return (raw: string): Overview | null => {
    const data = JSON.parse(raw);
    if (!data || !Number.isFinite(Date.parse(data.generatedAt))) throw new Error('Invalid overview timestamp');
    // Compatibility while an older server is still running during an upgrade.
    if (!data.type && Array.isArray(data.projects)) return data as Overview;
    if (data.type === 'snapshot' && data.sequence === 0 && Array.isArray(data.projects)) {
      sequence = 0; current = { projects: data.projects, generatedAt: data.generatedAt }; return current;
    }
    if (!current) throw new Error('Missing overview snapshot');
    if (data.type === 'heartbeat' && data.sequence === sequence) return null;
    if (data.type !== 'patch' || data.baseSequence !== sequence || data.sequence !== sequence + 1 || !Array.isArray(data.projects) || !Array.isArray(data.order)) throw new Error('Overview sequence gap');
    const projects = new Map(current.projects.map(item => [item.project.id, item]));
    for (const item of data.projects as Snapshot[]) {
      const previous = projects.get(item.project.id);
      // Checked-at changes do not require rebuilding unchanged charts or frame configuration.
      if (previous) {
        if (JSON.stringify(previous.project) === JSON.stringify(item.project)) item.project = previous.project;
        if (JSON.stringify(previous.trend) === JSON.stringify(item.trend)) item.trend = previous.trend;
        if (JSON.stringify(previous.metrics) === JSON.stringify(item.metrics)) item.metrics = previous.metrics;
      }
      projects.set(item.project.id, item);
    }
    const next: Snapshot[] = data.order.map((id: string) => { const item = projects.get(id); if (!item) throw new Error('Missing project'); return item; });
    if (new Set(data.order).size !== next.length) throw new Error('Duplicate project');
    sequence = data.sequence; current = { projects: next, generatedAt: data.generatedAt }; return current;
  };
}

export function createStreamWatchdog(now: () => number = () => performance.now(), timeoutMs = 40_000) {
  let lastMessage = now();
  return { received() { lastMessage = now(); }, expired() { return now() - lastMessage >= timeoutMs; } };
}
