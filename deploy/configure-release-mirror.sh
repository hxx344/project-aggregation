#!/usr/bin/env bash
# Configure the deployment downloader, without changing application environments.
set -Eeuo pipefail
umask 022
CONFIG_FILE=/etc/project-aggregation/release-mirror.conf
SYSTEMD_OVERRIDE=/etc/systemd/system/project-aggregation.service.d/mirror.conf
URL=${RELEASE_MIRROR_URL:-}
KIND=${RELEASE_MIRROR_KIND:-github}
PRIORITY=${RELEASE_MIRROR_PRIORITY:-fallback}
TIMEOUT=${RELEASE_MIRROR_TIMEOUT:-60}
VERIFY=0
MANIFEST=
die() { printf '[mirror] %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --url|--kind|--priority|--timeout|--manifest)
      (($# >= 2)) || die "$1 缺少参数"
      case "$1" in --url) URL=$2;; --kind) KIND=$2;; --priority) PRIORITY=$2;; --timeout) TIMEOUT=$2;; --manifest) MANIFEST=$2;; esac
      shift 2;;
    --verify) VERIFY=1; shift;;
    --help) printf '用法: configure-release-mirror.sh --url URL [--kind github|oss] [--priority fallback|always|disabled] [--timeout 1..300] [--verify]\n无 URL 时从 /dev/tty 读取；disabled 不下载。相同已验收配置默认复用，--verify 强制重新验收。\n'; exit 0;;
    *) die "未知参数: $1";;
  esac
done
[[ $EUID == 0 ]] || die '请以 root 运行'
command -v python3 >/dev/null || die '需要 python3'
if [[ -z $URL && $PRIORITY != disabled ]]; then
  if ! { read -r -p '请输入镜像完整 URL（例如 https://releases.example.com）: ' URL </dev/tty; } 2>/dev/null; then
    die '没有可用终端或输入已结束；请使用 --url URL（不会读取脚本的 stdin）。'
  fi
  [[ -n $URL ]] || die '镜像 URL 不能为空；禁用请使用 --priority disabled'
fi
[[ -n $URL ]] || URL=http://127.0.0.1:8090
python3 -I - "$URL" "$KIND" "$PRIORITY" "$TIMEOUT" "$CONFIG_FILE" "$SYSTEMD_OVERRIDE" <<'MIRROR_CONFIG_PY'
import ipaddress, os, re, sys
from pathlib import Path
from urllib.parse import urlsplit
try:
    url, kind, priority, timeout, config, override = sys.argv[1:]
    parts = urlsplit(url)
    if any(c.isspace() or ord(c) < 32 for c in url) or parts.scheme not in ('http', 'https') or not url.startswith(parts.scheme + '://') or not parts.hostname or parts.username is not None or parts.password is not None or parts.path or '?' in url or '#' in url or '\\' in url or '%' in parts.netloc or parts.netloc.endswith(':'):
        raise ValueError('URL must contain only scheme://host[:port]')
    if parts.port is not None and not 1 <= parts.port <= 65535:
        raise ValueError('invalid port')
    host = parts.hostname
    if parts.scheme == 'http' and host not in ('127.0.0.1', '::1'):
        raise ValueError('HTTP is allowed only for literal loopback 127.0.0.1 or [::1]')
    try: ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r'(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', host) or any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in host.split('.')):
            raise ValueError('invalid host')
    if kind not in ('github', 'oss') or priority not in ('fallback', 'always', 'disabled'):
        raise ValueError('invalid kind or priority')
    if not re.fullmatch(r'[1-9][0-9]{0,2}', timeout) or not 1 <= int(timeout) <= 300:
        raise ValueError('timeout must be an integer from 1 to 300')
    for value in (config, override, '/run/project-aggregation-release-mirror/configure.lock'):
        path = Path(value)
        for item in (path, *path.parents):
            if item.is_symlink(): raise ValueError('symlink path: ' + str(item))
            if item.exists():
                info = item.stat()
                if os.name != 'nt' and (info.st_uid != 0 or info.st_mode & 0o022):
                    raise ValueError('untrusted ownership/mode: ' + str(item))
                if item == path and not item.is_file(): raise ValueError('expected regular file: ' + str(item))
except (ValueError, OSError) as error:
    sys.exit('[mirror] ' + str(error))
MIRROR_CONFIG_PY
mkdir -p -m 0700 -- /run/project-aggregation-release-mirror
exec 9>/run/project-aggregation-release-mirror/configure.lock
flock 9
WORK=$(mktemp -d /run/project-aggregation-release-mirror/configure.XXXXXXXX)
trap 'rm -rf -- "$WORK"' EXIT
printf '# release-mirror-config-v1\nRELEASE_MIRROR_URL=%s\nRELEASE_MIRROR_KIND=%s\nRELEASE_MIRROR_PRIORITY=%s\nRELEASE_MIRROR_TIMEOUT=%s\n' \
  "$URL" "$KIND" "$PRIORITY" "$TIMEOUT" > "$WORK/config"
remove_legacy_override() {
  [[ -f $SYSTEMD_OVERRIDE ]] || return 0
  printf '[Service]\n# 从配置文件加载镜像设置\nEnvironmentFile=-%s\n' "$CONFIG_FILE" > "$WORK/legacy-override"
  if cmp -s "$SYSTEMD_OVERRIDE" "$WORK/legacy-override"; then
    mv -- "$SYSTEMD_OVERRIDE" "$WORK/old-override"
    if ! systemctl daemon-reload; then
      cp -p -- "$WORK/old-override" "$SYSTEMD_OVERRIDE"
      die 'daemon-reload 失败，已恢复旧 override；工作台未重启'
    fi
    printf '[mirror] 已移除旧生成的业务服务 override；工作台未重启。\n'
  else
    printf '[mirror] 保留用户修改过的 service override: %s\n' "$SYSTEMD_OVERRIDE"
  fi
}
if ((VERIFY == 0)) && cmp -s "$WORK/config" "$CONFIG_FILE"; then
  remove_legacy_override
  printf '[mirror] 配置无变化，复用此前验收结果，跳过重复下载；可用 --verify 重新验收。\n'
  exit 0
fi
if [[ $PRIORITY != disabled ]]; then
  helper=
  if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
    helper="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/mirror-tools.py"
  fi
  if [[ ! -f $helper ]]; then
    command -v curl >/dev/null || die '需要 curl'
    http_code=$(curl --fail --silent --show-error --location --max-redirs 5 --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --connect-timeout 15 --max-time 90 --max-filesize 1048576 \
      'https://github.com/hxx344/project-aggregation/releases/latest/download/release-manifest.json' -o "$WORK/manifest.json" --write-out '%{http_code}')
    [[ $http_code == 200 ]] || die "官方清单 HTTP 状态错误: $http_code"
    revision=$(python3 -I - "$WORK/manifest.json" <<'MIRROR_BOOTSTRAP_PY'
import json, re, sys
try:
    with open(sys.argv[1], encoding='utf-8') as stream: data = json.load(stream)
    commit = data['commit']
    if type(data['schema']) is not int or data['schema'] != 1 or data['repository'] != 'hxx344/project-aggregation' or not re.fullmatch('[a-f0-9]{40}', commit) or data['tag'] != 'deploy-' + commit:
        raise ValueError('invalid official manifest identity')
    print(commit)
except (ValueError, OSError, KeyError, TypeError) as error:
    sys.exit('[mirror] ' + str(error))
MIRROR_BOOTSTRAP_PY
    )
    helper="$WORK/mirror-tools.py"
    http_code=$(curl --fail --silent --show-error --location --max-redirs 5 --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --connect-timeout 15 --max-time 60 --max-filesize 1048576 \
      "https://raw.githubusercontent.com/hxx344/project-aggregation/$revision/deploy/mirror-tools.py" -o "$helper" --write-out '%{http_code}')
    [[ $http_code == 200 ]] || die "固定版本工具 HTTP 状态错误: $http_code"
    [[ -n $MANIFEST ]] || MANIFEST="$WORK/manifest.json"
  fi
  python3 -I - "$helper" <<'MIRROR_HELPER_PY'
import os, sys
from pathlib import Path
try:
    path = Path(sys.argv[1])
    for item in (path, *path.parents):
        if item.is_symlink(): raise ValueError('symlink helper path: ' + str(item))
        info = item.stat()
        if os.name != 'nt' and (info.st_uid != 0 or info.st_mode & 0o022):
            raise ValueError('untrusted helper: ' + str(item))
except (OSError, ValueError) as error:
    sys.exit('[mirror] ' + str(error))
MIRROR_HELPER_PY
  verify_args=(verify --url "$URL" --kind "$KIND" --timeout "$TIMEOUT")
  [[ -z $MANIFEST ]] || verify_args+=(--manifest "$MANIFEST")
  printf '[mirror] 验证官方固定发布身份并下载镜像包校验 SHA-256…\n'
  python3 -I "$helper" "${verify_args[@]}" || die '镜像验收失败；保留已有配置'
fi
remove_legacy_override
mkdir -p -- "$(dirname "$CONFIG_FILE")"
staged=$(mktemp "${CONFIG_FILE}.XXXXXXXX")
if ! install -m 0644 -- "$WORK/config" "$staged" || ! mv -fT -- "$staged" "$CONFIG_FILE"; then
  rm -f -- "$staged"
  die '配置写入失败，已有镜像配置未替换'
fi
printf '[mirror] 已保存部署下载器配置: %s（%s / %s）；工作台服务未重启。\n' "$CONFIG_FILE" "$KIND" "$PRIORITY"
