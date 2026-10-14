# CrossEx 持仓加仓与双腿平衡

工作台的 CrossEx → 投资组合 → 持仓组合提供「加仓」和「平衡双腿」。这些操作面向已有的一多一空、不同交易所的有效双腿组合，通过同一套预览和实盘确认完成。

## 加仓

两腿基础币数量严格相等时可以加仓。选择现有每腿数量的 25%、50%、75%、100%，或填写基础币增量；百分比按两腿共同数量步长向下取整。手输数量不自动修改，不符合任一腿步长或订单约束时应先调整输入。

界面显示原有持仓、增加后的数量、各腿预计保证金与单腿名义额预算。保证金参考使用当前标记价和杠杆；缺少价格、杠杆或账户数据时显示未知。共享账户可用保证金不能当作隔离交易所账户的可用余额。手续费和新保证金需求以服务端预览为准，成交费用以交易所记录为准。

增加后的实际平均成本由新成交价与原仓位共同决定。资金费金额随持仓数量变化，费率和收益不作保证。

## 平衡双腿

两腿数量差相对平均数量超过 0.1% 时，可以选择：

- **减少较大腿：** 将较大腿减至较小腿数量，仅发送只减仓订单。
- **增加较小腿：** 将较小腿增至较大腿数量，需要可用保证金及开仓额度。
- **指定目标数量：** 将两腿分别调整至同一正数目标，可能只增加、只减少，或先减少再增加。

目标能否执行取决于每腿实际增减量的步长、最小数量、最小名义额及单笔上限。系统不会为凑齐目标伪造零数量订单，也不会静默改变手输目标。新开仓暂停时，仍可使用纯减仓方案；含增加腿的方案不可提交。

## 预览与执行

操作按当前盘口生成**保护限价 IOC** 委托：尝试立即成交，未成交部分取消。预览中的价格、数量、增减方向和只减仓标记均可检查；这不是无价格上限的市价单。

自定义目标的混合操作先减后增，所有持仓调整都要求前腿确认完全成交后才继续后腿。部分成交、未知结果或超时会停止后续腿，不自动补单。请在订单与操作记录中核对逐腿结果，待实际持仓刷新后，再决定是否重新平衡。预览阶段不提前使用预计减仓释放的保证金或总额度。

对话框绑定打开时的持仓数量、方向及连接。持仓变化后须重新打开；确认前服务器还会刷新账户并核对持仓、设置、行情、杠杆、风险档位及保证金。过期预览、账户数据不完整或待确认请求会阻止新操作。重复确认沿用已有请求标识，不重复下单。

## 接口与数量口径

继续使用 `/api/live/preview` 与 `/api/live/confirm`。已有仓位通过专用 `kind: 'position'` 请求；普通 `open` 的已有仓冲突限制保留。

```ts
type PositionSnapshot = {
  positionId: string;
  expectedQuantity: string;
  expectedSide: 'LONG' | 'SHORT';
};

type PositionActionInput = {
  kind: 'position';
  action: 'add';
  connectionVersion: string | number;
  positions: [PositionSnapshot, PositionSnapshot];
  quantity: string;
} | {
  kind: 'position';
  action: 'balance';
  connectionVersion: string | number;
  positions: [PositionSnapshot, PositionSnapshot];
  strategy: 'reduce' | 'increase' | 'target';
  targetQuantity?: string;
};
```

服务器从所选真实持仓推导合约、方向和每腿数量，不接受调用方自行指定订单方向或 `reduceOnly`。CrossEx 的持仓和委托数量已使用基础币单位，不再乘一次原生合约乘数。金额保持各自计价币，预算由服务端统一按 USDT 核验。

`notionalPerLeg` 限制本次增加订单的名义额；已有持仓与新增订单共同受 `maxTotalNotional` 和当前杠杆风险档位约束。加仓不重复占用持仓数量槽位。

## 验证入口

交易边界与数量规则由 CrossEx 的持仓操作、运行时和行情测试覆盖。浏览器验收使用 [隔离工作台用例](../tests/crossex-position-actions.browser.mjs)，通过真实工作台入口打开内置 CrossEx，拦截全部账户和交易 API，不连接实盘账户。

Windows 原生环境构建工作台与 CrossEx 后，启动 `node scripts/preview-position-metrics.mjs`，再通过 `playwright-cli run-code --filename tests/crossex-position-actions.browser.mjs` 执行。截图保存在 `output/playwright/`。Linux 打包及安装验证使用仓库 CI，禁止以 WSL 代替。
