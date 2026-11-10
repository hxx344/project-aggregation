# 研究证据与规模基线记录

本记录仅对应 #313、#317、#324、#327、#329。初始基线 `a12e583`；本轮 Windows 原生执行，无真实账户、外部压力、采集或服务器部署。独立审查、统一前端检查、生产构建和 Linux CI 由主任务集成后登记，本文不把未运行项写成通过。

## #317 持仓资金费轮转

命令：`node --test modules/crossex/tests/position-funding-scale.test.mjs`，3 项通过。真实 `createPositionFunding`，受控时钟每 2 秒轮询、reader 延迟 6 秒，无网络。

| 合法持仓 | 首次全覆盖（虚拟秒） | 首轮请求数 | 最大在途 | 限流平台恢复（虚拟秒） |
| --- | ---: | ---: | ---: | ---: |
| 8 | 12 | 8 | 4 | 60 |
| 64 | 96 | 64 | 4 | 60 |
| 256 | 384 | 256 | 4 | 60 |

预算由 `ceil(N/4) × 6 秒` 推导。另覆盖限流期间其它平台继续轮转、5 分钟来源 TTL、时钟回拨后的全部持仓重获轮次。首次覆盖不等于同一时刻所有缓存都新鲜：256 规模的覆盖时长超过 TTL，夹具仍要求过期值不返回。墙钟耗时只作为本地回归观察，不作为生产容量 SLA。

## #313 清理规模与进程中断

命令：`python -B deploy/test-cleanup-scale.py`，1 项（3 个规模）通过。每类生成 plans/jobs 后通过真实子进程在删除 10 项后 `os._exit(75)`，新 Coordinator 重入。所有清理目标均位于本次隔离临时目录；不执行安装器或服务命令。

| 每类规模 | 初始目录 | 成功删除（保留故障阶段） | 保留 | 故障项 | 扫描/信任检查次数 | 清理阶段实测毫秒 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 67 | 38 | 29 | 16 | 320 | 450.74 |
| 256 | 515 | 482 | 33 | 20 | 7,680 | 1,798.63 |
| 1,024 | 2,051 | 2,018 | 33 | 20 | 109,066 | 13,633.35 |

保护 active-plan/job-plan/running-job，维持既有历史数量与每轮 20 项预算。故障阶段 `complete=false`，故障解除后一轮重试清零，不阻塞其余可清目录。耗时含真实子进程启动与扫描，不含初始目录构造；文件系统性能会影响结果。

`deploy/test-cleanup-scale.sh` 是独立 Linux 夹具，直接 source 安装器清理函数，使用临时目录与 `systemctl`/删除命令桩；覆盖 32/256/1,024 缓存、rename 后进程退出、部分删除失败与重入，并保留 current/previous/runtime/prepared/active-work。Windows 未运行，须由现有 Linux CI 执行；未以 WSL 替代。

## #324 日志证据导出

命令：`node --test tests/entropy-lighter-evidence.test.mjs tests/entropy-lighter-lab.test.mjs tests/entropy-lighter-workbench.test.mjs`，38 项通过（导出器最终小改后仅重跑其受影响测试）。覆盖实际 CLI、新服务方法、白名单去敏、JSONL 来源行号/SHA256、会话/标的/半开时间窗、坏行/清理/raw关闭及扫描/输出预算；既有 collector 与实际工作台 API 回归通过。新增 API 公共接线的专门 HTTP 鉴权验收由主任务负责。

页面新增局部交互夹具 `tests/entropy-evidence.browser.mjs`；需要主任务的稳定生产构建后执行。当前不将夹具存在视为浏览器验收通过。

## #327/#329 期权回测

命令：`python -B -m unittest discover -s tools/options-backtest/tests -v`，34 项通过，包含既有 29 项与新 5 项；pyarrow 25.0.1、numpy 2.4.6。证据测试独立从每腿实际报价/费率/资金费事件复算费用与净额，校验 carry 退款、原引擎数值保持、真实 CLI 冻结文件身份、重复运行一致、已有目录不可覆盖、未来追加不改旧证据。预检通过真实 CLI 校验逐小时缺口、平仓尾部、趋势预热、缺月、单位冲突、缺永续/资金费及未知交割；patch 模拟器/下载器确保没有被调用，核对目录无新增缓存。

预检依赖是明示的保守上界，不预测止盈/止损/max_open 的真实交易路径；资金费时刻表完整性仍未知。交易所官方交割 TWAP 未取得，证据明确保留小时远期价近似，不升级为真实成交或官方交割。

## 独立审查后的局部修复

审查者 `p2_review_research` 复现了两个 P1 与一个 P2：标准化事件结果被白名单误删；近似交割价掩盖实际退出小时不可达；实际 2,001 档投影到 2,000 档时未标记截断。已按事件类型/嵌套路径保留结果、逐腿状态及费用字段，补充退出可达性，并在实际投影裁剪时记录缺口。未改生产采集、交易或费用计算。

增量检查：`node --test tests/entropy-lighter-evidence.test.mjs` 6/6 通过；生产 `Lab.endStudy` 的成功/timeout、`Lab` 的成功/未决双腿结果及源时钟错误均保留，生产 feed decoder 的超限原始帧/标准化盘口明确标记截断。`python -B -m unittest discover -s tools/options-backtest/tests -p test_evidence_preflight.py -v` 6/6 通过；真实引擎在缺最后两小时的夹具保持 `open_at_data_end`，预检不再就绪；定时退出可达与价格触发提前退出另行区分。原引擎 29 项源码未变，复用此前通过结果。修复增量待原审查者复核。
