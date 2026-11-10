# 仓位共享缓存与后台刷新

风险等级 R2。基线 `b2fa5039f9c0805d0a0532b41ee91fc7d3160f17`。用户反馈全部仓位与套利观察首次等待较长，交易中心已读到仓位时，Monitor 关联交易仍可能读取超时。

## 范围与行为

| 范围 | 修改与审查覆盖 |
| --- | --- |
| `server/asset-snapshot.mjs`、`asset-positions.mjs`、`runtime/data-plane.mjs` | 仓位 UI 显式使用后台刷新；同来源版本已有快照立即返回，新慢来源不阻塞已有来源；全冷首次读取仍有界。通用快照默认等待与成交读取不变。项目显式检查先使对应仓位快照失效。 |
| `src/positions-cache*`、`TradingPositions`、`App` | 一份登录会话快照与在途读取，切页保留；失败标旧、空列表权威替换。账户变更先完成服务端失效应答再 GET，多来源检查合并，失败不跳过，整轮共用15秒期限。退出清理所有任务，来源变更拒收旧代际。 |
| `src/ProjectPage`、`hub-positions` | 关联交易复用全部仓位快照；等待补充来源后按当前缓存生成回复，补充来源缓存绑定代际。过期空快照不确认空仓；既有来源/窗口校验与字段脱敏保留。 |
| `src/trading-cache`、`trading-read`、`OilTradingPage` | 上次选中的套利观察分区延迟预热当前组合首页一次，和页面共用 GET；默认全部仓位不启动套利请求。离线取消只读请求，保留账户写入锁，既有75秒老化不变。 |
| 对应单元、HTTP、浏览器夹具与集成说明 | 覆盖慢源、失败、清空、配置版本、账户目录变更、辅助来源迟到、离线重连及观察页请求复用。没有改交易执行器、数据库、依赖或部署配置。 |

仓位只在当前 App 会话内存中保存，不进入浏览器持久存储。服务器与浏览器保留来源读取时间，缓存命中不续期；复用不代表重新确认交易现场。

## 独立审查

审查者 `/root/independent_review`，独立上下文，调用参数 `gpt-6-astra / ultra`。首轮固定20文件差异 SHA256 `91F6CF21C725F64DC955F0E143B80A8B0D711D1F1AEA48A98048F94FC64839B5`；增量 SHA256 `B38583952E996150BFB102AF83BA49193B3D8009846C222E0765AE13CDE97846`，另审阅新增浏览器夹具。

首轮发现并通过原生探针确认两项 P1，均在提交前修复：

- Asset 内部账户改变但项目版本未变时，单清浏览器缓存会重新采纳服务端旧仓位。修复服务端失效与浏览器应答屏障；真实 HTTP 回归在修前失败、修后通过。
- 等待辅助腿期间缓存失效，原先捕获的仓位仍会发出；短时重连后的下一次请求也可能复用旧辅助缓存。修复发送时重取当前快照、辅助缓存按代际重建，并覆盖单次迟到和后续新请求。

最终增量复核：P0=0、P1=0，无残余 P2，满足合并门槛。Codex Security 固定差异扫描 `7951a45b-4942-4aeb-8d57-8ebd13b2ef2e` 已完成并回读，未证实新增安全攻击路径；功能 P1 通过上述独立复核关闭，未以安全报告0项替代正确性审查。扫描 token 用量不可用；未重复扫描。

## 实际验证与复用

- Windows 原生 `pnpm run check`、`pnpm exec vite build --outDir .build-cache/positions-ui` 通过；最终辅助缓存修复后重跑通过。
- `node --test tests/asset-positions.test.mjs tests/asset-positions-http.test.mjs` 首轮20/20；增加显式检查失效后，受影响的 HTTP 文件重跑6/6，未改动的仓位单元结果复用。
- `node --test tests/asset-fills.test.mjs tests/asset-fills-http.test.mjs` 19/19，确认共享快照默认读取兼容；相关源码此后未改，复用结果。
- `node --test tests/positions-cache.test.mjs tests/hub-positions.test.mjs` 29/29，覆盖屏障、401、离线、迟到及新代际不能复用旧辅助腿。
- `node --test tests/trading-cache.test.mjs tests/trading-read.test.mjs` 50/50；离线预热迟到、只读取消不取消写入的两项在修前失败、修后通过。观察缓存源码此后未改，复用结果。
- `node --test tests/lessons-routing.test.mjs` 2/2，最后经验补充后重跑通过。
- 生产工作台经 Playwright CLI：`trading-positions.browser.mjs`、`hub-positions.browser.mjs`、`trading-resume.browser.mjs`、`trading-poll.browser.mjs` 首轮通过，覆盖共享慢读、15秒截止、失败保留、恢复合并、隐藏轮询与无自动交易写入。后续失效改动另用 `hub-positions-invalidation.browser.mjs` 在最终生产构建通过8场景：6次仓位GET、2次检查、3次辅助来源GET；包括账户移除应答屏障、清空/离线后的迟到回复及20秒内重连重新读取辅助腿、数量40变93。
- 真实 Monitor iframe 使用本轮未变的已有构建与隔离接口，专项脚本验证交易中心→Monitor在 HTTP 挂起时约97ms返回缓存，503后保留两条旧值与原时间，无页面异常或外部请求。原 `monitor-related-positions.browser.mjs` 的旧价差/标题断言不符当前模块，未声明该原脚本通过；专项保存在本轮本机验收记录中。之后只变更的宿主失效路径由上述新浏览器夹具覆盖。
- 30来源挂起对照：基线150ms内不返回，修改后约0.55ms返回全部缓存来源。这是隔离内存测试，不是生产网络延迟测量。

按 D1–D7 自审：身份、十进制数值、原始时间与空仓语义保留；失效、失败和有界读取有回归；宿主来源校验、会话隔离和字段脱敏有检查；没有新增外部交易操作或凭据存储。交易写入、数据库迁移与部署修改类别不适用。发布所需 Linux 打包/安装检查由现有 CI 执行；未使用 WSL，未操作真实私有账户或部署服务器。

## 回滚

撤销本批代码并按现有正式发布流程发布；或恢复上一正式版本 `deploy-b2fa5039f9c0805d0a0532b41ee91fc7d3160f17`。没有新增持久格式、数据库迁移或用户配置，内存缓存随会话/进程结束清理。
