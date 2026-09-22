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
export function retainedProjects(previous: string[], projects: Project[], activeId: string | null, ready: ReadonlySet<string>) {
  const available = new Map(projects.filter(p => p.enabled).map(p => [projectKey(p), p]));
  const active = projects.find(p => p.id === activeId);
  const key = active ? projectKey(active) : null;
  return [...(key ? [key] : []), ...previous.filter(item => item !== key && ready.has(item) && available.has(item))].slice(0, 2);
}
