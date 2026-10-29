# 全业务与工程审查报告

日期：2026-10-30（Asia/Shanghai）。最终源码基线：`37cb9e2947801c39c7432606302b5e5f4407e433`，与审查时远端 `main` 及[最新正式版](https://github.com/hxx344/project-aggregation/releases/tag/deploy-37cb9e2947801c39c7432606302b5e5f4407e433)一致。

本次新增登记 **16 条 Issues：11 条 P1、4 条 P2 缺陷、1 条 P2 演进建议**。主要问题集中在发送前证据时效、异步写入所有权、生产者与消费者的身份契约、活动状态与历史数据混读、部署目标交接，以及回测单位和到期语义。问题已登记，业务实现尚未修复。实施顺序见[技术演进迭代初稿](technical-evolution-draft-2026-10-30.md)。

**安全深度扫描未能启动，因此本报告不构成已完成的全仓安全审计，也不作“所有问题已找出”或“没有安全漏洞”的结论。** 本次实际完成的是所有业务域核心调用链、相关失败路径、性能热点与交付链的审查和离线验证；未逐行穷尽全部文件、全部组合状态或真实交易所行为。

## 1 范围和证据口径

本地起点为 `1f64c50`。发现其落后远端后，在工作区干净、检查结束后快进到 `37cb9e2`；比较其间 131 个变更文件，补查新增期权回测工具，重新执行仍成立问题的关键探针。已修复的 Greeks 新鲜度候选撤回，旧版本测试不计作最新版整套验证。

采用仓库[审查标准](code-review-standard.md)的严重度；只有能说明触发、位置和后果的发现作为缺陷。P1 不表示已发生线上损失；有真实资金执行能力的修复按 R3 实施。ADL 整组阻塞和 Bybit 恢复证据经复核后下调，避免把保守策略或尚未证明的资金后果夸大成阻断级问题。

| 审查域 | 实际覆盖的入口和链路 | 验证边界 |
| --- | --- | --- |
| 工作台与原生执行 | `src/TradingExecution.tsx`、`server/trading-execution*.mjs`、OKX 适配器；预览、确认、分批、等桶/等金额、改单、未知结果恢复、人工确认 | 隔离 HTTP/SQLite、真实适配器替身、生产构建浏览器夹具；无真实下单 |
| 共享运行时 | `server/runtime/`、数据面、摘要/SSE、调度、IPC、缓存和执行历史读取 | Windows 原生测试；UDS 专属用例本地跳过，核实对应提交 CI |
| ASTER | 单账户、普通配对、成交后核对、保证金、ADL、共享写入保护、中继、dashboard 摘要 | 受管 Engine→HTTP 最小探针、相关既有测试；不声称遍历所有实时状态 |
| Monitor | 市场发现、身份、排名、显示节流、报价时钟、价格/资金费历史、机会导入、图表选择 | 真实生产者→消费者离线链；未抓取实时交易所目录 |
| CrossEx | 持仓投影、配对会计、操作资格、订单历史/活动单、资金费、行情与目录缓存 | 真实 runtime/view/summary 与内存 SQLite；没有实盘或全页面浏览器验收 |
| Asset | 账本、估值/换汇、出入金、导入、历史、持仓目录/周期、成交缓存、同步与删除 | 真实存储函数、SQLite、并发映射与离线外部读取；无真实凭据 |
| Greeks | 策略结构、Greeks、订单/RFQ、单腿失败、任务停止、恢复、收益归属、持久化、页面状态 | Python 与 Node/VM 测试；旧新版本差异复核，未把 VM 测试称为浏览器测试 |
| Entropy/Lighter | 真实行情解码器、延迟研究、双腿模拟、Binance 方向模拟、费率版本、暂停恢复、页面轮询 | 离线回放、120 项相关测试和临时修正定位后的浏览器夹具 |
| 期权回测 | `tools/options-backtest/optbt/` 全部实现、CLI、Parquet、UTC、趋势、费用、永续、结算、报告 | 合成 Parquet 的真实 CLI、现有市场夹具；不随工作台模块发布 |
| 安装、发布与恢复 | `deploy/`、pipeline、更新器、prepare/activate、双槽、缓存/清单、冷备份/恢复、Actions | 无副作用 CLI/阶段探针；Linux/systemd 复用既有 CI，不使用 WSL |
| 安全 | 已请求 Codex Security Deep Scan | 启动前受权限配置阻止；没有扫描结果、完整威胁模型或依赖漏洞审计结论 |

审查不修改业务代码、不运行真实订单/划转、不部署服务器、不向外部通知渠道发送消息。GitHub Issues 为用户要求的交付。

## 2 新增问题登记

每条 Issue 保存固定提交源码链接、触发条件、复现结果、反证与验收标准。下表用于安排工作，不替代问题单详情。

| Issue | 级别 | 已确认问题 | 影响及证据 |
| --- | --- | --- | --- |
| [#83](https://github.com/hxx344/project-aggregation/issues/83) | P1 | CrossEx 终态历史挤出外部活动订单 | 300 条终态历史后，摘要活动单为 1，页面响应活动单为 0，撤单入口消失 |
| [#84](https://github.com/hxx344/project-aggregation/issues/84) | P1 | LUNA/LUNA2 投影与服务端身份不一致 | 同一组等量对冲被拆成 +2/-2 两个单腿；服务端能绑定，页面不能组合调整 |
| [#85](https://github.com/hxx344/project-aggregation/issues/85) | P1 | Hyperliquid 目录币种与价格历史白名单冲突 | 真实目录 BTC 的 USDT 报价/USDC 结算被 reader 拒绝，尚未调用上游 |
| [#86](https://github.com/hxx344/project-aggregation/issues/86) | P1 | 中文合约在机会榜与图表链路的校验不一致 | discovery/ranking 接受，URL 抛错、历史 API 返回 400 |
| [#87](https://github.com/hxx344/project-aggregation/issues/87) | P1 | Asset 120 秒同步锁失效与迟到写入 | 删除的账号条目/金额被旧刷新恢复；旧 finally 删除另一任务的新锁。凭据没有恢复 |
| [#88](https://github.com/hxx344/project-aggregation/issues/88) | P1 | ASTER 单账户最终发送缺少规划依据时效检查 | 持久化延迟约 9 秒，BBO/账户都过期，真实受管 HTTP 链仍发送双腿市价请求到 MockTransport |
| [#89](https://github.com/hxx344/project-aggregation/issues/89) | P1 | 双腿模拟成交时不再核对最低金额 | 合法信号后报价变化，8.68 USDC 低于最低 10 USDC，仍计为完成并生成收益 |
| [#90](https://github.com/hxx344/project-aggregation/issues/90) | P2 | Hub/CrossEx 高频读取全量终态历史 | 同步扫描、排序和 JSON 解析随历史规模增长；有规模实测 |
| [#91](https://github.com/hxx344/project-aggregation/issues/91) | P2 建议 | ADL 可考虑按合约独立推进减险 | 首个尾差使后续可执行合约停止；现有文档允许保守阻塞，须先明确策略选择 |
| [#92](https://github.com/hxx344/project-aggregation/issues/92) | P2 | 研究页浏览器夹具同名定位冲突 | 新增方向面板后有两个 ANTH/SNDK 按钮，原夹具严格模式失败 |
| [#93](https://github.com/hxx344/project-aggregation/issues/93) | P1 | activate 成功缓存跳过健康核验 | 首次成功后关掉健康端点，重跑仍 exit=0 且不再安装/探测 |
| [#94](https://github.com/hxx344/project-aggregation/issues/94) | P1 | pipeline 提交与实际部署目标未绑定 | 发布 A 候选，安装器选择正式 B，B 的 HTTP 200 可归入 A 的成功记录 |
| [#95](https://github.com/hxx344/project-aggregation/issues/95) | P1 | 回测按全月中位数猜单位 | 追加晚于 end 的数据，使同一历史报价 400→0.01 美元，历史盈亏随之变化 |
| [#96](https://github.com/hxx344/project-aggregation/issues/96) | P1 | 回测到期边界仍允许按旧盘口成交 | 到期小时开仓生成 37.20 美元虚假盈利；延迟日历平仓多计 11.01 美元时间价值 |
| [#97](https://github.com/hxx344/project-aggregation/issues/97) | P2 | 回测最差持仓盈亏漏入场点 | 入场估值 -57.52，报告最差 -50.11，少计 7.41 美元损失 |
| [#98](https://github.com/hxx344/project-aggregation/issues/98) | P2 | Bybit 未创建确认漏查 status=3 | 已创建后终结、零成交的策略未被认领，审计却记为未创建；未证明重复敞口 |

### 优先级与同类路径

第一批处理 #88 的最终发送依据、#87 的过期写者，以及 #83 的活动订单完整性。它们分别影响资金动作前提、本地账本正确性和人工处置入口。#93/#94 在下一次使用 pipeline 激活前处理，保留既有正式晋级边界。#95/#96 修复前，相关回测结果不应作为经过本轮审查认可的策略证据。

#84–#86 一起补生产者到消费者契约，不能只改某层正则或人工测试夹具。#89 要同时核对 study、双腿 paper 与单平台 scalper 的规则适用边界。#90 可以分 Hub/CrossEx 两个实施批次，但同一问题单追踪完整性与性能；不能靠截断活动数据“优化”。

## 3 关键复核与排除项

- ASTER #88 和 Asset #87 均由第二位审查代理从真实入口独立复现。所有权有效不等于规划证据仍有效；客户端超时也不等于服务端旧任务已停止。
- ADL #91 的行为可复现，但[现有说明](../modules/aster/docs/README.md)允许尾差不足时保留现场。最终按 P2 建议登记，未将其写成已经违反策略契约的 P1。
- Bybit #98 的零成交终态并未证明继续预览造成重复仓位。降为 P2，重点是原策略身份和证据语义；[官方策略列表文档](https://github.com/bybit-exchange/docs/blob/master/docs/v5/strategy/strategy-list.mdx)核对日期为 2026-10-30。
- 直接给 Lab 注入缺失 sourceAt 曾能产生低层异常，但实际 decoder 会先拒绝此输入，未作为生产缺陷登记。#89 的复现保留合法源时间和 nonce，确实经过 decoder。
- Greeks 锁内返回旧持仓却标新鲜的初始候选，在最新版本已有 `load_positions_snapshot()` 与随结果返回的时效标记，已撤回。原 #23 坏目录缓存与 #24–27 的已修流水线问题不重新登记。
- 原生执行等桶乘数、海力士等金额向下取整、续跑剩余原生数量、OKX 合约身份变化、改单保留总数量等关键路径，本次未发现新增高置信阻断问题；这不是对全部交易所状态的证明。

## 4 性能实测

环境为 Windows、Node 24.15.0、内存 SQLite。没有生产数据量和服务器指标；结果用于证明工作量增长及建立可重复基线。两模块夹具不同，不据此横向比较模块优劣。

| 路径 | 历史规模 | tick/summary | state/view | 方法 |
| --- | ---: | ---: | ---: | --- |
| Hub 原生执行 | 0 | 0.007 ms | 0.026 ms | 预热后 7 次中位数 |
| Hub 原生执行 | 1,000 任务 | 19.20 ms | 18.90 ms | 同上 |
| Hub 原生执行 | 5,000 任务 | 108.10 ms | 127.29 ms | JSON 约 23.43 MiB，全为 completed |
| CrossEx | 1,000 订单 | 1.34 ms | 3.26 ms | 单次真实 runtime 内存夹具 |
| CrossEx | 10,000 订单 | 25.21 ms | 29.20 ms | 全为终态，view 最多返回 300 条 |
| CrossEx | 50,000 订单 | 104.72 ms | 130.70 ms | 查询计划为全表扫描和临时排序 |

Hub 默认每秒 tick，读取与解析发生在事件循环。CrossEx summary/view/activeOrders 等共享全量读取函数。优先改查询范围与索引，而不是先换语言、数据库或延长数据有效期。修复的退出条件必须同时包含活动/未知记录完整性、解析行数和时延。

根前端生产构建已完成：入口 JS 约 295.40 kB（gzip 92.81 kB），共享图表 chunk 约 315.11 kB（gzip 94.19 kB），研究页约 79.43 kB（gzip 24.71 kB）。这是构建体积，不是加载速度或用户体验指标，本次没有据此单独定性缺陷。

## 5 实际验证记录

### 最终基线或可直接复用的结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm run check` | 通过 | 快进到 37cb9e2 后重新执行 |
| `pnpm exec vite build --outDir <隔离临时目录>` | 通过 | 当前生产前端，未覆盖仓库现有 dist |
| 原生执行/交易所/HTTP/OKX/data-plane/updates-client 六文件 | 179 通过、17 跳过、0 失败 | 17 项为 Windows 跳过的 socket/UDS 专属检查 |
| Entropy/Lighter 六文件 | 120 通过 | 相关源码、配置、测试在两基线间无变化，差异核对后复用 |
| `trading-execution.browser.mjs` | 15 场景通过、66 请求 | 当前生产构建；预览/幂等重试/未知结果/停止/移动端/过期；所有 API 为隔离夹具 |
| `entropy-lighter.browser.mjs` 原版 | 失败 | 两个同名标的按钮导致严格定位失败，#92 |
| 上述研究夹具的临时限定区域版本 | 原场景通过，45 读取、7 模拟写入 | 只调整两处定位到“价差标的”，未改仓库测试；不把它冒充原版通过 |
| pipeline/recovery 九文件首轮 | 193 通过、26 失败、2 跳过 | 24 失败来自共用初始化误选缺 pydantic 的 Python |
| recovery-admission 定向重跑 | 24/24 通过 | 显式使用既有 `.venv-aster`；不重复整组 |
| pipeline/recovery 剩余两项 | 未通过 | Windows 跨卷 junction 的 MODULE_NOT_FOUND/649；组合备份 UNSAFE_RUNTIME_LOCK_PATH，未认定生产缺陷 |
| 更新器 prepare/scope 定向检查 | 7/7 通过 | Windows 原生离线 |
| options-backtest 现有测试 | 21 通过、1 ERROR | Windows 清理仍被 NumPy mmap 持有的 ask.npy 失败；不能称全套通过 |
| 新问题探针 | 相关场景均重现 | Issue 内列明真实函数/CLI、输入、输出、反证；不使用线上数据 |

根六文件实际命令：

```powershell
node --test --test-concurrency=2 tests/trading-execution.test.mjs tests/trading-execution-exchanges.test.mjs tests/trading-execution-http.test.mjs tests/trading-okx.test.mjs tests/data-plane-client.test.mjs tests/updates-client.test.mjs
```

研究六文件实际命令：

```powershell
node --test --test-concurrency=2 tests/entropy-lighter-lab.test.mjs tests/entropy-lighter-scalper.test.mjs tests/entropy-lighter-scalper-integration.test.mjs tests/entropy-lighter-feeds.test.mjs tests/entropy-lighter-auto-fees.test.mjs tests/entropy-lighter-insights.test.mjs
```

回测实际命令为 `python -m unittest discover -s tools/options-backtest/tests -v`。CLI 复现使用 `python -m optbt run <JSON> --data <临时Parquet目录> --out <临时输出目录> --json`。实际 NumPy 2.4.6、PyArrow 25.0.1，与该工具要求的 2.5.4/26.0.0 不同；未安装依赖，离线数值分支另由主任务核对/复现。Greeks 的旧基线检查使用已有完整依赖的系统 Python 3.11，未把缺依赖的仓库 `.venv` 描述为可用。

### 初始基线的补充记录

`1f64c50` 上还实际运行了：ASTER 28 个相关测试模块 534 项通过；Asset 两组各 136 项、Greeks Python 145 项和 Node/VM 141 项通过；Monitor/CrossEx 首批 170 项通过、第二批九文件退出码 0；根交易相关十文件 185 项通过。它们帮助发现测试未覆盖的失败路径，但涉及后续源码变化的结果不作为最终基线整套通过的证据，也不累计成唯一测试数量。

最新提交的 [Checks 40845978703](https://github.com/hxx344/project-aggregation/actions/runs/40845978703) 和[正式发布 40846393425](https://github.com/hxx344/project-aggregation/actions/runs/40846393425)已核实成功。Checks 包含真实 systemd 恢复、双槽、激活/增量、模块、relay、镜像和部署包验证。复用这些 Linux 结果，未使用 WSL；CI 成功不代表本报告新增故障场景已有回归。

## 6 既有 Issues 与未完成项

审查前检索了开放和关闭问题单；当时开放项为 #30、#46、#47、#48、#55、#63、#71，未重复创建。

| 既有项 | 本次处理 |
| --- | --- |
| [#55](https://github.com/hxx344/project-aggregation/issues/55) 显示节流恢复 | 离线回放确认：同步新帧已能排名，显示仍可能等 20 秒常规周期；相关源码未变化，不新建 |
| [#71](https://github.com/hxx344/project-aggregation/issues/71) 双槽 main 串联覆盖 | 仍待补齐；已有真实 systemd 辅助链，不能描述为“没有双槽测试” |
| [#63](https://github.com/hxx344/project-aggregation/issues/63) 采集启动仲裁强杀恢复 | 保留既有跟踪，不声称本次修复 |
| [#46](https://github.com/hxx344/project-aggregation/issues/46)、[#47](https://github.com/hxx344/project-aggregation/issues/47)、[#48](https://github.com/hxx344/project-aggregation/issues/48) | 指标范围/口径演进，沿原单处理 |
| [#30](https://github.com/hxx344/project-aggregation/issues/30) Aster 归档成交时间 | 仍为原单跟踪，本次不重复登记或声明结案 |

安全扫描调用在创建任何扫描前返回：

```text
Deep Scan cannot safely start a read-only worker: the parent must provide a managed filesystem permission profile.
```

当前会话为 unrestricted 文件权限，插件要求受管理的权限配置。本次没有绕过限制、重启替代扫描或伪造安全报告。配置就绪后，应以固定源码基线继续正式深度扫描，覆盖鉴权/凭据、模块代理、IPC、备份恢复、特权更新、执行边界和供应链，再合并去重后的安全问题。安全发现、扫描覆盖率与 token 消耗均无可用测量，不填零。

生产账户规模、实际 API 延迟、磁盘/WAL 增长、四周 SLO、异地材料取回与生产 RPO/RTO 未取得证据。浏览器完成的是隔离业务夹具，未启动带真实凭据的五模块整站。演进稿将这些事项列为退出条件，而不是已完成能力。

## 7 本次交付边界

交付为 Issues、本文、技术演进初稿及一条经验证的同步锁经验，不包含业务修复、服务器部署或新的运行包。沿用仓库文档提交工作流；最新正式运行版仍为审查基线版本。

本次留下两个 Windows 临时诊断材料：跨卷目录链接 `audit-entry-jk4wtn/pipeline` 与回测 mmap 测试目录 `tmpb5ae0s19`。自动审批拒绝其清理操作，仅返回 `blocked by policy`；未扩大删除范围，不影响仓库交付文件。它们不含真实账户凭据。
