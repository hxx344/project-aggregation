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
  python3 -I - "$1" "$2" "$3" <<'CI_DOWNLOAD_PY'
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


def write_progress_file(stage, progress=None, downloaded=None, total=None, speed=None):
    """Publish optional detail only in the coordinator's protected job directory."""
    filename = os.environ.get('PROJECT_UPDATE_PROGRESS_FILE', '')
    if not filename or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        return
    directory = None
    temporary = None
    try:
        parts = filename.split('/')
        if parts[0] or any(part in ('', '.', '..') for part in parts[1:]):
            return
        if stage not in ('preflight', 'download', 'prepare', 'build', 'verify', 'extract', 'switch', 'finalize'):
            return
        data = {
            'stage': stage,
            'timestamp': int(time.time() * 1000),
        }
        if progress is not None:
            if not isinstance(progress, (int, float)) or not 0 <= progress <= 1:
                return
            data['progress'] = float(progress)
        if downloaded is not None:
            data['downloaded'] = int(downloaded)
        if total is not None:
            data['total'] = int(total)
        if speed is not None and speed > 0:
            data['speed'] = int(speed)
            if downloaded is not None and total is not None and downloaded < total:
                remaining = total - downloaded
                data['eta'] = int(remaining / speed)
        # Open every ancestor without following links. Keep the verified parent
        # descriptor for all file operations so no path lookup can swap it later.
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory = os.open('/', flags)
        for part in [None, *parts[1:-1]]:
            if part is not None:
                child = os.open(part, flags, dir_fd=directory)
                os.close(directory)
                directory = child
            info = os.fstat(directory)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                return
        try:
            current = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if current is not None and (not stat.S_ISREG(current.st_mode) or current.st_uid != 0 or
                                    current.st_nlink != 1 or current.st_mode & 0o077):
            return
        candidate = '.progress-' + secrets.token_hex(16)
        descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        temporary = candidate
        with os.fdopen(descriptor, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
    except (OSError, ValueError, TypeError):
        pass  # Progress write failure should not block download
    finally:
        if directory is not None:
            if temporary is not None:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except OSError:
                    pass
            os.close(directory)


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
            now = time.time()
            if self.stage == 'download' and self.total and now - self.last_progress_write >= PROGRESS_UPDATE_INTERVAL:
                speed = int(self.received / elapsed) if elapsed > 0 else 0
                write_progress_file(
                    stage='download',
                    progress=current / self.total,
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
        # Shutdown sockets before close: close alone can wait on a blocked BufferedReader.
        for response in responses:
            try:
                raw = getattr(getattr(response, 'fp', None), 'raw', None)
                connection = getattr(raw, '_sock', None)
                if connection is not None:
                    connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for response in responses:
            self.close_response(response)

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
            write_progress_file(sys.argv[2], float(sys.argv[3]) if sys.argv[3] else None)
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
  ci_release_download --progress "$1" "${2:-}" >/dev/null 2>&1 || true
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
