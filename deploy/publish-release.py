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
if (repository != os.environ['GITHUB_REPOSITORY'] or commit != os.environ['GITHUB_SHA'] or
        not re.fullmatch(r'[a-f0-9]{40}', commit) or tag != 'deploy-' + commit):
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

# Read only the verified release commit, including its subject and multiline body.
message = subprocess.run(['git', 'log', '-1', '--format=%B', commit], capture_output=True,
                         text=True, encoding='utf-8', shell=False, check=True).stdout.rstrip('\r\n')
if not message.strip():
    raise ValueError('Release commit has no update description')
notes = (f'{message}\n\n发布提交：{commit}\n'
         '此说明来自该发布提交的标题与正文，不是跨版本累计变更。\n\n'
         '部署说明：部署包已通过 CI 验证，更新时保留服务器已有配置与数据。\n')
with tempfile.TemporaryDirectory(prefix='candidate-notes-') as temporary:
    notes_file = Path(temporary) / 'release-notes.txt'
    notes_file.write_text(notes, encoding='utf-8', newline='\n')
    if not release:
        gh('release', 'create', tag, '--repo', repository, '--target', commit, '--draft', '--title', f'Candidate {commit[:12]}',
           '--notes-file', str(notes_file))
    # Each synchronous upload must finish before publication. Do not re-read a
    # potentially cached REST release list immediately after creating a draft.
    for name in assets + ['release-manifest.json']:
        gh('release', 'upload', tag, '--repo', repository, '--clobber', str(directory / name))
    # Refresh notes on draft retries too. Public releases take the early exit above.
    # CI publishes candidates only. Stable promotion is a separate explicit workflow.
    gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=true', '--latest=false',
       '--notes-file', str(notes_file))
print('Published CI candidate (not a stable update): ' + tag)
