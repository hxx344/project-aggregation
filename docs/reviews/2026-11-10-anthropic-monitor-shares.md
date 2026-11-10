# Anthropic 监控股数同步

## 变更前范围

- 用户要求 Anthropic 监控溢价使用同步交易中心设置的股数。基线 `a12e583` 的监控计算固定使用流通 12.7、完全稀释 16.7（十亿股），交易中心则保存浏览器偏好。
- 风险等级：R3（现有跨模块桥接新增只读字段及能力）。影响工作台股数保存通知、Monitor 桥接、卡片/历史/相关持仓派生展示；不修改交易执行、订单计划或自动规则。
- 以宿主同一份有效股数为输入：Binance 每单位 S 股、xyz 每单位 1 股、io/RH 每单位 F 股；溢价为 `(Binance / S) / (对比价格 / 对应股数) - 1`。原始报价与历史数据不改写。
- 嵌入页面在配置未同步或无效时不展示推定溢价；独立页面明确标示默认口径。配置变化重算历史及统计，不额外抓取行情。服务端全局摘要无法读取浏览器偏好，只保留明确标注的默认口径。
- 回滚：撤销本次提交并按已有正式发布流程发布；无数据库迁移或用户配置格式变更。旧桥接忽略新增字段，新模块对缺少能力的旧宿主显示未同步。

## 验证计划

根目录及 Monitor 类型检查；股数偏好、桥接、Anthropic 市场计算、摘要、关联持仓相关单测；生产构建的工作台 iframe 验收首次自定义值、三腿换算、修改后切回/跨标签同步、未知配置及水合。仅使用隔离接口夹具，不访问交易账户。独立只读审查固定差异后，运行暂存门禁并提交、推送、等待发布所需 CI、正式发布和远端核实。

## 已执行证据

- Windows Node v24.22.1：根目录 `pnpm run check`、Monitor `pnpm run typecheck` 均通过。
- `node --test modules/monitor/tests/anthropic-shares.test.mjs modules/monitor/tests/anthropic-market.test.mjs modules/monitor/tests/related-position-totals.test.mjs modules/monitor/tests/monitor-summary.test.mjs`：37/37 通过。
- `node --test tests/trading-preferences.test.mjs`：9/9 通过；Monitor `node --experimental-strip-types --test tests/hub-bridge.test.mjs tests/hub-fills.test.mjs`：34/34 通过。
- 根目录 `node node_modules/vite/bin/vite.js build --configLoader runner` 与 Monitor `node scripts/build.mjs` 通过，后者包含模块类型检查、client/SSR 构建和产物清单校验。产物仅用于本机验收，不提交。
- `node --test tests/lessons-routing.test.mjs`：2/2 通过。首次在 Windows 文本写入后发现 LF 分节读取不匹配，已恢复文档 LF 并把新条目放回活动区，随后通过。

## 自审范围

- 数据计算：三种对比合约的单位、分母方向及缺失值一致，历史仍存原生价格，设置变化重算派生数据；报价来源时间与资金费处理不变。
- 状态与失败：可信宿主传参、同窗保存通知、跨窗 storage、能力撤回及重连清理；未知配置撤回派生数值。没有新增远程请求、重试或缓存。
- 资金与权限：参数仅供显示，执行计划、数量/价格输入、自动规则和服务端授权均未修改。
- 交付：工作树从 `a12e583` 隔离，未包含主工作区其他未提交更改；回滚不需要迁移。没有服务器部署或 Sites 发布。
- 不适用：数据库、安装器修改、依赖升级、性能优化、样式重构与真实账户执行测试。Linux 产物验收交由既有发布 CI，未使用 WSL。

## 浏览器与独立审查

- `playwright-cli -s=antshares run-code --filename tests/monitor-anthropic-shares.browser.mjs`：通过，8.1 秒，`pageerrors=0`、账户及配置 API 写入 `0`。生产工作台 preview 4187 + Monitor SSR 3197。
- 原生报价 Binance=1200、xyz=80、io=2000、RH=800：S=10/F=20 时三腿 50%/20%/200%；跨标签变为 S=12/F=30 后 25%/50%/275%；交易中心真实输入 S=15/F=30、切回与刷新后 0%/20%/200%。详情、均值、近期表、SVG 键盘 tooltip、概览和关联持仓均一致。
- 验证伪造 source/origin 不能改设置；旧宿主缺能力、非法值时三项溢价为 `—`、无默认曲线；未回复的宿主不发市场读取。浏览器夹具调试中修正了自身 tooltip/locator 和缺少 `alerts.config` 的测试响应，未发现对应产品缺陷。旧成交标记夹具新增默认股数隔离及恢复，未重复运行其无关完整场景。
- 独立审查：隔离上下文 `gpt-6-astra / ultra`，基线 `a12e583` 至本批工作树；检查调用链、比值口径、同步与未知状态、SSR、消息来源/能力、历史和持仓一致性、测试与经验路由。未发现新增 P0/P1/P2；审查者另执行 `git diff --check a12e583` 通过，复用团队已执行的类型/单测/构建结果。
- 既有边界：两个交易中心标签同时保留编辑表单时不相互刷新草稿，属于基线行为；切回监控再返回交易中心会卸载/重读偏好，本次未新增旧草稿写回。
