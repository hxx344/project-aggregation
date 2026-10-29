"""Exercise release resolution and extraction; download protocol has its own tests."""
import copy
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BASH = os.environ.get('TEST_BASH') or ('D:/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))


class ReleaseHelpers(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.commit = 'a' * 40
        self.key = 'b' * 64
        self.manifest = {'schema': 1, 'repository': 'hxx344/fixture', 'commit': self.commit,
                         'tag': 'deploy-' + self.commit, 'artifacts': {}}
        self.archive()
        (self.root / 'run.sh').write_text('''set -Eeuo pipefail
umask 077
source "$HELPER"
python3() { "$TEST_PYTHON" -X utf8 "$@" | tr -d '\\r'; }
uname() { printf '%s\\n' "${TEST_ARCH:-x86_64}"; }
curl() {
  local output='' url='' argument
  while (($#)); do
    argument=$1; shift
    case "$argument" in
      -o) output=$1; shift ;;
      --proto|--retry|--connect-timeout|--max-time|--max-filesize) shift ;;
      https://*) url=$argument ;;
    esac
  done
  printf '%s\\n' "$url" >> "$FIXTURE/urls"
  [[ ! -f "$FIXTURE/fail-download" ]] || return 22
  case "$url" in
    */latest/download/release-manifest.json) cp "$FIXTURE/manifest.json" "$output" ;;
    */releases/download/deploy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/fixture.tar.gz) cp "$FIXTURE/archive.tar.gz" "$output" ;;
    *) return 23 ;;
  esac
}
ci_release_download() {
  mkdir -p -- "$1"
  if [[ -f "$1/$3.tar.gz" && $(sha256sum "$1/$3.tar.gz" | cut -d ' ' -f1) == "$3" ]]; then return; fi
  curl "$2" -o "$1/$3.tar.gz"
}
ci_release_resolve hxx344/fixture "$FIXTURE/work"
ci_release_extract "$FIXTURE/cache" "$FIXTURE/extracted"
''', encoding='utf-8', newline='\n')

    def tearDown(self):
        self.temporary.cleanup()

    def test_embedded_helpers_match_source(self):
        helper = (ROOT / 'deploy/release-common.sh').read_text(encoding='utf-8').strip()
        for name in ('install.sh', 'install-all.sh'):
            installer = (ROOT / 'deploy' / name).read_text(encoding='utf-8')
            start = installer.index('# BEGIN CI RELEASE HELPERS')
            end = installer.index('# END CI RELEASE HELPERS', start) + len('# END CI RELEASE HELPERS')
            self.assertEqual(installer[start:end], helper, name)

    def test_source_publisher_includes_runnable_pinned_research_tool(self):
        source = self.root / 'source'
        (source / 'server').mkdir(parents=True)
        (source / 'server/index.mjs').write_text('export {};')
        (source / 'package.json').write_text('{"type":"module"}')
        lab = source / 'tools/entropy-lighter-lab'
        lab.mkdir(parents=True)
        names = ('cli.mjs', 'core.mjs', 'feeds.mjs', 'binance-scalper.mjs', 'config.example.json')
        for name in names:
            shutil.copy2(ROOT / 'tools/entropy-lighter-lab' / name, lab / name)
        (lab / 'config.json').write_text('private configuration must not ship')
        lp = source / 'tools/aero-lp'
        lp.mkdir(parents=True)
        lp_names = ('cli.mjs', 'core.mjs', 'chain.mjs', 'config.example.json')
        for name in lp_names:
            shutil.copy2(ROOT / 'tools/aero-lp' / name, lp / name)
        (lp / 'README.md').write_text('documentation must not ship')
        for args in (('init', '-q'), ('config', 'core.autocrlf', 'false'), ('config', 'user.name', 'fixture'),
                     ('config', 'user.email', 'fixture@example.invalid'), ('add', '.'), ('commit', '-qm', 'pinned runtime')):
            subprocess.run(['git', '-C', str(source), *args], check=True, capture_output=True)
        commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        subprocess.run(['git', 'clone', '-q', '--bare', str(source), str(self.root / 'repository.git')], check=True)
        (lab / 'cli.mjs').write_text('throw new Error("uncommitted source must not ship");')
        publish = self.root / 'publish'; publish.mkdir()
        installer = (ROOT / 'deploy/install.sh').read_text(encoding='utf-8')
        commands = re.findall(r'^  (git --git-dir="\$APP_DIR/repository.git" archive "\$commit" .*?\| tar -x -C "\$work_dir/publish")$', installer, re.M)
        self.assertEqual(1, len(commands), 'Exercise the production source publication command')
        result = subprocess.run([BASH, '-c', 'set -Eeuo pipefail\n' + commands[0]], cwd=self.root,
            env={**os.environ, 'APP_DIR': self.root.as_posix(), 'commit': commit, 'work_dir': self.root.as_posix()},
            capture_output=True, text=True)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(set(names), {path.name for path in (publish / 'tools/entropy-lighter-lab').iterdir()})
        self.assertEqual(set(lp_names), {path.name for path in (publish / 'tools/aero-lp').iterdir()})
        result = subprocess.run(['node', str(publish / 'tools/entropy-lighter-lab/cli.mjs'), 'check'],
                                cwd=publish, capture_output=True, text=True)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn('Configuration valid', result.stdout)

    def archive(self, extra=None, wrong_commit=False):
        entries = [('.release-commit', ('c' * 40 if wrong_commit else self.commit).encode()),
                   ('.release-application-key', self.key.encode()), ('server/index.mjs', b'export {};')]
        with tarfile.open(self.root / 'archive.tar.gz', 'w:gz') as archive:
            for name, content in entries:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            if extra:
                member, content = extra
                archive.addfile(member, io.BytesIO(content) if content is not None else None)
        artifact = {'file': 'fixture.tar.gz', 'application_key': self.key,
                    'sha256': hashlib.sha256((self.root / 'archive.tar.gz').read_bytes()).hexdigest()}
        self.manifest['artifacts'] = {'linux-x64': artifact, 'linux-arm64': copy.deepcopy(artifact)}
        self.save_manifest()

    def save_manifest(self):
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def run_helper(self, success=True, **environment):
        result = subprocess.run([BASH, str(self.root / 'run.sh')], env={**os.environ,
            'HELPER': (ROOT / 'deploy/release-common.sh').as_posix(), 'TEST_PYTHON': Path(sys.executable).as_posix(),
            'FIXTURE': self.root.as_posix(), **environment}, cwd=self.root,
            text=True, encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_fixed_tag_cache_corruption_and_permissions(self):
        self.run_helper()
        self.assertEqual((self.root / 'extracted/server/index.mjs').read_text(), 'export {};')
        if os.name != 'nt':
            self.assertEqual((self.root / 'extracted').stat().st_mode & 0o777, 0o755)
            self.assertEqual((self.root / 'extracted/server').stat().st_mode & 0o777, 0o755)
        shutil.rmtree(self.root / 'extracted')
        self.run_helper()
        urls = (self.root / 'urls').read_text().splitlines()
        self.assertEqual(sum('/releases/download/deploy-' in url for url in urls), 1)
        next((self.root / 'cache').glob('*.tar.gz')).write_bytes(b'corrupt cache')
        shutil.rmtree(self.root / 'extracted')
        self.run_helper()
        self.assertEqual(sum('/releases/download/deploy-' in url for url in (self.root / 'urls').read_text().splitlines()), 2)

    def test_manifest_binding_and_architecture(self):
        for change in ({'repository': 'other/repo'}, {'tag': 'main'}, {'commit': 'bad'}, {'schema': True}):
            original = copy.deepcopy(self.manifest)
            self.manifest.update(change)
            self.save_manifest()
            self.run_helper(False, PYTHONOPTIMIZE='1')
            self.manifest = original
        self.save_manifest()
        self.run_helper(False, TEST_ARCH='riscv64')

    def test_privileged_python_ignores_caller_import_paths(self):
        for name in ('json.py', 'pathlib.py', 'tarfile.py', 'hashlib.py'):
            (self.root / name).write_text('raise RuntimeError("untrusted caller module imported")\n', encoding='utf-8')
        self.run_helper(PYTHONPATH=self.root.as_posix(), PYTHONHOME=(self.root / 'untrusted-python').as_posix())

    def test_x64_only_release_installs_on_x64_and_rejects_arm_without_using_cached_archive(self):
        del self.manifest['artifacts']['linux-arm64']
        self.save_manifest()
        self.run_helper()
        self.assertEqual((self.root / 'extracted/server/index.mjs').read_text(), 'export {};')
        shutil.rmtree(self.root / 'extracted')
        result = self.run_helper(False, TEST_ARCH='aarch64')
        self.assertIn('linux-arm64', result.stderr)
        self.assertFalse((self.root / 'extracted').exists())
        urls = (self.root / 'urls').read_text().splitlines()
        self.assertEqual(sum('/releases/download/deploy-' in url for url in urls), 1)

    def test_architecture_package_accepts_regular_native_runtime_binaries(self):
        content = b'platform-specific-native-runtime'
        member = tarfile.TarInfo('modules/asset/node_modules/native/binding.node')
        member.size, member.mode = len(content), 0o755
        self.archive(extra=(member, content))
        self.run_helper()
        self.assertEqual((self.root / 'extracted' / member.name).read_bytes(), content)

    def test_corrupt_download_and_failure(self):
        (self.root / 'archive.tar.gz').write_bytes(b'corrupt download')
        self.run_helper(False)
        self.assertFalse(any((self.root / 'cache').iterdir()))
        (self.root / 'fail-download').touch()
        self.run_helper(False)

    def test_pinned_manifest_does_not_rediscover_latest(self):
        self.run_helper(PROJECT_DEPLOY_MANIFEST_FILE=(self.root / 'manifest.json').as_posix())
        urls = (self.root / 'urls').read_text().splitlines()
        self.assertEqual(len(urls), 1)
        self.assertIn('/releases/download/deploy-' + self.commit + '/', urls[0])
        self.run_helper(False, PROJECT_DEPLOY_MANIFEST_FILE=(self.root / 'missing.json').as_posix())

    def test_unsafe_archive_types_and_paths(self):
        cases = []
        for name in ('../outside', '/absolute', 'a/../../outside', 'C:/outside', 'a\\outside'):
            member = tarfile.TarInfo(name)
            member.size = 1
            cases.append((member, b'x'))
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            member = tarfile.TarInfo('link')
            member.type, member.linkname = kind, '../../outside'
            cases.append((member, None))
        duplicate = tarfile.TarInfo('server/index.mjs')
        duplicate.size = 1
        cases.append((duplicate, b'x'))
        for extra in cases:
            shutil.rmtree(self.root / 'extracted', ignore_errors=True)
            self.archive(extra)
            self.run_helper(False, PYTHONOPTIMIZE='1')
            self.assertFalse((self.root / 'outside').exists())

    def test_wrong_package_identity_and_nonempty_destination(self):
        self.archive(wrong_commit=True)
        self.run_helper(False)
        self.archive()
        self.run_helper(False)


if __name__ == '__main__':
    unittest.main()
