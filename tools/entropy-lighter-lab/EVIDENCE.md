# 研究证据片段导出

工作台 Entropy / Lighter 页的「技术与模拟明细 → 研究证据片段」可输入会话和时间窗，按当前标的生成 JSONL 与独立清单下载。仅有登录会话可以通过 `GET /api/research/entropy-lighter/evidence?session=UUID&symbol=SNDK&from=毫秒&to=毫秒` 读取；同一服务一次只处理一份导出。停止采集后仍可读取保留的记录。

离线 CLI：

```text
node tools/entropy-lighter-lab/cli.mjs export --data DATA_DIR --session UUID --symbol SNDK --from 1800000000000 --to 1800000300000 --out NEW_DIR
```

CLI 与 API 使用同一只读导出器。`NEW_DIR` 必须不存在；输出 `events.jsonl`、`manifest.json`，不覆盖已有证据。导出不启动采集、模拟或交易，不补采缺失历史，也不更改原日志和配置。

时间窗采用 `[from,to)`，先按 `receivedAt`，其次 `at`，再其次新增记录的 `recordedAt` 过滤；来源时钟仍保留在事件中。每行附原分段文件名及行号，清单附实际已扫描字节 SHA256、开始读取时大小和扫描完成状态。并发追加/清理、缺段、坏行、半行、旧事件缺少墙上时钟、未启用 raw 或无法确认 raw 开关均列入 `gaps`，不会用零代替未知覆盖。

原始帧标为 `raw_frame`，仅投影公开盘口字段，并保留原载荷 SHA256；每侧最多 2,000 档，不导出任意原文或配置。标准化事件标为 `normalized_event`，按实际事件类型和嵌套字段路径投影，保留延迟评估/失败原因、信号时刻、逐腿状态与成交、费用和返佣口径；`costConfig` 仅导出明确的模拟费用/时间参数。原始帧依赖同会话已保留的 `metadata` 确认原生合约与标的关系；无法确认的帧单独计为覆盖缺口，不以当前市场映射推断旧记录。

数组、字段长度或深度实际触及投影上限时，清单添加对应 `projection_*_limit` 缺口并令 `scanComplete=false`；不支持的标准化事件类型或字段形状也明确标记，不输出貌似完整的空壳结果。

固定上限：24 小时时间窗、扫描 4,096 个目录项/32 个分段/32 MiB/100,000 行、3 秒处理预算、单行 4 MiB；输出最多 10,000 条/4 MiB。时间预算在目录项、读取块和行处理边界检查，单次本地文件系统调用耗时可能超过剩余预算。达到任一上限明确写入清单。`sourceCoverageVerified` 固定为 false：读完保留文件不等于交易所原始流完整，`scanComplete` 不能替代行情完整性证明。
