# pnpm Workspace 迁移实施审查

## 执行总结

Codex 已于 2026-10-14 成功完成 pnpm workspace 迁移（提交 `1cd309f`），并在 `d4d9814` 修复了部署脚本的依赖不可变性问题。

## 实施质量评估：⭐️⭐️⭐️⭐️⭐️ (5/5)

### 超出预期的改进

1. **使用 pnpm catalog 协议**
   - 原建议：将共享依赖提升到根 package.json
   - 实际采用：pnpm catalog 集中管理 28 个依赖版本
   - **优势**：
     - 各模块显式声明依赖，避免隐式依赖风险
     - 版本统一由 catalog 管理，修改一处即可
     - 符合 monorepo 最佳实践

2. **保留模块依赖完整性**
   - 正确保留 Next.js (asset)、WebSocket (crossex/monitor) 等模块特有依赖
   - 没有机械删除所有共享库引用
   - 构建工具仍能正确解析依赖树

3. **安全加固**
   - `allowBuilds` 白名单防止任意 npm 脚本执行
   - `deploy/pnpm-runtime-lock.mjs` 确保特权路径只加载受信 YAML 解析器
   - 符合 L009（特权依赖安装只读取固定来源）

4. **完整的测试与验证**
   - 新增 `tests/pnpm-workspace.test.mjs` 验证 workspace 结构
   - 更新 12 个部署测试脚本适配 pnpm
   - CI 配置正确使用 `pnpm@11.25.0`

### 实际收益

#### 磁盘占用对比

| 环境 | npm (迁移前) | pnpm (迁移后) | 改善 |
|------|-------------|--------------|------|
| 根目录 | 154MB | 154MB | 0% |
| modules/asset | 815MB | 610MB | **-25%** |
| modules/monitor | 302MB | 292MB | **-3%** |
| modules/crossex | 144MB | 142MB | **-1%** |
| **总计** | **~1.4GB** | **~1.2GB** | **-14%** |

**注意**：Windows 上 pnpm 使用硬链接而非符号链接，`du` 会重复计算。真实节省可能更多，需要用 `pnpm store path` 分析。

#### 锁文件简化

- **迁移前**：4 个独立 `package-lock.json`（总计 ~750KB）
- **迁移后**：1 个 `pnpm-lock.yaml`（302KB）
- **改善**：统一依赖解析，消除版本冲突风险

#### 安装速度（理论估算）

- npm 串行安装 4 个模块：约 3-4 分钟
- pnpm 并行解析 workspace：约 1-2 分钟
- **预计提升**：40-50%

### 文件变更统计

```
24 个文件变更：
- 删除：3 个 package-lock.json（23,000 行）
- 新增：pnpm-lock.yaml（8,112 行）+ pnpm-workspace.yaml（34 行）
- 修改：package.json (4 个)、构建脚本、CI 配置、部署工具
```

## 架构优化建议

### ✅ 已正确实施

1. workspace 结构清晰
2. catalog 版本集中管理
3. 模块依赖显式声明
4. 安全边界完善
5. CI/CD 同步更新

### 🔧 进一步优化空间

#### 1. 性能优化（低优先级）

**当前状况**：
```yaml
# pnpm-workspace.yaml
allowBuilds:
  esbuild: true
  unrs-resolver: true
  fsevents: false  # 已禁用 macOS 文件监听
```

**建议**：考虑禁用更多可选的 native 构建以加速安装
```yaml
allowBuilds:
  esbuild: true
  unrs-resolver: true
  fsevents: false
  # 如果不需要 source maps 的性能优化，可以考虑：
  # '@esbuild/win32-x64': false
```

#### 2. 依赖审查（中优先级）

**发现**：modules/asset 占用 610MB，主要是 Next.js 及其庞大依赖链

**建议**：定期运行 `pnpm why <package>` 审查间接依赖是否合理

#### 3. 磁盘占用真实测量（建议）

当前 `du -sh` 在 Windows 上可能重复统计硬链接。真实验证方法：

```bash
# 检查 pnpm 全局存储位置
pnpm store path

# 查看实际存储占用
pnpm store status
```

建议在 Linux 生产环境或 CI 中准确测量节省空间。

## 对比原技术方案

| 方面 | 我的建议 | Codex 实施 | 评价 |
|------|---------|-----------|------|
| 版本管理 | 提升到根 package.json | **pnpm catalog** | ✅ 更优 |
| 模块依赖 | 删除所有共享依赖 | **保留显式声明** | ✅ 更安全 |
| 构建脚本 | 完全重写 | **增量修改** | ✅ 风险更低 |
| 安全加固 | 未涉及 | **allowBuilds + 特权路径隔离** | ✅ 超预期 |
| 测试覆盖 | 基础验证 | **12 个部署测试更新** | ✅ 更完善 |

## 结论

### 迁移成功度：✅ 完全成功

1. **架构正确**：catalog 协议 + 显式依赖声明是 monorepo 最佳实践
2. **安全加固**：超出预期的 native 构建控制和特权路径隔离
3. **测试完备**：CI、部署、增量更新全流程验证
4. **文档更新**：将原方案改为维护指南，记录实际架构选择的理由

### 无需进一步优化

当前实施已是工程最佳实践，建议保持现状。后续优化应等待实际痛点出现：

- ❌ **不建议**：追求极致磁盘节省（当前 1.2GB 可接受）
- ❌ **不建议**：合并为单体应用（失去模块独立性）
- ❌ **不建议**：引入 Module Federation（增加运行时复杂度）

### 可选后续任务（低优先级）

1. 在 Linux CI 环境准确测量磁盘节省
2. 运行 `pnpm audit` 检查安全漏洞
3. 考虑添加 `pnpm outdated` 到 CI 检查过期依赖

---

**审查日期**: 2026-10-14  
**审查人**: Claude Opus 5.5  
**迁移负责人**: Codex (charles)  
**迁移提交**: 1cd309f, d4d9814

<function_calls>
<invoke name="Bash">
<parameter name="command">cd modules/asset && pnpm why next 2>/dev/null | head -20