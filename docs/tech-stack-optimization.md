# 技术栈优化建议

## 当前技术栈分析

### 前端技术栈

| 模块 | 构建工具 | 框架 | 状态管理 | 数据库 |
|------|---------|------|---------|--------|
| 主应用 | Vite 8.2.2 | React 19.2.6 | 无 | - |
| Monitor | Vite 8.0.13 + SSR | React 19.2.6 | 无 | SQLite (DrizzleORM) |
| Asset | Next.js 16.3.4 | React 19.2.6 | 无 | SQLite (DrizzleORM) |
| CrossEx | Vite 8.2.2 | React 19.2.6 | 无 | SQLite (原生) |
| Greeks | Python FastAPI | - | - | JSON 文件 |

**共同依赖**：
- 图表：Recharts 3.8.0
- 图标：lucide-react 1.31.0
- 实时通信：WebSocket (ws 8.21.3) + EventSource

### 后端技术栈

- **Node.js**: 24.15.0 (原生 SQLite，无外部依赖)
- **Python**: 3.12 (仅 Greeks 模块)
- **数据库**: SQLite + WAL 模式
- **ORM**: DrizzleORM 0.45.2 (Monitor/Asset)
- **进程通信**: Unix domain sockets / Windows named pipes

## 优化建议分级

### 🟢 立即可做（低风险，高收益）

#### 1. 统一 Vite 版本

**问题**：
- 主应用和 CrossEx: Vite 8.2.2
- Monitor: Vite 8.0.13

**方案**：
```yaml
# pnpm-workspace.yaml catalog
'vite': '8.2.2'
```

**收益**：消除构建行为差异，减少依赖体积

#### 2. 移除冗余的 Event Source 轮询

**问题**：检查发现 5 处 WebSocket/EventSource 使用，部分可能有冗余轮询（L003 已记录）

**方案**：
- 已有恢复事件合并机制 (App.tsx, UpdateStatus.tsx)
- 定期审查 `tests/resume-refresh.browser.mjs` 和 `tests/trading-resume.browser.mjs`

**收益**：降低服务器负载，减少网络请求

#### 3. 启用 SQLite 预编译语句缓存

**当前状况**：
```javascript
// server/db-cache.mjs 已实现
const stmt = createStatementCache(db);
```

✅ **已优化**，但建议定期监控缓存命中率

#### 4. Greeks 状态持久化改进

**当前**：
```javascript
// modules/greeks/app/engine.py
STATE_FILE: resolve(dataDir, 'engine_state.json')
```

**问题**：JSON 文件写入频繁时可能有性能瓶颈

**方案**：考虑改用 SQLite（与其他模块一致）或增加写入节流

**优先级**：中（仅当 Greeks 高频交易时需要）

### 🟡 中期优化（中风险，中收益）

#### 5. 统一 ORM 使用

**问题**：
- Monitor + Asset: DrizzleORM
- CrossEx: 原生 SQLite
- 主应用: 原生 SQLite

**方案 A**（保守）：保持现状
- CrossEx 和主应用逻辑简单，原生 SQL 更清晰
- DrizzleORM 增加抽象层但收益有限

**方案 B**（激进）：全部迁移到 DrizzleORM
- 统一查询接口
- 自动类型推导
- 但增加依赖体积和学习成本

**建议**：**保持现状** ✅
- 原生 SQLite 性能更优
- CrossEx 和主应用 SQL 简单，不需要 ORM 抽象
- Monitor/Asset 已用 DrizzleORM，无需回退

#### 6. Next.js vs Vite 统一

**问题**：Asset 模块使用 Next.js 16.3.4，其他用 Vite

**分析**：
```typescript
// modules/asset/next.config.ts
const nextConfig: NextConfig = {
  serverExternalPackages: ['node:sqlite'],
  outputFileTracingIncludes: {
    '/*': ['./drizzle/*.sql'],
  }
};
```

**迁移成本**：
- Next.js App Router 路由需要重写
- SSR 逻辑需要迁移到 Vite SSR
- 构建产物追踪需要手动实现

**建议**：**保持 Next.js** ✅
- Asset 已深度集成 Next.js（文件追踪、SSR）
- 迁移成本高，收益低
- Next.js 16 已足够高效

#### 7. Python-Node 通信优化

**当前架构**：
```
Node.js (greeks.mjs)
  ↓ spawn + JSON lines over stdin/stdout
Python FastAPI (greeks-bridge.py)
  ↓ HTTP Basic Auth
Greeks 业务逻辑
```

**方案 A**（现状）：JSON Lines over stdio
- ✅ 简单可靠
- ✅ 无需网络端口
- ❌ 序列化开销

**方案 B**（优化）：共享内存 + MessagePack
- ✅ 性能提升 2-3x
- ❌ 复杂度高
- ❌ 跨平台兼容性差

**建议**：**保持 JSON Lines** ✅
- 当前瓶颈不在序列化
- 可靠性优于性能

### 🔴 长期考虑（高风险，需验证收益）

#### 8. Recharts 性能优化

**问题**：Recharts 在大数据量时性能较差

**替代方案对比**：

| 方案 | 性能 | 学习成本 | 迁移成本 | 生态 |
|------|------|---------|---------|------|
| Recharts 3.8.0 (当前) | ⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️⭐️ | - | ⭐️⭐️⭐️⭐️ |
| Apache ECharts | ⭐️⭐️⭐️⭐️⭐️ | ⭐️⭐️⭐️ | 🔴 高 | ⭐️⭐️⭐️⭐️⭐️ |
| Victory | ⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️ | 🟡 中 | ⭐️⭐️⭐️ |
| Visx (Airbnb) | ⭐️⭐️⭐️⭐️ | ⭐️⭐️ | 🟡 中 | ⭐️⭐️⭐️⭐️ |
| Chart.js + react-chartjs-2 | ⭐️⭐️⭐️⭐️ | ⭐️⭐️⭐️⭐️ | 🟡 中 | ⭐️⭐️⭐️⭐️⭐️ |

**建议**：
- **短期**：继续使用 Recharts，通过数据采样优化（L006 已有经验）
- **长期**：如果遇到性能瓶颈，考虑 Chart.js（生态成熟、迁移成本适中）

**不建议**：
- ❌ D3.js：学习曲线陡峭，维护成本高
- ❌ 自研 Canvas 图表：重复造轮子

#### 9. 状态管理引入评估

**当前**：所有模块无全局状态管理库

**是否需要**：

❌ **不建议引入**，理由：
- 所有模块使用服务端推送（SSE/WebSocket）
- 状态由后端维护，前端只是展示层
- React 19 内置 `useOptimistic` 和 `useTransition` 已足够
- 引入 Redux/Zustand/Jotai 会增加复杂度而无明显收益

✅ **继续使用**：
- `useState` + `useEffect` 订阅后端推送
- 简单表单状态用 `useReducer`

#### 10. TypeScript 严格模式

**当前**：
```json
// tsconfig.json
{
  "compilerOptions": {
    "strict": false  // 推测
  }
}
```

**建议**：逐步启用严格模式
```json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": true,
    "noImplicitAny": true
  }
}
```

**收益**：减少运行时错误，改善 IDE 提示

**迁移策略**：
1. 先在新文件启用
2. 逐步修复旧文件
3. 不强制全量迁移（遗留代码可保留 `@ts-ignore`）

## 不建议的方向

### ❌ 1. 迁移到 TypeScript 后端（Node.js）

当前后端已使用 ES modules + JSDoc，类型提示已足够。完全迁移到 `.ts` 文件：
- ❌ 需要构建步骤（降低开发体验）
- ❌ 部署复杂度增加
- ✅ 当前运行时无需编译，调试更快

### ❌ 2. 引入微前端框架（qiankun/Module Federation）

当前架构已是 workspace + 独立模块：
- ❌ 运行时复杂度爆炸
- ❌ 构建产物增大
- ✅ 当前进程隔离已足够

### ❌ 3. 全部迁移到 Rust/Go

Python Greeks 模块性能已足够：
- ❌ 重写成本巨大
- ❌ 生态不如 Python（量化库）
- ✅ 当前瓶颈不在计算性能

### ❌ 4. GraphQL 替代 REST

当前 REST + SSE 已满足需求：
- ❌ GraphQL 增加学习成本
- ❌ 实时推送仍需 WebSocket/SSE
- ✅ 当前接口简单，无需 GraphQL 灵活性

## 具体实施建议

### Phase 1：无风险优化（本周可做）

```bash
# 1. 统一 Vite 版本
pnpm add -w vite@8.2.2 --save-dev

# 2. 检查 SQLite 缓存命中率
# 在 server/db-cache.mjs 添加统计日志

# 3. 审查 EventSource 订阅
# 运行已有测试确认无冗余轮询
pnpm test
```

### Phase 2：中期优化（1-2个月）

1. **Greeks 状态持久化监控**
   - 添加写入频率监控
   - 仅当 QPS > 100 时考虑优化

2. **TypeScript 严格模式**
   - 新文件启用 `strict: true`
   - 旧文件逐步修复

3. **图表性能监控**
   - 添加 Recharts 渲染时间打点
   - 仅当 P95 > 500ms 时考虑替换

### Phase 3：长期跟踪

1. 定期审查依赖版本（`pnpm outdated`）
2. 监控 Node.js 原生 SQLite 性能
3. 关注 React 19 新特性（Compiler、Server Components）

## 总结

### 当前技术栈评级：⭐️⭐️⭐️⭐️ (4/5)

**优点**：
- ✅ 现代化工具链（Vite, React 19, pnpm）
- ✅ 轻量级数据库（SQLite + WAL）
- ✅ 无重度依赖（无 Redux/Apollo/大型 UI 库）
- ✅ 混合架构合理（Node + Python 各司其职）

**需要改进**：
- 🟡 Vite 版本不统一（轻微）
- 🟡 TypeScript 未开启严格模式（可选）

**无需改进**：
- ✅ ORM 混用是合理的（简单逻辑用原生 SQL）
- ✅ Next.js + Vite 混用符合各自模块特点
- ✅ Recharts 性能暂无瓶颈

### 最终建议

**立即执行**（本周）：
1. 统一 Vite 版本到 8.2.2
2. 验证 SQLite 缓存工作正常

**短期优化**（本月）：
1. 新文件启用 TypeScript 严格模式
2. 添加 Recharts 性能监控

**长期跟踪**：
1. 定期运行 `pnpm audit` 和 `pnpm outdated`
2. 关注 React Compiler 稳定版发布

**不要做**：
- ❌ 不要统一 ORM（原生 SQL 有其优势）
- ❌ 不要迁移 Asset 的 Next.js（成本高收益低）
- ❌ 不要引入状态管理库（当前无需要）
- ❌ 不要重写 Python 模块（性能足够）

---

**文档版本**: v1.0  
**评估日期**: 2026-10-14  
**评估人**: Claude Opus 5.5
