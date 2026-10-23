"""Production dependencies must not silently disappear from deployment archives."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
import subprocess
import sys

spec = importlib.util.spec_from_file_location('package_release', Path(__file__).with_name('package-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeDependencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.cleanup)
        self.source = Path(self.temp.name) / 'source'
        self.target = Path(self.temp.name) / 'target'
        self.source.mkdir()
        self.install_root = self.source
        self.lock = {'lockfileVersion': '9.0', 'importers': {}, 'packages': {}, 'snapshots': {}}
        self.packages = {}

    def link(self, path, target):
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.symlink_to(os.path.relpath(target, path.parent), target_is_directory=target.is_dir())
        except OSError:
            if os.name == 'nt' and target.is_dir():
                import _winapi
                _winapi.CreateJunction(str(target.resolve()), str(path))
                return
            self.skipTest('Symbolic links require Windows privileges; Linux CI covers this boundary')

    @staticmethod
    def unlink(path):
        if os.name == 'nt' and not path.is_symlink() and stat.S_ISDIR(path.lstat().st_mode):
            path.rmdir()
        else:
            path.unlink()

    def cleanup(self):
        # Python 3.11's rmtree leaves dangling junctions behind after a source
        # directory is moved. Remove only links inside this fixture first.
        root = Path(self.temp.name).resolve()
        for directory, names, files in os.walk(root, topdown=True, followlinks=False):
            for name in names[:] + files:
                entry = Path(directory) / name
                if module.is_link(entry):
                    self.assertTrue(entry.is_relative_to(root))
                    self.unlink(entry)
                    if name in names:
                        names.remove(name)
        self.temp.cleanup()

    def move(self, path):
        target = path.with_name(path.name + '-moved')
        path.rename(target)
        self.addCleanup(target.rename, path)

    def package(self, name, version='1.0.0', context='', code=None):
        key = f'{name}@{version}{context}'
        package = self.install_root / 'node_modules/.pnpm' / hashlib.sha256(key.encode()).hexdigest()[:12] / 'node_modules' / name
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': name, 'version': version}))
        (package / 'index.js').write_text(code or f'module.exports = {json.dumps(version)};')
        self.lock['packages'][f'{name}@{version}'] = {}
        self.lock['snapshots'][key] = {}
        self.packages[key] = package
        return key

    def connect(self, parent, child, name=None, optional=False, peer=False, installed=True):
        name = name or json.loads((self.packages[child] / 'package.json').read_text())['name']
        group = 'optionalDependencies' if optional and not peer else 'dependencies'
        self.lock['snapshots'][parent].setdefault(group, {})[name] = child
        file = self.packages[parent] / 'package.json'
        manifest = json.loads(file.read_text())
        manifest.setdefault('peerDependencies' if peer else group, {})[name] = '*'
        if peer and optional:
            manifest.setdefault('peerDependenciesMeta', {})[name] = {'optional': True}
        file.write_text(json.dumps(manifest))
        if installed:
            self.link(self.packages[parent].parent / name, self.packages[child])

    def importer(self, dependencies, optional=None, dev=None, importer='.'):
        entry, manifest = {}, {}
        for group, values in (('dependencies', dependencies), ('optionalDependencies', optional), ('devDependencies', dev)):
            if values:
                entry[group] = {name: {'specifier': '*', 'version': key} for name, key in values.items()}
                manifest[group] = {name: '*' for name in values}
                for name, key in values.items():
                    self.link(self.source / importer / 'node_modules' / name, self.packages[key])
        directory = self.source / importer
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'package.json').write_text(json.dumps(manifest))
        self.lock['importers'][importer] = entry

    def copy(self, dependency_roots=()):
        module.copy_runtime_dependencies(self.source, self.target, dependency_roots, lock=self.lock,
                                         importers=tuple(self.lock['importers']))

    def run_node(self, script, cwd=None):
        return subprocess.run(['node', '-e', script], cwd=cwd or self.target, check=True, text=True, capture_output=True).stdout.strip()

    def test_native_optional_transitive_peer_and_development_closure(self):
        runtime = self.package('runtime')
        native = self.package('@vendor/native')
        other_platform = self.package('@vendor/other-platform')
        peer = self.package('react')
        compiler = self.package('compiler')
        compiler_child = self.package('compiler-helper')
        self.connect(runtime, native, optional=True)
        self.connect(runtime, other_platform, optional=True, installed=False)
        self.connect(runtime, peer, peer=True)
        self.connect(compiler, compiler_child)
        (self.packages[native] / 'binding.node').write_bytes(b'native-runtime')
        self.importer({'runtime': runtime}, dev={'compiler': compiler})
        self.copy()
        self.assertTrue((self.target / 'node_modules/@vendor/native/binding.node').is_file())
        self.assertTrue((self.target / 'node_modules/react/package.json').is_file())
        for name in ('compiler', 'compiler-helper', '@vendor/other-platform', '.pnpm'):
            self.assertFalse((self.target / 'node_modules' / name).exists())
        self.assertFalse(any(module.is_link(path) for path in self.target.rglob('*')))

    def prepare_five_modules(self):
        runtime, vinext = self.package('runtime'), self.package('vinext')
        for importer in module.IMPORTERS:
            self.importer({'runtime': runtime}, importer=importer)
        self.importer({'vinext': vinext}, importer='modules/aster/dashboard')
        for name in module.MODULES:
            (self.source / 'modules' / name).mkdir(parents=True, exist_ok=True)
        required = ('dist/index.html', 'server/modules/greeks-bridge.py', 'server/modules/aster.mjs', 'server/modules/python-module.mjs',
                    'modules/monitor/dist/client/index.html', 'modules/asset/.next/BUILD_ID',
                    'modules/crossex/dist/index.html', 'modules/greeks/requirements.lock',
                    'modules/aster/dashboard/dist/client/index.html', 'modules/aster/requirements.lock',
                    'modules/aster/trading/server.py', 'deploy/migrate-modules.py', 'deploy/diagnose-aster-margin.py')
        for name in required:
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('runtime')
        return required

    def test_five_module_package_includes_aster_static_and_python_without_vinext(self):
        from unittest.mock import patch
        required = self.prepare_five_modules()
        with patch.object(module, 'read_runtime_lock', return_value=self.lock):
            module.stage_runtime(self.source, self.target)
        for name in required:
            self.assertTrue((self.target / name).is_file(), name)
        self.assertFalse((self.target / 'node_modules/vinext').exists())
        self.assertFalse((self.target / 'modules/aster/dashboard/node_modules').exists())
        self.assertTrue((self.target / 'node_modules/runtime/package.json').is_file())

    def test_embedded_stage_omits_hub_outputs_and_dependency_materialization(self):
        from unittest.mock import patch
        required = self.prepare_five_modules()
        # The source installer does not hydrate the hub dist for this operation.
        shutil.rmtree(self.source / 'dist')
        with patch.object(module, 'copy_runtime_dependencies', side_effect=AssertionError('Dependencies must be cached separately')):
            module.stage_runtime(self.source, self.target, embedded_only=True)
        self.assertEqual({'modules', 'deploy'}, {p.name for p in self.target.iterdir()})
        for name in required:
            if name.startswith(('modules/', 'deploy/')):
                self.assertTrue((self.target / name).is_file(), name)
        self.assertFalse((self.target / 'node_modules').exists())

    def test_embedded_stage_still_rejects_missing_bridge(self):
        from unittest.mock import patch
        self.prepare_five_modules()
        (self.source / 'server/modules/aster.mjs').unlink()
        with patch.object(module, 'read_runtime_lock', return_value=self.lock):
            with self.assertRaisesRegex(ValueError, 'Missing module runtime/build output: server/modules/aster.mjs'):
                module.stage_runtime(self.source, self.target, embedded_only=True)

    def test_embedded_stage_rejects_missing_margin_diagnostic(self):
        self.prepare_five_modules()
        (self.source / 'deploy/diagnose-aster-margin.py').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing trusted Aster margin diagnostic'):
            module.stage_runtime(self.source, self.target, embedded_only=True)

    def test_embedded_stage_rejects_linked_margin_diagnostic(self):
        self.prepare_five_modules()
        diagnostic = self.source / 'deploy/diagnose-aster-margin.py'; diagnostic.unlink()
        outside = self.source.parent / 'outside-diagnostic.py'; outside.write_text('must not be packaged')
        self.link(diagnostic, outside)
        with self.assertRaisesRegex(ValueError, 'Missing trusted Aster margin diagnostic'):
            module.stage_runtime(self.source, self.target, embedded_only=True)

    def test_ci_application_key_tracks_only_committed_diagnostic_changes(self):
        diagnostic = self.source / 'deploy/diagnose-aster-margin.py'
        diagnostic.parent.mkdir(); diagnostic.write_text('original diagnostic')
        git = ['git', '-C', str(self.source)]
        def run(*args):
            subprocess.run([*git, *args], check=True, capture_output=True)
        run('init', '-q'); run('config', 'user.name', 'fixture'); run('config', 'user.email', 'fixture@example.invalid')
        run('config', 'core.autocrlf', 'false'); run('add', '.'); run('commit', '-qm', 'original')
        before = module.application_key(git, 'x64')
        diagnostic.write_text('updated diagnostic')
        self.assertEqual(module.application_key(git, 'x64'), before, 'uncommitted input cannot change a fixed release')
        run('add', '.'); run('commit', '-qm', 'diagnostic update')
        changed = module.application_key(git, 'x64'); self.assertNotEqual(changed, before)
        (self.source / 'README.md').write_text('documentation only'); run('add', '.'); run('commit', '-qm', 'docs')
        self.assertEqual(module.application_key(git, 'x64'), changed)

    def test_dependency_stage_has_fixed_importer_targets_and_validated_production_graph(self):
        from unittest.mock import patch
        self.prepare_five_modules()
        with patch.object(module, 'read_runtime_lock', return_value=self.lock):
            module.stage_dependencies(self.source, self.target)
        self.assertEqual({'modules', 'node_modules'}, {p.name for p in self.target.iterdir()})
        for importer in module.IMPORTERS:
            self.assertTrue((self.target / importer / 'node_modules').is_dir())
        self.assertTrue((self.target / 'node_modules/runtime/package.json').is_file())
        self.assertFalse((self.target / 'node_modules/vinext').exists())
        shutil.rmtree(self.target)
        self.unlink(self.source / 'node_modules/runtime')
        with patch.object(module, 'read_runtime_lock', return_value=self.lock):
            with self.assertRaisesRegex(ValueError, 'Missing production dependency: runtime'):
                module.stage_dependencies(self.source, self.target)

    def test_embedded_only_option_cannot_change_full_archive_contract(self):
        for flag in ('--embedded-only', '--dependencies-only'):
            with self.subTest(flag=flag):
                result = subprocess.run([sys.executable, str(module.__file__), flag],
                                        capture_output=True, text=True)
                self.assertNotEqual(0, result.returncode)
                self.assertIn('requires --stage-only', result.stderr)

    def test_fixed_importer_links_preserve_shared_and_conflicting_dependency_resolution(self):
        from unittest.mock import patch
        shared1 = self.package('shared', code='module.exports = "first";')
        shared2 = self.package('shared', '2.0.0', code='module.exports = "second";')
        root_only = self.package('root-only', code='module.exports = "root";')
        peer_code = 'module.exports = [require("shared"), require("root-only")];'
        consumer1 = self.package('consumer', context='(shared@1.0.0)', code=peer_code)
        consumer2 = self.package('consumer', context='(shared@2.0.0)', code=peer_code)
        for consumer, shared in ((consumer1, shared1), (consumer2, shared2)):
            self.connect(consumer, shared, peer=True)
            self.connect(consumer, root_only)
        nested = self.package('nested', code='module.exports = require("shared");')
        self.connect(nested, shared2)
        for importer in module.IMPORTERS:
            deps = {'shared': shared1, 'consumer': consumer1, 'root-only': root_only}
            if importer == 'modules/asset':
                deps = {'shared': shared2, 'consumer': consumer2, 'nested': nested}
            self.importer(deps, importer=importer)
        with patch.object(module, 'read_runtime_lock', return_value=self.lock):
            module.stage_dependencies(self.source, self.target)
        self.assertTrue((self.target / 'modules/asset/node_modules/consumer').is_dir())
        self.assertFalse((self.target / 'modules/asset/node_modules/root-only').exists())
        self.assertFalse((self.target / 'modules/asset/node_modules/consumer/node_modules/root-only').exists())
        release = self.source.parent / 'release'
        for importer in module.IMPORTERS:
            directory = release / importer
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'package.json').write_text('{}')
            self.link(directory / 'node_modules', self.target / importer / 'node_modules')
        # Only the immutable production layout remains available to the release.
        self.move(self.source)
        script = '''
          const { createRequire } = require('node:module');
          const { resolve } = require('node:path');
          const root = createRequire(resolve('package.json'));
          const asset = createRequire(resolve('modules/asset/package.json'));
          const monitor = createRequire(resolve('modules/monitor/package.json'));
          console.log(JSON.stringify([root('consumer'), asset('consumer'), asset('nested'), monitor('shared')]));
        '''
        self.assertEqual([['first', 'root'], ['second', 'root'], 'second', 'first'],
                         json.loads(self.run_node(script, release)))
        (release / 'modules/asset/check.mjs').write_text(
            'import consumer from "consumer"; import nested from "nested"; console.log(JSON.stringify([consumer,nested]));')
        result = subprocess.run(['node', str(release / 'modules/asset/check.mjs')],
                                cwd=release, check=True, capture_output=True, text=True)
        self.assertEqual([['second', 'root'], 'second'], json.loads(result.stdout))

    def test_missing_required_direct_and_transitive_dependencies_fail(self):
        runtime, child = self.package('runtime'), self.package('required-child')
        self.connect(runtime, child)
        self.importer({'runtime': runtime})
        direct = self.source / 'node_modules/runtime'
        self.unlink(direct)
        with self.assertRaisesRegex(ValueError, 'Missing production dependency: runtime'):
            self.copy()
        self.link(direct, self.packages[runtime])
        self.unlink(self.packages[runtime].parent / 'required-child')
        with self.assertRaisesRegex(ValueError, 'Missing production dependency: required-child'):
            self.copy()

    def test_wrong_name_or_version_cannot_be_copied(self):
        runtime = self.package('runtime')
        self.importer({'runtime': runtime})
        for name, version in (('different', '1.0.0'), ('runtime', '2.0.0')):
            with self.subTest(name=name, version=version):
                (self.packages[runtime] / 'package.json').write_text(json.dumps({'name': name, 'version': version}))
                with self.assertRaisesRegex(ValueError, 'name/version mismatch'):
                    self.copy()

    def test_version_conflicts_and_peer_contexts_resolve_after_source_moves(self):
        shared1, shared2 = self.package('shared'), self.package('shared', '2.0.0')
        code = 'module.exports = require("shared");'
        first = self.package('consumer', context='(shared@1.0.0)', code=code)
        second = self.package('consumer', context='(shared@2.0.0)', code=code)
        self.connect(first, shared1, peer=True)
        self.connect(second, shared2, peer=True)
        self.importer({'consumer': first, 'shared': shared1})
        self.importer({'consumer': second, 'shared': shared2}, importer='modules/asset')
        self.copy()
        self.move(self.source)
        self.assertEqual(self.run_node('console.log(require("consumer"))'), '1.0.0')
        self.assertEqual(self.run_node('console.log(require("consumer"))', self.target / 'modules/asset'), '2.0.0')
        self.assertFalse(any(module.is_link(path) for path in self.target.rglob('*')))

    def test_shared_importers_copy_one_package(self):
        runtime = self.package('runtime')
        self.importer({'runtime': runtime})
        self.importer({'runtime': runtime}, importer='modules/asset')
        self.copy()
        self.assertEqual(len(list(self.target.rglob('package.json'))), 1)
        self.assertFalse((self.target / 'modules/asset/node_modules/runtime').exists())

    def test_cycles_terminate_and_preserve_node_resolution(self):
        first = self.package('first', code='exports.name="first"; exports.other=()=>require("second").name;')
        second = self.package('second', code='exports.name="second"; exports.other=()=>require("first").name;')
        self.connect(first, second)
        self.connect(second, first)
        self.importer({'first': first})
        self.copy()
        self.move(self.source)
        self.assertEqual(self.run_node('console.log(require("first").other(), require("second").other())'), 'second first')
        self.assertEqual(len(list(self.target.rglob('package.json'))), 2)

    def test_conflicting_cycles_fail_with_bounded_expansion(self):
        a1, a2 = self.package('a'), self.package('a', '2.0.0')
        b1, b2 = self.package('b'), self.package('b', '2.0.0')
        for parent, child in ((a1, b1), (b1, a2), (a2, b2), (b2, a1)):
            self.connect(parent, child)
        self.importer({'a': a1, 'b': b1})
        with self.assertRaisesRegex(ValueError, 'Conflicting dependency cycle'):
            self.copy()
        self.assertLess(len(list(self.target.rglob('package.json'))), 15)

    def test_external_cache_is_allowed_only_when_explicitly_trusted(self):
        cache = self.source.with_name('dependency-cache')
        cache.mkdir()
        self.install_root = cache
        runtime = self.package('runtime')
        self.importer({'runtime': runtime})
        self.link(cache / 'node_modules/runtime', self.packages[runtime])
        with self.assertRaisesRegex(ValueError, 'escapes trusted roots'):
            self.copy()
        self.copy([cache])
        self.move(cache)
        self.move(self.source)
        self.assertEqual(self.run_node('console.log(require("runtime"))'), '1.0.0')

    def test_explicit_cache_works_without_source_dependency_links(self):
        cache = self.source.with_name('dependency-cache')
        cache.mkdir()
        self.install_root = cache
        runtime = self.package('runtime')
        self.importer({'runtime': runtime})
        self.unlink(self.source / 'node_modules/runtime')
        self.link(cache / 'node_modules/runtime', self.packages[runtime])
        self.copy([cache])
        self.assertEqual(self.run_node('console.log(require("runtime"))'), '1.0.0')

    def test_transitive_dependency_cannot_escape_trusted_roots(self):
        runtime = self.package('runtime')
        external = self.source.with_name('outside')
        external.mkdir()
        self.install_root = external
        child = self.package('child')
        self.connect(runtime, child)
        self.importer({'runtime': runtime})
        with self.assertRaisesRegex(ValueError, 'escapes trusted roots'):
            self.copy()

    def test_unsafe_scoped_name_cannot_escape_package_directory(self):
        for name in ('../escape', '@scope/..', '@scope/.', '/absolute', 'name/subpath'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Invalid runtime package name'):
                module.RuntimeDependencies.package_name(name)

    def test_lock_parser_reads_from_trusted_build_dependency(self):
        (self.source / 'pnpm-lock.yaml').write_text(json.dumps(self.lock))
        repository = Path(__file__).resolve().parent.parent
        if not (repository / 'node_modules/yaml/package.json').is_file():
            self.skipTest('Lock parser integration is covered by the app job after pnpm install')
        self.assertEqual(module.read_runtime_lock(self.source, [repository], 'node'), self.lock)

    def test_package_content_links_and_special_manifest_links_are_rejected(self):
        runtime = self.package('runtime')
        self.importer({'runtime': runtime})
        real_file = self.packages[runtime] / 'index.js'
        link = self.packages[runtime] / 'unexpected.js'
        self.link(link, real_file)
        with self.assertRaisesRegex(ValueError, 'link or special file'):
            self.copy()

    def test_internal_directory_cycle_and_external_payload_links_are_rejected(self):
        runtime = self.package('runtime')
        self.importer({'runtime': runtime})
        link = self.packages[runtime] / 'loop'
        self.link(link, self.packages[runtime])
        with self.assertRaisesRegex(ValueError, 'link or special file'):
            self.copy()
        self.unlink(link)
        if self.target.exists():
            shutil.rmtree(self.target)
        self.link(link, self.source.parent)
        with self.assertRaisesRegex(ValueError, 'link or special file'):
            self.copy()

    def test_missing_peer_or_missing_locked_manifest_dependency_fails(self):
        runtime, peer = self.package('runtime'), self.package('peer')
        self.connect(runtime, peer, peer=True, installed=False)
        self.importer({'runtime': runtime})
        with self.assertRaisesRegex(ValueError, 'Missing production dependency: peer'):
            self.copy()
        self.lock['snapshots'][runtime]['dependencies'].clear()
        with self.assertRaisesRegex(ValueError, 'snapshot misses required'):
            self.copy()

    def test_importer_manifest_must_match_lock(self):
        runtime = self.package('runtime')
        self.importer({'runtime': runtime})
        (self.source / 'package.json').write_text('{"dependencies":{"extra":"*"}}')
        with self.assertRaisesRegex(ValueError, 'importer dependency mismatch'):
            self.copy()

    def release_manifest_fixture(self, directory, architectures=('linux-x64',)):
        directory.mkdir(parents=True, exist_ok=True)
        manifest = {'schema': 1, 'repository': 'hxx344/project-aggregation', 'commit': 'a' * 40,
                    'tag': 'deploy-' + 'a' * 40, 'node_version': '24.15.0',
                    'artifacts': {}}
        for architecture in architectures:
            artifact = directory / (architecture.removeprefix('linux-') + '.tar.gz')
            artifact.write_bytes(('archive fixture: ' + architecture).encode())
            manifest['artifacts'][architecture] = {
                'file': artifact.name, 'sha256': hashlib.new('sha256', artifact.read_bytes()).hexdigest(),
            }
        return manifest

    def test_x64_manifest_becomes_the_complete_release_manifest(self):
        directory = Path(self.temp.name)
        manifest = self.release_manifest_fixture(directory)
        (directory / 'release-manifest-x64.json').write_text(json.dumps(manifest))
        script = Path(__file__).with_name('merge-release-manifests.py')
        subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), str(directory)], check=True, capture_output=True)
        self.assertEqual(json.loads((directory / 'release-manifest.json').read_text()), manifest)

    def test_no_arguments_keep_ci_release_directory_and_x64_only_default(self):
        directory = Path(self.temp.name) / 'output/release'
        manifest = self.release_manifest_fixture(directory)
        (directory / 'release-manifest-x64.json').write_text(json.dumps(manifest))
        # Historical arm64 files must not expand the default architecture set.
        (directory / 'release-manifest-arm64.json').write_text('unrelated historical file')
        script = Path(__file__).with_name('merge-release-manifests.py').resolve()
        subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script)],
                       cwd=self.temp.name, check=True, capture_output=True)
        self.assertEqual(json.loads((directory / 'release-manifest.json').read_text()), manifest)

    def test_merge_rejects_missing_or_tampered_actual_artifact(self):
        script = Path(__file__).with_name('merge-release-manifests.py')
        for fault in ('missing', 'tampered'):
            with self.subTest(fault=fault):
                directory = Path(self.temp.name) / fault
                manifest = self.release_manifest_fixture(directory)
                (directory / 'release-manifest-x64.json').write_text(json.dumps(manifest))
                artifact = directory / 'x64.tar.gz'
                if fault == 'missing':
                    artifact.unlink()
                else:
                    artifact.write_bytes(b'tampered')
                failed = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), str(directory)],
                                        capture_output=True, text=True)
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn('Missing artifact' if fault == 'missing' else 'Artifact hash mismatch', failed.stderr)
                self.assertFalse((directory / 'release-manifest.json').exists())

    def test_missing_x64_manifest_cannot_publish_an_arm64_manifest(self):
        directory = Path(self.temp.name)
        manifest = self.release_manifest_fixture(directory, ('linux-arm64',))
        (directory / 'release-manifest-arm64.json').write_text(json.dumps(manifest))
        script = Path(__file__).with_name('merge-release-manifests.py')
        failed = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), str(directory)], capture_output=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn(b'release-manifest-x64.json', failed.stderr)
        self.assertFalse((directory / 'release-manifest.json').exists())

    def test_release_manifest_requires_exactly_the_x64_artifact(self):
        directory = Path(self.temp.name)
        script = Path(__file__).with_name('merge-release-manifests.py')
        for architectures in ((), ('linux-arm64',), ('linux-x64', 'linux-arm64'), ('linux-x64', 'windows-x64')):
            with self.subTest(architectures=architectures):
                manifest = self.release_manifest_fixture(directory, architectures)
                (directory / 'release-manifest-x64.json').write_text(json.dumps(manifest))
                failed = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), str(directory)], capture_output=True)
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn(b'Invalid release identity or architecture', failed.stderr)
                self.assertFalse((directory / 'release-manifest.json').exists())

if __name__ == '__main__':
    unittest.main()
