"""Portable cache integrity checks; Linux CI also exercises POSIX special files."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
HELPER = Path(__file__).with_name('build-artifact-cache.py').resolve()
spec = importlib.util.spec_from_file_location('build_artifact_cache', HELPER)
cache_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache_tool)
KEY = '1234567890abcdef' * 4


class BuildArtifactCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.cleanup)
        self.artifact = self.root / 'build-one' / 'dist'
        self.artifact.mkdir(parents=True)
        self.cache = self.root / 'cache'
        self.workspace = self.root / 'build-two'
        self.workspace.mkdir()
        self.destination = self.workspace / 'dist'
        self.write(self.artifact, 'index.html', '<script src="assets/app.js"></script>')
        self.write(self.artifact, 'assets/app.js', 'original application chunk')
        self.write(self.artifact, 'server/routes/page.js', 'original server page')
        (self.artifact / 'empty').mkdir()
        self.links = []

    def cleanup(self):
        for path in reversed(self.links):
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if cache_tool.is_link(info):
                if os.name == 'nt' and stat.S_ISDIR(info.st_mode) and not path.is_symlink():
                    path.rmdir()
                else:
                    path.unlink()
        self.temp.cleanup()

    def write(self, root, relative, content):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def link(self, path, target, *, junction=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        if junction:
            if os.name != 'nt':
                self.skipTest('Windows junctions are covered by Windows checks')
            import _winapi
            _winapi.CreateJunction(str(target), str(path))
        else:
            try:
                path.symlink_to(target, target_is_directory=target.is_dir())
            except OSError:
                if os.name == 'nt' and target.is_dir():
                    import _winapi
                    _winapi.CreateJunction(str(target), str(path))
                else:
                    self.skipTest('Symbolic links require Windows privileges; Linux CI covers this case')
        self.links.append(path)

    def store(self):
        cache_tool.store(self.artifact, self.cache, KEY)

    def manifest(self):
        return json.loads((self.cache / 'manifest.json').read_text(encoding='utf-8'))

    def write_manifest(self, manifest):
        (self.cache / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')

    def assert_no_stage(self):
        self.assertEqual([], list(self.root.glob('.cache.tmp-*')))
        self.assertEqual([], list(self.root.glob('.cache.old-*')))

    def run_cli(self, *args, cwd=None, env=None):
        return subprocess.run([sys.executable, '-I', str(HELPER), *map(str, args)],
                              text=True, capture_output=True, cwd=cwd, env=env)

    def test_cli_cache_survives_original_temporary_workspace(self):
        expected = cache_tool.inspect_tree(self.artifact)
        result = self.run_cli('store', self.artifact, self.cache, KEY)
        self.assertEqual(0, result.returncode, result.stderr)
        shutil.rmtree(self.artifact.parent)
        self.assertEqual(0, self.run_cli('verify', self.cache, KEY).returncode)
        result = self.run_cli('restore', self.cache, KEY, self.destination)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(expected, cache_tool.inspect_tree(self.destination))
        self.assertTrue((self.destination / 'empty').is_dir())
        self.assertEqual({'artifact', 'manifest.json'}, {path.name for path in self.cache.iterdir()})
        self.assertFalse((self.destination / 'manifest.json').exists())
        self.assert_no_stage()

    def test_manifest_records_every_file_and_directory(self):
        self.store()
        manifest = self.manifest()
        self.assertEqual(1, manifest['schema'])
        self.assertEqual(KEY, manifest['key'])
        self.assertEqual('dist', manifest['artifact_name'])
        self.assertEqual(['assets', 'empty', 'server', 'server/routes'], manifest['directories'])
        self.assertEqual(['assets/app.js', 'index.html', 'server/routes/page.js'],
                         [entry['path'] for entry in manifest['files']])
        self.assertTrue(all(len(entry['sha256']) == 64 for entry in manifest['files']))

    def test_non_entrypoint_tampering_fails_and_does_not_restore(self):
        self.store()
        path = self.cache / 'artifact/server/routes/page.js'
        old = path.read_text(encoding='utf-8')
        path.write_text('X' * len(old), encoding='utf-8')
        result = self.run_cli('verify', self.cache, KEY)
        self.assertNotEqual(0, result.returncode)
        self.assertIn('server/routes/page.js', result.stderr)
        with self.assertRaisesRegex(cache_tool.CacheError, 'digest'):
            cache_tool.restore(self.cache, KEY, self.destination)
        self.assertFalse(self.destination.exists())

    def test_missing_non_entrypoint_file_fails(self):
        self.store()
        (self.cache / 'artifact/assets/app.js').unlink()
        with self.assertRaisesRegex(cache_tool.CacheError, 'file inventory mismatch.*missing='):
            cache_tool.verify(self.cache, KEY)

    def test_added_file_fails_even_when_entrypoint_is_unchanged(self):
        self.store()
        self.write(self.cache, 'artifact/server/routes/unlisted.js', 'extra')
        with self.assertRaisesRegex(cache_tool.CacheError, 'file inventory mismatch.*unexpected='):
            cache_tool.verify(self.cache, KEY)

    def test_missing_and_added_empty_directories_fail(self):
        self.store()
        empty = self.cache / 'artifact/empty'
        empty.rmdir()
        with self.assertRaisesRegex(cache_tool.CacheError, 'directory inventory mismatch'):
            cache_tool.verify(self.cache, KEY)
        empty.mkdir()
        (self.cache / 'artifact/extra-empty').mkdir()
        with self.assertRaisesRegex(cache_tool.CacheError, 'directory inventory mismatch'):
            cache_tool.verify(self.cache, KEY)

    def test_invalid_or_wrong_key_is_rejected_without_changes(self):
        for invalid in ('', '../unsafe', 'a' * 63, 'g' * 64, 'a' * 65):
            with self.subTest(key=invalid):
                with self.assertRaisesRegex(cache_tool.CacheError, '64 hexadecimal'):
                    cache_tool.store(self.artifact, self.cache, invalid)
                self.assertFalse(self.cache.exists())
        self.store()
        with self.assertRaisesRegex(cache_tool.CacheError, 'key mismatch'):
            cache_tool.verify(self.cache, 'f' * 64)
        cache_tool.verify(self.cache, KEY.upper())

    def test_missing_or_malformed_cache_reports_failure(self):
        result = self.run_cli('verify', self.cache, KEY)
        self.assertNotEqual(0, result.returncode)
        self.assertIn('missing path', result.stderr)
        self.store()
        (self.cache / 'manifest.json').write_text('{broken', encoding='utf-8')
        result = self.run_cli('verify', self.cache, KEY)
        self.assertNotEqual(0, result.returncode)
        self.assertIn('cannot read manifest', result.stderr)

    def test_unknown_top_level_cache_content_is_rejected(self):
        self.store()
        self.write(self.cache, 'unlisted', 'extra')
        with self.assertRaisesRegex(cache_tool.CacheError, 'exactly'):
            cache_tool.verify(self.cache, KEY)

    def test_manifest_traversal_absolute_and_ambiguous_paths_are_rejected(self):
        self.store()
        manifest = self.manifest()
        for invalid in ('../outside', '/absolute', 'a/../../outside', 'a\\..\\outside',
                        'C:/outside', 'a//b', './a', 'a/./b', 'a/'):
            with self.subTest(path=invalid):
                changed = json.loads(json.dumps(manifest))
                changed['files'][0]['path'] = invalid
                self.write_manifest(changed)
                with self.assertRaisesRegex(cache_tool.CacheError, 'invalid relative artifact path'):
                    cache_tool.verify(self.cache, KEY)
                self.assertFalse(self.destination.exists())

    def test_duplicate_manifest_fields_paths_and_missing_parent_are_rejected(self):
        self.store()
        manifest = self.manifest()
        text = json.dumps(manifest)
        (self.cache / 'manifest.json').write_text('{"schema":1,' + text[1:], encoding='utf-8')
        with self.assertRaisesRegex(cache_tool.CacheError, 'duplicate manifest field'):
            cache_tool.verify(self.cache, KEY)
        duplicated = json.loads(text)
        duplicated['files'].append(duplicated['files'][0])
        self.write_manifest(duplicated)
        with self.assertRaisesRegex(cache_tool.CacheError, 'duplicate manifest path'):
            cache_tool.verify(self.cache, KEY)
        manifest['directories'].remove('assets')
        self.write_manifest(manifest)
        with self.assertRaisesRegex(cache_tool.CacheError, 'missing parent directory'):
            cache_tool.verify(self.cache, KEY)

    def test_next_excludes_only_root_cache_and_standalone(self):
        self.artifact = self.artifact.rename(self.artifact.with_name('.next'))
        self.write(self.artifact, 'BUILD_ID', 'fixture-build')
        self.write(self.artifact, 'cache/transient.bin', 'cache')
        self.write(self.artifact, 'standalone/server.js', 'standalone')
        self.write(self.artifact, 'server/cache/required.js', 'required cache name')
        self.write(self.artifact, 'server/standalone/required.js', 'required standalone name')
        self.store()
        for ignored in ('cache', 'standalone'):
            self.assertFalse((self.cache / 'artifact' / ignored).exists())
        self.assertTrue((self.cache / 'artifact/server/cache/required.js').is_file())
        self.assertTrue((self.cache / 'artifact/server/standalone/required.js').is_file())
        cache_tool.restore(self.cache, KEY, self.destination)
        self.assertTrue((self.destination / 'BUILD_ID').is_file())
        self.write(self.cache, 'artifact/cache/extra', 'must not be ignored when verifying cache')
        with self.assertRaisesRegex(cache_tool.CacheError, 'directory inventory mismatch'):
            cache_tool.verify(self.cache, KEY)

    def test_dist_does_not_exclude_cache_or_standalone(self):
        self.write(self.artifact, 'cache/required', 'cache')
        self.write(self.artifact, 'standalone/required', 'standalone')
        self.store()
        self.assertTrue((self.cache / 'artifact/cache/required').is_file())
        self.assertTrue((self.cache / 'artifact/standalone/required').is_file())

    def test_excluded_next_root_entry_cannot_be_a_link(self):
        self.artifact = self.artifact.rename(self.artifact.with_name('.next'))
        self.link(self.artifact / 'cache', self.workspace)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            self.store()
        self.assertFalse(self.cache.exists())

    def test_artifact_directory_link_is_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        sentinel = self.write(outside, 'sentinel', 'keep')
        self.link(self.artifact / 'assets/linked', outside)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            self.store()
        self.assertFalse(self.cache.exists())
        self.assertEqual('keep', sentinel.read_text(encoding='utf-8'))
        self.assert_no_stage()

    def test_artifact_file_symlink_is_rejected(self):
        sentinel = self.write(self.root, 'outside.txt', 'keep')
        self.link(self.artifact / 'linked.txt', sentinel)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            self.store()
        self.assertFalse(self.cache.exists())

    def test_windows_junction_is_rejected(self):
        self.link(self.artifact / 'junction', self.workspace, junction=True)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            self.store()

    def test_source_parent_link_is_rejected(self):
        alias = self.root / 'source-alias'
        self.link(alias, self.artifact.parent)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.store(alias / 'dist', self.cache, KEY)

    def test_cache_parent_and_root_links_are_rejected(self):
        alias = self.root / 'cache-parent-alias'
        self.link(alias, self.workspace)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.store(self.artifact, alias / 'cache', KEY)
        self.store()
        alias_root = self.root / 'cache-alias'
        self.link(alias_root, self.cache)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.verify(alias_root, KEY)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.store(self.artifact, alias_root, KEY)

    def test_link_added_inside_cache_cannot_be_verified_or_replaced(self):
        self.store()
        self.link(self.cache / 'artifact/linked', self.workspace)
        original = (self.cache / 'manifest.json').read_bytes()
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.verify(self.cache, KEY)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            self.store()
        self.assertEqual(original, (self.cache / 'manifest.json').read_bytes())

    def test_cached_artifact_root_cannot_be_a_link(self):
        self.store()
        shutil.rmtree(self.cache / 'artifact')
        self.link(self.cache / 'artifact', self.artifact)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.verify(self.cache, KEY)

    def test_manifest_cannot_be_a_symbolic_link(self):
        self.store()
        original = self.cache / 'manifest.json'
        outside = self.root / 'outside-manifest.json'
        original.rename(outside)
        self.link(original, outside)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.verify(self.cache, KEY)

    def test_destination_parent_link_is_rejected(self):
        self.store()
        alias = self.root / 'destination-alias'
        self.link(alias, self.workspace)
        with self.assertRaisesRegex(cache_tool.CacheError, 'link or reparse point'):
            cache_tool.restore(self.cache, KEY, alias / 'dist')
        self.assertFalse(self.destination.exists())

    def test_hardlinks_and_special_files_are_rejected(self):
        outside = self.write(self.root, 'external-file', 'external')
        os.link(outside, self.artifact / 'hardlink')
        with self.assertRaisesRegex(cache_tool.CacheError, 'hard-linked file'):
            self.store()
        self.assertFalse(self.cache.exists())

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'POSIX FIFO validation runs in Linux CI')
    def test_fifo_rejected_without_opening_or_blocking(self):
        os.mkfifo(self.artifact / 'fifo')
        with self.assertRaisesRegex(cache_tool.CacheError, 'special file'):
            self.store()
        self.assertFalse(self.cache.exists())

    def test_existing_destination_file_and_directory_are_never_overwritten(self):
        self.store()
        self.destination.write_text('user file', encoding='utf-8')
        with self.assertRaises(cache_tool.CacheError):
            cache_tool.restore(self.cache, KEY, self.destination)
        self.assertEqual('user file', self.destination.read_text(encoding='utf-8'))
        self.destination.unlink()
        self.destination.mkdir()
        sentinel = self.write(self.destination, 'source.js', 'user source')
        with self.assertRaisesRegex(cache_tool.CacheError, 'already exists'):
            cache_tool.restore(self.cache, KEY, self.destination)
        self.assertEqual('user source', sentinel.read_text(encoding='utf-8'))

    def test_destination_created_during_verification_is_not_removed(self):
        self.store()
        real_verify = cache_tool.verify

        def competing_destination(*args):
            result = real_verify(*args)
            self.write(self.destination, 'source.js', 'user source')
            return result

        with patch.object(cache_tool, 'verify', side_effect=competing_destination):
            with self.assertRaises(FileExistsError):
                cache_tool.restore(self.cache, KEY, self.destination)
        self.assertEqual('user source', (self.destination / 'source.js').read_text(encoding='utf-8'))

    def test_store_rejects_overlapping_boundaries_and_parent_traversal(self):
        with self.assertRaisesRegex(cache_tool.CacheError, 'overlap'):
            cache_tool.store(self.artifact, self.artifact / 'cache', KEY)
        with self.assertRaisesRegex(cache_tool.CacheError, 'overlap'):
            cache_tool.store(self.artifact, self.artifact.parent, KEY)
        with self.assertRaisesRegex(cache_tool.CacheError, 'parent traversal'):
            cache_tool.store(self.artifact, self.workspace / '..' / 'cache', KEY)
        self.assertTrue((self.artifact / 'index.html').is_file())

    def test_copy_failure_does_not_publish_or_destroy_previous_cache(self):
        with patch.object(cache_tool, 'copy_file', side_effect=OSError('simulated copy failure')):
            with self.assertRaisesRegex(OSError, 'simulated copy failure'):
                self.store()
        self.assertFalse(self.cache.exists())
        self.assert_no_stage()
        self.store()
        previous = self.manifest()
        self.write(self.artifact, 'assets/app.js', 'changed source')
        with patch.object(cache_tool, 'copy_file', side_effect=OSError('simulated copy failure')):
            with self.assertRaises(OSError):
                self.store()
        self.assertEqual(previous, cache_tool.verify(self.cache, KEY))
        self.assert_no_stage()

    def test_source_mutation_during_copy_does_not_publish(self):
        real_copy = cache_tool.copy_file

        def mutate_source(source, destination, entry):
            real_copy(source, destination, entry)
            self.write(self.artifact, 'late.js', 'new file after initial inventory')

        with patch.object(cache_tool, 'copy_file', side_effect=mutate_source):
            with self.assertRaisesRegex(cache_tool.CacheError, 'file inventory mismatch'):
                self.store()
        self.assertFalse(self.cache.exists())
        self.assert_no_stage()

    def test_copied_bytes_are_verified_before_publication(self):
        real_copy = cache_tool.copy_file

        def corrupt_copy(source, destination, entry):
            real_copy(source, destination, entry)
            destination.write_text('corrupted copy', encoding='utf-8')

        with patch.object(cache_tool, 'copy_file', side_effect=corrupt_copy):
            with self.assertRaisesRegex(cache_tool.CacheError, 'digest'):
                self.store()
        self.assertFalse(self.cache.exists())
        self.assert_no_stage()

    def test_publication_failure_restores_previous_cache(self):
        self.store()
        previous = self.manifest()
        self.write(self.artifact, 'assets/app.js', 'replacement build')
        real_rename = Path.rename

        def fail_publication(source, target):
            if source.name.startswith('.cache.tmp-') and target == self.cache:
                raise OSError('simulated publication failure')
            return real_rename(source, target)

        with patch.object(Path, 'rename', fail_publication):
            with self.assertRaisesRegex(OSError, 'simulated publication failure'):
                self.store()
        self.assertEqual(previous, cache_tool.verify(self.cache, KEY))
        self.assert_no_stage()

    def test_parent_sync_failure_does_not_leave_published_cache(self):
        real_sync = cache_tool.sync_directory

        def fail_parent_sync(path):
            if path == self.root:
                raise OSError('simulated parent sync failure')
            real_sync(path)

        with patch.object(cache_tool, 'sync_directory', side_effect=fail_parent_sync):
            with self.assertRaisesRegex(OSError, 'simulated parent sync failure'):
                self.store()
        self.assertFalse(self.cache.exists())
        self.assert_no_stage()
        self.store()
        previous = self.manifest()
        self.write(self.artifact, 'assets/app.js', 'replacement build')
        with patch.object(cache_tool, 'sync_directory', side_effect=fail_parent_sync):
            with self.assertRaisesRegex(OSError, 'simulated parent sync failure'):
                self.store()
        self.assertEqual(previous, cache_tool.verify(self.cache, KEY))
        self.assert_no_stage()

    def test_damaged_cache_can_be_replaced(self):
        self.store()
        self.write(self.cache, 'artifact/assets/app.js', 'bad cache data')
        (self.cache / 'manifest.json').write_text('broken manifest', encoding='utf-8')
        self.store()
        cache_tool.verify(self.cache, KEY)
        self.assertEqual((self.artifact / 'assets/app.js').read_bytes(),
                         (self.cache / 'artifact/assets/app.js').read_bytes())
        self.assert_no_stage()

    def test_failed_restore_removes_only_its_new_destination(self):
        self.store()
        with patch.object(cache_tool, 'copy_file', side_effect=OSError('simulated restore failure')):
            with self.assertRaisesRegex(OSError, 'simulated restore failure'):
                cache_tool.restore(self.cache, KEY, self.destination)
        self.assertFalse(self.destination.exists())
        cache_tool.verify(self.cache, KEY)

    def test_readonly_cache_files_can_be_verified_restored_and_replaced(self):
        self.store()
        for path in self.cache.rglob('*'):
            if path.is_file():
                os.chmod(path, path.stat().st_mode & ~0o222)
        try:
            cache_tool.verify(self.cache, KEY)
            cache_tool.restore(self.cache, KEY, self.destination)
            self.store()
            cache_tool.verify(self.cache, KEY)
            self.assert_no_stage()
        finally:
            for path in self.cache.rglob('*'):
                if path.is_file():
                    os.chmod(path, path.stat().st_mode | stat.S_IWUSR)

    @unittest.skipIf(os.name == 'nt', 'POSIX executable modes are checked in Linux CI')
    def test_executable_flag_is_preserved_and_verified(self):
        script = self.write(self.artifact, 'server/start.sh', '#!/bin/sh\nexit 0\n')
        script.chmod(0o755)
        self.store()
        cache_tool.restore(self.cache, KEY, self.destination)
        self.assertEqual(0o111, (self.destination / 'server/start.sh').stat().st_mode & 0o111)
        (self.cache / 'artifact/server/start.sh').chmod(0o644)
        with self.assertRaisesRegex(cache_tool.CacheError, 'metadata mismatch'):
            cache_tool.verify(self.cache, KEY)

    def test_cached_python_and_shell_content_is_never_executed(self):
        marker = self.root / 'executed'
        self.write(self.artifact, 'danger.py', 'from pathlib import Path\nPath(' + repr(str(marker)) + ').touch()\n')
        self.write(self.artifact, 'danger.sh', 'exit 77\n')
        shadow = self.root / 'shadow'
        shadow.mkdir()
        for name in ('json.py', 'pathlib.py', 'hashlib.py'):
            self.write(shadow, name, 'raise RuntimeError("untrusted module executed")\n')
        env = os.environ.copy()
        env['PYTHONPATH'] = str(shadow)
        for command in (('store', self.artifact, self.cache, KEY),
                        ('verify', self.cache, KEY),
                        ('restore', self.cache, KEY, self.destination)):
            result = self.run_cli(*command, cwd=shadow, env=env)
            self.assertEqual(0, result.returncode, result.stderr)
        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
