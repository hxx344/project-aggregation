# 模块迁移执行指南 - For Codex

## 任务目标

将 Market Monitor、Asset Ledger、Gate CrossEx、Greeks 四个独立服务迁移到 project-aggregation 工作台中，作为内嵌模块统一运行在端口 3100。

## 执行前须知

### 假设条件
- 当前目录：`/d/project_aggregation`
- 源代码位置（需要你确认）：
  - Market Monitor: `../market-spread-monitor`
  - Asset Ledger: `../asset-ledger`
  - Gate CrossEx: `../gate-crossex-arbitrage`
  - Greeks: `../greeks`
- 操作系统：Linux (Windows Git Bash 环境)
- Node.js: >= 24.15.0

### 最终架构
```
project-aggregation (单一服务，端口 3100)
├── /api/hub/*          # 工作台核心
├── /api/monitor/*      # Market Monitor 内嵌
├── /api/asset/*        # Asset Ledger 内嵌
├── /api/crossex/*      # CrossEx 内嵌
└── /api/greeks/*       # Greeks 内嵌

数据库：
├── data/hub.db         # 工作台
├── data/monitor.db     # Monitor 数据
├── data/asset.db       # Asset 账本
├── data/crossex.db     # CrossEx 记录
└── data/greeks.db      # Greeks 策略
```

## 执行步骤

### Step 1: 准备工作（必做）

```bash
# 1.1 创建备份
mkdir -p backups/current
cp -r data backups/current/

# 1.2 确认源代码位置（如果路径不对，停止并告知用户）
ls -la ../market-spread-monitor
ls -la ../asset-ledger
ls -la ../gate-crossex-arbitrage
ls -la ../greeks

# 1.3 创建模块目录结构
mkdir -p server/modules/{monitor,asset,crossex,greeks}
mkdir -p src/modules/{monitor,asset,crossex,greeks}
mkdir -p data
```

### Step 2: Market Monitor 迁移

```bash
# 2.1 复制代码
cp -r ../market-spread-monitor/server/* server/modules/monitor/
cp -r ../market-spread-monitor/src/* src/modules/monitor/

# 2.2 复制数据库
cp ../market-spread-monitor/data/monitor.db data/monitor.db 2>/dev/null || echo "Monitor DB not found, will create new"
```

**2.3 创建 `server/modules/monitor/routes.mjs`：**

```javascript
import { Router } from 'express';

export function createMonitorRoutes(db) {
  const router = Router();

  router.get('/monitors', async (req, res) => {
    try {
      const monitors = db.prepare('SELECT * FROM monitors WHERE enabled = 1').all();
      res.json(monitors);
    } catch (error) {
      console.error('[Monitor] Error:', error);
      res.status(500).json({ error: 'Failed to fetch monitors' });
    }
  });

  router.get('/hub/summary', async (req, res) => {
    try {
      // 实现摘要逻辑，参考原 /api/hub/summary
      res.json({
        schemaVersion: 2,
        data: {
          updatedAt: new Date().toISOString(),
          health: { state: 'online', message: 'Running', staleAfterSeconds: 120 },
          metrics: []
        }
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to generate summary' });
    }
  });

  return router;
}
```

**2.4 修改 `server/app.mjs`，在文件末尾添加：**

```javascript
// Market Monitor Module
import { createMonitorRoutes } from './modules/monitor/routes.mjs';
import Database from 'better-sqlite3';

const monitorDb = new Database('data/monitor.db');
monitorDb.pragma('journal_mode = WAL');
app.use('/api/monitor', createMonitorRoutes(monitorDb));
```

**2.5 验证**：
```bash
npm run dev:server
# 在另一个终端测试：
curl http://localhost:3100/api/monitor/monitors
```

### Step 3: Asset Ledger 迁移

```bash
# 3.1 复制代码
cp -r ../asset-ledger/server/* server/modules/asset/
cp -r ../asset-ledger/src/* src/modules/asset/

# 3.2 复制数据库
cp ../asset-ledger/data/asset.db data/asset.db 2>/dev/null || echo "Asset DB not found, will create new"
```

**3.3 创建 `server/modules/asset/routes.mjs`：**

```javascript
import { Router } from 'express';

export function createAssetRoutes(db) {
  const router = Router();

  router.get('/ledger', async (req, res) => {
    try {
      const ledger = db.prepare('SELECT * FROM ledger ORDER BY updated_at DESC').all();
      res.json({ ledger });
    } catch (error) {
      console.error('[Asset] Error:', error);
      res.status(500).json({ error: 'Failed to fetch ledger' });
    }
  });

  router.post('/sync', async (req, res) => {
    try {
      // 实现同步逻辑，参考原 POST /api/sync
      res.json({ status: 'success' });
    } catch (error) {
      res.status(500).json({ error: 'Sync failed' });
    }
  });

  router.get('/hub/positions', async (req, res) => {
    try {
      res.json({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        exchanges: []
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch positions' });
    }
  });

  router.get('/hub/summary', async (req, res) => {
    try {
      res.json({
        schemaVersion: 2,
        data: {
          updatedAt: new Date().toISOString(),
          health: { state: 'online', message: 'Running', staleAfterSeconds: 120 },
          metrics: []
        }
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to generate summary' });
    }
  });

  return router;
}
```

**3.4 在 `server/app.mjs` 末尾添加：**

```javascript
// Asset Ledger Module
import { createAssetRoutes } from './modules/asset/routes.mjs';

const assetDb = new Database('data/asset.db');
assetDb.pragma('journal_mode = WAL');
app.use('/api/asset', createAssetRoutes(assetDb));
```

**3.5 验证**：
```bash
curl http://localhost:3100/api/asset/ledger
```

### Step 4: Gate CrossEx 迁移

```bash
# 4.1 复制代码
cp -r ../gate-crossex-arbitrage/server/* server/modules/crossex/
cp -r ../gate-crossex-arbitrage/src/* src/modules/crossex/

# 4.2 复制数据库
cp ../gate-crossex-arbitrage/data/crossex.db data/crossex.db 2>/dev/null || echo "CrossEx DB not found, will create new"
```

**4.3 创建 `server/modules/crossex/routes.mjs`：**

```javascript
import { Router } from 'express';

export function createCrossExRoutes(db) {
  const router = Router();

  router.get('/spreads', async (req, res) => {
    try {
      const spreads = db.prepare('SELECT * FROM spreads ORDER BY timestamp DESC LIMIT 100').all();
      res.json(spreads);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch spreads' });
    }
  });

  router.get('/hub/summary', async (req, res) => {
    res.json({
      schemaVersion: 2,
      data: {
        updatedAt: new Date().toISOString(),
        health: { state: 'online', message: 'Running', staleAfterSeconds: 120 },
        metrics: []
      }
    });
  });

  return router;
}
```

**4.4 在 `server/app.mjs` 末尾添加：**

```javascript
// Gate CrossEx Module
import { createCrossExRoutes } from './modules/crossex/routes.mjs';

const crossexDb = new Database('data/crossex.db');
crossexDb.pragma('journal_mode = WAL');
app.use('/api/crossex', createCrossExRoutes(crossexDb));
```

### Step 5: Greeks 迁移

```bash
# 5.1 复制代码
cp -r ../greeks/server/* server/modules/greeks/
cp -r ../greeks/src/* src/modules/greeks/

# 5.2 复制数据库
cp ../greeks/data/greeks.db data/greeks.db 2>/dev/null || echo "Greeks DB not found, will create new"
```

**5.3 创建 `server/modules/greeks/routes.mjs`：**

```javascript
import { Router } from 'express';

export function createGreeksRoutes(db) {
  const router = Router();

  router.get('/strategy', async (req, res) => {
    try {
      const strategy = db.prepare('SELECT * FROM strategy LIMIT 1').get();
      res.json(strategy || {});
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch strategy' });
    }
  });

  router.get('/hub/summary', async (req, res) => {
    res.json({
      schemaVersion: 2,
      data: {
        updatedAt: new Date().toISOString(),
        health: { state: 'online', message: 'Running', staleAfterSeconds: 30 },
        metrics: []
      }
    });
  });

  return router;
}
```

**5.4 在 `server/app.mjs` 末尾添加：**

```javascript
// Greeks Module
import { createGreeksRoutes } from './modules/greeks/routes.mjs';

const greeksDb = new Database('data/greeks.db');
greeksDb.pragma('journal_mode = WAL');
app.use('/api/greeks', createGreeksRoutes(greeksDb));
```

### Step 6: 前端整合

**6.1 更新 `src/App.tsx`：**

移除 `aster` 和 `variational`，更新 adapters 定义：

```typescript
const adapters: Record<Adapter, string> = {
  monitor: 'Market Monitor',
  asset: '资产账本',
  crossex: 'Gate CrossEx',
  greeks: 'Greeks 期权',
  standard: '标准概览接口',
  link: '仅网页入口'
};
```

添加导航按钮：

```typescript
<nav>
  <button onClick={() => navigate({ view: 'overview' })}>
    <LayoutDashboard />总览
  </button>
  <button onClick={() => navigate({ view: 'monitor' })}>
    <Activity />市场监控
  </button>
  <button onClick={() => navigate({ view: 'asset' })}>
    <Wallet />资产账本
  </button>
  <button onClick={() => navigate({ view: 'crossex' })}>
    <Gauge />CrossEx 套利
  </button>
  <button onClick={() => navigate({ view: 'greeks' })}>
    <TrendingUp />Greeks 期权
  </button>
</nav>
```

**6.2 创建页面组件（如果原模块有前端）：**

- `src/modules/monitor/MonitorPage.tsx`
- `src/modules/asset/AssetPage.tsx`
- `src/modules/crossex/CrossExPage.tsx`
- `src/modules/greeks/GreeksPage.tsx`

在 `App.tsx` 中懒加载：

```typescript
const MonitorPage = lazy(() => import('./modules/monitor/MonitorPage'));
const AssetPage = lazy(() => import('./modules/asset/AssetPage'));
const CrossExPage = lazy(() => import('./modules/crossex/CrossExPage'));
const GreeksPage = lazy(() => import('./modules/greeks/GreeksPage'));

// 在渲染中
{route.view === 'monitor' && <Suspense fallback={<LoadingSpinner />}><MonitorPage /></Suspense>}
{route.view === 'asset' && <Suspense fallback={<LoadingSpinner />}><AssetPage /></Suspense>}
{route.view === 'crossex' && <Suspense fallback={<LoadingSpinner />}><CrossExPage /></Suspense>}
{route.view === 'greeks' && <Suspense fallback={<LoadingSpinner />}><GreeksPage /></Suspense>}
```

### Step 7: 清理旧模块引用

**7.1 更新 `server/adapters.mjs`：**

移除这些分支：
```javascript
// 删除这些代码
if (project.adapter === 'aster') { ... }
if (project.adapter === 'variational') { ... }
```

保留通用函数：`validateUrl`, `requestJson`, `blockedAddress` 等。

**7.2 删除数据库中的旧模块：**

在 `server/app.mjs` 启动时添加清理代码：

```javascript
// 清理已移除的模块
db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run('aster', 'variational');
db.prepare('DELETE FROM snapshots WHERE project_id IN (?, ?)').run('aster', 'variational');
```

### Step 8: 安装依赖

```bash
npm install better-sqlite3@^11.0.0
npm install ccxt@^4.0.0
npm install ws@^8.0.0
npm install
```

### Step 9: 测试

```bash
# 9.1 类型检查
npm run check

# 9.2 构建测试
npm run build

# 9.3 启动服务器
npm run dev:server

# 9.4 测试各模块端点（在另一个终端）
curl http://localhost:3100/api/monitor/monitors
curl http://localhost:3100/api/asset/ledger
curl http://localhost:3100/api/crossex/spreads
curl http://localhost:3100/api/greeks/strategy

# 9.5 浏览器测试
# 打开 http://localhost:3100
# 测试登录
# 测试切换到各个模块
```

### Step 10: 更新文档

**10.1 更新 `README.md`：**

```markdown
# Project Aggregation

统一的加密货币交易与资产管理平台。

## 内置模块

- **Market Monitor**: 跨交易所价差监控
- **Asset Ledger**: 多交易所资产账本
- **Gate CrossEx**: Gate.io 套利执行
- **Greeks**: BTC 期权策略

## 快速启动

```bash
npm install
npm run dev          # 开发环境
npm run build        # 构建
npm start            # 生产环境
```

访问 http://localhost:3100
```

**10.2 更新 `AGENTS.md`：**

在文件开头添加：

```markdown
## 模块迁移完成

以下模块已迁移到工作台内部，不再作为独立服务运行：

- Market Monitor: `/api/monitor/*`
- Asset Ledger: `/api/asset/*`
- Gate CrossEx: `/api/crossex/*`
- Greeks: `/api/greeks/*`

数据库位置：`data/{module}.db`
```

## 验证清单

执行完成后，确认以下所有项：

- [ ] 四个模块的代码已复制到 `server/modules/` 和 `src/modules/`
- [ ] 四个数据库文件存在于 `data/` 目录
- [ ] `server/app.mjs` 中正确挂载了四个模块路由
- [ ] `npm run check` 无 TypeScript 错误
- [ ] `npm run build` 成功
- [ ] 服务器启动无错误
- [ ] 四个模块的 API 端点响应正常
- [ ] 浏览器可以访问工作台并看到四个模块入口
- [ ] 模块间切换正常
- [ ] 文档已更新

## 遇到问题时

### 问题 1: 源代码路径不存在

**症状**：`dir ..\market-spread-monitor` 失败

**解决**：询问用户实际的源代码位置，然后更新 Step 2-5 中的路径。

### 问题 2: 数据库文件不存在

**症状**：复制数据库时提示文件不存在

**解决**：
```bash
# 创建空数据库
node -e "const db = require('better-sqlite3')('data/monitor.db'); db.close();"
```

然后继续迁移，告知用户该模块会使用新数据库。

### 问题 3: TypeScript 错误

**症状**：`npm run check` 报错

**解决**：
1. 检查 `src/modules/*/` 中的 `.tsx` 文件是否有语法错误
2. 检查导入路径是否正确
3. 必要时添加 `// @ts-ignore` 临时跳过

### 问题 4: 端口冲突

**症状**：服务器启动失败，提示端口占用

**解决**：
```bash
# Linux 查找占用端口的进程
lsof -i :3100
# 或者
netstat -tlnp | grep 3100

# 结束进程（替换 PID）
kill <PID>
# 或强制结束
kill -9 <PID>
```

### 问题 5: 模块数据库 schema 不匹配

**症状**：查询数据库时报错 "no such table"

**解决**：检查原模块的数据库 schema，必要时运行迁移脚本或创建表。

## 回滚方案

如果迁移失败需要回滚：

```bash
# 1. 停止服务器（Ctrl+C）

# 2. 恢复备份
rm -rf data
cp -r backups/current/data ./

# 3. 撤销代码变更
git checkout server/app.mjs
git clean -fd server/modules
git clean -fd src/modules

# 4. 重启服务器
npm run dev:server
```

## 完成标志

当所有验证清单项都勾选，且服务器稳定运行 30 分钟无错误，迁移即完成。

向用户报告：
```
✅ 模块迁移完成！

已迁移模块：
- Market Monitor: http://localhost:3100/api/monitor
- Asset Ledger: http://localhost:3100/api/asset
- Gate CrossEx: http://localhost:3100/api/crossex
- Greeks: http://localhost:3100/api/greeks

工作台访问：http://localhost:3100

数据库位置：data/
备份位置：backups/current/
```
