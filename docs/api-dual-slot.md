# 工作台 API 双槽技术实现方案（M4）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.3 切流方案已批准（第 3 节，2026-10-26） |
| 日期 | 2026-10-26 |
| 源码基线 | project-aggregation `f3ea48d` |
| 上位文档 | [架构实现方案](architecture-implementation.md) 第 3.1、9.1、11 节与第 15 节的 M4；[控制面与数据面分离](control-data-plane-separation.md)（M3，已全部发布） |
| 适用范围 | `server/api/`、`server/portal.mjs`、`server/control/`、`server/static-response.mjs`、`server/recovery/`、`server/update-service/registry.py`、`deploy/install.sh` 与相关测试 |
| 设计状态 | M4-1 至 M4-4 已合入；M4-3c 为 `47ff929`，M4-4 为 `6ab243e`。合入和 CI 不等于生产验收；本轮修复与证据见 [合入审查修复记录](m0-m4-review-fixes.md)。第 3 节切流方案于 2026-10-26 批准，第 5.2、6 节的原草案以第 3 节为准 |
| 改动分级 | 本文为 R1 文档；实现批次的等级见第 9 节 |

文中 `路径:行号` 均指上述基线，实施时以符号名重新定位。

v1.2 在第 3 节提出新的稳定入口与切流方案（独立的连接级入口进程），已于 2026-10-26 按 3.11 的推荐选择批准（v1.3）。原草案的端口复用、候选启动写入、两槽共享 `current` 和公共健康检查存在未解决的契约冲突；对应批次不得按旧步骤实施。M4-2 的授权存储与不涉及激活的排空改进可独立推进，M4 激活仍须满足 M2a、M3 和 P2b 生产验收前置。

## 1 结论与范围

### 1.1 目标

M3 之后，只改 API 的更新已经不重启运行时、模块和采集，但仍是 `systemctl restart project-aggregation-api`（`deploy/install.sh:2806-2814`）：旧 API 停止到新 API 监听之间，端口拒绝连接，页面请求失败、概览流断开；Portal 的 ticket 与 grant 只在 API 内存中（`server/portal.mjs:81`），重启后已打开的内嵌模块页面授权失效，需要从工作台重新打开。原基线中的登录失败计数和锁定随 API 重启清零，M4-1 已将其迁入共享仓储。

M4 让只改 API 的更新做到：

1. 新旧两个 API 实例（槽 `a`、`b`）短暂并存，新实例就绪后才让旧实例退出，端口始终有进程接受连接。
2. 两个实例共享登录风控、会话与 Portal 授权，跨实例交替失败的累计与锁定一致，切换后已打开的项目页面继续可用。
3. 新实例启动失败时不影响旧实例，更新以失败结束，旧版本继续服务。

### 1.2 非目标

- 不做 API 多实例常驻与负载均衡（M7），并存只发生在切换的几秒内。
- 不做持久 SSE 游标与事件重放（M5）。概览流断开后沿用现有协议：重连即收到完整快照（`src/App.tsx:145`）。
- 不改运行时、模块、采集或原生执行的重启方式；整体更新仍按 P2 的路径整体重启。
- 稳定入口是否增加进程由第 3 节决定（已批准新增入口进程），不以“不新增进程”排除上位候选隔离与可控切流要求。
- Windows、`pnpm dev:server` 与手动运行的启动器（`server/launcher.mjs`）保持单实例，双槽只用于 Linux systemd 部署。

### 1.3 退出条件（对应上位文档 M4）

| 条件 | 验证方式 |
| --- | --- |
| 更新中数据进程持续运行 | Ubuntu CI：只改 API 的更新前后，运行时单元 `MainPID` 不变（P2 已有，继续保留） |
| 候选隔离及切换连续性 | 定向验证候选身份与 HTTP/Portal/静态资源，再接外部流量；并发短连接、保活、流与写入请求下统计拒连、重置、HTTP 失败及恢复时间，低频 health 只作辅助 |
| 跨槽失败累计和锁定一致 | 单元测试：两个 API 实例共用一个库，交替提交错误密码，第 5 次失败后两边都返回锁定 |
| 页面恢复 | Ubuntu CI：切换前取得的 Portal grant Cookie 在切换后仍可访问；概览流断开后重连收到快照 |
| 失败回滚有效 | 候选失败不替换旧槽；旧槽同期崩溃仍从其固定旧版本恢复；切流后失败与中断重跑依据持久阶段和版本绑定恢复，更新不误报成功 |
| 完整回执 | 沿用安装器的 `finish_activation` 与更新任务的成功状态 |

## 2 现状

| 项目 | 现状 | 对 M4 的影响 |
| --- | --- | --- |
| 会话 | 已在 `hub.sqlite` 的 `sessions` 表（`server/control/store.mjs:11-18`） | 两个实例天然共享，无需改动 |
| 登录风控 | 原基线为进程内 Map；M4-1 已接入 `server/control/login-guard.mjs` 的共享表、原子预占与崩溃到期处理 | 保留现有语义，真实双槽登录验收仍在激活阶段完成 |
| Portal | ticket、grant 都是进程内 Map（`server/portal.mjs:81`），ticket 在 `/__hub/authorize` 消费（`:418-425`），每秒按会话与项目 revision 复核活动流（`:107-113`） | 迁入共享表；活动流与在途登录仍归各进程 |
| Portal 上游认证材料 | 只有外部项目在服务端代登录时存在（`server/api/server.mjs:177-183`）；双进程 API 不处理项目凭据（`server/api/main.mjs:22-24`），内置模块的 grant 不带认证材料 | 双槽部署中的 grant 都不含认证材料，首期无需持久化加密 Cookie（见 4.4） |
| 运行时对多个 API 实例 | 概览订阅按连接分别推送（`server/runtime/data-plane.mjs:61-62`、`server/runtime/internal-server.mjs:41`）；SSE 计数按 API 实例分别保存并求和（`server/runtime/data-plane.mjs:26`、`:70-84`） | 两个 API 实例同时连接运行时无需改协议 |
| 生命周期锁 | API 持有 `.api.lock` 的共享锁（`server/api/main.mjs:48`） | 两个槽可同时持有，恢复工具的排他锁仍会等待两者 |
| 执行入口 | 原生执行入口在库内串行化（P1-4a 的 `execution_entries`） | 两个实例的写入准入已互斥 |
| 关闭顺序 | `close()` 先关控制面服务、结束流，再 `closeServer()` 关监听（`server/api/server.mjs:455-459`） | 关闭期间仍在接受新连接，新请求会撞上已关闭的 Portal 与协调器；双槽需改为先停监听再排空 |
| 只改 API 的判定 | 运行时组件键之外的输入只有 `server/api`、`src`、`public`、`index.html`、`vite.config.ts`、`tsconfig.app.json`（`deploy/package-release.py:323`）；其他共享代码一律算运行时（`deploy/install.sh:2518-2532`） | 新旧两槽并存时，二者只可能在上述输入上不同；`server/control/`、`server/portal.mjs` 的变化必然整体重启 |
| 静态资源 | 各 API 从自身版本目录的 `dist/` 读取（入口经软链启动，`import.meta.url` 为真实路径） | 并存期间两个槽的 `dist/` 不同，见 6.3 |

## 3 方案选择（2026-10-26 批准）

本节于 2026-10-26 批准，3.11 各项按推荐选择；第 5.2、6 节的原草案以本节为准改写。选择标准取自上位第 11.2 节：验证前不导流、每槽固定版本、私有定向探针、可控切流、旧槽失败隔离、确定回滚，并覆盖稳定入口自身更新与恢复工具停止完整服务组。

### 3.1 评审结论

推荐 **A1：独立的连接级稳定入口**。新增 `project-aggregation-entry.service`，只持有公共端口，把每个 TCP 连接原样转发到当前槽的私有 UNIX socket；不解析 HTTP。切流是入口内存中的一次目标替换，由安装器在候选私有验证通过、记录写入后发出。

| 判定项 | A1 独立连接入口（推荐） | A2 入口并入运行时进程 | B systemd 套接字共享 | C 内核端口复用 |
| --- | --- | --- | --- | --- |
| 验证前不导流 | 满足：候选不创建流量 socket（3.3） | 满足 | 需候选晚于验证才 `accept`，可做到 | 不满足：一监听即分得外部连接 |
| 切流可控、原子 | 满足：入口替换目标，此后新连接只到新槽 | 满足 | 不满足：两槽共用一个 accept 队列，只能靠各自开始或停止 `accept` 来近似，没有单一切换点 | 不满足：内核按哈希分配，无切换点 |
| 关闭旧槽时的排队连接 | 不受影响：排队在入口的监听队列 | 同 A1 | 不受影响：systemd 持有描述符 | 被重置：每个 reuseport socket 有独立 accept 队列，需 root 设置 `tcp_migrate_req`，Node 也不能附加 eBPF 选择器 |
| 旧槽同期崩溃 | 旧槽按固定版本自动重启；入口在重连预算内等待 | 同 A1 | 同 A1 | 新连接散到崩溃槽时被拒 |
| SSE、WebSocket、项目 Host | 字节透传，无需重新实现 | 同 A1 | 原生 | 原生 |
| 客户端与本地地址 | 需传递：入口在每条私有连接前写 PROXY v1 头（3.4） | 同 A1 | 原生 | 原生 |
| 入口自身更新 | 入口与槽协议计入运行时组件键，只随整体更新重启；代码面很小 | 随运行时重启，同样只在整体更新时发生 | 套接字单元几乎不变 | 无入口 |
| 恢复工具停服 | 普通服务单元，加同一 recovery guard 即可；停止后端口拒连 | 无新增单元 | 停服期间套接字单元仍完成握手，客户端挂起而不是被拒；套接字单元需固定触发服务或占位单元，与模板槽并存时需额外约定 | 无新增单元 |
| 隔离 | 入口故障只影响接入，不影响运行时与模块 | 弱：公共流量与数据面共用事件循环，入口缺陷或过载会拖住采集与执行 | 好 | 好 |
| 资源 | 多一个 Node 进程：最小 `net` 服务实测 RSS 约 47 MiB（Node 24.15，`NODE_ENV=production`）；每个连接多一跳本机 socket 拷贝 | 不增加进程 | 不增加 | 不增加 |

B 被排除的关键是没有单一切换点与停服语义；C 是没有切换点且关闭时重置排队连接。A2 省下约 47 MiB，但把未鉴权的公共连接放进数据面进程，与上位第 3.1 节进程边界和 M3 的拆分方向相反；内存紧张时再按测量复议。

### 3.2 组件与路径

| 组件 | 内容 |
| --- | --- |
| 入口 `server/entry/main.mjs` | 加载与运行时相同的 `EnvironmentFile`，监听 `HOST:PORT`（从 API 移来，`0.0.0.0`、IPv6 照旧）；目标槽取自 `.api-slot`；每个外部连接打开到目标槽 `http.sock` 的私有连接，先写 PROXY v1 头再双向透传，支持半关闭；按槽统计在途连接数 |
| 入口控制 socket | `/run/project-aggregation-entry/ctl.sock`（`RuntimeDirectoryMode=0700`，服务用户所有，root 可连），HTTP：`GET /status` 返回目标槽、切换代数、各槽在途连接数；`POST /switch {slot, instanceId}` |
| 槽私有 socket（`/run/project-aggregation-api-<槽>/`） | `probe.sock`：安装器定向探针，候选与服务模式都有；`http.sock`：入口转发的流量，**只在服务模式下存在**；`ctl.sock`：`GET /identity` 返回 `{protocol, slot, instanceId, pid, release, mode}`，`POST /promote`。转发流量只能到 `http.sock`，到不了控制接口 |
| 槽协议 `server/slot-protocol.mjs` | PROXY 头读写、socket 路径、`identity`/`promote`/`switch` 格式与协议版本，由入口和 API 共用。放在 `server/api/` 之外，计入运行时组件键：只改 API 的更新不能改变入口与槽之间的契约，回滚到 `previous` 时同样成立 |
| 槽的版本绑定 | `$APP_DIR/slots/a`、`slots/b` 分别软链到 `releases/<版本>`；模板单元 `ExecStart` 经 `slots/%i` 启动（入口按 `import.meta.main` 判定，L078）。安装器只改停止状态下的槽链接，自动重启仍用该槽固定版本 |
| 服务记录 `$APP_DIR/.api-slot` | root 原子写入 `{slot, release}`，是“哪个槽在服务”的唯一持久依据；`current` 仍指向记录中的版本，只表示部署选择，供清理与工具读取 |
| 切换阶段 `$APP_DIR/.api-cutover` | `{from, to, release, phase}`，`phase` 为 `candidate`、`switching`、`draining`；完成后删除，供中断重跑 |

单槽兼容：Windows、`pnpm dev:server`、手动启动器与 M4 之前的部署不设 `WORKBENCH_API_SLOT`，API 照旧直接监听 TCP，没有入口与 PROXY 头。

### 3.3 槽的模式

槽启动时读取 `.api-slot`：槽名与真实版本路径都与记录一致时以**服务**模式启动，否则以**候选**模式启动。旧槽在候选验证期间崩溃，会从固定旧版本以服务模式恢复；候选崩溃重启仍是候选。

| 模式 | 行为 |
| --- | --- |
| 候选 | 只创建 `probe.sock` 与 `ctl.sock`，不创建 `http.sock`，入口连接它只会得到 `ENOENT` 并按 3.7 等待。库连接设 `PRAGMA query_only=ON`，不执行 `openHubDatabase` 的建表事务（`server/control/schema.mjs:34`），改为核对必需的表与列（`hub.sqlite` 目前没有 schema 版本号，不另造）；不调用 `ensurePassword`/`seedProjects`，只核对管理员密码与项目种子已存在；不构造更新协调器：它在构造时就缓存 `pendingPlanId` 与维护值，并可能写回设置（`server/updates.mjs:193-195`、`:242`、`:250`），所以候选不轮询更新、不同步维护，也不会带着候选启动时的缓存进入服务；不上报 SSE 计数；Portal 不签发也不消费 ticket/grant（含 `GET /__hub/authorize`，`server/portal.mjs:451-452`），返回 503，并停掉每 60 s 的 `pruneStored` 清理（`:141-142`）；其余写请求返回 503。任一核对失败即退出 |
| 服务 | 现有 API 行为：建表、协调器、计数上报、写入按准入提交。整体更新与首次启动仍在服务模式下执行 `ensurePassword`/`seedProjects`（受控准备阶段） |

`POST /promote`：槽重新读取 `.api-slot`，与自身一致才执行：关闭 `query_only`，此时才构造更新协调器（从库内读取当前持久值）并等待 `initialize()` 结束（失败沿用现有处理：记警告，相关写入暂拒），启动 Portal 清理，再创建 `http.sock` 并返回 `mode=serving`；不一致返回 409；重复调用幂等。

定向探针由安装器运行目标版本中的 `server/entry/probe.mjs`，经 `probe.sock` 发送 PROXY 头（源 `127.0.0.1`，目的端口取环境文件的 `PORT`）与固定的工作台 Host `hub.localhost:<PORT>`（`server/api/server.mjs:431` 与 `server/portal.mjs:443` 都放行；curl 默认的 `localhost` 会被 302 到规范地址，`server/api/server.mjs:435-436`；不用 `PUBLIC_ORIGIN`，因其须连端口完全相等才绕过 Portal，`:423`），全部只读、不带会话：`/api/health` 与 `/api/ready` 为 200；`/` 返回本版本 `index.html`，其引用的一个 `assets/` 文件可读；带一个已登记项目 Host 的无授权请求得到 Portal 的 401（不签发 ticket）；`/api/session` 无会话得到 `authenticated: false`。另以 `ctl.sock` 的 `identity` 核对 `pid` 等于单元 `MainPID`、`release` 等于目标版本、`slot` 与 `mode` 正确、`protocol` 与入口一致。不用 curl 的 `--haproxy-protocol`：它在 UNIX socket 上发出的地址不可控。服务模式下 `probe.sock` 只接受 GET、HEAD。公共端口应答不能替代以上检查。

**M4-3b 实现**（`server/slot-protocol.mjs`，`server/api/main.mjs` 的 `slotOptions`/`startApi`）：单元以 `WORKBENCH_API_SLOT`（`a`/`b`）、`WORKBENCH_API_SLOT_DIR`（私有 socket 目录）与 `WORKBENCH_API_SLOT_RECORD`（`.api-slot` 路径）启用槽模式，后两者须为绝对路径，缺一即退出；未设置时仍监听 TCP `PORT`，单槽部署行为不变。候选对 `/api/health`、`/api/ready`、`/api/session` 与静态文件之外的 `/api/` 请求一律 503（读请求也拒绝，比“写请求 503”更严）。`probe.sock` 由 API 的 HTTP 服务自身监听，保留其连接跟踪与请求超时；`http.sock` 的连接经 `attach()` 交给同一服务；`ctl.sock` 不读 PROXY 头。`identity` 的 `mode` 在 `http.sock` 建好后才为 `serving`；晋升在库已可写之后失败即经 `fail()` 退出进程，此后的 `promote` 返回 503，重启后按记录以服务模式启动。槽目录须为本用户所有且无组与其他用户权限；只删除连不上的陈旧 socket，候选启动时也删掉遗留的 `http.sock`；记录文件存在但读不了时退出，不按候选启动。协调器改写共享设置的接线移到 `server/control/update-state.mjs`（3.5 的要求）。

### 3.4 客户端与本地地址

经入口转发后，私有连接上的 `req.socket` 是 UNIX socket，没有对端地址和本地端口：

- `remoteAddress` 用于登录 IP 限流与日志，共 4 处（`server/api/server.mjs:237`、`:306`、`:310`，`server/logger.mjs:26`）；不处理会把所有客户端算作同一来源。
- `localPort` 用于 Portal 核对 Host 端口（`server/portal.mjs:94-97`）；它在每个请求的第一步执行，不处理会使整站请求与升级连接都返回 421。

处理：入口在每条私有连接开头写 `PROXY TCP4|TCP6 源 目的 源端口 目的端口\r\n`；API 在 `http.sock` 与 `probe.sock` 上先读这一行（限 107 字节（含 CRLF）、2 s，格式错误、`UNKNOWN` 或超时即断开），把两端地址记在连接上，再交给 HTTP 服务；上述 5 处改读 `clientAddress(req)` 与 `localPortOf(req)`。只在私有 UNIX socket 上接受 PROXY 头，TCP 监听不解析，外部不能伪造来源。`req.socket.encrypted` 不受影响：API 本身不终结 TLS，转发前后都为 false。

### 3.5 只改 API 的切换步骤与提交点

`activation_scope` 为 `api` 时（判定改为比对入口单元而不是单个 API 单元文件，`deploy/install.sh:2523-2524`；存在 `.api-cutover` 时先续完或回滚上一次切换，仍未收敛就按整体更新处理，不给出 `api`；其余条件不变）：

| 步骤 | 动作 | 失败或中断时 |
| --- | --- | --- |
| 1 准备 | 读 `.api-slot` 得旧槽 `old`，`new` 为另一槽；`new` 若在运行先停止；`slots/new` 指向目标版本；写 `.api-cutover` `phase=candidate` | 外部无变化；重跑从本步重来 |
| 2 候选 | `systemctl start api@new`，等待 `identity` 为候选且身份一致（60 s），执行 3.3 的定向探针 | 停止 `new`、删除 `.api-cutover`，更新失败；`old` 未被触碰 |
| 3 记录 | `.api-cutover` 写 `phase=switching`；`systemctl enable api@new`；原子写 `.api-slot={new, 版本}`；`current` 指向目标版本 | **提交点**是 `.api-slot` 的写入。之后重跑向前完成 4 至 6，或按回滚流程反向切换 |
| 4 晋升与切流 | `ctl promote new`；入口 `switch {new, instanceId}`：入口自行读取 `.api-slot` 与 `new` 的 `identity`，须记录槽等于目标、目标为服务模式且实例号一致，才替换目标并返回切换代数 | 失败按回滚流程处理 |
| 5 排空 | `phase=draining`；`systemctl disable api@old`；`systemctl stop api@old`（按 5.1 节排空，至多 75 s）；入口 `status` 中 `old` 在途连接数归零 | 停止超时由 systemd 强杀；重跑按记录停止并停用非记录槽 |
| 6 完成 | 经公共端口检查 `/api/ready`，入口 `status` 目标为 `new`；删除 `.api-cutover`；`finish_activation` | 健康失败按回滚流程处理 |

启用链接先加后减：步骤 3 先启用 `new` 再写记录，步骤 5 才停用 `old`。任意时刻断电，开机时至少拉起记录中的槽：记录未写时 `old` 以服务模式启动、`new` 以候选模式空转；记录已写时 `new` 以服务模式启动、`old` 以候选模式空转。重跑负责停止并停用候选槽。

步骤 3 到 4 之间的窗口：

- 旧槽若恰好崩溃，会以候选模式重启（记录已指向 `new`），没有 `http.sock`；入口目标仍是 `old`，新连接按 3.6 等待，直到步骤 4 完成或回滚。
- 入口若重启，以记录中的 `new` 为目标；`new` 尚未晋升，没有 `http.sock`，新连接同样按 3.7 等待。

两种情况都不会把真实流量送进候选槽；安装器连续执行步骤 3、4，中断后重跑按 `phase=switching` 续作。重跑时若 `.api-slot` 尚未等于 `phase.to`，从步骤 3 重做；已相等则从步骤 4 继续。

**两个协调器并存**：从步骤 4 晋升到步骤 5 旧槽停止，至多约 75 s 内两个槽都在服务模式。更新协调器（`server/updates.mjs`）、Portal 与控制表都在运行时组件键内，只改 API 的更新中两槽的协调器与 Portal 代码相同、读写同一组共享表；协调器的回调接线在 `server/api/server.mjs:74-90`，属于可随只改 API 的更新变化的代码，M4-3b 须把其中改写共享状态的部分移到 `server/api/` 之外或证明它只做映射；`initialize()` 与维护同步按库内持久值幂等收敛，只改 API 的更新不进入交易维护，因此不会互相改写维护状态。此结论在 M4-4 的 Ubuntu CI 中以“切换期间两槽同时轮询、维护状态与更新任务终态不变”验证。

**回滚**（切流后健康失败、更新任务失败或用户回退）走同一流程，目标为 `previous`：旧槽仍在运行时从步骤 3 开始，并在步骤 4 对它执行 `promote`（它可能已以候选模式重启；仍在服务模式时 `promote` 为幂等）；已停止时从步骤 1 开始，以其固定旧版本作为候选验证。回滚也失败时保持 `new` 服务并报告失败，不宣告成功。目标版本不支持双槽时按整体更新处理（见第 7 节）。

**中断重跑**依据 `.api-cutover`、`.api-slot`、两个槽链接、两个单元的启用状态、`MainPID` 与 `identity`：无 `.api-cutover` 时只校正启用链接并停止非记录槽；有则按阶段续作。不从 `current` 推断哪个槽在服务。

### 3.6 整体更新与整体回滚

整体更新（运行时、入口或共享代码变化）沿用 P2 的停组路径，但必须同时改写槽绑定，不能只改 `current`（现有路径见 `deploy/install.sh:2818`、`:2825`，回滚见 `:1419-1421`）：

1. `systemctl stop project-aggregation`，经 `PartOf=` 停止入口与两个槽。
2. 写入单元文件；把记录槽 `s` 的链接 `slots/s` 指向目标版本，原子写 `.api-slot={s, 目标版本}`，`current` 指向目标版本；非记录槽停用，其链接也指向目标版本，避免清理一直保留它原来的版本；删除残留的 `.api-cutover`。
3. 启动运行时，由其 `Wants=` 拉起入口，入口经启用链接拉起 `s`，`s` 以服务模式启动。
4. 健康检查与 `finish_activation`；失败时整体回滚按同样顺序把 `slots/s`、`.api-slot`、`current` 改回 `previous`。

所有改写都在服务组停止期间进行，中断后重跑从第 1 步重来即可，不存在一半已切换的运行状态。

### 3.7 入口行为与预算

- 目标槽连接失败（`ENOENT`、`ECONNREFUSED`，例如槽在自动重启或尚未晋升）：每 200 ms 重试，单次连接超时 2 s，总预算 10 s；期间暂停读取客户端数据；预算用尽关闭客户端连接并记一条警告。不重试已发出数据的连接。
- 切换只影响之后接受的连接；已建立的连接留在原槽，由原槽排空时的 `Connection: close` 与强制关闭结束（M4-3a 已实现）。
- 没有有效记录时不接受转发（关闭连接并记录原因），不猜测目标。
- 单元：`Restart=always`、`RestartSec=1`；入口崩溃期间端口拒连，影响与现在 API 重启相同，但入口代码只做转发，崩溃面更小。

**M4-3c 实现**（`server/entry/main.mjs`、`server/entry/probe.mjs`，共用 `server/slot-protocol.mjs`）：入口以 `WORKBENCH_ENTRY_DIR`（自身 `ctl.sock` 所在目录，须为本用户所有的 0700 目录）、`WORKBENCH_API_SLOT_RECORD` 与 `WORKBENCH_ENTRY_SLOT_ROOT` 启动，三者须为绝对路径；槽目录为 `<ROOT>/project-aggregation-api-<槽>`（`slotDirectory`），M4-4 的模板单元须让 `WORKBENCH_API_SLOT_DIR` 与之一致。启动时记录不可读即退出，记录缺失或无效时照常监听但不转发，之后每个新连接重读记录，读到即开始转发。等待中的连接按目标槽的当前值重试，因此切换前到达、切换后才连上的连接进入新槽；`waiting` 计数单列。私有连接一侧带 FIN 关闭时另一侧写完剩余数据再关；槽侧出错时以 RST 断开客户端（槽进程崩溃在 UNIX socket 上与正常 FIN 无法区分，按 FIN 处理），客户端出错时销毁槽侧连接。目标槽的连接由槽决定寿命，客户端读得慢或不读只会让槽侧暂停，与 API 直接面对客户端时一致；暂停中的槽侧看不到槽退出，因此切换后不再是目标的槽上，暂停中的连接 30 s 内没有任何读写进展即重置客户端并释放两侧（以客户端连接的空闲超时计；内核成批报告可写，持续回压下约相当于每 30 s 至少收走发送队列的一半，排空中的槽本身最多再留 75 s）；槽侧已结束而客户端 30 s 内没有读写进展同样重置。暂停期间客户端自身的关闭要等暂停解除才被发现，不再是目标的槽上另以该超时为限。每次连接尝试的超时取 2 s 与剩余预算的较小值。重复的警告（无记录、重试预算用尽）每 5 s 记一条并带被合并的条数。`POST /switch` 逐个串行处理，请求体在排队前读取，排队中断开的请求不阻塞其后的请求，请求体已读完的仍会照常执行（执行时重新核对记录与身份）；另核对目标槽 `identity.release` 等于记录版本的真实路径，目标未变时幂等、不增加切换代数；`GET /status` 返回 `{protocol, pid, target, generation, connections: {a, b}, waiting}`。关闭时停止监听，直接断开仍在等待的连接，已转发的连接最多再等 5 s：M4-4 的模板槽须 `After=project-aggregation-entry.service`，整组停止时槽先于入口停止并完成排空。探针 `probe.mjs --dir --slot --release --port [--pid] [--mode] [--entry-dir]` 在标准输出写 `{ok, failures, instanceId}`，全部通过才以 0 退出，`instanceId` 供安装器在 `switch` 时使用；项目 Host 取第一个内置模块的 `portalHost`；`index.html` 与其引用的第一个 `assets/` 文件逐字节比对目标版本的 `dist/`。

### 3.8 单元关系与恢复入口

- 运行时单元 `Wants=project-aggregation-entry.service`；入口单元 `PartOf=project-aggregation.service`，**不设 `[Install]`、永不 enable**，只由运行时单元文本拉起；模板槽 `PartOf=project-aggregation.service`，以 `WantedBy=project-aggregation-entry.service` 启用。
- 回退到 M4 之前的安装器时：它在整体更新开头 `systemctl stop "$SERVICE"`（`deploy/install.sh:2392`），经 `PartOf=` 停掉入口与槽；重写后的运行时单元不再 `Wants=` 入口，入口不再被拉起，挂在入口下的槽启用链接随之失效，不会与旧 API 争端口。这依赖旧安装器先停组而不是直接 `restart`（直接 `restart` 会经 `PartOf=` 把入口一起重启）；实施时核对各受支持旧版本的这一行为。残留单元可手动删除后 `daemon-reload`。
- `systemctl stop|restart project-aggregation` 经 `PartOf=` 作用于入口与两个槽。恢复工具停止运行时单元及入口、`@a`、`@b`；guard 写入入口与模板两个 drop-in 目录，`install_guard` 分别核对。
- 入口单元文本、入口与槽协议代码计入整体更新判定：变化即整体重启。模板文本变化不改变判定，新模板在下次启动槽时生效。
- `prune_releases` 保留两个槽链接指向的版本。
- 入口与槽的 `ctl.sock` 对同一服务用户的其他进程（如模块）可达：`identity` 只读，`promote` 与 `switch` 都须与 root 写入的记录一致，因此不能借此把流量导向未经记录的槽。同用户进程也能连 `http.sock`、`probe.sock` 并伪造 PROXY 头的来源地址，绕过按 IP 的登录限流；这不比它已能直接读写 `hub.sqlite` 扩大权限，只在此登记。

### 3.9 首次迁移与退回

| 情形 | 处理 |
| --- | --- |
| 首次启用双槽 | 整体更新：停组；删除单个 API 单元；写入入口、模板与运行时单元；`slots/a` 指向目标版本，`.api-slot={a, 目标版本}`，启用 `@a`；启动运行时 |
| 首次启用失败 | 整体回滚：停组；删除入口单元、模板、槽链接、启用链接、`.api-slot`、`.api-cutover`；恢复单个 API 单元与旧运行时单元，`current` 指回 `previous`；启动。未删除入口单元会使其占住端口，所以删除在恢复启动之前完成 |
| 由 M4 安装器回退到 M4 之前的版本 | 同“首次启用失败”的拆除步骤 |
| 退回 M4 之前后再升级到 M4 | 视为首次启用：先删除残留的 `.api-slot`、槽链接与启用链接（可能指向已清理的版本），再按首次启用重建，不沿用残留记录 |

### 3.10 影响面

| 部分 | 变化 |
| --- | --- |
| `server/api/main.mjs`、`server/api/server.mjs`、`server/portal.mjs`、`server/logger.mjs`、`server/control/schema.mjs` | 候选/服务模式、私有 socket 与 PROXY 头、`clientAddress`/`localPortOf`、只读核对、`identity`/`promote` |
| `server/slot-protocol.mjs`、`server/entry/`（新增） | 槽协议、连接转发、控制 socket、重连预算、定向探针 |
| `deploy/install.sh` | 入口与模板单元、槽链接、`.api-slot`/`.api-cutover`、切换与回滚、整体更新改写槽绑定、首次迁移与退回、清理根、`activation_scope` |
| `server/update-service/registry.py`、`server/recovery/operations.py` | 登记入口与模板单元、guard、停服集合 |
| 资源 | 多一个约 47 MiB 起的常驻进程；切换期间两个 API 槽并存（API 实测约 75 MiB），至多 75 s |
| 不变 | 运行时、模块、采集、执行；会话、登录风控、Portal 的共享表 |

### 3.11 批准事项（2026-10-26 按推荐批准）

1. 接受新增常驻入口进程（A1）及其约 47 MiB 起的内存与一跳本机转发；否则改选 A2。
2. 槽的模式由 `.api-slot` 决定；候选只读、不创建流量 socket、不调用 `ensurePassword`/`seedProjects`，只改 API 的更新依赖旧槽已完成这两步。
3. 客户端地址与本地端口经 PROXY v1 头传递，只在私有 UNIX socket 上接受。
4. 批次按第 9 节的修订拆分：M4-3b 做 API 侧模式、私有接口与槽协议，M4-3c 做入口进程与探针，二者在单槽部署中都不接线；M4-4 接线并在 Ubuntu CI 做连续请求验收。

## 4 M4-1、M4-2：共享登录风控与 Portal 授权

### 4.1 存储位置

新表都在 `hub.sqlite`，由 `server/control/schema.mjs` 的建表语句创建（`CREATE TABLE IF NOT EXISTS`，旧版本忽略新表）。读写封装在 `server/control/` 下的新文件中，不放进 `server/api/`：按第 2 节，`server/control/` 的变化计入运行时组件键，表语义的任何改动都会整体重启，避免两个槽对同一张表的理解不同。

每一步都在 `immediate()`（`server/control/schema.mjs:19-26`）的一个短事务内完成，事务中不做密码哈希、网络请求或其他等待。`SQLITE_BUSY` 沿用 P1-4d-1 的 503。

### 4.2 登录风控表

```sql
CREATE TABLE IF NOT EXISTS login_ip_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_account_guard (account TEXT PRIMARY KEY, failed INTEGER NOT NULL, first_failure_at INTEGER NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_pending (id TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
```

现有语义逐项保留（`server/api/server.mjs:234-287`），只把状态换成表：

| 步骤 | 现有行为 | 共享实现 |
| --- | --- | --- |
| IP 配额预占 | 读请求体前计数加一，满 10 次在窗口内返回 429 | 一个事务内删除过期行、检查并加一；`until` 为首次计数时刻加 `loginWindowMs` |
| 账户锁定检查 | 锁定期内直接 429 | 与 IP 配额预占同一事务读取 `login_account_guard` |
| 账户名额预占 | 读完请求体后、哈希前，`failed + pending >= 5` 即 429，否则 `pending + 1` | 插入一行 `login_pending`，`pending` 为该账户未过期的行数 |
| 校验 | 事务外做密码哈希 | 不变 |
| 失败 | 首次失败记时，累计到 5 次锁定 `accountLockoutMs` | 一个事务内删除自己的 `login_pending` 行并更新计数与锁定 |
| 成功 | 校验后若已被并发失败锁定仍拒绝；否则清零失败数、退回 IP 预占 | 一个事务内删除 `login_pending` 行、复核锁定、清零并把 IP 计数减一 |
| 过期 | 失败在首次失败后 `accountLockoutMs` 过期，锁在截止时刻过期 | 相同，判定时一并删除；有未过期的 `login_pending` 行时不删账户行 |

进程崩溃时预占无法退回：IP 计数留到窗口结束，与现状一致，均为失败关闭；`login_pending` 行带 30 s 期限（远大于一次密码校验的耗时），期满仍未结束的校验（进程崩溃，或记录结果的写入失败，密码正确时也一样）按租约到期时刻计为一次失败，由此触发的锁定同样记 `account_locked` 日志，之后迟到的结果不再重复计数。锁定检查与 IP 预占合并为一个事务，已能在只读查询中判定的拒绝（已锁定、IP 配额用尽）不取写锁。各槽的 `loginWindowMs`、`accountLockoutMs` 来自同一环境文件。

账户仍为单账户 `global`；错误文案、状态码与日志字段不变。

### 4.3 Portal 表

```sql
CREATE TABLE IF NOT EXISTS portal_tickets (digest TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, revision TEXT NOT NULL, destination TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS portal_grants (digest TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, revision TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_portal_tickets_expires ON portal_tickets(expires);
CREATE INDEX IF NOT EXISTS idx_portal_grants_expires ON portal_grants(expires);
```

- 只保存 token 的 SHA-256 摘要，浏览器仍持有原始随机值；表中没有可直接使用的凭证。
- ticket 消费用一个事务内的 `DELETE ... WHERE digest=? RETURNING ...`，两个槽同时消费同一 ticket 时只有一个拿到行。
- grant 的有效性仍按 `validGrant`（原 `liveGrant` 的判断）进行：未过期、会话有效、项目存在且 revision 一致。会话和项目本来就在库里，登出、项目变更、凭据更换由此在两个槽同时生效。
- 登出撤销改为删除 grant 行；库忙删不掉时，本进程立即拒绝该 grant，并在每秒清理中重试删除；重试成功前另一槽仍可能放行，若进程在此之前退出且退出时的重试也失败，该行留到过期（浏览器 cookie 已清除）。自动登录失败的撤销只涉及带认证材料的 grant，仍删进程内条目（见 4.4）。活动流复核读库出错时关闭该流（失败关闭）。
- 300 个的上限改为按表计数，判断与插入在同一事务内。
- 每秒的清理在各槽分别运行，只读库：活动流与进程内 grant 按库中状态复核。删除过期或失效行每分钟一次（签发 ticket 前也会做一次），每表每次至多删 500 行；每分钟的删除与撤销重试都不等待写锁，库忙时推迟到下一轮，不影响正确性，因为每次使用都会自行检查过期与有效性。
- 活动流集合 `active`、自动登录在途集合和资产同步合并 `syncFlights` 仍是进程内状态，它们只描述本进程持有的连接。

### 4.4 带上游认证材料的 grant

外部项目的服务端代登录只在单进程入口 `server/workbench.mjs` 中可用（双进程 API 的 `decrypt` 直接拒绝）。这类 grant 首期不入库，仍放在进程内 Map，行为与现状相同；双槽部署中不会产生这类 grant。若以后双进程 API 也要代登录外部项目，再按上位文档 9.1 节把认证材料加密入库，届时单独评审。

### 4.5 备份与恢复

恢复时 `server/recovery/restore.mjs:105` 已清空 `sessions` 与三个 `login_*` 表，旧备份中没有的表跳过；M4-2 已将新增 `portal_tickets`、`portal_grants` 纳入清空集合。隔离恢复后登录计数从零开始；普通 API 重启、从已含 M4-1 的版本升级均保留库内风控记录，不能与恢复清理混为一谈。

## 5 M4-3：API 排空、就绪标记与静态资源

### 5.1 关闭顺序

收到 `SIGTERM` 后按以下顺序关闭，取代 `server/api/server.mjs:455-459` 的现有顺序：

1. 关闭监听，不再接受新连接；`server.closeIdleConnections()` 关闭空闲的保活连接；此后的响应带 `Connection: close`。
2. 结束概览流与更新流，浏览器重连到另一槽（`EventSource` 自带重连，概览流重连后收到完整快照）。
3. 关闭 Portal 的升级连接与活动流（`portal.close()` 已有，`server/portal.mjs:481`），项目页面按其自身逻辑重连。
4. 等待在途请求结束，上限沿用 `REQUEST_TIMEOUT_MS` 60 s；期满后强制关闭剩余连接。
5. 关闭更新协调器、发送最后一次 SSE 计数、关闭数据库与锁（`server/api/main.mjs:37-43`）。

单实例部署同样受益：关闭期间不再有请求撞上已关闭的 Portal。API 单元的 `TimeoutStopSec=75` 覆盖上述 60 s 加余量，不变。

M4-3a 实施要点（`createApiServer().close()`，原 `closeServer()` 并入其中）：

- 第 1 步对尚未写出响应头的在途请求补 `Connection: close`，此后每个响应结束时再关一次空闲连接；只调用 `server.close()` 时，响应头已发出的保活连接会留到 `keepAliveTimeout` 才断开。
- 第 3 步是新增的 `portal.drain()`：只断开升级连接和响应类型为 `text/event-stream` 的代理流，排空期间到达的事件流与升级请求直接结束或返回 503；普通代理请求、自动登录与资产协调继续完成。第 5 步的 `portal.close()` 再结束其余部分。
- 排空期间 `/api/ready` 返回 503，新的概览流返回 503；`/api/health` 不变。
- 60 s 期限从 `close()` 开始计时；更新流立即结束连接、停止定时器，其状态读取与 HTTP 排空并行，不在排空前串行等待。期满时关闭剩余 HTTP 连接和已升级的套接字，并记录一条警告与剩余数。被拒绝的升级请求写完响应即销毁套接字，不因客户端半开而拖住关闭。之后最多再等 2 s 让仍在执行的处理函数结束，再关闭协调器；尚未开始的维护同步被取消，迟到的检查、准入及收尾不再写控制库或发送新的更新请求。协调器与状态流共同使用最后 5 s 收尾预算，再关数据库与锁；最坏合计约 60 + 2 + 5，在 75 s 内。
- 单进程 `createApp` 的数据面随进程关闭：排空与数据面关闭并行，在途的导入、交易读取被取消后仍以其结果答复，不必等满 60 s。
- 手动运行的启动器 `API_STOP_MS` 由 30 s 改为 75 s，与 API 单元的 `TimeoutStopSec` 一致，避免排空中的 API 被提前强杀。

### 5.2 端口复用与就绪标记

以下变量仅为原草案，不是已批准实现。第 3 节已批准方案以入口持有的公共端口、槽的私有 UNIX socket、槽链接、`.api-slot` 记录与 `identity` 接口取代端口复用与就绪文件（见 3.2、3.3）；批准后按其改写本节。不允许用公共端口应答替代候选检查。

`server/api/main.mjs` 增加两个环境变量，只在双槽单元中设置：

| 变量 | 作用 |
| --- | --- |
| `WORKBENCH_API_REUSE_PORT=1` | 以 `reusePort: true` 监听；非 Linux 平台拒绝启动并说明原因 |
| `WORKBENCH_API_READY_FILE` | 监听成功后原子写入就绪记录：`{ pid, slot, instanceId, releaseKey, port }`，`releaseKey` 取版本目录的 `.release-application-key`；关闭开始时删除 |

候选检查必须使用显式只读模式或独立验证入口：锁与恢复状态、已有 schema、运行时兼容性及前端真实读取均通过后才能晋升；不能直接复用当前会建表、初始化密码、种子和协调维护的普通 API 启动。幂等写入仍是副作用，移到受控准备阶段；候选不得启动协调轮询或转发用户写入。

### 5.3 并存期间的静态资源

两个槽并存的几秒内，浏览器可能从新槽拿到 `index.html`，再经另一条连接从旧槽请求新版本的脚本；或者已打开的旧页面在切换后按需加载旧版本的分包。两种情况下对方的 `dist/` 都没有该文件，会返回 404。

静态响应在自身 `dist/` 中找不到文件、且路径位于 Vite 产出的 `assets/` 目录时，依次从 `$APP_DIR/current`、`previous`、`slots/a`、`slots/b` 指向的发布目录查找。槽链接覆盖 `current` 已切换而 `previous` 尚未更新的窗口，也保留回滚前已返回页面所需的分包；安装器清理继续保留槽链接引用的发布目录。`APP_DIR` 由当前版本目录推导，不来自请求；不扫描其他发布目录、不新增来源缓存，链接移动或删除在下一次查找生效。

这也修复了现有问题：整体更新后仍开着的旧页面加载旧分包会 404。

`server/static-response.mjs` 的 `createReleaseAssetLookup` 只在 `<APP_DIR>/releases/<12 位提交>-<16 位键>/dist` 布局下生效，普通开发目录不查找。四个固定链接解析后须仍是同一 `releases/` 下的合法发布目录且不是自身；文件名只允许单段 `[A-Za-z0-9_.-]`，文件须是普通文件且真实路径不变，不跟随发布目录内的软链。Windows 测试用目录 junction 验证同一规则。回滚到尚未包含该能力的旧程序，不能获得新程序的跨槽资源保障。

## 6 M4-4：双槽单元与安装器切换

按第 3 节实施；本节记录实施时的取舍、影响面与回滚，原草案（共享 `current`、端口复用、按就绪文件切换）已废弃。

### 6.1 单元与状态文件

| 对象 | 内容 |
| --- | --- |
| 运行时 `project-aggregation.service` | 与单槽相同，只把 `Wants=` 的 API 单元换成入口单元 |
| 入口 `project-aggregation-entry.service` | 从 `current` 运行 `server/entry/main.mjs`；`PartOf=` 运行时、无 `[Install]`；`Restart=always`、`RestartSec=1`；`RuntimeDirectory=project-aggregation-entry`（0700）；`WORKBENCH_ENTRY_DIR`、`WORKBENCH_API_SLOT_RECORD=$APP_DIR/.api-slot`、`WORKBENCH_ENTRY_SLOT_ROOT=/run` |
| 槽模板 `project-aggregation-api@.service` | `WorkingDirectory` 与 `ExecStart` 经 `$APP_DIR/slots/%i`；`After=` 运行时与入口、`PartOf=` 运行时；`RuntimeDirectory=project-aggregation-api-%i`（0700）；`WORKBENCH_API_SLOT=%i` 及槽目录、记录路径；其余（重启退避、`TimeoutStopSec=75`、沙箱）与单槽 API 单元相同；`WantedBy=` 入口 |
| `$APP_DIR/slots/a`、`slots/b` | 指向 `releases/<版本>` 的软链，只在该槽停止时改写 |
| `$APP_DIR/.api-slot` | `{"slot","release"}`，root 原子写入 |
| `$APP_DIR/.api-cutover` | `{"from","to","release","phase"}`，切换完成或整体更新时删除 |

入口用 `PartOf=` 而不是 `StopPropagatedFrom=`：在 systemd 255 上实测两者都会随运行时的重启与崩溃自动重启而重启入口，后者没有收益。运行时崩溃时入口与槽一起重启，影响与现状（API 随运行时重启）相同。

恢复 guard 只加在运行时与槽模板（`project-aggregation-api@.service.d/`）：入口不打开数据目录，不需要 guard（与 3.8 原文“入口与模板”不同，按此实施）。安装器整体更新时把运行时已有的 guard 复制到模板目录，退回单槽时复制到单个 API 单元目录，避免恢复工具上次写入的保护在拓扑变化后失效。

### 6.2 何时启用双槽

- 双槽的判定：入口单元存在，且运行时单元的 `Wants=` 列出入口单元。只有入口单元而运行时不拉起它（中断的退回、手动残留）仍按单槽处理；安装器（`dual_installed`）、更新服务登记与恢复入口用同一条判定。
- 已是双槽时保持双槽，回到单槽只经回滚或退回。
- 首次启用：直接执行安装命令时立即启用。由在线更新执行时，执行进程在任务开始时已加载旧的 `registry.py`，它不认识双槽单元，会把成功的安装判为“安装结果尚未确认”；因此更新执行单元在运行且已安装的 `registry.py` 未声明 `LAYOUTS` 含 `dual-slot` 时，本次仍按单槽安装，安装结束时更新服务随之升级，下一次整体更新（或再次执行安装命令）再启用双槽。
- 布局不同即整体更新：首次启用与退回都改运行时单元，`activation_scope` 只在两次安装都是双槽、运行时与入口单元文本、运行时部署记录和运行时组件键都未变、且没有未收敛的 `.api-cutover` 时给出 `api`。更新服务的预判（`ci_scope`）同样只对登记为 `dual-slot` 布局的安装给出 `api`，单槽安装的 CI 更新一律按整体更新规划。

### 6.3 只改 API 的切换

按 3.5 的步骤 1 至 6 实施（`api_cutover`）。候选等待 60 s 内反复运行目标版本的 `server/entry/probe.mjs`（以服务用户执行，`--pid` 取单元 `MainPID`）；晋升与切换经 `curl --unix-socket` 调用槽与入口的 `ctl.sock`；步骤 5 停止旧槽后等待入口统计的旧槽连接归零（10 s）。模板文本变化时先写入并 `daemon-reload`，旧槽的进程不受影响。

失败处理（`rollback` 的 API 分支）：

- 提交点（写 `.api-slot`）之前：停止并停用新槽，删除 `.api-cutover`；旧槽、`current` 与记录都未改动。
- 提交点之后：以旧槽与其固定版本为目标反向切换；旧槽仍在运行时从步骤 3 开始（`promote` 幂等），已停止时从步骤 1 开始。反向切换也失败时保持新槽服务、报告失败。

中断重跑：安装开始时若存在 `.api-cutover`，记录已指向 `to` 则向前完成步骤 4 至 6，否则停止并停用 `to`；仍未收敛则按整体更新处理。

### 6.4 整体更新、首次启用与退回

按 3.6、3.9 实施（`activate_dual_full`、`dual_teardown`）：先 `systemctl stop` 运行时（经 `PartOf=` 停止入口、槽与单槽 API），再迁移模块、写单元、改写记录槽与另一槽的链接、记录与 `current`，启用记录槽、停用另一槽，最后启动运行时。首次启用删除单个 API 单元，记录槽取 `a`。

整体回滚：先停组；之前是双槽时恢复三份单元文件、把记录槽链接与记录改回之前的版本；之前是单槽或首次安装时执行 `dual_teardown`（停用两个槽实例，删除入口与模板单元、槽链接、`.api-slot`、`.api-cutover`），恢复单个 API 单元后再启动。删除在启动之前完成，避免入口占住端口。

### 6.5 更新服务登记与恢复入口

- `registry.py`：按 6.2 的判定为双槽时（结果字段 `layout` 为 `dual-slot`，否则为 `single`）核对运行时、入口（`WorkingDirectory=current`，运行 `server/entry/main.mjs`）与模板（`WorkingDirectory=$APP_DIR/slots/%i`，运行 `slots/%i/server/api/main.mjs`）三份单元及其 drop-in；guard 只允许出现在运行时与模板目录；部署身份纳入三份单元文本。`LAYOUTS` 声明支持的布局，供 6.2 判断。
- `server/recovery/operations.py`：按 6.2 的判定为双槽时停服集合为运行时、入口、`@a`、`@b`；单槽时为运行时与 API，另加仍残留的入口与槽实例（手动启动仍可能运行）；`deployment()` 核对入口与模板的服务用户与 Node 路径，`install_guard` 写运行时与模板 guard 并核对两个实例加载的 drop-in；恢复后只启动运行时。

### 6.6 影响面与回滚

| 项目 | 内容 |
| --- | --- |
| 影响 | `deploy/install.sh`（单元、布局判定、切换、整体更新、回滚、清理、健康检查）、`server/update-service/registry.py`、`server/recovery/operations.py`、CI 与测试；入口、槽与探针代码不变 |
| 不影响 | 运行时、模块、采集与执行；单槽部署在暂缓启用时保持原路径 |
| 回滚 | 代码层面还原本批次提交即可：已启用双槽的部署由新版本安装器的整体回滚或退回流程恢复单槽；由 M4 之前的安装器覆盖安装时，先执行 `sudo systemctl stop project-aggregation`，并删除入口与模板单元后 `daemon-reload`（见 3.8） |
| 验收 | Ubuntu CI 真实 systemd（`deploy/test-slots-systemd.sh`，真实入口与 API 槽，运行时用测试替身与假模块）：首次启用、连续短连接与保活请求下的只改 API 切换（统计拒连、重置、HTTP 失败；保活连接上因服务端关闭空闲连接而失败的请求按浏览器做法重试一次并单独计数，其余非 200 均判失败）、候选失败不影响旧槽、提交后反向切换（含记录已移动而内存标志未置位）、中断切换的续作与停止、整体更新保持记录槽、整体停止时槽先于入口、退回单槽；mock 安装测试继续覆盖单槽路径与布局判定 |

## 7 兼容、迁移与回滚

| 情形 | 处理 |
| --- | --- |
| 首次启用双槽 | 单元拓扑变化，整体更新；来源尚无持久 Portal 时旧 grant 随进程消失，用户重新打开模块页面。来源已含 M4-1 时保留库内登录风控；更早版本的内存计数不迁移 |
| M4 之间只改 API | 候选验证后切流，旧槽按预算排空，流断开后恢复；连接失败口径按第 1.3 节验收 |
| M4 之间改到共享代码或单元 | 整体更新，与 P2 相同 |
| 回退到 M4 之前的版本 | 运行时单元不同，整体更新；M4 安装器执行回滚时恢复单个 API 单元，删除入口单元、模板、槽链接、`.api-slot` 与 `.api-cutover`；由 M4 之前的安装器执行时，残留单元不再被拉起（见 3.8、3.9），可手动删除后 `daemon-reload`；新表留在库里不影响旧代码 |
| 新表结构以后需要改动 | 只能先扩展后收缩；由于 `server/control/` 计入运行时组件键，改动必然整体重启，不会出现新旧两槽同时读写不同语义 |

## 8 风险

| 风险 | 处理 |
| --- | --- |
| 关闭监听瞬间排队连接被重置 | 第 3 节由入口持有唯一监听队列，关闭旧槽不涉及公共监听；仍须按第 1.3 节做负载验收，不将浏览器重试或内核参数当成已解决 |
| 入口成为新的单点 | 入口只做连接转发、计入整体更新；崩溃由 systemd 1 s 内重启，期间影响与现有 API 重启相同；M4-3c 覆盖半关闭、升级连接、重连预算与控制接口 |
| 登录与 Portal 改为每次读库后的写入竞争 | 每步一个短事务；Portal 的每个请求只读不写，写只发生在签发、消费、撤销与清理；P1-4d-1 的写等待统计可观察影响 |
| 候选误启动协调器 | 候选不构造协调器、不建 `http.sock`，`promote` 时才从库内持久值构造并启用服务中职责（3.3）；按上位状态边界验证 |
| 旧页面与新 API 的接口兼容 | 与现有整体更新相同，不在本方案内新增约束 |
| 槽身份与候选链路不一致 | 安装器以 `ctl.sock` 的 `identity` 核对槽、固定版本、`MainPID` 与协议版本，并经 `probe.sock` 做 HTTP/Portal/静态探针；入口切换时再核对记录与实例号（3.3、3.5） |

## 9 批次拆分

| 批次 | 内容 | 等级 | 规模 |
| --- | --- | --- | --- |
| M4-1 | 共享登录风控：`server/control/login-guard.mjs`、建表、登录路由改用共享表、恢复时清空、跨实例测试 | R3（鉴权） | 中 |
| M4-2 | Portal 持久授权：`server/control/portal-store.mjs`、建表、`createPortal` 改用存储、恢复时清空、跨实例测试 | R3（鉴权） | 中 |
| M4-3a | 单实例 API 排空顺序与静态资源跨版本回退，不含激活 | R2 | 中 |
| M4-3b | 按第 3.2 至 3.4 节：`server/slot-protocol.mjs`、API 候选/服务模式与只读核对、私有 `probe.sock`/`http.sock`/`ctl.sock`、`identity`/`promote`、PROXY 头与 `clientAddress`/`localPortOf`；单槽部署不接线 | R3（部署激活） | 中 |
| M4-3c | 按第 3.2、3.7 节：`server/entry/` 连接转发、控制 socket、重连预算与 `probe.mjs` 定向探针；单槽部署不接线 | R3（部署激活） | 中 |
| M4-4 | 模板单元与槽记录、安装器双槽切换与回滚、首次迁移与回退、更新服务登记、恢复入口、Ubuntu CI 连续请求验证 | R3（部署激活） | 大 |

每个实现批次单独提交、单独审查并发布。M4-1、M4-2 已合入；M4-3a 可在单实例部署先行改善授权、关闭和旧分包加载。第 3 节已批准，M4-3b、M4-3c 已实施；M4-4 依赖 M4-1、M4-2、M4-3a/b/c 全部通过并发布，以及 M2a、M3 和 P2b 生产验收前置，不把尚未完成的草案当作可直接实施方案。

## 10 关联资料

- [架构实现方案](architecture-implementation.md)：M4 的目标、Portal 持久授权与双槽激活状态机。
- [控制面与数据面分离](control-data-plane-separation.md)：P2 的双单元、按范围激活与 P2b 准入。
- [部署说明](deployment.md)：安装与服务管理入口。
- [备份与恢复](backup-recovery.md)：恢复 guard 与服务组停止方式。
