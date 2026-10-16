"""Package the unified application and its five embedded module runtimes."""
import argparse
import gzip
import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path
from time import perf_counter

MODULES = ('monitor', 'asset', 'crossex', 'greeks', 'aster')
# ASTER's dashboard is prebuilt static content served by its Python bridge.
# Its vinext/React build graph must not become server runtime dependencies.
IMPORTERS = ('.', 'modules/monitor', 'modules/asset', 'modules/crossex')
EXCLUDED = {'node_modules', '.git', '.venv', '.venv-aster', '.vinext', '.wrangler', '__pycache__', '.pytest_cache', '.module-cache', '.build-cache',
            '.mypy_cache', 'tests', 'test-results', 'output', 'runtime-data', '.data',
            '.env', '.env.local', '.env.production', '.env.production.local', '.env.linux'}


def is_link(path):
    """Include Windows junctions in the same boundary as POSIX symbolic links."""
    return path.is_symlink() or bool(getattr(path.lstat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def checked_ignore(excluded=()):
    def ignore(directory, names):
        ignored = set(excluded).intersection(names)
        if Path(directory).name == '.next':
            ignored |= {'cache', 'standalone'}.intersection(names)
        for name in set(names) - ignored:
            entry = Path(directory) / name
            if is_link(entry) or not (entry.is_file() or entry.is_dir()):
                raise ValueError('Runtime tree contains a link or special file: ' + str(entry))
        return ignored
    return ignore


def runtime_parser_credentials(parser_user):
    """The installed YAML package may contain code written by the build account."""
    if os.name != 'posix':
        if parser_user is not None:
            raise ValueError('--parser-user requires POSIX user switching')
        return {}
    if parser_user is None:
        if os.geteuid() == 0:
            raise ValueError('Root packaging requires an explicit non-root --parser-user')
        return {}
    import pwd
    account_name = str(parser_user)
    try:
        account = pwd.getpwuid(int(account_name)) if account_name.isdecimal() else pwd.getpwnam(account_name)
    except (KeyError, ValueError, OverflowError) as error:
        raise ValueError('Unknown runtime lock parser account: ' + account_name) from error
    if account.pw_uid == 0 or account.pw_gid == 0:
        raise ValueError('Runtime lock parser account and primary group must be non-root')
    if os.geteuid() != 0:
        if account.pw_uid != os.geteuid() or account.pw_gid != os.getegid():
            raise ValueError('Cannot select another runtime lock parser account without root')
        return {}
    return {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []}


def read_runtime_lock(source, dependency_roots, node, parser_user=None):
    credentials = runtime_parser_credentials(parser_user)
    helper = Path(__file__).with_name('pnpm-runtime-lock.mjs')
    if is_link(source / 'pnpm-lock.yaml'):
        raise ValueError('Runtime lockfile cannot be a link')
    result = subprocess.run([str(node), str(helper), str(source / 'pnpm-lock.yaml'),
                             *map(str, dependency_roots)], stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, **credentials)
    if result.returncode:
        raise ValueError('Cannot parse pnpm runtime lockfile: ' + result.stderr.strip())
    return json.loads(result.stdout)


class RuntimeDependencies:
    """Validate pnpm's installed graph, then materialize a finite npm-style tree.

    Only lockfile production edges are traversed. Package contents are copied
    once per required resolution context, without following any content links.
    A shared top-level package is reused whenever Node's resolution permits it.
    """

    def __init__(self, source, destination, lock, dependency_roots=()):
        self.source, self.destination, self.lock = source.resolve(), destination.resolve(), lock
        self.roots = tuple(dict.fromkeys([Path(root).resolve() for root in dependency_roots] + [self.source]))
        self.nodes, self.importers, self.locations = {}, {}, {}
        if str(lock.get('lockfileVersion')) != '9.0':
            raise ValueError('Unsupported pnpm lockfile version')

    @staticmethod
    def package_name(name):
        if not re.fullmatch(r'(?:@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+', name) or any(part in ('.', '..') for part in name.split('/')):
            raise ValueError('Invalid runtime package name: ' + str(name))
        return name

    def identity(self, name, reference):
        self.package_name(name)
        reference = reference['version'] if isinstance(reference, dict) else reference
        key = name + '@' + str(reference)
        if key not in self.lock['snapshots']:
            key = str(reference)  # pnpm npm: aliases refer to the real package identity.
        if key not in self.lock['snapshots']:
            raise ValueError('Missing registry runtime snapshot: ' + name + '@' + str(reference))
        base = key.split('(', 1)[0]
        package, _, version = base.rpartition('@')
        self.package_name(package)
        if base not in self.lock['packages'] or not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9_.-]+)?', version):
            raise ValueError('Unsupported runtime package identity: ' + key)
        return key, package, version

    def trusted(self, path):
        try:
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ValueError('Broken or circular runtime dependency link: ' + str(path)) from error
        if not any(resolved.is_relative_to(root) for root in self.roots):
            raise ValueError('Runtime dependency escapes trusted roots: ' + str(path))
        if not resolved.is_dir():
            raise ValueError('Runtime dependency is not a directory: ' + str(path))
        return resolved

    def installed(self, directory, name, optional=False, importer=False):
        self.package_name(name)
        if importer:
            candidates = [root / directory / 'node_modules' / name for root in self.roots]
        else:
            candidates = []
            for parent in (directory, *directory.parents):
                if parent.name != 'node_modules' and any(parent.is_relative_to(root) for root in self.roots):
                    candidates.append(parent / 'node_modules' / name)
        for candidate in candidates:
            if candidate.exists() or candidate.is_symlink():
                return self.trusted(candidate)
        if optional:
            return None
        raise ValueError('Missing production dependency: ' + name + ' from ' + str(directory))

    def visit(self, name, reference, installed):
        key, expected_name, expected_version = self.identity(name, reference)
        manifest_file = installed / 'package.json'
        if is_link(manifest_file):
            raise ValueError('Runtime package manifest cannot be a link: ' + str(manifest_file))
        manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
        if manifest.get('name') != expected_name or manifest.get('version') != expected_version:
            raise ValueError('Production dependency name/version mismatch: ' + str(installed))
        if key in self.nodes:
            if self.nodes[key]['source'] != installed:
                raise ValueError('Duplicate installed runtime snapshot: ' + key)
            return key
        snapshot = self.lock['snapshots'][key]
        edges = dict(snapshot.get('dependencies', {}))
        optional = dict(snapshot.get('optionalDependencies', {}))
        edges.update(optional)
        peer_meta = manifest.get('peerDependenciesMeta', {})
        required = set(manifest.get('dependencies', {})) - set(manifest.get('optionalDependencies', {}))
        required |= {peer for peer in manifest.get('peerDependencies', {}) if not peer_meta.get(peer, {}).get('optional')}
        if not required.issubset(edges):
            raise ValueError('Production lock snapshot misses required dependencies: ' + key + ': ' + ', '.join(sorted(required - edges.keys())))
        node = self.nodes[key] = {'name': expected_name, 'source': installed, 'edges': {}}
        for child, child_ref in sorted(edges.items()):
            optional_edge = child in optional or peer_meta.get(child, {}).get('optional', False)
            origin = self.installed(installed, child, optional_edge)
            if origin is not None:
                node['edges'][child] = self.visit(child, child_ref, origin)
        return key

    def collect(self, importers):
        for importer in importers:
            manifest_file = self.source / importer / 'package.json'
            if is_link(manifest_file):
                raise ValueError('Runtime importer manifest cannot be a link: ' + str(manifest_file))
            manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
            entry = self.lock['importers'].get(importer)
            if entry is None:
                raise ValueError('Missing runtime importer: ' + importer)
            roots = self.importers[importer] = {}
            for group in ('dependencies', 'optionalDependencies'):
                declared, locked = manifest.get(group, {}), entry.get(group, {})
                if declared.keys() != locked.keys():
                    raise ValueError('Runtime importer dependency mismatch: ' + importer + '/' + group)
                for name, reference in sorted(locked.items()):
                    if reference.get('specifier') != declared[name]:
                        raise ValueError('Runtime importer specifier mismatch: ' + importer + '/' + name)
                    installed = self.installed(importer, name, group == 'optionalDependencies', importer=True)
                    if installed is not None:
                        roots[name] = self.visit(name, reference, installed)

    def resolved_location(self, parent, name):
        for directory in (parent, *parent.parents):
            if not directory.is_relative_to(self.destination):
                break
            if directory.name != 'node_modules':
                location = directory / 'node_modules' / name
                if location in self.locations:
                    return self.locations[location]
        return None

    def place(self, location, key):
        if location in self.locations:
            if self.locations[location] != key:
                raise ValueError('Conflicting runtime package destination: ' + str(location))
            return
        if len(self.locations) >= max(1000, len(self.nodes) * 20):
            raise ValueError('Runtime dependency layout expansion limit exceeded')
        source = self.nodes[key]['source']

        def ignore(directory, names):
            # pnpm dependency links are graph edges, not package payload. Nested
            # vendored directories remain package contents and must be regular.
            return checked_ignore({'node_modules', '.bin'} if Path(directory) == source else {'.bin'})(directory, names)

        shutil.copytree(source, location, ignore=ignore)
        self.locations[location] = key

    def materialize(self):
        # Root declarations have priority; other installed production identities
        # are shared globally. A differing version/peer context is nested only
        # where Node would otherwise resolve the wrong identity.
        defaults = dict(self.importers.get('.', {}))
        for roots in self.importers.values():
            for name, key in roots.items():
                defaults.setdefault(name, key)
        for key, node in sorted(self.nodes.items()):
            defaults.setdefault(node['name'], key)
        for name, key in sorted(defaults.items()):
            self.place(self.destination / 'node_modules' / name, key)
        for importer, roots in self.importers.items():
            for name, key in roots.items():
                directory = self.destination / importer
                if self.resolved_location(directory, name) != key:
                    self.place(directory / 'node_modules' / name, key)
        queue = [(location, key, (key,)) for location, key in self.locations.items()]
        while queue:
            parent, key, ancestors = queue.pop(0)
            for name, child_key in self.nodes[key]['edges'].items():
                if self.resolved_location(parent, name) == child_key:
                    continue
                if child_key in ancestors:
                    raise ValueError('Conflicting dependency cycle cannot be materialized without links: ' + child_key)
                location = parent / 'node_modules' / name
                self.place(location, child_key)
                queue.append((location, child_key, (*ancestors, child_key)))
        # Check after all placements, because a later nested package could
        # otherwise shadow an earlier package's resolution.
        for parent, key in self.locations.items():
            for name, child_key in self.nodes[key]['edges'].items():
                if self.resolved_location(parent, name) != child_key:
                    raise ValueError('Final runtime dependency resolution mismatch: ' + key + '/' + name)
        for importer, roots in self.importers.items():
            for name, key in roots.items():
                if self.resolved_location(self.destination / importer, name) != key:
                    raise ValueError('Final runtime importer resolution mismatch: ' + importer + '/' + name)


def copy_runtime_dependencies(source, destination, dependency_roots=(), node='node', lock=None, importers=IMPORTERS,
                              parser_user=None):
    roots = tuple(dict.fromkeys([Path(root).resolve() for root in dependency_roots] + [source.resolve()]))
    if lock is None:
        lock = read_runtime_lock(source, roots, node, parser_user)
    graph = RuntimeDependencies(source, destination, lock, dependency_roots)
    graph.collect(importers)
    graph.materialize()


def stage_dependencies(source, stage, dependency_roots=(), node='node', parser_user=None):
    """Keep the existing production graph layout in one immutable source cache."""
    copy_runtime_dependencies(source, stage, dependency_roots, node, parser_user=parser_user)
    # All importers have a stable link target, including those whose complete
    # dependency set resolves from the shared root without any local conflicts.
    for importer in IMPORTERS:
        (stage / importer / 'node_modules').mkdir(parents=True, exist_ok=True)


def stage_runtime(source, stage, dependency_roots=(), node='node', parser_user=None, *, embedded_only=False):
    # Source installs publish the hub separately from its pinned Git sources and
    # verified dist cache. Do not copy those files into a stage that discards them.
    if not embedded_only:
        for relative in ('dist', 'server'):
            if is_link(source / relative):
                raise ValueError('Runtime directory cannot be a link: ' + relative)
            shutil.copytree(source / relative, stage / relative, ignore=checked_ignore({'__pycache__'}))
        shutil.copy2(source / 'package.json', stage / 'package.json')
        for notice in ('LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'):
            if (source / notice).is_file():
                shutil.copy2(source / notice, stage / notice)
    for module in MODULES:
        origin, target = source / 'modules' / module, stage / 'modules' / module
        if is_link(origin) or not origin.is_dir():
            raise ValueError('Missing embedded module: ' + module)
        shutil.copytree(origin, target, ignore=checked_ignore(EXCLUDED))
    if not embedded_only:
        copy_runtime_dependencies(source, stage, dependency_roots, node, parser_user=parser_user)
    for relative in ('modules/monitor/dist/client/index.html', 'modules/asset/.next/BUILD_ID',
                     'modules/crossex/dist/index.html', 'modules/greeks/requirements.lock',
                     'server/modules/greeks-bridge.py', 'modules/aster/requirements.lock',
                     'modules/aster/dashboard/dist/client/index.html', 'server/modules/aster.mjs', 'server/modules/python-module.mjs'):
        required_root = source if embedded_only and relative.startswith('server/') else stage
        if not (required_root / relative).is_file():
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
    partial = parser.add_mutually_exclusive_group()
    partial.add_argument('--embedded-only', action='store_true',
                         help='With --stage-only, assemble only module sources, artifacts and migration helper')
    partial.add_argument('--dependencies-only', action='store_true',
                         help='With --stage-only, assemble the validated production dependency graph')
    parser.add_argument('--dependency-root', type=Path, action='append', default=[],
                        help='Trusted installed pnpm workspace root (may be repeated)')
    parser.add_argument('--node', default=os.environ.get('NODE_BIN', 'node'))
    parser.add_argument('--parser-user', help='Non-root username or UID for dependency lock parsing; required when running as root')
    args = parser.parse_args()
    if (args.embedded_only or args.dependencies_only) and not args.stage_only:
        parser.error('--embedded-only/--dependencies-only requires --stage-only')
    runtime_parser_credentials(args.parser_user)
    source, repository = args.source.resolve(), args.repository.resolve()
    if args.stage_only:
        args.stage_only.mkdir(parents=True, exist_ok=True)
        if args.dependencies_only:
            stage_dependencies(source, args.stage_only, args.dependency_root, args.node, args.parser_user)
        else:
            stage_runtime(source, args.stage_only, args.dependency_root, args.node, args.parser_user,
                          embedded_only=args.embedded_only)
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
              'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html',
              'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts',
              '.npmrc', '.env', '.env.local', '.env.production', '.env.production.local',
              'deploy/package-release.py', 'deploy/pnpm-runtime-lock.mjs', 'deploy/migrate-modules.py',
              'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']
    tree = subprocess.check_output([*git, 'ls-tree', '-r', 'HEAD', '--', *inputs])
    application_key = hashlib.sha256(f'unified-native-pnpm-v1\n24.15.0\n11.25.0\n{architecture}\n'.encode() + tree).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    filename = f'{name}-linux-{architecture}.tar.gz'
    archive_path = args.output / filename
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary)
        started = perf_counter()
        stage_runtime(source, stage, args.dependency_root, args.node, args.parser_user)
        print(f'[package] Runtime staging: {perf_counter() - started:.1f}s', flush=True)
        (stage / '.release-commit').write_text(commit + '\n')
        (stage / '.release-application-key').write_text(application_key + '\n')
        # Level 6 avoids the expensive maximum-compression pass while retaining
        # deterministic gzip metadata and the same verified runtime contents.
        started = perf_counter()
        with archive_path.open('wb') as output, gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0, compresslevel=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(stage.rglob('*')):
                    if is_link(path):
                        raise ValueError('Archive contains an unresolved link: ' + str(path))
                    if not path.is_file():
                        continue
                    info = tarfile.TarInfo(path.relative_to(stage).as_posix())
                    content = path.read_bytes()
                    info.size, info.mode, info.mtime = len(content), 0o755 if path.stat().st_mode & 0o111 else 0o644, 0
                    archive.addfile(info, io.BytesIO(content))
        print(f'[package] Archive compression (gzip 6): {perf_counter() - started:.1f}s', flush=True)
    artifact = {'file': filename, 'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(), 'application_key': application_key}
    manifest = {'schema': 1, 'repository': 'hxx344/' + name, 'commit': commit, 'tag': 'deploy-' + commit,
                'node_version': '24.15.0', 'artifacts': {'linux-' + architecture: artifact}}
    (args.output / f'release-manifest-{architecture}.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Packaged {name} {commit[:12]} for Linux {architecture}: {archive_path.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
