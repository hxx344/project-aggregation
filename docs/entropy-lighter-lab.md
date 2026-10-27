# Entropy / Lighter 24 小时行情研究工具

工具已内置到工作台，用于持续采集公开盘口，研究 SNDK、ANTH 的真实价差、Binance 行情之后的跨所价格变化，以及延迟对 taker 成交结果的影响。默认运行公开行情与方向模拟研究；不需要 API Key，没有真实下单、签名、转账或自成交功能。

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

以下为 2026-10-27 查验结果，程序运行时重新读取市场目录，不固定 Lighter market ID。

| 研究标的 | Entropy | Lighter | Binance，只研究领先信号 |
| --- | --- | --- | --- |
| SNDK | `io:SNDK` | `SNDK`（本次 ID 139） | `SNDKUSDT` |
| ANTH | `io:ANTH` | `ANTHROPIC`（本次 ID 193） | `ANTHROPICUSDT` |

[Entropy 是 Hyperliquid HIP-3 的 io 市场](https://docs.entropy.io/about-entropy/readme)。公开信息读取用 Hyperliquid `/info`，WS 用 `l2Book` 的 `fast:true` 完整快照。Lighter 用官方 `orderBookDetails` 和 WS `order_book`，按 `begin_nonce == previous nonce` 校验增量连续性，缺口立即失效并要求新快照。Binance 用完整 top-20 部分深度帧，不把它误当作可直接拼接的增量。

[Lighter Standard](https://apidocs.lighter.xyz/docs/account-types) 当前普通 taker 零手续费，固定 taker 等待 300ms。该等待不包含全部网络、服务端处理和回报时间；本工具配置的 Lighter 延迟不得低于 300ms。费用通过公开 `feeTiers?filter=perps` 自动读取 Standard 档；Plus/Premium 的费用不同，本工具不读取实际账户 tier，也不把默认档称为账户实付费率。本工具只按普通 taker 研究，不使用 maker 或 TWAP。

[Entropy 费率](https://docs.entropy.io/equity-perp-mechanics/fees) 已自动获取，无需输入：读取 Hyperliquid 公共 `userFees` 的全局 `feeSchedule.cross`，再结合每个市场的 `deployerFeeScale`、growth mode 与抵押币种。请求使用固定零地址，仅保留全局费表，忽略零地址的账户费率、折扣和交易量；不读取用户账户。当前两个市场默认费率均为 `0.009% = 0.9 bps`，数值随公共费表和市场参数刷新，不在程序中固定为 0.9。`1 bps = 0.01%`。

费用口径为公开默认档、无账户个别折扣、无 builder 加费的 API 研究情景，不是对账户实付费率的确认。正常每 15 分钟刷新，缺失/将过期时每分钟有限重试并遵守服务器冷却；20 分钟有效期不会被报告心跳续期。只更新费用不会重连健康盘口。未知字段或获取失败保留行情采集，但暂停新增模拟信号并等待自动恢复。原 schema 1 的手填字段仍可读取，但新运行统一采用自动费用，不再用旧数值覆盖它。

返佣固定展示 110% 和 120% 两档，无需输入。用户已确认这是额外渠道、以**全部 Entropy 手续费**为基数；它区别于 Entropy 官方以自身分成为基数的返佣规则。程序按每条结果锁定的 Entropy 整轮总手续费分别乘 1.1、1.2，显示假设返佣金额与返佣后余量，不对 Lighter 手续费返佣。资格、上限、实际结算和领取尚未核对，均标为未到账情景。

若默认费率为 `f`、返佣比例为 `r`，单次 Entropy 成交额的净补贴为 `f × (r−1)`。以本次自动读得的 `f=0.9 bps` 为例，单次净补贴 `0.09–0.18 bps`，Entropy 开平两次合计 `0.18–0.36 bps`。返佣前亏损的方案不会仅因返佣假设转正就升级为候选。

## Binance 第4档突破方向模拟

采集启动后自动运行此实验，不需要开启原跨所四腿 paper、勾选等价性或填写费用。SNDK、ANTH 分别按 Binance 的 `SNDKUSDT`、`ANTHROPICUSDT` 方向触发，只在 Entropy 模拟 taker 开平仓。页面先显示当前阶段、冻结价和持仓，再给出各延迟情景的已平样本、亏损占比、Entropy 模拟成交额、返佣前净收益和 110% / 120% 返佣后净收益；逐笔结果含退出原因。

每轮固定 Binance 当时 `asks[3]` 为上沿、`bids[3]` 为下沿，不随后续盘口漂移。仅后续买一从上沿下方穿到上沿及以上时做多，卖一从下沿上方穿到下沿及以下时做空，一侧触发后撤销另一侧。多仓买一回落到原上沿下方、空仓卖一回升到原下沿上方时退出，等于触发价不立即退出；只扩大点差不会触发。Binance 只产生方向信号，不与 Entropy USD/USDC 价相减，也不建立 Binance 头寸。ANTH 的领先关系作为待验证假设，原跨所等价性限制继续保留。

每情景分别使用现有 Entropy 假设延迟，默认 200ms / 500ms，开仓和平仓分别延迟。只在到达后新收到、源时间及接收时间有效的 Entropy 盘口扫单；触发价和旧缓存不作为成交价。开仓延迟途中已反向时仍保留入场意图，模拟入场后再按退出延迟处理，避免事后筛掉不利路径。最大持有时间从入场代理成交起计算，默认 5 秒；来源失效也触发退出。每轮结束默认冷却 10 秒后重新冻结，单标的单情景只留一笔在途或持仓，各情景结果不可相加。

数量只按 Entropy 精度与最小下单限制向下取整，深度不足不假设隐藏成交。两次实际模拟成交额分别计费，逐笔锁定自动 Entropy 费率，Lighter 费用缺失不影响此实验。滑点已在两次扫单中扣除，单腿资金费准备按入场名义金额计算；返佣后净收益再分别加上两次总手续费的 110% / 120%，返佣尚未到账。方向收益没有预先锁定，完整记录亏损、开仓失败及未知退出，不能据均值保证下一笔结果。

断线、深度不足或过期会撤销未触发条件；已模拟发出后不追溯撤单。退出超时保留未决敞口并阻断该情景，总净收益显示未知，已知费用与成交额继续保留。前次会话有在途任务、未决敞口或未清洁结束时，新会话暂停方向实验并将最初证据保存在 `unresolved-scalper.json`，不反复覆盖；页面继续展示原会话持仓、统计及逐笔记录，标明上次会话，总净收益及返佣后净收益保持未知，不恢复旧任务。正常新会话的指标只统计该会话，旧原始事件保留。原始事件以 `binance_scalp_` 开头，每情景保留最近 20 个结束结果和完整会话累计统计，页面展示最新 8 条。新实验使用 `report.binanceScalper`，旧报告不会被补算为新策略结果。

## ANTH 跨所套利必须先核对合约等价性

[Entropy 预 IPO 规则](https://docs.entropy.io/market-types/pre-ipo-perpetuals) 明确每个价格单位代表公司 10 亿美元市值，IPO 后继续市值永续。[Lighter 预 IPO 规则](https://docs.lighter.xyz/trading/real-world-assets-rwas/pre-ipo-markets) 使用内部定价，IPO 后转换规则不同。Binance 也有独立的预 IPO 合约调整规则。

同一家公司、相近价格和 multiplier=1，不能证明终局结算等价。本次短时样本中 ANTH 约有 2% 基差；这只是某个时点的研究观察，不能作为套利收益或未来收敛承诺。ANTH 跨所纸面开平仓默认关闭；上面的 Binance 方向实验不以价差收敛为依据。SNDK 虽同为 SanDisk 股价，也须考虑开闭市、预言机和资金费差异。

## 先看观测结论

页面先分别解释 SNDK、ANTH 的当前研究结果，例如“成本未齐”“价差覆盖不了成本”“速度吃掉优势”或“值得纸面验证”。每张卡给出同一买卖方向、每腿金额、整轮成本预算、延迟后入场空间及下一步；原始盘口、毫秒指标、模拟明细和设置收进折叠区。曲线默认用百分比显示，缺失与断线区间留空。

入场空间按同数量两腿的可见深度计算。入场价格已经计入开仓滑点，预算另外预留四次手续费、退出两腿滑点和资金费；费率未知时成本和余量保持“待确认”。这里的余量需要平仓时基差收敛才能转化为完整收益，不是保证净利润。双边开平的示例成交额约为两腿入场名义之和的两倍，不代表每天可实现的交易量。

即使只启用采集，也会独立研究两个买卖方向，以及各组假设订单延迟到达后的新盘口。默认约每 10 秒抽样，各情景互为替代，不累加成交量。缺腿、超时、深度不足与失效都保留在观察完成率的分母中；源时间不可信的观测可保留金额参考，但不计入可信成本样本或其跨度。

SNDK 最多进入“值得纸面验证”：同一方向和延迟情景需至少 30 个源时间可信、成本完整的样本，可信样本覆盖至少 5 分钟，全部抽样完成率至少 80%，可信样本成本后达标率至少 75%，且近期预算、报价与身份等条件仍有效。这些是研究筛选门槛，不是获利概率；现有模拟执行仍等待严格时效的新盘口。ANTH 先核验经济等价，不因长期大价差推荐收敛套利。Binance 仅作为潜在领先信号研究，不把方向命中率当成可交易证据。

报告每 5 秒更新，前台每 5 秒读取。页面以服务器时间和本地单调经过时间估算报告年龄、保守计入请求耗时，不再用浏览器墙钟对历史采样套用 750ms 执行门槛。报价观测、报告是否更新、采样时是否符合严格执行条件分别显示；报告或研究证据停更时保留历史金额并撤回当前判断。模拟的 750ms 接收时效、源时间和双腿配对约束保持不变。旧报告缺少新字段时显示“等待新版采样”，不默认健康或自动继承新配置。

## 技术报告字段

- `counts`：实际收到的盘口数量、信号数量、拒绝原因、断线/缺口次数。
- `basis`：Entropy mid / Lighter mid − 1 的接收时间观测，单位 bps；不是可成交收益。每条 `spread` 还保留 bid/ask 可见 taker 价差与时间质量。
- `leaderMarkouts`：Binance 在 250ms 内至少变动 2 bps 后，观察 Entropy/Lighter 在 100/300/500/1000/2000ms 的同方向收益。使用同一进程的接收单调时钟，只比较各市场相对变化，不假设 USDT=USDC。它是条件观测，不证明因果领先，也未自动用于交易信号。
- `diagnostics.rttMs`：各接口最近最多 1000 次公开 HTTP 或 WS ping/pong RTT 样本；`eventLoopDelayMs` 是采集进程阻塞分位数。两者均不等于下单延迟。
- `paper`：每组延迟假设下的完成笔数、亏损笔数、已知费用、Entropy/Lighter 各自开平累计名义成交额、返佣前净额及返佣情景。不同延迟情景互斥，不能把成交量和利润相加。
- `openPaperTasks`、`unresolved`：未完成或无法估值的纸面敞口。有这些状态时，该情景总净额为 `null`，已完成部分另列 `settledNetBeforeRebate`；已知手续费仍保留。
- `observedAt`、`observation`、`latestQuotes.receiveAgeMs`：生成报告时的采集器时间、观察窗口及单调接收年龄；`executionQuality` 独立保留严格模拟时效结果。
- `opportunityStudy`：按标的、买卖方向和延迟情景隔离的入场研究。`completed` 为双腿观测完成数，`costed`、`qualitySpanMs` 只涵盖源时间可信且成本已知的样本；不与现有跨标的 `paper` 汇总混用。
- `automaticFees` 与每条 `feeSnapshot`：当前自动费用与当时计算所用的费用版本/来源；同费率仅刷新时间不清空统计，费率语义改变会隔离研究样本，纸面在途任务仍按创建时的费用快照完成。历史结果不使用后来费率重算。

`events-*.jsonl` 保存原始帧、标准化盘口、目录、信号、每腿模拟成交、失败与结束报告，可离线重新研究。`report.json` 每 5 秒更新当前 session 汇总；`status.json` 是轻量心跳。默认最多约 2 GiB 行情文件、7 天保留上限；哪个先触发就先删除最旧的工具日志，不能理解成一定保存足 7 天。每段约 8 MiB，磁盘不足或写入失败会停止运行。该限额不清理用户其他文件。

交易所 source timestamp 与本地时间可能偏移。[Lighter 官方](https://apidocs.lighter.xyz/docs/timestamps) 明确说明执行时间与 API 帧时间不是同一时钟。本工具保存原始值、`sourceClockDeltaMs` 和 `sourceClockUncertain`。研究模式可以显示标明质量的接收时间观测；模拟仍拒绝缺失、过期或超前的来源时间。应在东京服务器上保持 NTP 同步，并观察偏差，不能把直接相减的时间当作订单耗时。

## 可选纸面基线

费用和返佣自动准备，默认研究模式就能看到成本、Binance 方向模拟与跨所研究结论。若要另行开启完整跨所纸面开平仓，在工作台勾选已核验标的并启用模拟即可；无需填写费率或返佣，自动费用未就绪时等待恢复而不发送模拟信号。保存后按页面状态启动采集。CLI 使用者可先运行 `check --config /absolute/path/config.json`，再重启相应采集进程。ANTH 默认保持未核验状态。

基线只用于检验价差是否经得住执行：同数量两腿 taker 开仓，固定持有默认 5 秒，然后 taker 平仓。开仓门槛要求扣除开平四次手续费、滑点和资金费准备后仍有额外安全边际；不把返佣作为入场依据。它不是经过验证的最优退出策略，也不保证每笔赚钱。

数量按两市场都接受的步长向下取整，并检查最小数量、最小名义金额和单位倍率。每腿只有在其延迟到达之后新收到的盘口上才可能成交，吃足可见深度并加入滑点；不回用触发时价格、不假设隐藏深度。模型是全成或不成的纸面 IOC，未模拟真实部分成交、撮合队列、对手方撤单或市场冲击，因此成交量仍是研究代理值。每个标的每组情景最多一个在途任务，结束后冷却，不能重复累加同一盘口的机会。

两腿独立生效。一腿失败会记录失败并尝试平掉已成交腿；退出行情缺失或深度不足会留下未知敞口、阻断该标的后续模拟。手续费、滑点计入逐笔结果；资金费仅扣配置的保守准备金，不宣称是实际资金费结算，也不包含杠杆、清算、保证金和融资模型。

默认延迟为 Entropy 200 / Lighter 450ms 和压力情景 500 / 800ms，均为未实测假设。东京服务器采集的行情 RTT 用于诊断，实际下单 submit→ACK、submit→fill、失败重试和对冲完成时间仍需以后从正常真实成交记录测量。先看 24–72h 样本中的价差寿命和压力情景结果，再决定是否开发实盘；本首版没有实盘开关。

崩溃/重启时，未清洁结束的 paper session 或未决任务会使新进程降为只采集，最初报告保存在 `unresolved-paper.json`，后续重启不会覆盖。先停止采集并复核该报告；需要新的独立实验时使用新的数据目录，旧数据保留。正常独占锁会自动识别死 PID；若进程恰在启动仲裁瞬间被强杀留下 `run.claim`，会明确拒绝启动，需要停止采集并核对没有运行进程后清理该空目录。

## 验证和回滚

Windows 原生测试：

```bash
node --test tests/entropy-lighter-lab.test.mjs tests/entropy-lighter-scalper.test.mjs tests/entropy-lighter-scalper-integration.test.mjs tests/entropy-lighter-cli.test.mjs
python deploy/test-package-layout.py -v
python deploy/test-release.py -v
```

发布测试分别覆盖完整包的五文件白名单与可运行 CLI、源码发布命令的固定提交提取，以及研究代码的缓存失效范围。Windows 的原生 Git Bash 可运行跨平台输入分类测试 `bash deploy/test-inputs.sh`；Linux 权限、systemd 激活、增量安装与回滚由现有 Ubuntu CI 验证。短时公开接口采集不等于已完成东京 24 小时验收。

本次包含部署交付路径变更，按 R3 审查。网络失败暂停对应研究/模拟并保留历史，磁盘写失败会停止采集。可从页面停止采集，配置和数据保留；回滚沿用工作台旧正式版本，保留 `DATA_DIR/entropy-lighter`，旧工作台不读取该研究目录。独立 CLI 安装方式仍可使用旧正式提交的专用安装器回滚，其数据与工作台目录分别保留。

自动费用版本的工作台会在研究目录保留一次 `config.before-auto-fees.json`，不会覆盖。若新版保存过“启用 paper 且旧费率字段为 null”的配置，旧版会因要求手填费用而拒绝启动；回退前先停止研究并关闭 paper，或停服后恢复该升级前备份，再回退工作台。始终保留原始记录、未决纸面敞口及暂停标记，不为回滚清空风险状态。
