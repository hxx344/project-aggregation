# Lessons from merged work

hxx344 仓库的代码由日常复盘审过再合入。每晚回顾过去一天的提交：哪些又修了一次、哪些不该合、哪些验证太薄。学到的写在这里。改代码前先读。每条教训先是规则，再是原因与证据。"Seen" 计有多少个不同复盘日发现过它。同一教训在 3 个及以上不同日期出现后，迁入 [docs/code-standards.md](docs/code-standards.md)。

2026-10-12 在 hxx344 多个仓库（project-aggregation、asset-ledger、market-spread-monitor、gate-crossex-arbitrage、variational-grid、greeks、aster_5x）共约 61 次提交。多数是性能与深色主题；反复出现的是账户锁定边界、金融 read 语义、SQLite statement 复用，以及半完成拆分与 React.memo 失效。

## Correctness at the boundary

**账户锁定：先自增失败次数，再比阈值；`until=0` 只表示「有计数、未锁定」。**
- `7543c3a1` 引入锁定后，`023eaac3` / `8e272fd3` / `5b148191` 连修：未达阈值勿写截止时间、清理勿删 `until=0`、off-by-one。最终以「失败则 `failedAttempts += 1`，之后再判断 `>= threshold`；清理只删 `until > 0 && until < now`」收敛，并用 `tests/account-lockout.test.mjs` 覆盖 1–5 次与成功清零。
- Seen 1× (2026-10-12).

**金融 / 覆盖类 `read()` 不可用采样时缓存列代替按当前 coverage 重算。**
- `32578ed6` 写入 `cumulative_funding_pnl`；`4ea30289` 恢复 `read()` 从当前 events 累加。预计算可加速写路径，但覆盖事后更新或测试改 coverage 时，用采样行缓存列会读出错误 PnL。
- Seen 1× (2026-10-12).

**标签页从后台回来时：先等 EventSource / 隧道 live，再决定是否兜底轮询；不要在 visibility/focus/pageshow 上立刻打 API。**
- `c41ce40` / `fc94b0a`：background 返回时多事件同时触发请求，但流尚未重连，约 40% 失败。正确做法：延迟约 1s 后若 stream 仍未 live 再轮询。适用于 App、TradingPositions、OilTradingPage、TradingExecution 等带轮询页。
- Seen 1× (2026-10-13).

## Fix the class, not the sample

**SQLite：缓存的是编译后的 Statement，不是绑定结果；要有界、按连接、可交错。**
- project-aggregation：`c838aca4` / `4b4e5bbe`；asset-ledger：`5ea37c8f`（上限 128 + 测试）；market-spread-monitor：`c307a33c`；gate-crossex-arbitrage：`281813a2`。热路径反复 `db.prepare(相同 SQL)` 浪费编译；各调用方仍各自 bind；close 后缓存失效；多 reader/generator 不可共享同一 cursor。
- Seen 1× (2026-10-12)（同日跨四仓出现，仍计一个日期）。

**半完成的文件拆分等于死代码：同一提交完成接线，或同一审查周期内删除。**
- `0d04b671` 抽出 Brand/Status 等未改 `App.tsx` import；`8e272fd3` 审查后删除未引用文件。只拆不接线会增加噪音并误导后续审查。
- Seen 1× (2026-10-12).

## Verification

**采样 / 图表算法优化用旧实现作 oracle，并钉死解析预算；不 mutate 输入。**
- variational-grid `50ef16fc`：`reduce_points` 单遍扫描 + `tests/test_history_reduction.py` 与旧实现逐点对齐，并列取首次索引。greeks `160e9329`：图表预解析时间戳，`Date.parse` 线性预算（如 1000 点 `dateParseCalls <= n+3`）。
- Seen 1× (2026-10-12).

**`React.memo` 子树必须配合稳定回调，并把高频可变状态（如时钟 tick）与稳定历史表拆开。**
- asset-ledger `8bafa81b`：`AssetTrend` memo + 稳定 `openHistory`；aster_5x `dc998c59` / `92aee006`：历史表与 quality 面板 memo。父组件每次新建内联 `() => …` 会使 memo 失效。
- Seen 1× (2026-10-12).

## Moved to the code standards

尚无。同一教训在三个及以上不同复盘日出现后再迁入 `docs/code-standards.md`，并在此留下索引。
