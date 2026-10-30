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
├── windows-job.ps1      # Windows 作业对象约束进程树
├── git-context.mjs      # 受执行器和锁保护的 Git 身份查询
├── identity.mjs         # origin/HEAD 与发布环境身份一致性
├── config-files.mjs     # 渲染及系统配置快照、内容与元数据恢复
├── release-manifest.mjs # 发布清单、架构、路径与真实产物摘要校验
├── digest.mjs           # 输入/产物摘要
├── logger.mjs           # 控制台 + run.jsonl 双写与脱敏
├── state.mjs            # 环境锁、状态文件、journal
└── environments/
    ├── base.json        # 共享骨架：配置声明、默认阶段命令
    ├── dev.json         # 本机开发
    ├── test.json        # CI 测试
    └── prod.json        # 生产发布
```

运行状态、日志和恢复备份落在 `.pipeline/`（已 gitignore）；流水线发布产物单独放在 `output/release/{env}`：

| 路径 | 内容 |
| --- | --- |
| `.pipeline/state/<env>.json` | 各阶段最后状态、幂等键、产物摘要 |
| `.pipeline/runs/<runId>/run.jsonl` | 结构化事件流（每行一个 JSON） |
| `.pipeline/runs/<runId>/journal.jsonl` | 回滚依据：阶段、快照、命令结果 |
| `.pipeline/runs/<runId>/logs/<stage>.log` | 脱敏后的命令输出及终止未确认原因 |
| `.pipeline/runs/<runId>/summary.json` | 本次运行汇总 |
| `.pipeline/runs/<runId>/backups/` | 配置与发布清单快照 |
| `.pipeline/runtime/<env>.env` | 渲染后的运行配置（0600） |
| `.pipeline/locks/<env>.lock` | 环境互斥锁、命令运行中标记及隔离原因 |
| `.pipeline/locks/<env>.lock.guard/` | 获取、回收、标记写入和释放环境锁期间的互斥目录 |
| `output/release/{env}/` | 分架构清单、合并清单与实际 tar.gz 产物 |

## 阶段与执行顺序

顺序固定，后一阶段依赖前一阶段的产物；局部重跑不改变顺序。

| # | 阶段 | 作用 | 校验点 | 失败回滚 |
| --- | --- | --- | --- | --- |
| 1 | `preflight` | 工具链版本、Git 身份、必填配置、所需命令 | 版本满足声明；提交可读；配置无缺失 | 无副作用 |
| 2 | `deps` | `pnpm install --frozen-lockfile` | 锁文件哈希前后一致；`node_modules/.modules.yaml` 存在 | 人工（删除依赖重装） |
| 3 | `config` | 渲染 dotenv，必要时写入系统路径 | 文件存在、0600、必填项齐全、可回读 | 自动恢复上一份或删除新文件 |
| 4 | `build` | `pnpm run build` 或 `build:all` | 声明产物存在且非空 | 由下次构建覆盖 |
| 5 | `verify` | `tsc --noEmit`、行为测试 | 命令退出码 | 只读 |
| 6 | `package` | 打包后执行 `deploy/merge-release-manifests.py` | schema、仓库、提交、标签、架构、路径、真实包 SHA-256 与合并内容一致 | 自动恢复上一份清单 |
| 7 | `publish` | `deploy/publish-release.py` | 清单有效，origin/HEAD 与发布环境身份一致 | 人工（远端 Release） |
| 8 | `activate` | `deploy/install-all.sh --expect-commit {commit}` | `/api/health` 连续探测，且部署记录等于本轮提交 | 安装器负责（保留上一版本） |

`dev` 只执行 1–5；`test` 执行 1–6；`prod` 执行 1–8，其中 `publish` 需要确认，`activate` 需要 `--apply`。

`activate` 只部署本轮提交。当前正式版不是它（尚未晋级，或已被其他版本替换）时，安装器不运行任何项目安装器并以退出码 75 结束，流水线记为 `deferred`，撤销该阶段旧的成功记录，整轮状态也为 `deferred`（退出码仍为 0，这不是失败）；晋级后重跑即可，不回落到 latest，也不安装未晋级的候选。相同输入命中缓存时仍读取健康端点和部署记录：一致则跳过，安装器不重复运行；不一致则撤销旧成功记录，并回落到幂等安装器。

`test`/`prod` 当前显式打包 x64，目录分别为 `output/release/test`、`output/release/prod`；`{releaseDirectory}` 来自 `package.releaseDirectory`。打包前清理目标清单，打包后生成 `release-manifest-x64.json` 与 `release-manifest.json`，历史清单不能补足本次缺失的产物。既有 CI 仍使用 `output/release`：无参数运行 `python3 deploy/merge-release-manifests.py` 仍只读取该目录的 x64 清单，不自动合并历史 arm64 文件；新增摘要校验要求同目录存在清单所指向的真实包。

发布前从 Git `origin` 解析 GitHub 仓库，并核实当前 `HEAD`。流水线向发布子命令传入已验证的 `GITHUB_REPOSITORY`、`GITHUB_SHA`；已有 Actions 环境变量与它们不一致时拒绝发布。该检查也不能被缓存命中绕过。

## 触发条件

| 环境 | 允许触发 | 守卫 |
| --- | --- | --- |
| `dev` | `local`、`manual` | 允许脏工作树，不要求分支 |
| `test` | `pull_request`、`push`、`manual` | 工作树必须干净；`push` 仅限 `main` |
| `prod` | `release`、`manual` | 必须 `main` 且干净；`release` 要求标签匹配 `deploy-*`；`manual` 额外要求 `--confirm-prod` |

守卫在**任何阶段执行前**求值，不满足直接以退出码 3 结束，避免在错误分支上构建或发布。`plan` 会提前展示守卫结果与配置缺失项。

`plan` 和 `run` 要求可读取的 Git 工作树，不支持无 `.git` 的发布归档。提交、分支或工作树状态读取失败时中止；每条 Git 命令超时为 10 秒且不自动重试，仅“没有精确标签”可作为无标签继续检查守卫，仅“没有 origin”记为无发布身份（发布阶段随后拒绝）。

CI 的现有工作流（`.github/workflows/ci.yml`）不变；需要时在 job 中以显式触发条件调用：

```bash
node deploy/pipeline/cli.mjs run --env test --trigger pull_request
```

## 配置管理

- 非敏感声明（类型、默认值、阶段命令、守卫）在 `environments/*.json`，进版本库。
- 敏感值只从进程环境或 `.env.<env>`（已 gitignore）读取，不写入 JSON、日志、状态文件。
- 合并规则：`extends` 链逐层覆盖；配置项按 `name`、阶段按 `id` 字段级合并，命令与输入整体替换；**触发条件不继承**，避免生产意外接受 `push`。
- 系统配置通过 `config.applyTarget` 声明实际写入的绝对路径，`applyCommands` 必须引用 `{applyTarget}`。生产目标为 `/etc/project-aggregation.env`，渲染目标为 `.pipeline/runtime/prod.env`，两者分别快照。`applyWithSudo` 的备份放在运行目录 `backups/privileged/`，共享备份目录先由流水线用户创建。
- 自定义 shell 或提权包装器须在命令中显式设置 `"privileged": true`；直接调用 `sudo`（含绝对路径）会自动识别。该标记必须为布尔值，适用的终止与隔离规则见下文。
- 优先级：进程环境 > `.env.<env>` > 默认值；`"default": null` 表示显式取消父级默认值。
- 生产在服务器上执行时，用现有配置注入进程环境；渲染配置与恢复备份仍可能含敏感值，须保护其权限并保留至恢复完成：

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
| `--dry-run` | 不执行阶段命令或更新阶段缓存；仍执行受锁保护的身份/版本查询并生成运行记录 |
| `--apply` | 允许写入系统配置并执行服务切换 |
| `--confirm-prod` | 生产手动发布的显式确认 |
| `--allow-dirty` | 仅 `dev` 生效，允许脏工作树 |
| `--echo` | 实时输出命令日志 |
| `--json` | `plan`/`config`/`status` 输出 JSON |
| `--run <runId>` / `--yes` | `rollback` 指定运行记录并确认 |

退出码：`0` 成功；`1` 阶段失败；`2` 参数或配置错误；`3` 触发条件不满足；`4` 环境锁被占用。

## 可重复执行

- **环境锁**：同一环境同时只允许一个任务；锁记录流水线 PID、runId、唯一标识与开始时间，内容通过硬链接原子发布。只有持有者已退出、锁可读且没有运行中或隔离标记时，才可自动回收；不按经过时长回收活锁，损坏或读取失败的锁直接拒绝。获取、回收、标记写入和释放期间用 `<env>.lock.guard` 目录串行保护；若进程在这段短操作中退出而留下目录，后续任务拒绝执行，须确认没有流水线进程后人工移除该保护目录。标记写入或释放时若保护目录被竞争者短暂占用，最多等待约 1 秒；释放只删除自身唯一标识对应的锁。
- **命令标记**：在启动任何外部命令前，先持久化 `commandRunning`（命令记录编号、阶段、命令 PID 占位、提权标记）；写入失败则不启动。命令在宽限内正常结束后解除；发生强制终止则转为隔离。`run`、预检、`plan/config` 的外部查询和手动 `rollback` 都受此约束。
- **隔离锁**：发生强制终止时记录 `terminationUnconfirmed`、暂停补偿并保留锁。即使隔离原因写入失败，已有运行中标记仍禁止释放和自动回收；流水线 PID 已退出也不能绕过它。损坏或不可读的现存锁也不自动删除。
- **幂等键**：`阶段声明 + 命令 + 输入内容摘要 + 配置指纹 + 提交 + 工具链` 共同决定。仅复用成功状态中保存的产物摘要基线；键相同且当前文件仍匹配该基线才跳过，日志记录 `stage.skip`。旧状态缺少摘要、阶段失败、文件改写或缺失都重新执行。- **敏感值单独计键**：轮换口令只让 `config` 重跑，不会触发全量重建。
- **产物完整性**：状态里保存声明产物及校验器返回的实际发布包 SHA-256，不以本轮临时计算的摘要充当旧基线。
- **配置应用**：`config` 阶段在 `run --apply` 时每轮执行并重新快照实际目标，不能因渲染文件未变化而跳过系统配置应用。
- `--force` 绕过跳过判断，但仍执行校验点与回滚逻辑。

## 失败回滚

阶段准备、执行或收尾失败时，按本轮已经开始执行阶段的**逆序**补偿，包括已产生写入的失败阶段；只恢复本轮实际做过的工作。记录写入失败不能阻断后续补偿。若命令终止未确认，则先隔离并停止补偿，避免与残留写入并发。

1. `config`：分别恢复实际系统目标与渲染目标的内容、存在性、权限和所有权；只有快照明确记录原文件不存在时才删除新文件。原文件存在但备份缺失时保留现状并报告失败，不以删除替代恢复。
2. `package`：恢复上一份发布清单，或删除本次新增的清单。
3. `publish` / `activate`：不自动执行，输出明确的人工步骤。

手动回滚已完成或具有恢复快照的失败运行（隔离未解除时仍会拒绝执行）：

```bash
node deploy/pipeline/cli.mjs rollback --env prod --run <runId> --dry-run   # 先看计划
node deploy/pipeline/cli.mjs rollback --env prod --run <runId> --yes
```

服务切换的回滚仍由安装器负责：旧程序、systemd 单元、环境文件与 Python 路径记录可恢复，业务数据库写入不回滚（见 [deployment.md](deployment.md#发布验证与失败恢复)）。

## 终止与隔离

流水线不尝试自动证明后代进程已全部停止：在 Linux 上扫描 `/proc` 无法排除 PID 复用、枚举期间派生和无关僵尸等干扰，结论不可靠。因此采用“强制终止即隔离”：

- 超时先向命令发送 TERM（POSIX 发给整个独立进程组，Windows 由 Job 对象约束进程树），默认 5000ms 内直接子进程仍未退出则发送 KILL；再等待最多 5000ms 后必定结算，不依赖 `child.killed`。
- 直接子进程退出后最多等待 1000ms 让输出管道关闭；仍未关闭说明有后代持有管道，强制销毁管道。
- 只要进入过强制终止（超时、日志写入失败、子进程错误或事件顺序异常）、输出管道被强制销毁、Windows Job 在命令退出后强制清理残留后代，或命令被信号终止，结果一律 `terminationUnconfirmed=true`：流水线停止后续阶段与自动补偿，保留隔离锁，等待人工核查。退出码为 0 也按失败处理。
- 直接子进程退出后不再向其 PID/PGID 发送信号，避免误伤复用该编号的无关进程。
- 命令在宽限内正常 exit 并 close 时解除运行标记。此时不检测已脱离原进程组的后代，见“边界”。

生产 `install-all.sh` 以 `setsid … &` 启动独立会话的长时安装器；正常路径会等待它结束，但流水线强制终止父进程时不能证明该 root 安装器已停止，因此同样隔离。

## 人工解除隔离

**主进程已退出或原进程组为空，都不能作为解除依据**，尤其是提权命令、隔离记录写入失败或只剩 `pid: null` 的预写标记。以下为 Linux 服务器上的人工核查，不是自动解锁脚本。无法证明相关部署写入全部停止时，保持隔离。

1. 暂停自动触发和并行流水线，读取环境锁，核对其流水线 PID、阶段、runId、命令记录编号与原因。保留 `.pipeline/runs/<runId>/` 的 journal、日志和备份；手动 rollback 的锁 runId 末尾带 `-rollback`，对应原运行目录去掉这个后缀。

   ```bash
   cd /path/to/project-aggregation
   pipeline_lock="$PWD/.pipeline/locks/prod.lock"  # 按目标环境替换
   sudo cat "$pipeline_lock"
   sudo ps -eo pid,ppid,pgid,sid,user,lstart,args --forest
   sudo ls -lt /var/log/project-aggregation-stack
   ```

2. 以 root 对照对应安装器运行目录的 `hub.log`、`hub.download.log`、`summary.txt` 和流水线日志，核实安装器及下载、构建等工作进程的 PID、启动时间、会话和写入目标。例如将运行目录占位符替换后读取：

   ```bash
   sudo tail -n 80 "/var/log/project-aggregation-stack/<运行目录>/hub.log"
   sudo fuser -v /run/lock/project-aggregation-stack.lock
   sudo flock -n /run/lock/project-aggregation-stack.lock -c true
   ```

   `fuser` 检查打开该文件的进程，`flock` 只检查该时刻能否取得独立锁；两者都不是单独的停止证明。**不要删除或截断 `/run/lock/project-aggregation-stack.lock`**，否则可能绕过仍在使用旧锁 inode 的安装器。

3. 若确认仍有相关写入，先让受信安装器正常结束或由 root 对核实的 PID 发 TERM，并等待它完成恢复；必要的进一步处置由 root 决定。重复核对进程、日志与独立锁，区分应继续运行的 systemd 服务和部署工作进程。没有退出日志也不能凭 PID 消失猜测恢复完成。

4. 只有已证明流水线与相关部署工作进程停止、独立锁空闲且恢复材料已保存时，才备份并删除**这一环境锁**：

   ```bash
   sudo cp -p --no-clobber -- "$pipeline_lock" "$pipeline_lock.manual-$(date -u +%Y%m%dT%H%M%SZ).bak" &&
     sudo rm -- "$pipeline_lock"
   ```

   如遗留 `<env>.lock.guard/`，还须核实没有流水线进程运行，再用 `sudo rmdir -- "$pipeline_lock.guard"` 移除空目录。随后再选择手动回滚或重新执行；回退流水线代码前也必须先完成这些核查。

## 日志

- 控制台：`[时间] 级别 [阶段] 消息`，便于人工跟踪。
- `run.jsonl`：`ts`、`level`、`event`、`runId`、`env`、`stage`、`msg`、`data`，可直接被脚本消费。
- `journal.jsonl`：额外记录快照、命令退出码与耗时，是回滚的唯一依据。
- 脱敏：已知敏感值在消息与字段中被替换为 `***`，敏感键也屏蔽；不记录整份命令环境。
- 脱敏后的命令输出写入 `logs/<stage>.log`，失败时摘要最后 40 行到错误信息；终止未确认原因同时进入错误日志和 journal。存储故障时保守标记仍阻止继续执行。

## 验证

相关验证入口（实际结果以对应版本的运行记录为准）：

- `node --test tests/pipeline.test.mjs tests/pipeline-recovery.test.mjs tests/pipeline-activate.test.mjs`：配置、缓存、发布身份、实际目标恢复、锁写入故障、强制终止即隔离与有界结算；激活绑定本轮提交与缓存命中后的运行态核验。
- `py -X utf8 -B deploy/test-package-layout.py -v`（Linux 使用 `python3`）：包布局、合并器真实产物摘要、默认 x64 与无参数 CI 调用兼容性。
- 对 `deploy/pipeline/*.mjs` 和两份流水线测试逐文件执行 `node --check`，再执行 `git diff --check`。
- Windows 原生测试验证 Job 对象与可注入进程夹具；实际 Linux 的忽略 TERM、后代持有管道等场景在 Windows 跳过，须在 Linux CI 验证，不使用 WSL。

未运行（需在对应环境执行）：

- `run --env test`：需要 Node 24.15.0、pnpm 11.25.0 与完整依赖，会执行全量构建、测试与打包。
- `run --env prod`：需要 `main` 干净工作树、`deploy-*` 标签或 `--confirm-prod`、`PUBLIC_ORIGIN`、`INITIAL_PASSWORD`，以及 GitHub 凭据。
- `activate`：需要目标服务器与 sudo，未获当次授权不执行。

## 边界

- 流水线不替代 CI 的安装器检查与发布晋级；`publish` 调用既有脚本，同时校验并传递当前 origin/HEAD 身份及清单。
- 命令正常 exit 并 close 后，不检测已脱离原进程组、且不再持有输出管道的后代。仅接受仓库内受信脚本，要求脚本等待部署工作完成，服务进程由 systemd 管理，不能自行后台派生服务。
- POSIX 的强制终止只覆盖原进程组；脱组后代由隔离锁和人工核查兜底，不自动证明其停止。Windows 使用 Job 对象约束进程树。`install-all.sh` 的独立会话安装器在强制终止时同样隔离，不因原进程组为空而自动解除。
- 不对远端 Release 做自动撤回，不对服务器做自动降级。
- 不缓存构建产物到外部存储；复用只发生在本地状态与现有模块缓存。
