#!/usr/bin/env bash
# Coordinate existing installers without taking ownership of their data or services.
set -Eeuo pipefail

STACK_CACHE=/var/cache/project-aggregation-stack
STACK_LOGS=/var/log/project-aggregation-stack
STACK_LOCK=/run/lock/project-aggregation-stack.lock
STACK_ORDER=(aster monitor asset crossex variational greeks hub)
declare -A STACK_REPOS=(
  [aster]=aster_5x [monitor]=market-spread-monitor [asset]=asset-ledger
  [variational]=variational-grid [crossex]=gate-crossex-arbitrage [greeks]=greeks [hub]=project-aggregation
)
declare -A STACK_PATHS=(
  [aster]=install-trading.sh [monitor]=deploy/install.sh [asset]=install.sh
  [variational]=install.sh [crossex]=install.sh [greeks]=install.sh [hub]=install.sh
)
declare -A STACK_NAMES=(
  [aster]='ASTER 5X' [monitor]='Market Monitor' [asset]='Asset Ledger'
  [variational]='Variational Grid' [crossex]='Gate CrossEx' [greeks]='Greeks · BTC 期权' [hub]='Project Aggregation'
)
declare -A stack_status=() stack_seconds=()
stack_selected=()
stack_workers=()
stack_refresh=0 stack_run='' stack_active='' stack_child='' stack_viewer=''
stack_with_tests=0 stack_mode=ci
  stack_started=$SECONDS

# BEGIN CI RELEASE HELPERS -- keep embedded copies identical to deploy/release-common.sh
# Only discovery uses latest; the archive is always fetched from its immutable commit tag.
ci_release_resolve() {
  local repository=$1 workspace=$2 manifest values
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  CI_RELEASE_REPOSITORY=$repository
  # shellcheck disable=SC2034 # Part of the shared installer interface.
  CI_RELEASE_WORK=$workspace
  mkdir -p -- "$workspace" || return 1
  manifest="$workspace/release-manifest.json"
  if [[ -n ${PROJECT_DEPLOY_MANIFEST_FILE:-} ]]; then
    [[ -f "$PROJECT_DEPLOY_MANIFEST_FILE" && ! -L "$PROJECT_DEPLOY_MANIFEST_FILE" &&
       $(stat -c %u "$PROJECT_DEPLOY_MANIFEST_FILE") == "$EUID" ]] || {
      printf '[CI] 预检清单不存在或不属于当前安装用户。\n' >&2; return 1;
    }
    if [[ "$PROJECT_DEPLOY_MANIFEST_FILE" != "$manifest" ]]; then
      cp -- "$PROJECT_DEPLOY_MANIFEST_FILE" "$manifest" || return 1
    fi
  elif ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --retry 3 --connect-timeout 15 --max-time 90 --max-filesize 1048576 \
    "https://github.com/$repository/releases/latest/download/release-manifest.json" -o "$manifest"; then
    printf '[CI] %s 暂无可用部署清单或下载失败；现有服务保持原样。\n' "$repository" >&2
    return 1
  fi
  values=$(python3 - "$manifest" "$repository" "$(uname -m)" <<'CI_MANIFEST_PY'
import json, re, sys
from pathlib import Path
def require(condition, message):
    if not condition:
        raise ValueError(message)
try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    architecture = {'x86_64': 'linux-x64', 'aarch64': 'linux-arm64', 'arm64': 'linux-arm64'}[sys.argv[3]]
    require(type(data['schema']) is int and data['schema'] == 1 and data['repository'] == sys.argv[2], 'repository/schema mismatch')
    commit = data['commit']
    require(re.fullmatch(r'[a-f0-9]{40}', commit), 'invalid commit')
    require(data['tag'] == 'deploy-' + commit, 'tag/commit mismatch')
    item = data['artifacts'][architecture]
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz', item['file']), 'invalid archive name')
    for key in ('sha256', 'application_key'):
        require(re.fullmatch(r'[a-f0-9]{64}', item[key]), 'invalid ' + key)
    node = data.get('node_version', '')
    require(not node or re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', node), 'invalid Node version')
    print('\n'.join([commit, data['tag'], item['file'], item['sha256'], item['application_key'], node]))
except (OSError, ValueError, KeyError, TypeError, AssertionError) as error:
    print('[CI] Invalid deployment manifest: ' + str(error), file=sys.stderr)
    sys.exit(1)
CI_MANIFEST_PY
  ) || return 1
  local -a fields
  mapfile -t fields <<< "$values"
  CI_RELEASE_COMMIT=${fields[0]}
  CI_RELEASE_TAG=${fields[1]}
  CI_RELEASE_FILE=${fields[2]}
  CI_RELEASE_SHA256=${fields[3]}
  CI_RELEASE_APPLICATION_KEY=${fields[4]}
  # shellcheck disable=SC2034 # Python applications do not consume the Node version.
  CI_RELEASE_NODE_VERSION=${fields[5]:-}
  printf '[CI] %s 最新可用部署包：%s。\n' "$repository" "${CI_RELEASE_COMMIT:0:12}"
}

ci_release_extract() {
  local cache=$1 destination=$2 archive temporary actual
  [[ ! -L "$cache" && ( ! -e "$cache" || -d "$cache" ) ]] || { printf '[CI] Invalid archive cache.\n' >&2; return 1; }
  mkdir -p -- "$cache" || return 1
  [[ $(stat -c %u "$cache") == "$EUID" ]] || { printf '[CI] Archive cache has an unexpected owner.\n' >&2; return 1; }
  archive="$cache/$CI_RELEASE_SHA256.tar.gz"
  [[ ! -L "$archive" && ( ! -e "$archive" || -f "$archive" ) ]] || return 1
  actual=''
  if [[ -f "$archive" ]]; then actual=$(sha256sum "$archive" | cut -d ' ' -f1) || return 1; fi
  if [[ "$actual" != "$CI_RELEASE_SHA256" ]]; then
    temporary=$(mktemp "$cache/.download.XXXXXXXX") || return 1
    if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --retry 3 --connect-timeout 15 --max-time 600 --max-filesize 2147483648 \
      "https://github.com/$CI_RELEASE_REPOSITORY/releases/download/$CI_RELEASE_TAG/$CI_RELEASE_FILE" -o "$temporary"; then
      rm -f -- "$temporary"
      return 1
    fi
    actual=$(sha256sum "$temporary" | cut -d ' ' -f1) || { rm -f -- "$temporary"; return 1; }
    if [[ "$actual" != "$CI_RELEASE_SHA256" ]]; then
      printf '[CI] 部署包校验失败；现有服务保持原样。\n' >&2
      rm -f -- "$temporary"
      return 1
    fi
    chmod 0644 "$temporary" || { rm -f -- "$temporary"; return 1; }
    mv -f -- "$temporary" "$archive" || return 1
  else
    printf '[CI] 部署包已缓存且校验通过，跳过下载。\n'
  fi
  python3 - "$archive" "$destination" "$CI_RELEASE_COMMIT" "$CI_RELEASE_APPLICATION_KEY" <<'CI_EXTRACT_PY'
import os, shutil, sys, tarfile
from pathlib import Path, PurePosixPath
def require(condition, message):
    if not condition:
        raise ValueError(message)
try:
    destination = Path(sys.argv[2])
    require(not destination.is_symlink(), 'destination cannot be a symlink')
    destination.mkdir(parents=True, exist_ok=True)
    require(not any(destination.iterdir()), 'destination must be empty')
    with tarfile.open(sys.argv[1], 'r:gz') as archive:
        members = []
        names, total = set(), 0
        for member in archive:
            require(len(members) < 200000, 'too many archive entries')
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and '\\' not in member.name and ':' not in member.name, 'unsafe archive path')
            require(member.isdir() or member.isfile(), 'archive links and special files are forbidden')
            name = str(path)
            require(name not in names, 'duplicate archive entry')
            names.add(name)
            total += member.size
            require(0 <= member.size and total <= 2147483648, 'archive too large')
            members.append(member)
        for member in members:
            path = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(0o755)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
    destination.chmod(0o755)
    for directory in destination.rglob('*'):
        if directory.is_dir():
            directory.chmod(0o755)
    require((destination / '.release-commit').read_text().strip() == sys.argv[3], 'archive commit mismatch')
    require((destination / '.release-application-key').read_text().strip() == sys.argv[4], 'archive application key mismatch')
except (OSError, ValueError, EOFError, tarfile.TarError, AssertionError) as error:
    print('[CI] Invalid deployment archive: ' + str(error), file=sys.stderr)
    sys.exit(1)
CI_EXTRACT_PY
}
# END CI RELEASE HELPERS

stack_log() { printf '[总部署] %s\n' "$*"; }
stack_fail() { stack_log "错误：$*" >&2; return 1; }
stack_usage() {
  cat <<'HELP'
用法：sudo bash install-all.sh [--only aster,monitor,asset,crossex,variational,greeks,hub] [--refresh] [--with-tests]
默认安装或升级六个模块及平台；已有配置、密码和数据由各自安装器保留。
默认下载 GitHub CI 已验证的部署包；服务器只检查配置和健康，不运行前端构建或完整测试。
支持 Ubuntu 22.04/24.04、Debian 12/13，x64/arm64，需 systemd。
  Variational 需要 Python 3.11+；Ubuntu 22.04 默认 Python 不满足要求。
  Variational 不要求部署时输入 vr-token；缺失或失效不阻止安装。
  默认 QQQ 模式可在页面“更新 Var token”，认证恢复前暂停相关模拟活动。
  Greeks 支持 Ubuntu 24.04、Debian 12/13，默认模拟；面板密码保存在 /etc/greeks/greeks.env。
  --only     只检查和部署指定项目，始终按上述顺序执行，平台最后部署。
  --refresh  重新下载安装器；不强制重装应用依赖、构建或重启。
  --with-tests  仅显式 PROJECT_DEPLOY_MODE=source 时开启工作台/CrossEx 部署测试；CI 模式忽略。
  --help     查看说明，无需 root。
失败后修复原因并重复原命令；已完成项目仍会检查配置和服务健康。
HELP
}

stack_parse() {
  local only='' item
  local -A requested=()
  stack_with_tests=${PROJECT_DEPLOY_TESTS-0}
  stack_mode=${PROJECT_DEPLOY_MODE-ci}
  case "$stack_mode" in ci|source) ;; *) stack_fail 'PROJECT_DEPLOY_MODE 必须是 ci 或 source。'; return 1 ;; esac
  while (($#)); do
    case "$1" in
      --only)
        (($# >= 2)) && [[ -n "$2" && -z "$only" ]] || { stack_fail '--only 需要一个非空列表，且只能指定一次。'; return 1; }
        only=$2; shift 2 ;;
      --refresh) stack_refresh=1; shift ;;
      --with-tests) stack_with_tests=1; shift ;;
      *) stack_fail "未知参数：$1；使用 --help 查看说明。"; return 1 ;;
    esac
  done
  case "$stack_with_tests" in
    0|1) ;;
    *) stack_fail 'PROJECT_DEPLOY_TESTS 必须是 0 或 1。'; return 1 ;;
  esac
  if [[ -z "$only" ]]; then stack_selected=("${STACK_ORDER[@]}"); return; fi
  [[ "$only" != ,* && "$only" != *, && "$only" != *,,* ]] || { stack_fail '项目列表不能含空项。'; return 1; }
  local -a items
  IFS=, read -r -a items <<< "$only"
  for item in "${items[@]}"; do
    # Validate before using a user-supplied associative array subscript.
    case "$item" in aster|monitor|asset|crossex|variational|greeks|hub) requested[$item]=1 ;;
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
  if [[ " ${stack_selected[*]} " == *' greeks '* ]]; then stack_greeks_preflight "$ID:$VERSION_ID"; fi
  command -v apt-get >/dev/null && command -v dpkg-query >/dev/null && command -v flock >/dev/null || {
    stack_fail '需要 apt-get、dpkg-query 和 util-linux 的 flock。'; return 1;
  }
}

stack_variational_python_ready() { /usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; }
stack_variational_preflight() {
  if [[ $1 == ubuntu:22.04 || -x /usr/bin/python3 ]]; then
    stack_variational_python_ready || { stack_fail 'Variational Grid 需要 /usr/bin/python3 3.11+；请使用 Debian 12/13 或 Ubuntu 24.04，或用 --only aster,monitor,asset,crossex,hub 跳过此模块。'; return 1; }
  fi
}

stack_greeks_preflight() {
  [[ $1 != ubuntu:22.04 ]] || { stack_fail 'Greeks 需要 Python 3.11+，支持 Debian 12/13 或 Ubuntu 24.04；Ubuntu 22.04 请用 --only 选择其他模块。'; return 1; }
}

stack_ensure_tools() {
  local item package
  local -a packages=(ca-certificates curl) missing=()
  local -A wanted=([ca-certificates]=1 [curl]=1)
  for item in "${stack_selected[@]}"; do
    case "$item" in
      aster) packages+=(python3 python3-venv tar xz-utils util-linux passwd) ;;
      variational) packages+=(python3 git util-linux passwd) ;;
      greeks) packages+=(python3 python3-venv git tar util-linux passwd) ;;
      monitor) packages+=(python3 xz-utils util-linux passwd iproute2) ;;
      asset|crossex|hub) packages+=(git xz-utils tar util-linux passwd) ;;
    esac
  done
  if [[ "$stack_mode" == ci ]]; then packages+=(python3 tar); fi
  for package in "${packages[@]}"; do
    [[ "$stack_mode" != ci || "$package" != git ]] || continue
    wanted[$package]=1
  done
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
  local revision=main url
  local -a conditional=()
  if [[ "$stack_mode" == ci ]]; then
    ci_release_resolve "hxx344/${STACK_REPOS[$item]}" "$stack_run/$item.release" || return 1
    revision=$CI_RELEASE_COMMIT
    curl --fail --silent --show-error --head --location --proto '=https' --tlsv1.2 \
      --retry 2 --connect-timeout 15 --max-time 90 \
      "https://github.com/$CI_RELEASE_REPOSITORY/releases/download/$CI_RELEASE_TAG/$CI_RELEASE_FILE" >/dev/null || {
        stack_fail "${STACK_NAMES[$item]} 对应架构的正式部署包不可下载，尚未开始部署。"; return 1;
      }
  fi
  url="https://raw.githubusercontent.com/hxx344/${STACK_REPOS[$1]}/$revision/${STACK_PATHS[$1]}"
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
  if [[ "$stack_mode" == ci ]]; then
    stack_log "${STACK_NAMES[$item]}：正式部署包及同提交安装器已就绪。"
  fi
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
    (( result == 0 )) || { stack_fail '安装器或 CI 部署包准备失败，尚未运行任何项目安装器；等待 CI 发布成功或修复下载问题后重试。'; return 1; }
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
  if [[ " ${stack_selected[*]} " == *' greeks '* && ${stack_status[greeks]:-} == '完成检查/部署' ]]; then
    stack_log "Greeks 登录用户名和密码查看命令：sudo grep '^DASHBOARD_' /etc/greeks/greeks.env"
    stack_log '在工作台“项目管理 → Greeks · BTC 期权”中填写该命令显示的 DASHBOARD_USERNAME 和 DASHBOARD_PASSWORD。'
  fi
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
  local -a installer_env
  for item in "${stack_selected[@]}"; do
    stack_active=$item
    stack_status[$item]='运行中'
    started=$SECONDS
    stack_log "开始 ${STACK_NAMES[$item]}；详细进度：$stack_run/$item.log"
    # Do not use 'if bash ...' or source the installer: preserve its own errexit and traps.
    # Log directly to disk; a broken console/tee must not abort a service activation.
    : > "$stack_run/$item.log"
    # Only these installers consume the test switch. Do not change unrelated
    # modules' build-environment fingerprints by forwarding it to every child.
    installer_env=(-u PROJECT_DEPLOY_MANIFEST_FILE)
    case "$item" in
      hub|crossex) installer_env+=("PROJECT_DEPLOY_TESTS=$stack_with_tests") ;;
      *) installer_env+=(-u PROJECT_DEPLOY_TESTS) ;;
    esac
    installer_env+=("PROJECT_DEPLOY_MODE=$stack_mode")
    if [[ "$stack_mode" == ci ]]; then installer_env+=("PROJECT_DEPLOY_MANIFEST_FILE=$stack_run/$item.release/release-manifest.json"); fi
    setsid env "${installer_env[@]}" bash "$stack_run/$item.sh" </dev/null > "$stack_run/$item.log" 2>&1 &
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
  if [[ "$stack_mode" == ci && "$stack_with_tests" == 1 ]]; then
    stack_log 'CI 模式已在 GitHub 完成必要检查，--with-tests 不会在服务器重复测试。'
  fi
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
