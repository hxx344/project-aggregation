"""Installer transactions with isolated commands; Windows runs are shell simulations.

Linux root additionally exercises the production ownership/path checks. No WSL.
The separate test-mirror-nginx.py covers actual nginx transport/cache behavior.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get('MIRROR_TEST_BASH') or ('D:/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))
WINDOWS = os.name == 'nt'
CAN_RUN = bool(BASH) and (WINDOWS or (os.geteuid() == 0 and 'microsoft' not in os.uname().release.lower()))


class Harness:
    def __init__(self, test):
        temporary = tempfile.TemporaryDirectory(prefix='mirror-setup-', dir=ROOT if WINDOWS else '/opt')
        test.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.commands = self.root / 'commands'
        self.commands.mkdir()
        self.log = self.root / 'commands.log'
        self.config = self.root / 'etc/project-aggregation/release-mirror.conf'
        self.override = self.root / 'etc/systemd/system/project-aggregation.service.d/mirror.conf'
        self.site = self.root / 'etc/nginx/sites-available/release-mirror'
        self.global_conf = self.root / 'etc/nginx/conf.d/github-releases-cache.conf'
        self.enabled = self.root / 'etc/nginx/sites-enabled/release-mirror'
        (self.root / 'run').mkdir()
        (self.root / 'etc').mkdir()
        (self.root / 'etc/resolv.conf').write_text('nameserver 127.0.0.1\n')
        (self.root / 'ca.pem').write_text('fixture CA', encoding='utf-8')
        for name in ('setup-release-mirror.sh', 'configure-release-mirror.sh'):
            text = (ROOT / 'deploy' / name).read_text(encoding='utf-8')
            text = text.replace('set -Eeuo pipefail', 'set -Eeuo pipefail\nexport PATH="$(cd -- "$MOCK_COMMANDS" && pwd):$PATH"')
            text = text.replace('/etc/ssl/certs/ca-certificates.crt', (self.root / 'ca.pem').as_posix())
            text = text.replace('/etc/', self.root.as_posix() + '/etc/')
            text = text.replace('/var/cache/github-releases', self.root.as_posix() + '/cache/releases')
            text = text.replace('/run/', self.root.as_posix() + '/run/')
            # No interactive controlling terminal in this fixture, even when the runner has one.
            text = text.replace('</dev/tty', '</dev/null')
            if WINDOWS:
                text = text.replace('[[ $EUID == 0 ]]', '[[ 1 == 1 ]]')
                text = text.replace('mkdir -p -m 0700', 'mkdir -p')
                text = text.replace("r'/[A-Za-z0-9_./-]+'", "r'[A-Za-z]:/[A-Za-z0-9_./-]+'")
                # Windows runner has no symlink privilege. Model only the nginx enable link;
                # actual symlink rejection stays a Linux test, not a simulated claim.
                text = text.replace('[[ -L $ENABLED_CONF', '[[ -f $ENABLED_CONF')
                text = text.replace('[[ ! -L $ENABLED_CONF', '[[ ! -f $ENABLED_CONF')
                text = text.replace('if Path(enabled).exists() and not Path(enabled).is_symlink():', 'if False:')
            (self.root / name).write_text(text, encoding='utf-8', newline='\n')
        self.script('python3', 'exec ' + self.quote(sys.executable.replace('\\', '/')) + ' "$@"')
        self.script('nginx', '''printf 'nginx %s\\n' "$*" >> "$COMMAND_LOG"
[[ ${NGINX_FAIL:-0} != 1 ]]''')
        self.script('systemctl', '''printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
if [[ $1 == is-active ]]; then [[ ${NGINX_STOPPED:-0} != 1 ]]; exit; fi
[[ ${SYSTEMCTL_FAIL:-} != "$1" ]]''')
        self.script('apt-get', 'printf "unexpected apt-get\\n" >> "$COMMAND_LOG"; exit 91')
        self.script('chown', ':')
        if WINDOWS:
            self.script('flock', ':')
            self.script('chmod', ':')
            self.script('ln', 'printf "%s" "${@: -2:1}" > "${@: -1}"')
            self.script('readlink', 'cat -- "$1"')
        # Shared helper transport is independently tested; installer sees only its exit contract.
        (self.root / 'mirror-tools.py').write_text('''import os, sys
from pathlib import Path
with Path(os.environ['COMMAND_LOG']).open('a') as f: f.write('verify ' + ' '.join(sys.argv[1:]) + '\\n')
sys.exit(int(os.environ.get('VERIFY_FAIL', '0')))
''', encoding='utf-8')

    @staticmethod
    def quote(value):
        return "'" + value.replace("'", "'\\''") + "'"

    def script(self, name, body):
        path = self.commands / name
        path.write_text('#!/usr/bin/env bash\n' + body + '\n', encoding='utf-8', newline='\n')
        path.chmod(0o755)

    def run(self, kind='configure', *args, **env):
        environment = {k: v for k, v in os.environ.items() if not k.startswith(('RELEASE_MIRROR_', 'RELEASE_CACHE_'))}
        environment.update(PATH=str(self.commands) + os.pathsep + os.environ['PATH'], MOCK_COMMANDS=str(self.commands), COMMAND_LOG=str(self.log), **env)
        return subprocess.run([BASH, str(self.root / (kind + '-release-mirror.sh')), *args],
                              env=environment, input='', text=True, encoding='utf-8', errors='replace',
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)

    def output(self):
        return self.log.read_text(encoding='utf-8') if self.log.exists() else ''

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8', newline='\n')


@unittest.skipUnless(CAN_RUN, 'requires native Git Bash on Windows or Linux root; WSL is prohibited')
class MirrorSetupTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness(self)

    def succeeds(self, result):
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_eof_is_explicit_and_never_consumes_script_stdin(self):
        result = self.h.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--url URL', result.stdout)
        self.assertFalse(self.h.config.exists())

    def test_cli_verify_and_identical_configuration_reuse(self):
        self.succeeds(self.h.run('configure', '--url', 'http://127.0.0.1:8090'))
        self.assertIn('RELEASE_MIRROR_KIND=github', self.h.config.read_text())
        before = self.h.config.stat().st_mtime_ns
        self.succeeds(self.h.run('configure', '--url', 'http://127.0.0.1:8090'))
        self.assertEqual(before, self.h.config.stat().st_mtime_ns)
        self.assertEqual(self.h.output().count('verify verify'), 1)
        self.succeeds(self.h.run('configure', '--url', 'http://127.0.0.1:8090', '--verify'))
        self.assertEqual(self.h.output().count('verify verify'), 2)
        self.assertNotIn('systemctl', self.h.output())

    def test_bad_arguments_rejected_without_side_effects(self):
        cases = [('--url',), ('--bogus',), ('--url', 'http://example.com'),
                 ('--url', 'http://localhost:8090'), ('--url', 'https://example.com/path'),
                 ('--url', 'https://user@example.com'), ('--url', 'https://example.com?q=1'),
                 ('--url', 'https://example.com#f'), ('--url', 'https://example.com', '--kind', 'other'),
                 ('--url', 'https://example.com', '--timeout', '301'),
                 ('--url', 'https://example.com', '--priority', 'maybe')]
        for args in cases:
            with self.subTest(args=args):
                result = self.h.run('configure', *args)
                self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(self.h.config.exists())
        self.assertEqual(self.h.output(), '')

    def test_validation_failure_keeps_old_config_and_override(self):
        self.h.write(self.h.config, 'old config\n')
        self.h.write(self.h.override, 'user override\n')
        result = self.h.run('configure', '--url', 'https://mirror.example.com', VERIFY_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.h.config.read_text(), 'old config\n')
        self.assertEqual(self.h.override.read_text(), 'user override\n')
        self.assertNotIn('systemctl', self.h.output())

    def test_disabled_has_no_download_and_preserves_user_override(self):
        self.h.write(self.h.override, '[Service]\nEnvironment=USER_VALUE=yes\n')
        self.succeeds(self.h.run('configure', '--priority', 'disabled'))
        self.assertIn('RELEASE_MIRROR_PRIORITY=disabled', self.h.config.read_text())
        self.assertIn('USER_VALUE', self.h.override.read_text())
        self.assertEqual(self.h.output(), '')

    def test_removes_only_exact_legacy_override_without_restarting_application(self):
        old = '[Service]\n# 从配置文件加载镜像设置\nEnvironmentFile=-' + self.h.config.as_posix() + '\n'
        self.h.write(self.h.override, old)
        self.succeeds(self.h.run('configure', '--priority', 'disabled'))
        self.assertFalse(self.h.override.exists())
        self.assertEqual(self.h.output(), 'systemctl daemon-reload\n')

    def test_daemon_reload_failure_restores_legacy_override_and_old_config(self):
        old = '[Service]\n# 从配置文件加载镜像设置\nEnvironmentFile=-' + self.h.config.as_posix() + '\n'
        self.h.write(self.h.override, old)
        self.h.write(self.h.config, 'old\n')
        result = self.h.run('configure', '--priority', 'disabled', SYSTEMCTL_FAIL='daemon-reload')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.h.override.read_text(encoding='utf-8'), old)
        self.assertEqual(self.h.config.read_text(), 'old\n')

    def test_setup_is_idempotent_and_default_listen_is_private(self):
        self.succeeds(self.h.run('setup'))
        self.assertIn('listen 127.0.0.1:8090;', self.h.site.read_text())
        before = self.h.site.stat().st_mtime_ns
        self.succeeds(self.h.run('setup'))
        self.assertEqual(before, self.h.site.stat().st_mtime_ns)
        self.assertEqual(self.h.output().count('nginx -t'), 1)
        self.assertEqual(self.h.output().count('systemctl reload nginx'), 1)
        self.assertNotIn('project-aggregation', self.h.output())

    def test_nginx_validation_and_reload_failure_restore_previous_files_and_link(self):
        self.succeeds(self.h.run('setup'))
        site, global_conf = self.h.site.read_bytes(), self.h.global_conf.read_bytes()
        for injection in ({'NGINX_FAIL': '1'}, {'SYSTEMCTL_FAIL': 'reload'}):
            with self.subTest(injection=injection):
                result = self.h.run('setup', '--listen', '127.0.0.1:8091', **injection)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.h.site.read_bytes(), site)
                self.assertEqual(self.h.global_conf.read_bytes(), global_conf)
                self.assertTrue(self.h.enabled.is_file() if WINDOWS else self.h.enabled.is_symlink())
        self.assertNotIn('project-aggregation.service', self.h.output())

    def test_first_install_failure_removes_only_generated_files(self):
        result = self.h.run('setup', NGINX_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('nginx -t', self.h.output())
        self.assertFalse(self.h.site.exists())
        self.assertFalse(self.h.global_conf.exists())
        self.assertFalse(self.h.enabled.exists())

    def test_existing_user_nginx_config_is_preserved(self):
        self.h.write(self.h.site, '# user config\n')
        result = self.h.run('setup')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.h.site.read_text(), '# user config\n')
        self.assertEqual(self.h.output(), '')

    @unittest.skipIf(WINDOWS, 'Windows runner does not grant native symlink creation')
    def test_symlink_config_rejected(self):
        target = self.h.root / 'user-file'
        target.write_text('user data')
        self.h.config.parent.mkdir(parents=True)
        self.h.config.symlink_to(target)
        result = self.h.run('configure', '--priority', 'disabled')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), 'user data')

    def test_stopped_nginx_is_started_without_application_restart(self):
        self.succeeds(self.h.run('setup', NGINX_STOPPED='1'))
        self.assertIn('systemctl start nginx', self.h.output())
        self.assertNotIn('reload nginx', self.h.output())

    def test_resolver_uses_system_settings_and_validates_override(self):
        self.succeeds(self.h.run('setup'))
        self.assertIn('resolver 127.0.0.1 valid=300s;', self.h.site.read_text())
        result = self.h.run('setup', '--resolver', '127.0.0.1;include /evil')
        self.assertNotEqual(result.returncode, 0)
        self.succeeds(self.h.run('setup', '--resolver', '[::1]:5353'))
        self.assertIn('resolver [::1]:5353 valid=300s;', self.h.site.read_text())


if __name__ == '__main__':
    unittest.main()
