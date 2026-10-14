#!/usr/bin/env bash
# Real install on a disposable native Ubuntu runner; never a user's server or WSL.
set -Eeuo pipefail
[[ ${AGG_RELAY_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires AGG_RELAY_DISPOSABLE_CI=1 GITHUB_ACTIONS=true on a disposable Linux root runner.' >&2; exit 1;
}
! grep -qi microsoft /proc/sys/kernel/osrelease || { echo 'WSL is not an accepted test environment.' >&2; exit 1; }
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'A real systemd PID 1 is required.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
service=aster-capacity-relay
root=/opt/aster-capacity-relay
etc=/etc/aster-capacity-relay
unit=/etc/systemd/system/aster-capacity-relay.service
cli=/usr/local/bin/aster-capacity-relay
for target in "$root" "$etc" "$unit" "$cli"; do
  [[ ! -e "$target" && ! -L "$target" ]] || { echo "Refusing to replace an existing fixture target: $target" >&2; exit 1; }
done
! id "$service" >/dev/null 2>&1 || { echo 'Relay service account already exists.' >&2; exit 1; }
[[ $(systemctl show "$service" --property=LoadState --value) == not-found ]] || {
  echo 'Relay service is already installed.' >&2; exit 1;
}
umask 022
fixture=$(mktemp -d /opt/aster-relay-ci-XXXXXXXX)
cleanup() {
  result=$?
  trap - EXIT
  if ((result)); then journalctl -u "$service" --no-pager -n 50 || true; fi
  systemctl disable --now "$service" >/dev/null 2>&1 || true
  rm -f -- "$unit" "$cli"
  systemctl daemon-reload || true
  userdel "$service" >/dev/null 2>&1 || true
  groupdel "$service" >/dev/null 2>&1 || true
  # Exact paths were proven absent above and are owned solely by this fixture.
  rm -rf -- "$root" "$etc"
  [[ "$fixture" == /opt/aster-relay-ci-* && -d "$fixture" && ! -L "$fixture" ]] && rm -rf -- "$fixture"
  exit "$result"
}
trap cleanup EXIT
chmod 0755 "$fixture"
mkdir "$fixture/source"
git -c safe.directory="$repository" -C "$repository" archive HEAD | tar -x -C "$fixture/source" --no-same-owner
chmod -R go-w "$fixture/source"
source_dir="$fixture/source"
install_relay() { bash "$source_dir/deploy/install-aster-relay.sh" --source "$source_dir" --address 127.0.0.1; }

install_relay
systemctl is-active --quiet "$service"
systemctl is-enabled --quiet "$service"
current=$(readlink -f "$root/current")
python="$current/.venv/bin/python"
[[ -x "$python" ]]
[[ $(stat -c '%U:%G:%a' "$etc/environment") == root:root:600 || $(stat -c '%U:%G:%a' "$etc/environment") == root:aster-capacity-relay:600 ]]
[[ $(stat -c '%U:%G:%a' "$etc/server.key") == root:aster-capacity-relay:640 ]]
[[ $(systemctl show "$service" --property=User --value) == "$service" ]]
runuser -u "$service" -- test ! -w "$current/modules/aster/trading/capacity_relay_server.py"
runuser -u "$service" -- test ! -w "$current/.venv/bin/python"
"$python" -I "$current/deploy/configure-aster-relay.py" health
"$python" -I "$current/deploy/configure-aster-relay.py" status > "$fixture/status.json"
/usr/bin/python3 -I - "$fixture/status.json" <<'PY'
import json, sys
from pathlib import Path
status = json.loads(Path(sys.argv[1]).read_text())
assert status['collector_running'] is True, status
assert status['configured_symbols'] == ['XAUUSD1', 'XAGUSD1'], status
assert {(row['symbol'], row['kind']) for row in status['samples']} == {
    (symbol, kind) for symbol in ('XAUUSD1', 'XAGUSD1') for kind in ('oi', 'brackets')}, status
# Upstream availability is intentionally not an installation success criterion.
PY

# Protocol tests use an offline upstream and real local TLS/WSS under the target Python.
(cd "$source_dir/modules/aster"; runuser -u "$service" -- env PYTHONPATH="$source_dir/modules/aster:$source_dir/modules/aster/tests" \
  "$python" -m unittest test_capacity_relay_server test_capacity_relay_client test_capacity_relay_status test_capacity_relay_e2e)
state_hash() { sha256sum "$etc/environment" "$etc/server.crt" "$etc/server.key" "$etc/address" | sha256sum | cut -d ' ' -f1; }
saved_state=$(state_hash)
pid=$(systemctl show "$service" --property=MainPID --value)
environment=$(readlink -f "$current/.venv")
environment_state() { find "$environment" -printf '%y %P %i %s %T@\n' | sort | sha256sum | cut -d ' ' -f1; }
saved_environment=$(environment_state)
install_relay
[[ $(readlink -f "$root/current") == "$current" ]]
[[ $(systemctl show "$service" --property=MainPID --value) == "$pid" ]]
[[ $(state_hash) == "$saved_state" ]]
[[ $(environment_state) == "$saved_environment" ]]

# A code-only update reuses the environment and preserves the connection identity.
printf '\n# Disposable CI code-only upgrade.\n' >> "$source_dir/modules/aster/trading/capacity_relay_server.py"
install_relay
updated=$(readlink -f "$root/current")
[[ "$updated" != "$current" && -d "$current" ]]
[[ $(readlink -f "$updated/.venv") == "$environment" ]]
[[ $(environment_state) == "$saved_environment" ]]
[[ $(state_hash) == "$saved_state" ]]
cp -- "$unit" "$fixture/working.service"
cp -- "$cli" "$fixture/working.cli"

# Valid local configuration followed by a failed process start exercises activation rollback.
/usr/bin/python3 -I - "$source_dir/modules/aster/trading/capacity_relay_server.py" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
assert '    import uvicorn\n' in text
path.write_text(text.replace('    import uvicorn\n', '    raise RuntimeError("disposable CI startup failure")\n    import uvicorn\n'))
PY
if install_relay; then echo 'A failing relay update unexpectedly succeeded.' >&2; exit 1; fi
[[ $(readlink -f "$root/current") == "$updated" ]]
cmp -- "$unit" "$fixture/working.service"
cmp -- "$cli" "$fixture/working.cli"
systemctl is-enabled --quiet "$service"
[[ $(state_hash) == "$saved_state" ]]
recovered=0
for attempt in $(seq 1 30); do
  if systemctl is-active --quiet "$service" && \
      "$updated/.venv/bin/python" -I "$updated/deploy/configure-aster-relay.py" health >/dev/null 2>&1; then
    recovered=1
    break
  fi
  sleep 1
done
[[ "$recovered" == 1 ]] || { echo 'The previous relay did not recover within 30 seconds.' >&2; exit 1; }
printf 'Native systemd install, authenticated TLS/WSS, no-op, dependency reuse, identity preservation and startup rollback passed.\n'
