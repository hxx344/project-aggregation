#!/usr/bin/env bash
# 在日本服务器上搭建 GitHub Releases 缓存代理
# 用于加速国内访问

set -Eeuo pipefail

CACHE_DIR="${RELEASE_CACHE_DIR:-/var/cache/github-releases}"
NGINX_CONF="/etc/nginx/sites-available/release-mirror"
DOMAIN="${RELEASE_MIRROR_DOMAIN:-releases.yourdomain.com}"

echo "========================================="
echo "GitHub Releases 缓存代理设置"
echo "========================================="
echo "缓存目录: $CACHE_DIR"
echo "域名: $DOMAIN"
echo ""

# 1. 安装依赖
if ! command -v nginx &>/dev/null; then
  echo "安装 Nginx..."
  # 只安装 nginx，不安装 certbot（避免触发云安全告警）
  # 本地镜像使用 HTTP 即可，不需要 HTTPS 证书
  apt-get update && apt-get install -y nginx
fi

# 2. 创建缓存目录
mkdir -p "$CACHE_DIR"
chown www-data:www-data "$CACHE_DIR"

# 3. 配置 Nginx 缓存代理
cat > "$NGINX_CONF" <<'NGINX_CONFIG'
proxy_cache_path /var/cache/github-releases
                 levels=1:2
                 keys_zone=github_releases:100m
                 max_size=50g
                 inactive=90d
                 use_temp_path=off;

server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER;

    # 限速保护
    limit_req_zone $binary_remote_addr zone=download:10m rate=10r/s;
    limit_req zone=download burst=20 nodelay;

    location / {
        # 代理到 GitHub
        proxy_pass https://github.com;
        proxy_ssl_server_name on;

        # 缓存配置
        proxy_cache github_releases;
        proxy_cache_valid 200 90d;
        proxy_cache_valid 404 1h;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock on;
        proxy_cache_lock_timeout 60s;

        # 缓存状态响应头
        add_header X-Cache-Status $upstream_cache_status;
        add_header X-Cached-At $date_gmt;

        # 超时设置
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;

        # 传递原始请求头
        proxy_set_header Host github.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 缓冲设置（大文件）
        proxy_buffering on;
        proxy_buffer_size 8k;
        proxy_buffers 32 8k;
        proxy_busy_buffers_size 64k;
    }

    # 健康检查
    location /health {
        access_log off;
        return 200 "OK\n";
        add_header Content-Type text/plain;
    }

    # 缓存统计
    location /cache-status {
        stub_status on;
        access_log off;
        allow 127.0.0.1;
        deny all;
    }
}
NGINX_CONFIG

sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" "$NGINX_CONF"

# 4. 启用配置
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/release-mirror
nginx -t && systemctl reload nginx

echo ""
echo "========================================="
echo "✅ 缓存代理已配置"
echo "========================================="
echo "HTTP 地址: http://$DOMAIN"
echo ""
echo "下一步："
echo "1. 配置 DNS: $DOMAIN → $(curl -s ifconfig.me)"
echo "2. 如需 HTTPS，手动安装: apt-get install certbot python3-certbot-nginx && certbot --nginx -d $DOMAIN"
echo "3. 测试下载: curl -I http://$DOMAIN/hxx344/project-aggregation/releases/latest/download/project-aggregation-linux-x64.tar.gz"
echo ""
echo "缓存统计: curl http://localhost/cache-status"
