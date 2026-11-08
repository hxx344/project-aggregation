# ANT 风险规则修复（Issues #257–#260）

## 范围与实施前约束

基线：`9351de4738379c033134b0d5c6cedc0e80d62231`。风险等级 R3，影响强平预警的未知状态、自动减仓未触发阶段的可执行性检查、RH 仓位身份验证及已成交批次之后的仓位读取恢复。不增加交易策略，不提高用户减仓比例，不改变身份、数量及真实发送前的准入要求。

数量检查采用 Issue #258 允许的监测阶段方案：保存后明确等待核验，每次监测在阈值判断前按当前持仓和市场规则构造完整计划。读取失败和数量不可行均保留原因；不存在用保存时旧计划授权下单的路径。

成交后等待只适用于已确认上一批成交、所有原单均已结算且当前读数精确等于上一批发送前数量的情况。等待期间不发送新单；账户、方向、模式及其他数量矛盾仍拒绝。专用等待次数和绝对期限保存在原任务中，停止与任务截止优先；恢复必须重新取得完整有效证据。重启继续沿用原有的暂停后人工确认政策，不自动续发，明确确认剩余计划后清除旧等待基线。

回滚：先停用新的自动减仓触发，保留原任务、订单、账户绑定及数据库，以原编号核对在途任务后回退交付父版本 `deploy-5ec9d872e82cfa86a4aa8f029e0dba08e5d526e5`。新增 JSON 状态字段兼容旧记录，不删除任务或重建首批。正式发布不包含服务器部署。

## 验证与独立审查

Windows 原生 Node v24.22.1、pnpm 11.25.0。新增失败回归先运行旧实现：#257 的 HL/RH 缺价与读取恢复路径失败；#259 的 17 个错误身份场景未拒绝；#258 数量/拆批及 #260 旧读场景失败。均为隔离夹具，未访问真实账户或发送真实通知。

最终源码检查：

| 实际命令 | 结果 |
| --- | --- |
| `node --test --test-concurrency=1 tests/trading-execution.test.mjs tests/trading-execution-hyperliquid.test.mjs tests/trading-auto.test.mjs` | 137/137 |
| `node --test --test-concurrency=1 tests/trading-anthropic-reduction.test.mjs tests/trading-anthropic-reduction-http.test.mjs tests/trading-execution-rh-lighter.test.mjs` | 104/104；含真实工作台 HTTP 授权、保存与定时触发入口 |
| `node --test tests/trading-anthropic-watch.test.mjs` | 24/24；复用同一任务内最终 watch 源码结果 |
| `node --test tests/trading-rh-lighter-execution.test.mjs tests/trading-execution-rh-lighter.test.mjs` | 原联合结果 97/97；后续共享计划变更后重跑第二行的引擎相关测试，适配器本身的 50 项结果有效复用 |
| `pnpm run check` | 通过；后续没有 TS/TSX 变化，复用结果 |
| `pnpm exec vite build --outDir .tmp-ant-issues-build` | 通过；构建随后移到系统临时目录，由 Vite preview 在 4175 提供 |
| `playwright-cli -s=antissues run-code --filename tests/trading-anthropic-positions.browser.mjs` | `passed: true`；覆盖缺价保警、恢复及 390px 布局，未捕获未处理页面异常；夹具刻意返回未涉及 API 的 404 与测试通知失败 502 |
| `git diff --check`、改动 mjs 的 `node --check` | 通过 |
| `node --test tests/lessons-routing.test.mjs` | 2/2 |
| `node scripts/review-gate.mjs --staged` | 13 个文件，0 阻断、0 提醒 |

推送前远端合入 `5ec9d87`（#261），本次提交接入该主线后再次逐文件比较，11 个本次代码/测试文件内容与已验证版本完全一致。上游调整涉及 Asset OKX/仓位读取及共享传输层，额外运行 `node --experimental-strip-types --test tests/exchange-transport.test.mjs modules/asset/tests/okx.test.ts modules/asset/tests/positions-readers.test.ts`，72/72 通过；本次未变源码的验证结果继续复用。新主线的安装/构建路径由合并后提交的发布 CI 验证。

独立审查者 `/root/review_ant`，调用参数 `gpt-6-astra / ultra`、`fork_turns=none`；只提供范围和标准。首次检查覆盖 10 个源码/测试文件、此文档及直接关联入口，P0=0、P1=0、P2=1：活动委托先于拆批校验，遮蔽数量不可行。修复将 `buildPlan` 的外部委托检查移至全部腿数量验证之后，仍在计划返回前拒绝；新增组合回归先红后绿。独立增量复核重跑原探针，确认问题关闭，数量修正后外部委托仍阻断；另验证旧仓位与兄弟腿合约乘数变化同时发生时立即暂停且零新批次。最终无未处理 P0/P1/P2。

使用 Codex Security `security-diff-scan` 对固定快照 `a647dd1376c93b7c122fb4f5f89e44c026f34fafec414ad7849790b6830d402d` 完成五个生产文件及支持路径的差异审查；扫描 `3fa5cf4c-cb81-4190-b680-69cc8254284b` 已封存，无安全候选。上述 P2 属一般正确性问题，扫描封存后修复，再做独立增量审查；不把初始安全快照冒充增量验证。无 Daybreak 检查。工具计量：总 9,400,883 tokens、输入 9,378,870、缓存输入 9,135,744；这是工具返回的跨关联聊天统计，不作为费用估算。

自审按 D1–D7：原生身份及十进制数量保持；未知风险不恢复；重试限时限次、停止优先且原单不重发；现有鉴权和共享写入守卫保留；HTTP 与可见入口覆盖；失败路径有红绿回归；未夹带无关重构、依赖或生成物。部署、数据库结构迁移、收益计价和其它模块变化不适用。正式发布等待本提交现有 `Checks` CI 生成验证候选，不在本机使用 WSL，不部署服务器。

## 外部契约与剩余边界

- [Lighter 官方 AccountPosition](https://raw.githubusercontent.com/elliottech/lighter-python/main/lighter/models/account_position.py) 的 `market_id` 与 `symbol` 为必填严格类型，未查到别名契约；本次拒绝缺失和矛盾身份，不猜别名。
- [固定版本官方 IOC 数量/金额验证](https://github.com/elliottech/lighter-prover/blob/fa85b33197710ece649739bc38f5e23e816ddbdf/circuit/src/types/tx_state.rs#L195-L226) 仅对非 IOC/TWAP 检查最小名义额；[调用处](https://github.com/elliottech/lighter-prover/blob/fa85b33197710ece649739bc38f5e23e816ddbdf/circuit/src/transactions/l2_create_order.rs#L598-L604) 传入 IOC 类型。本项目 RH 市价腿使用 IOC，因此不新增最低名义额拒绝。
- [Hyperliquid 官方错误表](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses) 声明一般最低金额 10 美元，但未核实小额 reduce-only 的具体豁免；监测提前显示该条件未确认，不宣称真实交易所一定拒绝或接受。没有实盘下单验证。
