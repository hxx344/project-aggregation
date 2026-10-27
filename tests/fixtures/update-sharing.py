"""Offline bridge to the real privileged coordinator; never deploys or contacts a network."""
import copy
import json
from pathlib import Path
import runpy
import sqlite3
import sys
import time

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(source / 'server/update-service'))
import registry
import releases
import updater


def send(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


if sys.argv[1] == 'hold-cli':
    with updater.file_lock(Path(sys.argv[2]), blocking=False):
        send({'ready': True})
        sys.stdin.readline()
    sys.exit(0)

root, database = Path(sys.argv[1]), Path(sys.argv[2])
fixtures = runpy.run_path(str(source / 'deploy/test-updater.py'))
network = fixtures['FakeNetwork']([registry.BY_ID['hub']])
installed = [{'id': 'hub', 'name': 'Workbench', 'state': 'unavailable',
              'currentVersion': fixtures['OLD'][:12], 'latestVersion': None,
              'currentCommit': fixtures['OLD'], 'latestCommit': None,
              'applicationKey': fixtures['OLD_KEY'], 'artifactCommit': fixtures['OLD'],
              'identity': '4' * 64}]
evidence = []


def before_installer(script, manifest, log, deploy_mode='source', scope='full'):
    # This callback is reached only after actual worker/stack locks, plan hashes,
    # installed identity and pinned release metadata have all been checked.
    with sqlite3.connect(database) as connection:
        settings = dict(connection.execute('SELECT key,value FROM settings'))
    evidence.append({'deployMode': deploy_mode, 'scope': scope,
                     'maintenance': settings.get('updates-maintenance') == '1',
                     'pendingPlanId': settings.get('updates-pending-plan', ''),
                     'hasAdmissionToken': bool(settings.get('updates-admission-token', ''))})
    # Stop here: no shell, installation, service change, or exchange call.
    return 1


coordinator = updater.Coordinator(directory=root / 'root-state',
    releases=releases.Releases(network, arch='linux-x64'),
    inspect=lambda: copy.deepcopy(installed), launch=lambda: None, alive=lambda: True,
    installer=before_installer, syntax=lambda script: None,
    clock=time.time, stack_lock=root / 'stack.lock')
for line in sys.stdin:
    request = json.loads(line)
    try:
        action = request['action']
        if action == 'check':
            coordinator.check(minimum_interval=0)
            if coordinator.check_thread:
                coordinator.check_thread.join(5)
                assert not coordinator.check_thread.is_alive(), 'offline check timed out'
            value = coordinator.status()
        elif action == 'status':
            value = coordinator.status()
        elif action == 'apply':
            value = coordinator.apply(request['planId'], request.get('deployMode', 'source'), request.get('scope', 'full'))
        elif action == 'identity-change':
            installed[0]['identity'] = '6' * 64
            value = True
        elif action == 'expire-plan':
            # Exercise the real status expiry path rather than fabricating the
            # API's response; an active API admission must survive idle root.
            with coordinator.lock():
                state = coordinator.load()
                state['expiresAt'] = updater.iso(0)
                coordinator.save(state)
            value = coordinator.status()
        elif action == 'run':
            coordinator.run()
            value = {'state': coordinator.status(), 'beforeInstaller': evidence}
        else:
            raise AssertionError('Unknown fixture action')
        send({'id': request['id'], 'value': value})
    except updater.UpdateError as error:
        send({'id': request['id'], 'error': {'status': error.status, 'message': str(error)}})
