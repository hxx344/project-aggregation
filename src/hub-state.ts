import type { Project, Snapshot } from './types';

export type NavigationQuery = { symbol?: string; longExchange?: string; shortExchange?: string };
const venues = new Set(['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter']);
export function navigationQuery(value: unknown): NavigationQuery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => !['symbol', 'longExchange', 'shortExchange'].includes(key))) return null;
  if (query.symbol !== undefined && (typeof query.symbol !== 'string' || !/^[A-Z0-9._-]{1,40}$/.test(query.symbol))) return null;
  for (const key of ['longExchange', 'shortExchange']) if (query[key] !== undefined && (typeof query[key] !== 'string' || !venues.has(query[key]))) return null;
  return { ...query } as NavigationQuery;
}
export function navigation(value: unknown): { projectId: string; query: NavigationQuery } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (!['aster', 'asset', 'monitor', 'crossex'].includes(String(message.projectId))) return null;
  const query = navigationQuery(message.query);
  if (!query || (['aster', 'asset'].includes(String(message.projectId)) && Object.keys(query).length)) return null;
  return { projectId: String(message.projectId), query };
}
export const projectKey = (project: Project) => `${project.id}:${project.revision || JSON.stringify(project)}`;
export function ageSnapshot(snapshot: Snapshot, now: number): Snapshot {
  if (snapshot.freshness === 'static' || !['online', 'partial'].includes(snapshot.state)) return snapshot;
  const updated = snapshot.updatedAt ? Date.parse(snapshot.updatedAt) : NaN;
  const ttl = Math.min(snapshot.project.staleAfterSeconds, snapshot.staleAfterSeconds || snapshot.project.staleAfterSeconds);
  if (Number.isFinite(updated) && now - updated <= ttl * 1000) return snapshot;
  return { ...snapshot, state: 'stale', message: `数据已过期。${snapshot.message}` };
}
export function nextSnapshotExpiry(snapshots: Snapshot[], now: number): number | null {
  let next = Infinity;
  for (const snapshot of snapshots) {
    if (snapshot.freshness === 'static' || !['online', 'partial'].includes(snapshot.state) || !snapshot.updatedAt) continue;
    const ttl = Math.min(snapshot.project.staleAfterSeconds, snapshot.staleAfterSeconds || snapshot.project.staleAfterSeconds);
    const expiry = Date.parse(snapshot.updatedAt) + ttl * 1000 + 1;
    if (expiry > now) next = Math.min(next, expiry);
  }
  return Number.isFinite(next) ? next : null;
}
export type FramePhase = 'loading' | 'ready' | 'failed' | 'unsupported';
export type WorkspacePlan = { frames: { key: string; phase: FramePhase }[]; attempted: string[]; recent: string[] };
export const emptyWorkspacePlan = (): WorkspacePlan => ({ frames: [], attempted: [], recent: [] });
export function canPreload(project: Project) {
  const adapters: Record<string, string> = { aster: 'aster', monitor: 'monitor', asset: 'asset', crossex: 'standard', variational: 'standard' };
  return project.enabled && project.accessMode === 'proxy' && !!project.apiUrl && adapters[project.id] === project.adapter;
}
export function planWorkspace(previous: WorkspacePlan, projects: Project[], activeId: string | null, priorityId: string | null, allowPreload: boolean): WorkspacePlan {
  const live = new Map(projects.map(project => [projectKey(project), project]));
  const active = projects.find(project => project.id === activeId);
  const activeKey = active ? projectKey(active) : null;
  const attempted = new Set(previous.attempted.filter(key => live.has(key)));
  const recent = [...(activeKey ? [activeKey] : []), ...previous.recent.filter(key => key !== activeKey && live.has(key))];
  // Preserve insertion order: moving an iframe DOM node can reload its document.
  let frames = previous.frames.filter(frame => {
    const project = live.get(frame.key);
    return project && (frame.key === activeKey || (project.enabled && (frame.phase === 'ready' || (frame.phase === 'loading' && canPreload(project)))));
  });
  if (activeKey && !frames.some(frame => frame.key === activeKey)) {
    frames.push({ key: activeKey, phase: 'loading' }); attempted.add(activeKey);
  }
  // Rapid clicks may leave one old load in the background, never an unbounded queue.
  const pending = frames.filter(frame => frame.key !== activeKey && frame.phase === 'loading');
  const retainedPending = recent.map(key => pending.find(frame => frame.key === key)).find(Boolean) ?? pending[0];
  frames = frames.filter(frame => frame.phase !== 'loading' || frame.key === activeKey || frame === retainedPending);
  while (frames.length > 5) {
    const candidates = frames.filter(frame => frame.key !== activeKey);
    const oldest = candidates.reduce((a, b) => (recent.indexOf(a.key) < 0 ? Infinity : recent.indexOf(a.key)) >= (recent.indexOf(b.key) < 0 ? Infinity : recent.indexOf(b.key)) ? a : b);
    frames = frames.filter(frame => frame !== oldest);
  }
  if (allowPreload && frames.length < 5 && !frames.some(frame => frame.phase === 'loading')) {
    const candidates = projects.filter(project => canPreload(project) && !attempted.has(projectKey(project)) && !frames.some(frame => frame.key === projectKey(project)));
    const next = candidates.find(project => project.id === priorityId) ?? candidates[0];
    if (next) { const key = projectKey(next); frames.push({ key, phase: 'loading' }); attempted.add(key); }
  }
  const result = { frames, attempted: [...attempted], recent };
  return JSON.stringify(result) === JSON.stringify(previous) ? previous : result;
}
