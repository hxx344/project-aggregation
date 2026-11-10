# #280 / #291 备份计划与取回就绪

风险等级：R3。影响受保护恢复 CLI、定时冷停、仅计划生成备份的保留、失败通知、安全元数据快照，以及认证后的就绪台账 API/UI。

计划默认关闭；root 配置每日窗口（默认 Asia/Shanghai，也支持 UTC）、保留数量与最低空闲容量后注册 systemd timer。沿用 stack/install 锁与完整服务组/cgroup 核验，真正停服前重查窗口；每个窗口先持久化 claim，崩溃后只恢复服务、保留 unknown，不重新备份。通知先持久化 claim，单次超时且不自动重试未知结果。保留只删除受管目录中身份、认证及密文摘要重新核验通过的旧计划包，至少留两个有效包；失败保留证据。

台账只读取固定 root-owned 白名单快照，人工取回/演练声明存 Hub settings 并绑定摘要、版本与时间，不收集密钥、不执行恢复、交接或解除隔离。归档认证、人工声明、CI 夹具、独立演练明确分层；旧包记录不覆盖新包。

失败行为：配置错误、未知旧状态、锁冲突、窗口外和空间不足均不开始冷停；备份失败恢复原活动服务集合，恢复前仍执行 source/guard 检查，retired 保持停机；清理和通知失败保留诊断。回滚：先以 schedule-configure --disable 禁用 timer，再回退代码；已有备份、双密钥、claim 与台账不删除，未知运行仍须人工核对，不通过清除保护解除。

最小验证：Windows 原生 Python 隔离状态机/故障夹具；Node 归档认证和元数据/API验证；根类型检查与页面实际入口；Linux CI 补充 root 权限、链接与 systemd 单元夹具。无生产备份/恢复/通知、无服务器部署、无异地备份 #292。

## 作者验证记录

- `node --test tests/backup-readiness.test.mjs tests/backup-archive.test.mjs`：13/13 通过。覆盖双密钥认证、密文篡改/预算、只读 CLI、手工包、摘要/版本/时间绑定、CI 与独立演练区分、秘密字段拒绝/过滤、旧格式保留、修订号冲突。
- `python tests/test_backup_maintenance.py`：25 例中 22 通过，3 项 Linux root 权限/链接/systemd 单元验证按平台跳过。覆盖跨日与临界窗口、重复运行、重启未知、原活动服务集合、retired/quarantine、空间/锁/通知失败、通知持久 claim、保留身份/唯一有效材料/失败证据/总预算、受管配置幂等及手工注册。
- `node --check tests/backup-readiness.browser.mjs` 与本组 `git diff --check` 通过。浏览器夹具已编写，交由主任务在统一生产 preview 4180 执行；本记录不声称已完成浏览器或根类型检查。
- 尝试运行既有 `python tests/test_recovery_operations.py`：Windows 下 2 个 POSIX 路径/cgroup 断言失败、13 个 `pwd` 缺失错误、5 个平台跳过；未修改或放宽这些既有 Linux 夹具。Linux CI 必须继续执行原恢复夹具与新增 root 专项。

自审：状态/失败路径/安全边界适用，使用固定受管路径、只读公开白名单、持久 claim、窗口最终校验、受保护 root 注册；人工写入通过既有 Hub settings 的 `immediate` 事务与修订号检查。无金融计算、业务缓存、交易 API 或数据库结构变更。页面表单使用读取代次保护，POST 成功后废弃此前 GET；无密钥自由文本输入。R3 独立审查及主任务的真实 HTTP/生产页面/必要 Linux CI 结果需另行登记，本记录不是合并批准。

### 独立审查修复：公开快照权限

审查者 `p2_review_platform` 确认：定时单元 `UMask=0077` 会把公开目录/临时文件的 0755/0644 创建参数收窄为 0700/0600，原子替换后 Hub 无法读取。修复只允许固定 `PUBLIC` 路径使用公开例外：验证 root 归属、无链接及安全父链后，对专用目录 FD 明确设置 0755、公开临时文件 FD 设置 0644；保留私有 umask，不修改其他目录和私有文件。

增量实际运行 `python tests/test_backup_maintenance.py`：27 例中 23 通过、4 项 Linux root 按平台跳过。新增 Linux 夹具在真实 umask 0077 下连续发布两次，并以 `nobody`、无补充组实际读取 JSON；同时实际拒绝读取私有状态。该 POSIX 场景尚待本次 Linux CI，Windows 结果不代替 Linux 权限验收。已通知原审查者仅复核此增量。
