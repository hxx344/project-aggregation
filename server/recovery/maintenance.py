# Managed by project-aggregation recovery
"""Opt-in local cold backups. All paths and privileged inputs belong to root."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import time
import urllib.request
import uuid

ROOT = Path('/var/backups/project-aggregation/scheduled')
CONFIG = Path('/etc/project-aggregation-recovery/schedule.json')
PUBLIC = Path('/var/lib/project-aggregation-backup-status/readiness.json')
UNITS = Path('/etc/systemd/system')
TIMER = 'project-aggregation-backup.timer'
SERVICE = 'project-aggregation-backup.service'
NAME = re.compile(r'scheduled-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}')
MANUAL_NAME = re.compile(r'manual-[a-f0-9]{24}')
MAX_RECORDS = 128
PUBLIC_RECORDS = 32
ZONES = {'Asia/Shanghai': timezone(timedelta(hours=8)), 'UTC': timezone.utc}


def stamp(now=None):
    return (now or datetime.now(timezone.utc)).isoformat()


def error_code(error):
    text = str(error)
    return text if re.fullmatch(r'(?:RECOVERY|RUNTIME|UNSAFE_RUNTIME)_[A-Z_]+', text) else 'RECOVERY_MAINTENANCE_FAILED'


def atomic(ops, filename, value, private=True):
    if not private and filename != PUBLIC:
        raise ValueError('RECOVERY_PUBLIC_PATH_INVALID')
    ops.safe_directory(filename.parent, private=private)
    if not private:
        # The timer intentionally keeps UMask=0077. Only this dedicated,
        # already-validated public directory may gain service-user traversal.
        descriptor = os.open(filename.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('RECOVERY_UNSAFE_DESTINATION')
            os.fchmod(descriptor, 0o755)
        finally:
            os.close(descriptor)
    if filename.exists() or filename.is_symlink():
        ops.trusted(filename, private=private)
    temporary = filename.with_name(filename.name + '.tmp-' + uuid.uuid4().hex)
    try:
        with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                               0o600 if private else 0o644), 'w', encoding='utf-8') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            if not private:
                os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(temporary, filename)
        descriptor = os.open(filename.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def read_json(ops, filename, fallback=None):
    if not filename.exists() and not filename.is_symlink():
        return fallback
    source = ops.trusted(filename, private=True)
    if source.stat().st_size > 256 * 1024:
        raise ValueError('RECOVERY_SCHEDULE_STATE_INVALID')
    return json.loads(source.read_text(encoding='utf-8'))


def validate_config(value):
    if not isinstance(value, dict) or value.get('schemaVersion') != 1 or type(value.get('enabled')) is not bool:
        raise ValueError('RECOVERY_SCHEDULE_CONFIG_INVALID')
    if not value['enabled']:
        return {'schemaVersion': 1, 'enabled': False}
    for field in ('start', 'end'):
        if not re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', str(value.get(field, ''))):
            raise ValueError('RECOVERY_SCHEDULE_CONFIG_INVALID')
    if value['start'] == value['end'] or value.get('timezone') not in ZONES or type(value.get('keep')) is not int or not 2 <= value['keep'] <= 30 or type(value.get('minFreeMb')) is not int or not 64 <= value['minFreeMb'] <= 1048576:
        raise ValueError('RECOVERY_SCHEDULE_CONFIG_INVALID')
    if value.get('webhook'):
        from urllib.parse import urlsplit
        parsed = urlsplit(value['webhook'])
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or len(value['webhook']) > 2048:
            raise ValueError('RECOVERY_SCHEDULE_CONFIG_INVALID')
    return {key: value[key] for key in ('schemaVersion', 'enabled', 'start', 'end', 'timezone', 'keep', 'minFreeMb', 'webhook') if key in value}


def window(config, now):
    """Stable start-date identity across midnight; no catch-up outside the window."""
    if not config['enabled']:
        return None
    local = now.astimezone(ZONES[config['timezone']])
    minute = local.hour * 60 + local.minute
    start, end = [int(value[:2]) * 60 + int(value[3:]) for value in (config['start'], config['end'])]
    if start < end:
        if not start <= minute < end:
            return None
    elif not (minute >= start or minute < end):
        return None
    day = local.date() - timedelta(days=1 if start > end and minute < end else 0)
    return f'{config["timezone"]}:{day}:{config["start"]}'


def load_state(ops):
    value = read_json(ops, ROOT / 'state.json', {'schemaVersion': 1, 'runs': []})
    if not isinstance(value, dict) or value.get('schemaVersion') != 1 or not isinstance(value.get('runs'), list) or len(value['runs']) > MAX_RECORDS:
        raise ValueError('RECOVERY_SCHEDULE_STATE_INVALID')
    for run in value['runs']:
        if not isinstance(run, dict) or not (NAME.fullmatch(str(run.get('id', ''))) or MANUAL_NAME.fullmatch(str(run.get('id', '')))) or run.get('status') not in ('running', 'unknown', 'failed', 'complete') or not isinstance(run.get('window'), str):
            raise ValueError('RECOVERY_SCHEDULE_STATE_INVALID')
    return value


def save(ops, state):
    atomic(ops, ROOT / 'state.json', state)


def append_run(state, run):
    while len(state['runs']) >= MAX_RECORDS:
        removable = next((index for index, previous in enumerate(state['runs'])
                          if previous['status'] not in ('running', 'unknown') and
                          (previous['status'] == 'failed' or previous.get('retention') == 'removed' or MANUAL_NAME.fullmatch(previous['id']))), None)
        if removable is None:
            raise ValueError('RECOVERY_SCHEDULE_STATE_CAPACITY')
        state['runs'].pop(removable)
    state['runs'].append(run)


def publish(ops, config, state):
    # Never expose file paths, environment, webhook, raw errors, manifests or keys.
    result = {'schemaVersion': 1, 'observedAt': stamp(), 'schedule': {key: config[key] for key in ('enabled', 'start', 'end', 'timezone', 'keep', 'minFreeMb') if key in config}, 'runs': []}
    result['schedule']['blockedByUnknown'] = any(run['status'] == 'unknown' for run in state['runs'])
    unresolved = [run for run in state['runs'] if run['status'] in ('running', 'unknown')]
    selected = {run['id'] for run in unresolved[:PUBLIC_RECORDS]}
    for run in reversed(state['runs']):
        if len(selected) >= PUBLIC_RECORDS:
            break
        selected.add(run['id'])
    for run in [run for run in state['runs'] if run['id'] in selected]:
        row = {key: run[key] for key in ('id', 'status', 'startedAt', 'completedAt', 'phase', 'error', 'notification', 'retention', 'metadataError') if key in run}
        row['origin'] = 'manual-registration' if MANUAL_NAME.fullmatch(run['id']) else 'scheduled'
        archive = run.get('archive')
        if archive:
            row['archive'] = {key: archive[key] for key in ('checkpointId', 'digest', 'commit', 'completedAt', 'files', 'bytes', 'archiveVerification', 'verifiedAt', 'unresolvedDependencyCount') if key in archive}
        result['runs'].append(row)
    atomic(ops, PUBLIC, result, private=False)


def public_best_effort(ops, config, state):
    try:
        publish(ops, config, state)
        return True
    except (ValueError, OSError):
        # Metadata failures must never reclassify a completed backup or restore.
        return False


def keys(ops):
    return ['--data-key-file', ops.KEYS / 'data.key', '--secrets-key-file', ops.KEYS / 'secrets.key']


def restore_services(ops, deployment, before):
    units = ops.services()
    if set(before) != set(units) or any(value not in ('active', 'inactive', 'failed') for value in before.values()):
        raise ValueError('RECOVERY_SCHEDULE_SERVICE_STATE_UNKNOWN')
    active = [unit for unit in units if before[unit] == 'active']
    if not active:
        return
    current = {unit: ops.service_state(unit).get('ActiveState') for unit in units}
    if all(current[unit] == ('active' if before[unit] == 'active' else current[unit]) and
           (before[unit] == 'active' or current[unit] in ('inactive', 'failed')) for unit in units):
        return
    ops.require_stopped()
    source = ops.run_cli(deployment, 'check-source', '--data-dir', deployment['source'], '--owner-uid', deployment['uid'])
    if source.get('state') == 'retired':
        raise ValueError('RECOVERY_SOURCE_RETIRED')
    if source.get('state') not in ('normal', 'quarantine'):
        raise ValueError('RECOVERY_SCHEDULE_SERVICE_STATE_UNKNOWN')
    ops.install_guard(deployment)
    ops.systemctl('start', *active, timeout=180)
    # Runtime Wants= can start an API which was inactive before this operation.
    extras = [unit for unit in units if unit not in active and ops.service_state(unit).get('ActiveState') not in ('inactive', 'failed')]
    if extras:
        ops.systemctl('stop', *extras, timeout=260)
    if any((ops.service_state(unit).get('ActiveState') == 'active') != (unit in active) for unit in units):
        raise ValueError('RECOVERY_SCHEDULE_SERVICE_RESTORE_FAILED')


def cold_backup(ops, deployment, destination, before_stop, run):
    units = ops.services()
    states = {unit: ops.service_state(unit) for unit in units}
    before = {unit: state.get('ActiveState') for unit, state in states.items()}
    if any(value not in ('active', 'inactive', 'failed') for value in before.values()):
        raise ValueError('RECOVERY_SCHEDULE_SERVICE_STATE_UNKNOWN')
    ops.install_guard(deployment)
    run['before'] = before
    before_stop()  # Persist claim and check window immediately before the stop.
    try:
        if any(value == 'active' for value in before.values()):
            ops.systemctl('stop', *units, timeout=260)
        ops.require_stopped({unit: state.get('ControlGroup', '') for unit, state in states.items()})
        source = ops.run_cli(deployment, 'check-source', '--data-dir', deployment['source'], '--owner-uid', deployment['uid'])
        if source.get('state') == 'retired':
            raise ValueError('RECOVERY_SOURCE_RETIRED')
        ops.run_cli(deployment, 'backup', '--data-dir', deployment['source'], '--owner-uid', deployment['uid'],
                    '--destination', destination, '--environment-file', ops.ENVIRONMENT, *keys(ops))
        ops.require_stopped()
    finally:
        restore_services(ops, deployment, before)
        run['servicesRecovered'] = True


def verify(ops, deployment, directory, timeout_seconds=600):
    return ops.run_cli(deployment, 'verify-archive', '--backup-dir', directory, '--timeout-ms',
                       max(1, int(timeout_seconds * 1000)), *keys(ops), timeout=min(630, timeout_seconds + 5))


def checked_tree(ops, directory):
    if not directory.is_absolute() or directory.parent != ROOT or not NAME.fullmatch(directory.name) or directory.resolve() != directory:
        raise ValueError('RECOVERY_RETENTION_UNSAFE_PATH')
    ops.safe_directory(directory)
    for item in directory.rglob('*'):
        info = item.lstat()
        if stat.S_ISDIR(info.st_mode):
            ops.safe_directory(item)
        else:
            ops.trusted(item, private=True)


def retain(ops, deployment, config, state):
    candidates = []
    deadline = time.monotonic() + 600
    for run in state['runs']:
        if not NAME.fullmatch(run['id']) or run['status'] != 'complete' or not run.get('archive') or run.get('retention') == 'removed':
            continue
        directory = ROOT / run['id']
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('RECOVERY_RETENTION_TIMEOUT')
        checked_tree(ops, directory)
        marker = read_json(ops, directory / '.schedule.json')
        if marker != {'schemaVersion': 1, 'id': run['id'], 'digest': run['archive']['digest']}:
            raise ValueError('RECOVERY_RETENTION_IDENTITY_MISMATCH')
        archive = verify(ops, deployment, directory, max(0.001, deadline - time.monotonic()))
        if archive['digest'] != run['archive']['digest'] or archive['checkpointId'] != run['archive']['checkpointId']:
            raise ValueError('RECOVERY_RETENTION_IDENTITY_MISMATCH')
        candidates.append((run, directory))
    # The newest keep >= 2 verified packages survive, including the current run.
    for run, directory in candidates[:-config['keep']]:
        if time.monotonic() >= deadline:
            raise ValueError('RECOVERY_RETENTION_TIMEOUT')
        checked_tree(ops, directory)
        run['retention'] = 'deleting'
        save(ops, state)
        try:
            shutil.rmtree(directory)
        except OSError:
            run['retention'] = 'delete-failed'
            save(ops, state)
            raise ValueError('RECOVERY_RETENTION_DELETE_FAILED') from None
        run['retention'] = 'removed'
        save(ops, state)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def notify(ops, config, state, run):
    if not config.get('webhook') or run.get('notification'):
        return
    # Once claimed, timeout/crash is unknown, never eligible for automatic resend.
    run['notification'] = 'unknown'
    save(ops, state)
    body = json.dumps({'event': 'backup-maintenance-failed', 'backupId': run['id'], 'phase': run['phase'], 'error': run['error']}).encode()
    request = urllib.request.Request(config['webhook'], data=body, headers={'Content-Type': 'application/json'}, method='POST')
    previous_handler = None
    if hasattr(signal, 'SIGALRM'):
        def expired(_signum, _frame):
            raise TimeoutError('notification deadline')
        previous_handler = signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, 8)
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=8) as response:
            run['notification'] = 'acknowledged' if 200 <= response.status < 300 else 'failed'
    except Exception:
        pass
    finally:
        if previous_handler is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
    save(ops, state)


def run_locked(ops, now=lambda: datetime.now(timezone.utc)):
    config = validate_config(read_json(ops, CONFIG, {'schemaVersion': 1, 'enabled': False}))
    if not config['enabled']:
        return {'enabled': False, 'status': 'disabled'}
    ops.safe_directory(ROOT)
    state = load_state(ops)
    deployment = ops.deployment()
    for previous in state['runs']:
        if previous['status'] == 'running':
            previous.update(status='unknown', phase='interrupted', error='RECOVERY_SCHEDULE_INTERRUPTED')
            save(ops, state)
        if previous['status'] == 'unknown':
            if previous.get('before') and not previous.get('servicesRecovered'):
                try:
                    restore_services(ops, deployment, previous['before'])
                    previous['servicesRecovered'] = True
                except Exception as error:
                    previous['recoveryError'] = error_code(error)
                save(ops, state)
            notify(ops, config, state, previous)
    current = window(config, now())
    if not current or any(item['window'] == current for item in state['runs']):
        public_best_effort(ops, config, state)
        return {'enabled': True, 'status': 'outside-window' if not current else 'already-claimed'}
    if any(item['status'] == 'unknown' for item in state['runs']):
        public_best_effort(ops, config, state)
        return {'enabled': True, 'status': 'unknown-requires-review'}
    run = {'id': 'scheduled-' + now().astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12],
           'window': current, 'startedAt': stamp(now()), 'status': 'running', 'phase': 'preflight'}
    append_run(state, run)
    save(ops, state)
    try:
        ops.safe_directory(ops.KEYS)
        if not all((ops.KEYS / name).is_file() for name in ('data.key', 'secrets.key')):
            raise ValueError('RECOVERY_KEYS_MISSING')
        if shutil.disk_usage(ROOT).free < config['minFreeMb'] * 1024 ** 2:
            raise ValueError('RECOVERY_SPACE_INSUFFICIENT')
        def before_stop():
            run['phase'] = 'cold-backup'
            save(ops, state)
            if window(config, now()) != current:
                raise ValueError('RECOVERY_SCHEDULE_WINDOW_CLOSED')
        directory = ROOT / run['id']
        cold_backup(ops, deployment, directory, before_stop, run)
        run['phase'] = 'archive-verification'
        save(ops, state)
        run['archive'] = verify(ops, deployment, directory)
        atomic(ops, directory / '.schedule.json', {'schemaVersion': 1, 'id': run['id'], 'digest': run['archive']['digest']})
        run.update(status='complete', completedAt=stamp(now()), phase='retention')
        save(ops, state)
        retain(ops, deployment, config, state)
        run['phase'] = 'complete'
    except Exception as error:
        # A retention failure does not erase evidence of a completed archive.
        if run['status'] != 'complete':
            run['status'] = 'unknown' if run.get('before') and not run.get('servicesRecovered') else 'failed'
        run['error'] = error_code(error)
        run['completedAt'] = stamp(now())
        save(ops, state)
        notify(ops, config, state, run)
    save(ops, state)
    metadata = public_best_effort(ops, config, state)
    return {'enabled': True, 'id': run['id'], 'status': run['status'], 'phase': run['phase'], 'metadataPublished': metadata, **({'error': run['error']} if run.get('error') else {})}


def configure(ops, args):
    value = {'schemaVersion': 1, 'enabled': not args.disable, 'start': args.window_start, 'end': args.window_end,
             'timezone': args.timezone, 'keep': args.keep, 'minFreeMb': args.min_free_mb}
    previous = read_json(ops, CONFIG, {})
    if args.webhook_file:
        source = ops.trusted(args.webhook_file, private=True)
        if source.stat().st_size > 2048:
            raise ValueError('RECOVERY_SCHEDULE_CONFIG_INVALID')
        value['webhook'] = source.read_text(encoding='utf-8').strip()
    elif previous.get('webhook'):
        value['webhook'] = previous['webhook']
    config = validate_config(value)
    # No real cold operation is part of configuration; keys are generated once.
    deployment = ops.deployment()
    ops.safe_directory(ops.KEYS)
    if config['enabled']:
        ops.run_cli(deployment, 'keys', *keys(ops))
    ops.safe_directory(ROOT)
    state = load_state(ops)
    service = ('# Managed by project-aggregation recovery\n[Unit]\nDescription=Workbench local cold backup\n'
               '[Service]\nType=oneshot\nUMask=0077\n'
               f'ExecStart=/usr/bin/python3 -I {ops.APP}/current/server/recovery/operations.py schedule-run\n'
               'TimeoutStartSec=infinity\nKillMode=control-group\n')
    timer = ('# Managed by project-aggregation recovery\n[Unit]\nDescription=Workbench backup window check\n'
             f'[Timer]\nOnCalendar=*-*-* *:*:00\nAccuracySec=1s\nPersistent=false\nUnit={SERVICE}\n'
             '[Install]\nWantedBy=timers.target\n')
    ops.safe_directory(UNITS, private=False)
    unchanged = previous == config
    for name, content in ((SERVICE, service), (TIMER, timer)):
        filename = UNITS / name
        if filename.exists() or filename.is_symlink():
            existing = ops.trusted(filename).read_text(encoding='utf-8')
            if not existing.startswith('# Managed by project-aggregation recovery\n'):
                raise ValueError('RECOVERY_UNMANAGED_SERVICE')
            unchanged = unchanged and existing == content
        else:
            unchanged = False
        # The timer is stopped before activating new configuration.
    if unchanged:
        loaded = ops.systemctl('show', TIMER, '--property=ActiveState,UnitFileState,NeedDaemonReload')
        fields = dict(line.split('=', 1) for line in loaded.splitlines() if '=' in line)
        expected_active, expected_enabled = ('active', 'enabled') if config['enabled'] else ('inactive', 'disabled')
        if fields.get('ActiveState') == expected_active and fields.get('UnitFileState') == expected_enabled and fields.get('NeedDaemonReload') == 'no':
            return {'enabled': config['enabled'], 'unchanged': True, 'metadataPublished': public_best_effort(ops, config, state)}
    if (UNITS / TIMER).exists():
        ops.systemctl('disable', '--now', TIMER, timeout=30)
    atomic(ops, CONFIG, {'schemaVersion': 1, 'enabled': False})
    for name, content in ((SERVICE, service), (TIMER, timer)):
        filename = UNITS / name
        temporary = filename.with_name(name + '.tmp-' + uuid.uuid4().hex)
        try:
            with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644), 'w', encoding='utf-8') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, filename)
        finally:
            temporary.unlink(missing_ok=True)
    ops.systemctl('daemon-reload', timeout=120)
    atomic(ops, CONFIG, config)
    if config['enabled']:
        try:
            ops.systemctl('enable', '--now', TIMER, timeout=30)
        except Exception:
            atomic(ops, CONFIG, {'schemaVersion': 1, 'enabled': False})
            public_best_effort(ops, {'schemaVersion': 1, 'enabled': False}, state)
            raise
    return {'enabled': config['enabled'], 'metadataPublished': public_best_effort(ops, config, state)}


def main(ops, arguments):
    parser = argparse.ArgumentParser(description='Root-only local backup schedule; daily windows, no missed-window catch-up.')
    parser.add_argument('action', choices=['schedule-configure', 'schedule-run', 'schedule-status', 'schedule-resolve', 'backup-register'])
    parser.add_argument('--run-id')
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--disable', action='store_true')
    parser.add_argument('--window-start')
    parser.add_argument('--window-end')
    parser.add_argument('--timezone', choices=list(ZONES), default='Asia/Shanghai')
    parser.add_argument('--keep', type=int, default=7)
    parser.add_argument('--min-free-mb', type=int, default=1024)
    parser.add_argument('--webhook-file', type=Path)
    args = parser.parse_args(arguments)
    with ops.exclusive(ops.STACK_LOCK), ops.exclusive(ops.INSTALL_LOCK):
        if args.action == 'backup-register':
            directory = args.backup_dir
            if not directory or not directory.is_absolute() or not directory.is_dir():
                raise ValueError('RECOVERY_ABSOLUTE_PATH_REQUIRED')
            # An explicit root CLI argument authorizes this one read. Neither
            # the application nor public metadata can supply a private path.
            ops.trusted(directory / 'manifest.json', private=True)
            deployment = ops.deployment()
            archive = verify(ops, deployment, directory)
            state = load_state(ops)
            identity = 'manual-' + archive['digest'][:24]
            state['runs'] = [item for item in state['runs'] if item['id'] != identity]
            append_run(state, {'id': identity, 'window': 'manual', 'status': 'complete', 'phase': 'complete',
                               'startedAt': archive['completedAt'], 'completedAt': archive['completedAt'], 'archive': archive})
            save(ops, state)
            config = validate_config(read_json(ops, CONFIG, {'schemaVersion': 1, 'enabled': False}))
            return {'id': identity, 'digest': archive['digest'], 'archiveVerification': archive['archiveVerification'], 'metadataPublished': public_best_effort(ops, config, state)}
        if args.action == 'schedule-configure':
            return configure(ops, args)
        if args.action == 'schedule-status':
            config = validate_config(read_json(ops, CONFIG, {'schemaVersion': 1, 'enabled': False}))
            return {'enabled': config['enabled'], 'runs': [{key: run[key] for key in ('id', 'status', 'phase', 'error') if key in run} for run in load_state(ops)['runs']]}
        if args.action == 'schedule-resolve':
            # Explicit root reconciliation never retries a cold backup. It only
            # checks existing material and restores the recorded service set.
            state = load_state(ops)
            run = next((item for item in state['runs'] if item['id'] == args.run_id), None)
            if not run or run['status'] not in ('unknown', 'running'):
                raise ValueError('RECOVERY_SCHEDULE_RUN_NOT_UNKNOWN')
            deployment = ops.deployment()
            if run.get('before'):
                restore_services(ops, deployment, run['before'])
                run['servicesRecovered'] = True
            directory = ROOT / run['id']
            if directory.exists() or directory.is_symlink():
                checked_tree(ops, directory)
                run['archive'] = verify(ops, deployment, directory)
                atomic(ops, directory / '.schedule.json', {'schemaVersion': 1, 'id': run['id'], 'digest': run['archive']['digest']})
                run.update(status='complete', phase='complete', completedAt=stamp())
            else:
                run.update(status='failed', phase='interrupted', completedAt=stamp())
            save(ops, state)
            config = validate_config(read_json(ops, CONFIG, {'schemaVersion': 1, 'enabled': False}))
            return {'id': run['id'], 'status': run['status'], 'metadataPublished': public_best_effort(ops, config, state)}
        return run_locked(ops)
