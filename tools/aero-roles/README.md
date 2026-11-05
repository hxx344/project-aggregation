# aero-roles：Aero 实盘的 Safe + Zodiac Roles 权限工具

资产放在 Safe（owner = 你的硬件钱包，1/1），服务器上的 bot 钱包只是 Roles 模块里的一个角色，只能调用白名单里的合约、函数和参数。设计与理由见 [`docs/aero-safe-roles-permissions-2026-11-04.md`](../../docs/aero-safe-roles-permissions-2026-11-04.md)。

本目录只生成和验证配置，**不签名、不发交易、不接触任何私钥**；工作台执行器尚未接入（文档第 9 节）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `addresses.mjs` | Safe、Roles v2、Aero Slipstream 的固定地址（只从这里取，不信任 RPC 或配置） |
| `permissions.mjs` | 配置 JSON → 角色权限（链上 Roles 配置与本地校验的唯一来源） |
| `conditions.mjs` | Roles 条件树的构造、展平与本地求值 |
| `roles-calls.mjs` | 部署批次、Transaction Builder JSON、bot 执行时的编码 |
| `policy.mjs` | 签名前本地校验（第二道防线） |
| `executor.mjs` | 工作台执行器：按 Safe 读状态，经 Roles 配平兑换、开仓质押、解押平仓、领奖卖出；签名后先落盘再广播 |
| `cli.mjs` | `plan` 命令：链上核对并生成部署批次 |
| `fork-test.mjs` | Base 分叉验收（正向流程 + 全部反向用例） |
| `config.example.json` | 示例配置；池子与额度是示例值，首批做市池与额度尚待决定 |

## 部署步骤（主网，等执行器接入后再做）

1. 在 Safe{Wallet}（app.safe.global，Base 网络）用硬件钱包创建 Safe：1 个 owner、阈值 1，激活方式选 Pay now（立即部署上链；Pay later 要等第一笔交易才部署，`plan` 无法核对）。界面建出的是 v1.5.0 L2，自带 CompatibilityFallbackHandler（必需）。不要启用其他模块、guard 或 module guard。
2. 准备 bot 地址：一个全新的、只用于此 Safe 的 EOA，不能是 Safe owner。
3. 复制 `config.example.json`，改成实际的池子、兑换路径和每日额度（`perDay` 用代币最小单位，例如 1000 USDC = `1000000000`）。
4. 生成批次（只读链）：

   ```bash
   node tools/aero-roles/cli.mjs plan --config my-config.json --safe <Safe 地址> --owner <硬件钱包地址> --bot <bot 地址> --out batch.json [--rpc <可信 RPC>]
   ```

   命令阻断以下任何一项不符：Safe 地址是标准 SafeProxy 1.5.0 字节码、指向 v1.5.0 SafeL2（核 singleton 存储槽）、唯一 owner 是 `--owner` 且阈值 1、没有任何已启用模块、没有 guard 和 module guard、fallback handler 正确；Roles / MultiSend / 拆包器 / 自定义条件 / Aero NPM、Router、工厂、Voter、gauge 实现等固定合约的字节码哈希；每个池子与 gauge 的链上关系（gauge 是已审实现的克隆，`pool.gauge()`、`factory.getPool()` 互相对应）和代币符号。不符就不输出文件。终端打印的 Roles 地址与每笔交易说明用于下一步核对。

   gauge 与代币地址来自配置，真伪靠 RPC 读回的数据判断：用你信任的 RPC（默认 `mainnet.base.org`），有疑问时换一个 RPC 再跑一次，两次输出应一致。
5. 在 Safe 界面 → Apps → Transaction Builder 导入 `batch.json`。界面会提示批次没有 checksum、无法校验，这是预期的；逐笔核对目标地址与终端输出一致后，用硬件钱包签名执行。
6. 紧急停止：在 Safe 里执行 `assignRoles(bot, [roleKey], [false])`，或 `disableModule` 移除 Roles 模块。两种方式都是一笔交易生效，不依赖服务器。

## 验证

```bash
node --test tests/aero-roles.test.mjs          # 单元测试，不联网
PATH=$HOME/.foundry/bin:$PATH node tools/aero-roles/fork-test.mjs   # 需要 anvil；分叉 mainnet.base.org，只监听 127.0.0.1
```

分叉验收在示例配置上再加一个 AERO/USDC 池（让 mint 与 NPM.approve 走多分支 Or）和一条只用于兑换的 WETH→USDC，建一个 1/1 Safe，执行与 `plan` 相同的批次，再以 bot 身份跑完整流程和文档第 8 节的反向用例。每个反向用例写明期望的 Roles 拒绝原因，原因不符即失败；本地校验结论必须与链上一致。

## 已知限制

- 未授权 `increaseLiquidity`：调仓一律平仓后新开仓。
- 额度按 `mint` 的 desired 金额和 `swap` 的 `amountIn` 扣减，从部署时刻起每满 24 小时整段补满（不是滚动窗口）：跨过补充时刻前后各花一次，短时间内最多可用 2 倍日额度。本地校验按批次累计消耗，可用额度用 `accruedAllowance` 按同一规则折算；不提供额度读数时判为不通过。
- 经 Roles 执行时 gas 要比估算值多留余量（验收中按估算值原样发送的兑换曾 revert）。
- 修改池子或额度的差异批次尚未实现；目前只支持首次部署。
- 执行器的交易截止时间取链上最新区块时间与本机时间的较晚者 + 600 秒；兑换与 mint 的最小成交量 = 以 Safe 身份 `eth_call` 报价 × (1 − 滑点)。
- 提前解押罚没期（`gaugeFactory.effectivePenaltyConfig`）内的解押/平仓须在页面确认接受罚没，否则不签名。
- `executor.mjs` 与它依赖的 `addresses`、`conditions`、`permissions`、`policy`、`roles-calls` 随工作台运行时打包（`deploy/package-release.py` 的 `AERO_ROLES_RUNTIME_FILES`）；`cli.mjs`、`fork-test.mjs` 与文档不进发布包。
