#!/usr/bin/env python3
"""在副服务器巡检主服务器：连续失败达到阈值发飞书告警，故障持续时定期提醒，恢复后发恢复通知。

每次运行只巡检一轮，由 systemd 定时器按分钟调用。可选心跳模式：主服务器定时推送签名心跳（--sender），
副服务器常驻接收（--serve），巡检把心跳是否新鲜、主服务器自检是否就绪当作一个检查目标。只用 Python 标准库。
"""
import argparse, base64, hashlib, hmac, http.server, ipaddress, json, os, re, socket, sys, threading, time, urllib.error, urllib.request
from urllib.parse import urlsplit

KEYS = ('FEISHU_WEBHOOK', 'FEISHU_SECRET', 'NAME', 'MAIN', 'CHECKS', 'HEARTBEAT_LISTEN', 'HEARTBEAT_TOKEN', 'FAIL_THRESHOLD', 'REMIND_MINUTES', 'TIMEOUT')
DEFAULTS = {'FEISHU_SECRET': '', 'NAME': '主服务器', 'MAIN': '', 'CHECKS': '', 'HEARTBEAT_LISTEN': '', 'HEARTBEAT_TOKEN': '',
            'FAIL_THRESHOLD': '3', 'REMIND_MINUTES': '30', 'TIMEOUT': '10'}
SENDER_KEYS = ('HEARTBEAT_URL', 'HEARTBEAT_TOKEN', 'READY_URL', 'TIMEOUT')
SENDER_DEFAULTS = {'READY_URL': 'http://127.0.0.1:3100/api/ready', 'TIMEOUT': '10'}
SEND_TIMEOUT = 10
MAX_CHECKS = 20
STATE_DIR = '/var/lib/main-watch'
HEARTBEAT_FILE = 'heartbeat.json'
HEARTBEAT_STALE = 90  # 发送端每 30 秒一次，连丢两次以上才算本轮失败
HEARTBEAT_SKEW = 120  # 两台服务器时钟允许的偏差（秒），也是在途心跳可被拖延的上限
HEARTBEAT_CONNECTIONS = 16  # 接收服务同时处理的连接上限，超出的直接关闭
REJECT_LOG_INTERVAL = 60
HEARTBEAT_MAX_BODY = 4096
SIGNATURE_HEADER = 'X-Main-Watch-Signature'
TOKEN_PATTERN = re.compile(r'[A-Za-z0-9_-]{32,256}')


class ConfigError(ValueError):
    pass


def parse_config(text, keys=KEYS):
    """读取 KEY=VALUE 配置；未知键、重复键和格式错误直接报错，不静默忽略。"""
    values = {}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not sep or key not in keys:
            raise ConfigError(f'第 {number} 行无法识别：{key or line}')
        if key in values:
            raise ConfigError(f'第 {number} 行重复配置 {key}')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key] = value
    return values


def loopback(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == 'localhost'


def target_ok(target):
    parts = urlsplit(target)
    try:
        port = parts.port
    except ValueError:
        return False
    if parts.scheme == 'tcp':
        return bool(parts.hostname) and port is not None and parts.path in ('', '/') and not parts.query
    return parts.scheme in ('http', 'https') and bool(parts.hostname) and not parts.username and not parts.password


def http_ok(url):
    return url.startswith(('http://', 'https://')) and target_ok(url)


def token_ok(token):
    return bool(TOKEN_PATTERN.fullmatch(token))


def local_address(listen):
    """心跳监听地址对应的本机可连地址；监听全部网卡时连回环。"""
    parts = urlsplit(f'tcp://{listen}')
    host = {'0.0.0.0': '127.0.0.1', '::': '::1'}.get(parts.hostname, parts.hostname)
    return host, parts.port


def validate(values):
    """返回规范化配置；任何一项不合法都报错，安装器据此拒绝写入。"""
    config = {**DEFAULTS, **values}
    webhook = config.get('FEISHU_WEBHOOK', '')
    parts = urlsplit(webhook)
    if not (parts.hostname and not parts.username and (parts.scheme == 'https' or (parts.scheme == 'http' and loopback(parts.hostname)))):
        raise ConfigError('FEISHU_WEBHOOK 必须是 https 地址（如 https://open.feishu.cn/open-apis/bot/v2/hook/...）')
    main = config['MAIN'].strip()
    if main and not target_ok(f'tcp://{main}'):
        raise ConfigError(f'MAIN 格式应为 主机:端口：{main}')
    # MAIN 是工作台就绪检查，与额外目标 CHECKS 分开保存，单独修改任一项不会顶掉另一项。
    checks = ([f'http://{main}/api/ready'] if main else []) + config['CHECKS'].split()
    if len(checks) > MAX_CHECKS or len(set(checks)) != len(checks):
        raise ConfigError(f'CHECKS 不能重复，最多 {MAX_CHECKS} 个')
    for target in checks:
        if not target_ok(target):
            raise ConfigError(f'检查目标无效：{target}（支持 http(s)://... 或 tcp://主机:端口）')
    listen, token, heartbeat = config['HEARTBEAT_LISTEN'].strip(), config['HEARTBEAT_TOKEN'], None
    if listen:
        port = urlsplit(f'tcp://{listen}').port if target_ok(f'tcp://{listen}') else None
        if port is None or not 1024 <= port <= 65535:
            raise ConfigError(f'HEARTBEAT_LISTEN 格式应为 主机:端口（端口 1024~65535），如 0.0.0.0:8792：{listen}')
        if not token_ok(token):
            raise ConfigError('HEARTBEAT_TOKEN 须为 32~256 位字母、数字、- 或 _')
        heartbeat = f'heartbeat://{listen}'
        checks.append(heartbeat)
    if not checks:
        raise ConfigError('MAIN、CHECKS 与 HEARTBEAT_LISTEN 至少需要一个检查目标')
    numbers = {}
    for key, low, high in (('FAIL_THRESHOLD', 1, 60), ('REMIND_MINUTES', 1, 1440), ('TIMEOUT', 1, 30)):
        try:
            numbers[key] = int(config[key])
        except ValueError:
            raise ConfigError(f'{key} 必须是整数') from None
        if not low <= numbers[key] <= high:
            raise ConfigError(f'{key} 必须在 {low}~{high} 之间')
    name = config['NAME'].strip()
    if not name or len(name) > 60:
        raise ConfigError('NAME 不能为空，且不超过 60 个字符')
    return {'webhook': webhook, 'secret': config['FEISHU_SECRET'], 'name': name, 'checks': checks,
            'threshold': numbers['FAIL_THRESHOLD'], 'remind': numbers['REMIND_MINUTES'] * 60, 'timeout': numbers['TIMEOUT'],
            'listen': listen, 'token': token, 'heartbeat': heartbeat}


def validate_sender(values):
    """主服务器端心跳配置：推送地址、共享令牌和本机就绪接口。"""
    config = {**SENDER_DEFAULTS, **values}
    url = config.get('HEARTBEAT_URL', '')
    if not http_ok(url):
        raise ConfigError('HEARTBEAT_URL 须为 http(s) 地址，如 http://副服务器IP:8792/heartbeat')
    if not token_ok(config.get('HEARTBEAT_TOKEN', '')):
        raise ConfigError('HEARTBEAT_TOKEN 须为 32~256 位字母、数字、- 或 _（与副服务器配置一致）')
    if not http_ok(config['READY_URL']):
        raise ConfigError(f'READY_URL 须为 http(s) 地址：{config["READY_URL"]}')
    try:
        timeout = int(config['TIMEOUT'])
    except ValueError:
        raise ConfigError('TIMEOUT 必须是整数') from None
    if not 1 <= timeout <= 30:
        raise ConfigError('TIMEOUT 必须在 1~30 之间')
    return {'url': url, 'token': config['HEARTBEAT_TOKEN'], 'ready': config['READY_URL'], 'timeout': timeout}


def role(sender):
    return (SENDER_KEYS, validate_sender) if sender else (KEYS, validate)


def probe(target, timeout):
    """返回 None 表示正常，否则返回错误描述。HTTP 要求 2xx，TCP 要求端口可连。"""
    try:
        if target.startswith('tcp://'):
            parts = urlsplit(target)
            socket.create_connection((parts.hostname, parts.port), timeout=timeout).close()
            return None
        request = urllib.request.Request(target, headers={'User-Agent': 'main-watch', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return None if 200 <= response.status < 300 else f'HTTP {response.status}'
    except urllib.error.HTTPError as error:
        return f'HTTP {error.code}'
    except Exception as error:
        return f'{type(error).__name__}: {error}'[:200]


def heartbeat_signature(token, body):
    return hmac.new(token.encode(), body, hashlib.sha256).hexdigest()


def heartbeat_body(ready_error, now):
    """心跳正文：毫秒发送时间（防重放）、主服务器本机就绪结果。"""
    return json.dumps({'sent_at': int(now * 1000), 'ready': ready_error is None, 'detail': ready_error or ''},
                      ensure_ascii=False).encode()


def send_heartbeat(config):
    """探测本机就绪接口后推送一次心跳；返回就绪错误（None 为就绪），推送失败抛异常。"""
    error = probe(config['ready'], config['timeout'])
    body = heartbeat_body(error, time.time())
    request = urllib.request.Request(config['url'], body, {'Content-Type': 'application/json; charset=utf-8',
                                                           SIGNATURE_HEADER: heartbeat_signature(config['token'], body)})
    with urllib.request.urlopen(request, timeout=config['timeout']) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f'HTTP {response.status}')
    return error


def accept_heartbeat(token, body, signature, now, last_sent):
    """校验签名、时间戳与顺序；返回 (心跳记录, 拒绝原因)。"""
    expected = heartbeat_signature(token, body).encode()
    if not hmac.compare_digest(expected, (signature or '').encode('utf-8', 'replace')):
        return None, '签名不符'
    try:
        beat = json.loads(body)
        sent, ready, detail = beat['sent_at'], beat['ready'], beat.get('detail', '')
    except (ValueError, KeyError, TypeError):
        return None, '格式错误'
    if type(sent) is not int or not isinstance(ready, bool) or not isinstance(detail, str):
        return None, '格式错误'
    if abs(now * 1000 - sent) > HEARTBEAT_SKEW * 1000:
        return None, f'时间戳与本机相差超过 {HEARTBEAT_SKEW} 秒，请校准两台服务器时钟'
    if sent <= last_sent:
        return None, '重放或乱序的心跳'
    return {'received_at': now, 'sent_at': sent, 'ready': ready, 'detail': detail[:200]}, None


def heartbeat_error(path, now, listen, timeout):
    """副服务器每轮检查最近一次心跳；None 表示新鲜且主服务器自检就绪。"""
    try:
        with open(path, encoding='utf-8') as handle:
            beat = json.load(handle)
        received, ready, detail = beat['received_at'], beat['ready'], beat['detail']
        if not isinstance(received, (int, float)) or isinstance(received, bool) or not isinstance(ready, bool):
            raise TypeError
    except FileNotFoundError:
        beat = None
    except (OSError, ValueError, KeyError, TypeError):
        return '心跳记录损坏，等待下一次心跳覆盖'
    if beat is None or now - received > HEARTBEAT_STALE:
        reason = '尚未收到主服务器心跳' if beat is None else f'已 {int(now - received)} 秒未收到主服务器心跳'
        host, port = local_address(listen)
        if probe(f'tcp://[{host}]:{port}' if ':' in host else f'tcp://{host}:{port}', min(timeout, 3)) is not None:
            reason += '（本机心跳接收服务未运行）'
        return reason
    return None if ready else f'主服务器自检未就绪：{detail}'[:200]


def checker(config, state_dir, clock=time.time):
    """心跳目标读心跳记录，其余目标走网络探测。"""
    path = os.path.join(state_dir, HEARTBEAT_FILE)

    def check(target, timeout):
        if target == config['heartbeat']:
            return heartbeat_error(path, clock(), config['listen'], timeout)
        return probe(target, timeout)
    return check


def serve(config, state_dir, log, ready=None):
    """常驻接收心跳：只接受 POST /heartbeat，校验通过后原子写入心跳记录。"""
    path = os.path.join(state_dir, HEARTBEAT_FILE)
    try:
        with open(path, encoding='utf-8') as handle:
            last = [int(json.load(handle)['sent_at'])]
    except (OSError, ValueError, KeyError, TypeError):
        last = [0]
    lock = threading.Lock()
    rejected = {'logged': 0.0, 'skipped': 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 10
        server_version, sys_version = 'main-watch', ''

        def log_message(self, *args):
            pass

        def reply(self, code):
            self.send_response(code)
            self.send_header('Content-Length', '0')
            self.end_headers()

        def do_GET(self):
            self.reply(404)

        def do_POST(self):
            if self.path != '/heartbeat':
                return self.reply(404)
            try:
                length = int(self.headers.get('Content-Length', ''))
            except ValueError:
                return self.reply(411)
            if not 0 < length <= HEARTBEAT_MAX_BODY:
                return self.reply(413)
            body = self.rfile.read(length)
            with lock:
                beat, error = accept_heartbeat(config['token'], body, self.headers.get(SIGNATURE_HEADER), time.time(), last[0])
                if error:
                    # 未鉴权请求可以任意发送，拒绝日志每分钟最多一条，其余只计数。
                    now = time.time()
                    if now - rejected['logged'] >= REJECT_LOG_INTERVAL:
                        extra = f'（此前 1 分钟内另有 {rejected["skipped"]} 条被拒）' if rejected['skipped'] else ''
                        log(f'拒绝来自 {self.client_address[0]} 的心跳：{error}{extra}')
                        rejected.update(logged=now, skipped=0)
                    else:
                        rejected['skipped'] += 1
                    return self.reply(403)
                save_state(path, {**beat, 'peer': self.client_address[0]})
                last[0] = beat['sent_at']
            self.reply(204)

    parts = urlsplit(f'tcp://{config["listen"]}')
    host, port = parts.hostname, parts.port

    class Server(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ':' in host else socket.AF_INET
        slots = threading.BoundedSemaphore(HEARTBEAT_CONNECTIONS)

        def process_request(self, request, client_address):
            if not self.slots.acquire(blocking=False):
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, client_address)
            except Exception:
                self.slots.release()
                raise

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.slots.release()

    with Server((host, port), Handler) as server:
        log(f'心跳接收已启动：{config["listen"]}')
        if ready:
            ready(server)
        server.serve_forever()


def control_target(webhook):
    """告警通道所在主机的 TCP 端口；连不上说明是本机网络问题，本轮不计主服务器失败。"""
    parts = urlsplit(webhook)
    return f'tcp://{parts.hostname}:{parts.port or (443 if parts.scheme == "https" else 80)}'


def feishu_body(text, secret, now):
    body = {'msg_type': 'text', 'content': {'text': text}}
    if secret:
        timestamp = str(int(now))
        body['timestamp'] = timestamp
        body['sign'] = base64.b64encode(hmac.new(f'{timestamp}\n{secret}'.encode(), b'', hashlib.sha256).digest()).decode()
    return body


def send(config, text):
    """单次发送，超时 10 秒，不在本轮重试；失败由下一轮（约 1 分钟后）重发。"""
    data = json.dumps(feishu_body(text, config['secret'], time.time()), ensure_ascii=False).encode()
    request = urllib.request.Request(config['webhook'], data, {'Content-Type': 'application/json; charset=utf-8'})
    with urllib.request.urlopen(request, timeout=SEND_TIMEOUT) as response:
        result = json.loads(response.read(65536) or b'{}')
    code = result.get('code', result.get('StatusCode'))
    if code != 0:
        raise RuntimeError(f'飞书拒绝消息：code={code} {result.get("msg", "")}'.strip())


def duration(seconds):
    seconds = int(seconds)
    if seconds >= 3600:
        return f'{seconds // 3600}小时{seconds % 3600 // 60}分'
    return f'{max(seconds // 60, 1)}分钟'


def fresh():
    return {'fails': 0, 'alerted': False, 'last_alert': 0, 'since': 0}


def entry_of(value):
    """状态文件损坏或字段类型不对时，从初始状态重新计数，不让单个条目拖垮整轮巡检。"""
    entry = {**fresh(), **value} if isinstance(value, dict) else fresh()
    numeric = all(isinstance(entry[key], (int, float)) and not isinstance(entry[key], bool) for key in ('fails', 'last_alert', 'since'))
    if not (numeric and isinstance(entry['alerted'], bool) and isinstance(entry.get('recovery', ''), str)):
        return fresh()
    return entry


def run_round(config, state, now, probe_fn, send_fn, log):
    """巡检一轮并返回新状态。告警发送失败不记为已告警，下一轮会重发。"""
    stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now))
    if probe_fn(control_target(config['webhook']), config['timeout']) is not None:
        log(f'{stamp} 本机连不上飞书，跳过本轮，不计入主服务器失败')
        return state
    state = {target: entry_of(state.get(target)) for target in config['checks']}
    down, recovered = [], []
    for target in config['checks']:
        entry = state[target]
        error = probe_fn(target, config['timeout'])
        if error is None:
            if entry['alerted']:
                recovered.append((target, f'• {target}（中断约 {duration(now - entry["since"])}）'))
            elif entry.get('recovery'):
                recovered.append((target, entry['recovery']))
            state[target] = fresh()
            continue
        # 待补发的恢复通知一直保留，直到发出或被新故障的告警取代，短暂复发不会把它丢掉。
        if entry['fails'] == 0:
            entry['since'] = now
        entry['fails'] += 1
        log(f'{stamp} 失败 {target} 第 {entry["fails"]} 次：{error}')
        if entry['fails'] >= config['threshold'] and (not entry['alerted'] or now - entry['last_alert'] >= config['remind']):
            down.append(target)
            entry['detail'] = f'• {target}\n  {error}（连续 {entry["fails"]} 次，已持续 {duration(now - entry["since"])}）'
    if down:
        try:
            send_fn(f'🔴 {config["name"]} 服务异常 {stamp}\n' + '\n'.join(state[t]['detail'] for t in down))
            for target in down:
                state[target].update(alerted=True, last_alert=now)
                state[target].pop('recovery', None)
            log(f'{stamp} 已发送异常告警：{" ".join(down)}')
        except Exception as error:
            log(f'{stamp} 飞书告警发送失败，下一轮重发：{error}')
    for entry in state.values():
        entry.pop('detail', None)
    if recovered:
        try:
            send_fn(f'🟢 {config["name"]} 服务恢复 {stamp}\n' + '\n'.join(line for _, line in recovered))
            log(f'{stamp} 已发送恢复通知')
        except Exception as error:
            for target, line in recovered:
                state[target]['recovery'] = line
            log(f'{stamp} 飞书恢复通知发送失败，下一轮重发：{error}')
    return state


def load_state(path):
    try:
        with open(path, encoding='utf-8') as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def save_state(path, state):
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(state, handle)
    os.replace(temporary, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description='巡检主服务器并通过飞书告警；--sender 为主服务器端心跳推送')
    parser.add_argument('--sender', action='store_true', help='主服务器端：推送一次心跳，配置默认 /etc/main-watch/sender')
    parser.add_argument('--config', help='配置文件，默认 /etc/main-watch/config（--sender 时为 /etc/main-watch/sender）')
    parser.add_argument('--state', help=f'状态文件；默认 $STATE_DIRECTORY/state.json，未设置时为 {STATE_DIR}/state.json；心跳记录在同一目录')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='只校验配置')
    mode.add_argument('--test', action='store_true', help='发送一条飞书测试消息')
    mode.add_argument('--probe', action='store_true', help='逐个探测检查目标并打印结果，不发告警、不写状态')
    mode.add_argument('--serve', action='store_true', help='常驻接收主服务器心跳（副服务器）')
    args = parser.parse_args(argv)
    if args.sender and (args.test or args.serve):
        parser.error('--sender 只能与 --check、--probe 一起使用')
    keys, check_config = role(args.sender)
    path = args.config or ('/etc/main-watch/sender' if args.sender else '/etc/main-watch/config')
    try:
        with open(path, encoding='utf-8') as handle:
            config = check_config(parse_config(handle.read(), keys))
    except (OSError, ConfigError) as error:
        print(f'配置错误：{error}', file=sys.stderr)
        return 2
    if args.check:
        print('配置有效：心跳推送到 ' + config['url'] if args.sender else f'配置有效：{len(config["checks"])} 个检查目标')
        return 0
    if args.sender:
        if args.probe:
            error = probe(config['ready'], config['timeout'])
            print(f'{"正常" if error is None else "失败"} {config["ready"]}' + (f'：{error}' if error else ''))
            return 1 if error else 0
        try:
            error = send_heartbeat(config)
        except urllib.error.HTTPError as failure:
            hint = '，请核对两端 HEARTBEAT_TOKEN 与时钟' if failure.code == 403 else ''
            print(f'心跳推送被拒绝：HTTP {failure.code}{hint}', file=sys.stderr)
            return 1
        except Exception as failure:
            print(f'心跳推送失败：{type(failure).__name__}: {failure}'[:300], file=sys.stderr)
            return 1
        print('心跳已送达，本机就绪' if error is None else f'心跳已送达，本机未就绪：{error}')
        return 0
    if args.test:
        try:
            send(config, f'[测试] {config["name"]} 监控告警通道正常 {time.strftime("%Y-%m-%d %H:%M:%S")}')
        except Exception as error:
            print(f'测试消息发送失败：{error}', file=sys.stderr)
            return 1
        print('测试消息已发送')
        return 0
    state_path = args.state or os.path.join(os.environ.get('STATE_DIRECTORY') or STATE_DIR, 'state.json')
    state_dir = os.path.dirname(os.path.abspath(state_path))
    if args.serve:
        if not config['heartbeat']:
            print('配置错误：未设置 HEARTBEAT_LISTEN，无需接收心跳', file=sys.stderr)
            return 2
        serve(config, state_dir, lambda text: print(text, flush=True))
        return 0
    check = checker(config, state_dir)
    if args.probe:
        failed = 0
        for target in config['checks']:
            error = check(target, config['timeout'])
            failed += error is not None
            print(f'{"正常" if error is None else "失败"} {target}' + (f'：{error}' if error else ''))
        return 1 if failed else 0
    state = run_round(config, load_state(state_path), time.time(), check, lambda text: send(config, text), print)
    save_state(state_path, state)
    return 0


if __name__ == '__main__':
    sys.exit(main())
