#!/usr/bin/env bash
# Compatibility entry point for the single unified application installer.
set -Eeuo pipefail

STACK_CACHE=/var/cache/project-aggregation-stack
STACK_LOGS=/var/log/project-aggregation-stack
STACK_LOCK=/run/lock/project-aggregation-stack.lock
STACK_ORDER=(hub)
declare -A STACK_REPOS=([hub]=project-aggregation)
declare -A STACK_PATHS=([hub]=deploy/install.sh)
declare -A STACK_NAMES=([hub]='Project Aggregation（五个内置模块与交易）')
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


class Cancelled(DownloadError):
    pass


class RangeRejected(DownloadError):
    pass


class Retryable(DownloadError):
    pass


def require(condition, message):
    if not condition:
        raise DownloadError(message)


def https_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname and
            parsed.username is None and parsed.password is None,
            'download and redirect URLs must use HTTPS without credentials')
    return url


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5
    max_repeats = 2

    def redirect_request(self, request, fp, code, message, headers, newurl):
        https_url(newurl)
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
        require(stat.S_ISDIR(info.st_mode) and not directory.is_symlink(),
                'cache directory cannot contain links or special files')
        if uid is not None:
            require(info.st_uid in (0, uid), 'cache ancestor has an unexpected owner')
            sticky_parent = directory != path and info.st_uid in (0, uid) and info.st_mode & stat.S_ISVTX
            require(not info.st_mode & 0o022 or sticky_parent,
                    'cache ancestor is writable by another user')
    if uid is not None:
        require(path.stat().st_uid == uid, 'cache directory has an unexpected owner')
    path.chmod(0o700)
    return path


def secure_open(path, flags=os.O_RDONLY):
    """Never truncate before checking the opened inode (including hard links)."""
    try:
        before = path.lstat()
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                'cache file must be a regular file with one link')
    except FileNotFoundError:
        before = None
    descriptor = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                'cache file must be a regular file with one link')
        if hasattr(os, 'geteuid'):
            require(info.st_uid == os.geteuid() and not info.st_mode & 0o022,
                    'cache file has an unsafe owner or permissions')
        if before is not None:
            require((before.st_dev, before.st_ino) == (info.st_dev, info.st_ino), 'cache file changed while opening')
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
    def __init__(self, cache, url, expected):
        require(re.fullmatch(r'[a-f0-9]{64}', expected) is not None, 'invalid archive SHA256')
        self.url, self.expected = https_url(url), expected
        self.cache = secure_directory(cache)
        self.archive = self.cache / (expected + '.tar.gz')
        self.parts = self.cache / ('.' + expected + '.parts')
        self.opener = urllib.request.build_opener(HTTPSRedirect())
        self.cancelled = threading.Event()
        self.phase_stop = threading.Event()
        self.active = set()
        self.active_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.progress_lock = threading.Lock()
        self.progress_stop = threading.Event()
        self.started = time.monotonic()
        self.received, self.total, self.positions = 0, None, {}
        self.mode = '检测'
        self.stage = 'download'
        self.last_progress_write = 0

    def check_cancel(self):
        if self.cancelled.is_set() or self.phase_stop.is_set():
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
        # Tests override only this transport; production never accepts HTTP or a TLS bypass.
        return self.opener.open(request, timeout=SOCKET_TIMEOUT)

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

        def interrupt(number, frame):
            if not self.cancelled.is_set():
                self.cancelled.set()
                raise Cancelled('download interrupted by signal %s' % number)

        try:
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
            for number, handler in handlers.items():
                signal.signal(number, handler)


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--progress':
            write_progress_file(sys.argv[2], float(sys.argv[3]) if sys.argv[3] else None)
        else:
            print(Downloader(*sys.argv[1:]).run())
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

stack_log() { printf '[总部署] %s\n' "$*"; }
stack_fail() { stack_log "错误：$*" >&2; return 1; }
stack_usage() {
  cat <<'HELP'
用法：sudo bash install-all.sh [--only hub] [--refresh] [--with-tests]
统一安装工作台、Market Monitor、Asset Ledger、Gate CrossEx、Greeks，并保留原生交易模块。
只部署一个工作台服务，业务模块不再单独安装、更新或监听 TCP 端口。
默认锁定 GitHub 正式版本的源码，在服务器按需构建；设置 PROJECT_DEPLOY_MODE=ci 可使用预构建包。
正式版本当前仅支持 x64，Python 需要 3.11+。
旧独立服务会停止并禁用；配置与数据复制到工作台数据目录，原文件保留。
新版本不健康时恢复旧服务和配置；重复执行复用未变化的依赖、产物和配置。
  --only hub    兼容原总部署入口；各内置模块不再支持独立部署。
  --refresh     重新获取安装器，不强制构建、重装或重启。
  --with-tests  仅源码部署时补做行为测试。
  --help        查看说明，无需 root。

HELP
}

stack_parse() {
  local only='' item
  local -A requested=()
  stack_with_tests=${PROJECT_DEPLOY_TESTS-0}
  stack_mode=${PROJECT_DEPLOY_MODE-source}
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
    case "$item" in hub) requested[$item]=1 ;;
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
  [[ $ID:$VERSION_ID != ubuntu:22.04 ]] || { stack_fail '内置 Greeks 需要 Python 3.11+，请使用 Ubuntu 24.04 或 Debian 12/13。'; return 1; }
  command -v apt-get >/dev/null && command -v dpkg-query >/dev/null && command -v flock >/dev/null || {
    stack_fail '需要 apt-get、dpkg-query 和 util-linux 的 flock。'; return 1;
  }
}

stack_ensure_tools() {
  local item package
  local -a packages=(ca-certificates curl) missing=()
  local -A wanted=([ca-certificates]=1 [curl]=1)
  packages+=(python3 python3-venv git xz-utils tar util-linux passwd)
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
  local revision url
  local -a conditional=()
  ci_release_resolve "hxx344/${STACK_REPOS[$item]}" "$stack_run/$item.release" || return 1
  revision=$CI_RELEASE_COMMIT
  if [[ "$stack_mode" == ci ]]; then
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
    stack_log "${STACK_NAMES[$item]}：部署包下载地址预检通过，同提交安装器已就绪；接下来按需下载部署包。"
  else
    stack_log "${STACK_NAMES[$item]}：正式版本 ${revision:0:12} 的安装器已就绪；接下来按需获取源码并构建。"
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
    (( result == 0 )) || { stack_fail '正式版本或安装器准备失败，尚未运行任何项目安装器；等待正式发布成功或修复下载问题后重试。'; return 1; }
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
      hub) installer_env+=("PROJECT_DEPLOY_TESTS=$stack_with_tests") ;;
      *) installer_env+=(-u PROJECT_DEPLOY_TESTS) ;;
    esac
    installer_env+=("PROJECT_DEPLOY_MODE=$stack_mode")
    installer_env+=("PROJECT_DEPLOY_MANIFEST_FILE=$stack_run/$item.release/release-manifest.json")
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
    stack_log '工作台统一使用 3100 端口；五个业务模块沿用工作台鉴权，配置与数据已保留。'
  fi
}

# Tests replace OS/package/network/service boundaries; never install to the test host.
if [[ ${AGG_STACK_SOURCE_ONLY:-0} != 1 ]]; then stack_main "$@"; fi
