# Project Aggregation

统一交易与资产工作台：保留原生交易功能，内置 Market Monitor、Asset Ledger、Gate CrossEx、Greeks 和 ASTER。业务源码位于本仓库的 `modules/`；全部页面沿用工作台登录，只有工作台默认 `3100` 一个 TCP 入口。

Entropy / Lighter 行情研究也已内置，统一更新后从侧栏 **监控 → Entropy / Lighter** 打开；支持持续采集、启动停止、配置、报告和图表，默认只采集公开行情。工具随工作台运行时管理，关闭页面或单独重启 API 不会中断采集。详见 [研究工具说明](docs/entropy-lighter-lab.md)。

Aerodrome 单边 LP 自动调仓从侧栏 **交易 → Aero LP** 打开：在页面填写钱包私钥（加密保存、只显示地址）和调仓参数，保存后立即生效；随工作台运行时管理，默认停止。详见 [工具说明](tools/aero-lp/README.md)。

市场监控的合约价差、资金费机会可在列表或详情点击 **导入 CrossEx**，直接打开 Gate CrossEx 的「跨所对冲」，填入精确多空合约并清空数量。需从工作台内打开，目标合约不在最新目录时会提示原因，不会替换成其它合约；填写数量后仍须手动预览与确认。

CrossEx 内的资金费机会入口：**Gate CrossEx → 跨所对冲 → 开仓区域下方的 Monitor 机会 → 资金费机会**，可切换回价差机会。优先列出可参考机会，再按 8h 等效费率差从高到低排列；保留两腿原始费率、结算周期、下次结算时间和独立的开仓毛价差；等效费差不是下一次结算净收入。缺失周期不默认 8h，数据过期或缺少启用的现货/充提筛选证据时禁止一键填入。选择机会只预填精确合约和多空方向、清空数量，仍须手动预览与确认。内置模块随本工作台统一发布，更新独立 CrossEx 仓库不会改变此页面。

## 一键安装与升级

当前正式发布针对 Ubuntu 24.04 LTS（x64 / x86_64，systemd）构建并验收。在该服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash
```

重复执行会增量升级，保留已有配置与数据。默认拉取通过 CI 的正式版本源码，在服务器按需构建；网页“系统更新”可选择源码构建或下载 CI 已构建运行包，两种方式均锁定所选正式提交。更新面板显示当前阶段、可测量的进度、下载量和速度。依赖、工作台前端及各模块产物分别缓存，无变化时跳过安装、构建和重启。自动准备 Node.js 24.15+ 及 Greeks、ASTER 的独立 Python 3.11+ 锁定依赖。当前正式发布与部署验收针对 x64；命令行可用 `PROJECT_DEPLOY_MODE=ci` 选择预构建包。

首次从独立服务升级时，会停止旧服务并复制配置、数据库与密钥到工作台数据目录，旧文件保留；启动失败会恢复旧服务。已迁移四模块的工作台会补迁移 ASTER，失败仅恢复本次涉及的旧服务；独立 Variational 继续暂停使用，数据不删除。原生交易模块继续保留。详见 [部署与迁移说明](docs/deployment.md)。

## 本地开发

使用 Node.js 24.15+、pnpm 11.25.0、Python 3.11+：

Windows 构建 ASTER dashboard 推荐 Node.js 24.20+；本任务已用 24.21.0 验证。24.15/24.19 在 vinext 构建结束时会触发 libuv 退出断言。Linux CI 与服务器继续使用已验收的 24.15.0 基线。

```bash
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm run build:all
python -m venv .venv
python -m venv .venv-aster
# Windows 使用 Scripts/python.exe；Linux/macOS 使用 bin/python
.venv/Scripts/python.exe -m pip install --require-hashes -r modules/greeks/requirements.lock
.venv-aster/Scripts/python.exe -m pip install --require-hashes -r modules/aster/requirements.lock
```

将 `GREEKS_PYTHON`、`ASTER_PYTHON` 分别设置为对应虚拟环境 Python 的绝对路径后运行 `pnpm start`。开发工作台前端可额外运行 `pnpm run dev`。一次安装覆盖根目录与四个 Node workspace（含 ASTER dashboard），共享版本由 workspace catalog 维护，`pnpm-lock.yaml` 提交到仓库。模块构建按源码、workspace 依赖和构建环境缓存，无变化时跳过。详见 [pnpm workspace 说明](docs/pnpm-workspace-migration.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `src/` | 工作台前端与原生交易页面 |
| `server/` | 工作台 API、交易执行、内置模块管理 |
| `modules/monitor/` | Market Monitor 业务源码 |
| `modules/asset/` | Asset Ledger Next.js 页面与 API |
| `modules/crossex/` | Gate CrossEx 页面与服务 |
| `modules/greeks/` | Greeks Python 业务及页面 |
| `modules/aster/` | ASTER Python 交易引擎与静态 dashboard |
| `tools/entropy-lighter-lab/` | 内置 Entropy / Lighter 行情采集与纸面模拟 |
| `tools/aero-lp/` | 内置 Aerodrome 单边 LP 调仓（`server/automation/aero-lp.mjs` 管理进程） |
| `deploy/` | 统一安装、迁移、打包与发布检查 |
| `tests/` | 行为、集成及浏览器检查 |

## 检查与文档

Entropy / Lighter 的 SNDK、ANTH 研究使用[工作台内置工具](docs/entropy-lighter-lab.md)，含延迟情景和返佣分账；纸面模拟需先核验合约并填写实付费率，ANTH 默认未核验。曾安装独立服务的用户先停止旧服务，避免重复采集；工作台不自动迁移其数据。

`pnpm run check` 执行工作台类型检查，`pnpm test` 运行 Node 行为测试；模块集成测试需要先完成 workspace 安装与模块构建，并配置 Greeks 与 ASTER 的独立 Python 环境。Linux 安装、systemd 恢复与 x64 部署包验收由 GitHub Actions 执行。

- [部署与迁移](docs/deployment.md)
- [Gate 资产连接](docs/gate-assets.md)
- [本地路由配置](docs/local-route.md)
- [协作规则](AGENTS.md)、[经验记录](LESSONS.md)、[代码规范](docs/code-standards.md)
- [文件组织](docs/FILE_ORGANIZATION.md)

## License

工作台原有代码沿用 MIT。内置 Gate CrossEx 保留 [AGPL-3.0-only](modules/crossex/LICENSE) 和 [第三方声明](modules/crossex/THIRD_PARTY_NOTICES.md)；各模块的来源与固定提交记录在对应的 `SOURCE.json` 中。
