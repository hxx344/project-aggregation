"""Exercise fixed-commit source fetching with real Git objects and injected transport errors."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BASH = os.environ.get('TEST_BASH') or ('D:/Git/bin/bash.exe' if os.name == 'nt' else shutil.which('bash'))


class SourceFetch(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.cache = self.root / 'application/repository.git'
        self.environment = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1',
                            'GIT_CONFIG_GLOBAL': (self.root / 'gitconfig').as_posix()}
        self.global_config = '[http]\n\tversion = HTTP/2\n'
        (self.root / 'gitconfig').write_text(self.global_config, encoding='utf-8')
        self.git('-C', self.source, 'init', '-q', '-b', 'main')
        self.git('-C', self.source, 'config', 'user.name', 'fixture')
        self.git('-C', self.source, 'config', 'user.email', 'fixture@example.invalid')
        (self.source / 'entry.txt').write_text('selected release\n', encoding='utf-8')
        self.git('-C', self.source, 'add', '.')
        self.git('-C', self.source, 'commit', '-qm', 'selected release')
        self.commit = self.git('-C', self.source, 'rev-parse', 'HEAD')
        (self.source / 'entry.txt').write_text('unpublished branch change\n', encoding='utf-8')
        self.git('-C', self.source, 'commit', '-qam', 'advance main')
        self.new_commit = self.git('-C', self.source, 'rev-parse', 'HEAD')
        (self.root / 'run.sh').write_text(r'''set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$INSTALLER"
APP_DIR="$FIXTURE/application"
work_dir="$FIXTURE/work"
commit="$TARGET_COMMIT"
REPOSITORY="$FIXTURE/source"
mkdir -p "$APP_DIR" "$work_dir"
updater_safe_path() { :; }
log() { printf '%s\n' "$*" >&2; }
ci_update_progress() { printf '%s\n' "$1" >> "$FIXTURE/progress"; }
sleep() { printf '%s\n' "$1" >> "$FIXTURE/delays"; }
git() {
  local argument fetching=0 attempt=1
  for argument in "$@"; do [[ "$argument" != fetch ]] || fetching=1; done
  if (( ! fetching )); then command git "$@"; return; fi
  if [[ -f "$FIXTURE/attempts" ]]; then attempt=$(( $(cat "$FIXTURE/attempts") + 1 )); fi
  printf '%s\n' "$attempt" > "$FIXTURE/attempts"
  printf '%s\n' "$@" > "$FIXTURE/fetch-$attempt.args"
  printf '%s\n' "${LC_ALL:-}" "${GIT_TERMINAL_PROMPT:-}" > "$FIXTURE/fetch-$attempt.env"
  if (( attempt <= ${FAIL_COUNT:-0} )); then
    printf '%s\n' "$FAIL_MESSAGE" >&2
    return "${FAIL_CODE:-128}"
  fi
  [[ ${FAKE_SUCCESS:-0} != 1 ]] || return 0
  command git "$@"
}
tee() {
  if [[ ${FAIL_TEE:-0} == 1 ]]; then cat; return 73; fi
  command tee "$@"
}
if [[ ${FAIL_PROGRESS:-0} == 1 ]]; then
  ci_source_progress() { cat >&2; return 74; }
fi
trap 'status=$?; printf "%s\n" "$status" >> "$FIXTURE/rollback"; exit "$status"' ERR
fetch_source
printf 'continued\n' > "$FIXTURE/completed"
''', encoding='utf-8', newline='\n')

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *arguments):
        result = subprocess.run(['git', *map(str, arguments)], env=self.environment,
                                text=True, encoding='utf-8', capture_output=True, check=True)
        return result.stdout.strip()

    def run_fetch(self, expected=0, **environment):
        for name in ('attempts', 'delays', 'rollback', 'completed', 'progress'):
            (self.root / name).unlink(missing_ok=True)
        result = subprocess.run([BASH, str(self.root / 'run.sh')], cwd=self.root,
                                env={**self.environment, 'INSTALLER': (ROOT / 'deploy/install.sh').as_posix(),
                                     'FIXTURE': self.root.as_posix(), 'TARGET_COMMIT': self.commit, **environment},
                                text=True, encoding='utf-8', capture_output=True)
        if expected is None:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertEqual((self.root / 'completed').exists(), result.returncode == 0)
        self.assertEqual(self.lines('rollback'), [] if result.returncode == 0 else [str(result.returncode)])
        self.assertEqual((self.root / 'gitconfig').read_text(encoding='utf-8'), self.global_config)
        return result

    def lines(self, name):
        path = self.root / name
        return path.read_text(encoding='utf-8').splitlines() if path.exists() else []

    def assert_fetches(self, count):
        self.assertEqual(self.lines('attempts'), [str(count)] if count else [])
        for attempt in range(1, count + 1):
            arguments = self.lines(f'fetch-{attempt}.args')
            self.assertIn('--depth=1', arguments)
            self.assertIn('--no-tags', arguments)
            self.assertIn('--progress', arguments)
            self.assertNotIn('--quiet', arguments)
            self.assertEqual(arguments[-1], f'{self.commit}:refs/project-aggregation/source/{self.commit}')
            self.assertIn('http.lowSpeedLimit=1', arguments)
            self.assertIn('http.lowSpeedTime=60', arguments)
            self.assertEqual('http.version=HTTP/1.1' in arguments, attempt > 1)
            self.assertEqual(self.lines(f'fetch-{attempt}.env'), ['C', '0'])

    def assert_cached(self, commit):
        self.assertEqual(self.git('--git-dir', self.cache, 'rev-parse',
                                  f'refs/project-aggregation/source/{commit}'), commit)
        self.git('--git-dir', self.cache, 'cat-file', '-e', commit + '^{commit}')

    def test_first_fetch_pins_selected_release_after_main_moves(self):
        result = self.run_fetch()
        self.assert_fetches(1)
        self.assertEqual(self.lines('delays'), [])
        self.assertIn('download', self.lines('progress'))
        self.assert_cached(self.commit)
        self.assertEqual(self.git('--git-dir', self.cache, 'show', self.commit + ':entry.txt'), 'selected release')
        self.assertNotEqual(self.commit, self.new_commit)
        self.assertIn('From ', result.stderr)

    def test_two_resets_retry_then_succeed_without_changing_the_target(self):
        message = 'error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF'
        result = self.run_fetch(FAIL_COUNT='2', FAIL_MESSAGE=message)
        self.assert_fetches(3)
        self.assertEqual(self.lines('delays'), ['2', '4'])
        self.assert_cached(self.commit)
        self.assertIn('Connection reset by peer', result.stderr)
        self.assertIn(message, (self.root / 'work/source-fetch-1.log').read_text(encoding='utf-8'))

    def test_permanent_errors_and_unknown_failures_do_not_retry(self):
        messages = (
            'fatal: unable to access repository: SSL certificate problem: certificate has expired\nfatal: early EOF',
            'fatal: Authentication failed for repository\nfatal: early EOF',
            'fatal: The requested URL returned error: 401\nfatal: early EOF',
            'fatal: The requested URL returned error: 403\nfatal: early EOF',
            'fatal: The requested URL returned error: 404\nfatal: early EOF',
            'fatal: The requested URL returned error: 429\nfatal: early EOF',
            'fatal: remote error: upload-pack: not our ref ' + self.commit,
            "fatal: couldn't find remote ref " + self.commit,
            'fatal: cannot write object: No space left on device\nfatal: early EOF',
            'fatal: cannot write object: Permission denied\nfatal: early EOF',
            'fatal: unexpected repository failure',
        )
        for message in messages:
            with self.subTest(message=message):
                self.run_fetch(128, FAIL_COUNT='9', FAIL_MESSAGE=message)
                self.assert_fetches(1)
                self.assertEqual(self.lines('delays'), [])

    def test_persistent_transient_error_exhausts_three_attempts_and_preserves_status(self):
        self.run_fetch(7, FAIL_COUNT='9', FAIL_CODE='7', FAIL_MESSAGE='fatal: Connection timed out')
        self.assert_fetches(3)
        self.assertEqual(self.lines('delays'), ['2', '4'])

    def test_interruption_codes_are_not_retried_even_with_transport_text(self):
        for code in (130, 141, 143):
            with self.subTest(code=code):
                self.run_fetch(code, FAIL_COUNT='9', FAIL_CODE=str(code), FAIL_MESSAGE='fatal: early EOF')
                self.assert_fetches(1)
                self.assertEqual(self.lines('delays'), [])

    def test_success_without_the_requested_commit_is_rejected(self):
        self.run_fetch(None, FAKE_SUCCESS='1')
        self.assert_fetches(1)
        self.assertEqual(self.lines('delays'), [])

    def test_legacy_cache_gets_a_retained_ref_and_survives_a_later_failure(self):
        self.cache.parent.mkdir()
        self.git('init', '--bare', '-q', self.cache)
        self.git('--git-dir', self.cache, 'fetch', '--depth=1', self.source, self.commit)
        self.assertEqual(self.git('--git-dir', self.cache, 'for-each-ref', '--format=%(refname)'), '')
        self.run_fetch(FAIL_COUNT='9', FAIL_MESSAGE='fatal: network must not be used')
        self.assert_fetches(0)
        self.assert_cached(self.commit)
        old_commit = self.commit
        self.commit = self.new_commit
        self.run_fetch(128, FAIL_COUNT='9', FAIL_MESSAGE='error: RPC failed; curl 56 Connection reset by peer')
        self.assert_fetches(3)
        self.assert_cached(old_commit)

    def test_log_write_failure_is_not_swallowed_or_retried(self):
        self.run_fetch(73, FAIL_TEE='1')
        self.assert_fetches(1)
        self.assertEqual(self.lines('delays'), [])

    def test_progress_pipeline_failure_does_not_report_success_or_retry(self):
        self.run_fetch(74, FAIL_PROGRESS='1')
        self.assert_fetches(1)
        self.assertEqual(self.lines('delays'), [])


if __name__ == '__main__':
    unittest.main()
