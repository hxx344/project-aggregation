# 正式包与生成服务入口的验收证据（#316）

风险等级：R2（发布验证与 CI 产物留存）。基线 `0c8adc20b4485f1a71fabb6254142ec083619fa1`。

## 范围与回滚

`tests/entry-symlink.test.mjs` 调用当前安装器的 `write_unit`，读取生成单元的 `ExecStart` 和 `WorkingDirectory`，沿 `current` 与 `slots/a`、`slots/b` 启动真实 runtime/API/entry。配置故意在启动前被拒绝，要求退出码 1 和对应入口的诊断；错误路径、导入失败、导入后退出 0 或超时都不算成功。生成脚本预算 15 秒、每个入口 30 秒，不自动重试。

`deploy/test-workspace.sh` 的 package lane 在实际 tar 解包目录上再运行同一探针；原有五模块恢复与 launcher/API 重启检查继续执行。`scripts/verify-embedded.mjs` 只为这些既有检查增加有界证据输出。CI 保存 `deployment-evidence-x64`，与同次 `deployment-package-x64` 分开：

- `generated-entries.json`：包 SHA256、包内提交号、Actions run/attempt/job、五个实际生成的启动命令和工作目录、预期拒绝与三个负对照。脚本真实路径必须等于包内该单元的预期入口。
- `package-runtime.json`：同一包身份与 Actions 身份，实际 runtime PID/实例、API 重启前后 PID、采集前后观测时间、未变的模块代次和执行租约保持结果。

没有修改生产安装、鉴权、维护、交易或回滚逻辑，也没有额外下载、构建或重启用户服务。撤销这次测试与 CI 变更即可回滚，已有发布与用户数据不变。任何新探针或证据写入失败都令相应 CI 作业失败，不能发布为已验收候选。

## 证据分层与复用

同次提交的 Checks 作业必须实际通过，表中引用只定位断言，不单独代表执行成功。正式包摘要应与 `release-manifest.json` 的对应架构资产摘要核对。

| 条件 | 入口与实际断言 | CI 作业 / 证据层次 |
| --- | --- | --- |
| 生成命令确实执行真实入口 | `tests/entry-symlink.test.mjs` 的 `generated systemd units`；包内五个命令，错误路径与零退出负对照 | App package；解包真实产物，故意拒绝配置；不是 systemd 成功启动 |
| API 重启保留 runtime、模块与采集 | `scripts/verify-embedded.mjs`：runtime PID/实例不变，模块代次不变，`checkedAt` 推进，租约保持并续期 | App package；真实五模块及 launcher，隔离网络，无交易所实盘数据；输出 `package-runtime.json` |
| 真实 systemd API-only 更新 | `deploy/test-units-systemd.sh`：只重启 API，runtime PID/旧 release 保持 | Installer (recovery, release and updater)；真实 systemd，业务入口是替身 |
| 双槽在线切流 | `deploy/test-slots-systemd.sh`：真实 API/entry 负载切槽、runtime/entry PID 保持、会话/旧资源继续可用 | Installer (dual-slot units under real systemd)；runtime 使用测试模块，非真实五模块 |
| API-only 发现需 full 时返回 75 | `deploy/test-ci-install.sh`、`deploy/test-ci-install-dual.sh`：实际安装器 main 不切 current、不停 runtime、不写激活记录 | Installer (activation, incremental and stack)；受控安装夹具 |
| 75 后重新生成 full 计划 | `CoordinatorTests.test_refused_api_update_leaves_release_unchanged_and_next_plan_is_full` | Installer (recovery, release and updater)；真实协调器，外部接口替身 |
| prepare 返回 76 且不激活 | `deploy/test-ci-install.sh`：链接、部署记录和运行时保留，无 start/stop/restart；后续正常入口激活已准备目录 | Installer (activation, incremental and stack)；受控安装夹具 |
| prepare 不进入维护，activate 重取停机证据 | `tests/embedded-updates.test.mjs` 的 `a prepare job runs without trading maintenance` | App behavior；真实协调器与模块测试替身 |
| 准备计划、过期与材料失效 | `CoordinatorTests.test_prepared_release_keeps_the_plan_until_its_activation`、`test_expired_plan_and_changed_local_identity_cannot_launch_worker`、`test_changed_protected_old_plan_cannot_authorize_recovery` | Installer (recovery, release and updater)；计划生命周期及共用的准入校验，不把过期材料当新授权 |

采集证据表示 API 重启前后同一 runtime 的周期读取尝试继续推进；`checkedAt` 取项目最大值，失败读取也可能推进，不能据此声称每个模块都成功采集或逐帧无缺口。模拟安装、生成入口拒绝、真实 systemd、真实五模块包检查分别保留边界，不能相互替代。

## 本地验证

- Windows 原生：两个修改的 `.mjs` 通过 `node --check`；Git Bash `D:/Git/bin/bash.exe -n deploy/test-workspace.sh` 通过；工作流 YAML 解析及证据上传步骤核对通过；`git diff --check` 通过。
- 四个已存在的计划/过期/75/材料失效回归通过；prepare/activate 维护准入回归 1 通过。类型检查复用 #274 后未变类型输入的通过结果。
- 新增 POSIX 生成入口、真实发布包、systemd 与安装 main 验收等待本次非 WSL Linux CI。未运行浏览器或部署用户服务器。

## 独立审查

隔离只读代理 `review_entry_evidence`，调用参数 `gpt-6-astra / ultra`。首轮无 P0/P1，确认一个 P2：原探针只验证工作目录，指向另一发布目录且返回相同拒绝消息的入口仍可通过。已按单元核对脚本真实路径，并补对应负对照；其余参数传递、权限及证据边界无阻断。审查者独立执行 Node/Bash 语法与差异检查，并用 Windows 原生隔离夹具复现 P2。增量复核验证正确入口通过、跨目录/缺失入口拒绝、import-only 真实零退出拒绝，去掉路径断言后跨目录负对照失败；无新增 P0–P3。采集前值复用 60 秒轮询预算及既有请求超时，避免尚无首次记录时将零值当作有效基线；独立复核确认，轮询预算不等于严格的墙钟总上限。最终 Linux CI / 正式包身份以本次交付记录为准。
