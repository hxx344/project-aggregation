# Lighter RH WebSocket 与原生追价

风险等级：R3。用户要求修复 ANT 套利的 Lighter 追价限速，将盘口和订单状态切换为 WebSocket，并接入原生改单。

## 变更前范围与失败行为

- 影响工作台 Lighter RH 执行适配器、新增的 WS 客户端、官方 WASM 签名白名单，以及公共执行引擎中 Lighter 的改单确认分支；不修改其他交易所协议、交易参数、数据库结构、部署路径或浏览器界面。
- 盘口使用 `ticker/{market}` 的完整买卖一价；订单使用鉴权的 `account_orders/{market}/{account}`。连续健康推送期间不做周期 REST 盘口/查单；断线、认证失败或快照不完整时不能使用旧状态授权追价。重连缺席原单时按客户索引做有界 REST 核对，不由缺席推断撤单或未创建。
- 原生改单保持原订单身份及数量，记录递增版本和目标价，只有对应版本回报或合法终态才能解除未决写入。发送结果未知不重发；部分成交、停止、任务截止、账户写入许可与价格界限沿用现有保护。
- 保留每分钟 40 次 REST 滑动限额、5 秒最小追价以及既有明确只读限流恢复。WS 的建连、订阅、心跳、重连、消息与缓存大小有界；凭据不进入日志或前端。
- 回滚：停止并核对未完成任务后，通过现有流程恢复上一正式版本，保留账户、订单与任务数据。新增改单记录保留原单 ID 和未决标志，回滚后仅允许核对/停止，不补发未知交易。正式发布不部署用户服务器。
- 独立工作树 `codex/lighter-ws` 从 `b524404` 开始，最终合入已发布的 `00fe4f1`（含 UI 偏好与 ANT 自动减仓）作为审查基线；本次提交只保留 Lighter WS/改单变化。

## 计划验证

- Windows 原生 WS 单元测试、Lighter 适配器/真实离线 WASM/执行引擎测试；覆盖连续推送零周期 REST、重连补核、旧帧与旧版本、部分成交、拒绝、未知结果、停止与重启。
- 公共执行状态机相关测试、类型检查、固定差异独立安全审查、暂存门禁及发布所需 CI。
- 已完成只读公开 WS 探测：真实 RH `ANTHROPIC` market 38 的 `subscribed/ticker` 和连续 `update/ticker` 与官方结构一致。没有下单或读取私有账户；私有流与交易验证使用受控传输和离线签名。
- 单独列出实际完成的验证；本节计划不作为通过证据。

## 协议依据

- [官方 WS 协议](https://docs.lighter.xyz/api/websocket)：RH 地址、BBO 完整帧、私有订单订阅、快照与更新、心跳。
- [官方签名说明](https://docs.lighter.xyz/developers/integration-guides/signing-transactions)：客户端索引改单、递增 `order_version`。
- [vendor 对应 WASM 源码](https://github.com/elliottech/lighter-go/blob/aefa96848a105d82a6bbb55d3d05663293a71713/wasm/main.go)：现有签名器已包含 15 参数的 `SignModifyOrder`，无需更新二进制。

已核实改单数量口径：[官方证明器固定提交](https://github.com/elliottech/lighter-prover/blob/fa85b33197710ece649739bc38f5e23e816ddbdf/circuit/src/transactions/l2_modify_order.rs#L164) 在执行时用原总量减原剩余量得到累计已成交量，再令新总量等于 `BaseAmount`、新剩余量等于该总量减累计已成交量（第 227–236 行）。发送原始总量可覆盖发送途中成交；普通限价单要求非零数量，不能用 `0` 猜测“仅改价格”。改单保留客户索引、交易所索引、TIF、reduce-only 与有效期。

私有 `account_orders` envelope 的 nonce 没有已核实的严格递增契约，不能套用 ticker 的去重门槛；相同 nonce 的新增成交仍须处理。每 30 秒无新私有证据时只对该频道重新订阅，等新快照；ticker 与 pong 不更新私有证据时间。公共报价仍按实际报价接收时间和来源时间过期。

## 审查覆盖分组

- WS 传输与快照：`trading-rh-lighter-stream.mjs` 及对应流测试。
- 读取恢复与原生改单：Lighter 适配器及对应适配器测试、离线流夹具。
- 签名白名单与线上字段：signer、worker、vendor 说明及真实离线 WASM 测试。
- 持久化与共享写者：公共执行引擎及 Lighter 引擎测试，直接关联账户写入保护、自动套利与自动减仓入口。
- 本记录与 L103 经验补充仅核对结论和证据，不扩大到无关模块。

## 已执行验证与独立审查

- Windows 原生运行 Lighter stream/adapter/signer/engine、公共 execution/HTTP、自动套利、Hyperliquid、ANT reduction/HTTP 共十份相关测试：初版 291/291 通过；`pnpm run check`、`git diff --check` 和经验路由 2/2 通过。
- 独立只读代理实际以 `gpt-6-astra / ultra` 调用，完成固定差异安全审查 `3eff2cb6-64a7-4781-8f51-ec97d3538d4a`。该扫描封存初版：安全漏洞 0，但业务 P1 两项，不能据此放行。独立生产模块探针确认：私有证据超过 30 秒而 timer 未执行时仍可读旧行；高 `order_version`、低队列 nonce 被丢弃，REST 改单确认后 WS 又返回旧成交量。
- 已修复两项 P1：读取前及等待后校验私有证据绝对截止，逾期同步撤权并单次重订阅；只用明确的改单版本、累计成交和终态约束判断新旧，移除订单队列 nonce 的统一递增假设。队列 nonce 与 API Key 的交易 nonce 分别处理。
- 修复后的 stream/adapter 两份测试共 69 项：首跑 68 通过，分钟测试的旧订阅次数断言失败；实际需要一次私有重订阅，精确更新断言为 3 后，受影响 5 项定向全部通过。最终 69 项结果有效，未变部分复用；结合其余未变用例，共 294 项相关测试的有效通过结果，不把初版 291 项当成修复后整套重跑。
- 独立增量复核另运行两份生产模块探针：绝对 30 秒期限、并发只重订阅一次、新快照前不返回旧状态；低队列 nonce 的改单与随后 inspect 均为 version 5 / filled 5，REST 为 0。两项均通过，两个 P1 关闭，无新增 P0/P1/P2。原封存扫描未改，补充证据保存在独立的 `lighter-fix-verification` 记录。
- 未运行真实私有账户下单。真实公开 RH ticker 通过 Windows .NET 客户端核对；本机 Node 直连/环境代理探测未建立连接，不据此声称生产 Node 的真实私有链路通过。生产模块由受控 WS 传输和真实离线 WASM 覆盖；Linux 发布包由既有 CI 验证，不使用 WSL。
- 无界面改动，未机械运行浏览器回归。未更改数据库结构、依赖、安装或服务器配置。

## 自审与后续交付

通用、金额精度与订单身份、缓存时效、失败恢复、凭据与写入边界已自审；原生改单不重置总量或累计成交，结果未知不重放，账户/期限/价格守卫保留，REST 补核与 WS 清理有界。数据库迁移、前端样式和安装变更不适用。新增 Binance WS 请求属于后续独立增量，尚不在本记录的检查结果内；两部分将统一完成发布，服务器仍由用户自行更新。
