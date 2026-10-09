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
