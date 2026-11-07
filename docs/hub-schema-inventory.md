# hub.sqlite 结构盘点（E1a）

版本：2026-11-07，源码基线 `148e1f2`。本文是[技术与架构演进](evolution-plan.md) E1 第 1 步的产出：盘点 `hub.sqlite` 全部建表、索引、加列与回填入口，定义版本 0 的已知历史布局、版本 1 的完整结构、上一可回滚版本，以及后续批次的唯一迁移入口。本批只读，不改代码。

## 1 结论

- 当前 `hub.sqlite` 没有任何代码读写 `PRAGMA user_version`，新建库为 0。账户写入器的 `aw_*` 表在独立的 `execution-control.sqlite`，不在本库范围内。
- 全部结构由 7 个文件、6 个创建点在启动时以 `CREATE … IF NOT EXISTS` 与“按列名检查后 `ALTER`”自愈生成，共 **26 张表、9 个显式索引、1 个虚拟生成列**（第 3 节）。历史上只有加表、加列、加索引和一次表替换，没有删列、改列类型或改约束。
- 已知历史布局都能被当前代码升级到与新建库一致的列结构（第 4 节，已用旧布局库实测）。唯一结构性残留是孤立的旧表 `trading_views`。
- 发现两处**同名不同定义**的漂移陷阱：索引与生成列只按名字判断是否已存在，表达式变化后旧库保留旧定义。执行器遇到不同定义的部分索引会在构造时抛出 `no query solution`，runtime 无法启动（第 5 节）。当前线上定义与代码一致，不是现存故障，但下一次修改 `FINAL_EXECUTION` 或索引条件就会触发。
- 版本 1 的标记批次与所有可回滚目标兼容：安装器保留的上一版本及其之前的版本都不读 `user_version`，只写该值不影响它们读写（第 6 节）。

## 2 创建点与进程

| 创建点 | 表 / 索引 | 运行进程 | 事务 |
| --- | --- | --- | --- |
| `server/control/schema.mjs:16` `TABLES`，由 `openHubDatabase` 执行（`:31`） | settings、projects、snapshots、sessions、execution_entries、login_ip_attempts、login_account_guard、login_pending、portal_tickets、portal_grants；idx_sessions_expires、idx_portal_tickets_expires、idx_portal_grants_expires | runtime、服务模式 API、单进程 `app.mjs`/`setup.mjs`；候选 API 以 `create:false` 只校验（`assertTables`，`:50`） | `immediate()` |
| `server/trading.mjs:177-181`、`:196` | trading_accounts（含 `account_mode` 补列与回填）、trading_views_v2 | runtime 数据面 | 前者 `immediate()`，后者无 |
| `server/trading-pnl.mjs:25` `migrateSamples` | trading_pnl_samples、trading_pnl_samples_v2（含 `cumulative_funding_pnl` 补列）、trading_pnl_migrations；`pair_samples_v2` 一次性回填 | runtime 数据面 | SAVEPOINT |
| `server/trading-execution.mjs:96-109`，部分索引 `:63-73` | execution_accounts、execution_jobs、execution_orders、execution_previews、execution_requests、execution_locks、execution_lease、execution_stop_requests；execution_jobs_unfinished、execution_jobs_finished、execution_orders_job、execution_orders_unsettled、idx_execution_previews_expires | runtime 数据面 | 无 |
| `server/trading-auto.mjs:152` | execution_auto_rules | runtime 数据面 | 无 |
| `server/trading-anthropic-reduction.mjs:12-13` | execution_anthropic_reduction（含单行种子） | runtime 数据面 | 无 |
| `server/observability.mjs:33`、`:49-53` | platform_baseline_samples（含 `valid_sample` 虚拟生成列补列）、platform_baseline_valid_bucket | runtime 数据面 | 无 |

- 业务表只由 runtime 单进程创建，所以没有事务的 `CREATE`/“检查后 `ALTER`”目前没有并发问题。一旦出现第二个创建者，这些路径就需要进入写锁。
- API 进程直接读业务表 `execution_jobs`（`server/control/execution-jobs.mjs:36-50`，更新准入的空闲检查）：表缺失按无任务处理，同名不同定义的索引回退为全表解析。`assertTables` 不覆盖这张表。
- 恢复链路有各自的结构假设：`server/recovery/admission.mjs:64` 的 `HUB_SCHEMA` 检查 5 张执行表的列，`server/recovery/restore.mjs:102-106` 要求 settings/projects/sessions 存在，并按表名清理会话与短期表，`server/recovery/inventory.mjs:199` 列出检查点日志表。`inventory.mjs:175` 只把 `user_version` 记入备份清单，不做比较。

## 3 版本 1：当前完整结构

以当前代码在空目录依次执行 `openHubDatabase` 与 6 个创建函数后导出 `sqlite_schema` 为准（`*` 为虚拟生成列）：

| 域 | 表：列 |
| --- | --- |
| 控制面 | settings: key,value · projects: id,json,credentials · snapshots: id,json（FK projects ON DELETE CASCADE）· sessions: id,csrf,expires · execution_entries: id,created_at,expires_at |
| 登录与 Portal | login_ip_attempts: ip,count,until · login_account_guard: account,failed,first_failure_at,until · login_pending: id,account,expires · portal_tickets: digest,project_id,session_id,revision,destination,expires · portal_grants: digest,project_id,session_id,revision,expires |
| 账户读取 | trading_accounts: exchange,revision,credentials,verified_at,snapshot,account_mode · trading_views_v2: pair_key,days,version,source_key,json |
| 盈亏采样 | trading_pnl_samples: time,binance_revision,bybit_revision,binance_at,bybit_at,unrealized_pnl（仅作迁移源）· trading_pnl_samples_v2: pair_key,revision_key,time,first_at,second_at,unrealized_pnl,cumulative_funding_pnl（末列已不读写，为统一结构保留）· trading_pnl_migrations: id |
| 原生执行 | execution_accounts: exchange,revision,credentials,account_mode,identity,key_label,verified_at,snapshot · execution_jobs: id,json · execution_orders: id,job_id,json · execution_previews: id,session,expires,json,consumed · execution_requests: id,preview_id,job_id,session · execution_locks: resource,job_id · execution_lease: id,owner,expires · execution_stop_requests: job_id,requested_at |
| 自动化 | execution_auto_rules: id,revision,enabled,created_at,config,state · execution_anthropic_reduction: id,revision,json |
| 基线 | platform_baseline_samples: bucket_ms,schema_version,json,valid_sample* |

索引 9 个：idx_sessions_expires、idx_portal_tickets_expires、idx_portal_grants_expires、idx_execution_previews_expires（部分）、execution_orders_job、execution_jobs_unfinished（部分，表达式）、execution_jobs_finished（部分，表达式）、execution_orders_unsettled（部分）、platform_baseline_valid_bucket。

版本 1 的结构判定不能只看表名和列名，需要比较三层：

1. 每张表的 `PRAGMA table_xinfo`（名称、类型、非空、默认值、主键、hidden）。已实测：经 `ALTER` 补列的旧库与新建库逐项一致，列顺序相同。表 `sql` 文本会因 `ALTER` 而不同，不能直接比较。
2. 每个索引的 `sqlite_schema.sql` 归一化文本。部分索引的 `WHERE` 由 `FINAL_EXECUTION` 等代码常量生成，名字相同不代表定义相同。
3. `valid_sample` 的生成表达式（只存在于表 `sql` 中）。

## 4 版本 0：已知历史布局

`user_version=0` 的库视为版本 0。当前代码能把以下差异就地升级到第 3 节的结构；除此之外的差异都属于未知布局。

| 差异 | 存在区间（首次引入 → 修正） | 当前处理 |
| --- | --- | --- |
| 缺少任意整张表或索引 | 各表首次出现前：控制四表 `710a682`（09-21）；交易与执行表 10-07（`d63940f`、`c38406c`）；idx_sessions_expires、idx_execution_previews_expires 10-12（`0c1ef2c`）；execution_entries 10-24（`fc3b81f`）；login_* 与 portal_* 10-26（`2bd64de`、`00198ad`）；platform_baseline_samples 与 execution_stop_requests 10-19（`c76b196`、`519d2e8`）；execution_jobs 部分索引 11-05（`8bdea00`）；execution_orders_unsettled 11-06（`aea9c8b`）；execution_auto_rules 11-06（`8fc0a62`）；execution_anthropic_reduction 11-07（`00fe4f1`） | `IF NOT EXISTS` 创建 |
| trading_accounts 缺 `account_mode` | `d63940f` → `32fac9d`（同日 10-07） | `ALTER` 补列，bybit/okx 回填 `unified` |
| trading_pnl_samples_v2 缺 `cumulative_funding_pnl` | `e556f22`（10-09）→ `32578ed`（10-12） | `ALTER` 补列 |
| platform_baseline_samples 缺 `valid_sample` | 只在 `c76b196` 的开发过程中可能出现 | `ALTER` 补生成列 |
| 多出孤立表 `trading_views`（days 主键单对视图） | `7756241`（10-07）创建，`e556f22`（10-09）改用 `trading_views_v2` 后不再读写，从未删除 | 无处理，残留 |
| `pair_samples_v2` 未回填 | `e556f22` 之前的库 | `trading_pnl_migrations` 标记一次性回填 |

控制表与执行表自首次出现起列结构未变；历史上没有删列、改类型或改约束。

## 5 漂移陷阱与登记

| 级别 | 问题 | 证据 | 处理批次 |
| --- | --- | --- | --- |
| P2 | 执行器只对 `no such index` 重建部分索引；同名不同定义时 `INDEXED BY` 抛出 `no query solution`，`createTradingExecution` 构造失败，runtime 无法启动。API 侧（`execution-jobs.mjs:47`）已兼容。 | `server/trading-execution.mjs:133-140`。在临时库预建 `WHERE status NOT IN ('completed')` 的同名索引，构造函数抛出 `no query solution` | E1c：索引定义纳入版本，变化时在迁移事务内 `DROP`+`CREATE`；在此之前修改 `FINAL_EXECUTION`、`JOB_CREATED` 或 `UNSETTLED_ORDER` 必须同时处理旧索引 |
| P3 | `valid_sample` 只按列名判断是否已存在，生成表达式变化后旧库保留旧表达式，基线有效性静默按旧口径计算 | `server/observability.mjs:49-53` | E1c：表达式变化作为版本迁移（重建列或表） |
| P3 | 孤立表 `trading_views` 占用备份与恢复检查 | 第 4 节 | 版本 1 允许其作为已知遗留存在；需要清理时单独一次迁移删除 |

当前线上定义与代码一致：部分索引自 `8bdea00`/`aea9c8b` 引入后，生成它们的常量文本没有变化（`FINAL_EXECUTION` 自 10-24 未改，`aea9c8b` 只是把条件移到 `execution-jobs.mjs` 共享，生成的 SQL 相同）。

## 6 上一可回滚版本

- 安装器 `prune_releases`（`deploy/install.sh:3095`）保留当前版本、`previous_release`、两个 API 槽各自指向的版本、运行时所在版本，以及待激活的准备版本，其余清理。所以程序回滚的下限是 `previous_release`，双槽回滚的目标也在这个集合内。
- 这些版本都不读 `user_version`，表和列的检查都按名字做，不会因多出的表或列失败；业务读取用 `SELECT *` 或显式列名，插入用显式列名（如 `INSERT OR IGNORE INTO trading_accounts(exchange,account_mode)`）。
- 推论：
  1. 只写 `user_version=1` 的标记批次，可以安全回滚到上述任一版本。
  2. 首批 DDL 只能加表、加可空列或带默认值的列、加索引，不能改已有索引或生成列的定义：旧代码的显式列插入必须仍然成功，旧代码的 `IF NOT EXISTS` 也不会修复被改过的定义。
  3. 改索引或生成列定义的迁移（第 5 节 P2/P3）属于不兼容迁移，要等回滚集合里的版本都已包含“同名不同定义”的兼容处理后才能执行。

## 7 唯一迁移入口与后续批次

已确定的选择（回答 [演进计划第 7 节](evolution-plan.md#7-待决策) 第 1 项）：

- **版本 1 布局**：第 3 节全部对象，按三层比较；允许已知遗留表 `trading_views`。
- **受支持历史布局**：第 4 节列出的版本 0 差异。
- **上一可回滚版本**：安装器保留集合（第 6 节）。目前这个集合里没有任何版本读取 `user_version`。
- **唯一入口**：新增 `server/control/hub-schema.mjs`，显式写出版本 1 的期望结构（不靠运行创建函数反推），提供 `inspectHubSchema(db)`，返回 `{ userVersion, state: 'v1' | 'v0-known' | 'unknown' | 'newer', diff }`；后续的 `migrateHub(db)` 按版本顺序执行。

建议批次：

| 批次 | 内容 | 级别 | 验收 |
| --- | --- | --- | --- |
| E1b-1 | `inspectHubSchema` 与测试夹具：新建库、第 4 节各历史布局、同名不同定义的索引、未知列、`user_version` 过新 | R1 | 每种布局的判定结果确定；不写库 |
| E1b-2 | runtime 在数据面全部创建函数完成后，在 `immediate()` 内重新判定，`v0-known` 且结构已完整时写 `user_version=1`；`unknown` 只记诊断、不改版本。候选 API 遇到 `newer` 拒绝晋升 | R3（数据库结构） | 历史库升级、并发启动、标记后回滚到 `previous_release` 读写正常 |
| E1c | `migrateHub` 有序迁移：结构变更、回填与版本推进在同一事务；首个迁移处理第 5 节的索引定义（等兼容处理进入回滚集合后） | R3 | 演进计划 E1 退出条件：迁移中断与重跑、迁移后注入启动/健康失败并回滚 |

## 8 复现方法

本批的结论来自两次本地实测（脚本未提交，按下面描述即可重写）：

1. 在临时目录调用 `openHubDatabase`，再依次调用 `createTrading`、`createTradingExecution`、`createTradingAuto`、`createAnthropicReduction`、`createBaseline`（客户端用空工厂，间隔设成很大的值），导出 `sqlite_schema` 与各表 `table_xinfo`。结果是 26 张表、9 个显式索引、`user_version=0`。
2. 手工建一个旧布局库：trading_accounts 缺 `account_mode`，trading_pnl_samples_v2 缺末列，带孤立的 `trading_views`，再预建一个条件不同的 `execution_jobs_unfinished`。用当前代码打开后：两张补列表的 `table_xinfo` 与新建库一致，`trading_views` 仍在，执行器构造抛出 `no query solution`。
