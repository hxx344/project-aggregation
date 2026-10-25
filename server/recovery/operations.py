# Managed by project-aggregation recovery
"""Root operator entry: serialize updates, stop the cgroup, then run cold recovery."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import uuid

APP = Path('/opt/project-aggregation')
ENVIRONMENT = Path('/etc/project-aggregation.env')
UNIT_FILE = Path('/etc/systemd/system/project-aggregation.service')
SERVICE = 'project-aggregation.service'
# The runtime unit pulls in the API unit; both hold writers of the data directory.
API_UNIT_FILE = Path('/etc/systemd/system/project-aggregation-api.service')
API_SERVICE = 'project-aggregation-api.service'
SERVICES = (SERVICE, API_SERVICE)
KEYS = Path('/etc/project-aggregation-recovery')
STACK_LOCK = Path('/run/lock/project-aggregation-stack.lock')
INSTALL_LOCK = Path('/run/lock/project-aggregation-install.lock')
CLEAN_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/', 'LANG': 'C.UTF-8', 'NODE_ENV': 'production'}


def trusted(filename, private=False):
    target = Path(filename)
    if not target.is_absolute():
        raise ValueError('RECOVERY_UNSAFE_PATH')
    for candidate in [*reversed(target.parents), target]:
        info = candidate.lstat()
        shared_sticky_parent = candidate != target and stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 and not shared_sticky_parent:
            raise ValueError('RECOVERY_UNTRUSTED_INPUT')
    info = target.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or private and info.st_mode & 0o077:
        raise ValueError('RECOVERY_UNTRUSTED_INPUT')
    return target


def environment_values(content):
    result = {}
    for line in content.splitlines():
        match = re.fullmatch(r'\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*', line)
        if match:
            parts = shlex.split(match[2], comments=True)
            if len(parts) > 1:
                raise ValueError('RECOVERY_ENVIRONMENT_INVALID')
            result[match[1]] = parts[0] if parts else ''
    return result


def trusted_environment():
    trusted(ENVIRONMENT)
    # The installer creates root:service-group 0640. Group read is intentional;
    # writes/execution or any access by other users are still forbidden.
    if ENVIRONMENT.stat().st_mode & 0o037:
        raise ValueError('RECOVERY_UNTRUSTED_INPUT')
    return ENVIRONMENT


def managed_unit(filename, entry):
    """The service user and Node executable of an installer-written unit running `entry`."""
    unit = trusted(filename).read_text(encoding='utf-8')
    if not unit.startswith('# Managed by project-aggregation installer\n'):
        raise ValueError('RECOVERY_UNMANAGED_SERVICE')
    user = re.search(r'^User=([A-Za-z_][A-Za-z0-9_-]*)$', unit, re.M)
    command = re.search(r'^ExecStart=(/[^\s]+) ' + re.escape(str(APP / 'current/server' / entry)) + r'$', unit, re.M)
    if not user or not command:
        raise ValueError('RECOVERY_SERVICE_CONFIG_INVALID')
    return user[1], command[1]


def deployment():
    import pwd
    trusted_environment()
    user, command = managed_unit(UNIT_FILE, 'runtime/main.mjs')
    if managed_unit(API_UNIT_FILE, 'api/main.mjs') != (user, command):
        raise ValueError('RECOVERY_SERVICE_CONFIG_INVALID')
    account = pwd.getpwnam(user)
    node = trusted(command)
    current_link = APP / 'current'
    if not current_link.is_symlink() or current_link.lstat().st_uid != 0:
        raise ValueError('RECOVERY_RELEASE_INVALID')
    release = current_link.resolve(strict=True)
    if not release.is_relative_to(APP / 'releases'):
        raise ValueError('RECOVERY_RELEASE_INVALID')
    trusted(release / 'server/recovery/cli.mjs')
    values = environment_values(ENVIRONMENT.read_text(encoding='utf-8'))
    source = Path(values.get('DATA_DIR', '/var/lib/project-aggregation'))
    if not source.is_absolute() or '..' in source.parts or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(source)):
        raise ValueError('RECOVERY_DATA_PATH_INVALID')
    return {'node': node, 'release': release, 'source': source, 'uid': account.pw_uid, 'gid': account.pw_gid,
            'groups': os.getgrouplist(account.pw_name, account.pw_gid)}


def systemctl(*arguments, timeout=15):
    return subprocess.run(['/usr/bin/systemctl', *arguments], env=CLEAN_ENV, capture_output=True,
                          text=True, timeout=timeout, check=True).stdout.strip()


def guard_dropin(guard, node):
    """The startup guard drop-in of both units; registry.recovery_guard() accepts exactly this."""
    return ('# Managed by project-aggregation recovery\n[Service]\n'
            f'ExecStartPre=/usr/bin/python3 -I {guard} ${{DATA_DIR}} '
            f'{APP}/current/server/execution/account-writer.mjs {node}\n').encode()


def dropin_state(unit):
    """The drop-ins systemd loaded for unit and whether its files changed since."""
    fields = systemctl('show', unit, '--property=DropInPaths,NeedDaemonReload')
    fields = dict(line.split('=', 1) for line in fields.splitlines() if '=' in line)
    return fields.get('DropInPaths', '').split(), fields.get('NeedDaemonReload') == 'yes'


def install_guard(config, *, library=Path('/usr/local/lib/project-aggregation-recovery'),
                  units=Path('/etc/systemd/system'),
                  launcher=Path('/usr/local/bin/project-aggregation-recovery')):
    guard = library / 'startup-guard.py'
    safe_directory(library, private=False)
    # Both units start code that opens the data directory, so both carry the guard.
    dropins = {unit: units / (unit + '.d') for unit in SERVICES}
    for directory in dropins.values():
        directory.mkdir(mode=0o755, exist_ok=True)
        for candidate in [directory, *directory.parents]:
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('RECOVERY_UNTRUSTED_INPUT')

    def managed(filename):
        previous = trusted(filename).read_bytes()
        if b'# Managed by project-aggregation recovery' not in previous.splitlines()[:2]:
            raise ValueError('RECOVERY_UNMANAGED_GUARD')
        return previous

    def update(filename, content, mode):
        if filename.exists() and managed(filename) == content:
            return False
        temporary = filename.with_name(filename.name + '.tmp-' + uuid.uuid4().hex)
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, filename)
        finally:
            temporary.unlink(missing_ok=True)
        return True

    source = config['release'] / 'server/recovery/startup-guard.py'
    update(guard, trusted(source).read_bytes(), 0o644)
    # Kept outside the release link so a failed update cannot remove this gate.
    content = guard_dropin(guard, config['node'])
    # Every unit is checked, loaded and on disk, before either drop-in is written.
    current = []
    for unit, directory in dropins.items():
        dropin = directory / '20-recovery-guard.conf'
        existing, stale = dropin_state(unit)
        if any(Path(value) != dropin for value in existing) or any(path != dropin for path in directory.glob('*.conf')):
            raise ValueError('RECOVERY_UNSUPPORTED_SERVICE_OVERRIDE')
        if dropin.exists() or dropin.is_symlink():
            managed(dropin)
        current.append(str(dropin) in existing and not stale)
    changed = [update(directory / '20-recovery-guard.conf', content, 0o644) for directory in dropins.values()]
    # A guard written by an earlier run whose reload failed, new or changed, is loaded now.
    if any(changed) or not all(current):
        systemctl('daemon-reload')
        # The reload also loads drop-ins from shared directories such as service.d.
        if any(dropin_state(unit)[0] != [str(directory / '20-recovery-guard.conf')] for unit, directory in dropins.items()):
            raise ValueError('RECOVERY_UNSUPPORTED_SERVICE_OVERRIDE')
    launcher_body = ('# Managed by project-aggregation recovery\n#!/bin/sh\n'
                     f'exec /usr/bin/python3 -I {APP}/current/server/recovery/operations.py "$@"\n').encode()
    # A shell script needs its shebang first; retain the ownership marker next.
    launcher_body = launcher_body.replace(b'# Managed by project-aggregation recovery\n#!/bin/sh\n', b'#!/bin/sh\n# Managed by project-aggregation recovery\n')
    update(launcher, launcher_body, 0o755)
    os.chmod(launcher, 0o755)


def service_state(unit):
    fields = systemctl('show', unit, '--property=ActiveState,MainPID,ControlGroup')
    return dict(line.split('=', 1) for line in fields.splitlines() if '=' in line)


def require_stopped(previous_groups=None):
    """Every unit is stopped and its cgroup, also the one seen before stopping, is empty."""
    states = {}
    for unit in SERVICES:
        state = states[unit] = service_state(unit)
        if state.get('ActiveState') not in {'inactive', 'failed'} or state.get('MainPID') != '0':
            raise ValueError('RECOVERY_WRITERS_STILL_RUNNING')
        group = state.get('ControlGroup') or (previous_groups or {}).get(unit, '')
        if group:
            if not group.startswith('/') or '..' in Path(group).parts:
                raise ValueError('RECOVERY_CGROUP_INVALID')
            group_dir = Path('/sys/fs/cgroup') / group.lstrip('/')
            if group_dir.exists():
                events = group_dir / 'cgroup.events'
                if not events.is_file() or not re.search(r'^populated 0$', events.read_text(), re.M):
                    raise ValueError('RECOVERY_WRITERS_STILL_RUNNING')
    return states


@contextmanager
def exclusive(filename):
    import fcntl
    descriptor = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        trusted(filename)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def run_cli(config, action, *arguments, timeout=630):
    result = subprocess.run([str(config['node']), str(config['release'] / 'server/recovery/cli.mjs'), action, *map(str, arguments)],
                            cwd='/', env=CLEAN_ENV, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        try:
            error = json.loads(result.stderr.strip().splitlines()[-1]).get('error')
        except (ValueError, IndexError):
            error = None
        raise ValueError(error if isinstance(error, str) and re.fullmatch(r'[A-Z_]+', error) else 'RECOVERY_COMMAND_FAILED')
    return json.loads(result.stdout)


def safe_directory(directory, private=True):
    directory.mkdir(mode=0o700 if private else 0o755, parents=True, exist_ok=True)
    for candidate in [directory, *directory.parents]:
        info = candidate.lstat()
        shared_sticky_parent = candidate != directory and stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 and not shared_sticky_parent:
            raise ValueError('RECOVERY_UNSAFE_DESTINATION')
    if private and directory.stat().st_mode & 0o077:
        raise ValueError('RECOVERY_UNSAFE_DESTINATION')


def chown_restored(directory, uid, gid):
    # The target is a newly created, isolated tree. Check every entry before
    # changing ownership; neither links nor special files can authorize traversal.
    paths = [directory, *directory.rglob('*')]
    for candidate in paths:
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) or stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise ValueError('RECOVERY_UNSAFE_RESTORED_TREE')
    for candidate in paths:
        os.chown(candidate, uid, gid, follow_symlinks=False)
        os.chmod(candidate, 0o700 if candidate.is_dir() else 0o600)


def require_service_parent(directory, config):
    # Check actual access with the service identity, including POSIX ACLs. Never
    # make an existing private parent such as /root globally traversable.
    program = 'import os,sys; from pathlib import Path; p=Path(sys.argv[1]); sys.exit(0 if all(os.access(x,os.X_OK) for x in [p,*p.parents]) else 1)'
    result = subprocess.run(['/usr/bin/python3', '-I', '-c', program, str(directory)], cwd='/', env=CLEAN_ENV,
                            user=config['uid'], group=config['gid'], extra_groups=config.get('groups', [config['gid']]),
                            timeout=5, capture_output=True, check=False)
    if result.returncode:
        raise ValueError('RECOVERY_TARGET_PARENT_INACCESSIBLE')


def main(arguments=None):
    parser = argparse.ArgumentParser(description='Cold encrypted backups and isolated recovery; no automatic production data replacement.')
    parser.add_argument('action', choices=['keys', 'backup', 'handoff', 'restore', 'admit', 'inspect'])
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--target-dir', type=Path)
    values = parser.parse_args(arguments)
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('RECOVERY_REQUIRES_LINUX_ROOT')
    with exclusive(STACK_LOCK), exclusive(INSTALL_LOCK):
        return _main_locked(values)


def _main_locked(values):
    config = deployment()
    safe_directory(KEYS)
    key_arguments = ['--data-key-file', KEYS / 'data.key', '--secrets-key-file', KEYS / 'secrets.key']
    if values.action == 'keys':
        return run_cli(config, 'keys', *key_arguments)
    if values.action == 'inspect':
        return run_cli(config, 'inspect', '--data-dir', values.target_dir or config['source'])
    if values.action in {'backup', 'handoff'}:
        run_cli(config, 'keys', *key_arguments)
    elif not all((KEYS / name).is_file() for name in ('data.key', 'secrets.key')):
        raise ValueError('RECOVERY_KEYS_MISSING')
    before = {unit: service_state(unit) for unit in SERVICES}
    groups = {unit: state.get('ControlGroup', '') for unit, state in before.items()}
    was_running = any(state.get('ActiveState') in {'active', 'activating', 'reloading'} for state in before.values())
    # Both units explicitly: PartOf= alone would leave an API started on its own.
    if was_running:
        # The API stops first (TimeoutStopSec=75), then the runtime (TimeoutStopSec=150).
        systemctl('stop', *SERVICES, timeout=260)
    require_stopped(groups)
    try:
        if values.action != 'restore':
            run_cli(config, 'check-source', '--data-dir', config['source'], '--owner-uid', config['uid'])
        install_guard(config)
        if values.action in {'backup', 'handoff'}:
            destination = values.destination
            pending = KEYS / 'pending-handoff.json'
            if values.action == 'handoff' and destination is None and pending.exists():
                saved = json.loads(trusted(pending, private=True).read_text(encoding='utf-8'))
                if saved.get('schemaVersion') != 1 or saved.get('source') != str(config['source']):
                    raise ValueError('RECOVERY_PENDING_HANDOFF_SOURCE_MISMATCH')
                destination = Path(saved['destination'])
            if destination is None:
                root = Path('/var/backups/project-aggregation')
                safe_directory(root)
                stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
                destination = root / (stamp + '-' + uuid.uuid4().hex[:12])
            if not destination.is_absolute():
                raise ValueError('RECOVERY_ABSOLUTE_PATH_REQUIRED')
            safe_directory(destination.parent)
            if values.action == 'handoff':
                temporary = pending.with_name(pending.name + '.tmp-' + uuid.uuid4().hex)
                with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600), 'w', encoding='utf-8') as stream:
                    json.dump({'schemaVersion': 1, 'source': str(config['source']), 'destination': str(destination)}, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, pending)
            result = run_cli(config, values.action, '--data-dir', config['source'], '--owner-uid', config['uid'],
                             '--destination', destination, '--environment-file', ENVIRONMENT, *key_arguments)
            if values.action == 'handoff':
                pending.unlink()
        elif values.action == 'restore':
            target = values.target_dir
            if not target or not target.is_absolute() or not values.backup_dir or not values.backup_dir.is_absolute():
                raise ValueError('RECOVERY_OPTIONS_INVALID')
            if target.exists() or target == config['source'] or target.is_relative_to(config['source']) or config['source'].is_relative_to(target):
                raise ValueError('RECOVERY_TARGET_EXISTS_OR_OVERLAP')
            safe_directory(target.parent, private=False)
            require_service_parent(target.parent, config)
            result = run_cli(config, 'restore', '--backup-dir', values.backup_dir, '--target-dir', target, *key_arguments)
            chown_restored(target, config['uid'], config['gid'])
        else:
            target = values.target_dir
            if not target or not target.is_absolute():
                raise ValueError('RECOVERY_OPTIONS_INVALID')
            result = run_cli(config, 'admit', '--data-dir', config['source'], '--target-dir', target,
                             '--owner-uid', config['uid'], '--target-owner-uid', config['uid'], '--environment-file', ENVIRONMENT, *key_arguments)
        require_stopped(groups)
        return result
    finally:
        # A handoff can retire the source before a disk failure is reported.
        # Never restart it based solely on the requested command's name.
        if was_running:
            try:
                current = run_cli(config, 'check-source', '--data-dir', config['source'], '--owner-uid', config['uid'])
            except (ValueError, OSError, subprocess.SubprocessError):
                if values.action != 'restore':
                    raise
                # Disaster restore needs only the checkpoint and its keys.
                # An unreadable original authority stays stopped.
            else:
                # Either unit running counts as running; the runtime unit starts the API unit (Wants=).
                if current['state'] != 'retired':
                    systemctl('start', SERVICE, timeout=180)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), separators=(',', ':')))
    except Exception as error:
        code = str(error)
        print(json.dumps({'error': code if re.fullmatch(r'(?:RECOVERY|RUNTIME|UNSAFE_RUNTIME)_[A-Z_]+', code) else 'RECOVERY_OPERATOR_FAILED'}), file=sys.stderr)
        sys.exit(1)
