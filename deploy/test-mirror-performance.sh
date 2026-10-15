#!/usr/bin/env bash
# 一键测试发布包下载性能对比
# 对比 GitHub 直连 vs Nginx 镜像 vs 阿里云 OSS

set -Eeuo pipefail

# 配置
GITHUB_REPO="hxx344/project-aggregation"
TEST_ITERATIONS=${TEST_ITERATIONS:-1}  # 默认只测试 1 次
DOWNLOAD_TIMEOUT=${DOWNLOAD_TIMEOUT:-60}  # 60 秒超时
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
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

format_time() {
    local seconds=$1
    printf "%.2f秒" "$seconds"
}

format_speed() {
    local bytes=$1
    local seconds=$2
    local speed=$(echo "scale=2; $bytes / $seconds / 1024 / 1024" | bc)
    printf "%.2f MB/s" "$speed"
}

# 测试下载速度
test_download() {
    local name=$1
    local url=$2
    local output=$3
    local cache_status=${4:-}

    echo ""
    echo -e "${YELLOW}测试: $name${NC}"
    echo "URL: $url"

    # 预热（如果是镜像）
    if [[ -n "$cache_status" ]]; then
        echo "预热缓存..."
        curl --fail --silent --max-time 120 "$url" -o /dev/null 2>&1 || true
        sleep 2
    fi

    local total_time=0
    local total_size=0
    local success_count=0

    for i in $(seq 1 $TEST_ITERATIONS); do
        echo -n "  第 $i 次测试: "

        # 清空本地缓存
        rm -f "$output"

        # 下载并计时
        local start=$(date +%s.%N)
        if curl --fail --silent --show-error --max-time $DOWNLOAD_TIMEOUT \
                --write-out "\n%{http_code}\n%{size_download}\n%{speed_download}\n%{time_total}\n" \
                "$url" -o "$output" > "$TEMP_DIR/curl_stats_${i}.txt" 2>&1; then

            local end=$(date +%s.%N)
            local elapsed=$(echo "$end - $start" | bc)

            # 读取统计信息
            local http_code=$(sed -n '1p' "$TEMP_DIR/curl_stats_${i}.txt")
            local size=$(sed -n '2p' "$TEMP_DIR/curl_stats_${i}.txt")
            local speed=$(sed -n '3p' "$TEMP_DIR/curl_stats_${i}.txt")
            local time_total=$(sed -n '4p' "$TEMP_DIR/curl_stats_${i}.txt")

            if [[ "$http_code" == "200" ]] && [[ -f "$output" ]]; then
                local file_size=$(stat -c%s "$output" 2>/dev/null || stat -f%z "$output" 2>/dev/null)
                local mb_size=$(echo "scale=2; $file_size / 1024 / 1024" | bc)
                local dl_speed=$(format_speed "$file_size" "$elapsed")

                # 检查缓存状态（如果是镜像）
                local cache_hint=""
                if [[ -n "$cache_status" ]]; then
                    local cache_result=$(curl -s -I "$url" | grep -i "X-Cache-Status" | cut -d' ' -f2 | tr -d '\r\n' || echo "UNKNOWN")
                    cache_hint=" [Cache: $cache_result]"
                fi

                print_success "$(format_time $elapsed) | ${mb_size} MB | ${dl_speed}${cache_hint}"

                total_time=$(echo "$total_time + $elapsed" | bc)
                total_size=$file_size
                success_count=$((success_count + 1))
            else
                print_error "HTTP $http_code"
            fi
        else
            # 下载失败：记录错误
            local elapsed=$(echo "$(date +%s.%N) - $start" | bc)
            local error_msg=$(tail -1 "$TEMP_DIR/curl_stats_${i}.txt" 2>/dev/null || echo "未知错误")

            # 判断是超时还是其他错误
            if echo "$error_msg" | grep -qi "timeout\|timed out\|Operation too slow"; then
                error_msg="下载超时（>${DOWNLOAD_TIMEOUT}秒）"
            fi

            print_error "${error_msg}"
        fi

        # 短暂延迟避免请求过快
        sleep 1
    done

    # 计算平均值
    if [[ $success_count -gt 0 ]]; then
        local avg_time=$(echo "scale=2; $total_time / $success_count" | bc)
        local avg_speed=$(format_speed "$total_size" "$avg_time")
        local mb_size=$(echo "scale=2; $total_size / 1024 / 1024" | bc)

        echo ""
        echo -e "${GREEN}平均结果:${NC}"
        echo "  时间: $(format_time $avg_time)"
        echo "  大小: ${mb_size} MB"
        echo "  速度: ${avg_speed}"
        echo "  成功率: ${success_count}/${TEST_ITERATIONS}"

        # 返回平均时间（用于后续比较）
        echo "$avg_time" > "$TEMP_DIR/${name}_time.txt"
        echo "$avg_speed" > "$TEMP_DIR/${name}_speed.txt"
    else
        print_error "所有测试均失败"
        echo "999999" > "$TEMP_DIR/${name}_time.txt"
        echo "0 MB/s" > "$TEMP_DIR/${name}_speed.txt"
    fi
}

# 获取最新发布信息
get_latest_release() {
    print_header "获取最新发布信息"

    local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
    echo "API: $api_url"

    if ! curl --fail --silent --max-time 30 "$api_url" > "$TEMP_DIR/release.json" 2>&1; then
        print_error "无法获取发布信息"
        exit 1
    fi

    local tag=$(grep -o '"tag_name":\s*"[^"]*"' "$TEMP_DIR/release.json" | head -1 | sed 's/.*"tag_name":\s*"\([^"]*\)".*/\1/')
    local asset_url=$(grep -o '"browser_download_url":\s*"[^"]*linux-x64.tar.gz"' "$TEMP_DIR/release.json" | head -1 | sed 's/.*"browser_download_url":\s*"\([^"]*\)".*/\1/')

    if [[ -z "$tag" ]] || [[ -z "$asset_url" ]]; then
        print_error "解析发布信息失败"
        cat "$TEMP_DIR/release.json"
        exit 1
    fi

    print_success "最新版本: $tag"
    print_success "下载地址: $asset_url"

    echo "$asset_url" > "$TEMP_DIR/asset_url.txt"
}

# 主测试流程
main() {
    print_header "发布包下载性能测试"
    echo "测试仓库: $GITHUB_REPO"
    echo "测试次数: $TEST_ITERATIONS 次（每次最多 ${DOWNLOAD_TIMEOUT} 秒）"
    echo "测试时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
    echo -e "${YELLOW}💡 提示: 可通过环境变量调整测试参数${NC}"
    echo "  TEST_ITERATIONS=3     # 测试 3 次求平均值"
    echo "  DOWNLOAD_TIMEOUT=120  # 超时时间 120 秒"
    echo ""

    # 1. 获取发布信息
    get_latest_release
    local asset_url=$(cat "$TEMP_DIR/asset_url.txt")

    # 2. 测试 GitHub 直连
    print_header "测试 1: GitHub 直连"
    test_download "github" "$asset_url" "$TEMP_DIR/github.tar.gz"

    # 3. 测试 Nginx 镜像（如果配置了）
    local mirror_domain=""
    if [[ -f "/etc/project-aggregation/release-mirror.conf" ]]; then
        source /etc/project-aggregation/release-mirror.conf
        mirror_domain="$RELEASE_MIRROR_DOMAIN"
    fi

    if [[ -n "$mirror_domain" ]]; then
        print_header "测试 2: Nginx 镜像"
        local mirror_url="${asset_url/github.com/$mirror_domain}"
        test_download "nginx" "$mirror_url" "$TEMP_DIR/nginx.tar.gz" "check"
    else
        print_warning "未配置 Nginx 镜像，跳过测试"
        echo "999999" > "$TEMP_DIR/nginx_time.txt"
        echo "N/A" > "$TEMP_DIR/nginx_speed.txt"
    fi

    # 4. 测试阿里云 OSS（如果配置了）
    local oss_domain="${ALIYUN_OSS_MIRROR:-}"
    if [[ -n "$oss_domain" ]]; then
        print_header "测试 3: 阿里云 OSS CDN"
        local oss_url="${asset_url/github.com/$oss_domain}"
        test_download "oss" "$oss_url" "$TEMP_DIR/oss.tar.gz"
    else
        print_warning "未配置阿里云 OSS，跳过测试"
        echo "999999" > "$TEMP_DIR/oss_time.txt"
        echo "N/A" > "$TEMP_DIR/oss_speed.txt"
    fi

    # 5. 生成对比报告
    generate_report
}

generate_report() {
    print_header "性能对比报告"

    local github_time=$(cat "$TEMP_DIR/github_time.txt")
    local github_speed=$(cat "$TEMP_DIR/github_speed.txt")

    local nginx_time=$(cat "$TEMP_DIR/nginx_time.txt")
    local nginx_speed=$(cat "$TEMP_DIR/nginx_speed.txt")

    local oss_time=$(cat "$TEMP_DIR/oss_time.txt")
    local oss_speed=$(cat "$TEMP_DIR/oss_speed.txt")

    echo ""
    echo "| 下载源 | 平均耗时 | 平均速度 | 相比 GitHub |"
    echo "|--------|---------|---------|------------|"

    # GitHub 基线
    printf "| GitHub 直连 | %s | %s | 基线 |\n" \
        "$(format_time $github_time)" "$github_speed"

    # Nginx 镜像
    if [[ "$nginx_time" != "999999" ]]; then
        local nginx_improvement=$(echo "scale=1; (1 - $nginx_time / $github_time) * 100" | bc)
        local nginx_speedup=$(echo "scale=1; $github_time / $nginx_time" | bc)
        printf "| Nginx 镜像 | %s | %s | " \
            "$(format_time $nginx_time)" "$nginx_speed"
        if (( $(echo "$nginx_improvement > 0" | bc -l) )); then
            echo -e "${GREEN}快 ${nginx_improvement}% (${nginx_speedup}x)${NC} |"
        else
            echo "相当 |"
        fi
    else
        echo "| Nginx 镜像 | - | - | 未配置 |"
    fi

    # 阿里云 OSS
    if [[ "$oss_time" != "999999" ]]; then
        local oss_improvement=$(echo "scale=1; (1 - $oss_time / $github_time) * 100" | bc)
        local oss_speedup=$(echo "scale=1; $github_time / $oss_time" | bc)
        printf "| 阿里云 OSS | %s | %s | " \
            "$(format_time $oss_time)" "$oss_speed"
        if (( $(echo "$oss_improvement > 0" | bc -l) )); then
            echo -e "${GREEN}快 ${oss_improvement}% (${oss_speedup}x)${NC} |"
        else
            echo "相当 |"
        fi
    else
        echo "| 阿里云 OSS | - | - | 未配置 |"
    fi

    echo ""

    # 推荐建议
    print_header "优化建议"

    if [[ "$nginx_time" == "999999" ]] && [[ "$oss_time" == "999999" ]]; then
        print_warning "当前未配置任何镜像加速"
        echo ""
        echo "基于当前测试结果，建议："
        echo ""

        if (( $(echo "$github_time > 60" | bc -l) )); then
            print_warning "GitHub 下载较慢 (>60秒)，强烈建议部署镜像加速"
            echo ""
            echo "快速部署 Nginx 镜像："
            echo "  1. 在日本服务器运行: sudo bash deploy/setup-release-mirror.sh"
            echo "  2. 在工作台配置: sudo bash deploy/configure-release-mirror.sh"
            echo ""
            echo "预期提升: 87秒 → 12秒 (约 7 倍)"
        else
            print_success "GitHub 直连速度尚可，可暂不部署镜像"
        fi
    else
        # 找出最快的方案
        local fastest="github"
        local fastest_time=$github_time

        if [[ "$nginx_time" != "999999" ]] && (( $(echo "$nginx_time < $fastest_time" | bc -l) )); then
            fastest="nginx"
            fastest_time=$nginx_time
        fi

        if [[ "$oss_time" != "999999" ]] && (( $(echo "$oss_time < $fastest_time" | bc -l) )); then
            fastest="oss"
            fastest_time=$oss_time
        fi

        case $fastest in
            github)
                print_success "GitHub 直连最快，当前配置最优"
                ;;
            nginx)
                print_success "Nginx 镜像最快，已优化"
                local improvement=$(echo "scale=1; (1 - $fastest_time / $github_time) * 100" | bc)
                echo "  相比 GitHub 提升: ${improvement}%"
                ;;
            oss)
                print_success "阿里云 OSS 最快，已优化"
                local improvement=$(echo "scale=1; (1 - $fastest_time / $github_time) * 100" | bc)
                echo "  相比 GitHub 提升: ${improvement}%"
                ;;
        esac
    fi

    echo ""
    print_header "测试完成"
    echo "测试数据保存在: $TEMP_DIR"
    echo ""
}

# 检查依赖
check_dependencies() {
    local missing=()

    if ! command -v curl &>/dev/null; then
        missing+=("curl")
    fi

    if ! command -v bc &>/dev/null; then
        missing+=("bc")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        print_error "缺少必需工具: ${missing[*]}"
        echo ""
        echo "安装命令："
        echo "  Ubuntu/Debian: sudo apt-get install ${missing[*]}"
        echo "  CentOS/RHEL: sudo yum install ${missing[*]}"
        exit 1
    fi
}

# 入口
check_dependencies
main "$@"
