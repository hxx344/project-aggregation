"""Digest the pnpm inputs that determine one importer's installed build closure.

The source installer runs this as root with ``python3 -I -c`` on the bytes stored
in the pinned commit, never on a copy in a build tree. It reads only Git blobs of
that commit and imports nothing outside the standard library. Any lockfile or
workspace shape it does not fully recognize exits non-zero, and the installer
then keeps the conservative whole-workspace dependency key.

Known gap: a closure package that requires a dependency it never declared (not a
peer) resolves it through pnpm's hoisted virtual store, whose chosen version any
importer can change. Covering that would put every version of every closure
name into each key, so a root-only addition such as ethers (which brings its own
tslib/ws) would rebuild every module again. The modules' own sources import only
declared packages; an undeclared one inside a dependency is left uncovered.

Usage: pnpm-module-inputs.py GIT_DIR COMMIT IMPORTER...
Prints one "IMPORTER DIGEST" line per requested importer.
"""
import hashlib
import json
import re
import subprocess
import sys

FORMAT = 'pnpm-module-inputs-v1'
# Workspace-level inputs of the frozen install. Root dependency maps and other
# importers' manifests reach a module only through the lockfile, which is
# narrowed to that importer's closure below.
SHARED_FILES = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'scripts/install-hooks.mjs')
DEPENDENCY_GROUPS = ('dependencies', 'devDependencies', 'optionalDependencies')
# Root scripts pnpm runs while installing; other root scripts never run there.
INSTALL_SCRIPTS = frozenset(('pnpm:devPreinstall', 'preinstall', 'install', 'postinstall',
                             'preprepare', 'prepare', 'postprepare'))
SNAPSHOT_EDGES = ('dependencies', 'optionalDependencies')
SNAPSHOT_FIELDS = frozenset((*SNAPSHOT_EDGES, 'transitivePeerDependencies', 'optional'))
# Catalogs only choose specifiers. The resolved versions are in each importer's
# lock entry, and a frozen install rejects a catalog the lockfile disagrees with.
CATALOG_SECTIONS = frozenset(('catalog', 'catalogs'))
CLOSURE_SECTIONS = frozenset(('importers', 'packages', 'snapshots'))
PLAIN_START = re.compile(r'''[^\s\-?:,\[\]{}#&*!|>'"%@`]''')
WORKSPACE_KEY = re.compile(r'''(?:[A-Za-z0-9_-]+|'[^']*'|"[^"\\]*"):(?:\s|$)''')
YAML_ALIAS = re.compile(r'''(?:^|[\s\[{,])\*[^\s,\[\]{}]''')


class InputError(Exception):
    pass


def quoted_end(text):
    quote, index = text[0], 1
    while index < len(text):
        if quote == '"' and text[index] == '\\':
            index += 2
            continue
        if text[index] == quote:
            if quote == "'" and text[index + 1:index + 2] == "'":
                index += 2
                continue
            return index + 1
        index += 1
    raise InputError('Unterminated quoted scalar: ' + text)


def scalar(text):
    if text[:1] == "'":
        if quoted_end(text) != len(text):
            raise InputError('Unsupported quoted scalar: ' + text)
        return text[1:-1].replace("''", "'")
    if text[:1] == '"':
        try:
            value = json.loads(text)
        except ValueError as error:
            raise InputError('Unsupported quoted scalar: ' + text) from error
        if not isinstance(value, str) or quoted_end(text) != len(text):
            raise InputError('Unsupported quoted scalar: ' + text)
        return value
    if not PLAIN_START.match(text) or ' #' in text or ': ' in text or text.endswith((':', ' ')):
        raise InputError('Unsupported plain scalar: ' + text)
    return text


def entry(content):
    """Split one block-mapping line into its key and inline value (None for a nested block)."""
    if content[:1] in ("'", '"'):
        end = quoted_end(content)
        key, rest = content[:end], content[end:]
        if rest == ':':
            return scalar(key), None
        if rest.startswith(': '):
            return scalar(key), rest[2:]
        raise InputError('Unsupported lockfile line: ' + content)
    position = content.find(': ')
    if position >= 0:
        return scalar(content[:position]), content[position + 2:]
    if content.endswith(':'):
        return scalar(content[:-1]), None
    raise InputError('Unsupported lockfile line: ' + content)


def indented(lines):
    result = []
    for line in lines:
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(' '))
        if indent % 2:
            raise InputError('Unsupported lockfile indentation: ' + line)
        result.append((indent, line[indent:]))
    return result


def parse_block(lines, start, indent):
    """Parse pnpm's block style: nested mappings, scalar leaves, {} and scalar sequences."""
    if lines[start][1].startswith('- '):
        items, index = [], start
        while index < len(lines) and lines[index][0] == indent and lines[index][1].startswith('- '):
            items.append(scalar(lines[index][1][2:]))
            index += 1
        if index < len(lines) and lines[index][0] > indent:
            raise InputError('Unsupported nested lockfile sequence')
        return items, index
    mapping, index = {}, start
    while index < len(lines) and lines[index][0] == indent:
        key, value = entry(lines[index][1])
        if key in mapping:
            raise InputError('Duplicate lockfile key: ' + key)
        index += 1
        nested = index < len(lines) and lines[index][0] > indent
        if value is None:
            if not nested or lines[index][0] != indent + 2:
                raise InputError('Unsupported lockfile value: ' + key)
            mapping[key], index = parse_block(lines, index, indent + 2)
        elif nested:
            raise InputError('Unsupported lockfile value: ' + key)
        else:
            mapping[key] = {} if value == '{}' else scalar(value)
    if index < len(lines) and lines[index][0] > indent:
        raise InputError('Unsupported lockfile indentation')
    return mapping, index


def split_sections(text):
    if '\r' in text or '\t' in text:
        raise InputError('Unsupported lockfile whitespace')
    sections, current = {}, None
    for line in text.split('\n'):
        if not line.strip():
            continue
        if line[0] != ' ':
            key, value = entry(line)
            if key in sections:
                raise InputError('Duplicate lockfile section: ' + key)
            current = sections[key] = {'value': value, 'lines': [line]}
        elif current is None or current['value'] is not None:
            raise InputError('Unsupported lockfile layout: ' + line)
        else:
            current['lines'].append(line)
    return sections


def split_entries(section, name):
    """Map each two-space entry of a closure section to its raw lines and parsed body."""
    if section is None or section['value'] == '{}':
        return {}
    if section['value'] is not None:
        raise InputError('Unsupported lockfile section: ' + name)
    entries, current = {}, None
    for line in section['lines'][1:]:
        indent = len(line) - len(line.lstrip(' '))
        if indent == 2:
            key, value = entry(line[2:])
            if key in entries:
                raise InputError('Duplicate ' + name + ' entry: ' + key)
            if value not in (None, '{}'):
                raise InputError('Unsupported ' + name + ' entry: ' + key)
            current = entries[key] = {'empty': value == '{}', 'lines': [line]}
        elif indent > 2 and current is not None and not current['empty']:
            current['lines'].append(line)
        else:
            raise InputError('Unsupported ' + name + ' layout: ' + line)
    return entries


def body(item):
    if item['empty']:
        return {}
    lines = indented(item['lines'][1:])
    if not lines or lines[0][0] != 4:
        raise InputError('Unsupported lockfile entry: ' + item['lines'][0])
    value, index = parse_block(lines, 0, 4)
    if index != len(lines) or not isinstance(value, dict):
        raise InputError('Unsupported lockfile entry: ' + item['lines'][0])
    return value


def raw(item):
    return '\n'.join(line for line in item['lines'] if line.strip())


def peer_groups(key):
    groups, depth, start = [], 0, 0
    for index, character in enumerate(key):
        if character == '(':
            if depth == 0:
                start = index + 1
            depth += 1
        elif character == ')':
            depth -= 1
            if depth < 0:
                raise InputError('Unbalanced snapshot key: ' + key)
            if depth == 0:
                groups.append(key[start:index])
    if depth:
        raise InputError('Unbalanced snapshot key: ' + key)
    return groups


class Lockfile:
    def __init__(self, text):
        self.sections = split_sections(text)
        version = self.sections.get('lockfileVersion', {}).get('value')
        if version is None or scalar(version) != '9.0':
            raise InputError('Unsupported pnpm lockfile; expected lockfileVersion 9.0')
        self.importers = split_entries(self.sections.get('importers'), 'importers')
        self.packages = split_entries(self.sections.get('packages'), 'packages')
        self.snapshots = split_entries(self.sections.get('snapshots'), 'snapshots')
        self.edges = {}
        self.dependencies = {}

    def settings(self):
        # Overrides, settings, patches, pnpmfile checksum and anything unknown
        # apply to the whole install, so every importer keeps them.
        return {name: raw(section) for name, section in self.sections.items()
                if name not in CLOSURE_SECTIONS and name not in CATALOG_SECTIONS}

    def resolve(self, name, reference):
        # Same identity rule as deploy/package-release.py: "name@ref", or the
        # reference itself for npm: aliases. Local links and files are sources
        # outside the module tree, so they are not narrowed.
        if not isinstance(reference, str) or re.search(r'(?:^|@)(?:link|file|workspace):', reference):
            raise InputError('Unsupported local dependency: ' + name + ' ' + str(reference))
        key = name + '@' + reference
        if key not in self.snapshots:
            key = reference
        if key not in self.snapshots:
            raise InputError('Missing lockfile snapshot: ' + name + '@' + reference)
        return key

    def snapshot_edges(self, key):
        if key not in self.edges:
            unknown = set(body(self.snapshots[key])) - SNAPSHOT_FIELDS
            if unknown:
                raise InputError('Unsupported snapshot field: ' + key + ': ' + ', '.join(sorted(unknown)))
            targets = [self.resolve(name, reference) for name, reference in self.snapshot_dependencies(key)]
            # Resolved peers are also edges; keep any that name a snapshot.
            targets.extend(group for group in peer_groups(key) if group in self.snapshots)
            self.edges[key] = targets
        return self.edges[key]

    def importer_dependencies(self, importer):
        groups = body(self.importers[importer])
        unknown = set(groups) - set(DEPENDENCY_GROUPS)
        if unknown:
            raise InputError('Unsupported importer field: ' + importer + ': ' + ', '.join(sorted(unknown)))
        result = []
        for group in DEPENDENCY_GROUPS:
            dependencies = groups.get(group, {})
            if not isinstance(dependencies, dict):
                raise InputError('Unsupported importer dependencies: ' + importer)
            for name, locked in sorted(dependencies.items()):
                if not isinstance(locked, dict) or 'version' not in locked or set(locked) - {'specifier', 'version'}:
                    raise InputError('Unsupported importer dependency: ' + importer + '/' + name)
                result.append((name, locked['version']))
        return result

    def snapshot_dependencies(self, key):
        if key not in self.dependencies:
            fields = body(self.snapshots[key])
            result = []
            for group in SNAPSHOT_EDGES:
                dependencies = fields.get(group, {})
                if not isinstance(dependencies, dict):
                    raise InputError('Unsupported snapshot dependencies: ' + key)
                result.extend(sorted(dependencies.items()))
            self.dependencies[key] = result
        return self.dependencies[key]

    def peer_names(self, base):
        """Names in a package's peerDependencies; only that field of the entry is parsed."""
        lines = indented(self.packages[base]['lines'][1:])
        for index, (indent, content) in enumerate(lines):
            if indent != 4 or not content.startswith('peerDependencies:'):
                continue
            key, value = entry(content)
            if key != 'peerDependencies':
                continue
            if value == '{}':
                return set()
            if value is not None or index + 1 >= len(lines) or lines[index + 1][0] != 6:
                raise InputError('Unsupported peerDependencies: ' + base)
            end = index + 1
            while end < len(lines) and lines[end][0] > 4:
                end += 1
            peers, consumed = parse_block(lines[index + 1:end], 0, 6)
            if consumed != end - index - 1 or not isinstance(peers, dict):
                raise InputError('Unsupported peerDependencies: ' + base)
            return set(peers)
        return set()

    def unresolved_peers(self, keys):
        """Every candidate a closure package can reach for a peer its snapshot leaves unresolved.

        Node resolves such a peer through pnpm's hoisted virtual store or the root
        node_modules, which any importer can change. Keep, for each such name, all
        locked versions and every importer or snapshot edge that uses that name.
        """
        names = set()
        for key in keys:
            resolved = {name for name, _ in self.snapshot_dependencies(key)}
            names.update(self.peer_names(key.split('(', 1)[0]) - resolved)
        if not names:
            return {}
        candidates = {name: set() for name in names}
        for key in self.snapshots:
            base = key.split('(', 1)[0]
            name = base[:base.rindex('@')] if base.rfind('@') > 0 else base
            if name in candidates:
                base_package = self.packages.get(base)
                candidates[name].add('snapshot ' + key + '\n' + raw(self.snapshots[key])
                                     + ('\n' + raw(base_package) if base_package else ''))
            for edge, reference in self.snapshot_dependencies(key):
                if edge in candidates:
                    candidates[edge].add('edge ' + key + ' ' + reference)
        for importer in self.importers:
            for edge, reference in self.importer_dependencies(importer):
                if edge in candidates:
                    candidates[edge].add('importer ' + importer + ' ' + reference)
        return {name: sorted(values) for name, values in candidates.items()}

    def closure(self, importer):
        if importer not in self.importers:
            raise InputError('Missing lockfile importer: ' + importer)
        pending = [self.resolve(name, reference) for name, reference in self.importer_dependencies(importer)]
        seen = set()
        while pending:
            key = pending.pop()
            if key in seen:
                continue
            seen.add(key)
            pending.extend(self.snapshot_edges(key))
        snapshots, packages = {}, {}
        for key in seen:
            base = key.split('(', 1)[0]
            if base not in self.packages:
                raise InputError('Missing lockfile package: ' + base)
            snapshots[key] = raw(self.snapshots[key])
            packages[base] = raw(self.packages[base])
        return {'importer': raw(self.importers[importer]), 'snapshots': snapshots, 'packages': packages,
                'unresolved-peers': self.unresolved_peers(seen)}


def workspace_settings(text):
    """Keep pnpm-workspace.yaml except catalogs; fall back to the whole file on any unusual shape."""
    if text is None:
        return None
    blocks, current = [], None
    for line in text.split('\n'):
        if line[:1] not in ('', ' ', '#'):
            match = WORKSPACE_KEY.match(line)
            if not match:
                return {'complete': text}
            name = line[:match.end()].rstrip().rstrip(':').strip('\'"')
            current = [name, [line]]
            blocks.append(current)
        elif current is None:
            current = ['', [line]]
            blocks.append(current)
        else:
            current[1].append(line)
    kept = '\n'.join(line for name, lines in blocks if name not in CATALOG_SECTIONS for line in lines)
    # A kept setting could alias an anchor defined inside a dropped catalog.
    if YAML_ALIAS.search(kept) or '\t' in text or '\r' in text:
        return {'complete': text}
    return {'without-catalogs': kept}


def root_manifest(text):
    manifest = json.loads(text)
    if not isinstance(manifest, dict):
        raise InputError('Root package.json is not an object')
    for group in DEPENDENCY_GROUPS:
        manifest.pop(group, None)
    scripts = manifest.get('scripts')
    if isinstance(scripts, dict):
        manifest['scripts'] = {name: value for name, value in scripts.items() if name in INSTALL_SCRIPTS}
    return manifest


def git(git_dir, *arguments):
    return subprocess.run(['git', '--git-dir=' + git_dir, *arguments], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, check=True).stdout


def read_files(git_dir, commit, paths):
    if not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', commit):
        raise InputError('Source must be a full commit id')
    files = {}
    for record in git(git_dir, 'ls-tree', '-z', '--full-tree', commit, '--', *paths).split(b'\0'):
        if not record:
            continue
        meta, _, path = record.partition(b'\t')
        mode, kind, object_id = meta.decode('ascii').split(' ')
        path = path.decode('utf-8')
        if kind != 'blob' or mode not in ('100644', '100755') or path not in paths:
            raise InputError('Dependency input must be a regular file: ' + path)
        files[path] = git(git_dir, 'cat-file', 'blob', object_id).decode('utf-8')
    return files


def digests(files, importers):
    if 'package.json' not in files or 'pnpm-lock.yaml' not in files:
        raise InputError('Missing pnpm workspace install inputs')
    lock = Lockfile(files['pnpm-lock.yaml'])
    shared = {
        'format': FORMAT,
        'lock-settings': lock.settings(),
        'workspace': workspace_settings(files.get('pnpm-workspace.yaml')),
        'npmrc': files.get('.npmrc'),
        'root-manifest': root_manifest(files['package.json']),
        'install-hooks': files.get('scripts/install-hooks.mjs'),
    }
    result = {}
    for importer in importers:
        payload = dict(shared, closure=lock.closure(importer))
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        result[importer] = hashlib.sha256(encoded).hexdigest()
    return result


def main(arguments):
    if len(arguments) < 3:
        print(__doc__.strip().splitlines()[-2], file=sys.stderr)
        return 2
    git_dir, commit, importers = arguments[0], arguments[1], arguments[2:]
    try:
        result = digests(read_files(git_dir, commit, SHARED_FILES), importers)
    except (InputError, ValueError, OSError, subprocess.CalledProcessError) as error:
        print('pnpm-module-inputs: ' + str(error)[:300], file=sys.stderr)
        return 1
    for importer in importers:
        print(importer, result[importer])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
