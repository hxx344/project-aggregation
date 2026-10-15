#!/usr/bin/env python3
"""Copy SHA256-verified immutable release artifacts to OSS; never reuse cross-tag files."""
import os
import sys

if __name__ == '__main__' and not sys.flags.isolated:
    os.execv(sys.executable, [sys.executable, '-I', os.path.abspath(__file__), *sys.argv[1:]])

import hashlib
import importlib.util
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('mirror_tools', Path(__file__).with_name('mirror-tools.py'))
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def oss_configuration(work, environment=None):
    environment = os.environ if environment is None else environment
    keys = ('ALIYUN_OSS_BUCKET', 'ALIYUN_OSS_ENDPOINT', 'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET')
    values = {key: environment.get(key, '') for key in keys}
    mirror.require(all(values.values()), '未配置完整 OSS 凭据，未执行同步')
    mirror.require(all(not re.search(r'[\r\n\x00]', value) for value in values.values()), 'OSS 配置含无效字符')
    bucket = values['ALIYUN_OSS_BUCKET']
    mirror.require(re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', bucket), 'OSS bucket 无效')
    endpoint = values['ALIYUN_OSS_ENDPOINT']
    if '://' not in endpoint:
        endpoint = 'https://' + endpoint
    endpoint = mirror.validate_url(endpoint, base=True, official=True)
    config = Path(work) / 'ossutil.conf'
    config.write_text('[Credentials]\nlanguage = EN\nendpoint = ' + endpoint +
                      '\naccessKeyID = ' + values['ALIYUN_ACCESS_KEY_ID'] +
                      '\naccessKeySecret = ' + values['ALIYUN_ACCESS_KEY_SECRET'] + '\n', encoding='utf-8')
    config.chmod(0o600)
    return bucket, config


def oss_copy(source, destination, config):
    # A private config avoids exposing AccessKeys in process arguments or exception text.
    try:
        result = subprocess.run(['ossutil', 'cp', str(source), str(destination), '--force',
                                 '--config-file', str(config)], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=600)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def remote_matches(remote, expected, config, work):
    destination = Path(work) / 'remote-check'
    try:
        return oss_copy(remote, destination, config) and sha256(destination) == expected
    finally:
        destination.unlink(missing_ok=True)


def synchronize(manifest, manifest_path, bucket, config, work):
    entries = [(item['file'], item['sha256'], item) for item in manifest['artifacts'].values()]
    # Publish the manifest last, after every object is verified at its final remote path.
    entries.append(('release-manifest.json', sha256(manifest_path), None))
    uploaded = reused = 0
    for filename, expected, item in entries:
        remote = f"oss://{bucket}/releases/{mirror.REPOSITORY}/{manifest['tag']}/{filename}"
        if remote_matches(remote, expected, config, work):
            print(f'已核验远端内容，跳过上传: {filename}')
            reused += 1
            continue
        local = Path(work) / filename
        if item is not None:
            mirror.download(mirror.artifact_url(manifest, item), local, expected, timeout=600, official=True)
        else:
            local = manifest_path
        mirror.require(sha256(local) == expected, f'上传前 SHA256 校验失败: {filename}')
        mirror.require(oss_copy(local, remote, config), f'OSS 上传失败: {filename}')
        mirror.require(remote_matches(remote, expected, config, work), f'OSS 上传后校验失败: {filename}')
        print(f'上传及远端 SHA256 校验通过: {filename}')
        uploaded += 1
    print(f'同步完成：上传 {uploaded} 个，复用已校验对象 {reused} 个。')
    return 0


def main():
    mirror.require(os.environ.get('GITHUB_REPO', mirror.REPOSITORY) == mirror.REPOSITORY,
                   '本工具仅同步工作台官方仓库')
    with tempfile.TemporaryDirectory(prefix='project-oss-release-') as temporary:
        work = Path(temporary)
        bucket, config = oss_configuration(work)
        mirror.require(shutil.which('ossutil'), '需要预先安装 ossutil')
        manifest, manifest_path = mirror.resolve_manifest(work)
        print(f"固定发布: {manifest['tag']}")
        return synchronize(manifest, manifest_path, bucket, config, work)


if __name__ == '__main__':
    def cancelled(signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, cancelled)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('已取消；临时文件已清理。', file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'同步失败: {error}', file=sys.stderr)
        sys.exit(1)
