"""Transactional, copy-only migration from the retired standalone services.

The journal is root-owned outside application data. Sources are never modified.
Rollback quarantines only directories this transaction created, so a retry copies
the latest standalone data after its service has stopped again.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import shutil
import subprocess
import time

SERVICES = ('market-spread-monitor', 'asset-ledger', 'gate-crossex-arbitrage',
            'greeks', 'aster-desk', 'variational-grid')
LEGACY = {
    'monitor': ('/etc/market-spread-monitor.env', 'ALERT_DATA_DIR', '/var/lib/market-spread-monitor'),
    'asset': ('/etc/asset-ledger.env', 'ASSET_DATA_DIR', '/var/lib/asset-ledger'),
    'crossex': ('/etc/gate-crossex-arbitrage.env', 'DATA_DIR', '/var/lib/gate-crossex-arbitrage'),
    'greeks': ('/etc/greeks/greeks.env', 'STATE_FILE', '/var/lib/greeks/engine_state.json'),
}


def read_env(path):
    values = {}
    if not path.exists():
        return values
    if path.is_symlink() or not path.is_file():
        raise ValueError('Environment file must be a regular file: ' + str(path))
    for line in path.read_text(encoding='utf-8').splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        key, separator, value = stripped.removeprefix('export ').partition('=')
        key = key.strip()
        if not separator or not key.replace('_', '').isalnum():
            raise ValueError('Unsupported environment syntax: ' + str(path))
        # Parse quotes without evaluating shell substitutions or executing code.
        parsed = shlex.split(value, comments=False, posix=True)
        values[key] = parsed[0] if len(parsed) == 1 else value
    return values


def no_links(path, recursive=True):
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError('Migration path cannot contain links: ' + str(path))
    if recursive and path.exists():
        for entry in path.rglob('*') if path.is_dir() else (path,):
            if entry.is_symlink() or not (entry.is_file() or entry.is_dir()):
                raise ValueError('Migration refuses links and special files: ' + str(entry))


class Migration:
    def __init__(self, data, journal, uid=None, gid=None, filesystem=Path('/'), systemctl=None):
        self.data, self.journal = Path(data), Path(journal)
        self.uid, self.gid, self.filesystem = uid, gid, Path(filesystem)
        self.control = systemctl or self.systemctl

    @staticmethod
    def systemctl(*args, check=True):
        result = subprocess.run(['/usr/bin/systemctl', *args], text=True, capture_output=True, check=False)
        if check and result.returncode:
            raise RuntimeError('systemctl operation failed: ' + ' '.join(args))
        return result.stdout.strip()

    def path(self, absolute):
        candidate = PurePosixPath(absolute)
        if not candidate.is_absolute() or '..' in candidate.parts:
            raise ValueError('Legacy data path must be absolute')
        return self.filesystem / str(candidate).lstrip('/')

    def save(self, value):
        temporary = self.journal.with_suffix('.new')
        temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
        temporary.chmod(0o600)
        temporary.replace(self.journal)

    def load(self):
        no_links(self.journal)
        return json.loads(self.journal.read_text(encoding='utf-8')) if self.journal.exists() else None

    def ownership(self, directory):
        for path in (directory, *directory.rglob('*')):
            path.chmod(0o700 if path.is_dir() else 0o600)
            if self.uid is not None and hasattr(os, 'chown'):
                os.chown(path, self.uid, self.gid)

    def begin(self):
        no_links(self.data, recursive=False)
        state = self.load()
        if state and state['status'] == 'committed':
            return False
        if state and state['status'] == 'pending':
            raise ValueError('An interrupted migration exists; recover it before retrying')
        modules = self.data / 'modules'
        modules.mkdir(mode=0o700, exist_ok=True)
        no_links(modules, recursive=False)
        if self.uid is not None and hasattr(os, 'chown'):
            os.chown(modules, self.uid, self.gid)
        state = {'status': 'pending', 'services': {}, 'created': [], 'data': str(self.data)}
        for service in SERVICES:
            if self.control('show', service, '--property=LoadState', '--value', check=False) != 'not-found':
                state['services'][service] = {
                    'active': self.control('is-active', service, check=False) in ('active', 'activating', 'reloading'),
                    'enabled': self.control('is-enabled', service, check=False),
                }
        self.save(state)
        # Stop all old writers before inspecting or copying any database/WAL/key.
        for service in state['services']:
            self.control('stop', service)
            if self.control('is-active', service, check=False) in ('active', 'activating', 'deactivating', 'reloading'):
                raise RuntimeError('Legacy service did not stop: ' + service)
            if state['services'][service]['enabled'] in ('enabled', 'enabled-runtime'):
                self.control('disable', *(['--runtime'] if state['services'][service]['enabled'] == 'enabled-runtime' else []), service)
        for module, (environment, variable, default) in LEGACY.items():
            target = modules / module
            if target.exists():
                continue  # Existing embedded-module data always wins.
            env_path = self.path(environment)
            values = read_env(env_path)
            # Asset's original installer stores its override in the service unit.
            if module == 'asset':
                unit = self.path('/etc/systemd/system/asset-ledger.service')
                if unit.is_file() and not unit.is_symlink():
                    for line in unit.read_text(encoding='utf-8').splitlines():
                        if line.startswith('Environment='):
                            for assignment in shlex.split(line.partition('=')[2]):
                                key, _, value = assignment.partition('=')
                                values[key] = value
            old_path = self.path(values.get(variable) or default)
            source = old_path.parent if module == 'greeks' else old_path
            no_links(source)
            # Only dedicated persistent directories are candidates, never / or /etc.
            if len(source.parts) < len(self.filesystem.parts) + 3:
                raise ValueError('Legacy data directory is not dedicated: ' + str(source))
            stage = modules / ('.migrating-' + module)
            if stage.exists():
                raise ValueError('Unexpected migration staging directory: ' + str(stage))
            state['created'].append(module)
            self.save(state)
            if source.is_dir():
                shutil.copytree(source, stage)
            else:
                stage.mkdir(mode=0o700)
            if module == 'crossex' and (stage / 'crossex.sqlite').exists() and not (stage / 'credentials.key').is_file():
                raise ValueError('CrossEx database exists without credentials.key; refusing a partial migration')
            if env_path.is_file():
                shutil.copy2(env_path, stage / '.env')
            if module == 'greeks' and old_path.is_file() and old_path.name != 'engine_state.json':
                shutil.copy2(old_path, stage / 'engine_state.json')
            # Runtime adapters replace old absolute data paths with their dataDir.
            (stage / '.migration-source.json').write_text(json.dumps({'source': str(source), 'environment': environment}) + '\n')
            self.ownership(stage)
            stage.replace(target)
        return True

    def commit(self):
        state = self.load()
        if state and state['status'] == 'pending':
            state['status'] = 'committed'
            self.save(state)

    def status(self):
        state = self.load()
        if not state:
            return 'absent'
        if state['data'] != str(self.data) or state['status'] not in ('pending', 'committed', 'rolled-back'):
            raise ValueError('Migration journal does not match this installation')
        return state['status']

    def rollback(self):
        state = self.load()
        if not state or state['status'] != 'pending':
            return
        if state['data'] != str(self.data):
            raise ValueError('Migration data directory does not match the journal')
        # New worker processes must be stopped by the installer before this call.
        quarantine = self.journal.parent / ('failed-module-migration-' + str(time.time_ns()))
        quarantine.mkdir(mode=0o700)
        for module in state['created']:
            if module not in LEGACY:
                raise ValueError('Invalid module in migration journal')
            for name in (module, '.migrating-' + module):
                current = self.data / 'modules' / name
                no_links(current)
                if current.exists():
                    shutil.move(str(current), str(quarantine / name))
        failures = []
        for service, previous in state['services'].items():
            if service not in SERVICES:
                raise ValueError('Invalid service in migration journal')
            try:
                if previous['enabled'] in ('enabled', 'enabled-runtime'):
                    self.control('enable', *(['--runtime'] if previous['enabled'] == 'enabled-runtime' else []), service)
                if previous['active']:
                    self.control('start', service)
            except RuntimeError:
                failures.append(service)
        if failures:
            raise RuntimeError('Could not restore legacy services: ' + ', '.join(failures))
        state['status'] = 'rolled-back'
        state['quarantine'] = str(quarantine)
        self.save(state)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('begin', 'commit', 'rollback', 'status'))
    parser.add_argument('--data', required=True, type=Path)
    parser.add_argument('--journal', required=True, type=Path)
    parser.add_argument('--user')
    args = parser.parse_args()
    uid = gid = None
    if args.user:
        import pwd
        account = pwd.getpwnam(args.user)
        uid, gid = account.pw_uid, account.pw_gid
    migration = Migration(args.data, args.journal, uid, gid)
    result = getattr(migration, args.operation)()
    if args.operation == 'status':
        print(result)


if __name__ == '__main__':
    main()
