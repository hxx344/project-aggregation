# 架构实施基线与批次进度

本文件记录 [架构实现方案](architecture-implementation.md) 的实际接入边界。本轮于 2026-10-26 对照源码 `462e43a`：M0、M1、M2 恢复安全基础及 M3 已接入，M3 的 P0/P1/P2/P2b 已发布，M4-1 共享登录风控已合入。源码接入、检查通过、正式发布和生产验收分开记录；正式身份以 GitHub Release 为准，本文不把后续设计算作实现。四周生产样本、生产 RPO/RTO 和 P2b 的 API-only 生产证据仍待收口。操作步骤见 [备份与恢复](backup-recovery.md)。

## 已接入的基线

五个内置模块在经过 worker 私有密钥认证后响应 `GET /__workspace/capabilities`。它不进入模块页面处理器，不追加旧摘要字段，页面代理继续拒绝原始或编码的内部路径。能力读取限 16 KiB、总时限 5 s、无自动重试、无跨实例缓存。

| 模块 | 摘要版本 | 维护协议 | 更新检查协议 | 现有健康路径 | 统一账户写入协议 | 恢复保护协议 |
| --- | --- | --- | --- | --- | --- | --- |
| Monitor | 1、2 | 无 | 无 | `/healthz` | 未接入 | 未接入 |
| Asset | 2 | 无 | 无 | `/api/health` | 未接入 | 未接入 |
| CrossEx | 1、2 | 1 | 1 | `/api/health` | 1 | 1 |
| Greeks | 2 | 1 | 1 | `/api/health` | 1 | 1 |
| ASTER | 2 | 1 | 1 | `/api/health` | 1 | 1 |

恢复能力字段为 `recoveryProtectionVersion`。三个交易 worker 的真实保护握手也必须支持版本 1，缺失或不兼容时不能仅凭能力声明就绪；Monitor 与 Asset 的持久材料纳入恢复集合，不因此声明资金写保护。

健康路径只描述现有读取入口，五模块均未声明统一 readiness。更新准入在三个交易模块进入维护后核对能力，再读取原有完整停机证据；身份、版本、字段或读取结果不符合当前契约时拒绝更新，仍等待所有并发检查结束后恢复维护状态。

登录工作台后，可读取以下管理员接口。它们只接受 GET，不接受查询参数，检查已有会话和来源，响应禁止缓存。

| 入口 | 行为 |
| --- | --- |
| `/api/system/architecture` | 通过私有 IPC 核对五模块能力；不可用时按模块返回 `unavailable`，不回退外部地址 |
| `/api/system/metrics` | 读取当前本地观测和最近最多 60 个分钟桶，不调用模块或交易所、不采集新样本 |
| `/api/system/accounts` | 读取共享保护库的账户域、模块归属、身份核验数量、操作状态数量和隔离原因；不返回 UID、连接名、原始意图、订单号或凭据 |
| `/api/system/recovery` | 读取共享核心的持久 `normal`、`quarantine` 或 `retired` 状态及恢复身份；不执行恢复、交易所对账或交易开闸 |

采样默认每分钟独立运行，无浏览器也会持续执行。记录存入 Hub 库的附加表 `platform_baseline_samples`，以分钟时间为主键，最多保留 28 天及 40,320 行，每条 JSON 不超过 16 KiB。重复启动或重复采样覆盖同一分钟，不增加时间分母；停机缺口保持缺失，时钟回拨到已记录分钟之前暂停写入并标记错误。

采样错误仅设置脱敏错误状态并记录结构化日志，保留已成功样本，不改变交易维护状态。关闭时取消计时器及在途能力读取，不在关闭后的数据库写入。程序回滚保留该附加表，旧程序忽略它，不恢复或删除业务库。

样本有效性通过生成列索引随 JSON 写入或修复一起更新，窗口聚合只扫描索引，避免每次指标读取重新解析全部历史。已有分钟表可重复补建该派生列与索引，无需丢弃观测记录。

## 指标口径和未覆盖项

| 字段 | 范围与口径 |
| --- | --- |
| `summaries.eligible` | 启用且有摘要接口的动态来源数；停用、纯链接和未配置接口排除，静态估值另列 |
| `fresh`、`stale`、`missing` | 使用真实 `updatedAt`，阈值取项目和来源 TTL 较短者；达到 TTL 即过期，缺失或明显未来时间计 missing |
| `unhealthy` | 单独反映来源状态和读取失败；保留的报价仍可能在其源时间有效期内，与传输健康分别观察 |
| `summaryReads` | 当前运行时基线实例实际摘要读取的成功、失败、累计与最大耗时；耗时使用单调时钟，非 P95 |
| `sse` | 运行时汇总近期 API 实例上报的首页连接数及慢消费者断开计数；没有近期连接数上报时跳过样本，不填零，不等同于浏览器推送延迟或全生命周期连接成功率 |
| `capabilities` | 采样时五个模块的实际能力核对结果，只有固定模块标签，无账户或订单维度 |
| `sampling.missingBuckets` | 保留窗口内从首个有效时间桶到当前分钟的未采样分钟数，不补零或补造健康记录 |
| `sampling.retainedBuckets`、`storedBuckets`、`invalidSamples` | 分别统计整个保留窗口的有效观测、已存记录和无效记录；坏 JSON、未知版本或缺少必要字段均不填补观测缺口 |

样本的 `instanceId` 属于运行时基线实例，`summaryReads` 在该实例内累计，重建基线后清零。慢消费者按各 API 的上报实例身份取差量，再归集到运行时基线；运行时重启后，API 的首次上报会把该 API 实例此前的累计次数计入新基线。只有同一基线实例内的差值可用于计算速率，API 上报身份不能当作样本身份。同分钟重启覆盖的是时间观测，不代表合并了两个进程的计数。历史样本只有源时间与接收时间观测，不承诺已有四周生产 SLO。

执行接受率、交易所确认率、完整未知订单统计、更新成功率和浏览器推送延迟尚未具备统一采样口径，接口通过 `coverage` 明确标记未覆盖。采样不调用会改变维护状态的 `updates.status()`，也不通过每腿只展示最后一单的原生执行投影推算全部未知订单。

## 真实写入口清单

以下为源码入口清单，不包含生产账户 UID 或凭据。工作台实际启动器将统一保护接入 Hub 和三个交易模块，保留各执行器已有的本地运行锁、维护门和恢复机制。

| 写入域 | 触发与最终写出位置 | 身份与现有保护 | 幂等及未知结果恢复 | M1 覆盖 |
| --- | --- | --- | --- | --- |
| Hub 原生订单 | 预览确认后的 jobs、停止与核对；[执行器](../server/trading-execution.mjs) → [交易所适配器](../server/trading-execution-exchanges.mjs)、[OKX 执行](../server/trading-okx-execution.mjs) | 会话、预览和账户 revision；全局租约、资源锁及真实 UID 注册 | 持久 request/job/order、确定性 clientId；未知请求查询原单，旧所有者晚回执拒绝覆盖 | 全账户准入、创建/改单/撤单的最终 HTTP 守卫及回执写入守卫 |
| CrossEx 订单 | [HTTP](../modules/crossex/server/app.mjs) 的 `/api/live/confirm`、`/api/live/cancel` → [live-runtime](../modules/crossex/server/live-runtime.mjs) → [live-client](../modules/crossex/server/live-client.mjs) | 连接代次、已确认的 Gate UID、本地 `live_owner` 与维护门；Gate 身份不自动等于所有底层交易所账户身份 | 本地请求和订单记录、客户端身份、恢复核对；保留不确定状态 | Gate CrossEx 账户域的准入、最终 HTTP 及状态写入守卫 |
| Greeks 限价及恢复 | [API](../modules/greeks/app/main.py) 的 `/api/trading/tasks`、停止；[engine](../modules/greeks/app/engine.py) 的调度、核对和失败腿恢复 → [bybit](../modules/greeks/app/bybit.py) | 模拟或实盘模式、执行锁、状态文件锁、维护门及 Bybit 当前用户 UID | 持久任务、orderLinkId 与成交核对；单腿失败和未决执行保留原身份 | 创建/改单/撤单及恢复；与 Hub 的同一 Bybit 主体互斥 |
| Greeks RFQ | 同一 API 的 `/api/rfq/create`、`/api/rfq/execute`、`/api/rfq/cancel` → engine → bybit | 原有模式、风控及 RFQ 未决保护 | RFQ link/id、报价和执行核对；不能将重复 execute 假设为交易所幂等 | 三类 RFQ 最终 HTTP 守卫，保留原 RFQ 恢复身份 |
| ASTER 订单与杠杆 | [engine](../modules/aster/trading/engine.py)、[配对执行](../modules/aster/trading/pair_execution.py)、[ADL](../modules/aster/trading/adl.py) 的账户、配对和后台动作 → [exchange](../modules/aster/trading/exchange.py) | 已认证的 user 钱包、配置代次、运行实例锁、预算和[维护控制](../modules/aster/trading/workspace_control.py) | 持久 intent、pending、post-fill 和 recovery watch；成交后验证源现场，未知不能清零 | 单账户与配对整体准入、后台线程、订单和杠杆最终 HTTP 及存储守卫 |
| ASTER 资金划转 | [margin_balance](../modules/aster/trading/margin_balance.py) 的配对保证金平衡与恢复 | 已验证子账户、签名身份、持久 pending 与发送前保护；与订单权限分别核对 | 保留原划转身份、历史及余额证据；未知写入不自动重试 | 同时取得涉及的账户，持久具体划转语义，最终 HTTP 与确认回执守卫 |

Monitor 没有交易所订单写入；其订阅、通知与本地配置写入另属数据采集和外部通知。Asset 的同步、导入、估值与配置会写本地账本，但不代表交易账户下单或划转。CrossEx 连接、预览与刷新，以及 Greeks 交易计划预览也不能算作已发送订单。

## M1 账户与持久保护

统一注册键为 `authority + environment + accountId` 的散列；API Key、签名者、模块显示名与本地账户名都不能构成新主体。父账户证据作为绑定元数据保存其散列，不替代当前子账户 UID；API Key 或签名者轮换仍受同一主体的模块归属约束。

| 实际适配器 | 身份证据 | 账户域 |
| --- | --- | --- |
| Hub Binance | 签名 USER_DATA `/api/v3/account` 的 `uid`；保留大整数精度 | `binance/mainnet` |
| Hub / Greeks Bybit | 私有 `/v5/user/query-api` 的当前 `userID`；Greeks 同时核验父子信息 | `bybit/mainnet`，Greeks 测试账户为 `bybit/testnet` |
| Hub OKX | 已有私有账户配置的 UID | `okx/mainnet` |
| CrossEx | Gate CrossEx 私有认证返回的 `user_id` | `gate-crossex/mainnet` |
| ASTER | 成功认证账户读取证明的 `user` 钱包，规范为小写地址 | `aster/mainnet` |

CrossEx 的 `BINANCE_`、`OKX_` 等交易场所前缀不提供底层原生账户 UID。因此 Gate CrossEx 主体不伪装成同名原生账户；本批不声称已经证明 Gate 与某个 Binance/OKX 原生账户相同。未知身份、缺少凭据的旧未决库存或损坏状态保留对应账户域的未知绑定，保持只读并阻止该域其他模块取得新的写许可。

保护由 [Node 核心](../server/execution/account-writer.mjs) 和 [Python 核心](../server/execution/account_writer.py) 共用 `DATA_DIR/execution-control.sqlite`。SQLite 使用 WAL、短事务和最多 750 ms 的争用等待；首次创建原子发布 `.required` 标记。数据库或标记缺失、身份变更、替换或不可信路径均拒绝继续写入，不自动创建空库绕过旧 fence。保留数据库、WAL 和标记，不将删除注册库当成解锁手段。

账户归属固定到模块；租约过期不会允许别的模块接管。同模块仅在旧进程已退出或已完成关闭后接管，fence 单调增加。租约 60 s，5 s 心跳，最终请求保留请求预算和 10 s 余量；时间倒退或真正失去所有权会终止旧写者的写入资格。单个账户隔离不续约该账户，也不拖垮同实例中无关账户。

任务第一腿前一次取得完整账户集合。每次副作用先持久化具体语义的操作 ID 和内容散列，再在实际 HTTP 出站及状态提交处检查原 ticket、绑定代次、fence 和未决状态。同一父任务的已准备多腿可并发；任何 UNKNOWN 阻止新风险操作。UNKNOWN amend 仅允许在核对原单后撤销同一账户、同一标的和同一原订单，不能因此换号建单；终态核对才解除 amend 的未知记录。

已确认、明确未发送和明确拒绝的私有回执先于共享操作结算落盘，恢复按原操作身份衔接两套存储。请求超时和失联保留 UNKNOWN，查询未找到不等于未发送；旧实例晚回执不能覆盖新写者状态。旧版本未决操作迁入核对，发现同一主体已有跨模块旧交易则持久隔离，不自动挑选胜者。只读查询和本地停止仍可使用，资金撤单仍须合法所有权。

实际监督器覆盖模块 `.env` 中的保护上下文，Python 核心路径固定在本发布的 `server/execution/`；模块不能改指向另一个空库。三个交易 worker 仅在确认实际执行器支持协议 1 后就绪；Python 通过已认证 stdio 私有状态完成握手，身份核验失败的只读状态仍可就绪。能力协议与真实执行器不一致时启动失败。`metrics.coverage.crossModuleAccountProtection` 仅表示工作台已接入此保护，不表示完成实盘、全账户健康或四周生产验收。

回滚保留业务库、操作身份和整个保护库，使用仍具协议 1 的健康版本。首次 M1 若需回退到不具该保护的旧程序，须保持交易模块维护/只读，完成原操作核对后再修复升级；不能恢复旧自动交易或重置 fence。程序回滚不能撤销已发生的成交或划转。本批没有执行服务器部署或真实资金请求；非 WSL Linux 权限、打包与生命周期行为由既有 CI 验证。

## M2 冷备份与恢复保护

工作台启动前取得数据根 OS 生命周期锁，关闭全部组件后释放。正式操作入口先串行更新锁、冷停完整服务 cgroup，再排他持有运行时与 API 两把生命周期锁处理各库、JSON 和密钥；SQLite 备份 API 吸收 WAL，清单记录库结构和水位。`data` 与 `secrets` 分别加密，完整内容、路径依赖和操作步骤见 [备份与恢复](backup-recovery.md)。

恢复只发布到新的隔离目标，校验密钥可解密性、完整性和 schema，撤销旧会话与预览，产生新 authority/epoch，并增加 fence 与绑定代次。共享 Node/Python 核心持久保留 `quarantine`，UNKNOWN、账户归属与隔离不清除。原源仍在且完整静止时生成的 sealed handoff 才能一次性准入唯一目标；源永久退休，历史备份或失去原源的副本不能手工解锁。`admit` 不切换生产数据目录，也不执行服务器部署。

版本目录外的 systemd guard 保留恢复保护，拒绝未完成恢复和不能实施协议的旧版回滚。M2 接入后，兼容回滚必须同时支持账户与恢复保护协议 1，不能仅凭 M1 账户协议继续运行。现有 CI 已接入本地包及密钥到真实五模块可读服务的隔离网络演练，验收结果以对应提交的 Checks 为准；该范围不包含生产数据量、异地材料取回或实盘对账。RPO 5 分钟、RTO 30 分钟仍为目标，不能据夹具耗时声明生产 SLA。

## 当前批次状态与剩余工作

M2a/M2b、E1、M5a/b/c、M7a/b 是上位文档 v1.1 对原批次的细分。下表记录源码接入与待验收项；“已接入”不是生产恢复、容量或实盘承诺。

| 批次 | 状态 | 下一项可核验交付 |
| --- | --- | --- |
| M0 基础接入 | 已交付基础能力 | 用户升级后持续采样；补足尚未覆盖 SLI，积累四周生产基线 |
| M1a 账户身份与准入 | 已接入实现 | 真实主体、环境和父子证据；冲突或身份缺失拒绝资金写入 |
| M1b 租约与核对 | 已接入实现 | 全账户首腿前准入、fence、晚回执隔离和持久原操作恢复；审查与发布检查按本批证据收口 |
| M2a 恢复安全基础 | 原 M2 的冷备份、隔离和交接已接入 | 既有 Linux CI 演练有明确范围；后续激活仍须按目标版本验证兼容程序回滚与失败路径，不由源码存在推断通过 |
| M2b 生产恢复 | 尚未闭环 | 周期与异地备份、保留与密钥取回、生产规模 RPO/RTO、原源丢失后的对账和交易恢复；缺证保持隔离 |
| M3 生命周期 | P0/P1/P2/P2b 已实现并发布 | 真实包在 systemd 双单元下的更新/失败回退及五模块故障组合；生产 CI 包 API-only 更新核对范围、维护、PID、采集和租约连续 |
| M4-1 共享登录风控 | `462e43a` 已合入，Checks 已通过 | 共享表与崩溃预占已接入；发布身份单独核对，真实双槽登录/撤销验收留到 M4 激活 |
| M4 其余批次 | 尚未实施 | 持久 Portal、排空与静态资源、候选隔离、固定槽版本及可控切流；双槽草案先按上位第 11 节修订 |
| E1 事务事件基础 | 尚未接入统一交付 | 登记所需数据域与消费者，完成原子事件、幂等消费、检查点与失败恢复；现有局部 SSE 序号不计作持久水位 |
| M5a/b/c 共享数据 | 尚未完成对应交付 | 机会契约解耦、行情采集去重、按需持久重放分别验收；当前 CrossEx 仍依赖 Monitor，概览仍以全量快照重连 |
| M6 主库切换 | 尚未实施，按需进入 | 用写等待与实际需求决策；迁移域事件完整性、影子复制、水位及恢复演练完成后才切单写源 |
| M7a/b 多实例 | 尚未实施 | 同机 API 先验证容量收益与共享控制状态；跨主机另验共享账户保护和旧写者出站隔离，不能以主库迁移代替 |

M3 的 Linux 受管部署由 `server/runtime/main.mjs` 与 `server/api/main.mjs` 两个单元入口承载；手动 POSIX 入口 `server/index.mjs` 通过启动器组合两进程。Windows 的该入口保留 `server/workbench.mjs` 单进程兼容形态，`pnpm dev:server` 也使用兼容入口；其通过不代替 Linux 双单元验收。相关失败场景见 `tests/embedded-runtime.test.mjs`、`tests/process-split.test.mjs` 与 `tests/entry-symlink.test.mjs`，正式包入口见 `scripts/verify-embedded.mjs`；测试存在不代表本轮重新运行。

本文件不推进历史提交复盘检查点。后续批次按源码与真实验证结果更新状态，不把已新增接口或测试夹具等同于完成生产容量、恢复或执行验收。
