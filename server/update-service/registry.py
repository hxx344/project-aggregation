"""Fixed local installation identities. Nothing here is supplied by the browser."""
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import stat


@dataclass(frozen=True)
class Module:
    id: str
    name: str
    repository: str
    directory: str
    service: str
    user: str
    installer: str
    release_pattern: str
    markers: tuple[str, ...]
    checked: str = ''
    artifact: str = ''
    root_marker: bool = False
    working_suffix: str = ''
    # Further units of the same installation, checked like `service`.
    extra_services: tuple[str, ...] = ()
    # The `service` unit may carry the recovery entry's startup guard.
    recovery_guard: bool = False


MODULES = (
    Module('hub', '工作台（包含五个内置模块）', 'project-aggregation', 'project-aggregation', 'project-aggregation',
           'project-aggregation', 'deploy/install.sh', r'[a-f0-9]{12}-[a-f0-9]{16}',
           ('.managed-release', '.install-ready'), '@.deployed-state', '.source-sha', True,
           extra_services=('project-aggregation-api',), recovery_guard=True),
)
BY_ID = {module.id: module for module in MODULES}
HEX40 = re.compile(r'[a-f0-9]{40}')
HEX64 = re.compile(r'[a-f0-9]{64}')
RECOVERY_GUARD = '20-recovery-guard.conf'
RECOVERY_MARKER = '# Managed by project-aggregation recovery'


def trusted(path: Path, directory=False):
    """Reject links and any object writable by the application account."""
    info = path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('Unexpected filesystem object')
    if os.name != 'nt' and (info.st_uid != 0 or info.st_mode & 0o022):
        raise ValueError('Installation metadata is not root-owned and read-only')
    return info


def text_file(path: Path, maximum=65536):
    info = trusted(path)
    if info.st_size > maximum:
        raise ValueError('Installation metadata is too large')
    return path.read_text(encoding='utf-8').strip()


def optional_text(path: Path):
    return text_file(path) if path.exists() or path.is_symlink() else ''


def unit_source(module: Module, name, current_path, filesystem, guard=False):
    unit = filesystem / 'etc/systemd/system' / (name + '.service')
    source = text_file(unit)
    properties = {}
    for line in source.splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            properties.setdefault(key, []).append(value)
    expected_work = current_path + module.working_suffix
    if properties.get('WorkingDirectory') != [expected_work] or properties.get('User') != [module.user]:
        raise ValueError('Unexpected service identity')
    if module.root_marker and f'# Managed by {module.service} installer' not in source:
        raise ValueError('Unknown service')
    if len(properties.get('ExecStart', [])) != 1:
        raise ValueError('Unknown service command')
    command = properties['ExecStart'][0]
    if module.id == 'variational':
        if not re.match(r'^/usr/bin/python3 -m variational_grid (?:run|compare) ', command):
            raise ValueError('Unknown Variational command')
    elif current_path + '/' not in command:
        raise ValueError('Service does not run the managed release')
    # Custom service overrides need a deliberate CLI update, not a guessed
    # identity; only the recovery entry's own startup guard is expected.
    for dropins in (unit.parent / (name + '.service.d'), filesystem / 'run/systemd/system' / (name + '.service.d')):
        if not dropins.exists():
            continue
        for conf in dropins.glob('*.conf'):
            if not (guard and dropins.parent == unit.parent and conf.name == RECOVERY_GUARD and
                    text_file(conf).partition('\n')[0] == RECOVERY_MARKER):
                raise ValueError('Custom service overrides')
    return source


def installed(module: Module, filesystem=Path('/')):
    root = filesystem / 'opt' / module.directory
    unit = filesystem / 'etc/systemd/system' / (module.service + '.service')
    if not (root.exists() or root.is_symlink() or unit.exists() or unit.is_symlink()):
        return None
    result = {'id': module.id, 'name': module.name, 'state': 'unmanaged', 'currentVersion': None,
              'latestVersion': None, 'currentCommit': None, 'latestCommit': None}
    try:
        # A protected leaf under a writable parent is not a trusted installation.
        for parent in (filesystem / 'opt', root, root / 'releases', filesystem / 'etc', filesystem / 'etc/systemd', unit.parent):
            trusted(parent, directory=True)
        if module.root_marker:
            text_file(root / '.managed-install')
        current = root / 'current'
        if not current.is_symlink():
            raise ValueError('current is not an installer-managed link')
        release = current.resolve(strict=True)
        if release.parent != (root / 'releases').resolve() or not re.fullmatch(module.release_pattern, release.name):
            raise ValueError('current is outside the managed release directory')
        trusted(release, directory=True)
        for marker in module.markers:
            value = text_file(release / marker)
            if module.id == 'variational' and marker == '.install-owned' and value != 'variational-grid':
                raise ValueError('Wrong installation owner')
        current_path = str(root / 'current').replace('\\', '/')
        sources = [unit_source(module, name, current_path, filesystem, guard=module.recovery_guard and name == module.service)
                   for name in (module.service, *module.extra_services)]
        checked = optional_text((root / module.checked[1:]) if module.checked.startswith('@') else (release / module.checked)) if module.checked else ''
        checked = checked.split()[0] if checked else ''
        artifact = optional_text(release / '.release-commit')
        if not HEX40.fullmatch(artifact) and module.artifact:
            artifact = optional_text(release / module.artifact)
        if not HEX40.fullmatch(artifact) and module.id == 'variational':
            artifact = release.name.removesuffix('-ci')
        artifact = artifact if HEX40.fullmatch(artifact) else None
        checked = checked if HEX40.fullmatch(checked) else artifact
        application_key = optional_text(release / '.release-application-key')
        application_key = application_key if HEX64.fullmatch(application_key) else None
        identity = hashlib.sha256(('\n'.join([str(release), *sources, checked or '', artifact or '', application_key or ''])).encode()).hexdigest()
        result.update(state='unavailable', currentCommit=checked, currentVersion=checked[:12] if checked else None,
                      reason='尚未检查正式版本', identity=identity, artifactCommit=artifact, applicationKey=application_key)
    except (OSError, ValueError, UnicodeError):
        result['reason'] = '本机安装或服务配置不符合受管理目录约定，请使用一键部署命令检查'
    return result


def inventory(filesystem=Path('/')):
    return [item for module in MODULES if (item := installed(module, filesystem)) is not None]
