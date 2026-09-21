# 接入协议 v1

新项目可以只提供网页入口，也可以通过统一摘要接口加入工作台。所有数据请求由工作台后端发起，不需要为浏览器开放跨域接口。

## 项目设置

| 字段 | 说明 |
| --- | --- |
| `name` / `description` | 显示名称和简要说明。 |
| `category` | `trading`、`monitoring`、`assets` 或 `other`。 |
| `adapter` | 内置 `aster`、`monitor`、`asset`；通用 `standard`；仅入口 `link`。 |
| `url` | 浏览器视角的完整 HTTP(S) 页面地址，可以保留查询参数。 |
| `apiUrl` | 工作台服务器视角的 HTTP(S) 服务地址，不能含查询参数、锚点或 URL 内的用户名密码。 |
| `authOrigin` | 可选的原项目登录来源地址，仅接受 HTTP(S) 来源（协议、主机和可选端口，不含路径、查询参数或凭据）；ASTER / Asset 配置了外部 `PUBLIC_ORIGIN` 时填写相同来源，例如 `https://asset.example.com`。留空使用接口服务来源。 |
| `mode` | `external` 打开原页面，`embed` 尝试嵌入原页面。 |
| `enabled` | 是否参与后台刷新和常规展示。 |
| `staleAfterSeconds` | 30–86400；按数据源 `updatedAt` 判断过期。 |
| `order` | 排序值，整数，范围 -10000 到 10000。 |
| `username` / `password` | 可选原项目凭据，密码仅用于提交，不在读取配置时返回。 |

只有登录后的工作台管理员可以查看摘要、管理项目和发起检查。首版是一位管理员的个人工作台，没有多租户或细分角色。工作台的上游 HTTP 请求允许本机和私网服务，禁止云元数据、链路本地及不可路由地址，不跟随重定向。将最终服务地址直接填入配置。

修改接口地址、适配器或登录来源地址会清理旧凭据及缓存，避免将旧凭据发给新目标；需要重新输入新目标密码。删除项目只删除工作台配置和缓存，不删除原系统的数据。

## 摘要接口

```http
GET /api/hub/summary
Accept: application/json
```

如果项目设置里保存了密码，`standard` 适配器使用 HTTP Basic：`Authorization: Basic base64(username:password)`。没有密码时不发送认证头。响应必须为 2xx JSON，最大 1 MiB；请求总时限默认 5 秒。

下面仅为协议示例，不是实际资产或行情。应用必须使用自己的值及真实数据更新时间。

```json
{
  "schemaVersion": 1,
  "data": {
    "updatedAt": "2026-09-21T12:00:00.000Z",
    "metrics": [
      {
        "key": "balance",
        "label": "账户余额",
        "value": 1250.5,
        "unit": "USD",
        "detail": "已结算余额；不包含未实现盈亏"
      },
      {
        "key": "pending",
        "label": "待处理任务",
        "value": null,
        "unit": "个",
        "detail": "来源暂未提供"
      }
    ],
    "trend": [
      { "at": "2026-09-20T00:00:00.000Z", "value": 1200 },
      { "at": "2026-09-21T00:00:00.000Z", "value": 1250.5 }
    ]
  }
}
```

- 顶层只接受 `schemaVersion`、`data`；`data` 只接受 `updatedAt`、`metrics`、可选的 `trend`，未知字段会被拒绝。
- `updatedAt` 是 ISO 8601 的数据源时间，不能用当前请求时间掩盖旧快照；不能比工作台时钟超前 60 秒。全部指标应属于该时间点，聚合多源时使用最早有效时间。
- `metrics` 最多 24 个。`key` 唯一，只允许英文字母、数字、下划线和短横线，长度 1–64；`label` 长度 1–80。
- `value` 接受有限数值、最长 160 字符的字符串或 `null`。缺失数据使用 `null`，不要使用 0 代替。数值不要携带千分位或币种字符，单位写在 `unit`。
- `unit` 可选，最长 24 字符；`detail` 可选，最长 240 字符。写清币种、统计周期和采样口径；百分比的值 `2.5` 表示 `2.5%`，不要交叉使用 0.025。
- `trend` 可选，最多 366 个点；每点仅包含 ISO 8601 `at` 和有限数值 `value`。提供同一指标、同一单位和清楚的采样周期；接入器按时间排序。无观测时不要伪造零点或插值。

标准项目的数据留在该项目下，不会自动加进首页的资产总额。通用趋势会被保留在摘要中；当前首页资产曲线固定读取 Asset Ledger，其他项目专用图表可以按需扩展。

## 已有项目适配

| 适配器 | 请求 | 认证 |
| --- | --- | --- |
| `aster` | `GET /api/state?compact=true` | 配置密码时先 `POST /api/login`，返回的 `aster_session` 仅在服务器内存缓存，最长 11 小时；认证失效后重新登录。 |
| `asset` | `GET /api/ledger` | 配置密码时先 `POST /api/login`，返回的 `asset_session` 仅在服务器内存缓存，最长 11 小时；认证失效后重新登录。 |
| `monitor` | `GET /api/monitors` 与选定模块的 `/api/monitors/{id}/quote` | 可选 HTTP Basic。 |
| `standard` | `GET /api/hub/summary` | 可选 HTTP Basic。 |
| `link` | 不发上游请求 | 浏览器打开原页面，由原页面自己登录。 |

monitor 首版支持 `oil`、`hynix`、`perpetual` 摘要。优先使用页面 URL 中 `monitor` 参数指定的模块，其次使用 `oil`，否则读取第一个模块；未知模块提示需要新适配器或标准接口。资金费率年化按上游小数值乘以 100 展示为百分比。永续模块更新时间使用启用交易所最早消息时间，并保留交易所过期状态。

扩展适配器时先读取原接口的真实字段，明确单位和时间，再添加转换逻辑及失败、认证、过期和缺失数据测试。不要从上游透传密码、API Key、订单操作或不受控的 HTML。

## 资产新鲜度补充

资产适配器使用原账本的 `mode` 分类：`manual` 为手工估值，`market`、`bybit`、`aster` 为动态数据。混合账本的 `updatedAt` 取所有非 `manual` 行最早更新时间，并通过 `manual_valuation_at` 指标单独保留手工行最早估值时间。缺少或未知 `mode` 按动态行处理并提示数据不完整，避免误判为不会过期。

仅全部行都明确为 `manual` 时，快照带有 `freshness: "static"`，更新时间为最早估值记录时间；按静态账本展示，不套用实时刷新阈值。该标记是内置资产适配器返回的快照属性，不是标准摘要协议可提交的字段。上游错误、数据缺失或汇率问题仍会单独提示。
