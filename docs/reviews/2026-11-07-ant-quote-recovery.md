# Anthropic 套利盘口过期恢复

## 范围与风险（实施前）

风险等级 R3。用户反馈 Lighter RH ANTHROPIC 买入、Binance ANTHROPICUSDT 卖出的两条市价腿均未成交，任务提示「盘口已过期，等待新行情后重试」并暂停。现有执行器在整组下单预检或挂单追价读取时遇到一次过期，就进入暂停撤单，实际没有等待恢复。

本次仅修复工作台共用执行器的盘口获取、过期恢复和诊断，覆盖首批、后续批次及挂单追价。保留来源时间、10 秒有效期、1 秒未来容差、账户/持仓/合约检查、最终发送守卫及未知订单核对。不修改交易所签名、下单协议、前端、数据库或部署配置。

两腿并行读取结束后，仅对过期盘口补读一次，每次仍受现有调用超时约束；整轮校验通过前不发送。持续过期通过后续执行轮次有界重试（至少三次且满二十秒，任务截止与用户停止优先），期间保留已挂委托、不新增委托或追价。未来或无效时间、交叉盘口、合约变化继续立即拒绝，并给出明确诊断。最终发送前被拒的委托仍按既有安全流程暂停核对，不自动重发未知结果。

具体是哪一腿在用户服务器过期，以及当时网络耗时和时钟差，暂无现场日志，不能认定为某个行情源故障。只读公共接口可用不等于复现了用户服务器环境。

## 回滚

停止活动套利任务并核对已有委托，再切回上一正式版；配置、数据库结构和持久订单格式不变。保留委托与恢复记录，不重新发送旧请求。服务器升级由用户执行。

## 验证与审查

Windows 原生环境执行，未使用 WSL，未真实下单。

- `node --test tests/trading-execution.test.mjs tests/trading-execution-rh-lighter.test.mjs tests/trading-execution-hyperliquid.test.mjs tests/trading-auto.test.mjs tests/trading-anthropic.test.mjs`：151 项，首轮 150 通过、1 项新测试夹具失败。失败原因是一次快进 60 秒先耗尽了夹具的执行租约，使截止分支未运行；改为两次 30 秒轮次后，受影响的四项定向检查全部通过。源码未改，复用其他 147 项通过结果。
- `node --test --test-name-pattern="stale books keep|a stale later|invalid or future|all legs are revalidated" tests/trading-execution.test.mjs`：4 项通过。
- `node --test tests/trading-execution-http.test.mjs tests/lessons-routing.test.mjs`：17 项通过，含工作台实际 HTTP 入口鉴权、预览、确认、停止和维护边界。
- `pnpm run check`：通过。`git diff --check`：通过。
- 独立审查者 `/root/review_ant_quote` 使用隔离上下文，调用参数为 `gpt-6-astra` / `ultra`。仅审本次四个源码与测试文件的固定差异及直接调用链；采用 Codex Security 差异审查，本地补丁方式隔离工作区内其他并行任务的修改。未确认 P0/P1/P2。能力预检为 `ready`；插件不能直接接收四文件本地补丁，未生成宿主封存扫描或 SARIF。
- 独立冻结源码内存探针 4/4 通过：补读期间用户停止、任务截止、租约转移，以及最终发送前盘口再次变旧，均阻止实际发送；执行权丢失不覆盖新所有者状态。

审查冻结基线 `fdf470e1e53d30414d0b840d67c75f0214e8ca9d`，补丁 SHA-256 为 `85a5d5230fc244dfb8dec0460bf37b12a4f4b5ec91918ad09b6acce7b8254be1`。执行器源码 SHA-256 `1e0320e254650eb138b79fb223dcaf2fe5e30b9b535275b721366d5b921dcf91`，规划器源码 SHA-256 `e5b6ddbcc5839c2a0e5e57a018d6f20dd497a38dae767ead014ace41074d6b72`；审查结束前复核一致。

自审适用项：来源时间和有效期未放宽；结构化过期错误只接受完整有效的旧盘口；有限补读与恢复预算独立；全部活动腿预检先于追价；停止、截止、租约与未知订单保护保留；只提交本次文件；回滚如上。金额换算、凭据、前端、数据库和安装逻辑未改变，对应专项不扩大验证。

未运行：浏览器验收（无可见交互或布局变更）、真实资金下单、用户服务器现场复现。发布所需 Linux 构建和安装检查由既有 GitHub Actions 完成，正式发布结果在交付时核实。
