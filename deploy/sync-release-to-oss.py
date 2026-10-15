#!/usr/bin/env python3
"""
在日本服务器上运行，自动同步 GitHub Releases 到阿里云 OSS
提供国内高速下载渠道
"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen, Request

# 配置（从环境变量读取）
GITHUB_REPO = os.getenv('GITHUB_REPO', 'hxx344/project-aggregation')
ALIYUN_OSS_BUCKET = os.getenv('ALIYUN_OSS_BUCKET')  # 例如: my-releases
ALIYUN_OSS_ENDPOINT = os.getenv('ALIYUN_OSS_ENDPOINT')  # 例如: oss-ap-northeast-1.aliyuncs.com
ALIYUN_ACCESS_KEY_ID = os.getenv('ALIYUN_ACCESS_KEY_ID')
ALIYUN_ACCESS_KEY_SECRET = os.getenv('ALIYUN_ACCESS_KEY_SECRET')

def get_latest_release():
    """获取最新发布信息"""
    url = f'https://api.github.com/repos/{GITHUB_REPO}/releases/latest'
    req = Request(url, headers={'Accept': 'application/vnd.github.v3+json'})
    with urlopen(req, timeout=30) as response:
        return json.loads(response.read())

def download_asset(url, local_path):
    """下载发布资源"""
    print(f"下载: {url}")
    req = Request(url, headers={'Accept': 'application/octet-stream'})

    with urlopen(req, timeout=600) as response:
        total = int(response.headers.get('Content-Length', 0))
        downloaded = 0

        with open(local_path, 'wb') as f:
            while True:
                chunk = response.read(1024 * 1024)  # 1MB chunks
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    percent = downloaded / total * 100
                    print(f"  进度: {percent:.1f}% ({downloaded}/{total})", end='\r')

    print(f"\n✅ 下载完成: {local_path}")

def verify_sha256(file_path, expected_sha256):
    """验证文件 SHA256"""
    sha256 = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            sha256.update(chunk)

    actual = sha256.hexdigest()
    if actual != expected_sha256:
        raise ValueError(f"SHA256 不匹配: 期望 {expected_sha256}, 实际 {actual}")

    print(f"✅ SHA256 校验通过")

def upload_to_oss(local_path, remote_path):
    """上传到阿里云 OSS"""
    if not all([ALIYUN_OSS_BUCKET, ALIYUN_OSS_ENDPOINT,
                ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET]):
        print("⚠️  未配置阿里云 OSS，跳过上传")
        return

    print(f"上传到 OSS: {remote_path}")

    # 使用 ossutil（需要预先安装）
    cmd = [
        'ossutil', 'cp',
        local_path,
        f'oss://{ALIYUN_OSS_BUCKET}/{remote_path}',
        f'--endpoint={ALIYUN_OSS_ENDPOINT}',
        f'--access-key-id={ALIYUN_ACCESS_KEY_ID}',
        f'--access-key-secret={ALIYUN_ACCESS_KEY_SECRET}',
        '--force'
    ]

    subprocess.run(cmd, check=True)
    print(f"✅ 上传完成")

    # 生成 CDN URL
    cdn_url = f"https://{ALIYUN_OSS_BUCKET}.{ALIYUN_OSS_ENDPOINT}/{remote_path}"
    print(f"📦 CDN 地址: {cdn_url}")

def main():
    print("=" * 50)
    print("GitHub Releases → 阿里云 OSS 同步器")
    print("=" * 50)
    print()

    # 1. 获取最新发布
    release = get_latest_release()
    tag = release['tag_name']
    print(f"最新版本: {tag}")
    print(f"发布时间: {release['published_at']}")
    print()

    # 2. 下载和上传所有资源
    cache_dir = Path('/tmp/release-mirror-cache')
    cache_dir.mkdir(exist_ok=True)

    for asset in release['assets']:
        name = asset['name']
        download_url = asset['browser_download_url']

        print(f"处理: {name}")

        # 下载到本地缓存
        local_path = cache_dir / name
        if not local_path.exists():
            download_asset(download_url, local_path)
        else:
            print(f"  使用缓存: {local_path}")

        # 上传到 OSS
        remote_path = f"releases/{GITHUB_REPO}/{tag}/{name}"
        upload_to_oss(local_path, remote_path)
        print()

    print("=" * 50)
    print("✅ 同步完成")
    print("=" * 50)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f"❌ 错误: {error}", file=sys.stderr)
        sys.exit(1)
