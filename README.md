# Project Aggregation

多资产聚合交易与资产管理平台。

## 快速开始

```bash
npm install
npm run dev
```

详见 [QUICK_START.md](QUICK_START.md)

## 项目结构

```
project_aggregation/
├── src/               # 前端源码
├── server/            # 后端服务
├── tests/             # 测试套件
├── docs/              # 项目文档
├── scripts/           # 辅助脚本
└── public/            # 静态资源
```

## 主要功能

- **资产管理**：Gate.io 资产同步与持仓分析
- **交易执行**：OKX/Bybit 合约交易与 PnL 追踪
- **跨交易所监控**：实时价差与套利机会识别
- **本地路由**：SSH 隧道与代理管理

## 文档导航

### 开发指南
- [快速开始](QUICK_START.md)
- [快速参考](QUICK_REFERENCE.md)
- [代码规范](docs/code-standards.md)
- [文件组织规范](docs/FILE_ORGANIZATION.md)

### 部署与集成
- [部署文档](docs/deployment.md)
- [集成说明](docs/integration.md)
- [本地路由配置](docs/local-route.md)

### AI 协作
- [协作规则](AGENTS.md) - 项目规则与文档入口
- [项目经验](LESSONS.md) - 已验证的开发经验
- [复盘流程](daily-review-prompt.md) - 增量复盘指南

### 优化指南
- [Codex 优化](CODEX_OPTIMIZATION_GUIDE.md)
- [README Codex](README_CODEX.md)

## 测试

```bash
# 运行所有测试
npm test

# 单元测试
npm run test:unit

# 浏览器测试
npm run test:browser
```

## 技术栈

- **前端**: React 18 + TypeScript + Vite
- **后端**: Node.js + better-sqlite3
- **测试**: Node.js Test Runner + Playwright
- **样式**: CSS Custom Properties + CSS Grid

## 环境要求

- Node.js >= 18
- npm >= 9

## License

MIT

---

更多信息请参阅 [docs/](docs/) 目录中的专题文档。
