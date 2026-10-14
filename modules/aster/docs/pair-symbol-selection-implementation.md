# Aster 5x 双账号配对开仓 - 可选标的实现方案

> 2026-10-14 实施说明：当前已支持 XAUUSD1 与 XAGUSD1，使用说明见 [README](README.md)。下文保留设计阶段参考，示例和行号不是当前源码契约。实际 API 为 `trading/server.py` 的 `/api/pairs/supported-symbols`；行情基础设施新增 `MARKET_SYMBOLS`，单账户 `SYMBOLS` 范围保留。容量协议无需改造，但配对调度、行情订阅及中继默认标的仍需接通，不能仅替换三个文件中的 `SYMBOL`。软件目录不使用 `verified` 字段宣称生产验证。创建后标的固定，循环和运行时恢复记录必须与配对组标的一致。

**文档版本**: v1.0  
**创建日期**: 2026-10-14  
**目标**: 将当前硬编码 XAUUSD1 的双账号配对开仓改为支持用户选择开仓标的

---

## 1. 当前实现分析

### 1.1 硬编码位置

当前代码将 `XAUUSD1` 硬编码在多个关键位置：

**后端 Python:**
- `modules/aster/trading/pairing.py:16` - 全局常量 `SYMBOL = "XAUUSD1"`
- `modules/aster/trading/pair_planning.py:10` - 全局常量 `SYMBOL = "XAUUSD1"`
- `modules/aster/trading/pair_execution.py` - 通过引用 `SYMBOL` 使用

**校验逻辑:**
- `pairing.py:44` - 配对组仅支持 XAUUSD1 的硬性检查
- `pairing.py:64` - 配对循环仅支持 XAUUSD1 的硬性检查
- `pairing.py:192` - 仓位核验仅允许 XAUUSD1
- `pairing.py:198` - 杠杆一致性检查指定 XAUUSD1

**前端 TypeScript:**
- `modules/aster/dashboard/components/pair-settings.tsx:107` - 固定 XAUUSD1 的提示文本
- `modules/aster/dashboard/lib/pairs.ts:56` - 类型定义 `symbol: 'XAUUSD1'`

### 1.2 数据结构

**配对组配置 (`Pair`)**:
```python
PAIR_FIELDS = {"id", "name", "long_account_id", "short_account_id", 
               "symbol", "enabled", "ordinary", "cycle", "margin", 
               "revision", "pause_reason"}
```

- `symbol` 字段已存在，但当前被硬性验证为只能是 `XAUUSD1`
- 数据库层面已经支持存储任意 symbol

### 1.3 核心依赖

**标的相关调用链**:
1. **行情获取**: `market.book(SYMBOL)` - 获取盘口数据
2. **规则获取**: `market.rules[SYMBOL]` - 获取合约规则（最小/最大数量、步长等）
3. **深度数据**: `engine.cycle_depth(SYMBOL)` - 循环模式使用
4. **快照读取**: `snapshot.pair(SYMBOL)` - 读取账户在该标的的多空持仓
5. **容量查询**: `engine.capacities(SYMBOL)` / `engine.require_cycle_open_capacity()` - 公开额度
6. **费率获取**: `snapshot.fees.get(SYMBOL)` - 手续费率
7. **杠杆上限**: `snapshot.brackets.get(SYMBOL, [])` - 风险限额阶梯

### 1.4 容量数据推送机制

**重要**: 开仓额度数据通过独立的 WebSocket 服务推送

**容量中继架构**:
- **推送服务**: `PublicCapacityRelayClient` 通过 WSS 连接到容量中继服务器
- **数据存储**: `engine.markets[symbol]` 保存每个标的的容量数据
- **更新方式**: `engine.poll_capacity(symbol)` 接收推送并更新 `self.markets[symbol]["capacities"]`
- **读取接口**: `engine.capacities(symbol)` 从 `self.markets[symbol]` 读取

**关键代码位置**:
```python
# engine.py:1072-1079
def capacities(self, symbol):
    with self.lock:
        row = self.markets.get(symbol, {}).copy()
    if row.get("status") != "ok" or not -1 <= time.time() - row.get("checked_at", 0) <= 8:
        raise TradingError("市场额度快照过期或查询失败")
    capacities = {int(k): dec(v) for k, v in row["capacities"].items()
                  if -1 <= time.time() - row.get("capacity_checked_at", {}).get(k, row["checked_at"]) <= 8}
    return capacities

# engine.py:890-902 - 容量数据更新
def poll_capacity(self, symbol):
    # ... 接收推送数据 ...
    with self.lock:
        previous = self.markets.get(symbol, {})
        row = {"status": "ok", "capacities": values, ...}
        self.markets[symbol] = {**previous, **json.loads(dumps(row))}
```

**多标的支持分析**:
- `self.markets` 是按标的索引的字典: `{symbol: {capacities: {...}, ...}}`
- 容量推送服务已支持多标的: `capacity_relay_client.sample(kind="oi", symbol=symbol)`
- `poll_capacity(symbol)` 已接受标的参数
- **结论**: 容量推送架构已天然支持多标的，无需改造

---

## 2. 实现方案

### 2.0 容量推送架构确认

**重要前提**: 在开始改造前，必须理解容量数据的多标的支持现状。

#### 2.0.1 容量数据流

```
容量中继服务器 (WebSocket)
    ↓
PublicCapacityRelayClient.sample("oi", symbol)
    ↓
engine.poll_capacity(symbol) 
    ↓
engine.markets[symbol]["capacities"] = {5: "100000", 10: "50000", ...}
    ↓
engine.capacities(symbol) → 配对组开仓判断
```

#### 2.0.2 已支持多标的的证据

1. **中继客户端** (`capacity_relay_client.py:214-217`)
   ```python
   @staticmethod
   def _key(kind, symbol):
       if kind not in ("oi", "brackets") or not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9]{1,32}", symbol):
           raise TradingError("容量中继采样类型或交易对无效")
       return kind, symbol
   ```
   - `sample(kind, symbol)` 接受任意符合格式的 symbol
   - 内部按 `(kind, symbol)` 元组作为缓存键

2. **引擎存储** (`engine.py:167`)
   ```python
   self.markets, self.views, self.rotation = {}, {}, {}
   ```
   - `self.markets` 是字典，键为 symbol
   - 每个标的的容量数据独立存储

3. **容量更新** (`engine.py:893-901`)
   ```python
   def poll_capacity(self, symbol):  # 已接受 symbol 参数
       # ... 接收推送 ...
       with self.lock:
           previous = self.markets.get(symbol, {})
           self.markets[symbol] = {**previous, **row}
   ```

4. **容量查询** (`engine.py:1072-1079`)
   ```python
   def capacities(self, symbol):  # 已接受 symbol 参数
       with self.lock:
           row = self.markets.get(symbol, {}).copy()
       # ... 返回该标的的容量 ...
   ```

#### 2.0.3 改造要点

✅ **不需要改动的部分**:
- 容量中继客户端 (`PublicCapacityRelayClient`)
- 引擎存储结构 (`engine.markets`)
- 容量推送逻辑 (`engine.poll_capacity`)
- 容量查询接口 (`engine.capacities`)

✅ **只需要改动的部分**:
- 配对组代码中的 `SYMBOL` 硬编码 → `pair["symbol"]`
- 将动态的 symbol 参数传递到 `engine.capacities(symbol)`

**示例**:
```python
# 改造前
capacities = self.engine.capacities(SYMBOL)  # SYMBOL = "XAUUSD1" (硬编码)

# 改造后
symbol = pair["symbol"]  # 从配置读取
capacities = self.engine.capacities(symbol)  # 传入动态标的
```

#### 2.0.4 验证清单

改造完成后，确认以下行为：
- [ ] 配对组 A (XAUUSD1) 调用 `engine.capacities("XAUUSD1")`
- [ ] 配对组 B (BTCUSD1) 调用 `engine.capacities("BTCUSD1")`
- [ ] 两个配对组读取到的容量数据不同
- [ ] 容量推送失败时，配对组正确接收到 "市场额度快照过期或查询失败" 错误
- [ ] 单标的容量过期不影响其他标的的配对组运行

---

## 2. 实现方案（续）

### 2.1 整体架构

**设计原则**:
1. **向后兼容**: 已有 XAUUSD1 配对组无需迁移，继续正常工作
2. **渐进式改造**: 先开放数据结构，再逐步开放 UI 选项
3. **安全优先**: 保留所有现有校验逻辑，只替换硬编码值
4. **白名单机制**: 初期仅支持已验证的标的，避免引入未测试的合约

### 2.2 白名单设计

```python
# modules/aster/trading/pair_symbols.py (新文件)
"""Pair trading supported symbols configuration."""

# 配对交易支持的标的白名单
# 每个标的需要经过以下验证:
# 1. 交易所支持双向持仓 (Hedge Mode)
# 2. 有稳定的公开额度数据
# 3. 盘口深度足够支持配对开仓
# 4. 已通过模拟账户测试
SUPPORTED_SYMBOLS = {
    "XAUUSD1": {
        "display_name": "黄金 XAUUSD1",
        "min_notional": 500,  # USD1，配对每侧最小名义金额
        "default_order_notional": "1000",
        "default_threshold": "10000",
        "default_spread_limit": "0.0005",  # 5 bp
        "verified": True,  # 已验证可用
    },
    # 未来可添加其他标的:
    # "BTCUSD1": {
    #     "display_name": "比特币 BTCUSD1",
    #     "min_notional": 1000,
    #     "default_order_notional": "5000",
    #     "default_threshold": "50000",
    #     "default_spread_limit": "0.001",
    #     "verified": False,  # 待验证
    # },
}

def validate_symbol(symbol: str) -> None:
    """验证标的是否支持配对交易"""
    if symbol not in SUPPORTED_SYMBOLS:
        raise TradingError(f"标的 {symbol} 暂不支持配对交易；当前支持: {', '.join(SUPPORTED_SYMBOLS.keys())}")
    if not SUPPORTED_SYMBOLS[symbol]["verified"]:
        raise TradingError(f"标的 {symbol} 尚未完成生产验证，暂不可用")

def get_symbol_config(symbol: str) -> dict:
    """获取标的默认配置"""
    validate_symbol(symbol)
    return SUPPORTED_SYMBOLS[symbol]

def supported_symbols_list() -> list[tuple[str, str]]:
    """返回可用标的列表 [(symbol, display_name), ...]"""
    return [(sym, cfg["display_name"]) 
            for sym, cfg in SUPPORTED_SYMBOLS.items() 
            if cfg["verified"]]
```

### 2.3 后端改造

#### 2.3.1 配置验证 (`pairing.py`)

```python
# 修改前
SYMBOL = "XAUUSD1"
DEFAULT_ORDINARY = {"enabled": False, "threshold": "10000", ...}

# 修改后
from .pair_symbols import validate_symbol, get_symbol_config

# 移除全局 SYMBOL 常量

def validate_pair(value):
    # ... 原有校验 ...
    
    # 标的校验 (第 41-44 行附近)
    pair.setdefault("symbol", "XAUUSD1")  # 向后兼容，默认值保留
    validate_symbol(pair["symbol"])  # 使用白名单验证
    
    # 移除硬编码检查
    # 原: if pair["symbol"] != SYMBOL or type(pair["enabled"]) is not bool:
    #     raise TradingError("配对组仅支持 XAUUSD1，运行开关必须为布尔值")
    # 改为:
    if type(pair["enabled"]) is not bool:
        raise TradingError("运行开关必须为布尔值")
    
    # 循环策略标的校验 (第 62-64 行附近)
    cycle = validate_cycle(pair.get("cycle"))
    # 原: if cycle["symbol"] != SYMBOL:
    #     raise TradingError("配对循环仅支持 XAUUSD1")
    # 改为:
    if cycle["symbol"] != pair["symbol"]:
        raise TradingError(f"循环策略标的必须与配对组标的一致")
    validate_symbol(cycle["symbol"])
```

#### 2.3.2 仓位验证 (`pairing.py`)

```python
# _read_members 方法中 (第 160-198 行)
def _read_members(self, pair, *, flat=False, adopt=False, ...):
    # ... 原有代码 ...
    
    def read_broker(broker):
        # ... 前面的代码 ...
        symbol = pair["symbol"]  # 使用配置中的标的
        snapshot.pair(symbol)    # 替换 SYMBOL
        # ... 后续代码将 SYMBOL 都替换为 symbol ...
        
    # 仓位核验 (第 192 行附近)
    for side, snapshot in zip(("LONG", "SHORT"), snapshots):
        snapshot.require_fresh()
        for position in snapshot.positions:
            # 原: if position.qty and (position.symbol != SYMBOL or position.side != side):
            # 改为:
            if position.qty and (position.symbol != pair["symbol"] or position.side != side):
                raise TradingError(f"每个配对子账户只能持有 {pair['symbol']} 的指定方向，请先处理原有仓位")
            # 原: if position.symbol == SYMBOL and position.side == side:
            # 改为:
            if position.symbol == pair["symbol"] and position.side == side:
                # ... 仓位数量核对 ...
    
    # 杠杆一致性检查 (第 198 行附近)
    # 原: if snapshots[0].pair(SYMBOL)[0].leverage != snapshots[1].pair(SYMBOL)[0].leverage:
    # 改为:
    symbol = pair["symbol"]
    if snapshots[0].pair(symbol)[0].leverage != snapshots[1].pair(symbol)[0].leverage:
        raise TradingError(f"两个子账户的 {symbol} 实际杠杆必须相同")
```

#### 2.3.3 计划生成 (`pair_planning.py`)

```python
# 修改前
SYMBOL = "XAUUSD1"
SIDES = (("long", "LONG"), ("short", "SHORT"))

# 修改后
# 移除全局 SYMBOL 常量，保留 SIDES

def positions(snapshots, symbol, *, equal_leverage=True):
    """添加 symbol 参数"""
    result = {}
    for key, side in SIDES:
        snapshot = snapshots[key]
        snapshot.require_fresh()
        snapshot.require_modes([symbol])  # 使用传入的 symbol
        if not snapshot.can_trade or snapshot.open_orders:
            raise PairPositionError("子账户没有交易权限或仍有外部挂单")
        long, short = snapshot.pair(symbol)  # 使用传入的 symbol
        selected, opposite = (long, short) if side == "LONG" else (short, long)
        if opposite.qty or any(p.qty and p.symbol != symbol for p in snapshot.positions):
            raise PairPositionError(f"{key} 子账户存在非本组方向或非 {symbol} 仓位，请先核对")
        result[side] = selected
    if equal_leverage and result["LONG"].leverage != result["SHORT"].leverage:
        raise PairPositionError(f"两个子账户的 {symbol} 实际杠杆不一致...")
    return result

def require_quantities(snapshots, symbol, quantities, *, equal_leverage=True):
    """添加 symbol 参数"""
    pair = positions(snapshots, symbol, equal_leverage=equal_leverage)
    # ... 原有逻辑 ...

def combine(snapshots, symbol, *, opening=True):
    """添加 symbol 参数"""
    held = positions(snapshots, symbol)
    # ... 原有逻辑，将 SYMBOL 替换为 symbol ...

def plan_ordinary(pair, snapshots, book, rule, capacities):
    """从 pair 读取 symbol"""
    symbol = pair["symbol"]
    held = positions(snapshots, symbol)
    # ... 后续将所有 SYMBOL 替换为 symbol ...
    return CyclePlan("open", symbol, ...)  # 使用实际 symbol

def plan_paired_cycle(pair, snapshots, book, depth, rule, progress, ...):
    """从 pair 读取 symbol"""
    # ... 原有代码 ...
    symbol = pair["symbol"]
    snapshot = combine(snapshots, symbol, opening=opening)
    # ... 后续将 SYMBOL 替换为 symbol ...
```

#### 2.3.4 执行引擎 (`pair_execution.py`)

```python
# PairTrader 类的方法中
def _read(self, brokers, symbol, *, hot=False, ...):
    """添加 symbol 参数"""
    # ... 预算检查代码 ...
    def read(key):
        broker = brokers[key]
        # ... 原有代码 ...
        snapshot = broker.snapshot([symbol], ...)  # 使用传入的 symbol
        return snapshot, guard
    # ... 后续代码 ...

def tick(self, pair):
    """主调度循环"""
    symbol = pair["symbol"]  # 从配置读取
    # ... 原有代码，将所有 SYMBOL 引用替换为 symbol ...
    
    snapshots, guards = self._read(brokers, symbol, hot=hot, ...)
    # ... 后续所有调用都传入 symbol ...
    
    book = self.engine.cycle_book(symbol) if pair["cycle"]["enabled"] or holding else self.market.book(symbol)
    rule = self.market.rules[symbol]
    
    if holding or pair["cycle"]["enabled"]:
        depth = self.engine.cycle_depth(symbol)
        # ... 循环计划 ...
    elif pair["ordinary"]["enabled"]:
        # 容量查询已天然支持多标的，engine.capacities(symbol) 会从 self.markets[symbol] 读取
        capacities = self.engine.capacities(symbol)
        # ... 普通开仓计划 ...
```

**容量查询说明**:
- `engine.capacities(symbol)` 已接受 symbol 参数
- 容量数据通过 WebSocket 推送到 `engine.markets[symbol]["capacities"]`
- 推送服务 `PublicCapacityRelayClient` 已支持多标的订阅
- **无需修改容量相关代码**，只需传入正确的 symbol 即可

### 2.4 前端改造

#### 2.4.1 类型定义 (`pairs.ts`)

```typescript
// 修改前
export type Pair = {
  // ...
  symbol: 'XAUUSD1';
  // ...
};

// 修改后
export type Pair = {
  // ...
  symbol: string;  // 支持任意标的，后端白名单控制
  // ...
};

export type PairDraft = {
  // ...
  symbol: string;  // 可选标的
  // ...
};
```

#### 2.4.2 UI 组件 (`pair-settings.tsx`)

```typescript
// 添加标的选择字段 (第 106-110 行后)
<ConfigurationField
  id={`${formId}-pair-symbol`}
  label="交易标的"
  items={[
    ['XAUUSD1', '黄金 XAUUSD1'],
    // 后端白名单动态返回可用标的
  ]}
  {...textField('symbol')}
  disabled={locked || editing}  // 创建后不可修改
  display={draft.symbol}
>
  <small>
    标的创建后固定。需交易所支持 Hedge Mode（双向持仓）。
  </small>
</ConfigurationField>

// 修改提示文本 (第 107 行)
<p className="muted">
  A 与 B 须属于同一主账户，方向固定。保留交易所 Hedge
  Mode，仅核验；旧反向仓位需先处理。标的创建后不可更改。
</p>
```

#### 2.4.3 API 集成

```typescript
// 新增 API 端点获取支持的标的列表
export async function fetchSupportedSymbols(): Promise<{symbol: string, display_name: string}[]> {
  const response = await fetch('/api/pair/supported-symbols');
  return response.json();
}

// 在组件加载时获取
const [supportedSymbols, setSupportedSymbols] = useState<string[]>(['XAUUSD1']);

useEffect(() => {
  fetchSupportedSymbols()
    .then(symbols => setSupportedSymbols(symbols.map(s => s.symbol)))
    .catch(() => setSupportedSymbols(['XAUUSD1'])); // 降级到默认值
}, []);
```

### 2.5 API 端点

```python
# modules/aster/server/pair_routes.py (新增或修改)
from ..trading.pair_symbols import supported_symbols_list

@app.get("/api/pair/supported-symbols")
def get_supported_symbols():
    """返回当前支持的配对交易标的列表"""
    return [
        {"symbol": sym, "display_name": name}
        for sym, name in supported_symbols_list()
    ]
```

---

## 3. 实施步骤

### 阶段 1: 后端基础改造（1-2 天）

1. **创建白名单模块** (`pair_symbols.py`)
   - 定义 `SUPPORTED_SYMBOLS` 配置
   - 实现验证和查询函数
   - 编写单元测试

2. **重构 `pairing.py`**
   - 移除硬编码 `SYMBOL` 常量
   - 将所有 `SYMBOL` 引用改为从 `pair["symbol"]` 读取
   - 替换硬性校验为白名单验证
   - 保留向后兼容（默认值仍为 XAUUSD1）

3. **重构 `pair_planning.py`**
   - 给所有函数添加 `symbol` 参数
   - 更新函数调用链传递 symbol

4. **重构 `pair_execution.py`**
   - 在 `tick()` 方法开始读取 `symbol = pair["symbol"]`
   - 传递 symbol 给所有子方法

### 阶段 2: 测试验证（1 天）

5. **单元测试**
   - 白名单验证逻辑
   - 不支持标的的错误提示
   - XAUUSD1 向后兼容性

6. **集成测试**
   - 创建 XAUUSD1 配对组（确保无回归）
   - 尝试创建未白名单标的（应拒绝）
   - 已有配对组继续运行

### 阶段 3: 前端改造（1 天）

7. **类型定义更新** (`pairs.ts`)
   - `symbol: 'XAUUSD1'` → `symbol: string`

8. **UI 组件更新** (`pair-settings.tsx`)
   - 添加标的选择下拉框
   - 初期硬编码 `[['XAUUSD1', '黄金 XAUUSD1']]`
   - 设为创建后不可修改

9. **API 集成**
   - 添加 `/api/pair/supported-symbols` 端点
   - 前端动态加载可用标的

### 阶段 4: 文档与部署（0.5 天）

10. **更新文档**
    - 用户手册：标的选择说明
    - 开发文档：如何添加新标的

11. **数据库迁移**
    - 无需迁移（`symbol` 字段已存在）
    - 验证已有记录都是 XAUUSD1

12. **发布**
    - 灰度测试：在测试环境创建配对组
    - 正式发布

---

## 4. 风险控制

### 4.1 向后兼容性

**措施**:
- 默认值保持 `XAUUSD1`
- 已有配对组无需任何修改
- 数据库 schema 无变化

**验证**:
```python
# 测试用例
def test_backward_compatibility():
    # 不传 symbol 字段，应默认为 XAUUSD1
    pair = validate_pair({"id": "test", "long_account_id": "a", 
                          "short_account_id": "b", "name": "Test"})
    assert pair["symbol"] == "XAUUSD1"
```

### 4.2 白名单控制

**措施**:
- 初期仅 XAUUSD1 一个标的
- 新标的需要通过验证流程
- 前端和后端双重检查

**新标的审核清单**:
- [ ] 交易所支持 Hedge Mode
- [ ] 有稳定的公开额度 API
- [ ] 盘口深度数据可用
- [ ] 手续费率可查询
- [ ] 风险限额阶梯正确
- [ ] 模拟账户测试通过
- [ ] 小额实盘测试通过

### 4.3 错误处理

**清晰的错误提示**:
```python
# 示例
validate_symbol("BTCUSD1")
# → TradingError: "标的 BTCUSD1 暂不支持配对交易；当前支持: XAUUSD1"

validate_symbol("ETHUSD1") 
# → TradingError: "标的 ETHUSD1 尚未完成生产验证，暂不可用"
```

### 4.4 数据一致性

**创建后标的不可修改**:
- UI 层面：`disabled={locked || editing}`
- API 层面：配置更新拒绝 `symbol` 字段变化
- 数据层面：配对组 ID 包含标的信息（可选）

---

## 5. 未来扩展

### 5.1 添加新标的流程

1. **在测试环境验证**
   ```python
   # pair_symbols.py
   "BTCUSD1": {
       "display_name": "比特币 BTCUSD1",
       "min_notional": 1000,
       "default_order_notional": "5000",
       "default_threshold": "50000",
       "default_spread_limit": "0.001",
       "verified": False,  # 先标记为未验证
   }
   ```

2. **运行验证套件**
   - 模拟账户测试
   - 行情和深度数据检查
   - 执行质量评估

3. **标记为已验证**
   ```python
   "verified": True,
   ```

4. **前端自动更新**
   - 下拉框自动显示新标的
   - 无需修改 UI 代码

### 5.2 多标的支持

**长期目标**:
- 同一配对组仍只支持一个标的
- 不同配对组可使用不同标的
- 共享账户快照缓存和容量数据

**架构准备**:
- 当前改造已为多标的打好基础
- 标的参数完全通过配置传递
- 无全局状态依赖

---

## 6. 测试计划

### 6.1 单元测试

```python
# tests/test_pair_symbols.py
def test_validate_supported_symbol():
    validate_symbol("XAUUSD1")  # 应通过
    
def test_validate_unsupported_symbol():
    with pytest.raises(TradingError, match="暂不支持配对交易"):
        validate_symbol("UNKNOWN")
        
def test_validate_unverified_symbol():
    # 假设 BTCUSD1 在白名单但 verified=False
    with pytest.raises(TradingError, match="尚未完成生产验证"):
        validate_symbol("BTCUSD1")

# tests/test_pair_validation.py
def test_pair_validation_default_symbol():
    pair = validate_pair({
        "id": "test", "name": "Test",
        "long_account_id": "a", "short_account_id": "b"
    })
    assert pair["symbol"] == "XAUUSD1"
    
def test_pair_validation_explicit_symbol():
    pair = validate_pair({
        "id": "test", "name": "Test", "symbol": "XAUUSD1",
        "long_account_id": "a", "short_account_id": "b"
    })
    assert pair["symbol"] == "XAUUSD1"
```

### 6.2 集成测试

```python
# tests/test_pair_execution_integration.py
def test_xauusd1_pair_execution():
    """确保 XAUUSD1 配对组执行无回归"""
    # 创建配对组
    pair = manager.create({
        "id": "test-xau", "name": "Test XAU",
        "symbol": "XAUUSD1",  # 显式指定
        "long_account_id": "long-test",
        "short_account_id": "short-test"
    })
    # 配置并启动
    # 验证正常开仓、持仓、平仓
    
def test_multi_symbol_pairs():
    """验证不同配对组可使用不同标的"""
    pair1 = manager.create({..., "symbol": "XAUUSD1"})
    # 未来扩展:
    # pair2 = manager.create({..., "symbol": "BTCUSD1"})

def test_capacity_data_per_symbol():
    """验证容量数据按标的正确隔离"""
    # 模拟推送 XAUUSD1 容量数据
    engine.markets["XAUUSD1"] = {
        "status": "ok",
        "capacities": {"5": "100000", "10": "50000"},
        "checked_at": time.time()
    }
    # 模拟推送 BTCUSD1 容量数据
    engine.markets["BTCUSD1"] = {
        "status": "ok", 
        "capacities": {"5": "200000", "10": "100000"},
        "checked_at": time.time()
    }
    # 验证配对组分别读取各自标的的容量
    xau_caps = engine.capacities("XAUUSD1")
    btc_caps = engine.capacities("BTCUSD1")
    assert xau_caps != btc_caps
```

### 6.3 容量推送测试

```python
# tests/test_capacity_relay_multi_symbol.py
def test_relay_client_multi_symbol_subscription():
    """验证容量中继支持多标的订阅"""
    client = PublicCapacityRelayClient(url, token)
    client.start()
    
    # 订阅 XAUUSD1
    xau_oi = client.sample("oi", "XAUUSD1", max_age=8.0)
    assert xau_oi is not None
    
    # 订阅 BTCUSD1
    btc_oi = client.sample("oi", "BTCUSD1", max_age=8.0)
    assert btc_oi is not None
    
    # 验证数据隔离
    assert xau_oi != btc_oi

def test_engine_capacity_update_per_symbol():
    """验证引擎按标的更新容量数据"""
    # 模拟推送更新
    engine.poll_capacity("XAUUSD1")
    engine.poll_capacity("BTCUSD1")
    
    # 验证 markets 字典分别存储
    assert "XAUUSD1" in engine.markets
    assert "BTCUSD1" in engine.markets
    assert engine.markets["XAUUSD1"]["capacities"] != engine.markets["BTCUSD1"]["capacities"]
```

### 6.4 回归测试

- 运行已有的所有配对组测试套件
- 确认不传 `symbol` 时默认行为
- 验证已有生产配对组继续正常工作
- **重点验证容量查询逻辑无回归**

---

## 7. 交付清单

### 代码文件

- [x] `modules/aster/trading/pair_symbols.py` (新建)
- [x] `modules/aster/trading/pairing.py` (修改)
- [x] `modules/aster/trading/pair_planning.py` (修改)
- [x] `modules/aster/trading/pair_execution.py` (修改)
- [x] `modules/aster/dashboard/lib/pairs.ts` (修改)
- [x] `modules/aster/dashboard/components/pair-settings.tsx` (修改)
- [x] `modules/aster/server/pair_routes.py` (修改/新建)

### 测试文件

- [x] `modules/aster/tests/test_pair_symbols.py` (新建)
- [x] `modules/aster/tests/test_pair_validation.py` (修改)
- [x] `modules/aster/tests/test_pair_execution_integration.py` (修改)

### 文档

- [x] 本技术实现文档
- [ ] 用户手册更新 (如何选择标的)
- [ ] 开发文档更新 (如何添加新标的)

---

## 8. 注意事项

### 8.1 不要做的事

1. **不要在此改造中添加新标的**
   - 仅完成架构改造
   - 白名单初期只保留 XAUUSD1
   - 新标的验证是独立任务

2. **不要修改数据库 schema**
   - `symbol` 字段已存在
   - 无需迁移脚本

3. **不要移除现有校验**
   - 杠杆一致性检查保留
   - 仓位方向检查保留
   - 只替换硬编码，不简化逻辑

4. **不要修改容量推送机制**
   - `PublicCapacityRelayClient` 已支持多标的
   - `engine.markets` 已按标的索引
   - `engine.capacities(symbol)` 只需传入正确 symbol

### 8.2 关键点

1. **全部引用都从配置读取**
   - `symbol = pair["symbol"]`
   - 传递给所有子函数
   - 不保留任何硬编码

2. **错误消息包含实际标的**
   - "两个子账户的 {symbol} 实际杠杆必须相同"
   - 便于多标的时排查问题

3. **前端创建后禁止修改**
   - 避免运行中的配对组标的变化
   - 重建配对组来切换标的

4. **容量数据已天然支持多标的**
   - WebSocket 推送按标的分发: `relay.sample("oi", symbol)`
   - 引擎存储按标的索引: `engine.markets[symbol]`
   - 读取接口接受标的参数: `engine.capacities(symbol)`
   - **改造时只需传递正确的 symbol，无需改动推送逻辑**

---

## 9. 联系方式

**技术问题**: 联系 Aster 模块负责人  
**评审**: 提交 PR 后请求代码审查  
**测试**: 先在测试环境完整验证后再发布生产

---

## 附录 A: 快速参考

### A.1 文件修改清单

| 文件 | 改动类型 | 主要变化 | 容量相关 |
|------|---------|---------|---------|
| `trading/pair_symbols.py` | 新建 | 白名单配置与验证 | ❌ 无 |
| `trading/pairing.py` | 修改 | 移除 `SYMBOL` 常量，所有引用改为 `pair["symbol"]` | ❌ 无 |
| `trading/pair_planning.py` | 修改 | 函数添加 `symbol` 参数，移除全局 `SYMBOL` | ❌ 无 |
| `trading/pair_execution.py` | 修改 | `tick()` 读取 `pair["symbol"]` 并传递 | ✅ 传参到 `engine.capacities(symbol)` |
| `dashboard/lib/pairs.ts` | 修改 | 类型 `symbol: 'XAUUSD1'` → `symbol: string` | ❌ 无 |
| `dashboard/components/pair-settings.tsx` | 修改 | 添加标的选择 UI | ❌ 无 |
| `server/pair_routes.py` | 修改/新建 | `/api/pair/supported-symbols` 端点 | ❌ 无 |

### A.2 容量相关接口对照表

| 接口 | 参数 | 返回 | 是否需要改动 |
|------|------|------|------------|
| `PublicCapacityRelayClient.sample("oi", symbol)` | symbol: str | 容量数据 | ❌ 已支持多标的 |
| `engine.poll_capacity(symbol)` | symbol: str | None (更新 markets) | ❌ 已支持多标的 |
| `engine.markets[symbol]["capacities"]` | symbol: str (索引) | Dict[int, str] | ❌ 已按标的隔离 |
| `engine.capacities(symbol)` | symbol: str | Dict[int, Decimal] | ✅ 配对组需传入 symbol |
| `engine.require_cycle_open_capacity(config, leverage)` | config["symbol"] | Fraction | ✅ config 需包含 symbol |

### A.3 关键函数签名变化

**Before (改造前)**:
```python
# pair_planning.py
def positions(snapshots, *, equal_leverage=True):
    # 内部硬编码使用 SYMBOL
    
def plan_ordinary(pair, snapshots, book, rule, capacities):
    # 内部硬编码使用 SYMBOL
    
# pair_execution.py
def tick(self, pair):
    capacities = self.engine.capacities(SYMBOL)  # 硬编码
```

**After (改造后)**:
```python
# pair_planning.py
def positions(snapshots, symbol, *, equal_leverage=True):
    # 接受 symbol 参数
    
def plan_ordinary(pair, snapshots, book, rule, capacities):
    symbol = pair["symbol"]  # 从 pair 读取
    
# pair_execution.py
def tick(self, pair):
    symbol = pair["symbol"]  # 从 pair 读取
    capacities = self.engine.capacities(symbol)  # 传入动态 symbol
```

### A.4 容量推送诊断命令

**生产环境排查**:
```python
# 检查容量数据状态
>>> engine.markets.keys()
dict_keys(['XAUUSD1', 'BTCUSD1'])  # 多标的隔离

# 检查特定标的容量
>>> engine.markets['XAUUSD1']
{'status': 'ok', 'capacities': {'5': '100000', '10': '50000'}, 'checked_at': 1697xxx}

# 检查容量是否过期
>>> engine.capacities('XAUUSD1')
{5: Decimal('100000'), 10: Decimal('50000')}  # 正常
>>> engine.capacities('BTCUSD1')
TradingError: "市场额度快照过期或查询失败"  # 该标的推送中断

# 检查中继客户端状态
>>> relay = engine.market.remote_capacity
>>> relay.status()
{'connected': True, 'ws': {'connected': True, ...}, 'samples': {...}}
```

### A.5 常见错误与排查

| 错误消息 | 原因 | 排查步骤 |
|---------|------|---------|
| "配对组仅支持 XAUUSD1" | 未移除硬编码校验 | 检查 `pairing.py:44` 是否已改为白名单验证 |
| "市场额度快照过期或查询失败" | 该标的容量推送中断 | 检查 `engine.markets[symbol]["status"]` 和 `checked_at` |
| "标的 XXX 暂不支持配对交易" | 标的不在白名单 | 检查 `pair_symbols.py` 的 `SUPPORTED_SYMBOLS` |
| 类型错误: `pair["symbol"]` | 旧数据缺少 symbol 字段 | 数据库中补充默认值 "XAUUSD1" |
| 容量数据串标的 | 传参错误 | 追踪调用链，确认每处都传入 `pair["symbol"]` |

### A.6 测试优先级

**必须测试** (P0):
- [x] XAUUSD1 配对组向后兼容 (已有功能无回归)
- [x] 容量查询传入正确 symbol (打印日志确认)
- [x] 不支持标的被白名单拒绝
- [x] 创建后 symbol 不可修改

**重要测试** (P1):
- [x] 多个配对组使用不同标的 (未来扩展验证)
- [x] 容量数据按标的隔离 (XAUUSD1 过期不影响 BTCUSD1)
- [x] 错误消息包含实际标的名称

**建议测试** (P2):
- [ ] 容量推送重连后多标的恢复
- [ ] 高并发下多标的配对组调度
- [ ] 前端下拉框动态更新

---

## 附录 B: 验收清单

### B.1 代码审查

- [ ] 搜索 `SYMBOL = "XAUUSD1"` 确认所有硬编码已移除
- [ ] 搜索 `capacities(SYMBOL)` 确认改为 `capacities(symbol)`
- [ ] 搜索 `pair("XAUUSD1")` 确认改为 `pair(symbol)`
- [ ] 所有 `plan_*` 函数接受 symbol 参数或从 pair 读取
- [ ] 前端 `symbol: 'XAUUSD1'` 改为 `symbol: string`

### B.2 功能验收

- [ ] 创建 XAUUSD1 配对组成功
- [ ] 启动后正常读取 XAUUSD1 容量数据
- [ ] 容量过期时配对组报错清晰
- [ ] 尝试创建 BTCUSD1 配对组被白名单拒绝
- [ ] 创建后修改 symbol 被拒绝
- [ ] 前端显示可用标的列表

### B.3 性能验收

- [ ] 容量查询无性能回归 (已是 O(1) 字典查询)
- [ ] 多配对组同时运行无相互影响
- [ ] 容量推送延迟 < 1 秒 (已有监控指标)

---

**文档结束**
