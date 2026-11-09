# Lessons from merged work

这里保存 project-aggregation 的项目经验，以及有明确来源的外仓参考。改动前按 [AGENTS.md 的路由表](AGENTS.md#按改动取用经验) 只读相关条目；路由表未覆盖时用 `grep -n '^### L' LESSONS.md` 按标题定位，再按行读取单条，不整份读取。升级条件统一见 [代码规范](docs/code-standards.md#升级规则)。

## 记录规则

- 真实缺陷、用户纠正或审查发现经核实且值得复用时，更新已有条目或新增经验；没有新证据就不机械追加。
- 每条经验写清适用条件、根因、以后做法、如何验证与证据。证据注明仓库、提交、相关路径和失败场景；未核实的历史线索保留并明确标记。
- 独立事件使用稳定 ID。重复审核、同一问题的连续修复、跨页面推广及 cherry-pick 不增加事件数；复盘日期也不自动等于实际发生日期。
- 升级和归档条件统一以 [代码规范的升级规则](docs/code-standards.md#升级规则) 为准。合并重复条目，已失效的经验注明原因和替代条目，保留证据。
- 能由针对性测试、静态检查或现有工具落实的规则，优先落实到适当检查；文档保留适用边界和检查入口。不要为低风险文案改动新增复述实现的测试。
- 新增条目按 ID 顺序追加到《经验条目》末尾，并在同一提交中把 ID 加入 [AGENTS.md 路由表](AGENTS.md#按改动取用经验) 的对应行；没有合适的行就新增一行，不留未路由的条目。
- 本文件只保存经验条目。复盘范围、提交窗口与结论写入复盘报告（见 [daily-review-prompt.md](daily-review-prompt.md)）；2026-10-12 至 10-20 的历史复盘摘要见 [复盘历史](docs/review-history.md)。
- 条目中的“历史复盘日期（Seen 1×）”只表示一次复盘日记录，不代表已核实的独立复发事件。每条历史线索保留稳定 ID、原复盘日期和全部原有证据。实际发生日期、独立事件边界未完成核实时，不计入规范升级；后续核实时沿用 ID 或明确关联正式事件，避免重复统计。外仓证据标注“未核验”，不将其实现或测试描述为本仓已有能力。

## 经验条目

### L001：累计失败与锁定状态分别处理

**适用条件：** 使用失败次数与截止时间表示账户锁定的路径；具体阈值以当前配置为准。

**根因：** 未达阈值就写入锁定时间会提前拒绝登录；把 `until=0` 当成过期记录删除，会丢失累计失败次数。在 `await` 之前读出记录、校验后再整条写回“旧值 + 1”，会让并发失败只记一次，晚返回的请求还会把已生效的锁覆盖回未锁定。

**以后做法：** 新增一次失败后再判断是否达到阈值。在读完请求体之后、密码哈希之前同步预占账户名额（失败数 + 进行中不超过阈值），失败时原地更新同一条记录，不写回旧副本；有进行中校验的记录不清理。锁在截止时刻到期；未达阈值的失败自首次失败起 `accountLockoutMs` 后过期；成功登录清零。

**证据：** 本仓 `7543c3a1` 引入锁定；`023eaac3` 修复未达阈值误设截止时间；`8e272fd3` 修复清理误删未锁定计数；`5b148191` 增加专项测试。后者父版本已先自增再比较，不能仅凭提交标题把它算成另一次 off-by-one 缺陷。2026-10-20 复查 Claude 提交时核实：HEAD `aca4637` 下 8 个并发错误请求全部返回 401 且随后正确密码登录成功；`tests/server.test.mjs` 的分段请求体用例断言 9 个并发失败全为 401，正是依赖该竞态通过；`5b148191` 中对 `res.data.message` 的断言因错误体字段为 `error` 从未执行。

**如何验证：** 涉及这一路径时运行 [账户锁定测试](tests/account-lockout.test.mjs)，确认当前阈值 5 下前四次失败、第五次锁定、锁定中正确密码仍被拒绝、并发失败逐次计数、未达阈值的失败过期、锁到期及成功后清零。5 次是本项目当前配置，不推广成通用阈值。

**事件记录：** `legacy-lockout-20261012`；历史复盘 2026-10-12（Seen 1×）；实际发生日期及独立性待核实，暂不计入升级。

### L002：缓存必须保持当前 coverage 的读取语义

**适用条件：** 接口约定按当前 funding coverage/events 计算的 [收益读取路径](server/trading-pnl.mjs)，包括记录样本后仍会补录覆盖与事件的场景。

**根因：** 采样时预计算的列无法反映后来更新的 coverage/events，直接用它替代当前计算会返回过期收益。

**以后做法：** 保持当前读取契约。若引入缓存，应有覆盖更新时的失效或重算机制；不能把所有金融读取一概判定为不可缓存。

**证据：** 本仓 `32578ed6` 将 funding 计算移入 `record()`，试图用写入时预计算加速读取；`4ea30289` 恢复按当前 events/coverage 计算。它们属于同一优化与修复链。

**如何验证：** [收益配对测试](tests/trading-pnl-pairs.test.mjs) 包含记录样本后补 coverage/funding event 的场景；不重写样本，读取仍应反映新覆盖。选取相关用例，不因此机械运行所有交易模块测试。

**事件记录：** `legacy-funding-read-20261012`；历史复盘 2026-10-12（Seen 1×）；实际发生日期及独立性待核实，暂不计入升级。

**回放输入归属补充（#244，2026-11-07）：** 基线 `fdf470e` 的 Aero 页面虽用完整请求签名触发重算，展示与排序却只比较窗口、投入和停摆；推荐宽度 A→B 后，B 慢响应或失败仍复用 A。结果复用必须匹配完整计算身份（池子、格数、样本版本、启用链及参数），并核对每一批响应的版本、窗口与格数；取消在途请求不能撤回已发布的旧结果。[生产回放夹具](tests/aero-replay.browser.mjs) 覆盖宽度变化、失败、迟到响应、样本版本反转排序和分批版本不一致。事件 `aero-replay-display-input-identity`，Issue 已有事件沿用；无实盘证据。

### L003：合并恢复事件，按页面连接方式保留兜底读取

**适用条件：** `visibilitychange`、`focus`、`pageshow`、网络恢复等事件可能成组触发的页面。

**根因：** 多个恢复事件会重复发起读取，流重连和请求取消可能交错；后到的事件还可能误取消恢复窗口中新启动的请求。仅轮询的页面没有可等待的 EventSource 状态。

**以后做法：** 合并重复恢复工作，区分旧请求与本轮新请求，按页面实际连接方式保留必要的兜底。使用推送流的页面检查流是否已提供可用更新；离线与卸载时取消延迟工作。延迟长短由连接与交互需求确定，不能将当前的 1000ms 作为所有页面的永久规则。

**证据：** 本仓 `c41ce40` 修改 [App](src/App.tsx) 与 [UpdateStatus](src/UpdateStatus.tsx)；`3f63db5`、`9382521` 补充恢复事件合并与新请求保护。`fc94b0a` 是保留的历史对象，其三个交易页源文件内容对应主线 `3a2cf14`，不能算成两次事件。[TradingPositions](src/TradingPositions.tsx)、[OilTradingPage](src/OilTradingPage.tsx)、[TradingExecution](src/TradingExecution.tsx) 使用延迟轮询，不具备这里所述的 EventSource live 判断。旧说明的“约 40% 失败”和“接近 0%”没有附带可复核测量，不作为结论或验收标准。

**本轮补充证据：** 2026-10-13 对 `3a2cf14` 的局部审查确认：三个交易页每次恢复都另建延迟回调，`TradingExecution` 还会重复启动递归轮询链。当前修复合并恢复回调、保留窗口中新读取，并在离线和卸载时取消延迟任务。独立复核另以虚拟时钟复现：隐藏页每 10 秒收到一次焦点事件时，若每次重置后台计时器，60 秒内没有后续读取；修复改为只补建缺失计时器。以上属于本轮连续修补，不增加独立事件计数。

**如何验证：** [恢复交互检查](tests/resume-refresh.browser.mjs) 覆盖 App/UpdateStatus 的事件突发合并、流先到取消兜底、离线取消、重新联网、新请求保留和退出清理。[交易恢复检查](tests/trading-resume.browser.mjs) 直接覆盖三个交易页的事件合并、旧请求替换、组合切换中新读取保留、离线取消、单一执行轮询链、隐藏重连及卸载清理，并确认自动恢复不发送写请求；隐藏事件连发用例已在修复前构建上复现失败。按改动范围选取 [观察页轮询](tests/trading-poll.browser.mjs)、[仓位](tests/trading-positions.browser.mjs) 和 [执行交互](tests/trading-execution.browser.mjs) 回归，不将任何单一脚本描述为全页面覆盖。

**事件记录：** `legacy-resume-20261013`；历史复盘 2026-10-13（Seen 1×）；同轮补丁和跨页面推广不重复计数，实际独立事件边界待核实。

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

### L008：停服更新前，“没有已知订单”必须有完整且新鲜的依据

**适用条件：** 更新或迁移会停止带实盘执行能力的模块，需要确认可以安全停机并保留重启恢复能力。

**根因：** 仅检查当前缓存里的挂单数组与本地任务数，会把读取失败后保留的旧空数组当成“无挂单”。执行所有权丢失或快照版本不匹配也不能证明可以停服。

**以后做法：** 先暂停新任务，再确认在途请求归零、执行锁静止、进程所有权有效，并重新读取全部实盘账户的完整挂单；读取失败、证据过期、版本或身份变化、活动挂单仍拒绝更新。可重启恢复的持久化订单、划转、成交后检查及历史观察不要求先清空；确认其归属、持久记录稳定并原样保留，重启仍按原编号恢复，不能重新发送原请求或将未知成交量改为零。配置为实盘但缺失凭据或尚未连接，不能据此免除挂单核验。独立读取可并发，但必须等全部结束后再解除维护门。安全停机准入与恢复后允许新交易的条件分别判断。

**证据：** project-aggregation 基于 `929b28d9` 的 2026-10-13 内嵌迁移工作区首次新增更新判定；审查在 [CrossEx 运行时](modules/crossex/server/live-runtime.mjs) 复现了成功读取空挂单后再次读取失败、以及时钟前进超过有效期时仍允许更新。该问题在本轮提交前修复，不表示基线提交已有此接口。

2026-10-14 在基于 `1850752c` 的 ASTER 接入工作区确认：高频策略快照可能省略 `open_orders`，不能将其空值当成交易所无挂单；[ASTER 维护控制](modules/aster/trading/workspace_control.py) 在维护门关闭新交易后，重新读取所有已配置实盘账户的完整挂单并核验本地未完成任务。该条为同一规则在新模块的推广，不重复计数。

2026-10-14 在 `9da911b4` 确认另一处边界错误：人工归档后的 `recovery_watch` 按设计长期保留，更新检查却把它永久视为当前未完成订单，导致已核对且无活动委托的账户也无法更新。当时修复加入历史原单逐笔查询；2026-10-15 下述停机语义修正替代了“升级必须先确认历史原单终态”的限制。新交易前的原观察保护继续保留，显示缓存仍不能授权交易，更新不能删除 watch 或把未知成交量改为零。

2026-10-15 用户反馈核对状态持续阻止更新，基线 `74fc6756` 的 [ASTER 维护控制](modules/aster/trading/workspace_control.py) 直接以任意未完成 intent、post-fill、pair pending 或 margin pending 阻断，导致恢复记录无法跨版本保留以修复恢复逻辑。[账户调度](modules/aster/trading/engine.py) 在维护且无 intent 时还会提前退出，使独立的成交后检查无法清除。本轮把更新准入改为静止执行与完整新鲜挂单证据，保留持久恢复记录，并允许维护中的成交后只读检查完成；检查后不启动新计划。具体现场是哪类持久记录未取得证据，不据截图推断。无原因或与 API 告警重复的正常执行阶段不再作为近期问题提示；具体异常与待恢复状态仍保留。

**如何验证：** [CrossEx 运行时测试](modules/crossex/tests/live-runtime.test.mjs) 覆盖失败、过期、未来时间、版本变化和所有权丢失；[模块更新保护测试](tests/embedded-updates.test.mjs) 验证维护门与更新接受顺序、失败恢复及不确定结果保留维护状态。[ASTER 更新检查测试](modules/aster/tests/test_workspace.py) 覆盖持久恢复记录不误阻断、活动挂单和读取失败仍拒绝、身份及持久状态竞态、重启恢复原编号且不重复发送；[账户加固测试](modules/aster/tests/test_engine_hardening.py) 验证维护期间成交后检查正常完成、读取失败保留记录且不下单或修改杠杆。前端提示测试覆盖正常阶段与真实异常；按本次影响选择相关检查。

**事件记录：** `embedded-update-evidence-20261013`；连续修补不重复计数。`archived-watch-update-block-20261014` 为长期观察误阻断更新的独立事件。`durable-recovery-update-block-20261015` 为持久恢复记录与维护调度互相阻塞的事件；其根因是混淆停机与交易准入，不将本条下不同根因按日期合并升级。

### L009：特权操作只读取可信来源的输入

**适用条件：** 安装器以服务账号构建，但以 root 准备依赖、复制外部配置文件或运行打包工具。

**根因：** 哈希锁文件与归属校验解决不同问题。服务账号可同时替换依赖内容和哈希；root 随后读取该锁文件安装依赖，仍可能执行被替换的构建代码。只保护文件本身而不保护父目录也不能防止替换。

**以后做法：** 从固定 Git 提交或已核验的发布包独立取得特权步骤所需输入，验证文件及整条父目录的归属、权限和链接边界；不把可写构建目录作为可信源。冻结依赖目录的所有权不等于验证其代码来源；需要加载构建依赖的解析器以明确的非 root UID/GID、无补充组运行，root 仅消费结构化结果并核对包名、版本与复制边界。

**证据：** project-aggregation 基于 `929b28d9` 的本轮迁移工作区中，[源码安装路径](deploy/install.sh) 曾在服务账号构建后将该工作树的 Greeks 锁文件传给 root pip。审查确认路径后在首次提交前改为从固定 Git 对象单独读取；基线提交不包含此新增路径。

2026-10-14 基于 `1850752c` 的 ASTER 迁移工作区中，[迁移器](deploy/migrate-modules.py) 在 `/etc/aster-desk/environment` 缺失时曾读取旧服务可写的运行目录 `.env`，再以 root 复制其中指定的 CA 路径并转移文件归属。隔离文件系统夹具复现了合成私有文件被复制；修复后仅可信外部配置可以授权外部文件读取。此问题在本轮提交前修复，不表示基线已有该路径。

**如何验证：** [Python 依赖来源检查](deploy/test-python-lock.sh) 覆盖工作树锁文件被替换、父目录可写及链接路径；[迁移测试](deploy/test-migration.py) 覆盖运行目录配置不能授权 root 读取外部文件、可信配置正常迁移及所有权和父目录权限；[解析器权限检查](deploy/test-runtime-lock-parser.py) 验证恶意依赖不能写 root 私有目录或恢复 root 身份。Linux 归属与权限检查在 CI 执行。

**事件记录：** `embedded-python-provenance-20261013`、`aster-migration-file-provenance-20261014`；两次独立事件，分别涉及特权依赖安装和外部文件读取。

2026-10-15 审查 `4239c81` 默认源码部署变更时确认：`deploy/package-release.py:read_runtime_lock` 以 root 加载服务账号安装的 YAML 模块。仅 chown/chmod 冻结不能阻止冻结前植入的代码。此路径自 `1cd309f`（2026-10-14）引入，原显式源码模式已有该问题，本次将其变为默认更新路径。原提交的原生 Node 复现确认可执行被替换的依赖；修正为只将解析子进程降权，保留可信 Python 的文件复制和边界校验。事件 ID：`source-parser-privilege-20261014`，发现日期不作为新的独立发生日期。

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

**本地退避与检查耗时补充（2026-10-20）：** 用户反馈工作台“经常很久没有检查到更新，检查也很慢”。核对基线 `a767bbe` 的 [更新协调器](server/update-service/updater.py) 与 [发布读取器](server/update-service/releases.py)：服务器期限与本地失败退避共用 `nextCheckNotBefore`，任一 GitHub 请求失败即整次失败，退避升至 30 分钟，期间手动检查被静默忽略；连接中断不重试，请求按探测顺序串行，单次 socket 超时 25 秒，且检查卡住时 `checking` 没有总时限。`gh` 实测近期正式版在提交后约 5–9 分钟发布，发布流程不是主要延迟。本条只约束服务器给出的期限：`retryNotBefore` 拦截自动、手动与重启后的检查；本地退避只约束自动检查，上限 15 分钟，手动仍受 60 秒最小间隔限制。旧状态在 `failureCount>0` 时把原期限保守迁移为服务器期限。未收到 HTTP 响应的连接失败最多重试一次，任何 HTTP 状态（含带 `Retry-After` 的 5xx）都不重试。缓存命中时 manifest 与部署包 HEAD 并发，未命中时 manifest 与发布元数据并发，校验条件与错误优先级不变；整次检查超过 3 分钟记为失败，迟到结果按 `checkId` 丢弃。没有取得用户服务器的检查状态与网络耗时，不承诺具体提速秒数。验证沿用上述两份检查，新增并发、重试分类、手动绕过本地退避、旧状态迁移与超时丢弃场景。事件 `updater-local-backoff-blocks-checks-20261020`，关联本条，不推进复盘检查点。2026-10-25 起手动最小间隔改为 10 秒（上次检查失败后仍为 60 秒），原因见 L079。

**短暂 HTTP 故障补充（2026-11-05）：** 用户在正式版 `a78e57777f655bcb4de043d12a5feb55854626d9` 的系统更新中遇到“GitHub 发布服务暂时不可用（HTTP 504）”及约 4 分钟后重试。实际传输层夹具按 504→成功返回，旧实现只请求一次即失败，确认此前“任何 HTTP 状态都不重试”的策略会错失短暂故障恢复；未取得用户服务器日志，不能断言 504 来自 GitHub 内部还是网络链路。只读 GET/HEAD 的 502/503/504 现与连接异常共用最多两次尝试、一次 1 秒等待；`Retry-After` 指令存在（含畸形值）、额度为零或有效服务器期限时不即时重试，401/403/404/429 等也不重试。`retryable` 与仅控制缓存保留的 `transient` 分开，耗尽后仍返回最后错误；缓存、正式身份校验、调度退避及执行前重新核验保持原语义。[发布读取检查](deploy/test-release-cache.py) 覆盖 GET/HEAD/跳转、混合故障预算、远端等待和实际读取链的持续 504 不返回旧成功。事件 `updater-http-504-no-immediate-retry-20261105`；关联本条，不推进复盘检查点。

**下载入口故障补充（2026-11-09）：** 用户正式版 `50cdcbcc4301` 的系统更新连续 10 次显示“GitHub 发布服务暂时不可用（HTTP 504）”，手动检查同样失败。服务器端逐项重放确认：只有 `github.com/hxx344/project-aggregation/releases/download/<tag>/release-manifest.json` 持续返回 504（响应带 `X-GitHub-Request-Id`，无 `Server`/`Via` 代理头），同一时刻 `releases/latest` 跳转、带 Token 的 API 与 `raw.githubusercontent.com` 均为 200；同一时刻 `api.github.com/repos/hxx344/project-aggregation/releases/assets/<id>`（`Accept: application/octet-stream`）5/5 返回 200。服务运行四天、代码与磁盘一致，新进程按服务方式重放同样失败，排除进程状态与代理。根因是发布文件只有 github.com 下载前端一个入口，单个前端故障会阻断检查与更新。以后做法：更新服务读取发布清单与部署包 HEAD（检查、缓存命中与执行前复核）时，github.com 入口返回可立即重试的失败（502/503/504 或连接失败，且无 `Retry-After`、额度为零或服务器期限）并耗尽原有重试后，按同一 tag 元数据中唯一同名、正整数 ID 的资产改走 API 文件接口一次，404/403/429 与服务器期限不回退；API 也失败时报告原下载错误，只有元数据或 API 给出等待期限时改报该期限，缓存命中路径的元数据只读一次以免放大匿名额度。安装器沿用自身下载器的可重试判定（408、429、全部 5xx 与连接中断），耗尽后按已发布、非预发布 tag 中唯一已上传资产改走 API 下载一次；API 每个分块都计一次匿名额度，所以只作回退，切换地址后已下载分块不续传，内容仍按官方清单校验 SHA256。[发布读取检查](deploy/test-release-cache.py) 覆盖冷读、缓存命中、执行前复核、真实传输 504、资产不匹配、元数据失败与 API 限流；[镜像与下载检查](deploy/test-release-mirror.py) 覆盖安装器下载回退。事件 `release-download-front-end-504-20261109`；关联本条，不推进复盘检查点。

### L014：在脱敏边界内保留上游错误的可诊断性

**适用条件：** 交易所接口返回 HTTP 状态和结构化错误码，错误需要展示给用户。

**根因：** 非 2xx 时直接丢弃正文会把 IP 白名单、权限、签名等不同失败全部压成通用 403；只映射认证类又会漏掉官方参数与请求格式错误。将未知代码、无代码、空正文、HTML、超限和读流失败合并成一种提示，也会丢失排查依据。原样展示正文则可能泄露凭据或签名。

**以后做法：** 有界读取错误正文，对相关官方错误码做精确白名单映射，输出固定原因与建议；未知代码、响应格式和读取异常用固定诊断分类表达，不能把未收录的代码说成没有返回。优先解析实际 JSON，不因错误的 Content-Type 丢掉有效错误码。不得通过任意字符串匹配猜测真实原因，也不得为读取失败建议开启交易或提现权限。检查公共 API 错误过滤是否会再次吞掉已脱敏的诊断。

**如何验证：** [Gate 单测](modules/asset/tests/gate.test.ts) 检查已知/未知错误码、恶意正文、限长与取消、超时和重定向；[生产 API 冒烟](tests/asset-gate.smoke.mjs) 检查诊断到达客户端且连接、金额和成功时间仍在失败时保留。仅运行受影响路径。

**证据：** 本仓 `b71cbdc` 的 [Gate reader](modules/asset/lib/gate.ts) 在非 2xx 分支读取 `label` 之前抛错。2026-10-14 用户先提供 HTTP 403，后在 `950da11` 诊断改进后提供 HTTP 400 截图；核实后者仍漏掉官方通用请求错误表全部 10 个代码，并混合所有响应读取失败类别。该日仅以虚构密钥对照请求，是否携带 Content-Type 均得到 `INVALID_KEY`，不能证明它是用户 400 的原因；用户真实响应原因仍未确认，不将其归因为权限、币种或 IP 问题。

**事件记录：** `gate-error-diagnostics-20261014`；首次确认 2026-10-14，属于一次缺陷与连续修复。

**RPC 地址密钥补充（Aero 市场，2026-11-05）：** 很多 RPC 服务把密钥放在 URL 路径或查询串里，节点报错时可能回显解码后的地址。只替换配置原文会漏掉 `%2B/%2F/%3D` 解码后的形式、大小写不同的转义和 userinfo；错误对象的 `cause`、`AggregateError.errors`、JSON-RPC `data` 也会把原文带进日志、状态接口和浏览器缓存。做法：对路径段、查询值和 userinfo 同时脱敏编码与解码两种形式，在 RPC 层重建错误对象而不是只改 message；浏览器缓存不保存诊断正文，并删除过期或旧格式的缓存副本（只是不展示，旧泄漏副本仍留在 IndexedDB）。短路径段会过度替换常见单词，属可读性问题，不能因此跳过脱敏（见 issue #186）。验证见 [RPC 测试](tests/aero-market-rpc.test.mjs) 与 [缓存测试](tests/aero-market-cache.test.mjs)；多轮独立审查以虚构密钥内存探针复核，未用真实节点。

**OKX 只读检查限流补充（2026-11-07）：** 用户截图显示 Anthropic 仓位过期，错误为 HTTP 429 / OKX 50011，却建议检查权限、IP 与时间。基线 `05784b4` 的 [只读客户端](server/trading-okx-readonly.mjs) 在原油、海力士、Anthropic、资金费四路并发刷新时分别检查同一账户配置；[诊断格式化](server/trading-diagnostics.mjs) 未识别限流。四次请求本身不能证明超过官方每用户 5 次/2 秒额度，其他同 UID 请求来源未核实。修复只合并同完整凭据的在途校验，完成后不缓存权限结果；各订阅者独立取消，最后一人取消才中断底层，旧任务不得清掉新任务。只读配置限流最多等待 2100ms 后重试一次，较长 Retry-After 在该客户端进程内约束后续读取；持续失败仍保留旧仓位、旧成功时间与过期状态。诊断按安全数字码识别，兼容旧快照，不透传正文，也不更改订单写请求重发规则。[限流回归](tests/trading-okx-rate-limit.test.mjs) 在旧代码复现四路重复、缺少重试与错误提示，修复后覆盖取消、凭据隔离、权限变化、冷却期限及真实 trading 刷新的保留/恢复；没有使用真实账户。事件 `okx-readonly-config-rate-limit-20261107`；不推进复盘检查点。

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

**适用条件：** 独立项目已作为固定源码副本内置到工作台、同一功能存在多个仓库与发布入口，或后端能力需要通过页面配置、观察和核对。

**根因：** 只在独立仓库实现并发布功能，未核对用户页面实际加载的内置模块，导致独立版通过测试且发布成功，工作台仍显示旧界面。来源记录不会自动同步上游代码。只完成后端执行和通知、未接通页面设置与状态入口，也会出现后端测试通过但用户无法找到功能的交付缺口。

**以后做法：** 从用户入口追踪运行目录、模块来源与打包路径；把改动纳入实际运行仓库，并保留其登录、内部通信与维护适配。需要用户配置和核对的功能，同时检查设置入口、真实配置持久化、状态来源及报告入口；页面默认值必须对应后端实际行为，运行中事件使用固化配置，读取页面不得刷新源数据时间或触发交易。验证沿用真实模块入口和发布包，不能用另一仓库的构建成功或仅后端用例通过代替交付完成。

**证据：** gate-crossex-arbitrage `640df2f8c81990cf48e9bac1b2a6101fcafb8483` 已发布资金费机会；2026-10-14 用户截图仍无切换按钮。project-aggregation `0b838004` 的 [来源记录](modules/crossex/SOURCE.json) 仍为 `804d284`，而 [模块适配器](server/modules/crossex.mjs) 加载本仓 `modules/crossex/dist`。[打包工具](deploy/package-release.py) 仅打包本仓模块，不拉取独立仓库的正式版。关联 L005 的入口核对原则，但属于本次独立的交付遗漏。

**补充证据：** project-aggregation `4197923` 已实现 [ADL 检测与处理](modules/aster/trading/adl.py) 及飞书报告，但该提交没有接入 Aster 配对页的设置、监测状态或报告入口；2026-10-16 用户要求在前端配置自动减仓和单批金额，并查看真实状态及处理报告。本轮在实际工作台的 [配对页](modules/aster/dashboard/components/pairs-workspace.tsx)、[ADL 面板](modules/aster/dashboard/components/pair-adl-panel.tsx) 和 [配对设置](modules/aster/dashboard/components/pair-settings.tsx) 补齐入口，并让配置控制实际执行、状态保留完整补查时间。此次证据限于源码核对和离线测试，不代表服务器部署或实盘验收。

**如何验证：** [内置资金费回归](tests/embedded-funding.test.mjs) 从真实 Monitor 投影，经私有管道、CrossEx 和工作台代理读取资金费机会，并追溯内置 HTML 的构建资源；浏览器从工作台入口验证切换与预填，正式包再核对内置模块产物。无需扩大为无关模块全量回归。

ADL 的相关验证使用 [配置校验](modules/aster/tests/test_adl_config.py)、[执行边界](modules/aster/tests/test_adl_controller.py) 和 [配置与报告接口](modules/aster/tests/test_adl_api.py)，分别检查普通十进制金额与边界、单批硬上限、关闭自动后只读核实、事件配置跨重启，以及报告读取不触发交易。浏览器从“两子账户配对 → ADL 应急处理 → ADL 设置”检查真实保存、状态和“查看处理报告”；按本次范围复用已通过结果，未执行的验收不得描述为通过。

**事件记录：** `embedded-funding-delivery-20261014`；2026-10-14 用户纠正后核实，补丁移植和发布验证均归为同一次事件，不推进主线复盘检查点。

本轮关联 `aster-adl-ui-entry-20261016`：同次 ADL 功能交付中的入口补全，设置、状态、报告及其连续修补不拆成多个事件；扩展本条经验，不另建重复条目或推进主线复盘检查点。

**工作台原生入口补充（2026-10-27）：** `3e4de30` 已在聚合仓库交付 Entropy/Lighter 采集与模拟，却仅提供独立 CLI/systemd；用户随后明确要求在工作台内部使用。仓库与发布目标正确仍不足以完成产品接入。新增研究能力先核对侧栏入口、配置/报告路径、后台生命周期及正式包，不能从“Linux 常驻”自行推导为另装服务。本轮补齐原生研究页、已鉴权的 API、runtime 托管进程、四文件发布白名单及增量键；用 [工作台接口测试](tests/entropy-lighter-workbench.test.mjs)、[生产页面夹具](tests/entropy-lighter.browser.mjs) 和 [跨 API 重启用例](tests/process-split.test.mjs) 验证，其中 POSIX 路径在 Windows 跳过、等待 CI，不能描述为本地通过。事件 `research-workbench-entry-20261027`；不推进复盘检查点，历史事件的具体根因与适用边界仍须逐项核验，不仅按条目内日期数量升级规范。

**双槽资源逃逸（2026-10-27）：** 审查已合入 `6ab243e` 确认：`84aa260` 的切流先移动 `current`，旧槽排空后才更新 `previous`；仅测试健康接口和目标 HTML，遗漏旧页面延迟分包与回滚后的新页面分包。实际资源查找复现两个方向 404，属于 P1 逃逸。资源来源须覆盖两个固定槽所引用的合法发布目录，仍拒绝任意其他版本和目录内链接；[资源 HTTP 回归](tests/release-assets.test.mjs) 与 [systemd 公共入口](deploy/test-slots-systemd.sh) 检查先取页面、再切流/回滚、最后请求分包及复用授权。事件 `api-slot-delayed-assets-20261027`；不推进复盘检查点。

### L018：固定 Node 执行包管理器时必须取得 JavaScript 入口

**适用条件：** CI 或安装器使用 `node <package-manager>`，以固定 Node 版本运行包管理器。

**根因：** `command -v pnpm` 可能返回 `.bin` 中的 shell shim；`realpath` 只能解析文件链接，不能把 shell 包装器变成 JavaScript。将该路径交给 Node 会在安装或构建前报语法错误。

**以后做法：** 明确取得所安装包的 JavaScript 入口，并用指定 Node 验证包管理器版本；若直接执行 shell shim，则另行确认其实际 Node 选择。不能假设 `pnpm exec` 总会提供 `npm_execpath`。

**证据：** 本仓基于 `35396d4` 的 2026-10-14 pnpm 迁移工作区中，[CI](.github/workflows/ci.yml) 最初把 `command -v pnpm` 传给 [非 root 构建检查](deploy/test-workspace.sh)，后者再通过 Node 执行。审查对照 `pnpm/action-setup@v4` 的 `.bin` 安装路径确认不匹配，首次提交前改为 action 安装目录下的 `pnpm/bin/pnpm.mjs`；本地 `pnpm exec node -p process.env.npm_execpath` 实际返回 `undefined`。这不是基线提交已有的 pnpm 缺陷。

**如何验证：** CI fixture 先以 `INSTALL_TEST_NODE` 执行入口并断言 pnpm 版本，再完成真实非 root 构建；仅 `bash -n` 不能覆盖入口类型错误。

**事件记录：** `pnpm-cli-entry-20261014`；迁移开发阶段一次已核实审查发现，连续修补不重复计数。

**原生发行版补充（2026-11-06）：** `npm_execpath` 也不一定是 JavaScript。Windows 本机全局 pnpm 11.25.0 是 `@pnpm/exe` 原生发行版，`npm_execpath` 指向 `pnpm.exe`；基于 `bf02adc` 的 [模块构建脚本](scripts/modules.mjs) 和 [流水线命令解析](deploy/pipeline/exec.mjs) 都用 `node <npm_execpath>` 启动 pnpm，实际报 `ERR_UNKNOWN_FILE_EXTENSION ".exe"`，`pnpm run build:modules` 在安装依赖后、构建任何模块前失败。做法：读取入口文件头，PE/ELF/Mach-O 原生可执行文件直接启动，其余仍交给固定 Node。验证：[流水线测试](tests/pipeline.test.mjs) 覆盖 JS 入口、过短文件与三类原生文件头；Windows 原生 pnpm 下实际运行 `pnpm run build:modules` 并确认二次运行全部缓存跳过。事件记录：`pnpm-native-execpath-20261106`，与原事件根因相同、触发入口不同，计为关联的独立事件。

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

**跨模块导入补充（2026-10-17）：** 事件 `monitor-crossex-import-identity-20261017`。本仓 `c00f651` 的 Monitor「在 CrossEx 查看」只传币种和交易所，`ManualHedgePanel` 据此选择目录中第一个合约；同平台 USDT/USDC 并存时会选错计价币，缺腿时还会回退。跨模块预填须携带精确双腿代码，并从原生符号解析币名、复用已验证别名与合约计价规则；接收端缺任何一腿时保留待处理状态，不自动替换。[Monitor 映射测试](modules/monitor/tests/crossex-import.test.mjs)、[接收匹配测试](modules/crossex/tests/opportunity-import.test.mjs) 与[工作台导入验收](tests/opportunity-import.browser.mjs)覆盖原生别名、USDT/USDC、Hyperliquid、迟到目录和缺合约。

**跨模块导入补充（2026-10-18）：** 同一事件 `monitor-crossex-import-identity-20261017` 的后续，不增加事件数。基于 `61b43d2` 的逐腿导入改动中，[FOLKS 夹具](modules/crossex/tests/opportunity-import.test.mjs) 使用已收录的 Gate 合约与缺失的 Lighter 合约验证部分匹配；实际支持范围以当前目录为准，不据夹具推断交易所实时上架状态。接收端保留精确有效腿，提示缺失合约及仍有效的可选场所，机会表禁用缺腿组合；缺腿必须由用户明确补选。审查在[工作台浏览器回归](tests/opportunity-import.browser.mjs) 实际复现：编辑已保留腿会触发默认选腿 effect，把原缺失腿自动替换为另一计价币合约；修复后手动选择保留空腿，切换币种才重新采用默认选择。单测另复现已下架或暂停合约被列为“可交易”，修正提示只统计有效状态。后续目录变化、补齐双腿和显式预览分别验收，数量与旧核对页不得沿用。原修改中的目录总数及实时场所断言未保存原始响应，不纳入本轮核实证据。

**多空方向与排序补充（2026-11-07）：** ANT 自动减仓开发中的初版表单把保存响应 `legs[0]` 当作多头，但执行计划会按交易所与合约排序；Binance 空头、Hyperliquid 多头的响应会把空头排到前面，再次保存就可能反转交易方向。腿的业务身份必须由 `exchange + symbol + side` 保留；固定多头/空头输入框按 `side` 查找，不按数组位置认领。[自动减仓浏览器回归](tests/trading-anthropic-reduction.browser.mjs) 覆盖服务端短腿在前、重新显示与保存仍维持原多空选择。事件 `ant-reduction-sorted-leg-direction-20261107`，作者自审在发布前发现并修复，未触发真实订单；不计作既有别名事件的复发。

**RH 仓位身份补充（#259，2026-11-08）：** 基线 `9351de4` 的 RH 执行适配器按 `market_id` 找到仓位后，把调用方 `symbol` 写入投影而未核对返回符号。编号与原生符号都属于已返回的身份字段，必须与已验证市场目录一致；官方 AccountPosition 要求 symbol 为字符串，缺失、畸形、大小写或空白变体均拒绝，不猜测别名。零仓位行也可能携带杠杆配置，不能跳过身份检查。[适配器回归](tests/trading-rh-lighter-execution.test.mjs) 和 [真实适配器到风险规划回归](tests/trading-execution-rh-lighter.test.mjs) 在修复前确认错误身份未被拒绝，修复后错误场景零任务、零锁、零发送。事件 `rh-position-market-symbol-consistency`，沿用 Issue ID；为离线矛盾响应验证，未确认线上错合约或损失。

**自动规则敞口补充（#284，2026-11-09）：** 基于 `0243193` 的未发布实现，历史 held 虽按原生合约与乘数分组，名义额仍误用当前新合约盘口；新旧原生代码、单位或乘数不一致时，历史估值及盘口时间须保留未知。同轮独立审查还确认：单向模式的 `BOTH` 或缺失仓位方向不能按买入认领多头、卖出认领空头，买入可能是平空；未归属委托可在两个方向明细提示，但总量未知且不得重复相加。`tests/trading-auto-exposure.test.mjs` 覆盖旧合约估值隔离；BOTH/缺方向新回归修前错误返回 complete、修后两方向未知，明确 SHORT 负对照仍准确。事件分别为 `auto-exposure-historical-contract-price-20261109`、`auto-exposure-oneway-order-attribution-20261109`；均首次发布前修复，无真实交易。

### L021：子面板样式不能改变公共页面的宽度

**适用条件：** 多个市场面板共用导航、行情卡片和居中容器，子面板按需加载并在切换后保留挂载。

**根因：** 合约扫描器用高特异性的祖先选择器将 `.hub-tabs` 的 `1560px` 上限覆盖为 `none`，进入机会或图表时连公共导航和行情卡片一起拉宽；持仓移除扫描器类后又恢复。扫描器自己的横向 padding 还覆盖了公共面板留白。

**以后做法：** 子面板只控制内部布局和所需方向的间距，沿用公共容器的宽度与横向留白；宽表格在面板内滚动。断点与溢出按实际 iframe 视口判断。

**证据：** `project-aggregation`，基线 `47be9dd` 的 [扫描器样式](modules/monitor/app/perpetual-scanner.css)、[公共布局](modules/monitor/app/globals.css) 和 [合约工作区](modules/monitor/app/perpetual-panel.tsx)。2026-10-14 用户报告后，在工作台实际 iframe 内复现：外层视口 2100px 时，原油切到合约使公共容器从 1560px 拉宽到约 1859px，左侧居中留白从约 150px 变为 0。

**如何验证：** 使用本仓生产构建，从工作台进入市场监控；在宽屏和窄屏依次切换原油、合约机会、图表、持仓、机会及其他市场，比较公共导航、行情卡片与容器边界。确认上限保持 1560px、合约横向留白按模块视口沿用 32px/16px、宽表格内部滚动，父页面与 iframe 均无横向溢出。本轮已覆盖 2100、1280、800、390px 外层视口；行情接口使用隔离夹具，不把布局验收描述为行情或交易验收。

**事件记录：** `monitor-scanner-shell-width-20261014`；一次已核实布局缺陷，多个视口及子标签页不重复计数。

**ANT 工具栏补充（2026-11-07）：** 基线 `4efbca4` 的 ANT 工具栏在共享 `.refresh-area` 横排中放入三个合约切换按钮、刷新按钮和刷新说明，390px iframe 实测 `scrollWidth=459`。新增市场控件时须按 iframe 实际宽度检查工具栏，不能只确认图表本身缩放。当前仅对 ANT 的窄屏工具栏与刷新区启用换行，不改公共容器宽度；[工作台验收](tests/monitor-anthropic-trades.browser.mjs) 复现并覆盖修复后的 390px 无横向溢出。事件 `ant-monitor-toolbar-overflow-20261107`；本次浏览器验收发现，未核实用户服务器是否遇到。

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

**强平距离未知补充（#257，2026-11-08）：** 基线 `9351de4` 的 ANT 预警把无法计算距离的所有 null 都视为恢复；HL/RH 非零仓位的名义金额为零时，标记价不可用但强平价仍有效，旧告警被错误解除。先判断必要读数是否有效，再处理交易所明确不再提供强平价或仓位消失；接口读取成功也不能为缺价数据发送绿色恢复。已激活告警保持，未知通知沿原发送前持久占用去重，页面明确无法计算。[预警回归](tests/trading-anthropic-watch.test.mjs) 覆盖 HL/RH 缺价、读取中断后仍缺价、发送失败、跨重启及有效数据恢复；[工作台页面夹具](tests/trading-anthropic-positions.browser.mjs) 覆盖保警与恢复展示。事件 `anthropic-watch-missing-mark-false-recovery`，沿用 Issue ID；离线复现，不声称真实 API 已返回该异常组合。

### L025：账户流水按委托聚合时严格限定可聚合类型

**适用条件：** 成交/资金流水按 order_id 或 business_id 聚合展示。

**根因：** Gate account book 里只有 TRANSACTION / TRADING_FEE / LIQUIDATION_FEE 的 business_id 才是委托号；资金费结算、划转及无委托号若强行按同 ID/时间合并，会把无关流水并进一笔委托。

**以后做法：** 仅对官方标明与委托绑定的类型按委托聚合；资金费、划转、缺 ID 保持独立记录；缺失金额用 unknown 而非 0；手续费按币种分别合计。

**证据：** 本仓 `bb296a89` 的 [account-history.ts](modules/crossex/src/account-history.ts) 与 [账户流水测试](tests/crossex-account-history.test.mjs)（funding/transfer 不继承委托、缺金额为 null）。

**如何验证：** 运行 [账户流水聚合测试](tests/crossex-account-history.test.mjs)。`FUNDING_FEE`、划转和空 `business_id` 即使标识或时间与成交相同也各自成组；缺金额为 `null`；手续费按币种分别合计。

**事件记录：** `crossex-account-history-group-20261014`；Seen 1×（2026-10-14）。

**分批成交汇总补充（2026-11-06）：** 原油与海力士的连续入场/出场汇总不能把显示用的成交 ID 字典序当作仓位变化顺序。同毫秒 `id9: 0→1`、`id10: 1→2` 会被排为 10、9，若直接取首末仓位，再接下一批 `2→3` 会误拆连续加仓。对已确认纯开仓/纯平仓的同毫秒记录，按精确仓位绝对值恢复单调链并逐笔核对；不同原生账户、合约、方向、币种或内部断链不能借用另一腿的连续证据。短时间内开仓、平仓、重开也须按类型分段，不能仅按十分钟窗口并成调仓；同毫秒混合开平和单笔过零仍保留调仓，不猜测操作编号。日期边界使用界面声明的北京时间。证据为基线 `0c1cbcc` 上首次实现的独立审查探针，修复与回归见 [成交汇总测试](modules/monitor/tests/trade-summary.test.mjs)。事件 `monitor-trade-summary-position-chain-20261106`，提交前发现，未逃逸到正式版，不推进复盘检查点。

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

**开仓容量补充（2026-10-18）：** 独立事件 `crossex-capacity-counter-currency-20261018`。本仓 `a896ba7` 的 [容量上下文](modules/crossex/server/market.mjs) 将原生 `quoteCurrency` 写入容量响应，但 [前端校验](modules/crossex/src/open-capacity.ts) 要求它与 CrossEx 合约后缀相同，导致 Lighter 多 / Hyperliquid 空的 VIRTUAL USDC 组合持续显示“开仓估算与所选合约不匹配”。容量字段应使用已验证身份的 `counterCurrency`（兼容旧身份的 `quoteCurrency`），保留原生身份与按结算币换算的金额逻辑，不放宽前端校验。[容量回归](modules/crossex/tests/open-capacity.test.mjs) 在修复前实际复现单腿和双腿错配，并覆盖 BUY/SELL、反向双腿、非 1 汇率的名义额和保证金、拒绝/不可用状态及零交易写入；[前端校验回归](modules/crossex/tests/open-capacity-ui.test.mjs) 继续拒绝真实币种错配。本次不推进历史复盘检查点。

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

### L030：大文件下载要显示进度并保留可验证的续传片段

**适用条件：** 一键更新通过网络下载完整运行包，下载时间足以让用户误以为安装停住。

**根因：** `curl --silent` 隐藏下载进度，编排层又把下载地址的 HEAD 预检成功描述为“部署包已就绪”；失败后删除临时包，也使重试从头开始。

**以后做法：** 区分预检、下载、校验与服务切换。实测 Range 支持后再启用有界并发，校验每段响应的范围与长度；失败片段按固定发布身份保存，复用时重新核验，整包 SHA-256 通过才允许解包。网络速度差异不能仅凭体感归因为发布包变大。

**证据：** 2026-10-14 用户在 `9ad1bff` 的安装日志停留于发布解析后报告等待很久；现场 curl 进程仍运行、临时文件字节数持续增加，确认处于下载阶段。该版包为 108,630,372 字节，上一正式版 `9da911b4` 为 108,628,521 字节，不能据此认定本轮修复导致下载明显变慢。相关实现为 [公共发布助手](deploy/release-common.sh) 与 [编排入口](deploy/install-all.sh)。

**如何验证：** [下载协议检查](deploy/test-release-download.py) 覆盖并发上限、异常分段回退、重试与续传、缓存边界和最终摘要；[发布助手检查](deploy/test-release.py) 覆盖三份嵌入代码一致、固定发布与解包校验。Linux CI 验证权限、进程锁及中断恢复，不能把 Windows 模拟结果写成 Linux 验收。

**事件记录：** `release-download-silent-wait-20261014`；一次已核实的用户反馈与现场下载状态，不包含未证实的网络变慢归因。

### L031：共享 SQLite 连接的事务校验不能嵌套连接上下文

**适用条件：** `Store.connection_scope()` 复用同一 SQLite 连接，写事务在比较持久状态后调用额外校验回调。

**根因：** 回调若再通过 `Store.connect()` 读取数据，嵌套连接上下文退出时可能提前提交外层事务，令后续配置、运行日志和归档写入失去整体回滚能力。

**以后做法：** 在当前事务内直接读取和比较所需持久记录；最终回调只核验已经取得的连接身份、快照版本和时效，不再次进入 Store 连接上下文。

**如何验证：** [配对标的切换测试](modules/aster/tests/test_pair_symbol_change.py) 的配置写入后失败场景，同时覆盖独立连接和 `connection_scope()`，确认最终校验后事务仍开启，失败后配置、运行记录及归档全部回滚。

**证据：** 本仓基于 `4cc7f3d` 的 2026-10-15 配对标的编辑工作区，首版 `PairManager._switch_symbol` 在事务回调中调用 `PairTrader._members`，间接读取 Store。提交前改为直接核对已捕获的 broker 与身份；[专用提交事务](modules/aster/trading/store.py) 保留持久状态比较。此为本轮新增实现中的缺陷，基线未包含该切换路径。

**事件记录：** `pair-symbol-switch-scoped-transaction-20261015`。

### L032：跨升级的构建复用必须覆盖实际安装入口与临时目录

**适用条件：** 将正式包部署改为服务器源码构建，或在每次更新的全新 Git 归档中复用模块产物。

**根因：** 只改底层安装器默认值，一键入口和更新器仍可显式选择旧模式。原安装器又将整个 `modules` 树纳入主站与模块公共构建键，临时归档不携带 `.module-cache`；模块脚本还把环境文件的绝对路径加入键，换目录后无法复用。

**以后做法：** 从一键命令和网页更新器追踪固定正式提交，统一传递发布清单，不用 `main` 代替所选版本。主站页面、单个模块产物和运行时组装分别确定输入；跨升级缓存由安装器保存在工作区外，并验证全部产物文件。root 执行的脚本和运行源码从固定 Git 对象重新提取；向服务账号可写的构建目录恢复产物时使用该账号。

**如何验证：** [入口检查](deploy/test-stack-ci.sh) 和 [源码安装检查](deploy/test-incremental.sh) 覆盖正式提交固定及分支变化；[模块安装检查](deploy/test-module-incremental.sh) 覆盖新临时目录、单模块重建、非入口文件损坏和失败不切服；[缓存检查](deploy/test-build-artifact-cache.py) 校验完整性与文件边界。[真实工作区检查](deploy/test-workspace.sh) 在 Linux CI 覆盖服务账号构建、组装和跨目录复用。按本次变化选取检查，不把 Windows 夹具结果作为 Linux 部署验收。

**证据：** 本仓 `c506a0a` 基线及 2026-10-15 用户要求改用源码部署的工作区，`deploy/install-all.sh` 与 `server/update-service/updater.py` 仍指定 `ci`，`deploy/install.sh` 重新归档后共享模块构建键失效，`scripts/modules.mjs` 使用绝对环境文件路径。模块选择及迁移目录的原生 Node 回归验证了修正后的复用行为。

**事件记录：** `source-deploy-entrypoint-cache-scope-20261015`；一次已核实的入口与缓存接入问题，后续同轮修正不重复计数。

### L033：切换配对标的按实际目标仓位采纳底仓

**适用条件：** 已有配对组修改交易标的，尤其用户已手动持有目标标的、配置或历史账本仍指向原标的的情况。

**根因：** 首版切换沿用新建组的全账户空仓要求，并一律拒绝长期保留的 `recovery_watch`。这使“配置为黄金、实际已手动持有白银”的组无法直接改为白银；仅移除空仓判断又可能把原标的数量错误映射到新账本。

**以后做法：** 从目标标的新鲜快照读取两侧指定方向的实际数量，建立新 `owned` 与循环底仓，保持暂停；原运行记录归档，不能以配置标的推断真实持仓归属。历史观察批次保留自身标的、客户端编号和账户身份，切换时重新核查，后续启动与写入继续核查。活动执行日志仍绑定当前标的，不因历史观察跨标的而放宽。

配对归属只覆盖指定标的及各账户指定方向，其他标的或反向持仓可以继续存在，不采纳进本组账本，也不被本组减仓。采纳、启动、运行及恢复使用同一范围；完整账户快照仍用于风险计算，同标的两方向均计入持仓上限、行情变化浮亏和占用增量。旧标的终态成交在完整当前风险核验后不阻止新标的运行，也不改写新底仓或原始归档；活动订单、原编号回执不匹配及本组账本冲突仍须核对。存在同标的非本组方向仓位时保留当前杠杆，避免自动升档连带修改手动仓位。本组空仓核对只检查所属两腿；解除仍带旧订单观察的绑定时，继续独立验证全账户空仓。

仓位展示范围与策略归属分开：配对页和账户页展示完整非零持仓，标记策略币种及本组管理方向。仅保证金模式使用“配置币种”标记；仓位取已有完整交易快照或账户接口单独解析的完整展示清单，保留原始读取时间，不把更新的余额当作空仓证据，也不改变交易风控使用的快照。

历史观察记录本身不代表当前未完成订单或统计不可用。汇总只在匹配的检查结果明确失败或发现活动回执时提示异常；重启丢失显示缓存、检查正常和单纯保留归档均不要求用户再次核查。配对成交量继续读取已核对账本，保留真实未决批次和 `volume_unknown` 的未知语义，不因旧观察记录永久阻塞，也不改写历史成交。

**如何验证：** [标的切换测试](modules/aster/tests/test_pair_symbol_change.py) 覆盖目标标的非零、不等量手动底仓及原账本数量隔离；[历史观察切换测试](modules/aster/tests/test_pair_symbol_watch.py) 覆盖真实人工归档后切换、原标的查询、重启保留、迟到成交及查询竞态，确认切换不发送交易写入。

[归档后底仓采纳](modules/aster/tests/test_pair_archived_baseline.py) 覆盖其他仓位存在时预览、确认及启动；[配对交易](modules/aster/tests/test_pair_trading.py) 覆盖单边拒单只减另一侧、超时后按同一编号查询不重发（原循环只减回本组新增量的用例已随配对循环移除，旧循环增量改为阻断待人工核对）；[仓位范围与风险](modules/aster/tests/test_pair_position_scope.py) 和 [升档检查](modules/aster/tests/test_pair_upgrade_capacity.py) 验证同标的总持仓上限、其他仓位占用、行情重估和发送前新增反向持仓不会触发杠杆写入。

展示层改动运行 [ASTER 汇总测试](modules/aster/tests/test_hub_summary.py) 与 [适配器测试](tests/adapters.test.mjs)，覆盖旧观察记录、重启无缓存、实际检查失败、迟到成交、已确认合计及 UTC 跨日；确认读取汇总不新增交易所查询、不修改持久状态。

**证据：** 本仓 `c506a0a` 的 [切换入口](modules/aster/trading/pairing.py) 同时要求 `require_flat=True` 并拒绝所有 `recovery_watch`；2026-10-15 用户截图显示历史归档提示，随后明确实际已手动开 `XAGUSD1`、组仍配置 `XAUUSD1`。修复基于 `4239c81`，仅支持按目标实际仓位采纳，不扩展为同组自动管理多个标的。

同日用户在切换后指出历史订单重复核查提示冗余。基于 `3be993f` 的 [摘要](modules/aster/trading/hub_summary.py) 和 [兼容适配器](server/adapters.mjs) 将长期 `recovery_watch` 等同当前未决订单，Python 还把重启无缓存等同检查失败；上述回归在修复前复现观察提示、重启误报和跨日成交量仍为空。本次仅修正汇总语义，保留交易前自动检查与归档记录。

同日基于 `65139ba`，用户截图显示“核对并采纳当前底仓”仍因其他仓位被拒绝。`PairManager._read_members` 与 `pair_planning.positions` 均将全账户持仓排他地绑定到本组方向，后者还覆盖运行与恢复；仅移除入口检查会在下一轮重新阻塞。修正两处范围后同步补齐同标的反向持仓的风险计算，保留原账户模式及未知订单保护，不扩展跨模式交易能力。

同日用户要求配对账户展示全部仓位。基于 `a7723d9`，后端 `snapshot_json` 已保留全量持仓，但配对风险卡只渲染组标的。展示修正复用已有快照与共享持仓表；[持仓展示测试](modules/aster/dashboard/tests/account-positions.test.mjs) 验证全币种、双向标记和快照选源，浏览器核对实际工作台内的配对页、账户页与窄屏表格。

**事件记录：** `pair-symbol-manual-holdings-adoption-20261015`；同一功能的用户反馈与连续修复。

### L034：源码发布权限与完整更新结果分别验收

**适用条件：** root 从 Git 归档组装源码发布目录，并在应用健康检查之后安装在线更新服务。

**根因：** Git 默认 tar 归档可带有 `0775` 目录和 `0664` 文件；源码组装漏掉 CI 包安装已有的 root 归属与去除组/其他用户写权限步骤，导致 `updater_safe_path` 拒绝后置安装。应用已切换且部署记录已写入，因此版本相等不能证明整次更新完成；页面忽略失败任务，出现绿色“已是最新”与更新失败同时显示。

**以后做法：** 对固定 Git 对象新组装的目录规范权限后发布，保留执行位与安全路径检查；更新组装配方版本并检查复用候选，不把旧可写代码简单改权限后继续信任。将版本对齐与上次任务结果分别呈现。失败目标仍为当前正式版本时，旧受保护计划只识别目标，重新检查生成固定摘要和当前安装身份的新恢复计划，再由用户确认执行。

**如何验证：** [更新服务安装检查](deploy/test-update-service.sh) 从真实 Git 归档检查源码发布权限、后置安装及重复运行；[协调器检查](deploy/test-updater.py) 覆盖切服后失败、过期计划恢复、完成回执、旧失败目标和 worker 启动失败后重试；[更新结果界面检查](tests/updates-result-status.browser.mjs) 覆盖版本对齐后的失败/中断提示与恢复确认，[HTTP 检查](tests/updates-http.test.mjs) 确认恢复标记穿过公共状态白名单并抵达 HTTP/SSE。Linux 权限与服务行为由现有 CI 验证，不用 Windows 结果代替。

**证据：** 本仓 `203515f` 部署的 2026-10-15 用户日志明确显示工作台健康运行后，`/opt/project-aggregation/releases/203515f0bee5-33025824d38fdd0a/server/update-service` 因允许其他用户写入被拒绝；固定该提交的真实 `git archive` 目录模式为 `0775`。相关路径：[源码安装器](deploy/install.sh)、[更新协调器](server/update-service/updater.py)、[系统更新页面](src/UpdateStatus.tsx)。

**事件记录：** `source-release-permissions-post-activation-failure-20261015`；一次已核实的用户故障与同轮状态恢复修复。

**更新材料保留补充：** 基线 `2d59d12` 的 [更新协调器](server/update-service/updater.py) 每次计划过期后创建新目录，却从不删除旧计划和任务日志。持续有可更新版本而未确认时，30 分钟计划 TTL 会使目录持续累积。计划过期只撤销执行授权；最近失败任务仍以 `jobPlanId` 识别恢复目标，不能据过期时间直接删除。清理须在状态锁内按引用保留当前计划、最近任务的计划和任务目录，再限制其余历史任务数量；文件创建及状态引用发布也须在同一锁内，避免误删尚未发布的新计划。回执按模块覆盖，不是按任务追加的历史目录。

**对应验证入口：** [协调器测试](deploy/test-updater.py) 覆盖连续过期后目录有界、失败恢复引用、排队/运行中任务保留、终态及启动清理、历史任务排序、未知名称与符号链接、写入中断和清理异常不改变更新结果。Windows 的原生回归不代替 Linux root 的链接、权限与 systemd 验证。事件 `updater-history-retention-2d59d12`，为本次基线源码核实的独立缺陷；未取得服务器积累时间与实际占用量，不据估算声称现场测量，不推进复盘检查点。

### L035：配对升杠杆须用共享公开额度覆盖两侧现有持仓

**适用条件：** ASTER 配对普通策略从当前杠杆升至更高档位，目标档有公开额度但已有底仓较大。

**根因：** 配对升档只检查公开额度超过配置门槛，以及各子账户的私有持仓上限，漏掉单账户升档已有的总名义持仓比较；两侧分别不过限也不能证明共享公开额度足够。

**以后做法：** 按两侧 `qty × max(仓位标记价, 当前标记价)` 求和，不抵消多空、不使用保证金金额。目标公开额度须严格超过总名义持仓与配置门槛，各账户仍分别满足私有档位上限。候选选择、等待原因与发送前检查复用同一判断，最后账户快照刷新后再次检查。额度变化不能作为清除已发送且结果未知请求的依据。

**如何验证：** [配对升档额度测试](modules/aster/tests/test_pair_upgrade_capacity.py) 覆盖低于、等于、精确略高于总持仓，双侧合计、价格变化、私有上限与发送前变化；确认跳过升档后仍可按当前档位评估开仓，并保留未知请求核对保护。[开仓提示测试](modules/aster/tests/test_opening_messages.py) 确认诊断与资格判断一致。

**证据：** 本仓 `74fc675` 的 [配对规划](modules/aster/trading/pair_planning.py) 在 2026-10-15 原生 Windows 回归中复现：当前 10x、两侧各 `100 × 100 = 10000 USD1`、门槛 `10000 USD1`，目标 20x 公开额度为 `15000` 或 `20000 USD1` 时仍返回 20x。截图中的持续核对来自 [配对执行](modules/aster/trading/pair_execution.py)；截图本身不足以证明原请求已被明确拒绝。

**事件记录：** `pair-upgrade-shared-capacity-20261015`；一次用户反馈与同轮防护修复。

### L036：更新进度必须经过真实任务与部署通道

**适用条件：** 特权更新进程、控制服务和网页分别运行，需要展示安装阶段或下载量的路径。

**根因：** `3be993f` 在 Node 路由直接导入 Python，独立的 `/progress` SSE 没有接通；控制服务和 worker 各自启用 `PrivateTmp`，固定 `/tmp` 文件无法共享。写入仅覆盖 CI 下载器，而网页升级默认走源码安装。新增浏览器文件未接入执行入口，模拟的状态 URL 也与产品不符，因而构建和孤立测试没有发现链路断点。

**以后做法：** 由当前任务的私有目录保存可选进度，经现有状态白名单与 SSE 输出，沿用会话校验、限额、重连和轮询。按实际安装分支上报阶段；只有可测量的阶段显示百分比。样本需有界读取并校验任务时间、字段和文件边界，损坏、过期或深层 JSON 只能隐藏详情，不影响权威任务结果与维护门。文件写入校验可信父目录，独占创建随机临时文件，禁止使用固定共享临时路径。

**如何验证：** [进度读取](deploy/test-progress.py)、[协调器](deploy/test-updater.py) 覆盖坏数据、任务隔离与重启；[HTTP](tests/updates-http.test.mjs)、[状态流](tests/update-stream.test.mjs) 验证真实路由和公共过滤；[浏览器脚本](tests/update-progress.browser.mjs) 从实际前端入口验证断线恢复、终态与会话清理。Linux CI 使用 [写入边界](deploy/test-release-progress.py)、[源码增量安装](deploy/test-incremental.sh) 与 [systemd](deploy/test-update-systemd.sh) 检查真实平台权限、升级和隔离，不用模拟文件解析代替完整链路。

**证据：** project-aggregation `3be993fea8985d3e21c2fa3b5090f9d5b7dae288` 的 `server/app.mjs`、`server/update-service/progress.py`、`deploy/release-common.sh` 与 `tests/update-progress.browser.mjs`；2026-10-15 在 `74fc675` 工作区审查核实。另用当前任务夹具复现 3001 字节嵌套 JSON 令 `status()` 抛 `RecursionError`，本轮补齐容错与回归。旧版首次升级没有新进度详情不等于不能升级，应保留旧状态通道兼容。

**历史耗时补充：** 实时样本的过期规则不适用于已完成任务的历史计时。历史记录使用受保护任务目录中的固定任务身份绑定，阶段时长由单调时钟计算并核对开机身份；不能用 `createdAt` 相对任务开始或当前墙上时间的位置决定是否显示。系统校时可能回拨，未闭合区间也不能用恢复时间补算。

**补充证据与验证：** 2026-10-16 基于本仓 `06042777` 增加阶段耗时的提交前审查，发现历史读取沿用 `createdAt >= startedAt` 和 `createdAt <= now + 1s`：校时发生在首次记录之后会暂时隐藏有效记录，发生在任务接受和首次记录之间则会持续隐藏。修正为固定任务身份校验，保留实时进度原有新鲜度规则；[进度读取测试](deploy/test-progress.py) 覆盖回拨、错任务记录与未闭合区间，[写入测试](deploy/test-release-progress.py) 覆盖单调计时及跨开机未知值。该问题在本轮首次提交前修正，不是基线已发布的历史计时缺陷。

**事件记录：** `update-progress-runtime-channel-20261015`、`update-timings-wall-clock-20261016`；分别为进度链路和新增历史计时的独立问题，各自连续修复不重复计数。

### L037：异步连接清理先释放同步资源，再等待子任务结束

**适用条件：** WebSocket 处理器注册连接名额，并在 `finally` 中取消、等待收发子任务后注销订阅。

**根因：** `finally` 中的 `await asyncio.gather(...)` 仍可被取消；如果同步的 `unsubscribe` 在其后，处理器和子任务都已结束，订阅却仍占用连接名额。仅延长测试等待不能修复资源泄漏。

**以后做法：** 取消子任务后，先同步注销订阅、清空队列并释放名额，再等待子任务收尾；保留取消传播，不用吞掉取消异常或放宽连接上限解决问题。

**如何验证：** [中继取消回归](modules/aster/tests/test_capacity_relay_server.py) 用事件控制第二次取消发生在收尾等待期间，确认任务已结束时连接数归零且新订阅可用；运行相关中继 API 测试，并由现有 Ubuntu 26.04 CI 验证实际 systemd、TLS 与更新恢复。

**证据：** 本仓 `b9692d2` 的 [CI 中继检查](https://github.com/hxx344/project-aggregation/actions/runs/38622433981/job/116053055716) 在退出 WebSocket 上下文后观察到连接数仍为 1；该路径自 `0cde1afd` 引入。[中继处理器](modules/aster/trading/capacity_relay_server.py) 的确定性 Windows 回归进一步复现处理器已取消、接收任务已结束但名额未释放，排除了单纯断言过早。

**同轮补充：** `c826f18` 的 [Ubuntu 26.04 CI](https://github.com/hxx344/project-aggregation/actions/runs/38635180672/job/116096379982) 在连接上限测试退出时抛出 `CancelledError`。事件控制的 Windows 回归确认：接收任务正常结束、发送任务停在收尾时，取消父处理器会让 `gather` 用最后一个子任务的空取消信息替代父信息，导致 AnyIO 无法识别自己的取消范围。先释放名额后用 `shield` 隔离等待，遇到父取消时再次取消子任务并原样抛出，保留父取消身份；不吞取消，也不留后台子任务。新增回归断言取消信息、子任务结束和名额归零，并保留原双重取消用例；Ubuntu 26.04 的真实 systemd/TLS 检查仍须通过。

**事件记录：** `relay-cancelled-cleanup-slot-leak-20261015`；发布检查暴露的一次连接清理缺陷。

**API 关闭与忙锁补充（2026-10-27）：** 审查 `6ab243e` 的 [API 排空](server/api/server.mjs) 复现更新流等待串行维护同步时越过声明的关闭预算；先同步停止流和定时器，再将 pending 与协调器纳入共同预算，关闭后取消排队任务，迟到返回不再写已关闭的库。不能只在连接上设期限却遗漏其等待的任务。[API 回归](tests/api-server.test.mjs) 用有限耗时的真实 HTTP/SSE 队列验证关闭上限；[更新回归](tests/embedded-updates.test.mjs) 验证等待中的写入和准入不在关闭后继续。事件 `api-drain-status-queue-20261027`。

同轮 [Portal](server/portal.mjs) 首次撤销与关闭时的重试仍等待 SQLite 的 5 s busy_timeout；[Portal 回归](tests/portal.test.mjs) 将计时起点移到登出请求前，确认首次撤销、后台重试与关闭都不阻塞事件循环，锁释放后仍完成跨实例撤销。事件 `portal-initial-revocation-busy-20261027`。两项均限于本次已核实的失败路径，不据此扩大其他模块的关闭约定。

### L038：内部十进制计算结果不重新套用输入长度限制

**适用条件：** 前端使用高精度 Decimal 计算价差、保证金或持仓调整量，并在渲染时再次解析计算结果。

**根因：** 外部输入限制为 160 字符，但 200 位精度的除法可产生更长的循环小数。加仓弹窗把内部价差结果当外部输入重解析，得到 `null` 后仍调用 `.gt()`，导致整个 CrossEx 界面卸载；保证金汇总也会因此漏掉不足提示。原浏览器价格组合恰好得到较短结果，未覆盖此边界。

**以后做法：** 内部运算和比较保留 Decimal 实例，仅在展示时转字符串；已经验证的计划自产差额不再经过外部输入长度校验。外部输入限制继续保留，不能只用可选链隐藏错误而丢失有效警告。

**如何验证：** [持仓操作测试](modules/crossex/tests/position-actions-ui.test.mjs) 覆盖循环价差、30% 边界、零价差和长差额；[工作台浏览器回归](tests/crossex-position-actions.browser.mjs) 使用开仓价 100/103、标记价 100/104，确认点击加仓正常展示 33.3333% 偏离提示，并用 7 倍杠杆、可用保证金 30 覆盖循环保证金汇总和预留不足提示。

**证据：** project-aggregation `6ba3eec` 引入的 [加仓弹窗](modules/crossex/src/PositionActionDialog.tsx) 与 [计算辅助](modules/crossex/src/position-actions.ts)，2026-10-15 用户报告点击加仓后黑屏。基于 `96debc6` 的原生 Windows 浏览器回归在修复前构建 `index-rW2drLUC.js` 上复现 `Cannot read properties of null (reading 'gt')`；直接计算 `0.03 → 0.04` 产生 202 字符的 `1/3`。

**事件记录：** `crossex-derived-decimal-dialog-crash-20261015`；一次用户反馈及同根因修复，不推进主线复盘检查点。

### L039：未知请求的恢复必须能转入当前状态核验

**适用条件：** 交易订单、升杠杆或划转已持久化，但原请求一直没有可用回执，或合法终态回执与当前实际持仓持续不符；也适用于人工归档后的历史观察。

**根因：** 原路径超时只改成 `attention` 或暂停，仍保留未完成请求并无限查询；部分恢复还要求实际杠杆必须等于目标、两侧旧流水编号必须相同。把未知单移入每次交易前都查询的历史观察，同样会永久挡住后续操作。

**以后做法：** 持久记录实际查询次数和最近可能发送的时间。回执未知的旧订单及待匹配历史流水最多查询三次，经过 120 秒观察窗口后转为新鲜的完整账户核验。本组市价单恢复按原客户端编号核对，不反复查询两侧全账户挂单；已有活动回执则保留其证据并低频追踪原编号直到终态，不能因次数上限直接采纳现实。预算等待不计次数，补偿请求重新计算等待窗口。仓位、身份、模式、杠杆和风险满足策略约束时，在同一事务归档旧请求并采纳现实基线；保留原始委托与未知成交，不重发旧请求，也不伪造零成交或成功回执。失衡仓位、已知活动原单及读取失败继续阻止恢复，并给出当前原因。绑定、启动、解绑及维护的全账户挂单要求继续按各自入口执行。

历史观察有限补证后由当前风险检查决定是否继续，不能把归档索引上限或已空仓后的解绑变成新的永久阻塞。解绑仍须在观察完成后读取完整空仓证据，并原子归档历史观察及解除账户归属。升档请求结束后按标的、目标、身份与配置设置冷却，冷却期间继续评估当前档位。自动暂停必须记录来源；无论正常回执完成还是按现实归档，仅解除同一请求造成、且未被用户操作或其他风险暂停覆盖的暂停。用户控制与清除恢复来源必须原子提交。成交结果仍未知时保留相应统计语义，不将估计金额写成真实成交。

**如何验证：** [单账户有界恢复](modules/aster/tests/test_bounded_recovery.py)、[配对有界恢复](modules/aster/tests/test_pair_bounded_recovery.py)覆盖查询上限、观察窗口、重启、补偿、完整现实证据与事务竞态；[调度衔接](modules/aster/tests/test_recovery_engine.py)验证冷却后仍按当前档位交易及用户暂停优先；[历史划转出口](modules/aster/tests/test_pair_margin_bounded_recovery.py)覆盖流水一直不匹配、网络失败、预算等待、新余额失败与恢复，不发送第二次划转。相关恢复与成交账本测试按影响范围复用。

**证据：** 本仓 `8bce5ca` 的 [普通执行](modules/aster/trading/execution.py)、循环执行 `cycle_execution.py`、迁移执行 `migration_execution.py`（两者已随循环与仓位迁移功能移除，源码见该提交）在未知单超过 120 秒后仍保留 pending；[配对执行](modules/aster/trading/pair_execution.py)在原单查询失败时到不了仓位采纳；[保证金平衡](modules/aster/trading/margin_balance.py)的旧 `accepted` 状态无历史查询出口。2026-10-15 用户明确要求清理同类永久核对，本次根据源码和离线回归修复；120 秒是转入现实核验的等待窗口，不是订单未成交的证明。

**事件记录：** `bounded-unknown-execution-recovery-20261015`；本次跨执行器的同类根因修复，不按文件或路径重复计数。

**2026-10-17 补充证据：** 基线 `d135996` 的配对恢复虽然限制原单查询次数，观察期仍每约 3 秒读取两侧交易快照，现实核验失败后又按待处理调度反复读取。`_read_members` 强制刷新账户模式并另查两侧全账户挂单，冷读预估 `2 × (72 + 40) = 224` 权重，与用户截图中的准入需求相符。市价恢复移除全账户挂单查询与显示专用重复快照，失败期限持久化，自动、手动及重启共同遵守；最终持仓、模式与身份新鲜度不变。发送前 `_config_guard` 的失败也须归为结构化“未发送”，而实际 POST 的未知结果仍保留。固定差异 `4229052` 的离线时序复现另发现：活动回执若在原编号检查后、快照捕获新代次前到达，仅靠快照代次仍可提前结束批次；恢复须在快照后再次补读本地回执，并在原身份、快照锁和事务 CAS 保护下持久化，不能等缓存过期后丢失已知活动状态。对应 [恢复预算检查](modules/aster/tests/test_pair_recovery_budget.py)、[未知单观察检查](modules/aster/tests/test_pair_unknown_observation.py)、[晚到回执检查](modules/aster/tests/test_pair_late_receipt_recovery.py) 及发送证据检查；本地离线结果不表示已验证服务器现场。事件 `pair-recovery-weight-starvation-20261017`。

**2026-10-28 补充：** `-2013`（查无订单）只有在原始错误码是确定性错误时才能证明未提交；`-1000`/`-1001`/`-1006`/`-1007` 与 408/5xx 等不确定提交即使查不到订单，也仍按有界恢复流程处理，见 L062 批量逐条判定。

**Hub 原生执行补充（2026-10-28）：** 基线 `80beef4` 的工作台原生执行在 Binance/OKX 建单结果未知且按客户订单号查不到时没有出口：`attention` 任务不再被 tick 处理，共享写入保护中的 unknown 建单永久挡住同账户后续写入；撤单回执未知或已确认但订单仍活跃时也永不重发。停在未知的建单都是超时、5xx 或未登记码等不确定结果，查无客户订单号不能按 L062 当作未提交证明，只能走本条的有界恢复：建单超过 120 秒观察窗口（不短于调用期限 + 60 秒，覆盖 Binance recvWindow 5 秒与 OKX 30 秒时间戳）后，间隔两次查不到，且新读该合约无其他挂单或运行中策略、仓位等于预览基线加本阶段已知成交，才按现实判为未送达并把共享操作结算为 rejected；不一致继续保留待核对，并按 60 秒低频重读。`attention` 任务每 15 秒自动核对一次，同一错误只记一次事件；撤单（含被明确拒绝的）共用 5 次上限、间隔 10 秒重发，崩溃后停在 sending 的撤单重启后也会重发。Bybit 追逐策略没有客户编号，只能在同样的窗口后、该合约无运行中策略、下单前后（含 300 秒交易所时钟容差）无未认领的同合约策略且仓位一致时由人工确认未创建。[Hub 执行测试](tests/trading-execution.test.mjs) 覆盖窗口内不判定、仓位或挂单不符保留与低频重读、写入保护释放后可续做、撤单上限（含拒绝）、崩溃后重发撤单与 Bybit 人工确认的时钟容差和运行中策略。此为审查发现的同类恢复缺口，不新增事件。

**ADL 路径补充：** 同日核查基线 `7642f4e` 时，[ADL 控制器](modules/aster/trading/adl.py) 的两侧现场每轮消耗 `2 × (5 + 5 + 30 + 40) = 160` 权重；本地注入连续三次明确未发送的预算拒绝，第四轮被误判为“连续三批未成交”并永久停止。现场读取的 120 秒预算等待也被统一改成 10 秒。市价订单路径按持久记录确认类型后省去全账户挂单、整组准入降至 80 权重；缺少类型或非市价记录仍保留完整核验。明确未发送保留审计但不占实际批次与未成交上限，现场及完成后观察共同遵守持久重试期限。等待期间只补读本地流回执，已知活动原单持续按原编号低频追踪至终态；完成后观察及新 ADL 事件也必须继承这些原单，不能因缓存过期、旧归档标记或新事件丢失。旧升杠杆记录兼容现有字段，并按最近可能发送时间保留观察窗口。[ADL 预算检查](modules/aster/tests/test_adl_budget.py)、[恢复检查](modules/aster/tests/test_adl_recovery.py) 和 [存活性与晚到回执检查](modules/aster/tests/test_adl_liveness.py) 覆盖这些离线故障场景及重启、身份、事务竞争；保证金待核对日志不阻止 ADL 接管，也不被清空。此为上述恢复问题的 ADL 路径补齐，不另计复发日期。

### L040：显示调度周期不能延长配对快照有效期

**适用条件：** ASTER 配对页根据账户刷新间隔调整过期提示、保证金等待或删除拦截，且当前提示与历史记录分别计算。

**根因：** 单账户 `snapshot_refresh.interval_seconds` 仅描述显示调度，不属于配对运行状态或源快照。配对任务的 `poll_interval` 同样不保证每轮刷新快照；暂停且无循环持仓时可以直接返回。把两侧账户间隔最大值加容差作为有效期，既会掩盖停止更新的配对状态，也会让旧非零仓位继续阻止服务端重新核验删除；只改当前提示还会让固定 8 秒的历史记录制造假恢复和重复告警。

**以后做法：** 配对快照和运行状态保持现有 8 秒判断；保证金定时等待沿用有明确检查期限、运行状态新鲜且无待确认操作的显示分支。短暂过期或断线只延迟提示：使用单调时钟确认异常连续持续 3 秒，再显示并写入历史，恢复立即重置；两侧、运行状态与花费按各自信号计时，切换配对组不重启计时。真实执行/API 错误立即显示，即使历史时间暂时无效也不能隐藏。当前数据提示与历史记录共用确认结果。显示调度不能延长操作拦截依据，也不代替服务端在锁内重新读取与验证。

**如何验证：** [配对测试](modules/aster/dashboard/tests/pairs.test.mjs) 在 8 秒边界确认旧非零仓位交由服务端重新核验；[提示测试](modules/aster/dashboard/tests/pair-notices.test.mjs) 覆盖停止更新的运行状态不能继续显示计划等待，以及当前提示与历史一致。[延迟观测测试](modules/aster/dashboard/tests/pair-notice-observation.test.mjs) 检查 3 秒边界、恢复后重新计时、时钟变化和真实错误即时显示；[浏览器验收](tests/aster-stale-notices.browser.mjs) 从实际工作台入口检查短暂异常不闪现、不留历史，持续异常显示及分组切换。回放原补丁中的 30/60 秒显示间隔和非有限值，确认其不能放宽配对有效期。

**证据：** project-aggregation 基于 `f2f1c36` 的 2026-10-15 未提交补丁修改了配对页四个文件，阈值改为账户间隔加 3 秒并限制到 70 秒。审查新增的三个定向回归在该补丁上全部失败；撤销错误间隔透传后复核。依据为 [账户状态输出](modules/aster/trading/engine.py)、[配对调度](modules/aster/trading/pairing.py)、[配对执行](modules/aster/trading/pair_execution.py) 与 [提示历史](modules/aster/dashboard/lib/pair-notices.ts)。该补丁未发布；启动按钮本来不使用此有效期，不能将本事件描述成绕过交易授权。

**补充证据：** 2026-10-15 用户要求不显示短暂过期，只显示持续 2–3 秒的异常；基线 `235950b` 的提示、两侧余额/仓位、成交质量和花费区域直接显示原始过期判断。当前修正采用上述 3 秒显示确认，仍保留快照原始时间与严格有效期，未增加 API 读取。

**事件记录：** `pair-display-cadence-freshness-20261015`；一次未提交补丁审查与连续修正，不推进主线复盘检查点。

### L041：账户保证金平衡独立于持仓交易策略

**适用条件：** ASTER 两个子账户之间按 USD1 可用余额自动平衡，包括仅保证金管理模式、其他标的或方向的手动持仓，以及策略订单仍在核对的情况。

**根因：** 划转复用了交易快照、持仓匹配、普通开仓占用上限和历史订单核查。即使交易所允许转出，标的不同、行情缺失或无关历史查询失败仍会阻止补充保证金；创建与启动入口也强制策略仓位核验。

**以后做法：** 划转单独读取账户 USD1 余额和交易所可划额度，不要求持仓标的、方向、模式或开仓状态匹配。金额按余额差的一半、实际可划额度、单次限额和现金保留确定。仅保证金启动保留原策略记录，不采纳或清空持仓；实际订单恢复继续按原路径处理（循环减仓已随循环功能移除，旧循环批次改为待人工核对，不阻止保证金平衡）。暂停、实盘授权、账户归属、发送前身份与快照代次检查、先持久化后发送和未知结果不重发仍保留。资金快照不提供持仓及杠杆授权，界面单独展示余额及原始读取时间。旧指纹与旧划转日志保持恢复兼容。

**如何验证：** [专用资金快照](modules/aster/tests/test_transfer_account_snapshot.py) 验证只查询账户接口，缺失资金字段、过期与事件失效仍被拒绝；[独立入口](modules/aster/tests/test_pair_margin_independent.py) 验证其他标的持仓可启动平衡、保留策略记录、普通交易仍核验本组底仓与实际杠杆，以及配置身份竞态；[划转测试](modules/aster/tests/test_pair_margin.py) 验证真实额度、现金保留、旧日志和防重发。恢复、预算及 WebSocket 测试按受影响路径选取，前端配对与提示测试验证余额状态不伪装为已确认空仓。

**证据：** project-aggregation `63d621d` 的 [划转实现](modules/aster/trading/margin_balance.py) 在 `_check_snapshots` 限制指定标的和方向，`_plan` 使用 `ordinary.margin_limit`；[配对入口](modules/aster/trading/pairing.py) 及 [执行调度](modules/aster/trading/pair_execution.py) 先要求策略仓位和行情。2026-10-15 用户明确要求保证金平衡独立于持仓标的，本轮定向回归覆盖上述误阻断。

**汇总显示补充：** 2026-10-15 用户确认仅启用保证金平衡时仍报告账户与项目数据过期。基线 `a45e687` 的配对成员已跳过独立账户读取，资金任务只更新 `margin_balances`，但 [工作台摘要](modules/aster/trading/hub_summary.py) 仍按历史完整仓位快照判断时效。仅资金模式且无策略待处理批次、无循环持仓时，摘要改用两侧资金快照的真实读取时间；不采集的持仓占用返回未知并说明原因，不伪造零值，也不更新旧仓位时间。最新资金读取失败仍以持久划转日志为依据报告，正常发送与已确认后的余额刷新阶段不直接等同故障。[摘要测试](modules/aster/tests/test_hub_summary.py) 覆盖上述场景、真实余额过期及混合账户汇总，并确认不增加交易所请求。此为本事件的显示路径补全，不增加独立事件计数。

**完整持仓显示补充：** 2026-10-15 用户提供交易所七条仓位、工作台仍显示旧三条的截图，基线 `05ea772` 仅资金检查没有更新持仓展示。复用同一次账户 GET 的完整 `positions`，经 [独立展示解析](modules/aster/trading/display_positions.py) 发布到 `display_positions`，不写入资金快照的交易持仓字段；未知标的、单向和逐仓也可展示。缺少行情或杠杆字段显示未知，关键清单字段损坏时保留上次成功清单及原时间，不能伪装为空仓或使划转失败。每次新清单整份替换，不把旧价格拼到新数量上；暂停和冷却期间保留读取时间并说明更新条件。专用资金快照、独立入口及前端持仓测试覆盖清单更新与交易依据隔离，此为同一事件的后续显示路径补全。

**顶部账户摘要补充：** 基线 `6026760` 在非配对页仍从历史交易快照绘制权益、可用余额、占用率及“更新延迟”，即使当前仅运行保证金平衡。顶部摘要按实际账户成员选择该侧 `margin_balances`，缺资金字段不回填旧交易值，占用率明确未采集，启停状态按配对组显示；原交易快照和操作权限保持不变。定时、冷却和暂停只能说明最近记录，不能修改源时间或掩盖真实错误。保证金只读状态单独投影持久失败原因，避免 HTTP 500 被 `waiting/blocks_trading=false` 误认为正常等待。[顶部摘要测试](modules/aster/dashboard/tests/account-summary.test.mjs) 覆盖新余额与三小时前旧快照、账户切换、失败恢复及真实过期；[状态投影测试](modules/aster/tests/test_pair_margin_status.py) 确认错误可见且不改变划转状态与权限。此为同一事件的页面入口补漏，不新增事件计数。

**飞书摘要补充：** 基线 `947346e` 的 [飞书摘要](modules/aster/trading/hourly_summary.py) 仍只读取交易快照，导致仅保证金监控时通知持续显示数小时前的余额和浮盈亏。通知按严格资金模式选择两侧 `margin_balances`，合计与分账户卡片共用来源；复用已读取的 `unrealized` 字段，不额外请求交易所。持仓仅从独立 `display_positions` 展示，并保留自己的采样时间及失败信息；未采集的占用率不借旧值补齐。缺余额、缺浮盈亏、过期、定时等待、暂停与真实异常分别表达，不能借通知生成时间刷新源时间。[飞书汇总测试](modules/aster/tests/test_hourly_summary.py) 与 [通知链路测试](modules/aster/tests/test_hourly_notification_engine.py) 已在旧实现复现陈旧值，并覆盖 compact 状态到持久 outbox、模拟发送的完整路径和零额外交易所请求。此为同一事件的通知入口补漏，不新增事件计数。

**飞书占用率补充：** 2026-10-15 用户反馈保证金监控卡片一直显示“未采集”。基线 `fd3c283` 的 [资金读取](modules/aster/trading/exchange.py) 未透传 USD1 资产行的 `positionInitialMargin`，[余额发布](modules/aster/trading/pair_execution.py) 只有资金字段，飞书还按资金模式硬编码未知。现复用同一次账户读取，独立发布展示占用额，按同次 USD1 权益计算百分比；不使用包含挂单的 `initialMargin`、USDT 顶层总额、维持保证金或“权益减可用余额”替代。缺失、负数或非有限数只让该指标待同步，不阻断合法资金读取，不回填旧占用；真实零值可以显示 0%。资金快照的交易持仓、风控属性与授权保持不变。专用资金快照、配对发布、飞书汇总及通知链路测试覆盖同次读取、币种隔离、零值与异常值，以及 compact 状态和 outbox 的完整传递；通知不新增交易所请求。此为同一事件的显示能力补全，不新增独立事件计数。

**配对失衡通知补充：** 2026-10-16 检查本仓 `831aeec` 时确认，[仓位观察](modules/aster/trading/position_observations.py) 只读取配对交易快照及配置标的，遗漏仅保证金模式持续更新的完整持仓。通知按每侧原始时间选择最新完整证据，新的清单读取失败阻止回退旧成功；完整非零持仓清单的缺项可视为零，缺失或损坏清单不能。交易快照对配置标的仍要求显式双侧，其余标的补零以 broker 保留全部非零仓位的契约为依据。将币种加入通知身份，同时迁移旧已发送事件以避免升级重复；保留已观察标的，全部平仓后仍能确认恢复。[配对告警回归](modules/aster/tests/test_position_imbalance_engine.py) 覆盖仅保证金、非配置标的、失败与恢复及零额外交易所请求，[通知状态回归](modules/aster/tests/test_position_imbalance_notifications.py) 覆盖独立 1% / 10 秒规则与旧事件迁移。通知证据不提供交易授权，此为同一来源分离问题的通知入口补全，不新增独立事件计数。

同轮复核用 120 秒保证金检查周期复现：每次两侧均有新鲜失衡仓位，但固定 70 秒观察间隔上限会让候选计数永久停在 1。仅保证金模式的连续观察间隔改为按真实检查周期留出有界容差；该间隔不延长每个样本的 8 秒有效期，超出间隔的中断仍重新确认。

**T0 优先补充（2026-10-19）：** 用户在 M1/M2 后再次确认保证金是 T0 基础功能。`5c51e81` 现场只读证据为六条旧双腿订单 UNKNOWN，资金日志无 pending、恢复门 normal；共享准入仍将账户所有 UNKNOWN 一概阻断，且调度仍先检查 ADL、策略身份。资金检查须在这些策略工作之前运行，历史订单核对走旁路；仅凭严格原始请求分类放行非资金 UNKNOWN，不篡改其原状态或猜测终态。优先许可绑定固定 USD1 FUTURE_FUTURE 端点、完整参数与三方已验证身份，最终 HTTP 再核对；资金自己的 UNKNOWN、身份/fence、真实额度与恢复隔离仍保留。资金专用预算不能被策略及历史查询用尽，总限额和冷却不能绕过。[T0 集成回归](modules/aster/tests/test_margin_t0.py) 覆盖六旧单原样保留、无订单查询仍完成新划转、策略/ADL 独立、许可借用与最终请求篡改拒绝，以及预算隔离。此为同一保证金与策略耦合问题在共享准入和调度上的后续补漏，不新增独立事件。

**ADL 自动暂停补充（2026-10-30）：** 基线 `5c3fadd` 虽已先检查资金，真实 ADL `_begin` 仍将 `pair.enabled` 置为 false，资金准入因而停止；旧 T0 测试只替换 `adl.tick` 返回 hold，没有触发实际暂停，不能证明应急期间资金持续运行。用户明确手动暂停仍停止划转，只有 ADL 自动暂停继续资金。资金运行意图应独立持久保存，自动暂停同事务继承，手动暂停独立撤销，最终发送前重验；不能依据暂停文案、hold 或旧策略快照猜测授权。旧事件缺少原意图时提供明确的仅资金启动入口。验证须走真实 ADL 控制器、重启及最终划转传输链路，覆盖受阻/完成观察、手动暂停、旧记录恢复、配置或身份竞态与资金未知结果不重发，见[专项回归](modules/aster/tests/test_adl_margin_priority.py)及[范围与回滚](docs/aster-adl-margin-priority.md)。这是同一耦合问题的暂停状态补漏，不增加独立事件计数。

**事件记录：** `aster-transfer-strategy-coupling-20261015`；一次用户纠正及完整调用链修复，不推进主线复盘检查点。

**2026-10-17 补充证据：** 基线 `d135996` 的 `PairManager.configure` 和 ADL 设置锁将任意未决订单／循环持仓视为全表单锁，连只关闭开仓策略也无法保存。新增暂停状态专用的“切换为仅保证金管理”操作，只改三个启用开关，完整保留订单、循环、历史观察和划转日志；普通设置锁与后续启动身份核验继续有效。[模式切换检查](modules/aster/tests/test_pair_margin_only_switch.py) 验证未知批次、未决划转、原循环减仓、ADL、鉴权及不可夹带参数，[工作台交互](tests/aster-margin-only.browser.mjs) 验证锁定、失败重试和保存后保持暂停。此为保证金独立入口的后续补漏，不增加独立事件计数。

### L042：旧配置的同值写入不能覆盖新模型的细分选择

**适用条件：** 配置从总开关迁移到逐项选择，且新旧客户端在过渡期共用写接口。

**根因：** 先把旧开关转换为完整的新配置，再比较最终值，会把旧客户端的重复保存变成实质修改。新模型能够表达的细分选择多于旧开关，转换不是可逆操作。

**以后做法：** 在执行兼容映射前按旧字段的现有值过滤同值写入，同一请求里的真实变更仍照常处理。新模型作为运行时依据，旧字段只承担明确的兼容操作；保留事务内通知取消、版本号和状态重置的幂等语义。

**如何验证：** [监控迁移回归](modules/aster/tests/test_monitoring_migration.py) 交错使用新旧客户端：只选上新后重复保存旧告警开启，不能新增其他类型；旧全局额度开关关闭、新模型显式开启本币额度后，重复保存旧订阅开启，不能反向清空通知。另覆盖同值全局字段、顺序不同的同一类型集合，以及混合请求中真实变更仍生效。

**证据：** project-aggregation 基于 `91bc47e` 的 2026-10-15 监控简化工作区，首版 [兼容映射](modules/aster/trading/monitoring.py) 在上述两类请求中分别扩大及关闭通知范围；只读审查用纯内存复现，首次提交前在 [事务写入](modules/aster/trading/store.py) 修复并补回归。该缺陷属于本轮新实现，基线不含 v2 模型。

**事件记录：** `aster-monitoring-legacy-idempotence-20261015`；一次首次提交前审查发现，不推进主线复盘检查点。

### L043：混合行情来源按标的同步路由、预算与调度

**适用条件：** 同一工作台中，部分币种从副服务器读取公开额度与杠杆档位，其他币种由主服务器直接请求交易所。

**根因：** 全局“已配置中继”被同时用作所有币种的来源、免费请求和快采依据。中继只提供金银时，其他币种会一直读取失败；若只改请求路由，主服务器实际承担的请求仍会被按零成本、高频调度。

**以后做法：** 用统一的按币种来源判断覆盖请求、预算与失败退避。只有金银可以使用中继，其他币种沿用主服务器低频读取。预算仅计入本机采样；本机额度不足不停止中继消费。忽略旧中继配置推送的其他币种，保留原采样时间、有效期和失败语义，不能通过放宽有效期掩盖降低频率。

**如何验证：** [路由集成测试](modules/aster/tests/test_capacity_relay_integration.py) 验证金银与其他币种的真实请求目的地、权重和故障隔离；[混合调度测试](modules/aster/tests/test_capacity_source_scheduling.py) 验证低频、低/零预算、私有调度成本与限流退避；[中继客户端测试](modules/aster/tests/test_capacity_relay_client.py) 验证其他币种不能更新金银缓存、样本健康或触发调度。

**证据：** project-aggregation `f01d20d` 的 [公开采样](modules/aster/trading/exchange.py) 及 [调度](modules/aster/trading/engine.py) 按中继是否存在统一分流和清零预算。2026-10-15 用户明确要求仅金银走副服务器，其他币种走主服务器；本轮修正统一覆盖实际读取与混合预算，并补充上述定向回归。

**事件记录：** `aster-capacity-per-symbol-source-20261015`；一次用户纠正及相关调用链修正，不推进主线复盘检查点。

### L044：持久金额条件的前后端输入语法保持一致

**适用条件：** 前端编辑、后端持久化同一十进制金额字符串，且保存后需要再次打开或与其他设置一起提交。

**根因：** Python `Decimal` 接受下划线、Unicode 数字和负零等写法，前端金额编辑器只接受普通 ASCII 十进制；仅核对数值是否有效，会留下能写入却无法重新编辑保存的配置。

**以后做法：** 明确并统一输入语法、长度和指数边界，后端 API 与存储入口共用校验；金额仍保留十进制字符串，不能转成浮点数统一格式。数值等价的重复保存保留原通知状态，不因金额写法改变而重新触发。

**如何验证：** [额度通知测试](modules/aster/tests/test_listing_alerts.py) 与 [前端条件测试](modules/aster/dashboard/tests/monitoring-notifications.test.mjs) 覆盖普通小数、科学计数、精度边界及下划线、Unicode 数字、负零拒绝；[配置迁移测试](modules/aster/tests/test_monitoring_migration.py) 验证等值写法不改变版本或待发通知。

**证据：** project-aggregation 基于 `b1426b4` 的 2026-10-15 单币额度条件开发中，只读联检确认首版 [后端校验](modules/aster/trading/monitoring.py) 直接使用 `monitor.number`，与 [前端条件解析](modules/aster/dashboard/lib/monitoring-notifications.ts) 语法不同。该首版未提交；已统一校验并增加 API、Store 和前端回归。

**事件记录：** `aster-capacity-condition-input-grammar-20261015`；一次首次提交前审查发现，不推进主线复盘检查点。

**2026-10-28 补充：** 策略更新与配对 API 入口也通过 [`models.decimal_text`](modules/aster/trading/models.py) 强制同一小数语法（仅字符串、长度 ≤128、指数绝对值 ≤100），与看板解析一致。

**定点参数补充（2026-11-05）：** `btc-hedge-threshold-precision-20261105`，基于 `f8f009f` 的对冲阈值增量审查发现：只检查有限数与上下界仍会接受 `1e-100`，而内部 `units()` 的指数边界会在首次非零敞口时抛错。新增定点参数须同时验证可表达性；本次阈值允许 0，正值至少 `1e-18`，前后端一致拒绝会截断为零或转换抛错的输入。核心配置、真实 HTTP 400 与浏览器提交前拒绝均有回归；独立 probe 确认最小正值仍能调度。仅适用于该定点参数，不把其精度推广为所有金额字段的通用限制。

### L045：全历史收益必须核对服务端读取窗口

**适用条件：** 基于最早和最新快照计算总体收益或年化，且数据读取可能带分页、数量上限或混合归档。

**根因：** 前端接收的完整数组不等于完整历史。日快照和归档分别限制条数后再合并截断，会丢失最早有效日；较新的归档还会挤掉参与收益计算的快照。

**以后做法：** 从指标反查数据库读取口径，全历史指标保留全部有效日快照，归档展示窗口独立限制。继续省略快照资产明细等大字段，保持账户隔离及旧数据兼容；不能仅扩大常数后声称覆盖全部历史。

**如何验证：** [历史读取测试](modules/asset/tests/snapshot-history.test.ts) 用真实 SQLite 的 800 个日快照和 760 个归档核对最早有效日仍在、归档不挤占有效数据，并检查账户隔离、出金回填和资产明细未返回；[收益测试](modules/asset/tests/performance-metrics.test.ts) 核对首末快照和实际年化跨度。

**证据：** project-aggregation 基线 `05ea772` 的 [store](modules/asset/lib/store.ts) 对日快照与归档分别 `LIMIT 730`，合并后再次 `slice(0,730)`；2026-10-15 月度表现开发中核实该路径不能支持规格的“全部历史总体年化”。读取迁至 [snapshot-history](modules/asset/lib/snapshot-history.ts)，取消有效日及合并截断，归档仍独立限制 730 条。

**事件记录：** `asset-full-history-performance-window-20261015`；一次开发前核实的数据口径问题，不推进主线复盘检查点。

### L046：独立采样的行情对象不保证已包含额度快照

**适用条件：** 额度、盘口与深度分别更新同一行情对象，且相关 React 面板在其他标签页下仍保持挂载。

**根因：** 首次额度采样失败只写入状态和错误；盘口或深度先完成也会建立没有 `capacities` 的行情对象。前端类型将额度字段声明为必填，渲染使用 `market?.capacities[tier]` 只保护了外层对象，读取第一档 `5` 时抛错。隐藏的普通开仓面板随状态更新仍会渲染，导致用户正在操作的监控页和整个 ASTER 工作区一起崩溃。

**以后做法：** 类型按独立数据源的实际到达契约声明可选字段；读取额度时同时检查行情对象、额度映射与单档值。未采样或失败显示未知，不填零、不高亮达标，恢复后沿用原采样时间边界。排查跨标签页崩溃时检查仍挂载的组件，并读取实际浏览器异常栈。

**如何验证：** [监控中心浏览器回归](tests/aster-monitor-center.browser.mjs) 从真实工作台入口加载有账户的页面，覆盖首采失败、仅盘口、仅深度、额度恢复与失败后保留旧值，确认监控切换和通知编辑仍可用、未知额度不达标；[普通开仓条件测试](modules/aster/dashboard/tests/ordinary-conditions.test.mjs) 保持缺失、失败和过期数据的判断。纯空账户夹具不能覆盖隐藏的账户面板。

**证据：** project-aggregation `9f956497` 的 [MarketPanel](modules/aster/dashboard/components/market-panel.tsx) 两处直接索引可缺失的 `capacities`；[行情采样](modules/aster/trading/engine.py) 的 `poll_market`、`poll_book`、`poll_depth` 会合法生成上述部分对象。2026-10-15 用户反馈勾选监控后整页报错，实际工作台浏览器捕获 `Cannot read properties of undefined (reading '5')`，堆栈定位到同版本 `page-ItLLfWRP.js:2:1633` 的额度单元格渲染。

**事件记录：** `aster-partial-market-hidden-panel-crash-20261015`；一次用户反馈和实际浏览器定位，不推进主线复盘检查点。

### L047：首屏概览与完整历史使用独立的数据契约

**适用条件：** 多个市场共用一个服务端渲染页面，概览只显示短期趋势，但详情需要全部历史和资金费统计。

**根因：** 首屏把四组金油比完整历史和资金费一起写入 HTML，历史增长后拖慢整个页面接收与初始化。2026-10-15 实际工作台读取的内嵌 JSON 达 7,690,553 字符，HTML 即使压缩后仍约 1.92 MB，接收耗时约 69 秒，超过工作台 30 秒加载期限。

**以后做法：** 概览只传报价和独立的七天趋势，保留时间、缺口、单位与源状态；详情按所选区间使用独立的图表契约读取价格、资金费和小型全历史摘要，并使用现有压缩协商。只有选择全部时读取全区间；原完整历史接口保持原义。不能把截短历史放回完整历史字段，否则会误算全历史统计，并阻止详情立即加载。读取失败保留旧趋势及其真实时间，不能刷新源时间来掩盖过期。

**如何验证：** [首屏测试](modules/monitor/tests/initial-market.test.mjs) 用四组各两万点的历史验证有界体积、七天边界、零值、缺口、源对象不变及失败恢复；[HTTP 测试](modules/monitor/tests/hub-summary.test.mjs) 验证历史响应 gzip 协商及解压后的完整字段；[浏览器回归](modules/monitor/tests/gold-oil-loading.browser.mjs) 经真实工作台入口验证详情按需读取和统计恢复。

**证据：** project-aggregation 基线 `6026760` 的 [首屏读取](modules/monitor/server/initial-market.mjs) 序列化四组完整历史；用户实际工作台网络记录显示文档状态为 200、gzip 仍传输 1,919,809 字节，并在约 69 秒后才完成。四组历史分别有约 1.49 万至 1.97 万个点，是主要体积来源。

**事件记录：** `monitor-initial-history-payload-20261015`；一次实际慢加载定位，不推进主线复盘检查点。
**状态补充（2026-11）：** 金油比监控已于 2026-11 移除，首屏不再输出 `cl-xau` 数据；概览与详情分离的契约仍适用于原油、海力士和合约页面。
**轮询补充（#166，2026-11-06）：** 契约不只管首屏，也管之后的轮询：海力士概览原先用 `useMarketFeed(initial.hynix, active || summaryActive)`，任何页签下都每 60 秒读一次完整 `/api/monitors/hynix/history`。现在完整历史只在详情打开时轮询，概览改读 `/api/monitors/hynix/trend`（与首屏 `hynix.trend` 同一函数、168 点、保留 `status` 与 `fetchedAt`，历史缺失返回 503），并拒收乱序的旧响应；卡片取三份读数中源时间最新的一份，是否过期看当前负责更新卡片的读取。本地种子数据每次读取 196,645 B / gzip 43,781 B → 8,344 B / gzip 2,221 B。验证：`modules/monitor/tests/monitor-summary-refresh.browser.mjs` 断言原油页签 60 秒内 trend 2 次、history 0 次，打开详情才读历史。
**补充（Issue #141，2026-11-05）：** 海力士首屏改为只内嵌 168 点 `hynix.trend`。拆分后详情 hook 不能再把首屏数据当作已加载的完整历史：首次成功读取前，概览沿用首屏趋势及其真实时间，读取失败标为过期；详情图与表格显示加载中，不能显示“暂无可用行情 / 暂无记录”。[浏览器回归](modules/monitor/tests/hynix-initial-fallback.browser.mjs) 让首次历史请求返回 503 后再成功，去掉回退或未加载状态时会失败。原油 `oil.candles` 仍整份内嵌，属同类余项。
**补充（Issue #166，2026-11-05）：** 原油首屏改为只内嵌 672 点（7 天 × 96）`oil.trend`，由服务端从已校验的 15 分钟 K 线生成并保留源状态与 `fetchedAt`；详情首次挂载即读取完整 K 线，成功前图表与表格显示加载中。本地仓库种子数据下内嵌 JSON 由 798,942 降到 33,611 字节，客户端挂载解析与初始计算中位数约 80–95ms 降到 0.5ms。[浏览器回归](modules/monitor/tests/oil-initial-fallback.browser.mjs) 同样以首次 503、下一轮成功验证回退与加载状态。海力士概览每 60 秒仍拉完整历史，未改。

**研究轮询补充（2026-11-05）：** 本次新增 Binance/Lighter 成本研究的提交前独立审查，以真实引擎生成 12 个情景各 20 轮成交记录，再经过工作台 HTTP 入口读取，正文达 4,830,897 字节，接受 gzip 的请求仍收到未压缩正文；前端每 5 秒读取且 10 秒超时。修复将常规状态限定为统计与在途任务，逐笔/曲线按当前会话与所选情景读取，完整导出保持原义，并只在该公开研究数据路由协商压缩。验证用 [工作台回归](tests/binance-lighter-workbench.test.mjs) 检查大报告下状态体积、单情景详情、gzip/q=0 与完整导出；[页面回归](tests/binance-lighter-cost.browser.mjs) 检查迟到详情不跨会话覆盖。事件 `cost-research-history-polling-20261105`；相对 `4bb440e` 的未发布实现，不是主线逃逸缺陷，不推进复盘检查点。

### L048：迟到的模块就绪消息仍需完成加载恢复

**适用条件：** 工作台通过原生 iframe load 和模块消息共同判断就绪，并保留后台预加载页面。

**根因：** 有效 ready 消息更新了连接状态，却未清除已有加载超时；内置模块在原生 load 后仍需初始化时，后台三秒兜底又会过早丢弃该页面。两个失败路径均在修复前的生产构建上复现。

**以后做法：** 经既有来源和当前窗口校验后的 ready 同步清除对应加载超时。对已知内置模块保留有界初始化窗口；真正无响应仍释放后台队列，旧窗口或错误来源不能恢复当前页面，不能自动反复重新载入。

**如何验证：** [加载浏览器回归](tests/project-load.browser.mjs) 用真实 iframe 与 postMessage 覆盖超时后恢复、错误来源与已销毁窗口拒绝、延迟初始化后复用，以及持续无响应时释放队列；[预加载状态测试](tests/workspace-preload.test.mjs) 核对缓存和队列边界。

**证据：** project-aggregation 基线 `6026760` 的 [ProjectPage](src/ProjectPage.tsx) 在 ready 路径未清除加载错误，且代理页面原生 load 后统一只等待三秒。上述浏览器回归在基线上分别因残留超时、后台 iframe 提前移除失败。

**事件记录：** `hub-late-ready-recovery-20261015`；同一加载状态链的回归修复，不推进主线复盘检查点。

### L049：刷新调度要覆盖请求耗时与缓存剩余有效期

**适用条件：** 账户快照具有短有效期，上层工作台再次采样该快照，或多个读取任务共用轮询锁。

**根因：** CrossEx 合约目录和账户共用整轮锁，慢目录阻止账户刷新；固定五秒轮询遇到六秒账户读取，会跳过下一拍，使连续成功的读取仍出现超过十五秒的旧快照。工作台按完整 TTL 的一半轮询，没有扣除摘要采到时已有的数据年龄，进一步产生可避免的过期提示。前端状态文字还沿用最后响应的 `live`，与本地时钟计算的过期保护不一致。

**以后做法：** 不相关读取分别调度并各自合并在途请求；账户轮询根据本轮耗时安排下一次，慢请求完成后及时继续，关闭时取消后续调度并等待在途读取。摘要轮询以本次 `checkedAt` 为固定基准计算剩余有效期，保留最小间隔及失败后的正常周期。源时间仍使用真实采样起点，不能以完成时间替换或延长 TTL；界面文字与当前过期判定一致。

**如何验证：** [账户轮询测试](modules/crossex/tests/account-refresh.test.mjs) 覆盖目录阻塞、六秒连续成功、请求不重叠、真实失败保留旧值与恢复、关闭等待；[摘要调度测试](tests/warmup.test.mjs) 覆盖剩余有效期、严格 TTL、静态数据与失败周期；[工作台浏览器回归](tests/crossex-position-metrics.browser.mjs) 验证过期、数据不完整和恢复后的状态文字及交易禁用。复用未改动的真实时效与未知订单保护测试。

**证据：** project-aggregation 基线 `2622586` 的 [账户调度](modules/crossex/server/app.mjs) 和 [摘要调度](server/app.mjs)；新增回归在修改前分别复现目录阻塞后 `asOf` 不变、六秒读取产生 15.1 秒快照，以及临近过期摘要未及时重采样。用户报告页面持续打开仍反复提示，但未取得现场接口耗时或日志，不能据截图认定每次提示均由此引起。逐笔订单核对或真实上游失败仍可能导致合理过期，本次未改变其保护边界。

**事件记录：** `crossex-refresh-cadence-20261015`；同一次刷新链定位与修复，不推进主线复盘检查点。

### L050：公开报价的短暂失败要有限恢复并保留具体诊断

**适用条件：** Monitor 原油主报价、交易所比较与海力士比较共用 Binance 公共行情请求；仅适用于无副作用的公共 GET，不推广到下单、划转或其他未知结果的写请求。

**根因：** 必要的合约信息或标记价格只尝试一次，短暂网络错误或 502 即使马上恢复，也会使本轮采集失败，主报价须等下一轮才恢复。采集器同时丢弃原异常，导致超时、HTTP 拒绝和数据校验错误都只显示“采集暂时失败”，无法定位实际来源。

**以后做法：** 将一次短延迟重试放在共享在途请求内，只处理明确的瞬态传输失败；持续失败仍按原规则保留数据和时间、禁止过期告警。可选资金费保持独立降级，不增加第二次超时；429 按端点冷却，418 在当前 reader 内共享冷却，合法恢复时间不能被提前截短。只输出应用定义的数据源、端点类别、错误分类和 HTTP 状态，不透传响应正文、完整 URL 或任意异常字符串。真实源时间及双腿一致性校验保持不变。

**如何验证：** [Binance 请求测试](modules/monitor/tests/binance-quote-request.test.mjs) 覆盖有限重试、冷却期限、响应读取失败与固定诊断；[报价测试](modules/monitor/tests/exchange-quotes.test.mjs) 核对并发读共享同一次重试、可选资金费失败仍更新价格及源时间不变；[数据库回归](modules/monitor/tests/market-database.test.mjs) 覆盖瞬态恢复、持续失败保留旧值与成功时间、诊断传到工作台摘要、旧源时间拒绝及真实恢复后清错。

**证据：** project-aggregation 基线 `2622586` 的 [报价读取](modules/monitor/lib/exchange-service.ts) 和 [采集器](modules/monitor/server/market-collector.mjs)。2026-10-15 用户报告原油价差频繁失败；旧实现的 502 后恢复探针只发起一次标记价格请求并失败。实际工作台 23:16–23:19 已恢复，主报价每约 30 秒更新；因原异常未保存，不能断言截图 23:13:57 的失败一定属于网络、超时或限流。本轮修复已确认的恢复与诊断缺口，不隐藏持续失败。

**事件记录：** `monitor-binance-quote-transient-recovery-20261015`；一次用户反馈及请求链修正，不推进主线复盘检查点。

**合约目录补充（2026-10-25）：** 用户截图显示原油价差停在 03:21:12、至少连续两轮未更新，同一时刻共用 CLUSDT 的 Binance 金油比 03:22:12 仍为实时。两条路径的差别：原油主报价每 60 秒必须重新下载约 1.15 MB 的全量 `exchangeInfo` 并读取全量 `premiumIndex`，金油比 5 分钟才读一次目录、按合约读价格。旧实现中目录刷新只要变慢或失败，最新价格也随整轮报价一起失败；提醒栏则把数据库记录的具体原因替换成“行情获取失败或已过期”。以后做法：Binance 与 Bybit 合约目录过期后改为后台刷新，上次有效目录不超过 10 分钟时先用它解析最新价格，超过 10 分钟仍阻塞并报错；价格、资金费、源时间与双腿一致性校验不变。数据库 fresh 读取拒绝时，在错误上附带采集器记录的固定原因，原油与金油比提醒栏改为显示该原因，其他任意异常文本仍隐藏。已登记、未改：Lighter 等比较平台的合约目录同样按 60 秒共享，但不影响主报价；海力士报价不经过 Binance 诊断，提醒栏保持原有通用提示。现场错误原因未取得，只能确认是原油路径持续约一分钟的失败，不能断言是目录超时、限流还是数据校验失败；工作台“运行详情”会显示采集器记录的原因。验证见 [报价测试](modules/monitor/tests/exchange-quotes.test.mjs) 的目录失败与慢刷新用例、[告警测试](modules/monitor/tests/oil-alerts.test.mjs) 的原因透传用例和 [数据库回归](modules/monitor/tests/market-database.test.mjs)；三处新增断言在旧实现上失败。事件 `monitor-binance-catalog-retention-20261025`，实际发生日期 2026-10-25（Asia/Shanghai）；不推进全历史复盘检查点。

### L051：固定版本的源码获取须有界恢复传输中断

**适用条件：** 安装器按正式发布清单的固定提交，从远端 Git 仓库准备源码，并复用本地 bare 对象缓存。

**根因：** 源码路径只执行一次静默浅层 fetch；连接重置或响应截断会直接终止更新，且没有接收进度。运行包下载器的恢复能力不覆盖这条路径。

**以后做法：** 对明确瞬态传输错误最多尝试三次，保留原始退出码与 2/4 秒退避；认证、证书、限流、缺少版本、磁盘错误及中断直接退出。重试可局部使用 HTTP/1.1，但不能据连接重置推断 HTTP/2 是根因；60 秒近零流量检测不等于总下载时限。始终获取同一固定 SHA，以专用 ref 保留缓存对象，成功后确认目标提交存在。缓存命中跳过下载，不删除旧对象、不回退分支或未核验源码归档；最终失败发生在构建与服务切换之前。

**如何验证：** [源码获取检查](deploy/test-source-fetch.py) 使用真实本地 Git 对象和故障注入覆盖恢复、耗尽、永久错误、中断、缓存命中、版本固定、假成功和日志失败；Windows 使用原生 Git Bash。[增量安装检查](deploy/test-incremental.sh) 在 Linux CI 确认源码失败不改变 current、部署记录、依赖或服务，恢复后仍复用增量结果。不把本地夹具描述为用户服务器网络已恢复。

**证据：** project-aggregation `52e0463` 的用户更新截图显示 `curl 56 Recv failure: Connection reset by peer`、`early EOF`、`invalid index-pack output` 和 hub 退出码 128；基线 `d1ae400` 的 [源码安装器](deploy/install.sh) 仍只有一次 `git fetch --quiet --depth=1`。未取得服务端完整网络日志，不能断定断开由 GitHub、代理还是线路引起。

**事件记录：** `source-fetch-reset-without-retry-20261015`；一次用户更新失败及源码获取链修复，不推进主线复盘检查点。

### L052：旧缺口修补与近期增量分开，并持久保存修补进度

**适用条件：** 持久化 K 线同时包含近期行情和不可立即补齐的早期缺口，服务重启后继续周期采集并向按区间读取的图表供数。

**根因：** 金油比 reader 发现任一旧缺口后，把整个请求起点退回该缺口，再分页读取到现在。永久空洞会让每轮重复抓取大段已存在历史；重启同时启动全部采集进一步争用网络。详情虽默认显示七天，仍传输完整历史，使后端等待与前端接收耗时叠加。

**以后做法：** 近期增量独立读取；每轮只修补有界旧窗口，只填缺失值，保存游标并在一轮完成后冷却。空洞或修补失败仍推进游标，不能阻止近期成功数据入库；首次无缓存仍完成原有初始化。启动沿用真实源时间计算剩余周期，并在该周期上叠加错峰，报价保持立即读取。图表缓存按交易所、原油品种和区间隔离，部分数据独立显示，缺失部分有限短轮询；切回部分缓存立即补读，失败保留旧图与真实时间。

**如何验证：** [修补回归](modules/monitor/tests/gold-oil-history-repair.test.mjs) 覆盖四种组合、永久空洞、多洞轮转、数据库重开、失败保留及新数据恢复；[启动调度测试](modules/monitor/tests/market-collector-startup.test.mjs) 验证剩余周期、相同源时间错峰和暂停清理。[图表契约测试](modules/monitor/tests/gold-oil-chart-data.test.mjs)、[缓存合并测试](modules/monitor/tests/gold-oil-chart-feed.test.mjs) 及 [工作台浏览器回归](modules/monitor/tests/gold-oil-loading.browser.mjs) 按影响范围核对区间、全历史摘要、资金费独立覆盖、迟到响应隔离和失败保图，不把合成夹具的耗时当作服务器实测。

**证据：** project-aggregation 基线 `eb6aab1` 的 [Binance reader](modules/monitor/lib/gold-oil-service.ts) 与 [Bybit reader](modules/monitor/lib/gold-oil-bybit-service.ts) 将最早缺口与近期起点取最小值。2026-10-16 用户报告更新或重启后图表明显慢；Windows 原生两万根历史夹具中，正常近期更新为 2 次请求，增加单个早期永久缺口后每轮变为 40 次，修复后首次最多 4 次、冷却期每轮 2 次。同一图表夹具默认七天为 672 点、约 79 KB，全部为 20,000 点、约 2.32 MB；未取得用户服务器重启期间的网络记录，不能将所有图表延迟归为同一来源。

**事件记录：** `monitor-history-gap-refresh-amplification-20261016`；一次用户反馈及历史采集与详情读取链修复，关联 L047 的契约边界，不推进主线复盘检查点。
**状态补充（2026-11）：** 金油比监控已于 2026-11 移除；上文引用的金油比修补测试与 Binance / Bybit reader 源码已随之删除，修补游标与有界窗口的做法仍适用于其他持久化 K 线。

**成交历史补充（2026-11-08）：** 基线 `75911f0` 的 [Asset 成交缓存](modules/asset/lib/hub-fills.ts) 已将原始成交存入 SQLite，但同步游标只有在持仓成功且回放无时间歧义时才推进；历史已完整取得、持仓失败或近期成交尚不能判断开平时，下一轮仍可能重复读取 85 天。历史同步进度与派生回放的可信状态应分别保存：只有完整读取、解析和合并校验通过才推进历史水位，继续以十分钟重叠补读并用当前持仓回放缓存；失败、分页预算耗尽和内容冲突不推进。普通失败同时保留原始记录、原成功时间和绝对重试期限，跨重启遵守冷却；冲突失效的历史不能被随后一次网络失败重新写回。新增字段兼容旧缓存，旧回放游标保留供回滚使用。

验证见 [成交回归](modules/asset/tests/hub-fills.test.ts)：原油、海力士、ANT 三市场在 SQLite 文件重开后仍增量恢复，旧成交与新增成交共同回放；修改前同一回归实测再次请求 85 天，并在失败冷却到期前重启后多发一次请求。真实 Binance 读取器配合合成响应，首次 85 天读取为 26 次请求，恢复轮为 2 次，持仓证据不足时开平方向仍未知。未读取实盘账户，不能将该请求数当作用户服务器耗时。事件 `asset-history-replay-cursor-coupling-20261108`；用户缓存建议后核实，不推进复盘检查点。

### L053：镜像测速须验证真实正文，并接通实际下载路径

**适用条件：** 为固定版本发布包增加镜像、CDN、下载测速或一键配置，尤其默认更新仍采用源码 Git 获取的项目。

**根因：** 测速把 curl 输出开头的空行当成 HTTP 状态，未跟随发布资产重定向；Nginx 只代理 GitHub 初始跳转，真实包离开缓存。配置写入应用服务，但生产下载器没有读取者；HTTP、HTTPS 与端口各用不同地址，检查失败仍输出成功。OSS 缓存以文件名复用，未按版本和摘要核验。上述缺陷让检查输出与实际下载、缓存和更新行为脱节。

**以后做法：** 从官方来源固定清单身份和摘要，镜像只提供固定版本包；真实正文、最终状态和 SHA-256 同时通过才算成功。配置作为可信数据由实际包下载器读取，不执行 shell，不改变默认源码更新模式，不承诺未测量的提速。镜像失败按策略回源，取消、本地权限和磁盘错误直接失败；无变化复用已验证配置和包。Nginx 内部完成受限 HTTPS 资产跳转并缓存最终正文，失败恢复旧配置。OSS 缓存和对象按版本隔离并验证内容。

**如何验证：** [测速与入口检查](deploy/test-mirror-tools.py) 覆盖 200、302、错误摘要和失败报告；[生产镜像下载检查](deploy/test-release-mirror.py) 覆盖实际下载器的优先级、回源、缓存、时限及可信配置；[安装与配置检查](deploy/test-mirror-setup.py) 覆盖失败保旧及幂等；[真实 Nginx 检查](deploy/test-mirror-nginx.py) 在 Linux CI 验证内部跳转、缓存命中和 Range，不把本机模拟当作服务器测速。复用 [发布协议回归](deploy/test-release-download.py) 与 [源码获取回归](deploy/test-source-fetch.py)，确认原有完整性和固定源码版本行为保持。

**证据：** project-aggregation `1229ebe` 引入镜像测速，`f9851a3` 引入镜像配置与同步；审查基线 `3e37bd4` 中 [测速脚本](deploy/test-mirror-performance.sh) 对本机 200/24 字节响应仍记录失败，302 夹具未请求正文；[Nginx 安装脚本](deploy/setup-release-mirror.sh) 在 `nginx -t` 返回失败的隔离用例中仍退出 0。[配置脚本](deploy/configure-release-mirror.sh) 的旧变量无生产消费者，默认更新入口仍指定 `source`；[OSS 同步器](deploy/sync-release-to-oss.py) 使用固定临时目录和跨版本同名缓存。2026-10-16 用户要求检查并修复，未取得服务器端速度证据。

**补充证据：** 修复提交 `dfef0d2` 的 Linux CI `38776971057` 复现超时线程与读取线程同时关闭 `HTTPResponse`，在 Python 3.12 的 `read1` 中触发 `AttributeError` 并阻止回源。停止下载只跨线程 shutdown socket，由原请求线程在 finally 中关闭响应；超时回归同时断言关闭线程归属。该 CI 的 `/opt` 含宽写权限与默认 ACL，安装夹具因此迁入独立的 `/run` 临时目录，保留生产权限检查。

**事件记录：** `release-mirror-unverified-download-wiring-20261016`；同一批镜像工具的审查与连续修复，关联 L009、L030、L032，不推进主线复盘检查点。

### L054：交易事件后的现场必须证明已反映该成交

**适用条件：** 根据 ADL、外部成交等事件读取实际持仓，自动减仓或宣布恢复完成。

**根因：** 新发出的 REST 请求仍可能同时返回两份尚未反映成交的旧持仓；本地读取时间新鲜、两份数量相同，不能证明交易已经落到仓位。事件数量字符串的小数位不同也不能视为身份冲突，Decimal 默认精度还可能把微小真实残差舍入为零。

**以后做法：** 除时效和账户代次外，要求受影响原始持仓方向的交易所更新时间覆盖成交时间，保留显式零仓方向的来源时间；缺失或滞后时等待，不标记事件已处理。累计成交按真实账户、合约与交易所订单号去重，数量按数值比较；合计和差额使用精确算术，每笔下单量向下取整且不跨越平衡点。明确尚未进入网络发送的失败不得归为结果未知。

**如何验证：** [ADL 控制器测试](modules/aster/tests/test_adl_controller.py) 复现旧平衡现场早于成交、迟到仓位、跨重启未知订单和微小残差；[全仓读取测试](modules/aster/tests/test_adl_exchange.py) 保留零仓更新时间并拒绝过期或被事件失效的现场；[事件解析测试](modules/aster/tests/test_adl_events.py) 核验交易所原始字段与累计数量。

**证据：** project-aggregation 基线 `0212f91a` 尚无 ADL 自动处理；2026-10-16 新功能开发中的离线故障注入在新增 [adl.py](modules/aster/trading/adl.py) 上复现“旧多空各 2、ADL 时间 1000、仓位更新时间 999”被提前标记完成，修正后等待持仓投影再执行。没有真实账户成交或服务器验收证据，不将离线结果描述为实盘验证。

**事件记录：** `aster-adl-position-projection-20261016`；同一功能开发中的审查与连续修补，关联 L008、L031、L039、L040，不推进主线复盘检查点。

**配对终态恢复补充（2026-10-21）：** 本仓 `dc87ff8` 让配对批次在一次持仓读取与终态回执不符后进入有界终态恢复，此后只能经 `adopt_unknown` 退出。测试普查发现 [test_pair_review](modules/aster/tests/test_pair_review.py) 一直未被 CI 运行，单独运行即复现：循环开仓成交后一次滞后读取，即使下一次读取已完整反映回执，批次也不再完成，120 秒后本批成交被采纳为底仓、不再平仓，下一循环叠加敞口。`e7894cd` 改为：终态恢复中数量与杠杆完全反映回执的读取走正常完成路径，否则仍有界退出且不发修复单；三次有界读取用尽后，在 120 秒完整核验到期时先按核验节奏读一次，节流在读取前落盘。独立审查第 2 轮还发现 ordinary 批次在恢复中修改 pending 后未落盘，`reconcile_positions` 的 CAS 每个 tick 冲突、状态永不前进；进入正常路径前先保存批次。以后让“滞后读取”进入有界路径时，同时确认后续反映成交的读取仍能完成批次，并检查本轮内存修改与任何 CAS 比较的落盘顺序。[终态恢复测试](modules/aster/tests/test_pair_review.py) 覆盖一次滞后、持续滞后、需修复单、滞后跨过有界读取、核验读取失败和 ordinary 单侧滞后，均做去掉守卫的变异验证。仍未解决的既有问题见 issue #20–#22（已在下方交付，历史归档部分转 #30）。事件 `aster-pair-terminal-recovery-lag-20261021`，不推进主线复盘检查点。

**#20–#22 本次交付：** `076d1f3` 基线上的离线回归复现：普通配对两侧返回成交前底仓，不能仅凭数量相等认定人工回退。本次方向时间证据限定于当前 pending 批次：数量与杠杆完整反映原单及修复单回执时，沿用正常完成路径，不要求新增时间字段；采纳不同于该投影的现实仓位或人工回退前，才要求对应方向时间覆盖该批已知成交，缺失或滞后则保留 pending 和原因。Live 保留交易所原始 `updateTime`，包括零仓方向；Paper 仅在新成交时原子保存方向时间，不迁移旧账本、不补造读取时间。时间要求只适用于创建时带 `position_time_evidence` 的新批次；升级时已在途的旧批次（尤其旧 Paper 循环批次人工平回底仓）无法补得方向时间，沿用 HEAD 的采纳行为，否则人工核对、跳过和删除均被 pending 拒绝而没有出口。

**完整核验与只减仓修复：** 120 秒完整核验统一进入 `adopt_unknown`，读取前以 CAS 保存节流，共享 30/60 秒失败退避、配额等待、原因和状态，保留 position_review 截止与时钟回拨处理。当前批次经历史观察守卫时，传递同一份快照及 guards；历史查询使租约失效则等待，不能再读一次并换掉原授权。终态恢复仅放开平仓部分成交和保证金超限的减仓：精确差额向下取整、不越过平衡点，超限最多撤回本批新增量，剩余平衡循环量继续保留在循环进度。已知成交减仓不因未决划转或非正权益被提前阻断；采纳底仓仍要求划转结清及风险准入。身份、模式、ADL、账户写入权、原编号查询、三次修复上限及发送前租约检查继续生效；修复量由两侧持仓差额算出，所以发出任何修复单前要先确认两侧租约仍有效。若只查下单侧，对侧加仓后仍会发出减仓单，反而扩大失衡。两侧检查放在并发发送之前，避免本侧修复成交撤销自身租约后挡住另一侧的修复单。验证入口为 [配对回归](modules/aster/tests/test_pair_review.py)、[完整核验](modules/aster/tests/test_pair_full_check.py)、[方向时间](modules/aster/tests/test_pair_position_timestamps.py) 和 [升级兼容](modules/aster/tests/test_pair_upgrade_compatibility.py)；后者使用 HEAD 格式旧压缩 watch 及无方向时间的 Live/Paper 持仓，覆盖开仓守卫、重新启动、底仓预览和删除。

**本轮变异验证：** 移除完整核验中当前批次的时间守卫、反转减仓方向、令修复量多出一个步长、丢弃已有快照并重新读取，分别触发 8、1、1、2 次断言失败，均无测试执行错误；恢复原实现的六项对照通过。第五轮独立审查后补充：只查下单侧租约、不区分旧批次两处变异各被新测试捕获。单次读取测试同时验证原 guards 失效时保留 pending，变异须覆盖测试包装器预先导入的函数引用，避免实际仍调用原实现。

**历史归档交付（#30，2026-11-05）：** 被挤出八批热索引的已知成交折叠进 `recovery_watch.history` 有界汇总（按账户、合约、方向记录退役成交计数与最新成交时间），压缩与 watch 写入同一 runtime 事务；旧数据首次读取时扫描观察与订单恢复记录迁移，按 watch 指纹缓存，热批次摘要变化即重新迁移。只有持仓方向带正的交易所更新时间且早于已知成交时才阻止采纳；时间缺失或为零、成交无时间、归档不完整（有退役标记却找不到材料记为 `unproven`）都不阻断，只留诊断，避免旧数据失去出口。滞后从本进程首次观察起按 `time.monotonic()` 计时，120 秒后放行并回到原数量核对：订单 `updateTime` 可能反映之后的 EXPIRED 而非成交，无限等待会卡死；也不能用本地墙钟减交易所时间判断到期，本地快 30 秒就会提前放行。按用户决定不设人工确认，删除配对不受该检查限制。审查还发现开仓守卫另读一份快照后仍用原快照发送：历史检查必须作用于规划、风险检查和发送实际使用的同一份快照及 guards，升杠杆覆盖刷新后的快照。验证入口为 [历史时间测试](modules/aster/tests/test_pair_history_times.py) 与 [同快照守卫测试](modules/aster/tests/test_pair_history_guards.py)。以上为同一事件 `aster-pair-terminal-recovery-lag-20261021` 的连续修补，不新增事件计数、不推进复盘检查点，也不描述为实盘验证。

**模拟行情时序补充（2026-11-05）：** 本次成本研究的提交前审查复现：Maker 代理成交发生在 t1000，t1301 收到来源时间 t700 的 Lighter 帧，原逻辑仅因其晚于旧缓存而用它完成延迟对冲。接收时间越过等待期限不能证明行情产生于该期限后；修复同时检查单调到达时间、相对到期点的来源时间下界及明确的时钟误差容差，不通过放宽全局 TTL 修复。250ms 是本模块当前容差，不是其它交易路径的默认规则。[核心回归](tests/binance-lighter-core.test.mjs) 覆盖迟到旧帧、容差边界、新帧与超时。事件 `cost-research-late-pretrade-book-20261105`；相对 `4bb440e` 的未发布实现，不推进复盘检查点。

**ANT 分批减仓补充（#260，2026-11-08）：** 基线 `9351de4` 在上一批已经完整成交、下一次账户仍返回成交前数量时立即暂停。只有原单全部已结算且非 unknown、当前数量精确等于可由上一批已确认成交推导的成交前数量，才允许暂缓下一批；旧读数不是下单许可。等待记录绑定原 phase/batch，持久保存绝对 20 秒上限、初读后的最多三次重读及间隔；恢复须取得精确预期数量并重新通过所有腿的身份、模式、合约、活动委托和盘口校验。成功但迟于截止的读取仍拒绝，兄弟腿硬错误优先。重启沿用原有暂停后人工确认剩余量政策，不自动续发或重复首批；明确确认新剩余计划才清除旧等待基线。[自动减仓回归](tests/trading-anthropic-reduction.test.mjs) 覆盖一次旧读恢复、次数/时间、迟到成功、外部变化、停止/任务截止、崩溃后证据保留和人工继续。事件 `ant-reduction-post-fill-read-lag`；沿用 Issue ID，离线复现，无真实成交验收。

**跨轮自动减仓补充（2026-11-08）：** 用户要求 ANT 强平距离规则每轮完成后继续监测。基线 `9351de4` 的调度器将每轮完成等同于规则结束，导致阈值仍满足也不再减仓。连续保护应区分任务终态与规则启停：只在成功且仍启用时恢复监测，手动停用、失败和未知结果不得复活。新轮次先以原任务的原生持仓减真实累计成交核对剩余，不能直接复用交易所仍未反映最后一批成交的快照，也不能把任务的“剩余待成交量 0”当成实际仓位。核对只在跨轮首次成功读取时完成，之后监测可重新使用当前持仓；完成回执仍保留展示。验证由 [自动减仓回归](tests/trading-anthropic-reduction.test.mjs) 和 [真实 HTTP 调度入口](tests/trading-anthropic-reduction-http.test.mjs) 覆盖续轮数量、旧快照与跨重启退避、手动停用和持久化失败；见 [本次记录](docs/reviews/2026-11-08-ant-continuous-reduction.md)。事件 `ant-reduction-continuous-monitoring-20261108`；用户纠正，离线复现，不代表已在实盘发送。

同轮独立审查还确认：保存参数或先停用再启用不能清除尚未完成的跨轮核对，包括任务刚完成、调度尚未结算的窗口。保持原账户身份的凭据换版可以继续核对历史成交，但当前读取与下单仍绑定新版本；核对完成前不允许换合约绕过原证明。是否允许自动续轮须依据持久执行阶段，不能仅看轮询恰好观察到的最终状态：人工继续过的任务完成后仍需显式重新启用规则。上述保存和未观察到暂停的路径由新增回归先复现、修复后通过，属同一交付前修补，不增加事件计数。

### L055：构建优化必须覆盖冻结安装与真实缓存目录

**适用条件：** 修改 workspace 依赖、编译器、CI 并行或缓存路径以加速构建。

**根因：** 批量展开 catalog 并替换 React 插件后，锁文件和 Vite 导入仍保留旧契约；本地旧依赖可能掩盖失败。CI 实际在新 Git 归档和独立服务账号 HOME 中构建，checkout 的缓存不会自动被使用。旧的整文件替换模板还会删除后来增加的校验和失败清理。

**以后做法：** 先核对固定包管理器下的冻结安装和实际调用入口。依赖、配置和锁文件一起变更；不把缺少验证的编译器迁移混入缓存优化。缓存显式接到真实消费者并保留来源与完整性验证；增量修改当前 CI，保留测试、进程清理、降权打包与跨目录复用验收。性能比例以实测为依据。

**如何验证：** 固定 pnpm 执行冻结锁文件校验；[增量类型检查](deploy/test-typecheck-cache.mjs) 覆盖冷/热检查、缓存后新增错误和修复；[模块缓存检查](deploy/test-module-builds.mjs) 覆盖模块选择和搬移。Linux [真实工作区检查](deploy/test-workspace.sh) 核对服务账号实际 pip 缓存路径、不可变依赖、构建、解包和运行。按改动范围选择，不用 Windows 结果替代 Linux 权限验收。

**证据：** project-aggregation `4197923` 基线上的 2026-10-16 构建优化工作区，五份 package 清单被改写而锁文件未变；固定 pnpm 11.25.0 的 `install --frozen-lockfile --lockfile-only --ignore-scripts --offline` 实际报 `ERR_PNPM_OUTDATED_LOCKFILE`，恢复 catalog 和已验证插件后通过。旧 `apply-ci-optimization-parallel.sh` 模板缺少当前打包器要求的 `--parser-user`；旧缓存草案没有向 `run_as_service` 的独立 HOME 传递 pip 路径。修正入口见 [构建说明](docs/build-performance.md)。这些草案未作为正式方案执行。

**事件记录：** `build-optimization-entrypoint-20261016`；同一次构建优化审核中的关联问题，不推进主线复盘检查点。

**同次用户反馈补充：** 2026-10-16 更新到 `668c32417df9` 的页面显示源码更新共 82 秒，其中 Aster 构建 18 秒、运行环境准备 27 秒、解包与发布目录准备 13 秒。该版本确实修改 Aster dashboard，构建合理；上轮 CI pip 缓存和重复类型检查没有覆盖服务器运行时组装。源码核对发现：默认不跑部署行为测试仍先恢复所有模块到无消费者的构建目录，随后再次恢复到可信目录；每次模块变化重新物化并复制全部生产 Node 依赖；Aster 构建键还覆盖整个 Python 模块。修正为按需工作区、独立固定生产依赖缓存与精确 importer 链接，并保留 Aster 实际引用的共享配置。首次新布局需建立缓存，不把 CI 成功或本地夹具耗时当作服务器提速结果。

**补充验证入口：** [依赖布局测试](deploy/test-package-layout.py) 覆盖无原构建树时固定链接的 CJS/ESM、共享与冲突版本解析；[模块安装回归](deploy/test-module-incremental.sh) 覆盖后端变化不编译、依赖缓存复用、固定旧版本链接及无效缓存拒绝；[真实工作区检查](deploy/test-workspace.sh) 直接验收源码链接布局和独立发布包。该反馈与修正沿用同一事件 ID。

**缓存失效范围补充（2026-10-17）：** 用户更新到 `bfd4a2f0b693` 后报告源码更新 197 秒，其中 Asset 80 秒、Aster 18 秒，解包与运行环境准备均已降至 3 秒。核对 `c00f651..bfd4a2f`：依赖输入、Asset 与 Aster 模块源码均未变化；`fa5e09b` 为 Monitor/Crossex 增加导航依赖时改了公共 `scripts/modules.mjs`，该脚本全文却进入所有模块键，连带使无关模块失效。原生 Git 树复算确认这两个模块树的唯一变化是调度器 blob。源码安装器已有完整产物缓存，改为直接执行各 importer 的真实构建命令，保留 Asset prepare、源码链接拒绝和产物检查；将实际命令指纹传入模块、组装与应用键。仅对固定已审计旧调度器及等价命令允许完整校验后的旧键迁移，避免为缓存规则升级再次全量编译。[迁移回归](deploy/test-module-cache-migration.sh) 验证独立 v1 协议、无工作区迁移、跨目录恢复及损坏/未知规则回退。本次是同一构建优化事件的后续修正，不新增事件计数；截图前一版本未知，不据此承诺固定提速秒数。

**共享依赖夹具补充（2026-10-17）：** 沿用 `monitor-crossex-import-identity-20261017`。本仓 `fa5e09b` 将导航解析器移至 `server/` 后，[CI 38954241655](https://github.com/hxx344/project-aggregation/actions/runs/38954241655) 的根项目冷类型检查报 `TS2307`：临时夹具只复制 `src`，遗漏新增跨目录依赖；CrossEx 的旧扁平夹具还会意外读到原仓共享文件。隔离类型检查须保留 importer 的仓库相对布局并复制直接共享源码，复用原有冷/热检查、新增类型错误与修复恢复场景验证，不以完整工作树的构建通过代替夹具验证。

**新增共享指标补充（2026-10-18）：** 基于 `cb6cba5` 的资本效率改动工作区引入 `server/capital-metrics.mjs` 后，Windows 原生运行 [隔离类型检查](deploy/test-typecheck-cache.mjs) 实际复现 CrossEx 冷检查 `TS2307`；原有指标测试全部通过仍不能覆盖该失败。新增共享前端依赖须同时纳入隔离夹具、[模块构建键](scripts/modules.mjs) 与[源码更新构建键](deploy/install.sh)，否则后续只更新共享公式时可能复用旧页面。复用 [模块键检查](deploy/test-module-builds.mjs) 与 [Git 输入分类](deploy/test-inputs.sh) 验证仅 Monitor/CrossEx 失效，其余模块保持缓存。事件 `capital-shared-build-input-20261018`，不推进复盘检查点。

**生命周期输入补充（2026-10-18）：** 用户在 `f641445` 正式版源码安装时反馈根 `prepare` 报 `MODULE_NOT_FOUND`：临时 `dependencies` 目录未提取 `scripts/install-hooks.mjs`。根脚本已由 `2a81ade` 接入，但 [源码安装器](deploy/install.sh) 的依赖白名单及指纹仍只覆盖 Asset 的 prepare 输入；[真实工作区检查](deploy/test-workspace.sh) 又预先复制依赖并写完成标记，跳过了冷安装。安装生命周期所需的本地脚本和数据必须同时进入固定 Git 提取及依赖指纹；验证不能用预填缓存替代首次安装。本次沿用 L055 的适用范围，记录独立事件 `source-deploy-lifecycle-input-20261018`，不推进复盘检查点。

**对应验证入口：** [Git 输入分类](deploy/test-inputs.sh) 覆盖根 hook 新增、修改、删除及无变化复用；[增量安装](deploy/test-incremental.sh) 在模拟依赖安装时执行真实 hook，并检查 prepare 失败不写完成缓存、不切服，修复后可重试；[Linux 工作区检查](deploy/test-workspace.sh) 改由生产函数执行真实固定源码冻结安装，再验证不可变依赖和跨目录复用。实际执行结果以修复提交的证据及对应 CI 为准，不把 Windows 检查描述为 Linux 部署验收。

### L056：主动断开后保留估值不再要求实时同步

**适用条件：** Asset 中由单个连接维护余额的 Bybit、Binance、OKX、Gate、VAR 账户；Aster 多账号聚合需按其独立来源规则处理，不直接套用单连接判断。

**根因：** 断开连接已删除凭据并清除同步错误，但资产仍保留交易所 `mode` 和真实旧时间。摘要仅按 `mode` 区分静态与动态，导致主动保留的旧估值继续触发模块与工作台的过期告警。

**以后做法：** 运行健康检查按当前账户的实际连接判断是否期待持续更新；仅读取当前 owner 的连接名称，不为摘要读取或解密凭据。未连接账户保留金额与原估值时间，停止参与实时过期判断；已保存连接但凭据失效仍需报警，重连恢复动态校验。缺少连接上下文时保守沿用动态判断；金额缺失、汇率失败和其他活跃来源异常仍保留。日历史的“含旧值”属于数据质量提示，不因主动断开而回写或抹除。

**如何验证：** [摘要测试](modules/asset/tests/hub-summary.test.ts) 覆盖存量断开记录、混合动态来源、全部静态、重新接入及 owner 隔离；[诊断测试](tests/diagnostics.test.mjs) 验证两条当前告警随断开清除；[生产 API 冒烟](tests/asset-gate.smoke.mjs) 通过实际 DELETE、摘要与重连接口验证余额和时间保留、停止源请求以及存量 VAR 无需迁移即可恢复。

**证据：** project-aggregation 基线 `4229052` 的 [disconnect](modules/asset/lib/store.ts) 和 [hub-summary](modules/asset/lib/hub-summary.ts)。2026-10-17 用户明确说明 VAR 令牌过期后已主动断开，但工作台仍持续显示两条过期提示；本轮按当前连接投影摘要时效，生产 API 回归覆盖断开前后及重连。

**事件记录：** `asset-disconnected-valuation-freshness-20261017`；同一次用户纠正及修复，不推进主线复盘检查点。

### L057：滚动均值使用各时点之前的完整历史

**适用条件：** 图表按时间范围展示尾随均值，且可见区间之前的样本仍属于历史点的计算窗口。

**根因：** 原油图把整个可见区间的平均值画成水平参考线，既不随历史时点变化，也不能表示当时已知的滚动基准。先裁剪历史再算均线还会丢失左端预热数据。

**以后做法：** 先按完整历史为每个时点计算，再裁剪展示；仅包含当前已收盘样本及之前记录。原油 1 天、1 周、1 月分别沿用 24 小时、7 天和 UTC 日历月窗口，固定窗口不足或有缺口时留空；全部历史明确标为逐点累计均值，缺失不补零。日历月末钳制可能让起点回退，不能假定窗口左边界永远递增。图线、悬停、键盘读数与最新摘要使用同一结果，纵轴包含均值范围。

**如何验证：** [滚动均值测试](modules/monitor/tests/oil-rolling-average.test.mjs) 以逐点筛选参考计算检查未来隔离、预热、窗口边界、月末回退、缺口及真实零值；[工作台浏览器检查](modules/monitor/tests/oil-rolling-average.browser.mjs) 验证四个范围、图线与读数、价格切换、缺口恢复和移动布局。按本次影响复用原油配对与百分比测试，不扩大无关模块回归。

**证据：** project-aggregation 基线 `24bb935` 的 [原油图](modules/monitor/modules/oil/app.mjs) 在 `renderChart` 中直接以 `summary.average` 绘制水平线，[区间统计](modules/monitor/modules/oil/data-utils.mjs) 对可见样本只求一次平均。2026-10-17 用户截图指出应为滚动平均，并明确窗口随 1 天、1 周、1 月范围变化。

**事件记录：** `oil-rolling-average-window-20261017`；一次用户纠正及修复，不推进主线复盘检查点。

### L058：页面状态时效不能冒充服务器间 WS 连接状态

**适用条件：** 浏览器通过定时 HTTP 快照展示服务器间的 WS 连接，且后台页面刷新频率低于快照有效期。

**根因：** Aster 后台页面每约 30 秒读取状态，回到前台先更新页面时钟，再异步读取新快照。原界面把 8 秒页面时效、样本新鲜度、HTTP 补取错误与 WS 连接合并成一个颜色，旧快照可使“WS 已连接”短暂变黄，即使服务器间连接从未变化。

**以后做法：** 连接徽标与数据摘要分别着色。过期的健康连接记录显示中性“WS 状态待更新”，不声称当前已连接或已断线；明确的 WS 异常继续告警，旧异常注明“最近记录”。样本过期、HTTP 错误及页面连接失败仍明确展示。保留源时间、8 秒时效和后端校验，不靠延长有效期或冻结页面时钟消除闪烁。

**如何验证：** [连接展示测试](modules/aster/dashboard/tests/capacity-relay.test.mjs) 覆盖过期与恢复、未知时间、已知断连、HTTP 错误和样本时效独立性；[工作台浏览器回归](tests/aster-relay-status.browser.mjs) 在实际 iframe 入口固定 WS 连接事实，隐藏超过 8 秒后延迟恢复读取，检查待更新与恢复状态，并确认没有交易写请求。

**证据：** project-aggregation 基线 `025884a` 的 [页面刷新](modules/aster/dashboard/lib/state-refresh.ts)、[状态展示](modules/aster/dashboard/lib/capacity-relay.ts) 和 [额度连接面板](modules/aster/dashboard/components/capacity-relay-panel.tsx)。2026-10-17 用户报告切回标签时黄色一闪后恢复绿色；源码确认上述路径可以独立触发该现象，未取得服务器现场日志，不推断每次黄灯均为页面时效所致。

**事件记录：** `aster-relay-display-resume-20261017`；一次状态展示语义修正，不推进主线复盘检查点。

**同平台多通道补充（2026-11-05）：** 成本研究提交前独立审查确认：Binance 成交通道耗尽重连后，下一帧正常盘口会清除平台/标的级无效标记，未等成交流恢复就重开 Maker 实验。健康应按用途和通道分别证明；盘口不能恢复成交流，必要通道终止失败须让依赖该通道的实验停止，而不是将缺证据记成未成交。[核心回归](tests/binance-lighter-core.test.mjs) 覆盖仅盘口恢复、成交流真正恢复及原未决敞口；[采集回归](tests/binance-lighter-feeds.test.mjs) 覆盖一个必要通道耗尽而其它通道仍健康时的整体清理。事件 `cost-research-cross-channel-recovery-20261105`；相对 `4bb440e` 的未发布实现，不推进复盘检查点。

### L059：资本回报分子与分母须描述同一双腿头寸

**适用条件：** 按双腿价格、杠杆和缓冲估算资本，再组合价差与资金费计算 ROC 的只读机会表。

**根因：** 分母按同数量双腿的各自名义金额计算，分子却直接使用等名义的资金费率差；两腿价格不同时会误估资金费现金流。冻结报价行中的预计算费差还会跨过时效期限，导致同一行费率已缺失而年化仍有效。

**以后做法：** 先固定头寸及计价单位；以多腿名义为基准，空腿资金费乘以空腿/多腿名义比后再减多腿支出。显示与排序共用计算入口，每次按当前时钟验证双腿报价与资金费；过期报价不继续给出 ROC，资金费缺失时只保留明确标注的价差情景。连续外推与实际结算时点计数须明确各自前提。

**如何验证：** [资本指标测试](tests/capital-metrics.test.mjs) 以多价100、空价110、两腿同为1%/8h验证现金流为多腿名义0.1%/8h，并覆盖负费率；[Monitor指标与排序测试](modules/monitor/tests/perpetual-scanner-sort.test.mjs) 覆盖不同周期、过期边界、缓存费差与当前双腿冲突、FX转换及排序一致性；[CrossEx资金费UI测试](modules/crossex/tests/funding-opportunities-ui.test.mjs)覆盖正等名义费差但加权收益为负、缺失费率不补零。按本次可见交互运行工作台浏览器回归。

**证据：** project-aggregation 基于 `cb6cba5` 的 2026-10-18 资本效率工作区；审查确认首次实现 [共享公式](server/capital-metrics.mjs) 分子未加权，[Monitor页面](modules/monitor/app/perpetual-panel.tsx) 从冻结行读取旧费差。首次提交前修正为 [共享时效入口](modules/monitor/lib/perpetual-capital.ts)；基线提交本身没有这些新指标。

**事件记录：** `capital-roc-contract-20261018`；本次开发前置审查及连续修补归为一个事件，不推进主线复盘检查点。

### L060：审查门禁须验证真实 Git 与发布入口

**适用条件：** 用提交钩子、CI 范围参数及提交证据落实代码审查规范。

**根因：** 参数被解析但未切换执行模式，干净 CI 将范围检查退化为空工作区检查；仅从文本 diff 头收集文件还会漏掉二进制、空文件和纯重命名。只给 PR 接门禁、却沿用直接 push main 和独立发布依赖，也不能覆盖实际交付路径。

**以后做法：** 在隔离 Git 仓库用真实提交与钩子验证失败和成功路径；文件路径与新增行分别采集，诊断不回显疑似凭据所在源行。PR、push 与手动执行都选择明确基线，发布内容从最近正式版检查至目标，不能把前一次失败的提交作为可信基线；目标提交为整个交付留证据，发布依赖同一门禁。安装钩子保留已有配置并报告实际状态。证据格式校验只检查基本完整性，测试真实性与语义结论仍由独立审查核对。

**如何验证：** [门禁行为回归](tests/review-gate.test.mjs) 覆盖干净工作区提交范围、暂存与未暂存差异、非法参数、重命名/嵌套/空/二进制路径、同一源行多规则命中时不泄漏内容、非 src 模块与删除提交证据、实际 Git 钩子拒绝及合格提交、安装幂等与归档隔离、PR/push/首次 push/手动运行，以及失败代码后续纯文档提交仍被拒绝。CI 在 Linux 运行同一回归；不以脚本语法正确或工作区空扫通过代替。

**证据：** project-aggregation `89685c8` 的 [参数解析](scripts/review-gate.mjs) 只保存 range 未设置 mode；本轮 Windows 原生运行 `--range 5dc279b..HEAD` 返回“没有代码改动”，而范围内有实际新增代码。隔离回归进一步复现已提交的违规行、嵌套二进制/空文件漏检以及合成 token 原文回显。新 [CI 入口](scripts/review-ci.mjs)、[提交证据入口](scripts/review-message.mjs) 与 [.github/workflows/ci.yml](.github/workflows/ci.yml) 接通执行链。复现使用无效合成数据，不涉及真实凭据。

**事件记录：** `review-gate-entrypoint-20261018`；一次门禁机制审核及连续修正，不推进主线复盘检查点。

### L061：账户配置与只读预检证据须有界复用且不得授权执行

**适用条件：** ADL/保证金等路径复用「账户配置」类证据（如持仓模式）降低 REST 权重，或用同次资金快照字段做 decline-only 划转预检；以及按事件标的缩小挂单查询范围。

**根因：** 配置类字段在短窗口内稳定，但若无明确 TTL 与失效源（配置推送、重连、进程重启），或把预检结论当成执行授权，会在模式变更后按错误现场减仓，或跳过归属/可划核验。挂单若按标的收窄却不校验响应集合，会漏读其他标的挂单或接受未请求标的。

**以后做法：**
- 配置证据（如 hedge mode）仅在同一事件/进程内有界复用（当前实现 ≤15s），配置更新与重连必须失效；仓位/挂单行仍须与模式提示一致，矛盾则阻塞。
- 缩小挂单查询时：标的集合有上限；超出回退全账户；响应标的必须 ⊆ 请求集。
- 快照可划额度等 hint 只用于「本轮不划转」预检；缺失可回退上限，畸形须阻塞；实际划转前重新核验归属、余额与交易所可划。
- 准入权重必须等于本轮实际将发送的请求权重（跳过的 dual/openOrders 不得仍按满权重准入）。

**证据：** project-aggregation `a896ba7d`：[ADL 控制器](modules/aster/trading/adl.py) `MODE_EVIDENCE_SECONDS`、`mode_stale` / `ACCOUNT_CONFIG_UPDATE`；[现场读取](modules/aster/trading/adl_exchange.py) `order_query_symbols` / `_scene_weight`；[保证金](modules/aster/trading/margin_balance.py) 快照 `transfer_withdrawable` decline-only。关联前序配额路径 `cb6cba5e`（未发送不计失败），不合并为同一事件。

**如何验证：** [ADL 预算](modules/aster/tests/test_adl_budget.py)、[控制器](modules/aster/tests/test_adl_controller.py)、[现场](modules/aster/tests/test_adl_exchange.py) 覆盖双账户不同模式、模式缓存失效、有界挂单查询与响应校验；[保证金轮询效率](modules/aster/tests/test_pair_margin_poll_efficiency.py) / [margin](modules/aster/tests/test_pair_margin.py) 覆盖 decline-only 与畸形 hint。不以「请求次数变少」单独作为正确性证据。

**事件记录：** `aster-adl-mode-evidence-cache-20261018`；历史复盘 2026-10-18（Seen 1×）；不推进主线复盘检查点以外的全历史完成标记。

### L062：共享准入与私有日志须按真实原操作恢复

**适用条件：** 账户共享保护库与各交易模块的私有订单、RFQ、划转或配对日志分别提交，且 HTTP 副作用可能在任意提交点前后中断。

**根因：** 共享 prepare 已成功后清除私有原操作标识，或共享 finish 先于可恢复的私有证据，会在崩溃后留下不可核对的永久未决记录。配对补偿可能双腿同批，逐腿猜父操作 ID 不能匹配真实批次。仅在准备阶段检查普通租约，也不能阻止已准备操作在其它结果变为 UNKNOWN 后迟发。

**以后做法：** HTTP 前持久化实际 operationId、真实有序批次与具体请求语义；准备成功后的本地写失败仍保留 prepared 证据。明确未发送、拒绝或合法回执先记私库，再结算共享操作；恢复按原批次和完整回执核对，不以余额或「查无原单」推断成功。紧邻最终 HTTP 使用含 operationId 的许可再次检查，晚回执提交仍核对原 fence。操作级明确拒绝与真正失去所有权分别处理，结算完成不能遗留永久页面禁用状态。

**如何验证：** [核心跨语言测试](tests/account-writer.test.mjs)、[Hub 执行测试](tests/trading-execution.test.mjs)、[CrossEx 运行时测试](modules/crossex/tests/live-runtime.test.mjs) 与 [ASTER 保护测试](modules/aster/tests/test_account_writer.py) 覆盖 prepare 后私库持续写失败、回执持久化后进程退出、双 repair 批次、已准备请求迟发以及结算后的下一次正常确认。

**证据：** project-aggregation 基于 `c76b196` 的 2026-10-19 M1 提交前独立审查：真实 SQLite 注入 IOERR 得到 HTTP 0 次、私库订单结束却丢失标识、共享 sending 仍为 1；双 repair 终态后重启仍残留包含两条 CID 的父操作；操作拒绝后共享未决已归零却仍无法从页面重新确认。修复与独立增量探针确认原标识保留、按实际批次结算且下一次合法交易可进行。均为本次未发布实现的审查发现，不计为基线已发布缺陷。

**事件记录：** `shared-admission-private-journal-recovery-20261019`；一次共享准入集成审查及其同类路径修复，不推进主线复盘检查点。

**已发布路径逃逸（2026-10-19）：** 用户在 `a0d9b64` 反馈 ASTER 保证金反复结果未知、交易所查无划转。离线真实 ManagedWriter、共享 SQLite 和 HTTPX hooks 确认：快照失效在发送前抛 `RequestNotSent`，HTTP 为 0，私库 rejected，批次却被无条件设为共享 unknown；下一轮 prepare 因旧 unknown 拒绝又被包装成普通异常，误记为新的私库 unknown，余额归档后继续循环。引入于已发布 M1 `519d2e8`，属于 P1 逃逸；不能据此断定用户现场第一笔一定是该快照失效。

修复明确未发送分类，先持久化 exact operation/body hash 的未发送证据或明确成功回执，再结算共享操作；尚未结算的证据保留原配对和主账户配置，暂停期间继续只读恢复。旧版 unknown 缺乏发送边界，不凭查无流水、新余额或 skipped 自动追认为 rejected/confirmed。原覆盖仅验证已持久 ACK 的恢复，缺少实际受管理新划转路径；[真实划转集成](modules/aster/tests/test_managed_margin_transfer.py) 现覆盖正常首发、发送前拒绝后重试、部分发送、超时、双库提交切点、原体篡改及配对删除/改配保护。[只读诊断](deploy/diagnose-aster-margin.py) 提供脱敏原请求关联，不改变 gate。

**新增独立事件：** `aster-margin-preflight-shared-unknown-20261019`，同次用户故障定位及连续修补；历史复盘检查点不变。

**同类拒绝补全：** 实际 HTTPX 回归还复现 HTTP400/既有明确拒绝码 `-2019` 后私库 rejected、共享 UNKNOWN，下一轮无法发出。划转专用类型只沿用既有拒绝白名单和固定端点；单次已发送请求的明确拒绝也须先持久化原体回执再结算。不能将“已发送”直接等同“已接受”，也不能把多笔批次中一笔拒绝推广为全部拒绝；混合结果、`-1007` 和网络超时继续保留 UNKNOWN。此为同一逃逸路径的补全，不新增事件。

**批量逐条判定（2026-10-28）：** 用户决定改变“混合结果整批保留 UNKNOWN”：整批未知会让已提交腿的单边暴露得不到修复。ASTER 批量回包逐条判定：明确成功回执算已提交，白名单码算拒单；非白名单且无订单编号的一条只把该条记为 unknown，其余照常结算。该条按原 clientOrderId 查询：查到算已提交；仅当原始码是确定性错误（负数，且不属于 `-1000`/`-1001`/`-1006`/`-1007` 未知、内部错误、超时类，非 408/5xx）且查询返回干净的 `-2013`（非含糊、无 retry_after、HTTP 400/404/无）时，才证明未提交并结算该写入操作；查询失败、429 或上述不确定原始码一律保持 unknown 并阻塞。配对路径补记 `query_absent` 后须在同一轮先写私库、再 `settle_pair` 结算共享操作，否则紧随的补偿单会被 `ACCOUNT_UNRESOLVED` 挡在 sending；共享准入拒绝时该批腿记为 `local_not_sent`，不得停在 sending。Greeks 同理只把 Bybit 执行前拒绝码（`10001`–`10010`、`10017`/`10018`/`10024`/`10027`/`10029`，以及按写端点登记的 `110xxx` 允许列表）当作拒单，`10000`/`10014`/`10016`、`110072`/`110079`、已废弃的 `110030` 与未登记码保持 unknown。**2026-10-29 补充（#79）：** 原先 `110000`–`110999` 整段放行，区间内未登记码（如 `110999`）会被结算成确定拒单并让建单跳过未知核对；现改为 [bybit.py](modules/greeks/app/bybit.py) 中按建单/改单/撤单/RFQ 端点分列、注明官方文档来源与核对日期的允许列表，不再用编号段或黑名单推断语义。[ASTER 保护测试](modules/aster/tests/test_account_writer.py)、[配对发送证据](modules/aster/tests/test_pair_submit_evidence.py)与 [Greeks 账户测试](modules/greeks/tests/test_account_writer.py)覆盖。此为设计调整，不新增事件。

**Greeks 改单逃逸（2026-10-27）：** 已发布 `519d2e8` 的改单身份仅由原订单与正文摘要组成，审查 `6ab243e` 实测价格 `2→3→2` 时第三个新意图误中 `ALREADY_SUBMITTED` 并进入撤单核对，属于 P1 逃逸。新意图须有先持久化的独立递增序号；参数再次相同不等于同一个意图重试。原单尚有 `sending/unknown` 时不能靠换号绕过，共享旧摘要 ID 及撤单/终态核对保持兼容。[Greeks 账户测试](modules/greeks/tests/test_account_writer.py) 覆盖真实追价、重启续号、遗留未决、同单并发及状态写失败零发送。事件 `greeks-amend-intent-reuse-20261027`；不推进复盘检查点。

### L063：恢复检查点须保留秘密材料、真实未决状态与原服务可用性

**适用条件：** 跨模块制作冷备份、隔离恢复或一次性转移交易 authority，尤其由 root 工具操作服务账户拥有的 SQLite 数据。

**根因：** 按文件名猜测秘密材料会漏掉迁移后的通知签名；当前成交量已处理完不能证明 ADL 原单已终结。把 schema/JSON 错误与业务未决混为一类会发布不可用恢复目录；只读 SQLite 也可能创建不同 UID 的 WAL/SHM，主文件的旧 gate 又不能替代已提交 WAL。仅创建新目标并 chown 不能保证服务账户可遍历已有父目录。

**以后做法：** 普通配置与未知文件默认进入独立 secrets 载荷；按真实订单终态和完整日志判断静止。隔离恢复仅容许明确、结构有效的业务未决，未知或损坏结构拒绝发布；普通恢复不能依赖已丢失的源。冷读只有无待提交 WAL 时使用 immutable；真实 WAL 优先，持真实生命周期锁才能 checkpoint，并处理本工具遗留的合法 root sidecar，禁止收编陌生 UID 文件。恢复前以实际服务身份验证父链可遍历性；文本限制按 UTF-8 字节执行。

**如何验证：** [备份回归](tests/recovery-backup.test.mjs) 覆盖真实通知迁移、损坏状态、双密钥、WAL gate 与 Unicode 字节限额；[准入分类](tests/recovery-admission.test.mjs) 覆盖零成交和部分成交的非终态 ADL；[POSIX 探针](tests/recovery-backup-posix.test.mjs) 与 [操作入口](tests/test_recovery_operations.py) 在非 WSL Linux CI 验证 root SIGKILL 残留、原服务 UID 重开、父链和缺源恢复。本机跳过的 POSIX 项不能描述为已通过。

**证据：** project-aggregation 基于 `56cdb9e` 的 2026-10-19 M2 提交前独立审查，复现通知签名进入 data 载荷、非终态 ADL 被误判静止、损坏日志被误容许，以及 1024 字节预算接受 1554 字节中文 JSON；相关 Windows 增量探针已验证修复。root 空 WAL/SHM 和父链后果在同轮审查中定位，Linux 故障探针随本批 CI 实测，不把代码存在等同运行通过。均属本次未发布实现的连续修补。

**事件记录：** `cold-recovery-authority-boundary-20261019`；本次恢复集成审查归为一个事件，不推进历史复盘检查点。

**同轮整包补充：** 真实五模块 CI 在根行为测试无失败后发现，从未创建任务的 Greeks 不落 `engine_state.json`。备份本来没有该固定文件时，允许恢复到 quarantine 并保留缺证，不合成空日志；handoff/admit 仍拒绝。已列入 manifest 的材料丢失、现有 JSON 或 schema 损坏继续拒绝。验证使用实际发布包演练和 [缺证/丢密文回归](tests/recovery-backup.test.mjs)，不能为了让新安装夹具通过而将所有缺文件都解释为新库。

**完整清单路径补充（#274，2026-11-09）：** 基线 `98db5da` 的备份生成器逐项纳入大小写不同的路径，而恢复按完整路径的小写值去重；合成根环境和 ASTER 环境条目也可能形成碰撞。交接因此可能先退役源端，恢复才拒绝。生成端须在全部合成条目追加后、认证封存和退役之前，复用恢复端的路径集合检查；历史已封存包恢复发布也先检查，拒绝后保留 retired 与唯一载荷，不自动解锁。不能只在目录遍历中去重，也不能把全部恢复条件强加给允许保存未决事实的普通备份。`tests/recovery-backup.test.mjs` 覆盖普通备份/交接的真实嵌套文件与合成路径碰撞、原文件和 authority/owner/fence/lease 不变、旧认证包拒绝及旧 sealed 恢复发布保护；Windows 原生已复现合成碰撞和恢复发布的旧行为，真实双文件大小写敏感场景由非 WSL Linux CI 验证。事件沿用 `recovery-manifest-casefold-collision`，未确认生产事故，不推进历史复盘检查点。

### L064：托管发送才要求持久原批次，未托管路径保持原契约

**适用条件：** 同一发送入口同时服务已启用的共享账户写入器与尚未启用的旧路径，例如 Aster 配对 [发送](modules/aster/trading/pair_execution.py) `_dispatch`。

**根因：** `519d2e8` 在 `writer.enabled` 为假时仍拼接 `pending["id"]`、写入 `writer_dispatches`，并进入 `writer.batch`。未托管 ADL 与配对发送的 pending 可以没有持久原批次编号，读取发生在 HTTP 之前。`56cdb9e` 的提交说明记录，`519d2e8` 的 Linux CI 在 ASTER 第二组 217 项中有 1 个 KeyError。

**以后做法：** 账户写入器启用时，HTTP 前要求非空字符串形式的持久原批次标识，并把本次 `operationId` 与有序 `clientOrderIds` 写入发送分组；缺少原批次时，在准备共享操作和发送 HTTP 之前失败，且不留下 `writer_dispatches`。写入器未启用时保持原发送契约：不读取原批次编号、不写发送分组、不用共享 batch 上下文。启用判断之前，托管约束不能进入未托管路径。

**如何验证：** [账户写入测试](modules/aster/tests/test_account_writer.py) `test_managed_dispatch_without_original_batch_id_still_rejects_before_transport` 覆盖托管缺原批次时零 HTTP、共享未决为空且不写分组。[预算路径](modules/aster/tests/test_pair_budget.py) `test_opening_cannot_spend_recovery_reserve` 与 [ADL 集成](modules/aster/tests/test_adl_integration.py) `test_each_prepared_leg_rechecks_adl_before_transport` 使用没有 `pending.id` 的未托管发送，应仍按原契约结束。本次日复盘未重跑这些测试。`56cdb9e` 的提交说明记录当时 Windows 上 `tests.test_adl_integration`、`tests.test_account_writer`、`tests.test_pair_submit_evidence` 为 51/51；该记录属于该提交，不是本轮复盘的执行结果。

**证据：** project-aggregation `56cdb9e84befc97511068c21e36dbefcf0a05166`。父提交 `519d2e8ec31f5e5962d464bc9bcf88425a03e18c` 的 [配对发送](modules/aster/trading/pair_execution.py) 在启用判断之外读取 `pending["id"]`；`56cdb9e` 将原批次校验和 `writer_dispatches` 收进 `writer.enabled`，未启用时用 `nullcontext` 代替 `writer.batch`。

**事件记录：** `aster-unmanaged-dispatch-compat-20261019`；实际发生日期 2026-10-19（Asia/Shanghai）；历史复盘 2026-10-19（Seen 1×）；不推进全历史复盘检查点。

### L065：项目加载优化须核对代理后的传输、缓存与就绪阶段

**适用条件：** 工作台通过独立 iframe 与受鉴权代理打开内置模块，尤其是带宽受限、冷缓存或多个后台页面同时读取的场景。

**根因：** 单独确认工作台入口启用 gzip，不能证明模块资源也已压缩。Greeks 的非哈希静态文件原本不在统一代理的压缩白名单内；Monitor 的 `private, immutable` 构建资源又被代理改成 `no-store`。此外，页面桥接脚本先于主脚本执行时，提前报告 ready 会在关键文件仍下载期间恢复后台读取。

**以后做法：** 沿工作台入口、授权、iframe 文档、静态文件与首批读取检查实际响应。明确选择项目时释放未完成的其他预载，保留已就绪文档；后台读取仅在前台加载期间暂停，并在就绪、失败或切回后恢复既有策略。模块 ready 须有主程序初始化依据。仅允许已注册内置传输的、声明不可变且带内容版本的构建代码保留浏览器私有缓存；HTML、API、Set-Cookie 和任意外部服务仍按原边界处理。非哈希静态代码可单独协商压缩，不能顺带改成长缓存。

**如何验证：** [预载状态回归](tests/workspace-preload.test.mjs) 与 [浏览器优先级回归](tests/project-priority.browser.mjs) 核对取消竞争、文档保留、暂停与恢复；[Greeks 分离脚本回归](tests/greeks-loading.browser.mjs) 使用真实 `hub.js` 延迟主脚本，防止提前恢复。代理的 [真实私有传输回归](tests/portal.test.mjs)、[缓存白名单](tests/static-cache.test.mjs) 和 [Greeks 静态交付](modules/greeks/tests/test_static_delivery.py) 检查正文一致、协商、范围/条件响应以及鉴权不变。传输字节的减少不等于同等比例的耗时改善，网络抖动须单独报告。

**证据：** project-aggregation 基线 `c413a92584ea18c452b278522fcc818bc24665b9` 的 `server/static-cache.mjs`、`modules/greeks/app/main.py`、`modules/greeks/app/static/hub.js` 与 `src/hub-state.ts`。本次新增基线回归分别复现资源缓存被禁用、项目打开时仍保留其他下载，以及 Greeks 未压缩；真实跨子域浏览器夹具使用旧 `hub.js` 时复现提前 ready，换为本次实现后通过。独立审查发现的同一就绪缺口已同批修复。

**事件记录：** `project-opening-transfer-contract-20261019`；实际发生日期 2026-10-19（Asia/Shanghai）；不推进历史复盘检查点。

### L066：异步规则任务须用完成时刻的绝对截止时间

**适用条件：** Engine 用 Future/worker 池调度周期性规则、通知或同类异步任务，并把 `future.result()` 的 delay 写回 `due[key]` 的路径（例如 Aster [engine](modules/aster/trading/engine.py) 的 `poll_trading_rules` / `run`）。

**根因：** worker 只返回相对 delay，主循环在更晚的一轮才消费 Future 时，会把「消费等待」叠加到退避上，真实 RetryAfter 下限被推迟；通知组回归曾因此失败。

**以后做法：** 规则类 worker 在尝试结束时返回 `(delay, absolute_deadline)`，绝对期限按 `monotonic()+delay`（并尊重 RetryAfter 下限）。主调度仅对该任务键使用该绝对期限，不得把 Future 消费等待再加进去；其他任务键保持原退避契约。预算优先级扩展（如资金第四维）时，夹具断言必须同步维度，避免三维假绿。

**如何验证：** 通知/配对/WebSocket 调度相关用例（如 `hourly_notification_engine` / `pair_scheduling` / `cycle_ws_scheduler`）覆盖持续失败与 pool 占满时资金仍可运行；本轮日复盘未重跑这些测试，`c413a92` 提交说明记录当时 Windows 原生相关项通过，该记录属于该提交而非本轮执行结果。

**证据：** project-aggregation `c413a92584ea18c452b278522fcc818bc24665b9`：`poll_trading_rules` 返回 `(delay, deadline)`；`run` 对 `key=="rules"` 解包并用 `max(monotonic(), rules_deadline)`。关联夹具四维 flag 同步属同提交修补，不另建事件。

**事件记录：** `aster-async-rule-deadline-20261020`；实际发生日期 2026-10-19（UTC 提交），历史复盘 2026-10-20（Seen 1×）；不推进全历史复盘检查点。

### L067：新增状态分支须保留既有阶段优先级

**适用条件：** 配对/执行 `tick` 一类多阶段状态机中插入新的等待/阻断分支（例如资金 `margin_wait`）且已有维护、恢复或更高优先的暂停语义。

**根因：** `40bdb6a` 为保证金等待新增分支后，把维护判断挪到了其后；Linux 模块回归发现维护中的工作台被资金等待覆盖，维护「禁止新发送、保留配置」语义丢失。

**以后做法：** 插入新阶段时先画出原优先级表，再放置新分支。维护/工作台暂停等全局禁发语义应先于资金等待等业务等待；pending 只读恢复顺序不得被新分支打断。改动后至少有一条回归断言「维护中不会落到 margin_wait」。

**如何验证：** 工作台/维护与资金等待相关用例；`d7f92d8` 提交说明记录首轮 Linux 726 项中维护 phase 断言失败并已修复。本轮日复盘未重跑。

**证据：** project-aggregation `d7f92d8b674c73a9f3efa3070e91a4fe1dc4081f`：[pair_execution.py](modules/aster/trading/pair_execution.py) 将 `workspace.active` → `phase=maintenance` 恢复到 `blocks_trading`/`margin_wait` 之前。

**事件记录：** `aster-maintenance-before-margin-wait-20261020`；实际发生日期 2026-10-19（UTC 提交），历史复盘 2026-10-20（Seen 1×）；不推进全历史复盘检查点。

### L068：模块高频或大体积 JSON 读取须协商压缩

**适用条件：** 内置模块经工作台代理向浏览器返回大体积或高频轮询的 JSON（合约目录、账户状态等），且用户可能通过带宽受限的链路访问服务器。

**根因：** 统一代理按设计不改写 API 响应，只压缩构建资源；CrossEx 的 `/api/live/instruments` 原样返回约 2 MB 的合约目录，`/api/state` 每 2 秒轮询且包含订单、成交与流水。用户链路实测约 22 KB/s 时，目录读取必然超过前端 12 秒超时并按退避反复重下，占满链路后账户状态也持续晚到，页面同时出现「合约目录读取超时」「数据已过期」，未选出合约导致价格图表与盘口为空。代码路径自内置以来未改变，上游目录增长（约 12458 条、4.9 MB）与慢链路叠加后才暴露。

**以后做法：** 模块自身对达到阈值的 JSON 响应按 `Accept-Encoding` 协商 gzip，压缩在线程池异步完成，失败回退原文并带 `Vary: Accept-Encoding`；小响应与不接受 gzip 的读取保持原样。响应不回显请求输入，才能与 CSRF token 同体压缩。排查「数据过期」时先测浏览器到服务器的实际吞吐与各接口体积，不先假定服务端变慢。

**如何验证：** [CrossEx HTTP 回归](modules/crossex/tests/live-http.test.mjs) 用原始 HTTP 核对 gzip 协商、解压后内容一致、`q=0` 与小响应不压缩；工作台嵌入与代理测试确认服务端读取方仍得到原文。

**证据：** project-aggregation 基线 `f4aab21` 的 [CrossEx 应用](modules/crossex/server/app.mjs)。2026-10-20 用户截图显示目录读取超时与账户过期；本机经端口转发读取工作台 272 KB 构建文件耗时 11.9 秒（约 22 KB/s，可能含浏览器并发占用）；实际上游目录 4.9 MB，接口输出 2034841 字节，gzip 后 91341 字节。未取得服务器日志，`/api/state` 的线上体积未实测。

**事件记录：** `crossex-uncompressed-json-slow-link-20261020`；实际发生日期 2026-10-20（Asia/Shanghai）；不推进全历史复盘检查点。

### L069：结算历史中的已知特殊类型须按真实收付计入，未知类型才拒绝

**适用条件：** 解析交易所历史资金费结算（Binance/Aster 等带 `rateType` 字段的接口），尤其是股票、ADR 等会除息的永续合约。

**根因：** Binance 历史资金费在股票永续除息时返回一条 `rateType: "Special"` 的一次性分红资金费，时间紧跟当期 `Regular` 结算约 1 秒。[CEX 结算解析](modules/monitor/lib/exchange-funding-cex.ts) 把非 `Regular` 一律视为异常并抛错，60 天窗口内只要出现一条，整条腿就读取失败，页面只显示「历史结算费率暂时读取失败」。原油合约没有分红，所以接入海力士前没有暴露。

**以后做法：** 对接口已知的结算类型逐个判断是否为真实收付；真实收付按原时间戳计入，不并入相邻的常规结算，未知类型仍拒绝。新增合约类别（股票、指数、商品）时，先用真实接口拉取完整窗口，检查有无非常规类型和异常间隔，不只抽样最近几条。

**如何验证：** [CEX 结算测试](modules/monitor/tests/exchange-funding-cex.test.mjs) 断言 `Special` 与紧邻的 `Regular` 两条均保留，未知类型仍拒绝；涉及新合约时用真实接口读取完整窗口核对。

**证据：** project-aggregation `1fdb6e8` 为海力士接入结算历史后，用户截图显示 Binance「正股 · 做多」`SKHYNIXUSDT` 读取失败；实测 `/fapi/v1/fundingRate?symbol=SKHYNIXUSDT` 在 2026-08-27 23:00:01 UTC 有一条 `Special`、费率 −0.00021475。同类 Binance 解析器 [gold-oil-funding.ts](modules/monitor/lib/gold-oil-funding.ts) 与 [binance-funding-history.mjs](modules/monitor/modules/oil/binance-funding-history.mjs) 只处理 BZ/CL/XAU 商品合约，按小时对齐配对，未改动。

**事件记录：** `binance-special-funding-hynix-20261020`；实际发生日期 2026-10-20（Asia/Shanghai）；不推进全历史复盘检查点。

### L070：交易所目录只校验实际用到的条目，原生代码不限 ASCII

**适用条件：** 读取持仓、余额等账户数据时，再下载交易所完整合约目录做元数据匹配（Binance/Aster `exchangeInfo` 等）。

**根因：** [Asset 仓位读取](modules/asset/lib/positions-readers.ts) 把整份目录逐条按 ASCII 格式校验后建表。Binance U 本位目录上架了「币安人生USDT」「龙虾USDT」等中文代码后，只要账户有任何 U 本位持仓，整个范围就因与持仓无关的条目报「读取失败」；没有持仓时跳过目录读取，所以同一 Key 的币本位范围仍正常，被误判为 API 权限不足。

**以后做法：** 目录只按原样建立查找表，仅对持仓实际命中的条目校验字段；查不到或字段非法仍拒绝整份快照。交易所原生代码与币名允许 Unicode 字母和数字，继续拒绝控制字符等异常字符，并保留原生代码不转写。

**如何验证：** [仓位读取测试](modules/asset/tests/positions-readers.test.ts) 在目录中混入中文、空值与含控制字符的无关条目，断言 UM/PM-UM/PM-CM 正常返回且保留中文持仓代码，持仓命中非法或缺失条目仍拒绝。

**证据：** project-aggregation 基线 `a16228f`。2026-10-21 用户截图显示 Binance 普通 UM、PM-UM、普通 CM「读取失败」，PM-CM 曾读到数据；服务器实测四个域名均 200、`fapi/v1/exchangeInfo` 约 1.15 MB（未超 2 MB 上限），目录含 5 个中文 `symbol`/`baseAsset`。普通 UM/CM 失败是否另因统一账户被拒绝未实测。

**事件记录：** `binance-unicode-symbol-catalog-20261021`；实际发生日期 2026-10-21（Asia/Shanghai）；不推进全历史复盘检查点。

**统一账户互斥范围补充（2026-10-21）：** 同一事件的后续，不增加事件数。`ac22920` 发布后 PM-UM/PM-CM 恢复，普通 UM/CM 仍「读取失败」；[Binance 说明](https://www.binance.com/en/support/faq/binance-portfolio-margin-api-ccf04078d7774d479f11ae15c4f56081) 写明开通统一账户后 fapi/dapi 的交易与用户数据接口受限，只能经 papi 读取。按用户选择，[仓位服务](modules/asset/lib/hub-positions.ts) 以目录 `accountMode` 判断：一种账户模式有范围读取成功、另一种从未成功时，隐藏并停止轮询后者；成功一侧转为失败即恢复显示与读取，避免长期掩盖真实故障。[服务测试](modules/asset/tests/hub-positions.test.ts) 双向覆盖隐藏、不轮询与失败恢复，并已确认在修复前代码上失败。

### L071：关联持仓按币种前缀匹配时，请求列表须覆盖每个交易所的原生命名

**适用条件：** Monitor 通过工作台按币种前缀（`matchBase`）筛选关联持仓，且同一标的在不同交易所使用不同币名或计价币（海力士 Hyperliquid `xyz:SKHX` 对 CEX `SKHYNIXUSDT`，Aster `USD1` 计价）。

**根因：** [Monitor 请求列表](modules/monitor/lib/related-pairs.ts) 的海力士只有 Hyperliquid 命名 `SKHY`、`SKHX`；[工作台匹配](src/hub-positions.ts) 要求前缀后只剩允许的计价后缀，`SKHYNIXUSDT` 去掉 `SKHY` 余下 `NIXUSDT`，正股腿被静默丢弃，面板只剩 ADR 一条腿。`USD1` 不在后缀表内，Aster 的 `SKHYNIXUSD1`、`CLUSD1` 等持仓同样被过滤。

**以后做法：** 请求列表与报价对比的合约表对齐，两腿原生币名都要列出；新增计价币先补后缀表。前缀匹配保持严格，不改成“包含”或放宽为任意后缀，避免 `SKHY` 误吞 `SKHYNIX`、`CL` 误吞 `CLOUD`。

**如何验证：** [Monitor 桥接测试](modules/monitor/tests/hub-bridge.test.mjs) 断言请求列表覆盖 `exchangeContracts` 每个市场的两腿币名；[工作台持仓测试](tests/hub-positions.test.mjs) 覆盖 `SKHYNIXUSDT`、`SKHYNIX-USDT-SWAP`、`SKHYNIX_USDT`、`USD1` 计价，并保留 `SKHYNIX` 不被 `SKHY` 匹配的反例。

**证据：** project-aggregation 基线 `f8e8560`。2026-10-22 用户截图显示海力士关联交易只有 Binance `SKHYUSDT` 空单一条，实际持仓有两腿。

**事件记录：** `hynix-related-leg-symbol-20261022`；实际发生日期 2026-10-22（Asia/Shanghai）；不推进全历史复盘检查点。

**来源覆盖补充（2026-11-07）：** Anthropic 价差的关联交易只列出 Binance 腿。除了请求列表只有 `ANTHROPIC`，更根本的是 Hyperliquid 腿根本不在持仓桥读取的 Asset 仓位里：Asset 只接入 Hyperliquid 账户总值，仓位由套利交易的实盘连接读取（`/api/trading/anthropic`）。新增市场时，先确认每条腿的仓位实际由哪个来源提供，并让持仓桥读到它；同时列出带 HIP-3 前缀的原生名（`IOANTH`、`XYZANT`）。[工作台持仓测试](tests/hub-positions.test.mjs) 覆盖两条 Hyperliquid 腿的并入、只读账户腿不重复，以及该来源失败时只标记自身不可用；[持仓桥浏览器用例](tests/hub-positions.browser.mjs) 从宿主页面入口验证。事件 `anthropic-related-hyperliquid-legs-20261107`；不推进复盘检查点。

### L072：更新后的维护锁释放不能依赖浏览器读取状态

**适用条件：** 工作台更新期间持久化交易维护锁，更新器重启工作台时任务仍在运行，内置交易模块以维护状态启动，锁只在 [更新协调器](server/updates.mjs) 的 `status()`/`check()` 观察到任务结束后释放。

**根因：** 释放路径只由浏览器触发（侧栏 UpdateStatus 的状态流或 `GET /api/system/updates`），服务端没有任何读取。更新完成后没人打开工作台时，CrossEx、Greeks、Aster 一直处于维护中；Aster 仅保证金管理的配对在维护中不读余额，[摘要](modules/aster/trading/hub_summary.py) 报「资金快照已过期」，用户回到页面后状态流读取一次才释放，几秒后恢复，看起来像要手动重新载入。

**以后做法：** 维护锁仍在或最近一次模块同步失败时，协调器在服务端按固定间隔调用与浏览器相同的 `status()`，复用既有的完成判断、待确认计划和模块同步；提交更新期间不读取，释放并同步成功后停止；关闭时清理计时器、等待进行中的读取，返回的结果不再写状态或调用模块。`initialize()` 仍只按持久值同步，不在启动时咨询更新器。

**如何验证：** [内置更新测试](tests/embedded-updates.test.mjs) 覆盖无外部读取时任务结束自动释放、释放后停止轮询、待确认计划与更新器不可用保持锁、启动同步失败后自动重试，提交更新期间不读取状态，以及关闭时等待进行中的读取且不再写状态或调用模块；前两条在修复前代码上失败，关闭用例在去掉关闭检查后失败。

**证据：** project-aggregation 基线 `d1939d3`。2026-10-22 用户截图显示更新回来后 Aster 5x「数据过期」，运行详情为 xau01、xau02「资金快照已过期（超过 120 秒）」与「项目数据已过期」，手动重新载入或等待后恢复。服务器日志未取得，「回来后才释放」的时序由源码推断，未在服务器复现。

**事件记录：** `update-latch-browser-release-20261022`；实际发生日期 2026-10-22（Asia/Shanghai）；不推进全历史复盘检查点。

**跨 API 所有权补充（2026-10-27）：** 审查 `6ab243e` 的两个真实协调器和特权更新器，确认同计划同模式下较晚返回的停机证据失败，能用本地旧值清掉另一实例已接受的维护标记；真实 worker 完成锁与身份核验后观察到维护为 false。普通在线切流的 ACTIVE job、CLI stack lock 和版本身份重核是反证，不能只凭双实例调用就宣称正常切流必然触发。持久准入代号、独占 owner 与维护/pending 须在同一事务中写入，活 owner 期间同计划的另一实例也不能覆盖它；不能只比较最后一个 token 而嵌套原状态，否则全部确定失败会遗留锁。owner 记录准备/发送边界，确认死亡的 preparing 可回原状态，sending 仍保留不确定 pending；所有退休（含关闭与未知结果）都换代，旧请求不改新一代。状态不按时间自动开闸。[共享协调器回归](tests/update-coordinator-sharing.test.mjs) 使用真实 Python 接受/执行逻辑，包含两条反证、全部失败及真实进程终止；POSIX 用实际槽/入口和被终止的 CLI 锁进程验证中断场景，由既有特权 CI 执行，不把 Windows 跳过写成通过。事件 `cross-api-maintenance-ownership-20261027`；不推进复盘检查点。

**更新进行中停读补充（2026-10-28）：** 用户截图显示全量更新解包阶段 Aster 两侧账户「最近快照 · 更新延迟」，快照停在更新开始时刻。根因是维护门同时承担了停机证据所需的读取静止：[账户调度](modules/aster/trading/engine.py)、[保证金平衡](modules/aster/trading/margin_balance.py) 与 [配对执行](modules/aster/trading/pair_execution.py) 在维护期间整段不读，而全量更新从提交就进入维护，覆盖下载、构建和验证数分钟。所有读取都在账户锁内，[维护控制](modules/aster/trading/workspace_control.py) 取证全程持有全部账户锁，因此只需在取证前静止：`reads_paused` 随进入维护置位，取证成功后清除，重试取证再次置位；交易与划转仍由维护门和发送门拒绝。维护期间的显示读取按原检查周期或空闲观察周期执行，节奏只存在内存，不移动持久的划转检查时间；失败只写入当前视图，不留下影响划转路径的持久失败记录（独立审查曾指出复用 `next_check_at` 会推迟维护后的首次划转评估）。CrossEx、Greeks 维护期间本来只拦交易、不停读取。根治方向是只在切换前进入维护，另行处理。[维护测试](modules/aster/tests/test_workspace.py) 的两条新用例在修复前失败。事件 `aster-update-maintenance-reads-20261028`；服务器日志未取得，时序由截图与源码推断。

**两阶段整体更新补充（2026-10-28）：** 根治上条：整体更新拆成准备与切换两个任务（[设计 6.9](docs/control-data-plane-separation.md)）。准备任务不进入维护，安装器在激活前以专用退出码 76 停下并写 `.prepared-release`；切换才走原有维护、停机证据与重启。专用退出码必须只由准备出口产生：独立审查指出失败步骤偶然返回 76 会被当作已准备，`rollback` 现把它改为 1，[安装器测试](deploy/test-install.sh) 在去掉该映射后失败。准备结果要留给用户挑时机，计划续期须长于普通检查有效期，否则等到收盘后切换要重新准备。能力按计划内安装器字节判定，旧更新服务与旧安装器自动回到单阶段。事件 `two-phase-update-20261028`；服务器上的真实切换耗时未测。

### L073：按市场分支的配对展示须覆盖每个有同构报价的市场

**适用条件：** Monitor 关联交易面板按市场计算两腿配对指标（开仓价差、当前价差），而多个市场共用同一套报价对比组件与持仓列表（原油 CL/BZ、海力士 ADR/正股）。

**根因：** [关联交易面板](modules/monitor/app/related-positions.tsx) 只在 `market === "oil"` 时计算配对，[Monitor 主页](modules/monitor/app/monitor-hub.tsx) 也只把原油对比的实时价差传给面板。海力士两条腿都已列出，开仓价差和当前价差却整块不显示，也没有“无法配对”提示。

**以后做法：** 配对规则按市场集中在 [配对模块](modules/monitor/lib/related-pairs.ts) 的表里，每个有报价对比的市场都登记两腿币名与价差公式；开仓价差与实时对比用同一公式（海力士为 ADR ÷（正股 ÷ 10）− 1，不用原始比值）。新增市场时同时接上实时价差。

**如何验证：** [Monitor 桥接测试](modules/monitor/tests/hub-bridge.test.mjs) 覆盖海力士 10:1 溢价公式、`SKHX` 别名、同交易所多笔/同向/缺腿、无效入场价，以及原油配对不受影响。

**证据：** project-aggregation 基线 `d1939d3`。2026-10-22 用户截图显示海力士关联交易只有持仓、没有开仓价差。

**事件记录：** `hynix-related-spread-20261022`；实际发生日期 2026-10-22（Asia/Shanghai）；不推进全历史复盘检查点。

### L074：发布说明只取面向用户的中文摘要

**适用条件：** 正式版说明由发布提交自动生成，并在 [系统更新弹窗](src/UpdateStatus.tsx) 的“更新内容”原样显示。

**根因：** [候选发布脚本](deploy/publish-release.py) 把整条提交信息（英文标题、实现细节、风险等级与验证证据）加上提交号和部署说明写入发布说明。提交信息是写给审查者的，用户看到的是大段英文和内部证据，抓不到这次更新改了什么。

**以后做法：** 提交信息单独写一段中文「更新说明」（1–3 条，不超过 300 字），[提交证据入口](scripts/review-message.mjs) 对需要证据的提交强制检查；发布只取这一段，缺失、重复或不含中文时用固定中文兜底，不回退到提交正文。两处的段落规则保持一致。

**如何验证：** [候选发布测试](deploy/test-publish.py) 覆盖只保留中文段、遇证据标签截止、缺失/英文/重复时兜底且不含提交号；[门禁回归](tests/review-gate.test.mjs) 覆盖缺失、英文、空行后条目、占位符、超长和重复被拒，CRLF 与多条目通过。

**证据：** project-aggregation 基线 `4db7716`。2026-10-22 用户截图显示更新弹窗展示 `2e21b96` 的完整英文提交信息与审查证据，并要求只看中文、简洁的信息。已发布的旧版本说明不改写，新发布起生效。

**事件记录：** `release-notes-user-summary-20261022`；实际发生日期 2026-10-22（Asia/Shanghai）；不推进全历史复盘检查点。

**跨版本补充（2026-10-23）：** 用户指出更新跨越多个版本时弹窗只显示最新版本的说明。基线 `d776084` 的 [发布读取器](server/update-service/releases.py) 只读 `releases/latest` 的正文。现在本机版本落后时读取一页发布列表，按 `created_at` 取本机版本之后、最新正式版及之前的全部已发布版本（含中间候选版本，不含草稿和更新的候选），从新到旧合并进原有 6000 字节的 `releaseNotes`；本机版本不在本页时按其标签定位，仍够不到则标明还有更早版本。同秒创建的边界版本用仓库比较确认先后。只有一个版本或无法定位时保留最新说明；这段读取最多等待 20 秒，失败或超时不影响检查与更新计划，失败后该仓库暂停 10 分钟（服务器给出更晚期限时以其为准），成功结果按发布缓存有效期复用。验证见 [发布读取检查](deploy/test-release-cache.py) 的 `ReleaseHistoryTests` 与 [更新协调器检查](deploy/test-updater.py)。事件 `release-notes-cross-version-20261023`，关联本条，不推进复盘检查点。

### L075：跨层读取的超时由内向外递增，请求方的活跃条件与应答方一致

**适用条件：** 一次读取穿过多层并各自设超时（Monitor → 工作台页面 → 工作台服务 → Asset），或请求方与应答方各自判断“现在能否读取”，或应答方在重新校验连接时丢弃旧请求的回复。

**根因：** 关联持仓的三层截止时间是 Monitor 12 秒、工作台页面 10 秒、服务端读 Asset 12 秒。Asset 慢于 10 秒时页面先放弃，报「工作台暂时无法读取持仓」，服务端本来会在 12 秒时带着上次仓位标为旧数据返回，这个降级结果送不到面板；交易中心用 15 秒，同一时刻能正常显示。Monitor 按后台读取许可（`readActive`）请求，工作台只在自己处于前台可见时才读取，后台请求直接答「不可用」，切回前台后要等下一轮 60 秒刷新才恢复。模块先于 iframe 原生 load 就绪并发出请求时，工作台在 load 时重新校验连接、丢弃旧文档代际的回复，Monitor 收不到任何回复，12 秒后报「未收到工作台回复」。

**以后做法：** 外层截止时间要比它等待的内层长出足够余量，让知道失败原因的那一层先回复；改任一层时一起核对上下游。请求方的活跃条件跟随应答方真正允许读取的条件，不用更宽的后台许可。应答方重新握手后，请求方对仍未得到回复的请求重发一次，已回复或已超时的请求不重发。

**如何验证：** [工作台持仓测试](tests/hub-positions.test.mjs) 断言服务端、工作台页面、Monitor 三层截止时间依次递增且留有余量；[Monitor 桥接测试](modules/monitor/tests/hub-bridge.test.mjs) 覆盖握手后只重发未回复请求；[主机桥接浏览器回归](tests/hub-positions.browser.mjs) 核对页面 15 秒超时，[真实 Monitor 浏览器回归](tests/monitor-related-positions.browser.mjs) 核对嵌入后按前台活跃读取并显示持仓。load 竞态依赖资源加载时序，浏览器回归无法稳定复现，只有单元测试覆盖。

**证据：** project-aggregation 基线 `d21a78c` 的 [工作台持仓桥](src/hub-positions.ts)、[服务端 Asset 读取](server/asset-positions.mjs)、[Monitor 桥接](modules/monitor/lib/hub-bridge.ts) 与 [Monitor 主页](modules/monitor/app/monitor-hub.tsx)。2026-10-23 用户截图显示关联交易时而「持仓不可用：工作台暂时无法读取持仓」，时而「12 秒内未收到工作台回复」，其余时间正常。现场 Asset 耗时与服务器日志未取得，三条原因由源码推断，哪一条在现场占主导未核实。

**事件记录：** `related-positions-intermittent-20261023`；实际发生日期 2026-10-23（Asia/Shanghai）；不推进全历史复盘检查点。

**排队写入补充（#225，2026-11-07）：** 基线 `fdf470e` 的 Aero Safe 预览、执行与纯写入口未共同遵守服务端整体时限：慢读占队列时，API 已超时，回调后来仍可能写入或启动任务。所有同类入口（含仓位策略）继承 API 收件截止时间并预留余量；排队和每次读链共用一个预算，写入、任务启动、旧交易重新广播与结算前再检查期限和授权。单独用 `Promise.race` 返回错误不能取消异步回调中的副作用，迟到的连接缓存及回执也必须弃置。已接受任务和后台恢复保持原生命周期。验证：[Safe 回归](tests/aero-safe.test.mjs)、[真实路由截止时间](tests/aero-safe-deadline-http.test.mjs) 及 [页面等待夹具](tests/aero-safe-changes.browser.mjs)，覆盖超时后释放队列/读取仍零写入、零新任务和零请求触发的重广播。事件 `aero-safe-queued-side-effect-timeout-20261107`；离线故障注入，未操作真实账户。

### L076：显示节流不能让已收到的新观测背后的旧报价过期

**适用条件：** 前端按固定周期发布已累积的行情帧，而新鲜度时钟按源时间逐秒前进，排名、提醒或筛选用该时钟判断已显示报价是否过期。

**根因：** Monitor 合约页每秒收到流帧并推进源时钟，却每 20 秒才发布一次最新帧。部分平台盘口不变时每 5 秒批量确认，服务端再把未变化的确认按 5 秒节奏转发，发布时报价可能已近 12 秒；接下来 20 秒不换帧，报价在下一次发布前越过 30 秒有效期退出排名，下一帧到达后又回来，表现为每次刷新前后机会短暂消失再出现。更新数据其实已在浏览器中，只是被显示节流压住。

**以后做法：** 有效期和时钟都不放宽、不冻结（L040、L058）。显示层发现已显示且发布时仍新鲜的报价即将过期，而同一合约已收到能撑过下一次常规发布的更新观测（盘口、标记价或资金费时间）时，在过期前一个时钟刻度提前发布最新帧；没有更新观测、已在发布时过期、不可比较或平台不在线的报价不触发提前发布，避免退化为高频刷新。

**如何验证：** [显示调度测试](modules/monitor/tests/perpetual-display.test.mjs) 覆盖提前发布、只有旧观测时按时过期、发布时已过期的报价等待常规周期、迟到确认立即发布、即将过期的确认不缩短周期、计时器只提前不推后，以及显示层接排名选择器、按 1 秒时钟逐秒检查分批确认的组合不会掉出排名（旧实现失败）。

**证据：** project-aggregation 基线 `5925053` 的 [显示调度](modules/monitor/lib/perpetual-display.ts)、[行情 Hook](modules/monitor/hooks/use-perpetual-feed.ts)、[排名新鲜度](modules/monitor/lib/perpetual-spreads.ts) 与 [服务端确认节奏](modules/monitor/server/perpetual-service.mjs)。2026-10-24 用户截图反映资金费套利列表每 20 秒刷新时机会短暂消失再出现；本机无运行中的行情服务，现场未复现，根因由源码与回放测试确认。独立审查另指出两腿时间差超过 5 秒的组合仍会随每次发布进出排名（持续约 20 秒），本次未改。

**事件记录：** `monitor-display-cadence-expiry-20261024`；实际发生日期 2026-10-24（Asia/Shanghai）；不推进全历史复盘检查点。

**腿时间差恢复补充（#55，2026-11-05）：** 上段遗留的腿时间差问题已处理：组合仅因两腿时间差超过 5 秒被排除时，对齐、新鲜、在线且可比较的帧到达后另发一次恢复帧，不重置常规截止、不清除待发布帧、不覆盖到期补救依据；恢复预算为两次基础发布之间最多一次且滚动 20 秒最多一次，候选跨基础发布保留。三轮被否决的设计说明：只比较“不劣于修复前”证明不了恢复有界（修复前同样长期缺席），而叠加恢复和到期等待会连发或推迟到期补救。以后改发布调度时，用固定的修复前实现做逐秒逐组合差分（[基线副本](modules/monitor/tests/fixtures/perpetual-display-head.ts)），同时单独断言恢复时限与发布预算，并覆盖延迟计时器和多组合竞争。与 20 秒发布同相位的周期性错位仍可让个别组合长期缺席（修复前同样如此），见 issue #187。验证见 [显示调度测试](modules/monitor/tests/perpetual-display.test.mjs) 的确定性场景与两组 384 种子回放；没有线上行情或浏览器验收。

**同相位饥饿补充（#187，2026-11-05）：** 根因是等待中的旧候选只把预算预留到最后一次对齐后 20 秒，周期性错位的组合却往往恰在预留失效时或之后才再次对齐：20 秒周期晚 1 秒对齐时，预算计时器先于该秒的帧触发，把预算给了刚就绪的组合；21、22、41 秒等周期在失效后才对齐，所以只把截止延后一个刻度不够。修复按等待先后分配，旧候选预留到最后一次对齐后 `min(120s, max(20s, 已观测的最长再对齐间隔))` 再加一个显示刻度；只保留最长间隔，同一次对齐的连续就绪帧不会缩短它。只有通过全部恢复安全检查的对齐才更新预留（当场被发布的组合随即移出等待，记录不产生影响；被压下的只因预算，即每个基础周期一次、滚动 20 秒、旧候选预留）：PR #214 首轮修复在安全检查之前就记录就绪，于是一个帧总因会移出基础发布已显示组合而被拒的候选会不断续期，让之后才能安全恢复的组合永久缺席（20 秒周期 C、40 秒周期 A、20 秒周期 B 的反例中 B 最长缺席 1121 秒，修复前 36 秒，现 16 秒）。以后凡是“谁可以占用共享预算”的公平状态，都只从调度器本会采纳的机会更新，不能从被安全规则否决的机会更新。120 秒上限覆盖两分钟内的再对齐周期，并限制一个学到长间隔后停止对齐的候选占用预算的时间；去掉上限时，安全拒绝种子回放中偶尔安全的候选会学到数百秒间隔，使其他组合缺席超出推导上界（64 种子组 B 最长缺席：修复前 1140 秒，现 138 秒，去掉上限 238 秒）。保证有前提：只对再对齐间隔不超过已观测最长间隔且不超过 120 秒（如严格周期）的组合按时就绪；间隔继续变长或超过上限的组合仍预留 `min(120s, gap)` 加一个刻度，但预留会在其下次对齐前失效，不保证按时恢复，期间仍挡住较新组合至多约 121 秒；从未在安全帧中对齐的组合不预留，可能被新候选抢先。代价是多个组合竞争时，原先总能抢到预算的组合缺席变长（#187 场景约 356 → 1958 秒，晚到组合约 3561 → 1959 秒），恢复次数和总展示时长明显下降：按等待先后轮流服务后，一次恢复不再顺带带回同帧对齐的多个组合。独立审查实测：#187 场景总展示约 6450 → 4870 组合秒（约 -25%，恢复次数不变）；随机周期 20–120 秒 100 个种子恢复次数 -17%、总缺席 +1.4%，各组合最长缺席之和 -23%；周期 121–140 秒加一个短周期组合的 60 个种子恢复次数 -35%、短周期组合总缺席 +16%。结果有界且不劣于修复前的逐秒比较，是以吞吐换公平的取舍，是否放行较新组合见 issue #222。验证用 `assertNoStarvation`，追踪窗口与上界都从场景帧推导（最长再对齐间隔 g，上界 `(组合数 + 1) × (g + 20s)`），不取实现常量；覆盖 20/21/22/41 秒周期、被单帧错位打断的对齐、被安全拒绝的候选（四个确定性场景与 64 个种子）、学到间隔后停止对齐的释放与 120 秒上限、128 种子随机周期（20–80 秒）回放和原 384 种子回放；`assertRecoveryLiveness` 的预留模型计入所有对齐（含被拒绝的）、取对齐起点间的最长间隔且不设上限，只会比实现更晚失效。这些“不饥饿”断言的前提是：随机周期回放强制基础发布取样秒（每 20 秒的第 19 秒）错位、所有报价新鲜在线可比较、安全拒绝场景只检查被拒候选之后的安全组合。变异结果：回到修复前 10 项失败（含 20 秒场景与“previously ready candidate releases its reservation after one interval and a display tick”）；回到 PR #214 初版的 21 秒预留 8 项、固定 20 秒 9 项；首轮实现（安全检查前记录、无上限）6 项；仅把记录移到安全检查前 4 项；只在预算空闲时记录 10 项；去掉上限 2 项；改为只记最近一次间隔 2 项。在基础发布取样秒对齐的组合会让与之同相的其他组合永久缺席（#218）：被挡住的组合每次对齐时，基线都显示着另一组合，而展示只能发原始整帧，任何能显示它的帧都违反逐秒不劣于修复前，所以在保留该性质时无法修复；饥饿断言改为只统计「对齐那一秒的帧仍保留基线全部行」的可兑现对齐，随机周期回放去掉取样秒强制错位后仍满足。#220 已修（2026-11-06）：原实现在候选 1–2 秒不可排名或平台离线时删除它，且只在「上次发布显示、本次只因时间差丢掉」时登记，离线恰好跨过一次发布的组合永久回不来（#187 场景加第 105–106 秒 Bybit 离线，EARLY/THIRD 缺席 1124 秒）；现在不可排名期间保留排队位置只暂不就绪，任何发布中曾显示过、此时只因时间差被排除的组合都重新排队（同场景缺席 638 秒）。以后凡是“等待资格”的状态，都不能因暂时不可用而删除，否则恢复依赖一个可能不再发生的触发事件。验证：`perpetual-display.test.mjs` 的 #220 两个场景与 128 种子随机离线回放在修复前失败；变异只恢复按上一次发布登记 2 项失败、只恢复不可排名即删除 1 项失败。

**吞吐评估补充（#222，2026-11-06）：** 结论是不改调度。同帧带回早已实现：恢复发布整帧原始快照，并移出所有当时就绪的等待组合，#187 场景 4928 组合秒、178 次恢复，没有可增量。放行较新组合的三种规则都按 3600 秒回放实测：① 观测间隔全部超过 120 秒上限时取消预留，周期 121–140 秒加短周期组合的 60 个种子中，长周期组合最长缺席之和 99517 → 139488 秒，有组合不再出现（3561 秒）；② 预留持有者按已观测最短间隔推算的下次对齐晚于滚动预算恢复时放行，短周期组合明显受益，但长周期组合最长缺席之和 +17%，单个组合 824 → 2370 秒；③ 只在预留覆盖该推算对齐、且所有更早等待组合都推算赶不上时放行，随机 20–120 秒组的恢复次数 +11% 至 +14%、最长缺席之和 -7% 至 -10%，但与原测试“学到间隔后停止对齐的候选到 83 + 38 + 1 秒才释放”冲突：只观测一次间隔无法区分停止对齐与慢周期；要求至少两次观测后不再冲突，收益降到约 1%–2%，且仍有个别组合最长缺席多约 100 秒。按“收益可忽略或最坏情况变差就不做”全部不上线。以后再评估放行时，同时看总吞吐与逐组合最长缺席分布（最大值、p95）：总量改善常伴随个别长间隔组合被饿死；被推算的“下次对齐”只是观测，不是保证。验证：[显示调度测试](modules/monitor/tests/perpetual-display.test.mjs) 新增两个超上限长周期组合场景（各长周期组合最长缺席不超过 900 秒），规则 ①、② 下分别失败；原 57 项不变。

**研究报告采样补充（2026-10-27）：** `075a335` 的 Entropy/Lighter 页面每 5 秒读取一份每 5 秒生成的报告，却用浏览器墙钟对报价接收时间套 750ms 模拟执行门槛；用户截图中六路同轮更新的报价常态全部标过期。采样展示须保留采集器生成时刻、单调接收年龄和严格执行质量，分别表达“最近采样有更新”“报告是否滞后”和“是否满足模拟准入”，页面使用服务器时间锚点与本地单调经过时间，不因展示周期放宽执行门槛。研究结论还须有独立的证据有效窗，不能让旧的正面或负面结论持续冒充当前判断。证据为 [采集器回归](tests/entropy-lighter-lab.test.mjs)、[结论回归](tests/entropy-lighter-insights.test.mjs) 与 [生产页面夹具](tests/entropy-lighter.browser.mjs)，覆盖双重 5 秒采样、偏钟、停更及在下次读取前撤回结论。事件 `research-report-display-expiry-20261027`，不推进复盘检查点。

**成本研究显示逃逸（2026-11-05）：** PR #170 的 `632ac2c` 在新增成本研究页重复了报告采样与执行时效混用：网页每 5 秒读取报告，却将 `book.ageMs + 页面经过时间` 套入服务端 1 秒执行门槛。用户截图显示四路行情约 3 秒后全部“接收年龄超限”；该文案分支证明采样中的 `book.valid` 原为 true，不能据此判定 WS 停更。原浏览器回归只断言旧快照不再绿色，漏了区分“当前待更新”与“服务端样本无效”。修复把过去时的采样校验、当前页面年龄和报告停止更新分开，真实 `valid=false` 与旧样本继续告警，执行门槛不变。[成本研究页面回归](tests/binance-lighter-cost.browser.mjs) 覆盖正常轮询间隔、中性待更新、同报告重复读取、15 秒停更、实际校验失败和慢 HTTP；夹具的服务器时钟按每个请求实际虚拟时刻生成，不能预先跳到整段快进的终点。事件 `cost-lab-sampling-validity-display-20261105`，为发布后用户发现的展示缺陷；不推进复盘检查点。

**公平轮换的新约定（#218，2026-11-07）：** 用户明确允许有效组合短暂替换当前列表行；上文“逐秒保留基线全部行”和只检查保留基线行的对齐机会不再作为本模块约束。只发布原始整帧、真实源时间与到期补救仍保留，恢复仍限基础发布之间一次、滚动 20 秒一次；等待最长的有效候选优先。独立审查另复现首屏就错位的组合在 600 秒内约 30 次对齐却零展示：队列不能要求它曾经显示过，冷启动与新上架也要按相同条件接纳。[显示测试](modules/monitor/tests/perpetual-display.test.mjs) 取消采样相位与曾显示前提，覆盖全部随机相位及冷启动/新上架；[工作台浏览器夹具](modules/monitor/tests/perpetual-display-fairness.browser.mjs) 验证实际 iframe 内轮换、预算、整帧与冻结源时间过期。回放夹具的源时间必须单调，不能用“当前秒”与“当前秒减六秒”交替造成假倒退。事件 `monitor-baseline-sampled-pair-starvation-20261107`；用户批准的展示取舍，不改变执行准入。

### L077：持仓展示数据不能套用开仓发现的准入门槛

**适用条件：** 已有持仓的展示字段（资金费率、标记价等）复用了为发现新机会而设计的数据源，而这个数据源带有开仓准入过滤（跨所身份证明、白名单、排名截断、开仓暂停）。

**根因：** Monitor 给 CrossEx 的 `opportunities-v2` 只发布在 Binance 有已验证 COIN 永续合约的币种，用来防止同名不同币被配成一对。CrossEx 持仓表的资金费率只从这份行情中取，所以 Binance 没上线的新币（Bybit/OKX 新上的 AXIS）两条腿都没有费率，显示「—」；账户里已结算的资金费照常显示，问题不明显。

**以后做法：** 已持有的合约以交易所账户返回的合约代码为准，按原生合约元数据核验身份后，直接读该交易所的公开数据；开仓发现继续保留跨所身份门槛。持仓侧读取在后台进行，页面读取不等待外部 IO；失败只保留旧值到来源时效截止，不用其他来源补齐。按持仓逐个读取时：并发槽位按单调递增的轮次轮转，不能每轮从列表头分配、不能固定截断列表，也不能按墙钟尝试时间排序（本地时钟回退后同样会饿死尾部）；来源时间落在未来的缓存值不能挡住新读取；全量元数据端点（如 Binance `fundingInfo`）在多个合约间共享短期快照；418/429 在身份解析之前就按交易所冷却，并行请求中任一腿限流都要上报；字段优先级沿用 Monitor 已有口径（Bybit ticker 的 `fundingIntervalHour` 优先于合约元数据）。

**如何验证：** [持仓资金费测试](modules/crossex/tests/position-funding.test.mjs) 覆盖 Monitor 行情不含该合约时仍读到费率、70 个合约慢读取下轮转全覆盖、时钟回退一小时后的轮转与缓存替换、限流暂停不触发身份解析、刷新频率、失败保留期限、并发上限与停止；[资金费客户端测试](modules/crossex/tests/funding-client.test.mjs) 覆盖原生身份、Bybit 周期优先级、`fundingInfo` 一分钟共享、限流冷却及 429 不被并行 503 遮蔽、Lighter 快照与身份无效时不发请求；[工作台嵌入测试](tests/embedded-funding.test.mjs) 从真实入口读取持仓费率。

**证据：** project-aggregation 基线 `8da1d5a` 的 [Monitor 投影](modules/monitor/server/perpetual-opportunities-v2.mjs) 第 50–53 行，以及 CrossEx [旧持仓费率路径](modules/crossex/server/funding-opportunities.mjs)。2026-10-25 用户截图显示 AXIS 两条腿资金费率为「—」，同屏 ORDER 正常；公开接口核实 Binance 没有 AXISUSDT（`Invalid symbol`），而 ORDERUSDT 是 COIN 永续合约，Bybit 和 OKX 的 AXIS 资金费数据正常。两轮独立审查用内存探针复现了调度饥饿（含时钟回退）、列表截断、Bybit 周期、`fundingInfo` 额度、未来缓存值、冷却绕过与 429 被遮蔽等问题，均已修复；对应测试经变异检查，在还原单处修复后失败。

**事件记录：** `crossex-held-funding-binance-gate-20261025`；实际发生日期 2026-10-25（Asia/Shanghai）；不推进全历史复盘检查点。

### L078：服务入口要按 systemd 的真实启动路径验证

**适用条件：** 入口文件用「是否为主模块」决定是否启动，且服务单元、安装器或恢复工具通过符号链接（如 `/opt/project-aggregation/current`）启动它；或部署测试用桩替代了 `systemctl` 与健康检查。

**根因：** Node 按真实路径加载入口，`import.meta.url` 是解析后的发布目录，而 `process.argv[1]` 保留 systemd 给出的 `current/...` 路径。入口用 `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` 比较，经符号链接启动时永远不相等，主块被跳过，进程不报错、以 0 退出。旧的单单元入口 `server/index.mjs` 无条件调用 `runLauncher()`，再用真实路径 `fork` 子进程，所以问题一直没暴露；拆成两个单元后，`ExecStart` 直接指向 `current/server/runtime/main.mjs` 和 `current/server/api/main.mjs`，两个单元一启动就「Deactivated successfully」。`Restart=on-failure` 不会重启退出码为 0 的进程，安装器 30 次健康检查失败后回滚。本地启动、导入检查和 [CI 安装测试](deploy/test-ci-install.sh) 都没覆盖：前两者用的是真实路径，后者把 `systemctl` 和健康检查替换成了桩。

**以后做法：** 由 systemd、安装器或恢复工具启动的入口，主模块判断用 Node 24 的 `import.meta.main`：它按 Node 实际加载的入口判断，经符号链接启动或使用 `--preserve-symlinks-main` 时都成立。不再手写 `argv[1]` 与 `import.meta.url` 的路径比较。只由真实路径调用的部署辅助脚本与开发脚本（`deploy/pipeline/config-files.mjs`、`modules/asset/scripts/prepare-ledger.mjs`、`scripts/*.mjs`、`modules/monitor/tests/*-server.mjs` 测试辅助脚本）暂未改写，改动时一并替换。新增或修改服务单元的 `ExecStart` 时，按单元里原样的路径（含符号链接与工作目录）启动一次入口，确认它真的执行了启动逻辑，而不只是能被导入。部署测试用桩替代 systemd 时，在提交说明里写明真实 systemd 路径未覆盖。

**如何验证：** [入口测试](tests/entry-symlink.test.mjs) 经符号链接发布目录启动运行时、API、启动器和恢复 CLI，各给一项会被立即拒绝的配置，断言退出码为 1 并输出各自的报错；还原修复后，运行时入口以 0 退出，测试失败。

**证据：** project-aggregation 正式版 `3c10039`（PR #57）在服务器 VM-4-13 的在线更新于 2026-10-26 00:20:35（Asia/Shanghai）失败。journal 显示两个单元同一秒 `Started` 后即 `Deactivated successfully`，没有任何 node 日志；更新日志为「服务未在 30 次健康检查内就绪」，回滚后旧版本恢复。本地用 `node <符号链接>/server/runtime/main.mjs` 复现以 0 退出。

**事件记录：** `two-unit-entry-symlink-20261026`；实际发生日期 2026-10-26（Asia/Shanghai）；不推进全历史复盘检查点。

**同类入口补充（2026-10-26）：** 新增 Entropy/Lighter 研究 CLI 的提交前独立审查，在 `tools/entropy-lighter-lab/cli.mjs` 再次发现手写路径比较；专用服务经 `current` 启动会跳过主块。改为 `import.meta.main`，新增 [研究工具真实入口测试](tests/entropy-lighter-cli.test.mjs)，在 Windows 同卷 junction 与 Linux symlink 下检查实际配置输出；Ubuntu CI 另跑真实 systemd 安装/回滚。事件 `research-cli-entry-symlink-20261026`，为同日独立入口，不额外增加规范升级日期计数；没有把本机桩检查描述成 Linux 验收。

### L079：新版发现不能读 CDN 缓存的 latest 接口，手动检查间隔须短于自动间隔

**适用条件：** 更新器先用不缓存的 `github.com/.../releases/latest` 跳转确认最新标签，再读 GitHub API 发布元数据；自动检查固定间隔运行，用户也能手动检查。

**根因：** [发布读取器](server/update-service/releases.py) 发现新标签后读取 API 的 `releases/latest`。该接口返回 `Cache-Control: public, max-age=60, s-maxage=60`，正式版刚发布时 CDN 仍可能给出旧版本，标签比对失败，整次检查记为失败并按 60 秒、120 秒本地退避。另一方面 [更新协调器](server/update-service/updater.py) 的手动最小间隔 60 秒与自动检查间隔相同，自动检查每分钟都会刷新起点，手动点击几乎总落在间隔内，被静默忽略。

**以后做法：** 发现阶段按跳转得到的标签读取 `releases/tags/<tag>`，标签、草稿、预发布等校验不变；执行阶段仍按批准的发布 ID 读取。手动检查最小间隔只用于防重复提交，必须明显短于自动间隔（当前 10 秒），服务器给出的重试期限仍约束所有检查。上次检查失败后（`failureCount > 0`，直到检查成功）手动间隔仍为 60 秒，额度消耗不比改动前更快，但不保证不超额：非 transient 失败会清掉发布缓存，比较失败不缓存，每次失败检查都可能消耗一次匿名 API 请求，按 10 秒连点约 10 分钟就会用完每小时 60 次额度，随后被限流期限锁住最多一小时。

**如何验证：** [发布读取检查](deploy/test-release-cache.py) 覆盖 API latest 仍为旧版时直接得到新版、且不请求 latest 接口，以及按标签读取到的元数据标签不符或仍是预发布时失败且不写缓存；[更新协调器检查](deploy/test-updater.py) 覆盖自动检查后 10 秒手动检查会真正执行，以及失败状态下 59 秒内的手动检查仍被拦下。两个新用例在修复前代码上失败。

**证据：** project-aggregation 基线 `d21a78c`。2026-10-22 用户反馈正式版发布约 3 分钟后才在系统更新中看到，期间手动检查没有反应。实测 API `releases/latest` 响应头为 `public, max-age=60, s-maxage=60`，而 `github.com` 跳转为 `no-cache`。用户服务器的检查状态与日志未取得，3 分钟由两次退避推断，未在服务器复现。2026-10-25 带认证复核：`releases/tags/<tag>` 与 `releases/latest` 同样是 `max-age=60`，按标签读取之所以有效，是因为更新器只在跳转指向新标签之后才请求它，CDN 中没有该地址的旧副本；若别处先读过候选期的同一地址，最坏情况是预发布校验失败一次，按原有退避重试。

**事件记录：** `update-discovery-cdn-lag-20261022`；实际发生日期 2026-10-22（Asia/Shanghai）；关联 L013 的检查节奏，不推进全历史复盘检查点。

**被拒点击须可见补充（2026-11-05）：** 用户反馈检查失败后“检查更新”按钮无论怎么点结果都一样。基线 `82fbdb2`：失败状态下 60 秒内的手动检查被 `check()` 原样返回旧状态，`retryNotBefore` 期间同样；页面不知道这些限制，按钮可点却无任何反馈，且“上次检查”只显示到分钟，60 秒后真正重跑又失败时界面也几乎不变。以后服务端拒绝点击的每条限制都要随状态公开（当前为 `manualCheckAt`，由 `public()` 按与 `check()` 相同的规则计算），页面据此禁用并倒计时，响应未开始检查时给出说明，检查时间显示到秒。验证：[更新协调器检查](deploy/test-updater.py) 断言 `manualCheckAt` 与拒绝窗口一致，[系统更新浏览器检查](tests/updates.browser.mjs) 覆盖倒计时解锁与被拒点击提示。用户服务器上的具体失败模块与原因未取得。事件 `update-recheck-silent-20261105`，不推进复盘检查点。

### L080：自动费率须区分公共费表、账户实付与返佣基数

**适用条件：** 研究、模拟或交易服务自动读取手续费，并据此计算价差收益或渠道返佣。

**根因：** 同一个接口可能同时返回公共费表和特定账户费率。2026-10-27 实测 Hyperliquid 零地址的 `userCrossRate` 为 `0.0004`，而 `feeSchedule.cross` 为 `0.00045`；把前者当默认费率会低估成本。Entropy 官方返佣按自身分成计算，用户另行取得的渠道优惠则可能按全部手续费计算，两者不能互换。直接用最新全局费率重算历史，也会改变已经产生的模拟结论。

**以后做法：** 公共模式只使用官方公共费表及已核验的合约系数，明确标注默认档、无账户折扣和无附加 builder 费用；未知费用不得当作零。为费率记录来源、有效期和语义版本，每次评价及在途任务锁定当时快照；同版本刷新只续来源有效期，版本改变或到期后撤回当前结论并重新收集样本。返佣基数按已确认的渠道条款单独表达，本次 110% / 120% 为用户确认的全部 Entropy 手续费额外返佣，不能推广为官方规则。

**如何验证：** [费率接入测试](tests/entropy-lighter-feeds.test.mjs) 覆盖公共费表与账户字段、费率单位及未知系数；[自动费率测试](tests/entropy-lighter-auto-fees.test.mjs) 覆盖逐标的费率、版本切换、单调时钟到期及历史快照；[生产页面夹具](tests/entropy-lighter.browser.mjs) 覆盖固定两档返佣和下次读取前费率到期时撤回当前结论。

**证据：** project-aggregation 基线 `0de9312` 的研究模块仍要求手填费用。2026-10-27 用户要求自动获取并确认渠道返佣按全部手续费计算；[官方 userFees 接口](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-a-users-fees)、[HIP-3 费用系数](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/hip-3-deployer-actions) 及 [Entropy 官方返佣说明](https://docs.entropy.io/about-entropy/referrals) 与 [接入实现](tools/entropy-lighter-lab/feeds.mjs)、[快照实现](tools/entropy-lighter-lab/core.mjs) 对照核验。

**事件记录：** `entropy-public-fees-and-rebate-basis-20261027`；实际发生日期 2026-10-27（Asia/Shanghai）；不推进全历史复盘检查点。

### L081：暂停研究执行须保留可见的未决敞口与原会话统计

**适用条件：** 行情采集进程内默认运行方向模拟，重启会新建会话；上次有未平任务、未知退出或未清洁结束，需要暂停新的模拟。

**根因：** 仅把旧报告写入备份并给新引擎传暂停标记，仍会创建空持仓、零费用和零净收益的新报告。后台阻断生效，但真实页面不再显示旧敞口、亏损及成交额，用户看到的零值会掩盖尚未确认的结果。默认方向模拟可能运行在 `mode=research`，只检查旧 `mode=paper` 也会漏掉启动后首次五秒写盘前的崩溃。

**以后做法：** 恢复检查跟随实际模拟功能而非总模式名称。暂停执行与保留证据分别处理：不把旧任务装入新引擎，继续投影原会话任务、统计、费率和观测时间，标明来源会话；所有未确认的总净收益及返佣后收益保持未知，已知费用、成交额和逐笔历史保留。连续重启不覆盖最初归档、不递归嵌套报告。正常新会话的指标明确本会话口径，不冒充全历史累计。

**如何验证：** [真实 CLI 重启测试](tests/entropy-lighter-cli.test.mjs) 用带开仓、已平亏损、费用和成交额的报告验证重启后保留原状态，并覆盖首次定期快照前强杀及连续重启；[生产方向页夹具](tests/entropy-lighter-scalper.browser.mjs) 验证旧会话未决与无任务但未清洁结束时净收益未知、历史仍可见。

**证据：** 基于 project-aggregation `fea7af6` 的本次未发布剥头皮实现，2026-10-27 独立审查用真实 CLI 复现归档保留但页面投影 `openTasks=0/fees=0/turnover=0/net=0`。修复后连续两次重启保留原 `openTasks=1/completed=2/fees=0.15/turnover=300/settledNet=-3`，净收益及返佣后净收益保持 null；见 [恢复投影](tools/entropy-lighter-lab/cli.mjs) 与 [审查记录](docs/reviews/2026-10-27-binance-depth4-scalper.md)。不是基线正式版的逃逸缺陷。

**事件记录：** `scalper-restart-unresolved-visible-evidence-20261027`；实际发生日期 2026-10-27（Asia/Shanghai）；不推进全历史复盘检查点。

### L082：交易所合约类型白名单须覆盖实际上线的品类

**适用条件：** 执行端按交易所合约元数据（如 Binance `contractType`、OKX `instType`）筛选可交易合约，而行情或监控端已在交易同一批合约。

**根因：** 基线 `80beef4` 的 [执行适配器](server/trading-execution-exchanges.mjs) 只接受 Binance `contractType=PERPETUAL`；原油 CL/BZ 与海力士合约在 Binance 属于 `TRADIFI_PERPETUAL`（[监控模块](modules/monitor) 代码与测试按此类型读取）。执行端于是把全部 Binance 原油腿判为合约规则无效，实盘预览无法通过，而离线测试的模拟规则一直使用 `PERPETUAL`，没有暴露。

**以后做法：** 新增或扩展执行品种时，以已在本仓读取同一合约的模块（行情、监控、只读台账）实际使用的类型为准核对白名单，并在执行适配器测试里用真实类型值构造规则；不能仅凭通用永续字段值推断。本机无法访问的交易所接口（Binance 451、Bybit 地域屏蔽）须在提交说明中登记为待核实。

**如何验证：** [执行适配器测试](tests/trading-execution-exchanges.test.mjs) 的 TradFi 用例验证 `TRADIFI_PERPETUAL` 规则可交易、账户只读取所选符号。

**证据：** project-aggregation 基线 `80beef4` 的 2026-10-28 实盘就绪审计发现；为未投入实盘的已发布路径缺陷，修复随海力士执行接入一起提交。

**事件记录：** `binance-tradifi-contract-type-20261028`；实际发生日期 2026-10-28（Asia/Shanghai）；不推进全历史复盘检查点。

### L083：异步任务过期后，锁归属与结果提交须一起校验

**适用条件：** 使用有过期时间的数据库锁串行化外部读取、账本同步或人工编辑，任务可能超过锁期限。

**根因：** 锁过期只允许新任务进入，不会停止旧任务。旧任务按业务 owner 无条件解锁会删除新锁；即使解锁加 token，旧任务仍可能将开始时读取的整份旧数据覆盖到新版本。

**以后做法：** 分别验证锁归属和提交资格。锁使用唯一 token/代次，释放只影响原锁；长任务有续租或有界截止。提交时，原锁代次及数据/凭据版本校验与写入须在同一短事务或 CAS 中完成，成功结果、错误状态和快照均受约束，失去资格的迟到结果不得写回。客户端取消不等于服务端已停止，不能仅靠延长固定 TTL 消除竞态。外部调用不放入长数据库事务。

**如何验证：** 用虚拟时间和隔离 SQLite 走实际同步/删除路径：旧刷新越过 TTL，新操作删除账号并取得新锁，随后旧刷新返回；删除结果应保留，新锁仍有效。另覆盖新增账号、凭据替换、失败清理和总截止。只测 lock/unlock 不足以证明业务写入不会覆盖。

**证据：** project-aggregation `37cb9e2947801c39c7432606302b5e5f4407e433` 的 [store.ts](modules/asset/lib/store.ts)；2026-10-30 两次独立离线探针确认 120 秒后新删除可被旧刷新覆盖，旧 finally 还能删除后来取得的锁。真实刷新使用 10 账号、并发 3 的有界外部阶段即可超过 TTL。见 [Issue #87](https://github.com/hxx344/project-aggregation/issues/87) 及[审查报告](docs/comprehensive-audit-2026-10-30.md)。最初登记时尚未修复；随后 PR #112 的 `0383110`、`7ff32c9` 补齐 token、续租、事务内提交校验和续租异常处理。2026-10-31 在 `4e19cfd` 复核相关写入口与定向测试通过，补充同一事件的修复证据，不新增事件。凭据未被恢复，不声称线上事故或资金移动。

**事件记录：** `asset-expired-sync-writer-20261030`；离线复现日期 2026-10-30（Asia/Shanghai），实际线上发生日期未知。两次复核属于同一事件，不重复计数，不推进历史复盘检查点。

**自动减仓失败写回补充（2026-11-07）：** ANT 规则读取风险期间若执行租约被新实例接管，旧实例的 catch 仍按原规则版本累计失败，可把两次失败增加到三次并停用接管者的规则。失败处理与成功提交一样必须在写事务内重新核验执行所有权，不能只比较配置 revision，也不能把事务外同步检查视为跨进程原子保护；无触发时清理失败和任务终态写回采用同一边界。[自动减仓集成测试](tests/trading-anthropic-reduction.test.mjs) 在真实执行器账户读取挂起时转移 `execution_lease.owner`，断言旧实例返回后持久规则逐字段不变；该用例修复前实际失败，修复后通过，独立探针另核对三条内部写回的归属检查与 UPDATE 均在事务内。事件 `ant-reduction-late-owner-failure-20261107`，独立审查在发布前发现；未发生真实交易。

### L084：本地否决重试的减险单须有独立上限，且不能共用开仓的发送条件

**适用条件：** 发送前守卫（新鲜度、代次、额度）会否决订单，且被否决的是补偿、平仓等减险单，或否决后会退还尝试次数。

**根因：** 退还次数保证了本地否决不占用交易所尝试额度，但也让这条路径失去上限：依据持续失效时，减险单一轮轮规划又被否决，敞口一直开着，同时持续新增补单与回执。开仓和补偿共用同一套新鲜度条件时，只影响下单数量上限的 BBO 过期也会挡住减险。

**以后做法：** 退还尝试次数时另设连续否决计数，达到上限转人工，真实进入发送边界或人工重试后清零。按用途区分发送条件：减险单只核对决定数量的账户依据，开仓才要求报价新鲜。本地否决用短重试，不走交易所拒绝的指数退避。

**如何验证：** 用真实写入器和模拟网络让每轮补单都丢失依据：断言次数有上限、暂停后不再新增补单、人工重试后能发出；交易所拒绝和成功发送都能清零计数；只有报价过期时补单仍能发出。

**证据：** project-aggregation PR #115 的 [execution.py](modules/aster/trading/execution.py) 与 [test_open_final_freshness.py](modules/aster/tests/test_open_final_freshness.py)；2026-10-30 独立审查发现首版退还次数后重试无上限，复审发现真实发送异常时计数不清零。

**事件记录：** `aster-repair-basis-unbounded-20261030`；审查阶段发现，未合入，未发生线上事故。

### L085：推迟不等于未改变，目标不可用时须撤销旧的成功记录

**适用条件：** 流水线或任务阶段可能以“推迟 / 跳过”结束，状态文件按阶段保存上次结果，同时整轮提交号会前移。

**根因：** 把推迟当成“本阶段不动”时，前面阶段已把状态的提交号改成新版本，旧的成功记录留在原处，查询结果就成了“新提交 + 阶段成功”，而该提交从未生效。整轮状态也仍报成功。

**以后做法：** 区分“本轮不需要做”和“目标不可用、本轮未生效”。后者删除该阶段的成功记录，并让整轮状态如实显示推迟；退出码按是否失败单独决定。

**如何验证：** 先让阶段成功，再让目标不一致并强制重跑：断言阶段记录已删除、整轮状态为推迟、状态提交号是新提交。退出码回归要走真实入口，不只测内部函数，例如 `stack_main` 的 75。

**证据：** project-aggregation PR #114 的 [cli.mjs](deploy/pipeline/cli.mjs) 与 [pipeline-activate.test.mjs](tests/pipeline-activate.test.mjs)；2026-10-30 独立审查发现首版 `status` 显示“新提交 + activate ok”。

**事件记录：** `pipeline-deferred-stale-success-20261030`；审查阶段发现，未合入，未发生线上事故。

**系统配置副作用补充（2026-10-31）：** PR #114 的 `d127de8` 修掉成功记录残留，但生产 `--apply` 在 activate 之前已经把配置写入 `/etc/project-aggregation.env`。目标不匹配返回 75 后只标 deferred，没有调用已有 config 补偿；旧程序和部署记录保留，新配置却留在系统中。真实 CLI 的 Windows 离线夹具复现 `PORT=3100→3200` 后 activate deferred，配置仍为 3200。目标不可用时也须处理之前阶段已执行的配置副作用，或延后应用配置；验证覆盖 config+activate 联动，不能仅给 activate 配测试。事件 `pipeline-deferred-applied-config-20261031`，引入于 2026-10-30，离线复现于 2026-10-31，线上发生日期未知；见[审查报告 F03](docs/reviews/4e19cfd237fb0d047686f2297a0c5e1007b70950.md)。随后 `1e5b91d` 在目标不可用时恢复本轮配置，补偿失败和记录失败明确非零退出且不重复补偿；activate 16 项和 recovery 35 项本地通过，1 项 POSIX 等本次 CI。原发现属于合入后的 P1 逃逸缺陷，修复属于同一事件。

**中断恢复补充（双槽安装，#177，2026-11-05）：** 安装器切换 API 槽中途被中断时，恢复依据必须保存“来源槽身份、原回滚目标与切换方向”，不能事后从 `current` 推断：晋升前崩溃时 `current` 已是候选版本，按它推导会把候选当作旧版本、冗余再切一次槽，并让回滚跳过真正被替换的版本；反向回滚中断时日志来源是失败候选，不区分方向就会把它登记成回滚目标。做法：切换日志记录 `intent` 与原 `previous`；正常与恢复路径都在删除切换日志前持久化 `previous`，整体激活另记 `.pending-previous`；磁盘上明确没有 `previous` 时同步清空内存变量；ERR trap 里的回滚函数显式 `return $?`，否则成功回滚仍返回原错误码而误报失败。测试固定写死期望槽位与回滚目标、要求切换恰好一次、真实改动单元与环境文件后再验证恢复，不从实际结果推导期望。验证见 [双槽 main() 夹具](deploy/test-ci-install-dual.sh)；本地仅 Windows Git Bash 兼容运行，真实 systemd 由 CI 覆盖。首次安装硬中断与 CI 时限余量见 issue #185。回滚收尾清理恢复记录时，只能删本轮自己写的记录：续作时 `current` 已是候选，回滚只能“恢复”到候选本身，继承来的 `.pending-previous` 是被替换版本的唯一副本，删掉就退回 #177 的错误回滚目标（合入后由 `0b2ea19` 引入、复核发现，验证见双槽夹具“续作再失败”场景）；而本轮新写的记录必须删，否则只改配置失败恢复后下次无变化更新会多重启一次（`test-incremental.sh`）。

**恢复记录的两个边界（#185、#191，2026-11-05）：** 其一，恢复依据还要区分“从未成功过”：首次安装切换 `current` 后、保存 `.last-successful.env` 前被强杀，只留下自己的 `<候选> - full` 记录，此后每次重试都因缺少环境快照在切换前拒绝。做法：记录目标即 `current`、`previous` 为 `-`、没有快照、`previous` 链接和只在成功时写入的 `.deployed-state` 时按首次安装重试（曾成功过但快照被删的主机仍拒绝），清空旧版本与单元备份，失败时同时移除该候选的 `current` 和单元，配置与数据保留。其二，换版本覆盖继承的记录后失败，回滚回到未完成的版本，它仍需要那份记录：回滚时写回继承记录，而不是删除，否则再退回该版本时 `previous` 会跳过真正被替换的版本。续作失败仍只恢复到候选本身，不退回继承记录里的旧版本：此时单元备份与环境快照可能已是候选写入的，退回旧版本得不到一致的旧状态。剩余边界：换版本的那次运行若在覆盖记录后被强杀，继承记录仍会丢失。验证见双槽夹具 11（换版本再失败）与 12（干净首装）与 12a（初装中断、有成功记录时仍拒绝、失败重试、换版本在移动 `current` 前失败、再次中断后成功，数据目录不变）；两场景及新增断言在基线 `e4c86b0` 上分别失败（记录被删、重试被拒），修复后通过。事件 `install-first-interrupt-20261105`、`install-pending-overwrite-20261105`，审查登记，未发生线上事故。

### L086：缓存核验要用与安装器相同的就绪标准，存活不等于就绪

**适用条件：** 部署缓存、回滚或恢复逻辑用探测结果决定“跳过”还是“重新安装”，且系统有多个进程，存活端点与就绪端点含义不同。

**根因：** #93 让缓存命中后重新核验运行态，但流水线只查 `/api/health`。这个端点由 API 单元直接返回 200，不经过 runtime，安装器却早已用 `/api/ready`。runtime 失联时缓存核验仍通过，恢复被跳过；修复用的夹具不区分路径，所以测试也没发现。

**以后做法：** 决定“能否跳过”的探测必须与安装器的成功标准一致，不要各写一份端点。夹具要按路径模拟不同端点，探测路径取自生产配置，不在测试里另写一份。

**如何验证：** 夹具让存活端点返回 200、就绪端点返回 503，断言缓存不算成功且回落到安装器；再把生产配置改回存活端点，确认用例失败。

**证据：** project-aggregation PR #114 合入后的 [prod.json](deploy/pipeline/environments/prod.json) 与 [pipeline-activate.test.mjs](tests/pipeline-activate.test.mjs)；2026-10-30

**事件记录：** `pipeline-revalidate-liveness-20261030`；外部审查发现 #93 修复不完整，属合并后发现的 P1 逃逸缺陷。

### L087：文件锁缺少 owner 元数据不等于锁已陈旧

**适用条件：** 先创建锁目录，再写 owner/PID 文件，多个真实进程可能竞争同一资源。

**根因：** 创建目录与写 owner 不是同一步。第二个进程把缺失 owner 当成旧锁删除，两个进程均继续执行；释放时无 token 校验又会删掉后来持有者的锁。

**以后做法：** 将“锁存在但归属尚未可读”作为占用或待核实状态，回收须有可靠的陈旧证据。采用原子发布/回收并绑定唯一归属 token，释放仅影响自己取得的锁。PID 存活校验无法弥补 owner 尚未发布的窗口。

**如何验证：** 在目录创建与元数据写入之间暂停第一个真实进程，启动第二个；必须最多一个进入受保护操作。再覆盖一个实例退出时另一实例的有效锁不能被删除。仅串行调用 acquire/release 不足。

**证据：** project-aggregation `53d9d423` / PR #99 的 [acquireLock](tools/aero-lp/cli.mjs)；`4e19cfd` 上两个未修改 CLI 入口（managed 与独立 run）、零余额外部读取夹具和调度屏障复现同时进入 cycle，一方退出后仍运行者的锁消失。见[审查报告 F02](docs/reviews/4e19cfd237fb0d047686f2297a0c5e1007b70950.md)。随后 `b947934` 以共享 guard 串行化创建/回收/释放，并核对唯一 token；真实 CLI 竞争、坏 owner/guard、旧释放和正常停止回归通过。未发送链上交易，不声称实际资金损失。

**事件记录：** `aero-lock-owner-publication-20261031`；引入日期 2026-10-30，离线复现日期 2026-10-31（Asia/Shanghai），线上发生日期未知；P1 逃逸缺陷。

### L088：不同假设下的份额估计不能直接相加为总额

**适用条件：** 逐头寸估计使用“该头寸加入共享池子后”的分母，再把估计值合计展示。

**根因：** 每仓分别只把自身加入活跃流动性，得到互不一致的情景；多个同时进入的头寸共享分母却被重复忽略。逐项有限不代表合计仍受全池排放约束。

**以后做法：** 明确共同价格/时间情景，在同一活跃集合和分母下计算可聚合值；不能形成共同情景时标为逐仓独立估计，不展示可相加的总额。保持全池排放等自然上界。

**如何验证：** 两个同下沿区间外头寸同时进入，核对合计等于共同分母的结果且不超过全池排放；另测一个区间内一个区间外、不同下沿和缺失估值。

**证据：** project-aggregation `8a0fcb6` / PR #104；[emissionPerDay](tools/aero-lp/core.mjs)、[rewardView](tools/aero-lp/cli.mjs)、[dailyFact](src/AeroLpPage.tsx)。`4e19cfd` 离线计算中当前流动性100、两仓各200，全池86400 AERO/天，页面合计115200，共同情景应为69120。见[审查报告 F04](docs/reviews/4e19cfd237fb0d047686f2297a0c5e1007b70950.md)。随后 `b947934` 提供共同情景合计并采用 BigInt 精确求和/比较，`199631a` 同步飞书摘要；相同下沿、大额原始单位和不可聚合情景回归及页面验收通过。仅展示影响，沿用同一事件。

**事件记录：** `aero-incompatible-reward-sum-20261031`；引入日期 2026-10-30，离线复现日期 2026-10-31（Asia/Shanghai），线上发生日期未知；P1 逃逸缺陷。

### L089：写操作也必须使之前的在途读取失效

**适用条件：** 表单页面同时轮询状态和保存配置，GET 使用代次丢弃旧响应。

**根因：** 只有下一次 GET 增加代次，保存未使旧 GET 失效。保存成功后草稿变干净，旧 GET 迟到会同时覆盖快照和草稿，页面显示旧配置且没有未保存标记。busy 只阻止新请求，不影响在途请求。

**以后做法：** 将写入纳入读取代次/取消协议，保存确认后只接收不早于本次写入的读取；保留用户在保存期间继续编辑的草稿。不要用后续轮询最终会修正代替竞争保护。

**如何验证：** 保持保存前的 GET，完成 PUT 并等待新 UI 渲染，再返回旧 GET；已保存值、启停状态与草稿标记应保持正确。另测保存失败、保存中继续编辑和后续真实刷新。

**证据：** project-aggregation PR #119 的 [FeishuDigestPage](src/FeishuDigestPage.tsx)。`4e19cfd` 生产构建的真实浏览器夹具复现服务端 NEW、页面 NEW→OLD、保存按钮禁用；[AeroLpPage](src/AeroLpPage.tsx) 写操作前递增 generation 是同类负对照。见[审查报告 F05](docs/reviews/4e19cfd237fb0d047686f2297a0c5e1007b70950.md)。随后 `199631a` 将写操作纳入读取代次，并显式保留保存期间新编辑（含改回旧值）；生产页面 6 场景通过，未向真实飞书发送。

**事件记录：** `feishu-save-stale-read-20261031`；引入日期 2026-10-30，离线复现日期 2026-10-31（Asia/Shanghai），线上发生日期未知；P1 逃逸缺陷。

**离线恢复补充（#275，2026-11-09）：** 基于 `c042116` 的未发布仓位保护覆盖实现，在离线时仅用 `offline` 暂时遮住旧结论，联网事件先清该标记再发新 GET。独立浏览器探针确认：离线期间另一客户端停用规则，重连请求尚未返回时，原有效期内的状态从 unknown 回到 ready，回包后才变为 disabled。对因离线或操作变化已撤销的可用性结论，应保留独立失效标记，只由新响应成功清除；网络恢复只恢复读取资格。`tests/trading-anthropic-protection.browser.mjs` 挂起重连 GET，在修复前失败、修复后通过，旧检查时间保留且等待新证据；显示状态从未授权执行，原执行器仍独立核验账户、租约和风险。事件 `ant-protection-reconnect-unconfirmed-20261109`，P1 在首次发布前修复，未发生交易或线上事故，不推进历史复盘检查点。

**跨组件敞口读取补充（#284，2026-11-09）：** `0243193` 后的未发布实现中，父组件保存开始时增加自身 GET 代次，子组件的敞口版本却只在写响应返回后更新。独立生产页面探针复现：服务端已保存 2 桶、写响应挂起，旧敞口响应随后把 1 桶显示出来。父组件提交开始即撤销传给子组件的可用版本，子组件清空结果并中止旧请求；明确失败恢复旧版本也不能复活已撤销结果。`tests/trading-auto-exposure-write-race.browser.mjs` 保留同一交错，修前 oldExposureShown=true、修后 false，保存仍在等待，恢复版本不自动读取。事件 `auto-exposure-pending-write-stale-read-20261109`；P1 在首次发布前修复。

### L090：防重复发送的持久化占用不能降为尽力记录

**适用条件：** 通过发送前持久保存时间点或操作身份，承诺崩溃重启后不重复对外发送。

**根因：** 发送前写失败被吞掉，仍对外发送；旧标记保留在磁盘，发送后也未落盘或期间崩溃时，重启把已发送操作当作漏发重试。

**以后做法：** 区分发送前的持久化准入与发送后的历史记录。前者失败就不得发送，并保留恢复后重试资格；后者是否允许尽力写按产品契约决定。不得以进程内已经更新变量替代持久化成功。

**如何验证：** 先保存旧标记，再令新标记和发送结果记录写失败，恢复旧磁盘状态并在补发窗口重启；确认失败时没有对外请求，或按明确语义避免重复。补正常重启和结果未知不重试的负对照。

**证据：** project-aggregation PR #119 的 [persistState/tick](server/automation/feishu-digest.mjs)。`4e19cfd` 真实 manager 的本地 fetch 替身、临时文件原子替换失败探针复现发送1次→重启后2次，见[审查报告 F06](docs/reviews/4e19cfd237fb0d047686f2297a0c5e1007b70950.md)。随后 `199631a` 严格保存发送前时间点，失败保留重试资格；计划配置的第二次写失败恢复旧水位，恢复也失败时明确提示。真实文件故障与重启回归通过；没有真实通知或资金动作，沿用同一 P2 事件。

**事件记录：** `feishu-failed-durable-claim-20261031`；引入日期 2026-10-30，离线复现日期 2026-10-31（Asia/Shanghai），线上发生日期未知。

### L091：新增异步历史查询后，最终恢复判定不能沿用查询前的现场

**适用条件：** 恢复确认先读取当前仓位/挂单，再新增可能耗时或分页的历史查询，随后据此解除未知状态。

**根因：** 历史读取完整性提高了，但最终决定仍使用等待前的现场。运行租约和本地订单状态只证明本地归属，不能证明期间交易所仓位或活动策略没有变化。

**以后做法：** 完成历史查询后再取得最终判定需要的当前证据，保留原账户身份、租约及操作约束。所有额外等待仍须有界；不能把用户确认或后续重新预览当作旧未知单已被正确认定的证据。

**如何验证：** 在历史查询等待中改变仓位、挂单或活动策略，最终确认必须拒绝并保留 unknown；正常无变化仍可完成。核对共享写入记录与本地订单同时保持未决，而不只断言页面文案。

**证据：** project-aggregation PR #116 的 `127c06f`、`6cc5c09`，[confirmNotCreated](server/trading-execution.mjs)。`4e19cfd` 真实服务、SQLite、共享 writer 夹具中，查询期间 SHORT 从0变1，仍输出 settled=true、unknown=false、canResume=true；见[审查报告 F01](docs/reviews/4e19cfd237fb0d047686f2297a0c5e1007b70950.md)。随后 `d201d78` 将最终账户读取移到历史查询后，复核 revision/unknown 并保留原租约与 writer 保护；44 项相关检查通过。后续预览/确认仍存在，不声称已证明重复实盘下单。

**事件记录：** `bybit-history-stale-account-proof-20261031`；引入日期 2026-10-30，离线复现日期 2026-10-31（Asia/Shanghai），线上发生日期未知；P1 逃逸缺陷。

**同轮规则调度补充（#283，2026-11-09）：** 基于 `0243193` 的只观察实现只在整轮读盘口后检查维护及领导权；前排实盘规则随后等待私有预检，期间进入维护，后排观察规则仍记录本会触发信号。每条规则处理前重新检查当前运行边界，变化则统一清零并等新盘口；观察分支不会经过实盘 commit，不能依赖 commit 守卫替它兜底。`tests/trading-auto.test.mjs` 的 `observation behind an awaiting live rule` 在修前维护场景新增错误 signal，修后维护及领导权变化均为零；独立探针另验证恢复后旧盘口不计数、新盘口恢复。事件 `auto-observation-between-rules-boundary-20261109`；为首次发布前的观察正确性 P1，没有绕过真实下单守卫。

### L092：私有日志跳过未知请求时，必须同时安排共享写入的结算出口

**适用条件：** 私有日志因余额或配置变化把一笔结果未知的写入归档为跳过、放弃或人工归档，而共享准入库仍为同一请求保留 `unknown`，并且这类 unknown 会阻止后续同类写入。

**根因：** [保证金平衡](modules/aster/trading/margin_balance.py) 的 `_reconcile` 把 `unknown` 待核对直接交给 `_resume_unknown`。后者按新余额归档为 `skipped` 并清除私有 pending，但没有结算共享库中的 `aster:transfer:<request_id>`。未知的保证金划转不属于 `_margin_compatible` 的豁免动作，此后同一组账户的每次划转都以 `ACCOUNT_UNRESOLVED` 拒绝，且没有自动出口。原测试把“新余额后仍保持 unresolved”当成预期，因此没有发现这个缺陷。

**以后做法：** 交易所的请求有效期（Aster v3 nonce 前后 60 秒）是比流水更强的证据：过期后原请求不可能再执行，余额才是事实来源。结算出口按过期设计，不按"证明未送达"设计：

- **过期时刻**：从共享行最后更新时间起算（它晚于发送尝试结束），加 nonce 窗口和时钟容差，不从本地记录的创建时间起算。共享行仍为 `sending` 时，至少从跳过时间起算；备份恢复把 `sending` 转为 `unknown` 时刷新最后更新时间。窗口来自文档时写明未经实盘验证。
- **结算**：私有日志跳过时写入结算待办。过期后读一次流水只打标签：一一对应为 confirmed，否则 rejected，读取失败也照常结算。标签先持久化再结算。本地额度等待或限流只推迟标签，且有上限。不能用"失败上限后转人工"作为出口，否则任一笔流水异常都会永久卡住该组账户。
- **扫描**：按共享库里本组可见的同类行扫描，覆盖没有待办的 unknown 旧行、待办损坏和崩溃遗留；只在没有私有 pending 时进行，避免触碰进行中的写入。没有待办的 `sending` 行不碰。有未到期的行时写入持久标记，保留主账户连接与配对保护；干净时才节流。
- **准入**：已过期的同模块 unknown 划转不再挡同组账户的任何写入（含普通下单）；新划转不受任何已过期同模块 unknown 阻止；普通下单仍受非划转 unknown 阻止。两种语言的准入实现同步改，各自测试，时间作为参数传入而不在校验中途重读。
- **回执与状态**：回执在共享结算之后才登记为已用；待办期间页面如实显示阻止交易；结算当轮不规划新写入；平衡关闭或暂停时结算仍运行，待办或标记未清空前禁止删除配对或更换原主账户配置。新增待办保留上一版本要求的字段，确保可回滚。

**如何验证：** [保证金托管划转测试](modules/aster/tests/test_managed_margin_transfer.py) 断言共享库状态：
- 时机与发送：只按本地记录老化时不结算；共享行过期前不读流水，过期后一次读取即结算（含 writer 重启），冷却后只发一次新划转。
- 标签：迟到回执 confirmed；读取失败、无法解析、满页无法拆分、冲突回执、身份变化都在一次读取内结算为 rejected 并留审计。
- 推迟与重试：限流推迟标签，超过上限后仍结算；结算失败后重试不再读取。
- 扫描与标记：`sending` 行从跳过时间起算；没有待办或待办损坏的 `aster:transfer:*`、`aster:legacy:pair_margin:*` 行由扫描结算，其它前缀不动；扫描标记在关闭平衡后仍保留保护并结算。
- 关闭平衡：仍结算，且删除配对先被拒；关闭或干净的配对不会每轮绑定主账户。

[Python](tests/test_account_writer.py) 与 [Node](tests/account-writer.test.mjs) 准入测试覆盖：只按创建时间老化仍挡；过期前仍挡，过期后放行划转与普通下单；过期的其它写入仍挡；其它模块的行仍挡。变异对照确认测试会失败，包括：过期窗口置 0、准入规则失效、只结算 `unknown`、只按创建时间计算过期、关闭限流推迟或推迟无上限。

**证据：** 第一版（`5f89be4`，PR #129）经三轮独立审查，按流水有界核对，核对不出时转人工；`f30b4aa`（PR #134，L093）补充了存在性证据与分段读取。用户随后要求"彻底不需要人工核对"，于是改为按 nonce 过期结算，并补上扫描和准入放宽。2026-11-02 服务器运行 `fc56fd5` 时，xag 配对组 `aster:transfer:b7922430…` 于 06:52 UTC 超时未知，随后被私有日志跳过。06:56 起每次划转都被 `ACCOUNT_UNRESOLVED` 拒绝，两侧可用余额差 3111.87 USD1。用户备份 `execution-control.sqlite` 后手工将该行设为 rejected，划转即恢复。

**事件记录：** `aster-margin-skip-shared-unknown-20261102`；线上发生日期 2026-11-02（UTC），是 L039 有界恢复与 L062 共享准入恢复在“跳过”分支上的遗漏，单独计为一次事件。

### L093：“查无”结论须排除不完整读取与已见反证

**适用条件：** 恢复逻辑依据外部历史中“没有某条记录”自动结算一笔结果未知的写入（例如判为 rejected），而这些历史读取可能被截断、含无法解析的行，或此前已读到过部分回执。

**根因：** [保证金平衡](modules/aster/trading/margin_balance.py) 的 `_settle_skipped_records` 只统计空读次数：部分回执只计失败，不清空读计数，也不保存回执，于是“空→部分→空”在未达失败上限时即判 rejected。`_receipt_matches` 把缺少 `tranId`、时间或金额无法解析的 USD1 划转候选直接跳过，无效流水也成了空读证据。`_income` 只读一页 `limit=1000`，活跃账户的手续费、成交流水占满一页后永远无法完成核对。

**以后做法：**

- 读到的部分或冲突回执写入持久证据，读取中途失败时已读完的页同样提取证据；有证据后空读只计入有界失败，确认要求同一回执两侧齐全且与证据一致，否则达到上限后转人工。新增字段前写入的待办若已有失败，迁移时把空读计数归零。
- 只有能明确归类为其他资产或类型的行可以排除；候选行缺编号、时间或金额无法解析时，按读取不完整处理，不增加空读计数。
- 拒绝所需的空读必须连续：中间任一实际失败的读取都会让空读计数归零。本地额度等待和服务端限流不计失败，并继承接口冷却截止时间。
- 单页满额时按时间窗拆分（两半共享中点，兼容 endTime 含或不含端点，完全相同的行去重），每个账户的请求次数有上限；超过上限，或时间窗不超过 2 毫秒仍满页时，按读取不完整处理。

**如何验证：** [保证金托管划转测试](modules/aster/tests/test_managed_margin_transfer.py) 用真实 ManagedWriter、SQLite 与 MockTransport，覆盖以下场景：空→部分→空跨重启不结算；部分后同一回执两侧齐全时 confirmed，换成另一回执时冲突；缺编号、时间无效、类型无法分类、金额无效；空→失败→空；一侧读到回执、另一侧失败；旧格式待办迁移；999/1000/1200 行分页及中点两种端点约定；满页无法拆小时达到分段上限、2 毫秒时间窗仍满页、证据超过上限转人工；分页中途失败；本地额度与 429；`empty==2` 后共享结算失败或进程退出再重启；legacy 前缀单独存在、与标准前缀并存，以及两者之间失败。对照验证：逐项去掉保护后，对应测试均失败。

**证据：** project-aggregation Issue #130/#131/#132，基于 `5f89be4` 的定向复盘静态确认；本次修复在 `fix/aster-transfer-settlement`。没有真实账户、划转或交易所异常数据，两次空读所依赖的交易所流水覆盖与延迟上界仍是本地常量，未经外部契约核实。

**现状：** 未知划转现已按 L092 过期结算，"查无"只决定审计标签，不再决定结算，存在性证据和转人工已移除。不完整读取的判定（无法分类或解析的候选、分段上限、2 毫秒满页）与分段读取仍然有效：这类读取标为"流水暂不可读"，不标为"两侧均无"。限流时标签最多推迟 300 秒，之后标为"流水暂不可读"。

**事件记录：** `aster-margin-absence-evidence-20261102`（P1，引入日期 2026-11-02）；`aster-margin-income-coverage-20261102` 与 `aster-margin-settlement-recovery-tests-20261102` 是同一恢复链的覆盖缺口，均为 L092 修复后的后续问题；线上发生日期未知。

**部分回执补充（#130，2026-11-05）：** 过期结算后，部分回执仍须持久保留：标签与绝对 `cooldown_until` 在共享结算前同次落盘，部分回执冷却 300 秒（普通 30 秒），重启沿用原截止时间；无待办扫描的补审计信息也在共享结算前写入 `unsettled_transfer_audits`。confirmed 只接受同一轮读取中两侧完整匹配：跨轮拼出的两侧证据可能分属前一笔同额划转，只能记为部分回执；无原交易编号时，早于创建时间的旧回执也不能用于确认。多条待办逐条剔除无效记录，不能因一条无效清空整表，过滤结果与扫描保护标记同次持久化。空白资产或类型字段按读取不完整处理。写入新证据时同步清零旧空读计数，保证回滚到 `f30b4aa` 后旧校验仍接受。残余（issue #184 部分缓解后）：发送前快照两侧流水，已存在的同额回执在结算时排除；两侧都有回执且任一侧同额候选多于一笔时记 `nonce_expired_ambiguous_receipt`，不 confirmed，冷却 300 秒；只有一笔候选时仍记 confirmed，但写归属备注并冷却 300 秒，创建后的外部同额划转仍可能被误标（审计归属错误）；某侧没有快照时沿用旧规则并备注“缺少发送前流水快照”。快照只传 `startTime`、不传 `endTime`，Aster 的实际行为未经实盘验证；300 秒不是交易所到账保证。验证见 [托管划转测试](modules/aster/tests/test_managed_margin_transfer.py)，含冻结的 `f30b4aa` 校验与 SQLite 故障注入；五轮独立审查以内存探针复核，没有实盘证据。

### L094：更换凭据前先持久撤销旧运行意图，再发布新凭据

**适用条件：** 凭据与“重启后是否自动运行”分别保存在不同文件，彼此之间没有跨文件事务；更换凭据时需要同时撤销旧的运行意图。

**根因：** [Aero LP 管理器](server/automation/aero-lp.mjs) 的 `setKey` 先原子替换 `wallet.json`，再写 `control.json` 的 `enabled=false`。fault 状态（重启预算耗尽、无子进程）下磁盘仍是 `enabled=true`。第二次写入单独失败或进程在两次写之间中断，就会留下“新钱包 + 旧 enabled=true”，工作台重启后 `initialize` 用新钱包自动启动签名进程。原测试只覆盖两次保存都成功的情况，内存中的 `enabled=false` 保护不到之后的新进程。

**以后做法：** 多文件持久状态没有事务时，按“任何失败或中断点留下的组合都安全”排列写入顺序：先持久撤销运行意图，成功后才发布新凭据；撤销失败时不写凭据，并把内存状态恢复为与磁盘一致，接口如实说明未更换。撤销已落盘而凭据写入失败时，清掉承诺“稍后自动启动”的故障或隔离提示，页面显示与重启后一致的停止。清除凭据、启动等写运行意图的同类路径同样保证失败后内存与磁盘一致。读钥失败或读空时撤销运行意图也一样：落盘成功才在内存生效，写失败时内存恢复为磁盘值、状态显示故障并写明“停止设置保存失败”，不承诺已停止；可能在定时器里执行的路径不抛出持久化异常。不要靠“换钥时自动启动”或放宽恢复、维护准入来修。

**如何验证：** [Aero LP 工作台测试](tests/aero-lp-workbench.test.mjs) 在真实 manager 的 fault 状态下，用占据 `*.tmp` 路径的目录分别让控制文件或钱包文件的写入失败（原文件保持有效，等价于 ENOSPC），再以新 manager `initialize`：控制写失败时新钱包不落盘、内存与磁盘都保持 `enabled=true`、重启只恢复原钱包；钱包写失败（也是两次写之间中断后的磁盘状态）时保持停止、重启 launch 为 0、原凭据仍可解密并能显式启动；隔离恢复期间钱包写失败后显示停止、准入恢复也不启动，告警日志不含私钥；启动保存失败时内存保持原值（含 fault 下仍为 `enabled=true`）；钱包 rename 失败后不遗留新密文的临时文件；读钥失败、读空两条分支在控制文件写失败时连续重启都不 launch、内存与磁盘都为 `enabled=true`、错误提示保存失败，自动重启定时器路径不抛未捕获异常。把写入顺序改回旧版、去掉内存恢复或提示清理，对应测试都会失败。

**证据：** Issue #128 静态审查确认引入于 PR #99 的 `52370d0`；独立审查另指出隔离恢复期间钱包写失败后页面仍承诺自动启动（P2），以及 `start` 保存失败时内存与磁盘相反，均在合并前修正；2026-11-03 修复时离线复现并验证，未运行签名或链上交易，不声称发生过真实重启或资金损失。Issue #160（读钥失败后停止意图写盘失败）2026-11-05 离线复现：旧代码在 `initialize` 误报配置无效且内存与磁盘相反，自动重启定时器抛未捕获异常；已修复，未签名。

**事件记录：** `aero-wallet-change-control-persist-failure-20261030`；引入日期 2026-10-30（Asia/Shanghai），线上发生日期未知；P1。

### L095：多步资金流程的自动重试必须按每一步落盘的进度续做

**适用条件：** 由服务端自动发起、一个任务里包含多笔会动用资金的链上交易（解押 → 平仓 → 卖出 → 兑换 → 开仓 → 质押），失败后由定时任务或人工重新启用来重试。

**根因：** 自动调仓初版只在平仓前、平仓后各写一次进度（`auto.json` 的 `reopen`），重试时按"平仓收回的数量"重新开仓。实际情况有三种：开仓已上链、质押前停下；兑换已确认、开仓失败；开仓回执超时。这三种情况下，重试都会再兑换或再开一次。执行器的 `capped(want, held)` 只按 Safe 现有余额截断，于是动用了 Safe 原有资金。另外，解押已确认、平仓签名前遇到维护时，错误码 `halted` 被当成"下一轮重试"，可头寸已经是未质押状态，判定直接跳过它，这个头寸就再也没人管，页面上也没有提示。

**以后做法：**
- 每一笔会挪动资金的交易，在签名后、广播前，先把"结果未定"（`inflight`）写盘。
- 确认后写入新的进度：兑换后的数量、新的 tokenId。
- 重试只从最后一个已确认的进度续做。
- 签过名后任何失败都停用，交给人工核对；结果未定或平仓中断的记录，不能自动续做，也不能重新启用，只能在人工核对后显式放弃。
- 一笔都没签名的失败，撤回这次记录，不计冷却和次数。
- 进度写不进去就不执行下一步。
- 任务执行中拒绝停机。

**如何验证：** [自动调仓测试](tests/aero-auto.test.mjs) 用假链覆盖以下路径：
- 开仓后质押失败：重试只质押；
- 兑换确认后失败：重试用兑换后的数量；
- 开仓或兑换结果未知：停用，且不能启用；
- 解押后中断：停用，重启后保持停用，放弃后才可启用；
- 签名前遇到维护：撤回记录；
- `auto.json` 写失败：不平仓、不广播；
- 交易未结清：不能放弃记录；
- 调仓执行中：`prepareStop` 拒绝停机。

去掉"已开出只质押"或"签名后保留平仓中"任一守卫，对应测试会失败。真实执行器路径另由 `tools/aero-roles/fork-rebalance.mjs` 的分叉演练验证。

**证据：** 本仓 `feat/aero-auto-rebalance` 合并前的独立审查（第 1 轮 P0-1、P1-1、P1-2，第 2 轮确认关闭）。2026-11-05 只做了离线测试与 Base 分叉演练，没有在主网运行。

**事件记录：** `aero-auto-rebalance-retry-progress-20261105`；合并前发现，未逃逸。

### L096：持续双边报价须共享库存，不能拆成单向开平轮次

**适用条件：** 用户要求持续双边做市、按净库存调整报价，并在另一场所对冲净敞口的模拟或执行策略。

**根因：** 将买卖方向拆成互不相干的「开仓、持有、平仓」情景，无法表达两侧订单共享库存与额度；固定持有期和平仓超时还会提前终止本应连续运行的研究。只统计完成轮次的成本，不能表示持续库存策略的整体盈亏。

**以后做法：** 先明确每个情景的库存账本、双边挂单及在途对冲的共同归属。买卖报价同时存在，按成交后的净库存调整价格与数量，同侧挂单与在途对冲计入额度；先处理已有订单对当前成交的响应，再重报，避免同一事件被重报逻辑吞掉或重复消费。成本同时呈现已实现与未实现部分；旧轮次模型的报告保留原义，不强行迁移成新策略历史。暂停报价不等于抹除持仓，正常重报不等于平仓失败。

**如何验证：** [成本核心回归](tests/binance-lighter-core.test.mjs) 检查初始双边、库存正负与变号时的调价调量、预留上限、延迟期间反向成交、净对冲、队列事件顺序及现金流守恒；[工作台回归](tests/binance-lighter-workbench.test.mjs) 检查旧记录只读与新模型隔离。断言真实订单/账本状态，不只检查双边文案。

**证据：** project-aggregation 基线 `9f74b4d` 的 `server/research/binance-lighter-core.mjs` 为两个方向分别创建情景，以 `entry → holding → exit` 驱动，平仓挂单到期将情景固定为未决。2026-11-05 用户明确纠正目标应为 BN 双边库存报价，本次 `codex/cost-lab-inventory-quotes` 按共享库存模型修正。没有实盘订单证据。

**事件记录：** `binance-inventory-strategy-mismatch-20261105`；用户纠正的策略建模错误，不能作为既有实盘策略失效的证据。

### L097：改动轮询或恢复时序时，同步所有覆盖该时序的浏览器夹具，夹具不依赖会话残留状态

**适用条件：** 页面轮询、唤醒恢复、重连读取等时序约定发生变化，或多个浏览器夹具在同一个 `playwright-cli` 会话里先后运行。

**根因：** `3a2cf14` 给交易页唤醒事件（含 `online`）加了 1 秒宽限期，`dc91237` 把唤醒合并为一次延迟读取并同步了 [轮询夹具](tests/trading-poll.browser.mjs)，但 [交易页夹具](tests/trading.browser.mjs) 仍断言“离线提示一消失就已读取”。该夹具在 `clock.install()` 后运行，宽限计时器受假时钟控制、永远到不了时间，断言稳定失败。它在中途失败时没执行到恢复视口那一行，留下 390px 视口；同一会话随后运行的轮询夹具走桌面侧栏导航，窄屏下侧栏隐藏，于是等待 `/api/trading` 超时。一个过期断言因此被误判成两个独立回归（#107）。

**以后做法：** 修改轮询、唤醒或重连时序时，用 `rg` 找出所有断言该时序的夹具一起修改。每个夹具开头显式设置自己依赖的视口、时钟等会话状态，不依赖前一个脚本的收尾。使用假时钟时，注意 `clock.install()` 之前创建的计时器仍按真实时间运行；要把读取归因到某个计时器，就在页面内计数并区分宽限期前后，不用混入真实时间轮询的请求总数。新断言要在去掉被测行为的变异构建上确认会失败。

**如何验证：** 用生产构建在同一会话依次运行 [交易页夹具](tests/trading.browser.mjs) 与 [轮询夹具](tests/trading-poll.browser.mjs)；另在新会话把视口设为 390 后单独运行轮询夹具，确认仍通过。把宽限期回调里的 `load()` 去掉，确认两个夹具都失败。

**证据：** project-aggregation 基线 `424869c` 的 #107 修复（2026-11-05）：当前构建上旧交易页夹具 4 次失败于 `reconnecting immediately reads cache`；旧轮询夹具新会话通过、紧接前者失败后同会话 2 次失败于第 127 行、新会话 390 视口失败；新夹具同会话连续 3 轮通过，变异构建上新断言 3 轮失败。生产代码未改。`clock.install()` 之前创建的 5 秒轮询按真实时间运行，是由读取时刻推断的，未单独验证。

**Monitor 扫描器夹具补充（#162，2026-11-05）：** 同类问题，不增加事件数。[筛选夹具](modules/monitor/tests/perpetual-scanner-filters.browser.mjs) 写死 `8470785` 时的背景色 `rgb(36, 35, 31)`，扫描器早已改用 `--scanner-bg: var(--card)`；[资金费夹具](modules/monitor/tests/perpetual-funding.browser.mjs) 在暂停时钟下立即读取重新请求后的值（响应仍需真实网络时间才渲染），重载后 `waitBases([])` 在页面初始化前就因零行成立，且列数断言（12、后改 16）从未与实际 17 列（导入列 1 + 默认列 16）一致，只是被前面的失败遮住。父提交 `ae5b5ab`、合并提交 `6338bbd` 与当前代码都失败，不是 PR #145 回归。以后做法补充：样式断言与运行时令牌的计算值比较，并约束其性质（不透明深色），不写死某次调色板的数值；时钟暂停时等待目标内容出现再断言，有上限的推进循环后仍显式失败；被前置失败遮住的后续断言在修好前置后逐条核对。修复后三个版本各通过 3 次。

**事件记录：** `trading-browser-fixture-timing-drift-20261105`；夹具缺陷，非产品回归；P2。

**验证夹具补充（#232/#245，2026-11-07）：** TLS 测试的统一 3 秒等待包含线程调度、最长 3 秒的握手和首帧，不能定位哪一步失败；现分别等待连接与首帧，首帧仍限 3 秒且仅一次连接，用受控 3.1 秒启动延迟证明旧等待失败，并用空缓存与删除初始推送的负对照防止假绿。仅有 3 秒有效期的 OI HTTP 缓存检查另起独立用例，避免建连消耗它的有效期；原 CI 失败现场耗时仍未知。原油主指标从百分比改成绝对差后，节奏夹具须同时更新数值和单位，采用 BZ=102、WTI=80（22 USDT/桶，不是 27.5%），保留失败恢复、切页停读和报价老化断言。证据为 [TLS E2E](modules/aster/tests/test_capacity_relay_e2e.py) 与 [原油概览夹具](modules/monitor/tests/monitor-overview-cadence.browser.mjs)。事件 `aster-relay-e2e-shared-wait-budget-20261107`、`monitor-oil-cadence-percent-fixture`；均为测试证据缺陷，不据此断言生产服务故障。

**#232 的 CI 增量证据：** 本批 `05784b4` 的 Ubuntu 24.04 / Python 3.12 discovered 分片实际失败于建连 `TimeoutError`，而独立 Ubuntu 26.04 中继验收通过；原记录不能据此断言是首帧问题或线程延迟。初版夹具要求第一次建连成功，比生产已有的超时退避重连更严。测试现只对 `TimeoutError` 允许一次真实客户端重试，每次 3 秒不变，总建连预算覆盖两次尝试、0.5 秒退避及调度余量；成功建连后禁止通过重连补首帧，持续超时、证书错误及缺失推送仍失败。启动延迟只注入首次连接，额外预算与双次尝试相加，不能让第二次机会在计时器到期前根本无法执行。诊断只记录 TCP/TLS/WebSocket 阶段和异常类型，不输出认证头。原失败首次建连超时的外因仍未证实；这是同一测试隔离事件的连续修复。

### L098：从机会行派生的估算必须继承该行的数据有效性，不能只看过期时间

**适用条件：** 从服务端投影的机会行（带 `eligible`、`reason`、`expiresAt` 等字段）取部分字段，另行计算展示金额、情景或建议数量的前端或服务端代码。

**根因：** #46 的 [持有期情景](modules/crossex/src/holding-scenario.ts) 最初只取资金费率、周期和 `expiresAt` 构造输入，丢弃了行的 `eligible/reason`。[服务端](modules/crossex/server/funding-opportunities.mjs) 会保留 Monitor 交易所离线、资金费时间异常等 `eligible=false` 但尚未到期的行；此时只要 CrossEx 盘口和费用仍新鲜，估算就返回 `complete=true` 和完整净额，页面没有离线提示。“未过期”不等于“数据有效”。

**以后做法：** 派生计算把源行的有效性状态与原因一起带入，数据有效性问题（离线、时间异常、报价异常、未知原因）阻止给出完整结果并显示原因。策略状态（暂停开仓、充提准入等）与数据有效性分开，用完整字符串白名单列出允许继续估算的策略原因，前缀、拼接或未知原因默认阻止。读服务端代码确认 `reason` 的全部来源，不凭单个文案判断。

**如何验证：** [情景测试](modules/crossex/tests/holding-scenario.test.mjs) 用真实服务端投影构造离线、资金费时间异常、策略状态与反向选腿的行，断言前两类不给完整净额且显示原因、策略状态不误阻止。去掉有效性检查后，离线与时间异常用例返回 `complete=true` 而失败。

**证据：** project-aggregation 基线 `424869c` 的 #46 实现（2026-11-05）：独立审查静态确认 P1，修复前新增用例 7 通过 5 失败（离线与时间异常返回 `complete=true`）；修复后相关测试 32/32 通过，第二轮独立审查无新问题。合并前拦截，未发布。

**事件记录：** `crossex-holding-scenario-row-validity-20261105`；合并前审查发现；P1。

### L099：全量历史读取的超时预算要按载荷与传输条件设定，内外两层超时只能保留一处

**适用条件：** 浏览器按固定周期读取数百 KB 以上的全量历史（K 线、资金费结算、对冲价格等），并与报价轮询、SSE 共用同一主机的 HTTP/1.1 连接；或轮询框架已带截止时间，请求函数内又自行加了 `AbortSignal.timeout`。

**根因：** Monitor 的历史读取与小体积报价共用 `startPolling` 默认 15 秒截止，请求函数里还各自套了一个 15 秒的 `AbortSignal.timeout`。原油 15 分钟 K 线约 2 万行、未压缩约 1 MB，每 60 秒全量重读；`8bc3bee` 把原油页改为 React 后，失败从数据说明里的一句“历史更新中断”改成带原因的红色提示，慢链路上超过 15 秒的读取因此变得显眼。只放宽轮询截止没有用，内层 15 秒超时仍会先中止请求。

**以后做法：** 历史类读取统一使用 `HISTORY_TIMEOUT_MS`（30 秒），请求函数只透传轮询给出的 `signal`，不再自带第二个超时；报价等小体积读取保持 15 秒。新增历史类读取沿用同一常量。若线上仍超时，先取得同一次失败的响应头时间、正文完成时间和 Monitor 事件循环指标（`/api/monitors/perpetual/diagnostics` 的 `eventLoopP99Ms/eventLoopMaxMs`），再决定是改成增量协议还是减少同步写盘，不靠继续加大超时掩盖。

**如何验证：** [原油历史超时浏览器回归](modules/monitor/tests/oil-history-timeout.browser.mjs) 用假时钟挂起 K 线响应：20 秒后才返回仍被采用且无提示；第二次读取 25 秒时无提示，31 秒时出现“数据读取超时”并保留已加载的数据。把 `HISTORY_TIMEOUT_MS` 改回 15 秒后该回归失败于第一段断言。

**证据：** project-aggregation 基线 `b66cb0a` 的 [polling.ts](modules/monitor/lib/polling.ts) 与 [use-oil-feed.ts](modules/monitor/hooks/use-oil-feed.ts)。2026-11-05 用户截图显示实时报价正常、历史提示“数据读取超时”。本机实测客户端解析与校验约 30 ms，服务端读取为单行 SQLite 读取加 gzip，链路上未发现新增阻塞，也没有取得线上请求时序，不能断言每次超时都来自传输慢；重写只确认了提示变得显眼。

**事件记录：** `monitor-history-read-timeout-20261105`；用户反馈；不推进主线复盘检查点。

### L100：多腿价差保护要在同一时间窗的盘口上一次算好全部腿的界限

**适用条件：** 按价差阈值自动下多条腿、并给每条腿设追价界限的执行路径，包括本仓套利交易自动规则（`server/trading-auto.mjs` 的 `boundsFor()`、`server/trading-execution.mjs` 的 `guardMet()`）。

**根因：** 各腿盘口并行读取，只按交易所时间做 10 秒新鲜度判断时，慢腿返回前另一腿的旧盘口仍算“新鲜”，两者配对得出的价差实际不存在；Binance `priceMatch=QUEUE` 按撮合时价格成交，于是成交价差低于阈值却记为完成。负阈值等大余量情况下，按余量平分的界限可能 ≤0，适配器本地拒绝该腿而另一腿已并发发出，留下单腿仓位。`Object.hasOwn()` 会把数组键转成字符串，枚举校验因此可被 `['oil']` 绕过。

**以后做法：** 价差保证必须落到交易所实际接受的委托价上（显式只挂单价格或原生追价上限），由交易所撮合时定价的方式（如 Binance `priceMatch=QUEUE`）不能承担保证；在发送任一腿前一次算好并校验全部腿的界限（为正、当前盘口未到界限），任何一腿不合格就整批不发；界限钳制只能收窄允许成交范围；盘口新鲜度窗口按本地接收时间计，只作附加检查；枚举字段先校验类型再查表。

**如何验证：** 运行 `node --test tests/trading-auto.test.mjs`，确认负阈值界限钳制、慢腿盘口不配对（首批不发送、退回当日次数）、Binance 自动委托带显式 `limitPrice` 与枚举数组被拒；运行 `node --test tests/trading-execution-exchanges.test.mjs` 确认界限外价格不发 HTTP；改动窗口或界限时做一次变异验证，确认去掉检查后对应用例失败。

**证据：** 本仓分支 `feat/arb-auto-threshold` 第三轮独立审查以真实 Binance 适配器加模拟传输复现：原油做空阈值 -150 时 BZ 界限 -2.48 被本地拒绝、CL 已成交；CL 读取延迟 8 秒时成交价差 3.01 低于开仓阈值 4 而任务完成；第四轮又指出即使限定读取窗口，QUEUE 在发送后仍可按更差价格挂单，最终改为显式 GTX 价格。安全差异审查复现 `market: ['oil']` 允许同时启用三条 Binance 原油规则。记录见 `docs/reviews/2026-11-06-arb-auto-threshold.md`。

**事件记录：** `arb-auto-bounds-20261106`；首次合并前审查发现，未逃逸到正式版。

**浏览器偏好枚举补充（2026-11-07）：** 基线 `b524404` 上新增的交易偏好恢复在判断结构是否有效时先做 `String(value)`，实际恢复却使用严格枚举；`['okx']` 被前者接纳、后者回退成 Binance，仍保留旧方向；合法 JSON 对象 `{ "toString": null }` 还会让初始化直接抛错。持久化 JSON 同样是不可信输入，结构校验与恢复须使用相同的严格类型/枚举判断，不先转换字符串。独立固定补丁探针确认后已在首次提交前修复，[偏好测试](tests/trading-preferences.test.mjs) 覆盖数组、对象、非当前品种的坏数据和方向清除；[审查记录](docs/reviews/2026-11-07-ui-preferences.md) 保存证据边界。事件 `trading-preference-enum-coercion-20261107`，未发布实现，未发生实盘交易。

### L101：后台页面不长期占用 HTTP/1.1 连接，也不在后台跑每秒推送

**适用条件：** 工作台按 `http://hub.localhost:<端口>` 等 HTTP/1.1 地址访问，页面或预载模块 iframe 用 EventSource 等长连接；或已加载的隐藏模块在 `backgroundUpdates:true` 下继续运行推送与定时重绘。

**根因：** 浏览器对同一主机最多保持 6 条 HTTP/1.1 连接，多个标签页共享。`d2151ee`（2026-10-09）为切回即新鲜，让总览推送在标签页隐藏时保留；系统更新推送本来也不随隐藏断开。每个工作台标签页因此长期占 2 条，开两三个标签页后其余请求只能排队，表现为其他工作台标签页卡住。监控模块的永续行情推送同理占用模块主机连接，并在隐藏时仍每秒解析一帧、遍历全部报价；CrossEx 的 1 秒时钟用 `document.hidden` 判断前台，但 `display:none` 的 iframe 仍报告可见；Greeks 每 10 秒无条件重建持仓 SVG。

**以后做法：** 页面隐藏或模块转入后台时关闭长连接，改用已有的低频读取（总览 30 秒、系统更新 15 秒/任务中 2 秒、永续快照 30 秒），回到前台立即重连并补读一次。模块判断前台以宿主 `activity` 的 `active` 与 `document.hidden` 共同为准，不能只看 `document.hidden`。新增长连接或秒级定时器时写清隐藏状态下的行为。

**如何验证：** [后台更新回归](tests/background-updates.browser.mjs) 与 [系统更新回归](tests/updates.browser.mjs) 确认隐藏即关闭推送、隐藏期间按周期读取、切回只新建一条推送；[永续后台回归](modules/monitor/tests/perpetual-background.browser.mjs) 确认独立打开与工作台 iframe 两种情况下后台关闭推送、等一个周期后读取快照、切回只建一条推送且筛选与分页保留；[行情流单元测试](modules/monitor/tests/perpetual-feed.test.mjs) 覆盖仅轮询与延后首读。

**证据：** project-aggregation 基线 `dee1e20`。2026-11-06 用户反馈打开工作台后其他工作台标签页与其他网站都变卡，访问地址为 `http://hub.localhost:3100/`（HTTP/1.1，经端口转发到服务器）。本机用 3000 条报价、每秒一帧补丁的夹具测量隐藏的监控 iframe：主线程任务占比由约 1.1% 降至 0.4%，后台推送帧由 30 秒 30 帧降至 0；前台约 2%。这只证明隐藏模块的开销下降，不能断言"其他网站变卡"主要来自这里，现场浏览器任务管理器数据未取得。

**事件记录：** `hub-background-connections-20261106`；用户反馈；不推进主线复盘检查点。

### L102：服务端与嵌入客户端首轮状态不同时，渲染分支先按服务端值水合，读取门控仍用真实状态

**适用条件：** 服务端渲染、再嵌入工作台 iframe 的模块页面，首轮状态由宿主桥接决定（服务端看不到宿主而假定可读，可信嵌入客户端要等宿主回复），且该状态同时决定渲染分支与数据读取，如 Monitor 的 `useHubBridge` 的 `readActive`、`app/oil-panel.tsx` 与 `app/dashboard.tsx` 的 `hasOpened` 和 `<Activity mode>`。

**根因：** 服务端令 `readActive=true`，嵌入客户端初值为 false，选中面板的 `active` 两边不同；`hasOpened` 初值与 `<Activity mode>` 都依赖它，首轮客户端树与服务端 HTML 不一致，React 报 #418 后整树改为客户端重建。单改 `hasOpened` 不够，`mode` 也参与了不一致。

**以后做法：** 渲染分支在水合这一轮按服务端会用的值（选中与否）输出，水合完成后再跟随真实状态（`useHydrated()`）；数据读取、首次打开标记等门控继续只用真实状态，不能为了消除不一致把客户端初值改成“可读”，否则后台预载的 iframe 会在宿主回复前提前读取。水合这一轮输出的只能是不挂载重组件、不发读取的占位。

**如何验证：** 构建工作台与 Monitor，用 `tests/monitor-embed-hydration.browser.mjs` 经真实工作台桥接首次打开原油与海力士，断言没有 pageerror，并用永不回复的宿主断言 3 秒内 API 读取为 0；改动这条路径时做因果变异：只令客户端桥接初值等于服务端时 #418 消失，回退修复后该回归失败于 #418。

**证据：** 本仓 issue #224，基线 `0c1cbcc` 与 `0169408` 在独立 Windows 工作树经工作台 4175 与 Monitor 夹具 3190 的代理子域 iframe 复现，原油与海力士首次打开各一次 `Minified React error #418`；`tests/monitor-trade-summary.browser.mjs` 原先放行 1 次 #418，现要求 0 错误。

**事件记录：** `monitor-embed-hydration-20261106`；回归浏览器验收发现，正式版首屏可恢复但会整树重建。

### L103：多腿执行中单次状态读取的传输失败不能直接暂停并撤掉对冲腿

**适用条件：** 多条腿并行挂单、每轮先读各腿委托状态再决定追价或下单的执行循环，包括本仓套利交易 `server/trading-execution.mjs` 的 `runJob()`；读取失败后的暂停会进入停止流程撤销余单。

**根因：** 原逻辑只要任一腿 `inspectOrder()` 抛错就暂停并撤销余单，不区分超时、连接失败、5xx、限流这类与委托无关的传输失败。2026-11-07 Anthropic 跨所开仓第 1 批 Binance 0.78 已全部成交，Hyperliquid `io:ANTH` 买单仍在挂单，一次状态读取失败即暂停并撤掉 Hyperliquid 委托，留下无对冲的 Binance 空单；事件只写“委托状态读取失败或提交结果不明”，看不出是哪条腿、什么错误。

**以后做法：** 只有传输类失败（`timeout`、`transport`、`upstream`、`aborted` 且服务未关闭、Binance -1003 / Bybit 10006 / OKX 50011 限流）在有界窗口内跳过本轮重试，至少 `READ_RETRY_ATTEMPTS` 3 次且满 `READ_RETRY_MS` 20 秒才暂停（读取可能一直挂到 35 秒调用期限，只按时长会一次也不重试），窗口内不追价、不撤单、不下新单，首次失败与恢复各记一条事件；数据格式、身份数量不一致、提交结果未查到等仍立即暂停。暂停原因和事件必须写明交易所、合约和具体错误。

**如何验证：** 运行 `node --test --test-name-pattern="transient status read" tests/trading-execution.test.mjs`，确认 Binance 追价腿超时或 -1003 限流读取时窗口内不改价、不撤单、不下单，恢复后继续完成，窗口内用户停止照常撤单，次数与时长都满才暂停，`invalid_data` 立即暂停，且原因带出 `Binance CLUSDT：…`。

**证据：** 用户 2026-11-07 截图：任务 `991841cb-…` 03:17:02 Binance 腿最后对账（已全部成交），03:17:07 读取失败暂停，03:17:24 Hyperliquid 委托撤销 0 成交。服务器日志未落具体错误，触发腿与错误码未核实。

**事件记录：** `trading-transient-read-pause-20261107`；用户反馈。

**盘口过期补充（2026-11-07）：** 用户随后反馈 Lighter RH ANTHROPIC 买入、Binance ANTHROPICUSDT 卖出的两条市价腿均未成交，任务以「盘口已过期，等待新行情后重试」暂停。`normalizeMarket()` 的过期异常仍直接进入暂停撤单；现有委托状态读取重试不覆盖这条路径。并行盘口读取时，慢腿或冷规则读取会让快腿盘口在整组返回前变旧。仅对过期盘口补读一次并重新校验整组，持续过期按独立预算等待（至少三次且满二十秒，任务截止与用户停止优先），恢复前不追价或下新单；活动委托先校验全部待追价腿，再执行改价或撤挂。不能因状态读取成功就清空盘口失败预算。保留原始来源时间与 10 秒门槛；无效、未来时间分别诊断，不能统称过期，更不能用本机当前时间替代来源时间。最终发送守卫拒绝后仍暂停核对，结果未知不自动重发。

验证：`tests/trading-execution-rh-lighter.test.mjs` 的 `Anthropic market legs` 两项在修复前均复现暂停，修复后覆盖慢腿 11 秒导致快腿过期后的补读、持续旧盘口零发送与恢复后只发送一次；`tests/trading-execution.test.mjs` 覆盖挂单保留、持续失败预算、第二腿过期时第一腿不改价、停止/截止优先及无效/未来/交叉盘口拒绝。事件 `trading-stale-book-no-retry-20261107`；用户现场具体过期腿、读取耗时和服务器时钟差未取得日志，不能将离线慢腿复现当作现场根因证明。审查与交付证据见 [本次记录](docs/reviews/2026-11-07-ant-quote-recovery.md)。

**Lighter 只读限流补充（2026-11-07）：** 用户截图再次出现 Binance 已全成、Lighter 部分成交后以“已达到本地限速”暂停。基线 `0ed4b6d` 的账户/盘口采集直接暂停，订单状态读取只有 20 秒通用窗口，未遵守适配器 `retryAt`。只对 Lighter 明确只读限流按恢复时间等待，首次失败起固定 180 秒、最多三次恢复；等待期间不读、不追价、不下新单，停止与任务截止优先，恢复重新核验所需证据。预算不能被同轮成功的状态读取清除；已接受建单的确定性“查无”仍保留原签名观察窗口。独立审查进一步确认：不能只检查 rejected Promise，还须先校验已成功返回的兄弟盘口、账户和订单终态，硬错误优先于限流等待；否则已越过价格界限或提前终止会被延后。该优先级缺口在交付前修复。

验证见 [Lighter 执行回归](tests/trading-execution-rh-lighter.test.mjs) 的 `Lighter RH rate-limited` 用例，覆盖真实适配器模拟传输的本地配额耗尽和 HTTP 429、部分成交余量、等待零调用、恢复上限、停止/截止、未知单不重发和已成功返回的硬错误优先。修复前七组新用例均失败；独立三组优先级探针用于增量复核。[审查记录](docs/reviews/2026-11-07-rh-lighter-read-cooldown.md) 区分离线缺陷与尚未取得的服务器版本/失败端点证据。事件 `rh-lighter-read-rate-cooldown-20261107`；不推进复盘检查点。

**自动规则读取分类补充（2026-11-07）：** ANT 自动减仓规则初版把所有 HTTP 语义 `status===409` 都视为永久拒绝，包含 `StaleMarketError`；一轮盘口补读后仍旧便停用规则，行情恢复也不再监测。调度器按错误类型区分短暂旧盘口与账户变更等硬拒绝，旧盘口沿用三次持久失败预算；明确限流 `retryAt` 不得被本地最长等待截短。[自动减仓集成测试](tests/trading-anthropic-reduction.test.mjs) 经真实 `collectMarkets` 复现 11 秒旧盘口两次读取后错误停用，修复后冷却再读可触发；另以执行器注入的较长期限验证跨重启不提前请求，当前 RH 适配器只有更短期限，后者是防扩展回归。事件 `ant-reduction-stale-rule-disable-20261107`，独立审查在发布前发现；同轮修复不增加既有事件次数。

**Lighter WS 与原生改单补充（2026-11-07）：** 用户继续反馈 ANT 追价频繁限流，并指出可以原生改单。基线 `00fe4f1` 的 Lighter 盘口与查单各按 4 秒 REST 缓存运行，追价则撤单、核验、账户预检、再建单；只读限流恢复没有减少这些请求。正常路径改用完整 BBO 与鉴权订单推送，原生改单维持原客户编号和总量，并以持久化版本和目标价格确认；发送结果未知不重放，旧版本只能更新已确认成交。官方证明器明确 BaseAmount 是新总量，不能传剩余量或用 0 猜测保量。私有频道 envelope nonce 缺乏严格递增契约，不按它过滤成交推送；公共 ticker/pong 不能使私有缓存无限有效，无新私有证据时有界重新订阅并等新快照，缺席原单再按客户编号精确 REST 核对。新发送变为未知后清除旧的未发送退避，避免旧 180 秒预算缩短新签名的观察窗口；不再需要追价时结束退避。

验证见 [流回归](tests/trading-rh-lighter-stream.test.mjs)、[适配器回归](tests/trading-rh-lighter-execution.test.mjs)、[引擎回归](tests/trading-execution-rh-lighter.test.mjs) 与 [本次记录](docs/reviews/2026-11-07-lighter-ws-reprice.md)。受控连续一分钟的健康推送没有 REST 盘口/查单；总量 10、已成 3、改单途中再成 2 后仍为总量 10、累计 5、剩余 5。两项退避边界在修复前的新回归均失败。独立审查另复现并关闭两个 P1：私有证据须在读取前/等待后检查绝对截止，不能只靠定时器；订单行 nonce 是队列字段，不能用统一递增门槛否决更高改单版本，买单队列计数可能下降。增量独立探针确认过期立即撤权、同一轮仅重订阅一次，以及更高版本/较低 nonce 后 inspect 不回退且零 REST。真实公开 RH ticker 已只读核对；未使用真实私有账户下单。事件 `rh-lighter-ws-native-amend-20261107`，关联同日限流改进，不推进复盘检查点。

**Binance WS 与校时补充（2026-11-07）：** 用户截图中的只读组合保证金仓位 HTTP 400 / -1021 是时间戳拒绝，不是限流；执行与只读客户端的校时逻辑须一起检查。明确 -1021 才允许有界校时后重签一次，未知交易结果不能套用此重试。Binance 订单流不提供账户完整快照，仓位增量也不提供最新强平价等风险字段；先建立流再读取 REST 基线，断线、换凭据或 ready/校时失败即撤销旧基线，恢复前只缓存事件。否则旧 socket 在 REST fallback 后到达，会把新快照回退到旧时间和仓位。推送更新数量不能给旧风险字段续期，风险未知不得授权自动减仓。事件 `binance-readonly-clock-ws-baseline-20261107`；真实流管理器回归复现基线回退并验证恢复，见 [只读流测试](tests/trading-binance-readonly-stream.test.mjs) 与 [本次记录](docs/reviews/2026-11-07-binance-ws-clock.md)。属于本轮增量修复，不推进复盘检查点。

同轮自审还确认：WS 入口即使检查来源年龄，下游执行器也必须保留该来源时间（只做校时坐标换算），不能改成本机接收时间。否则到达时旧 4 秒、等另一腿 7 秒，执行器会把实际旧 11 秒当作旧 7 秒。普通/PM 两项真实流加 `normalizeMarket` 回归先红后绿，见 [执行 WS 测试](tests/trading-binance-execution-stream.test.mjs)；同一事件补充，不增加事件次数。

独立审查另确认只读可见性缺口：余额事件的空 `P` 不代表清仓，但非空 `B` 及其他合约仓位变化仍会影响 cross/PM 强平风险，不能因合约不在关注列表就忽略风险失效信号。只转发余额变化布尔，在过滤仓位前清旧风险并递增在途 REST 的风险序列；数量和基线时间保留，下一次完整 REST 可恢复。四项普通/PM 回归先红后绿。ANT 自动减仓本身另读实盘 `execution.account` 风险，不将只读监控显示缺陷夸大为交易授权漏洞。

**推送故障与自动规则补充（2026-11-07）：** 合入后审查发现三处同类缺口。Binance 执行适配器把推送流的 `invalid_data` 直接报错，引擎随即暂停撤单；流里事件时间只容忍比校时估计超前 1 秒，样本过期后偏移又退回 0，时钟偏差主机在重新校时窗口即可触发。Lighter 订单快照含账户在该市场的全部订单，一行 `client_order_index` 为 0 的手动单就否决整份快照，且 `invalid_data` 不回退 REST，建单在发送前失败而同批 Binance 腿已发出。另外 Binance 断线或冷却期间读到的 REST 订单被写入流缓存，重连后新连接不补发断线期事件，旧 NEW 状态最长 30 秒仍作为当前状态返回。以后推送只是加速路径：任何非取消类的推送故障（含格式错误）只关闭本次推送读取并走有界 REST 精确补读，由 REST 结果自身的校验决定成败；推送时间超前归为 `upstream`；快照中本市场本账户 `client_order_index` 为 0 的手动单跳过，不能否决其它行，其它非法编号仍按格式错误处理；REST 结果（建单、改价、查询、撤单各路径）只能写入请求发出前已连接且代次未变的流缓存。自动减仓遇到用户自己的止盈止损或限价单（`ExternalOrdersError`）时保持启用并 30 秒重试、原因与事件可见，未达阈值时也提前给出预警，不能在触发时刻静默停用；任务进行中出现外部委托时，截止前只暂停发新批次、不撤本任务余单，截止后才按原路径暂停。验证见 `tests/trading-binance-execution-stream.test.mjs`、`tests/trading-binance-stream.test.mjs`、`tests/trading-rh-lighter-execution.test.mjs`、`tests/trading-rh-lighter-stream.test.mjs`、`tests/trading-anthropic-reduction.test.mjs` 本次新增用例，均做过去掉修复的变异验证。离线复现，未在真实账户触发。事件 `trading-stream-fault-review-20261107`；合入后审查发现，不推进复盘检查点。

**自动减仓可执行性补充（#258，2026-11-08）：** 基线 `9351de4` 直到危险阈值达到才计算原生减仓量，一步仓位乘 50% 会在触发时才失败。保存后的“启用”须明确等待核验；监测阶段每轮用当前仓位完成向下取整、全部拆批、单批数量/金额及时间检查，触发和最终发送仍按最新证据检查，不自动提高比例。数量错误不能被可恢复的活动委托阻塞遮蔽：本次独立审查复现“Binance 有活动委托 + OKX 4 张、50%、3 批”只提示委托，移除委托才暴露拆批失败；修正为所有腿完成数量校验后仍严格拒绝外部委托。最低金额按交易所和订单类型区分：RH IOC 的官方验证器豁免最低名义额，HL 小额减仓豁免未取得明确契约，因此提前提示不确定条件而不宣称可执行。验证见 [自动减仓回归](tests/trading-anthropic-reduction.test.mjs) 的 `reduction sizing`、`minimum notional readiness`、`external orders cannot hide` 与读失败/数量变化场景。事件 `ant-reduction-size-readiness`，沿用 Issue ID；同轮审查补漏不另计事件，无真实下单。

### L104：`submit()` 的失败分支提前返回前必须重新保存委托

**适用条件：** 在 `server/trading-execution.mjs` 的 `submit()` catch 块里新增任何提前 `return` 的分支（延后重发、bounce 重挂、已接受待可见等）。

**根因：** catch 块先调用 `finishWrite()`，它在写保护开启时就把委托落库，然后才把内存里的委托改成 `rejected`/`settled` 或 `unknown`。首版 Lighter RH「未送达延后重发」分支在 `deferSend()` 后直接返回，库里留下 `submitting`、未结算、结果未知的记录；下一轮读回后被当作不确定建单，要等签名有效期（约 12 分钟）才结算，期间该腿不能重发。没有写保护时（`operation` 为空）甚至一次都不落库。

**以后做法：** catch 块中任何在末尾 `saveOrder(order); pause(...)` 之前返回的分支，都先 `saveOrder(order)`（或像 bounce 分支那样在分支内保存）；不依赖 `finishWrite()` 已经保存。

**如何验证：** 运行 `node --test --test-name-pattern="refused before it left" tests/trading-execution-rh-lighter.test.mjs`；临时去掉延后分支的 `saveOrder(order)` 时该测试应失败（第二次重发不会发生）。

**证据：** 2026-11-07 project-aggregation Lighter RH 后续修复，开发中由新增引擎测试发现，未进入发布版本。

**事件记录：** `rh-lighter-defer-unsaved-20261107`；作者自测发现。

### L105：路径回放的覆盖须来自连续有效区间，不能用首尾跨度代替

**适用条件：** 用小时采样重放持仓、调仓或收益路径，且中间可能缺失整点或关键价格。

**根因：** 首尾相差八小时不证明中间八个区间的路径；跳过缺口后继续旧仓位同样隐含了未知期间未调仓的假设。

**以后做法：** 分开报告自然跨度、有效区间总数、缺口和实际回放段。Aero 当前只采用最新连续有效整点段，至少七个点构成六个小时区间才给收益；缺口处重新选择起点，不跨缺口累计排放。排放缺失与价格/整点缺失分开表达。

**如何验证：** [回放核心测试](tests/aero-market-replay.test.mjs) 覆盖两点相隔八小时、连续七点、内部缺口、缺价、缺排放；[服务测试](tests/aero-market.test.mjs) 与 [生产页面](tests/aero-replay.browser.mjs) 核对准入和覆盖说明。

**证据：** Issue #242；本仓 `fdf470e` 的 [回放引擎](server/research/aero-market-replay.mjs) 对 00/08 两点返回 `hours=8` 和收益，实际基线差分探针复现；修复后为 `insufficient_history`、收益为空。

**事件记录：** `aero-replay-hour-gap-coverage`；2026-11-07 离线确认，首次线上发生日期未知，沿用 Issue 事件 ID。

### L106：模拟扣费达到仓位价值时必须终止，不能让负流动性继续参与计算

**适用条件：** 研究回放按仓位价值比例扣调仓费，或按小时内碰边概率计提成本；不代表真实交易执行规则。

**根因：** `L *= 1 - costFraction` 在成本超过本金时变成负数；后续负仓位产生负成本甚至翻回正数，有限数值检查无法识别。

**以后做法：** 扣费事件先区分可继续与耗尽；已付成本封顶当时仓位价值，耗尽后流动性归零、记录终止点，不再累计后续排放或成本，也不展示完整窗口年化。小时内概率成本与整点调仓两条路径都检查；全范围无需调仓时不因理论单次费用高而提前拒绝。

**如何验证：** [回放核心测试](tests/aero-market-replay.test.mjs) 覆盖成本小于、等于、大于本金，整点出界与小时内碰边，极小投入和全范围；核对费用非负、终止后无排放及 `net = emission - impermanent - cost`。[页面夹具](tests/aero-replay.browser.mjs) 核对终止提示与无年化。

**证据：** Issue #243；本仓 `fdf470e` 基线差分探针中，成本比例 2 的九点序列仍回放八小时、费用归零并累计排放；修复后首个扣费小时终止，费用等于当时仓位价值。

**事件记录：** `aero-replay-capital-exhaustion`；2026-11-07 离线确认，首次线上发生日期未知，沿用 Issue 事件 ID。

### L107：受理反馈须绑定具体任务并持续呈现最终结果

**适用条件：** 提交只代表异步任务已受理，页面另以轮询取得成交进度，任务列表还含其他任务或分页历史。

**根因：** 组合交易在提交成功后写入固定受理提示，完成任务又移入折叠历史；即使后台和轮询正常，用户仍看不到本次结果。列表首项、相似计划或前后差分不能可靠关联幂等重试和并行任务。

**以后做法：** 提交响应明确返回本次任务的公开编号与快照，幂等恢复从持久请求取原编号；前端按编号随既有轮询更新并保留终态结果。读取失败或缺少任务时保留最后证据并标明未更新，不推断成功。完成只依据服务端终态；委托价不能当成交均价，跨交易腿不同单位不直接相加。

**如何验证：** [执行器测试](tests/trading-execution.test.mjs) 覆盖新建、继续剩余、相同请求及超出最近历史分页的原任务回执；[执行页面夹具](tests/trading-execution.browser.mjs) 覆盖部分成交、其他任务插入、极小剩余、失败/缺任务、暂停/待核对/停止、完成后保留与刷新恢复，确认持续跟踪不额外发起写操作。

**证据：** project-aggregation 基线 `00fe4f1` 的 `src/TradingExecution.tsx` 固定显示“组合已受理”，终态仅进入折叠历史。2026-11-07 用户截图及明确要求跟踪至完成；本轮检查源码确认反馈缺口，并用隔离浏览器覆盖修复路径，没有从截图推断真实交易成交情况。

**事件记录：** `execution-accepted-feedback-20261107`；本次用户纠正与验证为一个事件。

### L108：历史成交标记须有真实合约归属，当前持仓不能代替历史配对证据

**适用条件：** 同一标的在多个原生合约之间切换的价差图，以及当前持仓的组合盈亏展示。

**根因：** `b524404` 的 ANT 配置对 RH、xyz、io 共用 Binance/OKX 单腿事件，并随所选图表换纵坐标；成交来源没有包含 RH/HL，文字说明“非双腿成交价差”仍不能阻止用户将图上入场理解为该组合入场。原测试也断言同一 Binance 成交出现在三个图上，复述了错误模型。关联交易按结算币种拆开，未表达用户实际的 Binance–Lighter RH 当前组合。

**以后做法：** 历史事件按真实交易所与原生合约路由，RH、xyz、io 分别隔离；手动成交与工作台成交用相同的真实成交证据。只有单腿证据的 Binance/OKX 记录留明细，不通过当前持仓或相邻时间推断过去的对冲腿。当前组合独立确认唯一反向两腿，多账户或共用一腿时不重复分摊。跨币种估算仅在明确选择口径后提供，并持续标注；本次用户明确允许 ANT 的 USDT/USDG 按 1:1 估算，不推广到其他账本或估值。未知费用/本轮已实现不补零，已知部分与完整总额分开。

**如何验证：** [ANT 标记回归](modules/monitor/tests/anthropic-trades.test.mjs) 必须断言 RH 成交在 xyz/io 图上为零标记、无归属 CEX 仅明细；[组合回归](modules/monitor/tests/related-position-totals.test.mjs) 用用户截图验证未实现 +406.33、已知净盈亏 +394.84，同时保持完整总额未知，覆盖多账户歧义；[真实工作台入口](tests/monitor-anthropic-trades.browser.mjs) 验证切换图表与原币明细，不能只校验标记随曲线移动。

**证据：** project-aggregation `b524404` 的 `anthropicChartConfig` 将同一 `anthropicTradeEvents` 赋给三种对比，`anthropic-trades.test.mjs` 首版对同一 CEX 事件逐项期待 xyz/io/rh 坐标。2026-11-07 用户截图与纠正后核对源码；本次修正补齐原生成交只读来源并按合约分流。没有读取用户真实成交账户，不把夹具当作实盘交易证明。

**事件记录：** `ant-history-pair-attribution-20261107`；P1 逃逸缺陷，用户反馈后修复；已扩充审查清单的身份归属项，留作下次复盘输入，不推进复盘检查点。

**工作台订单关联补充（2026-11-08）：** 用户确认截图中的 Binance–Lighter RH 来自工作台组合下单。基线 `f24140d` 虽已保存任务和订单，成交链路却丢弃订单编号、没有账户证明，仍把所有 CEX 统一标为“未关联”。真实归属优先连接已有任务证据：Asset 的显示账号 `default` 和随机加密凭据哈希不是交易所 UID；按固定只读 UID、原生合约、订单编号、方向和模式核对。继续剩余会覆盖 `job.plan` 且移除已成腿，完整组合取 `totals`，账户版本从已受理预览补证，缺证据不猜。旧缓存必须一次性补读订单元数据，不能只等十分钟增量窗口自然补齐。另核对 [Lighter 官方 SDK](https://github.com/elliottech/lighter-python/blob/main/lighter/api/order_api.py) 发现成交历史 `limit<=100`，原实现请求 500；本轮改为 100 并保留有界分页。验证见 [归属回归](tests/trading-fill-attribution.test.mjs)、Asset 成交缓存与读者测试、ANT 标记和工作台入口夹具。没有读取用户真实私有账户，不断言参数错误是截图故障的唯一原因。沿用事件 `ant-history-pair-attribution-20261107`，不新增独立事件、不推进复盘检查点。

### L109：IF NOT EXISTS 不修复同名不同定义的索引或生成列，回滚目标须能改回自己的定义

**适用条件：** SQLite 结构由各进程启动时用 `CREATE ... IF NOT EXISTS` 或“按列名判断再 `ADD COLUMN`”补齐，且查询依赖对象的精确定义（`INDEXED BY` 部分索引、生成列表达式）；或计划做改索引条件、改生成列表达式的迁移。

**根因：** `IF NOT EXISTS` 和按名判断只看名字。同名但条件不同的部分索引保持原样，`INDEXED BY` 直接报 `no query solution`，执行器构造失败、runtime 起不来；表达式不同的生成列被沿用，统计按旧口径静默计算。新版本改了定义后回滚到旧版本，同样会遇到这种情况。

**以后做法：** 依赖精确定义的对象在启动时（以及读取报 `no query solution` 或缺索引时）比较 `sqlite_schema.sql`（SQLite 去掉 `IF NOT EXISTS`、保留原文空白，比较前归一空白），不符时在写锁内删除重建，调用方已在事务内则并入该事务；对象及其依附的索引在同一事务内重建，非关键对象重建失败整体回滚、只记日志。改这类定义的迁移要等安装器保留集合里的版本都包含这项兼容处理后才能执行。

**如何验证：** 在临时库预置同名不同定义的对象后走真实创建函数：启动成功、行数不变，`inspectHubSchema` 不再列为不符；定义一致时不写库；运行中被改定义后，缓存语句和新编译的语句各自恢复一次。用修复前的源码跑同一组测试应报 `no query solution`。

**证据：** project-aggregation E1a 盘点（`docs/hub-schema-inventory.md` 第 5 节，PR #253）在临时库复现执行器构造抛出 `no query solution`；E1c-1 在 `server/trading-execution.mjs` 的 `replaceChangedIndexes` 与 `server/observability.mjs` 的 `replaceChangedColumn` 修复，测试见 [执行器测试](tests/trading-execution.test.mjs) 与 [基线测试](tests/observability.test.mjs)。线上定义与代码一致，没有发生过线上事故。

**事件记录：** `hub-same-name-definition-drift-20261107`；盘点发现，修复前未在生产出现。

## 已归档

尚无。达到 [升级条件](docs/code-standards.md#升级规则) 后，将对应条目从《经验条目》移到本节，保留证据与规范链接；不按重复复盘次数自动升级。
