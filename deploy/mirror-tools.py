#!/usr/bin/env python3
"""Release mirror diagnostics. No source-update or service mutation in test modes."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

REPOSITORY = 'hxx344/project-aggregation'
MANIFEST_URL = f'https://github.com/{REPOSITORY}/releases/latest/download/release-manifest.json'
CONFIG_PATH = Path('/etc/project-aggregation/release-mirror.conf')
ARCHITECTURES = {'x86_64': 'linux-x64', 'AMD64': 'linux-x64',
                 'aarch64': 'linux-arm64', 'arm64': 'linux-arm64', 'ARM64': 'linux-arm64'}
MAX_ARCHIVE = 2 * 1024 ** 3
REQUIRED_FILES = ('dist/index.html', 'server/app.mjs',
                  'modules/monitor/dist/client/index.html', 'modules/asset/.next/BUILD_ID',
                  'modules/crossex/dist/index.html', 'modules/greeks/requirements.lock',
                  'modules/aster/requirements.lock', 'modules/aster/dashboard/dist/client/index.html')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_url(url, base=False, official=False):
    require(isinstance(url, str) and not re.search(r'[\s\x00-\x1f\x7f\\]', url), 'URL 包含空白、反斜杠或控制字符')
    parsed = urllib.parse.urlsplit(url)
    require(parsed.hostname and parsed.username is None and parsed.password is None and not parsed.fragment and '%' not in parsed.netloc,
            'URL 需要主机名，且不能含凭据或 fragment')
    require(parsed.scheme == 'https' or
            (not official and parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1')),
            '远端 URL 必须使用 HTTPS；HTTP 仅允许字面 loopback 地址')
    require(parsed.port is None or 1 <= parsed.port <= 65535, 'URL 端口无效')
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        require(len(parsed.hostname) <= 253 and all(
            re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
            for label in parsed.hostname.split('.')), 'URL 主机名无效')
    if base:
        require(not parsed.path and not parsed.query, '镜像 URL 不能包含路径或 query')
    return url


def origin(url):
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80)


class RestrictedRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5
    max_repeats = 2

    def __init__(self, official=False, deadline=None, initial_http_origin=None):
        super().__init__()
        self.official = official
        self.deadline = deadline
        self.initial_http_origin = initial_http_origin
        self.https_seen = initial_http_origin is None

    def redirect_request(self, request, fp, code, message, headers, newurl):
        validate_url(newurl, official=self.official)
        if urllib.parse.urlsplit(newurl).scheme == 'http':
            require(not self.https_seen and origin(newurl) == self.initial_http_origin,
                    'HTTP 重定向只能保持初始 loopback origin，HTTPS 不允许降级')
        else:
            self.https_seen = True
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            require(remaining > 0, '下载重定向超时')
            request.timeout = remaining
        return super().redirect_request(request, fp, code, message, headers, newurl)


def download(url, destination, expected_sha256=None, timeout=60, max_size=MAX_ARCHIVE,
             official=False, opener=None, progress=True):
    """Bound redirects and total transfer time; never expose an unverified completed file."""
    validate_url(url, official=official)
    require(0 < timeout <= 3600, 'timeout 必须在 1–3600 秒之间')
    if expected_sha256 is not None:
        require(re.fullmatch(r'[a-f0-9]{64}', expected_sha256), 'SHA256 无效')
    destination = Path(destination)
    started = time.monotonic()
    deadline = started + timeout
    received = 0
    digest = hashlib.sha256()
    partial = destination.with_name(destination.name + '.part')
    initial_http_origin = origin(url) if urllib.parse.urlsplit(url).scheme == 'http' else None
    client = opener or urllib.request.build_opener(RestrictedRedirect(official, deadline, initial_http_origin))
    request = urllib.request.Request(url, headers={'User-Agent': 'project-aggregation-mirror-tools',
                                                  'Accept-Encoding': 'identity'})
    try:
        with client.open(request, timeout=timeout) as response, partial.open('wb') as output:
            require(response.status == 200, f'最终 HTTP 状态必须为 200，实际为 {response.status}')
            validate_url(response.geturl(), official=official)
            if urllib.parse.urlsplit(response.geturl()).scheme == 'http':
                require(initial_http_origin is not None and origin(response.geturl()) == initial_http_origin,
                        '最终 HTTP URL 必须保持初始 loopback origin')
            declared = response.headers.get('Content-Length')
            total = int(declared) if declared is not None else None
            require(total is None or 0 < total <= max_size, '下载为空或超过大小上限')
            last_progress = started
            while True:
                remaining = deadline - time.monotonic()
                require(remaining > 0, f'下载超时（{timeout} 秒）')
                # HTTPResponse exposes this socket on all supported CPython versions.
                # Reset it for each read so a slow body cannot extend the total budget.
                try:
                    response.fp.raw._sock.settimeout(remaining)
                except AttributeError:
                    pass
                chunk = response.read1(1024 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                require(received <= max_size, '下载超过大小上限')
                output.write(chunk)
                digest.update(chunk)
                now = time.monotonic()
                if progress and now - last_progress >= 1:
                    size = f' / {total / 1024 ** 2:.2f} MiB' if total else ''
                    print(f'  已下载 {received / 1024 ** 2:.2f} MiB{size}', file=sys.stderr, flush=True)
                    last_progress = now
            require(time.monotonic() <= deadline, f'下载超时（{timeout} 秒）')
            require(received > 0, '下载为空')
            require(total is None or total == received, '下载不完整：Content-Length 不匹配')
            require(expected_sha256 is None or digest.hexdigest() == expected_sha256, 'SHA256 校验失败')
            elapsed = max(time.monotonic() - started, 0.000001)
            result = {'status': 'passed', 'seconds': elapsed, 'bytes': received,
                      'speed_mib': received / elapsed / 1024 ** 2,
                      'sha256': digest.hexdigest(), 'url': response.geturl(),
                      'cache_status': response.headers.get('X-Cache-Status', 'UNKNOWN')}
        os.replace(partial, destination)
        return result
    finally:
        partial.unlink(missing_ok=True)


def validate_manifest(data):
    require(isinstance(data, dict) and type(data.get('schema')) is int and data['schema'] == 1
            and data.get('repository') == REPOSITORY, '发布清单 repository/schema 不匹配')
    commit = data.get('commit')
    require(isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit), '发布清单 commit 无效')
    require(data.get('tag') == 'deploy-' + commit, '发布清单 tag/commit 不匹配')
    artifacts = data.get('artifacts')
    require(isinstance(artifacts, dict) and artifacts, '发布清单 artifacts 无效')
    names = set()
    for architecture, item in artifacts.items():
        require(architecture in ('linux-x64', 'linux-arm64') and isinstance(item, dict), '发布清单架构无效')
        filename, digest = item.get('file'), item.get('sha256')
        require(isinstance(filename, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz', filename),
                '发布清单文件名无效')
        require(filename not in names, '发布清单文件名重复')
        require(isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest), '发布清单 SHA256 无效')
        names.add(filename)
    return data


def trusted_file(path):
    path = Path(os.path.abspath(path))
    uid = os.geteuid() if hasattr(os, 'geteuid') else None
    for entry in (path, *path.parents):
        info = entry.lstat()
        require(not stat.S_ISLNK(info.st_mode), f'拒绝链接路径: {entry}')
        require(stat.S_ISREG(info.st_mode) if entry == path else stat.S_ISDIR(info.st_mode),
                f'路径类型无效: {entry}')
        if uid is not None:
            require(info.st_uid in (0, uid), f'路径所有者不可信: {entry}')
            sticky = entry != path and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            require(not info.st_mode & 0o022 or sticky, f'路径可被其他用户写入: {entry}')
    return path


def resolve_manifest(work, supplied=None):
    path = Path(work) / 'release-manifest.json'
    if supplied:
        source = trusted_file(supplied)
        require(source.stat().st_size <= 1024 ** 2, '发布清单过大')
        content = source.read_bytes()
        if source != path:
            path.write_bytes(content)
    else:
        download(MANIFEST_URL, path, timeout=90, max_size=1024 ** 2, official=True)
        content = path.read_bytes()
    return validate_manifest(json.loads(content)), path


def selected_artifact(manifest, machine=None):
    architecture = ARCHITECTURES.get(machine or platform.machine())
    require(architecture in manifest['artifacts'], '当前架构没有预构建发布包')
    return manifest['artifacts'][architecture]


def artifact_url(manifest, item, base='https://github.com', kind='github'):
    base = validate_url(base, base=True)
    require(kind in ('github', 'oss'), '镜像 kind 必须为 github 或 oss')
    path = (f'/{REPOSITORY}/releases/download/' if kind == 'github' else f'/releases/{REPOSITORY}/')
    return f"{base}{path}{manifest['tag']}/{item['file']}"


def read_config(path=CONFIG_PATH):
    if not Path(path).exists():
        return None
    path = trusted_file(path)
    require(path.stat().st_size <= 4096, '镜像配置过大')
    content = path.read_text(encoding='utf-8')
    values = {}
    keys = {'RELEASE_MIRROR_URL', 'RELEASE_MIRROR_KIND', 'RELEASE_MIRROR_PRIORITY', 'RELEASE_MIRROR_TIMEOUT'}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'''([A-Z][A-Z0-9_]*)=(?:"([^"\\]*)"|'([^'\\]*)'|([A-Za-z0-9:/.[\]_-]*))''', line)
        require(match is not None, '镜像配置包含无效字段')
        key = match[1]
        require(key not in values, '镜像配置包含重复字段')
        values[key] = next(value for value in match.groups()[1:] if value is not None)
    if 'RELEASE_MIRROR_URL' not in values and 'RELEASE_MIRROR_DOMAIN' in values:
        print('旧版镜像配置尚未接入下载器；本次按未配置处理，可通过显式部署或配置工具迁移。', file=sys.stderr)
        return None
    require(not (values.keys() - keys), '镜像配置包含未知字段')
    values.setdefault('RELEASE_MIRROR_PRIORITY', 'fallback')
    values.setdefault('RELEASE_MIRROR_KIND', 'github')
    values.setdefault('RELEASE_MIRROR_TIMEOUT', '60')
    require(values['RELEASE_MIRROR_PRIORITY'] in ('fallback', 'always', 'disabled'), '镜像 priority 无效')
    if values['RELEASE_MIRROR_PRIORITY'] == 'disabled':
        return values
    values['RELEASE_MIRROR_URL'] = validate_url(values.get('RELEASE_MIRROR_URL', ''), base=True)
    require(values['RELEASE_MIRROR_KIND'] in ('github', 'oss'), '镜像 kind 无效')
    require(re.fullmatch(r'[0-9]{1,3}', values['RELEASE_MIRROR_TIMEOUT']), '镜像 timeout 无效')
    values['RELEASE_MIRROR_TIMEOUT'] = int(values['RELEASE_MIRROR_TIMEOUT'])
    require(1 <= values['RELEASE_MIRROR_TIMEOUT'] <= 300, '镜像 timeout 无效')
    return values


def measure(name, url, item, work, iterations, timeout, official=False):
    samples, errors = [], []
    for number in range(1, iterations + 1):
        print(f'{name} 第 {number}/{iterations} 次: {url}', flush=True)
        try:
            sample = download(url, Path(work) / f'{name}.tar.gz', item['sha256'], timeout, official=official)
            samples.append(sample)
            print(f"  校验通过 | {sample['seconds']:.3f} 秒 | {sample['speed_mib']:.2f} MiB/s | X-Cache-Status={sample['cache_status']}")
        except (OSError, ValueError) as error:
            errors.append(str(error))
            print(f'  失败: {error}', file=sys.stderr)
    return {'name': name, 'status': 'passed' if not errors else 'failed', 'samples': samples,
            'errors': errors, 'seconds': sum(s['seconds'] for s in samples) / len(samples) if samples else None}


def report(results):
    baseline = results[0]
    print('\n| 下载源 | 状态 | 平均耗时 | 相比 GitHub |')
    print('| --- | --- | --- | --- |')
    for result in results:
        status = {'passed': '校验通过', 'failed': '失败', 'unconfigured': '未配置', 'disabled': '已禁用'}[result['status']]
        elapsed = result.get('seconds')
        comparison = '—'
        if result['status'] == 'passed' and baseline['status'] == 'passed':
            comparison = '基线' if result is baseline else f"耗时变化 {(elapsed / baseline['seconds'] - 1) * 100:+.1f}%"
        elif result['status'] == 'passed':
            comparison = '基线失败，无法比较'
        print(f"| {result['name']} | {status} | {f'{elapsed:.3f} 秒' if elapsed else '—'} | {comparison} |")
    print('缓存状态仅取自本次 GET 响应头；UNKNOWN 不代表冷缓存或热缓存。')
    print('本工具测试预构建发布包；默认源码更新仍使用 git fetch，此结果不代表源码更新加速。')
    print('同机缓存首次下载仍需访问 GitHub，不保证改善首次下载或新版本下载。')


def run_performance(manifest, work, timeout, iterations, config=None):
    item = selected_artifact(manifest)
    results = [measure('GitHub', artifact_url(manifest, item), item, work, iterations, timeout, official=True)]
    if config is None:
        results.append({'name': '镜像', 'status': 'unconfigured'})
    elif config['RELEASE_MIRROR_PRIORITY'] == 'disabled':
        results.append({'name': '镜像', 'status': 'disabled'})
    else:
        results.append(measure('镜像', artifact_url(manifest, item, config['RELEASE_MIRROR_URL'],
                                                   config['RELEASE_MIRROR_KIND']), item, work, iterations,
                               config['RELEASE_MIRROR_TIMEOUT']))
    oss = os.environ.get('ALIYUN_OSS_MIRROR')
    if oss:
        results.append(measure('OSS', artifact_url(manifest, item, oss, 'oss'), item, work, iterations, timeout))
    return results


def local_release_scripts(directory, commit):
    """Only reuse local deployment scripts from the selected immutable version."""
    directory = Path(directory)
    names = ('setup-release-mirror.sh', 'configure-release-mirror.sh', 'mirror-tools.py')
    try:
        for name in names:
            path = trusted_file(directory / name)
            original = subprocess.run(['git', '-C', str(directory), 'show', f'{commit}:deploy/{name}'],
                                      check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
            require(path.read_bytes().replace(b'\r\n', b'\n') == original.replace(b'\r\n', b'\n'),
                    '本地脚本与所选发布版本不一致')
        return directory
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def prepare_deploy_scripts(manifest, work, local_directory):
    local = local_release_scripts(local_directory, manifest['commit'])
    if local:
        print('复用已核验的本地同版本部署脚本。')
        return local
    directory = Path(work) / 'deploy'
    directory.mkdir(mode=0o700)
    for filename in ('setup-release-mirror.sh', 'configure-release-mirror.sh', 'mirror-tools.py'):
        url = f"https://raw.githubusercontent.com/{REPOSITORY}/{manifest['commit']}/deploy/{filename}"
        download(url, directory / filename, timeout=60, max_size=1024 ** 2, official=True)
    return directory


def deploy_local(manifest, manifest_path, work, timeout, local_directory, verify=False):
    require(hasattr(os, 'geteuid') and os.geteuid() == 0, '显式部署需要 root 权限；默认测速无需 root')
    scripts = prepare_deploy_scripts(manifest, work, local_directory)
    subprocess.run(['bash', str(scripts / 'setup-release-mirror.sh')], check=True)
    arguments = ['bash', str(scripts / 'configure-release-mirror.sh'), '--url', 'http://127.0.0.1:8090',
                 '--kind', 'github', '--priority', 'fallback', '--timeout', str(timeout),
                 '--manifest', str(manifest_path)]
    if verify:
        arguments.append('--verify')
    # configure verifies the immutable artifact once when changing configuration,
    # and reuses its prior successful verification when the data is unchanged.
    subprocess.run(arguments, check=True)


def run_download_speed(manifest, work, timeout):
    item = selected_artifact(manifest)
    archive = Path(work) / item['file']
    result = download(artifact_url(manifest, item), archive, item['sha256'], timeout, official=True)
    print(f"下载与 SHA256 校验通过: {result['bytes'] / 1024 ** 2:.2f} MiB，{result['seconds']:.3f} 秒，{result['speed_mib']:.2f} MiB/s")
    extracted = Path(work) / 'extracted'
    extracted.mkdir()
    started = time.monotonic()
    with tarfile.open(archive, 'r:gz') as bundle:
        # data_filter rejects traversal, absolute links and special files.
        require(hasattr(tarfile, 'data_filter'), '解包验证需要带安全解包支持的 Python 3.11.8+ / 3.12+')
        bundle.extractall(extracted, filter='data')
    missing = [name for name in REQUIRED_FILES if not (extracted / name).is_file()]
    require(not missing, '运行文件缺失: ' + ', '.join(missing))
    print(f'解压及运行文件检查通过: {time.monotonic() - started:.3f} 秒')
    print('本结果仅覆盖预构建发布包，默认源码更新的 git fetch 不在本测试范围。')
    return 0


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('performance', 'optimize', 'download-speed', 'verify', 'validate-config'))
    parser.add_argument('config', nargs='?')
    parser.add_argument('--url')
    parser.add_argument('--kind', choices=('github', 'oss'), default='github')
    parser.add_argument('--timeout', type=int, default=int(os.environ.get('DOWNLOAD_TIMEOUT', '60')))
    parser.add_argument('--iterations', type=int, default=int(os.environ.get('TEST_ITERATIONS', '1')))
    parser.add_argument('--manifest', help='已由调用流程从官方 HTTPS 获取、且路径受信的发布清单')
    parser.add_argument('--deploy-local', action='store_true')
    parser.add_argument('--test-only', action='store_true')
    parser.add_argument('--verify', action='store_true', help='显式部署时强制重新下载校验，跳过已有验收结果复用')
    args = parser.parse_args(argv)
    require(1 <= args.timeout <= 300 and 1 <= args.iterations <= 10, 'timeout/iterations 超出允许范围')
    return args


def main(argv=None):
    args = parse_arguments(argv)
    if args.mode == 'validate-config':
        print(json.dumps(read_config(args.config or CONFIG_PATH), ensure_ascii=False))
        return 0
    if args.mode == 'verify':
        require(args.url, 'verify 需要 --url')
        validate_url(args.url, base=True)
    auto = os.environ.get('AUTO_DEPLOY', 'false').lower()
    require(auto in ('true', 'false'), 'AUTO_DEPLOY 仅接受 true 或 false')
    explicit_deploy = args.mode == 'optimize' and not args.test_only and (args.deploy_local or auto == 'true')
    # configure's privileged helper paths must remain inside root-controlled ancestors.
    temp_parent = '/run' if explicit_deploy and hasattr(os, 'geteuid') and os.geteuid() == 0 and Path('/run').is_dir() else None
    with tempfile.TemporaryDirectory(prefix='project-mirror-', dir=temp_parent) as temporary:
        work = Path(temporary)
        manifest, manifest_path = resolve_manifest(work, args.manifest)
        print(f"固定发布: {manifest['tag']}", file=sys.stderr)
        if args.mode == 'verify':
            item = selected_artifact(manifest)
            result = download(artifact_url(manifest, item, args.url, args.kind), work / item['file'],
                              item['sha256'], args.timeout)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        if args.mode == 'download-speed':
            return run_download_speed(manifest, work, args.timeout)
        if explicit_deploy:
            deploy_local(manifest, manifest_path, work, args.timeout, Path(__file__).parent, verify=args.verify)
            print('本地镜像配置完成；完整校验或复用此前验收的状态见上述配置结果。')
            print('本次未额外执行性能测速；没有本次下载响应时，不宣称缓存命中或速度提升。')
            print('镜像仅服务预构建发布包；默认源码更新的 git fetch 保持不变。')
            return 0
        require(not args.verify, '--verify 需要同时指定 --deploy-local 或 AUTO_DEPLOY=true')
        config = read_config()
        results = run_performance(manifest, work, args.timeout, args.iterations, config)
        if args.mode == 'optimize':
            print('当前为只测速模式；--deploy-local 或 AUTO_DEPLOY=true 才会执行本地部署。')
        report(results)
        return 1 if any(result['status'] == 'failed' for result in results) else 0


if __name__ == '__main__':
    def cancelled(signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('已取消；本次临时文件已清理。', file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(f'失败: {error}', file=sys.stderr)
        sys.exit(1)
