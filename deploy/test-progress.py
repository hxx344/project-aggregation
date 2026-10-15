"""Display-only progress parsing; Linux ownership checks also run in root CI."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/update-service'))
from progress import get_progress, get_stage_timings, STAGES, DETAILS, MAX_TIMINGS_BYTES


class ProgressTests(unittest.TestCase):
    def setUp(self):
        if os.name != 'nt' and os.geteuid() != 0:
            self.skipTest('Run as root for protected progress metadata')
        self.temporary = tempfile.TemporaryDirectory(prefix='updater-progress-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.directory.chmod(0o700)
        self.path = self.directory / 'progress.json'
        self.now = 1800000000
        self.started = (self.now - 30) * 1000
        self.sample = {'stage': 'download', 'progress': 0.5, 'downloaded': 50,
                       'total': 100, 'speed': 10, 'eta': 5, 'timestamp': self.now * 1000}

    def write(self, sample):
        self.path.write_text(json.dumps(sample), encoding='utf8')
        self.path.chmod(0o600)

    def read(self):
        return get_progress(self.path, self.started, self.now)

    def test_valid_download_and_unknown_duration_stages(self):
        self.write(self.sample)
        self.assertEqual(self.read(), self.sample)
        for stage in STAGES:
            sample = {'stage': stage, 'timestamp': self.now * 1000}
            self.write(sample)
            self.assertEqual(self.read(), sample)

    def test_only_public_fields_survive_and_download_details_do_not_leak_to_other_stages(self):
        self.write({**self.sample, 'error': 'private-output', 'path': '/private/path', 'token': 'private-token'})
        self.assertEqual(self.read(), self.sample)
        self.write({**self.sample, 'stage': 'build'})
        self.assertEqual(self.read(), {'stage': 'build', 'progress': 0.5, 'timestamp': self.now * 1000})

    def test_detail_is_optional_and_bound_to_its_stage(self):
        for stage, details in DETAILS.items():
            for detail in details:
                sample = {'stage': stage, 'detail': detail, 'timestamp': self.now * 1000}
                self.write(sample)
                self.assertEqual(self.read(), sample)
        for detail in ('build-workbench', 'private output', None, [], {}):
            self.write({**self.sample, 'detail': detail})
            self.assertEqual(self.read(), self.sample)
        sample = {'stage': 'download', 'detail': 'source-receive', 'progress': 0.5,
                  'downloaded': 1024, 'speed': 256, 'timestamp': self.now * 1000}
        self.write(sample)
        self.assertEqual(self.read(), sample)

    def test_missing_corrupt_oversized_old_future_or_previous_job_sample_is_ignored(self):
        self.assertIsNone(self.read())
        for raw in ('{', '[]', 'null', ' ' * 4097, '[' * 1500 + '0' + ']' * 1500):
            self.path.write_text(raw, encoding='utf8'); self.path.chmod(0o600)
            self.assertIsNone(self.read())
        for stamp in (0, True, None, 'now', self.started - 1, (self.now + 2) * 1000, float('inf'), float('nan')):
            self.write({**self.sample, 'timestamp': stamp})
            self.assertIsNone(self.read(), str(stamp))
        self.write(self.sample)
        self.assertIsNone(get_progress(self.path, self.started, self.now + 301))

    def test_malformed_optional_data_cannot_reach_public_state(self):
        for stage in ('unknown', None, {}, ['download']):
            self.write({**self.sample, 'stage': stage}); self.assertIsNone(self.read())
        for progress in (-1, 1.01, True, None, '0.5', float('nan'), float('inf'), 10 ** 1000):
            self.write({**self.sample, 'progress': progress}); self.assertIsNone(self.read())
        for field in ('speed', 'eta', 'total', 'downloaded'):
            for value in (-1, True, '1', float('inf'), 2 ** 53):
                self.write({**self.sample, field: value}); self.assertIsNone(self.read())
        self.write({**self.sample, 'downloaded': 101}); self.assertIsNone(self.read())

    def test_links_and_nonregular_files_are_ignored(self):
        target = self.directory / 'target.json'
        target.write_text(json.dumps(self.sample), encoding='utf8'); target.chmod(0o600)
        os.link(target, self.path)
        self.assertIsNone(self.read())
        self.path.unlink()
        try:
            self.path.symlink_to(target)
        except OSError as error:
            if os.name == 'nt' and getattr(error, 'winerror', None) == 1314:
                self.skipTest('Symlink privilege unavailable; covered in Linux CI')
            raise
        self.assertIsNone(self.read())
        self.path.unlink(); self.path.mkdir()
        self.assertIsNone(self.read())

    @unittest.skipIf(os.name == 'nt', 'Unix permission checks run in Linux CI')
    def test_public_or_writable_file_and_nonprivate_parent_are_ignored(self):
        self.write(self.sample)
        for mode in (0o644, 0o620):
            self.path.chmod(mode); self.assertIsNone(self.read())
        self.path.chmod(0o600)
        self.directory.chmod(0o755)
        self.assertIsNone(self.read())
        self.directory.chmod(0o700)
        os.chown(self.path, 65534, 65534)
        self.assertIsNone(self.read())


class StageTimingTests(ProgressTests):
    # Reuse the same trusted-file boundary cases with a timing payload.
    def setUp(self):
        super().setUp()
        self.directory = self.directory / ('a' * 32)
        self.directory.mkdir(mode=0o700)
        self.path = self.directory / 'stage-timings.json'
        self.sample = {'schema': 1, 'jobId': self.directory.name, 'createdAt': self.now * 1000, 'closed': True, 'active': None,
                       'entries': [{'stage': 'build', 'detail': 'build-workbench', 'durationMs': 1200},
                                   {'stage': 'finalize', 'detail': 'updater', 'durationMs': 20}]}

    def read(self):
        return get_stage_timings(self.path)

    def test_valid_download_and_unknown_duration_stages(self):
        self.write(self.sample)
        expected = {'entries': self.sample['entries']}
        self.assertEqual(self.read(), expected)
        with mock.patch('progress.time.time', return_value=self.now + 86400):
            self.assertEqual(get_stage_timings(self.path), expected)
        for stage in STAGES:
            self.write({**self.sample, 'entries': [{'stage': stage, 'durationMs': None}]})
            self.assertEqual(self.read(), {'entries': [{'stage': stage, 'durationMs': None}]})

    def test_only_public_fields_survive_and_download_details_do_not_leak_to_other_stages(self):
        sample = {**self.sample, 'private': 'secret', 'entries': [
            {**self.sample['entries'][0], 'path': '/private', 'token': 'secret'}]}
        self.write(sample)
        self.assertEqual(self.read(), {'entries': [self.sample['entries'][0]]})

    def test_detail_is_optional_and_bound_to_its_stage(self):
        for stage, details in DETAILS.items():
            for detail in details:
                entries = [{'stage': stage, 'detail': detail, 'durationMs': 1}]
                self.write({**self.sample, 'entries': entries})
                self.assertEqual(self.read(), {'entries': entries})
        for detail in ('build-aster', 'private output', None, [], {}):
            self.write({**self.sample, 'entries': [{'stage': 'download', 'detail': detail, 'durationMs': 1}]})
            self.assertIsNone(self.read())

    def test_missing_corrupt_oversized_old_future_or_previous_job_sample_is_ignored(self):
        self.assertIsNone(self.read())
        for raw in ('{', '[]', 'null', ' ' * (MAX_TIMINGS_BYTES + 1), '[' * 1500 + '0' + ']' * 1500):
            self.path.write_text(raw, encoding='utf8'); self.path.chmod(0o600)
            self.assertIsNone(self.read())
        for stamp in (0, True, None, 'now', float('inf'), float('nan')):
            self.write({**self.sample, 'createdAt': stamp})
            self.assertIsNone(self.read())

    def test_wall_clock_corrections_do_not_hide_valid_job_measurements(self):
        # Covers correction before the first write and after the first write.
        for created in (self.started - 300000, self.now * 1000 + 1000):
            self.write({**self.sample, 'createdAt': created})
            with mock.patch('progress.time.time', return_value=self.now - 300):
                self.assertEqual(self.read(), {'entries': self.sample['entries']})

    def test_foreign_or_invalid_job_identity_cannot_supply_timings(self):
        for job_id in ('b' * 32, '', 'wrong-job', None, [], 42):
            self.write({**self.sample, 'jobId': job_id})
            self.assertIsNone(self.read())
        sample = dict(self.sample); sample.pop('jobId')
        self.write(sample)
        self.assertIsNone(self.read())
        self.write(self.sample)
        foreign = self.directory.parent / ('b' * 32)
        foreign.mkdir(mode=0o700)
        copied = foreign / 'stage-timings.json'
        copied.write_bytes(self.path.read_bytes()); copied.chmod(0o600)
        self.assertIsNone(get_stage_timings(copied))

    def test_malformed_optional_data_cannot_reach_public_state(self):
        for value in (-1, True, '1', float('inf'), 2 ** 53, float('nan'), 10 ** 1000):
            self.write({**self.sample, 'entries': [{'stage': 'build', 'durationMs': value}]})
            self.assertIsNone(self.read())
        for entries in ([], {}, [None], [{'stage': 'build'}],
                        [{'stage': ['build'], 'durationMs': 0}], self.sample['entries'] * 2,
                        [{'stage': 'build', 'durationMs': 1}] * 33):
            self.write({**self.sample, 'entries': entries})
            self.assertIsNone(self.read())
        for malformed in ({'schema': True}, {'schema': 2}, {'closed': 1},
                          {'closed': False, 'active': None}, {'active': {'index': 0}},
                          {'closed': False, 'active': {'index': True}},
                          {'closed': False, 'active': {'index': 2}}):
            self.write({**self.sample, **malformed})
            self.assertIsNone(self.read())

    def test_unclosed_interval_only_invalidates_its_aggregate(self):
        self.write({**self.sample, 'closed': False, 'active': {
            'index': 0, 'bootId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'monotonicNs': 12345}})
        self.assertEqual(self.read(), {'entries': [{**self.sample['entries'][0], 'durationMs': None},
                                                  self.sample['entries'][1]]})


if __name__ == '__main__':
    unittest.main(verbosity=2)
