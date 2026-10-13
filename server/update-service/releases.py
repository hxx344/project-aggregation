"""Read only public, stable GitHub releases from the built-in repository list."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import copy
from email.utils import parsedate_to_datetime
import hashlib
import json
import platform
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from registry import HEX40, HEX64


ALLOWED_HOSTS = {'api.github.com', 'github.com', 'raw.githubusercontent.com',
                 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
MAX_JSON = 1024 * 1024
MAX_INSTALLER = 2 * 1024 * 1024
MAX_RELEASE_CACHE = 16
MAX_INSTALLER_CACHE = 16
MAX_COMPARISON_CACHE = 64
MAX_RELEASE_NOTES = 6000
RELEASE_NOTES_TRUNCATED = '\n（更新内容过长，已截断）'
RELEASE_NOTES_CONTROLS = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]')
RELEASE_CACHE_TTL = 30 * 60
MAX_RETRY_DELAY = 24 * 60 * 60
# Shared by all repositories; cold checks add at most two network workers.
ARTIFACT_CHECKS = ThreadPoolExecutor(max_workers=2, thread_name_prefix='release-artifact')


class ReleaseError(Exception):
    def __init__(self, message='正式版本检查失败，请稍后重新检查', *, retry_at=None, transient=False):
        super().__init__(message)
        self.retry_at = retry_at
        self.transient = transient


def retry_deadline(headers, now):
    """Read bounded server deadlines without exposing response bodies or URLs."""
    deadlines = []
    remaining = headers.get('X-RateLimit-Remaining')
    reset = headers.get('X-RateLimit-Reset', '')
    if remaining == '0' and re.fullmatch(r'[0-9]{1,12}', reset):
        deadlines.append(int(reset))
    retry = headers.get('Retry-After', '')
    if re.fullmatch(r'[0-9]{1,10}', retry):
        deadlines.append(now + int(retry))
    elif retry:
        try:
            value = parsedate_to_datetime(retry)
            if value.tzinfo is not None:
                deadlines.append(value.timestamp())
        except (TypeError, ValueError, OverflowError):
            pass
    future = [min(deadline, now + MAX_RETRY_DELAY) for deadline in deadlines if deadline > now]
    return max(future) if future else None


def endpoint_name(url):
    # Only a fixed host label is public; signed redirect queries remain private.
    host = urllib.parse.urlsplit(url).hostname
    return {'api.github.com': 'GitHub API', 'github.com': 'GitHub 发布服务',
            'raw.githubusercontent.com': 'GitHub 安装器源码服务'}.get(host, 'GitHub 发布文件服务')


def allowed_url(url):
    try:
        value = urllib.parse.urlsplit(url)
        valid = (value.scheme == 'https' and value.hostname in ALLOWED_HOSTS and
                 not value.username and not value.password and value.port in (None, 443))
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ReleaseError('发布文件地址无效，已停止检查')


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, target):
        allowed_url(target)
        return super().redirect_request(request, response, code, message, headers, target)


class Network:
    def __init__(self):
        # Do not inherit a proxy or credentials from a service environment.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), SafeRedirect())

    def request(self, url, maximum=MAX_JSON, method='GET'):
        return self._request(url, maximum, method)

    def redirect(self, url):
        """Return the final URL without changing the bytes-only request API."""
        return self._request(url, method='HEAD', final_url=True)

    def _request(self, url, maximum=MAX_JSON, method='GET', final_url=False):
        allowed_url(url)
        api = urllib.parse.urlsplit(url).hostname == 'api.github.com'
        request = urllib.request.Request(url, method=method, headers={
            'User-Agent': 'project-aggregation-stable-updater/1',
            'Accept': 'application/vnd.github+json' if api else '*/*',
            'Cache-Control': 'no-cache'})
        try:
            with self.opener.open(request, timeout=25) as response:
                allowed_url(response.url)
                if final_url:
                    return response.url
                if method == 'HEAD':
                    return b''
                length = response.headers.get('Content-Length')
                if length is not None and (not length.isdigit() or int(length) > maximum):
                    raise ReleaseError('发布文件超出允许大小')
                data = response.read(maximum + 1)
                if len(data) > maximum:
                    raise ReleaseError('发布文件超出允许大小')
                return data
        except urllib.error.HTTPError as error:
            endpoint = endpoint_name(error.url)
            headers = error.headers or {}
            deadline = retry_deadline(headers, time.time())
            error.close()
            if error.code == 404:
                raise ReleaseError(f'{endpoint}未找到正式版本或发布文件（HTTP 404）') from None
            if error.code in (403, 429):
                if urllib.parse.urlsplit(error.url).hostname == 'api.github.com' and headers.get('X-RateLimit-Remaining') == '0':
                    reason = '匿名请求额度已用尽'
                elif error.code == 429 or headers.get('Retry-After'):
                    reason = '请求频率受限'
                else:
                    reason = '拒绝访问，请检查服务器的 GitHub 网络访问'
                raise ReleaseError(f'{endpoint}{reason}（HTTP {error.code}）', retry_at=deadline, transient=True) from None
            raise ReleaseError(f'{endpoint}暂时不可用（HTTP {error.code}）',
                               retry_at=deadline, transient=500 <= error.code < 600) from None
        except (OSError, TimeoutError, urllib.error.URLError):
            raise ReleaseError(f'无法连接{endpoint_name(url)}，请检查服务器网络', transient=True) from None


def decode_json(data):
    try:
        result = json.loads(data)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, UnicodeError):
        raise ReleaseError('正式版本的发布信息无效') from None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def release_notes(value):
    """Keep release prose as bounded text; it never participates in an update plan."""
    if not isinstance(value, str):
        return ''
    value = RELEASE_NOTES_CONTROLS.sub('', value.replace('\r\n', '\n').replace('\r', '\n')).strip()
    encoded = value.encode('utf-8')
    if len(encoded) <= MAX_RELEASE_NOTES:
        return value
    budget = MAX_RELEASE_NOTES - len(RELEASE_NOTES_TRUNCATED.encode('utf-8'))
    return encoded[:budget].decode('utf-8', errors='ignore') + RELEASE_NOTES_TRUNCATED


def architecture():
    try:
        return {'x86_64': 'linux-x64', 'amd64': 'linux-x64', 'aarch64': 'linux-arm64',
                'arm64': 'linux-arm64'}[platform.machine().lower()]
    except KeyError:
        raise ReleaseError('当前处理器架构不支持自动更新') from None


class Releases:
    def __init__(self, network=None, arch=None, clock=None):
        self.network = network or Network()
        self.arch = arch or architecture()
        self.clock = clock or time.monotonic
        # Minimal request-only adapters retain the original, fully fresh path.
        self.cacheable = callable(getattr(self.network, 'redirect', None))
        self._lock = threading.Lock()
        self._releases = OrderedDict()
        self._installers = OrderedDict()
        self._comparisons = OrderedDict()

    def _cached(self, cache, key):
        with self._lock:
            value = cache.get(key)
            if value is not None:
                cache.move_to_end(key)
            return value

    def _remember(self, cache, key, value, maximum):
        with self._lock:
            cache[key] = value
            cache.move_to_end(key)
            while len(cache) > maximum:
                cache.popitem(last=False)

    @staticmethod
    def api(module, suffix):
        return f'https://api.github.com/repos/hxx344/{module.repository}/{suffix}'

    @staticmethod
    def download(module, tag, filename):
        return f'https://github.com/hxx344/{module.repository}/releases/download/{tag}/{filename}'

    def latest_tag(self, module):
        base = f'https://github.com/hxx344/{module.repository}/releases/'
        target = self.network.redirect(base + 'latest')
        # Reject missing redirects, different repositories, encoded paths,
        # query strings and any final destination other than the exact tag URL.
        if not isinstance(target, str):
            raise ReleaseError('无法确认最新正式版本，请稍后重新检查')
        match = re.fullmatch(re.escape(base + 'tag/') + r'(deploy-[a-f0-9]{40})', target)
        if match is None:
            raise ReleaseError('尚无可用正式版本，或正式版本地址已改变')
        return match.group(1)

    def metadata(self, module, release_id=None):
        suffix = 'releases/latest' if release_id is None else f'releases/{release_id}'
        release = decode_json(self.network.request(self.api(module, suffix)))
        if (type(release.get('id')) is not int or release['id'] < 1 or
                release.get('draft') is not False or release.get('prerelease') is not False or
                not isinstance(release.get('tag_name'), str) or
                not re.fullmatch(r'deploy-[a-f0-9]{40}', release['tag_name']) or
                not isinstance(release.get('published_at'), str)):
            raise ReleaseError('该发布不是可安装的正式版本')
        if release_id is not None and release['id'] != release_id:
            raise ReleaseError('正式版本身份已改变，请重新检查')
        return release

    def read(self, module, release_id=None):
        # A worker names the approved release ID. Never reuse any discovery,
        # manifest, eligibility or installer cache in this execution boundary.
        if release_id is not None or not self.cacheable:
            release = self.metadata(module, release_id)
            manifest_bytes = self.network.request(self.download(module, release['tag_name'], 'release-manifest.json'))
            return self._verified(module, release, manifest_bytes, fresh=True)

        key = (module.repository, self.arch)
        try:
            tag = self.latest_tag(module)
            manifest_bytes = self.network.request(self.download(module, tag, 'release-manifest.json'))
            manifest_hash = digest(manifest_bytes)
            cached = self._cached(self._releases, key)
            if cached is not None:
                verified_at, value = cached
                age = self.clock() - verified_at
                if (0 <= age < RELEASE_CACHE_TTL and value['tag'] == tag and value['manifestHash'] == manifest_hash):
                    item = value['manifest']['artifacts'][self.arch]
                    self.network.request(self.download(module, tag, item['file']), method='HEAD')
                    return copy.deepcopy(value)
            release = self.metadata(module)
            if release['tag_name'] != tag:
                raise ReleaseError('最新正式版本已改变，请重新检查')
            result = self._verified(module, release, manifest_bytes)
            # The same tag and bytes can survive deletion/recreation of a
            # release. Periodically renew its ID and formal-release eligibility.
            self._remember(self._releases, key, (self.clock(), copy.deepcopy(result)), MAX_RELEASE_CACHE)
            return result
        except ReleaseError as error:
            # Never return stale success. A transient failure need not discard
            # verified metadata; recovery still probes tag/manifest/artifact and
            # respects its original TTL. Invalid content always clears it.
            if not error.transient:
                with self._lock:
                    self._releases.pop(key, None)
            raise

    def _verified(self, module, release, manifest_bytes, fresh=False):
        tag = release['tag_name']
        manifest = decode_json(manifest_bytes)
        try:
            item = manifest['artifacts'][self.arch]
            valid = (type(manifest['schema']) is int and manifest['schema'] == 1 and
                     manifest['repository'] == 'hxx344/' + module.repository and
                     HEX40.fullmatch(manifest['commit']) and manifest['tag'] == tag == 'deploy-' + manifest['commit'] and
                     re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz', item['file']) and
                     HEX64.fullmatch(item['sha256']) and HEX64.fullmatch(item['application_key']))
            if not valid:
                raise ValueError()
            node = manifest.get('node_version', '')
            if node and not re.fullmatch(r'\d+\.\d+\.\d+', node):
                raise ValueError()
            assets = {asset['name']: asset for asset in release['assets']}
            for name, maximum in (('release-manifest.json', MAX_JSON), (item['file'], 2 * 1024 ** 3)):
                asset = assets[name]
                if asset.get('state') != 'uploaded' or type(asset.get('size')) is not int or not 0 < asset['size'] <= maximum:
                    raise ValueError()
            remote_digest = assets[item['file']].get('digest')
            if remote_digest is not None and remote_digest != 'sha256:' + item['sha256']:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ReleaseError('正式版本缺少匹配本机的完整部署包') from None
        artifact_url = self.download(module, tag, item['file'])
        if self.cacheable:
            available = ARTIFACT_CHECKS.submit(self.network.request, artifact_url, method='HEAD')
            try:
                installer = self.installer(module, manifest['commit'], fresh=fresh)
            finally:
                available.result()
        else:
            self.network.request(artifact_url, method='HEAD')
            installer = self.installer(module, manifest['commit'], fresh=True)
        return {'releaseId': release['id'], 'commit': manifest['commit'], 'tag': tag,
                'version': manifest['commit'][:12], 'publishedAt': release['published_at'],
                'releaseNotes': release_notes(release.get('body')),
                'manifest': manifest, 'manifestHash': digest(manifest_bytes), 'manifestBytes': manifest_bytes,
                'installer': installer, 'installerHash': digest(installer), 'applicationKey': item['application_key']}

    def installer(self, module, commit, fresh=False):
        if not isinstance(commit, str) or not HEX40.fullmatch(commit):
            raise ReleaseError('安装器版本无效')
        key = (module.repository, module.installer, commit)
        if self.cacheable and not fresh:
            cached = self._cached(self._installers, key)
            if cached is not None:
                return cached
        source = self.network.request(f'https://raw.githubusercontent.com/hxx344/{module.repository}/{commit}/{module.installer}', MAX_INSTALLER)
        if not source.startswith(b'#!/usr/bin/env bash\n') and not source.startswith(b'#!/bin/bash\n'):
            raise ReleaseError('正式安装器格式无效')
        if b'PROJECT_DEPLOY_MANIFEST_FILE' not in source or b'CI RELEASE HELPERS' not in source:
            raise ReleaseError('该正式版本尚不支持固定版本更新，请先运行一键部署命令升级')
        if self.cacheable and not fresh:
            self._remember(self._installers, key, source, MAX_INSTALLER_CACHE)
        return source

    def is_newer(self, module, installed_commit, candidate):
        if (not isinstance(candidate, str) or not HEX40.fullmatch(candidate) or
                installed_commit and (not isinstance(installed_commit, str) or not HEX40.fullmatch(installed_commit))):
            raise ReleaseError('无法确认正式版本的更新顺序')
        if not installed_commit or installed_commit == candidate:
            return installed_commit != candidate
        key = (module.repository, installed_commit, candidate)
        if self.cacheable:
            cached = self._cached(self._comparisons, key)
            if cached is not None:
                return cached
        comparison = decode_json(self.network.request(self.api(module, f'compare/{installed_commit}...{candidate}')))
        status = comparison.get('status')
        if status not in ('ahead', 'behind', 'identical', 'diverged'):
            raise ReleaseError('无法确认正式版本的更新顺序')
        if status == 'diverged':
            raise ReleaseError('本机与正式版本的来源不同，请通过命令检查后更新')
        result = status == 'ahead'
        if self.cacheable:
            self._remember(self._comparisons, key, result, MAX_COMPARISON_CACHE)
        return result
