#!/usr/bin/env bash
# 配置更新器使用日本服务器镜像源
# 用于加速国内部署的工作台更新

set -Eeuo pipefail

CONFIG_FILE="/etc/project-aggregation/release-mirror.conf"
SYSTEMD_OVERRIDE="/etc/systemd/system/project-aggregation.service.d/mirror.conf"

echo "========================================="
echo "配置发布包镜像源"
echo "========================================="
echo ""

# 读取用户输入的镜像域名
read -p "请输入日本服务器镜像域名（留空使用 GitHub 直连）: " MIRROR_DOMAIN

if [[ -z "$MIRROR_DOMAIN" ]]; then
    echo "⚠️  未配置镜像，将使用 GitHub 直连"
    exit 0
fi

# 验证域名格式
if ! [[ "$MIRROR_DOMAIN" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]; then
    echo "❌ 无效的域名格式"
    exit 1
fi

echo "✅ 镜像域名: $MIRROR_DOMAIN"
echo ""

# 1. 创建配置文件
mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<CONFIG
# GitHub Releases 镜像配置
# 日本服务器提供的高速下载渠道

# 镜像域名（不含协议）
RELEASE_MIRROR_DOMAIN="$MIRROR_DOMAIN"

# 镜像优先级
#   always: 始终使用镜像
#   fallback: 镜像失败后回退到 GitHub
#   disabled: 禁用镜像
RELEASE_MIRROR_PRIORITY="fallback"

# 超时设置（秒）
RELEASE_MIRROR_TIMEOUT=60
RELEASE_GITHUB_TIMEOUT=300

# 健康检查
RELEASE_MIRROR_HEALTH_CHECK="https://$MIRROR_DOMAIN/health"
CONFIG

chmod 644 "$CONFIG_FILE"
echo "✅ 配置文件已创建: $CONFIG_FILE"
echo ""

# 2. 创建 systemd 环境变量覆盖
mkdir -p "$(dirname "$SYSTEMD_OVERRIDE")"
cat > "$SYSTEMD_OVERRIDE" <<SYSTEMD
[Service]
# 从配置文件加载镜像设置
EnvironmentFile=-$CONFIG_FILE
SYSTEMD

chmod 644 "$SYSTEMD_OVERRIDE"
systemctl daemon-reload
echo "✅ systemd 配置已更新"
echo ""

# 3. 测试镜像连通性
echo "========================================="
echo "测试镜像连通性"
echo "========================================="

# 测试健康检查
if curl --fail --silent --max-time 10 "https://$MIRROR_DOMAIN/health" >/dev/null 2>&1; then
    echo "✅ 健康检查通过"
else
    echo "⚠️  健康检查失败，请确认镜像服务正常运行"
fi

# 测试下载速度
TEST_URL="https://$MIRROR_DOMAIN/hxx344/project-aggregation/releases/latest/download/release-manifest.json"
echo ""
echo "测试下载速度..."
if time curl --fail --silent --max-time 10 "$TEST_URL" -o /tmp/mirror-test.json 2>&1; then
    SIZE=$(stat -c %s /tmp/mirror-test.json 2>/dev/null || stat -f %z /tmp/mirror-test.json 2>/dev/null)
    echo "✅ 下载测试通过 (${SIZE} bytes)"
    rm -f /tmp/mirror-test.json
else
    echo "⚠️  下载测试失败，请检查镜像配置"
fi

echo ""
echo "========================================="
echo "✅ 镜像配置完成"
echo "========================================="
echo ""
echo "配置文件: $CONFIG_FILE"
echo "下次更新将自动使用镜像加速"
echo ""
echo "如需禁用镜像，编辑配置文件并设置:"
echo "  RELEASE_MIRROR_PRIORITY=\"disabled\""
echo ""
echo "重启服务以应用配置:"
echo "  sudo systemctl restart project-aggregation"
