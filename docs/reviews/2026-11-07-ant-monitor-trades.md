# ANT 监控成交与关联盈亏

## 范围与回滚

风险等级 R3：在既有只读成交契约中新增 Anthropic 市场，影响内置 Asset 成交读取、工作台成交桥和 Monitor 展示。未修改交易执行、鉴权、凭据处理、数据库结构及服务器部署。

- 图表接入 Binance / OKX 的真实 ANT 成交，用已确认的持仓前后变化分类入场、出场、调仓或开平未知；保留原生价格、数量、币种及账户身份。标记纵坐标为所选比较合约的同根已收盘 15 分钟 K 线，明确不是双腿成交价差；缺口及未收盘时仅列出明细。
- 关联交易按原生结算币种展示未实现、当前持仓本轮已实现、手续费、资金费、已实现净额与总盈亏。不同币种不合并；未知币种、缺失字段、不完整列表或不完整本轮统计不产生完整总盈亏。
- Hyperliquid / Lighter RH 历史成交尚未接入，页面明确显示覆盖范围。Hyperliquid 现有仓位桥不提供结算币种与本轮统计，不补造币种或零已实现。所有关联持仓及其逐腿明细仍展示。

失败继续使用已有的有界重试和带来源时间的旧值保留。Asset 每次请求 10 秒 / 2 MiB、每范围刷新 45 秒 / 最多 80 请求，沿用端点间隔与按交易所串行调度；85 日分页、5 分钟刷新、失败 60 秒、快照不确定性最多 10 次重试。已有缓存按 owner、account、market、scope、凭据版本隔离，换凭据、删除、停止与闲置清理遵循原规则；ANT 使用单独持久 slot。

回滚：正常 revert 本次提交后按原流程发布；不迁移业务数据，保留配置及原油、海力士缓存。旧版不认识 `anthropic:` slot，恢复缓存时可能删除 ANT 成交缓存行；再次升级后按 85 天窗口重读。

## 审查与验证

Windows 原生验证，未使用 WSL，所有账户相关测试均为隔离夹具，无真实下单。

- `pnpm run build`：根目录 TypeScript 与 Vite 生产构建通过。
- `pnpm --dir modules/monitor run build`：Monitor 类型检查、客户端和 SSR 构建通过。之后仅为窄屏溢出增加两条 ANT 局部 CSS，增量重建客户端并重启 SSR 夹具后完成浏览器验收；复用未变化源码的类型检查与 SSR 结果。
- Asset `pnpm exec tsc --noEmit --incremental false` 通过；`node --experimental-strip-types --test tests/hub-fills.test.ts` 54/54。最后补充缓存恢复用例后，按 `each market keeps|ANT` 复跑 3/3，涵盖 ANT / oil / hynix 持久缓存隔离与重启。
- 根目录 `node --test tests/asset-fills-http.test.mjs tests/asset-fills.test.mjs tests/hub-fills.test.mjs modules/monitor/tests/hub-fills.test.mjs` 39/39；覆盖实际 HTTP 入口、字段校验、失败保留和市场隔离。
- Monitor 相关测试 83/83：`anthropic-market`、`anthropic-trades`、`related-position-totals`、`hynix-trades`、`oil-trade-markers`、`oil-trades`、`trade-summary`、`hub-bridge`、`hub-fills`。其中 `hub-fills` 与上述 39 项存在重叠，不将二者当独立测试总数相加。
- `tests/monitor-anthropic-trades.browser.mjs`：生产构建经工作台真实 iframe 桥接，验证入场/出场与键盘明细、原生价格、三种比较合约、时间范围和价格模式、分币种盈亏、缺失统计、失败保留、后台停读及 390px 无横向溢出，`pageerror=0`。
- `tests/monitor-trade-summary.browser.mjs`：原油与海力士的分批汇总、加权价格、标记选择、区间切换、窄屏与键盘展开通过，`pageerror=0`。本机 4175 已被其他工作树占用，在忽略目录复制同一夹具，仅将预览端口替换为 4178；未改其断言。

浏览器初次失败于 ANT 既有工具栏窄屏溢出（390px 页面宽、459px 滚动宽），修复仅作用于 ANT 小屏工具栏。新 CSS 首轮客户端重建后 SSR 夹具仍缓存旧 manifest，重启夹具后正确加载新样式并通过；不以旧样式的结果验证新样式。

独立审查由 `gpt-6-astra` / `ultra` 隔离上下文只读代理完成：核对真实入口、市场与账户隔离、开平回放、原生单位、币种分组、未知值、失败保留、有界读取及局部 CSS，未发现已证实 P0/P1。唯一 P2 为旧版本缓存恢复会清除不认识的 ANT slot，原回滚文档误称忽略；已按实际行为修正文档，无未处理 P2。

自审：通用范围与差异卫生、数据单位及合计、状态与时效、失败路径、真实入口及前端空态/错误态均已核对；权限、凭据、交易写入、数据库迁移及部署激活未修改，沿用已有边界。无新增缓存算法或性能优化，不扩大对应检查。受影响的 9 个 Monitor JS/TS/TSX 文件 ESLint 通过，`lessons-routing` 2/2、`git diff --check` 通过。发布所需 Linux 检查和发布包验证由现有 GitHub CI 执行；本地未运行全仓回归、Linux 部署或真实账户查询。
