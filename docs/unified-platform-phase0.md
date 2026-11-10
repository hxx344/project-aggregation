# 统一平台阶段 0：首批功能与契约清单

日期：2026-11-10，2026-11-11 同步总方案 v0.6 的阶段编号。状态：**首批实施准备清单，原型尚未运行**。对应[总体方案](unified-platform-plan.md)。本文固定源码基线为 [feb56f0df49a4e53f8c9abb495e8413568486c74](https://github.com/hxx344/project-aggregation/commit/feb56f0df49a4e53f8c9abb495e8413568486c74)，不把总方案附录 a12e583 的历史状态当作新基线。

本次完成首批范围、接口与失败场景的梳理，不表示全部功能矩阵、性能预算或阶段 0 所有退出条件已经完成。代码及测试引用仅是已存在的资产；本轮没有运行这些代码测试、连接真实交易账户或部署服务。

## 1 已确认输入与首批范围

| 项目 | 已确认内容 | 实施含义 |
| --- | --- | --- |
| 使用场景 | 自用、单台 Linux 服务器 | 首期沿用单用户工作台，保持统一仓库和发布 |
| 整机配置 | 4 核 CPU、8 GB 内存、120 GB 磁盘 | 是整机标称配置，不是新应用可独占的资源，也不等于剩余空间 |
| 首批场所 | Binance、Bybit | 不擅自增加第三家交易所 |
| 业务优先级 | 原生交易中心的 ANT／原油 | 先完成两所原油双腿；ANT 按现有能力分步覆盖 |
| 测试环境 | 没有专用测试服务器或测试子账户 | 先使用离线模拟、脱敏录制和既有 Linux CI，不要求立即开通新环境 |

基线的 Binance 与 Bybit 均接入原油 CLUSDT、BZUSDT；Binance 还接入 ANTHROPICUSDT，Bybit 没有 ANT 白名单。现有 ANT 组合接口要求两条不同合约身份，同所组合还要求不同合约。因此仅选 Binance + Bybit 时，无法组成现有 ANT 套利双腿，也不能把连接器单订单模拟包装成新建的 ANT 单腿交易功能。依据：[场所能力](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/server/trading-markets.mjs#L14-L25)、[组合约束](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/server/trading-execution-plan.mjs#L93-L137)。实际交易所目录仍须在未来接入时核验，源码白名单不是实时上架证明。

首个执行切片固定为一个原油合约的跨所相反方向双腿，默认用 CLUSDT 构造离线样例。验证链为：账户及目录 → 报价与仓位 → 预览 → 幂等确认 → 两腿执行 → 成交或撤单核对 → 任务结果与账本证据。BZUSDT、同所 CL/BZ 价差、四腿和自动规则属于同域后续用例，不能在只通过首切片时声称全部迁移完成。

ANT 首批交付目录、行情、仓位、成交证据和连接器契约准备。完整 ANT 组合、双腿减仓和保护仍在总功能矩阵中保留，后续具备第二个支持场所时再进入对应迁移；当前不新增单腿业务接口或扩大交易所范围。

## 2 首批功能矩阵

下表的证据状态均为“源码/测试资产已定位，新原型未验证”。现有只读与实盘路径属于旧系统；新原型使用独立数据目录及模拟传输，不取得旧账户的执行权。

| 编号 | 能力与入口 | 首批范围和执行归属 | 目标阶段（总方案 v0.6 编号）与验收结果 |
| --- | --- | --- | --- |
| F01 | 交易中心账户连接 | Binance 普通 U 本位/Portfolio Margin、Bybit unified；真实主体与凭据绑定分离 | 原地收敛/1：模式不明或身份缺失可显示原因，不能提交执行；换 Key 不产生新主体 |
| F02 | 原油报价、盘口、仓位与挂单 | 两所 CLUSDT/BZUSDT；展示数据与执行专用证据分开 | 原地收敛/1：缺失、过期、断线与真实零值分别呈现；原始接收年龄不被转发刷新 |
| F03 | 价差下单预览及确认 | 先 CLUSDT 跨所双腿，保留精确桶数、每腿规则与模式 | 1：预览不发送；重复确认只返回同一任务；配置或账户变化要求重预览 |
| F04 | 原订单追踪、停止与恢复 | Binance 订单与 Bybit 普通订单/原生追价策略分别建模 | 1：部分成交保持事实，未知结果核对原操作；停止后仍追踪未决委托 |
| F05 | 本次任务与证据展示 | 本次受理结果绑定任务 ID，独立于全局历史页和刷新成功与否 | 1/3：提交响应不确定时沿用原请求身份；读取失败不抹掉已确认成交 |
| F06 | 原油成交、手续费、资金费和盈亏 | 原始事实、币种、读取窗口与完整性分别记录 | 1/3：减仓与平仓后口径可对账，缺费用或历史缺口不得补零 |
| F07 | Binance ANT 只读及单位换算 | ANTHROPICUSDT 的报价、仓位、成交与股数假设；Bybit ANT 明确不支持 | 原地收敛/1：不同合约原生单位不混淆；不生成不合法双腿，不声称 ANT 完整收益账本已具备 |
| F08 | 原油同所、四腿及自动规则 | 延续不同预设、观察/实盘模式、独立规则和合约占用语义 | 3：首个手工闭环之后逐项扩展；只通过跨所双腿不能勾选这些功能 |
| F09 | ANT 组合、保护与自动减仓 | 当前两所选择不足以形成现有 ANT 组合 | 后续场所范围确定后迁移；原功能保留在旧系统，不删除、不伪造已验收 |

功能矩阵按旧系统实际合入的提交更新，验收时记录所对照的版本。Market Monitor、Asset、CrossEx、Greeks、ASTER、Aero、研究与系统工作区继续按总方案保留；本表是首批切片，不能用来宣布其他模块退役。

## 3 首批契约草案

这些是新模型需要承载的语义，不表示已有接口已变更。新旧传输格式可通过适配器对接，先固定可观察行为，再决定具体类型文件和包位置。

| 契约 | 最少携带的信息 | 必须保持的规则 |
| --- | --- | --- |
| 账户及凭据绑定 | 场所、环境、真实主体/子账户身份、凭据用途与版本、账户模式、写者归属与代次 | 显示 ID 不替代远端主体；敏感身份不进入公共日志；提交和发送均复核有效绑定 |
| 可执行合约 | 原始合约 ID、类型、结算币、数量单位、乘数、价格及数量步长、最小/最大数量、目录版本 | 精确十进制或原始整数；展示标的不能直接授权执行；不合法场所/合约组合明确拒绝 |
| 观测 | 来源时间、原本地接收时间、连接代次、序列或版本、完整性、失效原因 | 来源重启与迟到消息可区分；跨进程不直接比较不同起点的单调时钟；传输不能刷新原始年龄 |
| 预览 | 身份、到期时间、会话、标准化意图、账户/配置/目录版本、每腿数量与规则、证据时点 | 预览不下单；确认时重新核验；旧预览不能因刷新或切换账户重新获得有效性 |
| 命令及受理 | 稳定 requestId、previewId、载荷摘要、账户执行归属、受理状态与关联 jobId | 同身份同载荷返回原结果，不同载荷拒绝；持久受理不等于成交或命令已生效 |
| 执行任务与每腿操作 | job/leg/原操作 ID、客户端及交易所身份、预占、成交/剩余数量、截止与重试进度、未知证据 | 命令应用状态、任务控制状态、交易所订单状态分开；未知不折叠为失败重发 |
| 业务事实与事件 | 来源稳定身份、币种、数量、业务时间、完整读取范围、事件版本、消费水位 | 重复/乱序有确定处理；持久确认后才推进完整水位；成交、费用、资金费、现金流和估值分别保存 |

现有确认接口使用 previewId、requestId 和 confirmLive，并绑定会话；基线会把本次受理任务作为 acceptedJob 返回。新原型需保留这种受理可追踪性，模拟环境的确认字段不构成真实账户操作授权。依据：[确认与幂等](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/server/trading-execution.mjs#L692-L733)、[HTTP 路由](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/server/runtime/data-plane.mjs#L528-L542)、[客户端受理跟踪](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/src/TradingExecution.tsx#L353-L366)。

Bybit 普通市价订单与原生追价策略不能共用“查不到即重发”的恢复规则。前者按客户端身份查询并在严格观察/现场证据满足后结算；后者缺少可查询的客户端策略编号时，需要受观察窗和现场核对约束的人工处理。新任务不得替换旧未知操作的身份。

数据库沿用总方案的候选选择与写入归属：API 提交候选命令，executor 应用交易状态；外部调用不放长事务，提交校验与写入在同一短事务，最后发送前仍复核。停止、换凭据及账户交接的版本变化必须使在途旧计算失效。

## 4 验收场景与现有测试资产

| 场景 | 输入或故障点 | 新原型必须给出的结果 | 已有资产，未在本轮运行 |
| --- | --- | --- | --- |
| C01 能力与身份 | Bybit ANT、错误合约、重复腿、缺少 UID、Key 轮换 | 不合法组合在任务创建前拒绝；身份不明不取得写入权 | [执行规划测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-execution.test.mjs)、[场所适配测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-execution-exchanges.test.mjs) |
| C02 数量和模式 | 非法步长、分批舍入、极大/小数金额、单向/双向模式、平仓数量不足 | 数量守恒、原生单位准确；平仓不反向开仓或扩大预算 | 同上；按具体用例提取输入和期望，不直接复制全部夹具 |
| C03 预览及重复确认 | 预览过期、配置变化、相同 requestId 重试、同 ID 不同载荷 | 零重复任务/原操作；过期或变化要求重预览；原受理结果可查询 | [HTTP 执行测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-execution-http.test.mjs)、[执行器测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-execution.test.mjs) |
| C04 部分成交与失败腿 | 第一腿部分/全部成交，第二腿拒绝或暂时读取失败 | 保留成交与剩余量，按既定守卫处理未决腿；暂停后续批次不抹除敞口 | [执行器测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-execution.test.mjs) |
| C05 崩溃与未知请求 | 落盘前、落盘后发送前、发送后回执前、回执落盘前中断；迟到回执 | 重启核对同一身份，不盲重发；普通订单和 Bybit 追价策略保留各自恢复条件 | [执行器测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-execution.test.mjs)、[账户写入保护测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/account-writer.test.mjs) |
| C06 时效与写者变化 | 旧/未来报价、断线、序列缺口、IPC 积压；读取中暂停、换凭据或换写者 | 无效证据不授权发送；旧结果不写回；仍核对已经发送的委托 | [自动规则测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-auto.test.mjs)、[Binance 执行流测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-binance-execution-stream.test.mjs) |
| C07 页面结果与后台任务 | 提交响应丢失、总览刷新失败、历史分页改变 | 重试沿用原请求 ID；已确认成交和 acceptedJob 不被读取失败覆盖 | [执行浏览器夹具](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-execution.browser.mjs) |
| C08 账本与现金流 | 重复/乱序成交、分页失败、缺费用、仅入金、内部转账与缺汇率 | 持久去重；不提前推进完整水位；未知保留；纯入金不产生投资盈利 | [原油盈亏测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/tests/trading-pnl-pairs.test.mjs)、[现金流测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/modules/asset/tests/cash-flows.test.ts)、[日变化测试](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/modules/asset/tests/daily-changes.test.ts) |
| C09 存储竞争与恢复 | API 保存、执行落盘、回填、长查询、备份与 checkpoint 并发 | 记录锁等待、队列及最终证据年龄；失败有界，恢复保留未决操作 | 复用[写锁统计](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/server/sqlite-writes.mjs)；新原型组合场景待实现 |

每个场景后续分别登记：输入版本、模拟/录制/真实来源、运行命令、固定提交、实际结果及未覆盖项。现有测试存在不等于新原型已通过；同名测试也需核对是否真正覆盖新接口。录制材料先脱敏，不含真实密钥、签名或可执行请求。

## 5 基线增量与证据使用

总方案附录保存 a12e583 时的事实；本清单使用更新的 feb56f0，不回写成旧版本已经具备后来能力。

- 新基线已加入执行任务证据导出。它是只读持久状态投影，不能冒充重新核对了交易所现场，见[执行证据实现](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/server/trading-execution-evidence.mjs)。
- Asset 已加入人工现金流标注、版本审计、严格内部转账匹配与日变化归因，但覆盖仍明确不完整；原资产变化口径继续保留，不能改称完整投资收益，见[现金流契约](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/modules/asset/lib/cash-flows.ts#L18-L90)、[日归因](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/modules/asset/lib/daily-changes.ts#L103-L116)。
- 原油账本与 ANT 持仓、成交证据的覆盖仍分别记录。不能因为同一账户同时持有两类标的，就把原油收益数据套到 ANT；场所和合约身份按[当前目录](https://github.com/hxx344/project-aggregation/blob/feb56f0df49a4e53f8c9abb495e8413568486c74/server/trading-markets.mjs)保持。

功能矩阵的新实现基线在开始编码时再次固定；若旧系统又合入相关变更，只更新受影响条目，不重新核查无变化的全部资产。

## 6 资源与验证安排

### 6.1 合成负载起点

原型先使用每所一个逻辑账户、每账户确定的模式夹具。这是合成输入，不代表用户实际账户数。初始订阅集合是 Binance/Bybit 的 CLUSDT、BZUSDT，加 Binance ANTHROPICUSDT，共五个“场所—合约”组合。

按正常双腿任务、重复提交与未决恢复、历史回填和查询并发分别构造场景。逐步增加消息速率、任务数、历史记录、回填批次与并发读；每次记录具体输入和递增维度，不凭单一空载结果认定可上线。实际账户数、历史规模和生产负载在后续取得证据后替换合成假设，不阻塞先编写确定性夹具。

### 6.2 资源证据

- 4 核/8 GB/120 GB 是整机条件。测量旧系统、OS、版本目录、数据库/WAL、备份暂存和新原型共同占用后，才能确定新应用可用余量；不把 120 GB 当作全部可用的数据空间。
- Windows 原生环境用于契约、故障注入、数据库行为与测量工具准备；这些结果不能代替 Linux 安装、systemd 或实际时序验收，禁止使用 WSL。
- 后续复用既有非 WSL Linux CI，在隔离临时目录运行原型；具备条件时用进程组/cgroup 对整组原型限制 CPU、内存，并记录 runner 实际规格和限制方式。runner 资源不足时只报告该规格结果。
- CPU 配额不能复现目标 CPU 性能，内存限制不能完全模拟整机竞争，磁盘空间限额不能复现目标 fsync 延迟。受限 CI 是原型证据，目标服务器容量仍需后续实际测量。
- 记录 CPU、峰值 RSS、事件循环延迟、写锁等待分布及最大值、事务时长、积压、数据库/WAL 增长、备份恢复耗时及最终发送时的数据年龄。所有峰值要包含新旧共存、回填和备份场景。

### 6.3 预算与证据状态

沿用总方案列出的现行约束作为核对起点，例如 Hub 自动双腿本地读取窗口 1500 毫秒、预览盘口年龄 10 秒；它们不是 CPU 延迟、数据库等待或整个任务耗时预算，也不是新原型已经达到的指标。

新增执行、通知、恢复与资源余量预算应在实际原型验证前登记，区分建议值与通过值。当前没有目标服务器基线，也未运行受限 CI，不写吞吐、延迟或恢复时间的达标结论。对预算尚未定义的项目只能报告测量结果，不能标记验收通过。

## 7 下一批实施顺序与退出条件

1. 根据 F01–F09 与 C01–C09 固定首批输入、状态和证据字段，提取现有夹具；保留场所差异，不把旧断言机械复制为新契约。
2. 建立两所原油只读与 Binance ANT 能力校验切片。执行专用行情沿用原路径，展示采集的收敛按总方案单独验收。
3. 在独立代码入口及数据目录准备模拟连接器、持久化和恢复骨架，再完成 CLUSDT 跨所双腿全链路；模拟传输默认不允许意外访问外部写入接口。
4. 连接最小页面，验证预览、确认、acceptedJob、未知状态和重启后的原操作核对。页面可用不表示真实账户执行权已经切换。
5. 将混合负载和 SQLite 写入验证接入原型，同时按阶段 2 准备 ASTER 复杂恢复及时序场景；通过后才冻结相关架构并扩大交易页面和策略迁移。

后续实施开始前按仓库规则完成相应风险定级、规划与独立审查。本次不创建运行代码目录、数据库、CI 工作流或服务；只交付可审查的首批准备清单。

阶段 0 尚需在原型前细化量化预算，并逐步补齐其他工作区的功能矩阵。没有专用测试环境不阻塞当前准备；真实账户身份、历史规模和服务器负载在需要时采集，真实资金操作与服务器部署仍按当次授权执行。

全工作区功能矩阵、数据分类、执行状态图与预算登记见[阶段 0 收口盘点](unified-platform-phase0-inventory.md)。
