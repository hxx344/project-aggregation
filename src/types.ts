export type Category = 'trading' | 'monitoring' | 'assets' | 'other';
export type Adapter = 'aster' | 'monitor' | 'asset' | 'standard' | 'link';
export type Project = {
  id: string; name: string; description: string; category: Category; adapter: Adapter;
  url: string; apiUrl: string; authOrigin?: string; accessMode?: 'proxy' | 'direct'; autoSync?: boolean; mode: 'external' | 'embed'; enabled: boolean;
  staleAfterSeconds: number; order: number; hasCredentials: boolean; username?: string;
};
export type Metric = { key: string; label: string; value: number | string | null; unit?: string; detail?: string };
export type SyncStatus = {
  state: 'idle' | 'syncing' | 'success' | 'partial' | 'error' | 'unauthorized' | 'unconfigured' | 'disabled';
  message: string; startedAt: string | null; finishedAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null;
};
export type Snapshot = {
  project: Project;
  state: 'unconfigured' | 'online' | 'stale' | 'offline' | 'unauthorized' | 'disabled' | 'partial';
  message: string; checkedAt: string | null; updatedAt: string | null; latencyMs: number | null;
  freshness?: 'dynamic' | 'static'; sync?: SyncStatus | null; metrics: Metric[]; trend?: { at: string; value: number }[];
};
export type Overview = { projects: Snapshot[]; generatedAt: string };
export type ProjectInput = Omit<Project, 'hasCredentials'> & { password?: string; clearCredentials?: boolean };
