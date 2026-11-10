"""Bounded public update evidence, with no deployment log or configuration fields."""
from datetime import datetime, timezone
import re
import subprocess
import sys

JOB = re.compile(r'[a-f0-9]{32}')
COMMIT = re.compile(r'[a-f0-9]{40}')
MODULES = {'hub', 'monitor', 'asset', 'crossex', 'greeks', 'aster'}
UNITS = ('project-aggregation.service', 'project-aggregation-api.service',
         'project-aggregation-entry.service', 'project-aggregation-api@a.service', 'project-aggregation-api@b.service')
ACTIVE_STATES = {'active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance'}
SUB_STATES = {'running', 'dead', 'failed', 'exited', 'start', 'start-pre', 'start-post', 'stop', 'stop-sigterm', 'stop-sigkill', 'auto-restart', 'stop-post', 'final-sigterm', 'final-sigkill'}


def stamp(value):
    if not isinstance(value, str) or len(value) > 32:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value if parsed.tzinfo is not None else None
    except ValueError:
        return None


def commit(value):
    return value if isinstance(value, str) and COMMIT.fullmatch(value) else None


def rows(value, limit):
    return value[:limit] if isinstance(value, list) else []


def member(value, choices):
    return value if isinstance(value, str) and value in choices else None


def observe_units(clock):
    """One fixed read, <=5 seconds, no retry; liveness is not a health verdict."""
    at = datetime.fromtimestamp(clock(), timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    if sys.platform != 'linux':
        return {'observedAt': at, 'units': []}
    try:
        result = subprocess.run(['/usr/bin/systemctl', 'show', *UNITS, '--property=Id,ActiveState,SubState'],
                                capture_output=True, text=True, timeout=5, check=False,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        if result.returncode or len(result.stdout) > 16384:
            return {'observedAt': at, 'units': []}
        rows = []
        for block in result.stdout.split('\n\n'):
            values = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
            unit = values.get('Id')
            if unit in UNITS and not any(row['unit'] == unit for row in rows):
                rows.append({'unit': unit, 'activeState': values.get('ActiveState') if values.get('ActiveState') in ACTIVE_STATES else None,
                             'subState': values.get('SubState') if values.get('SubState') in SUB_STATES else None})
        return {'observedAt': at, 'units': rows}
    except (OSError, subprocess.SubprocessError):
        return {'observedAt': at, 'units': []}


def snapshot(state, previous=None, plan=None, installed=None, observation=None):
    job = state.get('job')
    if not isinstance(job, dict) or not isinstance(job.get('id'), str) or not JOB.fullmatch(job['id']):
        return None
    if previous is not None and (previous.get('schemaVersion') != 1 or previous.get('jobId') != job['id']):
        previous = None
    public_job = {key: member(job.get(key), choices) for key, choices in (
        ('status', {'queued', 'running', 'succeeded', 'failed', 'interrupted'}),
        ('deployMode', {'source', 'ci'}), ('scope', {'full', 'api'}), ('phase', {'activate', 'prepare'}))}
    public_job.update(id=job['id'], startedAt=stamp(job.get('startedAt')), finishedAt=stamp(job.get('finishedAt')),
                      activeModule=member(job.get('activeModule'), MODULES),
                      steps=[{'id': row['id'], 'status': row['status']} for row in rows(job.get('steps'), 32)
                             if isinstance(row, dict) and member(row.get('id'), MODULES)
                             and member(row.get('status'), {'pending', 'running', 'succeeded', 'failed', 'skipped'})])
    versions = []
    if plan is not None:
        for entry in rows(plan.get('entries'), 32):
            if not isinstance(entry, dict) or not member(entry.get('id'), MODULES):
                continue
            original = (installed or {}).get(entry['id'], {})
            versions.append({'id': entry['id'], 'fromCommit': commit(original.get('currentCommit')), 'targetCommit': commit(entry.get('commit'))})
    elif previous:
        for row in rows(previous.get('versions'), 32):
            if isinstance(row, dict) and member(row.get('id'), MODULES):
                versions.append({'id': row['id'], 'fromCommit': commit(row.get('fromCommit')), 'targetCommit': commit(row.get('targetCommit'))})
    observed = observation if observation is not None else (previous or {}).get('observation')
    units = []
    if isinstance(observed, dict):
        for row in rows(observed.get('units'), len(UNITS)):
            if isinstance(row, dict) and member(row.get('unit'), UNITS):
                units.append({'unit': row['unit'], 'activeState': member(row.get('activeState'), ACTIVE_STATES),
                              'subState': member(row.get('subState'), SUB_STATES)})
    missing = ['health-result-not-recorded', 'rollback-result-not-recorded', 'raw-logs-excluded']
    if not units:
        missing.append('unit-states-not-recorded')
    if not versions or any(row['fromCommit'] is None or row['targetCommit'] is None for row in versions):
        missing.append('version-evidence-incomplete')
    return {'schemaVersion': 1, 'jobId': job['id'], 'job': public_job, 'versions': versions,
            'observation': {'observedAt': stamp(observed.get('observedAt')) if isinstance(observed, dict) else None, 'units': units},
            'health': {'status': 'unknown'}, 'rollback': {'status': 'unknown'}, 'missing': missing}
