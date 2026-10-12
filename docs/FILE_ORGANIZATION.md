# 文件组织规范

## 目录结构

```
project_aggregation/
├── docs/              # 项目文档
│   ├── archive/       # 已完成的临时分析和指南（不出现在工作树）
│   ├── code-standards.md
│   ├── deployment.md
│   └── ...
├── src/               # 前端源码
├── server/            # 后端源码
├── tests/             # 测试文件
├── scripts/           # 辅助脚本
├── public/            # 静态资源
└── output/            # 临时输出（gitignore）
```

## 文档类型与存放位置

### 根目录保留文件
- `README.md` - 项目主文档
- `CLAUDE.md` - AI 协作入口
- `AGENTS.md` - 项目规则与文档索引
- `LESSONS.md` - 项目经验记录
- `daily-review-prompt.md` - 复盘流程
- `code-standards.md` - 代码规范兼容链接
- `package.json`, `tsconfig.json`, `vite.config.ts` 等配置文件

### scripts/ 目录
运维和辅助脚本：
- `check-server.sh` - 服务器检查脚本
- `wait-and-release.sh` - 等待和释放脚本
- `ssh-tunnel-optimized.ps1` - SSH 隧道管理
- `local-route-helper.mjs`, `start-local-route.ps1` - 本地路由
- `benchmark-overview.mjs` - 性能基准测试

### deploy/ 目录
部署和安装脚本：
- `install.sh`, `install-all.sh` - 安装脚本
- 发布和测试相关脚本

### docs/ 目录
- **持久性技术文档**：`deployment.md`, `integration.md`, `local-route.md`
- **代码规范**：`code-standards.md`, `workspace-style.md`, `FILE_ORGANIZATION.md`
- **专题指南**：特定时期的重要改动记录（带日期命名）
- **归档子目录**：`archive/` - 已完成的临时文档

### docs/archive/（gitignore）
- **临时分析报告**：`DIAGNOSIS.md`, `optimization-analysis.md`, `security-performance-audit.md`
- **进度追踪**：`improvements-completed.md`, `REFACTOR_PROGRESS.md`
- **已完成指南**：`*_COMPLETED.md`, `*_SUMMARY.md`, `*_GUIDE.md`（任务完成后的一次性文档）
- **对比记录**：`BEFORE_AFTER.md`, `VISUAL_COMPARISON.md`

这些文件保留在 git 历史中，但通过 `.gitignore` 从工作树中移除。

### 自动忽略的临时文件（.gitignore）
- **HTML 预览**：`*-preview.html`, `diagnose-*.html`
- **临时 CSS**：`design-tokens.css`
- **输出目录**：`output/`, `dist/`
- **日志**：`*.log`
- **构建产物**：`.tsbuildinfo`, `*.tsbuildinfo`
- **数据目录**：`.data*/`

## 添加新文档的规则

1. **持久性文档** → 放入 `docs/`，使用清晰的名称
2. **临时分析** → 直接创建在根目录，完成后移入 `docs/archive/` 并提交一次，之后通过 gitignore 从工作树移除
3. **演示和预览** → 使用 `-preview.html` 或 `diagnose-*.html` 后缀，自动被 gitignore
4. **项目规则** → 更新 `AGENTS.md`, `LESSONS.md`, `docs/code-standards.md`

## 测试文件规范

- 所有测试文件放在 `tests/` 目录
- 命名约定：
  - 单元/集成测试：`*.test.mjs`
  - 浏览器测试：`*.browser.mjs`
- 不要在根目录创建测试文件
- 测试报告输出到 `output/` 目录（已 gitignore）

## 脚本文件规范

- **根目录脚本**：仅保留常用的顶层命令脚本
  - 服务器管理：`check-server.sh`, `wait-and-release.sh`
  - 环境设置：`install.sh`, `install-all.sh`
  - SSH 管理：`ssh-tunnel-optimized.ps1`

- **scripts/ 目录**：放置专用或较大的辅助脚本
  - 本地路由：`local-route-helper.mjs`, `start-local-route.ps1`, `inspect-ssh-route.ps1`
  - 性能分析：`benchmark-overview.mjs`

## 清理检查清单

在提交前检查：
- [ ] 根目录是否有超过 10 个 `.md` 文件？
- [ ] 是否有 `*-preview.html` 或临时分析文档？
- [ ] 临时文件是否已添加到 `.gitignore`？
- [ ] 已完成的指南是否移到了 `docs/archive/`？
- [ ] 新增的脚本是否放在了合适的位置？

## 根目录文件控制目标

保持根目录简洁：
- **Markdown 文档**：≤ 6 个（核心文档）
- **脚本文件**：0 个（全部在 scripts/ 或 deploy/）
- **配置文件**：必需的项目配置（package.json, tsconfig.json 等）
- **临时文件**：0 个（通过 gitignore 自动排除）
