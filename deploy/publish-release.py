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
    # The by-tag endpoint can return 404 for drafts whose tag is not published.
    pages = json.loads(gh('api', '--paginate', '--slurp', f'repos/{repository}/releases?per_page=100').stdout)
    return next((release for page in pages for release in page if release['tag_name'] == tag), None)


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
    gh('release', 'upload', tag, '--repo', repository, '--clobber', *[str(directory / name) for name in assets + ['release-manifest.json']])
else:
    gh('release', 'create', tag, '--repo', repository, '--target', commit, '--draft', '--title', f'Deployment {commit[:12]}',
       '--notes', f'CI-verified deployment packages for commit {commit}. Existing configuration and data remain on the server.',
       *[str(directory / name) for name in assets + ['release-manifest.json']])
release = find_release()
if not release or not release['draft']:
    raise ValueError('Expected the complete deployment draft before publication')
if not set(assets + ['release-manifest.json']) <= {asset['name'] for asset in release['assets']}:
    raise ValueError('Draft is missing an asset')
# Jobs share a repository-wide publication lock. A later failing main build must
# not suppress this verified release, nor may an older job move latest backwards.
latest = gh('api', f'repos/{repository}/releases/latest', check=False)
promote = True
if latest.returncode == 0:
    latest_tag = json.loads(latest.stdout)['tag_name']
    if not re.fullmatch(r'deploy-[a-f0-9]{40}', latest_tag):
        raise ValueError('Latest release is outside the deployment channel')
    previous = latest_tag.removeprefix('deploy-')
    comparison = json.loads(gh('api', f'repos/{repository}/compare/{previous}...{commit}').stdout)
    promote = comparison['status'] in ('ahead', 'identical')
elif '404' not in latest.stderr:
    raise RuntimeError(latest.stderr)
gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--latest=' + str(promote).lower())
print('Published complete deployment release: ' + tag)
