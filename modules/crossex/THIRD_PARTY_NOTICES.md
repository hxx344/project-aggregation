# 来源与许可

本项目的手动交易终端、双腿交易布局、账户组合观察以及 CrossEx 接口适配，参考并改编了 [your-quantguy/gate-crossex](https://github.com/your-quantguy/gate-crossex)。参考版本为 `423356d89e5c8f41d9d9033f4db1f40299774ec0`，核对日期为 2026-10-08。

原项目及其贡献者保留原有版权；原项目采用 **AGPL-3.0-only**。本项目依照相同许可发布，完整条款见 [LICENSE](LICENSE)。网络服务中的“源代码”链接指向本项目公开仓库；部署修改版本时应提供该运行版本对应的完整源代码。

直接相关的上游文件包括：

- `apps/backend/src/crossex-client.ts`：账户、订单、费用、杠杆、风险档位及账户流水的字段契约。
- `apps/backend/src/market-hub.ts`：公开 WebSocket ticker、trade 与 funding_rate 订阅格式。
- `packages/public-data/src/index.ts`：八个交易所的真实历史 K 线端点与原生合约映射。
- 前端交易终端、持仓表、组合页、平仓对话框及双腿交易页面：紧凑深色布局、手动订单票、按基础资产归组的观察方式。

本项目的适配保留原有 Node HTTP / SQLite / systemd 部署结构，订单写入限定为用户发起的预览、确认和撤单。没有接入上游自动策略、自动撤单修复、资金划转、模拟行情种子或 broker 渠道标识。盘口使用经校验的完整原生快照，金额和数量使用十进制运算，缺失账户数据不补零。

其余 npm 依赖保留各自的软件许可；本声明不改变这些依赖的许可。
