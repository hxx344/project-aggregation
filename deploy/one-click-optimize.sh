#!/usr/bin/env bash
# 一键优化：测试下载速度 + 自动部署镜像（如果需要）
set -Eeuo pipefail

REPOSITORY=hxx344/project-aggregation
DOWNLOAD_TIMEOUT=${DOWNLOAD_TIMEOUT:-60}
AUTO_DEPLOY=${AUTO_DEPLOY:-true}  # 设为 false 可以只测试不部署
SPEED_THRESHOLD=${SPEED_THRESHOLD:-3.0}  # 低于 3 MB/s 就部署镜像

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() {
  echo ""
  echo -e "${BLUE}=========================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}=========================================${NC}"
}

print_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
  echo -e "${RED}❌ $1${NC}"
}

print_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

# 检查是否是 root
check_root() {
  if [ "$EUID" -eq 0 ]; then
    print_warning "检测到 root 权限，可以自动部署镜像"
    CAN_DEPLOY=true
  else
    print_warning "当前非 root 用户，如需部署镜像请使用 sudo 运行"
    CAN_DEPLOY=false
  fi
}

# 测试下载速度
test_download_speed() {
  print_step "步骤 1: 测试 GitHub 下载速度"

  WORK_DIR=$(mktemp -d)
  trap 'rm -rf "$WORK_DIR"' EXIT

  # 获取发布清单
  MANIFEST="$WORK_DIR/release-manifest.json"
  echo "正在获取最新发布信息..."

  START_MANIFEST=$(date +%s.%N)
  if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --connect-timeout 15 --max-time 90 --max-filesize 1048576 \
    "https://github.com/$REPOSITORY/releases/latest/download/release-manifest.json" \
    -o "$MANIFEST"; then
    print_error "无法获取发布清单"
    exit 1
  fi
  END_MANIFEST=$(date +%s.%N)
  MANIFEST_TIME=$(echo "$END_MANIFEST - $START_MANIFEST" | bc)

  # 解析发布信息
  VALUES=$(python3 -I - "$MANIFEST" "$REPOSITORY" "$(uname -m)" <<'MANIFEST_PY'
import json, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
architecture = {'x86_64': 'linux-x64', 'aarch64': 'linux-arm64', 'arm64': 'linux-arm64'}[sys.argv[3]]
commit = data['commit']
tag = data['tag']
item = data['artifacts'][architecture]
print(commit)
print(tag)
print(item['file'])
print(item['sha256'])
MANIFEST_PY
)

  IFS=$'\n' read -r -d '' COMMIT TAG FILENAME SHA256 <<< "$VALUES" || true

  echo "  提交: $COMMIT"
  echo "  文件: $FILENAME"

  # 下载测试
  ARCHIVE="$WORK_DIR/$FILENAME"
  DOWNLOAD_URL="https://github.com/$REPOSITORY/releases/download/$TAG/$FILENAME"

  echo ""
  echo "开始下载测试（${DOWNLOAD_TIMEOUT}秒超时）..."

  START_DOWNLOAD=$(date +%s.%N)

  if ! curl --fail --location --proto '=https' --tlsv1.2 \
    --connect-timeout 30 --max-time "$DOWNLOAD_TIMEOUT" \
    --progress-bar \
    "$DOWNLOAD_URL" -o "$ARCHIVE" 2>&1; then
    print_error "下载失败或超时"
    DOWNLOAD_SUCCESS=false
    DOWNLOAD_SPEED=0
    return 1
  fi

  END_DOWNLOAD=$(date +%s.%N)
  DOWNLOAD_TIME=$(echo "$END_DOWNLOAD - $START_DOWNLOAD" | bc)

  # 计算速度
  FILE_SIZE=$(stat -c %s "$ARCHIVE" 2>/dev/null || stat -f %z "$ARCHIVE" 2>/dev/null)
  FILE_SIZE_MB=$(echo "scale=2; $FILE_SIZE / 1024 / 1024" | bc)
  DOWNLOAD_SPEED=$(echo "scale=2; $FILE_SIZE_MB / $DOWNLOAD_TIME" | bc)

  echo ""
  print_success "下载完成"
  echo "  文件大小: ${FILE_SIZE_MB} MB"
  echo "  下载耗时: ${DOWNLOAD_TIME}s"
  echo "  平均速度: ${DOWNLOAD_SPEED} MB/s"

  DOWNLOAD_SUCCESS=true

  # 判断是否需要优化
  NEEDS_OPTIMIZATION=$(python3 -c "print('true' if $DOWNLOAD_SPEED < $SPEED_THRESHOLD else 'false')")
}

# 检查是否已部署镜像
check_existing_mirror() {
  print_step "步骤 2: 检查现有镜像配置"

  MIRROR_EXISTS=false

  # 检查环境变量配置
  if [ -f "/etc/project-aggregation/environment" ]; then
    if grep -q "PROJECT_RELEASE_MIRROR" /etc/project-aggregation/environment; then
      EXISTING_MIRROR=$(grep PROJECT_RELEASE_MIRROR /etc/project-aggregation/environment | cut -d= -f2)
      print_info "已配置镜像: $EXISTING_MIRROR"
      MIRROR_EXISTS=true
    fi
  fi

  # 检查 Nginx 是否在运行
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
      print_info "Nginx 服务正在运行"
      NGINX_RUNNING=true
    else
      NGINX_RUNNING=false
    fi
  else
    NGINX_RUNNING=false
  fi

  if [ "$MIRROR_EXISTS" = true ]; then
    print_success "已部署镜像，无需重复部署"
    return 0
  else
    print_info "未检测到镜像配置"
    return 1
  fi
}

# 部署 Nginx 镜像
deploy_nginx_mirror() {
  print_step "步骤 3: 部署 Nginx 镜像"

  if [ "$CAN_DEPLOY" = false ]; then
    print_error "需要 root 权限才能部署镜像"
    echo ""
    echo "请使用以下命令重新运行："
    echo "  sudo $0"
    return 1
  fi

  # 检查脚本是否存在
  if [ ! -f "deploy/setup-release-mirror.sh" ]; then
    print_error "找不到部署脚本: deploy/setup-release-mirror.sh"
    echo "请确保在项目根目录运行此脚本"
    return 1
  fi

  echo "正在部署 Nginx 镜像..."
  if bash deploy/setup-release-mirror.sh; then
    print_success "Nginx 镜像部署成功"
  else
    print_error "Nginx 镜像部署失败"
    return 1
  fi

  echo ""
  echo "正在配置工作台使用镜像..."
  if bash deploy/configure-release-mirror.sh; then
    print_success "工作台配置成功"
  else
    print_error "工作台配置失败"
    return 1
  fi
}

# 验证镜像效果
verify_mirror() {
  print_step "步骤 4: 验证镜像效果"

  if [ ! -f "deploy/test-mirror-performance.sh" ]; then
    print_warning "找不到性能测试脚本，跳过验证"
    return 0
  fi

  echo "运行性能对比测试..."
  bash deploy/test-mirror-performance.sh
}

# 生成报告
generate_report() {
  print_step "优化报告"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  下载速度: ${DOWNLOAD_SPEED} MB/s"
  echo "  速度阈值: ${SPEED_THRESHOLD} MB/s"
  echo "  需要优化: $NEEDS_OPTIMIZATION"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ "$NEEDS_OPTIMIZATION" = "false" ]; then
    print_success "下载速度良好，无需部署镜像"
    echo ""
    echo "当前速度已达标（≥ ${SPEED_THRESHOLD} MB/s）"
    echo "预计更新耗时: 约 $(python3 -c "print(int(108 / $DOWNLOAD_SPEED))") 秒"
  else
    if [ "$MIRROR_EXISTS" = true ]; then
      print_info "已部署镜像，但速度仍较慢"
      echo ""
      echo "可能的原因："
      echo "  1. 镜像缓存未命中（首次下载）"
      echo "  2. 网络问题"
      echo "  3. GitHub 限流"
      echo ""
      echo "建议："
      echo "  等待下次更新验证缓存效果"
    elif [ "$DEPLOYED_MIRROR" = true ]; then
      print_success "已完成镜像部署"
      echo ""
      echo "优化效果："
      echo "  首次更新: 仍需从 GitHub 下载（约 ${DOWNLOAD_TIME}s）"
      echo "  后续更新: 从本地镜像读取（预计 10-20s）"
      echo "  速度提升: 预计 5-10 倍"
    else
      print_warning "下载速度较慢，建议部署镜像"
      echo ""
      echo "要部署镜像，请以 root 权限运行："
      echo "  sudo $0"
      echo ""
      echo "或者手动部署："
      echo "  sudo bash deploy/setup-release-mirror.sh"
      echo "  sudo bash deploy/configure-release-mirror.sh"
    fi
  fi

  echo ""
}

# 主流程
main() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Project Aggregation 一键优化工具"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # 检查权限
  check_root

  # 测试下载速度
  if ! test_download_speed; then
    print_error "下载测试失败，无法继续"
    exit 1
  fi

  # 检查现有镜像
  if check_existing_mirror; then
    MIRROR_EXISTS=true
    generate_report
    exit 0
  else
    MIRROR_EXISTS=false
  fi

  # 判断是否需要部署
  DEPLOYED_MIRROR=false
  if [ "$NEEDS_OPTIMIZATION" = "true" ]; then
    if [ "$AUTO_DEPLOY" = "true" ] && [ "$CAN_DEPLOY" = "true" ]; then
      echo ""
      print_warning "检测到下载速度较慢（${DOWNLOAD_SPEED} MB/s < ${SPEED_THRESHOLD} MB/s）"
      echo ""
      read -p "是否立即部署 Nginx 镜像？(y/N) " -n 1 -r
      echo
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        if deploy_nginx_mirror; then
          DEPLOYED_MIRROR=true
          verify_mirror
        fi
      else
        print_info "跳过镜像部署"
      fi
    fi
  fi

  # 生成报告
  generate_report
}

main "$@"
