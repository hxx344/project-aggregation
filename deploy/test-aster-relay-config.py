"""Native offline configuration/TLS tests; Linux adds real privilege-boundary checks."""
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "deploy/configure-aster-relay.py"
spec = importlib.util.spec_from_file_location("aster_relay_configuration", HELPER)
configuration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configuration)
OPENSSL = shutil.which("openssl") or (r"D:\Git\usr\bin\openssl.exe" if Path(r"D:\Git\usr\bin\openssl.exe").is_file() else None)
LINUX_ROOT = sys.platform == "linux" and os.geteuid() == 0


@contextlib.contextmanager
def tls_server(config, directory, payload=None):
    response = {"status": "ok"} if payload is None else payload

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get("Authorization") != "Bearer " + config["token"]:
                self.send_error(401)
                return
            body = json.dumps(response).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(directory / "server.crt", directory / "server.key")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {**config, "url": "https://127.0.0.1:" + str(server.server_port)}
    finally:
        server.shutdown()
        thread.join(3)
        server.server_close()


@unittest.skipUnless(OPENSSL, "Native OpenSSL is required for certificate fixtures")
class RelayConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.server = Path(cls.temporary.name) / "server"
        with patch.dict(os.environ, {"PATH": str(Path(OPENSSL).parent) + os.pathsep + os.environ.get("PATH", "")}):
            configuration.prepare_server(cls.server, "127.0.0.1")
        cls.config = configuration.server_connection(cls.server)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.original = '# Workspace settings\nASTER_ALLOW_LIVE=0\nASTER_A_PRIVATE_KEY="fixture-preserved"\n# Keep this comment\nOTHER="literal value"\n'
        (self.directory / ".env").write_text(self.original, encoding="utf-8")
        self.verify = Mock()

    def apply(self, config=None, **kwargs):
        return configuration.apply_connection(config or self.config, self.directory, verify=kwargs.get("verify", self.verify))

    def imported_ca(self):
        return Path(configuration.read_environment(self.directory / ".env")["ASTER_CAPACITY_RELAY_CA_FILE"])

    def test_defaults_use_both_symbols_and_preserve_credentials_on_repeat(self):
        env = configuration.read_environment(self.server / "environment")
        self.assertEqual(env["ASTER_RELAY_SYMBOLS"], "XAUUSD1,XAGUSD1")
        self.assertEqual((env["ASTER_RELAY_PORT"], env["ASTER_RELAY_INTERVAL"], env["ASTER_RELAY_BRACKETS_INTERVAL"]), ("8766", "0.2", "60"))
        paths = [self.server / name for name in ("environment", "address", "server.key", "server.crt", "connection.json")]
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths}
        configuration.prepare_server(self.server, "")
        self.assertEqual(before, {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths})
        with self.assertRaises(ValueError):
            configuration.prepare_server(self.server, "127.0.0.2")
        self.assertEqual(before, {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths})

    def test_import_preserves_unrelated_content_and_is_idempotent(self):
        original_bytes = (self.directory / ".env").read_bytes()
        with patch.object(configuration.subprocess, "run") as process:
            self.assertTrue(self.apply())
            first = (self.directory / ".env").read_bytes()
            first_time = (self.directory / ".env").stat().st_mtime_ns
            self.assertTrue(first.startswith(original_bytes))
            ca = self.imported_ca()
            self.assertEqual(ca.read_text(), self.config["ca_pem"])
            self.assertFalse(self.apply())
            self.assertEqual((self.directory / ".env").stat().st_mtime_ns, first_time)
            self.assertEqual((self.directory / ".env").read_bytes(), first)
            process.assert_not_called()
        if os.name == "posix":
            self.assertEqual((self.directory / ".env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(ca.stat().st_mode & 0o777, 0o600)

    def test_empty_workspace_env_is_created_without_any_private_key(self):
        (self.directory / ".env").unlink()
        self.apply()
        values = configuration.read_environment(self.directory / ".env")
        self.assertEqual(set(values), set(configuration.KEYS))

    def test_old_ca_path_never_authorizes_a_file_read(self):
        poison = 'ASTER_CAPACITY_RELAY_CA_FILE="/root/private-fixture-never-read"\n'
        (self.directory / ".env").write_text(self.original + poison)
        original_read = configuration.Directory.read
        reads = []
        def tracked(store, name, *args, **kwargs):
            reads.append(name)
            return original_read(store, name, *args, **kwargs)
        with patch.object(configuration.Directory, "read", new=tracked):
            self.apply()
        self.assertNotIn("private-fixture-never-read", reads)
        self.assertNotIn("/root", (self.directory / ".env").read_text())

    def test_target_duplicates_and_export_syntax_are_replaced(self):
        (self.directory / ".env").write_text(self.original + 'export ASTER_CAPACITY_RELAY_TOKEN=old\nASTER_CAPACITY_RELAY_TOKEN=older\n')
        self.apply()
        updated = (self.directory / ".env").read_text()
        self.assertEqual(updated.count("ASTER_CAPACITY_RELAY_TOKEN="), 1)
        self.assertTrue(updated.startswith(self.original))

    def test_failed_preflight_preserves_environment_without_ca_creation(self):
        with self.assertRaises(ValueError):
            self.apply(verify=Mock(side_effect=ValueError("unreachable")))
        self.assertEqual((self.directory / ".env").read_text(), self.original)
        self.assertFalse(list(self.directory.glob("relay-ca-*.pem")))

    def test_failed_environment_rename_preserves_old_env_and_removes_new_ca(self):
        replace = configuration.os.replace
        def fail_environment(source, target, *args, **kwargs):
            if Path(target).name == ".env":
                raise OSError("fixture write failure")
            return replace(source, target, *args, **kwargs)
        with patch.object(configuration.os, "replace", side_effect=fail_environment), self.assertRaises(OSError):
            self.apply()
        self.assertEqual((self.directory / ".env").read_text(), self.original)
        self.assertFalse(list(self.directory.glob("relay-ca-*.pem")))
        self.assertFalse(list(self.directory.glob(".relay-*")))

    def test_failure_after_rename_restores_env_and_preserves_existing_ca(self):
        self.apply()
        before = (self.directory / ".env").read_bytes()
        ca = self.imported_ca()
        original_write = configuration.Directory.write
        failed = False
        def fail_after_write(store, name, data, *args, **kwargs):
            nonlocal failed
            original_write(store, name, data, *args, **kwargs)
            if name == ".env" and not failed:
                failed = True
                raise OSError("fixture post-rename failure")
        with patch.object(configuration.Directory, "write", new=fail_after_write), self.assertRaises(OSError):
            self.apply({**self.config, "token": "b" * 40})
        self.assertEqual((self.directory / ".env").read_bytes(), before)
        self.assertEqual(ca.read_text(), self.config["ca_pem"])

    def test_new_certificate_keeps_old_ca_for_running_service(self):
        self.apply()
        old_ca = self.imported_ca()
        second = {**self.config, "ca_pem": self.config["ca_pem"] + "\n"}
        self.assertTrue(self.apply(second))
        self.assertNotEqual(self.imported_ca(), old_ca)
        self.assertEqual(old_ca.read_text(), self.config["ca_pem"])

    def test_unsafe_url_token_and_pem_are_rejected(self):
        cases = (("url", "http://127.0.0.1:8766"), ("url", "https://user:password@example.com"),
                 ("url", "https://example.com/path"), ("url", "https://example.com?token=a"),
                 ("url", "https://example.com/#fragment"), ("url", "https://example.com:99999"),
                 ("url", "https://example.com:0"), ("url", "https://example.com\\@other.example"),
                 ("url", "https://example.com\n"), ("token", "a" * 31), ("token", "a" * 257),
                 ("token", "$(not-executed);" + "a" * 32), ("token", "a" * 32 + "\r\nHeader: value"),
                 ("ca_pem", "not a certificate"), ("ca_pem", self.config["ca_pem"] + "-----BEGIN PRIVATE KEY-----"))
        for field, value in cases:
            with self.subTest(field=field, value=value), self.assertRaises((ValueError, ssl.SSLError)):
                configuration.validate_connection(json.dumps({**self.config, field: value}))

    def test_bad_json_duplicate_fields_and_oversized_input_are_rejected(self):
        for raw in ("[1]", "null", "{}", "not-json", '{"url":1,"token":2,"ca_pem":3}',
                    json.dumps(self.config)[:-1] + ',"token":"' + self.config["token"] + '"}',
                    " " * (configuration.MAX_CONFIG + 1)):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                configuration.validate_connection(raw)

    def test_environment_parsing_never_executes_substitutions(self):
        self.assertEqual(configuration.read_environment_text("DATA_DIR='$(not-a-command)'\n")["DATA_DIR"], "$(not-a-command)")

    def test_generated_certificate_supports_strict_hostname_verified_tls(self):
        with tls_server(self.config, self.server) as config:
            context = configuration.tls_context(config["ca_pem"])
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.verify_flags & ssl.VERIFY_X509_STRICT)
            self.assertEqual(configuration.request_health(config), {"status": "ok"})
            self.assertEqual(configuration.request_health(config, local=True), {"status": "ok"})
            with self.assertRaises(ssl.SSLError):
                configuration.request_health({**config, "url": config["url"].replace("127.0.0.1", "localhost")})
            with self.assertRaises(ValueError):
                configuration.request_health({**config, "token": "x" * 40})

    def test_liveness_does_not_require_collected_samples(self):
        with tls_server(self.config, self.server, {"status": "ok", "collector_running": False, "samples": []}) as config:
            self.assertEqual(configuration.request_health(config), {"status": "ok"})
            self.assertEqual(configuration.request_health(config, path="/v1/status")["samples"], [])

    def test_unhealthy_or_oversized_response_is_rejected(self):
        for payload in ({"status": "starting"}, {"status": "ok", "extra": "x" * configuration.MAX_CONFIG}):
            with tls_server(self.config, self.server, payload) as config, self.assertRaises(ValueError):
                configuration.request_health(config)

    def test_existing_server_config_cannot_read_an_external_ca_path(self):
        copy = self.directory / "copied-server"
        shutil.copytree(self.server, copy)
        env = (copy / "environment").read_text().replace(str(self.server / "server.crt").replace("\\", "\\\\"), "/root/private-fixture")
        (copy / "environment").write_text(env)
        with self.assertRaises(ValueError):
            configuration.server_connection(copy)

    def test_interactive_cli_opens_terminal_before_drop_and_reads_after_drop(self):
        steps = []
        output = io.StringIO()
        with patch.object(configuration, "workspace_target", return_value=(self.directory, 1234, 1234)), \
                patch.object(configuration, "open_hidden_terminal", side_effect=lambda: steps.append("open-tty") or 91), \
                patch.object(configuration, "drop_privileges", side_effect=lambda *_: steps.append("drop")), \
                patch.object(configuration, "read_hidden", side_effect=lambda *_: steps.append("read-tty") or json.dumps(self.config)), \
                patch.object(configuration, "runtime_directory", return_value=self.directory), \
                patch.object(configuration, "request_health"), patch.object(configuration, "apply_connection", return_value=True), \
                patch.object(configuration.os, "close"), contextlib.redirect_stdout(output):
            self.assertEqual(configuration.main(["connect", "--interactive"]), 0)
        self.assertEqual(steps, ["open-tty", "drop", "read-tty"])
        self.assertIn(configuration.SAVED_MESSAGE, output.getvalue())
        self.assertNotIn(self.config["token"], output.getvalue())

    def test_file_cli_reads_only_after_privilege_drop(self):
        steps = []
        with patch.object(configuration, "workspace_target", return_value=(self.directory, 1234, 1234)), \
                patch.object(configuration, "drop_privileges", side_effect=lambda *_: steps.append("drop")), \
                patch.object(configuration, "read_file", side_effect=lambda *_: steps.append("read-file") or json.dumps(self.config).encode()), \
                patch.object(configuration, "runtime_directory", return_value=self.directory), \
                patch.object(configuration, "request_health"), patch.object(configuration, "apply_connection", return_value=False), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(configuration.main(["connect", "--file", "connection.json"]), 0)
        self.assertEqual(steps, ["drop", "read-file"])
        self.assertIn("无变化", output.getvalue())
        self.assertIn(configuration.SAVED_MESSAGE, output.getvalue())

    def test_input_error_is_redacted_and_does_not_write_or_start_process(self):
        secret = self.config["token"]
        with patch.object(configuration, "workspace_target", side_effect=ValueError(secret)), \
                patch.object(configuration, "apply_connection") as apply, \
                patch.object(configuration.subprocess, "run") as process, contextlib.redirect_stderr(io.StringIO()) as error:
            self.assertEqual(configuration.main(["connect"]), 1)
        self.assertNotIn(secret, error.getvalue())
        apply.assert_not_called()
        process.assert_not_called()

    def test_connect_cannot_override_workspace_directory(self):
        with patch.object(configuration, "workspace_target") as target, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(configuration.main(["connect", "--directory", "/etc/aster-desk"]), 1)
        target.assert_not_called()


@unittest.skipUnless(LINUX_ROOT and OPENSSL, "Linux root required for real permissions; never use WSL")
class LinuxPrivilegeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import pwd
        cls.account = pwd.getpwnam("nobody")
        cls.root_temporary = tempfile.TemporaryDirectory(prefix="relay-config-test-", dir="/root")
        cls.addClassCleanup(cls.root_temporary.cleanup)
        cls.fixture = Path(cls.root_temporary.name)
        cls.server = cls.fixture / "server"
        configuration.prepare_server(cls.server, "127.0.0.1")
        cls.config = configuration.server_connection(cls.server)
        cls.service_parent = Path("/srv/project-aggregation")
        cls.created_parent = not cls.service_parent.exists()
        cls.service_parent.mkdir(mode=0o755, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        if cls.created_parent:
            cls.service_parent.rmdir()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay-config-", dir=self.service_parent)
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name)
        os.chown(self.data, self.account.pw_uid, self.account.pw_gid)
        self.environment = self.fixture / (self.data.name + ".env")
        self.environment.write_text("DATA_DIR=" + str(self.data) + "\n")
        self.environment.chmod(0o600)

    def target(self):
        with patch.object(configuration, "SERVICE_USER", "nobody"):
            return configuration.workspace_target(self.environment)

    def child(self, config, *arguments):
        code = ("import importlib.util, pathlib; "
                f"s=importlib.util.spec_from_file_location('config', {str(HELPER)!r}); "
                "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                f"m.WORKSPACE_ENV=pathlib.Path({str(self.environment)!r}); m.SERVICE_USER='nobody'; "
                f"raise SystemExit(m.main({['connect', *arguments]!r}))")
        return subprocess.run([sys.executable, "-I", "-c", code], input=json.dumps(config), text=True,
                              capture_output=True, timeout=15)

    def test_real_root_entry_drops_privileges_and_saves_service_readable_configuration(self):
        with tls_server(self.config, self.server) as config:
            result = self.child(config)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(config["token"], result.stdout + result.stderr)
            environment = self.data / "modules/aster/.env"
            self.assertEqual(environment.stat().st_uid, self.account.pw_uid)
            self.assertEqual(environment.stat().st_mode & 0o777, 0o600)
            ca = Path(configuration.read_environment(environment)["ASTER_CAPACITY_RELAY_CA_FILE"])
            self.assertEqual(ca.stat().st_uid, self.account.pw_uid)
            self.assertEqual(ca.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.child(config).returncode, 0)

    def test_unreadable_file_is_not_read_as_root(self):
        private = self.fixture / "private-connection.json"
        private.write_text(json.dumps(self.config))
        private.chmod(0o600)
        result = self.child(self.config, "--file", str(private))
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.config["token"], result.stdout + result.stderr)
        self.assertFalse((self.data / "modules").exists())

    def test_workspace_environment_requires_trusted_file_and_parents(self):
        self.assertEqual(self.target()[0], self.data)
        self.environment.chmod(0o666)
        with self.assertRaises(ValueError):
            self.target()
        self.environment.chmod(0o600)
        self.fixture.chmod(0o777)
        try:
            with self.assertRaises(ValueError):
                self.target()
        finally:
            self.fixture.chmod(0o700)

    def test_data_root_requires_service_ownership_and_private_permissions(self):
        self.data.chmod(0o755)
        with self.assertRaises(ValueError):
            self.target()
        self.data.chmod(0o700)
        os.chown(self.data, 0, 0)
        with self.assertRaises(ValueError):
            self.target()

    def test_rejects_symlink_env_symlink_parent_fifo_and_hardlink(self):
        directory = self.fixture / self.data.name
        directory.mkdir(mode=0o700)
        private = self.fixture / (self.data.name + "-private")
        private.write_text("private fixture")
        environment = directory / ".env"
        environment.symlink_to(private)
        with self.assertRaises((ValueError, OSError)):
            configuration.apply_connection(self.config, directory, verify=lambda _: None)
        self.assertEqual(private.read_text(), "private fixture")
        environment.unlink()
        os.mkfifo(environment)
        with self.assertRaises(ValueError):
            configuration.apply_connection(self.config, directory, verify=lambda _: None)
        environment.unlink()
        os.link(private, environment)
        with self.assertRaises(ValueError):
            configuration.apply_connection(self.config, directory, verify=lambda _: None)
        environment.unlink()
        link = self.fixture / (self.data.name + "-link")
        link.symlink_to(directory, target_is_directory=True)
        with self.assertRaises(OSError):
            configuration.apply_connection(self.config, link, verify=lambda _: None)

    def test_runtime_symlink_cannot_modify_root_private_file(self):
        modules = self.data / "modules"
        modules.mkdir(mode=0o700)
        os.chown(modules, self.account.pw_uid, self.account.pw_gid)
        (modules / "aster").symlink_to(self.fixture, target_is_directory=True)
        private = self.fixture / ".env"
        private.write_text("ROOT_SECRET=fixture\n")
        with tls_server(self.config, self.server) as config:
            result = self.child(config)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(private.read_text(), "ROOT_SECRET=fixture\n")
        self.assertNotIn("ROOT_SECRET", result.stdout + result.stderr)

    def test_interactive_reader_disables_echo_and_restores_terminal(self):
        import pty
        import termios
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        previous = termios.tcgetattr(slave)
        result = []
        thread = threading.Thread(target=lambda: result.append(configuration.read_hidden(slave)))
        thread.start()
        prompt = os.read(master, 4096)
        self.assertIn("JSON".encode(), prompt)
        self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
        os.write(master, b'{"fixture":"hidden"}\n')
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, ['{"fixture":"hidden"}'])
        self.assertEqual(termios.tcgetattr(slave), previous)
        self.assertNotIn(b"hidden", os.read(master, 4096))


if __name__ == "__main__":
    unittest.main()
