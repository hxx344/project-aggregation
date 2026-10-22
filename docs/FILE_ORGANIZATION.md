# 文件组织规范

## 目录结构

```
project_aggregation/
├── docs/              # 项目文档
│   ├── archive/       # 已完成的临时分析和指南（gitignore，不跟踪）
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
- `AGENTS.md` - 项目规则与文档索引（代理执行协议唯一权威）
- `LESSONS.md` - 项目经验记录
- `daily-review-prompt.md` - 复盘流程
- `CONVENTIONS.md` - aider 入口，只引用 `AGENTS.md`
- `code-standards.md` - 代码规范兼容链接
- `package.json`, `tsconfig.json`, `vite.config.ts` 等配置文件

### 规则与审查文件职责

| 文件 | 维护内容 |
| --- | --- |
| `AGENTS.md` | 项目规则和阅读入口（代理执行协议唯一权威） |
| `LESSONS.md` | 项目经验、记录规则、适用边界和事件证据 |
| `docs/code-standards.md` | 满足升级条件的规范及其依据 |
| `docs/code-review-standard.md` | 合并前的审查范围、分级、严重级别与门槛 |
| `docs/code-review-checklist.md` | 逐项检查清单（唯一清单正文） |
| `docs/code-review-process.md` | 审查步骤、时限、轮次、热修、钩子与 CI 门禁、度量 |
| `daily-review-prompt.md` | 增量复盘、事件去重和检查点更新流程 |
| `docs/review-state.json` | 已完成检查点和未完成复盘的报告位置 |
| `.github/pull_request_template.md` | PR 自审与证据模板，只引用上述标准 |
| `scripts/review-gate.mjs`、`.githooks/` | 可机械判定的提交门禁：`pre-commit` 查内容、`commit-msg` 查证据，由 `scripts/install-hooks.mjs` 在安装时启用 |
| `CLAUDE.md`、`CONVENTIONS.md`、`.codebuddy/CODEBUDDY.md`、`.cursor/rules/`、`.cursorrules`、`.clinerules`、`.roo/rules/`、`.github/copilot-instructions.md`、`.github/instructions/` | 工具入口，只引用 `AGENTS.md`，不复制规则正文 |
| `.claude/commands/review.md`、`.codebuddy/commands/review.md` | 客户端只读审查命令，按权威流程输出意见 |

根目录 `code-standards.md` 仅保留兼容链接。权威文件路径变化时同步更新上述入口的引用。

### scripts/ 目录
运维和辅助脚本：
- `check-server.sh` - 服务器检查脚本
- `wait-and-release.sh` - 等待 CI 后触发正式发布并跟踪发布结果
- `ssh-tunnel-optimized.ps1` - SSH 隧道管理（目标服务器由参数或环境变量提供）
- `force-reinstall.sh`, `kill-all-processes.sh` - 停止工作台 systemd 服务与重新安装
- `local-route-helper.mjs`, `start-local-route.ps1`, `inspect-ssh-route.ps1` - 本地路由
- `benchmark-overview.mjs` - 性能基准测试

### deploy/ 目录
部署和安装脚本：
- `install.sh`, `install-all.sh` - 安装脚本
- 发布和测试相关脚本

### docs/ 目录
- **持久性技术文档**：`deployment.md`, `integration.md`, `local-route.md`
- **代码规范**：`code-standards.md`, `workspace-style.md`, `FILE_ORGANIZATION.md`
- **审查机制**：`code-review-standard.md`, `code-review-checklist.md`, `code-review-process.md`
- **专题指南**：特定时期的重要改动记录（带日期命名）
- **归档子目录**：`archive/` - 已完成的临时文档

### docs/archive/（gitignore）
- **临时分析报告**：`DIAGNOSIS.md`, `optimization-analysis.md`, `security-performance-audit.md`
- **进度追踪**：`improvements-completed.md`, `REFACTOR_PROGRESS.md`
- **已完成指南**：`*_COMPLETED.md`, `*_SUMMARY.md`, `*_GUIDE.md`（任务完成后的一次性文档）
- **对比记录**：`BEFORE_AFTER.md`, `VISUAL_COMPARISON.md`

归档时把文件移入该目录；已跟踪的文件同时执行 `git rm --cached`，内容保留在 git 历史中。`.gitignore` 只防止归档文件被重新加入。

### 自动忽略的临时文件（.gitignore）
- **HTML 预览**：`*-preview.html`, `diagnose-*.html`
- **临时 CSS**：`design-tokens.css`
- **输出目录**：`output/`, `dist/`
- **日志**：`*.log`
- **构建产物**：`.tsbuildinfo`, `*.tsbuildinfo`
- **数据目录**：`.data*/`

## 添加新文档的规则

1. **持久性文档** → 放入 `docs/`，使用清晰的名称
2. **临时分析** → 放在 `output/` 或 `docs/archive/`（均不跟踪）；已提交的临时文档完成后移入 `docs/archive/` 并 `git rm --cached`
3. **演示和预览** → 使用 `-preview.html` 或 `diagnose-*.html` 后缀，自动被 gitignore
4. **项目规则** → 更新 `AGENTS.md`, `LESSONS.md`, `docs/code-standards.md`

## 测试文件规范

- 所有测试文件放在 `tests/` 目录
- 命名约定：
  - 单元/集成测试：`*.test.mjs`
  - 浏览器测试：`*.browser.mjs`
  - 内置模块测试沿用各模块约定（如 `modules/*/tests/*.test.ts`、`*.smoke.mjs`），部署测试在 `deploy/test-*`
- 不要在根目录创建测试文件
- 测试报告输出到 `output/` 目录（已 gitignore）

## 脚本文件规范

- 脚本放在 `scripts/`（运维与本地辅助）或 `deploy/`（安装、发布与部署测试）。
- 根目录唯一例外是 `test-download-speed.sh`：CI 与 [发布镜像说明](release-mirror-setup.md) 把它作为兼容入口引用。

## 清理检查清单

在提交前检查：
- [ ] 根目录 `.md` 是否超出上面“根目录保留文件”列出的范围？
- [ ] 是否有 `*-preview.html` 或临时分析文档？
- [ ] 临时文件是否已添加到 `.gitignore`？
- [ ] 已完成的指南是否移到了 `docs/archive/`？
- [ ] 新增的脚本是否放在了合适的位置？

## 根目录文件控制目标

保持根目录简洁：
- **Markdown 文档**：仅限“根目录保留文件”列出的文档
- **脚本文件**：仅 `test-download-speed.sh` 兼容入口，其余在 scripts/ 或 deploy/
- **配置文件**：必需的项目配置（package.json, tsconfig.json 等）
- **临时文件**：0 个（通过 gitignore 自动排除）
