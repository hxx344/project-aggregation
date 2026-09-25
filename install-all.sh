#!/usr/bin/env bash
# Coordinate existing installers without taking ownership of their data or services.
set -Eeuo pipefail

STACK_CACHE=/var/cache/project-aggregation-stack
STACK_LOGS=/var/log/project-aggregation-stack
STACK_LOCK=/run/lock/project-aggregation-stack.lock
STACK_ORDER=(aster monitor asset crossex variational hub)
declare -A STACK_REPOS=(
  [aster]=aster_5x [monitor]=market-spread-monitor [asset]=asset-ledger
  [variational]=variational-grid [crossex]=gate-crossex-arbitrage [hub]=project-aggregation
)
declare -A STACK_PATHS=(
  [aster]=install-trading.sh [monitor]=deploy/install.sh [asset]=install.sh
  [variational]=install.sh [crossex]=install.sh [hub]=install.sh
)
declare -A STACK_NAMES=(
  [aster]='ASTER 5X' [monitor]='Market Monitor' [asset]='Asset Ledger'
  [variational]='Variational Grid' [crossex]='Gate CrossEx' [hub]='Project Aggregation'
)
declare -A stack_status=() stack_seconds=()
stack_selected=()
stack_workers=()
stack_refresh=0 stack_run='' stack_active='' stack_child='' stack_viewer=''
  stack_started=$SECONDS
stack_input=''

stack_log() { printf '[总部署] %s\n' "$*"; }
stack_fail() { stack_log "错误：$*" >&2; return 1; }
stack_usage() {
  cat <<'HELP'
用法：sudo bash install-all.sh [--only aster,monitor,asset,crossex,variational,hub] [--refresh]
默认安装或升级五个模块及平台；已有配置、密码和数据由各自安装器保留。
支持 Ubuntu 22.04/24.04、Debian 12/13，x64/arm64，需 systemd。
  Variational 需要 Python 3.11+；Ubuntu 22.04 默认 Python 不满足要求。
  首次导入行情令牌请从交互式 SSH 终端运行，输入隐藏且不写入日志。
  --only     只检查和部署指定项目，始终按上述顺序执行，平台最后部署。
  --refresh  重新下载安装器；不强制重装应用依赖、构建或重启。
  --help     查看说明，无需 root。
失败后修复原因并重复原命令；已完成项目仍会检查配置和服务健康。
HELP
}

stack_parse() {
  local only='' item
  local -A requested=()
  while (($#)); do
    case "$1" in
      --only)
        (($# >= 2)) && [[ -n "$2" && -z "$only" ]] || { stack_fail '--only 需要一个非空列表，且只能指定一次。'; return 1; }
        only=$2; shift 2 ;;
      --refresh) stack_refresh=1; shift ;;
      *) stack_fail "未知参数：$1；使用 --help 查看说明。"; return 1 ;;
    esac
  done
  if [[ -z "$only" ]]; then stack_selected=("${STACK_ORDER[@]}"); return; fi
  [[ "$only" != ,* && "$only" != *, && "$only" != *,,* ]] || { stack_fail '项目列表不能含空项。'; return 1; }
  local -a items
  IFS=, read -r -a items <<< "$only"
  for item in "${items[@]}"; do
    # Validate before using a user-supplied associative array subscript.
    case "$item" in aster|monitor|asset|crossex|variational|hub) requested[$item]=1 ;;
      *) stack_fail "未知项目：$item"; return 1 ;; esac
  done
  stack_selected=()
  for item in "${STACK_ORDER[@]}"; do
    if [[ ${requested[$item]:-0} == 1 ]]; then stack_selected+=("$item"); fi
  done
}

stack_preflight() {
  [[ $(uname -s) == Linux ]] || { stack_fail '总部署只用于 Linux 服务器。'; return 1; }
  [[ $EUID == 0 ]] || { stack_fail '请使用 sudo bash install-all.sh。'; return 1; }
  [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null || { stack_fail '需要正在运行的 systemd。'; return 1; }
  local ID='' VERSION_ID=''
  # Distribution metadata, never an application environment file.
  source /etc/os-release
  case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;;
    *) stack_fail '支持 Ubuntu 22.04/24.04、Debian 12/13。'; return 1 ;; esac
  case $(uname -m) in x86_64|aarch64|arm64) ;; *) stack_fail '仅支持 x64 或 arm64。'; return 1 ;; esac
  if [[ " ${stack_selected[*]} " == *' variational '* ]]; then stack_variational_preflight "$ID:$VERSION_ID"; fi
  command -v apt-get >/dev/null && command -v dpkg-query >/dev/null && command -v flock >/dev/null || {
    stack_fail '需要 apt-get、dpkg-query 和 util-linux 的 flock。'; return 1;
  }
}

# Open the terminal before setsid, preserving hidden getpass input in the child.
stack_variational_python_ready() { /usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; }
stack_open_terminal() { { exec {stack_input}</dev/tty; } 2>/dev/null; }
stack_variational_session_ready() {
  local current=/opt/variational-grid/current conf=/etc/variational-grid mode config=config.json
  [[ -d $current && -f $conf/mode ]] || return 1
  mode=$(cat "$conf/mode")
  [[ $mode != inventory ]] || config=inventory-base.json
  (cd "$current" && runuser -u variational-grid -- /usr/bin/python3 -m variational_grid check-session --config "$conf/$config") >/dev/null 2>&1
}
stack_variational_preflight() {
  if [[ $1 == ubuntu:22.04 || -x /usr/bin/python3 ]]; then
    stack_variational_python_ready || { stack_fail 'Variational Grid 需要 /usr/bin/python3 3.11+；请使用 Debian 12/13 或 Ubuntu 24.04，或用 --only aster,monitor,asset,crossex,hub 跳过此模块。'; return 1; }
  fi
  if stack_open_terminal; then return; fi
  stack_input=''
  stack_variational_session_ready || { stack_fail 'Variational Grid 首次安装或令牌失效时需要交互式终端，请在 SSH 终端重跑原命令以隐藏输入 vr-token。尚未安装或更新任何模块。'; return 1; }
}

stack_ensure_tools() {
  local item package
  local -a packages=(ca-certificates curl) missing=()
  local -A wanted=([ca-certificates]=1 [curl]=1)
  for item in "${stack_selected[@]}"; do
    case "$item" in
      aster) packages+=(python3 python3-venv tar xz-utils util-linux passwd) ;;
      variational) packages+=(python3 git util-linux passwd) ;;
      monitor) packages+=(python3 xz-utils util-linux passwd iproute2) ;;
      asset|crossex|hub) packages+=(git xz-utils tar util-linux passwd) ;;
    esac
  done
  for package in "${packages[@]}"; do wanted[$package]=1; done
  for package in "${!wanted[@]}"; do
    if [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) != 'install ok installed' ]]; then missing+=("$package"); fi
  done
  if ((${#missing[@]})); then
    stack_log "一次安装缺少的系统依赖：${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  else
    stack_log '系统依赖已齐全，跳过 apt 更新和安装。'
  fi
}

stack_private_dir() {
  local directory=$1
  [[ ! -L "$directory" ]] || { stack_fail "目录不能是符号链接：$directory"; return 1; }
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && $(stat -c %u "$directory") == 0 ]] || { stack_fail "目录应归 root 所有：$directory"; return 1; }
  fi
  install -d -m 0700 "$directory"
}

stack_cache_valid() {
  local directory=$1 expected actual
  [[ -f "$directory/install.sh" && -f "$directory/sha256" && ! -L "$directory/install.sh" ]] || return 1
  expected=$(cat "$directory/sha256")
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || return 1
  actual=$(sha256sum "$directory/install.sh" | cut -d ' ' -f1)
  [[ "$expected" == "$actual" ]] && bash -n "$directory/install.sh"
}

stack_fetch() {
  local item=$1 directory="$STACK_CACHE/$1" staged="$stack_run/$1.download" code
  local url="https://raw.githubusercontent.com/hxx344/${STACK_REPOS[$1]}/main/${STACK_PATHS[$1]}"
  local -a conditional=()
  stack_private_dir "$directory"
  mkdir "$staged"
  : > "$staged/etag"
  if (( ! stack_refresh )) && stack_cache_valid "$directory" && [[ -s "$directory/etag" ]]; then
    conditional=(--etag-compare "$directory/etag")
  fi
  code=$(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 2 --connect-timeout 15 --max-time 90 --etag-save "$staged/etag" \
    "${conditional[@]}" --output "$staged/install.sh" --write-out '%{http_code}' "$url") || return 1
  case "$code" in
    304)
      stack_cache_valid "$directory" || { stack_fail "${STACK_NAMES[$item]} 安装器缓存无效。"; return 1; }
      stack_log "${STACK_NAMES[$item]}：安装器未变，复用缓存。" ;;
    200)
      [[ -s "$staged/install.sh" ]] && head -n1 "$staged/install.sh" | grep -Eq '^#!.*bash' || {
        stack_fail "${STACK_NAMES[$item]} 返回的不是 Bash 安装器。"; return 1;
      }
      bash -n "$staged/install.sh" || return 1
      sha256sum "$staged/install.sh" | cut -d ' ' -f1 > "$staged/sha256"
      # A partial update invalidates the digest and triggers a full download next run.
      mv -f "$staged/install.sh" "$directory/install.sh"
      mv -f "$staged/sha256" "$directory/sha256"
      mv -f "$staged/etag" "$directory/etag"
      stack_log "${STACK_NAMES[$item]}：已获取并校验安装器。" ;;
    *) stack_fail "${STACK_NAMES[$item]} 下载状态异常：$code"; return 1 ;;
  esac
  cp "$directory/install.sh" "$stack_run/$item.sh"
  printf '%s\t%s\n' "$item" "$(cat "$directory/sha256")" > "$stack_run/$item.sha256"
  # Only files created for this download are removed; failed downloads stay in the log directory.
  rm -f -- "$staged/install.sh" "$staged/etag"
  rmdir "$staged"
}

stack_prefetch() {
  local offset item index result=0 pid
  # At most three small downloads; builds and service activation remain sequential.
  for ((offset=0; offset<${#stack_selected[@]}; offset+=3)); do
    stack_workers=()
    for ((index=offset; index<offset+3 && index<${#stack_selected[@]}; index++)); do
      item=${stack_selected[index]}
      (stack_fetch "$item") > "$stack_run/$item.download.log" 2>&1 &
      stack_workers+=("$!")
    done
    for pid in "${stack_workers[@]}"; do wait "$pid" || result=1; done
    stack_workers=()
    for ((index=offset; index<offset+3 && index<${#stack_selected[@]}; index++)); do
      cat "$stack_run/${stack_selected[index]}.download.log"
    done
    (( result == 0 )) || { stack_fail '安装器准备失败，尚未运行任何项目安装器；修复网络或下载错误后重试。'; return 1; }
  done
}

stack_summary() {
  local item
  printf '\n%-12s %-16s %s\n' '项目' '结果' '耗时（秒）'
  for item in "${stack_selected[@]}"; do
    printf '%-12s %-16s %s\n' "$item" "${stack_status[$item]:-未执行}" "${stack_seconds[$item]:--}"
  done
  stack_log "总耗时：$((SECONDS - stack_started)) 秒"
  [[ -z "$stack_run" ]] || stack_log "本次日志：$stack_run（仅 root 可读，可能含首次登录信息）"
}

stack_signal() {
  local status=$1 pid
  trap '' HUP INT TERM
  if [[ -n "$stack_child" ]]; then
    stack_log '正在等待当前安装器退出并完成自身恢复，请勿关闭服务器。'
    # The installer and its children share a dedicated session. Keep our lock until it exits.
    kill -TERM -- "-$stack_child" 2>/dev/null || true
    wait "$stack_child" || true
    stack_child=''
  fi
  if [[ -n "$stack_viewer" ]]; then wait "$stack_viewer" || true; stack_viewer=''; fi
  for pid in "${stack_workers[@]}"; do wait "$pid" || true; done
  if [[ -n "$stack_active" ]]; then stack_status[$stack_active]='已中断'; fi
  exit "$status"
}

stack_finish() {
  local status=$?
  trap - EXIT
  if [[ -n "$stack_run" ]]; then stack_summary | tee "$stack_run/summary.txt"; fi
  exit "$status"
}

stack_stream() {
  # Console failure must not become an installer failure; the durable log is independent.
  tail --pid="$1" --sleep-interval=0.2 -n +1 -f "$2"
}

stack_run_installers() {
  local item started result
  for item in "${stack_selected[@]}"; do
    stack_active=$item
    stack_status[$item]='运行中'
    started=$SECONDS
    stack_log "开始 ${STACK_NAMES[$item]}；详细进度：$stack_run/$item.log"
    # Do not use 'if bash ...' or source the installer: preserve its own errexit and traps.
    # Log directly to disk; a broken console/tee must not abort a service activation.
    : > "$stack_run/$item.log"
    if [[ $item == variational && -n $stack_input ]]; then
      VARIATIONAL_SESSION_STDIN=1 setsid bash "$stack_run/$item.sh" <&"$stack_input" > "$stack_run/$item.log" 2>&1 &
    elif [[ $item == variational ]]; then
      VARIATIONAL_SESSION_STDIN=1 setsid bash "$stack_run/$item.sh" </dev/null > "$stack_run/$item.log" 2>&1 &
    else
      setsid bash "$stack_run/$item.sh" </dev/null > "$stack_run/$item.log" 2>&1 &
    fi
    stack_child=$!
    stack_stream "$stack_child" "$stack_run/$item.log" &
    stack_viewer=$!
    if wait "$stack_child"; then result=0; else result=$?; fi
    stack_child=''
    wait "$stack_viewer" || true
    stack_viewer=''
    stack_seconds[$item]=$((SECONDS - started))
    if (( result != 0 )); then
      stack_status[$item]="失败（$result）"
      stack_log "${STACK_NAMES[$item]} 失败，后续项目未执行；末尾日志："
      tail -n 40 "$stack_run/$item.log"
      stack_log '该项目的恢复结果请查看日志；此前成功的项目保留。修复后重复原命令即可。'
      stack_active=''
      return "$result"
    fi
    stack_status[$item]='完成检查/部署'
    stack_log "${STACK_NAMES[$item]} 完成，用时 ${stack_seconds[$item]} 秒。"
    stack_active=''
  done
}

stack_main() {
  if [[ ${1:-} == --help || ${1:-} == -h ]]; then stack_usage; return; fi
  stack_parse "$@"
  stack_preflight
  umask 077
  mkdir -p /run/lock
  exec 8>"$STACK_LOCK"
  flock -n 8 || { stack_fail '另一个总部署正在运行，请等待其结束。'; return 1; }
  stack_private_dir "$STACK_CACHE"
  stack_private_dir "$STACK_LOGS"
  stack_run=$(mktemp -d "$STACK_LOGS/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
  trap stack_finish EXIT
  trap 'stack_signal 129' HUP
  trap 'stack_signal 130' INT
  trap 'stack_signal 143' TERM
  stack_log "本次项目：${stack_selected[*]}"
  stack_log "日志目录：$stack_run"
  stack_ensure_tools
  stack_prefetch
  stack_run_installers
  stack_log '所选项目均已完成检查或部署；更新与跳过项见各项目日志。'
  if [[ " ${stack_selected[*]} " == *' hub '* ]]; then
    stack_log '默认工作台端口为 3100；已有自定义端口保留。首次连接原项目仍需在项目管理中保存各自网页登录凭据。'
  fi
}

# Tests replace OS/package/network/service boundaries; never install to the test host.
if [[ ${AGG_STACK_SOURCE_ONLY:-0} != 1 ]]; then stack_main "$@"; fi
