# Aster 5x 配对开仓可选标的 - 快速摘要

> 本文为设计阶段摘要。当前已实现黄金 XAUUSD1、白银 XAGUSD1，实际范围与使用说明见 [README](README.md)；容量协议支持多标的不等于调度和中继默认订阅已自动支持。

**完整文档**: [pair-symbol-selection-implementation.md](pair-symbol-selection-implementation.md)

## 核心改动

将硬编码的 `XAUUSD1` 改为从配置读取，支持未来添加其他标的。

```python
# 改造前
SYMBOL = "XAUUSD1"
capacities = engine.capacities(SYMBOL)

# 改造后
symbol = pair["symbol"]
capacities = engine.capacities(symbol)
```

## 关键发现：容量推送已支持多标的 ✅

- **WebSocket 推送**: `PublicCapacityRelayClient.sample("oi", symbol)` 已接受 symbol 参数
- **引擎存储**: `engine.markets[symbol]["capacities"]` 已按标的索引
- **查询接口**: `engine.capacities(symbol)` 已接受 symbol 参数

**结论**: 容量架构无需改动，只需配对组代码传入正确的 symbol。

## 改动文件（7 个）

| 文件 | 类型 | 说明 |
|------|------|------|
| `trading/pair_symbols.py` | 新建 | 白名单配置（初期仅 XAUUSD1）|
| `trading/pairing.py` | 修改 | 移除 `SYMBOL` 常量，从 `pair["symbol"]` 读取 |
| `trading/pair_planning.py` | 修改 | 函数添加 `symbol` 参数 |
| `trading/pair_execution.py` | 修改 | 传递 symbol 到容量查询 |
| `dashboard/lib/pairs.ts` | 修改 | 类型改为 `symbol: string` |
| `dashboard/components/pair-settings.tsx` | 修改 | 添加标的选择 UI |
| `server/pair_routes.py` | 新增 | `/api/pair/supported-symbols` 端点 |

## 实施时间线

- **阶段 1**: 后端改造 (1-2 天)
- **阶段 2**: 测试验证 (1 天)
- **阶段 3**: 前端改造 (1 天)
- **阶段 4**: 部署上线 (0.5 天)

**总计**: 3.5-4.5 天

## 安全保障

✅ **零数据迁移** - symbol 字段已存在  
✅ **完全向后兼容** - 默认值仍为 XAUUSD1  
✅ **白名单控制** - 初期仅支持 XAUUSD1  
✅ **容量推送无忧** - 架构已支持多标的

## 验收标准

```bash
# 1. 创建 XAUUSD1 配对组（已有功能）
POST /api/pair {symbol: "XAUUSD1", ...}  # 成功

# 2. 尝试创建未支持标的
POST /api/pair {symbol: "BTCUSD1", ...}  # 拒绝：暂不支持

# 3. 容量查询正确传参
engine.capacities("XAUUSD1")  # 读取 XAUUSD1 的容量
engine.capacities("BTCUSD1")  # 未来：读取 BTCUSD1 的容量

# 4. 确认无硬编码残留
grep -r "SYMBOL = " trading/  # 应为空
```

## 关键注意事项

⚠️ **不要改动容量推送代码** - 已天然支持多标的  
⚠️ **不要在此次添加新标的** - 仅完成架构改造  
⚠️ **不要修改数据库 schema** - 字段已存在  
⚠️ **不要移除现有校验** - 只替换硬编码

## 联系方式

- 完整技术方案: [pair-symbol-selection-implementation.md](pair-symbol-selection-implementation.md) (996 行)
- 问题反馈: Aster 模块负责人
- 代码审查: 提交 PR 后请求评审

---

*文档版本: v1.0 | 创建日期: 2026-10-14*
