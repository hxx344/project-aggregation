# Project Aggregation

统一交易与资产工作台：保留原生交易功能，内置 Market Monitor、Asset Ledger、Gate CrossEx 和 Greeks。业务源码位于本仓库的 `modules/`；全部页面沿用工作台登录，只有工作台默认 `3100` 一个 TCP 入口。

资金费机会入口：**Gate CrossEx → 跨所对冲 → 开仓区域下方的 Monitor 机会 → 资金费机会**，可切换回价差机会。优先列出可参考机会，再按 8h 等效费率差从高到低排列；保留两腿原始费率、结算周期、下次结算时间和独立的开仓毛价差；等效费差不是下一次结算净收入。缺失周期不默认 8h，数据过期或缺少启用的现货/充提筛选证据时禁止一键填入。选择机会只预填精确合约和多空方向、清空数量，仍须手动预览与确认。内置模块随本工作台统一发布，更新独立 CrossEx 仓库不会改变此页面。

## 一键安装与升级

当前正式发布针对 Ubuntu 24.04 LTS（x64 / x86_64，systemd）构建并验收。在该服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash
```

重复执行会增量升级，保留已有配置与数据。安装器使用 GitHub 已验证的 x64 正式发布包；自动准备 Node.js 24.15+ 和 Greeks 的 Python 3.11+ 锁定依赖，不在服务器编译前端。当前 CI 不构建或发布 ARM64 包。

首次从独立服务升级时，会停止旧服务并复制配置、数据库与密钥到工作台数据目录，旧文件保留；启动失败会恢复旧服务。ASTER 和独立 Variational 暂停使用，数据不删除。原生交易模块继续保留。详见 [部署与迁移说明](docs/deployment.md)。

## 本地开发

使用 Node.js 24.15+、pnpm 11.25.0、Python 3.11+：

```bash
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm run build:all
python -m venv .venv
# Windows 使用 .venv/Scripts/python.exe；Linux/macOS 使用 .venv/bin/python
.venv/Scripts/python.exe -m pip install --require-hashes -r modules/greeks/requirements.lock
```

将 `GREEKS_PYTHON` 设置为虚拟环境 Python 的绝对路径后运行 `pnpm start`。开发工作台前端可额外运行 `pnpm run dev`。一次安装覆盖根目录与三个 Node 模块，共享版本由 workspace catalog 维护，`pnpm-lock.yaml` 提交到仓库。模块构建按源码、workspace 依赖和构建环境缓存，无变化时跳过。详见 [pnpm workspace 说明](docs/pnpm-workspace-migration.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `src/` | 工作台前端与原生交易页面 |
| `server/` | 工作台 API、交易执行、内置模块管理 |
| `modules/monitor/` | Market Monitor 业务源码 |
| `modules/asset/` | Asset Ledger Next.js 页面与 API |
| `modules/crossex/` | Gate CrossEx 页面与服务 |
| `modules/greeks/` | Greeks Python 业务及页面 |
| `deploy/` | 统一安装、迁移、打包与发布检查 |
| `tests/` | 行为、集成及浏览器检查 |

## 检查与文档

`pnpm run check` 执行工作台类型检查，`pnpm test` 运行 Node 行为测试；模块集成测试需要先完成 workspace 安装与模块构建，并配置 Greeks Python 环境。Linux 安装、systemd 恢复与 x64 部署包验收由 GitHub Actions 执行。

- [部署与迁移](docs/deployment.md)
- [Gate 资产连接](docs/gate-assets.md)
- [本地路由配置](docs/local-route.md)
- [协作规则](AGENTS.md)、[经验记录](LESSONS.md)、[代码规范](docs/code-standards.md)
- [文件组织](docs/FILE_ORGANIZATION.md)

## License

工作台原有代码沿用 MIT。内置 Gate CrossEx 保留 [AGPL-3.0-only](modules/crossex/LICENSE) 和 [第三方声明](modules/crossex/THIRD_PARTY_NOTICES.md)；各模块的来源与固定提交记录在对应的 `SOURCE.json` 中。
