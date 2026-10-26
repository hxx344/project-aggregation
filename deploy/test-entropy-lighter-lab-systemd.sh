#!/usr/bin/env bash
# Real, offline systemd acceptance on an explicitly disposable native Ubuntu runner.
set -Eeuo pipefail
[[ ${AGG_LAB_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires AGG_LAB_DISPOSABLE_CI=1 GITHUB_ACTIONS=true on a disposable Linux root runner.' >&2; exit 1;
}
! grep -qi microsoft /proc/sys/kernel/osrelease || { echo 'WSL is not an accepted test environment.' >&2; exit 1; }
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'A real systemd PID 1 is required.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
service=entropy-lighter-lab
root=/opt/entropy-lighter-lab
etc=/etc/entropy-lighter-lab
data=/var/lib/entropy-lighter-lab
unit=/etc/systemd/system/entropy-lighter-lab.service
for target in "$root" "$etc" "$data" "$unit" "$unit.d"; do
  [[ ! -e $target && ! -L $target ]] || { echo "Refusing to replace an existing fixture target: $target" >&2; exit 1; }
done
! id "$service" >/dev/null 2>&1 || { echo 'Research service account already exists.' >&2; exit 1; }
[[ $(systemctl show "$service" --property=LoadState --value) == not-found ]] || { echo 'Research service already exists.' >&2; exit 1; }
umask 022
fixture=$(mktemp -d /opt/entropy-lighter-ci-XXXXXXXX)
cleanup() {
  result=$?
  trap - EXIT
  if ((result)); then journalctl -u "$service" --no-pager -n 60 || true; fi
  systemctl disable --now "$service" >/dev/null 2>&1 || true
  rm -f -- "$unit"
  # All exact targets were checked absent above and belong solely to this fixture.
  rm -rf -- "$unit.d" "$root" "$etc" "$data"
  systemctl daemon-reload || true
  userdel "$service" >/dev/null 2>&1 || true
  groupdel "$service" >/dev/null 2>&1 || true
  [[ $fixture == /opt/entropy-lighter-ci-* && -d $fixture && ! -L $fixture ]] && rm -rf -- "$fixture"
  exit "$result"
}
trap cleanup EXIT
chmod 755 "$fixture"
mkdir "$fixture/source"
git -c safe.directory="$repository" -C "$repository" archive HEAD deploy/install-entropy-lighter-lab.sh tools/entropy-lighter-lab | \
  tar -x -C "$fixture/source" --no-same-owner
chmod -R go-w "$fixture/source"
source_dir="$fixture/source"
# Public data is deliberately unreachable from first boot onwards. Liveness is
# the collector's local heartbeat, while samples remain a separate research state.
install -d -m 755 "$unit.d"
printf '[Service]\nPrivateNetwork=true\n' > "$unit.d/ci-offline.conf"
install_lab() { bash "$source_dir/deploy/install-entropy-lighter-lab.sh" --source "$source_dir"; }
install_lab
systemctl is-active --quiet "$service"
systemctl is-enabled --quiet "$service"
current=$(readlink -f "$root/current")
node=$(readlink -f "$current/node")
[[ $("$node" --version) == v24.* ]]
[[ $(systemctl show "$service" --property=User --value) == "$service" ]]
[[ $(systemctl show "$service" --property=PrivateNetwork --value) == yes ]]
[[ $(stat -c '%U:%G:%a' "$etc/config.json") == root:entropy-lighter-lab:640 ]]
[[ $(stat -c '%U:%G:%a' "$data") == entropy-lighter-lab:entropy-lighter-lab:750 ]]
runuser -u "$service" -- test ! -w "$current/tools/entropy-lighter-lab/cli.mjs"
runuser -u "$service" -- test ! -w "$node"
runuser -u "$service" -- test ! -w "$etc/config.json"
"$node" "$root/current/tools/entropy-lighter-lab/cli.mjs" report --data "$data" > "$fixture/report.json"
/usr/bin/python3 -I - "$data/status.json" "$fixture/report.json" "$(systemctl show "$service" --property=MainPID --value)" <<'PY'
import json, sys
from pathlib import Path
status = json.loads(Path(sys.argv[1]).read_text())
report = json.loads(Path(sys.argv[2]).read_text())
assert status['pid'] == int(sys.argv[3]), status
assert status['mode'] == 'research' and status['session'], status
assert status['startedAt'] and status['heartbeatAt'], status
assert isinstance(report, dict), report
PY
printf 'preserved research data\n' > "$data/ci-preserved.jsonl"
chown "$service:$service" "$data/ci-preserved.jsonl"
config_hash=$(sha256sum "$etc/config.json" | cut -d ' ' -f1)
pid=$(systemctl show "$service" --property=MainPID --value)
runtime_hash=$(sha256sum "$node" | cut -d ' ' -f1)
install_lab
[[ $(readlink -f "$root/current") == "$current" ]]
[[ $(systemctl show "$service" --property=MainPID --value) == "$pid" ]]
[[ $(sha256sum "$node" | cut -d ' ' -f1) == "$runtime_hash" ]]

# Configuration bytes and content changes each trigger only the dedicated service.
printf '\n' >> "$etc/config.json"
install_lab
configured=$(readlink -f "$root/current")
[[ $configured != "$current" ]]
[[ $(systemctl show "$service" --property=MainPID --value) != "$pid" ]]
printf '\n// Disposable CI content-only upgrade.\n' >> "$source_dir/tools/entropy-lighter-lab/cli.mjs"
install_lab
updated=$(readlink -f "$root/current")
[[ $updated != "$configured" && -d $configured ]]
[[ $(readlink -f "$updated/node") == "$node" ]]
[[ $(sha256sum "$node" | cut -d ' ' -f1) == "$runtime_hash" ]]
[[ $(cat "$data/ci-preserved.jsonl") == 'preserved research data' ]]
cp -- "$unit" "$fixture/working.service"
saved_config=$(sha256sum "$etc/config.json" | cut -d ' ' -f1)

# Offline check still succeeds, but the actual symlink/systemd run path fails.
/usr/bin/python3 -I - "$source_dir/tools/entropy-lighter-lab/cli.mjs" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
injected = 'if (process.argv[2] === "run") throw new Error("disposable CI startup failure");\n'
if text.startswith('#!'):
    first, rest = text.split('\n', 1)
    path.write_text(first + '\n' + injected + rest)
else:
    path.write_text(injected + text)
PY
if install_lab; then echo 'A failing research update unexpectedly succeeded.' >&2; exit 1; fi
[[ $(readlink -f "$root/current") == "$updated" ]]
cmp -- "$unit" "$fixture/working.service"
[[ $(sha256sum "$etc/config.json" | cut -d ' ' -f1) == "$saved_config" ]]
[[ $(cat "$data/ci-preserved.jsonl") == 'preserved research data' ]]
systemctl is-enabled --quiet "$service"
recovered=0
for attempt in {1..30}; do
  if systemctl is-active --quiet "$service" && /usr/bin/python3 -I - "$data/status.json" "$(systemctl show "$service" --property=MainPID --value)" <<'PY'
import datetime, json, sys
from pathlib import Path
value = json.loads(Path(sys.argv[1]).read_text())
heartbeat = datetime.datetime.fromisoformat(value['heartbeatAt'].replace('Z', '+00:00'))
assert value['pid'] == int(sys.argv[2]) > 0
assert -5 <= (datetime.datetime.now(datetime.timezone.utc) - heartbeat).total_seconds() <= 30
PY
  then recovered=1; break; fi
  sleep 1
done
[[ $recovered == 1 ]] || { echo 'The previous research process did not recover.' >&2; exit 1; }
printf 'Native systemd offline first boot, non-root isolation, no-op, runtime reuse, data/config preservation and startup rollback passed.\n'
