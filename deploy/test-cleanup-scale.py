"""Isolated updater cleanup baseline. No installer, service, network or account calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/update-service'))
import updater


def contained(root, path):
    path.resolve().relative_to(root.resolve())
    if path.resolve() == root.resolve():
        raise AssertionError('fixture cannot delete its root')


def interrupt_child(directory):
    coordinator = updater.Coordinator(Path(directory))
    remove, deleted = updater.shutil.rmtree, 0

    def interrupted(path, *args, **kwargs):
        nonlocal deleted
        contained(Path(directory), Path(path))
        remove(path, *args, **kwargs)
        deleted += 1
        if deleted == max(1, updater.PRUNE_BATCH // 2):
            os._exit(75)  # Actual process termination after successful partial removal.

    with patch.object(updater.shutil, 'rmtree', interrupted), coordinator.lock():
        coordinator.prune(coordinator.load())
    raise AssertionError('interruption fixture did not reach its target')


class CleanupScale(unittest.TestCase):
    def test_scales_restart_and_failed_entries_do_not_starve(self):
        for count in (32, 256, 1024):
            with self.subTest(scale=count), tempfile.TemporaryDirectory(prefix='cleanup-scale-') as temporary:
                root = Path(temporary)
                coordinator = updater.Coordinator(root)
                protected = {'planId': 'e' * 32, 'jobPlanId': 'd' * 32, 'job': {'id': 'c' * 32, 'state': 'running'}}
                state = coordinator.load(); state.update(protected); coordinator.save(state)
                for folder, tokens in ((coordinator.plans, ('e' * 32, 'd' * 32)), (coordinator.jobs, ('c' * 32,))):
                    for token in tokens:
                        updater.private_directory(folder / token)
                        os.utime(folder / token, (1, 1))
                for index in range(count):
                    for folder in (coordinator.plans, coordinator.jobs):
                        entry = updater.private_directory(folder / f'{index:032x}')
                        (entry / 'fixture.txt').write_text('isolated fixture', encoding='utf8')
                        os.utime(entry, (1000 + index, 1000 + index))
                initial = 2 * count + 3
                started = time.perf_counter()
                result = subprocess.run([sys.executable, '-B', __file__, '--interrupt-child', str(root)],
                                        capture_output=True, timeout=30, check=False)
                self.assertEqual(result.returncode, 75, result.stderr.decode(errors='replace'))
                remaining = lambda: {path for folder in (coordinator.plans, coordinator.jobs) for path in folder.iterdir()}
                interrupted_deleted = initial - len(remaining())
                self.assertEqual(interrupted_deleted, max(1, updater.PRUNE_BATCH // 2))
                coordinator = updater.Coordinator(root)  # A fresh process has no failed-item memory.
                stuck = set(sorted(coordinator.plans.iterdir())[:min(updater.PRUNE_BATCH, count // 2)])
                protected_paths = {coordinator.plans / protected['planId'], coordinator.plans / protected['jobPlanId'], coordinator.jobs / protected['job']['id']}
                stuck -= protected_paths
                attempts = scanned = failed = 0
                remove, trusted = updater.shutil.rmtree, updater.trusted

                def measured_trusted(path, *args, **kwargs):
                    nonlocal scanned
                    if Path(path).parent in (coordinator.plans, coordinator.jobs):
                        scanned += 1
                    return trusted(path, *args, **kwargs)

                def measured_remove(path, *args, **kwargs):
                    nonlocal attempts, failed
                    contained(root, Path(path)); attempts += 1
                    if Path(path) in stuck:
                        failed += 1
                        raise PermissionError('controlled busy fixture')
                    return remove(path, *args, **kwargs)

                rounds = (2 * count + updater.PRUNE_BATCH - 1) // updater.PRUNE_BATCH + 2
                with patch.object(updater, 'trusted', measured_trusted), patch.object(updater.shutil, 'rmtree', measured_remove):
                    for _ in range(rounds):
                        before = attempts
                        with coordinator.lock():
                            coordinator.prune(coordinator.load())
                        self.assertLessEqual(attempts - before, updater.PRUNE_BATCH)
                expected_jobs = {coordinator.jobs / f'{index:032x}' for index in range(count - updater.JOB_HISTORY_LIMIT, count)}
                self.assertEqual(remaining(), protected_paths | stuck | expected_jobs)
                self.assertTrue(stuck)
                self.assertEqual(set(coordinator.prune_failed), stuck)
                partial = {'scalePerKind': count, 'initial': initial, 'scannedChecks': scanned, 'attempts': attempts,
                           'deleted': initial - len(remaining()), 'retained': len(remaining()), 'failedAttempts': failed,
                           'failedEntries': len(stuck), 'interruptedDeleted': interrupted_deleted, 'rounds': rounds,
                           'elapsedMs': round((time.perf_counter() - started) * 1000, 2), 'complete': False}
                stuck.clear()
                with coordinator.lock():
                    coordinator.prune(coordinator.load())
                self.assertEqual(remaining(), protected_paths | expected_jobs)
                self.assertEqual(coordinator.prune_failed, {})
                print(json.dumps({'updaterCleanup': partial, 'retryComplete': True, 'protected': ['active-plan', 'job-plan', 'running-job'],
                                  'environment': sys.platform, 'scope': 'temporary-directories-no-services'}), flush=True)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--interrupt-child':
        interrupt_child(sys.argv[2])
    else:
        unittest.main()
