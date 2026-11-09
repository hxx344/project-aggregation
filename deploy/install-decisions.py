"""Decisions of deploy/install.sh on its own activation records (docs/evolution-plan.md E4).

install.sh embeds this file verbatim as the heredoc of install_decide, so it
arrives and is verified with the installer itself: a first install has it, and
an update runs the target version's copy, never one an older installer left.
deploy/test-install-decisions.py checks that the embedded copy is identical.

Each command reads only the installer's records, release markers and the unit
files it wrote, and prints its decision on one line. The shell keeps every
system call, probe of running services, link and record write, and calls a
decision before the probes it used to precede. Exit status 1 means an absent
or invalid record, as the shell functions it replaced returned; 2 a usage error.
"""
import json
import os
import re
import sys

SLOTS = ('a', 'b')
PHASES = ('candidate', 'switching', 'draining')
INTENTS = ('forward', 'rollback', 'legacy')
SCOPES = ('full', 'api')
LAYOUTS = ('single', 'dual')
MODES = ('source', 'ci')
ABSOLUTE = re.compile(r'/\S+')
RELEASE_NAME = re.compile(r'[a-f0-9]{12}-[a-f0-9]{16}')
RUNTIME_KEY = re.compile(r'[a-f0-9]{64}')


class Invalid(Exception):
    """An absent or malformed record."""


class Usage(Exception):
    """An argument outside the values the installer passes."""


def load_json(path):
    try:
        with open(path, encoding='utf-8') as stream:
            return json.load(stream)
    except (OSError, ValueError) as error:
        raise Invalid(path) from error


def slot_record(path):
    """(slot, release) of .api-slot."""
    if not os.path.isfile(path):
        raise Invalid(path)
    value = load_json(path)
    if not isinstance(value, dict) or value.get('slot') not in SLOTS or not isinstance(value.get('release'), str) or \
            not ABSOLUTE.fullmatch(value['release']):
        raise Invalid(path)
    return value['slot'], value['release']


def cutover_record(path):
    """from, to, release, phase and, from journals that carry them, intent and previous of .api-cutover."""
    value = load_json(path)
    if not isinstance(value, dict) or {value.get('from'), value.get('to')} != set(SLOTS) or \
            not isinstance(value.get('release'), str) or not ABSOLUTE.fullmatch(value['release']) or \
            value.get('phase') not in PHASES:
        raise Invalid(path)
    record = {key: value[key] for key in ('from', 'to', 'release', 'phase')}
    if 'intent' in value or 'previous' in value:
        if value.get('intent') not in INTENTS or not isinstance(value.get('previous'), str) or \
                not re.fullmatch(r'-|/\S+', value['previous']):
            raise Invalid(path)
        record.update(intent=value['intent'], previous=value['previous'])
    return record


def cutover_resolution(cutover, recorded):
    """What happens to a cutover an earlier run left behind (design doc api-dual-slot 3.5).

    It continues when the slot record already names its target, or when it is
    a rollback, which is journaled before its target is probed or moved. Any
    other switch never committed, so its candidate slot stops. Journals from
    before the intent field cannot tell a forward switch from a rollback: they
    are legacy and keep the previous pointer as it is.
    """
    intent = cutover.get('intent', 'legacy')
    resume = recorded == (cutover['to'], cutover['release']) or intent == 'rollback'
    fields = ['resume' if resume else 'abandon', cutover['to'], cutover['release'], cutover['phase'], intent]
    if 'previous' in cutover:
        fields.append(cutover['previous'])
    return fields


def read_fields(path):
    """The fields `read -r` assigns from the first line of a file, or None where it fails.

    read fails on a file that cannot be opened or that ends before a newline,
    drops NUL bytes, and separates fields by runs of spaces and tabs.
    """
    try:
        with open(path, 'rb') as stream:
            line = stream.readline()
    except OSError:
        return None
    if not line.endswith(b'\n'):
        return None
    line = line[:-1].replace(b'\0', b'').decode('utf-8', 'surrogateescape')
    return [field for field in re.split(r'[ \t]+', line) if field]


def managed_release(path, app_dir):
    """A release directory this installer created."""
    return path.startswith(app_dir + '/releases/') and RELEASE_NAME.fullmatch(path.rsplit('/', 1)[-1]) is not None and \
        os.path.isdir(path) and not os.path.islink(path) and os.path.isfile(path + '/.managed-release')


def pending_previous(app_dir, release, old_release):
    """How .pending-previous "<target> <previous|-> <scope>" applies to this run.

    Full and single-API activations write it before they move current and
    remove it once their bookkeeping is durable. none: there is no record.
    resume: current already is this run's release, so this run finishes the
    interrupted activation with its scope and rollback release. inherit: this
    run replaces the unfinished release; the record is its only rollback
    pointer, and a rollback of this run writes it back (#191). ignore: the
    record names another release.
    """
    path = app_dir + '/.pending-previous'
    if not os.path.exists(path):
        return ['none']
    fields = read_fields(path)
    if fields is None or len(fields) != 3 or fields[2] not in SCOPES:
        raise Invalid(path)
    target, previous, scope = fields
    if not managed_release(target, app_dir) or (previous != '-' and not managed_release(previous, app_dir)):
        raise Invalid(path)
    if target == release and old_release == release:
        return ['resume', previous, scope]
    if target == old_release:
        return ['inherit', target, previous, scope]
    return ['ignore']


def first_install_resume(app_dir, old_release):
    """resume when a first install stopped after it moved current (#185), keep otherwise.

    Only that install's own record "<current> -" is left: no run ever
    succeeded (.deployed-state is written only by one and never removed), no
    environment snapshot or previous release exists and no cutover started.
    """
    pending = app_dir + '/.pending-previous'
    if not old_release or os.path.exists(app_dir + '/.last-successful.env') or os.path.exists(app_dir + '/.deployed-state') or \
            not os.path.isfile(pending) or os.path.islink(app_dir + '/previous') or os.path.exists(app_dir + '/.api-cutover'):
        return ['keep']
    fields = read_fields(pending)
    # As before, the scope is not checked; a fourth field is.
    if fields is None or len(fields) > 3 or fields[:2] != [old_release, '-']:
        return ['keep']
    return ['resume']


def file_text(path):
    """What "$(cat -- path)" yields: NUL bytes and trailing newlines dropped; None where cat fails."""
    try:
        with open(path, 'rb') as stream:
            data = stream.read()
    except OSError:
        return None
    return data.replace(b'\0', b'').rstrip(b'\n').decode('utf-8', 'surrogateescape')


def same_file(first, second):
    """cmp -s: both readable with the same bytes."""
    try:
        with open(first, 'rb') as one, open(second, 'rb') as other:
            return one.read() == other.read()
    except OSError:
        return False


def nonempty(path):
    """[[ -s path ]]"""
    try:
        return os.stat(path).st_size > 0
    except OSError:
        return False


def runtime_component_key(release):
    """The runtime component key recorded in a release, or None."""
    path = release + '/.runtime-component-key'
    key = file_text(path) if os.path.isfile(path) else None
    return key if key is not None and RUNTIME_KEY.fullmatch(key) else None


def valid_slot_record(path):
    try:
        slot_record(path)
    except Invalid:
        return False
    return True


def activation_scope(pending_scope, old_release, release, layout, dual, app_dir, work_dir, unit_file, entry_unit_file, api_unit_file,
                     deployment_key):
    """full, or probe when the records allow restarting only the API (design doc 6.2).

    An unfinished full activation keeps its scope. Otherwise the runtime unit
    must be installed and unchanged, its last full activation recorded with
    this deployment key, the API units settled in the target layout and the
    candidate built with a runtime component key. dual tells whether the
    dual-slot units are installed (dual_installed): one with the target layout
    single is a change of layout, always full. probe leaves the running
    runtime, its release (same-runtime) and the module migration to check.
    """
    if layout not in LAYOUTS or dual not in ('0', '1'):
        raise Usage(layout, dual)
    if pending_scope == 'full' or not old_release or not os.path.isfile(unit_file) or \
            not os.path.isfile(app_dir + '/.runtime-deployment'):
        return ['full']
    if layout == 'dual':
        settled = dual == '1' and same_file(work_dir + '/entry.service', entry_unit_file) and \
            not os.path.exists(app_dir + '/.api-cutover') and valid_slot_record(app_dir + '/.api-slot')
    else:
        settled = os.path.isfile(api_unit_file) and dual == '0'
    if not settled or not same_file(work_dir + '/service', unit_file) or \
            file_text(app_dir + '/.runtime-deployment') != deployment_key or runtime_component_key(release) is None:
        return ['full']
    return ['probe']


def same_runtime(release, running):
    """same when the running runtime's release was built with the candidate's runtime component key."""
    key = runtime_component_key(release)
    return ['same' if key is not None and runtime_component_key(running) == key else 'different']


def unchanged_source(mode, tests, app_dir, old_release, deployed_state, commit, deployment_key):
    """verify when the last successful run deployed this commit with this deployment and left nothing unfinished.

    Only a run that skips the tests can skip on these records: a source build
    with tests checks the commit again. verify leaves the release's runtime
    dependencies (source builds) and the service health to check; deploy
    prepares the release.
    """
    if mode not in MODES or tests not in ('0', '1'):
        raise Usage(mode, tests)
    skip = (mode == 'ci' or tests == '0') and bool(old_release) and os.path.isfile(old_release + '/.install-ready') and \
        nonempty(old_release + '/dist/index.html') and deployed_state == f'{commit} {deployment_key}' and \
        not os.path.exists(app_dir + '/.api-cutover') and not os.path.exists(app_dir + '/.pending-previous')
    return ['verify' if skip else 'deploy']


def unchanged_release(app_dir, release, old_release, deployed_state, deployment_key):
    """verify when the prepared release already runs with the recorded deployment and nothing is unfinished.

    deployed_state is "<commit> <deployment key>"; another commit may have
    produced the same release. verify leaves the service health to check.
    """
    recorded = deployed_state.split(' ', 1)[1] if ' ' in deployed_state else deployed_state
    skip = release == old_release and recorded == deployment_key and \
        not os.path.exists(app_dir + '/.api-cutover') and not os.path.exists(app_dir + '/.pending-previous')
    return ['verify' if skip else 'deploy']


def cutover_fields(path):
    return list(cutover_record(path).values())


COMMANDS = {
    'slot-record': (1, lambda path: list(slot_record(path))),
    'cutover-record': (1, cutover_fields),
    'cutover-resolution': (2, lambda cutover, slot: cutover_resolution(cutover_record(cutover), slot_record(slot))),
    'pending-previous': (3, pending_previous),
    'first-install-resume': (2, first_install_resume),
    'activation-scope': (11, activation_scope),
    'same-runtime': (2, same_runtime),
    'unchanged-source': (7, unchanged_source),
    'unchanged-release': (5, unchanged_release),
}


def usage():
    print(f'usage: install_decide {"|".join(COMMANDS)} ARGUMENTS', file=sys.stderr)
    return 2


def main(argv):
    if not argv or argv[0] not in COMMANDS or len(argv) - 1 != COMMANDS[argv[0]][0]:
        return usage()
    try:
        print(*COMMANDS[argv[0]][1](*argv[1:]))
    except Invalid:
        return 1
    except Usage:
        return usage()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
