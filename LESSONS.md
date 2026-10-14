# Lessons from merged work

这里保存 project-aggregation 的项目经验，以及有明确来源的外仓参考。改动前按适用条件读取；每条先给规则，再给原因、证据与验证方法。升级条件统一见 [代码规范](docs/code-standards.md#升级规则)。

历史材料来自 2026-10-12/13 的复盘，涉及 project-aggregation、asset-ledger、market-spread-monitor、gate-crossex-arbitrage、variational-grid、greeks、aster_5x。原记录称 10-12 共约 61 次提交；该统计本次未重算。原 “Seen 1×” 表示一次复盘日记录，不代表已核实的独立复发事件。本次只校准经验文档及本仓证据，没有重新执行下列业务测试，也没有完成全历史复盘。

2026-10-14 日复盘覆盖此前 L012 合入之后的约 27 个提交，审到主线 `f7485bb7`。范围包括 Gate 资产估值、发布身份、pnpm workspace、Crossex 别名/资金费/ADL/流水，以及更新器 token。本轮新增 L024–L026。这三条各自只有 2026-10-14 一个复盘日，未达到 [升级条件](docs/code-standards.md#升级规则)，仍留在本文件。全历史复盘尚未完成，`docs/review-state.json` 的完成检查点保持未建立；本仓库不使用 `reviewed-through` 注释。

每条历史线索保留稳定 ID、原复盘日期和全部原有证据。实际发生日期、独立事件边界未完成核实时，不计入规范升级；后续核实时沿用 ID 或明确关联正式事件，避免重复统计。外仓证据标注“未核验”，不将其实现或测试描述为本仓已有能力。

## Correctness at the boundary

### L001：累计失败与锁定状态分别处理

**适用条件：** 使用失败次数与截止时间表示账户锁定的路径；具体阈值以当前配置为准。

**根因：** 未达阈值就写入锁定时间会提前拒绝登录；把 `until=0` 当成过期记录删除，会丢失累计失败次数。

**以后做法：** 新增一次失败后再判断是否达到阈值。当前实现中 `until=0` 表示仅计数、未锁定，清理只处理 `until > 0 && until < now`；成功登录按契约清零。

**证据：** 本仓 `7543c3a1` 引入锁定；`023eaac3` 修复未达阈值误设截止时间；`8e272fd3` 修复清理误删未锁定计数；`5b148191` 增加专项测试。后者父版本已先自增再比较，不能仅凭提交标题把它算成另一次 off-by-one 缺陷。

**如何验证：** 涉及这一路径时运行 [账户锁定测试](tests/account-lockout.test.mjs)，确认当前阈值 5 下前四次失败、第五次锁定、锁定中正确密码仍被拒绝及成功后清零。5 次是本项目当前配置，不推广成通用阈值。

**事件记录：** `legacy-lockout-20261012`；历史复盘 2026-10-12（Seen 1×）；实际发生日期及独立性待核实，暂不计入升级。

### L002：缓存必须保持当前 coverage 的读取语义

**适用条件：** 接口约定按当前 funding coverage/events 计算的 [收益读取路径](server/trading-pnl.mjs)，包括记录样本后仍会补录覆盖与事件的场景。

**根因：** 采样时预计算的列无法反映后来更新的 coverage/events，直接用它替代当前计算会返回过期收益。

**以后做法：** 保持当前读取契约。若引入缓存，应有覆盖更新时的失效或重算机制；不能把所有金融读取一概判定为不可缓存。

**证据：** 本仓 `32578ed6` 将 funding 计算移入 `record()`，试图用写入时预计算加速读取；`4ea30289` 恢复按当前 events/coverage 计算。它们属于同一优化与修复链。

**如何验证：** [收益配对测试](tests/trading-pnl-pairs.test.mjs) 包含记录样本后补 coverage/funding event 的场景；不重写样本，读取仍应反映新覆盖。选取相关用例，不因此机械运行所有交易模块测试。

**事件记录：** `legacy-funding-read-20261012`；历史复盘 2026-10-12（Seen 1×）；实际发生日期及独立性待核实，暂不计入升级。

### L003：合并恢复事件，按页面连接方式保留兜底读取

**适用条件：** `visibilitychange`、`focus`、`pageshow`、网络恢复等事件可能成组触发的页面。

**根因：** 多个恢复事件会重复发起读取，流重连和请求取消可能交错；后到的事件还可能误取消恢复窗口中新启动的请求。仅轮询的页面没有可等待的 EventSource 状态。

**以后做法：** 合并重复恢复工作，区分旧请求与本轮新请求，按页面实际连接方式保留必要的兜底。使用推送流的页面检查流是否已提供可用更新；离线与卸载时取消延迟工作。延迟长短由连接与交互需求确定，不能将当前的 1000ms 作为所有页面的永久规则。

**证据：** 本仓 `c41ce40` 修改 [App](src/App.tsx) 与 [UpdateStatus](src/UpdateStatus.tsx)；`3f63db5`、`9382521` 补充恢复事件合并与新请求保护。`fc94b0a` 是保留的历史对象，其三个交易页源文件内容对应主线 `3a2cf14`，不能算成两次事件。[TradingPositions](src/TradingPositions.tsx)、[OilTradingPage](src/OilTradingPage.tsx)、[TradingExecution](src/TradingExecution.tsx) 使用延迟轮询，不具备这里所述的 EventSource live 判断。旧说明的“约 40% 失败”和“接近 0%”没有附带可复核测量，不作为结论或验收标准。

**本轮补充证据：** 2026-10-13 对 `3a2cf14` 的局部审查确认：三个交易页每次恢复都另建延迟回调，`TradingExecution` 还会重复启动递归轮询链。当前修复合并恢复回调、保留窗口中新读取，并在离线和卸载时取消延迟任务。独立复核另以虚拟时钟复现：隐藏页每 10 秒收到一次焦点事件时，若每次重置后台计时器，60 秒内没有后续读取；修复改为只补建缺失计时器。以上属于本轮连续修补，不增加独立事件计数。

**如何验证：** [恢复交互检查](tests/resume-refresh.browser.mjs) 覆盖 App/UpdateStatus 的事件突发合并、流先到取消兜底、离线取消、重新联网、新请求保留和退出清理。[交易恢复检查](tests/trading-resume.browser.mjs) 直接覆盖三个交易页的事件合并、旧请求替换、组合切换中新读取保留、离线取消、单一执行轮询链、隐藏重连及卸载清理，并确认自动恢复不发送写请求；隐藏事件连发用例已在修复前构建上复现失败。按改动范围选取 [观察页轮询](tests/trading-poll.browser.mjs)、[仓位](tests/trading-positions.browser.mjs) 和 [执行交互](tests/trading-execution.browser.mjs) 回归，不将任何单一脚本描述为全页面覆盖。

**事件记录：** `legacy-resume-20261013`；历史复盘 2026-10-13（Seen 1×）；同轮补丁和跨页面推广不重复计数，实际独立事件边界待核实。

## Fix the class, not the sample

### L004：Statement 复用按连接与使用方式划定边界

**适用条件：** 同一 SQLite 连接内反复执行固定 SQL 的热路径；SQL 种类、连接生命周期或交错游标会影响缓存策略。

**根因：** 反复 prepare 相同 SQL 重复编译；共享编译结果不等于共享参数、结果或一个正在遍历的游标。

**以后做法：** 在同一连接内复用编译后的 Statement，每次执行分别传参。SQL 种类无界时考虑有界淘汰，连接更换或关闭时处理缓存生命周期，交错 reader/generator 验证游标隔离；这些是相应场景的要求，不能声称现有缓存已经全部实现。

**证据：** 本仓 `c838aca4`、`4b4e5bbe` 接入缓存；`536103b7`、`7a2edd6d`、`55ea4486` 是该轮接入中的 import、默认初始化和重复声明修复链。[db-cache.mjs](server/db-cache.mjs) 当前提供按 SQL 的 Map、clear/size，没有有界淘汰或关闭状态包装器。外仓历史记录：asset-ledger `5ea37c8f`（上限 128 与测试）、market-spread-monitor `c307a33c`、gate-crossex-arbitrage `281813a2`；这些外仓内容本次未核验。

**如何验证：** 对涉及的缓存路径计数 prepare：同一连接、同一 SQL、未清理或淘汰期间只编译一次，不同参数结果互不串。若改动生命周期或交错游标，再验证对应边界。旧记录的 `loadQualitySamples` 属外仓线索，不是本仓已有测试。

**事件记录：** `legacy-sqlite-cache-20261012`；历史复盘 2026-10-12（Seen 1×，含同日跨仓线索）；独立事件未拆分核实，不能按 SHA 或仓库数量增加升级计数。

### L005：模块拆分交付要完成调用方迁移

**适用条件：** 以完成模块拆分、替换旧实现为目标的重构。

**根因：** 只新增模块、不迁移调用方，会留下未启用的实现，使后续开发误判实际执行路径。

**以后做法：** 接通新模块并移除被替代的重复实现。若明确采用分阶段迁移，说明当前入口与未完成工作，不把未接线的模块描述为重构已完成。

**证据：** 本仓 `0d04b671` 新增 Brand/Status 等六个文件但未修改 `App.tsx` 引用；`8e272fd3` 删除这些未接线文件。该证据不说明未引用文件必然增加最终构建产物。

**如何验证：** 搜索新模块引用并确认实际调用方已迁移，再做相关类型或构建检查。单独构建成功不能证明模块被使用。

**事件记录：** `legacy-module-wiring-20261012`；历史复盘 2026-10-12（Seen 1×）；实际发生日期及独立性待核实，暂不计入升级。

## Verification

### L008：停服更新前，“没有已知订单”必须有完整且新鲜的依据

**适用条件：** 更新或迁移会停止带实盘执行能力的模块，需要先确认没有待核对委托。

**根因：** 仅检查当前缓存里的挂单数组与本地任务数，会把读取失败后保留的旧空数组当成“无挂单”。执行所有权丢失或快照版本不匹配也不能证明可以停服。

**以后做法：** 先暂停新任务，再核验已连接账户的读取错误、快照时效与版本、执行所有权及未完成委托；状态未知时拒绝更新。仅有明确证据证明从未启用实盘的账户，才可免除交易所挂单核验；配置为实盘但缺失凭据或尚未连接，不能据此认定没有挂单。独立读取可并发，但必须等全部结束后再解除维护门。

**证据：** project-aggregation 基于 `929b28d9` 的 2026-10-13 内嵌迁移工作区首次新增更新判定；审查在 [CrossEx 运行时](modules/crossex/server/live-runtime.mjs) 复现了成功读取空挂单后再次读取失败、以及时钟前进超过有效期时仍允许更新。该问题在本轮提交前修复，不表示基线提交已有此接口。

2026-10-14 在基于 `1850752c` 的 ASTER 接入工作区确认：高频策略快照可能省略 `open_orders`，不能将其空值当成交易所无挂单；[ASTER 维护控制](modules/aster/trading/workspace_control.py) 在维护门关闭新交易后，重新读取所有已配置实盘账户的完整挂单并核验本地未完成任务。该条为同一规则在新模块的推广，不重复计数。

2026-10-14 在 `9da911b4` 确认另一处边界错误：人工归档后的 `recovery_watch` 按设计长期保留，更新检查却把它永久视为当前未完成订单，导致已核对且无活动委托的账户也无法更新。历史观察必须在本次维护窗口内按原客户端编号、标的和账户身份重新查询，仅明确不存在或终态零成交可通过；之后仍核对全账户挂单。观察查询与挂单查询共用新鲜度窗口，结束前复核版本、身份、配置和持久记录。显示缓存不能授权，更新不能删除 watch 或把未知成交量改为零；重启后的新交易仍执行原观察保护。

**如何验证：** [CrossEx 运行时测试](modules/crossex/tests/live-runtime.test.mjs) 覆盖失败、过期、未来时间、版本变化和所有权丢失；[模块更新保护测试](tests/embedded-updates.test.mjs) 验证维护门与更新接受顺序、失败恢复及不确定结果保留维护状态。[ASTER 更新检查测试](modules/aster/tests/test_workspace.py) 验证历史原单清晰时放行、迟到成交与活动单阻断、读取失败与竞态拒绝、观察记录跨重启保留；按本次影响选择相关检查。

**事件记录：** `embedded-update-evidence-20261013`；连续修补不重复计数。`archived-watch-update-block-20261014` 为长期观察误阻断更新的独立事件。

### L009：特权操作只读取可信来源的输入

**适用条件：** 安装器以服务账号构建，但以 root 准备依赖、复制外部配置文件或运行打包工具。

**根因：** 哈希锁文件与归属校验解决不同问题。服务账号可同时替换依赖内容和哈希；root 随后读取该锁文件安装依赖，仍可能执行被替换的构建代码。只保护文件本身而不保护父目录也不能防止替换。

**以后做法：** 从固定 Git 提交或已核验的发布包独立取得特权步骤所需输入，验证文件及整条父目录的归属、权限和链接边界；不把可写构建目录作为可信源。

**证据：** project-aggregation 基于 `929b28d9` 的本轮迁移工作区中，[源码安装路径](deploy/install.sh) 曾在服务账号构建后将该工作树的 Greeks 锁文件传给 root pip。审查确认路径后在首次提交前改为从固定 Git 对象单独读取；基线提交不包含此新增路径。

2026-10-14 基于 `1850752c` 的 ASTER 迁移工作区中，[迁移器](deploy/migrate-modules.py) 在 `/etc/aster-desk/environment` 缺失时曾读取旧服务可写的运行目录 `.env`，再以 root 复制其中指定的 CA 路径并转移文件归属。隔离文件系统夹具复现了合成私有文件被复制；修复后仅可信外部配置可以授权外部文件读取。此问题在本轮提交前修复，不表示基线已有该路径。

**如何验证：** [Python 依赖来源检查](deploy/test-python-lock.sh) 覆盖工作树锁文件被替换、父目录可写及链接路径；[迁移测试](deploy/test-migration.py) 覆盖运行目录配置不能授权 root 读取外部文件、可信配置正常迁移及所有权和父目录权限。Linux 归属与权限检查在 CI 执行。

**事件记录：** `embedded-python-provenance-20261013`、`aster-migration-file-provenance-20261014`；两次独立事件，分别涉及特权依赖安装和外部文件读取。

2026-10-14 独立中继安装入口接入本仓时，提交前检查发现：即使源码文件已校验归属，root 运行的 `python3 -c`、`python3 -` 仍可能从调用目录或 `PYTHONPATH` 导入同名模块。`deploy/install-aster-relay.sh` 与 `deploy/aster-capacity-relay` 的特权 Python 入口使用 `-I`；业务模块需要工作目录导入时，只从受信运行目录启动，并清除 `PYTHONPATH`、`PYTHONHOME`。工作台连接导入的管道命令同样使用 `python3 -I -`。证据为基于 `9ad1bff` 的本轮新增安装器（首次提交前修正），不是该基线已有缺陷；[中继安装检查](deploy/test-aster-relay-install.py) 使用伪造 `json.py`、`pathlib.py` 和解释器环境变量覆盖该入口。事件 ID：`relay-python-import-provenance-20261014`，属于解释器启动输入的独立边界问题，不因多个调用点重复计数。

### L010：拓扑迁移的提交点必须覆盖必要持久化记录

**适用条件：** 升级同时切换程序与独立服务拓扑，并通过迁移日志控制回滚。

**根因：** 先把迁移日志标记为成功，随后持久化配置失败，会触发程序回滚，却无法恢复已退役的旧服务。提前替换的“上次成功配置”也可能污染下一次恢复依据。

**以后做法：** 在仍可恢复旧拓扑时完成必要记录；提交迁移日志后明确结束旧拓扑回滚窗口。失败恢复同时还原实际配置及其成功快照。

**证据：** project-aggregation 基于 `929b28d9` 的本轮迁移工作区中，[安装器](deploy/install.sh) 曾先提交迁移、再保存环境和 Python 路径；审查确认后在首次提交前调整。该事件与 L009 的特权输入问题分别记录。

**如何验证：** [环境与迁移恢复检查](deploy/test-environment.sh) 对必要记录和迁移提交失败注入故障，断言旧程序、服务与配置快照一致恢复；提交成功后的非关键记录失败不得重新启用旧拓扑。

**事件记录：** `embedded-topology-commit-20261013`；本轮连续修补归为一次已核实事件。

### L011：源码导入后检查 Git 实际交付的构建输入

**适用条件：** 将已有项目源码导入带有历史忽略规则的仓库。

**根因：** 根目录 `.gitignore` 中未锚定路径的 `design-tokens.css` 同时忽略了嵌入模块的必需样式；本地文件存在，因此本地构建通过，从 Git 提交归档的 CI 却缺少文件。

**以后做法：** 临时文件规则限定在其实际目录；导入后核对被忽略的文件与构建输入。干净 Git 归档的构建结果才覆盖正式交付文件的完整性。

**证据：** project-aggregation `e478da63` 的 [CI](https://github.com/hxx344/project-aggregation/actions/runs/38307546837) 在两个架构均因 `modules/monitor/app/design-tokens.css` 缺失失败；同一规则也漏掉 `modules/crossex/src/design-tokens.css`。二者属于同一导入事件。

**如何验证：** 用 `git ls-files --error-unmatch` 确认两个样式文件已跟踪，再由干净归档的模块构建验证引用。无需因忽略规则修复重复运行无关业务回归。

**事件记录：** `embedded-import-ignore-20261013`；本轮一次已核实事件。


### L012：可选本机辅助探测默认关闭，除非用户环境确实运行该服务

**适用条件：** 前端定期探测可选本机 helper（如本地路由/直连探测）且工作台常经 SSH 隧道访问。

**根因：** `ConnectionStatus` 每 10 秒轮询本机 `/route`（port 3101）；用户未跑 helper 时该探测 100% 失败，诊断里失败请求占比可到约 48%（34/71），并污染连接体验。

**以后做法：** 可选本机能力默认关闭或仅在明确启用时探测；SSH 隧道场景不要把 helper 失败当成主链路故障。重新启用前先确认目标环境会运行对应服务。

**证据：** 本仓 `75cba45f` 注释掉 `createLocalRouteMonitor` 及相关 UI；提交说明记录 20/20 `/route` 失败。同提交曾误加入 `server/update-service/__pycache__/*.pyc`，后续主线目录已无该缓存，审查时顺带确认构建产物未被跟踪。

**如何验证：** 前台诊断/网络面板在未跑 helper 时不再出现周期性 `/route` 失败；连接质量探测仍覆盖主 API。

**事件记录：** `local-route-poll-20261013`；本轮一次已核实事件（Seen 1×）。

### L013：远端限流必须约束自动、手动与重启后的重试

**适用条件：** 后台更新检查依赖有请求额度的远端服务，且用户也能手动触发检查。

**根因：** 更新调度器每 30 秒重试，忽略远端恢复时间；任一发布探测失败又清除全部已验证元数据，恢复时增加 API 请求。统一的 403/429 提示还掩盖了失败端点与原因。

**以后做法：** 区分额度耗尽、访问拒绝和网络故障；持久化重试截止时间，自动、手动及重启后的检查共同遵守。瞬时失败保留仍受原有效期约束的已验证元数据，但当次检查仍失败；恢复后重新核验当前发布及文件，执行更新前始终重新校验固定发布身份。

**证据：** project-aggregation `12d6f6bf` 的 [更新调度器](server/update-service/updater.py) 与 [发布读取器](server/update-service/releases.py) 存在上述重试行为。2026-10-13 用户服务器返回发布页 302 正常、API 403，`X-RateLimit-Limit=60`、`Remaining=0`、`Used=60`，确认匿名 API 额度已耗尽；没有证据断言全部 60 次请求均来自本应用。

**如何验证：** [发布读取检查](deploy/test-release-cache.py) 覆盖响应分类、恢复时间、失败不返回旧成功及缓存恢复；[更新协调器检查](deploy/test-updater.py) 覆盖持续失败退避、手动与重启不绕过、成功复位及更新执行前重新校验。

**事件记录：** `updater-rate-limit-retry-20261013`；本轮一次已核实事件。

### L006：保持语义的算法优化要有参考结果与规模检查

**适用条件：** 承诺保持输出语义的采样或图表算法优化；涉及重复解析热点时增加与规模相称的检查。

**根因：** 遍历顺序、并列值和缓存改动可能悄悄改变输出；小样本结果正确也不能证明消除了大数据上的重复计算。

**以后做法：** 用旧实现或独立参考结果覆盖相关输入边界，检查输入未被意外修改。若同时改变语义，先定义新预期；解析预算应根据实际算法推导。

**证据：** 外仓历史记录、本次未核验：variational-grid `50ef16fc` 的 `reduce_points` 与 `tests/test_history_reduction.py`；greeks `160e9329` 的时间戳预解析。原记录的“并列极值取首次索引”和“1000 点 `dateParseCalls <= n+3`”属于对应实现契约，不推广成所有图表的要求。

**如何验证：** 在实际受影响项目中检查空输入、边界规模、并列值及相关宽度/采样参数，并测量解析次数随输入规模的增长。执行前先核实外仓契约和测试位置。

**事件记录：** `legacy-chart-optimization-20261012`；历史复盘 2026-10-12（Seen 1×）；外仓证据和独立事件均待核实，暂不计入升级。

### L007：memo 优化先确认输入稳定性与必要更新

**适用条件：** 用 `React.memo` 避免父组件无关更新导致重复渲染的组件边界。

**根因：** 每轮创建的函数、对象等 props 可能使浅比较失效；同时，真实数据、组件 state/context 或时间变化仍可能需要更新。

**以后做法：** 检查全部输入的预期稳定性。确有需要时使用 `useCallback`、提升函数位置或调整组件边界，并保留正确依赖。高频时间更新可与稳定历史内容拆开，但过期状态等依赖当前时间的内容仍须更新。

**证据：** 本仓 `402be956` 给交易页增加 memo，不能仅凭它证明已测得收益或稳定了全部回调。外仓历史记录、本次未核验：asset-ledger `8bafa81b` 的 AssetTrend/openHistory；aster_5x `dc998c59`、`92aee006` 的历史表及 quality 面板。

**如何验证：** 用 Profiler 或渲染计数检查具体的无关父状态变化，同时确认回调能读取最新状态、真实数据与过期显示正常更新。不能以“完全不重渲”为普遍目标，也不要求每个 memo 组件机械添加 useCallback。

**事件记录：** `legacy-memo-props-20261012`；历史复盘 2026-10-12（Seen 1×）；外仓证据和独立事件待核实，暂不计入升级。

### L014：在脱敏边界内保留上游错误的可诊断性

**适用条件：** 交易所接口返回 HTTP 状态和结构化错误码，错误需要展示给用户。

**根因：** 非 2xx 时直接丢弃正文会把 IP 白名单、权限、签名等不同失败全部压成通用 403；只映射认证类又会漏掉官方参数与请求格式错误。将未知代码、无代码、空正文、HTML、超限和读流失败合并成一种提示，也会丢失排查依据。原样展示正文则可能泄露凭据或签名。

**以后做法：** 有界读取错误正文，对相关官方错误码做精确白名单映射，输出固定原因与建议；未知代码、响应格式和读取异常用固定诊断分类表达，不能把未收录的代码说成没有返回。优先解析实际 JSON，不因错误的 Content-Type 丢掉有效错误码。不得通过任意字符串匹配猜测真实原因，也不得为读取失败建议开启交易或提现权限。检查公共 API 错误过滤是否会再次吞掉已脱敏的诊断。

**如何验证：** [Gate 单测](modules/asset/tests/gate.test.ts) 检查已知/未知错误码、恶意正文、限长与取消、超时和重定向；[生产 API 冒烟](tests/asset-gate.smoke.mjs) 检查诊断到达客户端且连接、金额和成功时间仍在失败时保留。仅运行受影响路径。

**证据：** 本仓 `b71cbdc` 的 [Gate reader](modules/asset/lib/gate.ts) 在非 2xx 分支读取 `label` 之前抛错。2026-10-14 用户先提供 HTTP 403，后在 `950da11` 诊断改进后提供 HTTP 400 截图；核实后者仍漏掉官方通用请求错误表全部 10 个代码，并混合所有响应读取失败类别。该日仅以虚构密钥对照请求，是否携带 Content-Type 均得到 `INVALID_KEY`，不能证明它是用户 400 的原因；用户真实响应原因仍未确认，不将其归因为权限、币种或 IP 问题。

**事件记录：** `gate-error-diagnostics-20261014`；首次确认 2026-10-14，属于一次缺陷与连续修复。

### L015：运行内容相同不能代替正式发布身份一致

**适用条件：** 发布按提交标识版本，安装器又用内容指纹复用运行产物的增量更新路径。

**根因：** 更新器在应用指纹与安装脚本相同时提前返回 `current`，界面把该状态统一显示为“已是最新”，导致当前与最新正式提交不同却无法确认新版本。本机领先于正式版也复用了同一显示状态。

**以后做法：** 先按提交身份和前进关系判断可用正式版本，再由安装器决定复用哪些产物；成功后通过部署记录与受保护回执确认新提交。界面只有身份一致才能显示最新；兼容旧服务时，保留版本差异与服务端解释，不自行生成更新计划。

**证据：** project-aggregation `950da115` 的 [更新判定](server/update-service/updater.py) 和 [更新面板](src/UpdateStatus.tsx)。2026-10-14 用户截图当前 `b71cbdc`、最新 `d438da9`，但显示“已是最新正式版”；两个正式清单的应用指纹和安装脚本确实相同。截图尚未发现后续 `950da11` 的原因未在服务器复现，不归因为本次已核实缺陷。

**如何验证：** [更新协调器检查](deploy/test-updater.py) 覆盖同内容新提交生成计划、成功后确认一次、回执失效与提交顺序；[更新面板验收](tests/updates.browser.mjs) 覆盖旧 `current` 的不同或缺失身份，不误报最新、不生成无依据的更新入口。Linux CI 继续覆盖同内容安装跳过下载和重启。

**事件记录：** `release-identity-equivalence-20261014`；本轮一次已核实事件。

### L016：稳定币计价仍须按目标法币换算

**适用条件：** 交易所把账户总额折算为 USDT 等稳定币，而账本、快照或汇总采用 USD。

**根因：** 将请求币种从 USD 改成 USDT 后，仍原样保存总额并把明细单价设为 1，会将稳定币数量当作美元价值。只同步单测中的币种字符串，无法发现这一金额契约变化，还会遗漏生产接口测试。

**以后做法：** 保留返回币种及原始折合数量，以有效的目标法币汇率换算总额和全部明细。仅读取所需币种行情；行情无效或过期时保留旧数据与成功时间，不假设固定 1:1。界面兼容旧记录的实际币种，估值时间不得晚于较旧的报价时间。

**如何验证：** [Gate 单测](modules/asset/tests/gate.test.ts) 使用非 1 汇率核对总额、分项、时间、备用行情方向和失效场景；[生产 API 冒烟](tests/asset-gate.smoke.mjs) 验证实际保存的美元金额、首次失败不落库、替换与刷新失败保留旧数据。

**证据：** 本仓 `4fd25be` 的 [Gate reader](modules/asset/lib/gate.ts) 请求 USDT 后仍原样返回 `total.amount`，明细 `price: 1`；[store](modules/asset/lib/store.ts) 将该值用于美元账本及人民币换算。2026-10-14 发布前核实，并复现生产 API 测试仍按 USD 请求导致失败。用户的 `INVALID_PARAM_VALUE` 截图不等于所有账户均拒绝 USD；本轮保留 USDT 接入选择并修正换算合同。

**事件记录：** `gate-usdt-usd-valuation-20261014`；发布前一次已核实缺陷，连续修补不重复计数。

### L017：功能交付须验证用户实际运行入口

**适用条件：** 独立项目已作为固定源码副本内置到工作台，或同一功能存在多个仓库与发布入口。

**根因：** 只在独立仓库实现并发布功能，未核对用户页面实际加载的内置模块，导致独立版通过测试且发布成功，工作台仍显示旧界面。来源记录不会自动同步上游代码。

**以后做法：** 从用户入口追踪运行目录、模块来源与打包路径；把改动纳入实际运行仓库，并保留其登录、内部通信与维护适配。验证沿用真实模块入口和发布包，不能用另一仓库的构建成功代替交付完成。

**证据：** gate-crossex-arbitrage `640df2f8c81990cf48e9bac1b2a6101fcafb8483` 已发布资金费机会；2026-10-14 用户截图仍无切换按钮。project-aggregation `0b838004` 的 [来源记录](modules/crossex/SOURCE.json) 仍为 `804d284`，而 [模块适配器](server/modules/crossex.mjs) 加载本仓 `modules/crossex/dist`。[打包工具](deploy/package-release.py) 仅打包本仓模块，不拉取独立仓库的正式版。关联 L005 的入口核对原则，但属于本次独立的交付遗漏。

**如何验证：** [内置资金费回归](tests/embedded-funding.test.mjs) 从真实 Monitor 投影，经私有管道、CrossEx 和工作台代理读取资金费机会，并追溯内置 HTML 的构建资源；浏览器从工作台入口验证切换与预填，正式包再核对内置模块产物。无需扩大为无关模块全量回归。

**事件记录：** `embedded-funding-delivery-20261014`；2026-10-14 用户纠正后核实，补丁移植和发布验证均归为同一次事件，不推进主线复盘检查点。

### L018：固定 Node 执行包管理器时必须取得 JavaScript 入口

**适用条件：** CI 或安装器使用 `node <package-manager>`，以固定 Node 版本运行包管理器。

**根因：** `command -v pnpm` 可能返回 `.bin` 中的 shell shim；`realpath` 只能解析文件链接，不能把 shell 包装器变成 JavaScript。将该路径交给 Node 会在安装或构建前报语法错误。

**以后做法：** 明确取得所安装包的 JavaScript 入口，并用指定 Node 验证包管理器版本；若直接执行 shell shim，则另行确认其实际 Node 选择。不能假设 `pnpm exec` 总会提供 `npm_execpath`。

**证据：** 本仓基于 `35396d4` 的 2026-10-14 pnpm 迁移工作区中，[CI](.github/workflows/ci.yml) 最初把 `command -v pnpm` 传给 [非 root 构建检查](deploy/test-workspace.sh)，后者再通过 Node 执行。审查对照 `pnpm/action-setup@v4` 的 `.bin` 安装路径确认不匹配，首次提交前改为 action 安装目录下的 `pnpm/bin/pnpm.mjs`；本地 `pnpm exec node -p process.env.npm_execpath` 实际返回 `undefined`。这不是基线提交已有的 pnpm 缺陷。

**如何验证：** CI fixture 先以 `INSTALL_TEST_NODE` 执行入口并断言 pnpm 版本，再完成真实非 root 构建；仅 `bash -n` 不能覆盖入口类型错误。

**事件记录：** `pnpm-cli-entry-20261014`；迁移开发阶段一次已核实审查发现，连续修补不重复计数。

### L019：不可变依赖缓存禁止脚本入口隐式重装

**适用条件：** 安装器先校验并冻结依赖，再通过可写外壳链接到构建工作区的流程。

**根因：** pnpm 11 的 `verifyDepsBeforeRun` 默认执行安装；缓存搬移及链接后的 workspace 状态与原安装位置不同，普通 `pnpm run check` 也会尝试重建依赖目录，破坏安装和构建的职责边界。

**以后做法：** 只在安装器的服务账号执行环境中禁止脚本前自动安装；依赖准备仍显式执行固定版本的 frozen 安装，并保留缓存来源、输入哈希、只读权限与实际构建验证。不要用自动确认目录删除修复该失败。

**证据：** 本仓 `1cd309f` 的 [Linux CI](https://github.com/hxx344/project-aggregation/actions/runs/38454566071) 安装器检查通过，但 [非 root 构建检查](deploy/test-workspace.sh) 在首个 `pnpm run check` 触发 `runDepsStatusCheck` 的隐式安装，报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。

**如何验证：** 在链接到冻结缓存的 workspace 中实际构建，确认缓存元数据不变、服务账号不能改包内容，随后执行独立发布包验收。本地普通可写 workspace 构建不能代替该 Linux 权限路径。

**事件记录：** `pnpm-immutable-auto-install-20261014`；迁移 CI 中一次已核实缺陷，后续连续修补不增加事件数。

### L020：统一标的与原生合约身份分别保留

**适用条件：** 不同交易所对同一加密标的使用不同币名，且行情配对、CrossEx 目录和原生深度读取共用报价对象。

**根因：** `base` 用于标的比较，`rawBase` 保存交易所原始币名；本仓 `35396d4` 尚未归一 Gate/OKX 的 `LUNA` 与 Binance/Bybit 的 `LUNA2`，身份校验又一概拒绝两字段不同。把 `rawBase` 当归一字段替换分组键无法修复，按归一字段拼接原生合约则会请求错误目录。

**以后做法：** 仅接入有官方身份及单位证据的交易所限定别名；保留原生 `symbol`、`rawBase` 和 CrossEx 目录代码。身份校验、只读预览、旧仓平仓、屏蔽名单与冷却期须使用一致语义。旧原生 `base` 表达仍可核验，但不得接受任意自报别名、倍率归一或股票代币替代关系。

**证据：** `project-aggregation`，事件 `crossex-base-alias-20261014`。2026-10-14 核实 [Binance Terra 2.0 公告](https://www.binance.com/en/support/announcement/detail/2806253154aa4c36bffdfe60c6afc85e)、[Gate LUNA 合约公告](https://www.gate.com/pt/announcements/article/26708) 与 [OKX 合约单位](https://www.okx.com/en-eu/help/okx-to-list-usdt-margined-perpetual-for-luna)，并读取当前原生及 CrossEx 公共目录确认可用符号。修复集中于 [统一身份](server/asset-identity.mjs)、[Monitor 目录](modules/monitor/modules/perpetual/exchanges.mjs)、[CrossEx 核验](modules/crossex/server/model.mjs) 和 [原生读取](modules/crossex/server/clients.mjs)。LUNC 保持独立；文档中的 Bitget/FUTU 示例不属于本次已确认范围。

**如何验证：** [别名回归](tests/crossex-base-matching.test.mjs) 覆盖已核实及伪造映射、旧报价、原生目录与筛选；[工作台资金费集成](tests/embedded-funding.test.mjs) 从真实市场发现到工作台机会及双腿只读预览保留原生代码；[模拟仓位检查](modules/crossex/tests/engine.test.mjs) 覆盖旧别名仓位平仓、重复开仓与冷却期。生产入口使用 `live-runtime.mjs`，须另用[实盘回归](modules/crossex/tests/live-runtime.test.mjs) 验证历史别名记录在预览、确认和容量查询中保持冷却限制；`47be9dd` 的模拟引擎检查不能代替该路径。针对性测试与本次差异审查即可，不推进主线复盘检查点。

**事件记录：** `crossex-base-alias-20261014`；本轮身份、匹配与兼容修复归为同一事件，不增加复发次数。

### L021：子面板样式不能改变公共页面的宽度

**适用条件：** 多个市场面板共用导航、行情卡片和居中容器，子面板按需加载并在切换后保留挂载。

**根因：** 合约扫描器用高特异性的祖先选择器将 `.hub-tabs` 的 `1560px` 上限覆盖为 `none`，进入机会或图表时连公共导航和行情卡片一起拉宽；持仓移除扫描器类后又恢复。扫描器自己的横向 padding 还覆盖了公共面板留白。

**以后做法：** 子面板只控制内部布局和所需方向的间距，沿用公共容器的宽度与横向留白；宽表格在面板内滚动。断点与溢出按实际 iframe 视口判断。

**证据：** `project-aggregation`，基线 `47be9dd` 的 [扫描器样式](modules/monitor/app/perpetual-scanner.css)、[公共布局](modules/monitor/app/globals.css) 和 [合约工作区](modules/monitor/app/perpetual-panel.tsx)。2026-10-14 用户报告后，在工作台实际 iframe 内复现：外层视口 2100px 时，原油切到合约使公共容器从 1560px 拉宽到约 1859px，左侧居中留白从约 150px 变为 0。

**如何验证：** 使用本仓生产构建，从工作台进入市场监控；在宽屏和窄屏依次切换原油、合约机会、图表、持仓、机会及其他市场，比较公共导航、行情卡片与容器边界。确认上限保持 1560px、合约横向留白按模块视口沿用 32px/16px、宽表格内部滚动，父页面与 iframe 均无横向溢出。本轮已覆盖 2100、1280、800、390px 外层视口；行情接口使用隔离夹具，不把布局验收描述为行情或交易验收。

**事件记录：** `monitor-scanner-shell-width-20261014`；一次已核实布局缺陷，多个视口及子标签页不重复计数。
### L022：页面时钟不套用原始时间戳的整数约束

**适用条件：** 页面用服务器时间加 `performance.now()` 增量计算持仓时长或数据过期。

**根因：** 单调时钟增量包含小数毫秒。对当前计算时钟使用 `Number.isSafeInteger` 会让真实页面的时间失效，而只用整数的单测仍通过。

**以后做法：** 分别验证原始来源时间和计算时钟；后者接受有限正数，并用含小数毫秒的实际时钟输入覆盖时长、年化和过期路径。

**证据：** 本仓基于 `47be9dd` 的持仓指标开发阶段，[指标计算](modules/crossex/src/position-view.ts) 首版在 `now + 12.5ms` 下将时长、资金费差和健康度全部置为未知；只读复核复现后在首次提交前修复。[页面时钟](modules/crossex/src/freshness.ts) 使用单调增量，基线不含此次新增指标缺陷。

**如何验证：** [指标测试](modules/crossex/tests/position-metrics.test.mjs) 的小数时钟用例，以及[工作台浏览器检查](tests/crossex-position-metrics.browser.mjs) 的独立过期与倒计时场景。

**事件记录：** `crossex-metric-clock-20261014`；本轮提交前一次已核实审查发现。

### L023：持仓观察不依赖机会排行榜的筛选结果

**适用条件：** 机会榜与已持仓面板复用资金费数据，但榜单会过滤零差值、按收益排名截断，或应用开仓资格。

**根因：** 机会筛选将已知的零费差和榜外持仓移除，持仓面板因此把真实可用数据显示为未知。

**以后做法：** 机会发现与持仓读取使用各自投影；后者按真实非零持仓的原生合约身份匹配，独立核验目录、来源与资金费时效，不用开仓策略掩盖持仓数据。空结果仍表示缺失，不补零。

**证据：** 本仓基于 `47be9dd` 的持仓指标开发阶段，首次接线复用[机会榜](modules/crossex/server/funding-opportunities.mjs)，审查以相同费率和超过 200 个组合复现缺失。首次提交前改为独立 `positionFundingRates`；原机会榜过滤行为本身未改变。

**如何验证：** [资金费投影测试](modules/crossex/tests/funding-opportunities.test.mjs) 覆盖零值、等费差、榜外、开仓策略及失效数据；[真实工作台入口](tests/embedded-funding.test.mjs) 验证 API 仅投影持仓对应费率并保留真实开仓时间。

**事件记录：** `crossex-held-funding-projection-20261014`；与页面时钟问题为两个独立审查发现。

### L024：ADL 交易所原始等级映射

**适用条件：** 多个交易所的 ADL/减仓优先级要统一成同一套 UI（如红灯数）展示。

**根因：** 各所原生等级刻度不同甚至相反（Gate 5→1 越高越前；Binance 0→4；Kraken 100/80/…；OKX/Bybit 含 0 档）。若直接显示原值或套用他所刻度，会把高优先级画成低优先级。

**以后做法：** 按已核实的交易所契约做显式映射表；未知/未核实交易所返回 unknown（灰灯），禁止借用他所刻度；缺失与畸形值不得显示为低优先级。

**证据：** 本仓 `015a363a` 新增 [adl-indicator.ts](modules/crossex/src/adl-indicator.ts)、[AdlIndicator.tsx](modules/crossex/src/AdlIndicator.tsx) 与 [ADL 映射测试](tests/crossex-adl-indicator.test.mjs)（Gate/Kraken 反向、OKX/Bybit 零档、未核实所返回 null）。

**如何验证：** 运行 [ADL 映射测试](tests/crossex-adl-indicator.test.mjs)。Gate `5,4,3,2,1` 与 Kraken `100,80,60,40,20` 映射为递增红灯；OKX/Bybit 的 `0` 保持零档；缺失、畸形和越界保持 `null`，不得画成低优先级；未核实交易所对 `1` 和 `5` 都返回 `null`，界面用灰灯表示 unknown。

**事件记录：** `crossex-adl-mapping-20261014`；Seen 1×（2026-10-14）。

### L025：账户流水按委托聚合时严格限定可聚合类型

**适用条件：** 成交/资金流水按 order_id 或 business_id 聚合展示。

**根因：** Gate account book 里只有 TRANSACTION / TRADING_FEE / LIQUIDATION_FEE 的 business_id 才是委托号；资金费结算、划转及无委托号若强行按同 ID/时间合并，会把无关流水并进一笔委托。

**以后做法：** 仅对官方标明与委托绑定的类型按委托聚合；资金费、划转、缺 ID 保持独立记录；缺失金额用 unknown 而非 0；手续费按币种分别合计。

**证据：** 本仓 `bb296a89` 的 [account-history.ts](modules/crossex/src/account-history.ts) 与 [账户流水测试](tests/crossex-account-history.test.mjs)（funding/transfer 不继承委托、缺金额为 null）。

**如何验证：** 运行 [账户流水聚合测试](tests/crossex-account-history.test.mjs)。`FUNDING_FEE`、划转和空 `business_id` 即使标识或时间与成交相同也各自成组；缺金额为 `null`；手续费按币种分别合计。

**事件记录：** `crossex-account-history-group-20261014`；Seen 1×（2026-10-14）。

### L026：匿名额度耗尽时提供可配置的认证读取路径

**适用条件：** 更新检查依赖 GitHub Releases/API，匿名额度会被耗尽（见既有 L013）。

**根因：** 仅退避重试仍无法在额度耗尽时继续可靠读发布；需要用户侧提供 token，且必须经工作台安全配置、不进前端明文日志。

**以后做法：** 在工作台提供 GitHub token 配置入口；服务端用该凭证读发布并遵守 L013 的退避与身份校验；无 token 时行为与诊断仍清晰（额度耗尽 vs 拒绝）。

**证据：** 本仓 `f7485bb7` 改 [更新调度器](server/update-service/updater.py)、[发布读取器](server/update-service/releases.py) 与 [UpdateStatus.tsx](src/UpdateStatus.tsx)，新增 [更新 token 浏览器检查](tests/update-token.browser.mjs) 等。

**如何验证：** [发布读取检查](deploy/test-release-cache.py) 区分匿名额度耗尽、认证额度耗尽和 Token 无效；[更新协调器检查](deploy/test-updater.py) 覆盖保存、更换、移除，对外只暴露是否已配置，并保留 L013 的重试截止时间。[更新 token 浏览器检查](tests/update-token.browser.mjs) 确认凭据不进入页面正文或浏览器存储。无 token 时仍按匿名额度耗尽与拒绝分别诊断。

**事件记录：** `updater-github-token-20261014`；Seen 1×（2026-10-14）。关联 L013，不合并为同一事件。

### L027：持仓配对核对 CrossEx 合约计价字段

**适用条件：** 真实持仓通过 CrossEx 合约代码配对，再解析原生交易所报价身份；尤其报价币与合约结算币不同的已支持合约。

**根因：** 原生身份的 `quoteCurrency` 不一定等于 CrossEx 合约后缀。Hyperliquid BTC 的已验证身份使用 USDT 报价、USDC 合约计价与结算；与 Bybit BTC USDC 持仓比较原生 `quoteCurrency`，会误拒绝原本可配对的持仓。

**以后做法：** 区分原生报价币、CrossEx `counterCurrency` 与结算币。已有持仓的同计价检查使用已验证的 CrossEx 合约身份，并继续执行 `validManualPair`；不能删除身份校验或假设所有币种字段可互换。

**证据：** 本仓基于 `25b2883d` 的 2026-10-14 持仓操作开发工作区，独立审查用真实 `bindPositionAction` 和 `createMarket` 复现：`HYPERLIQUID_FUTURE_BTC_USDC` 与 `BYBIT_FUTURE_BTC_USDC` 均通过身份与双腿校验，但新增比较原生报价币的条件拒绝加仓。错误条件在首次提交前修复；基线不包含新持仓操作。相关路径：[身份解析](modules/crossex/server/clients.mjs)、[持仓市场预览](modules/crossex/server/market.mjs)。

**如何验证：** [持仓操作集成测试](modules/crossex/tests/position-actions-runtime.test.mjs) 使用上述不同原生报价币、相同 CrossEx USDC 合约的组合，验证预览与确认；继续拒绝真实 CrossEx 计价不同或身份不匹配的组合。无需扩大到无关交易所接口回归。

**事件记录：** `crossex-position-counter-currency-20261014`；一次已核实的提交前审查发现，不推进主线复盘检查点。

### L028：移除账户组件重建时保留旧操作状态的失效边界

**适用条件：** 移除由账户或连接版本决定的 React `key`，以保留新功能对话框或页面状态。

**根因：** 原组件依靠重建清理旧账户的操作选择。去掉 `key` 后，只给新增对话框做快照失效处理，会留下既有平仓等对话框继续使用旧选择。

**以后做法：** 核对组件内全部操作状态的账户作用域；账户或连接版本变化时，清除不再适用的旧选择，或显式禁用并要求重新预览。保留只读页面状态不代表保留交易意图。

**证据：** 本仓基于 `25b2883d` 的 2026-10-14 持仓操作开发工作区，[PortfolioPanel](modules/crossex/src/PortfolioPanel.tsx) 移除连接版本 `key` 后，浏览器夹具切换连接版本，旧平仓弹窗仍保留。修复在 [PositionsPanel](modules/crossex/src/PositionsPanel.tsx) 的账户作用域变化时清除 `closing`；同一用例在修复前构建失败、修复后通过。此为首次提交前的局部回归，最终订单仍有服务端预览和人工确认，并非鉴权绕过。

**如何验证：** [持仓操作浏览器验收](tests/crossex-position-actions.browser.mjs) 覆盖旧平仓选择清除，以及新增对话框和确认页的持仓快照失效。

**事件记录：** `crossex-position-dialog-account-scope-20261014`；一次已核实的提交前审查发现。

### L029：明确拒绝的请求应解除前端提交标记

**适用条件：** 前端用提交标记防止重复写入，而服务端允许重新检查后复用仍有效的操作计划。

**根因：** 更新请求在发送前记录 `submittedPlan`，HTTP 4xx 明确拒绝后却未清除；服务端重新检查相同候选时保留原计划，前端因此一直显示“请先重新检查”。请求已被拒绝与请求结果未知不能共用永久提交状态。

**以后做法：** 收到明确拒绝时解除本次提交标记并保留错误原因；请求待定、已经接受或结果未知时继续阻止重复提交。不能在任意状态读取或检查成功后无条件清除标记，也不为绕开前端状态而强制轮换有效计划。

**证据：** 本仓基于 `6ba3eec` 的 2026-10-14 更新故障修复，旧 [UpdateStatus](src/UpdateStatus.tsx) 在 apply 返回 409、无新任务的浏览器夹具中，连续两次检查成功并返回相同 planId 后仍禁用更新按钮；完整刷新页面才恢复。用户运行的 `0cde1af` 同样存在该分支。[更新协调器](server/update-service/updater.py) 的计划复用行为符合既有契约，本次只修前端拒绝后的状态恢复。

**如何验证：** [更新重试浏览器检查](tests/updates-retry.browser.mjs) 覆盖明确拒绝、相同计划重查后重试及请求待定/结果未知时的防重复提交；[既有更新交互检查](tests/updates.browser.mjs) 覆盖二次确认、双击、慢响应、断线恢复、过期与状态推送交错。无需因此扩大到交易业务回归。

**事件记录：** `update-rejected-plan-latch-20261014`；一次已核实的用户故障与复现，不推进主线复盘检查点。

## Moved to the code standards

尚无。达到 [升级条件](docs/code-standards.md#升级规则) 后，将对应条目归档到本节，保留证据与规范链接；不按重复复盘次数自动升级。
