# 多模块性能优化实施指南

## 背景

**project-aggregation (工作台)** 已完成性能优化，版本 v0.2.0 实现了：
- 数据库 prepared statement 缓存（20-40% 性能提升）
- PnL 累积计算预计算优化（5-10倍提升）
- React 组件 memo 优化（减少 60-80% 重渲染）

**现在需要做的**：将这些已验证有效的优化技术应用到其他 6 个**独立项目**的代码库中。

## 重要说明

- project-aggregation 是一个**聚合工作台**，它集成/连接了其他独立服务
- 下列项目是**完全独立的代码仓库和部署服务**
- 它们各自有独立的代码、测试、构建和发布流程
- 优化需要在**每个项目的代码库中单独实施**

## 参考实现

**已完成的 PR**: https://github.com/hxx344/project-aggregation/pull/1
**关键 commits**:
- `c838aca` - 数据库 prepared statement 缓存
- `32578ed` - PnL 累积资金费优化
- `402be95` - React 组件记忆化

## 待优化的独立项目

以下是 6 个**独立的代码仓库**，每个都需要单独克隆、修改、测试和发布：

1. **ASTER 5X** - `hxx344/aster_5x` - 交易工作台
2. **Market Monitor** - `hxx344/market-spread-monitor` - 市场监控
3. **Asset Ledger** - `hxx344/asset-ledger` - 资产账本
4. **Gate CrossEx** - `hxx344/gate-crossex-arbitrage` - 跨交易所套利
5. **Variational Grid** - `hxx344/variational-grid` - 策略网格
6. **Greeks** - `hxx344/greeks` - 期权分析

**注意**：这些项目可能有不同的：
- 技术栈（不同的 Node 版本、框架等）
- 代码结构（文件组织、命名规范等）
- 测试要求（测试框架、覆盖率标准等）

每个项目需要**独立评估**哪些优化技术适用。

---

## 优化技术 #1: 数据库 Statement Cache

### 适用条件
- 模块使用 SQLite (`node:sqlite` 或 `better-sqlite3`)
- 存在重复的 SQL 查询

### 实现步骤

#### 1. 创建缓存模块
创建文件 `server/db-cache.js` (或 `.mjs`):

```javascript
/**
 * Prepared Statement Cache for SQLite
 * Provides 20-40% performance improvement for database operations.
 */
export function createStatementCache(db) {
  const cache = new Map();

  return {
    prepare(sql) {
      let stmt = cache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        cache.set(sql, stmt);
      }
      return stmt;
    },

    clear() {
      cache.clear();
    },

    size() {
      return cache.size;
    }
  };
}
```

#### 2. 在主模块中集成

找到数据库初始化代码，通常在 `server/index.js` 或 `server/app.js`:

```javascript
import { DatabaseSync } from 'node:sqlite';
import { createStatementCache } from './db-cache.js';

const db = new DatabaseSync('data.sqlite');
const stmt = createStatementCache(db);

// 将 stmt 传递给需要数据库访问的模块
const service = createService({ db, stmt });
```

#### 3. 替换所有 db.prepare 调用

**查找所有使用点**:
```bash
grep -r "db\.prepare" server/
```

**替换模式**:
```javascript
// 之前:
const result = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

// 之后:
const result = stmt.prepare('SELECT * FROM users WHERE id = ?').get(userId);
```

#### 4. 处理函数签名

如果函数接受 `db` 参数，添加可选的 `stmt` 参数:

```javascript
// 之前:
export function createService(db) {
  // ...
}

// 之后:
export function createService(db, stmt) {
  if (!stmt) stmt = createStatementCache(db);
  // ...
}
```

### 验证
```bash
npm test
# 所有测试应该通过
# 数据库操作耗时应减少 20-40%
```

---

## 优化技术 #2: 预计算累积值

### 适用条件
- 存在累积计算（累计 PnL、累计资金费、累计收益等）
- 计算逻辑在 O(n) 或更高复杂度

### 实现步骤

#### 1. 识别累积计算

查找类似这样的代码模式:
```javascript
// 反模式：每次读取时重新计算所有累积值
function read(events) {
  let accumulated = 0;
  const results = [];
  for (const event of events) {
    accumulated += event.amount;
    results.push({ ...event, cumulative: accumulated });
  }
  return results;
}
```

#### 2. 数据库 Schema 变更

添加累积字段:
```sql
ALTER TABLE table_name ADD COLUMN cumulative_value TEXT;
```

#### 3. 在写入时预计算

```javascript
function record(entry, current) {
  const previous = getLatest();
  const cumulativeValue = previous 
    ? add(previous.cumulative_value, entry.amount)
    : entry.amount;
  
  stmt.prepare('INSERT INTO table_name (..., cumulative_value) VALUES (..., ?)')
    .run(..., cumulativeValue);
}
```

#### 4. 读取时直接使用

```javascript
function read(start, end) {
  const records = stmt.prepare('SELECT * FROM table_name WHERE time >= ? AND time <= ?')
    .all(start, end);
  
  // 直接使用 cumulative_value，无需重新计算
  return records.map(row => ({
    ...row,
    cumulative: row.cumulative_value
  }));
}
```

### 注意事项
- 保持向后兼容：旧数据可能没有 cumulative 字段
- 数据覆盖变化时需要重新计算
- 写入测试用例验证正确性

---

## 优化技术 #3: React 组件 Memo

### 适用条件
- React 前端
- 存在大型列表渲染
- 父组件频繁更新但子组件 props 不变

### 实现步骤

#### 1. 识别优化目标

使用 React DevTools Profiler 识别：
- 列表组件（表格行、卡片列表等）
- 频繁重渲染但内容不变的组件

#### 2. 应用 memo

```javascript
import { memo } from 'react';

// 之前:
function ListItem({ data }) {
  return <div>{data.name}</div>;
}

// 之后:
const ListItem = memo(function ListItem({ data }) {
  return <div>{data.name}</div>;
});
```

#### 3. 常见模式

**列表项组件**:
```javascript
const PositionRow = memo(function PositionRow({ position }) {
  return (
    <tr>
      <td>{position.symbol}</td>
      <td>{position.quantity}</td>
    </tr>
  );
});
```

**大型容器组件**:
```javascript
const PositionList = memo(function PositionList({ positions }) {
  return (
    <table>
      <tbody>
        {positions.map(pos => (
          <PositionRow key={pos.id} position={pos} />
        ))}
      </tbody>
    </table>
  );
});
```

#### 4. 避免的陷阱

❌ **错误：内联函数作为 prop**
```javascript
<ListItem onClick={() => handleClick(item.id)} />
// 每次渲染都创建新函数，memo 失效
```

✅ **正确：使用 useCallback**
```javascript
const handleClick = useCallback((id) => {
  // ...
}, []);

<ListItem onClick={handleClick} />
```

### 验证
- 使用 React DevTools Profiler 对比优化前后
- 重渲染次数应减少 60-80%

---

## 标准工作流

### 对于每个模块执行：

```bash
# 1. 克隆仓库
git clone https://github.com/hxx344/{module-repo}
cd {module-repo}

# 2. 分析代码结构
ls -la server/
cat package.json

# 3. 检查数据库使用
grep -r "DatabaseSync\|better-sqlite3" server/
grep -r "db\.prepare" server/

# 4. 检查累积计算
grep -r "reduce\|accumulate\|cumulative" server/

# 5. 检查 React 组件
find src/ -name "*.tsx" -o -name "*.jsx" | xargs grep -l "map("

# 6. 创建优化分支
git checkout -b perf/optimization-v1

# 7. 应用优化（按优先级）
# - Statement cache (高优先级，通用)
# - 预计算 (如果适用)
# - React memo (前端项目)

# 8. 测试
npm test
npm run build

# 9. 提交
git add -A
git commit -m "Perf: Apply statement cache and component memoization

- Add prepared statement cache for 20-40% DB speedup
- Optimize React components with memo
- All tests passing

Based on project-aggregation v0.2.0 optimizations"

# 10. 推送并创建 PR
git push -u origin perf/optimization-v1
gh pr create --title "Performance optimization" --body "Apply proven optimizations from project-aggregation v0.2.0"
```

### PR 合并后发布

```bash
# 1. 确保在 main 分支
git checkout main
git pull

# 2. 构建
npm run build

# 3. 打包 (如果有 package-release.py)
python deploy/package-release.py --output output/release

# 4. 创建 deploy tag
COMMIT=$(git rev-parse HEAD)
git tag deploy-$COMMIT
git push origin deploy-$COMMIT

# 5. 创建 GitHub Release
gh release create deploy-$COMMIT \
  output/release/*.tar.gz \
  output/release/release-manifest.json \
  --title "Performance optimization release" \
  --notes "Database and frontend optimizations applied"

# 6. 设置为正式版本（非 prerelease）
gh release edit deploy-$COMMIT --prerelease=false
```

---

## 验证清单

每个模块完成后检查：

- [ ] 所有测试通过 (`npm test`)
- [ ] 构建成功 (`npm run build`)
- [ ] Statement cache 已实现（如果有数据库）
- [ ] 预计算已实现（如果有累积逻辑）
- [ ] React memo 已应用（如果是前端）
- [ ] Deploy release 已创建
- [ ] Release 设置为非 prerelease
- [ ] 在更新界面能看到新版本

---

## 预期结果

完成所有5个模块后，系统更新界面应显示：

```
本机模块 - 7个可更新

✅ 工作台 - f2cb0fa → 新版本
✅ ASTER 5X - e7827d5 → 新版本
✅ Market Monitor - 732cd1e → 新版本
✅ Asset Ledger - 1c1548d → 新版本
✅ Gate CrossEx - 24c1474 → 新版本
✅ Variational Grid - 7b3cb77 → 新版本
```

---

## 需要帮助？

如果遇到问题，参考：
- project-aggregation 仓库的 PR #1
- 提交历史：c838aca, 32578ed, 402be95, 4b4e5bb
- 测试文件了解预期行为

## 开始执行

建议按以下顺序优化：
1. **ASTER 5X** (最复杂，先建立经验)
2. **Market Monitor** (类似模式)
3. **Asset Ledger** (中等复杂度)
4. **Gate CrossEx** (标准模式)
5. **Variational Grid** (最后验证流程)

每完成一个模块，报告结果和遇到的问题。
