#!/usr/bin/env python3
"""在副服务器巡检主服务器：连续失败达到阈值发飞书告警，故障持续时定期提醒，恢复后发恢复通知。

每次运行只巡检一轮，由 systemd 定时器按分钟调用。只用 Python 标准库。
"""
import argparse, base64, hashlib, hmac, ipaddress, json, os, socket, sys, time, urllib.error, urllib.request
from urllib.parse import urlsplit

KEYS = ('FEISHU_WEBHOOK', 'FEISHU_SECRET', 'NAME', 'MAIN', 'CHECKS', 'FAIL_THRESHOLD', 'REMIND_MINUTES', 'TIMEOUT')
DEFAULTS = {'FEISHU_SECRET': '', 'NAME': '主服务器', 'MAIN': '', 'CHECKS': '', 'FAIL_THRESHOLD': '3', 'REMIND_MINUTES': '30', 'TIMEOUT': '10'}
SEND_TIMEOUT = 10
MAX_CHECKS = 20


class ConfigError(ValueError):
    pass


def parse_config(text):
    """读取 KEY=VALUE 配置；未知键、重复键和格式错误直接报错，不静默忽略。"""
    values = {}
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        key, value = key.strip(), value.strip()
        if not sep or key not in KEYS:
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
    if not checks:
        raise ConfigError('MAIN 与 CHECKS 至少需要一个检查目标')
    if len(checks) > MAX_CHECKS or len(set(checks)) != len(checks):
        raise ConfigError(f'CHECKS 不能重复，最多 {MAX_CHECKS} 个')
    for target in checks:
        if not target_ok(target):
            raise ConfigError(f'检查目标无效：{target}（支持 http(s)://... 或 tcp://主机:端口）')
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
            'threshold': numbers['FAIL_THRESHOLD'], 'remind': numbers['REMIND_MINUTES'] * 60, 'timeout': numbers['TIMEOUT']}


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
        # 待补发的恢复通知属于上一次故障；再次失败后按新故障重新计数。
        entry.pop('recovery', None)
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
    parser = argparse.ArgumentParser(description='巡检主服务器并通过飞书告警')
    parser.add_argument('--config', default='/etc/main-watch/config', help='配置文件，默认 /etc/main-watch/config')
    parser.add_argument('--state', help='状态文件；默认 $STATE_DIRECTORY/state.json')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='只校验配置')
    mode.add_argument('--test', action='store_true', help='发送一条测试消息')
    mode.add_argument('--probe', action='store_true', help='逐个探测检查目标并打印结果，不发告警、不写状态')
    args = parser.parse_args(argv)
    try:
        with open(args.config, encoding='utf-8') as handle:
            config = validate(parse_config(handle.read()))
    except (OSError, ConfigError) as error:
        print(f'配置错误：{error}', file=sys.stderr)
        return 2
    if args.check:
        print(f'配置有效：{len(config["checks"])} 个检查目标')
        return 0
    if args.test:
        try:
            send(config, f'[测试] {config["name"]} 监控告警通道正常 {time.strftime("%Y-%m-%d %H:%M:%S")}')
        except Exception as error:
            print(f'测试消息发送失败：{error}', file=sys.stderr)
            return 1
        print('测试消息已发送')
        return 0
    if args.probe:
        failed = 0
        for target in config['checks']:
            error = probe(target, config['timeout'])
            failed += error is not None
            print(f'{"正常" if error is None else "失败"} {target}' + (f'：{error}' if error else ''))
        return 1 if failed else 0
    state_path = args.state or os.path.join(os.environ.get('STATE_DIRECTORY') or '.', 'state.json')
    state = run_round(config, load_state(state_path), time.time(), probe, lambda text: send(config, text), print)
    save_state(state_path, state)
    return 0


if __name__ == '__main__':
    sys.exit(main())
