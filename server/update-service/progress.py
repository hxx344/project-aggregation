"""Update progress tracking and streaming for download operations.

Provides real-time progress updates during package download, verification,
extraction, and service switching phases.
"""
import json
import os
from pathlib import Path
import time
from typing import Optional, Dict, Any, Iterator

PROGRESS_FILE = Path('/tmp/project-aggregation-update-progress.json')
PROGRESS_TIMEOUT = 300  # 5 minutes without updates = timeout


class ProgressStage:
    """Download and installation stages with their relative weights."""
    PREFLIGHT = 'preflight'
    DOWNLOAD = 'download'
    VERIFY = 'verify'
    EXTRACT = 'extract'
    SWITCH = 'switch'


STAGE_WEIGHTS = {
    ProgressStage.PREFLIGHT: 0.05,
    ProgressStage.DOWNLOAD: 0.70,
    ProgressStage.VERIFY: 0.10,
    ProgressStage.EXTRACT: 0.10,
    ProgressStage.SWITCH: 0.05,
}


def get_progress() -> Optional[Dict[str, Any]]:
    """Read current progress from the shared progress file.

    Returns:
        Progress data dict, or None if file doesn't exist.
        Returns error dict if file is stale or invalid.
    """
    if not PROGRESS_FILE.exists():
        return None

    try:
        with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)

        if not isinstance(data, dict):
            return {'error': 'Invalid progress format'}

        # Check timeout
        timestamp = data.get('timestamp', 0)
        if not isinstance(timestamp, (int, float)) or timestamp <= 0:
            return {'error': 'Invalid progress timestamp'}

        age_ms = time.time() * 1000 - timestamp
        if age_ms > PROGRESS_TIMEOUT * 1000:
            return {**data, 'error': 'Progress timeout'}

        return data
    except (OSError, json.JSONDecodeError, ValueError) as error:
        return {'error': f'Failed to read progress: {error}'}


def stream_progress() -> Iterator[bytes]:
    """Stream progress updates via Server-Sent Events.

    Yields SSE-formatted data chunks. Ends stream when:
    - Installation completes (switch stage at 100%)
    - An error occurs
    - Progress file goes stale

    Yields:
        SSE data lines as bytes
    """
    last_data = None
    poll_interval = 0.5  # 500ms

    while True:
        data = get_progress()

        # Only push when data changes
        if data != last_data:
            payload = json.dumps(data if data else {}, ensure_ascii=False)
            yield f'data: {payload}\n\n'.encode('utf-8')
            last_data = data

            # End stream on completion or error
            if data:
                is_complete = (
                    data.get('stage') == ProgressStage.SWITCH and
                    isinstance(data.get('progress'), (int, float)) and
                    data.get('progress') >= 1.0
                )
                has_error = 'error' in data

                if is_complete or has_error:
                    break

        time.sleep(poll_interval)


def init_progress_file(stage: str, total: Optional[int] = None) -> None:
    """Initialize progress file for a new download operation.

    Args:
        stage: Initial stage (usually PREFLIGHT)
        total: Total file size in bytes (None if unknown)
    """
    data = {
        'stage': stage,
        'progress': 0.0,
        'timestamp': int(time.time() * 1000),
    }

    if total is not None:
        data['total'] = total

    write_progress_file(data)


def update_progress_file(
    stage: str,
    progress: float,
    downloaded: Optional[int] = None,
    total: Optional[int] = None,
    speed: Optional[int] = None,
    error: Optional[str] = None
) -> None:
    """Update progress file with current status.

    Args:
        stage: Current stage
        progress: Progress within stage (0.0 to 1.0)
        downloaded: Bytes downloaded so far
        total: Total bytes to download
        speed: Download speed in bytes/sec
        error: Error message if failed
    """
    data: Dict[str, Any] = {
        'stage': stage,
        'progress': max(0.0, min(1.0, progress)),
        'timestamp': int(time.time() * 1000),
    }

    if downloaded is not None:
        data['downloaded'] = downloaded

    if total is not None:
        data['total'] = total

    if speed is not None and speed > 0:
        data['speed'] = speed

        # Calculate ETA if we have downloaded and total
        if downloaded is not None and total is not None and downloaded < total:
            remaining = total - downloaded
            eta_seconds = int(remaining / speed)
            data['eta'] = eta_seconds

    if error:
        data['error'] = error

    write_progress_file(data)


def write_progress_file(data: Dict[str, Any]) -> None:
    """Atomically write progress data to file.

    Uses temporary file + rename for atomic update.
    """
    try:
        # Write to temporary file first
        temp_file = PROGRESS_FILE.with_suffix('.tmp')

        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())

        # Atomic rename
        os.replace(temp_file, PROGRESS_FILE)
    except OSError:
        # Failure to write progress should not block the actual download
        pass


def clear_progress_file() -> None:
    """Remove progress file after completion or cancellation."""
    try:
        if PROGRESS_FILE.exists():
            PROGRESS_FILE.unlink()
    except OSError:
        pass
