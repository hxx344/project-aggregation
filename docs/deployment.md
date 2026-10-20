# 统一部署与迁移

工作台保留原生交易功能，同时内置 Market Monitor、Asset Ledger、Gate CrossEx、Greeks 与 ASTER。五个模块的源码、页面和后端均随本仓库统一构建、验证、安装与更新。它们不再作为独立网站或独立 systemd 服务运行。

Aster 的公共额度中继可以单独运行在另一台服务器，使用本仓库的[独立中继安装与接入流程](aster-relay.md)。它不属于工作台业务模块安装，也不需要交易账户凭据。

开发、测试、生产的环境编排（依赖安装、配置渲染、构建、校验、打包、发布）使用 [自动化流水线](deployment-pipeline.md)；服务器安装与升级仍以本文为准，流水线的 `activate` 阶段只调用本文的安装器。

## 安装与升级

当前正式发布针对实际服务器 Ubuntu 24.04 LTS（当前为 24.04.4）、x64 / x86_64 构建并验收，需 systemd 和 Python 3.11+：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash
```

同一命令可重复执行。兼容入口 `deploy/install-all.sh` 只协调工作台安装器 `deploy/install.sh`，在线更新也只有 `hub` 一个目标。`--only hub` 继续可用，内置模块不支持独立安装或更新；旧的其他 `--only` 选项会明确拒绝。`--refresh` 只重新获取安装器，`--with-tests` 在源码部署时额外运行行为测试；正式版本发布前已由 CI 验证。

默认使用 `source` 模式：先读取正式 Release 清单，再只拉取清单中固定提交的源码，在服务器按需构建。一键命令和新版网页更新器传递同一份固定清单；执行期间出现新的正式版或 `main` 前进，也不会改变本次安装目标。发布解析失败会终止更新，不回退到主线。CI 继续执行验证、构建候选版和正式发布，服务器默认不下载完整预构建运行包。

网页“系统更新”支持在确认前选择本次更新方式：**下载源码并在服务器构建**，或 **下载 CI 已构建运行包**。后者直接使用该正式版本通过 CI 的产物，无需再次触发 CI。确认后方式固定在任务中，关闭面板或刷新页面不会改变；旧版更新服务未提供选择能力时仍按原方式更新，升级到本版后即可选择。

进度沿用更新任务状态自动推送：依赖准备、工作台及各模块构建、校验、服务切换和健康检查会显示具体阶段；没有可测量比例时显示进行中的进度条。CI 包下载显示已下载/总量、速度和预计剩余时间；总量未知时只显示已下载量及速度。源码下载显示 Git 对象接收比例和可用的实测字节数、速度，对象比例不用于估算字节总量或剩余时间。命中缓存时跳过相应工作，不模拟完整下载或构建过程。

更新结束后，结果中保留任务总耗时和实际记录的各阶段耗时，刷新或重新打开面板仍可查看。同一阶段多次执行会累计，缓存跳过的阶段不补零；中断导致区间未闭合时显示“未完整记录”。任务总耗时包含排队与协调时间，不要求等于阶段之和。旧任务没有阶段记录时明确提示；首次升级到支持计时的版本后，刷新页面即可查看本次已保存的耗时。

源码获取显示 Git 接收进度，连接重置、传输中断等明确网络故障最多尝试三次，间隔 2 秒、4 秒；重试局部使用 HTTP/1.1，不修改全局 Git 配置。持续无有效流量超过 60 秒时中止该次 HTTP 传输，这不是整个下载的总时限。认证、证书、限流及版本不存在等错误直接停止。已缓存的固定提交无需重新下载；源码获取最终失败时尚未构建或切换服务，修复网络后重复原命令即可。

依赖、工作台前端、Monitor、Asset、CrossEx 和 ASTER 前端分别缓存。单个模块源码变化只重建该模块，主站页面变化不重建模块；共享依赖、构建环境或相应构建配方变化会使相关缓存失效。每个模块内部先按完整模块源码判断变化，尚未细分前端、后端、测试和文档。缓存包含全部交付文件的摘要，非入口文件损坏也会拒绝复用并重建对应产物。无变化且服务健康时，跳过源码下载、依赖安装、验证、构建及重启；同内容的新正式提交会更新版本记录而不重启。所有构建完成后才停服切换，构建失败保持旧服务运行，切换失败沿用现有回滚流程。

Node.js 自动准备为 24.15 或更高的 24.x，pnpm 固定为 11.25.0。Greeks 与 ASTER 分别使用 `modules/greeks/requirements.lock` 和 `modules/aster/requirements.lock` 固定版本与哈希，独立虚拟环境以各自锁文件、Python 版本和架构为键缓存。首次源码部署需安装开发依赖并构建全部前端；实际耗时取决于网络、CPU、内存及缓存命中，不能由包体积直接推算。当前 CI 仅构建并验收 x64，源码模式仍要求正式清单含匹配架构，不扩大 ARM64 支持范围。

命令行选择 CI 预构建运行包：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo env PROJECT_DEPLOY_MODE=ci bash
```

该模式保留分段并发下载、有效片段复用和整包 SHA-256 校验。网页中的选择只作用于本次任务，不修改命令行默认模式。

需要比较预构建包下载源或配置固定版本包镜像时，使用[镜像与下载验证工具](release-mirror-setup.md)。镜像配置由包下载器直接读取，清单仍来自官方 HTTPS，包仍须通过官方 SHA-256；它不改变默认源码模式，也不加速 Git fetch。

## 服务与数据

只有 `project-aggregation.service` 对外提供业务 HTTP，默认绑定 `127.0.0.1:3100`。模块由工作台管理独立 Node worker；Greeks 与 ASTER 通过 Python 标准输入输出桥运行，不另开 TCP 端口。在线更新控制服务继续使用 Unix socket。所有模块沿用工作台鉴权，进入模块页面无需再保存独立网站登录凭据。

| 路径 | 用途 |
| --- | --- |
| `/etc/project-aggregation.env` | 工作台配置、监听与数据目录 |
| `/var/lib/project-aggregation` | 默认工作台数据目录，保留原生交易数据 |
| `$DATA_DIR/modules/monitor` | Monitor 状态与迁移的 `.env` |
| `$DATA_DIR/modules/asset` | Asset `config.json`、SQLite 数据与附件 |
| `$DATA_DIR/modules/crossex` | CrossEx SQLite 数据及 `credentials.key` |
| `$DATA_DIR/modules/greeks` | Greeks `engine_state.json` 与迁移的 `.env` |
| `$DATA_DIR/modules/aster` | ASTER SQLite、WAL、配置、密钥历史与迁移的 `.env` |
| `/opt/project-aggregation/releases` | root 只读运行版本 |
| `/opt/project-aggregation/python` | 按内容缓存的 Greeks Python 环境 |
| `/opt/project-aggregation/python-aster` | 按内容缓存的 ASTER 独立 Python 环境 |

安装器把 `GREEKS_PYTHON`、`ASTER_PYTHON` 写入工作台 systemd 单元。ASTER 从自己的 `.env` 继承账户和 relay 设置；运行目录始终指向 `$DATA_DIR/modules/aster`，页面从工作台 Aster 5x 入口打开。关停允许交易引擎等待在途请求完成，systemd 停止上限为 150 秒。

安装完成后查看首次工作台登录信息：

```bash
sudo journalctl -u project-aggregation --no-pager -n 30
```

电脑只需转发工作台端口：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3100:127.0.0.1:3100 user@server
```

## 从旧独立服务迁移

迁移在候选运行包及 Python 环境准备完成后进行。先停止工作台，再停止旧模块的写入进程，随后复制完整数据目录（包含 SQLite WAL/SHM）与配置。CrossEx 数据库缺失配套 `credentials.key` 时会停止迁移，不生成新密钥替代旧密钥。已有内置模块目录不覆盖。

| 模块 | 默认旧配置 | 默认旧数据 |
| --- | --- | --- |
| Monitor | `/etc/market-spread-monitor.env` | `/var/lib/market-spread-monitor` |
| Asset | 服务单元中的 `ASSET_DATA_DIR`、数据中的 `config.json` | `/var/lib/asset-ledger` |
| CrossEx | `/etc/gate-crossex-arbitrage.env` | `/var/lib/gate-crossex-arbitrage` |
| Greeks | `/etc/greeks/greeks.env` | `/var/lib/greeks` |
| ASTER | `/etc/aster-desk/environment` | `/var/lib/aster-desk`，或 `ASTER_TRADING_RUNTIME` 指定的专用目录 |

ASTER 的 `ASTER_CAPACITY_RELAY_CA_FILE` 若引用外部 CA 文件，迁移只复制该普通文件到内置数据目录的 `migration-files/` 并重写 `.env` 路径，旧文件保留；缺失或链接引用会阻止迁移。

原配置中明确指定的绝对数据路径会沿用为复制来源，Greeks 自定义 `STATE_FILE` 会复制为内置模块的 `engine_state.json`。复制后的模块由工作台数据目录定位，旧服务目录、配置文件和凭据均保留。迁移拒绝符号链接、特殊文件和过宽的数据目录，发现这种布局时不会猜测来源。

成功后，`market-spread-monitor`、`asset-ledger`、`gate-crossex-arbitrage`、`greeks`、`aster-desk` 和 `variational-grid` 旧服务保持停止与禁用。ASTER 的数据与环境配置复制到内置模块目录，独立 Variational 的配置与数据不搬迁、不删除；Asset 内部账户接入不受此入口调整影响。原生交易模块仍由工作台运行。

安装器记录旧服务的运行及开机启动状态。候选启动失败时，先停止新工作台，隔离本次新建的模块数据，再恢复旧服务状态、旧程序和工作台配置。失败候选的数据保留在 `/opt/project-aggregation/failed-module-migration-*` 供排查；下一次重试会重新复制旧服务恢复运行后的最新数据。迁移记录位于 root 私有的 `.module-migration.json`，v2 成功记录使后续更新跳过复制。已有四模块 v1 成功记录会单独补迁移 ASTER；本次事务只管理 `aster-desk`，失败不会重启已退役的其他服务或隔离其他模块数据。

## 发布、验证与失败恢复

GitHub Actions 只在 `ubuntu-24.04` 原生 x64 runner 构建一次，使用 Node.js 24.15.0 和 Python 3.12，与当前服务器的系统系列和 CPU 架构匹配。运行包包含完整 Next 运行依赖与 x64 原生库；ASTER 仅运行 `dashboard/dist/client` 静态页面和 Python 后端，其 vinext 构建依赖不进入生产依赖树，不标记为通用 `linux-any`。解压后的包需要启动工作台及五个模块完成验收。独立的安装器任务同样固定在 `ubuntu-24.04`，负责权限、systemd、增量更新与失败恢复检查，不再构建第二份应用。

x64 应用验收及安装器检查均通过后，发布 `deploy-<完整提交号>` 候选版本；发布清单必须且只能包含 `linux-x64`。沿用 **Publish stable release** 工作流将已验证候选晋级为正式版本，继续校验提交、CI 结果、文件完整性和版本前进关系。当前晋级流程仅接受 x64 候选，历史双架构 Release 保留。正式发布不会自动更新服务器。

manifest 固定提交、架构、运行内容指纹和 SHA-256；安装器先核验，再解压到独立发布目录。源代码、workspace 锁文件与 catalog、模块构建脚本及打包迁移工具均计入运行内容指纹。服务器默认不再执行 Node 依赖安装、前端构建或完整测试，也不需要 pnpm；Python 只在依赖或解释器环境变化时安装。

在线更新器正常每 1 分钟检查一次；正式版本信息缓存 30 分钟，稳定时每小时只发出少量 GitHub API 请求，其余请求访问 github.com 发布页面，不占用 API 额度。GitHub API 额度耗尽或服务器要求等待时，按响应中的恢复时间暂停，手动检查和服务重启都不会绕过；其他连续失败的自动重试间隔为 1、2、4、8、15 分钟（上限 15 分钟），手动检查可随时重试。单次检查超过 3 分钟按超时失败处理。页面会区分 API 额度耗尽、访问被拒和发布文件连接失败；检查失败仍禁止开始更新，不会把旧缓存显示为当前检查成功。

可在工作台“系统更新”面板的 GitHub Token 配置中保存、更换或移除个人访问令牌。公开仓库只需 fine-grained Token 的公开仓库只读访问，不需要写权限。保存仅确认配置已写入，后续实际访问 GitHub API 时才验证 Token 是否有效；缓存命中时可能不发起 API 请求。现有重试等待会保留，检查或更新进行中不能修改。旧更新服务缺少此能力时，先运行原一键部署命令升级一次。

Token 保存在 `/var/lib/project-aggregation-updater/credentials.json`，目录为 root/0700、文件为 root/0600，重复部署和升级会保留。检查服务及独立更新 worker 按请求读取，无需重启或设置 `GITHUB_TOKEN` 环境变量。页面、公开状态和事件流只返回是否配置；认证头只发送给 GitHub API，跨域重定向会移除，安装脚本不继承 Token。移除后恢复匿名请求；更换或移除不清空限流等待。

正式发布身份与运行内容指纹分别判断：较新的正式提交会显示“可更新”，即使应用内容相同。确认更新后，增量安装器复用相同运行包并记录已确认的正式提交，跳过无变化内容的下载、构建和工作台重启。本机领先于正式版时不自动降级；旧检查记录中的不同提交显示“版本不同”，不会仅因内容相同就显示“已是最新”。打开面板读取上次检查结果，查看刚发布的版本可点击“检查更新”；手动检查仍遵守最短 60 秒间隔和远端限流。

切换前保留上次成功的环境配置；新版本健康检查需要工作台及全部内置模块启动完成。失败时恢复旧程序、systemd 单元、环境及两个 Python 路径成功记录，失败的新配置另存为 `/etc/project-aggregation.env.failed-*`。程序回滚不撤销成功迁移之后的业务数据库写入。成功后保留当前及前一运行版本，用户数据与未知目录不参与版本清理。

本地 Windows 检查使用原生 Python、Node.js 和 Git Bash；Linux 权限、systemd 与完整安装验收在 CI 执行，不使用 WSL。
