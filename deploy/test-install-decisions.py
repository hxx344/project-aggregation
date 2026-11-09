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
        self.assertEqual(run('slot-record')[0], 2)
        self.assertEqual(run('unknown', slot)[0], 2)


if __name__ == '__main__':
    unittest.main()
