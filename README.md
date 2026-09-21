# Project Aggregation · 项目工作台

把 ASTER 5X、Market Monitor 和 Asset Ledger 放进一个入口：查看摘要、判断数据是否过期、进入原项目，并继续接入新的工具。

工作台独立运行，后端只读取已有项目的概览接口。资产以 Asset Ledger 为单一来源，ASTER 的保证金和成交量不会再次计入资产。项目不可用时保留上次成功的数据并明确标注状态；未取得的数据不会填成零或展示虚构行情。

## 首版提供什么

- 总览：资产账本摘要与历史曲线、交易账户和占用保证金、原油价差、连接与数据时效。
- 项目入口：打开原页面；可选嵌入模式，并保留直接打开入口。
- 接入管理：新增、编辑、停用、删除项目，配置页面地址、接口地址、适配器和数据过期阈值。
- 后台每 30 秒读取已启用的数据源。浏览器关闭后仍会读取；这不会代替原项目自己的行情采集或资产同步。
- 独立的工作台密码登录、服务器端会话和本地 SQLite 持久化。
- 增量一键部署、systemd 服务、健康检查和启动失败后的程序回滚。

首版不提供交易下单、启停策略、转账或资产同步按钮；相关操作仍在各自原项目内完成。统一入口也不会合并原项目的登录会话。

## 在现有 Linux 服务器安装

适用于使用 systemd 的 Debian / Ubuntu，支持 x64、arm64。三个旧项目继续使用原来的端口。以下同一条命令用于首次安装和后续更新：

```bash
sudo bash -c 'set -e; command -v curl >/dev/null || { apt-get update -qq && apt-get install -y curl ca-certificates; }; f=$(mktemp); curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/install.sh -o "$f"; bash "$f"; rm -f "$f"'
```

脚本安装缺失依赖，复用可用的 Node.js 24.15.0 或更高的 24.x 版本；需要安装时，从 Node.js 官方下载固定版本并核验官方 SHA-256。构建与服务使用专用 `project-aggregation` 用户。工作台默认仅监听 `127.0.0.1:3100`。

首次登录密码只在第一次启动时写入服务日志，在服务器查看：

```bash
sudo journalctl -u project-aggregation --no-pager -n 30
```

在自己的电脑运行以下一条 SSH 命令，把 `user@server` 替换为服务器登录地址，然后打开 [工作台](http://127.0.0.1:3100)：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 3100:127.0.0.1:3100 -L 3000:127.0.0.1:3000 -L 5678:127.0.0.1:5678 -L 18765:127.0.0.1:18765 user@server
```

保持这个终端运行，四个默认页面地址即可从电脑访问。如果某个本地端口被占用，可修改对应 `-L` 的第一个端口，同时修改工作台里的“页面地址”；“接口地址”继续填写服务器内的原端口。

## 连接三个项目

以下是首启时预置的配置。进入“项目管理”，为已设登录保护的项目填写现有页面的密码；monitor 若启用 HTTP Basic，还要填写用户名。这里填写的是原项目登录凭据，不是交易所 API Key。

| 项目 | 页面地址：浏览器访问 | 接口地址：工作台服务器访问 | 适配器 |
| --- | --- | --- | --- |
| ASTER 5X | `http://127.0.0.1:18765/` | `http://127.0.0.1:18765` | `aster` |
| Market Monitor | `http://127.0.0.1:3000/?monitor=oil` | `http://127.0.0.1:3000` | `monitor` |
| Asset Ledger | `http://127.0.0.1:5678/` | `http://127.0.0.1:5678` | `asset` |

`127.0.0.1` 指发出请求的那台机器。后端和三个项目部署在同一台 Linux 服务器时，上表的接口地址正确；电脑上的浏览器则需要上面的 SSH 转发，或能访问原项目的真实域名 / 地址。接口地址不含查询参数，monitor 选中的模块从页面地址的 `?monitor=oil` 读取。

如果 ASTER 或 Asset 原项目设置了外部 `PUBLIC_ORIGIN`，在“登录来源地址（可选）”填写同一个来源地址，例如 `https://asset.example.com`；其余情况留空，默认使用接口服务的来源。接口请求仍访问配置的本机接口地址。

保存后如果接口地址、适配器或登录来源地址发生变化，需要重新输入凭据。密码空白表示保留已保存的密码；清除凭据使用页面的专门选项。服务器加密保存上游密码，读取项目配置的接口不会返回密码。

嵌入模式受原页面的 `X-Frame-Options`、CSP、浏览器 Cookie 和 HTTPS 混合内容规则影响。工作台保留“打开原页面”入口；无法嵌入时使用这个入口即可。原应用的登录仍由原应用处理，工作台不会向浏览器传递原项目密码。

## 数据怎样计算

| 数据 | 来源和口径 |
| --- | --- |
| 资产表内总额 | `asset /api/ledger` 中所有资产行的 `value` 之和，单位 USD，包含原账本的“出金”行。 |
| 当前持有 | 表内总额减去项目名为“出金”的行。不叠加 ASTER 的余额、保证金。 |
| 资产历史 | 原账本已经保存的历史总额，最多最近 90 个有效日期；排除未来与归档记录，同日优先日快照。日期按北京时间展示。这是资产金额历史，不是收益率或回测曲线，入金和出金也会改变它。 |
| 资产更新时间 | 动态资产行更新时间中的最早值，明确标记 `mode=manual` 的手工行不参与实时过期计算；手工行最早估值记录时间单独展示。纯手工账本标记“静态估值”，保留估值记录时间。工作台只读账本，不调用账户同步。需要新动态数据时先在原项目同步。 |
| 交易概览 | `aster /api/state?compact=true`，统计启用账户及实盘账户。保证金、今日成交量使用上游 USD1 单位；今日成交量按上游 UTC 日口径，不做人民币换算。演示数据会有明确提示。 |
| 交易更新时间 | 实盘账户快照中的最早时间；快照缺失不会当成刚刚更新。 |
| 原油监控 | monitor 模块的 Binance 标记价格；价差 = 布伦特 − WTI，单位 USDT/桶，不是现货报价或百分比。 |
| 监控时效 | 使用报价的源更新时间并保留采集器的过期/部分失败状态；工作台成功连通不代表行情新鲜。 |

`checkedAt` 是工作台最近一次检查时间，`updatedAt` 是数据源实际更新时间；纯手工账本对应手工估值记录时间。默认 aster / monitor 超过 120 秒、asset 动态资产超过 900 秒标记过期，可按项目调整为 30–86400 秒。只有所有资产行都明确为 `mode=manual` 才按静态估值处理，不因记录较早就判定实时报价过期；未知或缺失分类按动态数据处理并提示不完整。单次上游读取总时限默认 5 秒；一个项目超时不会阻塞其他项目。

首次没有数据时显示等待、未连接或需要认证。读到部分异常数据时提示不完整；读取失败时保留旧值和源时间。上游提供的账本示例数据也会标明，不能作为真实资产结果。

## 接入后续项目

1. 只需要入口：在项目管理选择 `link`，填写页面地址即可。链接模式表示入口已配置，不会检测或采集该网站的数据。
2. 需要摘要：选择 `standard`，让新项目实现 `GET /api/hub/summary`。可选 HTTP Basic 认证，填写用户名与密码。
3. 旧系统接口不符合标准：在 `server/adapters.mjs` 增加适配器，同时更新前后端允许的适配器列表，并补充行为测试。

标准接口 `schemaVersion: 1` 的示例与字段约束见 [扩展协议](docs/integration.md)。当前最多接入 30 个项目，单个摘要最多 24 个指标、366 个趋势点。接入配置保存在本机数据库里，重启或升级后保留。

## 维护、配置和恢复

| 路径 | 用途 |
| --- | --- |
| `/etc/project-aggregation.env` | 服务配置；重复安装保留现有内容。 |
| `/var/lib/project-aggregation/` | 数据库 `hub.sqlite`、SQLite 日志及 `credentials.key`；不随程序版本清理。 |
| `/opt/project-aggregation/current` | 当前程序版本的符号链接。 |
| `/opt/project-aggregation/previous` | 上一个成功版本；更新完成后保留当前和前一版本。 |
| `/opt/project-aggregation/.last-successful.env` | 上次健康启动的环境配置快照，仅 root 可读，供失败回滚使用。 |
| `/opt/project-aggregation/cache` | 按内容和运行环境缓存依赖、前端构建及验证结果。 |
| `/etc/systemd/system/project-aggregation.service` | 自动管理的服务配置；使用环境文件修改监听地址等选项。 |

环境文件使用无引号的 `KEY=value`：

```dotenv
HOST=127.0.0.1
PORT=3100
DATA_DIR=/var/lib/project-aggregation
NODE_ENV=production
```

修改配置后重复执行安装命令。数据目录应是专用目录，安装器接受 `/var/lib/project-aggregation`、其子目录、`/srv/project-aggregation/` 下的子目录或 `/opt/project-aggregation-data`；改目录前自行迁移完整旧数据。直接改路径会使用新目录，不会自动移动旧数据。

忘记工作台密码时，在默认数据目录下运行：

```bash
sudo -u project-aggregation env DATA_DIR=/var/lib/project-aggregation "$(cat /opt/project-aggregation/.node-path)" /opt/project-aggregation/current/server/setup.mjs --reset-password
```

这会显示新密码并撤销原有工作台会话。自定义了 `DATA_DIR` 时，命令也要使用相同的目录。

```bash
sudo systemctl status project-aggregation
sudo journalctl -u project-aggregation -f
```

更新没有变化且服务健康时，会跳过源码下载、依赖安装、检查、构建和重启。仅文档变化会跳过应用更新；依赖不变复用安装结果，前端内容不变复用构建结果。新版本必须通过类型检查、行为测试、构建和健康检查，才记录为已部署。启动失败自动恢复前一程序版本、systemd 配置及上次健康启动的环境配置，并按旧地址和端口检查恢复结果。用户本次修改的配置另存为 `/etc/project-aggregation.env.failed-时间-PID`（仅 root 可读），可以修正后重新使用；首次安装失败保持当前配置原样。不会把持久数据恢复成旧副本，也不会删除未知目录。

备份时停止服务，保存完整的数据目录与环境文件，再启动服务。`hub.sqlite` 和 `credentials.key` 必须一起保留；运行中的 SQLite 还可能有 WAL 文件，不要只复制单个数据库文件。密钥丢失时服务器会拒绝启动，防止已有凭据被错误覆盖。

如果已有 HTTPS 反向代理，可把工作台代理到 `127.0.0.1:3100`，传递原始 `Host`，并在环境文件设置 `COOKIE_SECURE=true`；代理示例见 [部署说明](docs/deployment.md)。页面地址改为浏览器可访问的 HTTPS 地址，后端接口地址仍可保持服务器本地地址。

## 本地开发和验证

要求 Node.js 24.15.0+；Linux 安装器复用 24.x，CI 使用 Node 24。无需数据库服务。

```bash
npm ci
npm run check
npm test
npm run build
npm start
```

生产启动默认地址为 [http://127.0.0.1:3100](http://127.0.0.1:3100)。开发时在两个终端分别运行 `npm run dev:server` 和 `npm run dev`；Vite 位于 [http://127.0.0.1:5173](http://127.0.0.1:5173)，代理 `/api` 到后端。开发数据默认放在未提交的 `.data/`。

GitHub Actions 在 Windows 执行类型检查、行为测试和构建；Ubuntu job 检查安装脚本语法、原子切换、清理边界、程序回滚及端口配置冲突后的恢复。测试使用模拟上游，不等于连接了你的 Linux 服务器或真实交易账户。是否真实连通，以部署后页面的状态和源数据时间为准。本项目不使用 WSL 验证。
