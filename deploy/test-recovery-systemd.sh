#!/usr/bin/env bash
# Actual cgroup/OS-lock evidence on a disposable non-WSL GitHub runner.
set -Eeuo pipefail
[[ ${AGG_RECOVERY_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires a disposable Linux root CI runner.' >&2; exit 1;
}
! grep -qi microsoft /proc/sys/kernel/osrelease || { echo 'WSL is not supported.' >&2; exit 1; }
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'Real systemd is required.' >&2; exit 1; }
repository=$(cd -- "$(dirname "$0")/.." && pwd -P)
fixture=$(mktemp -d /tmp/agg-recovery-systemd.XXXXXXXX)
unit=project-aggregation-recovery-fixture.service
unit_file=/run/systemd/system/$unit
[[ ! -e "$unit_file" && ! -L "$unit_file" && $(systemctl show -p LoadState --value "$unit" 2>/dev/null) == not-found ]] || exit 1
cleanup() {
  local result=$?
  trap - EXIT
  systemctl kill --kill-whom=all --signal=KILL "$unit" >/dev/null 2>&1 || true
  systemctl stop "$unit" >/dev/null 2>&1 || true
  if [[ -f "$unit_file" && ! -L "$unit_file" ]] && grep -qx '# Managed recovery CI fixture' "$unit_file"; then rm -f -- "$unit_file"; fi
  systemctl daemon-reload
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  [[ "$fixture" == /tmp/agg-recovery-systemd.* && -d "$fixture" && ! -L "$fixture" ]] && rm -rf -- "$fixture"
  exit "$result"
}
trap cleanup EXIT
chmod 0700 "$fixture"
mkdir -m 0700 "$fixture/data"
cat > "$fixture/owner.py" <<'PY'
import fcntl, os, subprocess, sys, time
from pathlib import Path
root = Path(sys.argv[1])
descriptor = os.open(root / 'data/.runtime.lock', os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(descriptor, fcntl.LOCK_EX)
subprocess.Popen(['/usr/bin/python3', '-I', '-c', 'import time; time.sleep(300)'], pass_fds=(descriptor,))
(root / 'ready').write_text('ready')
time.sleep(300)
PY
cat > "$unit_file" <<EOF
# Managed recovery CI fixture
[Service]
Type=exec
ExecStart=/usr/bin/python3 -I $fixture/owner.py $fixture
KillMode=process
TimeoutStopSec=2
EOF
systemctl daemon-reload
systemctl start "$unit"
for ((attempt=0; attempt<50; attempt++)); do [[ ! -f "$fixture/ready" ]] || break; sleep .1; done
[[ -f "$fixture/ready" ]]
group=$(systemctl show -p ControlGroup --value "$unit")
systemctl stop "$unit"
[[ $(systemctl show -p MainPID --value "$unit") == 0 ]]
# A dead main PID with a surviving child is not a cold checkpoint.
/usr/bin/python3 -I - "$repository" "$unit" "$group" <<'PY'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('recovery_operations', pathlib.Path(sys.argv[1]) / 'server/recovery/operations.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.SERVICE = sys.argv[2]
try: module.require_stopped(sys.argv[3])
except ValueError as error: assert str(error) == 'RECOVERY_WRITERS_STILL_RUNNING'
else: raise AssertionError('An orphan writer was accepted')
PY
systemctl kill --kill-whom=all --signal=KILL "$unit"
for ((attempt=0; attempt<50; attempt++)); do
  [[ ! -e "/sys/fs/cgroup$group/cgroup.events" ]] && break
  grep -qx 'populated 0' "/sys/fs/cgroup$group/cgroup.events" && break
  sleep .1
done
/usr/bin/python3 -I - "$repository" "$unit" "$group" <<'PY'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('recovery_operations', pathlib.Path(sys.argv[1]) / 'server/recovery/operations.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.SERVICE = sys.argv[2]
module.require_stopped(sys.argv[3])
PY
"${RECOVERY_TEST_NODE:?Pass the verified Node executable}" --input-type=module - "$repository" "$fixture/data" <<'JS'
import {pathToFileURL} from 'node:url';
const {acquireRuntimeLock}=await import(pathToFileURL(process.argv[2]+'/server/recovery/lifecycle-lock.mjs'));
const lock=await acquireRuntimeLock({dataDir:process.argv[3]}); lock.assertHeld(); await lock.close();
JS
echo 'Real cgroup orphan rejection, complete stop and native lifecycle lock passed.'
