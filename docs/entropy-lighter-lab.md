# Entropy / Lighter 24 小时行情研究工具

工具已内置到工作台，用于持续采集公开盘口，研究 SNDK、ANTH 的真实价差、Binance 行情之后的跨所价格变化，以及延迟对 taker 成交结果的影响。默认只采集；不需要 API Key，没有下单、签名、转账或自成交功能。

工作台运行时管理采集进程，网页沿用工作台登录。采集不依赖浏览器保持打开；单独重启工作台 API 或更新页面时仍继续运行。代码随工作台统一发布，源码构建和预构建运行包均包含工具，不需要另装服务。

## 从工作台运行

服务器更新工作台后，从侧栏 **监控 → Entropy / Lighter** 打开研究页面。首次默认启动持续采集，可在页面查看运行状态、盘口统计、报告与图表，也可停止、启动或修改配置。停止选择会保存，工作台重启后不会擅自重新启动已停止的采集。

尚未安装或需要更新工作台时，在 Ubuntu 24.04 LTS x64、systemd 服务器执行统一命令：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash
```

重复执行增量更新并保留已有配置与数据。研究代码变化会更新并重启工作台运行时；仅 API 或工作台页面变化时，复用运行时，采集继续。无变化时跳过依赖安装、构建和服务重启。运行数据位于 `DATA_DIR/entropy-lighter`，默认是 `/var/lib/project-aggregation/entropy-lighter`，与运行代码的发布目录分开保存。

如果以前安装过独立 `entropy-lighter-lab` 服务，先停用旧服务及其开机启动，避免两套采集同时运行：

```bash
sudo systemctl disable --now entropy-lighter-lab
```

工作台不会自动迁移独立服务的 `/etc/entropy-lighter-lab/config.json` 或 `/var/lib/entropy-lighter-lab`。[独立安装器](../deploy/install-entropy-lighter-lab.sh)保留为可选 CLI 运行方式；工作台入口与统一更新不依赖它。离线启动也有本地心跳，进程存活与交易所行情有效分别判断。

本地研究或短时诊断仍可直接使用 CLI（Node 24.15+）：

```bash
node tools/entropy-lighter-lab/cli.mjs check
node tools/entropy-lighter-lab/cli.mjs run --duration 60
node tools/entropy-lighter-lab/cli.mjs report
```

不指定 `--duration` 就持续运行。数据默认写 `.data-entropy-lighter`；每个进程只允许独占一个数据目录。`--duration` 为 1–86400 秒，可用于服务器短时诊断。

## 已核实的市场与成本

以下为 2026-10-26 查验结果，程序运行时重新读取市场目录，不固定 Lighter market ID。

| 研究标的 | Entropy | Lighter | Binance，只研究领先信号 |
| --- | --- | --- | --- |
| SNDK | `io:SNDK` | `SNDK`（本次 ID 139） | `SNDKUSDT` |
| ANTH | `io:ANTH` | `ANTHROPIC`（本次 ID 193） | `ANTHROPICUSDT` |

[Entropy 是 Hyperliquid HIP-3 的 io 市场](https://docs.entropy.io/about-entropy/readme)。公开信息读取用 Hyperliquid `/info`，WS 用 `l2Book` 的 `fast:true` 完整快照。Lighter 用官方 `orderBookDetails` 和 WS `order_book`，按 `begin_nonce == previous nonce` 校验增量连续性，缺口立即失效并要求新快照。Binance 用完整 top-20 部分深度帧，不把它误当作可直接拼接的增量。

[Lighter Standard](https://apidocs.lighter.xyz/docs/account-types) 当前普通 taker 零手续费，固定 taker 等待 300ms。该等待不包含全部网络、服务端处理和回报时间；本工具配置的 Lighter 延迟不得低于 300ms。Plus/Premium 的费率不同，换 tier 后必须修改参数。本工具只按普通 taker 研究，不使用 maker 或 TWAP。

[Entropy 费率](https://docs.entropy.io/equity-perp-mechanics/fees) 随 HIP-3、growth mode、账户费档等变化。当前两市场返回 growth mode enabled；公开默认档的计算例子为 `0.090% × 0.1 = 0.009% = 0.9 bps`，这不是对你账户实际收费的确认，前端 builder 费用也可能影响实付。因此默认 `entropyTakerFeeBps: null`，模拟需先填入实际总费率。`1 bps = 0.01%`。

110%–120% 返佣暂按用户提供的假设计算，尚未取得资格、计费基数、上限、结算周期与领取条件。若实际费率为 `f`、返佣比例为 `r`，单次 Entropy 成交额的净补贴仅为 `f × (r−1)`。例如 `f=0.9 bps` 时，单次仅补贴 `0.09–0.18 bps`；Entropy 开平两次合计 `0.18–0.36 bps`，很容易被价差、滑点与延迟吃掉。不可仅因有返佣提高周转。

## ANTH 必须先核对合约等价性

[Entropy 预 IPO 规则](https://docs.entropy.io/market-types/pre-ipo-perpetuals) 明确每个价格单位代表公司 10 亿美元市值，IPO 后继续市值永续。[Lighter 预 IPO 规则](https://docs.lighter.xyz/trading/real-world-assets-rwas/pre-ipo-markets) 使用内部定价，IPO 后转换规则不同。Binance 也有独立的预 IPO 合约调整规则。

同一家公司、相近价格和 multiplier=1，不能证明终局结算等价。本次短时样本中 ANTH 约有 2% 基差；这只是某个时点的研究观察，不能作为套利收益或未来收敛承诺。ANTH 默认只采集。SNDK 虽同为 SanDisk 股价，也须考虑开闭市、预言机和资金费差异。

## 报告怎么看

- `counts`：实际收到的盘口数量、信号数量、拒绝原因、断线/缺口次数。
- `basis`：Entropy mid / Lighter mid − 1 的接收时间观测，单位 bps；不是可成交收益。每条 `spread` 还保留 bid/ask 可见 taker 价差与时间质量。
- `leaderMarkouts`：Binance 在 250ms 内至少变动 2 bps 后，观察 Entropy/Lighter 在 100/300/500/1000/2000ms 的同方向收益。使用同一进程的接收单调时钟，只比较各市场相对变化，不假设 USDT=USDC。它是条件观测，不证明因果领先，也未自动用于交易信号。
- `diagnostics.rttMs`：各接口最近最多 1000 次公开 HTTP 或 WS ping/pong RTT 样本；`eventLoopDelayMs` 是采集进程阻塞分位数。两者均不等于下单延迟。
- `paper`：每组延迟假设下的完成笔数、亏损笔数、已知费用、Entropy/Lighter 各自开平累计名义成交额、返佣前净额及返佣情景。不同延迟情景互斥，不能把成交量和利润相加。
- `openPaperTasks`、`unresolved`：未完成或无法估值的纸面敞口。有这些状态时，该情景总净额为 `null`，已完成部分另列 `settledNetBeforeRebate`；已知手续费仍保留。

`events-*.jsonl` 保存原始帧、标准化盘口、目录、信号、每腿模拟成交、失败与结束报告，可离线重新研究。`report.json` 每 5 秒更新当前 session 汇总；`status.json` 是轻量心跳。默认最多约 2 GiB 行情文件、7 天保留上限；哪个先触发就先删除最旧的工具日志，不能理解成一定保存足 7 天。每段约 8 MiB，磁盘不足或写入失败会停止运行。该限额不清理用户其他文件。

交易所 source timestamp 与本地时间可能偏移。[Lighter 官方](https://apidocs.lighter.xyz/docs/timestamps) 明确说明执行时间与 API 帧时间不是同一时钟。本工具保存原始值、`sourceClockDeltaMs` 和 `sourceClockUncertain`。研究模式可以显示标明质量的接收时间观测；模拟仍拒绝缺失、过期或超前的来源时间。应在东京服务器上保持 NTP 同步，并观察偏差，不能把直接相减的时间当作订单耗时。

## 可选纸面基线

完成合约核验并确认账户实付费率后，在工作台页面修改配置：`simulation.enabled=true`、`verifiedSymbols=["SNDK"]`、`entropyTakerFeeBps=实际总费率bps`。保存后按页面状态启动采集。CLI 使用者可先运行 `check --config /absolute/path/config.json`，再重启相应采集进程。ANTH 默认保持未核验状态。

基线只用于检验价差是否经得住执行：同数量两腿 taker 开仓，固定持有默认 5 秒，然后 taker 平仓。开仓门槛要求扣除开平四次手续费、滑点和资金费准备后仍有额外安全边际；不把返佣作为入场依据。它不是经过验证的最优退出策略，也不保证每笔赚钱。

数量按两市场都接受的步长向下取整，并检查最小数量、最小名义金额和单位倍率。每腿只有在其延迟到达之后新收到的盘口上才可能成交，吃足可见深度并加入滑点；不回用触发时价格、不假设隐藏深度。模型是全成或不成的纸面 IOC，未模拟真实部分成交、撮合队列、对手方撤单或市场冲击，因此成交量仍是研究代理值。每个标的每组情景最多一个在途任务，结束后冷却，不能重复累加同一盘口的机会。

两腿独立生效。一腿失败会记录失败并尝试平掉已成交腿；退出行情缺失或深度不足会留下未知敞口、阻断该标的后续模拟。手续费、滑点计入逐笔结果；资金费仅扣配置的保守准备金，不宣称是实际资金费结算，也不包含杠杆、清算、保证金和融资模型。

默认延迟为 Entropy 200 / Lighter 450ms 和压力情景 500 / 800ms，均为未实测假设。东京服务器采集的行情 RTT 用于诊断，实际下单 submit→ACK、submit→fill、失败重试和对冲完成时间仍需以后从正常真实成交记录测量。先看 24–72h 样本中的价差寿命和压力情景结果，再决定是否开发实盘；本首版没有实盘开关。

崩溃/重启时，未清洁结束的 paper session 或未决任务会使新进程降为只采集，最初报告保存在 `unresolved-paper.json`，后续重启不会覆盖。先停止采集并复核该报告；需要新的独立实验时使用新的数据目录，旧数据保留。正常独占锁会自动识别死 PID；若进程恰在启动仲裁瞬间被强杀留下 `run.claim`，会明确拒绝启动，需要停止采集并核对没有运行进程后清理该空目录。

## 验证和回滚

Windows 原生测试：

```bash
node --test tests/entropy-lighter-lab.test.mjs tests/entropy-lighter-feeds.test.mjs tests/entropy-lighter-cli.test.mjs
python deploy/test-package-layout.py -v
python deploy/test-release.py -v
```

发布测试分别覆盖完整包的四文件白名单与可运行 CLI、源码发布命令的固定提交提取，以及研究代码的缓存失效范围。Windows 的原生 Git Bash 可运行跨平台输入分类测试 `bash deploy/test-inputs.sh`；Linux 权限、systemd 激活、增量安装与回滚由现有 Ubuntu CI 验证。短时公开接口采集不等于已完成东京 24 小时验收。

本次包含部署交付路径变更，按 R3 审查。网络失败暂停对应研究/模拟并保留历史，磁盘写失败会停止采集。可从页面停止采集，配置和数据保留；回滚沿用工作台旧正式版本，保留 `DATA_DIR/entropy-lighter`，旧工作台不读取该研究目录。独立 CLI 安装方式仍可使用旧正式提交的专用安装器回滚，其数据与工作台目录分别保留。
