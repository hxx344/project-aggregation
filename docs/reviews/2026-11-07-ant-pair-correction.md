# ANT 当前组合与成交归属修正

## 变更前范围与回滚

风险等级 R3：新增已有实盘连接的只读历史成交读取，扩展工作台至 Monitor 的只读成交契约。开发从 `00fe4f1` 开始，已接入同期主线 `1d06abd`；保留自动分批减仓、页面偏好记忆与组合执行跟踪，不修改下单、撤单、杠杆、凭据存储及数据库结构。为隔离同期工作，本次在同仓库独立工作树 `codex/ant-pair-correction` 完成验证与提交。

用户反馈上一版 `b524404` 将 Binance 单腿成交画在 RH、xyz、io 全部图表，且关联交易按币种分栏，无法表达 Binance–Lighter RH 的当前组合。用户确认同时使用工作台与交易所手动下单，并选择 USDT/USDG 按 1:1 估算、明确标注口径。

实施范围：

- 当前持仓仅在 Binance 与一条比较合约构成唯一反向组合时合计，不把同一 Binance 腿重复分配给多个组合。按每股口径显示开仓、当前及有证据的平仓溢价，保留原币逐腿明细。
- USDT/USDG 以用户指定 1:1 口径显示估算；未知 RH 已实现、手续费及资金费不补零，显示已知盈亏估算与缺项，完整净盈亏只在全部必要数据已知时显示。截图预期为未实现 +406.33、已知净盈亏 +394.84（未包含缺失 RH 项）。
- RH `ANTHROPIC`、HL `xyz:ANT` 与 `io:ANTH` 真实成交分别归属对应图表，支持手动成交。BN/OKX 未关联成交保留明细，不依据当前持仓或相近时间猜历史配对，也不再投影到每张图。
- 新历史读取复用固定交易所地址、现有鉴权和限流，有界超时、分页及响应体；只读取当前连接允许的账户。缓存绑定连接身份与 revision，失败保留旧时间并标旧，变更连接与关闭时丢弃迟到结果。页面接口仅读缓存，首次读取异步刷新。

回滚：正常 revert 本次修正并发布，不删除执行任务、委托、账户与持仓记录；历史缓存属于可重建只读数据。旧版串图问题会随回滚返回，回滚不作为长期方案。

## 验证与审查

实现按四部分核对：两交易所只读适配器、runtime 历史服务与 API、host/Monitor 成交契约、图表与当前组合展示。全部操作在 Windows 原生环境完成，无 WSL，无真实账户读取或下单。

- 新增原生历史服务与适配器检查 52 项通过；原执行相关 39 项通过。检查时间字段最后调整后，仅复跑服务相关 7 项通过。相关源码未再改变的结果复用。
- 独立工作树合入 `1d06abd` 后，`node --test tests/trading-execution.test.mjs tests/trading-execution-http.test.mjs tests/trading-anthropic-history-http.test.mjs tests/trading-anthropic-reduction.test.mjs`：142/142。涵盖真实 HTTP 入口只读/鉴权/异步返回、断连迟到丢弃、现有自动减仓与执行跟踪不回归。
- ANT 标记、当前组合、host/Monitor fills 契约和 HL 适配器 46/46；随后补充原生币种大小写处理，host 契约与共享原油/海力士链路 62/62（包含部分前述用例，不将重复用例相加）。自审发现新增 HL fee 原生正数支出需转为共享现金流负数，已修正并在该轮验证；builderFee 不重复扣除。
- 根目录 `node node_modules/typescript/bin/tsc --noEmit` 与 `node node_modules/vite/bin/vite.js build` 通过；Monitor `node scripts/build.mjs` 的 TypeScript、客户端与 SSR 生产构建通过。受影响 Monitor 11 个 JS/TS/TSX 文件 ESLint 通过。
- 原有依赖通过同仓库依赖目录复用。首次并发调用 pnpm 自动依赖检查触发链接竞争，其中根目录命令因 Windows EPERM 未执行类型检查；之后改为直接运行已安装编译器，根目录与 Monitor 检查、构建均实际成功，不把失败命令计为通过。
- `tests/monitor-anthropic-trades.browser.mjs`：生产构建经真实工作台 iframe，RH 入场/出场与键盘明细、xyz/io 零 RH/歧义 CEX 标记、未归属 CEX 仅明细、截图 +406.33/+394.84、1:1 与缺项说明、原币逐腿明细、区间/价格模式、失败保留、后台停读、390px、偏好恢复与 URL 优先级通过，pageerror=0。
- 原油/海力士既有 `monitor-trade-summary.browser.mjs` 通过，pageerror=0。仅在忽略目录复制夹具并将端口替换为本任务的 4182/3192，未改断言。

独立正确性审查：`gpt-6-astra` / `ultra` 新上下文代理检查前端/host 差异及实际调用链，并独立离线验证截图金额、重复分配拒绝、未知币种、部分现金流及两种图表坐标隔离；无 P0/P1/P2。自审按适用清单完成数据身份、单位/未知值、新鲜度、有限失败恢复和真实入口；未改数据库/部署、交易状态机及凭据存储，不扩展这些不相关检查。

Codex Security diff scan `2d6616ad-5019-4887-ace6-c74d7eded446` 已完成并读取封存结果：固定差异覆盖 18 个源文件及直接支撑的鉴权/桥接路径，0 个安全候选、0 个发现。独立架构与后端 discovery 代理均按 `gpt-6-astra` / `ultra` 调用；插件登记扫描模型为 `gpt-6-astra` / `xhigh`，不将登记值描述为已切换。未执行 Daybreak 检查。

审查确认服务器历史缓存绑定 revision/identity，新的读取没有下单/撤单/杠杆调用。浏览器仍沿用原有同操作者 20 秒 host 缓存及带标记的旧视图保留，不宣称浏览器即时撤销；退出登录会卸载并清理 host。工具计量：totalTokens=16241177、inputTokens=16196786、cachedInputTokens=15909760，coverage=complete；这是工具记录的 rollout 计量，不是费用估算。

未运行：真实认证交易所读取、Linux 本地部署及全仓本地测试。Linux 构建、安装与发布包检查由既有 CI 完成后再正式发布。前述源码稳定后的检查复用，不为提交重复跑全套。
