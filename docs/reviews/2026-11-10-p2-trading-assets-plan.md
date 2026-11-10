# P2 成交与资产证据实施范围

风险等级：R3（只读公共数据契约、用户标注资金流持久化）。关联 #277、#279、#281、#307、#309、#310、#334。

## 影响与边界

- ANT 成交关联只追加有限原因；继续要求唯一订单、合约、方向和账户证据，不允许人工强关联。账户证据不足统一降级，不公开其他账户是否存在。
- 结束的 ANT 减仓任务按 phase/batch 和真实成交建立只读成本报告。未知费用/盘口/FX 保持未知，不将委托价当成交价。
- 单任务证据导出从持久化任务与订单白名单投影，保留未知状态和历史保留缺口，不调用交易接口。
- 本轮仓位证据使用现有精确十进制回放，限制记录数量；明细截断明确披露，汇总仍按完整已读取输入计算。
- 成交缓存诊断仅计数已有读取，按账户连接版本隔离并随条目淘汰。诊断读取不触发交易所请求。
- 资金流由用户显式标注账户、币种、北京时间业务日、金额和证据引用；内部转账仅唯一双边配对。修改保留历史，不从余额推测收益。复用 settings 与现有同步锁，无数据库迁移。
- 日归因保留旧资产变化指标，新增资金流、已知持仓贡献与未解释差额；没有汇率时效元数据时明确记录证据缺口。

## 验证与回滚

只运行相关 Node 行为测试、受影响前端类型检查和必要产品入口验证。测试使用合成账户/成交，不触发实盘或生产数据。归属拒绝、重复成交、翻仓、缺证、冷却、换绑、内部转账重复/跨日、周期切换与缺费用交叉场景须覆盖。

回滚恢复本批源码；新增响应字段是可选的，旧缓存可继续读取。资金流 settings 追加记录可保留，旧版本忽略该键；不删除既有资金/账户/执行数据。导出及诊断没有执行副作用。主任务统一完成独立安全审查、提交、推送及发布。

## 实际验证

- `node --test tests/trading-execution-evidence.test.mjs tests/trading-fill-attribution.test.mjs tests/account-writer-execution-evidence.test.mjs tests/hub-fills.test.mjs tests/hub-positions.test.mjs tests/asset-positions.test.mjs`：57 项通过。覆盖只读导出/共享尝试、真实成交去重和缺证、账户隔离与跨边界字段白名单。最初 Hub 测试发现扩展名遗漏，已修复并完成相应复跑。
- Asset：`node --experimental-strip-types --test tests/cash-flows.test.ts tests/cycle-evidence.test.ts tests/positions-cycle.test.ts tests/daily-changes.test.ts`：41 项通过；随后补充纯入金断言，针对日归因复跑见下。
- Asset：`node --experimental-strip-types --test tests/hub-fills.test.ts tests/daily-changes.test.ts`：98 项通过。缓存测试包含真实 Binance 输入的 85 天历史 26 次请求与回放重试 2 次请求对比；这是固定夹具基线，不是生产提速承诺。诊断专项覆盖两页读取、中途失败、冷却、重启恢复、冲突及换绑隔离。
- Asset：`node --experimental-strip-types --test tests/cash-flow-routes.test.ts`：1 项通过，未登录不进入数据层，写标注经过 mutation 检查。
- Monitor：`node --test tests/hub-bridge.test.mjs tests/hub-fills.test.mjs tests/anthropic-trades.test.mjs`：38 项通过；共享声明调整及明细断言后 `node --test tests/hub-bridge.test.mjs tests/anthropic-trades.test.mjs`：29 项通过。
- Asset：`pnpm exec tsc --noEmit` 通过。Hub/Monitor 类型检查、发布构建、真实 HTTP 路由与浏览器由主任务统一进行，不将尚未运行的检查记为通过。
- 补纯入金及歧义原因断言后：Asset `node --experimental-strip-types --test tests/daily-changes.test.ts` 26 项通过；Hub `node --test tests/trading-fill-attribution.test.mjs` 8 项通过。其它已通过测试对应源码未变化，直接复用结果。
- `git diff --check` 通过（共享工作区其它组文件只有换行格式提示）。无实盘、生产数据库、WSL 或服务器部署。

## 已接入入口与审查范围

| Issue | 实际入口与范围 |
| --- | --- |
| #281 | `server/trading-fill-attribution.mjs` → Hub/Monitor 成交字段校验 → `tradeDetailLines`；所有未关联成交保留，跨账户证据不足使用通用原因 |
| #277 | ANT 已结束减仓及执行卡片的只读证据展开；真实成交按 job/phase/batch 去重，明细按原币显示；全部订单量/覆盖对齐前不声明费用完整，历史触发盘口缺失时滑点不可计算 |
| #334 | `GET /api/trading/execution/jobs/:jobId/evidence`（主任务接线）及下载按钮；只读任务/订单/共享尝试白名单，无账户身份、签名载荷或自由上游错误正文 |
| #307 | `summarizeCycle` 同步生成纳入分项和排除原因，`server/cycle-evidence.mjs` 统一有界校验；Monitor 关联持仓卡片按每页20条展开，最多保留200条并披露截断 |
| #279 | Asset 已认证 `GET /api/hub/fills/diagnostics`，只读当前连接版本的进程内计数，最多128组；不唤起或延长交易所读取 |
| #309 | 真实 SQLite → `readDailyChanges` 联合回放：入金、缺费用/周期切换、旧人工汇率、换凭据与缺失日期；不补造日快照 |
| #310 | Asset 每日波动中的资金流表单与 `GET/POST /api/cash-flows`；settings 中 `cash-flow-audit-v1` 逐版本追加，现有同步租约保护，内部转账严格配对；旧出金累计口径保留 |

独立审查应覆盖：只读导出 SQL 的任务/订单隔离与注册库前后核验；金额未知语义和原币分组；翻仓分项与汇总一致；资金流修订的并发版本和幂等重试、鉴权/来源检查；新共享文件在 Hub、Monitor、Asset 构建与类型检查缓存键中的覆盖。共享构建输入的接线由主任务处理。

未覆盖：无生产历史/汇率样本；触发盘口历史不存在，滑点持续显示不可计算；共享操作仅保存最终状态，不声称恢复被覆盖的全部中间观察。未提供逐笔周期证据的其它来源继续显示缺证提示，不虚构明细。

## 独立审查后增量

- #307 修复响应规模问题：Asset 的实际 `read()` 响应增加全局 1,000 行、512 KiB 证据增量预算，并按原持仓概览字节数保留 2 MiB 传输上限余量。预算不修改缓存周期或汇总；逐仓 `totalRows` 保留，`truncated` 与实际返回数一致。预算不足以附带元数据时概览仍保留，UI 明示当前响应未附带证据。
- #334 修复同步 SQL 扫描问题：原单 UUID 驱动主键精确与前缀范围索引；最多扫描 4,001 个原始候选，再核对模块/任务/操作后缀，最多输出 4,000 条。达到候选预算时明确截断，不把未扫描部分说成没有操作。
- #307 明细增加 `side` 与本轮 `closingQuantity`，翻仓开仓份额为零平仓量；旧 v1 缺字段保持未知。明细平仓量及按原成交价加权的均价均能对回汇总。
- #310 已作废记录继续使用同一完整审计历史组件，展示原始凭证、日期、汇率和全部修订，不仅列最后作废版本。
- Windows 原生真实 HTTP 回归：50 仓 × 200 条由 `summarizeCycle` 生成的记录，未预算 2,639,136 bytes 被原传输上限拒绝；预算后 304,586 bytes，50 仓全部 ready，每仓附带 20/200 条，缓存仍各保留 200 条。单仓和翻仓证据不变；多字节文本与接近传输上限的概览也纳入预算检查。
- Windows 原生真实 SQLite 规模回归：4,000 订单 / 4,000 操作为 132.6 ms；4,000 订单 / 16,000 操作为 42.8 ms，后者只扫描 4,001 候选并报告截断。EXPLAIN 确认范围索引搜索，无整表扫描/临时排序；读取前后数据库写入计数不变。
- `node --test tests/asset-position-evidence-scale.test.mjs tests/account-writer-execution-evidence.test.mjs tests/trading-execution-evidence.test.mjs tests/asset-positions.test.mjs tests/hub-positions.test.mjs`：38 项通过。
- Asset `node --experimental-strip-types --test tests/cycle-evidence.test.ts tests/positions-cycle.test.ts tests/hub-positions.test.ts tests/cash-flows.test.ts`：29 项通过；`pnpm exec tsc --noEmit` 通过。Hub/Monitor 增量类型与浏览器继续由主任务统一执行。

## Asset 生产构建增量修复

主任务实际生产构建发现 `cash-flows → positions-cycle → positions-values` 把服务端 `node:crypto` 引入客户端。将原有 `decimal` 校验与 `POSITIONS_INVALID` 文案原样移到纯 `positions-decimal.ts`，服务端 `positions-values.ts` 保留导出兼容，周期运算直接引用纯模块。没有扩大金额长度/语法、改变十进制计算或除法精度。资金流 `kind` 同时改为先校验字符串类型再匹配枚举，数组/可转换对象不能绕过分支。

Windows 原生 Asset `node --experimental-strip-types --test tests/cash-flows.test.ts tests/positions-decimal.test.ts tests/positions-cycle.test.ts tests/cycle-evidence.test.ts tests/positions-readers.test.ts tests/hub-positions.test.ts tests/daily-changes.test.ts`：112 项通过；`pnpm exec tsc --noEmit` 通过。Asset 生产构建由主任务重新执行，未在本子任务重复运行。
