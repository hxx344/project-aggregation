# 项目工作台 · Project Aggregation

统一管理多个交易和监控项目的入口，提供摘要总览、健康监控、统一登录和原生交易功能。

## 核心功能

### 📊 总览看板
- **资产摘要** - 实时资产账本、保证金占用、持仓盈亏
- **健康监控** - 各项目连接状态、数据时效、诊断信息
- **本机连接质量** - 顶栏显示当前浏览器到工作台服务器的 HTTP 往返延迟和连接状态；前台每 10 秒探测，3 秒超时，后台暂停，网络恢复或返回页面时重测。良好 ≤150 ms、一般 ≤500 ms、较慢 >500 ms；耗时包含网络与服务响应。
- **历史曲线** - 资产和盈亏趋势可视化

### 🔗 项目集成
支持以下项目的统一接入：
- ASTER 5X - 交易工作台
- Market Monitor - 市场监控
- Asset Ledger - 资产账本
- Gate CrossEx - 跨交易所套利
- Variational Grid - 策略网格
- Greeks - 期权分析

### 💼 交易中心

#### 交易所仓位
- 统一查看 Binance、Bybit、OKX、Aster、Variational 的真实仓位
- 按交易所、账户、产品筛选
- 前台 5 秒刷新，后台 30 秒刷新
- 数据来源于 Asset 项目，无需重复配置密钥

#### 原油四腿套利
- 支持 Binance/Bybit、Binance/OKX、Bybit/OKX 组合
- 四腿、同所两腿、跨所两腿预设策略
- 批次拆分、追价执行、止损保护
- 幂等性保证、断电恢复、状态持久化

**交易所原生支持：**
- Binance - 普通 U 本位 & Portfolio Margin，使用 `LIMIT + GTX + priceMatch=QUEUE`
- Bybit - 统一账户，使用原生 `chaseOrder` 追价
- OKX - 单/多币种保证金，使用 `post_only` + `amend-order`

### 🔐 安全特性
- 独立密码登录，7 天会话有效期
- 凭据 AES-256-GCM 加密存储
- 会话固定漏洞防护
- 账户级登录限流（5 次失败锁定 30 分钟）
- DNS 重绑定攻击防护
- CSRF 令牌保护

### 📈 性能优化
- 结构化日志（Pino）
- 批量查询消除 N+1 问题
- 数据库索引优化
- 冗余序列化缓存
- SQLite WAL 模式

## 快速开始

### 一键安装
```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/install-all.sh | sudo bash
```

### 仅安装特定模块
```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/install-all.sh | sudo bash -s -- --only asset,hub
```

### 手动安装
```bash
# 克隆仓库
git clone https://github.com/hxx344/project-aggregation.git
cd project-aggregation

# 安装依赖
npm install

# 构建前端
npm run build

# 启动服务
npm start
```

服务默认运行在 `http://127.0.0.1:3100`

### 初始密码
首次启动会生成随机密码并显示在控制台，请妥善保存。

重置密码：
```bash
node server/setup.mjs --reset-password
```

## 系统要求

- Node.js >= 24.15.0
- 支持 Linux/macOS/Windows
- 推荐 2GB+ 内存

## 项目配置

### 接入新项目
1. 登录工作台
2. 点击"项目管理"
3. 填写项目信息：
   - 项目 ID（唯一标识）
   - 名称和描述
   - 接口地址（如 `http://127.0.0.1:3200`）
   - 适配器类型
   - 数据过期阈值（秒）

### 适配器类型
- `aster` - ASTER 交易工作台
- `monitor` - Market Monitor
- `asset` - 资产账本
- `standard` - 标准概览接口
- `link` - 仅网页入口

### Asset 后台同步
启用后，工作台每 60 秒调用 Asset 同步接口更新资产数据，浏览器关闭后仍会执行。

### 应用预热

预热与摘要刷新共用调度、请求去重和关闭清理。服务启动约 100 毫秒后首次读取所有已启用且有接口地址的应用，之后按摘要刷新周期或所选应用的预热间隔中较短者检查；`link` 入口不参与。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WARMUP_ENABLED` | `true` | 设为 `false` 关闭预热加速，正常摘要刷新继续 |
| `WARMUP_PROJECTS` | `aster,monitor,asset` | 逗号分隔的项目 ID，自动去空白和重复项；空值不选择任何项目 |
| `WARMUP_INTERVAL_MS` | `90000` | 毫秒，必须为 `1000` 至 `2147483647` 的整数；无效值会阻止启动并提示修正 |

默认摘要刷新间隔最多 30 秒，已比默认预热间隔更短，因此默认配置不会增加请求量。需要更频繁触达指定应用时，可设置更短间隔，例如在 Linux 上运行：

```bash
WARMUP_PROJECTS=aster,crossex WARMUP_INTERVAL_MS=10000 npm start
```

一键安装的服务可在 `/etc/project-aggregation.env` 中设置这些变量，重启 `project-aggregation` 服务后生效。调试日志使用 `LOG_LEVEL=debug`。代码调用 `createApp({ refreshInterval: 0 })` 时，自动摘要刷新和预热均关闭。

预热通过现有摘要接口触达上游，实际能否避免休眠取决于上游服务；不会提前建立浏览器页面或登录会话。打开速度需在实际部署中测量，不能据此保证固定提速比例。

## 交易执行

### 配置实盘连接
1. 进入"交易中心"
2. 选择交易所组合
3. 填写 API 密钥：
   - **Binance** - API Key + Secret
   - **Bybit** - API Key + Secret
   - **OKX** - API Key + Secret + Passphrase

**权限要求：**
- ✅ 合约交易（必需）
- ❌ 提现/划转（禁止）

### 执行流程
1. 选择策略（四腿/两腿）
2. 填写数量和价格参数
3. 点击"预览"查看执行计划
4. 核对账户、方向、数量
5. 确认后开始实盘执行

**安全机制：**
- 预览 30 秒有效期
- 持仓模式冲突检测
- 外部委托冲突检测
- 追价停止价保护
- 断电恢复机制

## 架构设计

### 后端
- **框架** - Node.js + ESM
- **数据库** - SQLite (WAL 模式)
- **日志** - Pino 结构化日志
- **加密** - AES-256-GCM

### 前端
- **框架** - React 19 + TypeScript
- **构建** - Vite 8
- **图表** - Recharts 3

### 部署
- **服务管理** - systemd
- **健康检查** - `/api/health`
- **自动更新** - 内置更新检查和应用

## 开发

### 运行测试
```bash
npm test
```

### TypeScript 检查
```bash
npm run check
```

### 开发模式
```bash
npm run dev
```

## 数据安全

- **凭据加密** - 使用 32 字节随机密钥（`credentials.key`）
- **会话管理** - SHA-256 哈希，HttpOnly + SameSite=Strict cookies
- **数据目录** - 默认 `.data/`，权限 `0o700`
- **备份建议** - 定期备份 `.data/hub.sqlite` 和 `.data/credentials.key`

⚠️ **重要提示：** 丢失 `credentials.key` 会导致无法解密已保存的凭据

## 故障排查

### 项目显示"数据已过期"
- 检查项目接口地址是否可访问
- 检查项目是否正常运行
- 查看诊断信息中的具体错误

### 交易执行失败
- 核对 API 密钥权限
- 检查账户余额和保证金
- 查看执行任务的详细错误信息
- 确认交易所账户模式与设置一致

### 无法登录
- 检查密码是否正确
- 查看是否触发账户锁定（30 分钟）
- 必要时重置密码

## 更新日志

### 最近更新
- ✅ 安全修复：会话固定、账户锁定、DNS 重绑定防护
- ✅ 性能优化：N+1 查询消除、序列化缓存
- ✅ 可观测性：结构化日志系统
- ✅ 代码重构：前端组件拆分、后端模块化
- ✅ 测试增强：日志和会话管理单元测试

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request

## 联系方式

- GitHub: https://github.com/hxx344/project-aggregation
