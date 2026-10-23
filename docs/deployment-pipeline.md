# 自动化环境配置与部署流水线

本文说明 `deploy/pipeline/` 的编排层：它把依赖安装、配置渲染、构建、校验、打包、发布和服务切换串成一条可重复执行、失败可回滚的流程。安装器（`deploy/install.sh`、`deploy/install-all.sh`）仍是服务器激活的唯一实现，流水线只在 `activate` 阶段调用它，不复制其逻辑。

## 结构

```
deploy/pipeline/
├── cli.mjs              # 入口：plan / run / config / status / rollback
├── constants.mjs        # 阶段顺序、触发条件、状态取值
├── config.mjs           # 环境配置继承、类型校验、指纹、dotenv 渲染
├── plan.mjs             # 触发守卫、阶段计划、幂等键、跳过判断、回滚计划
├── stages.mjs           # 八个阶段的执行、校验点与补偿动作
├── exec.mjs             # 参数化命令执行、超时终止、dry-run
├── digest.mjs           # 输入/产物摘要
├── logger.mjs           # 控制台 + run.jsonl 双写与脱敏
├── state.mjs            # 环境锁、状态文件、journal
└── environments/
    ├── base.json        # 共享骨架：配置声明、默认阶段命令
    ├── dev.json         # 本机开发
    ├── test.json        # CI 测试
    └── prod.json        # 生产发布
```

运行期文件全部落在 `.pipeline/`（已 gitignore）：

| 路径 | 内容 |
| --- | --- |
| `.pipeline/state/<env>.json` | 各阶段最后状态、幂等键、产物摘要 |
| `.pipeline/runs/<runId>/run.jsonl` | 结构化事件流（每行一个 JSON） |
| `.pipeline/runs/<runId>/journal.jsonl` | 回滚依据：阶段、快照、命令结果 |
| `.pipeline/runs/<runId>/logs/<stage>.log` | 命令原始输出 |
| `.pipeline/runs/<runId>/summary.json` | 本次运行汇总 |
| `.pipeline/runs/<runId>/backups/` | 配置与发布清单快照 |
| `.pipeline/runtime/<env>.env` | 渲染后的运行配置（0600） |
| `.pipeline/locks/<env>.lock` | 环境互斥锁 |

## 阶段与执行顺序

顺序固定，后一阶段依赖前一阶段的产物；局部重跑不改变顺序。

| # | 阶段 | 作用 | 校验点 | 失败回滚 |
| --- | --- | --- | --- | --- |
| 1 | `preflight` | 工具链版本、Git 身份、必填配置、所需命令 | 版本满足声明；提交可读；配置无缺失 | 无副作用 |
| 2 | `deps` | `pnpm install --frozen-lockfile` | 锁文件哈希前后一致；`node_modules/.modules.yaml` 存在 | 人工（删除依赖重装） |
| 3 | `config` | 渲染 dotenv，必要时写入系统路径 | 文件存在、0600、必填项齐全、可回读 | 自动恢复上一份或删除新文件 |
| 4 | `build` | `pnpm run build` 或 `build:all` | 声明产物存在且非空 | 由下次构建覆盖 |
| 5 | `verify` | `tsc --noEmit`、行为测试 | 命令退出码 | 只读 |
| 6 | `package` | `deploy/package-release.py` | 清单提交与当前提交一致、SHA-256 有效、包存在 | 自动恢复上一份清单 |
| 7 | `publish` | `deploy/publish-release.py` | 清单标签为 `deploy-*` | 人工（远端 Release） |
| 8 | `activate` | `deploy/install-all.sh` | `/api/health` 连续探测 | 安装器负责（保留上一版本） |

`dev` 只执行 1–5；`test` 执行 1–6；`prod` 执行 1–8，其中 `publish` 需要确认，`activate` 需要 `--apply`。

## 触发条件

| 环境 | 允许触发 | 守卫 |
| --- | --- | --- |
| `dev` | `local`、`manual` | 允许脏工作树，不要求分支 |
| `test` | `pull_request`、`push`、`manual` | 工作树必须干净；`push` 仅限 `main` |
| `prod` | `release`、`manual` | 必须 `main` 且干净；`release` 要求标签匹配 `deploy-*`；`manual` 额外要求 `--confirm-prod` |

守卫在**任何阶段执行前**求值，不满足直接以退出码 3 结束，避免在错误分支上构建或发布。`plan` 会提前展示守卫结果与配置缺失项。

`plan` 和 `run` 要求可读取的 Git 工作树，不支持无 `.git` 的发布归档。提交、分支或工作树状态读取失败时中止；每条 Git 命令超时为 10 秒且不自动重试，仅“没有精确标签”可作为无标签继续检查守卫。

CI 的现有工作流（`.github/workflows/ci.yml`）不变；需要时在 job 中以显式触发条件调用：

```bash
node deploy/pipeline/cli.mjs run --env test --trigger pull_request
```

## 配置管理

- 非敏感声明（类型、默认值、阶段命令、守卫）在 `environments/*.json`，进版本库。
- 敏感值只从进程环境或 `.env.<env>`（已 gitignore）读取，不写入 JSON、日志、状态文件。
- 合并规则：`extends` 链逐层覆盖；配置项按 `name`、阶段按 `id` 字段级合并，命令与输入整体替换；**触发条件不继承**，避免生产意外接受 `push`。
- 优先级：进程环境 > `.env.<env>` > 默认值；`"default": null` 表示显式取消父级默认值。
- 生产在服务器上执行时，用现有配置注入进程环境，不新增凭据副本：

```bash
set -a; . /etc/project-aggregation.env; set +a
node deploy/pipeline/cli.mjs run --env prod --trigger release
```

- 类型支持 `string`、`port`、`integer`、`boolean`、`url`、`path`、`enum`，可附加 `minLength`、`pattern`、`absolute` 等约束。
- 查看解析结果（敏感值显示 `***`）：

```bash
node deploy/pipeline/cli.mjs config --env prod
```

## 参数

```bash
node deploy/pipeline/cli.mjs <plan|run|config|status|rollback> [选项]
```

| 选项 | 说明 |
| --- | --- |
| `--env <dev\|test\|prod>` | 目标环境，默认 `dev` |
| `--trigger <条件>` | 默认 `dev=local`、`test/prod=manual` |
| `--from` / `--to` | 从/到指定阶段（含），用于分段重跑 |
| `--only a,b` / `--skip a,b` | 只跑或跳过指定阶段 |
| `--force` | 忽略历史状态强制重跑 |
| `--dry-run` | 只打印命令，不执行、不写状态 |
| `--apply` | 允许写入系统配置并执行服务切换 |
| `--confirm-prod` | 生产手动发布的显式确认 |
| `--allow-dirty` | 仅 `dev` 生效，允许脏工作树 |
| `--echo` | 实时输出命令日志 |
| `--json` | `plan`/`config`/`status` 输出 JSON |
| `--run <runId>` / `--yes` | `rollback` 指定运行记录并确认 |

退出码：`0` 成功；`1` 阶段失败；`2` 参数或配置错误；`3` 触发条件不满足；`4` 环境锁被占用。

## 可重复执行

- **环境锁**：同一环境同时只允许一个任务；锁内容通过硬链接原子发布，持有进程退出或超过 6 小时才回收。损坏锁仅在文件 mtime 超过 6 小时后回收，读取失败直接拒绝。获取、回收和释放期间用 `<env>.lock.guard` 目录串行保护；若进程在这段短操作中退出而留下目录，后续任务拒绝执行，须确认没有流水线进程后人工移除该保护目录。释放时若保护目录被竞争者短暂占用，最多等待约 1 秒；释放只删除自身唯一标识对应的锁。
- **幂等键**：`阶段声明 + 命令 + 输入内容摘要 + 配置指纹 + 提交 + 工具链` 共同决定。键相同且产物摘要仍匹配时跳过该阶段，日志记录 `stage.skip`。
- **敏感值单独计键**：轮换口令只让 `config` 重跑，不会触发全量重建。
- **产物完整性**：状态里保存每个产物的 SHA-256；文件被改动或删除会拒绝复用。
- `--force` 绕过跳过判断，但仍执行校验点与回滚逻辑。

## 失败回滚

阶段失败时，按本次已成功阶段的**逆序**执行补偿，且只回滚本次运行实际做过的阶段：

1. `config`：有备份则恢复，无备份则删除本次生成的文件。
2. `package`：恢复上一份发布清单，或删除本次新增的清单。
3. `publish` / `activate`：不自动执行，输出明确的人工步骤。

手动回滚一次已完成的运行：

```bash
node deploy/pipeline/cli.mjs rollback --env prod --run <runId> --dry-run   # 先看计划
node deploy/pipeline/cli.mjs rollback --env prod --run <runId> --yes
```

服务切换的回滚仍由安装器负责：旧程序、systemd 单元、环境文件与 Python 路径记录可恢复，业务数据库写入不回滚（见 [deployment.md](deployment.md#发布验证与失败恢复)）。

## 日志

- 控制台：`[时间] 级别 [阶段] 消息`，便于人工跟踪。
- `run.jsonl`：`ts`、`level`、`event`、`runId`、`env`、`stage`、`msg`、`data`，可直接被脚本消费。
- `journal.jsonl`：额外记录快照、命令退出码与耗时，是回滚的唯一依据。
- 脱敏：已知敏感值在消息与字段中被替换为 `***`；键名匹配 `password|secret|token|credential|key` 的值同样屏蔽；命令的环境变量不落盘。
- 命令原始输出写入 `logs/<stage>.log`，失败时摘要最后 40 行到错误信息。

## 验证

已运行（本机 Windows，Node 22.22.2）：

- `node --test tests/pipeline.test.mjs`：14 项通过，覆盖继承合并、配置校验与优先级、指纹与敏感值隔离、触发守卫、阶段计划、幂等键、跳过判断、环境锁回收、回滚计划、日志脱敏、版本比较。
- `node deploy/pipeline/cli.mjs plan --env dev|test|prod`：计划与守卫输出符合预期（生产缺配置、脏工作树、无标签均被拦截）。
- `node deploy/pipeline/cli.mjs run --env dev --only config`：首次渲染 0600 配置，第二次因输入与产物未变而跳过。
- `node deploy/pipeline/cli.mjs run --env dev --only config,build --force`：构建失败后配置阶段自动恢复，状态标记 `rolled_back`，退出码 1。
- `node deploy/pipeline/cli.mjs rollback --env dev --run <runId> --yes`：恢复运行前的配置内容。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。`pnpm run check` 因本机 pnpm 12.11.2 缺少对应原生包未能启动，与本次改动无关。

未运行（需在对应环境执行）：

- `run --env test`：需要 Node 24.15.0、pnpm 11.25.0 与完整依赖，会执行全量构建、测试与打包。
- `run --env prod`：需要 `main` 干净工作树、`deploy-*` 标签或 `--confirm-prod`、`PUBLIC_ORIGIN`、`INITIAL_PASSWORD`，以及 GitHub 凭据。
- `activate`：需要目标服务器与 sudo，未获当次授权不执行。

## 边界

- 流水线不替代 CI 的安装器检查与发布晋级；`publish` 仍调用既有脚本，正式发布身份与清单校验以 CI 为准。
- 不对远端 Release 做自动撤回，不对服务器做自动降级。
- 不缓存构建产物到外部存储；复用只发生在本地状态与现有模块缓存。
