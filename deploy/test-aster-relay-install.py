"""Offline source-boundary checks and isolated Linux installer transactions."""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("relay_source", ROOT / "deploy/aster-relay-source.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
REVISION = "a" * 40
PREFIX = "project-aggregation-" + REVISION
LINUX_ROOT = (sys.platform == "linux" and hasattr(os, "geteuid") and os.geteuid() == 0
              and "microsoft" not in os.uname().release.lower())


class SourceArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.archive = self.base / "source.tar.gz"
        self.destination = self.base / "extracted"

    def archive_members(self, additional=(), missing=()):
        with tarfile.open(self.archive, "w:gz") as handle:
            for name in source.FILES:
                if name not in missing:
                    data = ("# " + name + "\n").encode()
                    member = tarfile.TarInfo(PREFIX + "/" + name)
                    member.size = len(data)
                    handle.addfile(member, io.BytesIO(data))
            for member in additional:
                handle.addfile(member, io.BytesIO(b"x" * member.size))

    def test_extracts_only_allowlist_and_normalizes_mode(self):
        ignored = tarfile.TarInfo(PREFIX + "/other.py")
        ignored.size, ignored.mode = 3, 0o777
        self.archive_members([ignored])
        source.extract_source(self.archive, self.destination, REVISION)
        files = {p.relative_to(self.destination).as_posix() for p in self.destination.rglob("*") if p.is_file()}
        self.assertEqual(files, set(source.FILES))
        self.assertFalse((self.destination / "other.py").exists())

    def test_rejects_traversal_duplicate_links_special_members_and_wrong_root(self):
        names = (PREFIX + "/../escape", "/absolute", PREFIX + "/a//b", PREFIX + "/./b",
                 PREFIX + "/a\\b", PREFIX + "/C:drive", "another-root/path", PREFIX + "/" + source.FILES[0])
        members = [tarfile.TarInfo(name) for name in names]
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            item = tarfile.TarInfo(PREFIX + "/ignored-unsafe")
            item.type, item.linkname = kind, "../../escape"
            members.append(item)
        for item in members:
            with self.subTest(name=item.name, kind=item.type):
                self.archive_members([item])
                with self.assertRaises(ValueError):
                    source.extract_source(self.archive, self.destination, REVISION)
                self.assertFalse(self.destination.exists())

    def test_rejects_missing_files_and_bounded_archives(self):
        self.archive_members(missing=[source.FILES[0]])
        with self.assertRaises(ValueError):
            source.extract_source(self.archive, self.destination, REVISION)
        self.archive_members()
        for bound in ("MAX_ARCHIVE", "MAX_TOTAL", "MAX_MEMBER", "MAX_MEMBERS", "MAX_SELECTED"):
            with self.subTest(bound=bound), patch.object(source, bound, 1), self.assertRaises(ValueError):
                source.extract_source(self.archive, self.destination, REVISION)
        self.assertFalse(self.destination.exists())

    def test_manifest_requires_stable_repository_commit_and_tag(self):
        good = dict(schema=1, repository=source.REPOSITORY, commit=REVISION, tag="deploy-" + REVISION)
        self.assertEqual(source.manifest_commit(good), REVISION)
        for field, value in (("schema", True), ("schema", 2), ("repository", "other/repo"),
                             ("commit", "main"), ("commit", REVISION.upper()), ("tag", "latest")):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                source.manifest_commit({**good, field: value})

    def test_caps_decompression_even_for_ignored_tar_padding(self):
        stream = source.BoundedTarStream(io.BytesIO(b"x" * 32))
        stream.remaining = 8
        self.assertEqual(stream.read(4), b"xxxx")
        with self.assertRaises(ValueError):
            stream.read(20)

    def test_relay_lock_exactly_reuses_full_lock_versions_and_hashes(self):
        def packages(path):
            text = path.read_text(encoding="utf-8")
            return {match.group(1): match.group(0).strip() for match in re.finditer(
                r"^([A-Za-z0-9_.-]+)==[^\n]*(?:\n[ \t]+[^\n]*)*", text, re.M)}
        full = packages(ROOT / "modules/aster/requirements.lock")
        relay = packages(ROOT / "modules/aster/requirements-relay.lock")
        expected = {"annotated-doc", "annotated-types", "anyio", "certifi", "click", "fastapi", "h11",
                    "httpcore", "httpx", "idna", "pydantic", "pydantic_core", "starlette", "typing-inspection",
                    "typing_extensions", "uvicorn", "websockets"}
        self.assertEqual(set(relay), expected)
        for name, requirement in relay.items():
            self.assertEqual(requirement, full[name])
            self.assertIn("--hash=sha256:", requirement)


class RelayInstallerHarness:
    def __init__(self, test):
        self.test = test
        temporary = tempfile.TemporaryDirectory(prefix="aster-relay-fixture-", dir="/opt")
        test.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.source, self.commands, self.root = (self.base / name for name in ("source", "commands", "opt"))
        self.etc, self.unit, self.cli = (self.base / name for name in ("etc", "service", "cli"))
        self.commands.mkdir()
        mappings = {"/opt/aster-capacity-relay": str(self.root), "/etc/aster-capacity-relay": str(self.etc),
                    "/etc/systemd/system/aster-capacity-relay.service": str(self.unit),
                    "/usr/local/bin/aster-capacity-relay": str(self.cli), "/run/systemd/system": str(self.base)}
        for name in source.FILES:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            text = (ROOT / name).read_text() if name.startswith("deploy/") and "configure-" not in name else ""
            for before, after in mappings.items():
                text = text.replace(before, after)
            target.write_text(text)
        (self.source / "deploy/configure-aster-relay.py").write_text('''import os, sys
from pathlib import Path
directory = Path(os.environ["HARNESS_BASE"]) / "etc"
if sys.argv[1] == "prepare-server":
    directory.mkdir(exist_ok=True)
    for name in ("environment", "server.key", "server.crt", "connection.json", "address"):
        path = directory / name
        if not path.exists(): path.write_text("127.0.0.1" if name == "address" else "preserved fixture " + name)
elif sys.argv[1] == "health":
    if (directory.parent / "fail-health").exists(): sys.exit(44)
    print('{"status":"ok"}')
elif sys.argv[1] == "status":
    print('{"collector":"starting","samples_ready":false}')
''')
        (self.base / "remote-revision").write_text(REVISION)
        (self.base / "state").write_text("stopped")
        (self.base / "enabled").write_text("disabled")
        self.install_commands()

    def executable(self, name, body):
        path = self.commands / name
        path.write_text("#!/bin/bash\nset -e\n" + body + "\n")
        path.chmod(0o755)

    def install_commands(self):
        for name in ("id", "chown", "useradd", "sleep"):
            self.executable(name, "exit 0")
        self.executable("install", '''args=()
while (($#)); do
  case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
done
exec /usr/bin/install "${args[@]}"''')
        self.executable("python3", '''isolation=()
if [[ ${1:-} == -I ]]; then isolation=(-I); shift; fi
if [[ ${1:-} == -m && ${2:-} == venv ]]; then
  printf '1\\n' >> "$HARNESS_BASE/dependencies"
  mkdir -p "$3/bin"
  cp "$HARNESS_BASE/commands/venv-python" "$3/bin/python"
else exec "$HARNESS_PYTHON" "${isolation[@]}" "$@"; fi''')
        self.executable("venv-python", '''isolation=()
if [[ ${1:-} == -I ]]; then isolation=(-I); shift; fi
if [[ ${1:-} == -m && ${2:-} == pip ]]; then
  printf '%s\\n' "$*" >> "$HARNESS_BASE/pip-calls"
  [[ ! -f "$HARNESS_BASE/fail-pip" ]] || exit 42
  exit 0
fi
exec "$HARNESS_PYTHON" "${isolation[@]}" "$@"''')
        self.executable("systemd-run", '''printf '1\\n' >> "$HARNESS_BASE/validation"
[[ ! -f "$HARNESS_BASE/fail-validation" ]] || exit 43''')
        self.executable("systemctl", '''printf '%s\\n' "$*" >> "$HARNESS_BASE/service-calls"
case $1 in
  is-active) [[ $(cat "$HARNESS_BASE/state") == active ]] ;;
  is-enabled) [[ $(cat "$HARNESS_BASE/enabled") == enabled ]] ;;
  show) printf 'no\\n' ;;
  enable) printf enabled > "$HARNESS_BASE/enabled" ;;
  disable) printf disabled > "$HARNESS_BASE/enabled" ;;
  restart|start) printf active > "$HARNESS_BASE/state" ;;
  stop) printf stopped > "$HARNESS_BASE/state" ;;
esac''')
        self.executable("curl", '''exec "$HARNESS_PYTHON" -I "$HARNESS_BASE/download.py" "$@"''')
        (self.base / "download.py").write_text('''import json, os, shutil, sys, tarfile
from pathlib import Path
base = Path(os.environ['HARNESS_BASE'])
revision = (base / 'remote-revision').read_text()
target = Path(sys.argv[sys.argv.index('-o') + 1])
url = next(item for item in sys.argv if item.startswith('https:'))
if '/releases/latest/download/release-manifest.json' in url:
    target.write_text(json.dumps(dict(schema=1, repository='hxx344/project-aggregation', commit=revision, tag='deploy-' + revision)))
elif 'raw.githubusercontent.com/' in url:
    shutil.copyfile(base / 'source/deploy/aster-relay-source.py', target)
elif 'codeload.github.com/' in url:
    with (base / 'downloads').open('a') as output: output.write('1\\n')
    with tarfile.open(target, 'w:gz') as archive:
        archive.add(base / 'source', arcname='project-aggregation-' + revision)
else: sys.exit(41)
''')

    def run(self, *, fail=None, remote=False, address="127.0.0.1", extra_env=None):
        if fail:
            (self.base / ("fail-" + fail)).touch()
        try:
            command = ["bash", str(self.source / "deploy/install-aster-relay.sh"), "--address", address]
            if not remote:
                command += ["--source", str(self.source)]
            return subprocess.run(command, cwd=self.base, capture_output=True, text=True, timeout=45,
                                  env={**os.environ, "PATH": str(self.commands) + ":/usr/bin:/bin",
                                       "HARNESS_BASE": str(self.base), "HARNESS_PYTHON": sys.executable,
                                       **(extra_env or {})})
        finally:
            if fail:
                (self.base / ("fail-" + fail)).unlink()

    def success(self, **kwargs):
        result = self.run(**kwargs)
        self.test.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)
        return self.current

    @property
    def current(self):
        return (self.root / "current").resolve()

    def count(self, name):
        path = self.base / name
        return len(path.read_text().splitlines()) if path.exists() else 0

    def change_code(self):
        (self.source / "modules/aster/trading/capacity_relay_server.py").write_text("# Updated implementation\n")


@unittest.skipUnless(LINUX_ROOT, "Requires native non-WSL Linux root; isolated /opt fixture")
class RelayInstallerTests(unittest.TestCase):
    def setUp(self):
        self.h = RelayInstallerHarness(self)

    def test_first_install_then_noop_preserves_pid_dependencies_and_validation(self):
        first = self.h.success()
        calls = (self.h.base / "service-calls").read_text().count("restart ")
        self.assertEqual(self.h.success(), first)
        self.assertEqual(self.h.count("dependencies"), 1)
        self.assertEqual(self.h.count("validation"), 1)
        self.assertEqual((self.h.base / "service-calls").read_text().count("restart "), calls)
        self.assertIn("--require-hashes --only-binary=:all:", (self.h.base / "pip-calls").read_text())

    def test_remote_same_revision_skips_download_and_new_identity_reuses_content(self):
        first = self.h.success(remote=True)
        self.assertEqual(self.h.success(remote=True), first)
        self.assertEqual(self.h.count("downloads"), 1)
        (self.h.base / "remote-revision").write_text("b" * 40)
        self.assertEqual(self.h.success(remote=True), first)
        self.assertEqual(self.h.count("downloads"), 2)
        self.assertEqual(self.h.count("validation"), 1)
        self.assertEqual((first / ".install-revision").read_text().strip(), "b" * 40)

    def test_code_upgrade_reuses_dependencies_and_preserves_all_configuration(self):
        old = self.h.success()
        saved = {name: (self.h.etc / name).read_bytes() for name in ("environment", "server.key", "server.crt", "connection.json")}
        self.h.change_code()
        self.assertNotEqual(self.h.success(), old)
        self.assertTrue(old.is_dir())
        self.assertEqual(self.h.count("dependencies"), 1)
        self.assertEqual({name: (self.h.etc / name).read_bytes() for name in saved}, saved)

    def test_failed_health_restores_previous_release_unit_cli_and_active_enabled_state(self):
        old = self.h.success()
        unit, cli = self.h.unit.read_bytes(), self.h.cli.read_bytes()
        self.h.change_code()
        self.assertNotEqual(self.h.run(fail="health").returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual((self.h.base / "state").read_text(), "active")
        self.assertEqual((self.h.base / "enabled").read_text(), "enabled")
        self.assertEqual((self.h.unit.read_bytes(), self.h.cli.read_bytes()), (unit, cli))
        self.assertEqual(len(list((self.h.root / "releases").iterdir())), 1)

    def test_failed_health_restores_disabled_inactive_state(self):
        old = self.h.success()
        (self.h.base / "state").write_text("stopped")
        (self.h.base / "enabled").write_text("disabled")
        self.h.change_code()
        self.assertNotEqual(self.h.run(fail="health").returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual((self.h.base / "state").read_text(), "stopped")
        self.assertEqual((self.h.base / "enabled").read_text(), "disabled")

    def test_config_validation_fails_before_switch_and_restart(self):
        old = self.h.success()
        calls = (self.h.base / "service-calls").read_text().count("restart ")
        self.h.change_code()
        self.assertNotEqual(self.h.run(fail="validation").returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual((self.h.base / "service-calls").read_text().count("restart "), calls)

    def test_dependency_install_failure_leaves_previous_release_running(self):
        old = self.h.success()
        (self.h.source / "modules/aster/requirements-relay.lock").write_text("# Changed dependency closure\n")
        self.assertNotEqual(self.h.run(fail="pip").returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual((self.h.base / "state").read_text(), "active")
        self.assertEqual(self.h.count("validation"), 1)

    def test_different_address_does_not_overwrite_certificate(self):
        self.h.success()
        old = (self.h.etc / "server.crt").read_bytes()
        self.assertNotEqual(self.h.run(address="127.0.0.2").returncode, 0)
        self.assertEqual((self.h.etc / "server.crt").read_bytes(), old)

    def test_rejects_service_writable_source_cache_and_parent(self):
        self.h.source.chmod(0o777)
        self.assertNotEqual(self.h.run().returncode, 0)
        self.h.source.chmod(0o755)
        self.h.success()
        cache = next((self.h.root / "cache").iterdir())
        cache.chmod(0o777)
        self.assertNotEqual(self.h.run().returncode, 0)
        cache.chmod(0o755)
        self.h.base.chmod(0o777)
        self.assertNotEqual(self.h.run().returncode, 0)
        self.h.base.chmod(0o700)

    def test_rejects_linked_source_file(self):
        target = self.h.source / "modules/aster/requirements-relay.lock"
        target.unlink()
        target.symlink_to(self.h.base / "remote-revision")
        self.assertNotEqual(self.h.run().returncode, 0)

    def test_rejects_service_owned_cache_file(self):
        self.h.success()
        cache = next((self.h.root / "cache").iterdir())
        interpreter = cache / "bin/python"
        os.chown(interpreter, 65534, 65534)
        self.assertNotEqual(self.h.run().returncode, 0)

    def test_bad_stable_manifest_never_downloads_or_changes_current(self):
        old = self.h.success(remote=True)
        (self.h.base / "remote-revision").write_text("main")
        self.assertNotEqual(self.h.run(remote=True).returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual(self.h.count("downloads"), 1)

    def test_ignores_cwd_and_python_environment_module_injection(self):
        for name in ("json.py", "pathlib.py"):
            (self.h.base / name).write_text("open('module-injection-ran', 'w').write('bad')\nraise RuntimeError('injected module')\n")
        self.h.success(remote=True, extra_env={"PYTHONPATH": str(self.h.base), "PYTHONHOME": str(self.h.base)})
        self.assertFalse((self.h.base / "module-injection-ran").exists())


if __name__ == "__main__":
    unittest.main()
