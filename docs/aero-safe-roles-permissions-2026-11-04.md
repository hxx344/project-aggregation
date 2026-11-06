# Aero 市场实盘：Safe + Zodiac Roles 权限清单（v0.2）

日期：2026-11-04　状态：首版工具已实现（`tools/aero-roles/`），Base fork 验收 72/72 通过（第 8 节）；Safe 版本为 v1.5.0（Safe{Wallet} 在 Base 上新建的版本，不能选旧版）；未在主网部署，工作台执行器尚未接入（第 9 节）。

v0.2 变更：管理钱包定为单个硬件钱包 1/1（第 10 节）；首版不授权 `increaseLiquidity`；Safe 必须设置 CompatibilityFallbackHandler；额度键与部署步骤改为 `tools/aero-roles` 的实际实现。

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

`plan` 会把下表协议合约的运行时字节码与 `tools/aero-roles/addresses.mjs` 中的哈希逐一比对（SafeProxyFactory、Roles Integrity / Packer 库除外：`plan` 不经过工厂，Safe 代理本身另按 `SAFE_PROXY_CODEHASH` 核对；两个库只在 Roles mastercopy 内部使用，由 mastercopy 的 codehash 间接覆盖）：
- 这些合约都不是可升级代理，比对的是不可变代码。Aero 换地址重新部署时 `plan` 会拒绝，需要重新核实。
- 比对不覆盖治理可改的状态，例如 CLFactory 的手续费模块、Voter 治理或 emergencyCouncil 停用 gauge、NPM 的 tokenDescriptor。这些改动不会在 Roles 授权范围内打开转出路径，但属于信任前提。
- 代币不比对。USDC 本身是可升级代理（FiatTokenProxy），对它的信任来自发行方。

### 2.1 Safe 与 Roles

| 合约 | 地址 | 核实 |
| --- | --- | --- |
| SafeL2 v1.5.0 singleton | `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` | 源 `safe-global/safe-deployments` v1.5.0（Base 为 canonical）、链（codehash 与源记录一致） |
| SafeProxyFactory v1.5.0 | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` | 同上 |
| MultiSendCallOnly v1.5.0 | `0xA83c336B20401Af773B6219BA5027174338D1836` | 同上，选择器 `multiSend(bytes)` |
| CompatibilityFallbackHandler v1.5.0 | `0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4` | 同上 |
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
| ~~`increaseLiquidity(params)`~~ | `0x219f5d17` | 首版不授权（第 5 节）：调仓一律平仓 + 新开仓 |
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

### 3.5 MultiSendCallOnly `0xA83c…1836`（v1.5.0）

不给角色授权，改由 Roles owner 注册 `setTransactionUnwrapper(0xA83c…1836, 0x8d80ff0a, 0xB4Cd…efD)`：外层 delegatecall 被拆开，内层每笔按 3.1–3.4 校验，内层 delegatecall 一律不允许。常用批次：`decreaseLiquidity + collect + burn`（平仓）、`approve + mint`、`NPM.approve + gauge.deposit`。

v1.5.0 的 MultiSendCallOnly 会把内层 `to = 0` 改写为 Safe 自身，而 Roles 按 `0x0` 判权限。因此任何授权都不能指向零地址：配置校验与批次生成都拒绝零地址，分叉验收断言内层 `to = 0` 调 `enableModule` 被拒。

## 4. 池与兑换白名单（初始）

| 用途 | token0 / token1 | tickSpacing | 池 / gauge |
| --- | --- | --- | --- |
| 奖励卖出（swap） | AERO → USDC | 200 | `0xD0Ac…6816` / `0x4A3B…60D5` |
| 做市池 | 待定：由 Aero 市场页的推荐结果选出后逐个加入（`config.example.json` 与 fork 验收用 RSGP/USDC ts100 作示例） | | |

加池由管理钱包签一笔 Safe 交易，同时更新：NPM `mint` 的池白名单 `Or`、新 gauge 目标、新代币目标、`NPM.approve` 的 gauge 列表、必要的兑换路径。bot 无权自行扩大白名单。工作台已能为任意 Aero CL 池生成这份差异批次（多个池子可合成一批），见 9.2。

## 5. 额度（Roles `WithinAllowance`）

- 每个代币一个额度键（实现为 `keccak256("aero-roles:turnover:" + 小写代币地址)`），mint 的 desired 金额与 swap 的 `amountIn` 共用同一个键，按 24 小时补充。池白名单的每个 `Or` 分支固定了代币地址，分支内的金额字段直接挂对应代币的额度键。
- `mint` 的 desired 是上限，实际投入可能更少，额度按 desired 扣，偏保守。
- `increaseLiquidity` 的参数里没有代币地址，无法按代币取额度键：首版不授权（已定），调仓一律"平仓 + 新开仓"。
- 补充规则：从部署时刻起每满 24 小时整段补满，不是滚动窗口；跨过补充时刻前后各花一次，短时间内最多用掉 2 × 日额度，第 6 节的损失上限按此计。
- 上限取预期日周转额的 2 倍左右；超限时 bot 交易 revert，策略停在当前状态，等管理钱包调额度或次日补充。
- 可选：`CallWithinAllowance` 限制每日 swap 笔数，防止"小额多次"消耗。

## 6. 剩余风险（bot 私钥泄露时）

| 风险 | 上限 / 缓解 |
| --- | --- |
| 白名单池内不利成交：swap 设 `amountOutMinimum = 0` 后被夹，或先操纵价格再 mint / decrease | 损失上限 ≈ 2 × 日额度 × 价格偏离（补充边界前后各用一次，第 5 节）；只放深池；出账与成交偏离告警。Roles v2 不能直接比对预言机价格，链上价格校验需另写自定义条件合约并审计，首版不做 |
| 打乱策略：反复开平仓、解押损失排放、`emergencyWithdraw` | 只损失收益和 bot 自己的 gas，本金仍在 Safe；发现后撤销角色 |
| bot EOA 里的 ETH | 只放够几天 gas 的量 |
| Roles 配置错误（例如漏了某个 `EqualToAvatar`） | 第 8 节的反向用例在 fork 上逐条验证后才启用；清单与配置从同一份 JSON 生成 |
| 协议侧 | NPM owner 只能改描述器；gauge 紧急模式由协议开关；CL 池带 MEV tax 模块（`0x29F1…9a4a`），对成交成本的影响待核实 |

## 7. 管理钱包操作（只由 Safe owner 签）

- 部署：在 Safe{Wallet} 用硬件钱包创建 1/1 Safe（v1.5.0 L2，选 Pay now 立即部署；界面默认带 CompatibilityFallbackHandler；gauge 解押用 `safeTransferFrom` 退回 NFT，没有 handler 时解押会失败）→ `node tools/aero-roles/cli.mjs plan` 链上核对并生成 Transaction Builder 批次 → 管理钱包在 Safe 界面导入、核对、签名。批次一笔完成：经 ModuleProxyFactory 部署 Roles 代理（owner / avatar / target = Safe）→ `enableModule` → 注册 MultiSendUnwrapper → 下发 scope 与额度 → `assignRoles(bot, [roleKey], [true])`。权限与额度由 `tools/aero-roles/permissions.mjs` 从配置 JSON 生成，不依赖 `zodiac-roles-sdk`；之后加池与调额度用工作台生成差异批次（9.2）；删池的差异批次尚未实现。
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

结果（2026-11-04，Base 区块 53534429，`node tools/aero-roles/fork-test.mjs`，anvil 只监听 127.0.0.1，Safe 由 v1.5.0 工厂创建）：72/72 通过。
- 配置为示例池 RSGP/USDC ts100 再加 AERO/USDC ts200，`mint` 与 `NPM.approve` 的条件是两分支 `Or`，两个分支都在链上执行过；另加只用于兑换的 WETH→USDC，WETH 只能授权给 Router，授权给 NPM 被拒（`ParameterNotAllowed`）。
- `plan` 通过真实 Safe 的核对，并拒绝：没有 fallback handler、owner 不是指定硬件钱包、已启用其他模块、设置了 guard 或 module guard（v1.5.0 新增，可拦截模块交易）、singleton 不是 SafeL2、代理字节码非标准、固定合约字节码被替换（后五项在分叉上改状态模拟，改完复原后 `plan` 再次通过）。另对用户在 Safe{Wallet} 建出的真实 1.5.0 Safe 只读运行 `plan`，核对全部通过。`factory.getPool` 与 `gauge.pool()` 不一致的拒绝路径没有分叉用例。
- 额度：多分支 `Or` 下链上只报 `OrViolation`，超额用例另断言本地在第几笔、因超额拒绝；同批两笔 300 USDC 合计超额前先模拟证明单笔 300 能通过。`Or` 分支扣额度后失败的回滚、同一笔内同一额度用两次、嵌套 `Matches` 的累计由单元测试覆盖。
- 部署批次经 MultiSendCallOnly 一次执行；Roles 实际地址与 `plan` 预测一致。
- 上列正向流程全部成功（两个池各开一仓、质押、两种 `claimEmissions`、解押、同批平两仓、AERO→USDC）；`mint` 按 `amount1Desired` 扣减额度；`claimEmissions` 到账的是 AERO。
- 上列反向用例与额外用例（非成员地址、Safe / Roles 自身函数、MultiSend 夹带禁止调用、同批两笔 mint 合计超额、已质押 tokenId 的 `decreaseLiquidity`、`claimReferralEmissions`、3 参数 `claimEmissions` 的外部 recipient）全部由 Roles 以写明的期望原因拒绝（`ConditionViolation` 的具体 status / `NoMembership` / `NotAuthorized`），不是下游合约自身失败；本地签名前校验对每个用例的结论与链上一致。
- 发现：经 Roles 执行兑换时，按 gas 估算值原样发送曾在链上 revert，加 30% 余量后通过（原因未确认）；执行器需给 gas 留余量。
- 未覆盖：真实硬件钱包签名与 Safe 界面导入批次（JSON 未带 checksum，界面会提示无法校验）、主网小额实测、链上额度跨日补充（本地折算公式有单元测试）。
- 登记（不影响安全）：calldata 里 int24 / uint160 带高位脏位时，本地按规范化值放行、链上按原始字比较拒绝；`plan` 只用一个 RPC，多 RPC 交叉核对由人工换 RPC 重跑。

## 9. 工作台侧改动

进度（2026-11-04）：执行器与读取已实现——交易 → Aero 实盘页（配置、bot 私钥、Safe 余额与额度、头寸解押/平仓/质押、领奖与卖出、手动兑换、交易记录），Aero 市场池详情页的「Safe 实盘开仓」面板按选定区间（默认推荐区间）预览后开仓并质押；首版只手动执行，自动调仓与下面的监控另立任务。AERO 奖励按已定方案自动卖成 WETH（AERO→WETH ts200 白名单路由）。

- 执行器：交易改为经 Roles 代理以 Safe 名义执行；签名前本地校验保留，与 Roles 配置读同一份白名单 JSON，作为第二道防线。批量调用必须用 `addresses.mjs` 的 `SAFE.multiSendCallOnly`（拆包器只注册在这个地址上）；SDK 默认的 MultiSend 可能是别的版本，用了会被 Roles 全部拒绝。
- 读取：持仓、质押、余额、估值改按 Safe 地址（`tokenOfOwnerByIndex(Safe)`、`gauge.stakedValues(Safe)`）。
- 监控：独立只读进程监听 Safe 的出账和 Roles 配置事件，非预期变化发飞书。`plan` 只在部署时核对一次 Safe 状态，之后的变化靠监控：Safe 至少监听 `EnabledModule`、`DisabledModule`（Roles 被移除只会停摆，不会失窃）、`ChangedGuard`、`ChangedModuleGuard`（v1.5.0 新增）、`ChangedFallbackHandler`、`AddedOwner`、`RemovedOwner`、`ChangedThreshold`；Roles 代理至少监听 `OwnershipTransferred`、`AvatarSet`、`TargetSet`、`EnabledModule` / `DisabledModule`（Roles 自身的模块列表）、`SetUnwrapAdapter`、`SetDefaultRole`、`AssignRoles`，以及范围与额度变更（`ScopeTarget`、`AllowTarget`、`RevokeTarget`、`ScopeFunction`、`AllowFunction`、`RevokeFunction`、`SetAllowance`）；事件名按 Sourcify 验证的 mastercopy ABI 核对。Safe{Wallet} 的部分功能（如 TWAP）可能把 fallback handler 换成 ExtensibleFallbackHandler，需要 owner 签名，但属于部署后的状态漂移。
- 工作台只保存 bot 私钥和 Safe / Roles 地址，管理钱包私钥不录入。

### 9.1 自动调仓（2026-11-05）

Aero → 配置 → 自动调仓，默认关闭；判定在 `server/automation/aero-auto.mjs`（纯函数），执行在 `server/automation/aero-safe.mjs`，每 30 秒检查一次，与手动操作共用串行任务队列，一次只做一件事。

- 对象：只管理已质押、流动性大于 0 的头寸。连续出区间满「出区间等待」（默认 5 分钟）后：核对 TWAP → 解押 → 平仓 → 卖出 AERO（池子本身含 AERO 时不卖，收回的 AERO 是本金）→ 以现价为中心、按原格数重开（需要时先配平兑换）→ 质押。
- 投入量：只投入这次平仓前后 Safe 余额的增量（含卖出 AERO 所得），Safe 里原有的其他余额不动。Roles 没有授权 `increaseLiquidity`，所以调仓是平仓 + 新开仓，新头寸 tokenId 不同。
- 防操纵：执行前读池子 `observe([twapSeconds, 0])`，现价偏离 TWAP 超过上限（默认 5 分钟、1%）本轮不动，只写提示，下一轮再看；观测槽少于 2 个或历史不足窗口时同样不动。平仓前、重开前各核对一次。
- 节流：同池冷却（默认 30 分钟）、24 小时最多次数（默认 6）、提前解押罚没期内等待（可选「罚没期内也解押」）、预估今日额度不够重开时不平仓。
- 单池上限（2026-11-06）：按占总资产的比例限制每个池子，「单池上限（占总资产 %）」是默认值（100% 即不限，也是出厂值），各池可单独填写，留空用默认值。配置里存为基点：`poolCapBps` 与 `poolCaps`（`{ 池子地址小写: 基点 }`，最多 50 个）。
  - 估值：价格取「行情」扫描的 Base 代币美元价（`aeroMarket.tokenPrices()`，与页面估值同源）。总资产 = Safe 白名单代币余额 + 全部头寸（含已结算、未领取的手续费），不含未领 AERO 排放与 bot 的 gas ETH。本池以外的代币缺价时按 0 计（总资产偏小、上限更严），拦截说明与缩减事件里列出这些代币。
  - 判定：重开后本池全部头寸不超过总资产 × 上限。平仓前，本池其他头寸已占满，或剩余空间不到这次可重开价值的 10% 时不平仓（免得平掉大头寸只开出一点），额度预估也按缩减后的数量计算。重开前再读一次链上状态核对，超出部分两币等比缩减，余下的币留在 Safe；调仓记录标 `capped`（兑换后重试也保留，记在 `reopen.capped`），事件 `auto_pool_capped`。
  - 不猜：设了上限的池子在以下情况下不平仓：行情关闭、行情超过 60 分钟未更新、缺本池代币价格、余额或头寸数量没读到。已平仓待重开时遇到这些情况：保留待重开，状态里写明原因，等情况恢复再重开，不启动注定失败的任务；重开时读链失败也只是下一轮重试（错误码 `cap`），不停用。重开前发现本池已满或剩余空间不到 10%（例如期间手动加了仓）：停用，币留在 Safe，调高上限后重新启用，或放弃待重开记录。
  - 已知局限：Safe 持有的头寸超过扫描上限（`MAX_OWNED_SCAN` 40 个）时，未扫到的头寸不计入总资产和本池已有部分，本池估值可能偏小。
  - 回滚：上限为默认值时不写入 `auto.json`，旧版本照常读取。设过上限后回退到旧版本时，旧版本拒绝未知配置项，会因 `auto.json` 不合法而停用；回退前先在页面把上限恢复为 100% 并清空各池设置，或手动删掉这两项。
- 进度落盘（`aero-safe/auto.json`）：
  - 平仓前写入调仓记录和 `closing`，写不进去就不平仓。平仓时一笔都没签名就失败（例如维护）：撤回这条记录，不计次数和冷却。签过名后失败：保留 `closing` 并停用；链上可能已解押或已平仓，系统不自动续做。
  - 平仓后按余额增量写 `reopen`。卖 AERO 只卖这次平仓领到的数量，卖出所得确认后再计入。卖出签了名但结果未知：停用，待重开数量不含卖出所得。
  - 重开时：配平兑换确认后，把 `reopen` 改为兑换后的数量；兑换或开仓那一笔签名后、广播前，记下 `inflight`；开出新头寸后，记下 `minted`。
  - 重试按进度续做：已开出新头寸就只质押，不会再开一次；`inflight` 未落定时停用，不自动续做。
- 失败与重试：
  - 只有 TWAP 未通过、或工作台进入维护/隔离而在签名前中止，并且进度都已落盘、没有需要人工核对的记录时，才下一轮重试。其他任何错误都停用。
  - 工作台在 `closing` 或 `inflight` 状态下重启：直接停用，并写明要核对什么。
  - 调仓任务执行中，更新停机（`prepareStop`）一律拒绝，等任务在下一次签名前因维护停下。
- 人工核对：`closing` 或 `inflight` 存在时不能重新启用。核对 Safe 头寸和余额（未质押的头寸可手动平仓或质押）后，在「配置 → 自动调仓 → 放弃这条记录」清掉记录（`POST /api/automation/aero-safe/auto/discard`），再重新启用。待重开记录也可以放弃，例如这些币已经手动用掉。
- `auto.json` 读不出、或记录不合法（包括停用记录缺原因）时停用，并拒绝保存，需核对 Safe 头寸后删除该文件。
- 紧急停止：在配置里关闭；不依赖服务器的办法仍是第 7 节撤销角色。
- 分叉演练：`node tools/aero-roles/fork-rebalance.mjs`。2026-11-05 Base 区块 53541867 附近，WETH/USDC ts100，13/13 通过：手动开 2 格窄区间（投入一半余额）并质押；外部大额卖出把价格推出区间后，现价偏离 5 分钟 TWAP 3.3% 时不动；推进链上时间让 TWAP 追上后自动调仓，旧 NFT 销毁、新头寸居中同宽并已质押、Safe 原有的另一半余额没被投入、`auto.json` 落盘且无待重开、全部交易确认、新头寸在区间内不再触发。
- 已知局限：
  - 配平兑换按现价估算，兑换本身挪动价格后会有尾差留在 Safe。演练中窄区间、价格靠近区间边沿时，约 5% 的价值（231 USDC）没被重投；之后的调仓也只投入平仓所得，不会把这部分尾差重新投进去。
  - 停用时没有飞书即时提醒，只在页面显示；飞书汇总暂未包含 Aero 实盘。
  - 主网小额实测未做。

### 9.2 白名单变更：任意池加池、调额度（2026-11-05）

入口：
- Aero「行情」池详情页（Base 池）：不在白名单的池子在「Safe 实盘开仓」面板里加入待加池；
- Aero「配置」→ 白名单变更：调整已有代币的每日额度，查看、移出待加池，生成批次、核对启用；
- 行情列表里，已在白名单的池子标「已加池」，在待加池里的标「待加池」。

待变更存在 `aero-safe/changes.json`（重启后仍在），包括待加池（可多个）与额度调整。所有待变更合成一份批次，因为 `scopeFunction` 整体替换函数条件：各自从配置出发生成的批次会互相覆盖 `NPM.mint` 的池 `Or`、`NPM.approve` 的 gauge 列表和兑换 `Or`。上一版的单个加池计划 `pool-plan.json` 启动时转成待变更（连同批次）后删除；这类旧批次没有记录 Safe 与 Roles 地址，一律作废，须重新生成。

- 加入待加池（`POST /api/automation/aero-safe/changes/pool`，`{ pool, allowances: { 代币地址: 每日数量 } }`）：
  - 先链上核验池子（`executor.inspectPool`，与 `cli.mjs plan` 的池子核对相同）：
    - 池子由 CL 工厂按 (token0, token1, tickSpacing) 登记；
    - 有 gauge，没有 gauge 的池子拒绝；
    - gauge 是已审实现的 EIP-1167 克隆，与池子互相指向，NFT 与 voter 是固定地址。
    - 代币和 gauge 不能是 Safe、Roles、固定的协议合约，也不能与已有目标重合（同一地址出现两次时，后下发的 `scopeFunction` 会覆盖前一个）；`buildPermissions` 对所有配置都做这项检查。
  - 配置和其他待加池里都没有额度的新代币必须填每日额度，页面按约 1000 美元预填；也可顺带填这两个代币的已有额度。已在白名单、已在待加池、或同代币对同 tickSpacing 已在待加池的拒绝；合成后条件树超限返回 409「白名单已满」，不加入。
- 调额度（`POST /changes/allowances`，`{ allowances: { 代币地址: 每日数量 | null } }`）：已有代币改回配置值或传 null 即撤回；待加池新代币的额度只能改，不需要时移出对应池子。
- 移出待加池（`POST /changes/remove`，`{ pool }`）：只有它用到的新代币额度一并移除。全部放弃：`POST /changes/clear`。
- 合成规则（`applyChanges`）：依次加池子，该代币对两个方向没有兑换路径时按本池 tickSpacing 补上（已有路径沿用）；再按待改额度替换已有值或追加新代币。配置变化后（保存、启用）自动去掉已生效的项：已进白名单的池子、与配置相同的额度、待加池移出后孤立的新代币额度。
- 生成批次（`POST /changes/batch`）：`buildUpdateBatch` 比较配置与合成后的权限，只生成差异：
  - 新目标：`scopeTarget` 加全部函数；
  - 已有目标上条件变化的函数：重下 `scopeFunction`（整体替换）；
  - 新额度与改动的额度：`setAllowance(key, perDay, perDay, perDay, 86400, 0)`，执行后当天可用额度按新值计满（调低也一样）；未改动的额度不重下。
  - 减少权限（删池、删路径、删额度）一律拒绝。
  - 批次冻结存入 `changes.json`，返回 Transaction Builder JSON；不改配置、不签名。已有未启用批次时再生成会提示：旧批次如已执行应先核对启用，否则新批次会重复其中的额度设置。页面把冻结内容与最新草稿分开显示：生成后新增的变更不进这份批次，启用后继续保留，可再生成下一份；生成后从草稿撤回或改了值的池子与额度单独警示，已生成的批次文件仍包含它们，在 Safe 执行仍会生效，不想执行须重新生成并只执行新文件。
- 执行：页面下载 JSON，在 Safe{Wallet} → Transaction Builder 导入，核对后用硬件钱包签名执行。同一批次只执行一次：重复执行会把相关代币当天的额度重置为满额。
- 启用（`POST /changes/apply`）：只核对冻结的批次，全部通过才并入配置。以 bot 身份 `eth_call` `Roles.execTransactionWithRole(…, shouldRevert = true)`，金额一律为 0，不动资产。逐项核对：
  - 新池 `mint`、`NPM.approve → 新 gauge`；
  - 新 gauge 的 5 个函数；
  - 新兑换路径；
  - 新代币对 NPM / Router 的 `approve`。

  Roles 放行，或只是下游合约自身失败（`ModuleTransactionFailed`），算生效。`NPM.approve` 用链上已有的 tokenId 模拟，`CustomConditionViolation`（头寸不归 Safe）也算 gauge 参数已放行。新增与改动的额度直接读 `Roles.allowances`，补充量、上限和周期必须与批次一致。其他 Roles 拒绝、或非 Roles 原因的回滚都算未生效，配置不变。权限配置或 Safe/Roles 地址在生成后有变化、或批次没有记录目标地址时，批次作废，须重新生成。链上核对（加池的池子核验同理）在串行队列外等待，不挡自动调仓；回到队列后重新检查登录、维护、运行中的任务与未结清交易，并确认配置、批次与 bot 都没变，才写入配置。配置写入后 `changes.json` 写不进去时页面报告；重启后按配置认出已启用的批次（权限与目标都相同），不要求重新签名，之后排队的变更保留。
- 容量：Roles 每个函数的条件树最多 255 个节点。兑换 `Or` 每条路径 9 个节点，先用满：每加一个两边都是新代币的池子增加 2 条路径，按初始 3 条路径算，最多约 13 个池子。
- 分叉演练：`node tools/aero-roles/fork-add-pool.mjs`。2026-11-05 Base 区块 53550378，18/18 通过：
  - 从只含 WETH/USDC ts100 的 Roles 出发，把 WETH/cbBTC ts1 加入待加池并把 USDC 每日额度从 100 万调到 5000，合成 13 笔批次；
  - 拒绝没有 gauge 的 WETH/cbBTC ts50 和非池子地址；
  - 批次未执行时 13/15 项未通过；只差 USDC 调额度一笔时仍拒绝，配置不变；
  - 补执行后核对通过、并入配置（新池与 USDC 新额度）；
  - 投入上限 $100（WETH 按 $2000）只投 0.05 WETH；在新池经新路径 WETH → cbBTC 配平开仓、质押到新 gauge、平仓，cbBTC 回到 Safe。
- 多个待加池并行由单元测试覆盖（`tests/aero-safe.test.mjs`），分叉演练只加一个池。
- 未做：删池的差异批次；主网实测。

### 9.3 开仓投入上限（2026-11-05）

池详情页开仓表单可选填「投入上限（美元）」：先按投入比例取 Safe 余额，再按行情里两个代币的美元价估值，超过上限时两币等比缩小（`executor.capAmounts`）。页面把预览时的价格随开仓请求一起发送，执行时按同一价格重算，与预览的 1% 偏离检查一致。价格只用来缩小投入，不会让投入变多；行情缺少美元价时不能设上限。自动调仓只投入平仓收回的币，不受此项影响（自动调仓另有按总资产比例的单池上限，见 9.1）。链上兜底仍是 Roles 每日额度。

## 10. 待决策

1. ~~管理钱包形态~~：已定单个硬件钱包 1/1（2026-11-04）。硬件钱包丢失即失去 Safe 控制，助记词离线备份是唯一恢复手段；以后可由同一 Safe 加 owner 升级为多签，不需要迁移资产。
2. 首批做市池与每日额度。
3. ~~Aero LP 是否同步迁到 Safe + Roles~~：Aero LP 模块已移除（2026-11-05），Aero 只保留 Safe + Roles 一条执行路径。
4. ~~AERO 奖励处理~~：已定领取后自动卖成 WETH，低于最小卖出数量时留在 Safe（2026-11-04）。
