"""Production dependencies must not silently disappear from deployment archives."""
import importlib.util
import json
from pathlib import Path
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
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source'
        self.target = Path(self.temp.name) / 'target'
        self.source.mkdir()

    def package(self, name, **metadata):
        package = self.source / 'node_modules' / name
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': name, 'version': '1.0.0'}))
        return {'version': '1.0.0', **metadata}

    def test_includes_native_production_transitives_and_excludes_dev_dependencies(self):
        packages = {'node_modules/runtime': self.package('runtime'),
                    'node_modules/@vendor/native': self.package('@vendor/native', optional=True),
                    'node_modules/compiler': self.package('compiler', dev=True),
                    'node_modules/other-platform': {'version': '1.0.0', 'optional': True}}
        (self.source / 'node_modules/@vendor/native/binding.node').write_bytes(b'native-runtime')
        (self.source / 'package-lock.json').write_text(json.dumps({'packages': packages}))
        module.copy_runtime_dependencies(self.source, self.target)
        self.assertTrue((self.target / 'node_modules/@vendor/native/binding.node').is_file())
        self.assertFalse((self.target / 'node_modules/compiler').exists())

    def test_missing_required_or_wrong_version_dependencies_fail_packaging(self):
        (self.source / 'package-lock.json').write_text(json.dumps({'packages': {'node_modules/missing': {'version': '1.0.0'}}}))
        with self.assertRaisesRegex(ValueError, 'Missing production'):
            module.copy_runtime_dependencies(self.source, self.target)
        self.package('missing')
        (self.source / 'node_modules/missing/package.json').write_text('{"version":"2.0.0"}')
        with self.assertRaisesRegex(ValueError, 'version mismatch'):
            module.copy_runtime_dependencies(self.source, self.target)

    def test_x64_manifest_becomes_the_complete_release_manifest(self):
        directory = Path(self.temp.name)
        manifest = {'schema': 1, 'repository': 'hxx344/project-aggregation', 'commit': 'a' * 40,
                    'tag': 'deploy-' + 'a' * 40, 'node_version': '24.15.0',
                    'artifacts': {'linux-x64': {'file': 'x64.tar.gz'}}}
        (directory / 'release-manifest-x64.json').write_text(json.dumps(manifest))
        script = Path(__file__).with_name('merge-release-manifests.py')
        subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), str(directory)], check=True, capture_output=True)
        self.assertEqual(json.loads((directory / 'release-manifest.json').read_text()), manifest)

    def test_missing_x64_manifest_cannot_publish_an_arm64_manifest(self):
        directory = Path(self.temp.name)
        (directory / 'release-manifest-arm64.json').write_text(json.dumps({
            'artifacts': {'linux-arm64': {'file': 'arm64.tar.gz'}}}))
        script = Path(__file__).with_name('merge-release-manifests.py')
        failed = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), str(directory)], capture_output=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertFalse((directory / 'release-manifest.json').exists())

    def test_release_manifest_requires_exactly_the_x64_artifact(self):
        directory = Path(self.temp.name)
        script = Path(__file__).with_name('merge-release-manifests.py')
        for architectures in ((), ('linux-arm64',), ('linux-x64', 'linux-arm64'), ('linux-x64', 'windows-x64')):
            with self.subTest(architectures=architectures):
                manifest = {'artifacts': {arch: {'file': arch + '.tar.gz'} for arch in architectures}}
                (directory / 'release-manifest-x64.json').write_text(json.dumps(manifest))
                failed = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(script), str(directory)], capture_output=True)
                self.assertNotEqual(failed.returncode, 0)
                self.assertFalse((directory / 'release-manifest.json').exists())

    def test_runtime_dependency_links_cannot_copy_an_external_tree(self):
        self.package('external')
        target = self.source / 'node_modules/linked'
        try:
            target.symlink_to(self.source / 'node_modules/external', target_is_directory=True)
        except OSError:
            self.skipTest('Symbolic links require Windows privileges; Linux CI covers this boundary')
        (self.source / 'package-lock.json').write_text(json.dumps({'packages': {'node_modules/linked': {'version': '1.0.0'}}}))
        with self.assertRaisesRegex(ValueError, 'cannot be a link'):
            module.copy_runtime_dependencies(self.source, self.target)


if __name__ == '__main__':
    unittest.main()
