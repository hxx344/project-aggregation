/** 流水线常量：阶段顺序、触发条件与状态取值。新增阶段时同步 docs/deployment-pipeline.md。 */
export const PIPELINE_VERSION = '1.0.0';

/** 阶段顺序即执行顺序；依赖关系由顺序表达，避免并行阶段互相覆盖产物。 */
export const STAGE_ORDER = ['preflight', 'deps', 'config', 'build', 'verify', 'package', 'publish', 'activate'];

export const TRIGGER_IDS = ['local', 'pull_request', 'push', 'release', 'manual'];

/** 环境标识同时是 deploy/pipeline/environments/<id>.json 的文件名。 */
export const ENV_IDS = ['dev', 'test', 'prod'];

export const STATUS = {
  ok: 'ok',
  skipped: 'skipped',
  failed: 'failed',
  planned: 'planned',
  deferred: 'deferred',
  rolledBack: 'rolled_back',
};

export const STATE_SCHEMA = 1;

/** 流水线自带的查询子进程在内部命令被超时或信号终止时写到 stderr 的标记，执行器据此隔离。 */
export const CHILD_FORCED_MARKER = 'PIPELINE_CHILD_FORCED_TERMINATION';
