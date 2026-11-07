# OKX 只读配置限流修复

风险等级：R3。用户可见变化是短暂限流可有限恢复，持续限流显示准确原因；权限检查失败仍不能读取新仓位。

## 范围与回滚

- `server/trading-okx-readonly.mjs`：原油、海力士、Anthropic、资金费及连接验证共用同完整凭据的在途配置校验，不缓存完成后的权限结果；订阅者独立取消。
- `server/trading-okx-common.mjs`：只读失败安全提取 Retry-After，识别非 JSON 的 HTTP 429；订单写入的重试与 uncertain 判定保持原契约。
- `server/trading-diagnostics.mjs`：HTTP 429 / OKX 50011 明确为请求限流，兼容旧持久快照。
- 限流只对只读配置检查增加一次重试，默认等待 2100ms；超过本轮等待预算的远端期限保留在当前客户端内，后续调用不能提前发送。每次请求沿用 12 秒超时和交易服务原总截止。
- 无数据库、凭据存储、前端轮询或部署变更。回滚方式为撤销本次提交并按既有流程发布；旧版本仍能解析数字诊断。

## 证据与边界

基线 `05784b4` 四路刷新会发起四次账户配置请求，官方该接口按 User ID 限制为 5 次/2 秒；这证明重复消耗，不能证明四路读取是现场限流的唯一来源。执行客户端、Asset 与外部应用的同 UID 调用未纳入本次调度，不提供跨进程全局额度保证。

旧实现上新增回归复现并发四次、短暂限流不重试、错误引导检查权限。真实 `createTrading` + SQLite 夹具覆盖 Anthropic 失败后保留仓位与原成功时间、状态为 stale，恢复后清错；已有真实 HTTP 测试覆盖工作台 Anthropic 入口。

已运行：

- `node --test tests/trading-okx-rate-limit.test.mjs tests/trading-okx.test.mjs`：最终 51 项通过，包含下单、改撤单、时间校正、结果未知、取消及本次限流恢复。
- `node --test tests/trading-okx-rate-limit.test.mjs tests/trading-runtime.test.mjs tests/trading-scheduler.test.mjs tests/trading-exchanges.test.mjs`：91 项通过。
- 上述 91 项中的 10 项限流测试已由最终 13 项重跑替代；其余 81 项运行时、调度和其他交易所测试复用有效结果。后续只改 Retry-After 溢出及只读 HTTP 429 的时间校正优先级，相关失败分支由最终 51 项覆盖。
- `pnpm run check`：最终源码通过。
- `node --test tests/lessons-routing.test.mjs`：2 项通过；`git diff --check` 通过。

未运行：真实账户请求和实盘写入；浏览器布局回归（无前端改动，诊断通过真实服务链验证）；本地 Linux/WSL 验证（WSL 禁用，发布所需 Linux 检查由既有 CI 执行）。

自审覆盖失败拒绝、凭据隔离与脱敏、有界恢复、取消清理、旧数据时效及订单发送契约。未改变金融计算、数据库结构、公共接口结构或安装器，这些类别不扩大检查。

独立安全差异审查由隔离上下文的 `gpt-6-astra / ultra` 代理执行，使用 `codex-security:security-diff-scan` 的局部检查流程。插件不接受选择性固定补丁，因此未创建包含无关改动的完整扫描，也没有插件 scanId 或 canonical report。

审查发现两项 P2，均已同批修复并补回归：异常巨大 Retry-After 溢出导致永久冷却；HTTP 429 与时间错误码组合绕过冷却先校时重试。独立探针另确认 POST 50011、HTML 429、503 各仅发送一次，uncertain 分别为 false、true、true。

独立最终复核结论：无未处理 P0/P1/P2，可交付。额外验证了凭据变更不能绕过冷却，及 mutation 原有时间错误恢复策略保持不变。正式发布须等待本次提交的既有 CI 和候选包通过，再晋级核实；不部署用户服务器。
