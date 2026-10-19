import type { Diagnostic, Project, Snapshot } from './types';
import { cleanHubQuery, type HubQuery } from '../server/hub-navigation.mjs';

export const ATTENTION_DELAY_MS = 120_000;

export function snapshotDiagnostics(snapshot: Snapshot): Diagnostic[] {
  if (!snapshot.project.enabled || snapshot.project.adapter === 'link') return [];
  if (snapshot.diagnostics !== undefined) return snapshot.diagnostics;
  if (['online', 'unconfigured', 'disabled'].includes(snapshot.state)) return [];
  // Keep older server responses visible until the server can track continuity.
  return [{ id: 'hub:legacy-health', kind: snapshot.state === 'unauthorized' ? 'action' : 'fault',
    message: snapshot.message || '项目状态异常，请进入项目查看', firstSeenAt: snapshot.checkedAt || snapshot.updatedAt || '' }];
}

export function attentionDiagnostics(snapshot: Snapshot, now: number): Diagnostic[] {
  return snapshotDiagnostics(snapshot).filter(issue => issue.kind === 'action'
    || issue.kind === 'fault' && (snapshot.diagnostics === undefined || now - Date.parse(issue.firstSeenAt) >= ATTENTION_DELAY_MS));
}

export function diagnosticLabel(issue: Diagnostic, now: number): string {
  if (issue.kind === 'action') return '需要处理';
  if (issue.kind === 'notice') return '运行提示';
  return now - Date.parse(issue.firstSeenAt) >= ATTENTION_DELAY_MS ? '持续异常' : '观察中';
}

export function connectionDiagnostic(issue: Diagnostic): boolean {
  return ['hub:auth', 'hub:connection'].includes(issue.id);
}

export type NavigationQuery = HubQuery;
export const navigationQuery = cleanHubQuery;
export function navigation(value: unknown): { projectId: string; query: NavigationQuery } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (!['asset', 'monitor', 'crossex', 'greeks'].includes(String(message.projectId))) return null;
  const query = navigationQuery(message.query);
  if (!query || (query.importId && message.projectId !== 'crossex') || (['greeks', 'asset'].includes(String(message.projectId)) && Object.keys(query).length)) return null;
  return { projectId: String(message.projectId), query };
}
export const projectKey = (project: Project) => `${project.id}:${project.revision || JSON.stringify(project)}`;
export function ageSnapshot(snapshot: Snapshot, now: number): Snapshot {
  if (snapshot.project.enabled === false || snapshot.project.adapter === 'link' || snapshot.freshness === 'static' || !['online', 'partial'].includes(snapshot.state)) return snapshot;
  const updated = snapshot.updatedAt ? Date.parse(snapshot.updatedAt) : NaN;
  const ttl = Math.min(snapshot.project.staleAfterSeconds, snapshot.staleAfterSeconds || snapshot.project.staleAfterSeconds);
  if (Number.isFinite(updated) && now - updated <= ttl * 1000) return snapshot;
  const observed = snapshot.checkedAt ? Date.parse(snapshot.checkedAt) : NaN;
  const expired = Number.isFinite(updated) ? updated + ttl * 1000 : observed;
  const firstSeenAt = new Date(Math.min(now, Math.max(Number.isFinite(observed) ? observed : now, Number.isFinite(expired) ? expired : now))).toISOString();
  const diagnostics = snapshot.diagnostics === undefined || snapshot.diagnostics.some(issue => issue.id === 'hub:data-freshness')
    ? snapshot.diagnostics : [...snapshot.diagnostics, { id: 'hub:data-freshness', kind: 'fault' as const,
      message: snapshot.updatedAt ? '源数据已过期，等待项目更新' : '上游未提供有效的数据更新时间', firstSeenAt }];
  return { ...snapshot, state: 'stale', message: `数据已过期。${snapshot.message}`, ...(diagnostics ? { diagnostics } : {}) };
}
export function nextSnapshotExpiry(snapshots: Snapshot[], now: number): number | null {
  let next = Infinity;
  for (const snapshot of snapshots) {
    if (snapshot.project.enabled === false || snapshot.project.adapter === 'link') continue;
    if (snapshot.freshness !== 'static' && ['online', 'partial'].includes(snapshot.state) && snapshot.updatedAt) {
      const ttl = Math.min(snapshot.project.staleAfterSeconds, snapshot.staleAfterSeconds || snapshot.project.staleAfterSeconds);
      const expiry = Date.parse(snapshot.updatedAt) + ttl * 1000 + 1;
      if (expiry > now) next = Math.min(next, expiry);
    }
    for (const issue of ageSnapshot(snapshot, now).diagnostics || []) {
      const maturity = Date.parse(issue.firstSeenAt) + ATTENTION_DELAY_MS;
      if (issue.kind === 'fault' && maturity > now) next = Math.min(next, maturity);
    }
  }
  return Number.isFinite(next) ? next : null;
}
export type FramePhase = 'loading' | 'ready' | 'failed' | 'unsupported';
export type WorkspacePlan = { frames: { key: string; phase: FramePhase }[]; attempted: string[]; recent: string[] };
export const emptyWorkspacePlan = (): WorkspacePlan => ({ frames: [], attempted: [], recent: [] });
const preloadAdapters: Record<string, string> = { monitor: 'monitor', asset: 'asset', crossex: 'standard', greeks: 'standard', aster: 'aster' };
const workspaceCapacity = Object.keys(preloadAdapters).length;
export function canPreload(project: Project) {
  return project.enabled && project.accessMode === 'proxy' && !!project.apiUrl && Object.hasOwn(preloadAdapters, project.id) && preloadAdapters[project.id] === project.adapter;
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
  // Give a newly selected document the connection budget. Retain ready pages,
  // but cancel unfinished speculation so it cannot compete with its assets.
  const activeLoading = frames.some(frame => frame.key === activeKey && frame.phase === 'loading');
  if (activeLoading) {
    frames = frames.filter(frame => {
      if (frame.key === activeKey || frame.phase !== 'loading') return true;
      attempted.delete(frame.key);
      return false;
    });
  }
  // Outside a foreground load, never retain an unbounded pending queue.
  const pending = frames.filter(frame => frame.key !== activeKey && frame.phase === 'loading');
  const retainedPending = recent.map(key => pending.find(frame => frame.key === key)).find(Boolean) ?? pending[0];
  frames = frames.filter(frame => frame.phase !== 'loading' || frame.key === activeKey || frame === retainedPending);
  while (frames.length > workspaceCapacity) {
    const candidates = frames.filter(frame => frame.key !== activeKey);
    const oldest = candidates.reduce((a, b) => (recent.indexOf(a.key) < 0 ? Infinity : recent.indexOf(a.key)) >= (recent.indexOf(b.key) < 0 ? Infinity : recent.indexOf(b.key)) ? a : b);
    frames = frames.filter(frame => frame !== oldest);
  }
  // Automatic warming belongs to the overview. While viewing a project, only
  // explicit hover/focus intent may start another download after it is ready.
  const intent = projects.find(project => project.id === priorityId && project.id !== activeId && canPreload(project));
  if (allowPreload && (!activeKey || intent) && frames.length < workspaceCapacity && !frames.some(frame => frame.phase === 'loading')) {
    const candidates = projects.filter(project => canPreload(project) && !attempted.has(projectKey(project)) && !frames.some(frame => frame.key === projectKey(project)));
    const next = candidates.find(project => project.id === priorityId) ?? (!activeKey ? candidates[0] : undefined);
    if (next) { const key = projectKey(next); frames.push({ key, phase: 'loading' }); attempted.add(key); }
  }
  const result = { frames, attempted: [...attempted], recent };
  return JSON.stringify(result) === JSON.stringify(previous) ? previous : result;
}
