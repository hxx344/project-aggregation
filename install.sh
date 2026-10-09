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
INSTALL_REVISION=2
PROJECT_DEPLOY_TESTS=${PROJECT_DEPLOY_TESTS-0}
PROJECT_DEPLOY_MODE=${PROJECT_DEPLOY_MODE-source}
# The hub backend uses only Node built-ins. CrossEx also keeps runtime packages.
RUNTIME_DEPENDENCIES=0
activation_started=0
old_release=
old_unit_backup=
old_environment=
old_health_url=
work_dir=

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
  local tools=(curl xz)
  if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then tools+=(python3); else tools+=(git); fi
  for tool in "${tools[@]}"; do
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
atomic_record() {
  local destination=$1 value=$2 temporary="${1}.new.$$"
  printf '%s\n' "$value" > "$temporary"
  mv -f -- "$temporary" "$destination"
}
input_keys() {
  # Read git trees separately so a failed read cannot be masked by printf/hash.
  local dependency_tree typecheck_tree test_tree build_tree runtime_tree
  dependency_tree=$(tree_hash package.json package-lock.json .npmrc) || return
  typecheck_tree=$(tree_hash src tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts) || return
  test_tree=$(tree_hash src public server tests tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html) || return
  build_tree=$(tree_hash src public tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html .env .env.local .env.production .env.production.local) || return
  runtime_tree=$(tree_hash server package.json) || return
  # Recipes describe preparation semantics, independently of installer comments/docs.
  dependency_key=$(printf 'dependencies-v2\n%s\n%s' "$dependency_tree" "$runtime_key" | hash)
  typecheck_key=$(printf 'typecheck-v2\n%s\n%s' "$typecheck_tree" "$dependency_key" | hash)
  test_key=$(printf 'tests-v2\n%s\n%s' "$test_tree" "$dependency_key" | hash)
  # Vite may inline build-time environment; keep those inputs out of runtime config.
  build_key=$(printf 'build-v2\n%s\n%s\n%s' "$build_tree" "$dependency_key" "$build_environment" | hash)
  application_key=$(printf 'application-v2\n%s\n%s\n%s' "$runtime_tree" "$build_key" "$RUNTIME_DEPENDENCIES" | hash)
  dependencies="$APP_DIR/cache/dependencies-$dependency_key"
  built="$APP_DIR/cache/build-$build_key"
  typecheck_stamp="$APP_DIR/cache/typechecked-$typecheck_key"
  test_stamp="$APP_DIR/cache/tested-$test_key"
}
application_ready() {
  [[ -n "$old_release" && -f "$old_release/.install-ready" && -f "$old_release/.application-key" &&
     "$(cat "$old_release/.application-key")" == "$application_key" && -s "$old_release/dist/index.html" ]] || return 1
  if (( RUNTIME_DEPENDENCIES )); then
    [[ -f "$dependencies/.complete" && -d "$dependencies/node_modules" &&
       -L "$old_release/node_modules" && "$(readlink "$old_release/node_modules")" == "$dependencies/node_modules" ]] || return 1
  fi
}
prepare_source() {
  [[ ! -d "$work_dir/source" ]] || return 0
  mkdir "$work_dir/source"
  git --git-dir="$APP_DIR/repository.git" archive "$commit" | tar -x -C "$work_dir/source"
  chmod 0755 "$work_dir"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$work_dir/source"
}
prepare_dependencies() {
  if [[ -f "$dependencies/.complete" && -d "$dependencies/node_modules" ]]; then
    log '依赖与运行环境未变化，复用 root 只读依赖缓存。'
    return
  fi
  [[ ! -e "$dependencies" ]] || fail '依赖缓存目录不完整，请检查后重试。'
  log '依赖内容或运行环境变化，安装依赖。'
  local staging="$work_dir/dependencies"
  mkdir "$staging"
  local name
  for name in package.json package-lock.json .npmrc; do
    git --git-dir="$APP_DIR/repository.git" cat-file -e "$commit:$name" 2>/dev/null || continue
    git --git-dir="$APP_DIR/repository.git" show "$commit:$name" > "$staging/$name"
  done
  chmod 0755 "$work_dir"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$staging"
  (cd "$staging" && run_as_service env NODE_ENV=development "$NODE_BIN" "$NPM_BIN" ci --include=dev --no-audit --no-fund)
  [[ -d "$staging/node_modules" ]] || fail '依赖安装未生成 node_modules。'
  # Freeze once. Neither the running service nor later tests/builds can edit packages.
  chown -R root:root "$staging"
  chmod -R go-w "$staging"
  atomic_record "$staging/.complete" "$dependency_key"
  mv -- "$staging" "$dependencies"
}
prepare_workspace() {
  prepare_source
  [[ ! -d "$work_dir/source/node_modules" ]] || return 0
  prepare_dependencies
  local entry name modules="$work_dir/source/node_modules"
  mkdir "$modules"
  # Only top-level links: packages stay immutable, while Vite's .vite-temp/.vite
  # are created in this private workspace. No dependency copy or recursive chown.
  for entry in "$dependencies/node_modules/"* "$dependencies/node_modules/".[!.]*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name=${entry##*/}
    case "$name" in .vite|.vite-temp) continue ;; esac
    ln -s "$entry" "$modules/$name"
  done
  chown "$SERVICE_USER:$SERVICE_USER" "$modules"
}
prepare_application() {
  local reuse=0 need_build=1
  if application_ready; then reuse=1; fi
  if (( reuse )) || [[ -f "$built/.complete" && -s "$built/dist/index.html" ]]; then need_build=0; fi
  if [[ ! -f "$typecheck_stamp" || ( "$PROJECT_DEPLOY_TESTS" == 1 && ! -f "$test_stamp" ) ]] || (( need_build )); then prepare_workspace; fi
  if [[ ! -f "$typecheck_stamp" ]]; then
    log '类型检查输入变化，执行一次类型检查。'
    (cd "$work_dir/source" && run_as_service "$NODE_BIN" "$NPM_BIN" run check)
    atomic_record "$typecheck_stamp" "$typecheck_key"
  else log '类型检查输入未变化，复用验证结果。'; fi
  if [[ "$PROJECT_DEPLOY_TESTS" == 0 ]]; then
    log '跳过完整行为测试；CI 继续验证，设置 PROJECT_DEPLOY_TESTS=1 可在部署时补测。'
  elif [[ ! -f "$test_stamp" ]]; then
    log '测试或相关源码变化，在隔离目录执行行为测试。'
    (cd "$work_dir/source" && run_as_service "$NODE_BIN" "$NPM_BIN" test)
    atomic_record "$test_stamp" "$test_key"
  else log '行为测试输入未变化，复用验证结果。'; fi
  if (( need_build )); then
    log '前端内容或运行环境变化，构建页面。'
    (cd "$work_dir/source" && run_as_service env NODE_ENV=production "$NODE_BIN" "$NPM_BIN" run build:bundle)
    [[ -s "$work_dir/source/dist/index.html" ]] || fail '构建缺少 dist/index.html。'
    [[ ! -e "$built" ]] || fail '构建缓存目录不完整，请检查后重试。'
    mkdir "$work_dir/build"
    cp -a "$work_dir/source/dist" "$work_dir/build/dist"
    chown -R root:root "$work_dir/build"
    atomic_record "$work_dir/build/.complete" "$build_key"
    mv -- "$work_dir/build" "$built"
  else log '前端内容未变化，复用页面产物。'; fi
  if (( reuse )); then
    release=$old_release
    log '运行代码未变化，复用当前版本；未创建发布目录。'
    return
  fi
  release="$APP_DIR/releases/${commit:0:12}-${application_key:0:16}"
  if [[ -e "$release" ]]; then
    [[ ! -L "$release" && -f "$release/.managed-release" && "$(cat "$release/.managed-release")" == "$commit" &&
       -f "$release/.application-key" && "$(cat "$release/.application-key")" == "$application_key" &&
       -s "$release/dist/index.html" ]] || fail '候选版本目录已有未知或不完整内容，请检查后重试。'
    if (( RUNTIME_DEPENDENCIES )); then
      prepare_dependencies
      [[ -L "$release/node_modules" && "$(readlink "$release/node_modules")" == "$dependencies/node_modules" ]] || fail '候选版本依赖链接不正确。'
    fi
    return
  fi
  mkdir "$work_dir/publish"
  # Re-extract runtime source as root; tests/builds cannot modify published code.
  git --git-dir="$APP_DIR/repository.git" archive "$commit" server package.json | tar -x -C "$work_dir/publish"
  cp -a "$built/dist" "$work_dir/publish/dist"
  if (( RUNTIME_DEPENDENCIES )); then
    prepare_dependencies
    ln -s "$dependencies/node_modules" "$work_dir/publish/node_modules"
  fi
  atomic_record "$work_dir/publish/.managed-release" "$commit"
  atomic_record "$work_dir/publish/.source-sha" "$commit"
  atomic_record "$work_dir/publish/.application-key" "$application_key"
  mv -- "$work_dir/publish" "$release"
}
prepare_ci_application() {
  application_key=$CI_RELEASE_APPLICATION_KEY
  if [[ -n "$old_release" && -f "$old_release/.install-ready" && -f "$old_release/.ci-package-sha256" &&
        -f "$old_release/.application-key" && "$(cat "$old_release/.application-key")" == "$application_key" &&
        -s "$old_release/dist/index.html" && -f "$old_release/server/app.mjs" ]]; then
    if (( ! RUNTIME_DEPENDENCIES )) || [[ -f "$old_release/node_modules/ws/package.json" && -f "$old_release/node_modules/decimal.js/package.json" ]]; then
      release=$old_release
      log 'CI 运行内容未变化，复用当前版本；跳过部署包下载、依赖和构建。'
      return
    fi
  fi
  release="$APP_DIR/releases/${commit:0:12}-${application_key:0:16}"
  if [[ -e "$release" ]]; then
    [[ ! -L "$release" && -f "$release/.managed-release" && "$(cat "$release/.managed-release")" == "$commit" &&
       -f "$release/.ci-package-sha256" && "$(cat "$release/.ci-package-sha256")" == "$CI_RELEASE_SHA256" &&
       -s "$release/dist/index.html" && -f "$release/server/app.mjs" ]] || fail '候选 CI 版本目录已有未知或不完整内容。'
    return
  fi
  ci_release_extract "$APP_DIR/cache/archives" "$work_dir/publish"
  [[ -s "$work_dir/publish/dist/index.html" && -f "$work_dir/publish/server/app.mjs" && -f "$work_dir/publish/package.json" ]] || fail '部署包缺少运行文件。'
  if (( RUNTIME_DEPENDENCIES )); then
    [[ -f "$work_dir/publish/node_modules/ws/package.json" && -f "$work_dir/publish/node_modules/decimal.js/package.json" ]] || fail '部署包缺少后端依赖。'
  fi
  atomic_record "$work_dir/publish/.managed-release" "$commit"
  atomic_record "$work_dir/publish/.source-sha" "$commit"
  atomic_record "$work_dir/publish/.application-key" "$application_key"
  atomic_record "$work_dir/publish/.ci-package-sha256" "$CI_RELEASE_SHA256"
  chown -R root:root "$work_dir/publish"
  chmod -R a+rX,go-w "$work_dir/publish"
  mv -- "$work_dir/publish" "$release"
  log 'CI 部署包准备完成；服务器跳过 npm 安装、类型检查、测试及前端构建。'
}

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
  case "$PROJECT_DEPLOY_MODE" in source|ci) ;; *) fail 'PROJECT_DEPLOY_MODE 必须是 ci 或 source。'; return 1 ;; esac
  case "$PROJECT_DEPLOY_TESTS" in
    0|1) ;;
    *) fail 'PROJECT_DEPLOY_TESTS 必须是 0 或 1。'; return 1 ;;
  esac
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
  if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then
    runtime_key=$(printf '%s\n%s\n' "$("$NODE_BIN" --version)" "$(uname -m)" | hash)
    build_environment=ci-v1
  else
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
  [[ -x "$NPM_BIN" ]] || fail '当前 Node.js 没有对应 npm，请安装完整 Node.js 24 运行时。'
  runtime_key=$(printf '%s\n%s\n%s\n' "$("$NODE_BIN" --version)" "$("$NODE_BIN" "$NPM_BIN" --version)" "$(uname -m)" | hash)
  build_environment=$("$NODE_BIN" -e 'console.log(JSON.stringify(Object.entries(process.env).filter(([key]) => key.startsWith("VITE_")).sort(([a], [b]) => a.localeCompare(b))))')
  fi
  write_unit
  deployment_key=$({ cat "$ENV_FILE" "$work_dir/service"; printf '%s\n%s' "$runtime_key" "$INSTALL_REVISION:$build_environment"; } | hash)
  if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then
    ci_release_resolve hxx344/project-aggregation "$work_dir"
    commit=$CI_RELEASE_COMMIT
    [[ "$CI_RELEASE_NODE_VERSION" == "$NODE_VERSION" ]] || fail '部署包的 Node.js 版本与安装器不匹配，请获取最新版安装器。'
  else
  log '检查远端版本。'
  commit=$(git ls-remote --exit-code "$REPOSITORY" "refs/heads/$BRANCH" | cut -f 1)
  [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || fail '无法确定远端 main 的提交。'
  fi
  deployed_state=
  [[ ! -f "$APP_DIR/.deployed-state" ]] || deployed_state=$(cat "$APP_DIR/.deployed-state")
  if [[ ( "$PROJECT_DEPLOY_MODE" == ci || "$PROJECT_DEPLOY_TESTS" == 0 ) && -n "$old_release" && -f "$old_release/.install-ready" && -s "$old_release/dist/index.html" &&
        "$deployed_state" == "$commit $deployment_key" ]] && healthy; then
    remember_environment
    log "源提交 ${commit:0:12} 已检查、运行环境和配置未变化，服务健康；跳过下载、依赖、验证、构建和重启。"
    rm -rf -- "$work_dir"
    trap - ERR INT TERM
    return
  fi
  if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then
    prepare_ci_application
    run_as_service "$NODE_BIN" --input-type=module -e 'await import(process.argv[1])' "$release/server/app.mjs"
  else
  if [[ ! -d "$APP_DIR/repository.git" ]]; then git init --bare -q "$APP_DIR/repository.git"; fi
  if ! git --git-dir="$APP_DIR/repository.git" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git --git-dir="$APP_DIR/repository.git" fetch --quiet --depth=1 "$REPOSITORY" "$commit"
  else
    log '源码已缓存，跳过下载。'
  fi
  input_keys
  prepare_application
  fi
  if [[ "$release" == "$old_release" && "${deployed_state#* }" == "$deployment_key" ]] && healthy; then
    atomic_record "$APP_DIR/.deployed-state" "$commit $deployment_key"
    remember_environment
    log "已检查源提交 ${commit:0:12}；运行产物 $(cat "$release/.source-sha") 保持不变，跳过版本切换和重启。"
    rm -rf -- "$work_dir"
    trap - ERR INT TERM
    return
  fi
  previous_release=$old_release
  if [[ "$old_release" == "$release" && -L "$APP_DIR/previous" ]]; then previous_release=$(realpath -e "$APP_DIR/previous"); fi
  prepare_environment_rollback
  activation_started=1
  if [[ "$release" != "$old_release" ]]; then atomic_link "$release" "$APP_DIR/current"; fi
  if [[ ! -f "$UNIT_FILE" ]] || ! cmp -s "$work_dir/service" "$UNIT_FILE"; then
    install -m 0644 "$work_dir/service" "$UNIT_FILE"
    systemctl daemon-reload
  fi
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
  wait_healthy || fail '服务未在 30 次健康检查内就绪。'
  remember_environment
  activation_started=0
  atomic_record "$APP_DIR/.deployed-state" "$commit $deployment_key"
  atomic_record "$release/.install-ready" "$application_key"
  atomic_record "$APP_DIR/.node-path" "$NODE_BIN"
  if [[ -n "$previous_release" && "$previous_release" != "$release" ]]; then atomic_link "$previous_release" "$APP_DIR/previous"; fi
  prune_releases
  rm -rf -- "$work_dir"
  trap - ERR INT TERM
  log "安装完成：已检查源提交 ${commit:0:12}；运行产物 $(cat "$release/.source-sha")；监听 $HOST_VALUE:$PORT_VALUE，配置与数据已保留。"
  log "首次登录密码请在服务器运行：sudo journalctl -u $SERVICE --no-pager -n 30"
}

# CI may source pure helpers without changing its host.
if [[ "${AGG_INSTALL_SOURCE_ONLY:-0}" != 1 ]]; then main "$@"; fi
