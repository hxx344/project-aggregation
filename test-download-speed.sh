#!/usr/bin/env bash
# 测试从 GitHub 下载发布包的完整耗时（60 秒超时）
set -Eeuo pipefail

REPOSITORY=hxx344/project-aggregation
DOWNLOAD_TIMEOUT=${DOWNLOAD_TIMEOUT:-60}  # 默认 60 秒超时
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "========================================="
echo "测试环境信息"
echo "========================================="
echo "服务器架构: $(uname -m)"
echo "操作系统: $(uname -s) $(uname -r)"
echo "下载超时: ${DOWNLOAD_TIMEOUT} 秒"
echo "工作目录: $WORK_DIR"
echo ""

# 1. 测试获取发布清单
echo "========================================="
echo "步骤 1: 获取最新发布清单"
echo "========================================="
MANIFEST="$WORK_DIR/release-manifest.json"
START_MANIFEST=$(date +%s.%N)

if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 3 --connect-timeout 15 --max-time 90 --max-filesize 1048576 \
  "https://github.com/$REPOSITORY/releases/latest/download/release-manifest.json" \
  -o "$MANIFEST"; then
  echo "❌ 获取发布清单失败"
  exit 1
fi

END_MANIFEST=$(date +%s.%N)
MANIFEST_TIME=$(echo "$END_MANIFEST - $START_MANIFEST" | bc)
echo "✅ 清单下载完成: ${MANIFEST_TIME}s"
echo ""

# 2. 解析清单
echo "========================================="
echo "步骤 2: 解析发布信息"
echo "========================================="
VALUES=$(python3 -I - "$MANIFEST" "$REPOSITORY" "$(uname -m)" <<'MANIFEST_PY'
import json, re, sys
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

echo "提交: $COMMIT"
echo "标签: $TAG"
echo "文件: $FILENAME"
echo "SHA256: ${SHA256:0:16}..."
echo ""

# 3. 测试下载速度（使用 curl 显示进度）
echo "========================================="
echo "步骤 3: 下载发布包 (显示进度)"
echo "========================================="
ARCHIVE="$WORK_DIR/$FILENAME"
DOWNLOAD_URL="https://github.com/$REPOSITORY/releases/download/$TAG/$FILENAME"

echo "下载地址: $DOWNLOAD_URL"
echo ""

START_DOWNLOAD=$(date +%s.%N)

# 使用 curl 的进度显示，并计算速度（60 秒超时）
if ! curl --fail --location --proto '=https' --tlsv1.2 \
  --connect-timeout 30 --max-time $DOWNLOAD_TIMEOUT \
  --progress-bar \
  "$DOWNLOAD_URL" -o "$ARCHIVE"; then
  echo "❌ 下载失败或超时（>${DOWNLOAD_TIMEOUT}秒）"
  exit 1
fi

END_DOWNLOAD=$(date +%s.%N)
DOWNLOAD_TIME=$(echo "$END_DOWNLOAD - $START_DOWNLOAD" | bc)

# 获取文件大小
FILE_SIZE=$(stat -c %s "$ARCHIVE" 2>/dev/null || stat -f %z "$ARCHIVE" 2>/dev/null)
FILE_SIZE_MB=$(echo "scale=2; $FILE_SIZE / 1024 / 1024" | bc)
DOWNLOAD_SPEED=$(echo "scale=2; $FILE_SIZE_MB / $DOWNLOAD_TIME" | bc)

echo ""
echo "✅ 下载完成"
echo "   文件大小: ${FILE_SIZE_MB} MB"
echo "   下载耗时: ${DOWNLOAD_TIME}s"
echo "   平均速度: ${DOWNLOAD_SPEED} MB/s"
echo ""

# 4. 验证 SHA256
echo "========================================="
echo "步骤 4: 验证文件完整性"
echo "========================================="
START_VERIFY=$(date +%s.%N)

ACTUAL_SHA256=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
if [[ "$ACTUAL_SHA256" != "$SHA256" ]]; then
  echo "❌ SHA256 校验失败"
  echo "   期望: $SHA256"
  echo "   实际: $ACTUAL_SHA256"
  exit 1
fi

END_VERIFY=$(date +%s.%N)
VERIFY_TIME=$(echo "$END_VERIFY - $START_VERIFY" | bc)
echo "✅ SHA256 校验通过: ${VERIFY_TIME}s"
echo ""

# 5. 测试解压速度
echo "========================================="
echo "步骤 5: 解压发布包"
echo "========================================="
EXTRACT_DIR="$WORK_DIR/extracted"
mkdir -p "$EXTRACT_DIR"

START_EXTRACT=$(date +%s.%N)

if ! tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"; then
  echo "❌ 解压失败"
  exit 1
fi

END_EXTRACT=$(date +%s.%N)
EXTRACT_TIME=$(echo "$END_EXTRACT - $START_EXTRACT" | bc)

# 统计解压后的文件
FILE_COUNT=$(find "$EXTRACT_DIR" -type f | wc -l)
EXTRACT_SIZE=$(du -sm "$EXTRACT_DIR" | cut -f1)

echo "✅ 解压完成: ${EXTRACT_TIME}s"
echo "   文件数量: $FILE_COUNT"
echo "   解压大小: ${EXTRACT_SIZE} MB"
echo ""

# 6. 总结
echo "========================================="
echo "完整流程总结"
echo "========================================="

TOTAL_TIME=$(echo "$MANIFEST_TIME + $DOWNLOAD_TIME + $VERIFY_TIME + $EXTRACT_TIME" | bc)

printf "%-20s %10s\n" "获取清单:" "${MANIFEST_TIME}s"
printf "%-20s %10s\n" "下载压缩包:" "${DOWNLOAD_TIME}s"
printf "%-20s %10s\n" "验证 SHA256:" "${VERIFY_TIME}s"
printf "%-20s %10s\n" "解压文件:" "${EXTRACT_TIME}s"
echo "----------------------------------------"
printf "%-20s %10s\n" "总计:" "${TOTAL_TIME}s"
echo ""

printf "%-20s %10s\n" "压缩包大小:" "${FILE_SIZE_MB} MB"
printf "%-20s %10s\n" "解压后大小:" "${EXTRACT_SIZE} MB"
printf "%-20s %10s\n" "平均下载速度:" "${DOWNLOAD_SPEED} MB/s"
printf "%-20s %10s\n" "文件数量:" "$FILE_COUNT"
echo ""

# 7. 显示关键文件
echo "========================================="
echo "关键运行文件检查"
echo "========================================="
REQUIRED_FILES=(
  "dist/index.html"
  "server/app.mjs"
  "modules/monitor/dist/client/index.html"
  "modules/asset/.next/BUILD_ID"
  "modules/crossex/dist/index.html"
  "modules/greeks/requirements.lock"
  "modules/aster/requirements.lock"
  "modules/aster/dashboard/dist/client/index.html"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [[ -f "$EXTRACT_DIR/$file" ]]; then
    SIZE=$(stat -c %s "$EXTRACT_DIR/$file" 2>/dev/null || stat -f %z "$EXTRACT_DIR/$file" 2>/dev/null)
    printf "✅ %-50s %10s bytes\n" "$file" "$SIZE"
  else
    printf "❌ %-50s %10s\n" "$file" "缺失"
  fi
done

echo ""
echo "========================================="
echo "测试完成！"
echo "========================================="
