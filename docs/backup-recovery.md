# 冷备份、隔离恢复与交易交接

本文对应当前 [恢复工具](../server/recovery/operations.py)、[备份实现](../server/recovery/backup.mjs)和[恢复实现](../server/recovery/restore.mjs)。M2 已接入实现，相关 Linux 验收结果见对应提交的 Checks；本文不表示服务器已经部署、执行过生产恢复或达到生产 SLA。

普通备份允许保留活动任务和 UNKNOWN，恢复后统一进入 `quarantine`。它能恢复持久材料，不能证明备份点之后没有成交。只有仍持有完整原源、在同一冷停检查点证明财务静止并封存的 `handoff`，才有一次性授予指定恢复目标交易资格的入口。

## 入口与默认位置

Linux 正式安装的首次操作入口为：

```sh
sudo python3 -I /opt/project-aggregation/current/server/recovery/operations.py backup
```

`backup` 自动准备缺失的备份密钥、停止运行时与 API 两个服务单元并核对完整服务组、取得数据根生命周期锁、制作备份和安装持久启动保护。成功后或失败清理结束后，只有此前运行且原源未被退休的服务才会重新启动。所有命令使用当前受保护的正式发布与服务配置，不接受从网页传入的源码路径。

首次冷操作安装完成后，可使用短命令：

```sh
sudo project-aggregation-recovery backup
```

| 材料 | 默认位置与行为 |
| --- | --- |
| 实际数据根 | 读取 `/etc/project-aggregation.env` 的 `DATA_DIR`，默认 `/var/lib/project-aggregation` |
| 备份目录 | `/var/backups/project-aggregation/<UTC时间>-<随机标识>`；可用绝对路径 `--destination` 指定新目录，拒绝与数据根重叠 |
| 备份数据密钥 | `/etc/project-aggregation-recovery/data.key`，32 字节，权限 `0600` |
| 备份秘密材料密钥 | `/etc/project-aggregation-recovery/secrets.key`，独立的 32 字节，权限 `0600`，不得与数据密钥相同 |
| 交接续作记录 | `/etc/project-aggregation-recovery/pending-handoff.json`，记录原源和备份目标，不是解锁令牌 |
| 持久启动保护 | `/usr/local/lib/project-aggregation-recovery/startup-guard.py` 与两个单元各自的 `20-recovery-guard.conf`（`project-aggregation.service.d/`、`project-aggregation-api.service.d/`，内容相同）；API 进程启动时另外自行检查恢复状态。安装 guard 前先检查两个单元都没有其他 drop-in，任一单元有就整体拒绝（`RECOVERY_UNSUPPORTED_SERVICE_OVERRIDE`）；删除多余的 drop-in 后先执行 `sudo systemctl daemon-reload` 再重试，否则 systemd 仍报告已加载的旧 drop-in。网页更新只把 `/etc/systemd/system` 下与恢复入口写出内容逐字一致的 guard 视为受管配置，其他 drop-in（包括 `/run`、`system.control`、`system.attached`、transient、generator、`/usr/local/lib/systemd/system`、前缀目录与 `service.d` 中的）仍判为未受管；`/usr/lib` 下由软件包提供的 drop-in 不扫描 |

密钥目录只允许 root 访问。备份包不包含这两把备份密钥；取回备份时必须能分别取回对应密钥。应用自身的 `credentials.key` 和 Asset `config.json` 属于备份内容，不能代替备份密钥。不要用重新生成密钥替代丢失的旧密钥。

`keys` 仅准备或验证密钥，`inspect` 仅报告指定目录的本地恢复状态，二者不执行冷停，也不证明财务静止：

```sh
sudo project-aggregation-recovery keys
sudo project-aggregation-recovery inspect
sudo project-aggregation-recovery inspect --target-dir /srv/project-aggregation/restored
```

## 一致性与备份内容

操作入口先串行取得 stack 和 installer 锁，避免同时升级。需要冷操作时显式停止 `project-aggregation.service` 与 `project-aggregation-api.service`（不依赖 `PartOf=`），逐个检查两个单元的 `ActiveState`、`MainPID=0` 以及各自原 cgroup 的 `populated 0`，任一单元仍在运行即拒绝；结束后只启动运行时单元，由它拉起 API。两个单元必须都是安装器写出的受管单元，且使用同一服务账户和 Node。随后由工具先后持有数据根 `.runtime.lock` 与 `.api.lock` 的 OS 排他锁。Hub 在创建共享保护库和模块前取得 `.runtime.lock`，拆分后的 API 进程以共享模式持有 `.api.lock`，都在关闭完成后才释放。只看主 PID 或手动创建一个锁文件不能替代这套证据。

当前采用完整服务组冷停。没有跨数据库事务：一致性依据是在全部受支持写者退出且生命周期锁持有期间，各库及 JSON 保持静止。SQLite 使用备份 API 生成完整快照；需要时受控 checkpoint，读取或恢复不丢弃仍有内容的 WAL，也不直接复制主文件并忽略 WAL。manifest 为每个库记录 schema 摘要、`user_version`、`application_id` 和完整表行数，恢复时重新校验。

inventory 递归覆盖实际数据根，并保留模块目录中的未知普通文件，避免只按几个数据库文件名备份。主要材料包括：

| 域 | 需要保留的材料 |
| --- | --- |
| Hub 与统一执行保护 | `hub.sqlite`、`credentials.key`、`execution-control.sqlite` 及其 `.required` 身份证据；任务、订单、幂等请求、账户归属、fence、UNKNOWN 和隔离记录 |
| Monitor | 根及 `perpetual` 行情库；`notifications.json`、`monitor-control.json`、`variational-session.json`；`hynix/alerts.json`；`oil` 与四种 `cl-xau` 子目录的 `monitor.json`；合约告警、CrossEx 设置及 `paper-positions.json` |
| Asset | `ledger.sqlite`、`config.json` 中的 `credentialKey`、登录配置与会话秘密，导入材料及 `backups/before-import-*.sqlite` |
| CrossEx | `crossex.sqlite`、`credentials.key`，包含持仓、真实订单、执行、请求去重及财务历史 |
| Greeks | `engine_state.json` 中的订单日志、任务、RFQ、持仓与绩效，以及模块 `.env` |
| ASTER | `trading.sqlite3` 中的 intent、pair pending、划转、post-fill、ADL 与财务记录，以及含账户和主账户凭据的模块 `.env` |

各模块 `.env`、JSON、应用解密密钥、引用的内部 CA 和未知文件默认归 `secrets`。已知业务库、共享保护库与身份标记归 `data`；未知 SQLite 文件仍按秘密材料处理。两类分别使用独立密钥进行 AES-256-GCM 加密，manifest 同时用两把密钥认证，关联固定发布提交、检查点、文件明文与密文摘要、大小和分类。成功制作只表示归档完成；返回 `restorable: null` 不等于已完成独立恢复验收。

排除的可再生材料包括 `.runtime.lock`、`.api.lock`、模块进程锁、socket、临时文件、已被数据库快照吸收的 WAL/SHM 和旧恢复控制文件。符号链接、硬链接、特殊文件、不安全权限及路径越界直接拒绝，不会通过改名为排除项而放过。

根环境文件归档为加密的 `_recovery/root.env`，恢复时只作为材料保存，**不会写回 `/etc/project-aggregation.env`**。交易准入使用当前受保护根环境与对应模块 `.env` 的实际组合，不能把历史环境归档当成新授权。

当前受控处理 `ASTER_CAPACITY_RELAY_CA_FILE`：值必须指向数据根内实际纳入清单的普通文件。manifest 保存其根内相对绑定，恢复时将模块配置重绑到新目标根下的对应 CA。数据根外的绝对路径、缺失材料或不支持的引用会记录为未闭合 dependency；普通备份可保留这一事实并返回 `restorable: false`，但 `restore` 和 `handoff` 都拒绝。工具不会按模块 `.env` 的外部路径读取或复制任意文件。

## 隔离恢复

恢复只能写入不存在的新目标，不能覆盖生产目录、备份目录或与它们重叠的路径：

```sh
sudo project-aggregation-recovery restore \
  --backup-dir /var/backups/project-aggregation/<备份目录> \
  --target-dir /srv/project-aggregation/restored
```

工具在隔离 staging 内验证双密钥认证、GCM、文件摘要、SQLite 完整性和外键、schema、财务记录结构以及既有加密凭据可解密性。未知版本、损坏记录和缺失必需材料不能作为“待恢复任务”被忽略。验证成功后先发布处于隔离状态的保护库，再发布其余材料，最后写入完成状态。

从未创建任务的 Greeks 可能没有持久 `engine_state.json`。归档本来就没有该文件时，允许恢复到隔离状态并保留缺证事实，不生成空日志；缺证不能用于 `handoff` 或 `admit`。若 manifest 已列出文件但密文丢失，或现有 JSON/版本损坏，仍拒绝恢复。

普通隔离恢复只依赖备份与对应双密钥，原数据根丢失或损坏不会阻止恢复到新目录；无法确认原源状态时保持原服务停止。目标父目录必须允许实际服务账户遍历，已有私有父目录或祖先不符合条件时拒绝，不修改其权限。根环境文件兼容安装器的 root 所有、组只读 `0640`；备份密钥仍要求 `0600`。

恢复会执行以下有限变更，其余财务证据保留：

- 撤销 Hub 会话和执行预览、CrossEx 预览与旧运行租约；Asset 轮换 `sessionSecret`。Portal ticket/grant 在内存中，不会随恢复重建。
- 产生新的 `authorityId`、恢复身份和 epoch，关闭旧 owner，清零旧 lease，增加账户 fence 与绑定 generation；`sending` 转为 `unknown`，保留原操作身份、账户归属与隔离。
- 核验原 registry 身份后，受控重绑复制后的 `.required` 到新数据库 inode；不创建空保护库绕过旧记录，也不恢复祖先的可消费交接权。
- 写入持久 `quarantine`，所有已接入的资金请求和受保护提交仍由 Node/Python 共享核心拒绝，进程重启不能解除。

隔离状态可用于检查恢复材料和启动可读服务，不代表所有本地文件都不再写入，也不替代网络隔离。公共行情和通知等非交易路径可能仍访问外部服务；演练使用隔离网络环境，不能拿生产凭据试下单证明恢复成功。

`restore` 和 `admit` 均不修改 `DATA_DIR`、不切换发布版本、不自动将新目录部署为生产。用户需要自行选择配置切换与启动时机。示例使用安装器允许的 `/srv/project-aggregation/` 子目录，便于后续正常更新；目标仍必须与当前源目录互不重叠。

## 一次性交接准入

`handoff` 用于有完整原源的受控迁移。它要求原源为 `normal`，全部服务写者已退出、生命周期排他锁有效、依赖材料闭合，且完整财务扫描证明当前静止。扫描不使用 UI 的历史截断：Hub 任务全部终态且订单已核对；共享库无 `sending/unknown`；CrossEx 无未决或外部活动订单；Greeks 无真实未决任务、订单和 RFQ 且 `AUTO_OPEN` 关闭；ASTER 实盘账户及配对的自动资金策略关闭，无 intent、划转、post-fill、pair pending、ADL 等未决。既有账户隔离原样携带，交接不解除隔离账户限制。

```sh
sudo project-aggregation-recovery handoff \
  --destination /var/backups/project-aggregation/<新交接目录>

sudo project-aggregation-recovery restore \
  --backup-dir /var/backups/project-aggregation/<新交接目录> \
  --target-dir /srv/project-aggregation/restored

sudo project-aggregation-recovery admit \
  --target-dir /srv/project-aggregation/restored
```

密文和已认证 manifest 持久化后，源在共享保护库内永久进入 `retired`，旧 owner 关闭且 fence 增加。退休不会因备份目录发布失败而回滚，源不会自动重启。请在交接完成前保留当前配置对原源的引用，使 `admit` 能找到真正的源 authority。

`admit` 同时锁住原源和目标，重新核验 sealed handoff、manifest、双方 registry/inode/authority、当前根环境和财务静止证据。它先在原源持久消费授权并绑定唯一目标，再把该目标改为 `normal`；目标仍须通过正常账户身份、模块归属、fence 和隔离检查才能写出。原源继续 `retired`。

普通历史备份、原源丢失、源后续仍发生过资金操作或未完成对账的恢复目录，均不具备这份同点交接证据，本版本没有对应的自动开闸入口。不能编辑 `recovery-control.json`、`aw_meta` 或 `.required`，也不能删除保护库来手工解锁。

## 崩溃与重试

handoff 在退休后发布失败时，保留同一目标对应的 `.incomplete-<checkpointId>` 密文和封存证据；用**原 `--destination`** 重试 `handoff`。未显式指定地址时，操作入口会保留并使用 `pending-handoff.json` 的原地址，不能换地址重新封存同一个退休源。

`admit` 在消费原源之后中断，可以针对**原目标目录、原恢复身份和原数据库 inode** 重试；另一个恢复副本不能消费同一份 handoff。不要删除目标后重建一个同名目录，那是另一个目标。

中断或失败的 `restore` 会保留 `recovery-control.json` 的未完成或失败证据，可能还存在 staging 或已发布的部分材料。当前操作入口拒绝覆盖已有目标，不承诺从同目录自动续传恢复。保留原源、备份、目标、密钥和错误码后排查，不能删除证据强行启动或重跑。持久 guard 会拒绝未完成恢复、退休源、保护库/标记损坏，以及不能执行恢复协议的旧版回滚程序；其文件位于版本链接外，应用回滚不会移除它。

## 资源预算与验收边界

默认单次预算为 **10 GiB、10,000 个文件、10 分钟**，检查可用空间并留出写入余量。数据库和财务 checkpoint 检查在可终止的子进程中运行，财务扫描累计最多 **100,000 行**、单条记录 **8 MiB**，子进程 V8 堆上限 **256 MiB**。超过限制、失锁或超时即失败，不通过跳过历史行来报告静止。低层 CLI 有显式预算参数；正式 root 入口使用默认预算。

RPO 5 分钟、隔离恢复到可读服务 RTO 30 分钟仍是待验证目标。当前没有自动配置周期备份、异地上传、保留期或密钥取回流程，不能据默认 10 分钟工具预算推算生产 RPO/RTO。

现有 Ubuntu CI 已接入真实服务账号与打包后的五模块恢复演练，相关结果须以本次 CI 为准：从本地运行包和本地密钥制作检查点、恢复到新目录、重新启动真实五模块及 Hub，验证旧会话失效、恢复能力协商和资金写入仍受 `quarantine` 阻断。演练在只有 loopback 的独立网络命名空间运行，不依赖外网，也不发送实盘资金请求。测得的检查点年龄和恢复可读耗时只覆盖这个 CI 夹具，不包含生产数据量、异地取包、取密钥、交易所对账和人工响应。

Linux systemd、cgroup、归属与启动 guard 由现有非 WSL CI 验证；Windows 原生单测覆盖可运行的库与故障场景。生产恢复承诺需要另以真实数据规模、故障范围和可用环境完成验收。
