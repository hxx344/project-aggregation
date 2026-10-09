"""Verify release ordering and draft completion without writing to GitHub."""
import hashlib
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PUBLISHER = Path(__file__).with_name('publish-release.py')


class PublishRelease(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.commit, self.previous = 'b' * 40, 'a' * 40
        self.repo, self.tag = 'hxx344/fixture', 'deploy-' + self.commit
        payload = self.root / 'fixture.tar.gz'
        payload.write_bytes(b'fixture archive')
        item = {'file': payload.name, 'sha256': hashlib.sha256(payload.read_bytes()).hexdigest(), 'application_key': 'c' * 64}
        self.manifest = {'schema': 1, 'repository': self.repo, 'commit': self.commit, 'tag': self.tag,
                         'artifacts': {'linux-x64': item, 'linux-arm64': item}}
        (self.root / 'release-manifest.json').write_text(json.dumps(self.manifest))
        self.release = None
        self.latest = None
        self.status = 'ahead'
        self.calls = []

    def tearDown(self):
        self.temporary.cleanup()

    def fake_gh(self, args, **kwargs):
        self.calls.append(args)
        self.assertEqual(args[0], 'gh')
        code, stdout, stderr = 0, '', ''
        if args[1:4] == ['api', '--paginate', '--slurp']:
            stdout = json.dumps([[self.release] if self.release else []])
        elif args[1] == 'api' and args[2].endswith('/releases/latest'):
            if self.latest:
                stdout = json.dumps({'tag_name': self.latest})
            else:
                code, stderr = 1, 'HTTP 404 Not Found'
        elif args[1] == 'api' and '/compare/' in args[2]:
            self.assertTrue(args[2].endswith(self.previous + '...' + self.commit))
            stdout = json.dumps({'status': self.status})
        elif args[1:3] in (['release', 'create'], ['release', 'upload']):
            self.release = {'tag_name': self.tag, 'draft': True,
                            'assets': [{'name': 'fixture.tar.gz'}, {'name': 'release-manifest.json'}]}
        elif args[1:3] == ['release', 'edit']:
            self.assertTrue(self.release['draft'])
            self.release['draft'] = False
        elif args[1:3] == ['release', 'download']:
            directory = Path(args[args.index('--dir') + 1])
            (directory / 'release-manifest.json').write_text(json.dumps(self.manifest))
        else:
            self.fail('Unexpected GitHub operation: ' + str(args))
        return subprocess.CompletedProcess(args, code, stdout, stderr)

    def publish(self):
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': self.repo, 'GITHUB_SHA': self.commit}), \
                patch.object(sys, 'argv', [str(PUBLISHER), str(self.root)]), \
                patch('subprocess.run', self.fake_gh):
            try:
                runpy.run_path(str(PUBLISHER), run_name='__main__')
            except SystemExit as error:
                self.assertEqual(error.code, 0)

    def test_first_release_publishes_complete_draft(self):
        self.publish()
        self.assertFalse(self.release['draft'])
        self.assertIn('--latest=true', self.calls[-1])

    def test_old_success_publishes_without_regressing_latest(self):
        self.latest, self.status = 'deploy-' + self.previous, 'behind'
        self.publish()
        self.assertFalse(self.release['draft'])
        self.assertIn('--latest=false', self.calls[-1])

    def test_new_success_promotes_even_if_main_has_advanced(self):
        self.latest = 'deploy-' + self.previous
        self.publish()
        self.assertIn('--latest=true', self.calls[-1])
        self.assertFalse(any('/git/ref/' in str(call) for call in self.calls))

    def test_retry_fills_draft_but_never_overwrites_public_assets(self):
        self.release = {'tag_name': self.tag, 'draft': True, 'assets': []}
        self.publish()
        self.assertTrue(any(call[1:3] == ['release', 'upload'] for call in self.calls))
        self.calls.clear()
        self.publish()
        self.assertFalse(any(call[1:3] in (['release', 'create'], ['release', 'upload'], ['release', 'edit']) for call in self.calls))

    def test_checksum_failure_prevents_all_github_writes(self):
        (self.root / 'fixture.tar.gz').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.publish()
        self.assertFalse(self.calls)


if __name__ == '__main__':
    unittest.main()
