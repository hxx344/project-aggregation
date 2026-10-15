#!/usr/bin/env bash
# Shared verified release diagnostics. Works from a checkout or curl | bash.
set -Eeuo pipefail
work_dir=''
child=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  [[ -z "$work_dir" ]] || rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
command -v python3 >/dev/null 2>&1 || { echo '需要 Python 3；请先安装 python3。' >&2; exit 1; }
helper=''
script_path=${BASH_SOURCE[0]:-}
if [[ -n "$script_path" && -f "$script_path" ]]; then
  script_dir=$(cd -- "$(dirname -- "$script_path")" && pwd)
  [[ ! -f "$script_dir/deploy/mirror-tools.py" ]] || helper="$script_dir/deploy/mirror-tools.py"
fi
if [[ -n "$helper" ]]; then
  # Do not execute a sibling Python file replaceable by another account.
  if ! python3 -I - "$helper" <<'TRUSTED_HELPER_PY'
import os, stat, sys
from pathlib import Path
try:
    path = Path(os.path.abspath(sys.argv[1]))
    uid = os.geteuid() if hasattr(os, 'geteuid') else None
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) if item == path else stat.S_ISDIR(info.st_mode)):
            raise ValueError('invalid helper path')
        if uid is not None:
            sticky = item != path and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if info.st_uid not in (0, uid) or (info.st_mode & 0o022 and not sticky):
                raise ValueError('untrusted helper path')
except (OSError, ValueError) as error:
    sys.exit(str(error))
TRUSTED_HELPER_PY
  then
    echo '本地共享脚本路径不可信，改从官方固定发布版本取得。' >&2
    helper=''
  fi
fi
fetch_official() {
  local code
  if ! code=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --max-redirs 5 --connect-timeout 15 --max-time "$3" --max-filesize 1048576 \
    --write-out '%{http_code}' "$1" -o "$2"); then
    echo '无法取得官方固定发布依赖；请确认已发布包含镜像工具的正式版本。' >&2
    return 1
  fi
  [[ "$code" == 200 && -s "$2" ]] || { echo "官方依赖下载失败: HTTP $code 或空响应。" >&2; return 1; }
}
arguments=()
if [[ -z "$helper" ]]; then
  command -v curl >/dev/null 2>&1 || { echo '独立运行需要 curl。' >&2; exit 1; }
  work_dir=$(mktemp -d)
  manifest="$work_dir/release-manifest.json"
  fetch_official 'https://github.com/hxx344/project-aggregation/releases/latest/download/release-manifest.json' "$manifest" 90
  commit=$(python3 -I - "$manifest" <<'BOOTSTRAP_PY'
import json, re, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_bytes())
def require(test):
    if not test:
        raise ValueError('官方发布清单无效')
require(type(data.get('schema')) is int and data['schema'] == 1)
require(data.get('repository') == 'hxx344/project-aggregation')
commit = data.get('commit')
require(isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit))
require(data.get('tag') == 'deploy-' + commit)
require(isinstance(data.get('artifacts'), dict) and data['artifacts'])
for architecture, item in data['artifacts'].items():
    require(architecture in ('linux-x64', 'linux-arm64') and isinstance(item, dict))
    require(isinstance(item.get('file'), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz', item['file']))
    require(isinstance(item.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', item['sha256']))
print(commit)
BOOTSTRAP_PY
  )
  helper="$work_dir/mirror-tools.py"
  fetch_official "https://raw.githubusercontent.com/hxx344/project-aggregation/$commit/deploy/mirror-tools.py" "$helper" 60
  arguments+=(--manifest "$manifest")
fi
# stdin is not read: a pipeline must never consume the rest of its own shell source.
python3 -I "$helper" download-speed "${arguments[@]}" "$@" </dev/null &
child=$!
status=0
wait "$child" || status=$?
child=''
exit "$status"
