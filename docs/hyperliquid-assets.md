# Hyperliquid 资产连接

用于把 Anthropic 套利（Hyperliquid `io:ANTH` / `xyz:ANT` 实盘执行）所在账户计入资产账本。在 **资产账本 → 交易所连接 → Hyperliquid → 连接账户** 填写一个 **主账户地址**（Hyperliquid 页面显示的钱包地址，`0x` 开头、40 位十六进制）。不需要 API Key 或私钥；套利执行使用的 API 钱包（agent）地址会被拒绝，请改填它所属的主账户地址。目前只统计一个地址，不自动汇总子账户。

连接时先查询地址角色（`userRole`），再读取账户总值，两步都成功后才保存地址并写入资产。新账本会自动增加一条 `Hyperliquid` 资产；旧账本中的单条 `Hyperliquid` 或 `HL` 记录（不区分大小写）会被接管，不重复计入。接管后这一行改由接口维护，不能再手工编辑；原表中名为 `HL` 但含义不同的行，请在导入前改名。同名记录有多条时拒绝连接或导入，需先合并。更新连接失败保留原连接及金额；断开连接删除地址，保留最后估值。

## 估值口径

所有数据来自 Hyperliquid 官方 `POST https://api.hyperliquid.xyz/info` 公开查询，请求只携带地址，不带签名或密钥。

- **总额**：取 `portfolio` 中 `day` 序列最后一点的 `accountValue`，即官方账户总值，换算美元时只乘一次 USDC/USD。它包含现货代币市值、全部永续 DEX（主站及 `xyz`、`io` 等 HIP-3 市场，含未实现盈亏）、**金库存款**（如 HLP）和**质押 HYPE**（已委托、未委托与待提取）。如果账本里另有手工记录的 HLP 存款或质押 HYPE，请删除这些手工行，避免重复计入。
- **账户模式**：通过 `userAbstraction` 识别。统一账户（`unifiedAccount`）与组合保证金（`portfolioMargin`）模式下，各 DEX 的永续状态与现货余额是同一笔资金，明细只列现货余额。`default`、`disabled` 与 `dexAbstraction` 模式下，各 DEX 余额彼此独立（DEX abstraction 会把保证金实际划入对应 HIP-3 DEX），明细分列各 DEX 永续权益与现货余额。
- **明细**：只用于核对，不加总成总额。明细包括永续权益、现货余额、各金库权益与质押 HYPE。非 USDC 现货代币按 Hyperliquid 现货中价（无中价时用标记价，优先官方交易对，其次成交额最大的交易对）折算；找不到 USDC 报价的显示「未估值」。永续 DEX 只列出有权益或持仓的市场。
- **时间**：账户值时间超过 5 分钟或超前 1 分钟时拒绝使用。USDC/USD 优先使用 CoinGecko，报价超过 15 分钟或超前 1 分钟时改用 Coinbase；Coinbase 未提供源时间，采用获取时间。页面估值时间取账户值时间与汇率时间中较早者，不把 USDC 按 1:1 计为美元。

DEX 列表与各 DEX 的保证金代币缓存 10 分钟，新出现的 DEX 最多 10 分钟后出现在明细中；账户数据不缓存。各 DEX 状态最多同时请求 4 个。

## 失败处理

只有账户总值或 USDC/USD 汇率读取失败、限流（HTTP 429）、数据不完整或过期时，才保留旧值及上次成功时间并展示固定错误提示。账户模式、现货、金库、质押、各 DEX 状态或现货报价等明细读取失败时，仍更新总额，明细中会加一行说明「总额不受影响」；账户模式未识别时不列永续明细，避免把共用余额看成两笔。

每次请求超时 12 秒，单次同步（含连接时的角色校验）整体不超过 40 秒，不自动重试；工作台下一次刷新时会重新读取。提示不包含原始响应、网络错误详情或地址。

Hyperliquid 地址不进入工作台交易凭据导出或仓位读取目录；本连接只做资产估值，不提供交易、划转或提现操作。

## 核对记录

2026-11-07 用 HLP 金库的 9 个公开存款人地址（4 个 `unifiedAccount`、4 个 `default`、1 个 `disabled`；其中 1 个有约 13 万美元质押 HYPE，1 个统一账户有约 30 万美元主站永续权益）核对：`day` 最后一点均为查询当时（0–1 秒内）；现货市值 + 金库权益 + 质押 HYPE（+ 非共享模式的各 DEX 永续权益）与官方总值相差不超过 0.01%。统一账户把永续权益再加一次会多出约 14%，验证了只列现货余额的做法。未找到有 HIP-3 持仓或 `dexAbstraction`、`portfolioMargin` 模式的样本，这三种情况的明细口径依据官方文档。

接口依据（核对日期：2026-11-07）：[Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)、[Perpetuals](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)、[Spot](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)、[账户模式](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes)、[DEX abstraction](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)。
