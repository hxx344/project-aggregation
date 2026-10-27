# BTC 期权回测（options-backtest）

在服务器上用 Deribit 小时级原始报价回测 BTC 期权策略，主要通过 Claude 会话驱动，不属于工作台模块，也不随工作台发布。

## 快速开始

```bash
tools/options-backtest/bt examples                       # 列出示例策略
tools/options-backtest/bt run iron_condor                # 实盘铁鹰：周五 21:00 UTC 开仓，周日到期
tools/options-backtest/bt run iron_condor --set fill=cross --set exit.take_profit_pct=0.5
tools/options-backtest/bt sweep iron_condor --set legs.0.delta+legs.1.delta=0.3,0.35,0.4,0.45 --set fill=mid,cross
tools/options-backtest/bt chain 2025-01-03T21 --dte 2    # 查看某小时的期权链，核对选腿
```

- 首次运行时，`bt` 会在 `~/.local/share/options-backtest/venv` 建一个只装 numpy 和 pyarrow 的 venv。
- 首次读取数据时，会把每个月解析成 `.npy` 缓存，约 20 秒、900 MB。之后单次回测约 2 秒。
- `run` 在终端只打印约 6 行摘要。逐笔明细、汇总和实际使用的配置写到 `~/data/greeks/backtests/<name>/<UTC 时间>/` 下的 `trades.csv`、`summary.json`、`spec.json`。
- 加 `--json` 时，摘要输出为一行 JSON。
- `sweep` 对所有 `--set` 取值做笛卡尔积，打印排序后的对比表，完整结果写入 `sweep.csv`。
  - 用 `a+b=...` 可以让多个路径同时取同一个值，例如两条空头腿同时改 delta。

## 策略配置（spec）

配置可以是 JSON 文件、内联 JSON（以 `{` 开头）或 `examples/` 下的示例名。未写的字段取默认值，未知字段直接报错。时间一律为 UTC。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `start` / `end` | 数据首尾 | 开仓日期范围（含两端）。只写日期时，`end` 包含当天全部小时。到期结算可以超过 `end` |
| `entry.weekdays` | `null`（每天） | 如 `["fri"]` |
| `entry.hours` | `[0]` | 开仓小时列表 |
| `expiry.weekday` | `null` | 设置后选距开仓至少 `min_hours` 小时的第一个该星期几到期日（实盘规则是 `"sun"`） |
| `expiry.dte` | `2` | 未设 `weekday` 时，选离"开仓时间 + dte 天"最近的已上市到期日 |
| `expiry.min_hours` | `1` | 到期日距开仓的最少小时数 |
| `legs[]` | 必填 | 每条腿：`side` 为 `buy`/`sell`；`type` 为 `call`/`put`；`delta` 是目标绝对值，取最接近的行权价；`qty` 是相对数量；`beyond: i` 表示只在第 i 条腿的更虚值一侧选（翼）；`expiry` 可单独设置，用于日历价差 |
| `qty` | `1` | 每条腿的张数（1 张 = 1 BTC） |
| `fill` | `mid` | 成交价模型，见下方"成交价" |
| `fees` | 见下方"手续费" | `rate` / `cap_pct` / `settle_rate` / `settle_cap_pct` |
| `exit.take_profit_pct` | `null` | 浮盈 ≥ 净权利金 × 该比例时平仓 |
| `exit.stop_loss_pct` | `null` | 浮亏 ≥ 净权利金 × 该比例时平仓 |
| `exit.close_hours_before_expiry` | `null` | 到期前 N 小时平仓 |
| `max_open` | `1` | 同时持有的组合数上限，超出的开仓机会记为跳过 |
| `margin.mode` | `regular` | `regular` 为 Bybit 常规期权 Order IM；`max_loss` 用到期最大亏损，无限亏损的结构仍用 IM |

## 口径

**时间**

- 小时 H 只使用 (H−1h, H] 内最后一次快照，所以在 H 时刻下单不会看到未来报价。
- 平仓条件每小时检查一次，用平仓方向的成交价计算，并计入手续费。

**价格**

- 使用原始 `mark_price` / `bid_price` / `ask_price`。原始单位是 BTC，按该合约自己的远期价换算成美元。
- 数据来自 Deribit，用来近似实盘所在的 Bybit。
- 选腿时的 delta 用 `mark_iv` 和合约远期价，按 Black-76 现算。

**成交价**

| 模型 | 规则 |
| --- | --- |
| `mid` | 买一卖一中间价 |
| `cross` | 吃单：买在卖一，卖在买一 |
| `passive` | 挂单：买在买一，卖在卖一，和实盘下单价一致，但偏乐观 |
| `mark` | 按标记价成交 |

缺少对应盘口时退回标记价，退回的比例显示在摘要里（`mark-fallback fills`）。

**手续费**

- 交易费：每条腿 `min(rate × 标的价, cap_pct × 成交价) × 数量`，和实盘 `app/strategy.py` 一致。
- 交割费：每条实值腿 `min(settle_rate × 交割价, settle_cap_pct × 内在价值)`。0.015% 和 12.5% 是按 Bybit 公开费率填的假设值，用前请核对。

**结算**

- 到期小时用到期合约在最后一次快照里的远期价，近似 Deribit 交割价（交割价是 08:00 前 30 分钟的指数 TWAP）。
- 找不到时，依次退回到更晚到期合约的远期价、前 1–2 小时的快照、最后一次估值时的远期价。用最后一次估值远期价结算的交易，退出原因记为 `expiry_last_forward`。

**保证金**

- `regular` 模式用 Bybit 常规 Order IM 公式（同 `app/risk.py` 的 `short_order_margin`）。
- 摘要里的 `mean return/margin` 是每笔盈亏 ÷ 该笔保证金的平均值。

**暂不支持**：Delta 对冲、成交量与冲击成本、提前行权（Deribit 期权是欧式，不涉及）。

## 数据

- 默认读取 `~/data/options_hourly/BTC/YYYY-MM.parquet`，可用 `--data` 或环境变量 `OPTBT_DATA` 改。
- 文件来自用户本机原始数据经 `slim` 瘦身：每小时只保留最新快照，只留回测需要的列。
- 当前数据覆盖 2023-03-20 至 2026-03-25。

**月度缓存**：放在 `<数据目录>/.optbt-cache/v<版本>/YYYY-MM/`。以下任一情况会重建：

- 对应 parquet 的大小或修改时间变化；
- `market.py` 的 `CACHE_VERSION` 升级（`_load` 的输出改变时必须升级）。

**增加数据**：

1. 在本机运行 `python optbt/parquet.py slim <原始目录> -o <输出目录>`，需要 `pip install pyarrow numpy`。
2. 把输出文件上传到数据目录。

**parquet 工具**（`bt` 会转发给 `optbt/parquet.py`）：

| 命令 | 用途 |
| --- | --- |
| `inspect` | 检查列名和数据量 |
| `slim` | 瘦身 |
| `convert` | 生成约 16 MB 的波动率曲线库 `btc_smiles.sqlite3` |
| `verify` | 用原始报价检验曲线库的还原误差 |

曲线库的线性插值会让 IV 系统性偏高 0.1–0.3 个波动率点，所以回测引擎直接用原始报价，不用曲线库。

## 测试

```bash
python3 -m unittest discover -s tools/options-backtest/tests        # 只用标准库，数据层测试会跳过
~/.local/share/options-backtest/venv/bin/python -m unittest discover -s tools/options-backtest/tests   # 含数据层
```
