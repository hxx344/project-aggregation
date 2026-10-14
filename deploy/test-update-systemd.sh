#!/usr/bin/env bash
# Disposable GitHub Linux runner only: real service/socket startup, no network or app deployment.
set -Eeuo pipefail
[[ ${AGG_UPDATER_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires AGG_UPDATER_DISPOSABLE_CI=1 GITHUB_ACTIONS=true on a disposable Linux root runner.' >&2; exit 1;
}
! grep -qi microsoft /proc/sys/kernel/osrelease || { echo 'WSL is not an accepted test environment.' >&2; exit 1; }
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'A real systemd PID 1 is required.' >&2; exit 1; }
umask 022
source_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
AGG_INSTALL_SOURCE_ONLY=1 source "$source_root/deploy/install.sh"
progress_unit=project-aggregation-progress-fixture.service

# Guard exact fixed destinations before any mutation, including units loaded from other search paths.
[[ "$UPDATER_DIR" == /usr/local/lib/project-aggregation-updater && "$UPDATER_STATE_DIR" == /var/lib/project-aggregation-updater &&
   "$UPDATER_RUN_DIR" == /run/project-aggregation-updater && "$UPDATER_SERVICE" == project-aggregation-updater &&
   "$UPDATER_WORKER_SERVICE" == project-aggregation-update-worker && "$SERVICE_USER" == project-aggregation &&
   "$UPDATER_UNIT_FILE" == /etc/systemd/system/project-aggregation-updater.service &&
   "$UPDATER_WORKER_UNIT_FILE" == /etc/systemd/system/project-aggregation-update-worker.service ]] || exit 1
for target in /opt/project-aggregation /var/lib/project-aggregation /etc/project-aggregation.env \
  "$UPDATER_DIR" "$UPDATER_STATE_DIR" "$UPDATER_RUN_DIR"; do
  [[ ! -e "$target" && ! -L "$target" ]] || { echo "Refusing existing installation path: $target" >&2; exit 1; }
done
for name in project-aggregation project-aggregation-updater project-aggregation-update-worker project-aggregation-progress-fixture; do
  for base in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
    for target in "$base/$name.service" "$base/$name.service.d" "$base/multi-user.target.wants/$name.service"; do
      [[ ! -e "$target" && ! -L "$target" ]] || { echo "Refusing existing service path: $target" >&2; exit 1; }
    done
  done
  load_state=$(systemctl show --property=LoadState --value "$name.service" 2>/dev/null || true)
  active_state=$(systemctl show --property=ActiveState --value "$name.service" 2>/dev/null || true)
  [[ "$load_state" == not-found && "$active_state" == inactive ]] || {
    echo "Refusing existing or indeterminate service: $name ($load_state/$active_state)" >&2; exit 1;
  }
done
! getent passwd project-aggregation >/dev/null && ! getent group project-aggregation >/dev/null || {
  echo 'Refusing an existing project-aggregation account or group.' >&2; exit 1;
}
getent passwd nobody >/dev/null
command -v runuser >/dev/null

fixture=$(mktemp -d /tmp/agg-updater-systemd.XXXXXXXX)
created_user=0
created_services=0
created_progress_unit=0
cleanup() {
  local result=$? target
  trap - EXIT
  set +e
  if (( created_progress_unit )); then
    if (( result )); then journalctl -u "$progress_unit" --no-pager -n 30 >&2; fi
    systemctl stop "$progress_unit" >/dev/null 2>&1
    systemctl reset-failed "$progress_unit" >/dev/null 2>&1
  fi
  if (( created_services )); then
    if (( result )); then journalctl -u "$UPDATER_SERVICE" -u "$UPDATER_WORKER_SERVICE" --no-pager -n 40 >&2; fi
    systemctl stop "$UPDATER_WORKER_SERVICE" "$UPDATER_SERVICE" >/dev/null 2>&1
    systemctl disable "$UPDATER_SERVICE" >/dev/null 2>&1
    for target in /etc/systemd/system/project-aggregation-updater.service /etc/systemd/system/project-aggregation-update-worker.service; do
      if [[ -f "$target" && ! -L "$target" ]] && grep -qx '# Managed by project-aggregation updater installer' "$target"; then rm -f -- "$target"; fi
    done
    systemctl daemon-reload
    systemctl reset-failed "$UPDATER_SERVICE" "$UPDATER_WORKER_SERVICE" >/dev/null 2>&1
    for target in /usr/local/lib/project-aggregation-updater /var/lib/project-aggregation-updater /run/project-aggregation-updater; do
      if [[ -d "$target" && ! -L "$target" && $(readlink -f -- "$target") == "$target" && $(stat -c %u "$target") == 0 ]]; then
        rm -rf -- "$target"
      fi
    done
  fi
  if (( created_user )); then
    userdel project-aggregation
    if getent group project-aggregation >/dev/null; then groupdel project-aggregation; fi
  fi
  if [[ "$fixture" =~ ^/tmp/agg-updater-systemd\.[A-Za-z0-9]{8}$ && -d "$fixture" && ! -L "$fixture" &&
        $(readlink -f -- "$fixture") == "$fixture" && $(stat -c %u "$fixture") == 0 ]]; then rm -rf -- "$fixture"; fi
  exit "$result"
}
trap cleanup EXIT
chmod 0700 "$fixture"
mkdir -p "$fixture/release/server/update-service" "$fixture/work"
printf 'verified-systemd-fixture\n' > "$fixture/release/.managed-release"
for name in registry releases progress updater; do
  install -m 0644 -o root -g root "$source_root/server/update-service/$name.py" "$fixture/release/server/update-service/$name.py"
done
work_dir="$fixture/work"
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin project-aggregation
created_user=1
created_services=1
ensure_update_service "$fixture/release"
for name in "$UPDATER_SERVICE" "$UPDATER_WORKER_SERVICE"; do
  [[ $(systemctl show --property=LoadState --value "$name") == loaded ]]
  [[ $(systemctl show --property=FragmentPath --value "$name") == "/etc/systemd/system/$name.service" ]]
done
systemctl is-active --quiet "$UPDATER_SERVICE"
[[ $(systemctl show --property=ProtectSystem --value "$UPDATER_SERVICE") == strict ]]
[[ $(systemctl show --property=NoNewPrivileges --value "$UPDATER_SERVICE") == yes ]]
api_pid=$(systemctl show --property=MainPID --value "$UPDATER_SERVICE")
[[ "$api_pid" =~ ^[1-9][0-9]*$ ]]

# The root service performs its first check even before a browser or socket client connects.
/usr/bin/python3 -I - <<'PY'
import json, time
from pathlib import Path
state_file = Path('/var/lib/project-aggregation-updater/state.json')
for attempt in range(50):
    if state_file.exists():
        state = json.loads(state_file.read_text())
        if state.get('checkedAt') and not state['checking']:
            assert state['modules'] == [] and state['job'] is None, state
            break
    if attempt == 49:
        raise AssertionError('The root scheduler did not check without a connected client')
    time.sleep(0.1)
PY

# Only an AF_UNIX connection is constructed; GET /status cannot initiate version checks or installers.
runuser -u project-aggregation -- /usr/bin/python3 -I - <<'PY'
import http.client, json, socket, time
for attempt in range(50):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(3)
    try:
        connection.connect('/run/project-aggregation-updater/control.sock')
        break
    except (FileNotFoundError, ConnectionRefusedError):
        connection.close()
        if attempt == 49:
            raise
        time.sleep(0.1)
client = http.client.HTTPConnection('localhost')
client.sock = connection
client.request('GET', '/status')
response = client.getresponse()
state = json.loads(response.read())
assert response.status == 200 and state['enabled'] is True and state['job'] is None, state
client.close()
PY
[[ $(stat -c '%U:%G:%a' "$UPDATER_RUN_DIR/control.sock") == root:project-aggregation:660 ]]
runuser -u nobody -- /usr/bin/python3 -I - <<'PY'
import socket
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    try:
        connection.connect('/run/project-aggregation-updater/control.sock')
    except PermissionError:
        pass
    else:
        raise AssertionError('An unrelated account reached the privileged update socket')
PY

systemctl start "$UPDATER_WORKER_SERVICE"
[[ $(systemctl show --property=Result --value "$UPDATER_WORKER_SERVICE") == success ]]
[[ $(systemctl show --property=ExecMainStatus --value "$UPDATER_WORKER_SERVICE") == 0 ]]
systemctl is-active --quiet "$UPDATER_SERVICE"
[[ $(systemctl show --property=MainPID --value "$UPDATER_SERVICE") == "$api_pid" ]]
ensure_update_service "$fixture/release"
[[ $(systemctl show --property=MainPID --value "$UPDATER_SERVICE") == "$api_pid" ]]

# Seed only an isolated display fixture, without a release plan or installer.
# The real control service must read a writer's private job file across separate
# PrivateTmp namespaces. Neither process reads or writes a shared /tmp path.
/usr/bin/python3 -I - <<'PY'
import sys
sys.path.insert(0, '/usr/local/lib/project-aggregation-updater')
from updater import Coordinator, iso, private_directory
coordinator = Coordinator()
with coordinator.lock():
    state = coordinator.load()
    assert state['job'] is None and not state['checking'], state
    job_id = 'a' * 32
    private_directory(coordinator.jobs / job_id)
    state['job'] = {'id': job_id, 'status': 'running', 'startedAt': iso(), 'finishedAt': None,
                    'activeModule': 'hub', 'message': 'Systemd progress fixture',
                    'steps': [{'id': 'hub', 'name': 'Fixture', 'status': 'running'}]}
    coordinator.save(state)
PY
install -m 0644 -o root -g root "$source_root/deploy/release-common.sh" "$UPDATER_DIR/progress-fixture-helper.sh"
cat > "$UPDATER_DIR/progress-fixture-writer.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
source /usr/local/lib/project-aggregation-updater/progress-fixture-helper.sh
export PROJECT_UPDATE_PROGRESS_FILE=/var/lib/project-aggregation-updater/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/progress.json
readlink /proc/self/ns/mnt > /var/lib/project-aggregation-updater/progress-fixture.mountns
ci_update_progress build
[[ -s "$PROJECT_UPDATE_PROGRESS_FILE" ]]
SH
chmod 0700 "$UPDATER_DIR/progress-fixture-writer.sh"
created_progress_unit=1
systemd-run --unit="$progress_unit" --wait --collect --property=Type=oneshot \
  --property=PrivateTmp=true --property=UMask=0077 --property=TimeoutStartSec=20 \
  /bin/bash "$UPDATER_DIR/progress-fixture-writer.sh"
[[ $(cat "$UPDATER_STATE_DIR/progress-fixture.mountns") != "$(readlink /proc/self/ns/mnt)" ]]
[[ $(cat "$UPDATER_STATE_DIR/progress-fixture.mountns") != "$(readlink "/proc/$api_pid/ns/mnt")" ]]
[[ $(systemctl show --property=PrivateTmp --value "$UPDATER_SERVICE") == yes ]]
[[ $(stat -c '%U:%G:%a' "$UPDATER_STATE_DIR/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/progress.json") == root:root:600 ]]
runuser -u project-aggregation -- /usr/bin/python3 -I - <<'PY'
import http.client, json, socket
from pathlib import Path
try:
    Path('/var/lib/project-aggregation-updater/jobs/' + 'a' * 32 + '/progress.json').read_bytes()
except PermissionError:
    pass
else:
    raise AssertionError('The app account directly read the private job file')
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(3)
    connection.connect('/run/project-aggregation-updater/control.sock')
    client = http.client.HTTPConnection('localhost')
    client.sock = connection
    client.request('GET', '/status')
    response = client.getresponse()
    state = json.loads(response.read())
    assert response.status == 200 and state['job']['id'] == 'a' * 32, state
    detail = state['job']['progress']
    assert detail['stage'] == 'build' and detail['timestamp'] > 0, state
    assert 'progress' not in detail, state
    client.close()
PY
# Clear the synthetic running job before the scheduler could try to recover it.
/usr/bin/python3 -I - <<'PY'
import sys
sys.path.insert(0, '/usr/local/lib/project-aggregation-updater')
from updater import Coordinator
coordinator = Coordinator()
with coordinator.lock():
    state = coordinator.load()
    assert state['job']['id'] == 'a' * 32
    state['job'] = None
    coordinator.save(state)
PY
printf 'Real updater systemd startup, socket authorization, isolated progress, worker isolation and no-op update passed.\n'
