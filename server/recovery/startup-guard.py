# Managed by project-aggregation recovery
"""Persistent systemd guard retained when an application release rolls back."""
import json
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys


def guard(data_dir, core_file, node):
    directory = Path(data_dir)
    if directory.is_dir() and any(item.name.startswith('.recovery-stage-') for item in directory.iterdir()):
        raise ValueError('recovery incomplete')
    control = directory / "recovery-control.json"
    database = directory / "execution-control.sqlite"
    if control.exists():
        info = control.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 8 * 1024 * 1024:
            raise ValueError("recovery control unavailable")
        if json.loads(control.read_text(encoding="utf-8")).get("body", {}).get("status") != "complete":
            raise ValueError("recovery incomplete")
        if not database.exists():
            raise ValueError("registry missing")
    if not database.exists():
        raise ValueError('registry missing')
    info = database.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("registry unavailable")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=0.75)) as connection:
        row = connection.execute("SELECT value FROM aw_meta WHERE key='recovery_state'").fetchone()
        sticky = connection.execute("SELECT value FROM aw_meta WHERE key='recovery_schema'").fetchone()
        registry = connection.execute("SELECT value FROM aw_meta WHERE key='registry_id'").fetchone()
    if row is None:
        raise ValueError("recovery state missing")
    if sticky is None or sticky[0] != '1':
        raise ValueError('recovery schema missing')
    state = json.loads(row[0])
    if state.get("schemaVersion") != 1 or state.get("state") not in {"normal", "quarantine", "retired"}:
        raise ValueError("recovery state invalid")
    if state["state"] == "retired":
        raise ValueError("source authority retired")
    marker = Path(str(database) + '.required')
    marker_info = marker.lstat()
    if not stat.S_ISREG(marker_info.st_mode) or marker_info.st_nlink != 1 or marker_info.st_size > 1024:
        raise ValueError("registry marker unavailable")
    evidence = json.loads(marker.read_text(encoding='utf-8'))
    if not registry or evidence.get('schema') != 1 or evidence.get('registryId') != registry[0] or evidence.get('dev') != str(info.st_dev) or evidence.get('ino') != str(info.st_ino):
        raise ValueError("registry marker mismatch")
    # Even an old code rollback must preserve the M2 gate. Do not execute
    # business initialization merely to check that the selected core supports it.
    if row is not None or sticky is not None or control.exists():
        env = {"PATH": "/usr/bin:/bin", "HOME": "/", "NODE_ENV": "production"}
        if os.name == 'nt':
            env['SystemRoot'] = os.environ.get('SystemRoot', r'C:\Windows')
        program = "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); if(m.RECOVERY_SCHEMA_VERSION!==1) process.exit(1)"
        result = subprocess.run([str(node), "--input-type=module", "-e", program, str(core_file)], env=env,
                                cwd="/", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
        if result.returncode:
            raise ValueError("selected release cannot enforce recovery")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4 or not all(Path(value).is_absolute() for value in sys.argv[1:]):
            raise ValueError("invalid guard options")
        guard(*sys.argv[1:])
    except Exception:
        print("Recovery guard refused startup; retain the source and recovery records.", file=sys.stderr)
        sys.exit(1)
