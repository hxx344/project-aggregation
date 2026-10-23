"""Merge only explicitly requested architectures; default remains Linux x64."""
import argparse
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', nargs='?', type=Path, default=Path('output/release'))
parser.add_argument('--architectures', nargs='+', choices=('x64', 'arm64'), default=['x64'])
args = parser.parse_args()
directory = args.directory.resolve()
merged = None
for architecture in dict.fromkeys(args.architectures):
    manifest = json.loads((directory / f'release-manifest-{architecture}.json').read_text(encoding='utf-8'))
    if (manifest.get('schema') != 1 or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('commit', ''))
            or manifest.get('tag') != 'deploy-' + manifest['commit']
            or set(manifest.get('artifacts', {})) != {'linux-' + architecture}):
        raise ValueError('Invalid release identity or architecture: ' + architecture)
    entry = manifest['artifacts']['linux-' + architecture]
    filename = entry.get('file', '')
    if not filename or '/' in filename or '\\' in filename or Path(filename).name != filename:
        raise ValueError('Artifact must be a filename within the release directory')
    artifact = directory / filename
    if artifact.resolve().parent != directory or not artifact.is_file():
        raise ValueError('Missing artifact or artifact outside release directory')
    if hashlib.new('sha256', artifact.read_bytes()).hexdigest() != entry.get('sha256'):
        raise ValueError('Artifact hash mismatch: ' + filename)
    if merged is None:
        merged = {**manifest, 'artifacts': {}}
    if {k: v for k, v in merged.items() if k != 'artifacts'} != {
            k: v for k, v in manifest.items() if k != 'artifacts'}:
        raise ValueError('Release manifests have different identities')
    merged['artifacts'].update(manifest['artifacts'])
temporary = directory / 'release-manifest.json.tmp'
temporary.write_text(json.dumps(merged, indent=2) + '\n', encoding='utf-8')
temporary.replace(directory / 'release-manifest.json')
