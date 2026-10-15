"""Root-owned, local-only coordinator for the workspace's stable updates.

The HTTP service and the installer worker are separate systemd services. A
workspace/API restart therefore cannot cancel the worker or lose its result.
"""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import http.server
import json
import math
import os
import re
import socket
import socketserver
import stat
import subprocess
import threading
import time
import uuid

from registry import BY_ID, MODULES, inventory, text_file, trusted
from releases import Network, Releases, ReleaseError, digest, valid_github_token
from progress import get_progress


STATE_DIR = Path('/var/lib/project-aggregation-updater')
SOCKET_DIR = Path('/run/project-aggregation-updater')
WORKER = 'project-aggregation-update-worker.service'
STACK_LOCK = Path('/run/lock/project-aggregation-stack.lock')
PLAN_TTL = 30 * 60
CHECK_MIN_INTERVAL = 60
AUTO_CHECK_INTERVAL = 5 * 60
CHECK_RETRY_MAX_INTERVAL = 30 * 60
ACTIVE = {'queued', 'running'}
DEPLOYMENT_MODES = ('source', 'ci')
TOKEN = re.compile(r'[a-f0-9]{32}')
MAX_CREDENTIALS = 1024
PUBLIC_MODULE = ('id', 'name', 'state', 'currentVersion', 'latestVersion', 'currentCommit', 'latestCommit', 'reason', 'releaseNotes', 'recovery')
ENVIRONMENT = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8',
               'PYTHONDONTWRITEBYTECODE': '1', 'DEBIAN_FRONTEND': 'noninteractive'}


class UpdateError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def iso(value=None):
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError):
        return 0


def private_directory(directory):
    if directory.exists() or directory.is_symlink():
        trusted(directory, directory=True)
        if os.name != 'nt' and directory.stat().st_mode & 0o077:
            raise ValueError('Updater state directory must be private')
    else:
        trusted(directory.parent, directory=True)
        directory.mkdir(mode=0o700)
    return directory


def write_bytes(path, data):
    if path.exists() or path.is_symlink():
        trusted(path)
    temporary = path.parent / ('.write-' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_json(path, data):
    write_bytes(path, (json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode())


def read_json(path):
    result = json.loads(text_file(path, 2 * 1024 * 1024))
    if not isinstance(result, dict):
        raise ValueError('Invalid updater state')
    return result


def unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON property')
        result[key] = value
    return result


@contextmanager
def file_lock(path, blocking=True):
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags, 0o600)
    acquired = False
    try:
        trusted(path)
        if os.name == 'nt':
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b'0')
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        acquired = True
        yield
    finally:
        if acquired:
            if os.name == 'nt':
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def worker_alive():
    result = subprocess.run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', WORKER],
                            env=ENVIRONMENT, capture_output=True, text=True, timeout=5, check=False)
    return result.returncode == 0 and result.stdout.strip() in ('active', 'activating', 'deactivating')


def start_worker():
    subprocess.run(['/usr/bin/systemctl', 'start', '--no-block', WORKER], env=ENVIRONMENT,
                   capture_output=True, timeout=8, check=True)


def validate_deploy_mode(value):
    if not isinstance(value, str) or value not in DEPLOYMENT_MODES:
        raise UpdateError(400, '更新模式无效')
    return value


def run_installer(script, manifest, log, deploy_mode='source'):
    environment = {**ENVIRONMENT, 'PROJECT_DEPLOY_MODE': validate_deploy_mode(deploy_mode), 'PROJECT_DEPLOY_TESTS': '0',
                   'PROJECT_DEPLOY_MANIFEST_FILE': str(manifest),
                   'PROJECT_UPDATE_PROGRESS_FILE': str(log.parent / 'progress.json')}
    # Only the validated mode enters the fixed environment; no shell command string.
    with log.open('xb') as output:
        os.chmod(log, 0o600)
        result = subprocess.run(['/bin/bash', str(script)], cwd='/', env=environment,
                                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, check=False)
    return result.returncode


def syntax_check(script):
    subprocess.run(['/bin/bash', '-n', str(script)], env=ENVIRONMENT,
                   capture_output=True, timeout=10, check=True)


class Coordinator:
    def __init__(self, directory=STATE_DIR, releases=None, inspect=None, launch=None, alive=None,
                 installer=None, syntax=None, clock=time.time, stack_lock=STACK_LOCK):
        self.directory = private_directory(directory)
        self.plans = private_directory(directory / 'plans')
        self.jobs = private_directory(directory / 'jobs')
        self.releases = releases or Releases(Network(token_provider=self.read_token))
        self.inspect = inspect or inventory
        self.launch = launch or start_worker
        self.alive = alive or worker_alive
        self.installer = installer or run_installer
        self.syntax = syntax or syntax_check
        self.clock = clock
        self.stack_lock = stack_lock
        self.thread_lock = threading.RLock()
        self.check_thread = None
        self.scheduler_stop = threading.Event()
        self.scheduler_thread = None
        with self.lock():
            if not (directory / 'state.json').exists():
                self.save({'schema': 1, 'checking': False, 'checkedAt': None, 'checkError': None,
                           'failureCount': 0, 'nextCheckNotBefore': 0,
                           'planId': None, 'expiresAt': None, 'modules': [], 'job': None})

    @contextmanager
    def lock(self):
        with self.thread_lock, file_lock(self.directory / 'state.lock'):
            yield

    def load(self):
        result = read_json(self.directory / 'state.json')
        if result.get('schema') != 1:
            raise ValueError('Unsupported updater state')
        result.setdefault('failureCount', 0)
        result.setdefault('nextCheckNotBefore', 0)
        return result

    def save(self, state):
        write_json(self.directory / 'state.json', state)

    def _credentials_path(self):
        info = trusted(self.directory, directory=True)
        if os.name != 'nt' and info.st_mode & 0o077:
            raise ValueError('Updater state directory must be private')
        path = self.directory / 'credentials.json'
        try:
            info = trusted(path)
        except FileNotFoundError:
            return path
        if os.name != 'nt' and info.st_mode & 0o077:
            raise ValueError('Updater credentials must be private')
        return path

    def read_token(self):
        # Both control and worker processes read the current private file for
        # every API request. Only a genuinely absent file means anonymous use.
        try:
            path = self._credentials_path()
            try:
                descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
            except FileNotFoundError:
                return ''
            with os.fdopen(descriptor, 'rb') as source:
                info = os.fstat(source.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CREDENTIALS or
                        os.name != 'nt' and (info.st_uid != 0 or info.st_mode & 0o077)):
                    raise ValueError('Invalid credential file')
                data = source.read(MAX_CREDENTIALS + 1)
            if len(data) > MAX_CREDENTIALS:
                raise ValueError('Credential file is too large')
            value = json.loads(data, object_pairs_hook=unique_json_object)
            if (not isinstance(value, dict) or set(value) != {'schema', 'token'} or
                    type(value['schema']) is not int or value['schema'] != 1 or not valid_github_token(value['token'])):
                raise ValueError('Invalid credential configuration')
            return value['token']
        except (OSError, ValueError, UnicodeError):
            raise ReleaseError('GitHub Token 配置不可读取，请检查服务器配置和权限') from None

    def set_token(self, token):
        if not valid_github_token(token):
            raise UpdateError(400, 'GitHub Token 格式无效')
        with self.lock():
            state = self.load()
            if state['checking'] or state['job'] and state['job']['status'] in ACTIVE:
                raise UpdateError(409, '版本检查或更新正在进行，请结束后再修改 GitHub Token')
            try:
                path = self._credentials_path()
                if token:
                    write_json(path, {'schema': 1, 'token': token})
                else:
                    path.unlink(missing_ok=True)
                # Credentials do not change the reviewed release identity or
                # override an existing rate-limit deadline. No probe is sent.
                return self.public(state)
            except (OSError, ValueError, ReleaseError):
                raise UpdateError(503, 'GitHub Token 配置保存失败，请检查服务器配置和权限') from None

    def public(self, state):
        result = {'enabled': True, **{key: state.get(key) for key in
                ('checking', 'checkedAt', 'checkError', 'planId', 'expiresAt', 'job')},
                'modules': [{key: item[key] for key in PUBLIC_MODULE if key in item} for item in state['modules']],
                'githubToken': {'configured': bool(self.read_token())}, 'deploymentModes': list(DEPLOYMENT_MODES)}
        if result['job']:
            # Keep samples out of state.json and never forward them after the
            # task finishes. Each accepted job already owns a private directory.
            job = result['job'] = {key: value for key, value in result['job'].items() if key != 'progress'}
            job.setdefault('deployMode', 'source')
            if job['status'] == 'running' and TOKEN.fullmatch(job['id']):
                progress = get_progress(self.jobs / job['id'] / 'progress.json',
                                        timestamp(job['startedAt']) * 1000, self.clock())
                if progress is not None:
                    job['progress'] = progress
        remaining = state.get('nextCheckNotBefore', 0) - self.clock()
        if result['checkError'] and remaining > 0:
            result['checkError'] += f'；已暂停重试，约 {math.ceil(remaining / 60)} 分钟后自动重试'
        return result

    def _record_check_failure(self, state, message, retry_at=0):
        count = state.get('failureCount', 0)
        count = count + 1 if type(count) is int and count >= 0 else 1
        delay = min(CHECK_RETRY_MAX_INTERVAL, AUTO_CHECK_INTERVAL * 2 ** min(count - 1, 3))
        now = self.clock()
        state.update(checking=False, checkedAt=iso(now), checkError=message,
                     failureCount=count, nextCheckNotBefore=max(now + delay, retry_at),
                     planId=None, expiresAt=None)

    def _check_delay(self, state, minimum_interval):
        now = self.clock()
        started = state.get('lastCheckStarted') or timestamp(state.get('checkedAt'))
        deadline = state.get('nextCheckNotBefore', 0)
        if started > now:
            # Rebase once when the wall clock moves backwards, preserving the
            # original retry duration rather than blocking until the old date.
            retry_started = timestamp(state.get('checkedAt')) or started
            if deadline and retry_started > now:
                deadline = now + max(0, deadline - retry_started)
            state.update(lastCheckStarted=now, nextCheckNotBefore=deadline)
            self.save(state)
            started = now
        interval_delay = minimum_interval - (now - started) if started else 0
        return max(0, interval_delay, deadline - now)

    def recover(self, starting=False):
        with self.lock():
            state = self.load()
            changed = False
            if state['checking'] and starting:
                self._record_check_failure(state, '上次版本检查已中断')
                changed = True
            job = state['job']
            if job and job['status'] in ACTIVE and self.clock() - timestamp(job['startedAt']) > 30:
                try:
                    active = self.alive()
                except (OSError, subprocess.SubprocessError):
                    active = True  # Unknown service state must never permit a second worker.
                if not active:
                    job.update(status='interrupted', finishedAt=iso(self.clock()), activeModule=None,
                               message='更新进程已中断，请检查模块状态后重新检查版本')
                    for step in job['steps']:
                        if step['status'] == 'running':
                            step.update(status='failed', message='该模块的结果尚未确认')
                        elif step['status'] == 'pending':
                            step.update(status='skipped', message='尚未执行')
                    state.update(planId=None, expiresAt=None)
                    changed = True
            if changed:
                self.save(state)

    def status(self):
        self.recover()
        with self.lock():
            state = self.load()
            if state['planId'] and timestamp(state['expiresAt']) <= self.clock() and not (state['job'] and state['job']['status'] in ACTIVE):
                state.update(planId=None, expiresAt=None)
                self.save(state)
            return self.public(state)

    def check(self, minimum_interval=CHECK_MIN_INTERVAL):
        with self.lock():
            state = self.load()
            if state['checking'] or state['job'] and state['job']['status'] in ACTIVE:
                return self.public(state)
            if self._check_delay(state, minimum_interval) > 0:
                return self.public(state)
            state.update(checking=True, checkError=None, lastCheckStarted=self.clock())
            self.save(state)
            self.check_thread = threading.Thread(target=self.perform_check, daemon=True, name='stable-release-check')
            self.check_thread.start()
            return self.public(state)

    def next_check_delay(self):
        with self.lock():
            state = self.load()
            if state['checking'] or state['job'] and state['job']['status'] in ACTIVE:
                return 5
            return min(AUTO_CHECK_INTERVAL, self._check_delay(state, AUTO_CHECK_INTERVAL))

    def start_scheduler(self):
        # Only the control service calls this; a standalone installer worker never schedules checks.
        with self.thread_lock:
            if self.scheduler_thread and self.scheduler_thread.is_alive():
                return
            self.scheduler_stop.clear()
            def schedule():
                while not self.scheduler_stop.is_set():
                    try:
                        self.recover()
                        if self.scheduler_stop.wait(self.next_check_delay()):
                            return
                        self.check(minimum_interval=AUTO_CHECK_INTERVAL)
                    except Exception:
                        # A transient local read failure must not terminate future checks or spin.
                        if self.scheduler_stop.wait(AUTO_CHECK_INTERVAL):
                            return
            self.scheduler_thread = threading.Thread(target=schedule, daemon=True, name='stable-release-scheduler')
            self.scheduler_thread.start()

    def stop_scheduler(self):
        self.scheduler_stop.set()
        if self.scheduler_thread:
            self.scheduler_thread.join(timeout=2)

    def recovery_targets(self):
        with self.lock():
            state = self.load()
            job = state.get('job')
            if not job or job.get('status') not in ('failed', 'interrupted'):
                return {}
            try:
                # An expired, protected plan identifies a failed target only.
                # It never authorizes apply/run; those require a fresh plan.
                plan = self.read_plan(state.get('jobPlanId'), allow_expired=True)
            except (UpdateError, OSError, ValueError):
                return {}
            unfinished = {step['id'] for step in job['steps'] if step['status'] != 'succeeded'}
            return {entry['id']: {**entry, 'jobId': job['id'], 'startedAt': job['startedAt']}
                    for entry in plan['entries'] if entry['id'] in unfinished}

    def _candidate(self, installed, recovery=None):
        item = dict(installed)
        if item['state'] == 'unmanaged':
            return item, None
        module = BY_ID[item['id']]
        try:
            receipt = None
            receipt_path = self.directory / (module.id + '.receipt.json')
            if receipt_path.exists() or receipt_path.is_symlink():
                receipt = read_json(receipt_path)
                if receipt.get('identity') == item.get('identity') and re.fullmatch(r'[a-f0-9]{40}', receipt.get('commit', '')):
                    # Some installers correctly retain older equivalent runtime bytes.
                    item.update(currentCommit=receipt['commit'], currentVersion=receipt['commit'][:12])
            release = self.releases.read(module)
            item.update(latestVersion=release['version'], latestCommit=release['commit'],
                        releaseNotes=release.get('releaseNotes', ''))
            current = item['currentCommit']
            if current == release['commit']:
                completed = (receipt and receipt.get('identity') == item.get('identity') and
                             all(receipt.get(key) == release[key] for key in
                                 ('commit', 'releaseId', 'applicationKey', 'installerHash')) and
                             recovery and (receipt.get('jobId') == recovery['jobId'] or
                                 not receipt.get('jobId') and timestamp(receipt.get('completedAt')) > timestamp(recovery['startedAt'])))
                if recovery and recovery['commit'] == current and not completed:
                    item.update(state='available', recovery=True,
                                reason='版本已对齐，但上次更新未确认完成；可重新确认并恢复更新')
                    return item, release
                item.update(state='current', reason='已是最新正式版本')
                return item, None
            if current and not self.releases.is_newer(module, current, release['commit']):
                item.update(state='current', reason='本机版本领先于当前正式版本，不自动降级')
                return item, None
            item.update(state='available', reason='正式版本可用')
            return item, release
        except ReleaseError as error:
            item.update(state='unavailable', reason=str(error))
            retry_at = error.retry_at
            if type(retry_at) in (int, float) and math.isfinite(retry_at):
                item['retryAt'] = retry_at
            return item, None
        except Exception:
            item.update(state='unavailable', reason='正式版本检查未完成，请稍后重试')
            return item, None

    def perform_check(self):
        try:
            installations = self.inspect()
            recovery = self.recovery_targets()
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda item: self._candidate(item, recovery.get(item['id'])), installations))
            modules = [item for item, _ in results]
            retry_at = max((item.pop('retryAt', 0) for item in modules), default=0)
            candidates = [(item, release) for item, release in results if release]
            failed = any(item['state'] == 'unavailable' for item in modules)
            plan_id = None
            expires = None
            # A partial check never silently drops an installed module from the plan.
            if candidates and not failed:
                entries = []
                for item, release in candidates:
                    entry = {key: release[key] for key in ('releaseId', 'commit', 'tag', 'version', 'manifestHash', 'installerHash', 'applicationKey')}
                    entry.update(id=item['id'], installedIdentity=item['identity'])
                    entries.append(entry)
                with self.lock():
                    previous = self.load().get('planId')
                    try:
                        plan = self.read_plan(previous) if previous else None
                    except (UpdateError, OSError, ValueError):
                        plan = None
                    if plan and plan['entries'] == entries:
                        plan_id, expires = plan['id'], plan['expiresAt']
                if not plan_id:
                    plan_id = uuid.uuid4().hex
                    plan_directory = private_directory(self.plans / plan_id)
                    expires = iso(self.clock() + PLAN_TTL)
                    for item, release in candidates:
                        write_bytes(plan_directory / (item['id'] + '.manifest.json'), release['manifestBytes'])
                        write_bytes(plan_directory / (item['id'] + '.install.sh'), release['installer'])
                    write_json(plan_directory / 'plan.json', {'schema': 1, 'id': plan_id, 'expiresAt': expires, 'entries': entries})
            with self.lock():
                state = self.load()
                state.update(modules=modules)
                if failed:
                    self._record_check_failure(state, '部分模块检查失败，暂不能开始更新', retry_at)
                else:
                    state.update(checking=False, checkedAt=iso(self.clock()), checkError=None,
                                 failureCount=0, nextCheckNotBefore=0, planId=plan_id, expiresAt=expires)
                self.save(state)
        except Exception:
            with self.lock():
                state = self.load()
                self._record_check_failure(state, '版本检查未完成')
                self.save(state)

    def read_plan(self, plan_id, *, allow_expired=False):
        if not isinstance(plan_id, str) or not TOKEN.fullmatch(plan_id):
            raise UpdateError(400, '更新计划格式无效')
        directory = self.plans / plan_id
        trusted(directory, directory=True)
        plan = read_json(directory / 'plan.json')
        if plan.get('schema') != 1 or plan.get('id') != plan_id or not allow_expired and timestamp(plan.get('expiresAt')) <= self.clock():
            raise UpdateError(409, '更新计划已过期，请重新检查')
        entries = plan.get('entries')
        ids = [entry.get('id') for entry in entries] if isinstance(entries, list) else []
        if not ids or len(ids) != len(set(ids)) or any(key not in BY_ID for key in ids):
            raise UpdateError(409, '更新计划无效，请重新检查')
        if ids != [module.id for module in MODULES if module.id in ids]:
            raise UpdateError(409, '更新顺序无效，请重新检查')
        for entry in entries:
            if not re.fullmatch(r'[a-f0-9]{40}', entry.get('commit', '')) or entry.get('tag') != 'deploy-' + entry['commit']:
                raise UpdateError(409, '版本身份无效，请重新检查')
            if type(entry.get('releaseId')) is not int or entry['releaseId'] < 1:
                raise UpdateError(409, '发布身份无效，请重新检查')
            for key in ('manifestHash', 'installerHash', 'applicationKey', 'installedIdentity'):
                if not re.fullmatch(r'[a-f0-9]{64}', entry.get(key, '')):
                    raise UpdateError(409, '版本摘要无效，请重新检查')
            for suffix, key in (('.manifest.json', 'manifestHash'), ('.install.sh', 'installerHash')):
                path = directory / (entry['id'] + suffix)
                trusted(path)
                if path.stat().st_size > 2 * 1024 * 1024 or digest(path.read_bytes()) != entry[key]:
                    raise UpdateError(409, '计划文件校验失败，请重新检查')
        return plan

    def apply(self, plan_id, deploy_mode='source'):
        validate_deploy_mode(deploy_mode)
        with self.lock():
            state = self.load()
            job = state['job']
            if job and job['status'] in ACTIVE:
                if state.get('jobPlanId') == plan_id and job.get('deployMode', 'source') == deploy_mode:
                    return self.public(state)
                raise UpdateError(409, '已有更新任务正在执行')
            if state['checking'] or state.get('checkError') or not plan_id or state['planId'] != plan_id:
                raise UpdateError(409, '更新计划已改变，请重新检查')
            try:
                plan = self.read_plan(plan_id)
            except (OSError, ValueError):
                raise UpdateError(409, '计划文件不可用，请重新检查') from None
            current = {item['id']: item for item in self.inspect()}
            if any(current.get(entry['id'], {}).get('identity') != entry['installedIdentity'] for entry in plan['entries']):
                raise UpdateError(409, '本机版本已改变，请重新检查')
            job_id = uuid.uuid4().hex
            private_directory(self.jobs / job_id)
            state.update(jobPlanId=plan_id, job={'id': job_id, 'status': 'queued', 'deployMode': deploy_mode, 'startedAt': iso(self.clock()),
                         'finishedAt': None, 'activeModule': None, 'message': '已提交，正在准备正式版本更新',
                         'steps': [{'id': entry['id'], 'name': BY_ID[entry['id']].name, 'status': 'pending'} for entry in plan['entries']]})
            self.save(state)
            try:
                self.launch()
            except Exception:
                state['job'].update(status='failed', finishedAt=iso(self.clock()), message='无法启动更新服务，请检查服务器服务状态')
                for step in state['job']['steps']:
                    step.update(status='skipped', message='尚未执行')
                state.update(planId=None, expiresAt=None)
                self.save(state)
                raise UpdateError(503, '更新服务未能启动') from None
            return self.public(state)

    def progress(self, job_id, callback):
        with self.lock():
            state = self.load()
            if not state['job'] or state['job']['id'] != job_id:
                raise UpdateError(409, '更新任务身份已改变')
            callback(state, state['job'])
            self.save(state)

    def run(self):
        try:
            with file_lock(self.directory / 'worker.lock', blocking=False):
                self.run_locked()
        except BlockingIOError:
            # A duplicate invocation must not overwrite the real worker's job.
            return
        except PermissionError:
            if os.name != 'nt':
                raise
            # msvcrt reports an occupied lock as PermissionError on Windows.

    def run_locked(self):
        with self.lock():
            state = self.load()
            if not state['job'] or state['job']['status'] != 'queued':
                return
            job_id, plan_id = state['job']['id'], state['jobPlanId']
            deploy_mode = state['job'].get('deployMode', 'source')
        try:
            validate_deploy_mode(deploy_mode)
            with file_lock(self.stack_lock, blocking=False):
                plan = self.read_plan(plan_id)
                def begin(state, job):
                    job.update(status='running', message='正在核实所选正式版本')
                self.progress(job_id, begin)
                current = {item['id']: item for item in self.inspect()}
                # Download and validate every installer before changing any module.
                for entry in plan['entries']:
                    if current.get(entry['id'], {}).get('identity') != entry['installedIdentity']:
                        raise UpdateError(409, '本机版本已改变，未开始部署，请重新检查')
                    release = self.releases.read(BY_ID[entry['id']], entry['releaseId'])
                    if any(release[key] != entry[key] for key in ('commit', 'tag', 'manifestHash', 'installerHash', 'applicationKey')):
                        raise UpdateError(409, '正式发布内容已改变，未开始部署，请重新检查')
                    self.syntax(self.plans / plan_id / (entry['id'] + '.install.sh'))
                for entry in plan['entries']:
                    key = entry['id']
                    def running(state, job):
                        job.update(activeModule=key, message='正在更新 ' + BY_ID[key].name)
                        next(step for step in job['steps'] if step['id'] == key).update(status='running')
                    self.progress(job_id, running)
                    plan_directory = self.plans / plan_id
                    code = self.installer(plan_directory / (key + '.install.sh'), plan_directory / (key + '.manifest.json'),
                                          self.jobs / job_id / (key + '.log'), deploy_mode)
                    if code != 0:
                        raise UpdateError(500, BY_ID[key].name + ' 更新失败；已完成的模块保留，恢复结果请查看服务器部署日志')
                    observed = next((item for item in self.inspect() if item['id'] == key), None)
                    if not observed or observed['state'] == 'unmanaged' or not (
                            observed.get('applicationKey') == entry['applicationKey'] or observed.get('currentCommit') == entry['commit']):
                        raise UpdateError(500, BY_ID[key].name + ' 的安装结果尚未确认，请查看服务器部署日志')
                    receipt = {'jobId': job_id, 'commit': entry['commit'], 'releaseId': entry['releaseId'], 'applicationKey': entry['applicationKey'],
                               'installerHash': entry['installerHash'], 'identity': observed['identity'], 'completedAt': iso(self.clock())}
                    write_json(self.directory / (key + '.receipt.json'), receipt)
                    def succeeded(state, job):
                        next(step for step in job['steps'] if step['id'] == key).update(status='succeeded', message='已完成更新与健康检查')
                        module = next((item for item in state['modules'] if item['id'] == key), None)
                        if module:
                            module.pop('recovery', None)
                            module.update(state='current', currentCommit=entry['commit'], currentVersion=entry['version'], reason='已是所选正式版本')
                    self.progress(job_id, succeeded)
                def finish(state, job):
                    job.update(status='succeeded', activeModule=None, finishedAt=iso(self.clock()), message='所选正式版本更新完成')
                    state.update(planId=None, expiresAt=None)
                self.progress(job_id, finish)
        except Exception as error:
            message = str(error) if isinstance(error, (UpdateError, ReleaseError)) else '更新未完成，请检查服务器部署日志后重新检查版本'
            if isinstance(error, (BlockingIOError, PermissionError)):
                message = '另一个部署正在运行，请待其结束后重新检查'
            def failed(state, job):
                job.update(status='failed', activeModule=None, finishedAt=iso(self.clock()), message=message)
                for step in job['steps']:
                    if step['status'] == 'running':
                        step.update(status='failed', message='请查看服务器部署日志中的恢复结果')
                    elif step['status'] == 'pending':
                        step.update(status='skipped', message='尚未执行')
                state.update(planId=None, expiresAt=None)
            self.progress(job_id, failed)


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'LocalUpdater/1'
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass  # Never log request content or return raw deployment logs.

    def answer(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def dispatch(self):
        try:
            self.connection.settimeout(5)
            if self.command == 'GET' and self.path == '/status':
                self.answer(200, self.server.coordinator.status())
                return
            if self.command != 'POST' or self.path not in ('/check', '/apply', '/token'):
                raise UpdateError(404, '更新接口不存在')
            if self.headers.get('Transfer-Encoding') is not None:
                raise UpdateError(400, '不支持该请求格式')
            length = self.headers.get('Content-Length', '')
            if not length.isdigit() or not 0 < int(length) <= 1024:
                raise UpdateError(400, '请求内容无效')
            if self.headers.get_content_type() != 'application/json':
                raise UpdateError(415, '请求需使用 JSON')
            body = json.loads(self.rfile.read(int(length)), object_pairs_hook=unique_json_object)
            expected = {'/check': [set()], '/apply': [{'planId'}, {'planId', 'deployMode'}], '/token': [{'token'}]}[self.path]
            if not isinstance(body, dict) or set(body) not in expected:
                raise UpdateError(400, '更新参数无效')
            if self.path == '/token':
                self.answer(200, self.server.coordinator.set_token(body['token']))
            else:
                result = self.server.coordinator.check() if self.path == '/check' else self.server.coordinator.apply(body['planId'], body.get('deployMode', 'source'))
                self.answer(202, result)
        except UpdateError as error:
            self.answer(error.status, {'error': str(error)})
        except (ValueError, UnicodeError, TimeoutError):
            self.answer(400, {'error': '更新请求无效'})
        except Exception:
            self.answer(503, {'error': '更新服务暂时不可用'})

    do_GET = dispatch
    do_POST = dispatch
    do_PUT = dispatch
    do_DELETE = dispatch


if hasattr(socketserver, 'UnixStreamServer'):
    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True
        block_on_close = False
        request_queue_size = 16

        def __init__(self, path, coordinator):
            self.coordinator = coordinator
            self.requests = threading.BoundedSemaphore(16)
            super().__init__(str(path), Handler)

        def process_request(self, request, client_address):
            if not self.requests.acquire(blocking=False):
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, client_address)
            except Exception:
                self.requests.release()
                raise

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.requests.release()


def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in ('serve', 'run'):
        raise SystemExit('Use the installed Linux update services.')
    coordinator = Coordinator()
    if sys.argv[1] == 'run':
        coordinator.run()
        return
    import grp
    group = grp.getgrnam('project-aggregation').gr_gid
    trusted(SOCKET_DIR, directory=True)
    os.chown(SOCKET_DIR, 0, group)
    os.chmod(SOCKET_DIR, 0o750)
    endpoint = SOCKET_DIR / 'control.sock'
    if endpoint.exists() or endpoint.is_symlink():
        info = endpoint.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise SystemExit('Unexpected updater socket.')
        endpoint.unlink()
    coordinator.recover(starting=True)
    with Server(endpoint, coordinator) as server:
        os.chown(endpoint, 0, group)
        os.chmod(endpoint, 0o660)
        coordinator.start_scheduler()
        try:
            server.serve_forever(poll_interval=0.5)
        finally:
            coordinator.stop_scheduler()


if __name__ == '__main__':
    main()
