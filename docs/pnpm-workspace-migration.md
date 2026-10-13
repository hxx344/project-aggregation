# pnpm Workspace 迁移与维护

本仓库使用一个 pnpm workspace 管理工作台及 `modules/monitor`、`modules/asset`、`modules/crossex`。Greeks 继续使用已有 Python 锁文件和虚拟环境。内置模块随工作台统一构建、打包和发布。

## 依赖布局

- `package.json` 的 `packageManager` 固定为 `pnpm@11.25.0`；CI 与源码安装器使用同一版本。
- `pnpm-workspace.yaml` 声明三个模块，并用 catalog 集中管理 React、图表库、TypeScript、Vite 等共享版本。
- 每个模块继续显式声明实际使用的依赖，版本引用 `catalog:`。相同解析结果由 pnpm 的内容存储和根虚拟存储去重；模块 `node_modules` 主要是链接，不表示重复下载完整依赖。
- `pnpm-lock.yaml` 是唯一 Node 锁文件，必须提交。原有四份 `package-lock.json` 已移除，不应重新生成。
- Native/build 生命周期只允许 workspace `allowBuilds` 中列出的包运行；新增需要安装脚本的依赖时同步核对该名单。

原方案中的“从模块删除所有共享依赖声明”没有采用：模块构建工具及生产依赖解析需要显式依赖，去重由 pnpm 完成。Asset 的 Next.js、主题与组件库、CrossEx 的 WebSocket 等原有依赖均保留；迁移不切换 Next 的运行模式。

## 本地安装与构建

使用 Node.js 24.15+，在仓库根目录执行：

```bash
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm run build:all
```

首次从 npm 工作树迁移时，如果 pnpm 提示旧依赖目录冲突，只移除仓库根和三个 Node 模块的 `node_modules` 后重试；不删除 `.env`、配置、导入账本或数据目录。干净检出无需此步骤。

`pnpm run install:modules` 保留为兼容入口，在根目录执行一次 frozen workspace 安装。常规流程不需要先 `pnpm install` 再调用它。

```bash
pnpm run build          # 工作台类型检查与构建
pnpm run build:modules  # 按缓存增量构建三个 Node 模块
pnpm run check
pnpm test
```

完整集成测试前还须按 README 配置 Greeks Python 环境。开发时使用 `pnpm run dev:server` 与 `pnpm run dev`；实际模块入口仍由工作台管理。

## 构建缓存

`scripts/modules.mjs` 保留逐模块缓存，不使用无条件递归构建替代。缓存 key 包含模块源码、根及各模块 manifest、统一锁文件、workspace 配置、包管理器与 Node/平台架构、构建脚本、公开构建环境及环境文件。

模块源码变化仅重建该模块；共享依赖或构建环境变化会使相关缓存失效。缺少必要构建标记或标记内容变化时重新构建。Asset 构建前幂等准备示例账本，不覆盖已有个人导入。

## CI 与发布包

GitHub Actions 先安装固定 pnpm 并执行 `pnpm install --frozen-lockfile`，随后在 Ubuntu x64 上验收服务账号构建与安装器。依赖缓存冻结为 root 只读；每个 importer 使用可写 `node_modules` 外壳，使 Vite/Next 临时文件与共享包内容分离。该受控环境禁止 pnpm 在运行脚本前隐式重装，依赖安装只发生在显式 frozen 准备步骤。

打包器从锁定安装图提取生产依赖，处理当前平台可选依赖、peer、版本冲突与依赖循环；发布包不包含 pnpm 的外部链接，也不需要开发机或 CI 缓存才能运行。打包后从工作台实际入口验证四个模块页面、静态资源与汇总接口。

默认 Linux 一键更新继续下载验证后的正式包，保留配置和数据，不安装 pnpm、不编译前端。显式源码部署才自动准备固定 pnpm，并以完整 workspace 依赖输入缓存安装结果。重复执行复用有效依赖、构建和检查结果。

## 依赖更新

共享版本在 `pnpm-workspace.yaml` 的 catalog 中修改；模块独有依赖保留在其 manifest 中。修改后在根执行 `pnpm install` 更新锁文件，核对差异并运行受影响构建与测试；CI 和部署继续使用 frozen 安装。

不要把 `pnpm-lock.yaml` 加入 `.gitignore`，不要混用 npm/yarn 更新本仓依赖。若需要回退迁移，应完整回退依赖声明、锁文件、构建和部署脚本到同一已验证提交；服务器可使用已有发布回滚机制，不需现场重建 npm 树。

## 验证口径

- `tests/pnpm-workspace.test.mjs` 验证共享包物理解析一致、单次 workspace 安装和模块缓存失效行为。
- `deploy/test-package-layout.py` 验证生产闭包、依赖布局和链接边界。
- `deploy/test-inputs.sh`、`deploy/test-incremental.sh` 验证输入分类、无变化复用和恢复。
- `deploy/test-workspace.sh` 验证 Linux 非 root 构建、冻结依赖以及真实发布包启动。
- Windows 使用原生工具；Linux 权限、systemd 与部署验收使用 GitHub Actions，不使用 WSL。

磁盘与耗时收益取决于原有 npm 树、pnpm store 缓存和构建状态。原提案的空间节省与加速百分比是估算，不作为已验证收益。

参考：[pnpm workspace](https://pnpm.io/workspaces)、[catalog](https://pnpm.io/catalogs)。
