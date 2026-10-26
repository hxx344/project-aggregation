"""Lock parser compatibility and root-to-build-account isolation checks."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
DEPLOY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('package_release', DEPLOY / 'package-release.py')
package_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_release)
IS_ROOT = os.name == 'posix' and os.geteuid() == 0
LINUX_ROOT = sys.platform == 'linux' and IS_ROOT


class ParserFixture(unittest.TestCase):
    def setUp(self):
        self.node = os.environ.get('RUNTIME_LOCK_TEST_NODE') or shutil.which('node')
        if not self.node:
            self.skipTest('Node is required for the real lock parser subprocess')
        self.temporary = tempfile.TemporaryDirectory(prefix='runtime-lock-parser-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        self.source = self.root / 'source'
        self.dependencies = self.root / 'dependencies'
        self.tools = self.root / 'tools'
        for path in (self.source, self.dependencies, self.tools):
            path.mkdir(mode=0o755)
        shutil.copyfile(DEPLOY / 'pnpm-runtime-lock.mjs', self.tools / 'pnpm-runtime-lock.mjs')
        self.yaml = self.dependencies / 'node_modules/yaml'
        self.yaml.mkdir(parents=True, mode=0o755)
        (self.yaml / 'package.json').write_text(json.dumps({'name': 'yaml', 'main': 'index.js'}), encoding='utf-8')
        (self.yaml / 'index.js').write_text('exports.parse = JSON.parse;\n', encoding='utf-8')
        self.lock = {'lockfileVersion': '9.0', 'importers': {name: {} for name in package_release.IMPORTERS},
                     'packages': {}, 'snapshots': {}}
        (self.source / 'pnpm-lock.yaml').write_text(json.dumps(self.lock), encoding='utf-8')
        for path in self.root.rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o644)
        self.helper_location = patch.object(package_release, '__file__', str(self.tools / 'package-release.py'))
        self.helper_location.start()
        self.addCleanup(self.helper_location.stop)

    def parse(self, parser_user=None):
        return package_release.read_runtime_lock(self.source, [self.dependencies], self.node, parser_user)


class ParserCompatibilityTests(ParserFixture):
    @unittest.skipIf(IS_ROOT, 'Non-root compatibility runs without sudo; root isolation is covered separately')
    def test_existing_non_root_parser_call_still_reads_lockfile(self):
        self.assertEqual(self.parse(), self.lock)

    @unittest.skipIf(IS_ROOT, 'Non-root compatibility runs without sudo; root isolation is covered separately')
    def test_invalid_lockfile_still_fails(self):
        (self.source / 'pnpm-lock.yaml').write_text('{"lockfileVersion":"unsupported"}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Cannot parse pnpm runtime lockfile'):
            self.parse()

    @unittest.skipUnless(os.name != 'posix', 'POSIX identity validation is covered by root tests')
    def test_windows_cannot_silently_ignore_an_explicit_parser_identity(self):
        with self.assertRaisesRegex(ValueError, 'requires POSIX'):
            self.parse('nobody')


@unittest.skipUnless(LINUX_ROOT, 'Effective UID/GID and supplementary-group isolation require Linux root CI')
class RootParserIsolationTests(ParserFixture):
    def setUp(self):
        super().setUp()
        import pwd
        try:
            self.account = pwd.getpwnam('nobody')
        except KeyError:
            accounts = [account for account in pwd.getpwall() if account.pw_uid > 0 and account.pw_gid > 0]
            if not accounts:
                self.skipTest('Linux fixture requires an existing non-root account')
            self.account = accounts[0]
        self.assertGreater(self.account.pw_uid, 0)
        self.assertGreater(self.account.pw_gid, 0)
        private = self.root / 'root-private'
        private.mkdir(mode=0o700)
        self.sentinel = private / 'sentinel'
        self.sentinel.write_text('root-only data', encoding='utf-8')
        self.sentinel.chmod(0o600)

    def malicious_parser(self):
        # Model dependency code supplied before the installer freezes it root-owned.
        # The side effect runs at require(), before the exported parse function is called.
        payload = """
const fs = require('node:fs');
let writeError, regainUidError, regainGidError;
try { fs.writeFileSync(SENTINEL, 'parser wrote as root'); } catch (error) { writeError = error.code; }
try { process.setuid(0); } catch (error) { regainUidError = error.code; }
try { process.setgid(0); } catch (error) { regainGidError = error.code; }
const parserProbe = {
  uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid(),
  groups: process.getgroups(), writeError, regainUidError, regainGidError,
};
exports.parse = content => ({ ...JSON.parse(content), parserProbe });
""".replace('SENTINEL', json.dumps(str(self.sentinel)))
        (self.yaml / 'index.js').write_text(payload, encoding='utf-8')
        (self.yaml / 'index.js').chmod(0o444)

    def test_dependency_require_has_no_root_identity_groups_or_write_access(self):
        self.malicious_parser()
        result = self.parse(self.account.pw_name)
        self.assertEqual({key: result[key] for key in self.lock}, self.lock)
        probe = result['parserProbe']
        self.assertEqual(probe['uid'], self.account.pw_uid)
        self.assertEqual(probe['euid'], self.account.pw_uid)
        self.assertEqual(probe['gid'], self.account.pw_gid)
        self.assertEqual(probe['egid'], self.account.pw_gid)
        self.assertNotIn(0, probe['groups'])
        self.assertTrue(set(probe['groups']).issubset({self.account.pw_gid}))
        self.assertEqual(probe['writeError'], 'EACCES')
        self.assertEqual(probe['regainUidError'], 'EPERM')
        self.assertEqual(probe['regainGidError'], 'EPERM')
        self.assertEqual(self.sentinel.read_text(encoding='utf-8'), 'root-only data')
        self.assertEqual(os.geteuid(), 0, 'Only the parser child may change identity')

    def test_explicit_numeric_uid_parses_a_normal_lockfile(self):
        self.assertEqual(self.parse(str(self.account.pw_uid)), self.lock)

    def test_missing_root_or_unknown_account_never_executes_dependency_code(self):
        self.malicious_parser()
        import pwd
        for account in (None, '0', pwd.getpwuid(0).pw_name, 'aggregation-parser-account-that-does-not-exist'):
            with self.subTest(account=account), self.assertRaises(ValueError):
                self.parse(account)
            self.assertEqual(self.sentinel.read_text(encoding='utf-8'), 'root-only data')

    def test_non_root_account_with_root_primary_group_is_rejected(self):
        import pwd
        from types import SimpleNamespace
        account = SimpleNamespace(pw_uid=self.account.pw_uid, pw_gid=0)
        with patch.object(pwd, 'getpwnam', return_value=account):
            with self.assertRaisesRegex(ValueError, 'primary group must be non-root'):
                self.parse('fixture-root-group')

    def test_root_cli_without_parser_user_fails_before_creating_stage(self):
        stage = self.root / 'must-not-exist'
        arguments = ['package-release.py', '--source', str(self.source), '--stage-only', str(stage), '--node', self.node]
        with patch.object(sys, 'argv', arguments):
            with self.assertRaisesRegex(ValueError, 'explicit non-root --parser-user'):
                package_release.main()
        self.assertFalse(stage.exists())

    def test_staging_forwards_parser_account_while_python_copy_remains_root(self):
        self.malicious_parser()
        for importer in package_release.IMPORTERS:
            directory = self.source / importer
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'package.json').write_text('{}', encoding='utf-8')
        required = ('dist/index.html', 'server/modules/greeks-bridge.py', 'server/modules/aster.mjs',
                    'server/modules/python-module.mjs', 'modules/monitor/dist/client/index.html',
                    'modules/asset/.next/BUILD_ID', 'modules/crossex/dist/index.html',
                    'modules/greeks/requirements.lock', 'modules/aster/dashboard/dist/client/index.html',
                    'modules/aster/requirements.lock', 'deploy/migrate-modules.py', 'deploy/diagnose-aster-margin.py',
                    *(f'tools/entropy-lighter-lab/{name}' for name in package_release.LAB_RUNTIME_FILES))
        for relative in required:
            target = self.source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture runtime', encoding='utf-8')
        stage = self.root / 'root-private' / 'stage'
        arguments = ['package-release.py', '--source', str(self.source), '--stage-only', str(stage),
                     '--dependency-root', str(self.dependencies), '--node', self.node,
                     '--parser-user', self.account.pw_name]
        with patch.object(sys, 'argv', arguments):
            package_release.main()
        for relative in required:
            self.assertEqual((stage / relative).read_text(encoding='utf-8'), 'fixture runtime')
            self.assertEqual((stage / relative).stat().st_uid, 0)
        self.assertEqual(self.sentinel.read_text(encoding='utf-8'), 'root-only data')


if __name__ == '__main__':
    unittest.main(verbosity=2)
