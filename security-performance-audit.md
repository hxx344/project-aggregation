# Project Aggregation 安全与性能审查报告

## 执行摘要

审查日期：2026-10-12  
项目版本：0.1.0  
审查范围：安全性、性能、代码质量

### 关键发现

- **高优先级问题**: 1个 npm 依赖漏洞
- **中优先级问题**: 5个安全改进点
- **性能优化机会**: 8个方向
- **代码质量建议**: 6个改进点

---

## 一、安全问题

### 🔴 高优先级

#### 1.1 npm 依赖漏洞

**问题**: `source-map-js` 存在高危漏洞 (GHSA-68fv-2mgg-jv7q)
- **严重性**: HIGH (CVSS 7.5)
- **影响**: Event-loop denial of service
- **受影响版本**: 1.0.0 - 1.2.1
- **当前状态**: 可修复

**修复方案**:
```bash
npm audit fix
```

**位置**: 间接依赖，通过构建工具引入

---

### 🟡 中优先级

#### 1.2 会话管理

**当前实现**: 
- 会话有效期固定 7 天 ([server/app.mjs:28](server/app.mjs:28))
- 使用 SHA-256 哈希存储会话 ID
- HttpOnly + SameSite=Strict cookies

**改进建议**:
```javascript
// 建议：添加会话活动时刷新
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_THRESHOLD = 24 * 60 * 60 * 1000; // 最后 24 小时内刷新

// 在认证检查时：
if (current && current.expires - Date.now() < SESSION_REFRESH_THRESHOLD) {
  // 刷新会话过期时间
  db.prepare('UPDATE sessions SET expires=? WHERE id=?')
    .run(Date.now() + SESSION_AGE, current.id);
}
```

#### 1.3 速率限制

**当前实现**: 
- 登录：15 分钟内最多 10 次尝试 ([server/app.mjs:279](server/app.mjs:279))
- SSE 连接：每个会话最多 12 个，总计 60 个 ([server/app.mjs:363](server/app.mjs:363))

**改进建议**:
1. 添加全局 API 速率限制
2. 针对敏感操作（交易执行、密钥连接）添加独立限流

```javascript
// 建议实现
const rateLimits = new Map(); // IP -> { requests: [], resetAt: timestamp }

function checkRateLimit(ip, maxRequests = 100, windowMs = 60000) {
  const now = Date.now();
  const limit = rateLimits.get(ip) || { requests: [], resetAt: now + windowMs };
  
  limit.requests = limit.requests.filter(t => t > now - windowMs);
  
  if (limit.requests.length >= maxRequests) {
    throw new HttpError(429, '请求过于频繁，请稍后重试');
  }
  
  limit.requests.push(now);
  rateLimits.set(ip, limit);
}
```

#### 1.4 密钥轮换

**当前实现**: 
- 凭据加密密钥存储在 `credentials.key` ([server/app.mjs:57](server/app.mjs:57))
- 密钥丢失时拒绝启动（正确做法）

**改进建议**:
1. 实现密钥版本管理，支持密钥轮换
2. 添加密钥轮换文档和工具

```javascript
// 建议架构
const keyVersions = {
  current: 2,
  keys: {
    1: oldKey,
    2: newKey
  }
};

function encrypt(value) {
  const version = keyVersions.current;
  const key = keyVersions.keys[version];
  // ... 加密逻辑
  return { version, data: encrypted };
}

function decrypt(payload) {
  const key = keyVersions.keys[payload.version];
  // ... 解密逻辑
}
```

#### 1.5 SQL 注入防护

**当前状态**: ✅ 良好
- 全部使用参数化查询
- 未发现字符串拼接 SQL

**验证示例**: [server/app.mjs:67](server/app.mjs:67)
```javascript
db.prepare('SELECT value FROM settings WHERE key=?').get(name)?.value;
```

#### 1.6 输入验证

**当前状态**: ✅ 大部分良好

**改进点**:
1. 统一错误消息，避免泄露内部细节
2. 添加更严格的交易所 API 凭据格式验证

**建议**:
```javascript
// 在 server/trading-execution.mjs:141
// 当前：基本长度和字符检查
// 建议：添加交易所特定格式验证

const keyValidators = {
  binance: (key) => /^[A-Za-z0-9]{64}$/.test(key),
  okx: (key) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key),
  bybit: (key) => /^[A-Z0-9]{20}$/.test(key)
};
```

---

## 二、性能优化

### 🚀 数据库优化

#### 2.1 添加缺失索引

**当前状态**: 部分索引覆盖
- `execution_orders` 已有 `job_id` 索引 ✅
- 缺少 `sessions.expires` 索引
- 缺少 `execution_previews.expires` 索引

**建议**:
```sql
-- 会话清理查询优化
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

-- 预览过期清理优化
CREATE INDEX IF NOT EXISTS idx_execution_previews_expires 
  ON execution_previews(expires) WHERE consumed IS NULL;

-- 快照查询优化（如果频繁按时间范围查询）
CREATE INDEX IF NOT EXISTS idx_snapshots_checked 
  ON snapshots(id, json) WHERE json LIKE '%"checkedAt"%';
```

**预期改善**: 清理操作从 O(n) 扫描降至 O(log n) 索引查找

#### 2.2 数据库连接池

**当前实现**: 单一 `DatabaseSync` 连接 ([server/app.mjs:66](server/app.mjs:66))

**影响**: 
- SQLite 在 WAL 模式下支持并发读
- 当前实现串行化所有数据库访问

**建议**:
```javascript
// 对于高并发场景，考虑：
// 1. 使用 better-sqlite3 的连接池
// 2. 或迁移到 PostgreSQL（如果需要更高并发）

// 短期优化：确保只读查询不阻塞写入
const readDb = new DatabaseSync(dbPath, { readonly: true });
const writeDb = db; // 原有写连接
```

#### 2.3 缓存层优化

**当前实现**:
- 快照缓存：内存 Map + SQLite ([server/app.mjs:176](server/app.mjs:176))
- 交易缓存：`trading-view-cache.mjs`

**改进建议**:

1. **添加 LRU 缓存限制**
```javascript
class LRUCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }
  
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // 移到最后（最近使用）
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 删除最久未使用项
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

const states = new LRUCache(100); // 替代现有 Map
```

2. **摘要缓存分层**
```javascript
// 短期缓存（5秒）：用于高频轮询
// 中期缓存（30秒）：用于后台刷新
// 长期缓存（失败时）：用于降级展示

const cacheConfig = {
  hot: { ttl: 5000, size: 50 },
  warm: { ttl: 30000, size: 100 },
  cold: { ttl: 300000, size: 200 }
};
```

### 🔄 并发控制优化

#### 2.4 请求合并

**问题**: 多个客户端可能同时触发相同项目的刷新

**当前实现**: `pending` Map 避免重复请求 ([server/app.mjs:131](server/app.mjs:131)) ✅

**改进**: 添加请求合并指标监控
```javascript
const metrics = {
  requestsMerged: 0,
  cachehits: 0
};

function check(id) {
  if (pending.has(id)) {
    metrics.requestsMerged++;
    return pending.get(id);
  }
  // ...
}
```

#### 2.5 超时策略细化

**当前实现**: 
- 摘要读取：5 秒 ([server/app.mjs:52](server/app.mjs:52))
- 交易任务：60 秒
- 执行调用：35 秒 ([server/trading-execution.mjs:20](server/trading-execution.mjs:20))

**建议**: 根据操作类型分级
```javascript
const timeouts = {
  fastRead: 2000,      // 缓存数据读取
  normalRead: 5000,    // 标准 API 查询
  slowRead: 10000,     // 复杂聚合
  mutation: 30000,     // 写入操作
  trading: 35000       // 交易所调用（保持）
};
```

### 📊 数据传输优化

#### 2.6 响应压缩

**当前实现**: 
- 静态资源：部分启用 gzip ([server/portal-compression.mjs](server/portal-compression.mjs))
- API 响应：未压缩

**建议**:
```javascript
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

async function send(res, status, data, headers = {}) {
  const json = JSON.stringify(data);
  
  // 大于 1KB 的响应启用压缩
  if (json.length > 1024 && req.headers['accept-encoding']?.includes('gzip')) {
    const compressed = await gzipAsync(Buffer.from(json));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
      ...headers
    });
    res.end(compressed);
  } else {
    // 原有逻辑
  }
}
```

#### 2.7 SSE 优化

**当前实现**: 
- 15 秒心跳 ([server/app.mjs:451](server/app.mjs:451))
- 差量编码协议 `protocol=2` ([server/overview-stream.mjs](server/overview-stream.mjs))

**建议**: 
1. ✅ 已实现差量编码
2. 添加客户端重连指数退避
3. 监控连接质量指标

```javascript
// 客户端侧建议
let reconnectDelay = 1000;
const maxDelay = 30000;

eventSource.onerror = () => {
  setTimeout(() => {
    reconnect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, maxDelay);
  }, reconnectDelay);
};

eventSource.onopen = () => {
  reconnectDelay = 1000; // 重置
};
```

#### 2.8 批量操作优化

**建议**: 交易历史分页加载
```javascript
// 当前：一次返回 50 条
// 建议：支持客户端指定页大小

const pageSize = Math.min(
  Number(url.searchParams.get('pageSize') || '50'),
  200 // 最大限制
);
```

### ⚡ 前端性能

#### 2.9 React 优化

**建议检查点**:
1. 使用 `React.memo` 包装纯组件
2. 图表组件使用 `useMemo` 缓存数据转换
3. 虚拟滚动长列表（如资金费流水）

```typescript
// 示例：src/TradingFundingChart.tsx
import { memo, useMemo } from 'react';

export const TradingFundingChart = memo(({ data, days }) => {
  const chartData = useMemo(() => {
    return processChartData(data);
  }, [data]);
  
  return <ResponsiveContainer>...</ResponsiveContainer>;
});
```

---

## 三、代码质量改进

### 📝 类型安全

#### 3.1 TypeScript 严格模式

**当前配置**: [tsconfig.json:6](tsconfig.json:6)
```json
{
  "compilerOptions": {
    // 未启用 strict: true
  }
}
```

**建议**:
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true
  }
}
```

### 🧪 测试覆盖

#### 3.2 增加测试用例

**当前状态**: 有测试文件在 `tests/` 目录

**建议补充**:
1. 加密/解密边界测试
2. SQL 注入防护测试
3. 交易执行幂等性测试
4. 并发场景压力测试

```javascript
// tests/security.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';

test('SQL 注入防护', async () => {
  const maliciousInput = "'; DROP TABLE sessions; --";
  // 验证不会执行 SQL
});

test('加密数据完整性', async () => {
  const original = { apiKey: 'test', secret: 'secret' };
  const encrypted = encrypt(original);
  const decrypted = decrypt(encrypted);
  assert.deepStrictEqual(original, decrypted);
});
```

### 📄 文档完善

#### 3.3 API 文档

**建议**: 添加 OpenAPI/Swagger 规范

```yaml
# api-spec.yaml
openapi: 3.0.0
info:
  title: Project Aggregation API
  version: 0.1.0
paths:
  /api/projects:
    get:
      summary: 获取所有项目
      responses:
        '200':
          description: 项目列表
          content:
            application/json:
              schema:
                type: object
                properties:
                  projects:
                    type: array
```

#### 3.4 安全最佳实践文档

**建议创建**: `docs/security.md`
- 密钥轮换流程
- 备份恢复步骤
- 事件响应计划
- 审计日志说明

### 🔍 监控与日志

#### 3.5 结构化日志

**当前实现**: `console.log` ([server/app.mjs:52](server/app.mjs:52))

**建议**:
```javascript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

logger.info({ userId, action: 'login' }, '用户登录成功');
logger.error({ err, projectId }, '项目数据读取失败');
```

#### 3.6 性能监控

**建议添加**:
```javascript
// 关键路径计时
const metrics = {
  apiLatency: new Map(), // endpoint -> [durations]
  dbQueryTime: [],
  cacheHitRate: { hits: 0, misses: 0 }
};

function recordMetric(endpoint, duration) {
  if (!metrics.apiLatency.has(endpoint)) {
    metrics.apiLatency.set(endpoint, []);
  }
  metrics.apiLatency.get(endpoint).push(duration);
  
  // 保持最近 1000 条
  if (metrics.apiLatency.get(endpoint).length > 1000) {
    metrics.apiLatency.get(endpoint).shift();
  }
}

// 暴露指标端点
app.get('/api/metrics', (req, res) => {
  res.json({
    apiLatency: Object.fromEntries(
      Array.from(metrics.apiLatency).map(([k, v]) => [
        k,
        {
          p50: percentile(v, 50),
          p95: percentile(v, 95),
          p99: percentile(v, 99)
        }
      ])
    ),
    cacheHitRate: metrics.cacheHitRate.hits / 
      (metrics.cacheHitRate.hits + metrics.cacheHitRate.misses)
  });
});
```

---

## 四、架构建议

### 🏗️ 长期演进

#### 4.1 微服务拆分考虑

**当前**: 单体应用
**建议**: 当达到以下条件时考虑拆分
- 并发用户 > 100
- 接入项目 > 30
- 日请求量 > 100万

**拆分方向**:
1. 认证服务
2. 数据聚合服务
3. 交易执行服务（已较好隔离）

#### 4.2 数据库迁移路径

**SQLite 限制**:
- 单写入者
- 无跨机器复制
- 数据库文件大小 > 100GB 性能下降

**迁移触发条件**:
- 需要多实例部署
- 数据量 > 10GB
- 需要复杂查询分析

**建议路径**: SQLite → PostgreSQL
- 保持相同的 SQL 语法
- 渐进式迁移（双写验证）

---

## 五、实施优先级

### 🔥 立即处理（本周）

1. **修复 npm 漏洞** - 5 分钟
   ```bash
   npm audit fix
   npm test
   git commit -am "fix: 修复 source-map-js 安全漏洞"
   ```

2. **添加数据库索引** - 30 分钟
   - 会话过期索引
   - 预览过期索引

3. **启用 TypeScript strict 模式** - 2 小时
   - 分批修复类型错误
   - 提高类型安全

### 📅 短期规划（本月）

4. **实现请求速率限制** - 4 小时
5. **添加 API 响应压缩** - 2 小时
6. **补充安全测试用例** - 8 小时
7. **优化前端性能** - 16 小时
   - React.memo 优化
   - 图表数据缓存
   - 虚拟滚动

### 🎯 中期目标（本季度）

8. **实现密钥轮换机制** - 3 天
9. **添加结构化日志** - 2 天
10. **性能监控体系** - 5 天
11. **完善文档** - 3 天

### 🚀 长期愿景（明年）

12. **考虑数据库迁移** - 按需
13. **微服务拆分** - 按需
14. **容器化部署** - Docker + K8s

---

## 六、风险评估

### 当前安全评级: B+ (良好)

**优势**:
- ✅ 参数化查询防止 SQL 注入
- ✅ 密钥加密存储
- ✅ CSRF 保护
- ✅ 安全的会话管理
- ✅ 输入验证完善

**需改进**:
- ⚠️ npm 依赖漏洞
- ⚠️ 缺少全局速率限制
- ⚠️ 无密钥轮换机制

### 性能评级: B (良好)

**优势**:
- ✅ 请求去重
- ✅ 部分缓存机制
- ✅ SSE 差量更新
- ✅ SQLite WAL 模式

**瓶颈**:
- ⚠️ 单写入者限制
- ⚠️ 缺少响应压缩
- ⚠️ 前端未充分优化

---

## 附录：快速操作清单

### A. 立即执行命令

```bash
# 1. 修复依赖漏洞
npm audit fix

# 2. 运行测试确保无回归
npm test

# 3. 检查 TypeScript 类型
npm run check

# 4. 查看当前数据库索引
sqlite3 .data/hub.sqlite ".schema" | grep INDEX
```

### B. 监控指标

```javascript
// 添加到 server/app.mjs 的健康检查
if (pathname === '/api/health' && req.method === 'GET') {
  const metrics = {
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    dbSize: statSync(dbPath).size,
    activeSessions: db.prepare('SELECT COUNT(*) as count FROM sessions WHERE expires>?')
      .get(Date.now()).count,
    activeStreams: streams.size
  };
  send(res, 200, metrics);
}
```

---

**报告生成者**: Claude Opus 5.5  
**审查方法**: 静态代码分析 + 最佳实践对比  
**覆盖范围**: 服务端代码、配置文件、依赖管理
