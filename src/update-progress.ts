import type { UpdateJob, UpdateStage, UpdateProgressView } from './update-types';

const STAGE_MESSAGES: Record<UpdateStage, string> = {
  preflight: '正在检查更新条件…',
  download: '正在下载更新文件…',
  prepare: '正在准备依赖与配置…',
  build: '正在构建应用…',
  verify: '正在校验更新文件…',
  extract: '正在解包…',
  switch: '正在切换服务…',
  finalize: '正在完成安装与健康检查…',
};

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Progress belongs to the current task; no UI state or estimated stage weights. */
export function getUpdateProgress(job: UpdateJob | null | undefined): UpdateProgressView | null {
  if (!job || !['queued', 'running'].includes(job.status)) return null;
  const raw: unknown = job.progress;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const { stage, progress, timestamp, downloaded, total, speed, eta } = data;
  const startedAt = Date.parse(job.startedAt);
  if (typeof stage !== 'string' || !Object.hasOwn(STAGE_MESSAGES, stage) || 'error' in data
    || !Number.isFinite(startedAt) || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)
    || timestamp <= 0 || timestamp < startedAt
    || progress !== undefined && (!nonnegative(progress) || progress > 1)
    || downloaded !== undefined && (!nonnegative(downloaded) || !Number.isSafeInteger(downloaded))
    || total !== undefined && (!nonnegative(total) || !Number.isSafeInteger(total) || total === 0)
    || typeof downloaded === 'number' && typeof total === 'number' && downloaded > total
    || speed !== undefined && !nonnegative(speed)
    || eta !== undefined && !nonnegative(eta)) return null;

  return {
    stage: stage as UpdateStage,
    stageProgress: progress as number | undefined,
    message: STAGE_MESSAGES[stage as UpdateStage],
    speed: stage === 'download' && typeof speed === 'number' ? formatSpeed(speed) : undefined,
    eta: stage === 'download' && typeof eta === 'number' ? formatEta(eta) : undefined,
  };
}

function formatSpeed(bytesPerSec: number): string {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let value = bytesPerSec;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatEta(seconds: number): string {
  if (seconds < 1) return '不足1秒';
  if (seconds < 60) return `${Math.ceil(seconds)}秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}分钟`;
  return `${Math.ceil(seconds / 3600)}小时`;
}
