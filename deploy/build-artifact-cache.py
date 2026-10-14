"""Data-only build output cache. The caller owns permissions, freezing and locks.

The cache contains exactly manifest.json and artifact/. A key names all build
inputs and their environment; it is supplied by the installer, not calculated
from these outputs. No cached content is imported, evaluated or executed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile


SCHEMA = 1
NEXT_EXCLUDED = frozenset({'cache', 'standalone'})
MAX_MANIFEST_BYTES = 64 * 1024 * 1024


class CacheError(ValueError):
    pass


def checked_key(value):
    if not isinstance(value, str) or re.fullmatch(r'[0-9a-fA-F]{64}', value) is None:
        raise CacheError('key must contain exactly 64 hexadecimal characters')
    return value.lower()


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, 'st_file_attributes', 0)
        & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def checked_path(value, *, missing=False, directory=None):
    """Check every component without resolving links or normalizing away '..'."""
    path = Path(value)
    if '..' in path.parts:
        raise CacheError('parent traversal is forbidden: ' + repr(str(path)))
    path = Path(os.path.abspath(path))
    current = Path(path.anchor)
    components = [current]
    for part in path.parts[1:]:
        current /= part
        components.append(current)
    for index, component in enumerate(components):
        final = index == len(components) - 1
        try:
            info = component.lstat()
        except FileNotFoundError:
            if missing and final:
                return path, None
            raise CacheError('missing path: ' + repr(str(component))) from None
        if is_link(info):
            raise CacheError('link or reparse point is forbidden: ' + repr(str(component)))
        if not final or directory is True:
            if not stat.S_ISDIR(info.st_mode):
                raise CacheError('expected directory: ' + repr(str(component)))
        elif directory is False:
            if not stat.S_ISREG(info.st_mode):
                raise CacheError('expected regular file: ' + repr(str(component)))
        elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise CacheError('special file is forbidden: ' + repr(str(component)))
    return path, info


def checked_relative(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or '\0' in value:
        raise CacheError('invalid relative artifact path: ' + repr(value))
    if any(part in ('', '.', '..') for part in value.split('/')):
        raise CacheError('invalid relative artifact path: ' + repr(value))
    return value


def same_file(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def file_stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def open_regular(path, *, create=False):
    """Use no-follow directory descriptors on POSIX as well as lstat checks.

    Windows has no equivalent dir_fd API. The installer must keep parents
    trusted and stable for the operation on both platforms.
    """
    path, before = checked_path(path, missing=create, directory=False)
    if create and before is not None:
        raise CacheError('refusing to overwrite existing file: ' + repr(str(path)))
    flags = ((os.O_WRONLY | os.O_CREAT | os.O_EXCL) if create else os.O_RDONLY)
    flags |= getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    if not create:
        flags |= getattr(os, 'O_NONBLOCK', 0)
    directory_fd = None
    descriptor = None
    try:
        if os.open in os.supports_dir_fd and hasattr(os, 'O_NOFOLLOW'):
            directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            directory_fd = os.open(path.anchor, directory_flags)
            for part in path.parts[1:-1]:
                next_fd = os.open(part, directory_flags, dir_fd=directory_fd)
                os.close(directory_fd)
                directory_fd = next_fd
            descriptor = os.open(path.name, flags, 0o600, dir_fd=directory_fd)
        else:
            descriptor = os.open(path, flags, 0o600)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or is_link(opened):
            raise CacheError('expected regular file: ' + repr(str(path)))
        if opened.st_nlink != 1:
            raise CacheError('hard-linked file is forbidden: ' + repr(str(path)))
        _, after = checked_path(path, directory=False)
        if not same_file(opened, after) or (before is not None and file_stamp(before) != file_stamp(opened)):
            raise CacheError('file changed while opening: ' + repr(str(path)))
        stream = os.fdopen(descriptor, 'wb' if create else 'rb')
        descriptor = None
        return stream
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if directory_fd is not None:
            os.close(directory_fd)


def read_record(path, relative, destination=None):
    digest = hashlib.sha256()
    size = 0
    with open_regular(path) as source:
        before = os.fstat(source.fileno())
        while True:
            block = source.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
            size += len(block)
            if destination is not None:
                destination.write(block)
        after = os.fstat(source.fileno())
    _, current = checked_path(path, directory=False)
    if file_stamp(before) != file_stamp(after) or file_stamp(after) != file_stamp(current) or size != after.st_size:
        raise CacheError('file changed while reading: ' + repr(str(path)))
    return {'path': relative, 'size': size, 'sha256': digest.hexdigest(),
            'executable': bool(after.st_mode & 0o111)}


def inspect_tree(root, *, excluded=(), hash_files=True):
    root, _ = checked_path(root, directory=True)
    directories, files = [], []

    def visit(directory, prefix):
        checked_path(directory, directory=True)
        with os.scandir(directory) as iterator:
            names = sorted(entry.name for entry in iterator)
        for name in names:
            relative = checked_relative(prefix + name)
            path, info = checked_path(directory / name)
            # Exclusions apply only to the two named root entries. Their
            # contents are not artifacts, but the entries themselves may not
            # be links or special files.
            if not prefix and name in excluded:
                continue
            if stat.S_ISDIR(info.st_mode):
                directories.append(relative)
                visit(path, relative + '/')
            elif hash_files:
                files.append(read_record(path, relative))
            elif info.st_nlink != 1:
                raise CacheError('hard-linked file is forbidden: ' + repr(str(path)))

    visit(root, '')
    return {'directories': sorted(directories), 'files': sorted(files, key=lambda entry: entry['path'])}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CacheError('duplicate manifest field: ' + repr(key))
        result[key] = value
    return result


def validate_manifest(manifest, key):
    fields = {'schema', 'key', 'artifact_name', 'directories', 'files'}
    if not isinstance(manifest, dict) or set(manifest) != fields:
        raise CacheError('invalid manifest fields')
    if type(manifest['schema']) is not int or manifest['schema'] != SCHEMA:
        raise CacheError('unsupported manifest schema')
    if manifest['key'] != key:
        raise CacheError('manifest key mismatch')
    if manifest['artifact_name'] not in ('dist', '.next'):
        raise CacheError('invalid artifact name')
    directories, files = manifest['directories'], manifest['files']
    if not isinstance(directories, list) or not isinstance(files, list):
        raise CacheError('invalid manifest tree')
    seen = set()
    for directory in directories:
        checked_relative(directory)
        if directory in seen:
            raise CacheError('duplicate manifest path: ' + repr(directory))
        seen.add(directory)
    directory_set = seen.copy()
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {'path', 'size', 'sha256', 'executable'}:
            raise CacheError('invalid manifest file record')
        relative = checked_relative(entry['path'])
        if relative in seen:
            raise CacheError('duplicate manifest path: ' + repr(relative))
        seen.add(relative)
        if type(entry['size']) is not int or entry['size'] < 0 or type(entry['executable']) is not bool:
            raise CacheError('invalid file metadata: ' + repr(relative))
        if not isinstance(entry['sha256'], str) or re.fullmatch(r'[0-9a-f]{64}', entry['sha256']) is None:
            raise CacheError('invalid file digest: ' + repr(relative))
    for relative in seen:
        parent = relative.rpartition('/')[0]
        if parent and parent not in directory_set:
            raise CacheError('missing parent directory in manifest: ' + repr(relative))
    if directories != sorted(directories) or files != sorted(files, key=lambda entry: entry['path']):
        raise CacheError('manifest paths must be sorted')


def compare_tree(actual, expected):
    actual_dirs, expected_dirs = set(actual['directories']), set(expected['directories'])
    if actual_dirs != expected_dirs:
        raise CacheError('directory inventory mismatch; missing=' + repr(sorted(expected_dirs - actual_dirs))
                         + ', unexpected=' + repr(sorted(actual_dirs - expected_dirs)))
    actual_files = {entry['path']: entry for entry in actual['files']}
    expected_files = {entry['path']: entry for entry in expected['files']}
    if actual_files.keys() != expected_files.keys():
        raise CacheError('file inventory mismatch; missing=' + repr(sorted(expected_files.keys() - actual_files.keys()))
                         + ', unexpected=' + repr(sorted(actual_files.keys() - expected_files.keys())))
    for relative, entry in expected_files.items():
        if actual_files[relative] != entry:
            raise CacheError('file digest or metadata mismatch: ' + repr(relative))


def verify(cache, key):
    key = checked_key(key)
    cache, _ = checked_path(cache, directory=True)
    with os.scandir(cache) as iterator:
        names = {entry.name for entry in iterator}
    if names != {'artifact', 'manifest.json'}:
        raise CacheError('cache must contain exactly artifact/ and manifest.json')
    with open_regular(cache / 'manifest.json') as stream:
        content = stream.read(MAX_MANIFEST_BYTES + 1)
    if len(content) > MAX_MANIFEST_BYTES:
        raise CacheError('manifest is too large')
    try:
        manifest = json.loads(content.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise CacheError('cannot read manifest: ' + str(error)) from None
    validate_manifest(manifest, key)
    # No exclusions when checking the persisted tree: extra files always fail.
    compare_tree(inspect_tree(cache / 'artifact'), manifest)
    return manifest


def disjoint(first, second):
    if first == second or first in second.parents or second in first.parents:
        raise CacheError('source and destination boundaries overlap')


def copy_file(source, destination, entry):
    with open_regular(destination, create=True) as target:
        actual = read_record(source, entry['path'], target)
        if actual != entry:
            raise CacheError('source changed before copying: ' + repr(entry['path']))
        target.flush()
        os.fsync(target.fileno())
    os.chmod(destination, 0o755 if entry['executable'] else 0o644)


def copy_artifact(source, destination, manifest, *, excluded=()):
    # The operation creates this directory exclusively before calling us.
    destination, _ = checked_path(destination, directory=True)
    for relative in sorted(manifest['directories'], key=lambda item: (item.count('/'), item)):
        path = destination / relative
        checked_path(path, missing=True, directory=True)
        path.mkdir(mode=0o755)
    for entry in manifest['files']:
        copy_file(source / entry['path'], destination / entry['path'], entry)
    compare_tree(inspect_tree(source, excluded=excluded), manifest)


def remove_tree(path):
    """Only remove checked trees in caller-trusted, stable parent directories."""
    inspect_tree(path, hash_files=False)

    def readonly_retry(function, filename, error):
        checked, info = checked_path(filename)
        if info.st_nlink != 1 and stat.S_ISREG(info.st_mode):
            raise CacheError('refusing to change a hard-linked file')
        os.chmod(checked, info.st_mode | stat.S_IWUSR)
        function(checked)

    shutil.rmtree(path, onerror=readonly_retry)


def sync_directory(path):
    if os.name != 'nt':
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def store(artifact, cache, key):
    key = checked_key(key)
    artifact, _ = checked_path(artifact, directory=True)
    if artifact.name not in ('dist', '.next'):
        raise CacheError('artifact must be a dist or .next directory')
    cache, existing = checked_path(cache, missing=True, directory=True)
    disjoint(artifact, cache)
    excluded = NEXT_EXCLUDED if artifact.name == '.next' else ()
    manifest = {'schema': SCHEMA, 'key': key, 'artifact_name': artifact.name,
                **inspect_tree(artifact, excluded=excluded)}
    if existing is not None:
        inspect_tree(cache, hash_files=False)
    stage = Path(tempfile.mkdtemp(prefix='.' + cache.name + '.tmp-', dir=cache.parent))
    staged_info = stage.lstat()
    backup = None
    try:
        (stage / 'artifact').mkdir(mode=0o755)
        copy_artifact(artifact, stage / 'artifact', manifest, excluded=excluded)
        with open_regular(stage / 'manifest.json', create=True) as stream:
            stream.write((json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode('utf-8'))
            stream.flush()
            os.fsync(stream.fileno())
        verify(stage, key)
        sync_directory(stage)
        _, current = checked_path(cache, missing=True, directory=True)
        if (existing is None) != (current is None) or (existing is not None and not same_file(existing, current)):
            raise CacheError('cache changed before publication')
        if current is not None:
            inspect_tree(cache, hash_files=False)
            backup = Path(tempfile.mkdtemp(prefix='.' + cache.name + '.old-', dir=cache.parent))
            backup.rmdir()
            cache.rename(backup)
        try:
            stage.rename(cache)
            sync_directory(cache.parent)
        except BaseException:
            _, published = checked_path(cache, missing=True, directory=True)
            if published is not None and same_file(published, staged_info):
                cache.rename(stage)
            if backup is not None:
                _, replacement = checked_path(cache, missing=True, directory=True)
                if replacement is None:
                    backup.rename(cache)
                    backup = None
            raise
        stage = None
        if backup is not None:
            try:
                remove_tree(backup)
                backup = None
            except (CacheError, OSError) as error:
                # Publication succeeded; an undeleted old directory is never
                # used as a cache and should not turn success into a failure.
                print('build-artifact-cache: could not remove old cache ' + repr(str(backup))
                      + ': ' + str(error), file=sys.stderr)
    finally:
        if stage is not None:
            _, current = checked_path(stage, missing=True, directory=True)
            if current is not None and same_file(current, staged_info):
                remove_tree(stage)


def restore(cache, key, destination):
    cache, _ = checked_path(cache, directory=True)
    destination, existing = checked_path(destination, missing=True, directory=True)
    if existing is not None:
        raise CacheError('destination already exists: ' + repr(str(destination)))
    disjoint(cache, destination)
    manifest = verify(cache, key)
    # Creation is outside the cleanup block: a competing existing destination
    # must never be mistaken for a directory created by this invocation.
    checked_path(destination, missing=True, directory=True)
    destination.mkdir(mode=0o755)
    created = destination.lstat()
    try:
        copy_artifact(cache / 'artifact', destination, manifest)
        compare_tree(inspect_tree(destination), manifest)
    except BaseException:
        _, current = checked_path(destination, missing=True, directory=True)
        if current is not None and same_file(created, current):
            remove_tree(destination)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('verify')
    check.add_argument('cache')
    check.add_argument('key')
    save = commands.add_parser('store')
    save.add_argument('artifact')
    save.add_argument('cache')
    save.add_argument('key')
    load = commands.add_parser('restore')
    load.add_argument('cache')
    load.add_argument('key')
    load.add_argument('destination')
    args = parser.parse_args(argv)
    try:
        if args.command == 'verify':
            verify(args.cache, args.key)
        elif args.command == 'store':
            store(args.artifact, args.cache, args.key)
        else:
            restore(args.cache, args.key, args.destination)
    except (CacheError, OSError) as error:
        print('build-artifact-cache: ' + args.command + ' failed: ' + str(error), file=sys.stderr)
        return 1
    print('build-artifact-cache: ' + args.command + ' succeeded')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
