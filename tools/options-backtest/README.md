# BTC 期权回测（options-backtest）

在服务器上用 Deribit 小时级原始报价回测 BTC 期权策略，主要通过 Claude 会话驱动，不属于工作台模块，也不随工作台发布。

## 快速开始

```bash
tools/options-backtest/bt examples                       # 列出示例策略
tools/options-backtest/bt run iron_condor                # 实盘铁鹰：周五 21:00 UTC 开仓，周日到期
tools/options-backtest/bt run iron_condor --set fill=cross --set exit.take_profit_pct=0.5
tools/options-backtest/bt run trend_premium              # 顺势卖权：50 日均线上方卖看跌、下方卖看涨
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
| `expiry.min_hours` | `1` | 到期日距开仓的最少小时数；为 0 时到期日仍须晚于开仓小时 |
| `legs[]` | 必填 | 每条腿：`side` 为 `buy`/`sell`；`type` 为 `call`/`put`/`perp`（Binance 永续，见下方"永续腿"）；`delta` 是目标绝对值，取最接近的行权价；`qty` 是相对数量；`beyond: i` 表示只在第 i 条腿的更虚值一侧选（翼）；`expiry` 可单独设置，用于日历价差；`when` 为 `above`/`below` 时只在对应趋势状态下开这条腿（见下方"趋势过滤"），不写则总是开 |
| `qty` | `1` | 每条腿的张数（1 张 = 1 BTC） |
| `fill` | `mid` | 成交价模型，见下方"成交价" |
| `fees` | 见下方"手续费" | `rate` / `cap_pct` / `settle_rate` / `settle_cap_pct` / `perp_rate` |
| `exit.take_profit_pct` | `null` | 浮盈 ≥ 净权利金 × 该比例时平仓 |
| `exit.stop_loss_pct` | `null` | 浮亏 ≥ 净权利金 × 该比例时平仓 |
| `exit.close_hours_before_expiry` | `null` | 到期前 N 小时平仓 |
| `max_open` | `1` | 同时持有的组合数上限，超出的开仓机会记为跳过 |
| `trend.ma_days` | `null` | 趋势过滤的均线天数（整数 1–400）。设置后至少要有一条腿写 `when`，反之亦然 |
| `margin.mode` | `regular` | `regular` 为 Bybit 常规期权 Order IM；`max_loss` 用到期最大亏损，无限亏损的结构仍用 IM。含永续腿时按"永续以交割价平仓"近似，不含资金费和永续与交割价的价差 |
| `margin.perp_im` | `0.10` | 永续腿保证金 = 该比例 × 名义价值（默认 10 倍杠杆） |

## 口径

**时间**

- 小时 H 只使用 (H−1h, H] 内最后一次快照，所以在 H 时刻下单不会看到未来报价。
- 平仓条件每小时检查一次，用平仓方向的成交价计算，并计入手续费。

**价格**

- 使用原始 `mark_price` / `bid_price` / `ask_price`，标记价缺失的报价丢弃。三列共用同一价格单位，按该合约自己的远期价逐行换算成美元，不按数据分布猜单位，所以追加任何新数据都不会改变已有报价。
- 单位来自数据文件的 `optbt.units` 元数据（`slim` 写入，如 `{"price": "btc", "iv": "fraction"}`）；没有元数据的文件按 `bt slim` 的约定读取：价格为 BTC、IV 为小数，当前数据目录即为此格式。`ParquetMarket(price_unit=..., iv_unit=...)` 指定的单位与文件声明不一致时直接报错。
- 逐行核对标记价是否与声明单位矛盾（看涨不高于远期价、看跌不高于行权价、不低于内在价值超过远期价的 25%），IV 须在 0.5%–1000% 之间；有任何一行矛盾即拒绝读取该月，不改按其他单位解释。
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
- 永续腿：`perp_rate × 成交价 × 数量`，默认 0.05%（Binance 吃单）。
- 交割费：每条实值腿 `min(settle_rate × 交割价, settle_cap_pct × 内在价值)`。0.015% 和 12.5% 是按 Bybit 公开费率填的假设值，用前请核对。

**结算**

- 到期小时用到期合约在最后一次快照里的远期价，近似 Deribit 交割价（交割价是 08:00 前 30 分钟的指数 TWAP）。
- 找不到时，依次退回到更晚到期合约的远期价、前 1–2 小时的快照；到期 6 小时后仍没有，用该到期日各腿最后一次估值时的远期价。用最后一次估值远期价结算的交易，退出原因记为 `expiry_last_forward`。
- 只开决策小时仍未到期的合约（到期时刻严格晚于开仓小时，`min_hours: 0` 也不例外）；到期小时里那张 07:59 的快照不能用来开仓。
- 组合里最早的到期日一到就结算：每条已到期的腿（含等待期间又到期的远月腿）按各自到期日的交割价取内在价值，不再按到期前的旧盘口成交；未到期的腿按当时报价平仓，缺报价就等下一小时。某个已到期腿缺交割价时保持未决，回测结束仍未决的记为 `unsettled_at_data_end`（与普通的 `open_at_data_end` 区分）。

**永续腿（perp）**

- 用 Binance USDⓈ-M BTCUSDT 永续的小时 K 线：小时 H 的价格是 (H−1h, H] 这根 K 线的收盘价。用于开仓、逐小时估值和平仓，不计买卖价差。
- 不需要 `delta` / `beyond` / `expiry`，随组合里最早到期的期权一起平仓。到期时按该小时的永续价平仓；缺这一小时的数据时，用期权交割价代替。
- 资金费：持仓期间 (开仓, 平仓] 的每个资金费时点，按 `费率 × 当时 K 线收盘价` 计入（多头费率为正时付出），汇总在 `funding`。某个资金费时点缺 K 线时直接报错，不静默少算。
- 连续持有：上一笔的永续腿在某小时按该小时永续价平仓（到期按时结算，或止盈止损、提前平仓），新一笔在同一小时开出永续腿时，视为一直持有。交割价晚到或用交割价代替永续价时不算。新一笔不收开仓费，上一笔的平仓费退回，所以每段连续持有只收一次开仓费和一次平仓费。用于 covered call 等滚动策略。
- 摘要多一行 `perp leg price / funding paid / options and all fees`，把盈亏拆成永续价格、资金费、期权加全部手续费；`sweep` 表对应 `perp` / `funding` / `options` 列。

**趋势过滤**

- 每个开仓小时 H，用 Binance BTCUSDT 永续在 H 的收盘价，和截至 H（含 H）最近 `ma_days × 24` 根小时 K 线收盘价的均值比较。严格高于均值为 `above`，否则为 `below`。只用 H 及之前的 K 线，起点之前的预热月份会自动下载。
- 只开 `when` 等于当前状态或没写 `when` 的腿。该状态下没有腿时，跳过并记为 `flat_above` / `flat_below`，可用来写"只在均线上方开仓"。
- H 的价格缺失，或窗口内缺失超过 10% 时，跳过并记为 `no_trend_data`。
- `beyond` 只能指向同一状态下会开的腿。
- 逐笔明细的 `trend` 列记下开仓时的状态，摘要多一行按状态分组的盈亏（`summary.json` 的 `by_trend`）。
- 含永续腿时，只有新旧两笔的永续方向和数量相同，才视为连续持有。趋势翻转、换成反向永续时，照常收平仓费和开仓费。

**保证金**

- `regular` 模式用 Bybit 常规 Order IM 公式（同 `app/risk.py` 的 `short_order_margin`），但标的价用合约远期价代替指数价（数据无指数价列）；手续费同样用远期价。
- 摘要里的 `mean return/margin` 是每笔盈亏 ÷ 该笔保证金的平均值。

**暂不支持**：Delta 对冲、成交量与冲击成本、提前行权（Deribit 期权是欧式，不涉及）。

## 数据

- 默认读取 `~/data/options_hourly/BTC/YYYY-MM.parquet`，可用 `--data` 或环境变量 `OPTBT_DATA` 改。
- 文件来自用户本机原始数据经 `slim` 瘦身：每小时只保留最新快照，只留回测需要的列。
- 当前数据覆盖 2023-03-20 至 2026-03-25。

**Binance 永续数据**：只在策略含永续腿或设置了 `trend.ma_days` 时使用。

- 回测用到某个月时，从 data.binance.vision 的月度归档下载该月的 1 小时 K 线和资金费率，每月约 40 KB；只下载持仓实际经过的月份。设置 `trend.ma_days` 时，开仓区间内每个月和起点之前的均线预热月份的 K 线都会下载。
- 保存到 `~/data/binance/BTCUSDT/{klines,funding}-YYYY-MM.csv`，可用环境变量 `OPTBT_PERP_DATA` 改目录。
- 已发布的月份不会再变，所以文件已存在就不再下载。删掉某个月的文件即可重新下载。
- 每个文件下载超时 30 秒，最多尝试 3 次（压缩包损坏也重试）。仍然失败，或该月尚未发布（404）时直接报错并给出 URL，不会用缺失数据继续回测；当月数据要等 Binance 次月初发布，回测范围可用 `end` 限制；趋势过滤同样如此，未发布的月份会让回测报错，而不是记为 `no_trend_data`。
- 行情数据和回测结果都放在仓库外的 `~/data/` 下，不提交到 git。

**月度缓存**：放在 `<数据目录>/.optbt-cache/v<版本>/YYYY-MM/`。以下任一情况会重建：

- 对应 parquet 的大小或修改时间变化；
- `market.py` 或 `parquet.py` 的源码变化（按内容哈希判断）；
- 读取该月使用的价格或 IV 单位变化；
- `market.py` 的 `DATA_SCHEMA` 升级（从原始值到缓存值的换算语义改变时升级，缓存的 `source.txt` 记录该版本）；
- `market.py` 的 `CACHE_VERSION` 升级（缓存目录结构改变时升级）。

**增加数据**：

1. 在本机运行 `python optbt/parquet.py slim <原始目录> -o <输出目录> --price-unit btc --iv-unit percent`（按原始数据的实际单位填写），需要 `pip install pyarrow numpy`。原始文件没有 `optbt.units` 元数据时必须给出这两个单位，否则报错；输出文件会写入元数据（价格单位照原样，IV 统一为小数）。
2. 把输出文件上传到数据目录。

**parquet 工具**（`bt` 会转发给 `optbt/parquet.py`）：

| 命令 | 用途 |
| --- | --- |
| `inspect` | 检查列名和数据量 |
| `slim` | 瘦身 |
| `convert` | 生成约 16 MB 的波动率曲线库 `btc_smiles.sqlite3` |
| `verify` | 用原始报价检验曲线库的还原误差 |

四个命令都按文件的 `optbt.units` 元数据读取单位；文件没有元数据时用 `--iv-unit fraction|percent`（以及 `slim` / `verify` 需要的 `--price-unit btc|usd`）指定，现有数据目录用 `--price-unit btc --iv-unit fraction`。

曲线库的线性插值会让 IV 系统性偏高 0.1–0.3 个波动率点，所以回测引擎直接用原始报价，不用曲线库。

## 测试

```bash
python3 -m unittest discover -s tools/options-backtest/tests        # 只用标准库，数据层测试会跳过
~/.local/share/options-backtest/venv/bin/python -m unittest discover -s tools/options-backtest/tests   # 含数据层
```
