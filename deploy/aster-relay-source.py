"""Bounded extraction and provenance checks for the independent ASTER relay."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import sys
import sysconfig
import tarfile

REPOSITORY = "hxx344/project-aggregation"
FILES = (
    "modules/aster/monitor.py",
    "modules/aster/trading/__init__.py",
    "modules/aster/trading/capacity_relay_server.py",
    "modules/aster/requirements-relay.lock",
    "deploy/configure-aster-relay.py",
    "deploy/install-aster-relay.sh",
    "deploy/aster-capacity-relay.service",
    "deploy/aster-capacity-relay",
    "deploy/aster-relay-source.py",
)
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_MEMBER = 32 * 1024 * 1024
MAX_SELECTED = 4 * 1024 * 1024
MAX_MEMBERS = 30_000


class BoundedTarStream:
    """Bound decompression itself, including tar headers and ignored padding."""

    def __init__(self, stream):
        self.stream = stream
        self.remaining = MAX_TOTAL

    def read(self, size=-1):
        if size < 0:
            size = self.remaining + 1
        data = self.stream.read(min(size, self.remaining + 1))
        self.remaining -= len(data)
        if self.remaining < 0:
            raise ValueError("Source archive exceeds decompressed size limit")
        return data


def manifest_commit(data):
    if (not isinstance(data, dict) or type(data.get("schema")) is not int or data["schema"] != 1
            or data.get("repository") != REPOSITORY
            or not isinstance(data.get("commit"), str)
            or not re.fullmatch(r"[a-f0-9]{40}", data["commit"])
            or data.get("tag") != "deploy-" + data["commit"]):
        raise ValueError("Invalid stable release manifest")
    return data["commit"]


def trusted_path(path, *, missing=False):
    """Check every parent before allowing root to consume or replace a path."""
    path = Path(os.path.abspath(path))
    for item in reversed((path, *path.parents)):
        try:
            info = item.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise ValueError("Missing trusted path: " + str(item)) from None
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError("Links and special files are not trusted inputs: " + str(item))
        if os.name == "posix" and (info.st_uid != 0 or info.st_mode & 0o022):
            raise ValueError("Expected root-owned path without group/world writes: " + str(item))
    return path


def trusted_source(source):
    source = trusted_path(source)
    for name in FILES:
        path = trusted_path(source / name)
        if not path.is_file() or path.stat().st_size > MAX_SELECTED:
            raise ValueError("Missing or oversized relay file: " + name)
    return source


def trusted_cache(path):
    path = trusted_path(path)
    for directory, dirs, files in os.walk(path, followlinks=False):
        for name in dirs + files:
            entry = Path(directory) / name
            if entry.is_symlink():
                # venv links to the system interpreter and lib64 are legitimate;
                # both the link and its resolved target must remain root trusted.
                info = entry.lstat()
                if os.name == "posix" and info.st_uid != 0:
                    raise ValueError("Untrusted Python environment link")
                trusted_path(entry.resolve(strict=True))
            else:
                trusted_path(entry)


def extract_source(archive, destination, revision):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid source revision")
    archive, destination = Path(archive), Path(destination)
    if archive.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Source archive exceeds size limit")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Extraction destination must not exist")
    prefix = "project-aggregation-" + revision
    seen, selected, total = set(), {}, 0
    # Validate the entire tar, including ignored members, before writing files.
    # Never call extract/extractall: archive permissions/ownership are untrusted.
    with gzip.open(archive, "rb") as compressed, tarfile.open(fileobj=BoundedTarStream(compressed), mode="r|") as handle:
        for count, member in enumerate(handle, 1):
            name = member.name.rstrip("/") if member.isdir() else member.name
            parts = name.split("/")
            if (count > MAX_MEMBERS or not name or "\\" in name or "\x00" in name
                    or any(part in ("", ".", "..") or ":" in part for part in parts)
                    or PurePosixPath(name).is_absolute() or parts[0] != prefix
                    or name in seen or not (member.isfile() or member.isdir())
                    or member.size < 0 or member.size > MAX_MEMBER
                    or member.sparse is not None):
                raise ValueError("Unsafe, duplicate or oversized archive member")
            seen.add(name)
            total += member.size
            if total > MAX_TOTAL or (member.isdir() and member.size):
                raise ValueError("Source archive exceeds expanded size limit")
            relative = "/".join(parts[1:])
            if relative in FILES:
                if not member.isfile() or member.size > MAX_SELECTED:
                    raise ValueError("Invalid relay source member: " + relative)
                stream = handle.extractfile(member)
                data = stream.read(MAX_SELECTED + 1)
                if len(data) != member.size:
                    raise ValueError("Truncated relay source member")
                selected[relative] = data
        if set(selected) != set(FILES):
            raise ValueError("Source archive is missing required relay files")
    destination.mkdir(mode=0o755)
    try:
        for name, data in selected.items():
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with path.open("xb") as stream:
                stream.write(data)
            path.chmod(0o644)
    except BaseException:
        shutil.rmtree(destination)
        raise


def fingerprints(source):
    source = trusted_source(source)
    runtime = json.dumps([sys.version, os.path.realpath(sys.executable),
                          sysconfig.get_config_var("SOABI"), platform.machine(), platform.libc_ver()])
    lock = (source / "modules/aster/requirements-relay.lock").read_bytes()
    dependency = hashlib.sha256(("relay-python-v2:" + runtime).encode() + lock).hexdigest()
    content = hashlib.sha256(("relay-release-v2:" + dependency).encode())
    for name in sorted(FILES):
        data = (source / name).read_bytes()
        content.update(name.encode() + b"\0" + len(data).to_bytes(8, "big") + data)
    return dependency, content.hexdigest()


def installed_state(paths):
    result = hashlib.sha256()
    for raw in paths:
        path = trusted_path(raw)
        info = path.stat()
        result.update(str(path).encode() + b"\0" + path.read_bytes())
        result.update(str((stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)).encode())
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("extract")
    p.add_argument("archive"); p.add_argument("destination"); p.add_argument("revision")
    for name in ("trust-source", "trust-cache", "fingerprints"):
        sub.add_parser(name).add_argument("source")
    sub.add_parser("state").add_argument("paths", nargs="+")
    sub.add_parser("files")
    args = parser.parse_args()
    if args.command == "extract":
        extract_source(args.archive, args.destination, args.revision)
    elif args.command == "trust-source":
        trusted_source(args.source)
    elif args.command == "trust-cache":
        trusted_cache(args.source)
    elif args.command == "fingerprints":
        print("\n".join(fingerprints(args.source)))
    elif args.command == "state":
        print(installed_state(args.paths))
    elif args.command == "files":
        print("\n".join(FILES))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        sys.exit("[relay] " + str(error))
