# Code Review Lessons

每条教训记录其出现的日期，出现 3 次后自动升级为硬性规范。

## 活跃教训

### 账户锁定逻辑必须先自增再比阈值
**出现日期：** 2026-10-12
**证据：** 5b148191, 023eaac3, 8e272fd3
**描述：** 登录失败锁定的正确模型是：失败则 `failedAttempts += 1`，**之后**再判断是否 `>= threshold`；未达阈值时 `until = 0` 表示「仅计数未锁定」；清理时只删 `until > 0 && until < now`。如果在验证前用旧计数比阈值，或把 until=0 当过期删除，会出现「永远锁不上」或「一次失败就 429」。
**如何验证：** 跑专项测试确认：1-4 次 401、第 5 次 429、锁定中正确密码仍 429、成功登录清零

### 金融覆盖类 read() 不可用采样时缓存列替代当前覆盖重算
**出现日期：** 2026-10-12
**证据：** 32578ed6, 4ea30289
**描述：** 把 funding PnL 预计算进 DB 可加速写入路径，但 `read()` 语义要求「按当前条目的 funding coverage/events 重算」。用采样行里的缓存列会在覆盖事后更新或测试改 coverage 时读出错误 PnL。
**如何验证：** 改 coverage 后不重写 samples，断言 `read()` funding 随当前 events 变；相关 trading-pnl / trading-execution 测试全绿

### SQLite 缓存的是编译后的 Statement，不是绑定结果
**出现日期：** 2026-10-12
**证据：** c838aca4, 4b4e5bbe, 536103b7, 7a2edd6d, 55ea4486, 5ea37c8f, c307a33c, 281813a2
**描述：** 热路径反复 `db.prepare(相同 SQL)` 浪费编译。应在 store/open 层或共享 cache 复用 Statement；每个调用方仍 bind 自己的参数；动态 SQL 要有界淘汰；连接 close 后缓存必须失效；多 reader/generator 不可共享同一 cursor statement。
**如何验证：** mock `DatabaseSync.prototype.prepare` 计数：同 SQL 多次查询编译次数为 1；并行不同 bind 结果互不串；close 后旧 wrapper 拒绝；market store 交错 `loadQualitySamples` 游标独立

### 半完成的文件拆分等于死代码，要么接线要么立刻删
**出现日期：** 2026-10-12
**证据：** 0d04b671, 8e272fd3
**描述：** 只抽出模块而不改调用方 import，会增加构建噪音并误导后续审查。拆分提交必须同时完成接线，或同一审查周期内删除。
**如何验证：** 对新增路径跑引用搜索 / 打包；CI 或本地确认无未使用入口；避免「新增后又整目录删除」的往返

### React.memo 子树必须配合稳定回调
**出现日期：** 2026-10-12
**证据：** 402be956, 8bafa81b, dc998c59, 92aee006
**描述：** 父组件每次 render 新建 `() => navigate(...)` 会使 memo 失效。高频 `now` tick 应与稳定历史表拆成 memo 子组件，并用 useCallback 稳定传入的回调。
**如何验证：** 父级无关 state 更新时子组件不因内联函数重渲（React Profiler 或故意不稳定 props 对照）；时钟更新只刷新报告头、不重算整表

### 标签页恢复时必须延迟轮询并等待 EventSource 重连
**出现日期：** 2026-10-13
**证据：** c41ce40, fc94b0a
**描述：** 从 background 返回时，多个事件（visibilitychange, focus, pageshow）同时触发立即 API 请求，但此时 EventSource/SSH 隧道尚未重连，导致 40% 请求失败。正确做法：延迟 1 秒后检查 stream 是否已 live，未 live 才发起兜底轮询。适用于所有带轮询的页面（App.tsx、TradingPositions、OilTradingPage、TradingExecution）。
**如何验证：** 切换标签页返回后，观察 Network 面板：EventSource 先重连，poll 请求晚 1 秒且仅在 stream 未建立时发出；失败率接近 0%

### 采样/图表算法优化用旧实现作 oracle，并钉死解析预算
**出现日期：** 2026-10-12
**证据：** 50ef16fc, 160e9329
**描述：** 单遍极值、坐标缓存必须与旧行为逐点相等，且不 mutate 输入；大规模点列上时间解析次数应 O(n)。
**如何验证：** oracle 跨 width/count/limit；1000 点图 `dateParseCalls <= n+3`；并列极值取首次索引

---

## 已归档教训
（升级到 code-standards.md 的教训移到这里作为历史记录）
