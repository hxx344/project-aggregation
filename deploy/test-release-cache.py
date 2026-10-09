"""Deterministic public-release discovery, cache and worker freshness tests."""
from collections import Counter
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/update-service'))
import registry
import releases


OLD = 'b' * 40
NEW = 'a' * 40
NEXT = 'c' * 40
INSTALLER = b'#!/usr/bin/env bash\n# CI RELEASE HELPERS\n: "${PROJECT_DEPLOY_MANIFEST_FILE}"\n'


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
        first = self.reader.read(self.module)
        second = self.reader.read(self.module)
        self.assertEqual(first, second)
        self.assertEqual(self.network.counts(), {'discovery': 2, 'manifest': 2, 'artifact': 2,
                                                 'metadata': 1, 'installer': 1})
        first['manifest']['repository'] = 'changed-by-caller'
        second['manifest']['artifacts'].clear()
        self.assertEqual(self.reader.read(self.module)['manifest'], self.value['manifest'])

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
        first = self.reader.read(self.module)
        self.value['metadata']['id'] = 2
        self.value['metadata']['published_at'] = '2026-10-10T12:00:00Z'
        self.clock += releases.RELEASE_CACHE_TTL - 1
        self.assertEqual(self.reader.read(self.module), first)
        self.assertEqual(self.network.counts()['metadata'], 1)
        self.clock += 1
        refreshed = self.reader.read(self.module)
        self.assertEqual(refreshed['releaseId'], 2)
        self.assertEqual(refreshed['publishedAt'], self.value['metadata']['published_at'])
        self.assertEqual(refreshed['manifestHash'], first['manifestHash'])
        self.assertEqual(set(refreshed), {'releaseId', 'commit', 'tag', 'version', 'publishedAt', 'manifest',
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
        self.reader.read(self.module)
        self.network.add(self.module, NEXT, 2)
        self.entry['latest'] = NEXT
        result = self.reader.read(self.module)
        self.assertEqual(result['commit'], NEXT)
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
        other = registry.BY_ID['aster']
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
        self.network = FakeNetwork(registry.MODULES)
        self.reader = releases.Releases(self.network, arch='linux-x64')
        with patch.object(releases, 'MAX_RELEASE_CACHE', 2):
            for module in registry.MODULES:
                self.reader.read(module)
            self.assertEqual(len(self.reader._releases), 2)
            before = self.network.counts()['metadata']
            self.reader.read(registry.MODULES[0])
            self.assertEqual(self.network.counts()['metadata'], before + 1)

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


class TransportTests(unittest.TestCase):
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
        self.assertEqual(network.opener.open.call_args.kwargs['timeout'], 25)
        response.read.assert_not_called()
        self.assertEqual(network.request('https://api.github.com/repos/hxx344/project-aggregation/releases/latest'), b'{}')
        self.assertEqual(network.request(final, method='HEAD'), b'')
        response.url = 'https://attacker.example/release'
        with self.assertRaises(releases.ReleaseError):
            network.redirect('https://github.com/hxx344/project-aggregation/releases/latest')


if __name__ == '__main__':
    unittest.main(verbosity=2)
