"""Portable parser checks plus isolated native Linux installer transactions."""
import ast
import datetime
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "deploy/install-entropy-lighter-lab.sh"
TEXT = INSTALLER.read_text(encoding="utf-8")
FILES = ("tools/entropy-lighter-lab/cli.mjs", "tools/entropy-lighter-lab/core.mjs",
         "tools/entropy-lighter-lab/feeds.mjs", "tools/entropy-lighter-lab/binance-scalper.mjs",
         "tools/entropy-lighter-lab/config.example.json",
         "deploy/install-entropy-lighter-lab.sh")
REVISION = "a" * 40
LINUX_ROOT = (sys.platform == "linux" and os.geteuid() == 0
              and "microsoft" not in os.uname().release.lower())


def block(name):
    """Execute the actual inline Python functions without their CLI invocation."""
    source = TEXT.split("# BEGIN " + name + "\n", 1)[1].split("# END " + name, 1)[0]
    tree = ast.parse(source)
    assert isinstance(tree.body[-1], ast.Expr)
    tree.body.pop()
    namespace = {}
    exec(compile(tree, str(INSTALLER) + ":" + name, "exec"), namespace)
    return namespace


class InlineContractTests(unittest.TestCase):
    def test_manifest_requires_stable_repository_commit_tag_and_integer_schema(self):
        parse = block("MANIFEST_COMMIT")["manifest_commit"]
        good = dict(schema=1, repository="hxx344/project-aggregation", commit=REVISION, tag="deploy-" + REVISION)
        self.assertEqual(parse(good, good["repository"]), REVISION)
        for field, value in (("schema", True), ("schema", 2), ("commit", "main"),
                             ("repository", "another/repo"), ("tag", "latest")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                parse({**good, field: value}, good["repository"])

    def test_content_key_is_path_independent_and_changes_for_every_allowlisted_input(self):
        digest = block("SOURCE_DIGEST")["source_digest"]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for name in FILES:
                path = base / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            expected = digest(base, FILES)
            for name in FILES:
                path = base / name
                path.write_text(name + "changed")
                self.assertNotEqual(digest(base, FILES), expected)
                path.write_text(name)
            (base / FILES[0]).unlink()
            with self.assertRaises(ValueError):
                digest(base, FILES)

    def test_status_requires_current_pid_mode_and_fresh_heartbeat(self):
        check = block("STATUS_LIVE")["status_live"]
        now = datetime.datetime.now(datetime.timezone.utc)
        good = dict(pid=123, session="a-session", mode="research", startedAt=now.isoformat(), heartbeatAt=now.isoformat())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            # Windows has no O_NOFOLLOW; link rejection is tested on native Linux.
            with patch.object(os, "O_NOFOLLOW", getattr(os, "O_NOFOLLOW", 0), create=True), \
                    patch.object(os, "O_NONBLOCK", getattr(os, "O_NONBLOCK", 0), create=True):
                path.write_text(json.dumps(good))
                check(path, "123", now)
                for field, value in (("pid", 124), ("pid", True), ("mode", "live"), ("session", ""),
                                     ("stopped", True),
                                     ("heartbeatAt", (now - datetime.timedelta(seconds=31)).isoformat()),
                                     ("heartbeatAt", (now + datetime.timedelta(seconds=6)).isoformat()),
                                     ("startedAt", (now + datetime.timedelta(seconds=1)).isoformat())):
                    with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                        path.write_text(json.dumps({**good, field: value}))
                        check(path, "123", now)
                path.write_text("x" * 262145)
                with self.assertRaises(ValueError):
                    check(path, "123", now)

    def test_node_archive_only_materializes_verified_regular_node(self):
        functions = block("NODE_ARCHIVE")
        prefix = "node-v24.15.0-linux-x64"
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            archive = base / "node.tar.xz"
            with tarfile.open(archive, "w:xz") as handle:
                item = tarfile.TarInfo(prefix + "/bin/node")
                item.size = 4
                handle.addfile(item, io.BytesIO(b"node"))
                item = tarfile.TarInfo(prefix + "/bin/npm")
                item.type, item.linkname = tarfile.SYMTYPE, "../lib/node_modules/npm/bin/npm-cli.js"
                handle.addfile(item)
            functions["extract_node"](archive, prefix, base / "runtime")
            self.assertEqual((base / "runtime" / prefix / "bin/node").read_bytes(), b"node")
            self.assertFalse((base / "runtime" / prefix / "bin/npm").exists())
            for unsafe in (prefix + "/../escape", "/absolute", "other/bin/node"):
                with self.subTest(member=unsafe):
                    with tarfile.open(archive, "w:xz") as handle:
                        item = tarfile.TarInfo(unsafe)
                        item.size = 1
                        handle.addfile(item, io.BytesIO(b"x"))
                    with self.assertRaises(ValueError):
                        functions["validate_node_archive"](archive, prefix)


class InstallerHarness:
    def __init__(self, test):
        temporary = tempfile.TemporaryDirectory(prefix="entropy-lighter-fixture-", dir="/run")
        test.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.source, self.commands, self.root = (self.base / name for name in ("source", "commands", "opt"))
        self.etc, self.data, self.unit = (self.base / name for name in ("etc", "data", "service"))
        self.commands.mkdir()
        mappings = {"/opt/entropy-lighter-lab": str(self.root), "/etc/entropy-lighter-lab": str(self.etc),
                    "/var/lib/entropy-lighter-lab": str(self.data),
                    "/etc/systemd/system/entropy-lighter-lab.service": str(self.unit),
                    "/run/systemd/system": str(self.base)}
        for name in FILES:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            text = TEXT if name.startswith("deploy/") else "{}\n"
            for before, after in mappings.items():
                text = text.replace(before, after)
            target.write_text(text)
        (self.base / "state").write_text("stopped")
        (self.base / "enabled").write_text("disabled")
        (self.base / "revision").write_text(REVISION)
        self.install_commands()

    def executable(self, name, body):
        path = self.commands / name
        path.write_text("#!/bin/bash\nset -e\n" + body + "\n")
        path.chmod(0o755)

    def install_commands(self):
        self.executable("id", 'if [[ ${1:-} == -u ]]; then echo 65534; fi')
        for name in ("useradd", "runuser", "sleep"):
            self.executable(name, "exit 0")
        self.executable("stat", '''if [[ $1 == -c && $2 == %u && $3 == "$HARNESS_BASE/data" ]]; then echo 65534
else exec /usr/bin/stat "$@"; fi''')
        self.executable("install", '''args=()
while (($#)); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done
exec /usr/bin/install "${args[@]}"''')
        self.executable("python3", 'exec "$HARNESS_PYTHON" "$@"')
        self.executable("node", 'if [[ ${1:-} == --version ]]; then echo v24.15.0; fi')
        self.executable("systemd-run", '''echo check >> "$HARNESS_BASE/validation"
[[ ! -f "$HARNESS_BASE/fail-validation" ]]''')
        self.executable("systemctl", '''printf '%s\\n' "$*" >> "$HARNESS_BASE/service-calls"
case $1 in
  is-active) [[ $(cat "$HARNESS_BASE/state") == active ]] ;;
  is-enabled) [[ $(cat "$HARNESS_BASE/enabled") == enabled ]] ;;
  show) if [[ $* == *MainPID* ]]; then echo 123; else echo no; fi ;;
  enable) echo enabled > "$HARNESS_BASE/enabled" ;;
  disable) echo disabled > "$HARNESS_BASE/enabled" ;;
  restart|start) echo active > "$HARNESS_BASE/state"
    "$HARNESS_PYTHON" -I "$HARNESS_BASE/status.py" ;;
  stop) echo stopped > "$HARNESS_BASE/state" ;;
esac''')
        (self.base / "status.py").write_text('''import datetime, json, os
from pathlib import Path
base = Path(os.environ["HARNESS_BASE"])
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
value = dict(pid=123, session="fixture", mode="research", startedAt=now, heartbeatAt=now)
if (base / "fail-health").exists(): value["pid"] = 124
(base / "data/status.json").write_text(json.dumps(value))
''')
        self.executable("curl", 'exec "$HARNESS_PYTHON" -I "$HARNESS_BASE/download.py" "$@"')
        (self.base / "download.py").write_text('''import json, os, shutil, sys
from pathlib import Path
base = Path(os.environ["HARNESS_BASE"])
url = next(value for value in sys.argv if value.startswith("https:"))
target = Path(sys.argv[sys.argv.index("-o") + 1])
revision = (base / "revision").read_text()
if "/releases/latest/download/release-manifest.json" in url:
    target.write_text(json.dumps(dict(schema=1, repository="hxx344/project-aggregation", commit=revision, tag="deploy-" + revision)))
elif "raw.githubusercontent.com/" in url:
    name = url.split("/" + revision + "/", 1)[1]
    with (base / "downloads").open("a") as output: output.write(name + "\\n")
    shutil.copyfile(base / "source" / name, target)
else: sys.exit(41)
''')

    def run(self, remote=False, fail=None):
        if fail:
            (self.base / ("fail-" + fail)).touch()
        try:
            command = ["bash", str(self.source / FILES[-1])]
            if not remote:
                command += ["--source", str(self.source)]
            return subprocess.run(command, cwd=self.base, capture_output=True, text=True, timeout=60,
                                  env={**os.environ, "PATH": str(self.commands) + ":/usr/bin:/bin",
                                       "HARNESS_BASE": str(self.base), "HARNESS_PYTHON": sys.executable})
        finally:
            if fail:
                (self.base / ("fail-" + fail)).unlink()

    def success(self, **kwargs):
        result = self.run(**kwargs)
        if result.returncode:
            raise AssertionError(result.stdout + "\n" + result.stderr)
        return self.current

    @property
    def current(self):
        return (self.root / "current").resolve()

    def change_code(self):
        path = self.source / FILES[0]
        path.write_text(path.read_text() + "// changed\n")

    def count(self, name):
        path = self.base / name
        return len(path.read_text().splitlines()) if path.exists() else 0


@unittest.skipUnless(LINUX_ROOT, "Requires native non-WSL Linux root; isolated /run fixture")
class InstallerTransactionTests(unittest.TestCase):
    def setUp(self):
        self.h = InstallerHarness(self)

    def test_install_and_noop_skip_validation_restart_and_preserve_data_config(self):
        old = self.h.success()
        (self.h.data / "research.jsonl").write_text("preserved\n")
        config = (self.h.etc / "config.json").read_bytes()
        calls = (self.h.base / "service-calls").read_text().count("restart ")
        self.assertEqual(self.h.success(), old)
        self.assertEqual(self.h.count("validation"), 1)
        self.assertEqual((self.h.base / "service-calls").read_text().count("restart "), calls)
        self.assertEqual((self.h.etc / "config.json").read_bytes(), config)
        self.assertEqual((self.h.data / "research.jsonl").read_text(), "preserved\n")

    def test_code_config_and_node_changes_invalidate_cache(self):
        old = self.h.success()
        self.h.change_code()
        changed = self.h.success()
        self.assertNotEqual(old, changed)
        (self.h.etc / "config.json").write_text('{"changed":true}')
        configured = self.h.success()
        self.assertNotEqual(changed, configured)
        node = self.h.commands / "node"
        node.write_text(node.read_text() + "# runtime changed\n")
        self.assertNotEqual(self.h.success(), configured)
        self.assertEqual(self.h.count("validation"), 4)

    def test_remote_download_is_allowlisted_pinned_and_same_content_updates_identity(self):
        old = self.h.success(remote=True)
        self.assertEqual(self.h.count("downloads"), len(FILES))
        self.assertEqual(self.h.success(remote=True), old)
        self.assertEqual(self.h.count("downloads"), len(FILES))
        (self.h.base / "revision").write_text("b" * 40)
        self.assertEqual(self.h.success(remote=True), old)
        self.assertEqual(self.h.count("downloads"), 2 * len(FILES))
        self.assertEqual(self.h.count("validation"), 1)
        self.assertEqual((old / ".install-revision").read_text().strip(), "b" * 40)

    def test_bad_manifest_and_damaged_source_cache_fail_before_activation(self):
        old = self.h.success(remote=True)
        (self.h.base / "revision").write_text("main")
        self.assertNotEqual(self.h.run(remote=True).returncode, 0)
        self.assertEqual(self.h.current, old)
        (self.h.base / "revision").write_text(REVISION)
        (self.h.root / "sources" / REVISION / FILES[0]).write_text("corrupt")
        self.assertNotEqual(self.h.run(remote=True).returncode, 0)
        self.assertEqual(self.h.current, old)

    def test_failed_check_does_not_switch_or_restart(self):
        old = self.h.success()
        calls = (self.h.base / "service-calls").read_text().count("restart ")
        self.h.change_code()
        self.assertNotEqual(self.h.run(fail="validation").returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual((self.h.base / "service-calls").read_text().count("restart "), calls)

    def test_failed_heartbeat_restores_current_unit_enabled_and_active_state(self):
        old = self.h.success()
        unit = self.h.unit.read_bytes()
        self.h.change_code()
        self.assertNotEqual(self.h.run(fail="health").returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual(self.h.unit.read_bytes(), unit)
        self.assertEqual((self.h.base / "state").read_text().strip(), "active")
        self.assertEqual((self.h.base / "enabled").read_text().strip(), "enabled")
        self.assertEqual(len(list((self.h.root / "releases").iterdir())), 1)

    def test_failed_first_install_restores_absent_current_unit_and_keeps_data(self):
        self.assertNotEqual(self.h.run(fail="health").returncode, 0)
        self.assertFalse((self.h.root / "current").exists())
        self.assertFalse(self.h.unit.exists())
        self.assertTrue((self.h.etc / "config.json").exists())
        self.assertTrue(self.h.data.is_dir())

    def test_failed_activation_preserves_previously_disabled_inactive_service(self):
        old = self.h.success()
        (self.h.base / "state").write_text("stopped")
        (self.h.base / "enabled").write_text("disabled")
        self.h.change_code()
        self.assertNotEqual(self.h.run(fail="health").returncode, 0)
        self.assertEqual(self.h.current, old)
        self.assertEqual((self.h.base / "state").read_text().strip(), "stopped")
        self.assertEqual((self.h.base / "enabled").read_text().strip(), "disabled")

    def test_lock_rejects_concurrent_install_without_changing_release(self):
        import fcntl
        old = self.h.success()
        with (self.h.root / "upgrade.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.h.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Another lab installation", result.stderr)
        self.assertEqual(self.h.current, old)

    def test_untrusted_source_parent_and_linked_source_are_rejected(self):
        self.h.source.chmod(0o777)
        self.assertNotEqual(self.h.run().returncode, 0)
        self.h.source.chmod(0o755)
        path = self.h.source / FILES[0]
        path.unlink()
        path.symlink_to(self.h.base / "revision")
        self.assertNotEqual(self.h.run().returncode, 0)


if __name__ == "__main__":
    unittest.main()
