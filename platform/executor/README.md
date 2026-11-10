# 执行器原型（统一平台阶段 1）

统一交易与资产平台阶段 1 的首切片：原油 CLUSDT 在 Binance 与 Bybit 之间的跨所双腿开平仓，覆盖预览、确认、执行、核对、停止、超时、重启接管与故障注入。方案见 `docs/unified-platform-plan.md` 与 `docs/unified-platform-phase0.md`，盘点与预算见 `docs/unified-platform-phase0-inventory.md`。

## 边界

- 只有进程内模拟场所，没有真实交易所传输；契约层拒绝任何非模拟传输或非模拟环境。
- 独立入口、独立数据目录 `executor.sqlite`；拒绝含 `hub.sqlite`、`execution-control.sqlite`、`credentials.key` 或 `modules` 的目录，不读写工作台数据。
- 不在工作台发布包内（`deploy/package-release.py` 不打包 `platform/`），也不注册任何服务。
- HTTP 只监听 `127.0.0.1`，校验 Host，会话 cookie 为 HttpOnly + SameSite=Strict，写请求需 `x-pa-executor: 1` 与 JSON 体，体积上限 16 KiB。
- ANT（ANTHROPICUSDT）只读，且只有 Binance 可读。

## 运行

需要 Node 24（使用内置 `node:sqlite` 与类型擦除），无第三方依赖；类型检查使用仓库根目录的 TypeScript。

```powershell
cd platform/executor
node src/main.ts --data-dir D:\tmp\pa-executor --port 4710   # 打开 http://127.0.0.1:4710/
..\..\node_modules\.bin\tsc -p tsconfig.json                  # 类型检查
node --test test/*.test.ts                                     # 行为、恢复、故障注入与 HTTP 边界测试
node scripts/measure.ts                                        # 混合负载测量；未达建议预算时退出码 2
```

## 关键语义

- 未知结果不重发：发送中断记为 `unknown`，按原客户订单号核对；过观察窗、间隔多次查无且账户无痕迹才判定 `not-created`。
- 单写者租约带代次：租约过期后实例永久停止写入；新实例接管时把 `prepared` 记为 `not-sent`、`sending` 记为 `unknown`，未完成任务只核对并撤挂单，不再发送。正常关闭交还租约。
- `attention`（敞口不平衡、对冲腿被拒、撤单用尽、委托过观察窗仍未知、对冲腿账户读取持续失败）保留合约锁并继续核对，人工确认后才释放。
- 预览要求两腿桶数完全相等；对冲量按首腿实际成交换算并向下取整到对冲所步长。
- 入口执行循环连续失败 5 次或失去租约时交还租约并以非零码退出，由外部重启接管。
- 数量与价格用精确十进制字符串，不经过浮点。

## 已知限制

- 本机测量（Windows，非目标服务器）中，单次写事务持锁最大值与事件循环阻塞 p99 未达建议预算，原因是主线程同步提交在 `synchronous=FULL` 下等待 fsync；写入线程或批量提交留到阶段 2 选型。数值见盘点文档第 8 节。
- 未建模 Bybit 原生追价策略；未接入共享写者登记 `execution-control.sqlite`；事件与命令没有保留期限。
- 没有价格保护（只校验盘口新鲜度）；会话 cookie 只防跨站请求，不是本地鉴权。接真实账户前须补齐，见盘点文档第 9 节。
