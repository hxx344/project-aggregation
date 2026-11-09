"""Decisions deploy/install.sh takes on its activation records (deploy/install-decisions.py).

The real main() paths through these decisions run in deploy/test-ci-install.sh
and deploy/test-ci-install-dual.sh (CI, root); this file covers each decision's
full table and that the installer embeds this exact module.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'deploy/install-decisions.py'
spec = importlib.util.spec_from_file_location('install_decisions', MODULE)
assert spec and spec.loader
decisions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decisions)

A = 'aaaaaaaaaaaa-0000000000000000'
B = 'bbbbbbbbbbbb-1111111111111111'
C = 'cccccccccccc-2222222222222222'


class EmbeddedCopy(unittest.TestCase):
    def test_installer_embeds_the_module_verbatim_under_isolated_python(self):
        installer = (ROOT / 'deploy/install.sh').read_text(encoding='utf-8')
        start = installer.index('# BEGIN INSTALL DECISIONS')
        end = installer.index('# END INSTALL DECISIONS', start)
        block = installer[start:end]
        opening = "  python3 -I - \"$@\" <<'INSTALL_DECISIONS_PY'\n"
        self.assertIn('install_decide() {\n' + opening, block)
        embedded = block[block.index(opening) + len(opening):block.rindex('INSTALL_DECISIONS_PY\n}')]
        self.assertEqual(embedded, MODULE.read_text(encoding='utf-8'),
                         'copy deploy/install-decisions.py into the install_decide heredoc of deploy/install.sh')
        self.assertEqual(installer.count('# BEGIN INSTALL DECISIONS'), 1)


class Records(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.app = str(self.root / 'app')
        os.makedirs(self.app + '/releases')

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, text):
        path = self.root / name
        path.write_text(text if isinstance(text, str) else json.dumps(text), encoding='utf-8')
        return str(path)

    def release(self, name, managed=True):
        path = f'{self.app}/releases/{name}'
        os.makedirs(path, exist_ok=True)
        if managed:
            Path(path, '.managed-release').touch()
        return path

    def record(self, name, text):
        Path(self.app, name).write_text(text, encoding='utf-8')

    # .api-slot
    def test_slot_record(self):
        self.assertEqual(decisions.slot_record(self.write('slot', {'slot': 'b', 'release': '/r'})), ('b', '/r'))
        for bad in ('', '{', '[]', '{"slot":"c","release":"/x"}', '{"slot":"a","release":"x"}', '{"slot":"a","release":"/a b"}',
                    '{"slot":"a"}', '{"slot":"a","release":7}', '"a /x"'):
            with self.subTest(bad), self.assertRaises(decisions.Invalid):
                decisions.slot_record(self.write('slot', bad))
        with self.assertRaises(decisions.Invalid):
            decisions.slot_record(str(self.root / 'missing'))
        os.mkdir(self.root / 'directory')
        with self.assertRaises(decisions.Invalid):
            decisions.slot_record(str(self.root / 'directory'))

    # .api-cutover
    def test_cutover_record(self):
        legacy = {'from': 'a', 'to': 'b', 'release': '/r', 'phase': 'draining'}
        self.assertEqual(decisions.cutover_fields(self.write('cutover', legacy)), ['a', 'b', '/r', 'draining'])
        for intent, previous in (('forward', '-'), ('rollback', '/p'), ('legacy', '/p')):
            with self.subTest(intent=intent):
                path = self.write('cutover', {**legacy, 'intent': intent, 'previous': previous})
                self.assertEqual(decisions.cutover_fields(path), ['a', 'b', '/r', 'draining', intent, previous])
        for bad in ({**legacy, 'to': 'a'}, {**legacy, 'phase': 'done'}, {**legacy, 'release': None}, {**legacy, 'release': '/a b'},
                    {key: value for key, value in legacy.items() if key != 'release'}, {**legacy, 'intent': 'forward'},
                    {**legacy, 'previous': '/p'}, {**legacy, 'intent': 'back', 'previous': '/p'},
                    {**legacy, 'intent': 'forward', 'previous': 'p'}, {**legacy, 'intent': 'forward', 'previous': ''}, [], 'x'):
            with self.subTest(bad=bad), self.assertRaises(decisions.Invalid):
                decisions.cutover_record(self.write('cutover', bad))

    def test_cutover_resolution(self):
        def resolve(recorded, **extra):
            return decisions.cutover_resolution({'from': 'a', 'to': 'b', 'release': '/r', 'phase': 'switching', **extra}, recorded)
        # The slot record moved: the switch committed and continues forward.
        self.assertEqual(resolve(('b', '/r'), intent='forward', previous='/p'), ['resume', 'b', '/r', 'switching', 'forward', '/p'])
        # It did not: the candidate stops; the old slot never changed.
        self.assertEqual(resolve(('a', '/o'), intent='forward', previous='-'), ['abandon', 'b', '/r', 'switching', 'forward', '-'])
        self.assertEqual(resolve(('b', '/other'), intent='forward', previous='-')[0], 'abandon')
        # A rollback is journaled before its target moves, so it always continues.
        self.assertEqual(resolve(('a', '/o'), intent='rollback', previous='/p'), ['resume', 'b', '/r', 'switching', 'rollback', '/p'])
        # A legacy journal has no previous: api_cutover keeps the existing pointer.
        self.assertEqual(resolve(('b', '/r')), ['resume', 'b', '/r', 'switching', 'legacy'])
        self.assertEqual(resolve(('a', '/o')), ['abandon', 'b', '/r', 'switching', 'legacy'])

    # .pending-previous
    def test_pending_previous(self):
        target, previous = self.release(A), self.release(B)
        decide = lambda release=target, old=target: decisions.pending_previous(self.app, release, old)
        self.assertEqual(decide(), ['none'])
        self.record('.pending-previous', f'{target} {previous} full\n')
        # current already is this run's release: finish that activation.
        self.assertEqual(decide(), ['resume', previous, 'full'])
        # This run replaces the unfinished release: keep its record for a rollback.
        self.assertEqual(decide(release=self.release(C)), ['inherit', target, previous, 'full'])
        # current moved on to another release in between.
        self.assertEqual(decide(release=target, old=previous), ['ignore'])
        self.assertEqual(decide(release=target, old=''), ['ignore'])
        self.record('.pending-previous', f'\t{target}  -   api \nignored second line')
        self.assertEqual(decide(), ['resume', '-', 'api'])
        # read drops NUL bytes.
        self.record('.pending-previous', f'{target} -\0 full\n')
        self.assertEqual(decide(), ['resume', '-', 'full'])

    def test_pending_previous_refuses_invalid_records(self):
        target, previous = self.release(A), self.release(B)
        unmanaged = self.release(C, managed=False)
        os.symlink(target, f'{self.app}/releases/dddddddddddd-3333333333333333')
        os.makedirs(self.root / 'elsewhere' / A)
        Path(self.root / 'elsewhere' / A / '.managed-release').touch()
        for bad in (f'{target} {previous} full', f'{target} {previous}\n', f'{target} {previous} both\n', f'{target} {previous} full x\n',
                    '\n', f'{unmanaged} - full\n', f'{target} {unmanaged} full\n', f'{target} {self.app}/releases/missing full\n',
                    f'{self.app}/releases/dddddddddddd-3333333333333333 - full\n', f'{self.root}/elsewhere/{A} - full\n',
                    f'{self.app}/releases/{A}/ - full\n', f'{target} relative full\n'):
            with self.subTest(bad=bad), self.assertRaises(decisions.Invalid):
                self.record('.pending-previous', bad)
                decisions.pending_previous(self.app, target, target)
        Path(self.app, '.pending-previous').unlink()
        os.mkdir(Path(self.app, '.pending-previous'))
        with self.assertRaises(decisions.Invalid):
            decisions.pending_previous(self.app, target, target)

    # An interrupted first install (#185)
    def test_first_install_resume(self):
        current = self.release(A)
        decide = lambda old=current: decisions.first_install_resume(self.app, old)[0]
        self.assertEqual(decide(), 'keep')
        self.record('.pending-previous', f'{current} - full\n')
        self.assertEqual(decide(), 'resume')
        self.assertEqual(decide(old=''), 'keep')
        self.assertEqual(decide(old=self.release(B)), 'keep')
        for blocker in ('.last-successful.env', '.deployed-state', '.api-cutover'):
            with self.subTest(blocker):
                self.record(blocker, '')
                self.assertEqual(decide(), 'keep')
                Path(self.app, blocker).unlink()
        os.symlink(self.root / 'missing', Path(self.app, 'previous'))
        self.assertEqual(decide(), 'keep')
        Path(self.app, 'previous').unlink()
        # The scope is not checked; a fourth field, a previous release or no newline is.
        for text, expected in ((f'{current} -\n', 'resume'), (f'{current} - api\n', 'resume'), (f'{current} - full x\n', 'keep'),
                               (f'{current} {self.release(B)} full\n', 'keep'), (f'{current} - full', 'keep'), ('\n', 'keep')):
            with self.subTest(text=text):
                self.record('.pending-previous', text)
                self.assertEqual(decide(), expected)
        Path(self.app, '.pending-previous').unlink()
        os.mkdir(Path(self.app, '.pending-previous'))
        self.assertEqual(decide(), 'keep')

    # Design doc 6.2: whether only the API restarts.
    def scope_fixture(self, layout):
        """Records of a settled installation in layout, with the decision's arguments."""
        work, units = self.root / 'work', self.root / 'units'
        work.mkdir(exist_ok=True)
        units.mkdir(exist_ok=True)
        old, release = self.release(A), self.release(B)
        for directory in (old, release):
            Path(directory, '.runtime-component-key').write_text('4' * 64 + '\n', encoding='utf-8')
        for name, text in (('service', 'runtime\n'), ('entry.service', 'entry\n')):
            (work / name).write_text(text, encoding='utf-8')
        (units / 'runtime.service').write_text('runtime\n', encoding='utf-8')
        if layout == 'dual':
            (units / 'entry.service').write_text('entry\n', encoding='utf-8')
            self.record('.api-slot', json.dumps({'slot': 'a', 'release': old}))
        else:
            (units / 'api.service').write_text('api\n', encoding='utf-8')
        self.record('.runtime-deployment', 'k' * 64 + '\n')
        return {'pending_scope': '', 'old_release': old, 'release': release, 'layout': layout, 'dual': '1' if layout == 'dual' else '0',
                'app_dir': self.app, 'work_dir': str(work), 'unit_file': str(units / 'runtime.service'),
                'entry_unit_file': str(units / 'entry.service'), 'api_unit_file': str(units / 'api.service'), 'deployment_key': 'k' * 64}

    def test_activation_scope(self):
        for layout in ('single', 'dual'):
            arguments = self.scope_fixture(layout)
            work = arguments['work_dir']
            scope = lambda **changes: decisions.activation_scope(**{**arguments, **changes})[0]
            # (change, undo, why it restarts everything)
            cases = [
                (lambda: None, lambda: None, None),
                (lambda: arguments.update(pending_scope='full'), lambda: arguments.update(pending_scope=''), 'an unfinished full activation'),
                (lambda: arguments.update(old_release=''), lambda: arguments.update(old_release=self.app + f'/releases/{A}'), 'first install'),
                (lambda: os.rename(arguments['unit_file'], work + '/hidden'), lambda: os.rename(work + '/hidden', arguments['unit_file']),
                 'no runtime unit'),
                (lambda: os.rename(self.app + '/.runtime-deployment', work + '/deployment'),
                 lambda: os.rename(work + '/deployment', self.app + '/.runtime-deployment'), 'no full activation recorded'),
                (lambda: Path(work, 'service').write_text('changed\n'), lambda: Path(work, 'service').write_text('runtime\n'), 'runtime unit changed'),
                (lambda: Path(arguments['unit_file']).write_text('edited\n'), lambda: Path(arguments['unit_file']).write_text('runtime\n'),
                 'installed runtime unit edited'),
                (lambda: arguments.update(deployment_key='j' * 64), lambda: arguments.update(deployment_key='k' * 64),
                 'environment, Node or installer changed'),
                # "$(cat)" drops NUL bytes and trailing newlines.
                (lambda: self.record('.runtime-deployment', 'k' * 64 + '\n\n\0'), lambda: self.record('.runtime-deployment', 'k' * 64 + '\n'), None),
                (lambda: self.record('.runtime-deployment', 'k' * 64 + ' \n'), lambda: self.record('.runtime-deployment', 'k' * 64 + '\n'),
                 'another recorded deployment'),
                (lambda: Path(arguments['release'], '.runtime-component-key').write_text('not-a-key\n'),
                 lambda: Path(arguments['release'], '.runtime-component-key').write_text('4' * 64 + '\n'), 'candidate without a component key'),
            ]
            if layout == 'dual':
                cases += [
                    (lambda: arguments.update(dual='0'), lambda: arguments.update(dual='1'), 'dual-slot units not installed yet'),
                    (lambda: Path(work, 'entry.service').write_text('changed\n'), lambda: Path(work, 'entry.service').write_text('entry\n'),
                     'entry unit changed'),
                    (lambda: self.record('.api-cutover', '{}'), lambda: os.unlink(self.app + '/.api-cutover'), 'unresolved cutover'),
                    # A dangling link counts as absent, as [[ -e ]] does.
                    (lambda: os.symlink(self.root / 'missing', self.app + '/.api-cutover'), lambda: os.unlink(self.app + '/.api-cutover'), None),
                    (lambda: self.record('.api-slot', '{"slot":"c"}'),
                     lambda: self.record('.api-slot', json.dumps({'slot': 'a', 'release': arguments['old_release']})), 'invalid slot record'),
                ]
            else:
                cases += [
                    (lambda: os.unlink(arguments['api_unit_file']), lambda: Path(arguments['api_unit_file']).write_text('api\n'),
                     'single unit before the split'),
                    (lambda: arguments.update(dual='1'), lambda: arguments.update(dual='0'), 'single layout over dual-slot units'),
                ]
            for change, undo, why in cases:
                with self.subTest(layout=layout, why=why):
                    change()
                    self.assertEqual(scope(), 'full' if why else 'probe')
                    undo()
            self.assertEqual(scope(), 'probe')
            for bad in ({'layout': ''}, {'layout': 'both'}, {'dual': ''}):
                with self.subTest(bad=bad), self.assertRaises(decisions.Usage):
                    scope(**bad)
            Path(self.app, '.api-slot').unlink(missing_ok=True)

    def test_same_runtime(self):
        release, running = self.release(A), self.release(B)
        same = lambda: decisions.same_runtime(release, running)[0]
        for directory in (release, running):
            Path(directory, '.runtime-component-key').write_text('4' * 64 + '\n', encoding='utf-8')
        self.assertEqual(same(), 'same')
        Path(running, '.runtime-component-key').write_text('4' * 64, encoding='utf-8')
        self.assertEqual(same(), 'same')
        for release_key, running_key in (('4' * 64, '5' * 64), ('X' * 64, 'X' * 64), ('4' * 63, '4' * 63), ('4' * 64 + '\n4', '4' * 64 + '\n4')):
            with self.subTest(release_key=release_key, running_key=running_key):
                Path(release, '.runtime-component-key').write_text(release_key, encoding='utf-8')
                Path(running, '.runtime-component-key').write_text(running_key, encoding='utf-8')
                self.assertEqual(same(), 'different')
        Path(release, '.runtime-component-key').write_text('4' * 64, encoding='utf-8')
        Path(running, '.runtime-component-key').unlink()
        self.assertEqual(same(), 'different')
        self.assertEqual(decisions.same_runtime(release, '')[0], 'different')

    # The two runs that change nothing.
    def test_unchanged_source(self):
        old = self.release(A)
        os.makedirs(old + '/dist')
        Path(old, '.install-ready').write_text('key\n', encoding='utf-8')
        Path(old, 'dist/index.html').write_text('<html>', encoding='utf-8')
        arguments = {'mode': 'ci', 'tests': '1', 'app_dir': self.app, 'old_release': old, 'deployed_state': 'c' * 40 + ' ' + 'k' * 64,
                     'commit': 'c' * 40, 'deployment_key': 'k' * 64}
        unchanged = lambda **changes: decisions.unchanged_source(**{**arguments, **changes})[0]
        self.assertEqual(unchanged(), 'verify')
        self.assertEqual(unchanged(mode='source', tests='0'), 'verify')
        # A source build that runs the tests checks the commit again.
        self.assertEqual(unchanged(mode='source'), 'deploy')
        for changes in ({'old_release': ''}, {'deployed_state': ''}, {'commit': 'd' * 40}, {'deployment_key': 'j' * 64},
                        {'deployed_state': 'c' * 40 + '  ' + 'k' * 64}, {'old_release': self.release(B)}):
            with self.subTest(changes=changes):
                self.assertEqual(unchanged(**changes), 'deploy')
        Path(old, 'dist/index.html').write_text('', encoding='utf-8')
        self.assertEqual(unchanged(), 'deploy')
        Path(old, 'dist/index.html').write_text('<html>', encoding='utf-8')
        Path(old, '.install-ready').unlink()
        self.assertEqual(unchanged(), 'deploy')
        Path(old, '.install-ready').write_text('key\n', encoding='utf-8')
        for unfinished in ('.api-cutover', '.pending-previous'):
            with self.subTest(unfinished):
                self.record(unfinished, '')
                self.assertEqual(unchanged(), 'deploy')
                Path(self.app, unfinished).unlink()
                # A dangling link counts as absent, as [[ -e ]] does.
                os.symlink(self.root / 'missing', Path(self.app, unfinished))
                self.assertEqual(unchanged(), 'verify')
                Path(self.app, unfinished).unlink()
        for bad in ({'mode': ''}, {'tests': '2'}):
            with self.subTest(bad=bad), self.assertRaises(decisions.Usage):
                unchanged(**bad)

    def test_unchanged_release(self):
        release = self.release(A)
        arguments = {'app_dir': self.app, 'release': release, 'old_release': release, 'deployed_state': 'c' * 40 + ' ' + 'k' * 64,
                     'deployment_key': 'k' * 64}
        unchanged = lambda **changes: decisions.unchanged_release(**{**arguments, **changes})[0]
        self.assertEqual(unchanged(), 'verify')
        # Another commit produced the same release.
        self.assertEqual(unchanged(deployed_state='d' * 40 + ' ' + 'k' * 64), 'verify')
        # Only the first space separates the commit, as ${deployed_state#* } does.
        self.assertEqual(unchanged(deployed_state='c ' + 'k' * 64), 'verify')
        self.assertEqual(unchanged(deployed_state='k' * 64), 'verify')
        for changes in ({'old_release': self.release(B)}, {'old_release': ''}, {'deployed_state': ''}, {'deployment_key': 'j' * 64},
                        {'deployed_state': 'c' * 40 + '  ' + 'k' * 64}, {'deployed_state': 'c' * 40 + ' ' + 'k' * 64 + ' x'}):
            with self.subTest(changes=changes):
                self.assertEqual(unchanged(**changes), 'deploy')
        for unfinished in ('.api-cutover', '.pending-previous'):
            with self.subTest(unfinished):
                self.record(unfinished, '')
                self.assertEqual(unchanged(), 'deploy')
                Path(self.app, unfinished).unlink()
                os.symlink(self.root / 'missing', Path(self.app, unfinished))
                self.assertEqual(unchanged(), 'verify')
                Path(self.app, unfinished).unlink()

    def test_command_line(self):
        def run(*arguments):
            result = subprocess.run([sys.executable, '-I', str(MODULE), *arguments], capture_output=True, text=True, check=False)
            return result.returncode, result.stdout
        slot = self.write('slot', {'slot': 'a', 'release': '/r'})
        cutover = self.write('cutover', {'from': 'a', 'to': 'b', 'release': '/r', 'phase': 'candidate'})
        self.assertEqual(run('slot-record', slot), (0, 'a /r\n'))
        self.assertEqual(run('cutover-resolution', cutover, slot), (0, 'abandon b /r candidate legacy\n'))
        self.assertEqual(run('pending-previous', self.app, '', ''), (0, 'none\n'))
        self.assertEqual(run('first-install-resume', self.app, ''), (0, 'keep\n'))
        self.assertEqual(run('slot-record', cutover), (1, ''))
        self.assertEqual(run('cutover-resolution', cutover, cutover), (1, ''))
        self.assertEqual(run('same-runtime', self.app, self.app), (0, 'different\n'))
        self.assertEqual(run('unchanged-release', self.app, '/r', '/r', 'c k', 'k'), (0, 'verify\n'))
        self.assertEqual(run('unchanged-source', 'source', '1', self.app, '', '', 'c', 'k'), (0, 'deploy\n'))
        self.assertEqual(run('activation-scope', 'full', '', '', 'single', '0', *[self.app] * 6), (0, 'full\n'))
        self.assertEqual(run('activation-scope', 'full', '', '', 'other', '0', *[self.app] * 6), (2, ''))
        self.assertEqual(run('slot-record')[0], 2)
        self.assertEqual(run('unknown', slot)[0], 2)


if __name__ == '__main__':
    unittest.main()
