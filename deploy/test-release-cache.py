"""Deterministic public-release discovery, cache and worker freshness tests."""
from collections import Counter
from dataclasses import replace
from email.message import Message
from email.utils import formatdate
import io
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
import urllib.error
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/update-service'))
import registry
import releases


OLD = 'b' * 40
NEW = 'a' * 40
NEXT = 'c' * 40
INSTALLER = b'#!/usr/bin/env bash\n# CI RELEASE HELPERS\n: "${PROJECT_DEPLOY_MANIFEST_FILE}"\n'
GITHUB_TOKEN = 'github_pat_' + 'A1b2c3d4' * 8


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class FakeNetwork:
    """A mutable release server with no route to the real network."""
    def __init__(self, modules):
        self.calls = []
        self.values = {}
        self.failures = set()
        self.comparison = {'status': 'ahead'}
        for number, module in enumerate(modules, 1):
            self.values[module.repository] = {'module': module, 'latest': NEW, 'target': None, 'releases': {}}
            self.add(module, NEW, number)

    def add(self, module, commit, release_id):
        artifacts = {arch: {'file': module.repository + '-' + arch + '.tar.gz',
                            'sha256': '3' * 64, 'application_key': '2' * 64}
                     for arch in ('linux-x64', 'linux-arm64')}
        manifest = {'schema': 1, 'repository': 'hxx344/' + module.repository,
                    'commit': commit, 'tag': 'deploy-' + commit, 'artifacts': artifacts}
        metadata = {'id': release_id, 'draft': False, 'prerelease': False,
                    'published_at': '2026-10-09T12:00:00Z', 'tag_name': 'deploy-' + commit,
                    'assets': [{'name': 'release-manifest.json', 'state': 'uploaded', 'size': len(encoded(manifest))}] +
                    [{'name': item['file'], 'state': 'uploaded', 'size': 12345, 'digest': 'sha256:' + item['sha256']}
                     for item in artifacts.values()]}
        value = {'manifest': manifest, 'metadata': metadata, 'installer': INSTALLER}
        self.values[module.repository]['releases'][commit] = value
        return value

    def record(self, url, method):
        self.calls.append((url, method))
        if (url, method) in self.failures:
            raise releases.ReleaseError('fixture network unavailable')

    def redirect(self, url):
        self.record(url, 'HEAD')
        for repository, entry in self.values.items():
            base = f'https://github.com/hxx344/{repository}/releases/'
            if url == base + 'latest':
                return entry['target'] if entry['target'] is not None else base + 'tag/deploy-' + entry['latest']
        raise AssertionError('Unexpected discovery: ' + url)

    def request(self, url, maximum=releases.MAX_JSON, method='GET'):
        self.record(url, method)
        for repository, entry in self.values.items():
            base = 'https://api.github.com/repos/hxx344/' + repository + '/'
            if url == base + 'releases/latest':
                return encoded(entry['releases'][entry['latest']]['metadata'])
            if url.startswith(base + 'compare/'):
                return encoded(self.comparison)
            for commit, value in entry['releases'].items():
                if url == base + 'releases/' + str(value['metadata']['id']):
                    return encoded(value['metadata'])
                download = f'https://github.com/hxx344/{repository}/releases/download/deploy-{commit}/'
                if url == download + 'release-manifest.json':
                    return encoded(value['manifest'])
                if method == 'HEAD' and any(url == download + item['file'] for item in value['manifest']['artifacts'].values()):
                    return b''
                if url == f'https://raw.githubusercontent.com/hxx344/{repository}/{commit}/{entry["module"].installer}':
                    return value['installer']
        raise AssertionError('Unexpected request: ' + method + ' ' + url)

    def counts(self):
        result = Counter()
        for url, method in self.calls:
            if '/compare/' in url:
                result['compare'] += 1
            elif url.startswith('https://api.github.com/'):
                result['metadata'] += 1
            elif url.startswith('https://raw.githubusercontent.com/'):
                result['installer'] += 1
            elif url.endswith('/releases/latest'):
                result['discovery'] += 1
            elif url.endswith('/release-manifest.json'):
                result['manifest'] += 1
            elif method == 'HEAD':
                result['artifact'] += 1
        return result


class ReleaseCacheTests(unittest.TestCase):
    def setUp(self):
        self.module = registry.BY_ID['hub']
        self.network = FakeNetwork([self.module])
        self.clock = 1800000000.0
        self.reader = releases.Releases(self.network, arch='linux-x64', clock=lambda: self.clock)
        self.entry = self.network.values[self.module.repository]
        self.value = self.entry['releases'][NEW]

    def test_repeated_check_revalidates_discovery_manifest_and_artifact_only(self):
        self.value['metadata']['body'] = '修复版本检查\n保留更新内容 🚀'
        first = self.reader.read(self.module)
        self.value['metadata']['body'] = '同一版本的说明稍后才刷新'
        second = self.reader.read(self.module)
        self.assertEqual(first, second)
        self.assertEqual(second['releaseNotes'], '修复版本检查\n保留更新内容 🚀')
        self.assertEqual(self.network.counts(), {'discovery': 2, 'manifest': 2, 'artifact': 2,
                                                 'metadata': 1, 'installer': 1})
        first['manifest']['repository'] = 'changed-by-caller'
        second['manifest']['artifacts'].clear()
        self.assertEqual(self.reader.read(self.module)['manifest'], self.value['manifest'])

    def test_release_notes_preserve_plain_text_and_normalize_controls(self):
        self.value['metadata']['body'] = (' \r\n## 更新内容\r\n- 中文与表情 👩‍💻\r'
                                          '\t<script>alert("text")</script>\n'
                                          '\x00\x08\x0b\x0c\x1b\x7f\x85\u061c\u200e\u200f'
                                          '\u202a\u202e\u2066\u2069\ud800结束\udfff \n')
        result = self.reader.read(self.module)
        self.assertEqual(result['releaseNotes'], '## 更新内容\n- 中文与表情 👩‍💻\n'
                                                '\t<script>alert("text")</script>\n结束')
        self.assertEqual(result['commit'], NEW)

    def test_missing_invalid_or_whitespace_release_notes_do_not_block_checks(self):
        self.assertEqual(self.reader.read(self.module)['releaseNotes'], '')
        for body in (None, False, 123, [], {'text': 'not a string'}, ' \r\n\t\x00 '):
            with self.subTest(body=body):
                self.value['metadata']['body'] = body
                result = self.reader.read(self.module, self.value['metadata']['id'])
                self.assertEqual(result['releaseNotes'], '')
                self.assertEqual(result['commit'], NEW)

    def test_release_notes_limit_utf8_bytes_without_splitting_unicode(self):
        for body in ('a' * 6000, '中' * 2000, '🚀' * 1500):
            with self.subTest(boundary=body[:1]):
                self.value['metadata']['body'] = body
                result = self.reader.read(self.module, self.value['metadata']['id'])
                self.assertEqual(result['releaseNotes'], body)
        for body in ('a' * 6001, '中' * 3000, '🚀' * 2000):
            with self.subTest(truncated=body[:1]):
                self.value['metadata']['body'] = body
                text = self.reader.read(self.module, self.value['metadata']['id'])['releaseNotes']
                self.assertLessEqual(len(text.encode('utf-8')), 6000)
                self.assertTrue(text.endswith('\n（更新内容过长，已截断）'))
                prefix = text.removesuffix('\n（更新内容过长，已截断）')
                self.assertTrue(body.startswith(prefix))
                self.assertNotIn('\ufffd', text)

    def test_changed_manifest_revalidates_eligibility_and_manifest_with_pinned_installer_cache(self):
        first = self.reader.read(self.module)
        self.value['manifest']['node_version'] = '24.15.0'
        second = self.reader.read(self.module)
        self.assertNotEqual(first['manifestHash'], second['manifestHash'])
        self.assertEqual(second['manifest']['node_version'], '24.15.0')
        self.assertEqual(self.network.counts()['metadata'], 2)
        self.assertEqual(self.network.counts()['installer'], 1)
        self.value['manifest']['node_version'] = 'invalid'
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)
        self.assertFalse(self.reader._releases)

    def test_cache_expiry_refreshes_recreated_release_id_without_leaking_timestamps(self):
        self.value['metadata']['body'] = '最初的更新内容'
        first = self.reader.read(self.module)
        self.value['metadata']['id'] = 2
        self.value['metadata']['published_at'] = '2026-10-10T12:00:00Z'
        self.value['metadata']['body'] = '已修订的更新内容'
        self.clock += releases.RELEASE_CACHE_TTL - 1
        self.assertEqual(self.reader.read(self.module), first)
        self.assertEqual(self.network.counts()['metadata'], 1)
        self.clock += 1
        refreshed = self.reader.read(self.module)
        self.assertEqual(refreshed['releaseId'], 2)
        self.assertEqual(refreshed['publishedAt'], self.value['metadata']['published_at'])
        self.assertEqual(refreshed['releaseNotes'], '已修订的更新内容')
        self.assertEqual(refreshed['manifestHash'], first['manifestHash'])
        self.assertEqual(set(refreshed), {'releaseId', 'commit', 'tag', 'version', 'publishedAt', 'releaseNotes', 'manifest',
                                         'manifestHash', 'manifestBytes', 'installer', 'installerHash', 'applicationKey'})
        self.assertEqual(self.network.counts()['metadata'], 2)
        self.assertEqual(self.network.counts()['installer'], 1)
        self.assertEqual(self.reader.read(self.module), refreshed)
        self.assertEqual(self.network.counts()['metadata'], 2)

    def test_cache_expiry_rechecks_formal_release_eligibility(self):
        self.reader.read(self.module)
        self.value['metadata']['prerelease'] = True
        self.clock += releases.RELEASE_CACHE_TTL - 1
        self.reader.read(self.module)
        self.assertEqual(self.network.counts()['metadata'], 1)
        self.clock += 1
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)
        self.assertFalse(self.reader._releases)
        self.assertEqual(self.network.counts()['metadata'], 2)

    def test_new_tag_fetches_new_metadata_installer_and_artifact(self):
        self.value['metadata']['body'] = '旧版本的更新内容'
        self.assertEqual(self.reader.read(self.module)['releaseNotes'], '旧版本的更新内容')
        self.network.add(self.module, NEXT, 2)
        self.entry['latest'] = NEXT
        result = self.reader.read(self.module)
        self.assertEqual(result['commit'], NEXT)
        self.assertEqual(result['releaseNotes'], '')
        self.assertEqual(self.network.counts(), {'discovery': 2, 'manifest': 2, 'artifact': 2,
                                                 'metadata': 2, 'installer': 2})

    def test_latest_tag_race_cannot_populate_or_return_cache(self):
        self.reader.read(self.module)
        self.network.add(self.module, NEXT, 2)
        self.entry['target'] = f'https://github.com/hxx344/{self.module.repository}/releases/tag/deploy-{NEXT}'
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)
        self.assertFalse(self.reader._releases)
        self.assertEqual(self.network.counts()['installer'], 1)

    def test_missing_or_cross_repository_redirects_never_reuse_a_cached_release(self):
        base = f'https://github.com/hxx344/{self.module.repository}/releases/'
        for target in [base + 'latest', base, base + 'tag/v1.2.3', base + 'tag/deploy-' + NEW + '/',
                       base + 'tag/deploy-' + NEW + '?preview=1', base + 'tag/deploy-' + NEW + '#fragment',
                       base + 'tag/deploy-' + NEW.upper(), base + 'tag/deploy-%61' + NEW[1:],
                       'https://github.com/hxx344/other/releases/tag/deploy-' + NEW,
                       'https://github.com/other/project-aggregation/releases/tag/deploy-' + NEW,
                       base.replace('github.com', 'github.com.attacker.example') + 'tag/deploy-' + NEW,
                       base.replace('https:', 'http:') + 'tag/deploy-' + NEW,
                       base.replace('github.com', 'user@github.com') + 'tag/deploy-' + NEW,
                       base.replace('github.com', 'github.com:443') + 'tag/deploy-' + NEW, b'']:
            with self.subTest(target=target):
                self.entry['target'] = None
                self.reader.read(self.module)
                self.entry['target'] = target
                before = self.network.counts()
                with self.assertRaises(releases.ReleaseError):
                    self.reader.read(self.module)
                self.assertFalse(self.reader._releases)
                self.assertEqual(self.network.counts()['manifest'], before['manifest'])

    def test_reclassified_release_disappearing_from_latest_cannot_use_cache(self):
        self.reader.read(self.module)
        self.value['metadata']['prerelease'] = True
        self.network.add(self.module, OLD, 2)
        self.entry['latest'] = OLD
        result = self.reader.read(self.module)
        self.assertEqual(result['commit'], OLD)
        self.assertEqual(result['releaseId'], 2)
        self.entry['target'] = f'https://github.com/hxx344/{self.module.repository}/releases/latest'
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)

    def test_failures_at_every_live_probe_cannot_return_stale_success(self):
        urls = [(f'https://github.com/hxx344/{self.module.repository}/releases/latest', 'HEAD'),
                (self.reader.download(self.module, 'deploy-' + NEW, 'release-manifest.json'), 'GET'),
                (self.reader.download(self.module, 'deploy-' + NEW, self.value['manifest']['artifacts']['linux-x64']['file']), 'HEAD')]
        for failure in urls:
            with self.subTest(failure=failure):
                self.reader.read(self.module)
                self.network.failures.add(failure)
                with self.assertRaises(releases.ReleaseError):
                    self.reader.read(self.module)
                self.assertFalse(self.reader._releases)
                self.network.failures.clear()
                previous = self.network.counts()['metadata']
                self.reader.read(self.module)
                self.assertEqual(self.network.counts()['metadata'], previous + 1)

    def test_changed_manifest_cannot_skip_revoked_eligibility(self):
        self.reader.read(self.module)
        self.value['manifest']['node_version'] = '24.15.0'
        self.value['metadata']['prerelease'] = True
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)
        self.assertFalse(self.reader._releases)

    def test_transient_probe_failure_preserves_metadata_but_never_returns_success(self):
        self.reader.read(self.module)
        original = self.network.request
        artifact = self.reader.download(self.module, 'deploy-' + NEW,
                                        self.value['manifest']['artifacts']['linux-x64']['file'])
        for url in (self.reader.download(self.module, 'deploy-' + NEW, 'release-manifest.json'), artifact):
            with self.subTest(url=url):
                def unavailable(target, *args, **kwargs):
                    if target == url:
                        raise releases.ReleaseError('temporary failure', transient=True)
                    return original(target, *args, **kwargs)
                with patch.object(self.network, 'request', side_effect=unavailable):
                    with self.assertRaises(releases.ReleaseError):
                        self.reader.read(self.module)
                self.assertTrue(self.reader._releases)
                before = self.network.counts()
                self.reader.read(self.module)
                self.assertEqual(self.network.counts() - before, {'discovery': 1, 'manifest': 1, 'artifact': 1})
        with patch.object(self.network, 'redirect', side_effect=releases.ReleaseError('temporary', transient=True)):
            with self.assertRaises(releases.ReleaseError):
                self.reader.read(self.module)
        self.clock += releases.RELEASE_CACHE_TTL
        self.value['metadata']['prerelease'] = True
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)
        self.assertFalse(self.reader._releases)

    def test_recovery_after_transient_failure_still_checks_changed_manifest(self):
        self.reader.read(self.module)
        with patch.object(self.network, 'redirect', side_effect=releases.ReleaseError('temporary', transient=True)):
            with self.assertRaises(releases.ReleaseError):
                self.reader.read(self.module)
        self.value['manifest']['node_version'] = '24.15.0'
        self.value['metadata']['prerelease'] = True
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)
        self.assertFalse(self.reader._releases)

    def test_explicit_release_id_bypasses_all_caches_and_latest_discovery(self):
        self.reader.read(self.module)
        self.entry['target'] = 'https://github.com/unusable'
        self.value['manifest']['node_version'] = '24.15.0'
        self.value['installer'] += b'# changed after review\n'
        before = self.network.counts()
        result = self.reader.read(self.module, self.value['metadata']['id'])
        after = self.network.counts()
        self.assertEqual(after - before, {'metadata': 1, 'manifest': 1, 'artifact': 1, 'installer': 1})
        self.assertEqual(result['installer'], self.value['installer'])
        self.assertEqual(result['manifest']['node_version'], '24.15.0')
        self.value['metadata']['prerelease'] = True
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module, self.value['metadata']['id'])

    def test_explicit_release_id_checks_live_installer_and_artifact_failures(self):
        self.reader.read(self.module)
        self.value['installer'] = b'#!/bin/bash\necho no-fixed-plan-support\n'
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module, self.value['metadata']['id'])
        self.value['installer'] = INSTALLER
        filename = self.value['manifest']['artifacts']['linux-x64']['file']
        self.network.failures.add((self.reader.download(self.module, 'deploy-' + NEW, filename), 'HEAD'))
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module, self.value['metadata']['id'])

    def test_commit_comparisons_and_installers_are_bounded_and_repository_scoped(self):
        other = replace(self.module, id='fixture-other', repository='fixture-other')
        self.network = FakeNetwork([self.module, other])
        self.reader = releases.Releases(self.network, arch='linux-x64')
        for module in (self.module, other):
            self.assertTrue(self.reader.is_newer(module, OLD, NEW))
            self.assertTrue(self.reader.is_newer(module, OLD, NEW))
            self.reader.installer(module, NEW)
            self.reader.installer(module, NEW)
        self.assertEqual(self.network.counts(), {'compare': 2, 'installer': 2})
        with patch.object(releases, 'MAX_INSTALLER_CACHE', 2), patch.object(releases, 'MAX_COMPARISON_CACHE', 2):
            for number in range(5):
                commit = f'{number:040x}'
                self.network.add(self.module, commit, number + 10)
                self.reader.installer(self.module, commit)
                self.reader.is_newer(self.module, commit, NEW)
            self.assertEqual(len(self.reader._installers), 2)
            self.assertEqual(len(self.reader._comparisons), 2)
            before = self.network.counts()
            self.reader.installer(self.module, NEW)
            self.reader.is_newer(self.module, OLD, NEW)
            self.assertEqual(self.network.counts() - before, {'compare': 1, 'installer': 1})

    def test_negative_comparison_results_are_cached_and_errors_are_not(self):
        self.network.comparison = {'status': 'behind'}
        self.assertFalse(self.reader.is_newer(self.module, OLD, NEW))
        self.assertFalse(self.reader.is_newer(self.module, OLD, NEW))
        self.assertEqual(self.network.counts()['compare'], 1)
        for status in ('diverged', 'unknown'):
            self.network.comparison = {'status': status}
            for _ in range(2):
                with self.assertRaises(releases.ReleaseError):
                    self.reader.is_newer(self.module, OLD, NEXT)
        self.assertEqual(self.network.counts()['compare'], 5)

    def test_release_cache_is_architecture_scoped_and_bounded(self):
        self.reader.read(self.module)
        self.reader.arch = 'linux-arm64'
        self.reader.read(self.module)
        self.reader.arch = 'linux-x64'
        self.reader.read(self.module)
        self.assertEqual(self.network.counts()['metadata'], 2)
        self.assertEqual(self.network.counts()['installer'], 1)
        fixtures = [replace(self.module, id=f'fixture-{i}', repository=f'fixture-{i}') for i in range(3)]
        self.network = FakeNetwork(fixtures)
        self.reader = releases.Releases(self.network, arch='linux-x64')
        with patch.object(releases, 'MAX_RELEASE_CACHE', 2):
            for module in fixtures:
                self.reader.read(module)
            self.assertEqual(len(self.reader._releases), 2)
            before = self.network.counts()['metadata']
            self.reader.read(fixtures[0])
            self.assertEqual(self.network.counts()['metadata'], before + 1)

    def test_x64_only_release_is_readable_but_cannot_supply_an_arm_reader(self):
        removed = self.value['manifest']['artifacts'].pop('linux-arm64')
        self.value['metadata']['assets'] = [asset for asset in self.value['metadata']['assets']
                                            if asset['name'] != removed['file']]
        result = self.reader.read(self.module)
        self.assertEqual(result['commit'], NEW)
        self.assertEqual(set(result['manifest']['artifacts']), {'linux-x64'})
        before = self.network.counts()
        self.reader.arch = 'linux-arm64'
        with self.assertRaisesRegex(releases.ReleaseError, '缺少匹配本机的完整部署包'):
            self.reader.read(self.module)
        self.assertNotIn((self.module.repository, 'linux-arm64'), self.reader._releases)
        self.assertEqual(self.network.counts()['artifact'], before['artifact'])
        self.assertEqual(self.network.counts()['installer'], before['installer'])

    def test_request_only_adapters_keep_complete_uncached_validation(self):
        reader = releases.Releases(SimpleNamespace(request=self.network.request), arch='linux-x64')
        reader.read(self.module)
        self.value['installer'] += b'# changed fixture\n'
        self.assertEqual(reader.read(self.module)['installer'], self.value['installer'])
        self.assertEqual(self.network.counts(), {'metadata': 2, 'manifest': 2, 'artifact': 2, 'installer': 2})
        self.assertFalse(reader._releases)
        self.assertFalse(reader._installers)

    def test_cold_installer_and_artifact_checks_can_progress_concurrently(self):
        installer_started = threading.Event()
        head_started = threading.Event()
        original = self.network.request

        def overlapping(url, maximum=releases.MAX_JSON, method='GET'):
            if method == 'HEAD':
                head_started.set()
                if not installer_started.wait(5):
                    raise AssertionError('installer was blocked by artifact HEAD')
            if url.startswith('https://raw.githubusercontent.com/'):
                installer_started.set()
                if not head_started.wait(5):
                    raise AssertionError('artifact HEAD was blocked by installer')
            return original(url, maximum, method)

        self.network.request = overlapping
        self.reader.read(self.module)
        self.assertTrue(installer_started.is_set())
        self.assertTrue(head_started.is_set())

    def overlap(self, first, second):
        """Make each matched request wait until the other one is in flight."""
        events = {first: threading.Event(), second: threading.Event()}
        original = self.network.request

        def overlapping(url, maximum=releases.MAX_JSON, method='GET'):
            for name, matches in ((first, events[first]), (second, events[second])):
                if self.kind(url, method) == name:
                    matches.set()
                    other = events[second if name == first else first]
                    if not other.wait(5):
                        raise AssertionError(name + ' was serialized before the other probe')
            return original(url, maximum, method)

        self.network.request = overlapping
        return events

    @staticmethod
    def kind(url, method):
        if url.startswith('https://api.github.com/'):
            return 'metadata'
        if url.endswith('/release-manifest.json'):
            return 'manifest'
        return 'artifact' if method == 'HEAD' else 'other'

    def test_cold_manifest_and_metadata_are_requested_concurrently(self):
        events = self.overlap('manifest', 'metadata')
        self.assertEqual(self.reader.read(self.module)['commit'], NEW)
        self.assertTrue(all(event.is_set() for event in events.values()))

    def test_cached_artifact_probe_overlaps_manifest_and_keeps_request_counts(self):
        self.reader.read(self.module)
        events = self.overlap('manifest', 'artifact')
        before = self.network.counts()
        self.reader.read(self.module)
        self.assertTrue(all(event.is_set() for event in events.values()))
        self.assertEqual(self.network.counts() - before, {'discovery': 1, 'manifest': 1, 'artifact': 1})

    def test_concurrent_probe_failures_keep_original_error_precedence(self):
        manifest = (self.reader.download(self.module, 'deploy-' + NEW, 'release-manifest.json'), 'GET')
        metadata = (self.reader.api(self.module, 'releases/latest'), 'GET')
        self.network.failures.update({manifest, metadata})
        with self.assertRaisesRegex(releases.ReleaseError, 'fixture network unavailable') as caught, \
                patch.object(self.reader, 'metadata', side_effect=releases.ReleaseError('metadata failed', transient=True)):
            self.reader.read(self.module)
        self.assertFalse(caught.exception.transient)
        self.network.failures.clear()
        self.reader.read(self.module)
        self.value['manifest']['node_version'] = '24.15.0'
        artifact = (self.reader.download(self.module, 'deploy-' + NEW, self.value['manifest']['artifacts']['linux-x64']['file']), 'HEAD')
        self.network.failures.add(artifact)
        with self.assertRaises(releases.ReleaseError):
            self.reader.read(self.module)
        self.network.failures.clear()
        # The speculative probe of the old manifest cannot replace the new full validation.
        self.assertEqual(self.reader.read(self.module)['manifest']['node_version'], '24.15.0')


class TransportTests(unittest.TestCase):
    def http_error(self, code, headers=None, url='https://api.github.com/repos/hxx344/project-aggregation/releases/latest', token=''):
        network = releases.Network(token_provider=lambda: token)
        network.opener = unittest.mock.Mock()
        response_headers = Message()
        for key, value in (headers or {}).items():
            response_headers[key] = value
        body = io.BytesIO(b'private upstream details must not be shown')
        network.opener.open.side_effect = urllib.error.HTTPError(url, code, 'private reason', response_headers, body)
        with self.assertRaises(releases.ReleaseError) as caught, patch.object(releases.time, 'time', return_value=1800000000):
            network.request(url)
        self.assertTrue(body.closed)
        self.assertNotIn('private', str(caught.exception))
        self.assertNotIn('secret', str(caught.exception))
        self.assertNotIn(GITHUB_TOKEN, str(caught.exception))
        return caught.exception

    def test_authentication_headers_only_reach_https_github_api_and_are_read_per_request(self):
        provider = unittest.mock.Mock(side_effect=[GITHUB_TOKEN, 'R' * 20, ''])
        network = releases.Network(token_provider=provider)
        network.opener = unittest.mock.Mock()
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.headers = {}
        response.read.return_value = b'{}'
        network.opener.open.return_value = response
        for host in ('github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'):
            response.url = f'https://{host}/fixed-path'
            network.request(response.url)
            self.assertIsNone(network.opener.open.call_args.args[0].get_header('Authorization'))
        provider.assert_not_called()
        for url, token in (('https://api.github.com/repos/fixed', GITHUB_TOKEN),
                           ('https://api.github.com:443/repos/fixed', 'R' * 20),
                           ('https://api.github.com/repos/fixed', '')):
            response.url = url
            network.request(url)
            self.assertEqual(network.opener.open.call_args.args[0].get_header('Authorization'),
                             'Bearer ' + token if token else None)
        self.assertEqual(provider.call_count, 3)
        for url in ('http://api.github.com/fixed', 'https://api.github.com:444/fixed',
                    'https://api.github.com.attacker.example/fixed', 'https://user@api.github.com/fixed'):
            with self.assertRaises(releases.ReleaseError):
                network.request(url)
        self.assertEqual(provider.call_count, 3)

    def test_environment_tokens_are_ignored_and_provider_errors_fail_closed(self):
        with patch.dict(os.environ, {'GITHUB_TOKEN': GITHUB_TOKEN, 'GH_TOKEN': GITHUB_TOKEN}):
            self.assertEqual(releases.Network().token_provider(), '')
        for provider in (lambda: GITHUB_TOKEN + '\r\nHeader: bad', lambda: 123,
                         unittest.mock.Mock(side_effect=OSError(GITHUB_TOKEN))):
            network = releases.Network(token_provider=provider)
            network.opener = unittest.mock.Mock()
            with self.assertRaises(releases.ReleaseError) as caught:
                network.request('https://api.github.com/repos/fixed')
            self.assertNotIn(GITHUB_TOKEN, str(caught.exception))
            network.opener.open.assert_not_called()

    def test_redirects_strip_all_authorization_variants_and_never_restore_them(self):
        redirect = releases.SafeRedirect()
        for key in ('Authorization', 'authorization', 'AUTHORIZATION', 'aUtHoRiZaTiOn'):
            with self.subTest(key=key):
                request = urllib.request.Request('https://api.github.com/repos/fixed')
                request.headers[key] = 'Bearer ' + GITHUB_TOKEN
                request.unredirected_hdrs[key] = 'Bearer ' + GITHUB_TOKEN
                same_origin = redirect.redirect_request(request, None, 302, '', {}, 'https://api.github.com:443/repos/moved')
                self.assertTrue(any(k.lower() == 'authorization' for k in same_origin.headers))
                redirected = redirect.redirect_request(request, None, 302, '', {}, 'https://github.com/releases/fixed')
                self.assertFalse(any(k.lower() == 'authorization' for k in dict(redirected.header_items())))
                back_to_api = redirect.redirect_request(redirected, None, 302, '', {}, 'https://api.github.com/repos/returned')
                self.assertFalse(any(k.lower() == 'authorization' for k in dict(back_to_api.header_items())))
                for target in ('http://api.github.com/repos/fixed', 'https://api.github.com:8443/fixed', 'https://attacker.example/fixed'):
                    with self.assertRaises(releases.ReleaseError):
                        redirect.redirect_request(request, None, 302, '', {}, target)

    def test_invalid_token_and_authenticated_quota_have_specific_safe_errors(self):
        error = self.http_error(401, token=GITHUB_TOKEN)
        self.assertIn('GitHub Token 无效或已过期', str(error))
        self.assertFalse(error.transient)
        self.assertIsNone(error.retry_at)
        for code in (403, 429):
            error = self.http_error(code, {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800001200'}, token=GITHUB_TOKEN)
            self.assertIn('认证请求额度已用尽', str(error))
            self.assertNotIn('匿名', str(error))
            self.assertEqual(error.retry_at, 1800001200)
            self.assertTrue(error.transient)
        error = self.http_error(401, url='https://github.com/fixed', token=GITHUB_TOKEN)
        self.assertNotIn('Token', str(error))

    def test_primary_limit_reports_api_quota_and_server_reset(self):
        error = self.http_error(403, {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800001200'})
        self.assertIn('GitHub API匿名请求额度已用尽', str(error))
        self.assertIn('HTTP 403', str(error))
        self.assertEqual(error.retry_at, 1800001200)
        self.assertTrue(error.transient)

    def test_secondary_limit_honors_seconds_or_http_date_and_later_reset(self):
        for headers, deadline in [({'Retry-After': '90'}, 1800000090),
                                  ({'Retry-After': formatdate(1800000300, usegmt=True)}, 1800000300),
                                  ({'Retry-After': '60', 'X-RateLimit-Remaining': '0',
                                    'X-RateLimit-Reset': '1800001200'}, 1800001200)]:
            with self.subTest(headers=headers):
                error = self.http_error(429, headers)
                self.assertEqual(error.retry_at, deadline)
                self.assertTrue(error.transient)

    def test_plain_forbidden_is_not_misreported_as_api_rate_limit(self):
        for host, label in [('api.github.com', 'GitHub API'), ('github.com', 'GitHub 发布服务'),
                            ('release-assets.githubusercontent.com', 'GitHub 发布文件服务')]:
            error = self.http_error(403, url=f'https://{host}/download?secret=signed-query')
            self.assertIn(label + '拒绝访问', str(error))
            self.assertNotIn('额度', str(error))
            self.assertIsNone(error.retry_at)
            self.assertTrue(error.transient)

    def test_invalid_past_and_excessive_retry_headers_are_bounded(self):
        for value in ('-1', 'NaN', 'Infinity', 'bad date', '999999999999999999999', formatdate(1799999999, usegmt=True)):
            with self.subTest(value=value):
                self.assertIsNone(self.http_error(429, {'Retry-After': value}).retry_at)
        self.assertEqual(self.http_error(429, {'Retry-After': '9999999999'}).retry_at,
                         1800000000 + releases.MAX_RETRY_DELAY)
        self.assertIsNone(self.http_error(403, {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1799999999'}).retry_at)

    def test_missing_and_server_errors_have_distinct_cache_policy(self):
        self.assertFalse(self.http_error(404).transient)
        error = self.http_error(503, {'Retry-After': '120'})
        self.assertTrue(error.transient)
        self.assertEqual(error.retry_at, 1800000120)
        self.assertIn('HTTP 503', str(error))

    def test_transport_failure_identifies_endpoint_without_raw_error_details(self):
        network = releases.Network()
        network.opener = unittest.mock.Mock()
        network.opener.open.side_effect = urllib.error.URLError('private proxy credentials')
        with self.assertRaises(releases.ReleaseError) as caught, patch.object(releases.time, 'sleep') as sleep:
            network.request('https://raw.githubusercontent.com/hxx344/project-aggregation/fixed/deploy/install.sh')
        self.assertIn('安装器源码服务', str(caught.exception))
        self.assertNotIn('private', str(caught.exception))
        self.assertTrue(caught.exception.transient)
        self.assertEqual(network.opener.open.call_count, releases.CONNECTION_ATTEMPTS)
        sleep.assert_called_once_with(releases.CONNECTION_RETRY_DELAY)

    def test_connection_failure_retries_once_but_http_responses_do_not(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.url = 'https://github.com/hxx344/project-aggregation/releases/download/deploy-' + NEW + '/release-manifest.json'
        response.headers = {}
        response.read.return_value = b'{}'
        for failure in (urllib.error.URLError('reset'), TimeoutError(), ConnectionResetError()):
            with self.subTest(failure=type(failure).__name__):
                network = releases.Network()
                network.opener = unittest.mock.Mock()
                network.opener.open.side_effect = [failure, response]
                with patch.object(releases.time, 'sleep'):
                    self.assertEqual(network.request(response.url), b'{}')
                self.assertEqual(network.opener.open.call_count, 2)
        for code, headers in ((404, {}), (429, {'Retry-After': '90'}), (403, {}), (503, {'Retry-After': '120'}), (502, {})):
            with self.subTest(code=code), patch.object(releases.time, 'sleep') as sleep:
                network = releases.Network()
                network.opener = unittest.mock.Mock()
                message = Message()
                for key, value in headers.items():
                    message[key] = value
                network.opener.open.side_effect = urllib.error.HTTPError(response.url, code, 'reason', message, io.BytesIO())
                with self.assertRaises(releases.ReleaseError):
                    network.request(response.url)
                self.assertEqual(network.opener.open.call_count, 1)
                sleep.assert_not_called()

    def test_head_discovery_returns_final_url_and_request_remains_bytes(self):
        final = 'https://github.com/hxx344/project-aggregation/releases/tag/deploy-' + NEW
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.url = final
        response.headers = {'Content-Length': '2'}
        response.read.return_value = b'{}'
        network = releases.Network()
        network.opener = unittest.mock.Mock()
        network.opener.open.return_value = response
        self.assertEqual(network.redirect('https://github.com/hxx344/project-aggregation/releases/latest'), final)
        request = network.opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), 'HEAD')
        self.assertEqual(request.get_header('Cache-control'), 'no-cache')
        self.assertEqual(request.get_header('Accept'), '*/*')
        self.assertEqual(network.opener.open.call_args.kwargs['timeout'], releases.REQUEST_TIMEOUT)
        response.read.assert_not_called()
        self.assertEqual(network.request('https://api.github.com/repos/hxx344/project-aggregation/releases/latest'), b'{}')
        self.assertEqual(network.opener.open.call_args.args[0].get_header('Accept'), 'application/vnd.github+json')
        self.assertEqual(network.request(final, method='HEAD'), b'')
        response.url = 'https://attacker.example/release'
        with self.assertRaises(releases.ReleaseError):
            network.redirect('https://github.com/hxx344/project-aggregation/releases/latest')


if __name__ == '__main__':
    unittest.main(verbosity=2)
