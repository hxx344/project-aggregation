# Lessons

## 2026-10-12 — 账户锁定：先自增再比阈值；until=0 表示「仅计数未锁定」

- **证据 SHA**：`7543c3a1`（引入）、`023eaac3`（未达阈值勿写 until）、`8e272fd3`（清理勿删 until=0）、`5b148191`（off-by-one 最终修复 + `tests/account-lockout.test.mjs`）
- **描述**：登录失败锁定若在「验证前用旧计数比阈值」或「清理时把 until=0 当过期删除」，会出现「永远锁不上」或「一次失败就 429」。正确模型：失败则 `failedAttempts += 1`，**之后**再判断是否 `>= threshold` 并设置 `until = now + duration`；未达阈值时 `until = 0`；清理只删 `until > 0 && until < now`。
- **如何验证**：跑 `tests/account-lockout.test.mjs`：1–4 次 401、第 5 次 429、锁定中正确密码仍 429、成功登录后计数清零。

## 2026-10-12 — 金融/覆盖类 read() 不可用采样时缓存列替代当前覆盖重算

- **证据 SHA**：`32578ed6`（写入 `cumulative_funding_pnl`）、`4ea30289`（恢复 `read()` 从当前 events 累加）
- **描述**：把 funding PnL 预计算进 DB 可加速写入路径，但 `read()` 语义要求「按当前条目的 funding coverage/events 重算」。用采样行里的缓存列会在覆盖事后更新或测试改 coverage 时读出错误 PnL。
- **如何验证**：改 coverage 后不重写 samples，断言 `read()` funding 随当前 events 变；相关 trading-pnl / trading-execution 测试全绿（execution 测例对 cache 传 `stmt: null`）。

## 2026-10-12 — SQLite：缓存的是编译后的 Statement，不是绑定结果；需有界、按连接、可交错

- **证据 SHA**：`c838aca4` / `4b4e5bbe`（project-aggregation）；`5ea37c8f`（asset-ledger，上限 128 + `tests/sqlite-cache.test.ts`）；`c307a33c`（market-spread-monitor）；`281813a2`（gate-crossex-arbitrage）
- **描述**：热路径反复 `db.prepare(相同 SQL)` 浪费编译。应在 store/open 层或共享 cache 复用 Statement；每个调用方仍 bind 自己的参数；动态 SQL 要有界淘汰；连接 close 后缓存必须失效；多 reader/generator 不可共享同一 cursor statement。
- **如何验证**：mock `DatabaseSync.prototype.prepare` 计数：同 SQL 多次查询编译次数为 1；并行不同 bind 结果互不串；close 后旧 wrapper 拒绝；market store 交错 `loadQualitySamples` 游标独立。

## 2026-10-12 — 半完成的文件拆分等于死代码；要么接线要么立刻删

- **证据 SHA**：`0d04b671`（新增 Brand/Status/… 未改 App.tsx）、`8e272fd3`（Codex 审查后删除未引用文件）
- **描述**：只抽出模块而不改调用方 import，会增加构建噪音并误导后续审查。拆分提交必须同时完成接线，或同一审查周期内删除。
- **如何验证**：对新增路径跑引用搜索 / 打包；CI 或本地确认无未使用入口；避免「新增后又整目录删除」的往返。

## 2026-10-12 — React.memo 子树必须配合稳定回调与可变状态拆分

- **证据 SHA**：`8bafa81b`（AssetTrend memo + `useCallback` openHistory）；`dc998c59` / `92aee006`（aster_5x 历史表与 quality 面板 memo）
- **描述**：父组件每次 render 新建 `() => navigate(...)` 会使 memo 失效。高频 `now` tick 应与稳定历史表拆成 memo 子组件。
- **如何验证**：父级无关 state 更新时子组件不因内联函数重渲（React Profiler 或故意不稳定 props 对照）；时钟更新只刷新报告头、不重算整表。

## 2026-10-12 — 采样/图表算法优化用旧实现作 oracle，并钉死解析预算

- **证据 SHA**：`50ef16fc`（variational-grid `reduce_points` + `tests/test_history_reduction.py`）；`160e9329`（greeks 图表预解析时间戳 + `Date.parse` 线性预算）
- **描述**：单遍极值、坐标缓存必须与旧行为逐点相等，且不 mutate 输入；大规模点列上时间解析次数应 O(n)。
- **如何验证**：oracle 跨 width/count/limit；1000 点图 `dateParseCalls <= n+3`；并列极值取首次索引。
