"""Validate the deployment server's x64 manifest before publication."""
import json
import sys
from pathlib import Path

directory = Path(sys.argv[1] if len(sys.argv) > 1 else 'output/release')
manifest = json.loads((directory / 'release-manifest-x64.json').read_text(encoding='utf-8'))
if set(manifest['artifacts']) != {'linux-x64'}:
    raise ValueError('Expected exactly the deployment server architecture: linux-x64')
(directory / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
