# M2 恢复保护交付审查

本批按 R3 审查，范围为 `server/recovery/`、共享 Node/Python writer、真实模块握手、Hub 启停和恢复状态接口，以及对应测试、打包演练和 CI。基于主线 `56cdb9e` 实施；用户原有 pipeline、部署文档及其他未提交修改不在本批范围。

## 影响和回滚

运行时在启动写者前取得数据根 OS 锁，退出所有写者后释放；交易核心增加持久 normal/quarantine/retired 状态。冷备份停统一服务，恢复只写新目标；普通恢复不会开放交易。sealed handoff 永久退休原 authority，一次性消费原源证据后仅开放指定目标，不允许用程序回滚撤销退休。

回滚保留整个数据根、WAL、`.required`、恢复控制记录及外置备份密钥。已安装的 systemd guard 位于版本链接之外，拒绝不支持 M2 的旧程序启动受保护数据。程序故障选择仍支持恢复协议 1 的健康版本；保持 quarantine 或 retired，修复后续作，不删除 gate、重置 fence 或用旧库覆盖。服务器部署和配置切换仍由用户执行。

## 独立审查记录

规划代理 `plan_m2_recovery` 使用 `gpt-6.1-sol` / `ultra` 只读规划。作者与审查代理隔离；独立审查只读，不编辑、提交或推送。

| 审查代理 | 范围 | 修复与复核结论 |
| --- | --- | --- |
| `review_m2_core` | Node/Python gate、标记身份、OS 锁及 Windows ACL | 缺标记自动重绑、拒绝路径触发 WAL 写入、初始化竞态和继承 WRITE_DAC 均已修复；最终无剩余 P0/P1/P2 |
| `review_m2_backup` | 密钥分类、完整检查点、隔离发布、单次 handoff、路径和资源边界 | 通知签名分类、ADL 非终态、损坏结构白名单、root 空 sidecar 和 Unicode 字节限额均已修复；最终增量复核无剩余 P0/P1/P2 |
| `review_m2_runtime` | 启停、root 操作入口、持久 guard、实际包演练与 CI | 部分启动失锁排空、锁内解析配置、缺库旧版启动、缺源灾难恢复、已有私有父链及 CI Node 路径均已修复；最终无剩余 P0/P1 |

鉴权和交易边界按 `codex-security:security-diff-scan` 的差异审查方法处理，复用威胁边界并遵循用户跳过 Daybreak 检查的约定；没有宣称执行全仓安全扫描。

## 验证证据与边界

Windows 原生已运行相关跨语言 writer、OS 锁、财务分类、备份/恢复、故障续作、实际 Hub/startup/worker 协议测试和根 TypeScript 检查。审查期间只重跑受修复影响的增量，复用本批未变化源码的通过结果。root 操作入口 12 项中本机通过 8 项，4 项 Linux 专项明确跳过；Linux CI 另执行 root/service UID、真实 systemd 孤儿 cgroup 和发布包五模块恢复演练。

必要 Linux 和发布结果以同提交的 Checks 与正式发布记录为准，本文不预先将其标为通过。真实五模块演练使用本地包、合成数据和本地密钥，并处于无外网的 netns；不包含实盘写入、生产数据规模或异地取回，RPO 5 分钟和 RTO 30 分钟仍为目标。测试没有在 WSL 中执行。

自审覆盖状态机、双库原操作保留、跨语言契约、资金请求最终 gate、权限路径、加密完整性、失败恢复、资源上界和实际交付入口。未改变资金收益计算或前端可见布局，不新增对应浏览器回归；提交前仍须运行 staged review gate。

实际 Ubuntu 验收中，12 项恢复入口、3 项跨 UID SQLite 探针、真实 cgroup 与原生锁均通过；根行为测试 831 项中 826 通过、5 项按平台跳过。首轮真实五模块恢复揭示 Greeks 从未使用时不生成状态文件，窄修将固定文件的缺失保留为 `GREEKS_STATE_MISSING`，只允许隔离恢复，不合成空日志，不允许 handoff/admit；已列入 manifest 的密文丢失和现有损坏结构仍拒绝。独立备份审查复核该增量，最终整包结果继续以同提交 Checks 为准。
