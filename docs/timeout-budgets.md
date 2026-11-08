# 超时预算表

本文登记工作台各调用路径和停止路径上实际生效的超时预算，对应[演进计划](evolution-plan.md) E5。数值、来源位置和预算关系以 `tests/fixtures/timeout-budgets.json` 为准。`tests/timeout-budgets.test.mjs` 从下列来源逐项读回实际值：源码常量与参数默认值（并确认生产调用处没有传入覆盖值）、Python bridge、前端源码，以及安装器 `write_unit` 实际生成的 systemd 单元。下面三种情况都会让测试失败：

- 只改了来源，没有同步登记表；
- 两边一起改了，但某条关系不再成立；
- 本文表格与登记表不一致。

首批只做登记，不改任何预算；第二批修正了数值冲突 C1、C14、C16、C18，并把 C2、C15 改为按设计接受（第 5 节）。第三批修正了其余冲突 C3–C13、C17，以及 C18 中第二批留下的双槽切换部分。修正后把对应关系改为"成立"，测试会提示这一步。

阅读约定：

- 表中"起点"指计时开始的时刻。T0 是 API 收到浏览器请求的时刻（`server/api/server.mjs` 的 `receivedAt`）。
- Node 的 `server.requestTimeout` 和 `headersTimeout` 只限制接收请求的时间，不限制处理请求或返回响应的时间。Node 只按 `connectionsCheckingInterval` 定期检查这两个时限（默认 30 s，实际上限会多出最多 30 s），登记了接收时限的服务都设为 1 s，测试会检查。

## 1 拓扑

- 生产环境由 `deploy/install.sh` 生成独立单元：
  - runtime 单元运行 `server/runtime/main.mjs`，负责模块 worker 与 Python bridge；
  - API 单元（单槽）或 `api@a`/`api@b` 槽单元（双槽）运行 `server/api/main.mjs`；
  - 双槽另有 entry 单元。
- `server/launcher.mjs` 只用于 `npm start`，在一个进程组里运行 runtime 和 API。
- 共有四条请求链：
  - **链 1**：浏览器 → API → runtime 转发，业务在 runtime 的 data plane 内处理；只有个别路由（如模块能力读取）再经模块 socket 读取，带自己的时限；
  - **链 2**：Portal（在 API 进程内）→ 模块 socket；
  - **链 3**：模块 worker → Python bridge，链 2 访问 Greeks、ASTER 时接着走链 3；
  - **链 4**：更新准入，浏览器 → API → runtime 维护同步与停机准入 → 各交易模块（ASTER 再进 bridge）→ 更新服务。
- 浏览器侧只登记与服务端预算有设计关系的时限（Aero 调仓、更新请求）和已知不一致的执行写操作；其余前端时限、外部交易所调用不在本表范围内。

## 2 请求预算

### 2.1 链 1：API → runtime 转发

| 预算 | 值 | 起点 | 拥有者 | 超时后 | 取消传播 |
| --- | --- | --- | --- | --- | --- |
| `api.receive` | 60 s | 连接开始收请求 | API http.Server | 408，关闭连接；常量 `RECEIVE_TIMEOUT_MS`，要容得下 Portal 最大 16 MiB 的上传 | — |
| `api.headers` | 10 s | 连接开始收请求 | API http.Server | 408 | — |
| `api.forward-deadline` | 60 s | T0 | API `forward()` | 常量 `FORWARD_DEADLINE_MS`；截止时刻随请求传给 runtime，从 T0 起算，所以请求体收得慢会占用这段时间（C4） | 浏览器断开时中止转发（C7） |
| `client.forward` | 60 s | 读请求体之前 | API 的 runtime 客户端 | 取 min(截止时刻, 当前 + 60 s)；到期 504"运行时响应超时"，写操作标记为结果不确定（C5） | 请求先完整送达 runtime 再关闭 unix socket，由 runtime 决定：新建连接、预览和新任务不再执行，执行中的预览和连接中止交易所调用、不保存结果；停止、对账、断开账户与规则修改照常执行（C7） |
| `protocol.read` | 5 s | 发起读取 | API 的 runtime 客户端 | 发现与探测失败为 503；Portal 取模块地址失败为 502，重试一次 | — |
| `runtime.capabilities-read` | 5 s | 读取开始 | runtime data plane | 该模块记为不可用 | AbortSignal |
| `internal.receive` | 75 s | 收内部请求 | runtime 内部服务 | 408；只限接收，不限处理，处理时限由调用方的预算决定（C4） | — |
| `internal.headers` | 5 s | 收内部请求 | runtime 内部服务 | 408 | — |
| `protocol.maintenance` | 25 s | API 发起 | API 的 runtime 客户端 | 503 | — |
| `protocol.prepare-stop` | 70 s | API 发起 | API 的 runtime 客户端 | 503 | — |
| `aero.change-budget` | 50 s | 进入调仓变更 | runtime aeroSafe | 取 min(当前 + 50 s, 截止时刻 − 10 s)，到期 504 后不再写入 | 内部标记放弃；data plane 中只有此路径使用截止时刻 |
| `aero.deadline-margin` | 10 s | — | runtime aeroSafe | 为 API 截止留出的余量 | — |
| `execution.call` | 35 s | 每次交易所调用 | runtime 执行引擎 | 中止本次调用；预览先读账户再读行情，两次之和可能超过转发截止，由取消信号截断 | AbortSignal，并接上转发请求的取消（C7） |
| `browser.aero-change` | 70 s | 浏览器发起 | 前端 Aero 调仓 | 前端放弃等待 | AbortSignal |
| `browser.execution-write` | 65 s | 浏览器发起 | 前端执行页写操作 | 前端放弃等待，提示核对；比转发截止晚 5 s（C17） | AbortSignal；API 随之中止转发 |
| `browser.update-apply` | 140 s | 浏览器发起更新 | 前端更新面板 | 前端放弃等待；覆盖链 4 的整个更新请求 | AbortSignal |
| `browser.update-read` | 40 s | 浏览器读取或检查更新 | 前端更新面板 | 前端放弃等待；读取与检查会等更新服务和一次模块维护同步 | AbortSignal |
| `browser.asset-sync` | 80 s | 资产页点刷新 | 资产页 | 前端放弃等待，保留上次数据 | AbortSignal |

### 2.2 链 2：Portal → 模块

| 预算 | 值 | 起点 | 拥有者 | 超时后 | 取消传播 |
| --- | --- | --- | --- | --- | --- |
| `portal.connect` | 10 s | DNS 查询或上游连接开始 | Portal | 504"连接超时" | 销毁上游连接 |
| `portal.response-header` | 90 s | 上游连接创建，包含上传请求体 | Portal | 504"响应超时"；资产同步的总时限也用这个值，其中还包括两次没有自身时限的账本请求 | 销毁上游连接；模块端收到关闭后向 bridge 发 cancel；资产同步的最后一个等待者离开时中止 runtime 的同步（C7） |
| `client.asset-sync` | 70 s | 资产同步开始 | API 的 runtime 客户端 | 504；覆盖一轮同步加一次摘要读取 | 取消随请求传给 runtime；没有其它等待者、也没有后台轮次并入时中止该轮同步，保留已有账本（C7） |
| `runtime.asset-sync` | 60 s | 单轮同步开始 | runtime 资产同步 | 本轮记为超时；成功后再读一次摘要，两者都在 `client.asset-sync` 之内 | — |
| `runtime.summary-read` | 5 s | 读取开始 | runtime data plane | 本次摘要读取失败 | AbortSignal |
| `portal.authentication` | 10 s | 兑换授权票据 | Portal | 504；传入值须是 1 ms 到 2³¹ − 1 ms 的整数，否则创建 Portal 时报错（C9） | AbortController 传给登录 |
| `portal.ticket-ttl` | 30 s | 签发票据 | Portal | 401；属于授权有效期，不是请求预算 | — |
| `portal.stream-keepalive` | 30 s | 拿到 SSE 响应头或 WebSocket 101 | Portal | 开启 TCP keepalive，对端主机失联时由内核断开连接（C12） | — |
| `monitor.receive` | 30 s | 收请求 | Monitor worker | 408 | — |

Portal 拿到 SSE 响应头或 WebSocket 101 后清除计时器，长连接不受普通响应时限约束。事件流可以长时间没有数据，所以不设空闲时限，改为开启 TCP keepalive（`portal.stream-keepalive`），对端失联时连接会断开（C12）。API 关闭时立即结束这些连接。

### 2.3 链 3：worker → Python bridge

| 预算 | 值 | 起点 | 拥有者 | 超时后 | 取消传播 |
| --- | --- | --- | --- | --- | --- |
| `python.receive` | 30 s | 收请求 | worker 内 HTTP 服务 | 408 | — |
| `python.pending-default` | 55 s | 请求体读完 | worker | 504（`createPythonModule` 默认值） | 通过 stdin 发 cancel，bridge 取消对应任务 |
| `greeks.pending` | 55 s | 同上 | Greeks worker | 504 | 同上 |
| `aster.pending` | 55 s | 同上 | ASTER worker | 504 | 同上 |
| `python.startup-default` | 90 s | spawn | worker | 启动失败，结束 bridge | — |
| `greeks.startup` | 90 s | spawn | Greeks worker | 同上 | — |
| `aster.startup` | 90 s | spawn | ASTER worker | 同上 | — |
| `bridge.startup` | 90 s | bridge 开始启动生命周期 | Python bridge | 启动失败；worker 用 `startupTimeout` 传入（C3），起点晚于 worker 计时，所以 worker 先到期 | — |
| `python.writer-handshake` | 5 s | bridge 就绪 | worker | 启动失败 | 发 cancel |

bridge 把响应体整包回传，不支持流式；应用返回 `text/event-stream` 时 bridge 立即报错，worker 返回 502，而不是等到 55 s 时限得到 504（C13）。需要流式响应时再加流式协议。

### 2.4 链 4：更新准入

`POST /api/updates/apply` 在一个请求里依次执行：同步维护状态 → 停机准入 → 请求更新服务 → 结束时再同步一次维护状态（`server/updates.mjs`）。API 到 runtime 的两段时限 `protocol.maintenance`（每次维护同步）和 `protocol.prepare-stop` 见 2.1。

| 预算 | 值 | 起点 | 拥有者 | 超时后 | 取消传播 |
| --- | --- | --- | --- | --- | --- |
| `runtime.sync-deadline` | 4 s | runtime 自行重同步某个模块 | runtime | 本次重同步失败，按退避重试；runtime 自身的重同步在服务队列里最多一项，期间就绪的模块并入下一项，排在后面的 API 同步最多多等这么久 | — |
| `updates.module-maintenance` | 10 s | 向各交易模块设置维护状态（并行） | runtime 模块守卫 | 未确认的模块列为失败，503 | — |
| `updates.capabilities` | 5 s | 停机准入读取模块能力 | runtime 模块守卫 | 503 | — |
| `updates.status-aster` | 60 s | 读取能力之后 | runtime 模块守卫 | 503；比 bridge 的 55 s 等待晚 5 s | — |
| `updates.status-default` | 10 s | 同上 | runtime 模块守卫 | 503 | — |
| `updates.client` | 8 s | 请求更新服务 | API 更新客户端 | 失败；已发出时保持结果不确定 | — |

### 2.5 事件流与心跳

| 预算 | 值 | 起点 | 拥有者 | 超时后 | 取消传播 |
| --- | --- | --- | --- | --- | --- |
| `runtime.events-heartbeat` | 15 s | 周期 | runtime data plane | 推送一次状态 | — |
| `client.events-idle` | 45 s | 最后一次收到数据 | API 的 runtime 客户端 | 判定事件流已断开，按 1–30 s 退避重连 | 销毁连接 |
| `api.overview-heartbeat` | 15 s | 周期 | API 概览 SSE | 发送心跳 | — |
| `api.runtime-stale` | 30 s | 最后一次收到 runtime 推送或状态 | API | 概览显示为陈旧；漏掉一次心跳就会到达阈值 | — |

## 3 启动与停止预算

| 预算 | 值 | 起点 | 拥有者 | 超时后 | 取消传播 |
| --- | --- | --- | --- | --- | --- |
| `runtime.module-start` | 120 s | fork worker | runtime | 进入退避重启 | — |
| `python.shutdown-default` | 10 s | worker 关闭 bridge 的 stdin | worker | SIGKILL（C6）；bridge 先取消在途任务再开始自己的关闭计时，所以这是实际上限 | — |
| `greeks.shutdown` | 10 s | 同上 | Greeks worker | 同上；未传参数，沿用默认值 | — |
| `aster.shutdown` | 100 s | 同上 | ASTER worker | 同上 | — |
| `bridge.exit-extra` | 2 s | — | Python bridge | bridge 退出主循环后 `shutdown_timeout + 2` 秒强制 `os._exit(1)`；worker 在 `shutdown_timeout` 时已发 SIGKILL，所以只对父进程已不在的 bridge 起作用 | 不依赖父进程 |
| `greeks.bridge-exit` | 12 s | bridge 退出主循环 | Greeks bridge | 强制退出 | — |
| `aster.bridge-exit` | 102 s | bridge 退出主循环 | ASTER bridge | 强制退出 | — |
| `worker.close-default` | 30 s | 收到 shutdown 或 SIGTERM | 非 ASTER worker | `process.exit(1)` | — |
| `worker.close-aster` | 110 s | 同上 | ASTER worker | `process.exit(1)` | — |
| `runtime.stop-default` | 32 s | runtime 发出 shutdown | runtime | 结束整个进程组（SIGKILL） | — |
| `runtime.stop-aster` | 115 s | 同上 | runtime | 同上 | — |
| `runtime.kill-grace` | 5 s | SIGKILL 之后 | runtime | 重启前排空时再等这么久，确认进程树已经消失；关闭路径不直接使用，但会等待关闭前已开始的排空，所以停止关系把它计入作为保守上界 | — |
| `runtime.data-plane-close` | 120 s | runtime 关闭 data plane | runtime | 记为关闭失败，继续关闭其余部分；与模块停止并行（C11） | — |
| `api.drain` | 61 s | API 开始关闭 | API | 最多等在途请求 61 s，比转发截止多 1 s；到期后关闭所有连接并销毁已升级的连接 | 开始时立即结束 SSE 与 WebSocket |
| `api.handler-grace` | 2 s | 排空之后 | API | 停止等待处理函数 | — |
| `api.coordinator-close` | 5 s | 之后 | API | 停止等待状态读取与模块同步 | — |
| `api.close-report` | 0.5 s | 与上一项并行 | API | 停止等待最后一次统计汇报 | — |
| `entry.close-grace` | 5 s | entry 开始关闭 | entry | 关闭剩余连接 | — |
| `launcher.api-stop` | 75 s | launcher 停止 API | launcher（仅 `npm start`） | SIGKILL；之后停止 runtime | — |
| `launcher.runtime-stop` | 150 s | launcher 停止 runtime | launcher（仅 `npm start`） | SIGKILL（C10） | — |
| `launcher.api-ready` | 60 s | launcher 启动 API | launcher | 结束 API 并按退避重启 | — |
| `unit.runtime` | 150 s | systemd 开始停止 | systemd（runtime 单元） | SIGKILL | 见下文 |
| `unit.api` | 75 s | 同上 | systemd（API 单元，单槽） | SIGKILL | — |
| `unit.slot` | 75 s | 同上 | systemd（槽单元，双槽） | SIGKILL | — |
| `unit.entry` | 15 s | 同上 | systemd（entry 单元，双槽） | SIGKILL | — |

单元的停止关系：

- 生成的单元都没有 `ExecStop`、`KillMode` 和 `TimeoutSec`，测试也检查了这一点。
- 按 systemd 默认的 control-group 方式停止：停止开始时 SIGTERM 同时发给单元内所有进程，`TimeoutStopSec` 到期后发 SIGKILL。
- worker 和 bridge 在父进程还在时忽略 SIGTERM 与 SIGINT，由父进程按 `runtime/main.mjs` 的顺序结束（先让 API 看到不可用，再停 worker）；父进程已经不在时收到信号就退出（C8）。没有改用 `KillMode=mixed`：那样 runtime 一退出，仍在关闭的子进程会立即收到 SIGKILL。
- API 与槽单元通过 `PartOf=` 和 `After=` 跟随 runtime：先停 API，再停 runtime，每个单元各自计时，所以没有求和约束。槽单元 `After=` entry，先于 entry 停止。

## 4 关系

关系的写法是"外层 ≥ 各内层之和 + 最小余量"。余量取当前实际值能满足的下限。状态"冲突"表示待修正；"接受"表示外层不覆盖内层是有意的设计（理由见第 5 节）。两者测试都要求关系当前仍不成立，一旦成立就要改为"成立"。

| 关系 | 状态 | 外层 ⊇ 内层 + 余量 | 说明 |
| --- | --- | --- | --- |
| `api-drain-covers-forward` | 成立 | `api.drain` ⊇ `client.forward` + 1 s | 关闭时在途转发能等到自身截止，504 先于强制断开（C4） |
| `forward-covers-capabilities` | 成立 | `client.forward` ⊇ `runtime.capabilities-read` + 1 s | 转发路由内的模块能力读取 |
| `forward-covers-aero-change` | 成立 | `client.forward` ⊇ `aero.change-budget` + `aero.deadline-margin` + 0 s | 调仓变更在 API 截止前留出余量；代码取较小值，本关系保证常量本身不越界 |
| `events-idle-covers-two-heartbeats` | 成立 | `client.events-idle` ⊇ `runtime.events-heartbeat` + `runtime.events-heartbeat` + 5 s | 丢一次心跳不算断流 |
| `stale-covers-heartbeat` | 成立 | `api.runtime-stale` ⊇ `runtime.events-heartbeat` + 5 s | 陈旧阈值长于一次心跳 |
| `api-unit-covers-api-close` | 成立 | `unit.api` ⊇ `api.drain` + `api.handler-grace` + `api.coordinator-close` + 5 s | API 关闭的三段串行等待落在单元时限内（另有库关闭） |
| `slot-unit-covers-api-close` | 成立 | `unit.slot` ⊇ `api.drain` + `api.handler-grace` + `api.coordinator-close` + 5 s | 双槽同理 |
| `launcher-covers-api-close` | 成立 | `launcher.api-stop` ⊇ `api.drain` + `api.handler-grace` + `api.coordinator-close` + 5 s | 开发入口同理 |
| `coordinator-covers-close-report` | 成立 | `api.coordinator-close` ⊇ `api.close-report` + 0 s | 并行等待，取较长者 |
| `entry-unit-covers-entry-close` | 成立 | `unit.entry` ⊇ `entry.close-grace` + 5 s | — |
| `aster-worker-covers-bridge-exit` | 成立 | `worker.close-aster` ⊇ `aster.bridge-exit` + 1 s | bridge 先于 worker 自行退出 |
| `aster-stop-covers-worker-close` | 成立 | `runtime.stop-aster` ⊇ `worker.close-aster` + 1 s | runtime 强杀晚于 worker 自身时限 |
| `runtime-unit-covers-aster-stop` | 成立 | `unit.runtime` ⊇ `runtime.stop-aster` + `runtime.kill-grace` + 10 s | 模块并行停止，取最长的 ASTER；data plane 关闭与之并行，见 `runtime-unit-covers-data-plane-close` |
| `greeks-worker-covers-bridge-exit` | 成立 | `worker.close-default` ⊇ `greeks.bridge-exit` + 1 s | — |
| `default-stop-covers-worker-close` | 成立 | `runtime.stop-default` ⊇ `worker.close-default` + 1 s | — |
| `runtime-unit-covers-default-stop` | 成立 | `unit.runtime` ⊇ `runtime.stop-default` + `runtime.kill-grace` + 10 s | — |
| `runtime-unit-covers-data-plane-close` | 成立 | `unit.runtime` ⊇ `runtime.data-plane-close` + 10 s | 余量给内部服务、数据库和锁的关闭（C11） |
| `data-plane-close-covers-execution-call` | 成立 | `runtime.data-plane-close` ⊇ `execution.call` + 5 s | 关闭时在途的交易所调用能等到自身时限 |
| `launcher-covers-runtime-stop` | 成立 | `launcher.runtime-stop` ⊇ `runtime.stop-aster` + `runtime.kill-grace` + 10 s | 开发入口与 runtime 单元相同（C10） |
| `launcher-covers-data-plane-close` | 成立 | `launcher.runtime-stop` ⊇ `runtime.data-plane-close` + 10 s | 同上 |
| `module-start-covers-greeks-startup` | 成立 | `runtime.module-start` ⊇ `greeks.startup` + `python.writer-handshake` + 5 s | — |
| `module-start-covers-aster-startup` | 成立 | `runtime.module-start` ⊇ `aster.startup` + `python.writer-handshake` + 5 s | — |
| `maintenance-covers-module-maintenance` | 成立 | `protocol.maintenance` ⊇ `runtime.sync-deadline` + `updates.module-maintenance` + 1 s | API 的维护同步可能排在 runtime 自身重同步之后（`runtime/main.mjs` 注释）；runtime 自身的重同步在队列里最多一项（C18） |
| `prepare-stop-covers-module-evidence` | 成立 | `protocol.prepare-stop` ⊇ `updates.capabilities` + `updates.status-aster` + 5 s | 各模块并行，每个模块先读能力再读委托状态，取最长的 ASTER |
| `portal-covers-asset-sync` | 成立 | `portal.response-header` ⊇ `client.asset-sync` + 5 s | — |
| `browser-asset-covers-asset-sync` | 成立 | `browser.asset-sync` ⊇ `client.asset-sync` + 10 s | 资产页晚于 API 放弃；余量给 Portal 在同步前后各读一次的 ledger（本地模块，没有单独时限） |
| `browser-aero-covers-forward` | 成立 | `browser.aero-change` ⊇ `client.forward` + 5 s | 浏览器晚于服务端放弃 |
| `browser-execution-covers-forward` | 成立 | `browser.execution-write` ⊇ `client.forward` + 5 s | 浏览器晚于服务端放弃（C17） |
| `forward-covers-execution-call` | 成立 | `client.forward` ⊇ `execution.call` + 5 s | 单次交易所调用落在转发截止内；预览的两次调用由取消信号截断 |
| `browser-covers-update-apply` | 成立 | `browser.update-apply` ⊇ `protocol.maintenance` + `protocol.prepare-stop` + `updates.client` + `protocol.maintenance` + 5 s | 浏览器晚于整个更新请求放弃 |
| `browser-covers-update-read` | 成立 | `browser.update-read` ⊇ `updates.client` + `protocol.maintenance` + 5 s | 读取和检查先问更新服务，再等一次模块维护同步（C18 加长了后者） |
| `portal-covers-greeks-request` | 成立 | `portal.response-header` ⊇ `python.receive` + `greeks.pending` + 5 s | bridge 的 504 先于 Portal（C1） |
| `portal-covers-aster-request` | 成立 | `portal.response-header` ⊇ `python.receive` + `aster.pending` + 5 s | 同上 |
| `api-drain-covers-portal-request` | 接受 C2 | `api.drain` ⊇ `protocol.read` + `portal.response-header` + 0 s | 取模块地址的读取在响应头计时之前，两者串行 |
| `aster-status-covers-bridge` | 成立 | `updates.status-aster` ⊇ `aster.pending` + 5 s | bridge 的 504 先于 runtime 的 503（C14） |
| `api-drain-covers-update-apply` | 接受 C15 | `api.drain` ⊇ `protocol.maintenance` + `protocol.prepare-stop` + `updates.client` + `protocol.maintenance` + 0 s | 维护同步、停机准入、更新请求和结束时的维护同步串行 |
| `client-asset-sync-covers-runtime-sync` | 成立 | `client.asset-sync` ⊇ `runtime.asset-sync` + `runtime.summary-read` + 5 s | 同步本身 60 s 之后还要读一次摘要（C16） |
| `maintenance-covers-two-api-syncs` | 成立 | `protocol.maintenance` ⊇ `runtime.sync-deadline` + `updates.module-maintenance` + `updates.module-maintenance` + 1 s | 双槽切换时两个 API 的维护同步互相排队，排在一项 runtime 重同步之后（C18） |

## 5 已知冲突

| 编号 | 冲突 | 影响 | 修正方向或处理结果 |
| --- | --- | --- | --- |
| C1 | Portal 响应头 90 s，正好等于 bridge 收请求体 30 s 加等待 60 s | 请求体上传接近 30 s 时，Portal 的 504 和 bridge 的 504 同时触发，返回哪一个不确定 | 已修：Greeks 与 ASTER 的等待改为 55 s，30 + 55 + 5 = 90 s |
| C2 | Portal 请求最长 5 s 取模块地址加 90 s 响应头，API 排空只等 61 s | 停止或切换时，等待超过 60 s 的 Portal 请求会被强制断开 | 按设计接受：排空是 API 停止时长的上限，放宽到覆盖 95 s 会让单槽重启在有慢请求时停服更久，并连带调大三处 `TimeoutStopSec`。被断开的上游连接会让模块取消对应任务（bridge 收到 cancel），写操作不自动重试；受影响的主要是资产同步，API 关闭时 Portal 中止所有资产同步，runtime 的同步随之中止（C7） |
| C3 | bridge 启动时限写死为 90 s，不随 `startupTimeout` 变化 | Node 计时起点更早，所以通常先到期；但调大 `startupTimeout` 后，bridge 仍会在 90 s 时失败 | 已修：worker 用 `startupTimeout` 作为 bridge 的第三个参数传入 |
| C4 | Node 的 `requestTimeout` 只限接收请求，`internal-server.mjs` 的注释却把 75 s 当作 prepare-stop 的处理时限；API 的接收时限和转发截止也共用一个常量 | 注释会误导以后的修改；请求体收得慢会挤占转发时间 | 已修：注释改为"只限接收，不限处理"；API 拆成 `FORWARD_DEADLINE_MS`、`RECEIVE_TIMEOUT_MS`、`DRAIN_MS` 三个常量。截止仍从 T0 起算：接收时限要容得下 Portal 的大上传，分开计时会让转发总时长超过 60 s。排空改为 61 s，比转发截止多 1 s |
| C5 | 转发超时返回 503，调仓超时返回 504 | 同一类超时状态码不同 | 已修：传输层的响应超时统一为 504"运行时响应超时"，写操作的"结果未确认"沿用 504；runtime 不可用仍为 503。更新路径照旧换算为自身的 503 |
| C6 | 关闭 bridge 超时后 `child.kill()` 发的是 SIGTERM，而 bridge 在关闭阶段对 SIGTERM 只是再放入一个空帧 | 名义上的强杀实际不起作用，真正的上限是 bridge 自己的 `os._exit` | 已修：关闭和失败时到期改发 SIGKILL |
| C7 | 浏览器断开或 API 截止后，runtime 仍会把转发执行完；API 的资产同步返回 503 或 Portal 返回 504 后，runtime 的资产同步也不会中止 | 写操作结果不确定，超时后仍占用资源 | 已修：API 在浏览器断开时中止转发；请求总是先完整送达 runtime 再断开，runtime 内部服务在连接关闭时中止信号，由路由决定是否继续：新建连接、预览和新任务在进入执行队列时检查，执行中的预览和连接中止交易所调用、不保存结果；停止、对账、断开账户与规则修改照常执行，已开始的下单、撤单和对账不中途打断。资产同步记录等待者，最后一个离开、且没有后台轮次并入时中止该轮，保留已有账本，节流间隔照常计入（Asset 端可能仍在完成那一轮） |
| C8 | 单元按默认 control-group 方式停止，systemd 一开始就向 worker 和 bridge 发 SIGTERM | `runtime/main.mjs` 的关闭顺序（先让 API 看到不可用，再停 worker）对模块不成立，模块和 data plane 同时开始退出 | 已修：没有改单元（不用 `KillMode=mixed`，它会在 runtime 退出时立即 SIGKILL 仍在关闭的子进程）。worker 和 bridge 在父进程还在时忽略 SIGTERM 与 SIGINT，按 runtime 的顺序由父进程结束；父进程已不在时收到信号就退出 |
| C9 | Portal 的 `authenticationTimeoutMs` 被钳到最多 10 s，传入更大的值也不报错 | 调大配置不生效 | 已修：去掉钳制，传入值不是 1 ms 到 2³¹ − 1 ms 的整数时创建 Portal 报错 |
| C10 | 用 `npm start` 时 launcher 停止 runtime 没有时限 | 开发环境下 runtime 可能一直不退出 | 已修：launcher 停止 runtime 150 s 后发 SIGKILL，与 runtime 单元相同 |
| C11 | runtime 单元的 150 s 里，data plane 关闭是一串没有时限的串行等待 | `runtime-unit-covers-aster-stop` 只覆盖模块，data plane 那部分的余量没人检查 | 已修：data plane 关闭限 120 s，到期记为关闭失败并继续关闭其余部分；此时仍在进行的写库会失败，后果与进程被强制结束相同（SQLite 语句与事务是同步的，不会留下半个事务）。纳入关系 `runtime-unit-covers-data-plane-close` |
| C12 | Portal 代理的 SSE 和 WebSocket 没有空闲时限 | 只能靠 TCP 断开或 API 排空来结束 | 已修：不设空闲时限（事件流可以长时间没有数据），对代理的 SSE 与 WebSocket 连接开启 30 s TCP keepalive，对端失联时由内核断开 |
| C13 | bridge 整包回传响应体 | 以后在 Python 模块里加流式响应，会在 55 s 等待时限到期时得到 504 | 已修：仍不支持流式；应用返回 `text/event-stream` 时 bridge 立即报错，worker 返回 502 |
| C14 | 停机准入读取 ASTER 委托状态的 60 s，正好等于 bridge 的 60 s 等待 | ASTER 慢时 runtime 的 503 与 bridge 的 504 同时触发 | 已修：bridge 等待改为 55 s，比读取时限早 5 s |
| C15 | 更新请求串行等待维护同步、停机准入、更新服务和结束时的维护同步，最长约 128 s，API 排空只等 61 s | 正在更新时停止 API，会在结果确认前断开浏览器请求 | 按设计接受：排空到期后 handler 再有 2 s，随后 `updates.close()` 对尚未发出的更新撤销准入（恢复准入前的维护状态），apply 在 `assertOpen` 处中止；已发出的更新照常进行。进程崩溃时由下一个实例按持久化的 owner 记录恢复。前端遇到断连显示"正在重连并核实更新进度"，重连后看到新任务就跟踪它，没有新任务就提示重新检查版本。排空不放宽，理由同 C2 |
| C16 | runtime 单轮资产同步 60 s 之后还要读一次摘要（5 s），API 只等 60 s | API 先返回 503，runtime 还在执行 | 已修：API 等待改为 70 s；资产页的 75 s 和 Portal 的 90 s 仍覆盖它 |
| C17 | 执行页写操作的前端时限 30 s 和 45 s，短于转发截止 60 s；路由内实际的处理时限未登记 | 浏览器先放弃，显示"尚未确认"，服务端仍可能成功 | 已修：登记执行路由内单次交易所调用 35 s（`execution.call`）；前端写操作统一 65 s，比转发截止晚 5 s；预览的两次调用由取消信号截断 |
| C18 | runtime 自身的重同步每个模块排一项（首次不跳过），三个交易模块同时重启时 API 的维护同步最多等 3 × 4 + 10 = 22 s，超过 15 s；双槽切换时候选 API 初始化还会再排一项 | API 判定维护状态未确认，更新被拒绝或需要重试 | 已修：runtime 自身的重同步在服务队列里最多一项，期间就绪的模块并入下一项；`protocol.maintenance` 改为 25 s，覆盖双槽切换时排在一项 runtime 重同步之后的两个 API 同步（4 + 10 + 10 + 1 s），更新面板时限随之改为 140 s |

## 6 维护

- 新增或修改预算时同步改动三处：
  - `tests/fixtures/timeout-budgets.json`：`source.pattern` 必须在文件中只匹配一次，`group` 指定取第几个捕获组，`scale` 用于换算秒；
  - 本文表格；
  - 受影响的关系。
- 生成单元的值取自 `write_unit` 的实际输出。回退配置时，生成单元会跟着回退，不需要单独核对。
- 参数默认值只有在生产调用处不传入覆盖值时才生效。登记默认值时，要在 `overrides` 里列出调用文件和不得出现的参数名；如果只检查某次调用，用 `after`、`until` 截取调用片段。
- 修正冲突时，把相应关系改为"成立"，并保留余量。改为"接受"时在第 5 节写明理由。
- 正则命中位置所在行以注释开头时测试失败（`.py` 判断 `#`，其它判断 `//`、`/*`、`* `）；行尾注释不检测。
- 未登记：entry 的 `ENTRY_STALL_MS`（30 s）与安装器约 40 s 等待循环之间的约束，超出时只记日志；外部交易所请求的时限，属于各模块自身的路径。
