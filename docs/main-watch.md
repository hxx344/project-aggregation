# 主服务器巡检与飞书告警

巡检服务部署在副服务器上，每分钟探测一次主服务器工作台。连续失败达到阈值时向飞书群发送告警；故障持续期间按间隔重复提醒，恢复后发送恢复通知，附带中断时长。它只依赖 Python 3.8+ 标准库与 systemd，不需要交易凭据，也不安装 Node.js 或工作台。默认不监听任何端口；开启[心跳模式](#心跳模式)后才在副服务器上常驻一个心跳接收服务。

## 一键部署

前提：主服务器的安全组和防火墙已对副服务器放通工作台端口，工作台 `HOST` 不是只监听 `127.0.0.1`。在副服务器执行（替换尖括号内容；没开签名校验就去掉 `--secret`）：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-main-watch.sh | \
  sudo bash -s -- --main <主服务器IP>:<放通端口> \
  --webhook 'https://open.feishu.cn/open-apis/bot/v2/hook/<token>' --secret '<签名密钥>'
```

入口脚本只负责引导：读取[最新正式发布](https://github.com/hxx344/project-aggregation/releases/latest)的固定提交号，只下载该提交的巡检程序和安装器两个文件，再由这个正式版的安装器完成部署。部署过程如下：

1. 依赖缺失时安装 `python3`、`curl`，并创建无登录权限的 `main-watch` 系统账号；
2. 校验配置，写入 `/etc/main-watch/config`（`root:main-watch 640`）；
3. 发送一条飞书测试消息。发送失败时整次部署回滚，旧配置与定时器保持原样；
4. 在 systemd 下实际跑一轮巡检，确认服务账号能读配置、写状态，然后启用每分钟一次的定时器；
5. 当场探测每个目标并打印结果。目标不可达只给出提醒，不回滚部署，因为主服务器可能确实故障。

`--main 主机:端口` 检查 `http://主机:端口/api/ready`。工作台入口和运行时都就绪时才返回 200，版本切换期间短暂返回 503，默认连续 3 次失败才告警，可以避免切换造成误报。需要更多目标时用 `--checks`，多个目标用空格分隔。`--main` 与 `--checks` 分开保存，只改其中一项不会影响另一项；`--checks ""` 清除额外目标。额外目标支持 `http(s)://...`（要求 2xx）和 `tcp://主机:端口`（只检查端口能否连通）。只有确认副服务器能连到该端口时才加 `tcp://<IP>:22` 这类检查，否则会持续误报。

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--main HOST:PORT` | 工作台就绪检查 | — |
| `--checks "..."` | 额外检查目标，最多 20 个 | — |
| `--webhook URL` | 飞书群机器人 Webhook | 首次必填 |
| `--secret SECRET` | 签名校验密钥 | 空 |
| `--name NAME` | 告警里的服务器名称 | 主服务器 |
| `--threshold N` | 连续失败几次才告警 | 3 |
| `--remind MINUTES` | 故障持续时的重复提醒间隔 | 30 |
| `--test` | 部署后补发一条测试消息 | — |
| `--uninstall` | 移除服务，保留配置、状态与服务账号 | — |

Webhook 和签名密钥在安装期间会短暂出现在进程参数里；副服务器有其他不受信任的登录用户时，之后更换密钥改为直接编辑配置文件（见下文），不要再通过参数传入。首次安装失败回滚后，会留下空的 `/etc/main-watch`、`/opt/main-watch`（源码缓存与锁文件）和 `main-watch` 服务账号，不影响重新安装。

## 心跳模式

拉取式检查要求主服务器对副服务器开放入站端口。心跳模式反过来：主服务器每 30 秒在本机检查一次工作台 `/api/ready`，把结果作为签名心跳推送给副服务器；副服务器常驻接收，每轮巡检把心跳当作一个检查目标。两种方式可以同时开启。

心跳模式额外能发现主服务器连不出去的情况，例如出站网络中断。这时主服务器也连不上交易所。主服务器整机宕机、工作台进程停止、心跳推送程序失败时，副服务器都会因收不到心跳而告警。

1. 副服务器开启接收。可在首次安装时一起传，也可对已安装的副服务器补传：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-main-watch.sh | \
     sudo bash -s -- --heartbeat-listen 0.0.0.0:8792
   ```

   没传 `--heartbeat-token` 时自动生成令牌，部署结束时打印主服务器要执行的完整命令（含令牌）。之后可用 `sudo grep HEARTBEAT_TOKEN /etc/main-watch/config` 再查。
2. 在副服务器的安全组放通**来源为主服务器 IP** 的 TCP 8792。主服务器不需要开放任何入站端口。
3. 在主服务器执行第 1 步打印的命令：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-main-watch.sh | \
     sudo bash -s -- --sender --send-to http://<副服务器IP>:8792/heartbeat --heartbeat-token <令牌>
   ```

   安装器从 `/etc/project-aggregation.env` 的 `HOST`/`PORT` 推算本机就绪接口（默认 `http://127.0.0.1:3100/api/ready`），也可用 `--ready-url` 指定。部署时会在 systemd 下推送首个心跳；副服务器没开接收、端口没放通或令牌不一致时，整次部署回滚并说明原因。

| 副服务器判定 | 告警内容 |
| --- | --- |
| 最近 90 秒内收到心跳，且主服务器自检就绪 | 正常 |
| 从未收到 / 超过 90 秒没收到心跳 | `尚未收到主服务器心跳` / `已 N 秒未收到主服务器心跳`；本机接收服务没在运行时附带说明 |
| 收到心跳，但主服务器自检未就绪 | `主服务器自检未就绪：HTTP 503` 等 |

告警阈值、提醒间隔、恢复通知与拉取式检查相同（默认连续 3 轮失败才告警）。心跳用令牌做 HMAC-SHA256 签名，并带毫秒时间戳：签名不符、与副服务器时钟相差超过 5 分钟、时间戳不晚于上一条的心跳一律拒绝，所以走明文 HTTP 也无法伪造或重放。心跳内容只有就绪结果，不含凭据。两台服务器都需要开启时间同步。

主服务器端的日常操作：

```bash
sudo main-watch-sender status   # 推送定时器与最近一次结果
sudo main-watch-sender logs 50
sudo main-watch-sender probe    # 只检查本机就绪接口
sudo main-watch-sender send     # 立即推送一次
```

升级主服务器端：`... | sudo bash -s -- --sender`。卸载：`... | sudo bash -s -- --sender --uninstall`。副服务器关闭心跳：`--heartbeat-listen ""`。

## 升级与修改

不带参数重复执行同一条命令即为升级：保留已有配置。程序、配置、权限和定时器都没变化，且 systemd 下最近一轮巡检成功时，直接结束，不发消息也不重启；最近一轮失败（例如配置被改坏、目录权限被改）时会重新部署并修复。带参数执行时只覆盖给出的项，其他项保留，例如 `... | sudo bash -s -- --threshold 5`。配置有变化时会重发测试消息确认通道可用。

也可以直接编辑 `/etc/main-watch/config`，然后运行 `sudo main-watch check` 校验。下一轮巡检自动生效，不需要重启。

## 日常操作

```bash
sudo main-watch status   # 定时器与最近一轮的运行状态
sudo main-watch logs 100 # 最近的巡检失败、告警发送、被拒绝的心跳记录
sudo main-watch probe    # 立即探测所有目标，不发告警
sudo main-watch test     # 发送测试消息
sudo systemctl stop main-watch.timer   # 维护期间暂停；恢复用 start
```

## 判定规则

- 每轮先检查副服务器能否连到飞书服务器。连不上时跳过本轮，不计入主服务器失败，避免副服务器自己断网时误报。
- 告警或恢复通知发送失败（网络错误，或飞书返回非 0，例如签名不匹配）时，下一轮继续重发。恢复通知待发期间目标短暂复发时，待发通知保留到下次恢复时补发；复发达到告警阈值的，以新告警取代旧的待发通知。
- 单个目标失败后又恢复、但没达到告警阈值的，不发任何消息。
- 状态保存在 `/var/lib/main-watch/state.json`，重启副服务器后连续失败计数和告警记录都会保留；损坏的条目从零重新计数。
- 从配置中删除一个已告警的目标，不会再为它发恢复通知。

## 验证范围

CI 在 Ubuntu 24.04 的真实 systemd 上验证：首次安装被飞书拒绝时不留下服务、首次安装、测试消息与签名、systemd 下的告警轮次、无变化跳过、升级时飞书拒绝的回滚、非法参数不改动、只改额外目标时保留就绪检查、部署损坏时修复而不跳过，以及卸载。心跳模式在同一台机器上同时安装接收端与推送端，验证令牌错误时推送端回滚、真实心跳送达后巡检判定正常、工作台未就绪时告警“自检未就绪”、推送端无变化跳过、单独卸载推送端不影响巡检，以及关闭心跳后接收服务停止。从 GitHub 下载正式版的引导路径依赖正式发布，CI 不覆盖，以实际部署结果为准。
