"""Linux root checks for the exact progress writer embedded in public installers."""
import io
import copy
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import types
import unittest
from unittest import mock


HELPER = Path(__file__).with_name('release-common.sh')
BASH = os.environ.get('TEST_BASH') or ('D:/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))
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
        downloader.stage = 'verify'
        with mock.patch.object(core, 'write_progress_file') as write:
            downloader.progress()
        write.assert_not_called()


class StageTimingState(unittest.TestCase):
    BOOT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    JOB = 'a' * 32

    def advance(self, data, stage, at, detail=None, **kwargs):
        return core.advance_stage_timings(data, stage, detail, 100000, at * 1000000, self.BOOT, self.JOB, **kwargs)

    def test_real_transitions_aggregate_retries_in_first_seen_order(self):
        data = self.advance(None, 'preflight', 100)
        self.assertIsNone(self.advance(data, 'preflight', 150), 'metrics do not rewrite or advance the interval')
        data = self.advance(data, 'download', 200, 'source-receive')
        data = self.advance(data, 'download', 250, 'source-retry')
        data = self.advance(data, 'download', 450, 'source-receive')
        data = self.advance(data, 'verify', 500, 'typecheck')
        data = self.advance(data, None, 550, finish=True)
        self.assertEqual(data['entries'], [
            {'stage': 'preflight', 'durationMs': 100},
            {'stage': 'download', 'detail': 'source-receive', 'durationMs': 100},
            {'stage': 'download', 'detail': 'source-retry', 'durationMs': 200},
            {'stage': 'verify', 'detail': 'typecheck', 'durationMs': 50}])
        self.assertTrue(data['closed'])
        self.assertIsNone(data['active'])
        self.assertIsNone(self.advance(data, None, 600, finish=True))
        self.assertIsNone(self.advance(data, 'download', 650), 'late writers cannot reopen a finished installer')

    def test_wall_clock_changes_do_not_change_duration_and_unclosed_stays_explicit(self):
        data = self.advance(None, 'build', 100)
        data = core.advance_stage_timings(data, 'finalize', 'updater', 10, 200000000, self.BOOT, self.JOB)
        self.assertEqual(data['entries'][0]['durationMs'], 100)
        self.assertEqual(data['active']['index'], 1)
        self.assertFalse(data['closed'])
        data = core.advance_stage_timings(data, None, None, 900000000, 300000000, self.BOOT, self.JOB, True)
        self.assertEqual(data['entries'][1]['durationMs'], 100)

    def test_boot_change_missing_clock_and_reversed_clock_are_unknown(self):
        for boot, clock in [('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', 200000000),
                            (None, 200000000), (self.BOOT, None), (self.BOOT, 1)]:
            with self.subTest(boot=boot, clock=clock):
                data = self.advance(None, 'build', 100, 'build-workbench')
                data = core.advance_stage_timings(data, 'prepare', None, 100000, clock, boot, self.JOB)
                self.assertIsNone(data['entries'][0]['durationMs'])
                data = self.advance(data, 'build', 300, 'build-workbench')
                data = self.advance(data, None, 400, finish=True)
                self.assertIsNone(data['entries'][0]['durationMs'], 'a later known interval cannot erase an unknown one')

    def test_no_sample_and_corrupt_state_never_invent_history(self):
        self.assertIsNone(self.advance(None, None, 100, finish=True))
        valid = self.advance(None, 'build', 100)
        invalid_active = copy.deepcopy(valid); invalid_active['active'].pop('bootId')
        duplicate = copy.deepcopy(valid); duplicate['entries'] *= 2
        for invalid in ({}, [], invalid_active, duplicate, {**valid, 'jobId': 'b' * 32},
                        {**valid, 'jobId': None}, {**valid, 'jobId': 'wrong-job'},
                        {**valid, 'entries': [{'stage': 'private-error', 'durationMs': 1}]},
                        {**valid, 'entries': [{'stage': 'build', 'durationMs': True}]}):
            self.assertIsNone(self.advance(invalid, 'verify', 200))


class InstallerExitHooks(unittest.TestCase):
    def run_shell(self, source):
        return subprocess.run([BASH, '-c', source, 'timing-exit-test',
                               str(HELPER.with_name('install.sh')).replace('\\', '/')],
                              text=True, capture_output=True)

    def test_sourcing_helpers_preserves_the_callers_exit_trap(self):
        result = self.run_shell('trap "printf caller" EXIT; AGG_INSTALL_SOURCE_ONLY=1 source "$1"; :')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'caller')

    def test_rollback_closes_before_exit_and_preserves_error_and_signal_codes(self):
        for trigger, code in [('trap rollback ERR; bash -c "exit 47"', 47),
                              ('trap "rollback 130" INT; kill -INT "$$"', 130),
                              ('trap "rollback 143" TERM; kill -TERM "$$"', 143)]:
            with self.subTest(code=code):
                result = self.run_shell('AGG_INSTALL_SOURCE_ONLY=1 source "$1"; '
                                        'ci_finish_progress() { printf "closed\\n"; return 99; }; '
                                        'trap ci_finish_progress EXIT; ' + trigger)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(result.stdout.splitlines(), ['closed'])


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'Requires native Linux root ownership and dir_fd semantics')
class InstallerProgress(unittest.TestCase):
    def setUp(self):
        # The production writer rejects /tmp even when its immediate child is
        # private. Use a genuinely protected chain, without weakening checks.
        self.temporary = tempfile.TemporaryDirectory(prefix='agg-progress-', dir='/root')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / ('a' * 32)
        self.root.mkdir(mode=0o700)
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

    def test_timings_are_private_atomic_and_close_without_expanding_progress(self):
        with mock.patch.object(core.time, 'monotonic_ns', side_effect=[100000000, 150000000, 200000000, 300000000]):
            core.write_progress_file('build', detail='build-workbench')
            core.write_progress_file('build', .5, detail='build-workbench')
            core.write_progress_file('finalize', detail='updater')
            core.finish_stage_timings()
        path = self.root / 'stage-timings.json'
        data = json.loads(path.read_text())
        self.assertEqual(data['jobId'], self.root.name)
        self.assertEqual(data['entries'], [{'stage': 'build', 'detail': 'build-workbench', 'durationMs': 100},
                                           {'stage': 'finalize', 'detail': 'updater', 'durationMs': 100}])
        self.assertTrue(data['closed'])
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.root / 'stage-timings.lock').stat().st_mode), 0o600)
        self.assertEqual(list(self.root.glob('.stage-timings-*')), [])
        self.assertLess(self.path.stat().st_size, 4096)
        self.assertNotIn('entries', json.loads(self.path.read_text()))
        before = path.read_bytes()
        core.finish_stage_timings()
        core.write_progress_file('download')
        self.assertEqual(path.read_bytes(), before)

    def test_bad_timing_files_and_busy_lock_do_not_block_progress_or_touch_target(self):
        import fcntl
        timings = self.root / 'stage-timings.json'
        for raw in ('{', '[' * 1500 + '0' + ']' * 1500, ' ' * (core.MAX_TIMINGS_BYTES + 1)):
            timings.write_text(raw); timings.chmod(0o600)
            core.write_progress_file('verify')
            self.assertEqual(json.loads(self.path.read_text())['stage'], 'verify')
            self.assertEqual(timings.read_text(), raw)
        timings.unlink()
        victim = self.root / 'private-target'
        victim.write_text('unchanged'); victim.chmod(0o600)
        for name in ('stage-timings.json', 'stage-timings.lock'):
            target = self.root / name
            if target.exists():
                target.unlink()
            for kind in ('symlink', 'hardlink', 'fifo', 'public'):
                with self.subTest(name=name, kind=kind):
                    if kind == 'symlink': target.symlink_to(victim)
                    elif kind == 'hardlink': os.link(victim, target)
                    elif kind == 'fifo': os.mkfifo(target, 0o600)
                    else: target.write_text('unchanged'); target.chmod(0o644)
                    before = target.lstat()
                    core.write_progress_file('extract')
                    core.finish_stage_timings()
                    self.assertEqual(target.lstat().st_ino, before.st_ino)
                    self.assertEqual(victim.read_text(), 'unchanged')
                    self.assertEqual(json.loads(self.path.read_text())['stage'], 'extract')
                    target.unlink()
        lock = self.root / 'stage-timings.lock'
        lock.touch(mode=0o600)
        with lock.open('r+b') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            core.write_progress_file('switch')
        self.assertEqual(json.loads(self.path.read_text())['stage'], 'switch')


if __name__ == '__main__':
    unittest.main()
