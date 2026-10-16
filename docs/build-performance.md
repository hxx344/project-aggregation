# 构建缓存与 CI 验证

构建统一使用根目录固定的 Node、pnpm 版本和 `pnpm-lock.yaml`。依赖版本由
`pnpm-workspace.yaml` 的 catalog 管理，安装继续使用 `pnpm install --frozen-lockfile`。
编译器迁移需要单独验证配置、依赖锁及正式包，不通过批量替换包名实现。

## 当前有效的加速路径

- 根项目和 Crossex 的 TypeScript 检查将增量信息保存在各自
  `.build-cache/.tsbuildinfo`。重复检查可以复用结果，源码变化仍执行类型验证；
  缓存缺失时正常进行完整检查。它不等同于跨 GitHub Actions 运行的产物缓存。
- CI 的 `deploy/test-workspace.sh` 保留 Python 准备/测试与前端检查/构建两个独立任务。
  `deploy/workspace-test-jobs.sh` 负责传播失败和取消时清理进程组。
- `actions/setup-python` 按两份 `requirements.lock` 缓存 pip 下载。CI 将
  `python -m pip cache dir` 的结果作为 `INSTALL_TEST_PIP_CACHE` 传给工作区检查，
  两个虚拟环境均显式使用该目录，继续验证锁文件中的哈希。未指定路径时使用
  原有构建账号 HOME 下的 `.cache/pip`。
- 源码安装沿用安装器的输入键、校验记录和完整模块产物缓存。无变化时跳过对应工作，
  新临时目录也能恢复已验证的模块产物；无需增加一个绕开此入口的全量并行构建脚本。

CI 从固定 Git 对象建立临时源码目录，服务账号也使用独立 HOME。在 checkout 中恢复
TypeScript 或 Vite 缓存并不会自动进入该构建目录。不要将缓存 action 成功等同于
编译器实际命中缓存。

发布打包器已排除 Python 字节码、测试与构建缓存；无需先在 checkout 中递归删除文件。
产物仍使用现有 gzip 格式和清单协议，经解包与运行检查后才能发布。

## 检查入口

```sh
pnpm install --frozen-lockfile
node --test deploy/test-module-builds.mjs deploy/test-typecheck-cache.mjs
```

增量类型回归在隔离目录中运行冷检查、热检查、添加类型错误和修复错误四个阶段，
输出实际耗时而不设机器相关的速度阈值。Linux CI 进一步验证服务账号权限、不可变依赖、
模块缓存迁移、正式包完整性和运行入口；Windows 结果不能代替这些平台检查。

工作区可能保留旧优化草案（如 `apply-ci-optimizations.sh`、`build-parallel.mjs` 和
`CODEX-EXECUTE-THIS.md`）。这些草案不属于发布入口；旧的整文件替换模板会丢失已有检查，
不得用于更新当前 CI。性能结论以实际阶段耗时和缓存日志为依据，不采用草案中的预估比例。
