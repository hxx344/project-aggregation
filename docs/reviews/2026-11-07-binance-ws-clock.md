# Binance WebSocket 与只读时间校准

风险等级：R3。用户在 Lighter 修复过程中新增 Binance 请求：截图为 ANT 只读组合保证金仓位 HTTP 400 / -1021，并要求 Binance 同时切换 WS。

## 变更前范围

- 普通 U 本位与组合保证金的执行盘口、订单状态优先消费 Binance WS；执行账户的身份、仓位、外部挂单及风险准入继续完整 REST 检查。提交、改单和撤单仍沿既有签名 REST 通道，不增加未知写入重试。
- 只读账户的仓位增量通过其自身凭据 WS 更新工作台缓存，保持配置 revision 与实盘账户隔离。资金费历史继续 REST。WS 不提供的强平价/标记价等字段保留必要 REST 核对，不用仓位事件延长旧风险数据的有效期。
- 为 Binance 只读请求补上明确 -1021 后的有界校时和一次重签重试，与执行请求共用校时组件。保持 recvWindow，不把时间错误归因于限流或权限；未知写入不因校时而重复发送。
- WS 固定官方公共/私有目的地；listenKey 仅以 API Key 访问，生命周期与账户模式隔离，普通关闭不 DELETE 可能由其他连接共用的 listenKey。断线或换凭据使旧基线失效，先建流缓存事件，再以 REST 基线与增量合并。
- 回滚：按现有流程停止并核对任务，恢复上一正式版；保留数据库、订单意图与账户配置。没有结构迁移，旧版本继续按原 REST 路径核对，不重发未知交易。不部署服务器。

## 计划验证

按风险覆盖校时正负偏移、并发与取消、持续 -1021、未知写入不重发；普通/PM WS 地址、listenKey 续期与隔离、超大订单 ID、部分成交/终态、同毫秒乱序、显式零仓/空增量、重连基线竞争及风险字段时效。检查真实只读仓位入口与执行入口，并对受影响可见交互做定向验收。

本记录只描述新增 Binance 增量；Lighter 已在 `8a3884f` 提交并推送开发分支，其独立审查和测试沿用已有记录。最终统一完成必要 CI 和正式发布。

## 已执行验证

协议由本轮规划代理实际核对 [普通 UM 私有流](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams)、[组合保证金私有流](https://developers.binance.com/en/docs/products/derivatives-trading-portfolio-margin/user-data-streams) 与 [listenKey REST](https://developers.binance.com/en/docs/catalog/advanced-trading-derivatives-trading-portfolio-margin/api/rest-api/user-data-streams)，并读取官方 SDK 固定提交 [`01d123b`](https://github.com/binance/binance-connector-js/blob/01d123b3e92d1f55315d594468f1ab7ee37be7ea/common/src/constants.ts) 的地址、PM 连接实现及订单/仓位事件字段。普通 `/private`、PM `/pm`、BBO `/public` 分别路由；PM 只消费 `fs=UM`；listenKey 使用 API Key，无签名与时间戳，60 分钟到期，提前续期并在 24 小时前轮换。本地关闭不删除可能共用的 token。文档与静态 SDK 核对不等于真实私有账户联机验收。

- Windows 原生运行 clock、stream、只读/执行 stream、两类适配器、ANT watch、runtime/scheduler、execution/HTTP、auto、ANT reduction/HTTP 十四份测试，401/401 通过。覆盖普通与组合保证金的实际流管理器，连续一分钟健康盘口/订单推送不发 REST 轮询；改单与停止维持原 ID、原总量，未知 create/amend 不重发。
- `pnpm run check`、`git diff --check` 与 Vite 生产构建通过。Playwright 在工作台 ANT 实际页面上以受控 API 验证五个场景：-1021 时间错误、WS 数量与入场价更新、风险字段待核对、REST 风险恢复、显式零仓清除。首次浏览器夹具缺少当前选择状态端点，补齐并清理会话后五项通过；未修改产品界面。
- 合入主线 `4be9aa4` 的成交跟踪及 ANT 历史/盈亏修正：相关六份测试 199/199、类型检查和经验路由 2/2 通过，独立合并复核通过；Binance 增量恢复后，执行 WS、HTTP、历史 HTTP 及自动减仓四份集成测试 58/58 通过。其余输入未变化的 401 项结果复用，各组有重叠，不相加计数。
- 验证时发现并关闭一项只读基线竞态：ready/校时失败后仍有旧 socket 事件到达，可能把 REST fallback 的时间与仓位回退到旧基线；失败时清除基线，重新 ready 加 REST 建立前只缓存事件，不发布旧状态。真实流管理器回归覆盖失败与恢复。
- 后续自审发现 WS 盘口曾用本机接收时间进入执行器，隐藏了来源传输延迟：事件到达时旧 4 秒、再等待兄弟腿 7 秒，实际旧 11 秒的盘口仍被十秒门槛接受。新增普通/PM、正负时钟偏移的两项生产流与执行校验回归均先失败；统一按交易所原时间减校时偏移修复后，执行 WS 文件 19/19 通过。此前未变测试继续复用，本次只重跑受影响文件。
- 独立审查复现可见性 P2：余额变动而 `P=[]`、或非关注合约仓位变化后，旧强平价仍显示 live。自动减仓的 `startRiskReduction` 实际重新读取实盘 `execution.account` 风险，不读取只读 watch，故该问题不直接授权交易。现只透传 `balanceChanged` 布尔，余额/其他合约事件使账户风险失效并递增在途 REST 风险序列；不清仓、不改数量或基线时间、不增加网络请求。四项普通/PM 回归先红后绿，涵盖现有基线、在途 REST 及随后恢复；stream、readonly 与 ANT watch 55/55、类型检查通过。
- 未执行真实私有 WS、真实资金交易或服务器部署；未使用 WSL。本地未重复全仓回归，Linux 发布包和发布所需检查由既有 CI 执行。

## 独立审查与交付

审查固定于基线 `09940e0` 上的 Binance 差异，Codex Security scan `210b379c-d5d9-46ea-8839-71781656a306` 已封存并回读核实，独立代理调用参数为 `gpt-6-astra / ultra`。覆盖七个源码文件及相关测试：校时、流生命周期、只读仓位基线、执行订单恢复、工作台缓存发布、诊断与 ANT 风险时效。两个业务候选均保留原始证据并在安全层判为 `not_applicable`；未证明攻击者权限增益，安全发现为零，不抹去业务 P1/P2。两项修复分别经独立生产模块探针复核通过，无未处理 P0/P1/P2。初版固定快照没有替换成修复后的快照，增量探针及两次 exit 0 输出分别保存在扫描的 `binance-independent-probes` 与 `binance-risk-fix-probes` 记录中。

自审适用通用、外部输入/凭据、金额与订单身份、缓存/恢复和交付类别；没有数据库结构、依赖或安装配置变化。执行准入继续使用完整账户读取，WS 仓位不会获得下单权限；强平价等缺失字段保持未知。回滚先停止并核对活跃任务，再恢复上版，保留订单与恢复数据。
