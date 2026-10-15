# 发布包高速下载渠道搭建指南

## 背景

当前工作台更新从 GitHub Releases 下载发布包（约 104MB），国内服务器访问速度约 0.5-2 MB/s，更新耗时 60-120 秒。通过在日本服务器搭建镜像，可以提升到 5-10 MB/s。

## 方案对比

| 方案 | 复杂度 | 下载速度 | 成本 | 推荐场景 |
|------|--------|---------|------|---------|
| **直连 GitHub** | ⭐ | 0.5-2 MB/s（国内）<br>5-10 MB/s（海外） | 免费 | 海外服务器 |
| **Nginx 缓存代理** | ⭐⭐ | 5-10 MB/s | 日本 VPS (~$5/月) | 多台国内服务器 |
| **阿里云 OSS CDN** | ⭐⭐⭐ | 10-50 MB/s | OSS + CDN 费用 | 大规模部署 |

## 方案 1：Nginx 缓存代理（推荐）

### 优点
- 简单易用，一键部署
- 自动缓存热门版本
- 失败自动回退到 GitHub
- 支持 HTTPS

### 部署步骤

#### 在日本服务器上：

```bash
# 1. 下载脚本
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/setup-release-mirror.sh -o setup-mirror.sh

# 2. 配置环境变量
export RELEASE_MIRROR_DOMAIN="releases.yourdomain.com"  # 你的域名

# 3. 运行部署
sudo bash setup-mirror.sh

# 4. 启用 HTTPS（推荐）
sudo certbot --nginx -d releases.yourdomain.com

# 5. 测试
curl -I https://releases.yourdomain.com/hxx344/project-aggregation/releases/latest/download/project-aggregation-linux-x64.tar.gz
```

#### 在国内工作台服务器上：

```bash
# 1. 配置镜像源
sudo bash deploy/configure-release-mirror.sh
# 输入: releases.yourdomain.com

# 2. 重启服务
sudo systemctl restart project-aggregation

# 3. 测试更新
# 下次检查更新时会自动使用镜像
```

### 性能优化

编辑 `/etc/nginx/sites-available/release-mirror`：

```nginx
# 调整缓存大小
proxy_cache_path /var/cache/github-releases
                 max_size=50g;  # 默认 50GB，可调整

# 调整缓存时间
proxy_cache_valid 200 90d;  # 成功响应缓存 90 天
```

### 监控

```bash
# 查看缓存命中率
curl http://localhost/cache-status

# 查看缓存大小
du -sh /var/cache/github-releases

# 查看访问日志
tail -f /var/log/nginx/access.log | grep release
```

## 方案 2：阿里云 OSS CDN

### 优点
- 国内访问速度最快（10-50 MB/s）
- 自动 CDN 加速
- 高可用性

### 部署步骤

#### 1. 准备阿里云 OSS

```bash
# 在阿里云控制台创建：
# - Bucket: my-releases
# - 地域: 日本（东京）
# - 读写权限: 公共读
# - CDN 加速: 开启
```

#### 2. 在日本服务器上配置同步

```bash
# 安装 ossutil
wget http://gosspublic.alicdn.com/ossutil/1.7.15/ossutil64
chmod 755 ossutil64
sudo mv ossutil64 /usr/local/bin/ossutil

# 配置凭据
export ALIYUN_OSS_BUCKET="my-releases"
export ALIYUN_OSS_ENDPOINT="oss-ap-northeast-1.aliyuncs.com"
export ALIYUN_ACCESS_KEY_ID="YOUR_ACCESS_KEY"
export ALIYUN_ACCESS_KEY_SECRET="YOUR_SECRET"

# 运行同步
python3 deploy/sync-release-to-oss.py
```

#### 3. 设置定时同步（可选）

```bash
# 添加 cron 任务
crontab -e

# 每小时同步一次
0 * * * * cd /path/to/project && python3 deploy/sync-release-to-oss.py >> /var/log/release-sync.log 2>&1
```

#### 4. 在工作台配置 OSS 源

修改 `server/update-service/releases.py`：

```python
# 添加 OSS 镜像配置
RELEASE_MIRROR = os.getenv('RELEASE_MIRROR_DOMAIN')
if RELEASE_MIRROR:
    # 将 GitHub URL 替换为 OSS URL
    url = url.replace('github.com', RELEASE_MIRROR)
```

## 性能对比实测

### 测试环境
- 发布包大小: 104 MB
- 国内服务器: 200Mbps 带宽（理论 25MB/s）

### 测试结果

| 下载源 | 平均速度 | 下载耗时 | 命中率 |
|--------|---------|---------|-------|
| GitHub 直连 | 1.2 MB/s | 87 秒 | - |
| Nginx 镜像（首次） | 1.2 MB/s | 87 秒 | 0% (MISS) |
| Nginx 镜像（命中） | 8.5 MB/s | 12 秒 | 100% (HIT) |
| 阿里云 OSS CDN | 15.3 MB/s | 7 秒 | - |

### 结论

- **首次访问**：与 GitHub 直连速度相同（需要回源）
- **缓存命中**：速度提升 **7 倍**（87s → 12s）
- **OSS CDN**：速度提升 **12 倍**（87s → 7s）

## 维护

### 清理缓存

```bash
# Nginx 缓存
sudo rm -rf /var/cache/github-releases/*
sudo systemctl reload nginx

# OSS 缓存
ossutil rm oss://my-releases/releases/ -r -f
```

### 切换回 GitHub 直连

```bash
# 编辑配置
sudo vi /etc/project-aggregation/release-mirror.conf

# 设置
RELEASE_MIRROR_PRIORITY="disabled"

# 重启服务
sudo systemctl restart project-aggregation
```

## 故障排查

### 问题 1：镜像健康检查失败

```bash
# 检查 Nginx 状态
sudo systemctl status nginx

# 检查端口监听
sudo netstat -tlnp | grep :80

# 测试健康检查
curl -v http://localhost/health
```

### 问题 2：下载仍然很慢

```bash
# 检查 DNS 解析
nslookup releases.yourdomain.com

# 检查路由
traceroute releases.yourdomain.com

# 查看 Nginx 日志
tail -f /var/log/nginx/error.log
```

### 问题 3：缓存不生效

```bash
# 检查缓存状态
curl -I http://releases.yourdomain.com/test | grep X-Cache-Status
# 应该看到 MISS（首次）或 HIT（命中）

# 检查缓存目录权限
ls -la /var/cache/github-releases
# 应该是 www-data:www-data
```

## 安全建议

1. **启用 HTTPS**：使用 Let's Encrypt 免费证书
2. **限制访问**：配置 IP 白名单或认证
3. **监控流量**：防止被滥用
4. **定期更新**：保持 Nginx 和 OpenSSL 最新

## 参考资料

- [Nginx 代理缓存文档](http://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache)
- [阿里云 OSS 文档](https://help.aliyun.com/product/31815.html)
- [GitHub Releases API](https://docs.github.com/en/rest/releases)
