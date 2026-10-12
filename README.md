# Project Aggregation

统一交易与资产工作台：保留原生交易功能，内置 Market Monitor、Asset Ledger、Gate CrossEx 和 Greeks。业务源码位于本仓库的 `modules/`；全部页面沿用工作台登录，只有工作台默认 `3100` 一个 TCP 入口。

## 一键安装与升级

在 Ubuntu 24.04 或 Debian 12/13（x64/arm64，systemd）执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash
```

重复执行会增量升级，保留已有配置与数据。安装器使用 GitHub 已验证的对应架构正式发布包；自动准备 Node.js 24.15+ 和 Greeks 的 Python 3.11+ 锁定依赖，不在服务器编译前端。

首次从独立服务升级时，会停止旧服务并复制配置、数据库与密钥到工作台数据目录，旧文件保留；启动失败会恢复旧服务。ASTER 和独立 Variational 暂停使用，数据不删除。原生交易模块继续保留。详见 [部署与迁移说明](docs/deployment.md)。

## 本地开发

使用 Node.js 24.15+、Python 3.11+：

```bash
npm ci
npm run install:modules
npm run build:all
python -m venv .venv
# Windows 使用 .venv/Scripts/python.exe；Linux/macOS 使用 .venv/bin/python
.venv/Scripts/python.exe -m pip install --require-hashes -r modules/greeks/requirements.lock
```

将 `GREEKS_PYTHON` 设置为虚拟环境 Python 的绝对路径后运行 `npm start`。开发工作台前端可额外运行 `npm run dev`。模块依赖和构建按源码、锁文件与 Node 环境缓存，无变化时跳过。

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

`npm run check` 执行工作台类型检查，`npm test` 运行 Node 行为测试；模块集成测试需要先完成模块依赖安装与构建，并配置 Greeks Python 环境。Linux 安装、systemd 恢复与 x64/arm64 部署包验收由 GitHub Actions 执行。

- [部署与迁移](docs/deployment.md)
- [本地路由配置](docs/local-route.md)
- [协作规则](AGENTS.md)、[经验记录](LESSONS.md)、[代码规范](docs/code-standards.md)
- [文件组织](docs/FILE_ORGANIZATION.md)

## License

工作台原有代码沿用 MIT。内置 Gate CrossEx 保留 [AGPL-3.0-only](modules/crossex/LICENSE) 和 [第三方声明](modules/crossex/THIRD_PARTY_NOTICES.md)；各模块的来源与固定提交记录在对应的 `SOURCE.json` 中。
