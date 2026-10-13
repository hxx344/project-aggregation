# pnpm Workspace 迁移技术实现文档

## 目标

将 project-aggregation 从 npm 独立模块架构迁移到 pnpm workspace，消除依赖重复，减少磁盘占用约 800MB，加速安装和构建流程。

## 当前问题

- 4 个独立 node_modules 目录（主仓库 + 3 个模块）
- React、react-dom、recharts、lucide-react 等在 4 处重复安装
- 总磁盘占用约 1.4GB
- 构建脚本需要串行安装每个模块的依赖

## 架构变更

### 依赖层级

```
project-aggregation/
├── node_modules/          # 共享依赖（由 pnpm 管理）
│   ├── react@19.2.6
│   ├── react-dom@19.2.6
│   ├── recharts@3.8.0
│   └── lucide-react@1.31.0
├── modules/
│   ├── monitor/
│   │   └── node_modules/  # 仅模块特有依赖
│   ├── asset/
│   │   └── node_modules/  # 仅模块特有依赖
│   └── crossex/
│       └── node_modules/  # 仅模块特有依赖
└── package.json           # 声明共享依赖
```

## 实施步骤

### 第一步：创建 pnpm-workspace.yaml

在根目录创建 `pnpm-workspace.yaml`：

```yaml
packages:
  - 'modules/monitor'
  - 'modules/asset'
  - 'modules/crossex'
```

### 第二步：修改根 package.json

1. **提取共享依赖到根 package.json**

将以下依赖从各模块移到根 `dependencies`：

```json
{
  "dependencies": {
    "react": "19.2.6",
    "react-dom": "19.2.6",
    "recharts": "3.8.0",
    "lucide-react": "1.31.0",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "drizzle-orm": "0.45.2",
    "pino": "^10.4.0",
    "pino-pretty": "^13.2.0"
  },
  "devDependencies": {
    "@types/node": "24.12.0",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.2",
    "typescript": "5.9.3",
    "vite": "8.2.2"
  }
}
```

2. **更新脚本命令**

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "dev:server": "node --watch server/index.mjs",
    "check": "tsc --noEmit",
    "build": "tsc --noEmit && vite build",
    "build:bundle": "vite build",
    "install:modules": "pnpm install",
    "build:modules": "pnpm -r --filter './modules/*' run build",
    "build:all": "pnpm run build && pnpm run build:modules",
    "start": "node server/index.mjs",
    "test": "node --test tests/*.test.mjs"
  }
}
```

### 第三步：清理模块 package.json

对 `modules/monitor/package.json`、`modules/asset/package.json`、`modules/crossex/package.json`：

1. **删除已提升到根的共享依赖**

从各模块的 `dependencies` 中删除：
- `react`
- `react-dom`
- `recharts`
- `lucide-react`
- `class-variance-authority`
- `clsx`
- `drizzle-orm`

从各模块的 `devDependencies` 中删除：
- `@types/react`
- `@types/react-dom`
- `@vitejs/plugin-react`
- `typescript`
- `vite`

2. **保留模块特有依赖**

**monitor 保留**：
```json
{
  "dependencies": {
    "https-proxy-agent": "9.1.0",
    "proxy-from-env": "2.1.0",
    "radix-ui": "^1.6.7",
    "tailwind-merge": "3.6.0",
    "ws": "8.21.3"
  },
  "devDependencies": {
    "@eslint/js": "9.39.4",
    "@tailwindcss/postcss": "4.2.1",
    "drizzle-kit": "0.31.10",
    "eslint": "9.39.4",
    "eslint-plugin-react": "7.37.5",
    "eslint-plugin-react-hooks": "7.1.1",
    "globals": "14.0.0",
    "tailwindcss": "4.2.1",
    "tw-animate-css": "^1.4.0",
    "typescript-eslint": "8.59.3"
  }
}
```

**asset 保留**：
```json
{
  "dependencies": {
    "ethers": "6.17.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "4.1.5",
    "tailwindcss": "4.1.5"
  }
}
```

**crossex 保留**：
```json
{
  "dependencies": {
    "decimal.js": "10.6.0"
  }
}
```

### 第四步：删除旧依赖

```bash
# 删除所有 node_modules 和锁文件
rm -rf node_modules modules/*/node_modules
rm -f package-lock.json modules/*/package-lock.json
```

### 第五步：安装 pnpm

```bash
# Windows
npm install -g pnpm

# 验证安装
pnpm --version  # 应该 >= 8.0.0
```

### 第六步：安装依赖

```bash
# 在根目录执行
pnpm install
```

这会：
- 在根目录创建 `node_modules`（包含共享依赖）
- 在 `modules/*/node_modules` 只放模块特有依赖
- 生成 `pnpm-lock.yaml`

### 第七步：更新构建脚本

修改 `scripts/modules.mjs`：

```javascript
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const action = process.argv[2];
if (!['install', 'build'].includes(action)) throw new Error('Usage: node scripts/modules.mjs install|build');

// 使用 pnpm 而不是 npm
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const environment = `${process.version}:${process.platform}:${process.arch}:${process.env.NODE_ENV || ''}`;
const ignored = new Set(['node_modules', 'dist', '.next', '.build-cache', '.module-cache', '.git', '__pycache__', '.pytest_cache', '.venv', '.data', 'output']);

function digest(directory, files) {
  const hash = createHash('sha256').update('embedded-build-v1:' + environment);
  function visit(relative) {
    const file = path.join(directory, relative);
    if (!existsSync(file)) return;
    const entries = readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.startsWith('.env') || entry.name.endsWith('.tsbuildinfo')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected module source link: ${relative}/${entry.name}`);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) hash.update(name.replaceAll('\\', '/')).update(readFileSync(path.join(directory, name)));
    }
  }
  if (files) for (const file of files) hash.update(file).update(readFileSync(path.join(directory, file)));
  else visit('');
  return hash.digest('hex');
}

const run = (directory, args) => new Promise((resolve, reject) => {
  const child = spawn(pnpm, args, { cwd: directory, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`pnpm ${args.join(' ')} failed (${code})`)));
});

if (action === 'install') {
  // pnpm workspace 在根目录统一安装
  console.log('[modules] Installing workspace dependencies...');
  await run(root, ['install', '--frozen-lockfile']);
  console.log('[modules] All modules installed');
} else {
  // 构建逻辑保持不变
  for (const id of ['monitor', 'asset', 'crossex']) {
    const directory = path.join(root, 'modules', id), cache = path.join(directory, '.module-cache');
    mkdirSync(cache, { recursive: true });
    const key = digest(directory);
    const stamp = path.join(cache, `${action}.json`);
    const artifact = path.join(directory, id === 'asset' ? '.next/BUILD_ID' : id === 'monitor' ? 'dist/build-manifest.json' : 'dist/index.html');
    let saved;
    try { saved = JSON.parse(readFileSync(stamp, 'utf8')); } catch { /* first run or invalid cache */ }
    const artifactHash = () => createHash('sha256').update(readFileSync(artifact)).digest('hex');
    if (saved?.key === key && existsSync(artifact) && saved.artifact === artifactHash()) {
      console.log(`[modules] ${id}: ${action} unchanged; skipped`); continue;
    }
    console.log(`[modules] ${id}: ${action}`);
    await run(directory, ['run', 'build']);
    if (!existsSync(artifact)) throw new Error(`${id} did not produce ${artifact}`);
    writeFileSync(stamp, JSON.stringify({ key: digest(directory), artifact: artifactHash() }) + '\n');
  }
}
```

### 第八步：更新 CI 配置

修改 `.github/workflows/*.yml` 中的安装步骤：

```yaml
# 之前
- name: Install dependencies
  run: npm ci

# 之后
- name: Install pnpm
  uses: pnpm/action-setup@v2
  with:
    version: 8

- name: Install dependencies
  run: pnpm install --frozen-lockfile
```

### 第九步：更新 .gitignore

确保 `.gitignore` 包含：

```gitignore
node_modules/
pnpm-lock.yaml
.pnpm-debug.log
modules/*/node_modules/
```

但 `pnpm-lock.yaml` 应该**提交到仓库**（类似 package-lock.json）。

### 第十步：验证

```bash
# 1. 检查依赖安装
pnpm list react  # 应该只显示一个版本

# 2. 构建主应用
pnpm run build

# 3. 构建所有模块
pnpm run build:modules

# 4. 运行测试
pnpm test

# 5. 启动开发服务器
pnpm run dev:server  # 在另一个终端
pnpm run dev         # 主应用
```

## 兼容性处理

### 模块内部引用

模块代码无需修改，因为：
- `import React from 'react'` 会自动解析到根 node_modules
- TypeScript 类型定义也会自动找到
- Vite 的 resolve 机制支持 workspace

### 动态导入路径

如果有动态导入（如 `import()`），确保路径相对于模块自身：

```typescript
// ✅ 正确
const component = await import('./components/MyComponent');

// ❌ 不要使用绝对路径
const component = await import('modules/monitor/components/MyComponent');
```

### 部署脚本

如果 `deploy/install.sh` 或 `deploy/package-release.py` 使用 npm，需要改为 pnpm：

```bash
# 之前
npm ci --production

# 之后
pnpm install --prod --frozen-lockfile
```

## 回滚方案

如果出现问题，可以回滚：

```bash
# 1. 删除 pnpm 相关文件
rm -f pnpm-workspace.yaml pnpm-lock.yaml
rm -rf node_modules modules/*/node_modules

# 2. 恢复各模块的完整 package.json（从 git）
git checkout modules/*/package.json package.json

# 3. 使用 npm 重新安装
npm install
npm run install:modules
```

## 预期收益

### 磁盘占用

- **之前**: ~1.4GB (154MB + 815MB + 302MB + 144MB)
- **之后**: ~500MB (共享依赖 + 模块特有依赖)
- **节省**: ~900MB (64%)

### 安装速度

- **之前**: 4 次独立 `npm ci`，串行执行
- **之后**: 1 次 `pnpm install`，并行解析
- **预计加速**: 50-70%

### 构建速度

- **之前**: 每个模块独立构建，重复编译共享依赖的类型
- **之后**: 共享 node_modules，TypeScript 缓存更有效
- **预计加速**: 20-30%

## 风险评估

### 低风险
- ✅ 模块代码无需修改
- ✅ 运行时行为不变
- ✅ 可以逐步迁移（先主仓库，再模块）

### 中等风险
- ⚠️ CI 需要安装 pnpm
- ⚠️ 开发者需要全局安装 pnpm
- ⚠️ 部署脚本需要更新

### 缓解措施
- 在 CI 中使用 `pnpm/action-setup`
- 在 README 中添加 pnpm 安装说明
- 提供回滚步骤

## 检查清单

迁移完成后，确认：

- [ ] `pnpm-workspace.yaml` 已创建
- [ ] 根 `package.json` 包含所有共享依赖
- [ ] 各模块 `package.json` 只保留特有依赖
- [ ] `pnpm install` 成功完成
- [ ] `pnpm run build` 主应用构建成功
- [ ] `pnpm run build:modules` 所有模块构建成功
- [ ] `pnpm test` 测试通过
- [ ] 开发服务器正常启动
- [ ] CI 配置已更新
- [ ] 部署脚本已更新
- [ ] `pnpm-lock.yaml` 已提交到仓库
- [ ] 旧的 `package-lock.json` 已删除

## 参考资料

- [pnpm workspace 官方文档](https://pnpm.io/workspaces)
- [pnpm vs npm 性能对比](https://pnpm.io/benchmarks)
- [Vite + pnpm workspace 最佳实践](https://vitejs.dev/guide/dep-pre-bundling.html)

## 后续优化建议

完成基础迁移后，可以考虑：

1. **使用 pnpm catalog**: 在一个地方管理所有依赖版本
2. **启用 strict-peer-dependencies**: 确保依赖版本一致性
3. **配置 public-hoist-pattern**: 优化某些工具的兼容性
4. **使用 pnpm patch**: 为依赖打补丁而不 fork

---

**迁移预计耗时**: 2-4 小时（包括测试和验证）
**建议时间窗口**: 非高峰期，确保有回滚时间
**负责人**: 需要熟悉 Node.js 构建工具链的开发者
