# 交易与行情界面偏好

风险等级：R3（交易表单恢复）；基线：b524404。

影响面：工作台交易分区、组合交易表单和 Monitor 原油、海力士、Anthropic 面板。去掉价差下单顶部三个快捷按钮，在原油/海力士跨所或四腿预设中保留组合下拉选择。按品种保存有限的界面偏好，现有有效 URL 参数优先。

恢复范围为白名单选择、执行参数、股数假设和展示选项；数量、价格、账户连接、行情、持仓、预览、请求编号和确认状态仍为临时状态。恢复后必须重新输入交易数量、预览并确认。存储不可用或损坏时使用默认值且页面可操作；Monitor 水合完成后恢复，避免默认值提前覆盖旧偏好。

不涉及服务端交易协议、数据库和部署配置。回滚撤销本次前端提交即可，新版浏览器存储键可保留或清除，不影响服务器订单与数据。

实际验证（Windows 原生 Node 24.22.1，未使用 WSL）：

- `node --test tests/trading-preferences.test.mjs modules/monitor/tests/view-preferences.test.mjs`：8 项通过，覆盖白名单、数组/对象枚举、损坏/禁用存储、股数与 URL 优先；随后仅重跑修改过的根偏好 6 项和 `tests/lessons-routing.test.mjs` 2 项，均通过。
- 根 `pnpm run check`、Monitor `pnpm --dir modules/monitor typecheck` 与 7 个改动 Monitor TS/TSX 文件的定向 ESLint 均通过。
- 根 `pnpm run build`、Monitor `pnpm --dir modules/monitor build` 通过。发现工作区有并发任务后，导出暂存内容到独立验证目录，根用 `node node_modules/typescript/bin/tsc --noEmit` 和 `node node_modules/vite/bin/vite.js build --configLoader runner` 再验证；Monitor 构建同时通过。隔离根产物为 `OilTradingPage-IR4sR1R9.js` / `index-C3DRX494.js`，不包含并发的自动减仓修改。
- `tests/trading-preferences.browser.mjs`：隔离生产入口通过 ANT/Lighter、开平仓、数量方式、下单方式、执行参数、股数、分区恢复；数量/旧预览不恢复，重载零写请求，非当前品种的坏配置不阻断入口。
- `tests/monitor-anthropic-trades.browser.mjs`：真实工作台桥接与 SSR iframe 通过合约来源、区间、图表模式、指标、展开状态、市场隔离、全部区间的 null 恢复及 URL 优先；原有成交标记、旧数据保留、后台停读和 390px 布局检查仍通过，pageerror 为 0。
- `tests/trading-anthropic.browser.mjs`、`tests/trading-okx.browser.mjs`、`tests/trading-spread.browser.mjs`、`tests/trading-resume.browser.mjs` 通过。OKX/恢复夹具原有控件与响应漂移已同步，恢复夹具使用全新隔离浏览器会话，自动写请求为 0。与最终严格坏值校验无关的有效交易路径结果复用；最终偏好、价差和恢复检查使用隔离根产物。
- `git diff --cached --check` 与 `node scripts/review-gate.mjs --staged` 通过。完整仓库回归和 Linux 发布验收交由既有 CI；本地无真实账户交易或服务器部署。

独立只读审查者 `/root/review_preferences`（调用参数 `gpt-6-astra` / `ultra`）按 D1–D7 检查了固定差异与直接调用路径。初轮补丁 SHA256 `F5CCBF36B19C387E20D7FFED8A3D02CDC87AD995D5CCFC7245DE98FDAB4C9ABA` 发现一项 P1：存储枚举经 `String(...)` 转换会导致初始化异常或方向错配。修复后的固定补丁 `8BCC751198250AFC558FEC004C2321DF435890D9C9D59A8608CAF5AC1B3D275A` 经独立 8 组坏数据探针和增量审查确认关闭，最终 P0/P1/P2 均为 0。没有把作者浏览器结果归为审查者亲自执行。

安全审查沿用 Codex Security 差异审查标准。正式扫描工具拒绝绑定固定补丁（工作树内容选择不匹配），未创建 scanId、封存报告或 SARIF；只读能力预检 ready 后完成了上述独立本地固定差异审查，未修改运行配置。安全检查覆盖 localStorage → 表单 → 服务端 preview/start 的授权边界，未扩大全仓。

自审：通用、状态恢复、失败路径、前端、交付路径适用项已检查；账户/资金读数仍来自服务端，表单偏好不授权下单。计算公式、外部调用预算、后端状态机、数据库/迁移与安装激活未改，不因此新增全模块回归。无性能优化主张。用户及并发任务的改动未纳入本提交。正式发布与远端身份在提交后通过既有 CI/发布流程核实。
