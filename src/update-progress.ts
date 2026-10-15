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

const STAGE_DESCRIPTIONS: Record<UpdateStage, string> = {
  preflight: '检查版本、部署环境与更新条件。',
  download: '下载完成后继续安装；当前百分比仅表示本阶段进度。',
  prepare: '准备运行环境、依赖和已有配置。',
  build: '按需构建工作台及内置模块，耗时取决于服务器性能。',
  verify: '运行必要校验，确认更新可以继续。',
  extract: '展开已下载的构建产物并准备发布目录。',
  switch: '切换到新版本并重启受影响的服务。',
  finalize: '检查服务健康状态并完成更新服务安装。',
};

const DETAILS: Record<string, { stage: UpdateStage; message: string }> = {
  'source-receive': { stage: 'download', message: '正在接收源码对象…' },
  'source-retry': { stage: 'download', message: '正在重试源码下载…' },
  'source-resolve': { stage: 'prepare', message: '正在解析源码与版本…' },
  dependencies: { stage: 'prepare', message: '正在准备项目依赖…' },
  runtime: { stage: 'prepare', message: '正在准备运行环境…' },
  'build-workbench': { stage: 'build', message: '正在构建工作台…' },
  'build-monitor': { stage: 'build', message: '正在构建市场监控…' },
  'build-asset': { stage: 'build', message: '正在构建资产账本…' },
  'build-crossex': { stage: 'build', message: '正在构建跨所交易…' },
  'build-aster': { stage: 'build', message: '正在构建 Aster 模块…' },
  typecheck: { stage: 'verify', message: '正在检查代码类型…' },
  tests: { stage: 'verify', message: '正在运行更新测试…' },
  healthcheck: { stage: 'finalize', message: '正在检查服务健康状态…' },
  updater: { stage: 'finalize', message: '正在安装更新服务…' },
};

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const STAGE_LABELS: Record<UpdateStage, string> = {
  preflight: '更新条件检查', download: '下载更新文件', prepare: '依赖与配置准备', build: '应用构建',
  verify: '更新校验', extract: '解包与发布目录准备', switch: '服务切换', finalize: '安装收尾',
};
const DETAIL_LABELS: Record<string, string> = {
  'source-receive': '源码接收', 'source-retry': '源码下载重试', 'source-resolve': '源码与版本解析',
  dependencies: '项目依赖准备', runtime: '运行环境准备', 'build-workbench': '工作台构建',
  'build-monitor': '市场监控构建', 'build-asset': '资产账本构建', 'build-crossex': '跨所交易构建',
  'build-aster': 'Aster 模块构建', typecheck: '代码类型检查', tests: '更新测试',
  healthcheck: '服务健康检查', updater: '更新服务安装',
};

export function formatUpdateDuration(milliseconds: number): string {
  if (milliseconds < 1000) return '不足 1 秒';
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', rest ? `${rest} 秒` : ''].filter(Boolean).join(' ');
}

/** Completed-task measurements come from the installer; the browser never times phases. */
export function getUpdateTimingSummary(job: UpdateJob | null | undefined) {
  if (!job || !['succeeded', 'failed', 'interrupted'].includes(job.status)) return null;
  const start = Date.parse(job.startedAt), end = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  const total = Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatUpdateDuration(end - start) : null;
  const empty = { total, entries: [] as Array<{ key: string; label: string; duration: string }> };
  const raw: unknown = job.stageTimings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const { entries } = raw as Record<string, unknown>;
  if (!Array.isArray(entries) || !entries.length || entries.length > 32) return empty;
  const result = [], seen = new Set<string>();
  for (const row of entries) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return empty;
    const { stage, detail, durationMs } = row as Record<string, unknown>;
    if (typeof stage !== 'string' || !Object.hasOwn(STAGE_LABELS, stage)
      || detail !== undefined && (typeof detail !== 'string' || !Object.hasOwn(DETAILS, detail) || DETAILS[detail].stage !== stage)
      || durationMs !== null && (!nonnegative(durationMs) || durationMs > Number.MAX_SAFE_INTEGER)) return empty;
    const key = `${stage}:${detail ?? ''}`;
    if (seen.has(key)) return empty;
    seen.add(key);
    result.push({ key, label: typeof detail === 'string' ? DETAIL_LABELS[detail] : STAGE_LABELS[stage as UpdateStage],
      duration: durationMs === null ? '未完整记录' : formatUpdateDuration(durationMs as number) });
  }
  return { total, entries: result };
}

/** Progress belongs to the current task; no UI state or estimated stage weights. */
export function getUpdateProgress(job: UpdateJob | null | undefined): UpdateProgressView | null {
  if (!job || !['queued', 'running'].includes(job.status)) return null;
  const raw: unknown = job.progress;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const { stage, detail, progress, timestamp, downloaded, total, speed, eta } = data;
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

  const detailView = typeof detail === 'string' && Object.hasOwn(DETAILS, detail) && DETAILS[detail].stage === stage ? DETAILS[detail] : undefined;
  const receivingObjects = detailView && detail === 'source-receive';
  const downloading = stage === 'download' && !(detailView && detail === 'source-retry');
  const knownByteTotal = downloading && !receivingObjects && typeof total === 'number';
  return {
    stage: stage as UpdateStage,
    stageProgress: progress as number | undefined,
    message: detailView?.message || STAGE_MESSAGES[stage as UpdateStage],
    description: receivingObjects ? '百分比表示 Git 对象接收数量，下载字节总量未知。'
      : detailView && detail === 'source-retry' ? '连接恢复后继续接收源码，速率以新的下载测量为准。'
      : STAGE_DESCRIPTIONS[stage as UpdateStage],
    progressLabel: receivingObjects ? '对象接收' : '本阶段',
    downloaded: downloading && typeof downloaded === 'number' ? formatBytes(downloaded) : undefined,
    total: knownByteTotal ? formatBytes(total) : undefined,
    speed: downloading && typeof speed === 'number' ? `${formatBytes(speed)}/s` : undefined,
    eta: knownByteTotal && typeof eta === 'number' ? formatEta(eta) : undefined,
  };
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
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
