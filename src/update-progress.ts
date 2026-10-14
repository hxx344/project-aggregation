import type { UpdateProgress, UpdateStage, CombinedProgress } from './update-types';

const STAGE_WEIGHTS: Record<UpdateStage, number> = {
  preflight: 0.05,
  download: 0.70,
  verify: 0.10,
  extract: 0.10,
  switch: 0.05,
};

const STAGE_CUMULATIVE: Record<UpdateStage, number> = {
  preflight: 0,
  download: 0.05,
  verify: 0.75,
  extract: 0.85,
  switch: 0.95,
};

const STAGE_MESSAGES: Record<UpdateStage, string> = {
  preflight: '正在检查发布包…',
  download: '正在下载更新包…',
  verify: '正在校验完整性…',
  extract: '正在解包…',
  switch: '正在切换服务…',
};

export function calculateCombinedProgress(raw: UpdateProgress): CombinedProgress {
  const { stage, progress, speed, eta } = raw;

  // Calculate overall progress
  const stageBase = STAGE_CUMULATIVE[stage];
  const stageWeight = STAGE_WEIGHTS[stage];
  const overall = Math.min(stageBase + stageWeight * progress, 1);

  return {
    overall,
    stage,
    stageProgress: progress,
    message: STAGE_MESSAGES[stage],
    speed: speed ? formatSpeed(speed) : undefined,
    eta: eta ? formatEta(eta) : undefined,
  };
}

function formatSpeed(bytesPerSec: number): string {
  const units = ['B/s', 'KB/s', 'MB/s'];
  let value = bytesPerSec;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}分钟`;
  return `${Math.ceil(seconds / 3600)}小时`;
}
