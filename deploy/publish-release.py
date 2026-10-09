"""Publish complete deployment assets only after the workflow's required jobs pass."""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def gh(*arguments, check=True):
    result = subprocess.run(['gh', *arguments], capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result


directory = Path(sys.argv[1] if len(sys.argv) > 1 else 'output/release')
manifest = json.loads((directory / 'release-manifest.json').read_text())
repository, commit, tag = manifest['repository'], manifest['commit'], manifest['tag']
if repository != os.environ['GITHUB_REPOSITORY'] or commit != os.environ['GITHUB_SHA'] or tag != 'deploy-' + commit:
    raise ValueError('Release identity does not match this workflow')
assets = sorted({entry['file'] for entry in manifest['artifacts'].values()})
for entry in manifest['artifacts'].values():
    if hashlib.sha256((directory / entry['file']).read_bytes()).hexdigest() != entry['sha256']:
        raise ValueError('Artifact hash mismatch')
def find_release():
    # gh resolves unpublished drafts as well as public tags.
    result = gh('release', 'view', tag, '--repo', repository, '--json', 'isDraft,assets', check=False)
    if result.returncode:
        if 'not found' in result.stderr.lower() or '404' in result.stderr:
            return None
        raise RuntimeError(result.stderr)
    data = json.loads(result.stdout)
    return {'draft': data['isDraft'], 'assets': data['assets']}


release = find_release()
if release:
    if not release['draft']:
        with tempfile.TemporaryDirectory() as temporary:
            gh('release', 'download', tag, '--repo', repository, '--pattern', 'release-manifest.json', '--dir', temporary)
            if json.loads((Path(temporary) / 'release-manifest.json').read_text()) != manifest:
                raise ValueError('Published release differs; refusing to overwrite it')
        expected = set(assets + ['release-manifest.json'])
        if not expected <= {asset['name'] for asset in release['assets']}:
            raise ValueError('Published release is incomplete; refusing to modify it')
        print('Identical deployment release already published; skipped.')
        sys.exit(0)
else:
    gh('release', 'create', tag, '--repo', repository, '--target', commit, '--draft', '--title', f'Candidate {commit[:12]}',
       '--notes', f'CI-verified deployment packages for commit {commit}. Existing configuration and data remain on the server.')
# Each synchronous upload must finish before publication. Do not re-read a
# potentially cached REST release list immediately after creating a draft.
for name in assets + ['release-manifest.json']:
    gh('release', 'upload', tag, '--repo', repository, '--clobber', str(directory / name))
# CI publishes candidates only. Stable promotion is a separate explicit workflow.
gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=true', '--latest=false')
print('Published CI candidate (not a stable update): ' + tag)
