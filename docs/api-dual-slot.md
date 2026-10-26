# 工作台 API 双槽技术实现方案（M4）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.1 上位评审同步稿（切流方案待修订） |
| 日期 | 2026-10-26 |
| 源码基线 | project-aggregation `f3ea48d` |
| 上位文档 | [架构实现方案](architecture-implementation.md) 第 3.1、9.1、11 节与第 15 节的 M4；[控制面与数据面分离](control-data-plane-separation.md)（M3，已全部发布） |
| 适用范围 | `server/api/`、`server/portal.mjs`、`server/control/`、`server/static-response.mjs`、`server/recovery/`、`server/update-service/registry.py`、`deploy/install.sh` 与相关测试 |
| 设计状态 | M4-1 已在 `462e43a` 合入并通过 Checks；M4-2 持久 Portal 授权已合入（合并提交见 `git log --merges --grep M4-2`）；其余未实施。第 3、5.2、6 节保留原切流草案，须先按上位第 11 节修订并评审，不作为可直接实施的步骤 |
| 改动分级 | 本文为 R1 文档；实现批次的等级见第 9 节 |

文中 `路径:行号` 均指上述基线，实施时以符号名重新定位。

本轮只同步上位约束与实施状态，未选定新的稳定入口实现。原草案的端口复用、候选启动写入、两槽共享 `current` 和公共健康检查存在未解决的契约冲突；对应批次不得按旧步骤实施。M4-2 的授权存储与不涉及激活的排空改进可独立推进，M4 激活仍须满足 M2a、M3 和 P2b 生产验收前置。

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
- 稳定入口是否增加进程在第 3 节重新评审，不以“不新增进程”排除上位候选隔离与可控切流要求。
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

## 3 方案选择

本节保留原方案比较作为评审输入，C 不再视为已选定。新选择须满足上位第 11.2 节：验证前不导流、固定槽版本、私有定向探针和可控切流；同时覆盖稳定入口自身更新及恢复工具停止完整服务组的行为。端口可绑定或省去一跳不足以证明满足这些条件。

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A 常驻前置代理 | 新增一个只做转发的进程监听端口，按记录把请求转到 `a` 或 `b` 的 UNIX socket | 每个请求多一跳；转发 SSE、WebSocket 升级与 Portal 的项目 Host 要再实现一遍；前置代理自身更新又会断连 |
| B systemd 套接字共享 | `project-aggregation-api.socket` 持有监听，两个槽经 `Sockets=` 继承同一描述符 | 排队队列唯一，关闭一槽不丢连接；但套接字单元需要一个固定的触发服务名，与模板槽冲突；无进程时有连接会自动拉起服务，与恢复 guard 的停服语义冲突 |
| C 内核端口复用（原草案，待修） | 两个槽都以 `SO_REUSEPORT` 监听同一地址，内核分配新连接 | 原草案记录可绑定同端口，但候选一监听即可能接外部流量，不能满足先验证后切流；需重新论证或替换，不能按本节直接实施 |

方案 C 还存在关闭监听时排队连接被重置的问题；不能以队列通常为空或浏览器可能重试作为无损证明。连接迁移参数也不能代替候选隔离与切流控制。新方案须按第 1.3 节覆盖真实负载和失败路径，系统参数改动另行评估。

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

### 5.2 端口复用与就绪标记

以下变量仅为原草案，不是已批准实现。重新评审时保留槽、版本和进程身份核对，补每槽私有探针；是否使用端口复用随第 3 节决策，不允许用公共端口应答替代候选检查。

`server/api/main.mjs` 增加两个环境变量，只在双槽单元中设置：

| 变量 | 作用 |
| --- | --- |
| `WORKBENCH_API_REUSE_PORT=1` | 以 `reusePort: true` 监听；非 Linux 平台拒绝启动并说明原因 |
| `WORKBENCH_API_READY_FILE` | 监听成功后原子写入就绪记录：`{ pid, slot, instanceId, releaseKey, port }`，`releaseKey` 取版本目录的 `.release-application-key`；关闭开始时删除 |

候选检查必须使用显式只读模式或独立验证入口：锁与恢复状态、已有 schema、运行时兼容性及前端真实读取均通过后才能晋升；不能直接复用当前会建表、初始化密码、种子和协调维护的普通 API 启动。幂等写入仍是副作用，移到受控准备阶段；候选不得启动协调轮询或转发用户写入。

### 5.3 并存期间的静态资源

两个槽并存的几秒内，浏览器可能从新槽拿到 `index.html`，再经另一条连接从旧槽请求新版本的脚本；或者已打开的旧页面在切换后按需加载旧版本的分包。两种情况下对方的 `dist/` 都没有该文件，会返回 404。

静态响应在自身 `dist/` 中找不到文件、且路径位于 Vite 产出的 `assets/` 目录时，依次在 `$APP_DIR/current/dist/` 与 `$APP_DIR/previous/dist/` 中查找，找到即返回。`assets/` 下的文件名含内容哈希，同名即同内容，跨版本返回不会混用不同内容。路径校验与现有规则相同（`server/api/server.mjs:436-441`），只查这两个固定目录，不跟随其他软链；`APP_DIR` 由版本目录的上两级得出，不来自请求。

这也修复了现有问题：整体更新后仍开着的旧页面加载旧分包会 404。

## 6 M4-4：双槽单元与安装器切换

本节为待替换的原草案。后续版本须将两槽的启动路径分别绑定不可变 release，按“候选私有验证→可控切流→旧槽排空→完整回执”改写，并登记每步持久化和恢复依据；下述共享 `current`、先监听再验证及不区分应答槽的流程不得原样实施。

### 6.1 服务单元

`project-aggregation-api.service` 改为模板 `project-aggregation-api@.service`，实例 `a`、`b`，相对 P2 的 API 单元（`docs/control-data-plane-separation.md` 6.1 节）只改以下几项：

```ini
[Unit]
Description=Project Aggregation workspace API (slot %i)
After=project-aggregation.service
PartOf=project-aggregation.service

[Service]
Environment=WORKBENCH_API_SLOT=%i
Environment=WORKBENCH_API_REUSE_PORT=1
Environment=WORKBENCH_API_READY_FILE=/run/project-aggregation-api-%i/ready
RuntimeDirectory=project-aggregation-api-%i
RuntimeDirectoryMode=0700

[Install]
WantedBy=project-aggregation.service
```

- 运行时单元去掉 `Wants=project-aggregation-api.service`；当前槽以 `systemctl enable project-aggregation-api@<slot>` 在 `project-aggregation.service.wants/` 下建立依赖，开机或整体重启时只拉起当前槽。
- 安装器把当前槽记在 `$APP_DIR/.api-slot`（内容为 `a` 或 `b`），任何时刻只启用一个槽。
- `PartOf=` 使 `systemctl stop|restart project-aggregation` 同时作用于正在运行的槽，运维命令含义不变。
- 两个槽都从 `$APP_DIR/current` 启动。入口经软链解析为真实版本目录后，旧槽继续使用旧版本的代码与 `dist/`，`current` 切换不影响它。
- 首次安装 M4 的版本时，运行时单元文件变化，按 P2 规则整体更新：安装器停用并删除旧的 `project-aggregation-api.service`，写入模板并启用槽 `a`。

### 6.2 只改 API 时的切换

`activation_scope` 判为 `api` 时（`deploy/install.sh:2518-2532`，判定条件不变），取代现有的 `systemctl restart`：

```text
读 .api-slot 得旧槽 old，新槽 new 为另一个
→ 新槽若仍在运行（上次中断的残留）先停止
→ current 指向新版本；模板有变化则写入并 daemon-reload
→ systemctl start project-aggregation-api@new
→ 等待新槽就绪记录：pid 等于该单元 MainPID，releaseKey 等于新版本，期限 60 s
   └ 超时或单元失败：停止新槽，current 指回旧版本，旧槽不动，更新以失败结束
→ systemctl enable 新槽、disable 旧槽，写 .api-slot
→ systemctl stop project-aggregation-api@old（按 5.1 节排空，至多 75 s）
→ 原有的端口健康检查与 finish_activation
```

- 旧槽停止前，两个槽同时提供服务。按第 2 节，它们只在 `server/api/` 与前端上不同，共享表的语义一致；两个槽的更新协调器在并存期间各自轮询，但只改 API 的更新不进入交易维护，不会互相改写维护状态。
- 切换后的回滚（更新任务失败、或用户回退到上一版本）走同一流程，目标是 `previous`。目标版本不支持双槽（M4 之前的版本）时，运行时单元会不同，按整体更新处理。
- 安装器中断后重跑：以 `.api-slot` 和两个槽的实际状态为准。只有一个槽在运行时，把记录改成该槽；两个都在运行时，保留记录中的槽并停止另一个。
- `wait_healthy` 仍检查端口；端口由哪个槽应答无关紧要，新槽是否就绪已由就绪记录确认。

### 6.3 更新服务登记与恢复入口

- `registry.py` 的 `extra_services` 改为模板名，校验 `/etc/systemd/system/project-aggregation-api@.service` 的受管标记、`WorkingDirectory`、`User` 与唯一 `ExecStart`。部署身份 `identity` 改为纳入模板文件内容。
- 恢复 guard 写到 `project-aggregation-api@.service.d/20-recovery-guard.conf`，对两个实例都生效；`operations.install_guard` 校验两个实例的 `DropInPaths` 都只有这一个 guard。
- 备份、交接与恢复的停服步骤（`server/recovery/operations.py`）改为停止运行时单元及 `project-aggregation-api@a`、`@b`，不依赖哪个槽正在运行；恢复后的启动只启动运行时单元，由其依赖拉起当前槽。
- 只改 API 的判定（`activation_scope`）比较的是运行时单元文件，模板变化不改变判定，与 P2 中 API 单元变化的处理一致。

### 6.4 平台

- 模板单元、`%i` 与按实例的 `RuntimeDirectory` 在 Debian 12（systemd 252）与 Ubuntu 24.04（systemd 255）都可用；`RestartSteps` 的 254 版本条件沿用 P2-1。
- `SO_REUSEPORT` 只在 Linux 上使用。非 systemd 的手动运行与 Windows 保持单实例。

## 7 兼容、迁移与回滚

| 情形 | 处理 |
| --- | --- |
| 首次启用双槽 | 单元拓扑变化，整体更新；来源尚无持久 Portal 时旧 grant 随进程消失，用户重新打开模块页面。来源已含 M4-1 时保留库内登录风控；更早版本的内存计数不迁移 |
| M4 之间只改 API | 候选验证后切流，旧槽按预算排空，流断开后恢复；连接失败口径按第 1.3 节验收 |
| M4 之间改到共享代码或单元 | 整体更新，与 P2 相同 |
| 回退到 M4 之前的版本 | 运行时单元不同，整体更新；安装器恢复单个 API 单元、删除模板与依赖链接；新表留在库里不影响旧代码 |
| 新表结构以后需要改动 | 只能先扩展后收缩；由于 `server/control/` 计入运行时组件键，改动必然整体重启，不会出现新旧两槽同时读写不同语义 |

## 8 风险

| 风险 | 处理 |
| --- | --- |
| 关闭监听瞬间排队连接被重置 | 原草案未满足连续性证明，须重新选型并做负载验收，不将浏览器重试或内核参数当成已解决 |
| 登录与 Portal 改为每次读库后的写入竞争 | 每步一个短事务；Portal 的每个请求只读不写，写只发生在签发、消费、撤销与清理；P1-4d-1 的写等待统计可观察影响 |
| 候选误启动协调器 | 候选验证期间禁止更新轮询及维护同步，晋升后才启用服务中职责；按上位状态边界验证 |
| 旧页面与新 API 的接口兼容 | 与现有整体更新相同，不在本方案内新增约束 |
| 就绪记录与候选链路不一致 | 受信控制路径核对固定槽版本、单元进程和就绪身份，并做私有 HTTP/Portal/静态探针；文件存在本身不构成就绪 |

## 9 批次拆分

| 批次 | 内容 | 等级 | 规模 |
| --- | --- | --- | --- |
| M4-1 | 共享登录风控：`server/control/login-guard.mjs`、建表、登录路由改用共享表、恢复时清空、跨实例测试 | R3（鉴权） | 中 |
| M4-2 | Portal 持久授权：`server/control/portal-store.mjs`、建表、`createPortal` 改用存储、恢复时清空、跨实例测试 | R3（鉴权） | 中 |
| M4-3a | 单实例 API 排空顺序与静态资源跨版本回退，不含激活 | R2 | 中 |
| M4-3b | 显式候选模式、固定槽身份、私有探针与就绪协议；切流方式先按第 3 节重新评审 | R3（部署激活） | 中 |
| M4-4 | 模板单元与槽记录、安装器双槽切换与回滚、首次迁移与回退、更新服务登记、恢复入口、Ubuntu CI 连续请求验证 | R3（部署激活） | 大 |

每个实现批次单独提交、单独审查并发布。M4-1、M4-2 已合入；M4-3a 可在单实例部署先行改善授权、关闭和旧分包加载。M4-3b 须先完成切流方案评审；M4-4 依赖 M4-1、M4-2、M4-3a/b 全部通过并发布，以及 M2a、M3 和 P2b 生产验收前置，不把尚未完成的草案当作可直接实施方案。

## 10 关联资料

- [架构实现方案](architecture-implementation.md)：M4 的目标、Portal 持久授权与双槽激活状态机。
- [控制面与数据面分离](control-data-plane-separation.md)：P2 的双单元、按范围激活与 P2b 准入。
- [部署说明](deployment.md)：安装与服务管理入口。
- [备份与恢复](backup-recovery.md)：恢复 guard 与服务组停止方式。
