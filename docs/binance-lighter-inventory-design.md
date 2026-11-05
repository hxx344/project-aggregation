# BN 双边库存报价成本研究

## 目标、范围与回滚（2026-11-05）

风险等级 R3。将旧的「开仓 → 对冲 → 定时平仓」模拟改为 BN 同时双边 Maker 报价、根据 BN 净库存调整价格和数量、Lighter 对冲净敞口的持续模拟。每个币种和延迟组合是一个独立账户，不再按买卖方向拆开。仅模拟，不接入真实凭据、订单或服务器部署。

影响范围为研究引擎、模拟执行适配器、研究持久化及 API 投影、现有研究页面、相关测试。公开行情采集和工作台会话鉴权沿用既有边界。旧会话保持原始口径，不把单轮结果转换为库存策略结果。

新模型使用 schema 2 和独立的 v2 配置、会话及归档文件；旧版文件只读，提供旧记录及敞口摘要和下载。失败保留已成交库存与费用，行情短暂失效撤下报价并等待新证据，不以超时冒充平仓。回滚时停止研究、导出当前记录、切回上一正式版本；保留全部 v1/v2 数据，旧版本只读取原有文件。

## 核心约束

- BN 目标净库存为零，允许库存围绕零连续变化。多仓时降低买价与买量、降低卖价并提高卖量；空仓时相反。价格按 tick 舍入，始终满足 Post-only。库存上限同时覆盖当前库存及同侧剩余挂单，不能依靠另一侧未来成交抵消预留。
- 现有买卖挂单先处理新到的主动成交，再按成交后的库存重报；同一条成交不能成交刚创建的报价。公开成交量消耗可见队列，撤单缩量不算成交。目标价格无可见排队证据时不假设零队列。
- 重报有最小间隔；相同价格与数量保留队列，替换报价重新排队。挂单寿命到期只重报，不产生「平仓超时未决」。
- 每情景最多一个已提交的 Lighter IOC；BN 反向成交更新净需求，原 IOC 终态后重新计算剩余净敞口。对冲延迟与来源时间要求保留；只有新到的合格盘口能成交。部分成交记录实际数量，失败有界重试，耗尽后保留真实模拟余额并阻止继续报价。
- 停止、重启和归档不伪造零库存。服务重启保持停止，不恢复丢失的排队位置。

## 统计与界面

每场所独立使用精确数量及平均成本账本，记录已实现盈亏、剩余库存成本、全部费用和 BN 成交额。主指标为「盯市成本」：全部费用减已实现与未实现盈亏，再除以全部 BN 模拟成交额乘 10,000；明确包含未平库存估值，不能称为已平仓成本或可兑现利润。估值缺少合格双腿价格时留空。资金费仍只是另列的可选情景。

沿用 React/Recharts，分析任务是比较延迟下的成本并监控库存与残差。主阅读顺序为双边报价/库存、成本比较、按需单情景曲线与成交记录、行情质量、旧版记录。单页一张有界时间序列图，缺值断线；数值及单位直接展示，桌面和窄屏均在表格内部滚动，轮询和请求代次沿用既有实现。

## 必要验证

双边同时存在、零/多/空库存的价格与数量方向、同侧挂单预留与库存上限、Post-only/tick/lot/min-notional、队列重报与同事件不成交新单、双向成交与单个在途对冲、部分对冲/超时/重复帧/旧帧、短暂行情失效恢复、账本跨零及现金流守恒、盯市缺失与费用/成交额分母、长时间运行内存边界、旧文件不改写与新文件故障恢复。完成相关后端测试、类型检查/生产构建、工作台实际入口的关键浏览器验收、独立审查和安全差异审查，再按仓库现有流程提交、推送和正式发布。

## 并行实施数据契约

配置 `schema:2`：`symbols`、`latencyScenarios`、`orderNotional:1000`、`maxInventoryNotional:5000`、`maxUnhedgedNotional:2000`、`quoteOffsetBps:0`、`inventorySkewBps:2`、`quoteRefreshMs:1000`、`quoteMaxAgeMs:15000`、`hedgeWaitMs:2000`、`maxBookAgeMs:1000`、`maxSourceAgeMs:2000`、`maxPairSkewMs:750`、`maxHedgeSlippageBps:5`、`queueMultiplier:1`、`binanceMakerFeeBps:0`、`lighterTakerFeeBps:0`、`fundingCostBpsPerHour:null`。库存上限不得小于单侧订单名义额；所有金额均为 USDC 名义单位。报价量因子为 `1-r` 与 `1+r`，`r` 为带方向的 BN 库存名义额除以上限并限制在 [-1,1]。新增报价还须同时约束当前净敞口和在途对冲全部成交后的净敞口，不能把未成交对冲当作已经完成。

报告保留 `sessionId/startedAt/updatedAt/stopped/interrupted/mode/sessionConfig/markets/books/channels/diagnostics/assumptions/detailLevel`，`schema:2`，新增 `strategy:'inventory_quotes'`。每情景 ID 为 `BTC-inventory-300` 这类格式，包含：

- `id/symbol/latencyMs/status/reason`，状态为 `waiting/quoting/hedging/recovering/blocked/stopped`。
- `inventory:{binanceQuantity,lighterQuantity,residualQuantity,projectedResidualQuantity,binanceAveragePrice,lighterAveragePrice,binanceNotional,utilization,limitNotional}`；名义额带方向，数量单位为标的币。
- `quotes:{buy,sell}`，每侧为 null 或 `{id,side,price,quantity,remainingQuantity,queueAhead,submittedAt}`。
- `hedge` 为 null 或 `{id,side,quantity,dueAt,attempt}`。
- `stats:{quoteUpdates,makerFills,hedgeFills,hedgeFailures,binanceTurnover,lighterTurnover,fees,realizedPnl,unrealizedPnl,netPnl,markedCost,costPer10000,fundingScenarioCost,modeledCostPer10000}`。`realizedPnl` 为两场所各自已实现价格盈亏之和，`unrealizedPnl` 为合格各场所中间价估值之和，`netPnl=realizedPnl+unrealizedPnl-fees`，`markedCost=-netPnl`。估值不可用时后四项估值相关量为空；已知费用及已实现量保留。
- `valuation:{at,valid,reason,binanceMark,lighterMark}`，有效期独立核对双腿来源及接收时间，不以报价准入的成交频道状态替代估值时效。
- `recentFills` 使用既有成交字段，阶段改为 `quote/hedge`，最多 200 条；`history` 最多 300 点，每点 `{at,costPer10000,modeledCostPer10000,binanceQuantity,residualQuantity}`；`events` 最多 30 条 `{at,type,reason}`。摘要不返回逐笔/曲线/事件，完整导出明示滚动记录窗口但累计统计保留全会话。

状态的 `config/report` 使用新契约，`schema:2`。`archives` 保持统一列表，每条包含 `schema:1|2`、原 `sessionId/startedAt/endedAt/interrupted`，旧版保留 `completed/unresolved`，新版包含 `makerFills/hasExposure`。另返回 `legacySession`（旧版当前报告的摘要或 null），包含原 `completed/unresolved` 和 `exposures:[{id,symbol,binanceQuantity,lighterQuantity,residualQuantity}]`；下载仍走 `/report/<sessionId>`，不会把旧版报告放入新 `report`。

新文件为同一目录下 `config-v2.json`、`session-v2.json`、`archives-v2.json`，归档新子目录 `archives-v2`。旧 `config/session/archives.json` 及 `archives/` 完全不写；只迁移已知配置值，移除旧持有和开平轮次参数，旧报告原样下载。`cooldowns.json` 沿用既有共享限流事实。
