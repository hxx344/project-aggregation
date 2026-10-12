# 统一部署与迁移

工作台保留原生交易功能，同时内置 Market Monitor、Asset Ledger、Gate CrossEx 与 Greeks。四个模块的源码、页面和后端均随本仓库统一构建、验证、安装与更新。它们不再作为独立网站或独立 systemd 服务运行。

## 安装与升级

支持 Ubuntu 24.04、Debian 12/13，x64/arm64，需 systemd 和 Python 3.11+：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash
```

同一命令可重复执行。兼容入口 `deploy/install-all.sh` 只协调工作台安装器 `deploy/install.sh`，在线更新也只有 `hub` 一个目标。`--only hub` 继续可用，内置模块不支持独立安装或更新；旧的其他 `--only` 选项会明确拒绝。`--refresh` 只重新获取安装器，`--with-tests` 仅用于显式 `PROJECT_DEPLOY_MODE=source` 的排查部署。

默认从正式 Release 下载已经验证的对应架构运行包。Node.js 自动准备为 24.15 或更高的 24.x；Greeks 依赖由 `modules/greeks/requirements.lock` 固定版本与哈希，虚拟环境以锁文件、Python 版本和架构为键缓存。无变化且健康时，跳过应用包下载、依赖安装、构建、完整验证与服务重启。

## 服务与数据

只有 `project-aggregation.service` 对外提供业务 HTTP，默认绑定 `127.0.0.1:3100`。模块由工作台管理独立 Node worker；Greeks 通过 Python 标准输入输出桥运行，不另开 TCP 端口。在线更新控制服务继续使用 Unix socket。所有模块沿用工作台鉴权，进入模块页面无需再保存独立网站登录凭据。

| 路径 | 用途 |
| --- | --- |
| `/etc/project-aggregation.env` | 工作台配置、监听与数据目录 |
| `/var/lib/project-aggregation` | 默认工作台数据目录，保留原生交易数据 |
| `$DATA_DIR/modules/monitor` | Monitor 状态与迁移的 `.env` |
| `$DATA_DIR/modules/asset` | Asset `config.json`、SQLite 数据与附件 |
| `$DATA_DIR/modules/crossex` | CrossEx SQLite 数据及 `credentials.key` |
| `$DATA_DIR/modules/greeks` | Greeks `engine_state.json` 与迁移的 `.env` |
| `/opt/project-aggregation/releases` | root 只读运行版本 |
| `/opt/project-aggregation/python` | 按内容缓存的 Greeks Python 环境 |

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

原配置中明确指定的绝对数据路径会沿用为复制来源，Greeks 自定义 `STATE_FILE` 会复制为内置模块的 `engine_state.json`。复制后的模块由工作台数据目录定位，旧服务目录、配置文件和凭据均保留。迁移拒绝符号链接、特殊文件和过宽的数据目录，发现这种布局时不会猜测来源。

成功后，`market-spread-monitor`、`asset-ledger`、`gate-crossex-arbitrage`、`greeks`、`aster-desk` 和 `variational-grid` 旧服务保持停止与禁用。ASTER 和独立 Variational 的配置与数据不搬迁、不删除；Asset 内部账户接入不受此入口调整影响。原生交易模块仍由工作台运行。

安装器记录旧服务的运行及开机启动状态。候选启动失败时，先停止新工作台，隔离本次新建的模块数据，再恢复旧服务状态、旧程序和工作台配置。失败候选的数据保留在 `/opt/project-aggregation/failed-module-migration-*` 供排查；下一次重试会重新复制旧服务恢复运行后的最新数据。迁移记录位于 root 私有的 `.module-migration.json`，成功记录使后续更新跳过复制。

## 发布、验证与失败恢复

GitHub Actions 分别在原生 Linux x64 和 arm64 构建，运行包包含完整 Next 运行依赖与对应架构原生库，不标记为通用 `linux-any`。解压后的包需要启动工作台及四个模块完成验收。两个架构及安装器检查均通过后，发布 `deploy-<完整提交号>` 候选版本；沿用 **Publish stable release** 工作流将已验证候选晋级为正式版本。正式发布不会自动更新服务器。

manifest 固定提交、架构、运行内容指纹和 SHA-256；安装器先核验，再解压到独立发布目录。源代码、模块锁文件、模块构建脚本及迁移工具均计入运行内容指纹。服务器默认不再执行 npm 安装、前端构建或完整测试；Python 只在依赖或解释器环境变化时安装。

切换前保留上次成功的环境配置；新版本健康检查需要工作台及全部内置模块启动完成。失败时恢复旧程序、systemd 单元和环境，失败的新配置另存为 `/etc/project-aggregation.env.failed-*`。程序回滚不撤销成功迁移之后的业务数据库写入。成功后保留当前及前一运行版本，用户数据与未知目录不参与版本清理。

本地 Windows 检查使用原生 Python、Node.js 和 Git Bash；Linux 权限、systemd 与完整安装验收在 CI 执行，不使用 WSL。
