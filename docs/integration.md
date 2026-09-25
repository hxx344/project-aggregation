# 接入协议 v1

新项目可以只提供网页入口，也可以通过统一摘要接口加入工作台。摘要读取和 Asset 后台同步由工作台后端发起，不需要为浏览器开放跨域接口。原页面可选择经工作台代理或直接访问；支持的适配器保存凭据后可由工作台自动登录，原项目仍负责验证会话与操作权限。

## 项目设置

| 字段 | 说明 |
| --- | --- |
| `name` / `description` | 显示名称和简要说明。 |
| `category` | `trading`、`monitoring`、`assets` 或 `other`。 |
| `adapter` | 内置 `aster`、`monitor`、`asset`；通用 `standard`；仅入口 `link`。 |
| `url` | 完整 HTTP(S) 页面地址。`direct` 时浏览器直接打开；`proxy` 时仅提供入口路径和查询参数，不决定上游连接目标。 |
| `apiUrl` | 工作台服务器视角的 HTTP(S) 服务地址，也是 `proxy` 唯一的连接目标；不能含查询参数、锚点或 URL 内的用户名密码。`link` 使用 `proxy` 时也必须填写。 |
| `authOrigin` | 可选的原项目登录来源地址，仅接受 HTTP(S) 来源（协议、主机和可选端口，不含路径、查询参数或凭据）；ASTER 的 `ASTER_PUBLIC_ORIGIN` 或 Asset 的 `PUBLIC_ORIGIN` 配置了外部来源时填写相同来源，例如 `https://asset.example.com`。留空使用接口服务来源。 |
| `accessMode` | `proxy` 经工作台访问完整页面，`direct` 直接打开 `url`。内置 `aster`、`monitor`、`asset` 默认 `proxy`，`standard`、`link` 默认 `direct`；可手动切换，旧配置缺少字段时采用同样默认值。 |
| `mode` | `direct` 连接时，`external` 提供新窗口入口，`embed` 在进入项目时自动嵌入；`proxy` 连接统一直接显示原始页面，不受旧 `mode` 值影响。 |
| `autoSync` | 布尔值，仅 Asset 使用：启用后每 60 秒触发原项目资产同步。Asset 默认 `true`，其他适配器默认 `false`；旧记录缺少字段时采用同样默认值。 |
| `enabled` | 是否参与后台读取、Asset 同步和常规展示；停用项目也不能获得新的页面代理授权。 |
| `staleAfterSeconds` | 30–86400；按数据源 `updatedAt` 判断过期。 |
| `order` | 排序值，整数，范围 -10000 到 10000。 |
| `username` / `password` | 可选原项目凭据，用于后台读取、Asset 同步及支持适配器的 `proxy` 自动登录；密码仅用于提交，不在读取配置时返回。 |

只有登录后的工作台管理员可以查看摘要、管理项目和发起检查。首版是一位管理员的个人工作台，没有多租户或细分角色。工作台的上游 HTTP 请求允许本机和私网服务，禁止云元数据、链路本地及不可路由地址。摘要请求不跟随重定向，应填写最终接口地址；原页面代理保留页面跳转行为，但不会携带凭据在服务器端自动跟随任意目标。

修改接口地址、适配器或登录来源地址会清理旧凭据及缓存，避免将旧凭据发给新目标；需要重新输入新目标密码。项目配置修改会撤销已有页面代理授权。删除项目只删除工作台配置和缓存，不删除原系统的数据。

内置 ASTER 的正确同机接口地址是 `http://127.0.0.1:8765`，Asset 为 `http://127.0.0.1:5678`，monitor 为 `http://127.0.0.1:3000`。旧 ASTER 配置中的错误 `18765` 不会自动修改；管理员需改为 `8765` 并重填密码，工作台不会将旧目标凭据迁移给新目标。

Gate CrossEx 是第四个预置入口：`id=crossex`、`category=trading`、`adapter=standard`，页面与接口地址均为 `http://127.0.0.1:3200`，显式使用 `accessMode=proxy`、`autoSync=false`、`staleAfterSeconds=120`、`order=3`。其 HTTP Basic 用户名为 `admin`；填写 CrossEx 服务日志中的独立网页登录密码即可复用标准摘要与代理自动登录。普通新建 `standard` 项目的默认访问方式仍为 `direct`。

旧数据库通过独立 `seeded-crossex-v1` 标记在事务内一次性 `INSERT OR IGNORE` 补充入口，不改写同标识的已有项目、凭据或快照，也不恢复已删除的旧预置。删除 CrossEx 后重启不再添加；升级时已满 30 个项目会记录迁移完成并跳过添加，之后可腾出名额手动接入。

CrossEx 第一版仅模拟同币种跨交易所永续价差套利。Monitor 作为发现数据源，在 CrossEx 页面配置来源地址和来源凭据；这些凭据与工作台保存的 CrossEx 登录凭据独立。模拟余额、收益及趋势只属于该标准项目，不进入 Asset Ledger 资产总额与曲线。

## Variational Grid 预置接入

第五个预置为 `id=variational`、`name=Variational Grid`、`adapter=standard`、`category=trading`、`accessMode=proxy`、`autoSync=false`、`order=4`，页面和接口使用 `http://127.0.0.1:9876`，工作台阈值 120 秒。独立 `seeded-variational-v1` 迁移遵循同样的一次性添加、同标识保留及 30 项上限规则。

该模块只监听 loopback，不提供独立 Basic 登录；项目凭据留空。代理沿用工作台会话及一次性页面授权，原模块继续检查 localhost Host、同源 Origin 和写操作 token。`vr-token` 仅供原模拟引擎访问行情，不是工作台登录凭据。

`/api/hub/summary` 和 `?schemaVersion=2` 都返回 v2；仅查询共同采样库的 runtime 和末条 summary，不读取历史或各组仓位库，不调用交易所。CL/BZ、库存组合及压缩/旧格式 QQQ 采样均受支持。显示独立组的本轮模拟盈亏 USDC，不相加；无效数值为 null。来源时间取采样时间；QQQ 还受行情源及已持有 US100 仓位估值时间限制。过期阈值沿用模块 `max(60, poll_seconds * 3)`，工作台采用与本地设置较短者。无样本或重置中使用 null 时间；暂停/降级为 partial，停止为 offline，过期为 stale，合成行情标明演示。

三种页面均支持 `activity`；只接受精确宿主来源与父窗口的握手，隐藏、离线时暂停 GET，重新激活时补查，不影响后台模拟或自动重试写请求。

## 摘要接口

```http
GET /api/hub/summary?schemaVersion=2
Accept: application/json
```

如果项目设置里保存了密码，`standard` 适配器使用 HTTP Basic：`Authorization: Basic base64(username:password)`。没有密码时不发送认证头。响应必须为 2xx JSON，最大 1 MiB；请求总时限默认 5 秒。

下面仅为协议示例，不是实际资产或行情。应用必须使用自己的值及真实数据更新时间。

```json
{
  "schemaVersion": 2,
  "data": {
    "updatedAt": "2026-09-21T12:00:00.000Z",
    "health": { "state": "online", "message": "来源正常", "staleAfterSeconds": 120 },
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

- 顶层只接受 `schemaVersion`、`data`；v2 的 `data` 接受 `updatedAt`、`metrics`、`health`，以及可选的 `trend`、`freshness`，未知字段会被拒绝。
- `health` 只包含 `state`（`online` / `partial` / `stale` / `offline`）、`message`（最长 500 字符）、`staleAfterSeconds`（1–86400 的整数）。工作台保留来源状态，并取来源与项目阈值较短者。动态数据允许 `updatedAt: null`，但不能因此显示新鲜。
- `freshness` 可选 `dynamic` 或 `static`。只有明确为人工估值的静态数据使用 `static`；来源错误仍须通过 `health` 反映，不能借此隐藏错误。
- 工作台先请求 `?schemaVersion=2`，仅在 404/405 时回退旧接口。v1 仍支持，`data` 只能包含 `updatedAt`、`metrics`、可选 `trend`，且必须有有效时间。CrossEx 无参数请求继续返回 v1，兼容旧工作台。
- `updatedAt` 是 ISO 8601 的数据源时间，不能用当前请求时间掩盖旧快照；不能比工作台时钟超前 60 秒。汇总数值受其所依赖来源的最早有效时间限制。CrossEx 的可用性摘要以最新有效盘口的源时间为基础，同时受行情包生成时间限制；有浮动盈亏时再取持仓最早估值时间。过期盘口单独通过 `health.state = "partial"` 说明，过期持仓的浮盈为 `null`；全部盘口失效仍为 `stale`，来源读取失败为 `offline`，不能用其他币对的新报价延长持仓盈亏的有效期。
- `metrics` 最多 24 个。`key` 唯一，只允许英文字母、数字、下划线和短横线，长度 1–64；`label` 长度 1–80。
- `value` 接受有限数值、最长 160 字符的字符串或 `null`。缺失数据使用 `null`，不要使用 0 代替。数值不要携带千分位或币种字符，单位写在 `unit`。
- `unit` 可选，最长 24 字符；`detail` 可选，最长 240 字符。写清币种、统计周期和采样口径；百分比的值 `2.5` 表示 `2.5%`，不要交叉使用 0.025。
- `trend` 可选，最多 366 个点；每点仅包含 ISO 8601 `at` 和有限数值 `value`。提供同一指标、同一单位和清楚的采样周期；接入器按时间排序。无观测时不要伪造零点或插值。

标准项目的数据留在该项目下，不会自动加进首页的资产总额。通用趋势会被保留在摘要中；当前首页资产曲线固定读取 Asset Ledger，其他项目专用图表可以按需扩展。

## 已有项目适配

四类适配器均优先请求轻量 v2 摘要（Monitor 携带当前 `monitor` 查看条件），认证与旧接口相同。下表列出接口缺失时的兼容读取。页面自动登录另建独立会话，不复用下表的缓存。

| 适配器 | 请求 | 认证 |
| --- | --- | --- |
| `aster` | `GET /api/state?compact=true` | 配置密码时先 `POST /api/login`，返回的 `aster_session` 仅在服务器内存缓存，最长 11 小时；认证失效后重新登录。 |
| `asset` | `GET /api/ledger`；启用 `autoSync` 时另行 `POST /api/sync` | 配置密码时先 `POST /api/login`，返回的 `asset_session` 仅在服务器内存缓存，最长 11 小时；认证失效后重新登录。 |
| `monitor` | `GET /api/monitors` 与选定模块的 `/api/monitors/{id}/quote` | 可选 HTTP Basic。 |
| `standard` | `GET /api/hub/summary` | 可选 HTTP Basic。 |
| `link` | 不采集摘要；`proxy` 时转发用户的原页面请求 | 不支持自动登录，仍由用户在原页面自行登录。 |

monitor 首版支持 `oil`、`hynix`、`perpetual` 摘要。优先使用页面 URL 中 `monitor` 参数指定的模块，其次使用 `oil`，否则读取第一个模块；未知模块提示需要新适配器或标准接口。资金费率年化按上游小数值乘以 100 展示为百分比。永续模块更新时间使用启用交易所最早消息时间，并保留交易所过期状态。

扩展摘要适配器时先读取原接口的真实字段，明确单位和时间，再添加转换逻辑及失败、认证、过期和缺失数据测试。摘要不得透传密码、API Key、订单操作或不受控的 HTML；完整原页面通过独立的页面代理访问，不混入摘要协议。

## 单端口原页面访问

在自己的电脑建立一个转发即可访问工作台和已配置为 `proxy` 的项目：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3100:127.0.0.1:3100 user@server
```

打开 `http://127.0.0.1:3100` 会跳转至 `http://hub.localhost:3100`；工作台生成项目独立的 `.localhost` 子域并保持端口为 `3100`。Chrome / Edge 无需 hosts 或 DNS 修改。当前支持 SSH 本地访问，不承诺 Safari 或通用域名代理。[浏览器兼容说明](https://learn.microsoft.com/en-us/aspnet/core/test/localhost-tld?view=aspnetcore-10.0)

页面访问先由工作台会话签发一次性授权票据，再建立绑定该会话和项目主机的 host-only Cookie。保存密码后，`aster` 和 `asset` 每次页面授权各自调用 `POST /api/login`，将新的原项目会话保存在服务器；页面会话与后台摘要及同步会话独立。`monitor` 使用保存的 HTTP Basic 凭据，先以 `GET /api/monitors` 预检；`standard` 使用已有的 `GET /api/hub/summary` 预检。密码、Basic 认证信息和上游会话均不返回浏览器，页面请求由工作台服务器附加对应认证。

未保存凭据时仍可在原站登录，也可回工作台设置保存一次。登录失败或会话过期时，应回工作台重新打开项目，必要时更新保存的凭据；不自动使用失效会话继续请求。在原项目退出登录会撤销当前页面授权；退出工作台会撤销全部页面授权，修改项目配置会撤销该项目已有授权。`direct` 和 `link` 项目仍按原站方式自行登录。

代理保留根路径、页面查询参数和流式响应，避免修改 Next / Vite 的应用路径。项目的 `url` 主机不会成为代理目标；monitor 实时 SSE 必须持续转发。代理移除 `X-Frame-Options` 并将 CSP 的 `frame-ancestors` 限制为当前工作台，保留其余 CSP 指令，让原页面可以在工作台内嵌入；不向其他来源开放嵌入。摘要协议的 1 MiB 和 5 秒限制不用于原页面请求，Asset 的导入与较慢同步有各自限制。

已有 HTTPS 工作台入口可设置 `PUBLIC_ORIGIN=https://hub.example.com` 和 `COOKIE_SECURE=true`，将该来源加入允许入口。它不自动建立任意域名下的项目代理；这类入口可使用 `direct` 项目链接，单端口完整原页面仍以 SSH `.localhost` 为支持方式。

## Asset 后台同步

`autoSync=true`、项目启用且已保存原项目登录凭据时，服务器每 60 秒向 Asset 的 `POST /api/sync` 发送认证请求，单次超时 60 秒。该任务独立于按来源时限（最多每 30 秒）的摘要读取，不阻塞其他项目；不依赖工作台页面、Asset 页面或 SSH 连接保持打开。项目设置可关闭同步，之后仍读取已保存的账本。

此调用使用 Asset 已有的只读资产来源同步功能，会写入估值及历史，不会下单或转账。保存的原项目登录凭据用于服务器认证，不向浏览器暴露。后台同步的尝试、结果和错误状态独立于资产 `updatedAt`；不能用请求完成时间更新源数据时间。即使接口成功返回，某个来源也可能保留旧值，应以账本中的真实更新时间及来源错误判断新鲜度。

通过工作台打开 Asset 原页面时，已开启后台同步且已保存密码的 `/api/sync` 请求与后台共用一次同步。代理使用当前页面授权保存在服务器上的 Asset 会话，先验证账本访问权限，同步完成后再读取真实账本，避免同时刷新造成锁冲突；不要求浏览器持有原站会话 Cookie。页面授权或上游认证无效时不能读取，同步失败不伪装为成功。关闭后台同步后，原页面同步请求照常转发。

## 资产新鲜度补充

资产适配器使用原账本的 `mode` 分类：`manual` 为手工估值，`market`、`bybit`、`aster` 为动态数据。混合账本的 `updatedAt` 取所有非 `manual` 行最早更新时间，并通过 `manual_valuation_at` 指标单独保留手工行最早估值时间。缺少或未知 `mode` 按动态行处理并提示数据不完整，避免误判为不会过期。

仅全部行都明确为 `manual` 时，快照带有 `freshness: "static"`，更新时间为最早估值记录时间；按静态账本展示，不套用实时刷新阈值。该标记也可由 v2 摘要明确提供；v1 不接受此字段。上游错误、数据缺失或汇率问题仍会单独提示。

## 页面活动与查看条件联动

工作台最多保留五个确认支持 `activity` 的代理 iframe，按插入顺序保持 DOM 稳定，切换项目不移动已有 iframe。登录并取得项目配置后，可见且联网持续 200 ms 即开始依次预加载五个内置模块；只接受已启用、配置了 `apiUrl` 且 ID 与适配器匹配的代理接入（`aster/aster`、`monitor/monitor`、`asset/asset`、`crossex/standard`、`variational/standard`）。直接接入和自定义模块仍由点击打开。

后台一次准备一个模块，点击选择的项目立即打开；快速切换时最多保留当前项目和一个后台项目的未完成加载。悬停或键盘聚焦只调整尚未开始的队列顺序。每个 revision 自动尝试一次，失败、超时或文档加载后 3 秒仍未确认 `activity` 的隐藏页面会卸载并释放队列，用户点击可重新尝试；不循环签发 launch。首次授权仍在创建 iframe 后立即消费原有一次性 ticket，不缓存 ticket 或改变授权有效期。退出登录卸载全部页面；项目配置或凭据 revision 改变时撤销旧页面并重新授权，停用或移除项目会清理相应预加载。

五个内置模块在代理 iframe 中默认 inactive，先准备界面与脚本，收到宿主 activity 后才开始前台数据读取。页面隐藏、离线或 host `active=false` 时停止前台刷新并取消在途读取，恢复后立即补查；不停止任何后台交易、采集或同步任务。预加载不延长行情有效期，也不保证刚登录后立即点击的模块已经加载完成。

消息统一使用 `{channel:"project-hub", version:1, type:...}`。工作台发 `ready`（`role:"host"`），模块确认 `ready`（`role:"module", capabilities:["activity","navigate","changed"]`）。模块可以先发无能力的 `ready` 探测，工作台回握手后才确认能力。`activity` 携带布尔 `active`；实际写入成功后可发 `changed, scope:"summary"`，工作台合并短时间重复通知，只刷新相应项目。

模块确认可以早于或晚于 iframe `load`。每次文档 `load` 都重新探测能力，防止内部刷新或跳转至登录页后沿用旧文档状态；新文档提前发送的无能力探针也能在 load 前重新握手。能力确认不会无限触发 ready 往返。

`navigate` 携带 `projectId` 和 `query`。目标限 `monitor`、`crossex`、`aster`、`asset`；前两者只接受 `symbol`（1–40 位大写字母、数字、点、下划线、短横线）、`longExchange`、`shortExchange`（binance/bybit/okx/gate/kraken/hyperliquid/lighter）。ASTER 和 Asset 只接受空条件。导航只改变查看状态，不触发交易、导入或保存。

双方校验精确 `origin`、`event.source` 与消息结构，不使用 `*`。模块仅在 `p-<24位十六进制>.hub.localhost` 代理 iframe 内建立桥，父来源为同协议、同端口的 `hub.localhost`；独立打开不启用桥。工作台只接受当前可见、已完成握手的页面发起导航，目标也必须启用代理。

`GET /api/overview/events` 受工作台登录会话保护，每次推送重新验证会话；退出登录或改密码关闭订阅。每个会话最多 12 条订阅，全局 60 条，慢客户端断开重连。前端在隐藏/离线时关闭订阅，正常可见时接收推送与 15 秒心跳，订阅断开才使用 30 秒补查；卡片按下一次来源过期时刻定时更新，不每秒重绘整个总览。
