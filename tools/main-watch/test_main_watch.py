"""巡检逻辑与真实 HTTP 收发检查：只用标准库，在任意系统可运行。"""
import base64, hashlib, hmac, http.server, json, os, sys, tempfile, threading, unittest, urllib.error, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main_watch as watch  # noqa: E402

READY = 'http://10.0.0.5:3100/api/ready'
PORT = 'tcp://10.0.0.5:22'
TOKEN = 't' * 40
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



class HeartbeatTests(unittest.TestCase):
    def test_heartbeat_config(self):
        config = watch.validate({**BASE, 'CHECKS': '', 'HEARTBEAT_LISTEN': '0.0.0.0:8792', 'HEARTBEAT_TOKEN': TOKEN})
        self.assertEqual((config['checks'], config['heartbeat']), (['heartbeat://0.0.0.0:8792'], 'heartbeat://0.0.0.0:8792'))
        self.assertIsNone(watch.validate(BASE)['heartbeat'])
        for change in ({'HEARTBEAT_LISTEN': '0.0.0.0:8792'}, {'HEARTBEAT_LISTEN': '0.0.0.0:8792', 'HEARTBEAT_TOKEN': 'short'},
                       {'HEARTBEAT_LISTEN': '0.0.0.0:80', 'HEARTBEAT_TOKEN': TOKEN}, {'HEARTBEAT_LISTEN': '8792', 'HEARTBEAT_TOKEN': TOKEN}):
            with self.subTest(change=change), self.assertRaises(watch.ConfigError):
                watch.validate({**BASE, **change})
        sender = watch.validate_sender({'HEARTBEAT_URL': 'http://10.0.0.6:8792/heartbeat', 'HEARTBEAT_TOKEN': TOKEN})
        self.assertEqual(sender['ready'], 'http://127.0.0.1:3100/api/ready')
        for change in ({'HEARTBEAT_URL': 'tcp://10.0.0.6:8792'}, {'HEARTBEAT_TOKEN': 'x' * 31},
                       {'READY_URL': 'tcp://127.0.0.1:3100'}, {'TIMEOUT': '0'}):
            with self.subTest(change=change), self.assertRaises(watch.ConfigError):
                watch.validate_sender({'HEARTBEAT_URL': 'http://10.0.0.6:8792/heartbeat', 'HEARTBEAT_TOKEN': TOKEN, **change})
        with self.assertRaises(watch.ConfigError):
            watch.parse_config('FEISHU_WEBHOOK=x', watch.SENDER_KEYS)

    def test_accept_checks_signature_clock_and_order(self):
        body = watch.heartbeat_body(None, 1000)
        sign = watch.heartbeat_signature(TOKEN, body)
        beat, error = watch.accept_heartbeat(TOKEN, body, sign, 1001, 0)
        self.assertEqual((beat['ready'], beat['sent_at'], error), (True, 1000000, None))
        cases = [(TOKEN, body, watch.heartbeat_signature('u' * 40, body), 1001, 0, '签名'),
                 (TOKEN, body, None, 1001, 0, '签名'), (TOKEN, body, '签名非ascii', 1001, 0, '签名'),
                 (TOKEN, body, sign, 1000 + watch.HEARTBEAT_SKEW + 1, 0, '时间戳'),
                 (TOKEN, body, sign, 1001, 1000000, '重放')]
        for token, data, signature, now, last, reason in cases:
            with self.subTest(reason=reason, now=now):
                self.assertIn(reason, watch.accept_heartbeat(token, data, signature, now, last)[1])
        for bad in (b'{}', b'[1]', b'{"sent_at": 1000000.5, "ready": true}', b'{"sent_at": 1000000, "ready": "yes"}'):
            with self.subTest(bad=bad):
                self.assertEqual(watch.accept_heartbeat(TOKEN, bad, watch.heartbeat_signature(TOKEN, bad), 1000, 0)[1], '格式错误')

    def test_freshness_and_readiness(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, watch.HEARTBEAT_FILE)
            listen = '127.0.0.1:1'  # 无人监听：缺心跳时附带接收服务未运行
            self.assertIn('本机心跳接收服务未运行', watch.heartbeat_error(path, 1000, listen, 1))
            watch.save_state(path, {'received_at': 1000, 'sent_at': 1, 'ready': True, 'detail': ''})
            self.assertIsNone(watch.heartbeat_error(path, 1000 + watch.HEARTBEAT_STALE, listen, 1))
            self.assertIn('秒未收到', watch.heartbeat_error(path, 1001 + watch.HEARTBEAT_STALE, listen, 1))
            watch.save_state(path, {'received_at': 1000, 'sent_at': 1, 'ready': False, 'detail': 'HTTP 503'})
            self.assertEqual(watch.heartbeat_error(path, 1010, listen, 1), '主服务器自检未就绪：HTTP 503')
            Path(path).write_text('{"received_at": "x"}')
            self.assertIn('损坏', watch.heartbeat_error(path, 1010, listen, 1))


class HeartbeatEndToEndTests(unittest.TestCase):
    """真实接收服务 + 真实发送端 + 假工作台就绪接口。"""

    def setUp(self):
        self.app = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.app.posts, self.app.reply = [], {'code': 0}
        threading.Thread(target=self.app.serve_forever, daemon=True).start()
        self.addCleanup(self.app.server_close)
        self.addCleanup(self.app.shutdown)
        self.base = f'http://127.0.0.1:{self.app.server_port}'
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        started = threading.Event()
        receiver = {'token': TOKEN, 'listen': '127.0.0.1:0'}
        self.logs = []

        def ready(server):
            self.receiver = server
            started.set()
        threading.Thread(target=watch.serve, args=(receiver, self.dir.name, self.logs.append, ready), daemon=True).start()
        self.assertTrue(started.wait(5))
        self.addCleanup(self.receiver.server_close)
        self.addCleanup(self.receiver.shutdown)
        self.listen = f'127.0.0.1:{self.receiver.server_port}'
        self.sender = os.path.join(self.dir.name, 'sender')
        self.watch = os.path.join(self.dir.name, 'config')
        Path(self.watch).write_text(f'FEISHU_WEBHOOK={self.base}/hook\nHEARTBEAT_LISTEN={self.listen}\nHEARTBEAT_TOKEN={TOKEN}\nFAIL_THRESHOLD=1\n')

    def send(self, token=TOKEN, ready='/api/ready'):
        Path(self.sender).write_text(f'HEARTBEAT_URL=http://{self.listen}/heartbeat\nHEARTBEAT_TOKEN={token}\nREADY_URL={self.base}{ready}\n')
        return watch.main(['--sender', '--config', self.sender])

    def beat(self):
        return json.loads(Path(self.dir.name, watch.HEARTBEAT_FILE).read_text())

    def run_watch(self, *args):
        return watch.main(['--config', self.watch, '--state', os.path.join(self.dir.name, 'state.json'), *args])

    def test_signed_heartbeat_reaches_watcher(self):
        self.assertEqual(self.run_watch('--probe'), 1, 'no heartbeat yet')
        self.assertEqual(watch.main(['--sender', '--config', self.sender, '--check']), 2, 'missing sender config')
        self.assertEqual(self.send(), 0)
        self.assertEqual((self.beat()['ready'], self.beat()['peer']), (True, '127.0.0.1'))
        self.assertEqual(self.run_watch('--probe'), 0)
        self.assertEqual(self.run_watch(), 0)
        self.assertEqual(self.app.posts, [], 'healthy heartbeat sends nothing')
        self.assertEqual(self.send(ready='/down'), 0, 'delivered even when the workbench is not ready')
        self.assertIs(self.beat()['ready'], False)
        self.assertEqual(self.run_watch(), 0)
        self.assertIn('主服务器自检未就绪：HTTP 503', self.app.posts[-1]['content']['text'])

    def test_receiver_rejects_wrong_token_replay_and_junk(self):
        self.assertEqual(self.send(), 0)
        before = self.beat()
        self.assertEqual(self.send(token='w' * 40), 1)
        self.assertEqual(self.beat(), before)
        body = watch.heartbeat_body(None, before['sent_at'] / 1000)
        url = f'http://{self.listen}/heartbeat'
        for data, headers, code in ((body, {watch.SIGNATURE_HEADER: watch.heartbeat_signature(TOKEN, body)}, 403),
                                    (b'x' * (watch.HEARTBEAT_MAX_BODY + 1), {}, 413)):
            with self.subTest(code=code), self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=5)
            self.assertEqual(caught.exception.code, code)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f'http://{self.listen}/heartbeat', timeout=5)
        self.assertEqual(caught.exception.code, 404)
        self.assertEqual(self.beat(), before)
        self.assertEqual(len(self.logs), 2, '启动日志与每分钟最多一条拒绝日志')
        self.assertIn('签名不符', self.logs[1])


if __name__ == '__main__':
    unittest.main()
