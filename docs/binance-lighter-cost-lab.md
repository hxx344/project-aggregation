# Binance / Lighter 成本研究

## 实施范围与风险（2026-11-05）

风险等级 R3。新增工作台独立研究页、公开行情采集、模拟执行、版本化执行接口与研究 API。首批仅 BTCUSDC/BTC 与 ETHUSDC/ETH 永续合约。当前版本只使用公开行情，不读取交易凭据，不发送真实订单，不允许通过配置启用实盘。

全部实现位于 `server/research/binance-lighter-*`，由工作台 runtime 管理；`server/` 已由正式运行包与应用内容指纹覆盖，不新增独立服务或安装步骤。API 沿用工作台会话、同源、CSRF 和运行时会话复核。前端独立 lazy 路由 `?view=cost-lab`，沿用工作台布局。

从工作台「监控 → 对冲成本研究」进入。保存币种、单腿名义金额、挂单等待时间及对冲延迟后启动；运行中配置只读，关闭页面仍继续模拟。停止后可导出或归档本会话，再开始新的研究。首次启动和工作台重启后均不会自动开始模拟。

失败时停止新增模拟，保留已模拟成交、未决敞口和已完成记录。停止或重启不能将未平模拟改成零仓或已结算。回滚：停止新研究，回退上一正式版本；保留 `DATA_DIR/binance-lighter-cost`，不修改已有账户、数据库结构或其他模块配置。

## 计算口径

- Binance Maker 由公开主动成交消耗挂单时可见队列的代理模型驱动；盘口触价、撤单缩量不等于成交。不能证明真实排队位置或真实成交概率。部分模拟成交按数量安排对冲。
- Lighter 使用 Standard 普通 Taker 模型。延迟至少 300ms，延迟结束后只使用新收到且合格的盘口，按真实档位扫单；不足或超时保留未对冲数量，不补造足量成交。
- 盘口与逐笔成交流的健康状态独立，盘口更新不能证明成交流恢复。任何必要通道重连预算耗尽时停止本会话；临时断档也会撤销旧队列依据。
- 对冲同时要求单调接收时间超过到期点、来源时间晚于上一帧且不早于到期墙钟减 250ms 的时钟容差；单纯晚到的旧帧不作为延迟成交证据。序列号在任何大整数运算前限制为最多 40 位。
- 同时运行的币种、买卖方向与延迟情景互相独立，不把它们相加为可实现账户总收益。
- 四腿成交现金流计算价格盈亏；盘口滑点和延迟影响已在成交价内，不再重复扣除。费用锁定于本会话配置；默认零费是公开优惠假设，不代表账户实际费率已核验。
- 计价为 USDC 名义结算单位，不是 USD 法币估值。Lighter 原生参考价格单位 USD 与其 USDC 线性 PnL 分别保留。
- 成本指标只用同一情景中已完成开平的成本除以这些开平的 Binance 模拟名义额；Lighter 成交额不进入分母，未完成头寸不稀释已完成成本。
- 实际资金费未核验时保持未知。可另填每小时净资金费支出情景（正值成本，负值收益），按名义额和持有时长估计，不把它称为已结算资金费。活动资格、有效成交额和奖励保持未知。

## 界面与数据设计

分析任务是比较执行成本及观察实时数据质量。主视图为情景比较表、逐笔模拟记录与按真实时间绘制的成本折线；沿用 React/Recharts，单页一张图，最多 300 点，不逐盘口重绘。断流和未知值显示缺口而不是零。数字可直接读取，窄屏表格内部滚动，支持键盘和文本状态。配色与字号沿用工作台变量，状态不用单一颜色表达。页面只轮询聚合快照，关闭页面不会停止服务器采集。

## 接口契约 v1

入口 `/api/research/binance-lighter-cost`：GET 轻量状态；GET `/scenario/<sessionId>/<scenarioId>` 按需读取当前会话某个情景的完整逐笔与曲线；PUT `/config` 保存 `{config}`；POST `/start`、`/stop`、`/archive` 接受空对象；GET `/report` 导出当前完整报告及归档摘要；GET `/report/<sessionId>` 下载指定归档。配置只接受已知字段，不能传入 URL、路径、密钥或执行模式。归档仅针对停止的模拟，保留原记录。新会话与旧详情请求严格隔离，过期会话 ID 返回 409。

配置：`schema:1`，`symbols:['BTC','ETH']`，`notionalPerLeg:1000`，`latencyScenarios:[300,600,1000]`，`makerWaitMs:15000`，`holdMs:5000`，`hedgeWaitMs:2000`，`cooldownMs:3000`，`maxBookAgeMs:1000`，`maxSourceAgeMs:2000`，`maxPairSkewMs:750`，`maxHedgeSlippageBps:5`，`queueMultiplier:1`，`binanceMakerFeeBps:0`，`lighterTakerFeeBps:0`，`fundingCostBpsPerHour:null`。

状态：`{schema:1,state:'stopped'|'starting'|'running'|'fault',enabled,error,serverNow,config,report,archives,execution:{mode:'paper',liveAvailable:false,version:1}}`。

报告：`{schema:1,sessionId,sessionConfig,startedAt,updatedAt,stopped,interrupted,mode:'paper',detailLevel,markets,books,channels,scenarios,diagnostics,assumptions}`。常规状态的 `detailLevel='summary'` 不携带历史曲线和逐笔，空数组不是「无历史」；单情景接口返回 `{sessionId,updatedAt,scenario}`，完整导出保留原记录。这一路由按 `Accept-Encoding` 协商 gzip，保留 `no-store` 和 `Vary: Accept-Encoding`，不压缩其它会话或凭据接口。

每行情摘要：`{venue,symbol,nativeSymbol,bid,ask,sourceAt,receivedAt,ageMs,valid}`；连接状态：`{venue,channel,symbol?,state,reason?,at}`。`ageMs` 为报告产生时的单调接收年龄，浏览器叠加读取耗时与本地单调经过时间，不以页面刷新替代源更新。

每情景：`{id,symbol,direction:'buy'|'sell',latencyMs,status,reason,task,stats,recentRounds,history}`。`task` 为 null 或 `{id,startedAt,phase,targetQuantity,binanceQuantity,lighterQuantity,residualQuantity,maker,pendingHedges}`；`maker` 含 `{side,price,remainingQuantity,queueAhead}`；`pendingHedges` 含 `{id,phase,side,quantity,dueAt}`。

`stats`：`{attempts,completed,unfilled,unresolved,binanceTurnover,closedBinanceTurnover,fees,closedFees,tradingPnl,tradingCost,costPer10000,fundingScenarioCost,modeledCostPer10000}`。`binanceTurnover` 包含已发生的模拟成交；`closed*` 与成本指标仅含已完成开平。缺少资金费情景时相应值为 null。

`recentRounds`：`{id,startedAt,endedAt,outcome,reason,quantity,binanceTurnover,fees,tradingPnl,tradingCost,costPer10000,fundingScenarioCost,modeledCostPer10000,fills}`；`fills`：`{id,venue,side,phase,quantity,price,notional,fee,at,sourceAt,model}`。`history`：`{at,costPer10000,modeledCostPer10000}`。归档摘要含 `{sessionId,startedAt,endedAt,unresolved,completed,interrupted}`，中断标记不重复计入未决情景数。所有时间为毫秒。

## 实盘扩展边界

`binance-lighter-execution.mjs` 的 `EXECUTION_CONTRACT` v1 定义订单意图、`clientOrderId`、查询/取消和成交事件身份；当前工厂只返回 `PaperExecutionAdapter`。成本计算与市场数据不负责签名或网络写入。以后接实盘必须另行实现账户授权、共享写入准入、发送前持久化、未知订单核对与实际手续费/资金费入账，再接入真实适配器；不能只在本模块增加一个 `live` 开关。当前代码没有真实订单传输实现。

## 验证计划

独立验证纯计算/状态机、公开协议与序列、持久恢复及 API 权限；完成根前端类型检查和生产构建，新实际页面启停、保存竞态、过期与未决状态、窄屏验收。短时真实公开接口采集只证明连接与协议，不证明策略收益。发布前复用现有 Linux CI；禁止 WSL，不自动部署服务器。

## 来源

- [Binance 深度流](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public)
- [Binance 聚合成交流与普通成交量 nq](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market)
- [Lighter WebSocket](https://docs.lighter.xyz/api/websocket)
- [Lighter 时间字段](https://docs.lighter.xyz/developers/reference/timestamps)
- [Lighter 费率](https://docs.lighter.xyz/trading/trading-fees)
- [Lighter PnL](https://docs.lighter.xyz/trading/pnl-and-total-account-value)
- [Binance USDC 永续优惠](https://www.binance.com/en/support/announcement/detail/03180947641b414ebcb9a6c407fe80e2)
- [币安社区回馈活动](https://www.binance.com/zh-CN/support/announcement/detail/dad3f7336cd343fd9752c63b21f8d52a)
