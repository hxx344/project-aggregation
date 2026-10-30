#!/usr/bin/env bash
# Real systemd acceptance for install-main-watch.sh on an explicitly disposable Linux runner.
set -Eeuo pipefail
[[ ${AGG_WATCH_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires AGG_WATCH_DISPOSABLE_CI=1 GITHUB_ACTIONS=true on a disposable Linux root runner.' >&2; exit 1;
}
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'A real systemd PID 1 is required.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
service=main-watch
for target in /opt/main-watch /etc/main-watch /var/lib/main-watch /etc/systemd/system/main-watch.service \
    /etc/systemd/system/main-watch.timer /usr/local/bin/main-watch; do
  [[ ! -e $target && ! -L $target ]] || { echo "Refusing to replace an existing fixture target: $target" >&2; exit 1; }
done
! id "$service" >/dev/null 2>&1 || { echo 'Service account already exists.' >&2; exit 1; }
umask 022
fixture=$(mktemp -d /opt/main-watch-ci-XXXXXXXX)
server_pid=''
cleanup() {
  result=$?
  trap - EXIT
  if ((result)); then journalctl -u main-watch.service --no-pager -n 40 || true; fi
  [[ -z $server_pid ]] || kill "$server_pid" 2>/dev/null || true
  systemctl disable --now main-watch.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/main-watch.service /etc/systemd/system/main-watch.timer /usr/local/bin/main-watch
  rm -rf /opt/main-watch /etc/main-watch /var/lib/main-watch /var/lib/private/main-watch
  systemctl daemon-reload || true
  userdel "$service" >/dev/null 2>&1 || true
  groupdel "$service" >/dev/null 2>&1 || true
  [[ $fixture == /opt/main-watch-ci-* && -d $fixture && ! -L $fixture ]] && rm -rf -- "$fixture"
  exit "$result"
}
trap cleanup EXIT
chmod 755 "$fixture"
mkdir "$fixture/source"
git -c safe.directory="$repository" -C "$repository" archive HEAD deploy/install-main-watch.sh tools/main-watch | \
  tar -x -C "$fixture/source" --no-same-owner
chmod -R go-w,a+rX "$fixture/source"

# Loopback stand-ins: /api/ready answers 200, /hook records Feishu posts and fails while the flag file exists.
cat > "$fixture/server.py" <<'PY'
import http.server, json, os, sys
root = sys.argv[1]
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200 if self.path == '/api/ready' else 503); self.end_headers()
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        failing = os.path.exists(os.path.join(root, 'fail'))
        if not failing:
            with open(os.path.join(root, 'posts.log'), 'ab') as handle: handle.write(body + b'\n')
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({'code': 19021, 'msg': 'sign match fail'} if failing else {'code': 0}).encode())
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
with open(os.path.join(root, 'port.next'), 'w') as handle: handle.write(str(server.server_port))
os.replace(os.path.join(root, 'port.next'), os.path.join(root, 'port'))
server.serve_forever()
PY
python3 -I "$fixture/server.py" "$fixture" & server_pid=$!
for _ in {1..50}; do [[ -f $fixture/port ]] && break; sleep 0.1; done
port=$(cat "$fixture/port")
installer=("$fixture/source/deploy/install-main-watch.sh" --source "$fixture/source")
posts() { [[ -f $fixture/posts.log ]] && wc -l < "$fixture/posts.log" || echo 0; }

# Expect a failure whose output names the intended reason, so unrelated errors cannot pass.
fails() { local reason=$1 output; shift; if output=$("$@" 2>&1); then echo "Expected failure: $*" >&2; exit 1; fi
  grep -q -- "$reason" <<< "$output" || { printf 'Unexpected failure reason for %s:\n%s\n' "$*" "$output" >&2; exit 1; }; }

echo '== a rejected first install leaves no service behind'
touch "$fixture/fail"
fails '飞书测试消息发送失败' bash "${installer[@]}" --main "127.0.0.1:$port" --webhook "http://127.0.0.1:$port/hook"
[[ ! -e /opt/main-watch/main_watch.py && ! -e /etc/systemd/system/main-watch.timer && ! -e /etc/main-watch/config && ! -e /usr/local/bin/main-watch ]]
if systemctl is-enabled --quiet main-watch.timer; then echo 'Timer enabled after a rejected install' >&2; exit 1; fi
rm "$fixture/fail"

echo '== first install sends a test message and runs one real round'
bash "${installer[@]}" --main "127.0.0.1:$port" --checks "http://127.0.0.1:$port/down" \
  --webhook "http://127.0.0.1:$port/hook" --secret ci --threshold 1 | tee "$fixture/first.log"
grep -q '监控告警通道正常' "$fixture/posts.log"
grep -q 'sign' "$fixture/posts.log"
grep -q '服务异常' "$fixture/posts.log"  # threshold 1: the real systemd round alerted on /down
systemctl is-enabled --quiet main-watch.timer && systemctl is-active --quiet main-watch.timer
[[ $(stat -c '%U:%G %a' /etc/main-watch/config) == "root:$service 640" ]]
state=$(readlink -f /var/lib/main-watch)/state.json
[[ $(stat -c %U "$state") == "$service" ]]
python3 -I - "$state" "$port" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
assert state[f'http://127.0.0.1:{sys.argv[2]}/api/ready']['fails'] == 0, state
assert state[f'http://127.0.0.1:{sys.argv[2]}/down']['alerted'] is True, state
PY
grep -q '失败 http://127.0.0.1:.*/down' "$fixture/first.log"

echo '== repeat without arguments is a no-op that keeps configuration'
before=$(posts)
config_before=$(sha256sum /etc/main-watch/config)
bash "${installer[@]}" | tee "$fixture/noop.log"
grep -q '跳过部署' "$fixture/noop.log"
[[ $(posts) == "$before" && $(sha256sum /etc/main-watch/config) == "$config_before" ]]

echo '== a rejected webhook rolls back configuration and keeps the timer running'
touch "$fixture/fail"
fails '飞书测试消息发送失败' bash "${installer[@]}" --threshold 5
[[ $(sha256sum /etc/main-watch/config) == "$config_before" ]]
systemctl is-active --quiet main-watch.timer
rm "$fixture/fail"

echo '== invalid arguments change nothing'
fails '配置无效' bash "${installer[@]}" --checks 'ftp://nope'
[[ $(sha256sum /etc/main-watch/config) == "$config_before" ]]

echo '== changing only the extra checks keeps the readiness check'
bash "${installer[@]}" --checks "tcp://127.0.0.1:$port"
grep -qx "MAIN=127.0.0.1:$port" /etc/main-watch/config
grep -qx "CHECKS=tcp://127.0.0.1:$port" /etc/main-watch/config
probe=$(/usr/local/bin/main-watch probe)
grep -q "正常 http://127.0.0.1:$port/api/ready" <<< "$probe"

echo '== a broken deployment is repaired instead of skipped'
# Only the last systemd round is unhealthy: files and permissions match again before the rerun.
chmod 700 /etc/main-watch
systemctl start main-watch.service || true
[[ $(systemctl show --property=Result --value main-watch.service) != success ]]
chmod 750 /etc/main-watch
bash "${installer[@]}" | tee "$fixture/repair.log"
if grep -q '跳过部署' "$fixture/repair.log"; then echo 'Broken deployment was skipped' >&2; exit 1; fi
[[ $(stat -c '%U:%G %a' /etc/main-watch) == "root:$service 750" ]]
[[ $(systemctl show --property=Result --value main-watch.service) == success ]]

echo '== management command and uninstall'
/usr/local/bin/main-watch check
/usr/local/bin/main-watch probe >/dev/null || true
bash "${installer[@]}" --uninstall
[[ ! -e /etc/systemd/system/main-watch.timer && ! -e /opt/main-watch && -f /etc/main-watch/config ]]
if systemctl is-active --quiet main-watch.timer; then echo 'Timer still active after uninstall' >&2; exit 1; fi
echo 'main-watch systemd acceptance passed'
