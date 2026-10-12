# 合约身份与跨平台配对

价差只应比较同一底层资产、同一报价单位。交易所代码相同不等于同一资产；本模块不通过价格接近程度或价差上限来判定身份。

分类优先读取各平台官方市场目录：

- Bybit：`symbolType`、`underlyingTicker`、`marketRegion`。`stock`、`ETF`、`commodity`、`forex` 与币种分开。[官方规范](https://bybit-exchange.github.io/docs/v5/market/instrument)
- OKX：`instCategory`、`ruleType`。股票及其他非加密类别独立；`pre_market` 单独隔离。[官方规范](https://www.okx.com/docs-v5/en/)
- Gate：`contract_type`、`is_pre_market`；`stocks`、`metals`、`indices`、`forex`、`commodities` 等与普通加密合约分开。[官方规范](https://www.gate.com/docs/developers/apiv4/en/futures/)
- Aster：`underlyingSubType`、`symbolType`，识别股票、ETF、大宗及盘前类别。[官方规范](https://asterdex.github.io/aster-api-website/futures/market-data/)
- Lighter：使用 `orderBookDetails` 的 `funding_premium_multiplier`。官方定义加密资产为 1、RWA 为 1/2、Pre-IPO 为 1/100，API 分别编码为 100、50、1；缺失或新增取值按未核实规格隔离。[官方定义](https://docs.lighter.xyz/trading/funding)

非加密资产默认使用包含平台名、类别和原代码的身份，只展示自身行情；经独立确认每股规格的追加平台股票使用 `EQUITY:` 身份。Pre-IPO、市值合约、未知规格均保留平台命名空间，不依据简称进行合并。具体依据同时保存在市场的 `identitySource` 字段。

明确的加密资产代码冲突：Gate 的 `EDGE` 是 Base 上的 Definitive，合约地址为 `0xed6e000def95780fb89734c07ee2ce9f6dcaf110`，不能与 edgeX 配对。使用 `GATE:EDGE:DEFINITIVE` 身份。[Gate 官方资产信息](https://api.gateio.ws/api/v4/spot/currencies/EDGE)

Lighter 主站官方资产注册表将 `AI` 命名为 Artificial Inu，与其他平台的 Sleepless AI 分开；使用 `LIGHTER:AI:ARTIFICIAL-INU` 身份。[核对时的官方注册表](https://app.lighter.xyz/assets/dist-BJmqjeUf.js)

Aster 官方 2026-09-04 的 `MEME` 上市公告明确底层地址为 `0x385f4f8ae47651ce5f58f5265395a669f8281e18`，与 Memeland MEME 是不同资产；使用 `ASTER:MEME:A-MEME-COIN` 身份独立展示。[Aster 官方公告](https://x.com/Aster_DEX/status/2095786680758530107)

Aster 官方 2026-08-31 的 `AI` 上市公告明确底层地址为 `0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18`；使用 `ASTER:AI:CONTRACT` 身份独立展示，不与 Sleepless AI 按简称匹配。[Aster 官方公告](https://x.com/Aster_DEX/status/2094342472990412926)、[Binance Sleepless AI 合约定义](https://www.binance.com/en/support/announcement/detail/4667a7247a3e4e899bd11a7b10fae837)

为支持 Entropy 的已确认每股合约，Bybit 的 `SNDK`、`NBIS`、`GPRO`、`IONQ` 采用严格白名单：必须同时满足 `symbolType=stock`、`marketRegion=US`、`underlyingTicker` 与代码一致、非盘前状态，才映射为 `EQUITY:代码`、单位每股。其他股票暂不扩大跨平台映射。[Bybit 股票永续规格说明](https://www.bybit.com/en/learn/bybit-tradfi/bybit-tradfi-perpetuals)

`1000PEPE`、`1000SHIB` 等已确认的篮子单位按明确白名单归一；不会统一剥离数字前缀。`1INCH`、未知 `1000NEW`、带命名空间的合约均保留原身份。

核对日期：2026-09-19。分类与冲突映射应随官方元数据和产品规格变更更新。
