export type UpdateModule = {
  id: string;
  name: string;
  state: 'current' | 'available' | 'unavailable' | 'unmanaged';
  currentVersion: string | null;
  latestVersion: string | null;
  currentCommit: string | null;
  latestCommit: string | null;
  releaseNotes?: string;
  reason?: string;
  recovery?: boolean;
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
  githubToken?: { configured: boolean };
  reason?: string;
  checking: boolean;
  checkedAt: string | null;
  checkError: string | null;
  planId: string | null;
  expiresAt: string | null;
  modules: UpdateModule[];
  job: UpdateJob | null;
};

export type UpdateStage =
  | 'preflight'
  | 'download'
  | 'verify'
  | 'extract'
  | 'switch';

export interface UpdateProgress {
  stage: UpdateStage;
  progress: number;  // 0-1
  downloaded?: number;
  total?: number;
  speed?: number;  // bytes/sec
  eta?: number;  // seconds
  error?: string;
  timestamp: number;
}

export interface CombinedProgress {
  overall: number;  // 0-1, combined progress
  stage: UpdateStage;
  stageProgress: number;  // progress within current stage
  message: string;
  speed?: string;
  eta?: string;
}
