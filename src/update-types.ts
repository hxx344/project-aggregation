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

export type UpdateDeployMode = 'source' | 'ci';

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
  deployMode?: UpdateDeployMode;
  progress?: UpdateProgress;
  stageTimings?: { entries: Array<{ stage: UpdateStage; detail?: string; durationMs: number | null }> };
};

export type UpdateState = {
  enabled: boolean;
  deploymentModes?: UpdateDeployMode[];
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
  | 'prepare'
  | 'build'
  | 'verify'
  | 'extract'
  | 'switch'
  | 'finalize';

export interface UpdateProgress {
  stage: UpdateStage;
  detail?: string;
  progress?: number;  // Measured progress within this stage, 0-1; absent when unknown.
  downloaded?: number;
  total?: number;
  speed?: number;  // bytes/sec
  eta?: number;  // seconds
  timestamp: number;
}

export interface UpdateProgressView {
  stage: UpdateStage;
  stageProgress?: number;
  message: string;
  description: string;
  progressLabel: string;
  downloaded?: string;
  total?: string;
  speed?: string;
  eta?: string;
}
