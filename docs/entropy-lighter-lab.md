# Entropy / Lighter 24 小时行情研究工具

首版采集公开盘口，研究 SNDK、ANTH 的真实价差、Binance 行情之后的跨所价格变化，以及延迟对 taker 成交结果的影响。默认只采集；不需要 API Key，没有下单、签名、转账或自成交功能。程序独立运行，不接工作台现有交易执行器。

本次按 R3 交付：行情与纸面计算为 R2；独立 systemd 安装、激活及回滚为 R3。影响仅为新增工具、专用安装入口和对应 CI，不改变工作台现有模块。网络失败暂停对应研究/模拟，保留历史；磁盘写失败退出，交给 systemd 有界恢复。停止本服务即可停用，重新执行旧正式提交的安装器可回滚代码，配置与数据保留。

## 东京 Linux 一键运行

在 Ubuntu 24.04 LTS x64、systemd 服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-entropy-lighter-lab.sh | sudo bash
```

安装器读取本仓库正式发布的 manifest，固定到同一个 commit 下载白名单文件；自动准备缺少的依赖和校验过的 Node 24。已有受信任 Node 可复用，无 npm 依赖、构建或监听端口。配置首次生成后不覆盖。内容、配置、Node 和服务未变化时跳过验证与重启；变化只重启本服务。启动失败恢复旧代码和服务状态。

路径与管理命令：

```bash
sudo systemctl status entropy-lighter-lab --no-pager
sudo journalctl -u entropy-lighter-lab -f
sudo cat /var/lib/entropy-lighter-lab/status.json
sudo /opt/entropy-lighter-lab/current/node /opt/entropy-lighter-lab/current/tools/entropy-lighter-lab/cli.mjs report --data /var/lib/entropy-lighter-lab
sudo systemctl stop entropy-lighter-lab
```

配置为 `/etc/entropy-lighter-lab/config.json`，数据为 `/var/lib/entropy-lighter-lab`，代码在 `/opt/entropy-lighter-lab/current`。服务以专用非 root 用户运行；离线启动也有本地心跳，心跳存活与交易所行情有效分别判断。

本地直接启动（Node 24.15+）：

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

完成合约核验并确认账户实付费率后，编辑配置：`simulation.enabled=true`、`verifiedSymbols=["SNDK"]`、`entropyTakerFeeBps=实际总费率bps`，再运行 `check --config /etc/entropy-lighter-lab/config.json` 并重启本服务。首版建议保持 ANTH 未核验状态。

基线只用于检验价差是否经得住执行：同数量两腿 taker 开仓，固定持有默认 5 秒，然后 taker 平仓。开仓门槛要求扣除开平四次手续费、滑点和资金费准备后仍有额外安全边际；不把返佣作为入场依据。它不是经过验证的最优退出策略，也不保证每笔赚钱。

数量按两市场都接受的步长向下取整，并检查最小数量、最小名义金额和单位倍率。每腿只有在其延迟到达之后新收到的盘口上才可能成交，吃足可见深度并加入滑点；不回用触发时价格、不假设隐藏深度。模型是全成或不成的纸面 IOC，未模拟真实部分成交、撮合队列、对手方撤单或市场冲击，因此成交量仍是研究代理值。每个标的每组情景最多一个在途任务，结束后冷却，不能重复累加同一盘口的机会。

两腿独立生效。一腿失败会记录失败并尝试平掉已成交腿；退出行情缺失或深度不足会留下未知敞口、阻断该标的后续模拟。手续费、滑点计入逐笔结果；资金费仅扣配置的保守准备金，不宣称是实际资金费结算，也不包含杠杆、清算、保证金和融资模型。

默认延迟为 Entropy 200 / Lighter 450ms 和压力情景 500 / 800ms，均为未实测假设。东京服务器采集的行情 RTT 用于诊断，实际下单 submit→ACK、submit→fill、失败重试和对冲完成时间仍需以后从正常真实成交记录测量。先看 24–72h 样本中的价差寿命和压力情景结果，再决定是否开发实盘；本首版没有实盘开关。

崩溃/重启时，未清洁结束的 paper session 或未决任务会使新进程降为只采集，最初报告保存在 `unresolved-paper.json`，后续重启不会覆盖。先停服务并复核该报告；需要新的独立实验时使用新的数据目录，旧数据保留。正常独占锁会自动识别死 PID；若进程恰在启动仲裁瞬间被强杀留下 `run.claim`，会明确拒绝启动，需要停服务并核对没有运行进程后清理该空目录。

## 验证和回滚

Windows 原生测试：

```bash
node --test tests/entropy-lighter-lab.test.mjs tests/entropy-lighter-feeds.test.mjs tests/entropy-lighter-cli.test.mjs
python deploy/test-entropy-lighter-lab-install.py -v
```

后一个命令在 Windows 仅执行跨平台案例，其余权限/事务案例由 Ubuntu CI 执行。新增 CI 使用真实 systemd，覆盖离线首次启动、current 符号链接入口、非 root 隔离、无变化升级、配置与数据保留、代码更新及启动失败回滚，并纳入正式发布门槛。未使用 WSL，短时公开接口采集不等于已完成东京 24 小时验收。

停用只需 `systemctl stop`；不删除配置和数据。回滚可以取本仓旧正式 commit 的专用安装器，并传入同一 commit 的受信任源码目录 `--source /absolute/root-owned-checkout --revision FULL_COMMIT`。不要把未知来源或服务用户可写的源码作为 root 安装输入。
