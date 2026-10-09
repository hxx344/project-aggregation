"""Read only public, stable GitHub releases from the built-in repository list."""
import hashlib
import json
import platform
import re
import urllib.error
import urllib.parse
import urllib.request

from registry import HEX40, HEX64


ALLOWED_HOSTS = {'api.github.com', 'github.com', 'raw.githubusercontent.com',
                 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
MAX_JSON = 1024 * 1024
MAX_INSTALLER = 2 * 1024 * 1024


class ReleaseError(Exception):
    def __init__(self, message='正式版本检查失败，请稍后重新检查'):
        super().__init__(message)


def allowed_url(url):
    value = urllib.parse.urlsplit(url)
    if value.scheme != 'https' or value.hostname not in ALLOWED_HOSTS or value.username or value.password or value.port not in (None, 443):
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
        allowed_url(url)
        request = urllib.request.Request(url, method=method, headers={
            'User-Agent': 'project-aggregation-stable-updater/1', 'Accept': 'application/vnd.github+json'})
        try:
            with self.opener.open(request, timeout=25) as response:
                allowed_url(response.url)
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
            if error.code == 404:
                raise ReleaseError('尚无可用正式版本，或发布文件不完整') from None
            if error.code in (403, 429):
                raise ReleaseError('GitHub 查询暂时受限，请稍后重新检查') from None
            raise ReleaseError('正式版本下载暂时不可用，请稍后重新检查') from None
        except (OSError, TimeoutError, urllib.error.URLError):
            raise ReleaseError('无法连接正式版本发布服务，请稍后重新检查') from None


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


def architecture():
    try:
        return {'x86_64': 'linux-x64', 'amd64': 'linux-x64', 'aarch64': 'linux-arm64',
                'arm64': 'linux-arm64'}[platform.machine().lower()]
    except KeyError:
        raise ReleaseError('当前处理器架构不支持自动更新') from None


class Releases:
    def __init__(self, network=None, arch=None):
        self.network = network or Network()
        self.arch = arch or architecture()

    @staticmethod
    def api(module, suffix):
        return f'https://api.github.com/repos/hxx344/{module.repository}/{suffix}'

    @staticmethod
    def download(module, tag, filename):
        return f'https://github.com/hxx344/{module.repository}/releases/download/{tag}/{filename}'

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
        release = self.metadata(module, release_id)
        tag = release['tag_name']
        manifest_bytes = self.network.request(self.download(module, tag, 'release-manifest.json'))
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
        except (ValueError, TypeError, KeyError):
            raise ReleaseError('正式版本缺少匹配本机的完整部署包') from None
        self.network.request(self.download(module, tag, item['file']), method='HEAD')
        installer = self.installer(module, manifest['commit'])
        return {'releaseId': release['id'], 'commit': manifest['commit'], 'tag': tag,
                'version': manifest['commit'][:12], 'publishedAt': release['published_at'],
                'manifest': manifest, 'manifestHash': digest(manifest_bytes), 'manifestBytes': manifest_bytes,
                'installer': installer, 'installerHash': digest(installer), 'applicationKey': item['application_key']}

    def installer(self, module, commit):
        if not HEX40.fullmatch(commit):
            raise ReleaseError('安装器版本无效')
        source = self.network.request(f'https://raw.githubusercontent.com/hxx344/{module.repository}/{commit}/{module.installer}', MAX_INSTALLER)
        if not source.startswith(b'#!/usr/bin/env bash\n') and not source.startswith(b'#!/bin/bash\n'):
            raise ReleaseError('正式安装器格式无效')
        if b'PROJECT_DEPLOY_MANIFEST_FILE' not in source or b'CI RELEASE HELPERS' not in source:
            raise ReleaseError('该正式版本尚不支持固定版本更新，请先运行一键部署命令升级')
        return source

    def is_newer(self, module, installed_commit, candidate):
        if not installed_commit or installed_commit == candidate:
            return installed_commit != candidate
        comparison = decode_json(self.network.request(self.api(module, f'compare/{installed_commit}...{candidate}')))
        status = comparison.get('status')
        if status not in ('ahead', 'behind', 'identical', 'diverged'):
            raise ReleaseError('无法确认正式版本的更新顺序')
        if status == 'diverged':
            raise ReleaseError('本机与正式版本的来源不同，请通过命令检查后更新')
        return status == 'ahead'
