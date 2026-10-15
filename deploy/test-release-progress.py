"""Linux root checks for the exact progress writer embedded in public installers."""
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import types
import unittest
from unittest import mock


HELPER = Path(__file__).with_name('release-common.sh')
SOURCE = HELPER.read_text(encoding='utf-8')
PYTHON = SOURCE.split("<<'CI_DOWNLOAD_PY'\n", 1)[1].split('\nCI_DOWNLOAD_PY', 1)[0]
core = types.ModuleType('installer_progress')
exec(compile(PYTHON, str(HELPER) + ':CI_DOWNLOAD_PY', 'exec'), core.__dict__)


class SourceProgress(unittest.TestCase):
    def test_git_reports_object_ratio_and_measured_bytes_without_byte_total(self):
        sample = core.source_progress_sample('Receiving objects:  25% (2/8), 1.50 MiB | 512.00 KiB/s')
        self.assertEqual(sample, {'stage': 'download', 'detail': 'source-receive', 'progress': .25,
                                  'downloaded': 1572864, 'speed': 524288})
        self.assertEqual(core.source_progress_sample('Resolving deltas:  50% (3/6)'),
                         {'stage': 'prepare', 'detail': 'source-resolve', 'progress': .5})
        self.assertEqual(core.source_progress_sample('Receiving objects: 100% (8/8), 100 bytes | 0 bytes/s, done.')['speed'], 0)
        self.assertNotIn('downloaded', core.source_progress_sample('Receiving objects: 0% (0/8)'))
        for line in ('fatal: private error', 'remote: Receiving objects: 50% (1/2)',
                     'Receiving objects: 50% (3/2)', 'Receiving objects: 101% (1/2)',
                     'Receiving objects: 0% (0/0)'):
            self.assertIsNone(core.source_progress_sample(line))

    def test_crlf_chunking_throttling_and_last_sample_preserve_original_log(self):
        transcript = (b'Receiving objects: 25% (2/8), 1 MiB | 1 MiB/s\r'
                      b'Receiving objects: 50% (4/8), 2 MiB | 2 MiB/s\r\n'
                      b'Resolving deltas: 50% (1/2)\rResolving deltas: 100% (2/2)')
        class SmallChunks(io.BytesIO):
            def read1(self, _size):
                return self.read(7)
        output = io.BytesIO()
        with mock.patch.object(core, 'write_progress_file') as write, mock.patch.object(core.time, 'monotonic', return_value=10):
            core.source_progress_stream(SmallChunks(transcript), output)
        self.assertEqual(output.getvalue(), transcript)
        samples = [call.kwargs for call in write.call_args_list]
        self.assertEqual([sample['progress'] for sample in samples], [.25, .5, 1])
        self.assertEqual([sample['stage'] for sample in samples], ['download', 'prepare', 'prepare'])
        self.assertNotIn('speed', samples[-1])

    def test_oversized_untrusted_lines_are_not_parsed_and_next_record_recovers(self):
        transcript = b'x' * 15000 + b'Receiving objects: 50% (1/2)\rReceiving objects: 100% (2/2)\n'
        with mock.patch.object(core, 'write_progress_file') as write:
            core.source_progress_stream(io.BytesIO(transcript), io.BytesIO())
        self.assertEqual(write.call_count, 1)
        self.assertEqual(write.call_args.kwargs['progress'], 1)

    def test_unknown_archive_size_still_publishes_bytes_and_zero_speed(self):
        downloader = object.__new__(core.Downloader)
        downloader.positions = {0: 1234}
        downloader.progress_lock = core.threading.Lock()
        downloader.started = 5
        downloader.received = 0
        downloader.total = None
        downloader.mode = 'single'
        downloader.stage = 'download'
        downloader.last_progress_write = 0
        with mock.patch.object(core.time, 'monotonic', return_value=10), mock.patch.object(core, 'write_progress_file') as write:
            downloader.progress()
        self.assertEqual(write.call_args.kwargs, {'stage': 'download', 'progress': None,
                                                 'downloaded': 1234, 'total': None, 'speed': 0})


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'Requires native Linux root ownership and dir_fd semantics')
class InstallerProgress(unittest.TestCase):
    def setUp(self):
        # The production writer rejects /tmp even when its immediate child is
        # private. Use a genuinely protected chain, without weakening checks.
        self.temporary = tempfile.TemporaryDirectory(prefix='agg-progress-', dir='/root')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / 'progress.json'
        self.environment = mock.patch.dict(os.environ, {'PROJECT_UPDATE_PROGRESS_FILE': str(self.path)})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def emit(self, path, *args, **kwargs):
        with mock.patch.dict(os.environ, {'PROJECT_UPDATE_PROGRESS_FILE': str(path)}):
            core.write_progress_file(*args, **kwargs)

    def test_shell_entry_publishes_indeterminate_then_measured_progress_privately(self):
        command = ['bash', '-c', 'source "$1"; ci_update_progress "$2" "${3:-}"',
                   'progress-test', str(HELPER), 'build']
        subprocess.run(command, check=True, capture_output=True)
        data = json.loads(self.path.read_text())
        self.assertEqual(data['stage'], 'build')
        self.assertNotIn('progress', data)
        self.assertGreater(data['timestamp'], 0)
        core.write_progress_file('download', 0.5, downloaded=100, total=200, speed=20)
        data = json.loads(self.path.read_text())
        self.assertEqual((data['progress'], data['downloaded'], data['total'], data['eta']), (0.5, 100, 200, 5))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(self.path.stat().st_uid, 0)
        self.assertEqual(list(self.root.glob('.progress-*')), [])

    def test_real_source_pipeline_uses_preserved_input_fd_and_publishes_details(self):
        data = b'Receiving objects: 50% (2/4), 4 MiB | 1 MiB/s\r'
        result = subprocess.run(['bash', '-c', 'source "$1"; ci_source_progress',
                                 'progress-test', str(HELPER)], input=data, capture_output=True, check=True)
        self.assertEqual(result.stderr, data)
        sample = json.loads(self.path.read_text())
        self.assertEqual((sample['stage'], sample['detail'], sample['progress']), ('download', 'source-receive', .5))
        self.assertEqual((sample['downloaded'], sample['speed']), (4194304, 1048576))
        self.assertNotIn('total', sample)
        self.assertNotIn('eta', sample)
        core.write_progress_file('finalize', detail='healthcheck')
        self.assertEqual(json.loads(self.path.read_text())['detail'], 'healthcheck')

    def test_rejects_any_writable_foreign_or_linked_ancestor(self):
        unsafe = self.root / 'unsafe'
        unsafe.mkdir(mode=0o700)
        nested = unsafe / 'nested'
        nested.mkdir(mode=0o700)
        for mode in (0o720, 0o702):
            with self.subTest(mode=oct(mode)):
                unsafe.chmod(mode)
                self.emit(nested / 'progress.json', 'build')
                self.assertFalse((nested / 'progress.json').exists())
        unsafe.chmod(0o700)
        os.chown(unsafe, 65534, 65534)
        try:
            self.emit(nested / 'progress.json', 'build')
            self.assertFalse((nested / 'progress.json').exists())
        finally:
            os.chown(unsafe, 0, 0)
        linked = self.root / 'linked'
        linked.symlink_to(unsafe, target_is_directory=True)
        self.emit(linked / 'nested/progress.json', 'build')
        self.assertFalse((nested / 'progress.json').exists())
        with tempfile.TemporaryDirectory(prefix='agg-progress-reject-', dir='/tmp') as temporary:
            target = Path(temporary) / 'progress.json'
            self.emit(target, 'build')
            self.assertFalse(target.exists())

    def test_rejects_symlink_hardlink_fifo_and_nonprivate_target(self):
        victim = self.root / 'victim'
        victim.write_bytes(b'unchanged')
        victim.chmod(0o600)
        for kind in ('symlink', 'hardlink', 'fifo', 'world-readable'):
            with self.subTest(kind=kind):
                if kind == 'symlink':
                    self.path.symlink_to(victim)
                elif kind == 'hardlink':
                    os.link(victim, self.path)
                elif kind == 'fifo':
                    os.mkfifo(self.path, 0o600)
                else:
                    self.path.write_bytes(b'unchanged')
                    self.path.chmod(0o644)
                before = self.path.lstat()
                core.write_progress_file('build')
                self.assertEqual(self.path.lstat().st_ino, before.st_ino)
                self.assertEqual(victim.read_bytes(), b'unchanged')
                self.path.unlink()

    def test_exclusive_temp_collision_preserves_existing_file(self):
        collision = self.root / ('.progress-' + 'a' * 32)
        collision.write_bytes(b'owned by another operation')
        with mock.patch.object(core.secrets, 'token_hex', return_value='a' * 32):
            core.write_progress_file('build')
        self.assertEqual(collision.read_bytes(), b'owned by another operation')
        self.assertFalse(self.path.exists())

    def test_invalid_paths_numbers_and_nonroot_are_ignored(self):
        for filename in ('relative.json', str(self.root) + '/../progress.json', str(self.root) + '//progress.json'):
            with mock.patch.object(core.os, 'open', side_effect=AssertionError('invalid path was opened')):
                self.emit(filename, 'build')
        for value in (float('nan'), float('inf'), -0.1, 1.1):
            core.write_progress_file('download', value)
            self.assertFalse(self.path.exists())
        core.write_progress_file('unknown')
        self.assertFalse(self.path.exists())
        with mock.patch.object(core.os, 'geteuid', return_value=65534), \
                mock.patch.object(core.os, 'open', side_effect=AssertionError('nonroot attempted to write')):
            core.write_progress_file('build')


if __name__ == '__main__':
    unittest.main()
