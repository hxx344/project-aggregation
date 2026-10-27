---
name: options-backtest
description: Backtest BTC option strategies (iron condor, strangle, spreads, legs chosen by delta and expiry rule) on the server's raw Deribit hourly quotes with tools/options-backtest/bt. Use when the user asks to backtest, compare parameters, sweep deltas/DTE/exits, or inspect historical option chains.
---

# BTC 期权回测

用法与口径以 `tools/options-backtest/README.md` 为准；本文件只给调用要点。

1. 先用 `tools/options-backtest/bt examples` 找到最接近的示例。实盘铁鹰是 `iron_condor`，实盘卖宽跨是 `short_strangle`；用永续多头代替现货的备兑看涨是 `covered_call`（`type: perp`，含资金费）。
2. 小改用 `--set path=value`（如 `legs.0.delta=0.3`、`fill=cross`、`exit.take_profit_pct=0.5`、`start=2024-01-01`）。结构不同时写内联 JSON 或在结果目录外新建 spec 文件，字段表见 README。
3. 比较多组参数用 `bt sweep SPEC --set a+b=v1,v2 --set c=x,y`，看排序表，需要细节再读 `sweep.csv`。
4. 结果目录在摘要最后一行；分析逐笔时读 `trades.csv` 的相关列，不整份打印。
5. 选腿或价格看起来不对时，用 `bt chain <UTC 小时> --dte N` 查看那一小时的期权链。

含永续腿时，把盈亏拆成永续价格、资金费和期权部分（摘要和 sweep 表都有），并和单纯持有永续的基准（`perp_pnl − funding`）对比，期权部分（`options`）才是策略相对基准的增量。

向用户报告时说明：成交价模型（`mid` 偏乐观，`cross` 为吃单）、数据为 Deribit（实盘是 Bybit）、时间范围与交易笔数；不要只报总盈亏，带上最大回撤、最差单笔和按年份分布。
