"""Publish complete deployment assets only after the workflow's required jobs pass."""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


# Keep in step with validNote() in scripts/review-message.mjs.
NOTE_LABEL = re.compile(r'^更新说明[ \t]*[:：][ \t]*')
NOTE_END = re.compile(r'^(?:风险等级|已运行|未运行|待确认|独立审查|回滚)[ \t]*[:：]')
CHINESE = re.compile(r'[\u3400-\u9fff]')
FALLBACK_NOTES = '内部维护与稳定性改进，使用方式无变化。'


def user_notes(message):
    """Only the commit's Chinese user-facing section reaches the update dialog."""
    lines = message.splitlines()
    starts = [index for index, line in enumerate(lines) if NOTE_LABEL.match(line)]
    if len(starts) != 1:
        return FALLBACK_NOTES
    section = [NOTE_LABEL.sub('', lines[starts[0]], count=1)]
    for line in lines[starts[0] + 1:]:
        if not line.strip() or NOTE_END.match(line):
            break
        section.append(line)
    note = '\n'.join(line.strip() for line in section if line.strip())
    return note if CHINESE.search(note) else FALLBACK_NOTES


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

# Read only the verified release commit; its English subject and review evidence stay out of the notes.
message = subprocess.run(['git', 'log', '-1', '--format=%B', commit], capture_output=True,
                         text=True, encoding='utf-8', shell=False, check=True).stdout.rstrip('\r\n')
if not message.strip():
    raise ValueError('Release commit has no update description')
notes = user_notes(message) + '\n'
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
