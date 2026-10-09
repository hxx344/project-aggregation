"""Exercise the actual embedded downloader with local archives and a fake network."""
import copy
import hashlib
import io
import json
import os
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
ci_release_resolve hxx344/fixture "$FIXTURE/work"
ci_release_extract "$FIXTURE/cache" "$FIXTURE/extracted"
''', encoding='utf-8', newline='\n')

    def tearDown(self):
        self.temporary.cleanup()

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
            'FIXTURE': self.root.as_posix(), **environment}, text=True, encoding='utf-8', capture_output=True)
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
