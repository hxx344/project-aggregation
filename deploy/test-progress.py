#!/usr/bin/env python3
"""Tests for update progress tracking and SSE streaming."""
import json
import sys
import tempfile
import time
from pathlib import Path

# Test needs the progress module
sys.path.insert(0, str(Path(__file__).parent.parent / 'server' / 'update-service'))

from progress import get_progress, PROGRESS_FILE, PROGRESS_TIMEOUT


def test_progress_file_parsing():
    """Test reading and validating progress file."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        test_file = Path(f.name)

        # Valid progress data
        data = {
            'stage': 'download',
            'progress': 0.45,
            'downloaded': 48952341,
            'total': 108630372,
            'speed': 2457600,
            'eta': 24,
            'timestamp': int(time.time() * 1000)
        }
        json.dump(data, f)

    # Temporarily replace PROGRESS_FILE
    import progress
    original_file = progress.PROGRESS_FILE
    progress.PROGRESS_FILE = test_file

    try:
        result = get_progress()
        assert result is not None
        assert result['stage'] == 'download'
        assert result['progress'] == 0.45
        assert result['downloaded'] == 48952341
        assert result['total'] == 108630372
        assert result['speed'] == 2457600
        assert result['eta'] == 24
    finally:
        progress.PROGRESS_FILE = original_file
        test_file.unlink()


def test_progress_timeout_detection():
    """Test that old progress data is marked as timed out."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        test_file = Path(f.name)

        # Old timestamp (6 minutes ago)
        old_time = int((time.time() - 360) * 1000)
        data = {
            'stage': 'download',
            'progress': 0.5,
            'timestamp': old_time
        }
        json.dump(data, f)

    import progress
    original_file = progress.PROGRESS_FILE
    progress.PROGRESS_FILE = test_file

    try:
        result = get_progress()
        assert result is not None
        assert 'error' in result
        assert 'timeout' in result['error'].lower()
    finally:
        progress.PROGRESS_FILE = original_file
        test_file.unlink()


def test_missing_progress_file():
    """Test handling of missing progress file."""
    import progress
    original_file = progress.PROGRESS_FILE
    progress.PROGRESS_FILE = Path('/nonexistent/progress.json')

    try:
        result = get_progress()
        assert result is None
    finally:
        progress.PROGRESS_FILE = original_file


def test_invalid_json():
    """Test handling of corrupted progress file."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        test_file = Path(f.name)
        f.write('{ invalid json }')

    import progress
    original_file = progress.PROGRESS_FILE
    progress.PROGRESS_FILE = test_file

    try:
        result = get_progress()
        assert result is not None
        assert 'error' in result
    finally:
        progress.PROGRESS_FILE = original_file
        test_file.unlink()


def test_all_stages():
    """Test progress data for all stages."""
    stages = ['preflight', 'download', 'verify', 'extract', 'switch']

    for stage in stages:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            test_file = Path(f.name)
            data = {
                'stage': stage,
                'progress': 0.5,
                'timestamp': int(time.time() * 1000)
            }
            json.dump(data, f)

        import progress
        original_file = progress.PROGRESS_FILE
        progress.PROGRESS_FILE = test_file

        try:
            result = get_progress()
            assert result is not None
            assert result['stage'] == stage
            assert result['progress'] == 0.5
        finally:
            progress.PROGRESS_FILE = original_file
            test_file.unlink()


if __name__ == '__main__':
    test_progress_file_parsing()
    test_progress_timeout_detection()
    test_missing_progress_file()
    test_invalid_json()
    test_all_stages()
    print('[PASS] All progress tests passed')
