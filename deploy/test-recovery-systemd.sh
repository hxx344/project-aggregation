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
dropin_dir=$unit_file.d
# A prefix drop-in directory: systemd applies it to every unit whose name starts with
# project-aggregation-recovery-, here only the fixture.
shared_dir=/run/systemd/system/project-aggregation-recovery-.service.d
[[ ! -e "$unit_file" && ! -L "$unit_file" && ! -e "$dropin_dir" && ! -L "$dropin_dir" && ! -e "$shared_dir" && ! -L "$shared_dir" && $(systemctl show -p LoadState --value "$unit" 2>/dev/null) == not-found ]] || exit 1
cleanup() {
  local result=$?
  trap - EXIT
  systemctl kill --kill-whom=all --signal=KILL "$unit" >/dev/null 2>&1 || true
  systemctl stop "$unit" >/dev/null 2>&1 || true
  if [[ -f "$unit_file" && ! -L "$unit_file" ]] && grep -qx '# Managed recovery CI fixture' "$unit_file"; then rm -f -- "$unit_file"; fi
  if [[ -d "$dropin_dir" && ! -L "$dropin_dir" ]]; then rm -f -- "$dropin_dir/10-recovery-fixture.conf" "$dropin_dir/20-recovery-guard.conf"; rmdir -- "$dropin_dir" || true; fi
  if [[ -d "$shared_dir" && ! -L "$shared_dir" ]]; then rm -f -- "$shared_dir/zz-recovery-fixture.conf"; rmdir -- "$shared_dir" || true; fi
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
# install_guard relies on DropInPaths, as loaded_dropins reads it, listing a
# drop-in once a reload loaded it, also from a directory created after the last reload.
loaded_dropins() {
  /usr/bin/python3 -I - "$repository" "$unit" <<'PY'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('recovery_operations', pathlib.Path(sys.argv[1]) / 'server/recovery/operations.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(module.loaded_dropins(sys.argv[2]))
PY
}
expect_loaded_dropins() {
  local actual
  actual=$(loaded_dropins)
  [[ "$actual" == "$1" ]] || { echo "loaded_dropins: $actual, expected $1" >&2; return 1; }
}
expect_loaded_dropins "[]"
mkdir -m 0755 "$dropin_dir"
printf '[Service]\nEnvironment=RECOVERY_FIXTURE=1\n' > "$dropin_dir/10-recovery-fixture.conf"
systemctl daemon-reload
expect_loaded_dropins "['$dropin_dir/10-recovery-fixture.conf']"
group=$(systemctl show -p ControlGroup --value "$unit")
systemctl stop "$unit"
[[ $(systemctl show -p MainPID --value "$unit") == 0 ]]
# A dead main PID with a surviving child is not a cold checkpoint.
/usr/bin/python3 -I - "$repository" "$unit" "$group" <<'PY'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('recovery_operations', pathlib.Path(sys.argv[1]) / 'server/recovery/operations.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.SERVICES = (sys.argv[2],)
try: module.require_stopped({sys.argv[2]: sys.argv[3]})
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
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.SERVICES = (sys.argv[2],)
module.require_stopped({sys.argv[2]: sys.argv[3]})
PY
# install_guard end to end on the stopped unit: an override in a shared directory created
# since the last reload is rejected, before writing when systemd already shows it (a
# stopped unit may be unloaded and read afresh), otherwise after install_guard's reload;
# once the operator removes it and reloads, the guard is accepted and is the only loaded drop-in.
rm -f -- "$dropin_dir/10-recovery-fixture.conf"
systemctl daemon-reload
mkdir -p "$fixture/release/server/recovery"
install -m 0644 "$repository/server/recovery/startup-guard.py" "$fixture/release/server/recovery/startup-guard.py"
mkdir -m 0755 "$shared_dir"
printf '[Service]\nEnvironment=RECOVERY_SHARED=1\n' > "$shared_dir/zz-recovery-fixture.conf"
install_guard() {
  /usr/bin/python3 -I - "$repository" "$unit" "$fixture" "$1" <<'PY'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('recovery_operations', pathlib.Path(sys.argv[1]) / 'server/recovery/operations.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
unit, fixture, expected = sys.argv[2], pathlib.Path(sys.argv[3]), sys.argv[4]
module.SERVICES = (unit,)
guard = f'/run/systemd/system/{unit}.d/20-recovery-guard.conf'
try:
    module.install_guard({'release': fixture / 'release', 'node': pathlib.Path('/usr/bin/node')},
                         library=fixture / 'lib', units=pathlib.Path('/run/systemd/system'), launcher=fixture / 'launcher')
except ValueError as error:
    assert expected == 'rejected' and str(error) == 'RECOVERY_UNSUPPORTED_SERVICE_OVERRIDE', error
    assert '/run/systemd/system/project-aggregation-recovery-.service.d/zz-recovery-fixture.conf' in module.loaded_dropins(unit), module.loaded_dropins(unit)
else:
    assert expected == 'accepted', 'A shared override was accepted'
    assert module.loaded_dropins(unit) == [guard], module.loaded_dropins(unit)
PY
}
install_guard rejected
rm -f -- "$shared_dir/zz-recovery-fixture.conf"
rmdir -- "$shared_dir"
systemctl daemon-reload
install_guard accepted
"${RECOVERY_TEST_NODE:?Pass the verified Node executable}" --input-type=module - "$repository" "$fixture/data" <<'JS'
import {pathToFileURL} from 'node:url';
const {acquireRecoveryLocks,assertLifecycleLock}=await import(pathToFileURL(process.argv[2]+'/server/recovery/lifecycle-lock.mjs'));
const lock=await acquireRecoveryLocks({dataDir:process.argv[3]}); assertLifecycleLock(lock,{dataDir:process.argv[3]}); await lock.close();
JS
echo 'Real drop-in state, guard install against a shared override, cgroup orphan rejection, complete stop and native lifecycle lock passed.'
