# 组合受理后的成交跟踪

风险等级：R3（提交响应与执行状态读取契约）；基线：`00fe4f104361f4da3b8e3fefd795724eb7af45c3`。

组合提交成功后绑定服务端返回的具体执行任务，顶部持续显示各腿成交、目标、剩余、进度、委托编号与最后核对时间。全部成交和停止后保留展开结果；暂停、待核对、撤单中均按实际状态提示，读取失败保留最后证据。确认成功时定位跟踪卡，后续轮询不抢焦点。委托价明确标注，不冒充成交均价或逐笔成交价格。

范围：工作台 `TradingExecution`、提交成功响应、现有状态 GET 的可选 `jobId`、相关类型/样式和测试。后台订单状态机、交易适配器、下单参数、数据库与部署流程未改。回滚本次提交并发布即可；旧客户端忽略新增回执字段，无数据迁移，不删除已有交易记录。

独立审查发现并修复一个 P2：长时间运行的任务完成时，可能被 31 个创建更晚的终态任务挤出历史分页。仅保留前端最后快照会永远停在运行中。现有轮询携带目标 ID，服务端在原列表外最多补充这一任务；不存在明确返回 404，不能把缺失视为完成。独立内存执行探针复核：真实 `tick()` 将两腿全部成交，普通历史不含原任务，带目标的读取返回 31 条并含 `completed`，各腿成交/剩余为 `2/0`，读取新增交易所调用为 0。

实际验证均在 Windows 原生环境执行，未使用 WSL、真实交易账户或服务器部署：

- 从基线导出并仅应用本任务差异的隔离源码运行 `node --test tests/trading-execution.test.mjs tests/trading-execution-http.test.mjs`：116/116。此前工作区首轮新增分页夹具将时钟推进到租约过期，失败已通过修正夹具时间解决，未放宽生产保护。
- 分页修复后运行 `node --test --test-name-pattern='submission receipt|session-bound and one-use|partial fill resumes|tick and state read|execution HTTP routes' tests/trading-execution.test.mjs tests/trading-execution-http.test.mjs`：6/6。覆盖原回执、继续剩余、超分页、去重、未知任务、未登录与非法查询、读取不触发交易所调用；未受影响的执行状态机检查复用前轮有效结果。
- 隔离最终源码 `node node_modules/typescript/bin/tsc --noEmit` 与 `node node_modules/vite/bin/vite.js build --configLoader runner` 通过。最终页面包为 `OilTradingPage-Ds4BwiLh.js`，使用工作台真实页面入口和隔离静态服务；全部 API 由夹具拦截。
- `tests/trading-execution.browser.mjs` 最终通过，132 请求：受理重试、各腿进度、极小余量、多任务不串单、缺任务、读取失败、暂停/待核对/停止、超历史分页的完成、结果保留、刷新恢复、桌面/390px 和会话过期。持续跟踪及刷新未新增写操作；页面异常为 0。旧夹具按品种独立偏好补显式跨所选择，登出等待登录界面而非卸载时可能取消的 GET。
- `tests/trading-anthropic.browser.mjs`（22 请求）、`tests/trading-okx.browser.mjs`（27 请求）通过；Anthropic 有效展示结果在仅新增通用查询参数后复用。`tests/trading-resume.browser.mjs` 的 9 类恢复场景通过，写请求为 0。
- `node --test tests/lessons-routing.test.mjs`：2/2。L107 首次追加位置误入归档，检查发现后移入活动经验区，未修改断言。

独立审查由 `/root/review_execution_tracking` 以显式 `gpt-6-astra / ultra`、隔离上下文完成，固定补丁 SHA256：`73131ac9858d537b129cfc57cb74cb0cd70be1d41ae97c789775444aa7e3235e`。覆盖全部本任务代码、直接调用方与测试；无遗留 P0/P1/P2。Codex Security 差异审查沿用同一任务扫描，工作区曾存在其他任务并发差异，审查明确排除它们，不将局部覆盖描述为全仓扫描。

自审：通用、数据精度、状态与失败路径、鉴权、前端和交付适用项已检查。成交量保持原字符串，百分比按十进制定点向下显示，不跨腿累加不同单位；终态仅由服务端判定。读取保持 12 秒超时、单链轮询及原取消/代次协议，没有新交易所调用或自动提交。无数据库迁移、依赖升级、安装配置或性能优化，不新增无关全模块回归。提交前执行 staged review gate，推送后由既有 CI 构建候选包并核实正式发布。
