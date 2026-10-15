"""Read optional, task-scoped installer progress for the existing status channel.

Progress is display-only: a missing, stale or malformed sample cannot change the
installation result or make the update control service unavailable.
"""
import json
import math
import os
from pathlib import Path
import re
import stat
import time

from registry import trusted


STAGES = {'preflight', 'download', 'prepare', 'build', 'verify', 'extract', 'switch', 'finalize'}
DETAILS = {
    'download': {'source-receive', 'source-retry'},
    'prepare': {'source-resolve', 'dependencies', 'runtime'},
    'build': {'build-workbench', 'build-monitor', 'build-asset', 'build-crossex', 'build-aster'},
    'verify': {'typecheck', 'tests'},
    'finalize': {'healthcheck', 'updater'},
}
PROGRESS_TIMEOUT = 300
MAX_PROGRESS_BYTES = 4096
MAX_TIMINGS_BYTES = 16384
MAX_TIMINGS_ENTRIES = 32
MAX_NUMBER = 2 ** 53 - 1


def number(value, maximum=MAX_NUMBER):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum


def get_progress(path: Path, started_at: float, now=None):
    """Read only the current job's private file; never return raw errors or logs."""
    try:
        parent = trusted(path.parent, directory=True)
        if os.name != 'nt' and parent.st_mode & 0o077:
            return None
        trusted(path)
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PROGRESS_BYTES or info.st_nlink != 1
                    or os.name != 'nt' and (info.st_uid != 0 or info.st_mode & 0o077)):
                return None
            raw = source.read(MAX_PROGRESS_BYTES + 1)
        if len(raw) > MAX_PROGRESS_BYTES:
            return None
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get('stage'), str) or data['stage'] not in STAGES:
            return None
        stamp = data.get('timestamp')
        clock = (time.time() if now is None else now) * 1000
        if (not number(stamp) or stamp <= 0 or stamp < started_at
                or stamp > clock + 1000 or clock - stamp > PROGRESS_TIMEOUT * 1000):
            return None
        if 'progress' in data and not number(data['progress'], 1):
            return None
        for key in ('downloaded', 'total', 'speed', 'eta'):
            if key in data and not number(data[key]):
                return None
        if 'downloaded' in data and 'total' in data and data['downloaded'] > data['total']:
            return None
        result = {'stage': data['stage'], 'timestamp': stamp}
        if isinstance(data.get('detail'), str) and data['detail'] in DETAILS.get(data['stage'], set()):
            result['detail'] = data['detail']
        if 'progress' in data:
            result['progress'] = data['progress']
        if data['stage'] == 'download':
            result.update({key: data[key] for key in ('downloaded', 'total', 'speed', 'eta') if key in data})
        return result
    except (OSError, ValueError, UnicodeError, OverflowError, RecursionError):
        return None


def get_stage_timings(path: Path):
    """Project terminal display data without expiring completed measurements."""
    try:
        parent = trusted(path.parent, directory=True)
        if os.name != 'nt' and parent.st_mode & 0o077:
            return None
        trusted(path)
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TIMINGS_BYTES or info.st_nlink != 1
                    or os.name != 'nt' and (info.st_uid != 0 or info.st_mode & 0o077)):
                return None
            raw = source.read(MAX_TIMINGS_BYTES + 1)
        if len(raw) > MAX_TIMINGS_BYTES:
            return None
        data = json.loads(raw)
        if (not isinstance(data, dict) or type(data.get('schema')) is not int or data['schema'] != 1
                or type(data.get('closed')) is not bool):
            return None
        # A job's private directory provides its identity across wall-clock
        # corrections. Copied data from another job must still be rejected.
        if (not isinstance(data.get('jobId'), str) or re.fullmatch(r'[a-f0-9]{32}', data['jobId']) is None
                or data['jobId'] != path.parent.name):
            return None
        created = data.get('createdAt')
        if not number(created) or created <= 0:
            return None
        entries = data.get('entries')
        if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_TIMINGS_ENTRIES:
            return None
        active = data.get('active')
        if data['closed']:
            if active is not None:
                return None
        elif (not isinstance(active, dict) or type(active.get('index')) is not int
              or not 0 <= active['index'] < len(entries)):
            return None
        result, seen = [], set()
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict) or not isinstance(entry.get('stage'), str) or entry['stage'] not in STAGES:
                return None
            stage, detail = entry['stage'], entry.get('detail')
            if 'detail' in entry and (not isinstance(detail, str) or detail not in DETAILS.get(stage, set())):
                return None
            key = (stage, detail)
            if key in seen or 'durationMs' not in entry:
                return None
            seen.add(key)
            duration = entry['durationMs']
            if duration is not None and not number(duration):
                return None
            row = {'stage': stage, 'durationMs': None if active is not None and active['index'] == index else duration}
            if detail is not None:
                row['detail'] = detail
            result.append(row)
        return {'entries': result}
    except (OSError, ValueError, UnicodeError, OverflowError, RecursionError):
        return None
