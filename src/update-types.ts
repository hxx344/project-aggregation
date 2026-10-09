export type UpdateModule = {
  id: string;
  name: string;
  state: 'current' | 'available' | 'unavailable' | 'unmanaged';
  currentVersion: string | null;
  latestVersion: string | null;
  currentCommit: string | null;
  latestCommit: string | null;
  reason?: string;
};

export type UpdateJob = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  activeModule: string | null;
  steps: Array<{
    id: string;
    name: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
    message?: string;
  }>;
  message: string;
};

export type UpdateState = {
  enabled: boolean;
  reason?: string;
  checking: boolean;
  checkedAt: string | null;
  checkError: string | null;
  planId: string | null;
  expiresAt: string | null;
  modules: UpdateModule[];
  job: UpdateJob | null;
};
