"""Candidate publication boundaries, with no GitHub network or credentials."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
PUBLISHER = Path(__file__).resolve().parents[1] / 'deploy/publish-release.py'


class PublishRelease(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='candidate-publish-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.commit = 'b' * 40
        self.repo, self.tag = 'hxx344/fixture', 'deploy-' + self.commit
        archive = self.root / 'fixture.tar.gz'; archive.write_bytes(b'fixture archive')
        item = {'file': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'application_key': 'c' * 64}
        self.manifest = {'schema': 1, 'repository': self.repo, 'commit': self.commit, 'tag': self.tag,
                         'artifacts': {'linux-x64': item}}
        (self.root / 'release-manifest.json').write_text(json.dumps(self.manifest), encoding='utf8')
        self.release = None
        self.calls = []
        self.upload_failure = False
        self.remote_manifest = self.manifest
        self.notes = '- 系统更新弹窗只显示中文摘要 🚀\n- 更新时保留已有配置'
        self.message = ('feat(updates): show concise release notes\n\nEnglish implementation detail.\n\n'
                        '更新说明：\n' + self.notes + '\n风险等级：R2\n已运行：fixture\n\n'
                        'Co-authored-by: fixture <fixture@example.invalid>\n')
        self.git_failure = False
        self.notes_files = []

    def fake_command(self, args, **kwargs):
        self.calls.append(args)
        if args[0] == 'git':
            self.assertEqual(args, ['git', 'log', '-1', '--format=%B', self.commit])
            self.assertIs(kwargs.get('shell'), False)
            self.assertEqual(kwargs.get('encoding'), 'utf-8')
            self.assertTrue(kwargs.get('text'))
            self.assertTrue(kwargs.get('check'))
            if self.git_failure:
                raise subprocess.CalledProcessError(1, args, '', 'fixture git failure')
            return subprocess.CompletedProcess(args, 0, self.message, '')
        self.assertEqual(args[0], 'gh')
        self.assertNotIn('shell', kwargs)
        code, stdout, stderr = 0, '', ''
        operation = args[1:3]
        if operation == ['release', 'view']:
            if self.release:
                stdout = json.dumps({'isDraft': self.release['draft'], 'assets': self.release['assets']})
            else:
                code, stderr = 1, 'release not found'
        elif operation == ['release', 'create']:
            self.assertIn('--draft', args)
            self.release = {'tag_name': self.tag, 'draft': True, 'prerelease': True, 'assets': [],
                            'body': self.read_notes(args)}
        elif operation == ['release', 'upload']:
            self.assertTrue(self.release['draft'])
            if self.upload_failure:
                code, stderr = 1, 'fixture upload failure'
            else:
                source = next(Path(value) for value in args[4:] if Path(value).is_file())
                self.release['assets'].append({'name': source.name})
        elif operation == ['release', 'edit']:
            self.assertTrue(self.release['draft'])
            self.assertIn('--draft=false', args)
            self.assertIn('--prerelease=true', args)
            self.assertIn('--latest=false', args)
            self.release.update(draft=False, prerelease=True, body=self.read_notes(args))
        elif operation == ['release', 'download']:
            directory = Path(args[args.index('--dir') + 1]); name = args[args.index('--pattern') + 1]
            if name == 'release-manifest.json':
                (directory / name).write_text(json.dumps(self.remote_manifest), encoding='utf8')
            else:
                (directory / name).write_bytes((self.root / name).read_bytes())
        else:
            self.fail('Candidate CI must not inspect or mutate latest: ' + str(args))
        if kwargs.get('check') and code:
            raise subprocess.CalledProcessError(code, args, stdout, stderr)
        return subprocess.CompletedProcess(args, code, stdout, stderr)

    def read_notes(self, args):
        self.assertNotIn('--notes', args)
        self.assertIn('--notes-file', args)
        source = Path(args[args.index('--notes-file') + 1])
        self.assertTrue(source.is_file())
        self.notes_files.append(source)
        return source.read_bytes().decode('utf-8')

    def publish(self):
        environment = {'GITHUB_REPOSITORY': self.repo, 'GITHUB_SHA': self.commit,
                       'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'push'}
        with patch.dict(os.environ, environment), patch.object(sys, 'argv', [str(PUBLISHER), str(self.root)]), \
                patch('subprocess.run', self.fake_command):
            try:
                runpy.run_path(str(PUBLISHER), run_name='__main__')
            except SystemExit as error:
                self.assertEqual(error.code, 0)

    def writes(self):
        return [call for call in self.calls if call[1:3] in (['release', 'create'], ['release', 'upload'], ['release', 'edit'])]

    def test_first_complete_candidate_never_advances_stable_or_compares_ancestry(self):
        self.publish()
        self.assertFalse(self.release['draft']); self.assertTrue(self.release['prerelease'])
        self.assertEqual({item['name'] for item in self.release['assets']}, {'fixture.tar.gz', 'release-manifest.json'})
        self.assertEqual(self.calls[-1][1:3], ['release', 'edit'])
        self.assertFalse(any(call[1] == 'api' for call in self.calls))
        self.assertEqual(self.release['body'], self.notes + '\n')
        self.assertEqual(len(self.notes_files), 2)
        self.assertFalse(any(path.exists() for path in self.notes_files))

    def test_retry_completes_draft_before_publishing_candidate(self):
        self.release = {'tag_name': self.tag, 'draft': True, 'assets': [], 'body': 'Old generic notes'}
        self.publish()
        self.assertFalse(any(call[1:3] == ['release', 'create'] for call in self.calls))
        self.assertEqual(sum(call[1:3] == ['release', 'upload'] for call in self.calls), 2)
        self.assertTrue(self.release['prerelease'])
        self.assertEqual(self.release['body'], self.notes + '\n')
        self.assertEqual(len(self.notes_files), 1)
        self.assertFalse(self.notes_files[0].exists())

    def test_upload_failure_leaves_draft_unpublished(self):
        self.upload_failure = True
        with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
            self.publish()
        self.assertTrue(self.release['draft'])
        self.assertFalse(any(call[1:3] == ['release', 'edit'] for call in self.calls))
        self.assertFalse(any(path.exists() for path in self.notes_files))

    def test_git_failure_prevents_creating_or_publishing_a_candidate(self):
        for draft in [None, {'tag_name': self.tag, 'draft': True, 'assets': [], 'body': 'Existing draft notes'}]:
            with self.subTest(draft=bool(draft)):
                self.calls.clear(); self.release = draft; self.git_failure = True
                with self.assertRaises(subprocess.CalledProcessError):
                    self.publish()
                self.assertEqual(self.writes(), [])
                self.assertEqual(self.release, draft)

    def test_notes_keep_only_the_chinese_user_section(self):
        cases = [
            ('fix: one line\n\n更新说明：修复更新后交易模块停留在维护中\n\n风险等级：R2\n', '修复更新后交易模块停留在维护中\n'),
            ('fix: stop at evidence\n\n更新说明：第一条\n  - 第二条\n已运行：fixture\n', '第一条\n- 第二条\n'),
            ('docs: no section\n\nEnglish body only.\n', '内部维护与稳定性改进，使用方式无变化。\n'),
            ('fix: english\n\n更新说明：Fix the latch\n', '内部维护与稳定性改进，使用方式无变化。\n'),
            ('fix: duplicate\n\n更新说明：甲\n\n更新说明：乙\n', '内部维护与稳定性改进，使用方式无变化。\n'),
        ]
        for message, expected in cases:
            with self.subTest(message=message):
                self.calls.clear(); self.notes_files.clear(); self.release = None; self.message = message
                self.publish()
                self.assertEqual(self.release['body'], expected)
                self.assertNotIn(self.commit, self.release['body'])

    def test_empty_commit_message_prevents_publication(self):
        self.message = '\n \n'
        with self.assertRaisesRegex(ValueError, 'no update description'):
            self.publish()
        self.assertEqual(self.writes(), [])

    def test_rerunning_public_candidate_or_stable_release_makes_no_changes(self):
        for prerelease in [True, False]:
            with self.subTest(prerelease=prerelease):
                self.calls.clear()
                self.release = {'tag_name': self.tag, 'draft': False, 'prerelease': prerelease,
                                'assets': [{'name': 'fixture.tar.gz'}, {'name': 'release-manifest.json'}],
                                'body': 'Already published notes'}
                self.git_failure = True
                self.publish()
                self.assertEqual(self.writes(), [])
                self.assertEqual(self.release['prerelease'], prerelease)
                self.assertEqual(self.release['body'], 'Already published notes')
                self.assertFalse(any(call[0] == 'git' for call in self.calls))

    def test_incomplete_or_different_public_release_is_never_modified(self):
        for assets, remote in [([], self.manifest), ([{'name': 'fixture.tar.gz'}, {'name': 'release-manifest.json'}], {**self.manifest, 'commit': 'a' * 40})]:
            with self.subTest(assets=assets):
                self.calls.clear(); self.release = {'tag_name': self.tag, 'draft': False, 'assets': assets}; self.remote_manifest = remote
                with self.assertRaises(ValueError):
                    self.publish()
                self.assertEqual(self.writes(), [])

    def test_checksum_failure_prevents_all_github_operations(self):
        (self.root / 'fixture.tar.gz').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            self.publish()
        self.assertEqual(self.calls, [])

    def test_invalid_commit_prevents_all_commands(self):
        self.commit = 'main'
        self.manifest.update(commit=self.commit, tag='deploy-' + self.commit)
        (self.root / 'release-manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.publish()
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
