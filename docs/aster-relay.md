# Aster 独立额度中继

中继部署在另一台 Linux 服务器，只采集 Aster 公共额度和风险档位，经 HTTPS/WSS 提供给工作台。它不需要交易账户的私钥，不运行工作台或交易执行服务。代码、安装器、验证与正式版本统一由本仓库维护。

工作台只从副服务器读取黄金 `XAUUSD1`、白银 `XAGUSD1` 的额度和杠杆档位。其他币种由主服务器直接读取 Aster，普通监控每币约 `60` 秒刷新、逐币错开；策略需要的额度采用 `2` 秒基线，档位约 `60` 秒刷新，预算不足时自动放慢。副服务器故障不影响其他币种的直接读取；金银中继失败仍等待中继恢复。主服务器会忽略旧中继配置推送的其他币种，无需为此修改副服务器配置。

## 新服务器安装

中继使用 Python 3.11+、OpenSSL 与 systemd。独立 CI 在 Ubuntu 26.04 x64 上使用系统 Python，验证依赖、真实 systemd 安装、TLS/WSS、重复安装及失败恢复；工作台自身的 Ubuntu 24.04 发布环境保持不变。

从本仓库[最新正式发布](https://github.com/hxx344/project-aggregation/releases/latest)取得 `deploy-` 后的完整 40 位提交号，将下列 `RELEASE_COMMIT` 和公网 IP 替换为实际值。在新中继服务器执行：

```bash
RELEASE_COMMIT='<正式发布的40位提交号>'
curl -fsSL "https://raw.githubusercontent.com/hxx344/project-aggregation/$RELEASE_COMMIT/deploy/install-aster-relay.sh" | sudo bash -s -- --address <中继公网IP>
```

安装器自动准备缺少的依赖、独立服务账号、连接令牌、包含该 IP 的自签证书、systemd 服务及管理命令。默认端口 `8766`，默认订阅黄金 `XAUUSD1` 和白银 `XAGUSD1`；每个标的的公开额度采集间隔为 `0.4` 秒，风险档位采集间隔为 `60` 秒。云安全组和系统防火墙需要允许工作台服务器访问中继的 TCP `8766`；限制来源时使用工作台实际出口 IP。

安装入口固定到已正式发布的提交。安装器通过正式发布清单发现稳定版本，从同一固定提交的本仓源码中只提取中继所需文件，再运行该版本安装逻辑。不会下载原独立仓库代码，也不会安装 Node.js 或工作台前端。

同一安装命令可以重复执行升级。代码、依赖、配置与解释器环境未变且服务健康时，跳过源码归档下载、依赖安装、验证及服务重启。仅版本身份变化而内容相同时更新版本记录并复用运行内容；代码变化但依赖未变时复用 Python 环境。升级保留已有令牌、证书和订阅配置，失败时恢复旧运行版本及服务状态。

## 接入现有工作台

在中继服务器执行以下命令，复制输出的连接 JSON。该输出包含连接令牌，只用于导入你自己的工作台。

```bash
sudo aster-capacity-relay export-connect
```

在**工作台服务器**使用同一个正式提交下载接入工具，粘贴 JSON 后回车。输入不会回显：

```bash
RELEASE_COMMIT='<正式发布的40位提交号>'
curl -fsSL "https://raw.githubusercontent.com/hxx344/project-aggregation/$RELEASE_COMMIT/deploy/configure-aster-relay.py" | sudo python3 -I - connect --interactive
```

工具先核对 HTTPS 地址、令牌、证书与已认证连接，再保存到实际 `$DATA_DIR/modules/aster/.env`。`DATA_DIR` 从 `/etc/project-aggregation.env` 读取，默认 `/var/lib/project-aggregation`；其他账户配置和数据保持原样。CA 按内容保存为独立文件，已有连接仍可使用原证书。重复导入相同连接不会重复写入。

**保存后，运行中的工作台仍使用原连接，下次重启才生效。** 接入工具不自动重启服务。先暂停工作台内所有交易模块的新任务，处理在途操作及待核对委托，再执行：

```bash
sudo systemctl restart project-aggregation
```

这是整个工作台的服务重启。进入工作台的 Aster 5x 页面，确认副服务器额度连接及黄金、白银数据状态。旧的 `aster-desk relay-connect` 不适用于当前工作台。

## 状态与配置

```bash
sudo aster-capacity-relay status
sudo aster-capacity-relay logs
sudo aster-capacity-relay restart
```

`status` 应显示 `collector_running=true`，`configured_symbols` 包含所需标的，每个标的的 `oi`、`brackets` 样本均为 `ready=true`。`/health` 成功只表示 TLS、鉴权和服务可达；额度源暂时不可用时安装仍可成功，但需要根据采样状态判断数据是否可用。

| 路径 | 用途 |
| --- | --- |
| `/etc/aster-capacity-relay/environment` | 令牌、端口、订阅标的与证书路径 |
| `/etc/aster-capacity-relay/server.crt`、`server.key` | 中继证书与私钥 |
| `/etc/aster-capacity-relay/address` | 已绑定的公网 IP |
| `/opt/aster-capacity-relay/current` | 当前运行版本 |
| `/opt/aster-capacity-relay/cache` | 按内容与解释器环境缓存的 Python 依赖 |
| `aster-capacity-relay.service` | 独立中继 systemd 服务 |

已有配置只订阅黄金时，在 `environment` 中将 `ASTER_RELAY_SYMBOLS` 改为 `XAUUSD1,XAGUSD1` 后重启中继；升级不会覆盖显式订阅值。已有服务器的 `--address` 必须与原 IP 一致，避免悄悄改变证书和连接身份。换机后使用新机器导出的连接重新接入工作台。

已有服务器也会保留 `ASTER_RELAY_INTERVAL`，因此升级不会自动把原来的 `0.2` 秒改为 `0.4` 秒。在副服务器执行以下命令即可将公开额度采集频率减半并重启中继，无需升级代码。如果状态仍显示限流退避，等 `backoff_seconds=0` 后再重启，避免清除尚未结束的退避计时。

```bash
sudo sed -i 's/^ASTER_RELAY_INTERVAL=.*/ASTER_RELAY_INTERVAL=0.4/' /etc/aster-capacity-relay/environment && sudo aster-capacity-relay restart
```

启动后运行 `sudo aster-capacity-relay status`，确认 `effective_interval_seconds` 为 `0.4`；服务刚启动时若暂未连接成功，隔几秒重查。该命令适用于安装器生成、已包含 `ASTER_RELAY_INTERVAL` 的配置；不会重启工作台。风险档位采集间隔、样本有效期及限流退避规则保持原有设置。

安装与连接测试在 `deploy/test-aster-relay-install.py`、`deploy/test-aster-relay-config.py`；真实 Linux 验收在 `deploy/test-aster-relay-systemd.sh`。这些检查是正式发布的必要条件，不在 WSL 中执行。
