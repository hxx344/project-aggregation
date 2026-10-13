# Gate 资产连接

在 **资产账本 → 交易所连接 → Gate → 连接账户** 填写 Gate 国际站实盘的 **API v4 Key** 和对应 Secret，签名方式为 HMAC。请在 Gate 控制台仅开启钱包读取权限，关闭交易、划转、提现等写入权限；如设置 IP 白名单，应填写运行工作台的服务器出口 IPv4。新建密钥、修改权限或 IP 白名单后，最多需等待 5 分钟生效。

连接时先读取并校验余额，成功后将密钥加密保存到现有资产账本数据库。新账本会自动增加一条 Gate 资产；旧账本中的单条 `Gate` 或 `Gate.io` 记录会被接管，不重复计入。同名记录有多条时会拒绝连接，需先合并。更新连接失败保留原连接及金额；断开连接删除密钥，保留最后估值。

## 估值口径

使用 Gate 的 `GET /api/v4/wallet/total_balance?currency=USD`。账本总额仅采用响应中的 `total.amount`；明细展示各账户折合 USD 的金额，既不把分项重复加到总额，也不另行加减保证金、浮动盈亏或借贷。金额是 Gate 官方估值，不代表实际 USD 持仓。覆盖范围以该接口为准，不自动汇总子账户；官方文档没有明确所有账户模式下总额与借贷、浮盈的计算公式，因此不将其标为净权益。

Gate 的余额与换算价格最多可能缓存 1 分钟，接口不提供源数据时刻；页面标注的是获取时间。Gate 同步独立于公共币价接口；读取失败或数据不完整时保留旧值及上次成功时间，并展示错误状态。金额和同步状态会进入账本快照、资产曲线及工作台首页摘要。

## 权限与支持范围

本程序只向固定 Gate 官方地址发送上述 GET 请求，不提供交易、划转或提现操作。Gate 当前账户信息接口未提供可可靠核验当前密钥完整权限的字段，因此连接成功只表示余额可读，不表示密钥的只读权限已自动核验。请在 Gate 控制台核对权限。

本次支持资产估值；Gate 密钥不进入工作台交易凭据导出或仓位读取目录。

## 连接失败排查

失败提示会显示 HTTP 状态、可识别的 Gate 错误码、具体原因和处理建议。例如 `HTTP 403 · IP_FORBIDDEN` 表示服务器出口 IP 不在密钥白名单中。各类提示对应以下检查：

| 错误码或现象 | 检查内容 |
| --- | --- |
| `IP_FORBIDDEN` | 白名单填写运行平台的服务器出口 IPv4；修改后等待生效 |
| `FORBIDDEN` | 钱包（Wallet）读取权限及 Gate 账户限制 |
| `INVALID_KEY`、`INVALID_CREDENTIALS` | 国际站实盘 API v4 Key 是否有效，Key 与 Secret 是否配对 |
| `INVALID_SIGNATURE` | 同一组 Key 与 Secret 是否复制完整 |
| `REQUEST_EXPIRED` | 同步运行平台的服务器时间，误差不能超过 60 秒 |
| `MISSING_REQUIRED_HEADER` | 服务器代理是否改写认证请求头；持续出现时反馈错误码 |
| `ACCOUNT_LOCKED`、`READ_ONLY` | 在 Gate 核对账户/API 状态；读取资产无需开启交易或提现权限 |
| HTTP 429、`TOO_MANY_REQUESTS` | 稍后重试，减少手动刷新 |
| HTTP 5xx、服务繁忙或内部异常 | 稍后重试 |
| DNS、TLS 证书、连接中断或超时 | 检查服务器网络、时间、证书信任或代理配置 |

若 Gate 或网关没有返回可识别错误码，提示会明确说明原因尚未确定；仅凭 HTTP 403 不能判断密钥版本、权限或网络限制。程序只展示已知错误码及固定说明，不回显原始错误正文、签名或密钥；错误正文超过 16 KiB 时降级为 HTTP 状态提示。连接验证失败不会保存新密钥，刷新失败保留上次成功金额与时间。

接口依据（核对日期：2026-10-14）：[余额接口](https://www.gate.com/docs/developers/apiv4/en/wallet/)、[签名规则](https://www.gate.com/docs/developers/apiv4/en/#api-signature-string-generation)、[错误码](https://www.gate.com/docs/developers/apiv4/en/#label-list)、[账户信息接口](https://www.gate.com/docs/developers/apiv4/en/account/)。
