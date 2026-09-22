# Project Aggregation · 项目工作台

把 ASTER 5X、Market Monitor、Asset Ledger 和 Gate CrossEx 放进一个入口：查看摘要、判断数据是否过期、进入原项目，并继续接入新的工具。

工作台独立运行，通过一个 SSH 转发端口查看摘要并打开四个完整原页面，也可在页面关闭后继续触发 Asset 后台同步。资产以 Asset Ledger 为单一来源，ASTER 的保证金和成交量不会再次计入资产，CrossEx 的模拟余额和模拟盈亏也不会计入。项目不可用时保留上次成功的数据并明确标注状态；未取得的数据不会填成零或展示虚构行情。

## 首版提供什么

- 总览：资产账本摘要与历史曲线、交易账户和占用保证金、原油价差、连接与数据时效。
- 项目入口：点击左侧项目，内容区直接显示原始页面；保存原项目凭据后自动登录。总览保留跨项目摘要，项目管理负责连接设置。
- 接入管理：新增、编辑、停用、删除项目，配置页面访问方式、接口地址、适配器、Asset 后台同步和数据过期阈值。
- 工作台后端每 30 秒读取已启用项目的现有数据；启用 Asset 后台同步时，每 60 秒调用原项目的同步接口。浏览器关闭后仍会执行。
- 独立的工作台密码登录、服务器端会话和本地 SQLite 持久化。
- 增量一键部署、systemd 服务、健康检查和启动失败后的程序回滚。

工作台的自动任务不会下单、启停策略或转账；Asset 同步只调用原项目已有的资产同步功能，会更新估值和历史记录。原页面的操作仍由原项目处理；页面访问使用独立会话，不与后台读取或同步共用。

## 原有三个项目的统一界面

ASTER、Monitor 和 Asset 的原始前端采用同一套浅色青绿样式：顶部显示项目名称及操作，横向导航切换项目内部功能，表格、表单、图表和弹窗保持一致。工作台保留左侧项目栏；Asset 原来的内部侧栏改为横向导航。原站单独打开时也使用相同布局，所有功能、数据口径和登录保护继续由原项目提供。

样式直接维护在各自仓库里，工作台不会向原页面注入 CSS。**仅更新工作台不会更新三个原项目的界面**。已在同一台服务器部署这四个服务时，可运行以下一条命令依次调用各自现有安装器升级：

```bash
sudo bash -c 'set -e; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; for path in aster_5x/main/install-trading.sh market-spread-monitor/main/deploy/install.sh asset-ledger/main/install.sh project-aggregation/main/install.sh; do printf "\n更新 %s\n" "$path"; curl -fsSL "https://raw.githubusercontent.com/hxx344/$path" -o "$f"; bash "$f"; done'
```

各安装器沿用已有配置、密码和数据，按原有增量规则决定是否构建和重启；某一步失败即停止后续升级，修复后可重复执行。完成后重新载入工作台中的项目，仍只需转发 `3100`。后续项目可复用 [界面样式约定](docs/workspace-style.md)。

## 接入 Gate CrossEx 模拟模块

Gate CrossEx 独立部署，第一版用于同币种跨交易所永续价差套利模拟，与 Market Monitor 的价差发现配合使用，不执行实盘下单。以下一条命令依次更新 Monitor、安装或更新 CrossEx、更新工作台，复用各仓库现有安装器：

```bash
sudo bash -c 'set -e; command -v curl >/dev/null || { apt-get update -qq && apt-get install -y curl ca-certificates; }; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; for path in market-spread-monitor/main/deploy/install.sh gate-crossex-arbitrage/main/install.sh project-aggregation/main/install.sh; do printf "\n更新 %s\n" "$path"; curl -fsSL "https://raw.githubusercontent.com/hxx344/$path" -o "$f"; bash "$f"; done'
```

各安装器保留已有配置与数据；无变化时按各自规则跳过重复安装、构建和重启。某一步失败会停止，修复后可重复执行。

工作台升级后会一次性补充 `Gate CrossEx` 入口，默认通过代理访问服务器 `127.0.0.1:3200`。在“项目管理 → Gate CrossEx”填写用户名 `admin` 和 **CrossEx 自己的网页登录密码**，该密码与工作台密码独立，首次启动时记录在 `gate-crossex-arbitrage` 服务日志中。保存后点击左侧入口即可自动登录，仍只需转发工作台的 `3100`。

```bash
sudo journalctl -u gate-crossex-arbitrage --no-pager -n 30
```

Monitor 数据源地址及其 Basic 凭据在 **CrossEx 页面**配置；同机默认来源为 `http://127.0.0.1:3000`。工作台保存的项目登录信息不会自动传给 CrossEx 的数据源设置，也不需要在工作台填写交易所 API Key。

升级保留全部已有项目配置；若已有 `crossex` 标识，不会覆盖。手动删除入口后重启不会重新添加。首次升级时已满 30 个项目则跳过自动添加并记为已处理；腾出名额后可手动添加 `standard` 项目，使用 `proxy`、端口 `3200`、过期阈值 `120` 秒。

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
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3100:127.0.0.1:3100 user@server
```

保持这个终端运行。打开 `http://127.0.0.1:3100` 会跳转到 `http://hub.localhost:3100`；从工作台进入项目时，工作台为各项目生成独立的 `.localhost` 子域，仍使用 `3100`。无需再转发各原项目端口。

Chrome / Edge 会把 `.localhost` 子域解析到本机，无需修改 hosts 或 DNS；单端口原页面代理当前支持这种 SSH 本地访问方式，不承诺 Safari 或通用域名代理。[浏览器兼容说明](https://learn.microsoft.com/en-us/aspnet/core/test/localhost-tld?view=aspnetcore-10.0)

## 连接四个项目

以下是首启时预置的配置。进入“项目管理”，为已设登录保护的项目填写现有页面的密码；monitor 若启用 HTTP Basic，还要填写用户名，CrossEx 用户名为 `admin`。保存一次后，通过工作台打开项目即可自动登录。这里填写的是原项目登录凭据，不是交易所 API Key。

| 项目 | 页面地址：提供入口路径和查询参数 | 接口地址：工作台服务器访问 | 适配器 |
| --- | --- | --- | --- |
| ASTER 5X | `http://127.0.0.1:8765/` | `http://127.0.0.1:8765` | `aster` |
| Market Monitor | `http://127.0.0.1:3000/?monitor=oil` | `http://127.0.0.1:3000` | `monitor` |
| Asset Ledger | `http://127.0.0.1:5678/` | `http://127.0.0.1:5678` | `asset` |
| Gate CrossEx | `http://127.0.0.1:3200/` | `http://127.0.0.1:3200` | `standard` |

升级时，缺少 `accessMode` 的三个原有内置项目默认采用 `proxy`；CrossEx 预置显式使用 `proxy`。缺少 `autoSync` 的 Asset 默认开启后台同步，其他项目默认关闭。已保存的显式设置继续保留。

接口地址不会自动迁移。若现有 ASTER 接口地址仍是 `http://127.0.0.1:18765`，请在“项目管理”中改为 `http://127.0.0.1:8765`，重新填写 ASTER 网页登录密码并保存。工作台不会自动改端口或把旧密码搬到新目标。采用 `proxy` 时，旧页面地址中的 `18765` 不作为连接目标，可以保留或改为上表地址。

`proxy` 仅连接 `apiUrl` 指定的服务器接口地址，页面地址 `url` 只提供路径和查询参数；例如 monitor 的 `?monitor=oil` 会保留。`direct` 则让浏览器直接打开 `url`，需要该地址本身可达。接口地址不含查询参数；同机部署时，上表的 `127.0.0.1` 指 Linux 服务器。

如果 ASTER 的 `ASTER_PUBLIC_ORIGIN` 或 Asset 的 `PUBLIC_ORIGIN` 设置了外部地址，在“登录来源地址（可选）”填写同一个来源地址，例如 `https://asset.example.com`；其余情况留空，默认使用接口服务的来源。接口请求仍访问配置的本机接口地址。

保存后如果接口地址、适配器或登录来源地址发生变化，需要重新输入凭据。密码空白表示保留已保存的密码；清除凭据使用页面的专门选项。服务器加密保存上游密码，读取项目配置的接口不会返回密码。

保存的密码、Basic 认证信息和上游会话只留在工作台服务器。通过工作台打开 ASTER 或 Asset 时，每次页面授权都建立独立的原项目登录会话，不与摘要读取及 Asset 后台同步共用。monitor 使用保存的 Basic 凭据，先读取 `/api/monitors` 验证；采用 `proxy` 的 `standard` 则使用已有的 `/api/hub/summary` 做同样的只读预检。浏览器只接收工作台的页面授权 Cookie，不接收上游密码或会话。

尚未保存凭据时，仍可进入原站登录页，也可以回“项目管理”保存一次。自动登录失败或会话过期时，回工作台重新打开项目；密码已变更时先更新保存的信息。`direct` 以及 `link` 项目仍按原站方式自行登录。

页面访问使用一次性授权票据和绑定工作台会话的 host-only Cookie。在原项目退出登录会撤销当前页面授权；退出工作台会撤销全部页面授权，修改项目配置也会使该项目已有授权失效。

代理模式下，点击左侧项目即自动载入原始页面，不再经过摘要详情或手动载入。原页面占满内容区，顶部保留“重新载入”“单独打开”和“连接设置”；原有 `mode=external` 配置也直接采用此方式，无需改数据库。后台摘要刷新不会重新载入正在操作的页面。代理允许原页面嵌入工作台：代理将 `X-Frame-Options` 和 CSP 的 `frame-ancestors` 统一为仅允许当前工作台嵌入，保留其余 CSP 限制。也可以用“单独打开”独立操作。直接访问模式仍受原页面自身的嵌入策略限制。

## 数据怎样计算

| 数据 | 来源和口径 |
| --- | --- |
| 资产表内总额 | `asset /api/ledger` 中所有资产行的 `value` 之和，单位 USD，包含原账本的“出金”行。 |
| 当前持有 | 表内总额减去项目名为“出金”的行。不叠加 ASTER 的余额、保证金或 CrossEx 模拟余额。 |
| 资产历史 | 原账本已经保存的历史总额，最多最近 90 个有效日期；排除未来与归档记录，同日优先日快照。日期按北京时间展示。这是资产金额历史，不是收益率或回测曲线，入金和出金也会改变它。 |
| 资产更新时间 | 动态资产行更新时间中的最早值，明确标记 `mode=manual` 的手工行不参与实时过期计算；手工行最早估值记录时间单独展示。纯手工账本标记“静态估值”，保留估值记录时间。后台同步状态在项目管理中单独展示，不代替资产源时间。 |
| 交易概览 | `aster /api/state?compact=true`，统计启用账户及实盘账户。保证金、今日成交量使用上游 USD1 单位；今日成交量按上游 UTC 日口径，不做人民币换算。演示数据会有明确提示。 |
| 交易更新时间 | 实盘账户快照中的最早时间；快照缺失不会当成刚刚更新。 |
| 原油监控 | monitor 模块的 Binance 标记价格；价差 = 布伦特 − WTI，单位 USDT/桶，不是现货报价或百分比。 |
| 监控时效 | 使用报价的源更新时间并保留采集器的过期/部分失败状态；工作台成功连通不代表行情新鲜。 |
| CrossEx 模拟摘要 | `standard /api/hub/summary`，单独展示模块提供的模拟指标，不计入真实资产总额或资产历史。具体价差发现、来源配置和模拟操作在 CrossEx 原页面进行。 |

`checkedAt` 是工作台最近一次检查时间，`updatedAt` 是数据源实际更新时间；纯手工账本对应手工估值记录时间。默认 aster / monitor 超过 120 秒、asset 动态资产超过 900 秒标记过期，可按项目调整为 30–86400 秒。只有所有资产行都明确为 `mode=manual` 才按静态估值处理，不因记录较早就判定实时报价过期；未知或缺失分类按动态数据处理并提示不完整。单次上游读取总时限默认 5 秒；一个项目超时不会阻塞其他项目。

Asset 后台同步可在项目设置中开关。启用、项目未停用且已保存原项目登录凭据时，服务器每 60 秒调用 `POST /api/sync`，即使原页面关闭、浏览器退出或 SSH 断开也会继续运行。单次同步最多等待 60 秒，不阻塞其他项目的摘要读取。同步调用原有资产同步功能，会写入估值和历史，不执行下单或转账。关闭此开关后，工作台仍定期读取账本；原页面自身的同步功能不受影响。同步失败会保留旧数据；“最近同步尝试”或成功响应不代表每个来源都已更新，应同时查看源数据时间和错误状态。

首次没有数据时显示等待、未连接或需要认证。读到部分异常数据时提示不完整；读取失败时保留旧值和源时间。上游提供的账本示例数据也会标明，不能作为真实资产结果。

通过工作台打开 Asset 原页面时，已开启后台同步且已保存密码的 `/api/sync` 请求与后台共用一次同步。代理使用当前页面授权保存在服务器上的 Asset 会话，先验证账本访问权限，同步完成后再读取真实账本，避免同时刷新造成锁冲突；不要求浏览器持有原站会话 Cookie。页面授权或上游认证无效时不能读取，同步失败不伪装为成功。关闭后台同步后，原页面同步请求照常转发。

## 接入后续项目

1. 只需要入口：在项目管理选择 `link`，默认 `direct`，填写浏览器可访问的页面地址。若需要通过工作台访问，可改为 `proxy` 并填写接口地址；链接模式不会采集摘要。
2. 需要摘要：选择 `standard`，让新项目实现 `GET /api/hub/summary`。可选 HTTP Basic 认证，填写用户名与密码；页面默认 `direct`。改为 `proxy` 后，工作台会用该接口验证保存的 Basic 凭据，再自动认证页面请求。
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

如果已有 HTTPS 反向代理，可把工作台代理到 `127.0.0.1:3100`，传递原始 `Host`，并设置 `PUBLIC_ORIGIN=https://hub.example.com` 和 `COOKIE_SECURE=true`；前者将该工作台入口加入允许来源。这个配置不提供通用域名下的原页面代理；完整原页面的单端口访问仍以 SSH 和 `.localhost` 为支持方式。HTTPS 入口可使用 `direct` 项目链接，详情见 [部署说明](docs/deployment.md)。

## 本地开发和验证

要求 Node.js 24.15.0+；Linux 安装器复用 24.x，CI 使用 Node 24。无需数据库服务。

```bash
npm ci
npm run check
npm test
npm run build
npm start
```

生产启动默认地址为 [http://127.0.0.1:3100](http://127.0.0.1:3100)。完整原页面代理请先构建，再通过 3100 验证。仅开发工作台界面时，在后端环境设置 `PUBLIC_ORIGIN=http://127.0.0.1:5173`，然后在两个终端分别运行 `npm run dev:server` 和 `npm run dev`；Vite 位于 [http://127.0.0.1:5173](http://127.0.0.1:5173)，代理摘要和管理接口到后端。Vite 预览不提供原项目页面代理。开发数据默认放在未提交的 `.data/`。

GitHub Actions 在 Windows（Node 24.x）、Ubuntu（Node 24.15.0 和 24.x）分别执行类型检查、行为测试和构建；另一个 Ubuntu job 检查安装脚本语法、原子切换、清理边界、程序回滚及端口配置冲突后的恢复。测试使用模拟上游，不等于连接了你的 Linux 服务器或真实交易账户。是否真实连通，以部署后页面的状态和源数据时间为准。本项目不使用 WSL 验证。
