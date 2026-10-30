"""巡检逻辑与真实 HTTP 收发检查：只用标准库，在任意系统可运行。"""
import base64, hashlib, hmac, http.server, json, os, sys, tempfile, threading, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main_watch as watch  # noqa: E402

READY = 'http://10.0.0.5:3100/api/ready'
PORT = 'tcp://10.0.0.5:22'
BASE = {'FEISHU_WEBHOOK': 'https://open.feishu.cn/open-apis/bot/v2/hook/x', 'CHECKS': f'{READY} {PORT}', 'FAIL_THRESHOLD': '3', 'REMIND_MINUTES': '30'}


class Fake:
    def __init__(self, down=(), control=True, send_ok=True):
        self.down, self.control, self.send_ok, self.sent = set(down), control, send_ok, []

    def probe(self, target, timeout):
        if target.startswith('tcp://open.feishu.cn'):
            return None if self.control else 'OSError: unreachable'
        return 'HTTP 503' if target in self.down else None

    def send(self, text):
        if not self.send_ok:
            raise RuntimeError('boom')
        self.sent.append(text)


def rounds(fake, count, state=None, start=1000, config=None):
    config = config or watch.validate(BASE)
    state = state or {}
    for index in range(count):
        state = watch.run_round(config, state, start + index * 60, fake.probe, fake.send, lambda _: None)
    return state


class ConfigTests(unittest.TestCase):
    def test_parse_rejects_unknown_duplicate_and_malformed_lines(self):
        self.assertEqual(watch.parse_config('# c\nNAME="主"\nCHECKS=a b\n'), {'NAME': '主', 'CHECKS': 'a b'})
        for text in ('OTHER=1', 'NAME=a\nNAME=b', 'just text'):
            with self.subTest(text=text), self.assertRaises(watch.ConfigError):
                watch.parse_config(text)

    def test_validate_accepts_defaults_and_rejects_unsafe_values(self):
        config = watch.validate(BASE)
        self.assertEqual((config['threshold'], config['remind'], config['name']), (3, 1800, '主服务器'))
        self.assertEqual(watch.validate({**BASE, 'FEISHU_WEBHOOK': 'http://127.0.0.1:9/hook'})['webhook'], 'http://127.0.0.1:9/hook')
        bad = [{'FEISHU_WEBHOOK': 'http://open.feishu.cn/hook'}, {'FEISHU_WEBHOOK': ''}, {'CHECKS': ''},
               {'CHECKS': 'ftp://x'}, {'CHECKS': 'tcp://x'}, {'CHECKS': f'{READY} {READY}'},
               {'CHECKS': 'http://user:pw@x/'}, {'FAIL_THRESHOLD': '0'}, {'REMIND_MINUTES': 'x'}, {'NAME': ' '}]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(watch.ConfigError):
                watch.validate({**BASE, **change})

    def test_main_and_checks_are_kept_separately(self):
        config = watch.validate({**BASE, 'MAIN': '10.0.0.5:3100', 'CHECKS': PORT})
        self.assertEqual(config['checks'], [READY, PORT])
        self.assertEqual(watch.validate({**BASE, 'MAIN': '10.0.0.5:3100', 'CHECKS': ''})['checks'], [READY])
        for change in ({'MAIN': '', 'CHECKS': ''}, {'MAIN': 'host-only'}, {'MAIN': '10.0.0.5:3100', 'CHECKS': READY}):
            with self.subTest(change=change), self.assertRaises(watch.ConfigError):
                watch.validate({**BASE, **change})

    def test_signature_matches_feishu_formula(self):
        body = watch.feishu_body('hi', 'sec', 1700000000)
        expected = base64.b64encode(hmac.new(b'1700000000\nsec', b'', hashlib.sha256).digest()).decode()
        self.assertEqual((body['timestamp'], body['sign']), ('1700000000', expected))
        self.assertNotIn('sign', watch.feishu_body('hi', '', 1))


class RoundTests(unittest.TestCase):
    def test_alerts_once_after_threshold_then_reminds_and_recovers(self):
        fake = Fake(down=[READY])
        state = rounds(fake, 2)
        self.assertEqual(fake.sent, [], 'below the threshold nothing is sent')
        state = rounds(fake, 1, state, start=1120)
        self.assertEqual(len(fake.sent), 1)
        self.assertIn(READY, fake.sent[0])
        self.assertNotIn(PORT, fake.sent[0])
        state = rounds(fake, 29, state, start=1180)
        self.assertEqual(len(fake.sent), 1, 'no repeat inside the reminder window')
        state = rounds(fake, 1, state, start=1120 + 1800)
        self.assertEqual(len(fake.sent), 2, 'reminder after REMIND_MINUTES')
        fake.down.clear()
        state = rounds(fake, 1, state, start=4000)
        self.assertTrue(fake.sent[-1].startswith('🟢'))
        self.assertEqual(state[READY], watch.fresh())

    def test_failed_send_is_retried_next_round(self):
        fake = Fake(down=[READY], send_ok=False)
        state = rounds(fake, 3)
        self.assertFalse(state[READY]['alerted'])
        fake.send_ok = True
        state = rounds(fake, 1, state, start=1180)
        self.assertEqual(len(fake.sent), 1)
        self.assertTrue(state[READY]['alerted'])

    def test_failed_recovery_notice_is_resent_once(self):
        fake = Fake(down=[READY])
        state = rounds(fake, 3)
        fake.down.clear()
        fake.send_ok = False
        state = rounds(fake, 1, state, start=1180)
        self.assertIn('中断约', state[READY]['recovery'])
        fake.send_ok = True
        state = rounds(fake, 2, state, start=1240)
        self.assertEqual([text[0] for text in fake.sent], ['🔴', '🟢'])
        self.assertEqual(state[READY], watch.fresh())

    def test_pending_recovery_survives_a_short_relapse(self):
        fake = Fake(down=[READY])
        state = rounds(fake, 1, state={READY: {**watch.fresh(), 'recovery': '• old'}})
        self.assertEqual(state[READY]['recovery'], '• old')
        fake.down.clear()
        state = rounds(fake, 1, state, start=1060)
        self.assertEqual(fake.sent, ['🟢 主服务器 服务恢复 ' + fake.sent[0].split('恢复 ', 1)[1]])
        self.assertTrue(fake.sent[0].endswith('• old'))

    def test_new_alert_replaces_pending_recovery(self):
        fake = Fake(down=[READY])
        state = rounds(fake, 3, state={READY: {**watch.fresh(), 'recovery': '• old'}})
        self.assertNotIn('recovery', state[READY])
        fake.down.clear()
        rounds(fake, 1, state, start=1180)
        self.assertNotIn('• old', fake.sent[-1])

    def test_corrupt_state_entries_restart_counting(self):
        fake = Fake(down=[READY])
        state = rounds(fake, 1, state={READY: 'junk', PORT: {'fails': 'x', 'alerted': True}})
        self.assertEqual(state[READY]['fails'], 1)
        self.assertEqual(state[PORT], watch.fresh())

    def test_local_network_outage_does_not_count(self):
        fake = Fake(down=[READY], control=False)
        self.assertEqual(rounds(fake, 5), {})
        self.assertEqual(fake.sent, [])

    def test_short_blip_resets_without_messages(self):
        fake = Fake(down=[READY])
        state = rounds(fake, 2)
        fake.down.clear()
        state = rounds(fake, 1, state, start=1120)
        self.assertEqual((fake.sent, state[READY]), ([], watch.fresh()))

    def test_removed_targets_are_dropped(self):
        state = rounds(Fake(), 1, state={'old': {'fails': 9}})
        self.assertEqual(set(state), {READY, PORT})


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200 if self.path == '/api/ready' else 503)
        self.end_headers()

    def do_POST(self):
        self.server.posts.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        reply = self.server.reply
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(reply).encode())


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.posts, self.server.reply = [], {'code': 0, 'msg': 'success'}
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.config = os.path.join(self.dir.name, 'config')
        self.state = os.path.join(self.dir.name, 'state.json')

    def write(self, **values):
        lines = {'FEISHU_WEBHOOK': self.base + '/hook', 'FEISHU_SECRET': 's', 'FAIL_THRESHOLD': '1', **values}
        Path(self.config).write_text(''.join(f'{k}={v}\n' for k, v in lines.items()), encoding='utf-8')

    def main(self, *args):
        return watch.main(['--config', self.config, '--state', self.state, *args])

    def test_cli_modes_against_real_http(self):
        self.write(CHECKS=f'{self.base}/api/ready {self.base}/broken')
        self.assertEqual(self.main('--check'), 0)
        self.assertEqual(self.main('--probe'), 1)
        self.assertEqual(self.server.posts, [], 'probe never sends')
        self.assertEqual(self.main('--test'), 0)
        self.assertIn('sign', self.server.posts[0])
        self.assertEqual(self.main(), 0)
        self.assertIn('/broken', self.server.posts[1]['content']['text'])
        self.assertTrue(json.loads(Path(self.state).read_text())[f'{self.base}/broken']['alerted'])

    def test_feishu_error_code_fails_test_and_keeps_alert_pending(self):
        self.write(CHECKS=f'{self.base}/broken')
        self.server.reply = {'code': 19021, 'msg': 'sign match fail'}
        self.assertEqual(self.main('--test'), 1)
        self.main()
        self.assertFalse(json.loads(Path(self.state).read_text())[f'{self.base}/broken']['alerted'])

    def test_response_without_code_is_not_success(self):
        self.write(CHECKS=f'{self.base}/api/ready')
        self.server.reply = {}
        self.assertEqual(self.main('--test'), 1)

    def test_invalid_config_exits_2(self):
        self.write(CHECKS='nonsense')
        self.assertEqual(self.main('--check'), 2)


if __name__ == '__main__':
    unittest.main()
