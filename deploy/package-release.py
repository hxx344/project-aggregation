"""Package the unified application and its four embedded module runtimes."""
import argparse
import gzip
import hashlib
import io
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

MODULES = ('monitor', 'asset', 'crossex', 'greeks')
EXCLUDED = {'node_modules', '.git', '.venv', '__pycache__', '.pytest_cache', '.module-cache', '.build-cache',
            '.mypy_cache', 'tests', 'test-results', 'output', 'runtime-data', '.data',
            '.env', '.env.local', '.env.production', '.env.production.local', '.env.linux'}


def checked_ignore(excluded=()):
    def ignore(directory, names):
        ignored = set(excluded).intersection(names)
        if Path(directory).name == '.next':
            ignored |= {'cache', 'standalone'}.intersection(names)
        for name in set(names) - ignored:
            entry = Path(directory) / name
            if entry.is_symlink() or not (entry.is_file() or entry.is_dir()):
                raise ValueError('Runtime tree contains a link or special file: ' + str(entry))
        return ignored
    return ignore


def copy_runtime_dependencies(source, destination, allow_package_links=False):
    """Copy lockfile production packages, including platform optional/native packages."""
    lock = json.loads((source / 'package-lock.json').read_text(encoding='utf-8'))
    for relative, metadata in sorted(lock['packages'].items()):
        if not relative.startswith('node_modules/') or metadata.get('dev'):
            continue
        installed = source / relative
        if installed.is_symlink() and not allow_package_links:
            raise ValueError('Runtime dependency cannot be a link: ' + str(installed))
        if not installed.exists():
            if metadata.get('optional'):
                continue
            raise ValueError('Missing production dependency: ' + str(installed))
        expected = metadata.get('version')
        actual = json.loads((installed / 'package.json').read_text(encoding='utf-8')).get('version')
        if expected != actual:
            raise ValueError('Production dependency version mismatch: ' + str(installed))
        target = destination / relative
        if not target.exists():
            shutil.copytree(installed, target, ignore=checked_ignore({'.bin'}))


def stage_runtime(source, stage):
    for relative in ('dist', 'server'):
        if (source / relative).is_symlink():
            raise ValueError('Runtime directory cannot be a link: ' + relative)
        shutil.copytree(source / relative, stage / relative, ignore=checked_ignore({'__pycache__'}))
    shutil.copy2(source / 'package.json', stage / 'package.json')
    for notice in ('LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'):
        if (source / notice).is_file():
            shutil.copy2(source / notice, stage / notice)
    # The immutable root dependency fixture uses top-level package links.
    copy_runtime_dependencies(source, stage, allow_package_links=True)
    for module in MODULES:
        origin, target = source / 'modules' / module, stage / 'modules' / module
        if origin.is_symlink() or not origin.is_dir():
            raise ValueError('Missing embedded module: ' + module)
        shutil.copytree(origin, target, ignore=checked_ignore(EXCLUDED))
        if module != 'greeks':
            copy_runtime_dependencies(origin, target)
    for relative in ('modules/monitor/dist/client/index.html', 'modules/asset/.next/BUILD_ID',
                     'modules/crossex/dist/index.html', 'modules/greeks/requirements.lock',
                     'server/modules/greeks-bridge.py'):
        if not (stage / relative).is_file():
            raise ValueError('Missing module runtime/build output: ' + relative)
    (stage / 'deploy').mkdir()
    shutil.copy2(source / 'deploy/migrate-modules.py', stage / 'deploy/migrate-modules.py')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path.cwd())
    parser.add_argument('--repository', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, default=Path('output/release'))
    parser.add_argument('--architecture', choices=('x64', 'arm64'))
    parser.add_argument('--stage-only', type=Path)
    args = parser.parse_args()
    source, repository = args.source.resolve(), args.repository.resolve()
    if args.stage_only:
        args.stage_only.mkdir(parents=True, exist_ok=True)
        stage_runtime(source, args.stage_only)
        return
    architecture = args.architecture or {'x86_64': 'x64', 'AMD64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if platform.system() != 'Linux' or not architecture:
        raise ValueError('Release archives must be built and tested natively on Linux x64/arm64')
    actual_arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if actual_arch != architecture:
        raise ValueError('Cross-packaging native dependencies is not supported')
    package = json.loads((source / 'package.json').read_text(encoding='utf-8'))
    name = package['name']
    if name != 'project-aggregation' or not (source / 'dist/index.html').is_file():
        raise ValueError('Build the unified application before packaging')
    git = ['git', '-c', f'safe.directory={repository.as_posix()}', '-C', str(repository)]
    commit = subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip()
    inputs = ['server', 'src', 'public', 'modules', 'scripts/modules.mjs',
              'package.json', 'package-lock.json', 'index.html',
              'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts',
              '.npmrc', '.env', '.env.local', '.env.production', '.env.production.local',
              'deploy/package-release.py', 'deploy/migrate-modules.py', 'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']
    tree = subprocess.check_output([*git, 'ls-tree', '-r', 'HEAD', '--', *inputs])
    application_key = hashlib.sha256(f'unified-native-v1\n24.15.0\n{architecture}\n'.encode() + tree).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    filename = f'{name}-linux-{architecture}.tar.gz'
    archive_path = args.output / filename
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary)
        stage_runtime(source, stage)
        (stage / '.release-commit').write_text(commit + '\n')
        (stage / '.release-application-key').write_text(application_key + '\n')
        with archive_path.open('wb') as output, gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(stage.rglob('*')):
                    if path.is_symlink():
                        raise ValueError('Archive contains an unresolved link: ' + str(path))
                    if not path.is_file():
                        continue
                    info = tarfile.TarInfo(path.relative_to(stage).as_posix())
                    content = path.read_bytes()
                    info.size, info.mode, info.mtime = len(content), 0o755 if path.stat().st_mode & 0o111 else 0o644, 0
                    archive.addfile(info, io.BytesIO(content))
    artifact = {'file': filename, 'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(), 'application_key': application_key}
    manifest = {'schema': 1, 'repository': 'hxx344/' + name, 'commit': commit, 'tag': 'deploy-' + commit,
                'node_version': '24.15.0', 'artifacts': {'linux-' + architecture: artifact}}
    (args.output / f'release-manifest-{architecture}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Packaged {name} {commit[:12]} for Linux {architecture}: {archive_path.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
