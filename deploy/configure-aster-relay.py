"""Configure the public relay and import its connection into the embedded ASTER module."""
import argparse
from contextlib import contextmanager
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

SERVER_DIR = Path("/etc/aster-capacity-relay")
WORKSPACE_ENV = Path("/etc/project-aggregation.env")
SERVICE_USER = "project-aggregation"
KEYS = ("ASTER_CAPACITY_RELAY_URL", "ASTER_CAPACITY_RELAY_TOKEN", "ASTER_CAPACITY_RELAY_CA_FILE")
ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$")
TOKEN = re.compile(r"[A-Za-z0-9_-]{32,256}")
MAX_CONFIG = 65536
MAX_ENV = 1024 * 1024
SAVED_MESSAGE = "配置已保存，运行中的工作台连接未切换，下次重启生效。"


def is_link(metadata):
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def check_regular(metadata, uid=None):
    if is_link(metadata) or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Expected an ordinary file without links")
    if os.name == "posix" and uid is not None and (metadata.st_uid != uid or metadata.st_mode & 0o022):
        raise ValueError("Unsafe file owner or permissions")


def no_links(path):
    path = Path(path).absolute()
    for entry in (*reversed(path.parents), path):
        if is_link(entry.lstat()):
            raise ValueError("Paths must not contain symbolic links")


class Directory:
    """Pin the directory on Linux; every file operation is relative to that FD."""

    def __init__(self, path, uid=None):
        self.path, self.uid, self.fd = Path(path).absolute(), uid, None

    def __enter__(self):
        if os.name == "posix":
            current = os.open(self.path.anchor, os.O_RDONLY | os.O_DIRECTORY)
            try:
                for part in self.path.parts[1:]:
                    following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                    os.close(current)
                    current = following
                metadata = os.fstat(current)
                if self.uid is not None and (metadata.st_uid != self.uid or metadata.st_mode & 0o022):
                    raise ValueError("Unsafe runtime directory owner or permissions")
                self.fd = current
            except BaseException:
                os.close(current)
                raise
        else:
            no_links(self.path)
            if not self.path.is_dir():
                raise ValueError("Runtime directory does not exist")
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)

    def open(self, name, flags, mode=0o600):
        if Path(name).name != name or name in (".", ".."):
            raise ValueError("Expected a file name")
        if self.fd is not None:
            return os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, mode, dir_fd=self.fd)
        target = self.path / name
        if target.exists() or target.is_symlink():
            check_regular(target.lstat(), self.uid)
        return os.open(target, flags | getattr(os, "O_BINARY", 0), mode)

    def read(self, name, limit=MAX_ENV, missing=False):
        try:
            descriptor = self.open(name, os.O_RDONLY)
        except FileNotFoundError:
            if missing:
                return None
            raise
        with os.fdopen(descriptor, "rb") as stream:
            check_regular(os.fstat(stream.fileno()), self.uid)
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Input file is too large")
        return data

    def remove(self, name):
        if self.fd is not None:
            os.unlink(name, dir_fd=self.fd)
        else:
            (self.path / name).unlink()

    def write(self, name, data, mode=0o600):
        if isinstance(data, str):
            data = data.encode("utf-8")
        temporary = ".relay-" + secrets.token_hex(16)
        descriptor = self.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if self.fd is not None:
                os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
                os.fsync(self.fd)
            else:
                os.replace(self.path / temporary, self.path / name)
        finally:
            try:
                self.remove(temporary)
            except FileNotFoundError:
                pass

    @contextmanager
    def lock(self):
        if self.fd is None:
            yield
            return
        import fcntl
        descriptor = self.open(".relay-config.lock", os.O_RDWR | os.O_CREAT)
        try:
            check_regular(os.fstat(descriptor), self.uid)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)


def read_file(path, limit=MAX_ENV):
    path = Path(path).absolute()
    with Directory(path.parent) as directory:
        return directory.read(path.name, limit)


def read_environment_text(text):
    values = {}
    for line in text.splitlines():
        match = ENV_LINE.fullmatch(line)
        if match:
            words = shlex.split(match[2], comments=False, posix=True)
            if len(words) > 1:
                raise ValueError("Unsupported environment value")
            values[match[1]] = words[0] if words else ""
    return values


def read_environment(path):
    return read_environment_text(read_file(path).decode("utf-8"))


def update_environment(text, values):
    retained = []
    for line in text.splitlines(keepends=True):
        match = ENV_LINE.fullmatch(line.rstrip("\r\n"))
        if not match or match[1] not in KEYS:
            retained.append(line)
    result = "".join(retained)
    if result and not result.endswith("\n"):
        result += "\n"
    return result + "".join(key + "=" + json.dumps(values[key], ensure_ascii=True) + "\n" for key in KEYS)


def tls_context(pem):
    # Use only the supplied certificate as the trust anchor. Hostname checks and
    # strict X.509 validation remain enabled, including on Python 3.14/OpenSSL 3.5.
    context = ssl.create_default_context(cadata=pem)
    context.verify_flags |= ssl.VERIFY_X509_STRICT
    return context


def validate_connection(raw):
    if len(raw.encode("utf-8") if isinstance(raw, str) else raw) > MAX_CONFIG:
        raise ValueError("Connection configuration is too large")
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate connection field")
            result[key] = value
        return result
    data = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(data, dict) or set(data) != {"url", "token", "ca_pem"}:
        raise ValueError("Expected url, token and ca_pem")
    if not all(isinstance(value, str) for value in data.values()):
        raise ValueError("Connection fields must be strings")
    if any(ord(char) <= 32 or ord(char) >= 127 for char in data["url"]):
        raise ValueError("Invalid relay URL")
    parsed = urlsplit(data["url"])
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or not re.fullmatch(r"[A-Za-z0-9.:[\]-]+", parsed.netloc)):
        raise ValueError("Relay URL must be an HTTPS origin")
    if parsed.port == 0 or len(parsed.hostname) > 253:
        raise ValueError("Invalid relay address")
    if not TOKEN.fullmatch(data["token"]):
        raise ValueError("Invalid relay token")
    pem = data["ca_pem"]
    if not re.fullmatch(r"-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*", pem):
        raise ValueError("Expected one PEM certificate without a private key")
    if len(pem) > 32768:
        raise ValueError("Certificate is too large")
    tls_context(pem)
    data["url"] = data["url"].rstrip("/")
    return data


def request_health(config, *, local=False, path="/health"):
    if path not in ("/health", "/v1/status"):
        raise ValueError("Unsupported relay endpoint")
    parsed = urlsplit(config["url"])
    context = tls_context(config["ca_pem"])
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=5, context=context)
    try:
        if local:
            target = "::1" if ":" in parsed.hostname else "127.0.0.1"
            connection.sock = context.wrap_socket(socket.create_connection((target, parsed.port or 443), 5),
                                                  server_hostname=parsed.hostname)
        connection.request("GET", path, headers={"Authorization": "Bearer " + config["token"], "Accept": "application/json"})
        response = connection.getresponse()
        raw = response.read(MAX_CONFIG + 1)
        if response.status != 200 or len(raw) > MAX_CONFIG:
            raise ValueError("Relay health check failed")
        payload = json.loads(raw)
        if not isinstance(payload, dict) or (path == "/health" and payload.get("status") != "ok"):
            raise ValueError("Invalid relay health response")
        return {"status": "ok"} if path == "/health" else payload
    finally:
        connection.close()


def server_connection(directory=SERVER_DIR):
    directory = Path(directory).absolute()
    with Directory(directory, os.geteuid() if os.name == "posix" else None) as store:
        env = read_environment_text(store.read("environment").decode("utf-8"))
        address = str(ipaddress.ip_address(store.read("address").decode("ascii").strip()))
        # Never let an environment value authorize a root read of another file.
        if (Path(env["ASTER_RELAY_CERT_FILE"]) != directory / "server.crt"
                or Path(env["ASTER_RELAY_KEY_FILE"]) != directory / "server.key"):
            raise ValueError("Relay certificate paths must use its configuration directory")
        host = "[" + address + "]" if ":" in address else address
        return validate_connection(json.dumps({"url": f"https://{host}:{int(env['ASTER_RELAY_PORT'])}",
            "token": env["ASTER_RELAY_TOKEN"], "ca_pem": store.read("server.crt").decode("ascii")}))


def prepare_server(directory, address):
    directory = Path(directory).absolute()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with Directory(directory, os.geteuid() if os.name == "posix" else None) as store:
        saved = store.read("address", missing=True)
        if saved is not None:
            saved = str(ipaddress.ip_address(saved.decode("ascii").strip()))
            if address and str(ipaddress.ip_address(address)) != saved:
                raise ValueError("Existing relay address must be preserved")
            address = saved
        if not address:
            raise ValueError("First installation requires --address with the public IP")
        address = str(ipaddress.ip_address(address))
        cert, key = store.read("server.crt", missing=True), store.read("server.key", missing=True)
        if (cert is None) != (key is None):
            raise ValueError("Existing certificate/key pair is incomplete")
        if cert is None:
            with tempfile.TemporaryDirectory(prefix=".tls-", dir=directory) as temporary:
                scratch = Path(temporary)
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
                    "-days", "3650", "-subj", "/CN=Aster capacity relay", "-addext", "subjectAltName=IP:" + address,
                    "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth",
                    "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
                    "-addext", "subjectKeyIdentifier=hash", "-addext", "authorityKeyIdentifier=keyid:always",
                    "-keyout", str(scratch / "key"), "-out", str(scratch / "cert")],
                    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                store.write("server.key", (scratch / "key").read_bytes())
                store.write("server.crt", (scratch / "cert").read_bytes(), 0o644)
        cert_file, key_file = directory / "server.crt", directory / "server.key"
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(cert_file, key_file)
        decoded = ssl._ssl._test_decode_cert(str(cert_file))
        if not any(kind == "IP Address" and ipaddress.ip_address(value) == ipaddress.ip_address(address)
                   for kind, value in decoded.get("subjectAltName", ())):
            raise ValueError("Existing certificate does not cover the relay address")
        if saved is None:
            store.write("address", address + "\n")
        if store.read("environment", missing=True) is None:
            store.write("environment", "# Relay settings; preserved on upgrades.\n" + "\n".join([
                "ASTER_RELAY_TOKEN=" + secrets.token_urlsafe(32),
                "ASTER_RELAY_HOST=" + ("::" if ":" in address else "0.0.0.0"), "ASTER_RELAY_PORT=8766",
                "ASTER_RELAY_SYMBOLS=XAUUSD1,XAGUSD1", "ASTER_RELAY_INTERVAL=0.2", "ASTER_RELAY_BRACKETS_INTERVAL=60",
                "ASTER_RELAY_CERT_FILE=" + json.dumps(str(cert_file)), "ASTER_RELAY_KEY_FILE=" + json.dumps(str(key_file)), ""]))
        config = server_connection(directory)
        encoded = (json.dumps(config, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
        if store.read("connection.json", missing=True) != encoded:
            store.write("connection.json", encoded)


def require_trusted_path(path, *, missing_leaf=False):
    """Root-owned input and every parent must be protected against replacement."""
    path = Path(path).absolute()
    for entry in (*reversed(path.parents), path):
        try:
            metadata = entry.lstat()
        except FileNotFoundError:
            if entry == path and missing_leaf:
                continue
            raise
        if is_link(metadata) or (entry != path and not stat.S_ISDIR(metadata.st_mode)):
            raise ValueError("Unsafe privileged input path")
        if os.name == "posix" and (metadata.st_uid != 0 or metadata.st_mode & 0o022):
            raise ValueError("Privileged inputs and parents must be root-owned and protected")


def workspace_target(environment=None):
    environment = WORKSPACE_ENV if environment is None else environment
    if os.name != "posix" or os.geteuid() != 0:
        raise ValueError("Run connect using sudo on the workstation server")
    import pwd
    account = pwd.getpwnam(SERVICE_USER)
    if account.pw_uid == 0:
        raise ValueError("Workspace service must not run as root")
    require_trusted_path(environment)
    env = read_environment(environment)
    value = env.get("DATA_DIR", "/var/lib/project-aggregation")
    parsed = PurePosixPath(value)
    if (not re.fullmatch(r"/[A-Za-z0-9_./-]+", value) or ".." in parsed.parts
            or str(parsed) != value or value == "/"):
        raise ValueError("Invalid DATA_DIR")
    roots = ("/var/lib/project-aggregation", "/opt/project-aggregation-data")
    if not any(value == root or value.startswith(root + "/") for root in roots) and not value.startswith("/srv/project-aggregation/"):
        raise ValueError("DATA_DIR is outside the workspace installer directories")
    data = Path(value)
    no_links(data)
    metadata = data.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != account.pw_uid or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ValueError("DATA_DIR must belong to the workspace service and have mode 0700")
    return data, account.pw_uid, account.pw_gid


def drop_privileges(uid, gid):
    if uid == 0:
        raise ValueError("Root is not a workspace account")
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    os.umask(0o077)
    if os.geteuid() != uid or os.getegid() != gid:
        raise ValueError("Could not drop root privileges")


def runtime_directory(data, uid):
    # This runs after privilege dropping. No root reads or writes occur anywhere
    # in the service-owned tree, including during directory creation.
    directory = Path(data)
    for component in ("modules", "aster"):
        with Directory(directory, uid) as store:
            child = directory / component
            if store.fd is None:
                child.mkdir(mode=0o700, exist_ok=True)
            else:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=store.fd)
                except FileExistsError:
                    pass
        directory = child
    with Directory(directory, uid):
        pass
    return directory


def apply_connection(config, directory, *, verify=request_health, uid=None):
    config = validate_connection(json.dumps(config))
    verify(config)
    uid = os.geteuid() if uid is None and os.name == "posix" else uid
    directory = Path(directory).absolute()
    certificate = config["ca_pem"].encode("ascii")
    ca_name = "relay-ca-" + hashlib.sha256(certificate).hexdigest() + ".pem"
    values = dict(zip(KEYS, (config["url"], config["token"], str(directory / ca_name))))
    with Directory(directory, uid) as store, store.lock():
        original = store.read(".env", missing=True)
        updated = update_environment((original or b"").decode("utf-8"), values).encode("utf-8")
        previous_ca = store.read(ca_name, missing=True)
        if previous_ca is not None and previous_ca != certificate:
            raise ValueError("Existing certificate does not match its content hash")
        if original == updated and previous_ca == certificate:
            return False
        created_ca = previous_ca is None
        try:
            if created_ca:
                store.write(ca_name, certificate)
            # The environment rename is the commit point. Old CA files remain
            # available to the running service and are never read from old .env.
            store.write(".env", updated)
        except BaseException:
            current = store.read(".env", missing=True)
            if current == updated:
                if original is None:
                    store.remove(".env")
                else:
                    store.write(".env", original)
            if created_ca and store.read(ca_name, missing=True) is not None:
                store.remove(ca_name)
            raise
    return True


def open_hidden_terminal():
    # Open only the controlling terminal before dropping privileges. JSON and
    # --file are always read afterwards. Never fall back to echoed input.
    import termios
    descriptor = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
    try:
        termios.tcgetattr(descriptor)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def read_hidden(descriptor):
    import termios
    previous = termios.tcgetattr(descriptor)
    hidden = previous[:]
    hidden[3] &= ~termios.ECHO
    try:
        termios.tcsetattr(descriptor, termios.TCSAFLUSH, hidden)
        os.write(descriptor, "请粘贴中继连接 JSON（隐藏输入），然后按回车：".encode("utf-8"))
        with os.fdopen(os.dup(descriptor), "r", encoding="utf-8") as stream:
            raw = stream.readline(MAX_CONFIG + 2)
        return raw.rstrip("\r\n")
    finally:
        termios.tcsetattr(descriptor, termios.TCSAFLUSH, previous)
        os.write(descriptor, b"\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare-server", "export-connect", "health", "status", "connect"))
    parser.add_argument("--directory", type=Path, help="Relay configuration directory (relay commands only)")
    parser.add_argument("--address")
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument("--file", type=Path)
    inputs.add_argument("--interactive", action="store_true", help="Read hidden JSON from /dev/tty, even when stdin carries this script")
    args = parser.parse_args(argv)
    terminal = None
    try:
        if args.command == "connect":
            if args.directory is not None or args.address is not None:
                raise ValueError("Connect uses the installed workspace DATA_DIR")
            data, uid, gid = workspace_target()
            if args.interactive or (args.file is None and sys.stdin.isatty()):
                terminal = open_hidden_terminal()
            drop_privileges(uid, gid)
            if terminal is not None:
                raw = read_hidden(terminal)
            elif args.file:
                raw = read_file(args.file, MAX_CONFIG).decode("utf-8")
            else:
                raw = sys.stdin.read(MAX_CONFIG + 1)
            config = validate_connection(raw)
            request_health(config)
            changed = apply_connection(config, runtime_directory(data, uid), uid=uid, verify=lambda _: None)
            print(("" if changed else "连接配置无变化。") + SAVED_MESSAGE)
        else:
            if args.file is not None or args.interactive:
                raise ValueError("Connection input is only supported by connect")
            directory = args.directory or SERVER_DIR
            require_trusted_path(directory, missing_leaf=args.command == "prepare-server")
            if args.command == "prepare-server":
                prepare_server(directory, args.address)
            else:
                config = server_connection(directory)
                if args.command == "export-connect":
                    print(json.dumps(config, separators=(",", ":")))
                else:
                    payload = request_health(config, local=True, path="/v1/status" if args.command == "status" else "/health")
                    # Service errors are normally enums, but never echo a token
                    # even if an unexpected upstream/status payload reflects it.
                    print(json.dumps(payload, ensure_ascii=True).replace(config["token"], "[redacted]"))
    except (OSError, ValueError, KeyError, ssl.SSLError, subprocess.SubprocessError,
            http.client.HTTPException, RecursionError):
        print("中继配置或健康检查失败。请检查地址、证书、token、目录权限和服务状态；工作台未重启。", file=sys.stderr)
        return 1
    finally:
        if terminal is not None:
            os.close(terminal)
    return 0


if __name__ == "__main__":
    sys.exit(main())
