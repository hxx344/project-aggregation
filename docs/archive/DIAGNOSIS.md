# 工作台延迟诊断指南

## 问题现象
ping 服务器延迟低且稳定，但工作台访问卡顿甚至断连。

## 根本原因
ping 测的是网络层（ICMP），工作台走应用层（HTTP/WebSocket），中间有多层开销：

### 1. TCP 连接建立
- ping 无需三次握手，工作台每次请求可能需要
- 无 Keep-Alive 时每次重建连接增加 20-100ms

### 2. 服务器处理时间
- ping 到达后直接返回，几乎零处理
- 工作台需要：路由 → 数据库查询 → JSON 序列化 → 返回
- SQLite 查询、多项目轮询在服务器忙时会累积延迟

### 3. 带宽/吞吐量
- ping 包只有 64 字节
- 工作台传输 HTML/JS/CSS/API 响应，可达几百 KB
- VPN、跨国线路、NAT 限速会让大包明显变慢

### 4. 中间设备超时
- NAT、防火墙、云负载均衡器有会话超时（60-300 秒）
- 长连接闲置后被中断
- HTTP Keep-Alive 超时后需重建

### 5. DNS 解析
- ping IP 不涉及 DNS，浏览器访问域名需查询
- 公共 DNS 可能比本地 DNS 慢几十毫秒

---

## 诊断步骤

### 1. 对比 ICMP vs TCP 延迟
```bash
# ICMP 延迟
ping -c 10 <服务器IP>

# TCP 应用层延迟（包含 DNS、TCP、HTTP）
curl -w '\n时间分解:\n  DNS查询: %{time_namelookup}s\n  TCP连接: %{time_connect}s\n  TLS握手: %{time_appconnect}s\n  总耗时: %{time_total}s\n' \
  -o /dev/null -s http://<服务器IP>:3100/api/health
```

**正常值参考：**
- TCP 连接应 <50ms（与 ping 接近）
- 总耗时应 <200ms
- 如果 TCP 连接本身就慢，检查服务器 CPU/负载

### 2. 检查 Keep-Alive 效果
```bash
# 测试复用连接（快）
ab -n 100 -c 1 -k http://<服务器IP>:3100/api/health

# 测试每次新建（慢）
ab -n 100 -c 1 http://<服务器IP>:3100/api/health
```
如果两者差距大（>50ms/请求），说明连接建立开销高。

### 3. 服务器端连接状态
在服务器上运行：
```bash
# 查看 TCP 连接统计
ss -s

# 查看工作台的活跃连接数
netstat -ant | grep 3100 | grep ESTABLISHED | wc -l

# 查看 TIME-WAIT 堆积（可能耗尽端口）
netstat -ant | grep TIME_WAIT | wc -l
```

**问题信号：**
- TIME-WAIT 超过几千：端口耗尽，需调整内核参数
- ESTABLISHED 很少但访问慢：连接频繁断开重建

### 4. 抓包分析（需要 root）
```bash
# 在客户端或服务器抓包 3 分钟
tcpdump -i any -nn 'host <服务器IP> and port 3100' -w workbench.pcap

# 用 Wireshark 打开，检查：
# - TCP Retransmission（红色）：网络丢包
# - TCP ZeroWindow：服务器处理不过来
# - 大量 SYN/FIN：连接频繁建立/关闭
```

### 5. 浏览器开发者工具
1. 打开工作台页面
2. F12 → Network 标签
3. 观察：
   - **Timing** 列：DNS、连接、等待、下载时间分解
   - **Waterfall** 图：并发请求是否阻塞
   - **Protocol** 列：是否用了 HTTP/2 或 h2（更高效）

---

## 优化方案

### 短期（无需改代码）

#### 1. 启用 HTTP Keep-Alive
检查服务器配置（如果用了 Nginx/Caddy）：
```nginx
keepalive_timeout 65;
keepalive_requests 100;
```

#### 2. 调整 TCP 内核参数（Linux 服务器）
```bash
# 加快 TIME-WAIT 回收
sudo sysctl -w net.ipv4.tcp_tw_reuse=1

# 增大连接队列
sudo sysctl -w net.core.somaxconn=1024
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=2048
```

#### 3. 使用 CDN 或反向代理
在客户端和服务器间加一层缓存：
- Cloudflare（免费）
- 本地 Nginx 缓存静态资源

#### 4. 配置本地 DNS 缓存
```bash
# Linux
sudo systemctl start systemd-resolved

# macOS
sudo dscacheutil -flushcache

# Windows（管理员 PowerShell）
ipconfig /flushdns
```

### 中期（需修改代码）

#### 1. 减少轮询频率
当前配置（见 README）：
- 连接质量检测：10 秒
- 仓位刷新：前台 5 秒，后台 30 秒
- 资产同步：60 秒

如果服务器响应慢，可降低频率：
```javascript
// src/connection-quality.ts
export const CONNECTION_INTERVAL_MS = 15_000; // 改为 15 秒
```

#### 2. 批量合并请求
将多个小请求合并为一个：
```javascript
// 原来：3 个请求
GET /api/positions
GET /api/assets
GET /api/health

// 改为：1 个请求
GET /api/dashboard  // 返回所有数据
```

#### 3. 启用 HTTP/2
Node.js 服务改用 HTTP/2：
```javascript
import http2 from 'http2';
const server = http2.createSecureServer({ cert, key }, app);
```
单连接可并发多个请求，减少握手开销。

#### 4. 添加客户端缓存
```javascript
// 静态资源用强缓存
res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

// API 用协商缓存
res.setHeader('ETag', generateETag(data));
if (req.headers['if-none-match'] === etag) {
  return res.status(304).end();
}
```

### 长期（架构调整）

#### 1. WebSocket 替代轮询
实时推送代替定时拉取：
```javascript
// 服务器
wss.on('connection', (ws) => {
  setInterval(() => {
    ws.send(JSON.stringify({ type: 'position', data }));
  }, 5000);
});

// 客户端
const ws = new WebSocket('ws://server:3100');
ws.onmessage = (e) => updateUI(JSON.parse(e.data));
```

#### 2. 服务端渲染（SSR）
首屏 HTML 直接包含数据，减少往返：
```javascript
// 返回带数据的 HTML，而不是空壳 + JS 再请求
res.send(`<div id="root">${renderToString(<App data={data} />)}</div>`);
```

#### 3. 边缘计算
将静态资源和部分 API 部署到离用户更近的节点。

---

## 快速排查清单

1. **curl 测试** - 看 TCP 连接和总耗时
2. **ab -k 对比** - 确认 Keep-Alive 是否生效
3. **浏览器 Network** - 找到最慢的请求
4. **服务器 top/htop** - 检查 CPU/内存是否打满
5. **tcpdump 抓包** - 确认是否有丢包/重传

从最简单的开始，逐步深入。
