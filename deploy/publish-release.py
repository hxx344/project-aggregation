"""Publish complete deployment assets only after the workflow's required jobs pass."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def gh(*arguments, check=True):
    return subprocess.run(['gh', *arguments], check=check, capture_output=True, text=True)


directory = Path(sys.argv[1] if len(sys.argv) > 1 else 'output/release')
manifest = json.loads((directory / 'release-manifest.json').read_text())
repository, commit, tag = manifest['repository'], manifest['commit'], manifest['tag']
if repository != os.environ['GITHUB_REPOSITORY'] or commit != os.environ['GITHUB_SHA'] or tag != 'deploy-' + commit:
    raise ValueError('Release identity does not match this workflow')
assets = sorted({entry['file'] for entry in manifest['artifacts'].values()})
for entry in manifest['artifacts'].values():
    if hashlib.sha256((directory / entry['file']).read_bytes()).hexdigest() != entry['sha256']:
        raise ValueError('Artifact hash mismatch')
head = json.loads(gh('api', f'repos/{repository}/git/ref/heads/main').stdout)['object']['sha']
if head != commit:
    print('A newer main commit exists; leaving the latest deployment release unchanged.')
    sys.exit(0)
existing = gh('api', f'repos/{repository}/releases/tags/{tag}', check=False)
if existing.returncode == 0:
    release = json.loads(existing.stdout)
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
    gh('release', 'upload', tag, '--repo', repository, '--clobber', *[str(directory / name) for name in assets + ['release-manifest.json']])
elif '404' in existing.stderr:
    gh('release', 'create', tag, '--repo', repository, '--target', commit, '--draft', '--title', f'Deployment {commit[:12]}',
       '--notes', f'CI-verified deployment packages for commit {commit}. Existing configuration and data remain on the server.',
       *[str(directory / name) for name in assets + ['release-manifest.json']])
else:
    raise RuntimeError(existing.stderr)
release = json.loads(gh('api', f'repos/{repository}/releases/tags/{tag}').stdout)
if not set(assets + ['release-manifest.json']) <= {asset['name'] for asset in release['assets']}:
    raise ValueError('Draft is missing an asset')
head = json.loads(gh('api', f'repos/{repository}/git/ref/heads/main').stdout)['object']['sha']
if head != commit:
    print('Newer main commit detected before publication; draft retained, latest unchanged.')
    sys.exit(0)
gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--latest')
print('Published complete deployment release: ' + tag)
