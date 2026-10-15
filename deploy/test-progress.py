"""Display-only progress parsing; Linux ownership checks also run in root CI."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/update-service'))
from progress import get_progress, STAGES, DETAILS


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
