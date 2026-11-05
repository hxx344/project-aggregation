# Aero 市场实盘：Safe + Zodiac Roles 权限清单（草案 v0.1）

日期：2026-11-04　状态：设计草案，未实现、未部署、未在 fork 上验证。

## 0. 结论与范围

- 资产放在 Safe，管理钱包是 Safe 的唯一 owner（或之一）；bot 钱包只是 Roles 模块里的一个角色，只能调用本文第 3 节列出的合约、函数和参数。Roles 默认拒绝：未列出的调用一律不能执行，第 3 节的"禁止"栏是风险说明，不是需要额外配置的黑名单。
- bot 私钥泄露时，攻击者无法把资产转出 Safe，只能在白名单池子内用额度内的资金做不利成交（第 6 节）。
- 首版范围：Base 链、合并后 Aero（MetaDEX）的 Slipstream CL 池（工厂 `0x9CB2…7a76`）。v2 volatile/stable 池、Optimism 等其他链不在范围内，后续按同样结构单独出清单。
- 每个策略一个 Safe（Aero 市场与 Aero LP 分开），资产、台账与故障范围隔离。

## 1. 账户结构

```
管理钱包（硬件钱包，不进服务器）
  └─ owner of Safe（Aero 市场策略）—— avatar：资产、LP NFT、gauge 质押都记在它名下
       └─ 已启用模块：Roles Modifier 代理（owner = Safe，avatar = Safe，target = Safe）
            └─ 角色 aero-market-bot：成员 = bot EOA（只持少量 ETH 付 gas，不是 Safe owner）
```

- Safe 只启用 Roles 一个模块；不给 bot 任何 owner 或其他模块身份。
- bot 发交易：调用 Roles 代理的 `execTransactionWithRole(to, 0, data, 0, roleKey, true)`；批量操作经 MultiSendCallOnly（`operation = 1`），由 Roles 的 MultiSendUnwrapper 拆开后逐笔按本清单校验。
- 每个 bot 用自己的 EOA 和 nonce，多个策略并行不会互相冲突。

## 2. 已核实地址（Base，chainId 8453）

核实方式：「源」= 官方仓库部署清单；「链」= 2026-11-04 用 `mainnet.base.org` 读取到合约代码，以及表中所列的关联读数；「选择器」= 第 3 节用到的函数选择器均出现在链上字节码中。

### 2.1 Safe 与 Roles

| 合约 | 地址 | 核实 |
| --- | --- | --- |
| SafeL2 v1.4.1 singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | 链（safe-deployments 规范地址，源未在本次重读） |
| SafeProxyFactory v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | 链（同上） |
| MultiSendCallOnly v1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | 链、选择器 `multiSend(bytes)` |
| Zodiac ModuleProxyFactory | `0x000000000000aDdB49795b0f9bA5BC298cDda236` | 链（部署前对照 Zodiac 文档再核一次） |
| Roles v2 mastercopy | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` | 源 `zodiaceco/zodiac-modifier-roles-v2` README（Base 在列）、链、选择器 |
| Roles Integrity / Packer 库 | `0x6a6Af4b16458Bc39817e4019fB02BD3b26d41049` / `0x869718c939652084bc491fbc5ce0d3c1d5b309f0` | 源、链 |
| MultiSendUnwrapper | `0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD` | 源、链；源码要求 `value = 0` 且外层为 delegatecall |
| AvatarIsOwnerOfERC721（自定义条件） | `0x91B1bd7BCC5E623d5CE76b0152253499a9C819d1` | 源、链；源码检查 `IERC721(调用目标).ownerOf(参数) == avatar` |

不要使用：旧文档里的 Roles `0x9646fDAD…D337`、Unwrapper `0x93B7fCbc…27c0`（`gnosisguild/zodiac-modifier-roles` 现为未发布的 v3，生产 v2 已迁到 `zodiaceco`）。

### 2.2 Aero Slipstream（新工厂）

来源：`dromos-labs/metadex-slipstream-public` 的 `deployment-addresses/cl-base.json`、`leaf-base.json`（与 `server/research/aero-market-chains.mjs` 同源）。

| 合约 | 地址 | 链上关联读数 |
| --- | --- | --- |
| CLFactory | `0x9CB220581b91b0C83223012FE69688b92aD07a76` | `voter() = 0x3824…4078` |
| NonfungiblePositionManager（NPM） | `0x4857DB576eE0e45F10525eC59527BfD10beeC60b` | `factory() = CLFactory`，`name() = "Slipstream V3 Deposit"`，`owner() = 0x4225…4cE0`（协议方，只能改描述器，不涉资金） |
| SwapRouter | `0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418` | `factory() = CLFactory`，`WETH9() = 0x4200…0006` |
| Voter（LeafVoter） | `0x382409fad8503FbCdbB27A4211551fa03e884078` | `RECEIPT_TOKEN() = 0x6CdD…ceE7`（xAERO） |
| CLGaugeFactory | `0xf437f62053ACB121665b8fDBfeA8F214FB8E589d` | gauge 的 `gaugeFactory()` |
| CLGauge 实现 | `0x89E91A960154b1ed6c093039a8F0725ab67D14E0` | 已查两个 gauge 均为它的 EIP-1167 克隆 |

不要使用旧部署：NPM `0x8279…5b72`、SwapRouter `0xBE6D…18a5` 的 `factory()` 都是旧工厂 `0x5e7B…809A`，与当前池子不配套。

### 2.3 代币与奖励卖出池

| 名称 | 地址 | 说明 |
| --- | --- | --- |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | |
| AERO（新） | `0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee` | gauge 奖励到账币种 |
| AERO/USDC CL 池，tickSpacing 200 | `0xD0Acf293547457Fb4fE9eE32CA93e89497626816` | 本次读数约 86.6 万 AERO + 70.7 万 USDC，新工厂下最深；gauge `0x4A3B…60D5` |
| AERO/USDC CL 池，tickSpacing 100 | `0x422dF9aa896e883c9CDcBad309C0785b7364A1cF` | 约 32 万 USDC，备选 |

## 3. 角色 `aero-market-bot` 的允许调用

记号：`EqualToAvatar` = 必须等于 Safe 地址；`OwnedByAvatar` = 自定义条件 AvatarIsOwnerOfERC721（NFT 必须归 Safe）；`池白名单` = `(token0, token1, tickSpacing)` 属于第 4 节列表（`Or` 组合）；`额度[币]` = 第 5 节的 `WithinAllowance`。所有目标的 ExecutionOptions 为 None：不能附带 ETH、不能 delegatecall（MultiSend 由 unwrapper 单独处理）。

### 3.1 NPM `0x4857…C60b`

| 函数 | 选择器 | 参数条件 |
| --- | --- | --- |
| `mint(MintParams)` | `0xb5007d1f` | `token0/token1/tickSpacing` ∈ 池白名单；`recipient` EqualToAvatar；`amount0Desired` ≤ 额度[token0]，`amount1Desired` ≤ 额度[token1]；`sqrtPriceX96` = 0（非 0 会顺带创建新池） |
| `increaseLiquidity(params)` | `0x219f5d17` | `tokenId` OwnedByAvatar；`amount0Desired/amount1Desired` 计入额度（需按 tokenId 所属池的代币取额度键，见第 5 节说明） |
| `decreaseLiquidity(params)` | `0x0c49ccbe` | `tokenId` OwnedByAvatar（取出的代币记在仓位上，靠 `collect` 领取） |
| `collect(params)` | `0xfc6f7865` | `tokenId` OwnedByAvatar；`recipient` EqualToAvatar |
| `burn(uint256)` | `0x42966c68` | `tokenId` OwnedByAvatar |
| `approve(address,uint256)` | `0x095ea7b3` | `to` ∈ 白名单 gauge；`tokenId` OwnedByAvatar |

禁止（不授权即生效）：`transferFrom` / `safeTransferFrom` / `setApprovalForAll`（可直接转走 NFT）、`multicall`（内层调用无法逐项约束，批量改走 MultiSend）、`sweepToken` / `unwrapWETH9` / `refundETH`（带任意 recipient）、`permit`。

### 3.2 每个白名单 gauge（目标逐个列地址）

| 函数 | 选择器 | 参数条件 |
| --- | --- | --- |
| `deposit(uint256)` | `0xb6b55f25` | 无（合约要求 `nft.ownerOf == msg.sender`，即 Safe 自己的 NFT） |
| `withdraw(uint256)` | `0x2e1a7d4d` | 无（合约要求质押人 = msg.sender，NFT、手续费与排放都回到 msg.sender） |
| `claimEmissions(address,address)` | `0x8ed86282` | `_account`、`_recipient` 均 EqualToAvatar |
| `claimEmissions(address,address,uint256[])` | `0x09902477` | 同上 |
| `emergencyWithdraw(uint256)` | `0x5312ea8e` | 无（资产回 msg.sender；仅协议开启紧急模式时可用） |

禁止：`depositFor`（替他人质押）、`withdrawFrom`、`approve` / `setApprovalForAll`（被授权者可用 `withdrawFrom` 把 NFT 取到自己地址）、`approveForClaim`（被授权者可把排放领到自己地址）、`claimReferralEmissions`、`forfeitRollover`。

加入新 gauge 前须核实：`pool.gauge() == gauge`、`gauge.pool() == pool`、`gauge.nft() == NPM`、`gauge.voter() == Voter`，字节码是 `0x89E9…14E0` 的克隆；实现不同的 gauge 必须重新审一遍函数表。

### 3.3 SwapRouter `0x9Ee3…D418`

| 函数 | 选择器 | 参数条件 |
| --- | --- | --- |
| `exactInputSingle(params)` | `0xa026383e` | `(tokenIn, tokenOut, tickSpacing)` ∈ 兑换白名单；`recipient` EqualToAvatar；`amountIn` ≤ 额度[tokenIn] |

禁止：`exactInput` / `exactOutput*`（多跳路径是 bytes，难以约束；需要时用多笔 single 组合）、`multicall`、`sweepToken`、`unwrapWETH9`、`refundETH`、`selfPermit*`。

### 3.4 每个白名单代币（目标逐个列地址）

| 函数 | 选择器 | 参数条件 |
| --- | --- | --- |
| `approve(address,uint256)` | `0x095ea7b3` | `spender` ∈ {NPM `0x4857…C60b`, SwapRouter `0x9Ee3…D418`}；金额不限 |

金额不限的理由：NPM 与 Router 只在 Safe 自己发起的调用里从 Safe 拉币，授权额度本身不构成转出路径；真正的资金闸门是第 5 节对 mint / swap 金额的额度。禁止：`transfer`、`transferFrom`、`increaseAllowance`、`permit`。

### 3.5 MultiSendCallOnly `0x9641…02e2`

不给角色授权，改由 Roles owner 注册 `setTransactionUnwrapper(0x9641…02e2, 0x8d80ff0a, 0xB4Cd…efD)`：外层 delegatecall 被拆开，内层每笔按 3.1–3.4 校验，内层 delegatecall 一律不允许。常用批次：`decreaseLiquidity + collect + burn`（平仓）、`approve + mint`、`NPM.approve + gauge.deposit`。

## 4. 池与兑换白名单（初始）

| 用途 | token0 / token1 | tickSpacing | 池 / gauge |
| --- | --- | --- | --- |
| 奖励卖出（swap） | AERO → USDC | 200 | `0xD0Ac…6816` / `0x4A3B…60D5` |
| 做市池 | 待定：由 Aero 市场页的推荐结果选出后逐个加入 | | |

加池由管理钱包签一笔 Safe 交易，同时更新：NPM `mint` 的池白名单 `Or`、新 gauge 目标、新代币目标、`NPM.approve` 的 gauge 列表、必要的兑换路径。bot 无权自行扩大白名单。

## 5. 额度（Roles `WithinAllowance`）

- 每个代币一个额度键，例如 `turnover-USDC`、`turnover-AERO`，mint/increase 的 desired 金额与 swap 的 `amountIn` 共用同一个键，按 24 小时补充。池白名单的每个 `Or` 分支固定了代币地址，分支内的金额字段直接挂对应代币的额度键。
- `mint` 的 desired 是上限，实际投入可能更少，额度按 desired 扣，偏保守。
- `increaseLiquidity` 的参数里没有代币地址，无法按代币取额度键：首版要么不授权 `increaseLiquidity`（调仓一律"平仓 + 新开仓"），要么给它单独一个按池分开的小额度。建议首版不授权。
- 上限取预期日周转额的 2 倍左右；超限时 bot 交易 revert，策略停在当前状态，等管理钱包调额度或次日补充。
- 可选：`CallWithinAllowance` 限制每日 swap 笔数，防止"小额多次"消耗。

## 6. 剩余风险（bot 私钥泄露时）

| 风险 | 上限 / 缓解 |
| --- | --- |
| 白名单池内不利成交：swap 设 `amountOutMinimum = 0` 后被夹，或先操纵价格再 mint / decrease | 损失上限 ≈ 当日额度 × 价格偏离；只放深池；出账与成交偏离告警。Roles v2 不能直接比对预言机价格，链上价格校验需另写自定义条件合约并审计，首版不做 |
| 打乱策略：反复开平仓、解押损失排放、`emergencyWithdraw` | 只损失收益和 bot 自己的 gas，本金仍在 Safe；发现后撤销角色 |
| bot EOA 里的 ETH | 只放够几天 gas 的量 |
| Roles 配置错误（例如漏了某个 `EqualToAvatar`） | 第 8 节的反向用例在 fork 上逐条验证后才启用；清单与配置从同一份 JSON 生成 |
| 协议侧 | NPM owner 只能改描述器；gauge 紧急模式由协议开关；CL 池带 MEV tax 模块（`0x29F1…9a4a`），对成交成本的影响待核实 |

## 7. 管理钱包操作（只由 Safe owner 签）

- 部署：创建 Safe → 经 ModuleProxyFactory 部署 Roles 代理（owner / avatar / target = Safe）→ `enableModule` → 注册 MultiSendUnwrapper → 按 JSON 下发 scope 与额度（用 `zodiac-roles-sdk` 4.x 生成差异调用）→ `assignRoles(bot, [roleKey], [true])`。
- 日常：加删池子、调额度、从 Safe 直接提走利润或本金。
- 紧急停止：`assignRoles(bot, [roleKey], [false])`，或 `disableModule(Roles)`，一笔交易生效，不依赖服务器；必要时再撤销代币授权。
- 换 bot 私钥：先给新地址分配角色，再撤销旧地址。

## 8. 上线前验证（Base fork，再小额主网）

正向（必须成功）：approve → mint → NPM.approve + deposit → claimEmissions → withdraw → decrease + collect + burn（MultiSend）→ AERO 换 USDC。

反向（必须 revert）：
- USDC / AERO `transfer` 到外部地址；`approve` 给非 NPM / Router。
- `mint` / `collect` / `exactInputSingle` 的 recipient 填外部地址；`claimEmissions` 的 recipient 或 account 填外部地址。
- NPM `transferFrom`、`setApprovalForAll`、`multicall`、`sweepToken`；`NPM.approve` 给非白名单地址；对非 Safe 的 tokenId 操作。
- gauge `depositFor`、`withdrawFrom`、`approve`、`setApprovalForAll`、`approveForClaim`。
- 非白名单池的 `mint` / swap；`sqrtPriceX96 ≠ 0`；超额度；`value > 0`；delegatecall 到 MultiSend 以外的地址；MultiSend 内层 delegatecall。
- 撤销角色后，bot 的任意调用。

## 9. 工作台侧改动（实施时另立任务）

- 执行器：交易改为经 Roles 代理以 Safe 名义执行；签名前本地校验保留，与 Roles 配置读同一份白名单 JSON，作为第二道防线。
- 读取：持仓、质押、余额、估值改按 Safe 地址（`tokenOfOwnerByIndex(Safe)`、`gauge.stakedValues(Safe)`）。
- 监控：独立只读进程监听 Safe 的出账和 Roles 配置事件，非预期变化发飞书。
- 工作台只保存 bot 私钥和 Safe / Roles 地址，管理钱包私钥不录入。

## 10. 待决策

1. 管理钱包形态：单个硬件钱包 1/1（简单），还是 2/3 多签（防单把丢失或泄露）。
2. 首批做市池与每日额度。
3. Aero LP 是否同步迁到 Safe + Roles（结构相同，白名单只含 RSGP/USDC 一个池）。
4. AERO 奖励自动卖成 USDC，还是留在 Safe 由管理钱包处理。
