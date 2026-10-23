# 构建缓存与 CI 验证

构建统一使用根目录固定的 Node、pnpm 版本和 `pnpm-lock.yaml`。依赖版本由
`pnpm-workspace.yaml` 的 catalog 管理，安装继续使用 `pnpm install --frozen-lockfile`。
编译器迁移需要单独验证配置、依赖锁及正式包，不通过批量替换包名实现。

## 当前有效的加速路径

- 根项目和 Crossex 的 TypeScript 检查将增量信息保存在各自
  `.build-cache/.tsbuildinfo`。重复检查可以复用结果，源码变化仍执行类型验证；
  缓存缺失时正常进行完整检查。它不等同于跨 GitHub Actions 运行的产物缓存。
- CI 用 `INSTALL_TEST_LANE` 把 `deploy/test-workspace.sh` 分到两台 runner，两边都走真实
  冻结安装和模块生产构建：`behavior` 运行前端检查与根行为测试，`package` 组装、打包并验收
  发布包；本地默认 `all` 两者都跑。夹具内按依赖并行：Python 环境准备、前端检查和四个模块
  各自的构建同时运行；根行为测试在另一份固定 Git 提取中运行，模块产物从已校验缓存恢复
  （与开启 `PROJECT_DEPLOY_TESTS=1` 的升级相同）。组装完成后，源码发布目录检查和跨目录
  复用检查与打包同时进行，解包发布包检查在打包后立即开始。
  `deploy/workspace-test-jobs.sh` 负责传播失败和取消时清理进程组。
- 夹具通过 `INSTALL_TEST_PNPM_STORE` 复用 actions/cache 恢复的 pnpm 内容 store，只省去包下载；
  生产安装器仍执行冻结复制安装和生命周期脚本，并关闭 side-effects 缓存，依赖构建钩子照常执行。
- 夹具通过 `INSTALL_TEST_MODULE_CACHE` 导入 actions/cache 恢复的上次模块产物：仅导入目录名中
  内容键与本次输入键一致的模块，经 `build-artifact-cache.py` 完整校验后重新存入 root 所有的
  缓存，校验失败即丢弃并正常构建。因此输入未变的模块在 CI 中不再编译，任一构建输入变化的
  模块照常构建并验证；`package` 作业在有模块重建时导出当前四个缓存（`INSTALL_TEST_MODULE_CACHE_EXPORT=1`），
  按提交另存一份。是否命中以日志中的 `Imported the verified … build` 为准。
- 改动只涉及 `docs/` 下的 md/txt/rst 或根目录 `*.md` 时，Checks 不运行，改由 `docs.yml`
  运行同一审查门禁；`NOTICE.md`、`THIRD_PARTY_NOTICES.md` 和 `modules/` 下的文件会进入发布包，
  不算文档。这类提交没有候选版，也就不能提升为正式版，下一次代码提交照常全量检查和发布。
  GitHub 的路径过滤只看前 300 个改动文件，只有前 300 个全是文档时才可能漏跑，同样无法发布。
- ASTER Python 单元测试由 `deploy/test-aster-python.sh` 在独立 CI 作业中运行：从 HEAD 的固定
  Git 归档为每个分片提取独立源码树，按原四组运行，其中交易组按模块分片并发，最后汇总测试数。
  `tests/` 下其余模块自动归入 discovered 组并分片运行，新增测试文件无需登记。CI 用
  `ASTER_TEST_PART` 把 listed、discovered 两部分分到两台 runner，每部分都校验每个模块恰好属于一处。
- Monitor、Crossex、Asset 的 Node 测试和 Greeks、Asset 的 Python 测试不需要构建产物，由
  `deploy/test-module-units.sh` 在 `module-units` 作业中并发运行，参数与各模块 `package.json`
  的 test 脚本一致。
- `deploy/test-exclusions.txt` 列出暂未通过、因此不运行的测试文件及原因；修好后删掉对应行即可
  接入，条目对应的文件不存在时检查失败。
  模块选择与增量类型检查、安装器两组检查也拆成并行作业，`release` 等待全部作业通过。
- `actions/setup-python` 按两份 `requirements.lock` 缓存 pip 下载。CI 将
  `python -m pip cache dir` 的结果作为 `INSTALL_TEST_PIP_CACHE` 传给工作区检查，
  两个虚拟环境均显式使用该目录，继续验证锁文件中的哈希。未指定路径时使用
  原有构建账号 HOME 下的 `.cache/pip`。
- 源码安装沿用安装器的输入键、校验记录和完整模块产物缓存。无变化时跳过对应工作，
  新临时目录也能恢复已验证的模块产物；无需增加一个绕开此入口的全量并行构建脚本。

## 服务器源码更新

CI 的 pip 下载缓存与 TypeScript 的重复检查缓存不等于服务器更新加速。更新页面中的
“运行环境准备”还包括内置模块与 Node 生产依赖的组装，“解包与发布目录准备”包括
源码提取、产物恢复和发布目录复制。

源码安装将已验证的生产 Node 依赖独立保存在固定输入键的只读目录。工作台根目录及
Monitor、Asset、Crossex 的 `node_modules` 指向同一生产缓存中的对应位置，保留共享包、
局部版本和 peer 依赖的原有解析关系。模块代码变化时不重新整理或复制整套依赖；
锁文件、依赖清单、运行环境或依赖组装规则变化时才建立新缓存。旧发布始终引用原缓存，
不因更新而改指向新依赖，也不删除旧版本回滚需要的依赖。

默认更新仅在实际需要编译或检查时创建构建工作区。命中的模块缓存不再先恢复到无人
使用的可写构建目录，而是在可信运行目录中恢复并完成完整校验。开启部署行为测试时，
仍为测试恢复所有必要产物。内置模块组装不再复制随后会被丢弃的主站页面和服务源码。

Aster 前端的构建键覆盖 dashboard、环境文件及原有公共构建输入。仅修改 Python 运行代码或模块根文档不会触发前端编译；修改
dashboard 仍需重建。因此包含新界面的版本仍可能在更新时花费十几秒构建 Aster。

服务器安装器直接在各模块目录执行其 `pnpm run build`，Asset 先执行 `pnpm run prepare`。
本地多模块调度器 `scripts/modules.mjs` 不再是服务器编译输入；为 Monitor/Crossex 添加
导航依赖等局部调度改动，不会连带使 Asset/Aster 的产物失效。模块实际源码、构建脚本、
共享源码、依赖和环境继续参与缓存键，安装器的实际构建命令及目录映射也会自动参与。

新键可按需接收已审计旧调度器产生的缓存：使用当前源码、依赖和环境重算精确的旧键，
完整校验旧产物后另存为新缓存，保留原目录。未知调度器、不同构建规则、错误旧键或损坏
产物均不会迁移，而是正常构建；不会仅凭目录名或成功标记复用。更新缓存规则不要求
所有模块重新编译，旧运行时组装仍只在输入变化时更新。

首次升级到 `c00f651` 引入的独立生产依赖布局时需要建立缓存；已有该缓存的更新直接复用。
这里减少的是重复工作，不承诺固定总耗时；下载、必要编译、磁盘速度及服务就绪仍会
影响服务器实测。正式 CI 发布包继续包含独立的生产依赖，不依赖服务器上的缓存链接。

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
