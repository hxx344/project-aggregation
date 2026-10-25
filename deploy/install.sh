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
NODE_VERSION=24.15.0
PNPM_VERSION=11.25.0
PNPM_INTEGRITY=XN6SW08HX3Jetx+64YpC/+eEUkeJ8ZthxzHLhyHsKKruFg4BqNWvT+2ypCzb8wDv4j2zVrDUoXtNY+EfirfJVg==
INSTALL_REVISION=7
UPDATER_DIR=/usr/local/lib/project-aggregation-updater
UPDATER_STATE_DIR=/var/lib/project-aggregation-updater
UPDATER_RUN_DIR=/run/project-aggregation-updater
UPDATER_SERVICE=project-aggregation-updater
UPDATER_WORKER_SERVICE=project-aggregation-update-worker
UPDATER_UNIT_FILE=/etc/systemd/system/project-aggregation-updater.service
UPDATER_WORKER_UNIT_FILE=/etc/systemd/system/project-aggregation-update-worker.service
PROJECT_DEPLOY_TESTS=${PROJECT_DEPLOY_TESTS-0}
PROJECT_DEPLOY_MODE=${PROJECT_DEPLOY_MODE-source}
# The hub backend uses only Node built-ins. CrossEx also keeps runtime packages.
RUNTIME_DEPENDENCIES=0
activation_started=0
migration_commit_started=0
old_release=
old_unit_backup=
old_environment=
old_health_url=
work_dir=
module_migration_helper=
GREEKS_PYTHON_PATH=
ASTER_PYTHON_PATH=
MODULE_BUILD_IDS=(monitor asset crossex aster)
RUNTIME_DEPENDENCY_IMPORTERS=(. modules/monitor modules/asset modules/crossex)
declare -A MODULE_BUILD_IMPORTERS=([monitor]=modules/monitor [asset]=modules/asset [crossex]=modules/crossex [aster]=modules/aster/dashboard)
declare -A MODULE_BUILD_OUTPUTS=([monitor]=modules/monitor/dist [asset]=modules/asset/.next [crossex]=modules/crossex/dist [aster]=modules/aster/dashboard/dist)
declare -A MODULE_BUILD_ENTRIES=([monitor]=client/index.html [asset]=BUILD_ID [crossex]=index.html [aster]=client/index.html)
declare -A module_build_keys=()
declare -A module_build_recipes=()
declare -A legacy_module_build_keys=()
# Only this complete runner blob has been checked for equivalent direct build
# commands. Recipe digests also bind that equivalence to this installer code.
LEGACY_MODULE_RUNNER_BLOB=e7eb0c0c6bc14fb450bea423294fe56f75dbb768
declare -A LEGACY_MODULE_BUILD_RECIPES=(
  [monitor]=116f6e5a77bde31726c6084c3b572cfc1254b7823c8b4f119b65249249b0af5d
  [asset]=261becfd83608074f1efea6eab6324b0de0b491dad66ac92ac01ece85f34ae60
  [crossex]=60bcf7368d21d674d1f8ddc467093eac2432e31d7789028ccf90a88cab9925cb
  [aster]=7ce9059ea460126de7b43456dda0e1591f28293f1198e64e9428547733ff1d56
)
# 0: unchecked, 1: caches ready, 2: outputs available to workspace tests.
modules_prepared=0
declare -A module_outputs_prepared=()

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
  values=$(python3 -I - "$manifest" "$repository" "$(uname -m)" <<'CI_MANIFEST_PY'
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

ci_release_download() {
  python3 -I - "$@" <<'CI_DOWNLOAD_PY'
import concurrent.futures
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import ssl
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BLOCK = 8 * 1024 * 1024
MAX_SIZE = 2 * 1024 * 1024 * 1024
WORKERS = 4
ATTEMPTS = 3
SOCKET_TIMEOUT = 20
RANGE_DEADLINE = 180
SINGLE_DEADLINE = 1800
PROGRESS_UPDATE_INTERVAL = 0.5  # Update progress file every 500ms
PROGRESS_STAGES = {'preflight', 'download', 'prepare', 'build', 'verify', 'extract', 'switch', 'finalize'}
MAX_TIMINGS_BYTES = 16384
MAX_TIMINGS_ENTRIES = 32
PROGRESS_DETAILS = {
    'download': {'source-receive', 'source-retry'},
    'prepare': {'source-resolve', 'dependencies', 'runtime'},
    'build': {'build-workbench', 'build-monitor', 'build-asset', 'build-crossex', 'build-aster'},
    'verify': {'typecheck', 'tests'},
    'finalize': {'healthcheck', 'updater'},
}


class DownloadError(Exception):
    pass


class LocalDownloadError(DownloadError):
    """A local permission, configuration or cache error must never trigger failover."""
    pass


class Cancelled(DownloadError):
    pass


class MirrorTimeout(DownloadError):
    pass


class RangeRejected(DownloadError):
    pass


class Retryable(DownloadError):
    pass


def require(condition, message):
    if not condition:
        raise DownloadError(message)


def require_local(condition, message):
    if not condition:
        raise LocalDownloadError(message)


def https_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname and
            parsed.username is None and parsed.password is None,
            'download and redirect URLs must use HTTPS without credentials')
    return url


def mirror_base_url(value):
    """Only an explicitly configured literal loopback endpoint may use HTTP."""
    try:
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname or ''
        try:
            ipaddress.ip_address(host)
            valid_host = True
        except ValueError:
            valid_host = (0 < len(host) <= 253 and all(re.fullmatch(
                r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in host.split('.')))
        valid = (isinstance(value, str) and value.isascii() and
                 not any(ord(char) <= 32 or char == '\\' for char in value) and
                 parsed.scheme in ('https', 'http') and parsed.hostname and
                 parsed.username is None and parsed.password is None and
                 parsed.path in ('', '/') and not parsed.query and not parsed.fragment and
                 (parsed.port is None or 1 <= parsed.port <= 65535) and
                 valid_host and '%' not in parsed.netloc and
                 (parsed.scheme == 'https' or parsed.hostname in ('127.0.0.1', '::1')))
    except (TypeError, ValueError):
        valid = False
    require_local(valid, 'mirror must be an HTTPS origin or explicit literal loopback HTTP origin')
    return value.rstrip('/')


def mirror_origin(url):
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80)


def download_url(url, http_origin=None):
    if http_origin is not None:
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1') and
                parsed.username is None and parsed.password is None and
                mirror_origin(url) == http_origin):
            return url
    return https_url(url)


def read_mirror_config(path=Path('/etc/project-aggregation/release-mirror.conf')):
    """Read root-controlled data, never shell code or the application environment."""
    path = Path(path)
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    uid = os.geteuid() if hasattr(os, 'geteuid') else None
    for parent in reversed(path.parents):
        info = parent.lstat()
        require_local(stat.S_ISDIR(info.st_mode) and not parent.is_symlink(),
                      'mirror configuration parent must be a real directory')
        if uid is not None:
            sticky = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            require_local(info.st_uid in (0, uid) and (not info.st_mode & 0o022 or sticky),
                          'mirror configuration parent is not trusted')
    with secure_open(path) as source:
        require_local(os.fstat(source.fileno()).st_size <= 4096, 'oversized mirror configuration')
        try:
            content = source.read(4097).decode('utf-8')
        except UnicodeError as error:
            raise LocalDownloadError('mirror configuration is not UTF-8') from error
    values = {}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(?:"([^"\\]*)"|\'([^\'\\]*)\'|([A-Za-z0-9:/.[\]_-]*))', line)
        require_local(match is not None, 'invalid mirror configuration assignment')
        key = match[1]
        require_local(key not in values, 'duplicate mirror configuration key')
        values[key] = next(item for item in match.groups()[1:] if item is not None)
    if 'RELEASE_MIRROR_URL' not in values and 'RELEASE_MIRROR_DOMAIN' in values:
        print('[CI] 旧版镜像配置尚未接入下载器；本次使用 GitHub，请重新运行镜像配置工具。', file=sys.stderr)
        return None
    allowed = {'RELEASE_MIRROR_URL', 'RELEASE_MIRROR_KIND', 'RELEASE_MIRROR_PRIORITY', 'RELEASE_MIRROR_TIMEOUT'}
    require_local(not (values.keys() - allowed), 'unknown mirror configuration key')
    priority = values.get('RELEASE_MIRROR_PRIORITY', 'fallback')
    require_local(priority in ('fallback', 'always', 'disabled'), 'invalid mirror priority')
    if priority == 'disabled':
        return None
    base = mirror_base_url(values.get('RELEASE_MIRROR_URL', ''))
    kind = values.get('RELEASE_MIRROR_KIND', 'github')
    require_local(kind in ('github', 'oss'), 'invalid mirror kind')
    timeout = values.get('RELEASE_MIRROR_TIMEOUT', '60')
    require_local(re.fullmatch(r'[0-9]{1,3}', timeout) is not None and 1 <= int(timeout) <= 300,
                  'mirror timeout must be between 1 and 300 seconds')
    return {'url': base, 'kind': kind, 'priority': priority, 'timeout': int(timeout)}


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5
    max_repeats = 2

    def __init__(self, http_origin=None):
        super().__init__()
        self.http_origin = http_origin

    def redirect_request(self, request, fp, code, message, headers, newurl):
        # HTTPS requests cannot downgrade, even when the initial mirror is local HTTP.
        download_url(newurl, self.http_origin if request.full_url.startswith('http://') else None)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def secure_directory(path):
    """All parents must resist replacement by another user, including on cache hits."""
    path = Path(os.path.abspath(path))
    uid = os.geteuid() if hasattr(os, 'geteuid') else None
    for directory in reversed((path, *path.parents)):
        try:
            info = directory.lstat()
        except FileNotFoundError:
            directory.mkdir(mode=0o700)
            info = directory.lstat()
        require_local(stat.S_ISDIR(info.st_mode) and not directory.is_symlink(),
                'cache directory cannot contain links or special files')
        if uid is not None:
            require_local(info.st_uid in (0, uid), 'cache ancestor has an unexpected owner')
            sticky_parent = directory != path and info.st_uid in (0, uid) and info.st_mode & stat.S_ISVTX
            require_local(not info.st_mode & 0o022 or sticky_parent,
                    'cache ancestor is writable by another user')
    if uid is not None:
        require_local(path.stat().st_uid == uid, 'cache directory has an unexpected owner')
    path.chmod(0o700)
    return path


def secure_open(path, flags=os.O_RDONLY):
    """Never truncate before checking the opened inode (including hard links)."""
    try:
        before = path.lstat()
        require_local(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                'cache file must be a regular file with one link')
    except FileNotFoundError:
        before = None
    descriptor = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(descriptor)
        require_local(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                'cache file must be a regular file with one link')
        if hasattr(os, 'geteuid'):
            require_local(info.st_uid == os.geteuid() and not info.st_mode & 0o022,
                    'cache file has an unsafe owner or permissions')
        if before is not None:
            require_local((before.st_dev, before.st_ino) == (info.st_dev, info.st_ino), 'cache file changed while opening')
        return os.fdopen(descriptor, 'r+b' if flags & os.O_RDWR else 'rb')
    except BaseException:
        os.close(descriptor)
        raise


def secure_unlink(path):
    try:
        with secure_open(path):
            pass
    except FileNotFoundError:
        return
    path.unlink()


def digest_file(stream):
    stream.seek(0)
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(block)
    return digest.hexdigest()


def progress_directory():
    """Pin the root-controlled job directory without following any ancestor link."""
    filename = os.environ.get('PROJECT_UPDATE_PROGRESS_FILE', '')
    if not filename or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        return None, None, None
    directory = None
    try:
        parts = filename.split('/')
        if parts[0] or any(part in ('', '.', '..') for part in parts[1:]):
            return None, None, None
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory = os.open('/', flags)
        for part in [None, *parts[1:-1]]:
            if part is not None:
                child = os.open(part, flags, dir_fd=directory)
                os.close(directory)
                directory = child
            info = os.fstat(directory)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                return None, None, None
        # Timings and their lock are private, just like the progress file.
        if os.fstat(directory).st_mode & 0o077:
            return None, None, None
        result, directory = directory, None
        return result, parts[-1], parts[-2]
    finally:
        if directory is not None:
            os.close(directory)


def private_progress_file(info):
    return stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077


def atomic_progress_json(directory, name, data, prefix, maximum=4096):
    temporary = None
    try:
        encoded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(encoded) > maximum:
            return
        try:
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if current is not None and not private_progress_file(current):
            return
        candidate = prefix + secrets.token_hex(16)
        descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        temporary = candidate
        with os.fdopen(descriptor, 'wb') as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=directory)


def timing_integer(value, maximum=2 ** 53 - 1):
    return type(value) is int and 0 <= value <= maximum


def valid_stage_timings(data):
    if (not isinstance(data, dict) or type(data.get('schema')) is not int or data['schema'] != 1
            or not isinstance(data.get('jobId'), str) or re.fullmatch(r'[a-f0-9]{32}', data['jobId']) is None
            or not timing_integer(data.get('createdAt')) or type(data.get('closed')) is not bool):
        return False
    entries = data.get('entries')
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_TIMINGS_ENTRIES:
        return False
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get('stage'), str) or entry['stage'] not in PROGRESS_STAGES:
            return False
        stage, detail = entry['stage'], entry.get('detail')
        if 'detail' in entry and (not isinstance(detail, str) or detail not in PROGRESS_DETAILS.get(stage, set())):
            return False
        if 'durationMs' not in entry or entry['durationMs'] is not None and not timing_integer(entry['durationMs']):
            return False
        key = (stage, detail)
        if key in seen:
            return False
        seen.add(key)
    active = data.get('active')
    if active is None:
        return data['closed']
    return (not data['closed'] and isinstance(active, dict) and {'index', 'bootId', 'monotonicNs'} <= active.keys()
            and timing_integer(active.get('index'), len(entries) - 1)
            and (active.get('bootId') is None or isinstance(active['bootId'], str) and
                 re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', active['bootId']) is not None)
            and (active.get('monotonicNs') is None or timing_integer(active['monotonicNs'], 2 ** 63 - 1)))


def advance_stage_timings(data, stage, detail, stamp, monotonic_ns, boot_id, job_id, finish=False):
    """Accumulate only explicit intervals; polling and wall-clock changes add no time."""
    if not isinstance(job_id, str) or re.fullmatch(r'[a-f0-9]{32}', job_id) is None:
        return None
    if data is None:
        if finish:
            return None
        data = {'schema': 1, 'jobId': job_id, 'createdAt': stamp, 'closed': False, 'entries': [], 'active': None}
    elif not valid_stage_timings(data) or data['jobId'] != job_id or data['closed']:
        return None
    active = data['active']
    if active is not None:
        entry = data['entries'][active['index']]
        if not finish and (entry['stage'], entry.get('detail')) == (stage, detail) and active['bootId'] == boot_id:
            return None  # Byte/percentage refreshes never rewrite or split timing intervals.
        previous = active['monotonicNs']
        if (entry['durationMs'] is not None and boot_id is not None and active['bootId'] == boot_id
                and previous is not None and monotonic_ns is not None and monotonic_ns >= previous):
            duration = entry['durationMs'] + (monotonic_ns - previous) // 1000000
            entry['durationMs'] = duration if timing_integer(duration) else None
        else:
            entry['durationMs'] = None
    if finish:
        data.update(active=None, closed=True)
        return data
    for index, entry in enumerate(data['entries']):
        if (entry['stage'], entry.get('detail')) == (stage, detail):
            break
    else:
        if len(data['entries']) >= MAX_TIMINGS_ENTRIES:
            return None
        index = len(data['entries'])
        entry = {'stage': stage, 'durationMs': 0}
        if detail is not None:
            entry['detail'] = detail
        data['entries'].append(entry)
    data['active'] = {'index': index, 'bootId': boot_id, 'monotonicNs': monotonic_ns}
    return data


def write_stage_timings(directory, job_id, stage=None, detail=None, finish=False):
    """The fixed sibling file survives old workers and control-service restarts."""
    if not isinstance(job_id, str) or re.fullmatch(r'[a-f0-9]{32}', job_id) is None:
        return
    descriptor = None
    try:
        import fcntl
        descriptor = os.open('stage-timings.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                             0o600, dir_fd=directory)
        if not private_progress_file(os.fstat(descriptor)):
            return
        # Display-only data must never wait behind a stalled writer.
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        data = None
        try:
            source_fd = os.open('stage-timings.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            pass
        else:
            with os.fdopen(source_fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not private_progress_file(info) or info.st_size > MAX_TIMINGS_BYTES:
                    return
                raw = source.read(MAX_TIMINGS_BYTES + 1)
            if len(raw) > MAX_TIMINGS_BYTES:
                return
            data = json.loads(raw)
        try:
            boot_id = Path('/proc/sys/kernel/random/boot_id').read_text(encoding='ascii').strip()
            if re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', boot_id) is None:
                boot_id = None
        except (OSError, UnicodeError):
            boot_id = None
        result = advance_stage_timings(data, stage, detail, int(time.time() * 1000), time.monotonic_ns(), boot_id, job_id, finish)
        if result is not None:
            atomic_progress_json(directory, 'stage-timings.json', result, '.stage-timings-', MAX_TIMINGS_BYTES)
    except (ImportError, OSError, ValueError, TypeError, OverflowError, RecursionError):
        pass
    finally:
        if descriptor is not None:
            os.close(descriptor)


def finish_stage_timings():
    directory = None
    try:
        directory, _name, job_id = progress_directory()
        if directory is not None:
            write_stage_timings(directory, job_id, finish=True)
    except (OSError, ValueError, TypeError):
        pass
    finally:
        if directory is not None:
            os.close(directory)


def write_progress_file(stage, progress=None, downloaded=None, total=None, speed=None, detail=None):
    """Publish optional detail only in the coordinator's protected job directory."""
    directory = None
    try:
        if stage not in PROGRESS_STAGES:
            return
        data = {
            'stage': stage,
            'timestamp': int(time.time() * 1000),
        }
        if isinstance(detail, str) and detail in PROGRESS_DETAILS.get(stage, set()):
            data['detail'] = detail
        if progress is not None:
            if not isinstance(progress, (int, float)) or not 0 <= progress <= 1:
                return
            data['progress'] = float(progress)
        if downloaded is not None:
            data['downloaded'] = int(downloaded)
        if total is not None:
            data['total'] = int(total)
        if speed is not None and speed >= 0:
            data['speed'] = int(speed)
            if speed > 0 and downloaded is not None and total is not None and downloaded < total:
                remaining = total - downloaded
                data['eta'] = int(remaining / speed)
        directory, name, job_id = progress_directory()
        if directory is None:
            return
        write_stage_timings(directory, job_id, stage, data.get('detail'))
        atomic_progress_json(directory, name, data, '.progress-')
    except (OSError, ValueError, TypeError, OverflowError, RecursionError):
        pass  # Progress write failure should not block download
    finally:
        if directory is not None:
            os.close(directory)


def source_progress_sample(line):
    """Git's percentage counts objects, never bytes; do not infer a byte total/ETA."""
    match = re.match(r'^(Receiving objects|Resolving deltas):\s*(\d{1,3})%\s*\((\d+)/(\d+)\)'
                     r'(?:,\s*([0-9]+(?:\.[0-9]+)?)\s+(bytes|[KMGT]iB)'
                     r'\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s+(bytes|[KMGT]iB)/s)?', line)
    if not match:
        return None
    operation, percent, completed, count, amount, unit, rate, rate_unit = match.groups()
    completed, count = int(completed), int(count)
    if not count or not 0 <= completed <= count <= 2 ** 53 - 1 or not 0 <= int(percent) <= 100:
        return None
    receiving = operation == 'Receiving objects'
    sample = {'stage': 'download' if receiving else 'prepare', 'progress': completed / count,
              'detail': 'source-receive' if receiving else 'source-resolve'}
    if receiving and amount is not None:
        units = {'bytes': 1, 'KiB': 1024, 'MiB': 1024 ** 2, 'GiB': 1024 ** 3, 'TiB': 1024 ** 4}
        downloaded, speed = float(amount) * units[unit], float(rate) * units[rate_unit]
        if not 0 <= downloaded <= 2 ** 53 - 1 or not 0 <= speed <= 2 ** 53 - 1:
            return None
        sample.update(downloaded=int(downloaded), speed=int(speed))
    return sample


def source_progress_stream(source, output):
    """Relay the unchanged Git log while sampling bounded CR/LF progress records."""
    pending, discard, latest, published = b'', False, None, None
    last_write = 0
    while True:
        chunk = source.read1(4096)
        if not chunk:
            break
        output.write(chunk)
        output.flush()
        for part in re.split(b'([\r\n])', chunk):
            if part in (b'\r', b'\n'):
                if not discard:
                    sample = source_progress_sample(pending.decode('utf-8', errors='replace'))
                    if sample:
                        latest = sample
                        now = time.monotonic()
                        if now - last_write >= PROGRESS_UPDATE_INTERVAL or not published or sample['detail'] != published['detail']:
                            write_progress_file(**sample)
                            published, last_write = sample, now
                pending, discard = b'', False
            elif not discard:
                pending += part
                if len(pending) > 4096:
                    pending, discard = b'', True
    if pending and not discard:
        latest = source_progress_sample(pending.decode('utf-8', errors='replace')) or latest
    if latest and latest != published:
        write_progress_file(**latest)


class Downloader:
    def __init__(self, cache, url, expected, *, http_origin=None, timeout=None):
        require(re.fullmatch(r'[a-f0-9]{64}', expected) is not None, 'invalid archive SHA256')
        self.url, self.expected = download_url(url, http_origin), expected
        self.cache = secure_directory(cache)
        self.archive = self.cache / (expected + '.tar.gz')
        self.parts = self.cache / ('.' + expected + '.parts')
        self.opener = urllib.request.build_opener(HTTPSRedirect(http_origin))
        self.cancelled = threading.Event()
        self.phase_stop = threading.Event()
        self.active = set()
        self.active_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.progress_lock = threading.Lock()
        self.progress_stop = threading.Event()
        self.started = time.monotonic()
        self.deadline = self.started + timeout if timeout is not None else None
        self.received, self.total, self.positions = 0, None, {}
        self.mode = '检测'
        self.stage = 'download'
        self.last_progress_write = 0

    def check_cancel(self):
        if self.cancelled.is_set():
            raise Cancelled('download cancelled')
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise MirrorTimeout('mirror download deadline exceeded')
        if self.phase_stop.is_set():
            raise Cancelled('download cancelled')

    def progress(self):
        with self.progress_lock:
            current = sum(self.positions.values())
            elapsed = max(time.monotonic() - self.started, 0.001)
            percent = '%.1f%%' % (min(current / self.total, 1) * 100) if self.total else '?%'
            total = '%.1f' % (self.total / 1048576) if self.total else '?'
            print('[CI] 下载 %s: %s %.1f/%s MiB | %.2f MiB/s | %.0fs' %
                  (self.mode, percent, current / 1048576, total,
                   self.received / elapsed / 1048576, elapsed), file=sys.stderr, flush=True)

            # Write progress file for SSE streaming (rate-limited)
            now = time.monotonic()
            if self.stage == 'download' and now - self.last_progress_write >= PROGRESS_UPDATE_INTERVAL:
                speed = int(self.received / elapsed) if elapsed > 0 else 0
                write_progress_file(
                    stage='download',
                    progress=min(current / self.total, 1) if self.total else None,
                    downloaded=current,
                    total=self.total,
                    speed=speed
                )
                self.last_progress_write = now

    def set_mode(self, mode, total, positions=None):
        with self.progress_lock:
            self.stage = 'download'
            self.mode, self.total = mode, total
            self.positions = positions or {}
        self.progress()

    def monitor(self):
        while not self.progress_stop.wait(5):
            self.progress()

    def record(self, key, position, received=0):
        with self.progress_lock:
            self.positions[key] = position
            self.received += received

    def _open_request(self, request):
        # Official downloads remain HTTPS-only; only a trusted mirror can opt into local HTTP.
        timeout = SOCKET_TIMEOUT
        if self.deadline is not None:
            self.check_cancel()
            timeout = min(timeout, max(0.001, self.deadline - time.monotonic()))
        return self.opener.open(request, timeout=timeout)

    def request(self, start=None, end=None):
        self.check_cancel()
        headers = {'Accept-Encoding': 'identity', 'User-Agent': 'project-aggregation-installer'}
        if start is not None:
            headers['Range'] = 'bytes=%d-%d' % (start, end)
        try:
            response = self._open_request(urllib.request.Request(self.url, headers=headers))
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            if code in (408, 429) or 500 <= code <= 599:
                raise Retryable('HTTP %s' % code) from error
            if start is not None and code == 416:
                raise RangeRejected('server rejected byte ranges') from error
            raise DownloadError('download failed: HTTP %s' % code) from error
        except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
            if isinstance(error, ssl.SSLCertVerificationError) or isinstance(getattr(error, 'reason', None), ssl.SSLCertVerificationError):
                raise DownloadError('TLS certificate verification failed') from error
            raise Retryable('connection failed: %s' % error) from error
        with self.active_lock:
            self.active.add(response)
        try:
            self.check_cancel()
        except BaseException:
            self.close_response(response)
            raise
        return response

    def close_response(self, response):
        try:
            response.close()
        finally:
            with self.active_lock:
                self.active.discard(response)

    def stop_workers(self):
        self.phase_stop.set()
        with self.active_lock:
            responses = list(self.active)
        # Wake blocked reads without closing HTTPResponse from another thread.
        # Each request owner closes its response in finally; concurrent close/read1
        # races inside CPython's HTTPResponse._close_conn on Linux.
        for response in responses:
            try:
                raw = getattr(getattr(response, 'fp', None), 'raw', None)
                connection = getattr(raw, '_sock', None)
                if connection is not None:
                    connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def pause_retry(self, attempt):
        self.check_cancel()
        if attempt + 1 >= ATTEMPTS:
            return False
        if self.phase_stop.wait(min(2 ** attempt, 4)):
            self.check_cancel()
        self.check_cancel()
        return True

    @staticmethod
    def length(response):
        value = response.headers.get('Content-Length')
        if value is None:
            return None
        if not re.fullmatch(r'[0-9]+', value):
            raise RangeRejected('invalid Content-Length')
        return int(value)

    @staticmethod
    def identity(response):
        if response.headers.get('Content-Encoding', 'identity').strip().lower() != 'identity':
            raise RangeRejected('unexpected Content-Encoding')

    def range_headers(self, response, start, end, total):
        self.identity(response)
        if response.status != 206 or response.headers.get('Content-Range') != 'bytes %d-%d/%d' % (start, end, total):
            raise RangeRejected('server returned an inconsistent byte range')
        if self.length(response) != end - start + 1:
            raise RangeRejected('server returned an inconsistent range length')

    def read(self, response, amount, deadline):
        self.check_cancel()
        if time.monotonic() >= deadline:
            raise Retryable('request deadline exceeded')
        try:
            if self.deadline is not None:
                raw = getattr(getattr(response, 'fp', None), 'raw', None)
                connection = getattr(raw, '_sock', None)
                if connection is not None:
                    connection.settimeout(min(SOCKET_TIMEOUT, max(0.001, self.deadline - time.monotonic())))
            return response.read1(amount)
        except (OSError, http.client.HTTPException) as error:
            self.check_cancel()
            raise Retryable('connection interrupted') from error

    def probe(self):
        write_progress_file('download')
        for attempt in range(ATTEMPTS):
            response = None
            try:
                response = self.request(0, 0)
                content_range = re.fullmatch(r'bytes 0-0/([0-9]+)', response.headers.get('Content-Range', ''))
                if response.status != 206 or content_range is None:
                    return None
                total = int(content_range[1])
                if not 0 < total <= MAX_SIZE:
                    raise DownloadError('archive exceeds size limit')
                self.range_headers(response, 0, 0, total)
                # The byte value is irrelevant; only this exact response's shape enables ranges.
                if len(self.read(response, 2, time.monotonic() + RANGE_DEADLINE)) == 1:
                    return total
                raise Retryable('incomplete range probe')
            except RangeRejected:
                return None
            except Retryable as error:
                print('[CI] Range 检测失败（%d/%d）：%s' % (attempt + 1, ATTEMPTS, error), file=sys.stderr, flush=True)
                if not self.pause_retry(attempt):
                    raise
            finally:
                if response is not None:
                    self.close_response(response)

    def invalidate_parts(self):
        # Only names created by this implementation are ever removed.
        for index in range(MAX_SIZE // BLOCK):
            secure_unlink(self.parts / ('part-%03d' % index))
        for name in ('metadata.json', 'metadata.json.new', 'assembly.part', 'single.part'):
            secure_unlink(self.parts / name)

    def save_state(self):
        path = self.parts / 'metadata.json.new'
        with secure_open(path, os.O_RDWR | os.O_CREAT) as target:
            target.truncate(0)
            target.write(json.dumps(self.state, sort_keys=True).encode('utf-8'))
            target.flush()
            os.fsync(target.fileno())
        os.replace(path, self.parts / 'metadata.json')

    def prepare_parts(self, total):
        identity = {'version': 1, 'url': self.url, 'sha256': self.expected, 'size': total, 'block': BLOCK}
        saved = {}
        try:
            with secure_open(self.parts / 'metadata.json') as source:
                require(os.fstat(source.fileno()).st_size <= 65536, 'oversized download metadata')
                saved = json.load(source)
        except (FileNotFoundError, ValueError, UnicodeError):
            pass
        if not isinstance(saved, dict) or any(saved.get(key) != value for key, value in identity.items()):
            self.invalidate_parts()
            saved = {}
        completed = saved.get('completed', {})
        if not isinstance(completed, dict):
            completed = {}
        self.state = dict(identity, completed={})
        pending, positions = [], {}
        for index, start in enumerate(range(0, total, BLOCK)):
            size = min(BLOCK, total - start)
            path = self.parts / ('part-%03d' % index)
            with secure_open(path, os.O_RDWR | os.O_CREAT) as part:
                length = os.fstat(part.fileno()).st_size
                if length == size and completed.get(str(index)) == digest_file(part):
                    self.state['completed'][str(index)] = completed[str(index)]
                else:
                    if length >= size:
                        part.truncate(0)
                        length = 0
                    pending.append((index, start, size))
                positions[index] = length
        self.save_state()
        return pending, positions

    def part(self, index, start, size):
        path = self.parts / ('part-%03d' % index)
        for attempt in range(ATTEMPTS):
            response = None
            try:
                self.check_cancel()
                with secure_open(path, os.O_RDWR) as target:
                    offset = os.fstat(target.fileno()).st_size
                    response = self.request(start + offset, start + size - 1)
                    self.range_headers(response, start + offset, start + size - 1, self.total)
                    target.seek(offset)
                    deadline = time.monotonic() + RANGE_DEADLINE
                    while offset < size:
                        data = self.read(response, min(65536, size - offset), deadline)
                        if not data:
                            raise Retryable('incomplete byte range')
                        target.write(data)
                        offset += len(data)
                        self.record(index, offset, len(data))
                    target.flush()
                    os.fsync(target.fileno())
                    digest = digest_file(target)
                with self.state_lock:
                    self.state['completed'][str(index)] = digest
                    self.save_state()
                return
            except Retryable as error:
                print('[CI] 分块 %d 失败（%d/%d）：%s' % (index + 1, attempt + 1, ATTEMPTS, error), file=sys.stderr, flush=True)
                if not self.pause_retry(attempt):
                    raise
            finally:
                if response is not None:
                    self.close_response(response)

    def parallel(self, total):
        pending, positions = self.prepare_parts(total)
        self.set_mode('并发（最多 4 路，可续传）', total, positions)
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS)
        futures = []
        try:
            futures = [executor.submit(self.part, *item) for item in pending]
            waiting = set(futures)
            while waiting:
                self.check_cancel()
                done, waiting = concurrent.futures.wait(waiting, timeout=0.25,
                                                       return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    future.result()
        finally:
            self.stop_workers()
            for future in futures:
                future.cancel()
            executor.shutdown(wait=True)
        self.phase_stop.clear()
        path = self.parts / 'assembly.part'
        with secure_open(path, os.O_RDWR | os.O_CREAT) as target:
            target.truncate(0)
            for index in range((total + BLOCK - 1) // BLOCK):
                self.check_cancel()
                with secure_open(self.parts / ('part-%03d' % index)) as source:
                    for data in iter(lambda: source.read(1024 * 1024), b''):
                        target.write(data)
            target.flush()
            os.fsync(target.fileno())
        return path

    def single(self):
        self.phase_stop.clear()
        self.check_cancel()
        path = self.parts / 'single.part'
        self.set_mode('单连接', None)
        for attempt in range(ATTEMPTS):
            response = None
            try:
                response = self.request()
                require(response.status == 200, 'unexpected single-stream response')
                self.identity(response)
                total = self.length(response)
                require(total is None or 0 < total <= MAX_SIZE, 'archive exceeds size limit')
                self.set_mode('单连接', total)
                with secure_open(path, os.O_RDWR | os.O_CREAT) as target:
                    target.truncate(0)
                    count = 0
                    deadline = time.monotonic() + SINGLE_DEADLINE
                    while True:
                        data = self.read(response, min(65536, MAX_SIZE + 1 - count), deadline)
                        if not data:
                            break
                        count += len(data)
                        require(count <= MAX_SIZE, 'archive exceeds size limit')
                        target.write(data)
                        self.record('single', count, len(data))
                    if total is not None and count != total:
                        raise Retryable('incomplete single-stream response')
                    target.flush()
                    os.fsync(target.fileno())
                return path
            except Retryable as error:
                print('[CI] 单连接失败（%d/%d）：%s' % (attempt + 1, ATTEMPTS, error), file=sys.stderr, flush=True)
                if not self.pause_retry(attempt):
                    raise
            finally:
                if response is not None:
                    self.close_response(response)

    def locked_download(self):
        try:
            with secure_open(self.archive) as source:
                write_progress_file('verify')
                if digest_file(source) == self.expected:
                    print('[CI] 部署包已缓存且校验通过，跳过下载。', file=sys.stderr, flush=True)
                    write_progress_file('verify', 1.0)
                    return self.archive
            secure_unlink(self.archive)
        except FileNotFoundError:
            pass
        self.parts = secure_directory(self.parts)
        monitor = threading.Thread(target=self.monitor, daemon=True)
        monitor.start()
        try:
            self.progress()
            total = self.probe()
            try:
                candidate = self.parallel(total) if total is not None else self.single()
            except RangeRejected:
                print('[CI] 服务器分块响应不一致，已停止并发，改用单连接。', file=sys.stderr, flush=True)
                candidate = self.single()

            for clean_attempt in range(2):
                with self.progress_lock:
                    self.stage = 'verify'
                write_progress_file('verify', total=total)
                with secure_open(candidate) as source:
                    verified = digest_file(source) == self.expected
                if verified:
                    self.check_cancel()
                    # The cache directory and candidate are private and the per-hash lock remains held.
                    os.replace(candidate, self.archive)
                    self.invalidate_parts()
                    self.progress()
                    write_progress_file('verify', 1.0, total=total)
                    return self.archive
                self.invalidate_parts()
                require(clean_attempt == 0, 'archive SHA256 mismatch after clean download')
                print('[CI] 部署包 SHA256 不匹配，清理本包分块后重新单连接下载。', file=sys.stderr, flush=True)
                candidate = self.single()
        finally:
            self.stop_workers()
            self.progress_stop.set()
            monitor.join()

    def run(self):
        handlers = {}
        timer = None

        def interrupt(number, frame):
            if not self.cancelled.is_set():
                self.cancelled.set()
                raise Cancelled('download interrupted by signal %s' % number)

        try:
            if self.deadline is not None:
                timer = threading.Timer(max(0, self.deadline - time.monotonic()), self.stop_workers)
                timer.daemon = True
                timer.start()
            if threading.current_thread() is threading.main_thread():
                for name in ('SIGINT', 'SIGTERM', 'SIGHUP'):
                    number = getattr(signal, name, None)
                    if number is not None:
                        handlers[number] = signal.signal(number, interrupt)
            with secure_open(self.cache / ('.' + self.expected + '.lock'), os.O_RDWR | os.O_CREAT) as lock:
                if os.name == 'posix':
                    import fcntl
                    while True:
                        self.check_cancel()
                        try:
                            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            self.cancelled.wait(0.25)
                return self.locked_download()
        finally:
            if timer is not None:
                timer.cancel()
                timer.join()
            for number, handler in handlers.items():
                signal.signal(number, handler)


def release_download(cache, url, expected, *, config_path=None):
    """Only immutable archives use mirrors; discovery and executable sources stay official."""
    https_url(url)
    match = re.fullmatch(
        r'https://github\.com/(hxx344/project-aggregation)/releases/download/'
        r'(deploy-[a-f0-9]{40})/([A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz)', url)
    config = (read_mirror_config() if config_path is None else read_mirror_config(config_path)) if match else None
    if config is not None:
        repository, tag, filename = match.groups()
        suffix = (f'/{repository}/releases/download/{tag}/{filename}' if config['kind'] == 'github'
                  else f'/releases/{repository}/{tag}/{filename}')
        candidate = config['url'] + suffix
        http_origin = mirror_origin(candidate) if candidate.startswith('http://') else None
        print('[CI] 尝试已配置镜像下载固定版本包；仍按官方清单验证 SHA256。', file=sys.stderr, flush=True)
        try:
            return Downloader(cache, candidate, expected, http_origin=http_origin, timeout=config['timeout']).run()
        except (Cancelled, LocalDownloadError):
            raise
        except DownloadError:
            if config['priority'] == 'always':
                raise
            print('[CI] 镜像下载或完整性校验失败，回退 GitHub 固定版本。', file=sys.stderr, flush=True)
    return Downloader(cache, url, expected).run()


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--progress':
            write_progress_file(sys.argv[2], float(sys.argv[3]) if sys.argv[3] else None,
                                detail=sys.argv[4] if len(sys.argv) > 4 else None)
        elif sys.argv[1] == '--finish-progress':
            finish_stage_timings()
        elif sys.argv[1] == '--source-progress':
            with os.fdopen(3, 'rb') as source:
                source_progress_stream(source, sys.stderr.buffer)
        else:
            print(release_download(*sys.argv[1:]))
    except (DownloadError, OSError, ValueError) as error:
        print('[CI] 部署包下载失败：' + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
CI_DOWNLOAD_PY
}

ci_update_progress() {
  # Old workers and direct installs omit this optional, root-controlled path.
  [[ -n ${PROJECT_UPDATE_PROGRESS_FILE:-} ]] || return 0
  ci_release_download --progress "$1" "${2:-}" "${3:-}" >/dev/null 2>&1 || true
}

ci_finish_progress() {
  [[ -n ${PROJECT_UPDATE_PROGRESS_FILE:-} ]] || return 0
  ci_release_download --finish-progress >/dev/null 2>&1 || true
}

ci_source_progress() {
  if [[ -z ${PROJECT_UPDATE_PROGRESS_FILE:-} ]]; then cat >&2; return; fi
  # Python's stdin contains the trusted helper; fd 3 carries only Git's log.
  ci_release_download --source-progress 3<&0
}

ci_release_extract() {
  local cache=$1 destination=$2 archive
  ci_release_download "$cache" \
    "https://github.com/$CI_RELEASE_REPOSITORY/releases/download/$CI_RELEASE_TAG/$CI_RELEASE_FILE" \
    "$CI_RELEASE_SHA256" || return 1
  archive="$cache/$CI_RELEASE_SHA256.tar.gz"
  ci_update_progress extract
  python3 -I - "$archive" "$destination" "$CI_RELEASE_COMMIT" "$CI_RELEASE_APPLICATION_KEY" "$CI_RELEASE_SHA256" <<'CI_EXTRACT_PY'
import hashlib, os, shutil, stat, sys, tarfile
from pathlib import Path, PurePosixPath
def require(condition, message):
    if not condition:
        raise ValueError(message)
try:
    archive_path = Path(sys.argv[1])
    before = archive_path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'archive must be a regular file with one link')
    descriptor = os.open(archive_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    source = os.fdopen(descriptor, 'rb')
    info = os.fstat(source.fileno())
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'archive must be a regular file with one link')
    require(not hasattr(os, 'geteuid') or info.st_uid == os.geteuid(), 'archive has an unexpected owner')
    digest = hashlib.sha256()
    for block in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(block)
    if digest.hexdigest() != sys.argv[5]:
        source.close()
        current = archive_path.lstat()
        if (info.st_dev, info.st_ino) == (current.st_dev, current.st_ino):
            archive_path.unlink()
        raise ValueError('archive SHA256 mismatch')
    source.seek(0)
    destination = Path(sys.argv[2])
    require(not destination.is_symlink(), 'destination cannot be a symlink')
    destination.mkdir(parents=True, exist_ok=True)
    require(not any(destination.iterdir()), 'destination must be empty')
    with source, tarfile.open(fileobj=source, mode='r:gz') as archive:
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
# The runtime socket <runtime dir>/runtime-<uuid>.sock must fit the 100-byte
# Unix socket path limit (server/runtime/protocol.mjs): 50 bytes follow the
# runtime directory, which is <DATA_DIR>/run unless WORKBENCH_RUNTIME_DIR is set.
runtime_dir_fits() {
  ((${#1} <= 50))
}

health_url() {
  local host=$1 port=$2
  case "$host" in 0.0.0.0) host=127.0.0.1 ;; ::) host='[::1]' ;; *:*) host="[$host]" ;; esac
  printf 'http://%s:%s/api/health' "$host" "$port"
}
remember_environment() {
  # main runs as root; a root-only snapshot may include INITIAL_PASSWORD.
  local temporary="$APP_DIR/.last-successful.env.new.$$"
  install -m 0600 "$ENV_FILE" "$temporary" || return 1
  mv -f -- "$temporary" "$APP_DIR/.last-successful.env" || return 1
}
prepare_environment_rollback() {
  old_environment=
  old_health_url=
  local module
  for module in greeks aster; do
    if [[ -f "$APP_DIR/.$module-python-path" ]]; then
      install -m 0600 "$APP_DIR/.$module-python-path" "$work_dir/previous-$module-python-path" || return 1
    else
      touch "$work_dir/previous-$module-python-path.absent" || return 1
    fi
  done
  [[ -n "$old_release" ]] || return 0
  if [[ ! -f "$APP_DIR/.last-successful.env" ]]; then
    fail '缺少上次成功的环境配置快照，已在切换版本前停止；现有服务保持运行。'
    return 1
  fi
  old_environment="$work_dir/previous.env"
  install -m 0600 "$APP_DIR/.last-successful.env" "$old_environment"
  old_health_url=$(health_url "$(read_setting HOST 127.0.0.1 "$old_environment")" "$(read_setting PORT 3100 "$old_environment")")
}
# The interpreter recorded before this activation belongs to the release that
# becomes the rollback target. The record names that release so cache pruning
# can ignore it whenever the previous link has moved without it.
remember_previous_python_paths() {
  local module interpreter target
  target=$(realpath -e -- "$1") || return 1
  for module in greeks aster; do
    interpreter=
    if [[ -f "$work_dir/previous-$module-python-path" ]]; then interpreter=$(cat -- "$work_dir/previous-$module-python-path") || return 1; fi
    atomic_record "$APP_DIR/.previous-$module-python-path" "$target"$'\n'"$interpreter" || return 1
  done
}
restore_python_paths() {
  local module
  for module in greeks aster; do
    if [[ -f "$work_dir/previous-$module-python-path" ]]; then
      install -m 0600 "$work_dir/previous-$module-python-path" "$APP_DIR/.$module-python-path" || return 1
    elif [[ -f "$work_dir/previous-$module-python-path.absent" ]]; then
      rm -f -- "$APP_DIR/.$module-python-path" || return 1
    fi
  done
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
  # Activation records may already contain the failed candidate. Restore the
  # durable snapshot too, so a later deployment cannot roll back to that state.
  remember_environment || return 1
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
  trap - ERR INT TERM EXIT
  set +e
  # Close before recovery. If this optional write fails, leave the interval
  # unknown instead of retrying at EXIT and counting rollback as deployment.
  ci_finish_progress
  if [[ "$activation_started" == 1 ]]; then
    # A signal/error can arrive after the journal commits but before Python
    # returns. Check only this attempt's commit window, never a historic receipt.
    if [[ "$migration_commit_started" == 1 && -n "$module_migration_helper" ]]; then
      local migration_status
      if ! migration_status=$(python3 "$module_migration_helper" status --data "$DATA_PATH" --journal "$APP_DIR/.module-migration.json"); then
        log '无法确认迁移提交结果；保留当前服务，请检查迁移日志后重试。'
        exit "$exit_code"
      fi
      if [[ "$migration_status" == committed ]]; then
        log '模块迁移已提交，保留已通过健康检查的新服务；重试安装可补齐剩余记录。'
        exit "$exit_code"
      fi
    fi
    # Stop every embedded writer before re-enabling its standalone predecessor.
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    if [[ -n "$module_migration_helper" ]]; then
      if ! python3 "$module_migration_helper" rollback --data "$DATA_PATH" --journal "$APP_DIR/.module-migration.json"; then
        log '旧模块服务恢复未完成；工作台保持停止，请检查迁移日志后重试。'
        exit "$exit_code"
      fi
    fi
    log '新版本启动失败，正在恢复之前的程序和服务配置。'
    if [[ -n "$old_unit_backup" && -f "$old_unit_backup" ]]; then
      cp -- "$old_unit_backup" "$UNIT_FILE"
    else
      systemctl stop "$SERVICE" >/dev/null 2>&1 || true
      systemctl disable "$SERVICE" >/dev/null 2>&1 || true
      if [[ -f "$UNIT_FILE" ]] && grep -q '^# Managed by project-aggregation installer$' "$UNIT_FILE"; then rm -f -- "$UNIT_FILE"; fi
    fi
    if ! restore_python_paths; then
      log '无法恢复上次成功的 Python 路径记录；工作台保持停止，请检查磁盘权限。'
      exit "$exit_code"
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
  local tools=(curl xz python3)
  if [[ "$PROJECT_DEPLOY_MODE" == source ]]; then tools+=(git); fi
  for tool in "${tools[@]}"; do
    if ! command -v "$tool" >/dev/null 2>&1 || [[ "$tool" == python3 && ! -x /usr/bin/python3 ]]; then
      case "$tool" in xz) missing+=(xz-utils) ;; *) missing+=("$tool") ;; esac
    fi
  done
  if ! /usr/bin/python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then missing+=(python3-venv); fi
  [[ -s /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
  if ! command -v flock >/dev/null 2>&1 || ! command -v runuser >/dev/null 2>&1; then missing+=(util-linux); fi
  if ((${#missing[@]})); then
    command -v apt-get >/dev/null 2>&1 || fail '缺少依赖且没有 apt-get；请安装 curl git xz-utils python3 ca-certificates util-linux 后重试。'
    ci_update_progress prepare
    log "安装缺少的系统依赖：${missing[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  else
    log '系统依赖已齐全，跳过安装。'
  fi
  /usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || fail '内置 Greeks 与 ASTER 需要 Python 3.11+；请使用 Debian 12/13 或 Ubuntu 24.04。'
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
    ci_update_progress prepare
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
ensure_pnpm() {
  local runtime_dir="$APP_DIR/runtime/pnpm-$PNPM_VERSION" archive="$work_dir/pnpm.tgz" staging="$work_dir/pnpm"
  PNPM_BIN="$runtime_dir/bin/pnpm.mjs"
  if [[ -f "$PNPM_BIN" ]]; then
    updater_safe_path "$PNPM_BIN"
    [[ "$("$NODE_BIN" "$PNPM_BIN" --version)" == "$PNPM_VERSION" ]] || fail '已缓存 pnpm 版本不匹配。'
    return
  fi
  [[ ! -e "$runtime_dir" ]] || fail 'pnpm 运行时目录不完整，请检查后重试。'
  ci_update_progress prepare
  log "准备固定版本 pnpm $PNPM_VERSION 并校验官方包 SHA-512。"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz" -o "$archive"
  python3 - "$archive" "$PNPM_INTEGRITY" <<'PNPM_INTEGRITY_PY'
import base64, hashlib, sys
from pathlib import Path
actual = base64.b64encode(hashlib.sha512(Path(sys.argv[1]).read_bytes()).digest()).decode()
if actual != sys.argv[2]:
    raise SystemExit('pnpm package integrity mismatch')
PNPM_INTEGRITY_PY
  mkdir -p "$APP_DIR/runtime" "$staging"
  tar -xzf "$archive" -C "$staging" --strip-components=1 --no-same-owner
  [[ "$("$NODE_BIN" "$staging/bin/pnpm.mjs" --version)" == "$PNPM_VERSION" ]] || fail 'pnpm 下载包版本不匹配。'
  ln -s pnpm.mjs "$staging/bin/pnpm"
  chown -R root:root "$staging"
  chmod -R a+rX,go-w "$staging"
  mv -- "$staging" "$runtime_dir"
}
run_as_service() {
  local manager_path=
  [[ -z ${PNPM_BIN:-} ]] || manager_path="$(dirname "$PNPM_BIN"):"
  # These commands use a separately verified, frozen dependency cache. pnpm 11
  # must not reinstall it because its recorded install directory has moved.
  runuser -u "$SERVICE_USER" -- env pnpm_config_verify_deps_before_run=false "HOME=$APP_DIR/build-home" "PATH=$(dirname "$NODE_BIN"):${manager_path}/usr/local/bin:/usr/bin:/bin" "$@"
}
tree_hash() { git --git-dir="$APP_DIR/repository.git" ls-tree -r "$commit" -- "$@" | hash; }
validate_module_build_source() {
  local module=$1 tree
  # The old runner rejected source links before compilation. Inspect the fixed
  # Git tree as data; never execute a verifier from the writable build tree.
  tree=$(git --git-dir="$APP_DIR/repository.git" ls-tree -r "$commit" -- "modules/$module") || return
  case "$tree" in
    120000\ *|*$'\n120000 '*) fail "$module 源码包含符号链接，停止构建或缓存复用。"; return 1 ;;
  esac
}
run_module_build() {
  local module=$1 importer=${MODULE_BUILD_IMPORTERS[$1]}
  (
    cd "$work_dir/source/$importer" || return
    if [[ "$module" == asset ]]; then
      run_as_service "$NODE_BIN" "$PNPM_BIN" run prepare || return
    fi
    run_as_service "$NODE_BIN" "$PNPM_BIN" run build || return
    if [[ "$module" == monitor && ! -f dist/build-manifest.json ]]; then
      fail 'monitor 构建缺少 dist/build-manifest.json。'
      return 1
    fi
  )
}
module_build_recipe() {
  local module=$1 definitions
  definitions=$(declare -f run_module_build validate_module_build_source) || return
  printf 'direct-module-build-v1\n%s\n%s\n%s\n%s\n%s\n' "$definitions" "$module" \
    "${MODULE_BUILD_IMPORTERS[$module]}" "${MODULE_BUILD_OUTPUTS[$module]}" "${MODULE_BUILD_ENTRIES[$module]}" | hash
}
read_build_environment() {
  "$NODE_BIN" -e 'console.log(JSON.stringify(Object.entries(process.env).filter(([key]) => key === "NODE_ENV" || /^(VITE_|NEXT_PUBLIC_)/.test(key)).sort(([a], [b]) => a.localeCompare(b))))'
}
atomic_record() {
  local destination=$1 value=$2 temporary="${1}.new.$$"
  printf '%s\n' "$value" > "$temporary" || return 1
  mv -f -- "$temporary" "$destination" || return 1
}
input_keys() {
  # Read git trees separately so a failed read cannot be masked by printf/hash.
  local dependency_tree typecheck_tree test_tree build_tree runtime_tree embedded_tree runtime_dependency_tree module module_tree
  local legacy_runner_blob legacy_tree module_recipe module_artifacts_key
  local -a navigation_inputs=(server/hub-navigation.mjs server/hub-navigation.d.mts server/asset-identity.mjs server/asset-identity.d.mts)
  local -a module_shared_inputs=("${navigation_inputs[@]}" server/capital-metrics.mjs server/capital-metrics.d.mts)
  local -a module_inputs
  legacy_module_build_keys=()
  dependency_tree=$(tree_hash package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc scripts/install-hooks.mjs \
    modules/monitor/package.json modules/asset/package.json modules/crossex/package.json modules/aster/dashboard/package.json \
    modules/monitor/.npmrc modules/asset/.npmrc modules/crossex/.npmrc modules/aster/dashboard/.npmrc \
    modules/asset/scripts/prepare-ledger.mjs modules/asset/lib/example-ledger.json) || return
  typecheck_tree=$(tree_hash src "${navigation_inputs[@]}" tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts) || return
  test_tree=$(tree_hash modules scripts src public server tests tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html) || return
  build_tree=$(tree_hash src public "${navigation_inputs[@]}" tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html .env .env.local .env.production .env.production.local deploy/build-artifact-cache.py) || return
  runtime_tree=$(tree_hash server package.json deploy/migrate-modules.py deploy/diagnose-aster-margin.py) || return
  embedded_tree=$(tree_hash modules "${module_shared_inputs[@]}" scripts/modules.mjs deploy/build-artifact-cache.py deploy/package-release.py deploy/pnpm-runtime-lock.mjs deploy/migrate-modules.py deploy/diagnose-aster-margin.py .env .env.local .env.production .env.production.local) || return
  runtime_dependency_tree=$(tree_hash deploy/package-release.py deploy/pnpm-runtime-lock.mjs) || return
  # Recipes describe preparation semantics, independently of installer comments/docs.
  dependency_key=$(printf 'pnpm-workspace-dependencies-v1:frozen,include-dev,copy,prepare-ledger\n%s\n%s\n%s' "$dependency_tree" "$runtime_key" "$PNPM_VERSION" | hash)
  runtime_dependency_key=$(printf 'production-dependencies-v1:immutable,fixed-importers\n%s\n%s' "$dependency_key" "$runtime_dependency_tree" | hash)
  typecheck_key=$(printf 'typecheck-v3\n%s\n%s' "$typecheck_tree" "$dependency_key" | hash)
  test_key=$(printf 'tests-v2\n%s\n%s' "$test_tree" "$dependency_key" | hash)
  # Vite may inline build-time environment; keep those inputs out of runtime config.
  build_key=$(printf 'hub-build-v3\n%s\n%s\n%s' "$build_tree" "$dependency_key" "$build_environment" | hash)
  dependencies="$APP_DIR/cache/dependencies-$dependency_key"
  runtime_dependencies="$APP_DIR/cache/runtime-dependencies-$runtime_dependency_key"
  built="$APP_DIR/cache/build-$build_key"
  typecheck_stamp="$APP_DIR/cache/typechecked-$typecheck_key"
  test_stamp="$APP_DIR/cache/tested-$test_key"
  legacy_runner_blob=$(git --git-dir="$APP_DIR/repository.git" rev-parse "$commit:scripts/modules.mjs" 2>/dev/null) || legacy_runner_blob=
  for module in "${MODULE_BUILD_IDS[@]}"; do
    # ASTER serves a static dashboard. Its Python runtime is not a frontend input.
    if [[ "$module" == aster ]]; then
      module_inputs=(modules/aster/dashboard \
        modules/aster/.env modules/aster/.env.local modules/aster/.env.production modules/aster/.env.production.local)
    elif [[ "$module" == monitor || "$module" == crossex ]]; then
      module_inputs=("modules/$module" "${module_shared_inputs[@]}")
    else
      module_inputs=("modules/$module")
    fi
    module_inputs+=(deploy/build-artifact-cache.py .env .env.local .env.production .env.production.local)
    module_tree=$(tree_hash "${module_inputs[@]}") || return
    module_recipe=$(module_build_recipe "$module") || return
    module_build_recipes[$module]=$module_recipe
    module_build_keys[$module]=$(printf 'module-artifacts-v2\n%s\n%s\n%s\n%s\n%s' "$module" "$module_tree" "$dependency_key" "$build_environment" "$module_recipe" | hash)
    if [[ "$legacy_runner_blob" == "$LEGACY_MODULE_RUNNER_BLOB" && "$module_recipe" == "${LEGACY_MODULE_BUILD_RECIPES[$module]}" ]]; then
      legacy_tree=$(tree_hash "${module_inputs[@]}" scripts/modules.mjs) || return
      legacy_module_build_keys[$module]=$(printf 'module-artifacts-v1\n%s\n%s\n%s\n%s' "$module" "$legacy_tree" "$dependency_key" "$build_environment" | hash)
    fi
  done
  module_artifacts_key=$({ for module in "${MODULE_BUILD_IDS[@]}"; do printf '%s %s\n' "$module" "${module_build_keys[$module]}"; done; } | LC_ALL=C sort | hash)
  embedded_key=$(printf 'embedded-runtime-v4:direct-module-builds\n%s\n%s\n%s\n%s' "$embedded_tree" "$dependency_key" "$build_environment" "$module_artifacts_key" | hash)
  application_key=$(printf 'application-v5:immutable-production-links\n%s\n%s\n%s\n%s\n%s' "$runtime_tree" "$build_key" "$embedded_key" "$runtime_dependency_key" "$RUNTIME_DEPENDENCIES" | hash)
  embedded="$APP_DIR/cache/embedded-$embedded_key"
}
application_ready() {
  [[ -n "$old_release" && -f "$old_release/.install-ready" && -f "$old_release/.application-key" &&
     "$(cat "$old_release/.application-key")" == "$application_key" && -s "$old_release/dist/index.html" ]] || return 1
  source_runtime_dependencies_ready "$old_release" "$runtime_dependency_key" || return 1
  if (( RUNTIME_DEPENDENCIES )) && [[ ! -d "$old_release/modules" ]]; then
    [[ -f "$dependencies/.complete" && -d "$dependencies/node_modules" &&
       -L "$old_release/node_modules" && "$(readlink "$old_release/node_modules")" == "$dependencies/node_modules" ]] || return 1
  fi
  published_source_safe "$old_release"
}
runtime_dependency_cache_ready() {
  local cache=$1 key=$2 importer suffix
  updater_safe_path "$cache" || return 1
  [[ -d "$cache" && -f "$cache/.complete" ]] || return 1
  updater_safe_path "$cache/.complete" || return 1
  [[ "$(cat "$cache/.complete")" == "$key" ]] || return 1
  for importer in "${RUNTIME_DEPENDENCY_IMPORTERS[@]}"; do
    suffix=
    [[ "$importer" == . ]] || suffix="/$importer"
    [[ -d "$cache$suffix/node_modules" ]] || return 1
    updater_safe_path "$cache$suffix/node_modules" || return 1
  done
}
source_runtime_dependencies_ready() {
  local root=$1 expected=${2:-} marker="$1/.runtime-dependency-key" key cache importer suffix link
  # Small standalone installer fixtures have no embedded modules. Real module
  # releases must carry the new layout marker, including the early no-op path.
  [[ -e "$root/modules" || -L "$root/modules" || -e "$marker" || -L "$marker" ]] || return 0
  [[ -d "$root/modules" ]] || return 1
  updater_safe_path "$root/modules" || return 1
  [[ -f "$marker" ]] || return 1
  updater_safe_path "$marker" || return 1
  key=$(cat "$marker") || return 1
  [[ "$key" =~ ^[a-f0-9]{64}$ && ( -z "$expected" || "$key" == "$expected" ) ]] || return 1
  cache="$APP_DIR/cache/runtime-dependencies-$key"
  runtime_dependency_cache_ready "$cache" "$key" || return 1
  for importer in "${RUNTIME_DEPENDENCY_IMPORTERS[@]}"; do
    suffix=
    [[ "$importer" == . ]] || suffix="/$importer"
    link="$root$suffix/node_modules"
    updater_safe_path "${link%/*}" || return 1
    [[ -L "$link" && "$(readlink "$link")" == "$cache$suffix/node_modules" ]] || return 1
  done
}
source_fetch_retryable() {
  local transcript=$1
  # A transport-looking suffix (for example early EOF) must not hide a
  # permanent permission, certificate, missing-ref, rate-limit or disk error.
  if grep -Eiq 'authentication failed|could not read (Username|Password)|terminal prompts disabled|permission denied|repository .*not found|not our ref|couldn.t find remote ref|unadvertised object|requested URL returned error: (400|401|403|404|410|429)|SSL certificate|certificate verification|certificate problem|server certificate verification|no space left|disk quota exceeded|read-only file system|unable to create|cannot create|could not write|unable to write|error writing|out of memory|cannot allocate memory' "$transcript"; then
    return 1
  fi
  grep -Eiq 'RPC failed; curl (5|6|7|18|28|35|52|55|56|92)([ ;:]|$)|could not resolve (host|proxy)|failed to connect|couldn.t connect|connection (reset|timed out|closed|refused)|recv failure|send failure|unexpected disconnect|early EOF|remote end hung up|TLS connection was non-properly terminated|operation (timed out|too slow)|timeout was reached|requested URL returned error: (408|500|502|503|504)' "$transcript"
}
fetch_source() {
  local repository="$APP_DIR/repository.git" reference attempt transcript status delay
  local -a options pipeline_status
  [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || { log '错误：源码版本必须是固定的完整提交号。' >&2; return 1; }
  reference="refs/project-aggregation/source/$commit"
  updater_safe_path "$repository" || return
  if [[ ! -d "$repository" ]]; then git init --bare -q "$repository" || return; fi
  if git --git-dir="$repository" cat-file -e "$commit^{commit}" 2>/dev/null; then
    # Retain objects fetched by older installers too; FETCH_HEAD alone is
    # overwritten on the next update and is not a durable cache reference.
    git --git-dir="$repository" update-ref "$reference" "$commit" || return
    log '源码已缓存，跳过下载。'
    return 0
  fi
  for attempt in 1 2 3; do
    ci_update_progress download
    transcript="$work_dir/source-fetch-$attempt.log"
    # This is a stall guard, not a total transfer deadline. Do not interrupt
    # a slow connection that is still making progress or change global config.
    options=(-c http.lowSpeedLimit=1 -c http.lowSpeedTime=60)
    if (( attempt > 1 )); then options+=(-c http.version=HTTP/1.1); fi
    log "获取固定版本 ${commit:0:12} 的源码（第 $attempt/3 次）；显示 Git 接收进度。"
    if LC_ALL=C GIT_TERMINAL_PROMPT=0 git "${options[@]}" --git-dir="$repository" \
        fetch --depth=1 --no-tags --progress "$REPOSITORY" "$commit:$reference" 2>&1 | tee "$transcript" | ci_source_progress; then
      if ! git --git-dir="$repository" cat-file -e "$commit^{commit}" 2>/dev/null; then
        log '错误：Git 获取完成但缺少所选提交，停止更新。' >&2
        return 1
      fi
      log "源码已获取并核对提交 ${commit:0:12}。"
      return 0
    else
      pipeline_status=("${PIPESTATUS[@]}")
      status=${pipeline_status[0]}
    fi
    # Preserve the actual Git/signal status; an output/log failure is not a
    # retryable network error, even if its partial transcript looks like one.
    case "$status" in 130|141|143) return "$status" ;; esac
    if (( pipeline_status[1] != 0 )); then return "${pipeline_status[1]}"; fi
    if (( pipeline_status[2] != 0 )); then return "${pipeline_status[2]}"; fi
    if (( attempt == 3 )) || ! source_fetch_retryable "$transcript"; then
      log "错误：源码获取失败（退出码 $status）；尚未进入构建或服务切换，保留已有缓存。" >&2
      return "$status"
    fi
    delay=$((attempt * 2))
    ci_update_progress download '' source-retry
    log "源码连接暂时中断，${delay} 秒后使用 HTTP/1.1 重试同一提交；已有缓存保留。"
    sleep "$delay" || return
  done
}
prepare_source() {
  [[ ! -d "$work_dir/source" ]] || return 0
  ci_update_progress extract
  mkdir "$work_dir/source"
  git --git-dir="$APP_DIR/repository.git" archive "$commit" | tar -x -C "$work_dir/source"
  chmod 0755 "$work_dir"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$work_dir/source"
}
prepare_dependencies() {
  if [[ -f "$dependencies/.complete" && -d "$dependencies/node_modules" && "$(cat "$dependencies/.complete")" == "$dependency_key" ]]; then
    updater_safe_path "$dependencies/.complete"
    log '依赖与运行环境未变化，复用 root 只读依赖缓存。'
    return
  fi
  [[ ! -e "$dependencies" ]] || fail '依赖缓存目录不完整，请检查后重试。'
  ci_update_progress prepare '' dependencies
  log '依赖内容或运行环境变化，安装依赖。'
  local staging="$work_dir/dependencies"
  mkdir "$staging"
  local name
  for name in package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc scripts/install-hooks.mjs \
    modules/monitor/package.json modules/asset/package.json modules/crossex/package.json modules/aster/dashboard/package.json \
    modules/monitor/.npmrc modules/asset/.npmrc modules/crossex/.npmrc modules/aster/dashboard/.npmrc \
    modules/asset/scripts/prepare-ledger.mjs modules/asset/lib/example-ledger.json; do
    git --git-dir="$APP_DIR/repository.git" cat-file -e "$commit:$name" 2>/dev/null || continue
    mkdir -p "$(dirname "$staging/$name")"
    git --git-dir="$APP_DIR/repository.git" show "$commit:$name" > "$staging/$name"
  done
  [[ -f "$staging/package.json" && -f "$staging/pnpm-lock.yaml" && -f "$staging/pnpm-workspace.yaml" ]] || fail '固定源码缺少 pnpm 工作区安装输入。'
  chmod 0755 "$work_dir"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$staging"
  (cd "$staging" && run_as_service env NODE_ENV=development CI=true "$NODE_BIN" "$PNPM_BIN" install --frozen-lockfile --prod=false --package-import-method=copy --store-dir "$APP_DIR/build-home/pnpm-store")
  [[ -d "$staging/node_modules" ]] || fail '依赖安装未生成 node_modules。'
  local importer
  for importer in modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
    [[ ! -f "$staging/$importer/package.json" || -d "$staging/$importer/node_modules" ]] || fail "依赖安装缺少工作区 importer：$importer"
  done
  # Freeze once. Neither the running service nor later tests/builds can edit packages.
  chown -R root:root "$staging"
  chmod -R go-w "$staging"
  atomic_record "$staging/.complete" "$dependency_key"
  mv -- "$staging" "$dependencies"
}
prepare_workspace() {
  prepare_source
  prepare_dependencies
  local importer entry name modules
  # Every importer needs its own writable shell for Vite and other build caches.
  # Link each entry to the matching frozen importer so pnpm's relative package
  # links keep resolving through the cache's single virtual store.
  for importer in . modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
    [[ -d "$dependencies/$importer/node_modules" ]] || continue
    modules="$work_dir/source/$importer/node_modules"
    [[ ! -d "$modules" ]] || continue
    mkdir -p "$modules"
    for entry in "$dependencies/$importer/node_modules/"* "$dependencies/$importer/node_modules/".[!.]*; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      name=${entry##*/}
      case "$name" in .vite|.vite-temp|.cache) continue ;; esac
      ln -s "$entry" "$modules/$name"
    done
    chown "$SERVICE_USER:$SERVICE_USER" "$modules"
  done
}
prepare_runtime_dependencies() {
  if runtime_dependency_cache_ready "$runtime_dependencies" "$runtime_dependency_key"; then
    log '生产依赖与组装规则未变化，复用独立只读缓存。'
    return
  fi
  [[ ! -e "$runtime_dependencies" && ! -L "$runtime_dependencies" ]] || fail '生产依赖缓存不完整，请检查后重试。'
  prepare_dependencies
  ci_update_progress prepare '' runtime
  log '生产依赖或组装规则变化，准备独立只读缓存。'
  local trusted="$work_dir/trusted-dependencies" staged="$work_dir/runtime-dependencies" name
  # The lock parser runs as the service account and must traverse this private
  # root-owned staging parent without gaining any write access to it.
  chmod 0755 "$work_dir"
  mkdir "$trusted"
  for name in package.json pnpm-lock.yaml pnpm-workspace.yaml modules/monitor/package.json \
      modules/asset/package.json modules/crossex/package.json deploy/package-release.py deploy/pnpm-runtime-lock.mjs; do
    mkdir -p "$trusted/$(dirname "$name")"
    git --git-dir="$APP_DIR/repository.git" show "$commit:$name" > "$trusted/$name"
  done
  python3 -I "$trusted/deploy/package-release.py" --source "$trusted" --dependency-root "$dependencies" \
    --node "$NODE_BIN" --parser-user "$SERVICE_USER" --stage-only "$staged" --dependencies-only
  chown -R root:root "$staged"
  chmod -R a+rX,go-w "$staged"
  atomic_record "$staged/.complete" "$runtime_dependency_key"
  runtime_dependency_cache_ready "$staged" "$runtime_dependency_key" || fail '生产依赖缓存缺少必要目录。'
  mv -- "$staged" "$runtime_dependencies"
}
prepare_build_cache_helper() {
  [[ ! -f "$work_dir/build-artifact-cache.py" ]] || return 0
  # The helper executes as root, so never read it from the build account's tree.
  git --git-dir="$APP_DIR/repository.git" show "$commit:deploy/build-artifact-cache.py" > "$work_dir/build-artifact-cache.py"
  chmod 0644 "$work_dir/build-artifact-cache.py"
}
build_artifact_cache() {
  python3 -I "$work_dir/build-artifact-cache.py" "$@"
}
artifact_cache_ready() {
  updater_safe_path "$1" || return 1
  [[ -d "$1" ]] || return 1
  build_artifact_cache verify "$1" "$2"
}
migrate_module_build_cache() {
  local module=$1 legacy_key=${legacy_module_build_keys[$1]:-} key=${module_build_keys[$1]} recipe
  local old_cache cache stage artifact
  [[ -n "$legacy_key" ]] || return 1
  recipe=$(module_build_recipe "$module") || return
  [[ "$recipe" == "${LEGACY_MODULE_BUILD_RECIPES[$module]}" && "$recipe" == "${module_build_recipes[$module]}" ]] || return 1
  old_cache="$APP_DIR/cache/module-$module-$legacy_key"
  cache="$APP_DIR/cache/module-$module-$key"
  artifact_cache_ready "$old_cache" "$legacy_key" || return 1
  updater_safe_path "$work_dir" || return 1
  stage=$(mktemp -d "$work_dir/module-cache-migration-$module.XXXXXXXX") || return
  artifact="$stage/${MODULE_BUILD_OUTPUTS[$module]##*/}"
  # Re-key only fully verified bytes through a private root-owned tree. The
  # old cache remains available to the previous installer and rollback.
  if ! build_artifact_cache restore "$old_cache" "$legacy_key" "$artifact" ||
      ! build_artifact_cache store "$artifact" "$cache" "$key"; then
    rm -rf -- "$stage"
    return 1
  fi
  chown -R root:root "$cache" || return
  chmod -R a+rX,go-w "$cache" || return
  rm -rf -- "$stage" || return
  log "$module 已完整校验并迁移旧构建缓存，跳过编译。"
}
prepare_module_builds() {
  local mode=${1:-hydrate} required=2 module key cache artifact
  case "$mode" in
    cache-only) required=1 ;;
    hydrate) ;;
    *) fail "未知模块产物准备模式：$mode"; return 1 ;;
  esac
  (( modules_prepared < required )) || return 0
  for module in "${MODULE_BUILD_IDS[@]}"; do
    validate_module_build_source "$module" || return
    key=${module_build_keys[$module]}
    cache="$APP_DIR/cache/module-$module-$key"
    artifact="$work_dir/source/${MODULE_BUILD_OUTPUTS[$module]}"
    updater_safe_path "$cache"
    if artifact_cache_ready "$cache" "$key" || migrate_module_build_cache "$module"; then
      log "$module 构建输入未变化，校验并复用模块产物。"
      if [[ "$mode" == hydrate && ${module_outputs_prepared[$module]:-} != "$key:$artifact" ]]; then
        prepare_workspace
        # Only tests need these copies. Restore writable build-tree outputs
        # as the build account; privileged copies target root-owned trees.
        run_as_service /usr/bin/python3 -I "$work_dir/build-artifact-cache.py" restore "$cache" "$key" "$artifact"
        module_outputs_prepared[$module]="$key:$artifact"
      fi
    else
      prepare_workspace
      ci_update_progress build '' "build-$module"
      log "$module 构建输入变化或缓存不完整，仅构建该模块。"
      run_module_build "$module"
      [[ -s "$artifact/${MODULE_BUILD_ENTRIES[$module]}" ]] || fail "$module 构建缺少必要入口。"
      build_artifact_cache store "$artifact" "$cache" "$key"
      chown -R root:root "$cache"
      chmod -R a+rX,go-w "$cache"
      module_outputs_prepared[$module]="$key:$artifact"
    fi
  done
  modules_prepared=$required
}
prepare_embedded_runtime() {
  prepare_module_builds cache-only
  ci_update_progress prepare '' runtime
  # Re-extract executable sources and packaging helpers from the pinned Git
  # object. Only the declared, fully verified build outputs come from caches.
  mkdir "$work_dir/trusted-runtime"
  git --git-dir="$APP_DIR/repository.git" archive "$commit" server modules package.json pnpm-lock.yaml pnpm-workspace.yaml deploy/package-release.py deploy/pnpm-runtime-lock.mjs deploy/migrate-modules.py | tar -x -C "$work_dir/trusted-runtime"
  # Older selected revisions remain installable with their own packaging code.
  if git --git-dir="$APP_DIR/repository.git" cat-file -e "$commit:deploy/diagnose-aster-margin.py" 2>/dev/null; then
    git --git-dir="$APP_DIR/repository.git" archive "$commit" deploy/diagnose-aster-margin.py | tar -x -C "$work_dir/trusted-runtime"
  fi
  local module key
  for module in "${MODULE_BUILD_IDS[@]}"; do
    key=${module_build_keys[$module]}
    build_artifact_cache restore "$APP_DIR/cache/module-$module-$key" "$key" "$work_dir/trusted-runtime/${MODULE_BUILD_OUTPUTS[$module]}"
  done
  python3 -I "$work_dir/trusted-runtime/deploy/package-release.py" --source "$work_dir/trusted-runtime" --node "$NODE_BIN" --parser-user "$SERVICE_USER" --stage-only "$work_dir/embedded-runtime" --embedded-only
  mkdir "$work_dir/embedded-cache"
  mv "$work_dir/embedded-runtime/modules" "$work_dir/embedded-runtime/deploy" "$work_dir/embedded-cache/"
  chown -R root:root "$work_dir/embedded-cache"
  chmod -R a+rX,go-w "$work_dir/embedded-cache"
  atomic_record "$work_dir/embedded-cache/.complete" "$embedded_key"
  mv -- "$work_dir/embedded-cache" "$embedded"
}
prepare_application() {
  local reuse=0 need_build=0 need_embedded=0 has_modules=0
  if application_ready; then reuse=1; fi
  prepare_build_cache_helper
  if git --git-dir="$APP_DIR/repository.git" cat-file -e "$commit:modules" 2>/dev/null; then has_modules=1; fi
  if (( ! reuse )); then
    if ! artifact_cache_ready "$built" "$build_key"; then need_build=1; fi
    if (( has_modules )); then
      updater_safe_path "$embedded"
      if [[ ! -f "$embedded/.complete" || "$(cat "$embedded/.complete")" != "$embedded_key" || ! -d "$embedded/modules" ]]; then
        [[ ! -e "$embedded" ]] || fail '内置模块运行缓存不完整，请检查后重试。'
        need_embedded=1
      fi
    fi
  fi
  if [[ ! -f "$typecheck_stamp" || ( "$PROJECT_DEPLOY_TESTS" == 1 && ! -f "$test_stamp" ) ]] || (( need_build )); then prepare_workspace; fi
  if [[ "$PROJECT_DEPLOY_TESTS" == 1 && ! -f "$test_stamp" ]] && (( has_modules )); then
    prepare_module_builds
    prepare_source_greeks_runtime
    prepare_source_aster_runtime
  fi
  if [[ ! -f "$typecheck_stamp" ]]; then
    ci_update_progress verify '' typecheck
    log '类型检查输入变化，执行一次类型检查。'
    (cd "$work_dir/source" && run_as_service "$NODE_BIN" "$PNPM_BIN" run check)
    atomic_record "$typecheck_stamp" "$typecheck_key"
  else log '类型检查输入未变化，复用验证结果。'; fi
  if [[ "$PROJECT_DEPLOY_TESTS" == 0 ]]; then
    log '跳过完整行为测试；CI 继续验证，设置 PROJECT_DEPLOY_TESTS=1 可在部署时补测。'
  elif [[ ! -f "$test_stamp" ]]; then
    ci_update_progress verify '' tests
    log '测试或相关源码变化，在隔离目录执行行为测试。'
    (cd "$work_dir/source" && run_as_service env GREEKS_PYTHON="$GREEKS_PYTHON_PATH" ASTER_PYTHON="$ASTER_PYTHON_PATH" "$NODE_BIN" "$PNPM_BIN" test)
    atomic_record "$test_stamp" "$test_key"
  else log '行为测试输入未变化，复用验证结果。'; fi
  if (( need_build )); then
    ci_update_progress build '' build-workbench
    log '工作台前端内容或运行环境变化，仅构建工作台页面。'
    (cd "$work_dir/source" && run_as_service env NODE_ENV=production "$NODE_BIN" "$PNPM_BIN" run build:bundle)
    [[ -s "$work_dir/source/dist/index.html" ]] || fail '构建缺少 dist/index.html。'
    build_artifact_cache store "$work_dir/source/dist" "$built" "$build_key"
    chown -R root:root "$built"
    chmod -R a+rX,go-w "$built"
  else log '工作台前端未变化，复用页面产物。'; fi
  if (( need_embedded )); then prepare_embedded_runtime
  elif (( has_modules )); then log '内置模块运行内容未变化，复用组装结果。'; fi
  if (( has_modules )); then prepare_runtime_dependencies; fi
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
    source_runtime_dependencies_ready "$release" "$runtime_dependency_key" || fail '候选版本生产依赖链接不完整或不可信。'
    if (( RUNTIME_DEPENDENCIES && ! has_modules )); then
      prepare_dependencies
      [[ -L "$release/node_modules" && "$(readlink "$release/node_modules")" == "$dependencies/node_modules" ]] || fail '候选版本依赖链接不正确。'
    fi
    published_source_safe "$release" || return 1
    return
  fi
  mkdir "$work_dir/publish"
  ci_update_progress extract
  # Re-extract runtime source as root; tests/builds cannot modify published code.
  git --git-dir="$APP_DIR/repository.git" archive "$commit" server package.json | tar -x -C "$work_dir/publish"
  build_artifact_cache restore "$built" "$build_key" "$work_dir/publish/dist"
  if (( has_modules )); then
    cp -a --reflink=auto "$embedded/modules" "$embedded/deploy" "$work_dir/publish/"
    local importer suffix
    for importer in "${RUNTIME_DEPENDENCY_IMPORTERS[@]}"; do
      suffix=
      [[ "$importer" == . ]] || suffix="/$importer"
      ln -s "$runtime_dependencies$suffix/node_modules" "$work_dir/publish$suffix/node_modules"
    done
    atomic_record "$work_dir/publish/.runtime-dependency-key" "$runtime_dependency_key"
  fi
  if (( RUNTIME_DEPENDENCIES && ! has_modules )); then
    prepare_dependencies
    ln -s "$dependencies/node_modules" "$work_dir/publish/node_modules"
  fi
  atomic_record "$work_dir/publish/.managed-release" "$commit"
  atomic_record "$work_dir/publish/.source-sha" "$commit"
  atomic_record "$work_dir/publish/.application-key" "$application_key"
  # Root tar preserves Git archive's group-write bits despite the process umask.
  # Only normalize this freshly assembled tree from the pinned Git object and
  # verified caches; an existing writable release must never regain trust here.
  chown -hR root:root "$work_dir/publish"
  chmod -R a+rX,go-w "$work_dir/publish"
  source_runtime_dependencies_ready "$work_dir/publish" "$runtime_dependency_key" || fail '新版本生产依赖链接不完整或不可信。'
  published_source_safe "$work_dir/publish"
  mv -- "$work_dir/publish" "$release"
}
prepare_ci_application() {
  application_key=$CI_RELEASE_APPLICATION_KEY
  if [[ -n "$old_release" && -f "$old_release/.install-ready" && -f "$old_release/.ci-package-sha256" &&
        -f "$old_release/.application-key" && "$(cat "$old_release/.application-key")" == "$application_key" &&
        -s "$old_release/dist/index.html" && -f "$old_release/server/app.mjs" ]]; then
    if (( ! RUNTIME_DEPENDENCIES )) || [[ -f "$old_release/node_modules/ws/package.json" && -f "$old_release/node_modules/decimal.js/package.json" ]]; then
      published_source_safe "$old_release" || return 1
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
    published_source_safe "$release" || return 1
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
  log 'CI 部署包准备完成；服务器跳过 pnpm 安装、类型检查、测试及前端构建。'
}

# Every helper path is a fixed installer constant, never a client/environment input.
# Root-owned sticky ancestors allow isolated /tmp fixtures without allowing their
# children to be replaced by another user. No symlink is followed, including parents.
updater_safe_path() {
  local path=$1 cursor=$1 mode owner
  [[ "$path" =~ ^/[A-Za-z0-9_./-]+$ && "$path" != / && "$path" != *'/../'* && "$path" != */.. &&
     "$path" != *'/./'* && "$path" != */. && "$path" != *'//'* ]] || { fail "更新服务路径无效：$path"; return 1; }
  while [[ "$cursor" != / ]]; do
    [[ ! -L "$cursor" ]] || { fail "更新服务路径不能包含符号链接：$cursor"; return 1; }
    if [[ -e "$cursor" ]]; then
      owner=$(stat -c %u "$cursor") || return 1
      mode=$(stat -c %a "$cursor") || return 1
      [[ "$owner" == 0 ]] || { fail "更新服务路径必须由 root 拥有：$cursor"; return 1; }
      if (( (8#$mode & 0022) != 0 )); then
        [[ "$cursor" != "$path" && -d "$cursor" ]] && (( (8#$mode & 01000) != 0 )) || {
          fail "更新服务路径不能允许其他用户写入：$cursor"; return 1;
        }
      fi
    fi
    cursor=${cursor%/*}
    [[ -n "$cursor" ]] || cursor=/
  done
}
published_source_safe() {
  local directory=$1 path
  [[ -d "$directory/server" && -f "$directory/package.json" && -f "$directory/.managed-release" &&
     -f "$directory/.source-sha" && -f "$directory/.application-key" ]] || {
    fail '发布目录缺少受信运行源码或标记。'; return 1;
  }
  for path in "$directory" "$directory/server" "$directory/package.json" \
      "$directory/.managed-release" "$directory/.source-sha" "$directory/.application-key" "$directory/.install-ready"; do
    updater_safe_path "$path" || return 1
  done
  # Only these sources will be copied into the privileged updater. Existing
  # candidates are checked, never repaired or chmodded into trusted input.
  path="$directory/server/update-service"
  [[ -e "$path" || -L "$path" ]] || return 0
  updater_safe_path "$path" || return 1
  [[ -d "$path" ]] || { fail '发布包中的在线更新服务目录无效。'; return 1; }
  for path in "$path/"*.py; do
    [[ -e "$path" || -L "$path" ]] || continue
    updater_safe_path "$path" || return 1
    [[ -f "$path" ]] || { fail '发布包中的在线更新服务文件无效。'; return 1; }
  done
}
updater_managed_directory() {
  local directory=$1
  updater_safe_path "$directory" || return 1
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && -f "$directory/.managed-install" && ! -L "$directory/.managed-install" ]] || {
      fail "更新服务目录已存在且不属于本安装器：$directory"; return 1;
    }
    updater_safe_path "$directory/.managed-install" || return 1
    [[ $(cat "$directory/.managed-install") == project-aggregation-updater-v1 ]] || {
      fail "更新服务目录的管理标记不匹配：$directory"; return 1;
    }
  fi
}
updater_managed_unit() {
  local unit=$1 name=$2 fragment dropins
  updater_safe_path "$unit" || return 1
  if [[ -e "$unit" ]]; then
    [[ -f "$unit" ]] && grep -qx '# Managed by project-aggregation updater installer' "$unit" || {
      fail "同名更新服务已存在且不属于本安装器：$unit"; return 1;
    }
  fi
  fragment=$(systemctl show --property=FragmentPath --value "$name" 2>/dev/null) || return 1
  dropins=$(systemctl show --property=DropInPaths --value "$name" 2>/dev/null) || return 1
  [[ -z "$fragment" || ( "$fragment" == "$unit" && -f "$unit" ) ]] || {
    fail "同名更新服务来自其他位置，已停止覆盖：$name"; return 1;
  }
  [[ -z "$dropins" ]] || { fail "更新服务存在额外覆盖配置，已停止覆盖：$name"; return 1; }
}
write_updater_units() {
  cat > "$work_dir/updater.service" <<EOF || return 1
# Managed by project-aggregation updater installer
[Unit]
Description=Project Aggregation stable update control
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=$SERVICE_USER
ExecStart=/usr/bin/python3 -I $UPDATER_DIR/updater.py serve
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RuntimeDirectory=project-aggregation-updater
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
ReadWritePaths=$UPDATER_STATE_DIR $UPDATER_RUN_DIR

[Install]
WantedBy=multi-user.target
EOF
  cat > "$work_dir/updater-worker.service" <<EOF
# Managed by project-aggregation updater installer
[Unit]
Description=Project Aggregation stable update worker
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
Group=root
ExecStart=/usr/bin/python3 -I $UPDATER_DIR/updater.py run
TimeoutStartSec=infinity
UMask=0077
PrivateTmp=true
EOF
}
ensure_update_service() {
  local source_release=$1 source file name directory mode temporary fingerprint unit_changed=0 code_changed=0 existing=0
  source="$source_release/server/update-service"
  if [[ ! -e "$source" && ! -L "$source" ]]; then
    log '当前发布包尚未包含在线更新服务，跳过注册。'
    return 0
  fi
  updater_safe_path "$source" || return 1
  [[ -d "$source" ]] || { fail '发布包中的在线更新服务目录无效。'; return 1; }
  [[ -f "$source_release/.managed-release" ]] || { fail '在线更新服务必须来自已验证的发布目录。'; return 1; }
  updater_safe_path "$source_release/.managed-release" || return 1
  for name in updater.py registry.py releases.py progress.py; do
    [[ -s "$source/$name" && -f "$source/$name" ]] || { fail "发布包缺少在线更新文件：$name"; return 1; }
  done
  local -a files=()
  for file in "$source/"*.py; do
    name=${file##*/}
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*\.py$ && -f "$file" ]] || { fail '在线更新服务包含无效程序文件。'; return 1; }
    updater_safe_path "$file" || return 1
    files+=("$file")
  done
  updater_managed_directory "$UPDATER_DIR" || return 1
  updater_managed_directory "$UPDATER_STATE_DIR" || return 1
  updater_safe_path "$UPDATER_DIR/.service-ready" || return 1
  [[ ! -e "$UPDATER_DIR/.service-ready" || -f "$UPDATER_DIR/.service-ready" ]] || { fail '更新服务完成记录不是普通文件。'; return 1; }
  [[ ! -d "$UPDATER_DIR" ]] || existing=1
  updater_safe_path "$UPDATER_RUN_DIR" || return 1
  if [[ -e "$UPDATER_RUN_DIR" ]]; then
    [[ -d "$UPDATER_RUN_DIR" ]] || { fail '在线更新运行目录不是普通目录。'; return 1; }
    # systemd recreates /run after a reboot. An existing managed installation may
    # have only its own socket here; a first install must not claim another path.
    (( existing )) || { fail "在线更新运行目录已存在：$UPDATER_RUN_DIR"; return 1; }
    for file in "$UPDATER_RUN_DIR/"* "$UPDATER_RUN_DIR/".[!.]*; do
      [[ -e "$file" || -L "$file" ]] || continue
      [[ "${file##*/}" == control.sock && -S "$file" && ! -L "$file" && $(stat -c %u "$file") == 0 ]] || {
        fail "在线更新运行目录包含未知文件：$file"; return 1;
      }
    done
  fi
  updater_managed_unit "$UPDATER_UNIT_FILE" "$UPDATER_SERVICE" || return 1
  updater_managed_unit "$UPDATER_WORKER_UNIT_FILE" "$UPDATER_WORKER_SERVICE" || return 1
  for file in "${files[@]}"; do
    name=${file##*/}
    updater_safe_path "$UPDATER_DIR/$name" || return 1
    [[ ! -e "$UPDATER_DIR/$name" || -f "$UPDATER_DIR/$name" ]] || { fail "更新程序目标不是普通文件：$name"; return 1; }
    if ! cmp -s "$file" "$UPDATER_DIR/$name"; then code_changed=1; fi
  done
  [[ -x /usr/bin/python3 ]] || { fail '在线更新服务需要 /usr/bin/python3。'; return 1; }
  if (( code_changed )); then
    /usr/bin/python3 -I - "${files[@]}" <<'UPDATER_CHECK_PY' || return 1
from pathlib import Path
import sys
for name in sys.argv[1:]:
    compile(Path(name).read_bytes(), name, 'exec')
UPDATER_CHECK_PY
  fi
  write_updater_units || return 1
  fingerprint=$(sha256sum "${files[@]}" "$work_dir/updater.service" "$work_dir/updater-worker.service" | sed 's|  .*/|  |' | hash) || return 1
  # A previous attempt may have copied files before service activation failed.
  # Its missing/stale receipt forces reconciliation instead of claiming a no-op.
  if [[ ! -f "$UPDATER_DIR/.service-ready" || $(cat "$UPDATER_DIR/.service-ready") != "$fingerprint" ]]; then
    code_changed=1
    unit_changed=1
  fi
  for directory in "$UPDATER_DIR" "$UPDATER_STATE_DIR"; do
    mode=0755
    [[ "$directory" != "$UPDATER_STATE_DIR" ]] || mode=0700
    install -d -m "$mode" -o root -g root "$directory" || return 1
    if [[ ! -e "$directory/.managed-install" ]]; then
      printf 'project-aggregation-updater-v1\n' > "$directory/.managed-install" || return 1
      chmod 0600 "$directory/.managed-install" || return 1
    fi
  done
  install -d -m 0750 -o root -g "$SERVICE_USER" "$UPDATER_RUN_DIR" || return 1
  for file in "${files[@]}"; do
    name=${file##*/}
    if ! cmp -s "$file" "$UPDATER_DIR/$name"; then
      temporary=$(mktemp "$UPDATER_DIR/.incoming.XXXXXXXX") || return 1
      if ! install -m 0644 -o root -g root "$file" "$temporary" || ! mv -f -- "$temporary" "$UPDATER_DIR/$name"; then
        rm -f -- "$temporary"
        return 1
      fi
    fi
  done
  if ! cmp -s "$work_dir/updater.service" "$UPDATER_UNIT_FILE"; then
    install -m 0644 -o root -g root "$work_dir/updater.service" "$UPDATER_UNIT_FILE" || return 1
    unit_changed=1
  fi
  if ! cmp -s "$work_dir/updater-worker.service" "$UPDATER_WORKER_UNIT_FILE"; then
    install -m 0644 -o root -g root "$work_dir/updater-worker.service" "$UPDATER_WORKER_UNIT_FILE" || return 1
    unit_changed=1
  fi
  if (( unit_changed )); then systemctl daemon-reload || return 1; fi
  if ! systemctl is-enabled --quiet "$UPDATER_SERVICE"; then systemctl enable "$UPDATER_SERVICE" >/dev/null || return 1; fi
  if systemctl is-active --quiet "$UPDATER_SERVICE"; then
    if (( code_changed || unit_changed )); then systemctl restart "$UPDATER_SERVICE" || return 1; fi
  else
    systemctl start "$UPDATER_SERVICE" || return 1
  fi
  systemctl is-active --quiet "$UPDATER_SERVICE" || { fail '在线更新服务未能启动，工作台已安装的健康版本保持运行。'; return 1; }
  if [[ ! -f "$UPDATER_DIR/.service-ready" || $(cat "$UPDATER_DIR/.service-ready") != "$fingerprint" ]]; then
    temporary=$(mktemp "$UPDATER_DIR/.ready.XXXXXXXX") || return 1
    if ! printf '%s\n' "$fingerprint" > "$temporary" || ! chmod 0600 "$temporary" || ! mv -f -- "$temporary" "$UPDATER_DIR/.service-ready"; then
      rm -f -- "$temporary"
      return 1
    fi
  fi
  if (( code_changed || unit_changed )); then
    log '在线更新服务已更新；执行任务服务保持独立，未停止或重启正在执行的更新。'
  else
    log '在线更新服务内容未变化，跳过复制、服务配置重载和重启；已确认控制服务运行。'
  fi
}
finish_update_service() {
  ci_update_progress finalize '' updater
  if ! ensure_update_service "$1"; then
    fail '工作台已健康运行，但在线更新服务安装未完成；请修复以上错误后重新执行安装命令。'
    return 1
  fi
}

validate_embedded_runtime() {
  local root=$1 file
  for file in modules/monitor/dist/client/index.html modules/asset/.next/BUILD_ID modules/crossex/dist/index.html modules/greeks/requirements.lock server/modules/greeks-bridge.py modules/aster/requirements.lock modules/aster/dashboard/dist/client/index.html server/modules/aster.mjs server/modules/python-module.mjs deploy/migrate-modules.py; do
    [[ -s "$root/$file" ]] || { fail "统一部署包缺少模块文件：$file"; return 1; }
  done
}
prepare_source_greeks_runtime() {
  local trusted_root="$work_dir/python-lock" lockfile="$work_dir/python-lock/modules/greeks/requirements.lock"
  [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || { fail 'Greeks 依赖需要固定提交。'; return 1; }
  updater_safe_path "$APP_DIR/repository.git" || return 1
  updater_safe_path "$lockfile" || return 1
  mkdir -p "$trusted_root/modules/greeks"
  # Never use or freeze a lockfile from the service-owned test/build workspace.
  # Retrieve its bytes independently from the already-pinned repository object.
  git --git-dir="$APP_DIR/repository.git" show "$commit:modules/greeks/requirements.lock" > "$lockfile" || return 1
  chmod 0600 "$lockfile"
  prepare_greeks_runtime "$trusted_root"
}
prepare_greeks_runtime() {
  local root=$1 fingerprint runtime lockfile="$1/modules/greeks/requirements.lock"
  # Both source-mode testing and CI activation share this privileged boundary.
  # A protected leaf under a service-writable ancestor is still untrusted.
  updater_safe_path "$lockfile" || return 1
  [[ -s "$lockfile" && -f "$lockfile" ]] || { fail '缺少可信 Greeks 依赖锁文件。'; return 1; }
  updater_safe_path "$APP_DIR/python" || return 1
  fingerprint=$({ cat "$lockfile"; /usr/bin/python3 -VV; uname -m; } | hash)
  runtime="$APP_DIR/python/$fingerprint"
  updater_safe_path "$runtime" || return 1
  if [[ -x "$runtime/bin/python" && -f "$runtime/.complete" && "$(cat "$runtime/.complete")" == "$fingerprint" ]]; then
    GREEKS_PYTHON_PATH="$runtime/bin/python"
    log 'Greeks 依赖与 Python 环境未变化，复用已验证虚拟环境。'
    return
  fi
  if [[ -d "$runtime" && ! -L "$runtime" && -f "$runtime/.building" && "$(cat "$runtime/.building")" == "$fingerprint" ]]; then
    [[ "$(realpath -e "$runtime")" == "$APP_DIR/python/$fingerprint" ]] || return 1
    rm -rf -- "$runtime"
  fi
  [[ ! -e "$runtime" ]] || { fail "Greeks 虚拟环境不完整：$runtime"; return 1; }
  ci_update_progress prepare
  mkdir -p "$APP_DIR/python"
  mkdir "$runtime"
  atomic_record "$runtime/.building" "$fingerprint"
  # Build at its final path: Python's scripts contain the absolute venv location.
  /usr/bin/python3 -m venv "$runtime"
  "$runtime/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$lockfile"
  "$runtime/bin/python" -c 'import fastapi, httpx, pydantic_settings'
  chmod -R a+rX,go-w "$runtime"
  atomic_record "$runtime/.complete" "$fingerprint"
  rm -f -- "$runtime/.building"
  GREEKS_PYTHON_PATH="$runtime/bin/python"
  log 'Greeks Python 依赖已按锁定版本安装并验证。'
}
prepare_source_aster_runtime() {
  local trusted_root="$work_dir/python-lock" lockfile="$work_dir/python-lock/modules/aster/requirements.lock"
  [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || { fail 'ASTER 依赖需要固定提交。'; return 1; }
  updater_safe_path "$APP_DIR/repository.git" || return 1
  updater_safe_path "$lockfile" || return 1
  mkdir -p "$trusted_root/modules/aster"
  # Never use or freeze a lockfile from the service-owned test/build workspace.
  # Retrieve its bytes independently from the already-pinned repository object.
  git --git-dir="$APP_DIR/repository.git" show "$commit:modules/aster/requirements.lock" > "$lockfile" || return 1
  chmod 0600 "$lockfile"
  prepare_aster_runtime "$trusted_root"
}
prepare_aster_runtime() {
  local root=$1 fingerprint runtime lockfile="$1/modules/aster/requirements.lock"
  # Both source-mode testing and CI activation share this privileged boundary.
  # A protected leaf under a service-writable ancestor is still untrusted.
  updater_safe_path "$lockfile" || return 1
  [[ -s "$lockfile" && -f "$lockfile" ]] || { fail '缺少可信 ASTER 依赖锁文件。'; return 1; }
  updater_safe_path "$APP_DIR/python-aster" || return 1
  fingerprint=$({ cat "$lockfile"; /usr/bin/python3 -VV; uname -m; } | hash)
  runtime="$APP_DIR/python-aster/$fingerprint"
  updater_safe_path "$runtime" || return 1
  if [[ -x "$runtime/bin/python" && -f "$runtime/.complete" && "$(cat "$runtime/.complete")" == "$fingerprint" ]]; then
    ASTER_PYTHON_PATH="$runtime/bin/python"
    log 'ASTER 依赖与 Python 环境未变化，复用已验证虚拟环境。'
    return
  fi
  if [[ -d "$runtime" && ! -L "$runtime" && -f "$runtime/.building" && "$(cat "$runtime/.building")" == "$fingerprint" ]]; then
    [[ "$(realpath -e "$runtime")" == "$APP_DIR/python-aster/$fingerprint" ]] || return 1
    rm -rf -- "$runtime"
  fi
  [[ ! -e "$runtime" ]] || { fail "ASTER 虚拟环境不完整：$runtime"; return 1; }
  ci_update_progress prepare
  mkdir -p "$APP_DIR/python-aster"
  mkdir "$runtime"
  atomic_record "$runtime/.building" "$fingerprint"
  # Build at its final path: Python's scripts contain the absolute venv location.
  /usr/bin/python3 -m venv "$runtime"
  "$runtime/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$lockfile"
  "$runtime/bin/python" -c 'import fastapi, httpx, eth_account, eth_abi, websockets'
  chmod -R a+rX,go-w "$runtime"
  atomic_record "$runtime/.complete" "$fingerprint"
  rm -f -- "$runtime/.building"
  ASTER_PYTHON_PATH="$runtime/bin/python"
  log 'ASTER Python 依赖已按锁定版本安装并验证。'
}
migrate_embedded_modules() {
  module_migration_helper="$1/deploy/migrate-modules.py"
  migration_commit_started=0
  # The migration helper uses a root-only journal and never modifies old data.
  # Stop the hub first so neither old nor new in-process writers race the copy.
  if systemctl is-active --quiet "$SERVICE"; then systemctl stop "$SERVICE"; fi
  python3 "$module_migration_helper" begin --data "$DATA_PATH" --journal "$APP_DIR/.module-migration.json" --user "$SERVICE_USER"
}
finish_activation() {
  # Finish fallible records while the migration can still restore old services.
  remember_environment || return 1
  atomic_record "$APP_DIR/.greeks-python-path" "$GREEKS_PYTHON_PATH" || return 1
  atomic_record "$APP_DIR/.aster-python-path" "$ASTER_PYTHON_PATH" || return 1
  if [[ -n "$module_migration_helper" ]]; then
    migration_commit_started=1
    python3 "$module_migration_helper" commit --data "$DATA_PATH" --journal "$APP_DIR/.module-migration.json" || return 1
  fi
  # A committed migration is the topology commit point. Later bookkeeping must
  # never restart the old hub with its now-retired standalone modules.
  activation_started=0
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
Environment=GREEKS_PYTHON=$GREEKS_PYTHON_PATH
Environment=ASTER_PYTHON=$ASTER_PYTHON_PATH
Restart=on-failure
RestartSec=5
TimeoutStopSec=150
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
# Rename before deleting: an interrupted removal must never leave a partial
# entry under a live cache key, which later installs reject as incomplete.
discard_cache_entry() {
  local target=$1 trash
  trash="${target%/*}/.prune.${target##*/}"
  if [[ -e "$trash" || -L "$trash" ]]; then rm -rf -- "$trash" || return 1; fi
  mv -T -- "$target" "$trash" || return 1
  rm -rf -- "$trash"
}
# Every cache entry is rebuilt from pinned inputs when its key is missing, so a
# successful activation keeps only what this deployment and its rollback
# releases still reference. Callers hold the install lock and must treat a
# failure as non-fatal: the activated release never depends on pruning.
prune_caches() {
  local cache="$APP_DIR/cache" entry name root links target key module directory interpreter recorded recorded_release
  local removed=0 failed=0 source_keys=0
  local -A keep=() keep_python=()
  local -a roots=()
  for root in "${release:-}" "${previous_release:-}" "${old_release:-}" "$APP_DIR/current" "$APP_DIR/previous"; do
    [[ -n "$root" && -e "$root" ]] || continue
    root=$(realpath -e -- "$root") || return 1
    roots+=("$root")
  done
  for root in "${roots[@]}"; do
    # Releases built by any installer revision link production dependencies into the cache.
    links=$(find "$root" -maxdepth 5 -type l -lname "$cache/*" -printf '%l\n') || return 1
    while IFS= read -r target; do
      target=${target#"$cache/"}
      target=${target%%/*}
      [[ -n "$target" ]] || continue
      keep[$target]=1
    done <<< "$links"
    if [[ -f "$root/.runtime-dependency-key" ]]; then
      key=$(cat -- "$root/.runtime-dependency-key") || return 1
      keep[runtime-dependencies-$key]=1
    fi
  done
  # CI deployments never compute source cache keys; leave those caches for a later source deployment.
  if [[ "$PROJECT_DEPLOY_MODE" == source && -n "${dependency_key:-}" && -n "${embedded_key:-}" ]]; then
    source_keys=1
    for key in "dependencies-$dependency_key" "runtime-dependencies-$runtime_dependency_key" "build-$build_key" "embedded-$embedded_key"; do
      keep[$key]=1
    done
    for module in "${!module_build_keys[@]}"; do keep[module-$module-${module_build_keys[$module]}]=1; done
  fi
  for entry in "$cache"/* "$cache"/.[!.]*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name=${entry##*/}
    if [[ "$name" == .prune.* || "$name" =~ ^\.(build|module-[a-z]+)-[a-f0-9]{64}\.(tmp|old)- ]]; then
      if rm -rf -- "$entry"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
      continue
    fi
    (( source_keys )) || continue
    [[ "$name" =~ ^(dependencies|runtime-dependencies|build|embedded)-[a-f0-9]{64}$ ||
       "$name" =~ ^module-[a-z]+-[a-f0-9]{64}$ ]] || continue
    [[ -z ${keep[$name]:-} ]] || continue
    if discard_cache_entry "$entry"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
  done
  if [[ -d "$cache/archives" && ! -L "$cache/archives" ]]; then
    for entry in "$cache/archives"/* "$cache/archives"/.[!.]*; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      name=${entry##*/}
      if [[ "$name" == .prune.* ]]; then
        if rm -rf -- "$entry"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
        continue
      fi
      [[ "$name" =~ ^\.?([a-f0-9]{64})\.(tar\.gz|parts|lock)$ && "${BASH_REMATCH[1]}" != "${CI_RELEASE_SHA256:-}" ]] || continue
      if discard_cache_entry "$entry"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
    done
  fi
  for module in greeks aster; do
    directory="$APP_DIR/python"
    interpreter=$GREEKS_PYTHON_PATH
    if [[ "$module" == aster ]]; then directory="$APP_DIR/python-aster"; interpreter=$ASTER_PYTHON_PATH; fi
    # Without a managed active interpreter there is no trustworthy keep set.
    [[ "$interpreter" =~ ^"$directory/"([a-f0-9]{64})/bin/python$ ]] || continue
    keep_python=(["${BASH_REMATCH[1]}"]=1)
    if [[ -e "$APP_DIR/previous" ]]; then
      # Without a record naming the current rollback release, its environment is unknown.
      [[ -f "$APP_DIR/.previous-$module-python-path" ]] || continue
      recorded_release= interpreter=
      { IFS= read -r recorded_release || true; IFS= read -r interpreter || true; } < "$APP_DIR/.previous-$module-python-path" || return 1
      [[ -n "$recorded_release" && "$recorded_release" == "$(realpath -e -- "$APP_DIR/previous")" ]] || continue
      if [[ "$interpreter" =~ ^"$directory/"([a-f0-9]{64})/bin/python$ ]]; then keep_python[${BASH_REMATCH[1]}]=1; fi
    fi
    # The active record and this run's pre-activation copy cover the restored unit after a rollback.
    for recorded in "$APP_DIR/.$module-python-path" "${work_dir:-}/previous-$module-python-path"; do
      [[ -f "$recorded" ]] || continue
      interpreter=$(cat -- "$recorded") || return 1
      if [[ "$interpreter" =~ ^"$directory/"([a-f0-9]{64})/bin/python$ ]]; then keep_python[${BASH_REMATCH[1]}]=1; fi
    done
    for entry in "$directory"/* "$directory"/.prune.*; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      name=${entry##*/}
      if [[ "$name" == .prune.* ]]; then
        if rm -rf -- "$entry"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
        continue
      fi
      [[ "$name" =~ ^[a-f0-9]{64}$ && -z ${keep_python[$name]:-} ]] || continue
      if discard_cache_entry "$entry"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
    done
  done
  # Work directories are created only under the install lock, so any other one is a failed attempt.
  for entry in "$APP_DIR"/.install.*; do
    [[ -d "$entry" && ! -L "$entry" && "$entry" != "${work_dir:-}" && "${entry##*/}" =~ ^\.install\.[A-Za-z0-9]{8}$ ]] || continue
    if rm -rf -- "$entry"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
  done
  (( removed == 0 )) || log "已清理 $removed 项旧部署缓存或失败安装残留。"
  (( failed == 0 )) || { log "有 $failed 项旧缓存未能删除。"; return 1; }
}
main() {
  case "$PROJECT_DEPLOY_MODE" in source|ci) ;; *) fail 'PROJECT_DEPLOY_MODE 必须是 ci 或 source。'; return 1 ;; esac
  case "$PROJECT_DEPLOY_TESTS" in
    0|1) ;;
    *) fail 'PROJECT_DEPLOY_TESTS 必须是 0 或 1。'; return 1 ;;
  esac
  [[ "$(uname -s)" == Linux ]] || fail '安装脚本仅用于 Linux；开发环境请使用 pnpm 命令。'
  [[ "$EUID" == 0 ]] || fail '请使用 sudo bash install.sh。'
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] || fail '需要正在运行 systemd 的 Linux 主机。'
  trap ci_finish_progress EXIT
  umask 022
  ensure_tools
  ci_update_progress preflight
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
  # The runtime resolves the configured path without following links.
  configured_data=$(realpath -m -s "$DATA_PATH")
  DATA_PATH=$(realpath -m "$DATA_PATH")
  case "$DATA_PATH" in /var/lib/project-aggregation|/var/lib/project-aggregation/*|/srv/project-aggregation/*|/opt/project-aggregation-data|/opt/project-aggregation-data/*) ;; *) fail 'DATA_DIR 请使用 /var/lib/project-aggregation、/srv/project-aggregation/ 子目录或 /opt/project-aggregation-data，避免修改系统目录权限。' ;; esac
  runtime_setting=$(read_setting WORKBENCH_RUNTIME_DIR '')
  if [[ -n "$runtime_setting" ]]; then
    runtime_dir_fits "$(realpath -m -s "$runtime_setting")" || fail 'WORKBENCH_RUNTIME_DIR 路径过长（上限 50 字节）：运行时 socket 的完整路径不能超过 100 字节。'
  else
    for candidate in "$configured_data" "$DATA_PATH"; do
      runtime_dir_fits "$candidate/run" || fail "DATA_DIR 路径过长（${#candidate} 字节，上限 46）：运行时 socket 位于 DATA_DIR/run 下，完整路径不能超过 100 字节。请先停止 $SERVICE 服务，把数据目录整体移到较短路径，再修改 DATA_DIR 并重新安装。"
    done
  fi
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_PATH"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR/build-home"
  HEALTH_URL=$(health_url "$HOST_VALUE" "$PORT_VALUE")
  ensure_node
  if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then
    runtime_key=$(printf '%s\n%s\n' "$("$NODE_BIN" --version)" "$(uname -m)" | hash)
    build_environment=ci-v1
  else
  ensure_pnpm
  runtime_key=$(printf '%s\n%s\n%s\n%s\n' "$("$NODE_BIN" --version)" "$PNPM_VERSION" "$(uname -s)" "$(uname -m)" | hash)
  build_environment=$(read_build_environment)
  fi
  if [[ -f "$APP_DIR/.greeks-python-path" ]]; then GREEKS_PYTHON_PATH=$(cat "$APP_DIR/.greeks-python-path"); fi
  if [[ -f "$APP_DIR/.aster-python-path" ]]; then ASTER_PYTHON_PATH=$(cat "$APP_DIR/.aster-python-path"); fi
  write_unit
  deployment_key=$({ cat "$ENV_FILE" "$work_dir/service"; printf '%s\n%s' "$runtime_key" "$INSTALL_REVISION:$build_environment"; } | hash)
  # Both deployment modes consume exactly the selected stable release. The
  # coordinator passes a pinned manifest; direct installs discover stable once.
  ci_release_resolve hxx344/project-aggregation "$work_dir"
  commit=$CI_RELEASE_COMMIT
  [[ "$CI_RELEASE_NODE_VERSION" == "$NODE_VERSION" ]] || fail '正式版本的 Node.js 基线与安装器不匹配，请获取最新版安装器。'
  deployed_state=
  [[ ! -f "$APP_DIR/.deployed-state" ]] || deployed_state=$(cat "$APP_DIR/.deployed-state")
  if [[ ( "$PROJECT_DEPLOY_MODE" == ci || "$PROJECT_DEPLOY_TESTS" == 0 ) && -n "$old_release" && -f "$old_release/.install-ready" && -s "$old_release/dist/index.html" &&
        "$deployed_state" == "$commit $deployment_key" ]] &&
      { [[ "$PROJECT_DEPLOY_MODE" != source ]] || source_runtime_dependencies_ready "$old_release"; } && healthy; then
    remember_environment
    log "源提交 ${commit:0:12} 已检查、运行环境和配置未变化，服务健康；跳过下载、依赖、验证、构建和重启。"
    finish_update_service "$old_release"
    prune_caches || log '部分旧缓存未能清理；已上线版本不受影响，下次成功部署会重试。'
    rm -rf -- "$work_dir"
    trap - ERR INT TERM
    return
  fi
  if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then
    prepare_ci_application
    ci_update_progress verify
    validate_embedded_runtime "$release"
    # The entries are imported, not run: argv[1] is a placeholder, so their main-module checks stay false.
    run_as_service "$NODE_BIN" --input-type=module -e 'for (const file of process.argv.slice(2)) await import(file)' import-check \
      "$release/server/app.mjs" "$release/server/launcher.mjs" "$release/server/runtime/main.mjs" "$release/server/api/main.mjs"
  else
  log "准备正式版本 ${commit:0:12} 的源码；不下载预构建运行包。"
  fetch_source
  input_keys
  ci_update_progress prepare
  prepare_application
  ci_update_progress verify
  validate_embedded_runtime "$release"
  fi
  prepare_greeks_runtime "$release"
  prepare_aster_runtime "$release"
  write_unit
  deployment_key=$({ cat "$ENV_FILE" "$work_dir/service"; printf '%s\n%s' "$runtime_key" "$INSTALL_REVISION:$build_environment"; } | hash)
  if [[ "$release" == "$old_release" && "${deployed_state#* }" == "$deployment_key" ]] && healthy; then
    atomic_record "$APP_DIR/.deployed-state" "$commit $deployment_key"
    remember_environment
    log "已检查源提交 ${commit:0:12}；运行产物 $(cat "$release/.source-sha") 保持不变，跳过版本切换和重启。"
    finish_update_service "$release"
    prune_caches || log '部分旧缓存未能清理；已上线版本不受影响，下次成功部署会重试。'
    rm -rf -- "$work_dir"
    trap - ERR INT TERM
    return
  fi
  previous_release=$old_release
  if [[ "$old_release" == "$release" && -L "$APP_DIR/previous" ]]; then previous_release=$(realpath -e "$APP_DIR/previous"); fi
  prepare_environment_rollback
  ci_update_progress switch
  activation_started=1
  migrate_embedded_modules "$release"
  if [[ "$release" != "$old_release" ]]; then atomic_link "$release" "$APP_DIR/current"; fi
  if [[ ! -f "$UNIT_FILE" ]] || ! cmp -s "$work_dir/service" "$UNIT_FILE"; then
    install -m 0644 "$work_dir/service" "$UNIT_FILE"
    systemctl daemon-reload
  fi
  systemctl enable "$SERVICE" >/dev/null
  systemctl restart "$SERVICE"
  ci_update_progress finalize '' healthcheck
  wait_healthy || fail '服务未在 30 次健康检查内就绪。'
  finish_activation
  atomic_record "$APP_DIR/.deployed-state" "$commit $deployment_key"
  atomic_record "$release/.install-ready" "$application_key"
  atomic_record "$APP_DIR/.node-path" "$NODE_BIN"
  if [[ -n "$old_release" && "$old_release" != "$release" ]]; then remember_previous_python_paths "$old_release"; fi
  if [[ -n "$previous_release" && "$previous_release" != "$release" ]]; then atomic_link "$previous_release" "$APP_DIR/previous"; fi
  finish_update_service "$release"
  prune_releases
  prune_caches || log '部分旧缓存未能清理；已上线版本不受影响，下次成功部署会重试。'
  rm -rf -- "$work_dir"
  trap - ERR INT TERM
  log "安装完成：已检查源提交 ${commit:0:12}；运行产物 $(cat "$release/.source-sha")；监听 $HOST_VALUE:$PORT_VALUE，配置与数据已保留。"
  log "首次登录密码请在服务器运行：sudo journalctl -u $SERVICE --no-pager -n 30"
}

# CI may source pure helpers without changing its host.
if [[ "${AGG_INSTALL_SOURCE_ONLY:-0}" != 1 ]]; then main "$@"; fi
