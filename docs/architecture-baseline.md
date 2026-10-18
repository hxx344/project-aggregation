# 架构实施基线与批次进度

本文件记录 [架构实现方案](architecture-implementation.md) 的实际接入边界。2026-10-19 首批建立 M0 的能力协商、持续采样和写入口清单；四周生产样本仍需用户升级后积累，跨模块账户保护属于下一阶段 M1。

## 已接入的基线

五个内置模块在经过 worker 私有密钥认证后响应 `GET /__workspace/capabilities`。它不进入模块页面处理器，不追加旧摘要字段，页面代理继续拒绝原始或编码的内部路径。能力读取限 16 KiB、总时限 5 s、无自动重试、无跨实例缓存。

| 模块 | 摘要版本 | 维护协议 | 更新检查协议 | 现有健康路径 | 统一账户写入协议 |
| --- | --- | --- | --- | --- | --- |
| Monitor | 1、2 | 无 | 无 | `/healthz` | 未接入 |
| Asset | 2 | 无 | 无 | `/api/health` | 未接入 |
| CrossEx | 1、2 | 1 | 1 | `/api/health` | 未接入 |
| Greeks | 2 | 1 | 1 | `/api/health` | 未接入 |
| ASTER | 2 | 1 | 1 | `/api/health` | 未接入 |

健康路径只描述现有读取入口，五模块均未声明统一 readiness。更新准入在三个交易模块进入维护后核对能力，再读取原有完整停机证据；身份、版本、字段或读取结果不符合当前契约时拒绝更新，仍等待所有并发检查结束后恢复维护状态。

登录工作台后，可读取以下管理员接口。它们只接受 GET，不接受查询参数，检查已有会话和来源，响应禁止缓存。

| 入口 | 行为 |
| --- | --- |
| `/api/system/architecture` | 通过私有 IPC 核对五模块能力；不可用时按模块返回 `unavailable`，不回退外部地址 |
| `/api/system/metrics` | 读取当前本地观测和最近最多 60 个分钟桶，不调用模块或交易所、不采集新样本 |

采样默认每分钟独立运行，无浏览器也会持续执行。记录存入 Hub 库的附加表 `platform_baseline_samples`，以分钟时间为主键，最多保留 28 天及 40,320 行，每条 JSON 不超过 16 KiB。重复启动或重复采样覆盖同一分钟，不增加时间分母；停机缺口保持缺失，时钟回拨到已记录分钟之前暂停写入并标记错误。

采样错误仅设置脱敏错误状态并记录结构化日志，保留已成功样本，不改变交易维护状态。关闭时取消计时器及在途能力读取，不在关闭后的数据库写入。程序回滚保留该附加表，旧程序忽略它，不恢复或删除业务库。

样本有效性通过生成列索引随 JSON 写入或修复一起更新，窗口聚合只扫描索引，避免每次指标读取重新解析全部历史。已有分钟表可重复补建该派生列与索引，无需丢弃观测记录。

## 指标口径和未覆盖项

| 字段 | 范围与口径 |
| --- | --- |
| `summaries.eligible` | 启用且有摘要接口的动态来源数；停用、纯链接和未配置接口排除，静态估值另列 |
| `fresh`、`stale`、`missing` | 使用真实 `updatedAt`，阈值取项目和来源 TTL 较短者；达到 TTL 即过期，缺失或明显未来时间计 missing |
| `unhealthy` | 单独反映来源状态和读取失败；保留的报价仍可能在其源时间有效期内，与传输健康分别观察 |
| `summaryReads` | 当前 API 实例实际摘要读取的成功、失败、累计与最大耗时；耗时使用单调时钟，非 P95 |
| `sse` | 当前首页连接数及本实例因写缓冲超限断开的次数，不等同于浏览器端推送延迟或全生命周期连接成功率 |
| `capabilities` | 采样时五个模块的实际能力核对结果，只有固定模块标签，无账户或订单维度 |
| `sampling.missingBuckets` | 保留窗口内从首个有效时间桶到当前分钟的未采样分钟数，不补零或补造健康记录 |
| `sampling.retainedBuckets`、`storedBuckets`、`invalidSamples` | 分别统计整个保留窗口的有效观测、已存记录和无效记录；坏 JSON、未知版本或缺少必要字段均不填补观测缺口 |

`summaryReads` 和慢消费者计数均按 `instanceId` 区分，重启后从零开始；只有同一实例内的差值可用于计算速率。同分钟重启覆盖的是时间观测，不代表合并了两个进程的计数。历史样本只有源时间与接收时间观测，不承诺已有四周生产 SLO。

执行接受率、交易所确认率、完整未知订单统计、更新成功率和浏览器推送延迟尚未具备统一采样口径，接口通过 `coverage` 明确标记未覆盖。采样不调用会改变维护状态的 `updates.status()`，也不通过每腿只展示最后一单的原生执行投影推算全部未知订单。

## 真实写入口清单

以下为源码入口清单，不包含生产账户 UID 或凭据。当前保护均局限于相应执行器，五模块能力不会把本地锁声明为跨模块账户锁。

| 写入域 | 触发与最终写出位置 | 身份与现有保护 | 幂等及未知结果恢复 | M1 覆盖 |
| --- | --- | --- | --- | --- |
| Hub 原生订单 | 预览确认后的 jobs、停止与核对；[执行器](../server/trading-execution.mjs) → [交易所适配器](../server/trading-execution-exchanges.mjs)、[OKX 执行](../server/trading-okx-execution.mjs) | 会话、预览和账户 revision；60 s 全局租约、资源锁及发送前检查。账户表按 exchange 主键；部分连接没有可靠外部 UID | 持久 request/job/order、确定性 clientId；未知请求查询原单，旧所有者晚回执拒绝覆盖 | 尚无跨模块账户注册 |
| CrossEx 订单 | [HTTP](../modules/crossex/server/app.mjs) 的 `/api/live/confirm`、`/api/live/cancel` → [live-runtime](../modules/crossex/server/live-runtime.mjs) → [live-client](../modules/crossex/server/live-client.mjs) | 连接代次、已确认的 Gate UID、本地 `live_owner` 与维护门；Gate 身份不自动等于所有底层交易所账户身份 | 本地请求和订单记录、客户端身份、恢复核对；保留不确定状态 | 未接入共享写入准入 |
| Greeks 限价及恢复 | [API](../modules/greeks/app/main.py) 的 `/api/trading/tasks`、停止；[engine](../modules/greeks/app/engine.py) 的调度、核对和失败腿恢复 → [bybit](../modules/greeks/app/bybit.py) | 模拟或实盘模式、执行锁、状态文件锁、维护门；缺少统一账户 UID 注册 | 持久任务、orderLinkId 与成交核对；单腿失败和未决执行保留原身份 | 未接入共享写入准入 |
| Greeks RFQ | 同一 API 的 `/api/rfq/create`、`/api/rfq/execute`、`/api/rfq/cancel` → engine → bybit | 原有模式、风控及 RFQ 未决保护 | RFQ link/id、报价和执行核对；不能将重复 execute 假设为交易所幂等 | 未接入共享写入准入 |
| ASTER 订单与杠杆 | [engine](../modules/aster/trading/engine.py)、[cycle](../modules/aster/trading/cycle.py)、[ADL](../modules/aster/trading/adl.py) 的账户、配对和后台动作 → [exchange](../modules/aster/trading/exchange.py) | 原有账户身份、配置代次、运行实例锁、预算和[维护控制](../modules/aster/trading/workspace_control.py) | 持久 intent、pending、post-fill 和 recovery watch；成交后验证源现场，未知不能清零 | 未接入共享写入准入 |
| ASTER 资金划转 | [margin_balance](../modules/aster/trading/margin_balance.py) 的配对保证金平衡与恢复 | 已验证子账户、签名身份、持久 pending 与发送前保护；与订单权限分别核对 | 保留原划转身份、历史及余额证据；未知写入不自动重试 | 未接入共享写入准入 |

Monitor 没有交易所订单写入；其订阅、通知与本地配置写入另属数据采集和外部通知。Asset 的同步、导入、估值与配置会写本地账本，但不代表交易账户下单或划转。CrossEx 连接、预览与刷新，以及 Greeks 交易计划预览也不能算作已发送订单。

M1 需要将 HTTP 与后台写入路径一并接入最终发送前边界，识别生产或测试环境、外部账户 UID、子账户和写入模块。同一账户的 API Key 轮换不得产生新身份；缺失可靠身份时不能启用共享写入或自动接管。

## 后续批次

| 批次 | 状态 | 下一项可核验交付 |
| --- | --- | --- |
| M0 基础接入 | 本批实现 | 发布包验证和用户升级后持续采样；补足尚未覆盖 SLI，积累四周生产基线 |
| M1a 账户身份与准入 | 待实施，最高优先级 | 按上述清单提供可信账户身份与所有写入入口，拒绝跨模块同账户冲突 |
| M1b 租约与核对 | 依赖 M1a | 多账户整体取得、fence、旧实例隔离、持久原单恢复 |
| M2 备份与恢复 | 可在 M0 基础上并行 | 一致性备份、隔离恢复、密钥恢复及非 WSL Linux 演练 |
| M3 至 M7 | 保持原依赖 | 依次推进生命周期、双槽、共享数据、主库切换和多实例；不跳过执行保护或恢复证据 |

本文件不推进历史提交复盘检查点。后续批次按源码与真实验证结果更新状态，不把已新增接口或测试夹具等同于完成生产容量、恢复或执行验收。
