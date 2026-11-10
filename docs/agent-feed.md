# Agent 数据接口

给其它 agent 或脚本读取工作台非私密数据的只读接口。令牌在侧栏 **系统 → Agent 数据接口** 创建与撤销。

本文同时是给 agent 的使用说明：把「怎么读」一节和令牌交给 agent 即可。

## 怎么读

```bash
# 1. 有哪些数据集、每个指标的单位
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3100/api/agent/v1/catalog
# 2. 当前值；datasets 省略时返回令牌可读的全部数据集
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3100/api/agent/v1/snapshot?datasets=system.host,market.monitor"
```

- 只有 `GET`。令牌只放在 `Authorization: Bearer` 头里，不接受放在地址参数中。
- 与工作台同机的 agent 用 `http://127.0.0.1:3100`（端口以部署为准）；其它机器用工作台配置的访问地址。
- 先读一次 `catalog`，之后轮询 `snapshot`。快照每 5 秒最多生成一次并由所有令牌共用，轮询间隔短于 5 秒拿到的是同一份数据；按各数据集的 `refreshSeconds` 安排间隔即可。
- 每个令牌每分钟最多 120 次请求，超出返回 `429` 与 `Retry-After`。

### 快照格式

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-10T00:00:05.000Z",
  "datasets": [{
    "id": "system.host", "scope": "system", "status": "ok", "message": null,
    "asOf": "2026-11-10T00:00:03.000Z", "staleRows": 0,
    "rows": [{ "entity": "host", "metric": "cpu_usage", "label": null, "value": 12.5, "unit": "%",
               "asOf": "2026-11-10T00:00:03.000Z", "stale": false, "status": "ok" }]
  }]
}
```

每行是一个对象的一个指标：

| 字段 | 含义 |
| --- | --- |
| `entity` | 数据所属对象，例如 `host`、`module:monitor`、`pool:base:0x…` |
| `metric` | 指标标识，同一数据集内含义固定 |
| `label` | 人读名称，可能为 `null` |
| `value` | 数值、文本或布尔值；**读不到时为 `null`，不代表 0** |
| `unit` | 单位，无单位时为 `null` |
| `asOf` | 来源采到该值的时间（UTC），不是接口应答时间 |
| `stale` | `true` 表示该值已超过有效期或来源自报过期，不应当作当前值 |
| `status` | `ok` / `warn` / `alert` / `unknown`；`unknown` 表示没有值 |

判断数据是否可用时按这个顺序看：

1. 数据集 `status` 为 `unavailable`：整个数据集读不到，`rows` 为空，原因在 `message`。这不等于「没有异常」。
2. 行的 `stale` 为 `true`：值是旧的。`stale` 在每次应答时按当时时间判定，所以同一行可以从 `false` 变成 `true` 而 `asOf` 不变。
3. 行的 `value` 为 `null`：这一项没有值。
4. `status` 是工作台按固定阈值给出的提示（例如磁盘占用 85% 为 `warn`、95% 为 `alert`），需要别的阈值时直接用 `value` 判断。

### 错误

| 状态 | 含义 |
| --- | --- |
| `400` | 参数无效：未知数据集、重复、空，或带了接口不认识的参数 |
| `401` | 没有令牌、令牌格式不对或已撤销 |
| `403` | 令牌的数据范围不含所请求的数据集 |
| `404` / `405` | 路径不存在 / 不是 `GET` |
| `429` | 超过每分钟请求数 |
| `503` | 工作台正在切换版本，稍后重试 |

## 数据集

| 数据集 | 范围 | 来源更新间隔 | 内容 |
| --- | --- | --- | --- |
| `system.host` | `system` | 5 秒 | CPU 占用与负载、内存、交换分区、磁盘占用与剩余、运行时间 |
| `system.runtime` | `system` | 5 秒 | 数据面是否就绪；各内嵌模块进程的状态、重启次数、连续失败次数 |
| `system.projects` | `system` | 30 秒 | 工作台读取各模块摘要的状态、延迟、诊断条数、上次成功时间 |
| `system.event-loop` | `system` | 5 秒 | 数据面事件循环最近 1 分钟与 5 分钟的最大延迟和卡顿次数 |
| `market.monitor` | `public` | 30 秒 | Monitor 的摘要指标：原油价格与价差、海力士溢价与资金费率、Anthropic 各所溢价等，取决于 Monitor 当前配置的监控 |
| `market.aero` | `public` | 随扫描间隔 | AERO 价格，以及 TVL 最高的 40 个池子的 TVL、手续费率、每日排放、1 天波动率 |

`system.host` 与 `system.runtime` 由控制面直接读取，数据面不可用时仍然返回；此时 `system.runtime` 的 `ready` 为 `false`，其余四个数据集为 `unavailable`。

各指标的单位以 `catalog` 为准。`market.monitor` 的指标由 Monitor 自己命名，`catalog` 不列出，每行自带 `label` 与 `unit`。

### 不提供的数据

接口只读取工作台内存里已有的值，生成快照不会向交易所、链上节点或模块发起请求。以下内容不在接口内，现有令牌无法读到：

- 账户、持仓、余额、盈亏、订单、划转与任何执行状态
- 凭据、Webhook、RPC 地址、访问地址、主机名与路径
- Asset、Cross-Exchange、Greeks、ASTER 的摘要指标（都是账户数字）和各模块的诊断原文
- Aero 收藏、筛选条件与 Safe 钱包信息
- 交易所盘口报价、研究工具的采集数据、更新状态

每个数据集在代码里逐字段取值（`server/agent-feed/runtime-feed.mjs`、`server/agent-feed/feed.mjs`），应答前再按行格式逐字段复制一遍（`server/agent-feed/catalog.mjs` 的 `cleanDataset`），来源对象新增字段不会自动出现在接口里。

## 令牌

- 最多 8 个。每个令牌有名称和数据范围：`public`（行情）与 `system`（工作台运行状态），可同时选。
- 令牌只在创建时显示一次。工作台只保存它的 SHA-256 摘要（控制面 `settings` 表的 `agent-feed-tokens`），列表、接口和日志都不回显令牌。
- 撤销立即生效。令牌泄露时直接撤销并新建，没有「修改范围」操作。
- 令牌不是登录：只能读 `/api/agent/v1/` 下的数据，不能访问工作台其它接口；反过来，浏览器登录的会话也不能读这两个接口。
- 管理令牌需要登录工作台。创建与撤销会写入日志（令牌标识与范围）。
- 「最近使用」只记在当前 API 进程的内存里，重启或更新后从空开始。
- 从备份恢复后，令牌列表回到备份时的状态：备份之后撤销的令牌会重新生效，恢复后请到页面检查并撤销不再需要的令牌。
- 接口不限制来源地址，访问控制只靠令牌、数据范围与频率限制。

## 取舍与后续

本期（第一期）只做目录与快照。以下未做：

- 增量读取（只返回变化的行）与推送
- 历史：接口只返回当前值，需要趋势时由读取方自己保存
- `portfolio` 范围（账户与持仓数据）
- 交易所盘口报价：读取会触发对交易所的请求，需要先决定由谁承担请求频率
- MCP 封装

## 回滚

回退到上一个版本即可。`settings` 里的 `agent-feed-tokens` 记录会被旧版本忽略，无需清理；再次升级后原有令牌继续有效。数据面与控制面版本不一致时（控制面新、数据面旧），数据面来源的四个数据集显示为「数据面当前版本不提供该数据集」，其余功能不受影响。
