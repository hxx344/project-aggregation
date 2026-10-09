"""Package an already-built workspace; no server-side npm or build is required."""
import argparse
import gzip
import hashlib
import io
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path.cwd())
    parser.add_argument('--repository', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, default=Path('output/release'))
    args = parser.parse_args()
    source, repository = args.source.resolve(), args.repository.resolve()
    package = json.loads((source / 'package.json').read_text())
    name = package['name']
    if name not in ('project-aggregation', 'gate-crossex-arbitrage'):
        raise ValueError('Unsupported application')
    if not (source / 'dist/index.html').is_file():
        raise ValueError('Build the frontend before packaging')
    commit = subprocess.check_output(['git', '-c', f'safe.directory={repository.as_posix()}', '-C', str(repository), 'rev-parse', 'HEAD'], text=True).strip()
    inputs = ['server', 'src', 'public', 'package.json', 'package-lock.json', 'index.html',
              'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts',
              '.npmrc', '.env', '.env.local', '.env.production', '.env.production.local',
              'deploy/package-release.py', 'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']
    tree = subprocess.check_output(['git', '-c', f'safe.directory={repository.as_posix()}', '-C', str(repository), 'ls-tree', '-r', 'HEAD', '--', *inputs])
    application_key = hashlib.sha256(b'ci-node-runtime-v1\n24.15.0\n' + tree).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    filename = f'{name}-linux-any.tar.gz'
    archive_path = args.output / filename
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary)
        shutil.copytree(source / 'dist', stage / 'dist')
        shutil.copytree(source / 'server', stage / 'server', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(source / 'package.json', stage / 'package.json')
        for notice in ('LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'):
            if (source / notice).is_file():
                shutil.copy2(source / notice, stage / notice)
        if name == 'gate-crossex-arbitrage':
            lock = json.loads((source / 'package-lock.json').read_text())
            for dependency in ('ws', 'decimal.js'):
                installed = source / 'node_modules' / dependency
                version = json.loads((installed / 'package.json').read_text())['version']
                if version != lock['packages']['node_modules/' + dependency]['version']:
                    raise ValueError('Runtime dependency does not match lockfile: ' + dependency)
                shutil.copytree(installed, stage / 'node_modules' / dependency)
        (stage / '.release-commit').write_text(commit + '\n')
        (stage / '.release-application-key').write_text(application_key + '\n')
        # Stable bytes make retries inspectable; no absolute paths, links or build timestamps.
        with archive_path.open('wb') as output, gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(stage.rglob('*')):
                    if not path.is_file():
                        continue
                    if path.is_symlink() or path.suffix == '.node':
                        raise ValueError('Universal package contains a link or native binary: ' + str(path))
                    info = tarfile.TarInfo(path.relative_to(stage).as_posix())
                    content = path.read_bytes()
                    info.size, info.mode, info.mtime = len(content), 0o644, 0
                    archive.addfile(info, io.BytesIO(content))
    artifact = {'file': filename, 'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(), 'application_key': application_key}
    manifest = {'schema': 1, 'repository': 'hxx344/' + name, 'commit': commit, 'tag': 'deploy-' + commit,
                'node_version': '24.15.0', 'artifacts': {'linux-x64': artifact, 'linux-arm64': artifact}}
    (args.output / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Packaged {name} {commit[:12]}: {archive_path.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
