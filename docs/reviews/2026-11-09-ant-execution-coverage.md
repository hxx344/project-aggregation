# ANT 仓位与下单单元统一账户来源

风险等级：R3。用户要求核实反复出现的账户待核验/证据过期，并明确要求这里全部接通下单单元；以代码与隔离测试核验，不访问服务器或发送实盘订单。

## 实施前范围与回滚

- ANT 四所仓位、强平预警及自动减仓覆盖统一使用「价差下单」保存并核验的执行连接。增加执行适配器的只读仓位接口，共用原生数量、方向与风险解析，不借助普通单/条件单读取决定仓位能否显示。
- 执行器桥接私有凭据与受控读取；观察缓存绑定账户身份、连接版本、模式和 Lighter 子账户，请求前后校验并丢弃旧连接迟到响应。新观察不能领取写权限、修改任务、下单或让 GET 触发工作。展示字段与内部账户证明分开，失败保留旧数据及原时刻，不伪造新鲜度。
- 自动减仓覆盖消费同源账户证据与原执行准入结果。区分规则监测状态与瞬时盘口可发送依据，原风险/盘口到期检查保持；异常、维护、未知结果和写入保护不能被正常配置覆盖。Binance standard/portfolio-margin、OKX 保证金模式、Hyperliquid 普通主账户与 Lighter 指定子账户继续隔离。
- 四所统一切到执行连接后不隐式回退另一独立只读账户；只读账本与历史统计不改。已有预警配置和机器人保留，来源切换清理旧账户活动预警，不能把换账户误报为平仓。
- 外部只读沿用交易所适配器的超时和限流上限；后台每轮每所一次仓位读取，等待中的同轮不重叠，明确限流截止前不读；GET 只消费缓存。缓存仅当前进程有效，断开/换凭据/换账户范围/关闭立即失效，来源采样时间决定过期。
- 回滚撤回本次源码与正式版本；无数据库结构或连接配置迁移，保留原有凭据、任务、成交及预警配置。服务器更新由用户自行执行。

## 必要验证

适配器验证同账户、UID/钱包/子账户、模式、缺失展示字段、带活动委托仍能观察、零交易写入；执行器到 watch 的集成覆盖只连执行账户、独立只读账户不串入、迟到响应/重启/失败不续期；覆盖投影与真实减仓保护回归；根类型检查、生产构建和 ANT 实际页面的连接引导/覆盖/阻塞/老化/子账户。限定差异独立正确性和安全审查，提交前 staged gate；Windows 原生与既有 Linux CI，禁止 WSL。

## 实际结果

- 四所执行适配器新增 `positionSnapshot`；执行器桥绑定当前凭据/账户范围，读取前后核对，既不领取写权限也不改原执行快照。后台每 30 秒消费同一执行连接，独立只读账户不再进入 ANT 仓位及保护判断；旧构造分支仅为原有独立调用/测试保留，生产入口没有失败回退。
- 页面明确下单账户与 Lighter 子账户；真实盘口/风险 `validUntil` 不变，独立且有界的 `monitorUntil` 只说明调度仍在监测。读取中断、来源失效、缺价、换绑和写入保护问题仍撤销正常覆盖，不把该显示状态用于发送。
- 四所既有适配器回归 178/178，由实施子代理运行；新增 `tests/trading-execution-position-snapshot.test.mjs` 初版 23/23，风险分类增量后 27/27，补充真实 HL→缓存→预警链单项 1/1。原账户风险宽容解析负对照 8/8。新增或改变的输入各自验证，未机械重跑未改路径。
- `node --test tests/trading-execution-position-watch.test.mjs tests/trading-anthropic-watch.test.mjs tests/trading-anthropic-protection.test.mjs tests/trading-anthropic-reduction-http.test.mjs`：修复后 55/55。覆盖只连接执行账户即可显示、独立只读账户不同也不串入、四所未知强平价保警/重启去重、账户切换、迟到响应、限流、证明脱敏、GET 零外部读取和零交易变更。
- `node --test tests/trading-execution-position-bridge.test.mjs tests/trading-anthropic-reduction.test.mjs`：95/95；`node --test tests/trading-execution.test.mjs tests/lessons-routing.test.mjs`：113/113，原执行授权/恢复/只减仓行为保持。
- 合入最新主线 `a95078d` 后，仅执行返回接口列表有冲突，保留原 `exposureEvidence` 与本次两个观察桥。`node --test tests/trading-execution-position-bridge.test.mjs tests/trading-auto-exposure.test.mjs tests/trading-anthropic-reduction-http.test.mjs tests/lessons-routing.test.mjs`：交点 30/30。
- 原 runtime 测试同步为“独立只读账户不能替代执行连接”，保留机器人权限、加密及接口断言；`node --test --test-name-pattern='Anthropic watch never' tests/trading-runtime.test.mjs`：1/1。正向执行来源由上述真实 HTTP 计时入口覆盖。
- `pnpm run build`（含 TypeScript）与最新生产构建浏览器 `playwright-cli -s=ant-execution-coverage run-code --filename tests/trading-anthropic-protection.browser.mjs --raw` 通过：12 场景覆盖四所来源、Binance 已关联、OKX 其它保证金范围保留可见但不覆盖、RH 单一子账户、ready→monitoring→stale、断线重连、启停和 390px；仅两个显式测试按钮产生夹具写入，真实交易/通知为零。预览与浏览器已关闭。

## 独立审查与自审

`review_ant_execution_coverage`（实际参数 `gpt-6-astra / ultra`，隔离上下文、只读）首轮发现 P1：HL 畸形强平价经新宽容解析变为 `null` 后会误解除旧警报，同类路径涉及四所。采纳并统一区分本所明确无强平价与未知风险，保留原时间；交易预检原语义不改。第二轮独立运行四所分类与真实 HL 整链路 5/5，确认原 P1 关闭，P0/P1=0，无新增问题。用户要求的代码核验不被描述为已连接用户服务器或确认现场私有 UID。

`security_ant_execution_coverage` 按 `codex-security:security-diff-scan` 完成扫描 `d2b1ab45-ef04-437a-a0b1-17f7927db672` 并回读 completed。覆盖 13 个生产文件、8 个测试和 2 个文档及直接鉴权/凭据/交易链，确认安全漏洞 0、未决 0；误清告警是已关闭的资金保护正确性缺陷，未将其夸大为攻击者可控或下单绕过。原固定差异基线 `742cbb0`、SHA256 `00da49577c90a4f09837df25ab2a0bf9a8f53e756bd95721b30845726a5df98e` 保留，修复与主线交点通过 v2 `c7e63d8afdd8e0fa7665bac6dc9c3ed24f5952875cef142301b0eaeabbfc9882` 增量复核关联，没有重复全仓扫描或 Daybreak 检查。插件 token 测量不可用。

自审适用通用、账户/单位、时效与失败路径、安全边界、真实入口及前端状态类别；无数据库结构/依赖/安装器改动，收益账本与性能重构不适用。提交前运行 staged review gate；发布所需 Linux CI 与正式版本身份以本提交对应 Actions/Release 为证据，不提前声称通过。保留原配置和数据，不部署用户服务器。
