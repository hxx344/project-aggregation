# aero-lp：Aerodrome 单边 LP 自动调仓

在 Base 链 Aerodrome Slipstream（CL）池里用单一代币（池子的 token0，默认 RSGP/USDC 池里的 RSGP）挂单边流动性，并质押到 gauge 领取 AERO 排放：

- 区间下沿 = 当前价格上方 `gapBps`（默认 0.4%）后的第一个可用 tick，上沿固定为 `upperPrice`（默认 0.005）。
- 每 `intervalSec`（默认 600 秒）检查一次：
  - 价格在区间内或在区间上方：不动。
  - 价格跌到区间下方，且按新价格算出的下沿比现有下沿低（至少低一格）：撤出旧头寸（自动领取奖励），按新价格重新开单边区间并质押。
  - 价格仍在区间下方但新下沿没变低：不动。每跌出一个新格最多调仓一次，不会来回刷手续费。
  - 钱包里新增的代币（超过 `keepInWallet + minDeploy`）会按当前价格另开一个头寸，不论现有头寸是否在区间内。
- **防砸盘保护：** 现价比最近 `twapSec`（默认 15 分钟）的 TWAP 低超过 `maxTwapDeviationBps`（默认 3%）时，本轮不下移区间、也不新开仓，只记日志；等价格回到 TWAP 附近或 TWAP 跟上来再调。读不到 TWAP（例如池子观测记录不够覆盖窗口）时同样暂缓。持续快速下跌时调仓会因此滞后。这个保护只挡住瞬间砸盘：有人分多次、每次压在阈值内慢慢砸，区间仍会被一步步带低。

## 在工作台中使用（推荐）

工具已内置工作台，随工作台统一更新。从侧栏 **交易 → Aero LP** 打开：

1. **钱包私钥**：填入后点「保存私钥」。私钥用工作台的凭据密钥（`DATA_DIR/credentials.key`）加密保存在 `DATA_DIR/aero-lp/wallet.json`，页面和接口只返回钱包地址；启动时经进程间通道交给调仓进程，不进命令行参数、环境变量或日志。更换或清除私钥前需先停止。
2. **调仓参数**：页面列出全部参数（含 RPC 与合约地址），保存时服务端按下表范围校验。运行中保存会**立即**按新参数开始一轮检查；改了 RPC、池子、代币、工厂或 NFT 合约时自动重连并重新核对合约。
3. **启动 / 停止**：默认停止。启动后关闭页面或单独重启 API 不影响运行；工作台重启后保持上次的启停选择。停止时等当前一轮交易完成再退出，最多等 90 秒，超时强制结束（可恢复，见「异常处理」）。
4. **状态**：页面每 5 秒刷新现价、TWAP、目标区间、头寸、钱包余额、本轮动作和最近 50 条事件；完整日志在 `DATA_DIR/aero-lp/events.jsonl`（超过 2MB 轮转为 `events.1.jsonl`）。
5. **更新维护**：工作台进入更新维护时，调仓进程照常检查但不发交易，维护结束后恢复。进程意外退出时按 1/2/4/8/16 秒重启，连续失败后显示异常，需手动重新启动。

工作台和下文的命令行方式都会占用 `run-<钱包地址>.lock`，但锁只在同一数据目录内有效：**同一钱包不要同时在工作台和命令行里运行。**

## 先了解的几件事

- **单边区间在价格上方时不赚 AERO。** gauge 只给「已质押且价格在区间内」的流动性发排放。下沿在现价之上，意味着头寸刚建好时就处于区间外；要等价格涨进区间才开始计奖励。价格涨进区间后，你的 RSGP 会逐步卖成 USDC。
- **价格只能按格移动。** 本池 tickSpacing = 100，每格约 1%。下沿会落在 `现价 × (1 + gapBps)` 之上的第一个格点，所以实际间距在 0.4%～1.4% 之间；价格跌到让下沿能再降一格时才调仓（刚开仓后最快只差 1 个 tick 就会触发第一次）。
- **上沿取最近格点。** 0.005 对应的最近格点是 tick −329300，约 0.005005。日志里显示的上沿就是这个值。
- **奖励领取。** 撤出头寸时 gauge 自动把累计奖励（xAERO，可 1:1 赎回 AERO）发到钱包；不撤出时奖励留在 gauge 里，可以在 Aerodrome 页面上领取。质押期间头寸不赚交易手续费。
- **提前撤出罚金。** 每轮都会读取 gauge 工厂的 `effectivePenaltyConfig`。罚金窗口内需要调仓时只记日志，等窗口过后再撤；目前 Base 上的配置是没有罚金窗口。
- **按上沿识别头寸。** 本钱包在本池里上沿等于配置上沿的头寸都会被调整（包括手工开的），上沿不同的头寸只在日志里列出。
- **质押失败不阻断。** gauge 停用等原因导致质押失败时只记 `stake_failed`，撤仓与开仓照常；头寸保持未质押，下一轮再试。

## 命令行使用

不经工作台也可以直接运行，下面几节说明命令行方式的配置与私钥来源。

### 安装与准备

需要 Node 24.15.0 以上，并在仓库根目录执行过 `pnpm install`（ethers 随根目录依赖安装）。

```bash
cd tools/aero-lp
cp config.example.json config.json      # config.json 已被 git 忽略
mkdir -p ~/.config/aero-lp
( umask 077; printf '%s\n' '0x你的私钥' > ~/.config/aero-lp/key )   # 必须是 600 权限，否则拒绝读取
```

也可以不用文件，改用环境变量 `AERO_LP_PRIVATE_KEY` 提供私钥；两者都有时以环境变量为准。程序从不打印私钥。建议用一个只存放本策略资金的专用钱包，并留少量 ETH 支付 gas（每次调仓约 4～6 笔交易）。

### 命令

```bash
./lp status            # 只读：价格、目标区间、头寸、将执行的动作（不发交易）
./lp once --dry-run    # 同上
./lp once              # 执行一轮
./lp run               # 每 intervalSec 循环一轮；Ctrl+C / SIGTERM 等当前轮结束后退出
./lp run --config /path/to/other.json
```

没有私钥时做只读检查，需要在 config 里填 `address`。

日志按行输出 JSON，同时追加到 `dataDir/events.jsonl`。会发交易的命令（`run`、不带 `--dry-run` 的 `once`）都要先拿 `dataDir/run-<钱包地址>.lock`，同一钱包同时只有一个进程发交易；多份配置共用一把私钥时必须共用 `dataDir`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `rpcUrl` | `https://mainnet.base.org` | Base RPC，必须是 https，启动时核对 chainId；请求超时 20 秒，读请求最多尝试 3 次 |
| `pool` | RSGP/USDC CL 池 | Slipstream 池地址；启动时校验工厂、gauge 和 token0 是否匹配 |
| `factory` | `0x9cb2…7a76` | Slipstream 池工厂，必须与池子的 `factory()` 一致 |
| `nft` | `0x4857…c60b` | 头寸 NFT 管理合约，必须与 gauge 的 `nft()` 一致；代币只授权给它 |
| `gauge` | `0x77e3…72b1` | 质押用的 gauge，必须与池子的 `gauge()` 一致；NFT 只授权给它。授权对象由配置固定，RPC 返回不同地址时拒绝连接 |
| `token` | RSGP | 必须是池子的 token0（单边投入的币） |
| `token1` | USDC | 池子的 token1；开仓按 (token0, token1, tickSpacing) 定位池子，三者都由配置固定 |
| `tickSpacing` | `100` | 池子的格点间距，必须与池子一致 |
| `upperPrice` | `0.005` | 固定上沿，单位为 token1/token0（USDC/RSGP） |
| `gapBps` | `40` | 下沿至少高于现价多少（万分比） |
| `intervalSec` | `600` | 检查间隔（秒），10–86400；公共 RPC 建议不低于 10 秒 |
| `twapSec` | `900` | 防砸盘保护的 TWAP 窗口（秒），0 表示关闭，最大 3600；本池观测记录约覆盖 30 分钟，窗口过长会读不到 TWAP |
| `maxTwapDeviationBps` | `300` | 现价低于 TWAP 超过这个幅度（万分比）时暂缓调仓 |
| `slippageBps` | `50` | 撤出与开仓的最小到账保护 |
| `keepInWallet` | `"0"` | 钱包里保留不投入的 token0 数量 |
| `minDeploy` | `"1000"` | 可投入余额低于这个数量时不新开头寸 |
| `minEthForGas` | `"0.0002"` | ETH 低于这个值时只记日志，不发交易 |
| `keyFile` | `~/.config/aero-lp/key` | 仅命令行：私钥文件 |
| `address` | `null` | 仅命令行：只读模式用的钱包地址；有私钥时必须与私钥地址一致 |
| `dataDir` | `~/.local/share/aero-lp` | 仅命令行：日志与锁目录 |

## 异常处理

- 每笔交易先在本地签名并记录哈希（`tx_signed`），再广播；只发一次，等 1 个确认，最长 180 秒。失败、回滚或超时都会结束当前轮，不重发；下一轮重新读链上状态再决定。中途中断留下的「已开但未质押」头寸会被补质押，空头寸会被销毁。
- 钱包有未确认交易（pending nonce 大于 latest）时，本轮不发交易。
- 开仓前会再读一次价格并重算下沿，用 `staticCall` 预演；预演结果需要 USDC 或流动性为 0（价格已进入区间）时放弃开仓，资金留在钱包，下一轮再试。

## 后台运行

```bash
nohup ./lp run >> ~/.local/share/aero-lp/stdout.log 2>&1 &
```

或者用 systemd 用户服务（`~/.config/systemd/user/aero-lp.service`）：

```ini
[Unit]
Description=aero-lp single-sided LP rebalancer

[Service]
WorkingDirectory=%h/project-aggregation/tools/aero-lp
ExecStart=%h/project-aggregation/tools/aero-lp/lp run
Restart=on-failure
RestartSec=60
TimeoutStopSec=900

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now aero-lp
journalctl --user -u aero-lp -f
```

## 停止与回退

停掉进程即可（`kill <pid>` 或 `systemctl --user stop aero-lp`）。收到停止信号后会等当前一轮结束再退出，一轮调仓最长可能要几分钟；systemd 默认 90 秒后强制结束，建议在服务里加 `TimeoutStopSec=900`。被强制结束时可能留下未质押的头寸或钱包里的代币，下次启动会自动补质押或重新开仓。

头寸会留在链上，可以在 Aerodrome 页面上手动领奖、撤出或调整。
