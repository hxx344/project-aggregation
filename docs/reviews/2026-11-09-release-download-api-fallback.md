# 发布文件下载入口故障时改走 GitHub API 文件接口

风险等级：R3（特权更新器的发布读取与安装器部署包下载）。基线 `04858918d92e26183db1b1fe5451e0facb14bcaa`。

## 事件与证据

用户正式版 `50cdcbcc4301`（已含 11-05 的 504 即时重试）系统更新连续显示“GitHub 发布服务暂时不可用（HTTP 504）”，手动检查同样失败。用户在服务器上逐项重放：

- 只有 `GET https://github.com/hxx344/project-aggregation/releases/download/<tag>/release-manifest.json` 持续返回 504，响应带 `X-GitHub-Request-Id`，无 `Server`/`Via` 代理头。
- 同一时刻 `releases/latest` 跳转、带 Token 的 API 与 `raw.githubusercontent.com` 均为 200。
- 同一时刻 `https://api.github.com/repos/hxx344/project-aggregation/releases/assets/<id>`（`Accept: application/octet-stream`，302 到 `release-assets.githubusercontent.com`）5/5 返回 200，HEAD 同样可用。
- 服务自 11-05 运行，磁盘代码一致，新进程按服务方式重放同样失败，排除进程状态与代理。

结论：发布文件只有 github.com 下载前端一个入口，该前端故障会阻断检查与更新。

## 范围与行为

- `server/update-service/releases.py`：清单 GET（冷读、缓存命中、按 release_id 执行前复核）与部署包 HEAD（缓存探测与完整校验）在 github.com 入口返回可立即重试的失败（502/503/504 或连接失败，且无 `Retry-After`、额度为零或服务器期限），并耗尽原有重试后，按同一 tag 元数据中唯一同名、正整数 ID 的资产改走 API 文件接口一次。404/403/429 与服务器期限不回退。API 或元数据失败时报告原下载错误；只有它们带等待期限时改报该期限。缓存命中路径的元数据只读一次，由两个回退共享，避免放大匿名额度。认证头仍只发往 `api.github.com`，跳转时剥离。清单内容、正式版资格和部署包身份校验不变。
- `deploy/release-common.sh` 的 `CI_DOWNLOAD_PY`（逐字同步到 `deploy/install.sh`、`deploy/install-all.sh`）：官方固定版本包下载按下载器既有可重试判定（408、429、全部 5xx 与连接中断）耗尽后，查询同一已发布、非预发布 tag 中唯一已上传资产，改用 API 文件接口下载一次，仍按官方清单校验 SHA256；回退失败时报告原下载错误，取消与本地错误不回退。镜像逻辑不变。
- `server/update-service/updater.py`：仅更新检查期限注释。
- `LESSONS.md` L013 增补本次事件。

## 失败场景与测试

- `deploy/test-release-cache.py`（61 项通过）：冷读、缓存命中、清单变化、执行前复核四条路径在下载入口 504 时经 API 读取同一文件；永久错误与服务器期限不访问 API；资产 ID 为零/字符串/布尔/缺失、重名、缺资产、tag 不符、assets 非列表均不回退；API 失败报告原错误、API 限流报告其期限；元数据失败（含非 ReleaseError 异常）保留原错误；元数据额度期限在各路径上报告；真实传输层 API 资产请求使用 `application/octet-stream` 并保留 API 认证。禁用回退的变异使新增回退测试失败。
- `deploy/test-release-mirror.py` 新增 `GitHubApiFallback` 7 项：官方入口故障经 API 下载固定版本包；镜像回退后官方再故障仍走 API；终止性官方错误不查询 API；元数据不可用保留原错误；API 内容哈希不符不采用；取消、本地与系统错误不走 API；其他仓库与非固定版本 URL 不走 API。
- `deploy/test-updater.py` 107 项通过（16 项跳过，需 Linux root）。

## 已知限制（登记不修）

- 安装器从 github.com 切换到 API 地址后，按新地址重新下载，此前已完成的分块不续传；仅影响下载入口已故障的情况，最坏多下载一次完整包。
- 安装器的回退条件比更新服务宽（含 408/429），与下载器既有可重试判定一致；回退本身每个分块各计一次匿名 API 额度，因此只作回退。
- 回退期间的信号处理沿用下载器既有机制。
- 未配置 GitHub Token 时，缓存命中路径每次检查回退需 3 次 API 请求，按每分钟自动检查，下载入口持续故障约 20 分钟会耗尽每小时 60 次的匿名额度；之后按服务器给出的期限暂停检查与执行前复核，直到额度重置，即使下载入口已恢复。故障期间原本就一直失败，不是退化；已配置 Token 的部署不受影响。
- 每个端点都慢到超时上限时，缓存命中且清单已变化的检查约 186 秒，略超 180 秒检查期限；超时按既有逻辑记为“版本检查超时”，迟到结果按 checkId 丢弃。

## 回滚

撤销本提交并按既有流程发布正式版即可。无数据格式、配置或缓存结构变化；回滚后恢复为单一下载入口，下载入口故障时重新表现为 HTTP 504 失败。

## 独立审查

两轮只读审查代理，上下文与作者隔离，复杂度 heavy。

- 第一轮：无 P0/P1。P2-1 缓存命中路径读两次元数据且丢失元数据 403 的等待期限，已改为共享一次读取并透传期限；P2-2 安装器切换地址后不续传，登记不修（见上）；P2-3 缺少回退时元数据额度期限的测试，已补。P3：检查期限注释过时、冷读非 ReleaseError 异常替换原错误、LESSONS 文案未区分两端回退条件，均已改；安装器回退期间的信号处理接受现状。
- 第二轮（核查修复）：无 P0/P1/P2，第一轮问题核实已关闭；三份 `CI_DOWNLOAD_PY` 正文逐字一致；P2-2 描述核实准确（分块身份含 URL，不一致时删除分块）。P3-1 匿名额度耗尽、P3-2 个别路径略超检查期限已登记为已知限制；P3-3 HEAD 证据来自用户同次重放；P3-4 变异结果只能来自作者执行记录。第二轮独立运行 release-cache 61 项、mirror 18 项（1 跳过）、download 22 项（3 跳过）、progress 18 项（8 跳过）通过，`git diff --check` 通过。

## 验证

- 已运行（Windows，Python 3.11）：`py -3 deploy\test-release-cache.py` 61 项通过；`py -3 deploy\test-updater.py` 107 项通过（16 项需 Linux root 跳过）；`py -3 deploy\test-release.py` 11 项通过；`py -3 deploy\test-release-mirror.py` 18 项通过（1 跳过）；`py -3 deploy\test-release-download.py` 22 项通过（3 跳过）；Git Bash `bash -n` 三个安装脚本通过；`node --test tests/lessons-routing.test.mjs` 2 项通过；`git diff --check` 通过；禁用回退的变异使新增回退测试失败。
- 未运行：需 root 的安装器与更新器夹具，由 PR 的 Linux CI 运行；未在用户服务器上部署验证，服务器由用户自行更新后在系统更新页重新检查。
