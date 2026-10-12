"""Join separately verified native architecture manifests before publication."""
import json
import sys
from pathlib import Path

directory = Path(sys.argv[1] if len(sys.argv) > 1 else 'output/release')
merged = None
for architecture in ('x64', 'arm64'):
    current = json.loads((directory / f'release-manifest-{architecture}.json').read_text())
    if set(current['artifacts']) != {'linux-' + architecture}:
        raise ValueError('Unexpected architecture manifest')
    identity = {key: value for key, value in current.items() if key != 'artifacts'}
    if merged is None:
        merged = {**identity, 'artifacts': {}}
    elif identity != {key: value for key, value in merged.items() if key != 'artifacts'}:
        raise ValueError('Architecture builds are from different releases')
    merged['artifacts'].update(current['artifacts'])
(directory / 'release-manifest.json').write_text(json.dumps(merged, indent=2) + '\n')
