#!/usr/bin/env bash
# Idempotent Debian/Ubuntu installation. Existing data and configuration are preserved.
set -Eeuo pipefail

APP_DIR=/opt/project-aggregation
DATA_DIR_DEFAULT=/var/lib/project-aggregation
ENV_FILE=/etc/project-aggregation.env
SERVICE=project-aggregation
SERVICE_USER=project-aggregation
UNIT_FILE=/etc/systemd/system/project-aggregation.service
REPOSITORY=https://github.com/hxx344/project-aggregation.git
BRANCH=main
NODE_VERSION=24.15.0
INSTALL_REVISION=1
activation_started=0
old_release=
old_unit_backup=
old_environment=
old_health_url=
work_dir=

log() { printf '[project-aggregation] %s\n' "$*"; }
fail() { log "错误：$*" >&2; return 1; }
hash() { sha256sum | cut -d ' ' -f 1; }
node_supported() {
  "$1" -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a === 24 && b >= 15 ? 0 : 1)' >/dev/null 2>&1
}
read_setting() {
  local key=$1 fallback=$2 file=${3:-$ENV_FILE} value
  value=$(sed -n "s/^${key}=//p" "$file" | tail -n 1)
  printf '%s' "${value:-$fallback}"
}
health_url() {
  local host=$1 port=$2
  case "$host" in 0.0.0.0) host=127.0.0.1 ;; ::) host='[::1]' ;; *:*) host="[$host]" ;; esac
  printf 'http://%s:%s/api/health' "$host" "$port"
}
remember_environment() {
  # main runs as root; a root-only snapshot may include INITIAL_PASSWORD.
  local temporary="$APP_DIR/.last-successful.env.new.$$"
  install -m 0600 "$ENV_FILE" "$temporary"
  mv -f -- "$temporary" "$APP_DIR/.last-successful.env"
}
prepare_environment_rollback() {
  old_environment=
  old_health_url=
  [[ -n "$old_release" ]] || return 0
  if [[ ! -f "$APP_DIR/.last-successful.env" ]]; then
    fail '缺少上次成功的环境配置快照，已在切换版本前停止；现有服务保持运行。'
    return 1
  fi
  old_environment="$work_dir/previous.env"
  install -m 0600 "$APP_DIR/.last-successful.env" "$old_environment"
  old_health_url=$(health_url "$(read_setting HOST 127.0.0.1 "$old_environment")" "$(read_setting PORT 3100 "$old_environment")")
}
restore_environment() {
  [[ -n "$old_environment" && -f "$old_environment" ]] || return 1
  if ! cmp -s "$ENV_FILE" "$old_environment"; then
    local failed_environment="${ENV_FILE}.failed-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    local temporary="${ENV_FILE}.restore.$$"
    # Preserve the candidate before replacing it; neither copy is world-readable.
    install -m 0600 "$ENV_FILE" "$failed_environment" || return 1
    install -m 0600 "$old_environment" "$temporary" || return 1
    mv -f -- "$temporary" "$ENV_FILE" || return 1
    log "未生效的新配置已保存：$failed_environment"
  fi
  HEALTH_URL=$old_health_url
}
healthy() {
  systemctl is-active --quiet "$SERVICE" && curl --fail --silent --max-time 3 "$HEALTH_URL" >/dev/null
}
wait_healthy() {
  local attempt
  for attempt in {1..30}; do
    if healthy; then return 0; fi
    sleep 1
  done
  return 1
}
atomic_link() {
  local target=$1 link=$2
  ln -s "$target" "${link}.new.$$"
  mv -Tf "${link}.new.$$" "$link"
}
safe_remove_release() {
  local target=$1 resolved
  [[ -d "$target" && ! -L "$target" && -f "$target/.managed-release" ]] || return 0
  resolved=$(realpath -e "$target")
  [[ "$resolved" == "$APP_DIR/releases/"* && "$resolved" != "$APP_DIR/releases" ]] || return 1
  [[ "${resolved##*/}" =~ ^[a-f0-9]{12}-[a-f0-9]{16}$ ]] || return 1
  rm -rf -- "$resolved"
}
rollback() {
  local exit_code=${1:-$?}
  trap - ERR INT TERM
  set +e
  if [[ "$activation_started" == 1 ]]; then
    log '新版本启动失败，正在恢复之前的程序和服务配置。'
    if [[ -n "$old_unit_backup" && -f "$old_unit_backup" ]]; then
      cp -- "$old_unit_backup" "$UNIT_FILE"
    else
      systemctl stop "$SERVICE" >/dev/null 2>&1 || true
      systemctl disable "$SERVICE" >/dev/null 2>&1 || true
      if [[ -f "$UNIT_FILE" ]] && grep -q '^# Managed by project-aggregation installer$' "$UNIT_FILE"; then rm -f -- "$UNIT_FILE"; fi
    fi
    if [[ -n "$old_release" && -d "$old_release" ]]; then
      if ! restore_environment; then
        log '无法保留候选配置或恢复上次成功配置；未再次重启服务，请检查配置文件和磁盘空间。'
        exit "$exit_code"
      fi
      atomic_link "$old_release" "$APP_DIR/current"
      systemctl daemon-reload
      systemctl restart "$SERVICE" || true
      if wait_healthy; then log '已恢复上次成功的程序和配置；持久数据保持原样。'; else log '旧版本尚未恢复健康，请查看服务日志。'; fi
    else
      if [[ -L "$APP_DIR/current" && "$(readlink "$APP_DIR/current")" == "${release:-}" ]]; then rm -f -- "$APP_DIR/current"; fi
      systemctl daemon-reload || true
      log '首次安装未成功；保留配置和数据以便重试。'
    fi
  fi
  [[ -z "$work_dir" ]] || log "本次工作目录保留用于排查：$work_dir"
  exit "$exit_code"
}
ensure_tools() {
  local missing=() tool
  for tool in curl git xz; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      case "$tool" in xz) missing+=(xz-utils) ;; *) missing+=("$tool") ;; esac
    fi
  done
  [[ -s /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
  if ! command -v flock >/dev/null 2>&1 || ! command -v runuser >/dev/null 2>&1; then missing+=(util-linux); fi
  if ((${#missing[@]})); then
    command -v apt-get >/dev/null 2>&1 || fail '缺少依赖且没有 apt-get；请安装 curl git xz-utils ca-certificates util-linux 后重试。'
    log "安装缺少的系统依赖：${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  else
    log '系统依赖已齐全，跳过安装。'
  fi
}
ensure_node() {
  local candidate machine archive runtime_dir checksum
  if [[ -f "$APP_DIR/.node-path" ]]; then
    candidate=$(cat "$APP_DIR/.node-path")
    if [[ -x "$candidate" ]] && node_supported "$candidate"; then NODE_BIN=$candidate; return; fi
  fi
  candidate=$(command -v node || true)
  [[ -z "$candidate" ]] || candidate=$(realpath "$candidate")
  if [[ -n "$candidate" && "$candidate" != /root/* && "$candidate" != /home/* ]] && node_supported "$candidate"; then
    NODE_BIN=$(realpath "$candidate")
    return
  fi
  case "$(uname -m)" in x86_64) machine=x64 ;; aarch64|arm64) machine=arm64 ;; *) fail '自动安装 Node.js 仅支持 Linux x64 和 arm64。' ;; esac
  archive="node-v${NODE_VERSION}-linux-${machine}.tar.xz"
  runtime_dir="$APP_DIR/runtime/node-v${NODE_VERSION}-linux-${machine}"
  if [[ ! -x "$runtime_dir/bin/node" ]] || ! node_supported "$runtime_dir/bin/node"; then
    log "下载 Node.js $NODE_VERSION 并核验官方 SHA-256。"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$work_dir/SHASUMS256.txt"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "$work_dir/$archive"
    checksum=$(awk -v name="$archive" '$2 == name { print $1 }' "$work_dir/SHASUMS256.txt")
    [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || fail '官方校验文件中找不到当前安装包。'
    (cd "$work_dir" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status)
    mkdir -p "$APP_DIR/runtime"
    [[ ! -e "$runtime_dir" ]] || fail "运行时目录不完整，请检查：$runtime_dir"
    tar -xJf "$work_dir/$archive" -C "$APP_DIR/runtime" --no-same-owner
  fi
  NODE_BIN="$runtime_dir/bin/node"
  node_supported "$NODE_BIN" || fail 'Node.js 版本不满足 24.15.0 或更高的 24.x 版本要求。'
}
run_as_service() {
  runuser -u "$SERVICE_USER" -- env "HOME=$APP_DIR/build-home" "PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin" "$@"
}
tree_hash() { git --git-dir="$APP_DIR/repository.git" ls-tree -r "$commit" -- "$@" | hash; }
write_unit() {
  cat > "$work_dir/service" <<EOF
# Managed by project-aggregation installer
[Unit]
Description=Project Aggregation workspace
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR/current
ExecStart=$NODE_BIN $APP_DIR/current/server/index.mjs
EnvironmentFile=$ENV_FILE
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_PATH

[Install]
WantedBy=multi-user.target
EOF
}
prune_releases() {
  local directory
  while IFS= read -r directory; do
    if [[ "$directory" == "$release" || "$directory" == "$previous_release" ]]; then continue; fi
    [[ -f "$directory/.managed-release" ]] || continue
    [[ "${directory##*/}" =~ ^[a-f0-9]{12}-[a-f0-9]{16}$ ]] || continue
    safe_remove_release "$directory"
  done < <(find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d ' ' -f 2-)
}
main() {
  [[ "$(uname -s)" == Linux ]] || fail '安装脚本仅用于 Linux；开发环境请使用 npm 命令。'
  [[ "$EUID" == 0 ]] || fail '请使用 sudo bash install.sh。'
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] || fail '需要正在运行 systemd 的 Linux 主机。'
  umask 022
  ensure_tools
  mkdir -p /run/lock
  exec 9>/run/lock/project-aggregation-install.lock
  flock -n 9 || fail '另一个安装进程正在运行，请稍后重试。'
  if [[ -e "$APP_DIR" && ! -f "$APP_DIR/.managed-install" ]]; then
    [[ -d "$APP_DIR" && ! -L "$APP_DIR" && -z "$(ls -A "$APP_DIR")" ]] || fail "$APP_DIR 已存在且不属于本安装脚本；为保护已有文件已停止。"
  fi
  [[ ! -L "$APP_DIR" ]] || fail '安装根目录不能是符号链接。'
  mkdir -p "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/cache"
  touch "$APP_DIR/.managed-install"
  work_dir=$(mktemp -d "$APP_DIR/.install.XXXXXXXX")
  trap rollback ERR
  trap 'rollback 130' INT
  trap 'rollback 143' TERM
  if [[ -L "$APP_DIR/current" ]]; then
    old_release=$(realpath -e "$APP_DIR/current")
    [[ "$old_release" == "$APP_DIR/releases/"* && -f "$old_release/.managed-release" ]] || fail 'current 指向未知目录，停止更新。'
  elif [[ -e "$APP_DIR/current" ]]; then
    fail 'current 已存在且不是本安装脚本管理的符号链接。'
  fi
  if [[ -f "$UNIT_FILE" ]]; then
    grep -q '^# Managed by project-aggregation installer$' "$UNIT_FILE" || fail '同名 systemd 服务已存在且不属于本安装脚本。'
    old_unit_backup="$work_dir/previous.service"
    cp -- "$UNIT_FILE" "$old_unit_backup"
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DATA_DIR_DEFAULT" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    install -m 0640 -o root -g "$SERVICE_USER" /dev/null "$ENV_FILE"
    printf 'HOST=127.0.0.1\nPORT=3100\nDATA_DIR=%s\nNODE_ENV=production\n' "$DATA_DIR_DEFAULT" > "$ENV_FILE"
  fi
  HOST_VALUE=$(read_setting HOST 127.0.0.1)
  PORT_VALUE=$(read_setting PORT 3100)
  DATA_PATH=$(read_setting DATA_DIR "$DATA_DIR_DEFAULT")
  [[ "$HOST_VALUE" =~ ^[A-Za-z0-9.:_-]+$ ]] || fail 'HOST 格式不正确，请使用无引号的主机名或 IP。'
  [[ "$PORT_VALUE" =~ ^[0-9]{1,5}$ ]] && ((10#$PORT_VALUE > 0 && 10#$PORT_VALUE < 65536)) || fail 'PORT 必须在 1 到 65535 之间。'
  [[ "$DATA_PATH" =~ ^/[A-Za-z0-9_./-]+$ && "$DATA_PATH" != / && "$DATA_PATH" != *'/../'* && "$DATA_PATH" != */.. ]] || fail 'DATA_DIR 必须是无空格的专用绝对目录。'
  DATA_PATH=$(realpath -m "$DATA_PATH")
  case "$DATA_PATH" in /var/lib/project-aggregation|/var/lib/project-aggregation/*|/srv/project-aggregation/*|/opt/project-aggregation-data|/opt/project-aggregation-data/*) ;; *) fail 'DATA_DIR 请使用 /var/lib/project-aggregation、/srv/project-aggregation/ 子目录或 /opt/project-aggregation-data，避免修改系统目录权限。' ;; esac
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_PATH"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR/build-home"
  HEALTH_URL=$(health_url "$HOST_VALUE" "$PORT_VALUE")
  ensure_node
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
  [[ -x "$NPM_BIN" ]] || fail '当前 Node.js 没有对应 npm，请安装完整 Node.js 24 运行时。'
  runtime_key=$(printf '%s\n%s\n%s\n' "$("$NODE_BIN" --version)" "$("$NODE_BIN" "$NPM_BIN" --version)" "$(uname -m)" | hash)
  write_unit
  deployment_key=$({ cat "$ENV_FILE" "$work_dir/service"; printf '%s\n%s' "$runtime_key" "$INSTALL_REVISION"; } | hash)
  log '检查远端版本。'
  commit=$(git ls-remote --exit-code "$REPOSITORY" "refs/heads/$BRANCH" | cut -f 1)
  [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || fail '无法确定远端 main 的提交。'
  deployed_state=
  [[ ! -f "$APP_DIR/.deployed-state" ]] || deployed_state=$(cat "$APP_DIR/.deployed-state")
  if [[ -n "$old_release" && "$deployed_state" == "$commit $deployment_key" ]] && healthy; then
    remember_environment
    log "版本 ${commit:0:12}、运行环境和配置未变化，服务健康；跳过下载、依赖、验证、构建和重启。"
    rm -rf -- "$work_dir"
    trap - ERR INT TERM
    return
  fi
  if [[ ! -d "$APP_DIR/repository.git" ]]; then git init --bare -q "$APP_DIR/repository.git"; fi
  if ! git --git-dir="$APP_DIR/repository.git" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git --git-dir="$APP_DIR/repository.git" fetch --quiet --depth=1 "$REPOSITORY" "$commit"
  else
    log '源码已缓存，跳过下载。'
  fi
  dependency_key=$(printf '%s\n%s' "$(tree_hash package.json package-lock.json)" "$runtime_key" | hash)
  validation_key=$(printf '%s\n%s' "$(tree_hash src public server tests package.json package-lock.json tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html)" "$runtime_key" | hash)
  build_key=$(printf '%s\n%s' "$(tree_hash src public package.json package-lock.json tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html)" "$runtime_key" | hash)
  if [[ -n "$old_release" && -f "$old_release/.validation-key" && "${deployed_state#* }" == "$deployment_key" && "$(cat "$old_release/.validation-key")" == "$validation_key" ]] && healthy; then
    printf '%s %s\n' "$commit" "$deployment_key" > "$APP_DIR/.deployed-state"
    remember_environment
    log '只有文档或部署以外的文件变化，应用内容未变化；跳过依赖、验证、构建和重启。'
    rm -rf -- "$work_dir"
    trap - ERR INT TERM
    return
  fi
  release="$APP_DIR/releases/${commit:0:12}-${validation_key:0:16}"
  dependencies="$APP_DIR/cache/dependencies-$dependency_key"
  built="$APP_DIR/cache/build-$build_key"
  validation_stamp="$APP_DIR/cache/validated-$validation_key"
  if [[ ! -d "$release" ]]; then
    mkdir "$work_dir/source"
    git --git-dir="$APP_DIR/repository.git" archive "$commit" | tar -x -C "$work_dir/source"
    printf '%s\n' "$commit" > "$work_dir/source/.managed-release"
    printf '%s\n' "$commit" > "$work_dir/source/.source-sha"
    printf '%s\n' "$validation_key" > "$work_dir/source/.validation-key"
    mv -- "$work_dir/source" "$release"
  else
    [[ ! -L "$release" && -f "$release/.managed-release" && "$(cat "$release/.managed-release")" == "$commit" ]] || fail '版本目录已有未知内容，停止更新。'
  fi
  if [[ ! -f "$dependencies/.complete" ]]; then
    log '依赖内容或运行环境变化，安装依赖。'
    dependency_work="$work_dir/dependencies"
    mkdir "$dependency_work"
    cp "$release/package.json" "$release/package-lock.json" "$dependency_work/"
    chmod 0755 "$work_dir"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$dependency_work"
    (cd "$dependency_work" && run_as_service "$NODE_BIN" "$NPM_BIN" ci --no-audit --no-fund)
    touch "$dependency_work/.complete"
    [[ ! -e "$dependencies" ]] || fail '依赖缓存目录不完整，请检查后重试。'
    chown -R root:root "$dependency_work"
    mv -- "$dependency_work" "$dependencies"
  else
    log '依赖与运行环境未变化，复用已安装依赖。'
  fi
  if [[ ! -d "$release/node_modules" ]]; then cp -a "$dependencies/node_modules" "$release/node_modules"; fi
  if [[ ! -f "$validation_stamp" || ! -f "$built/.complete" ]]; then chown -R "$SERVICE_USER:$SERVICE_USER" "$release"; fi
  if [[ ! -f "$validation_stamp" ]]; then
    log '内容或运行环境变化，执行类型检查和行为测试。'
    (cd "$release" && run_as_service "$NODE_BIN" "$NPM_BIN" run check && run_as_service "$NODE_BIN" "$NPM_BIN" test)
    touch "$validation_stamp"
  else
    log '复用相同内容与运行环境的验证结果。'
  fi
  if [[ ! -f "$built/.complete" ]]; then
    log '前端内容或运行环境变化，构建页面。'
    (cd "$release" && run_as_service "$NODE_BIN" "$NPM_BIN" run build)
    [[ ! -e "$built" ]] || fail '构建缓存目录不完整，请检查后重试。'
    mkdir "$work_dir/build"
    cp -a "$release/dist" "$work_dir/build/dist"
    touch "$work_dir/build/.complete"
    mv -- "$work_dir/build" "$built"
  elif [[ ! -f "$release/dist/index.html" ]]; then
    log '前端内容未变化，复用构建结果。'
    cp -a "$built/dist" "$release/dist"
  else
    log '前端构建已存在，跳过重复构建。'
  fi
  [[ -f "$release/dist/index.html" ]] || fail '构建缺少 dist/index.html。'
  chown -R root:root "$release"
  previous_release=$old_release
  if [[ "$old_release" == "$release" && -L "$APP_DIR/previous" ]]; then previous_release=$(realpath -e "$APP_DIR/previous"); fi
  prepare_environment_rollback
  activation_started=1
  atomic_link "$release" "$APP_DIR/current"
  if [[ ! -f "$UNIT_FILE" ]] || ! cmp -s "$work_dir/service" "$UNIT_FILE"; then
    install -m 0644 "$work_dir/service" "$UNIT_FILE"
    systemctl daemon-reload
  fi
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
  wait_healthy || fail '服务未在 30 次健康检查内就绪。'
  remember_environment
  activation_started=0
  printf '%s %s\n' "$commit" "$deployment_key" > "$APP_DIR/.deployed-state"
  printf '%s\n' "$NODE_BIN" > "$APP_DIR/.node-path"
  if [[ -n "$previous_release" && "$previous_release" != "$release" ]]; then atomic_link "$previous_release" "$APP_DIR/previous"; fi
  prune_releases
  rm -rf -- "$work_dir"
  trap - ERR INT TERM
  log "安装完成：提交 ${commit:0:12}，监听 $HOST_VALUE:$PORT_VALUE；配置与数据已保留。"
  log "首次登录密码请在服务器运行：sudo journalctl -u $SERVICE --no-pager -n 30"
}

# CI may source pure helpers without changing its host.
if [[ "${AGG_INSTALL_SOURCE_ONLY:-0}" != 1 ]]; then main "$@"; fi
