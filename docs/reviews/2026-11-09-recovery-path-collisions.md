# 备份完整清单的路径碰撞检查（#274）

风险等级：R3。基线 `98db5dac232c40b191cd6f3a5886c2260c94a569`。事件 `recovery-manifest-casefold-collision`；只确认离线缺陷，未确认生产事故。

## 行为、范围与回滚

普通备份、handoff 和已封存 handoff 的恢复发布，与恢复端共用完整路径的 `toLowerCase()` 唯一性检查。首次制作在全部合成条目追加后、认证清单/封存/退役/发布之前拒绝碰撞；旧包恢复仍拒绝。新制作失败清理本次临时目录，原文件、authority、owner、account fence/lease 保持不变；旧 sealed 包续发布拒绝时，保留唯一载荷和 retired 状态。

涉及 `server/recovery/{inventory,backup,restore}.mjs`、对应回归和备份说明。没有 schema、分类、密钥或交易准入变更；普通备份原有保存未决依赖及凭据事实的语义不变。回滚撤销本次代码并按现有流程发布，不能改写数据、解除 retired/quarantine，也不能用旧版继续处理已知碰撞源。服务器部署由用户自行更新。

## 验证

- 修改生产代码前，定向运行 `node --test --test-name-pattern='final manifest path collisions|legacy collision' tests/recovery-backup.test.mjs`：普通备份/handoff 的两类合成路径碰撞及旧 sealed 续发布，共五个实际场景均因“未拒绝”失败；旧认证包恢复拒绝通过。Windows 不运行真实双文件大小写并存场景。
- 修改后运行 `node --test tests/recovery-backup.test.mjs tests/recovery-data-catalog.test.mjs`：32 通过、1 失败、3 跳过。唯一失败是既有 runtime-only 临时目录未配置 Windows ACL；按同文件既有安全夹具补齐后，仅重跑 `--test-name-pattern='archive traversal'`，1 通过。其余未变用例的有效结果复用，不把首次整组运行写成全绿。
- `pnpm run check` 通过；`node --test tests/lessons-routing.test.mjs` 2 通过；`git diff --check` 通过。
- `python -I tests/test_recovery_operations.py OperatorTests.test_operation_stops_both_units_and_starts_the_runtime_unit OperatorTests.test_rejected_guard_runs_no_operation_and_restarts_only_a_live_source -v` 2 通过。这是操作编排的模拟服务验证，非真实 systemd。
- 待发布前 CI：Linux 下真实嵌套 `Review.json`/`review.json`、POSIX 身份/锁、正式包恢复和服务操作验收。未使用 WSL、真实账户、交易或用户服务器。

## 独立审查

隔离代理 `review_recovery_collision`，调用参数 `gpt-6-astra / ultra`，只读审查七个固定文件与相关调用边界。无 P0/P1/P2/P3。独立 Windows 定向验证 12 通过、0 失败、2 个大小写敏感子场景跳过；正常 handoff/admit 与发布中断续作通过。

Codex Security diff scan `10bde3da-fa23-487c-a0f1-b77570d0d174` 已封存，工作树摘要 `2b931fe1cfd212947541be70a4c69d0374f9d98815898429964a19ced64ea308`，候选/发现均为 0；范围为本次差异及直接关联恢复边界，不是全仓安全扫描，也不覆盖随后 #316 的测试改动。Linux 平台验证仍由本次交付 CI 补齐。
