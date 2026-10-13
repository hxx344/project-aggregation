# Greeks 模块为什么不用 Vite/Next.js

## TL;DR

Greeks 是 **纯后端 Python FastAPI 应用**，没有前端构建需求，所以不需要 Vite 或 Next.js。

## 架构对比

### Greeks 模块架构

```
Node.js 主进程 (server/modules/greeks.mjs)
    ↓ spawn 子进程
greeks-bridge.py (ASGI over stdio)
    ↓ 路由 HTTP 请求
FastAPI app (app/main.py)
    ↓ 调用
Trading Engine (量化交易逻辑)
    ↓ 连接
Bybit API (期权交易)
```

**关键特征**：
- ✅ **纯后端服务**，无前端代码
- ✅ **通过 stdin/stdout 与 Node.js 通信**（不监听网络端口）
- ✅ **Python FastAPI** 提供 RESTful API
- ✅ **状态存储在 JSON 文件**（`engine_state.json`）

### 其他模块架构

```
Monitor/Asset/CrossEx:
  前端 (React + Vite/Next.js)
      ↓ HTTP/WebSocket
  后端 (Node.js)
      ↓ SQLite
  数据持久化
```

**关键特征**：
- ✅ **有前端界面**，需要构建工具
- ✅ **Node.js 后端** 提供 API
- ✅ **SQLite 数据库** 持久化

## 为什么 Greeks 不需要 Vite/Next.js

### 1. 没有前端代码

**Greeks 模块文件结构**：
```
modules/greeks/
├── app/
│   ├── main.py           # FastAPI 入口
│   ├── engine.py         # 交易引擎
│   ├── bybit.py          # 交易所接口
│   ├── strategy.py       # 策略逻辑
│   ├── orders.py         # 订单管理
│   └── risk.py           # 风险控制
├── pyproject.toml        # Python 依赖
└── requirements.lock     # 锁定版本
```

**没有**：
- ❌ 没有 `src/` 或 `app/` 前端目录
- ❌ 没有 `.tsx`、`.jsx` 文件
- ❌ 没有 `package.json`
- ❌ 没有 React 组件

**对比 Monitor 模块**：
```
modules/monitor/
├── src/                  # React 前端
│   ├── App.tsx
│   ├── MarketPanel.tsx
│   └── ...
├── server/               # Node.js 后端
├── package.json
└── vite.config.ts        # ← 因为有前端才需要
```

### 2. FastAPI 自带静态文件服务

```python
# modules/greeks/app/main.py
from fastapi.staticfiles import StaticFiles

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
```

FastAPI 内置静态文件服务，不需要 Vite 的开发服务器或 Next.js 的 SSR。

### 3. Python 运行时不需要构建

**JavaScript/TypeScript**（需要构建）：
```bash
# 开发
vite dev

# 生产
vite build  # 生成 dist/
```

**Python**（直接运行）：
```bash
# 开发和生产都是
python -m uvicorn app.main:app

# 或者通过 bridge
python greeks-bridge.py app.main:app
```

Python 是解释型语言，不需要编译或打包步骤。

### 4. 专注量化计算，不是 Web 界面

**Greeks 模块的核心职责**：
- 📊 期权定价（Black-Scholes 模型）
- 📈 Greeks 计算（Delta, Gamma, Theta, Vega）
- 🔄 自动化交易执行
- ⚖️ 风险管理和对冲

这些都是**纯后端逻辑**，不涉及 UI 渲染。

**前端在哪里？**

工作台主应用（`src/`）会调用 Greeks 的 API 并展示结果：

```typescript
// 主应用 src/某个组件.tsx
const response = await fetch('/api/greeks/positions');
const positions = await response.json();

return <PositionsTable data={positions} />;
```

Greeks 只返回 JSON 数据，渲染由主应用完成。

## 技术选型对比表

| 方面 | Greeks (Python) | Monitor/Asset/CrossEx (Node.js) |
|------|----------------|--------------------------------|
| **语言** | Python 3.12 | TypeScript/JavaScript |
| **前端框架** | ❌ 无 | React 19 |
| **构建工具** | ❌ 不需要 | Vite 8 / Next.js 16 |
| **后端框架** | FastAPI | 原生 Node.js HTTP |
| **主要用途** | 量化交易引擎 | Web 应用（前后端） |
| **运行方式** | Python 解释器 | Node.js 运行时 + 编译产物 |
| **数据库** | JSON 文件 | SQLite |
| **依赖管理** | pip + requirements.lock | pnpm + pnpm-lock.yaml |

## 为什么选择 Python 而非 Node.js

### 1. 量化金融生态

**Python 优势**：
```python
# 丰富的量化库
import numpy as np          # 数值计算
import pandas as pd         # 时间序列
import scipy.stats as st    # 统计分布
from py_vollib import black_scholes  # 期权定价

# Black-Scholes 定价
price = black_scholes.black_scholes(
    flag='c',           # call option
    S=50000,            # 标的价格
    K=52000,            # 行权价
    t=7/365,            # 到期时间
    r=0.05,             # 无风险利率
    sigma=0.8           # 波动率
)
```

**Node.js 劣势**：
- ❌ 缺少成熟的期权定价库
- ❌ 科学计算生态弱
- ❌ 需要自己实现 Black-Scholes 模型

### 2. 异步 I/O 同样强大

**误区**：Python 不擅长异步

**实际**：Python 3.7+ 的 `asyncio` 和 FastAPI 非常高效：

```python
# Greeks 的并发市场数据拉取
async def market_loop(self):
    while True:
        async with httpx.AsyncClient() as client:
            # 并发请求多个交易对
            tasks = [
                self.fetch_orderbook(client, symbol)
                for symbol in self.symbols
            ]
            results = await asyncio.gather(*tasks)
        await asyncio.sleep(1)
```

性能与 Node.js 相当，但有更好的数值计算支持。

### 3. 状态管理更简单

**Greeks 的状态存储**：
```python
# 直接序列化 Python 对象
state = {
    'positions': [position.dict() for position in self.positions],
    'pending_orders': self.pending_orders,
    'last_reconciliation': self.last_reconciliation.isoformat()
}
json.dump(state, f)
```

**如果用 Node.js**：
- 需要 TypeScript 类型定义
- 需要 ORM 或手动 SQL
- 序列化/反序列化更复杂

### 4. 数学表达式更清晰

**Python**：
```python
# Greeks 计算（伪代码）
delta = norm.cdf(d1)
gamma = norm.pdf(d1) / (S * sigma * sqrt(T))
theta = -(S * norm.pdf(d1) * sigma) / (2 * sqrt(T)) \
        - r * K * exp(-r * T) * norm.cdf(d2)
```

**JavaScript**（需要额外库）：
```javascript
const { erf } = require('mathjs');
// 需要手动实现标准正态分布 CDF/PDF
const normCdf = (x) => 0.5 * (1 + erf(x / Math.sqrt(2)));
// 代码冗长，可读性差
```

## 为什么不把 Greeks 改成 Node.js + Vite

### 方案 A：改写为 Node.js

**需要做的事**：
1. 重写 3000+ 行 Python 代码为 TypeScript
2. 自己实现或寻找：
   - Black-Scholes 期权定价
   - 标准正态分布函数
   - 数值优化算法
3. 迁移状态管理逻辑
4. 重新测试所有交易策略

**成本**：2-3 个月全职开发  
**收益**：几乎为零

### 方案 B：保持 Python + 添加前端

Greeks 本身就是纯后端服务，如果需要专属 UI：

**选项 1**：在主应用中集成（当前做法）
```typescript
// src/GreeksPanel.tsx
const GreeksPanel = () => {
  const positions = useFetch('/api/greeks/positions');
  return <PositionsTable data={positions} />;
};
```

**选项 2**：为 Greeks 单独构建前端
```
modules/greeks/
├── app/              # Python 后端（保持不变）
├── frontend/         # 新增 React 前端
│   ├── src/
│   ├── vite.config.ts
│   └── package.json
└── ...
```

**问题**：
- ❌ Greeks UI 功能已在主应用实现
- ❌ 增加维护负担（两套 UI）
- ❌ 用户需要在两个界面间切换

## 当前架构的优势

### 1. 关注点分离

```
┌─────────────────────────────────────┐
│   主应用 (Vite + React)             │
│   - 统一入口                        │
│   - 用户界面                        │
│   - 调用各模块 API                  │
└─────────────────────────────────────┘
            ↓ HTTP
┌─────────────────────────────────────┐
│   Greeks (Python FastAPI)           │
│   - 纯业务逻辑                      │
│   - 无 UI 耦合                      │
│   - 返回 JSON                       │
└─────────────────────────────────────┘
```

**好处**：
- ✅ Greeks 专注量化逻辑，不关心渲染
- ✅ 主应用统一 UI 风格
- ✅ 易于测试（Greeks 可独立单元测试）

### 2. 技术栈各司其职

| 模块 | 适合的技术 | 选择 |
|------|----------|------|
| 前端渲染 | React + Vite | ✅ 主应用 |
| API 网关 | Node.js | ✅ 主应用 |
| 量化计算 | Python | ✅ Greeks |
| 数据聚合 | Node.js + SQLite | ✅ Monitor/Asset |

### 3. 独立部署和扩展

```bash
# Greeks 可以独立升级
cd modules/greeks
pip install --upgrade py-vollib
python -m pytest

# 不影响主应用
cd ../..
pnpm dev  # 主应用继续运行
```

### 4. 进程隔离提升稳定性

```
主进程 (Node.js)
  ├── Monitor 模块 (子进程)
  ├── Asset 模块 (子进程)
  ├── CrossEx 模块 (子进程)
  └── Greeks 模块 (Python 子进程)  ← 独立进程
```

**好处**：
- ✅ Greeks 崩溃不影响其他模块
- ✅ 可以独立重启 Greeks
- ✅ 内存隔离（Python GC 不影响 Node.js）

## 结论

### Greeks 不需要 Vite/Next.js 的原因

1. **没有前端代码**：纯后端 API 服务
2. **Python 不需要构建**：解释型语言，直接运行
3. **FastAPI 自带静态服务**：不需要额外开发服务器
4. **专注量化计算**：UI 由主应用统一提供
5. **Python 生态优势**：期权定价、科学计算库成熟

### 当前架构是正确的

```
✅ 前端需求 → React + Vite/Next.js (主应用、Monitor、Asset、CrossEx)
✅ 量化计算 → Python + FastAPI (Greeks)
✅ 统一入口 → 主应用聚合所有模块
```

### 什么情况下才需要改变

只有以下情况才考虑给 Greeks 添加前端：

1. **Greeks 需要独立部署**给其他团队使用
2. **需要复杂的交互式图表**（如实时 Greeks 曲面）
3. **主应用无法满足**的特殊 UI 需求

但即使这样，也应该：
- 保持 Python 后端（FastAPI）
- 新增独立的 `modules/greeks/frontend/` 目录
- 使用 Vite 构建前端
- **不要**重写 Python 逻辑为 Node.js

---

**文档版本**: v1.0  
**日期**: 2026-10-14  
**作者**: Claude Opus 5.5
