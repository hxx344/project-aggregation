#!/usr/bin/env bash
# Linux CI helpers: no package installation, systemd changes, or network access.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/install.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
APP_DIR="$test_root/application"
mkdir -p "$APP_DIR/releases"
ENV_FILE="$test_root/environment"
printf 'HOST=127.0.0.1\nPORT=3100\n' > "$ENV_FILE"
[[ "$(read_setting HOST fallback)" == 127.0.0.1 ]]
[[ "$(read_setting DATA_DIR /var/lib/project-aggregation)" == /var/lib/project-aggregation ]]
[[ "$(health_url 0.0.0.0 3100)" == http://127.0.0.1:3100/api/health ]]
[[ "$(health_url :: 3100)" == http://\[::1\]:3100/api/health ]]
[[ "$(health_url ::1 3100)" == http://\[::1\]:3100/api/health ]]
mkdir "$test_root/first" "$test_root/second"
atomic_link "$test_root/first" "$APP_DIR/current"
atomic_link "$test_root/second" "$APP_DIR/current"
[[ "$(readlink "$APP_DIR/current")" == "$test_root/second" ]]
managed="$APP_DIR/releases/aaaaaaaaaaaa-bbbbbbbbbbbbbbbb"
unknown="$APP_DIR/releases/user-created"
mkdir "$managed" "$unknown"
touch "$managed/.managed-release" "$unknown/.managed-release"
safe_remove_release "$managed"
[[ ! -e "$managed" ]]
if safe_remove_release "$unknown"; then echo 'Unexpected acceptance of unknown release name' >&2; exit 1; fi
[[ -d "$unknown" ]]
outside="$test_root/cccccccccccc-dddddddddddddddd"
mkdir "$outside"
touch "$outside/.managed-release"
if safe_remove_release "$outside"; then echo 'Unexpected deletion outside releases' >&2; exit 1; fi
[[ -d "$outside" ]]
ln -s "$outside" "$APP_DIR/releases/eeeeeeeeeeee-ffffffffffffffff"
safe_remove_release "$APP_DIR/releases/eeeeeeeeeeee-ffffffffffffffff"
[[ -d "$outside" ]]

# Failed activation restores the previous app and unit; mocks never call real systemd.
mkdir -p "$APP_DIR/releases/111111111111-2222222222222222" "$APP_DIR/releases/333333333333-4444444444444444"
old_release="$APP_DIR/releases/111111111111-2222222222222222"
release="$APP_DIR/releases/333333333333-4444444444444444"
old_unit_backup="$test_root/previous.service"
UNIT_FILE="$test_root/current.service"
API_UNIT_FILE="$test_root/current-api.service"
printf 'previous service\n' > "$old_unit_backup"
printf 'new service\n' > "$UNIT_FILE"
atomic_link "$release" "$APP_DIR/current"
systemctl() { printf '%s\n' "$*" >> "$test_root/systemctl.calls"; }
wait_healthy() { return 0; }
work_dir="$test_root/work"
mkdir "$work_dir"
remember_environment
prepare_environment_rollback
activation_started=1
set +e
( (exit 9); rollback )
rollback_status=$?
set -e
[[ "$rollback_status" == 9 ]]
[[ "$(readlink "$APP_DIR/current")" == "$old_release" ]]
cmp -s "$old_unit_backup" "$UNIT_FILE"
grep -q '^restart project-aggregation$' "$test_root/systemctl.calls"

# Activation scope (design doc 6.2): only the API restarts when the runtime unit
# would restart into the same code, unit and configuration with no pending migration.
# A real process stands in for the runtime: its working directory is the release it runs.
key() { printf '%064d' "$1"; }
running="$APP_DIR/releases/999999999999-aaaaaaaaaaaaaaaa"
mkdir -p "$running"
for directory in "$old_release" "$release" "$running"; do touch "$directory/.managed-release"; key 41 > "$directory/.runtime-component-key"; done
# Same name as the running release, but outside the releases directory.
elsewhere="$test_root/elsewhere/${running##*/}"
gone="$APP_DIR/releases/888888888888-aaaaaaaaaaaaaaaa"
mkdir -p "$elsewhere" "$gone"; touch "$gone/.managed-release"; key 41 > "$gone/.runtime-component-key"
live_pid= outside_pid= gone_pid=
trap 'kill $live_pid $outside_pid $gone_pid 2>/dev/null || true; rm -rf -- "$test_root"' EXIT
in_directory() { (cd "$1" && exec sleep 600) </dev/null >/dev/null 2>&1 & printf '%s' "$!"; }
live_pid=$(in_directory "$running") outside_pid=$(in_directory "$elsewhere") gone_pid=$(in_directory "$gone")
for pid_directory in "$live_pid:$running" "$outside_pid:$elsewhere" "$gone_pid:$gone"; do
  for attempt in {1..50}; do [[ $(readlink "/proc/${pid_directory%%:*}/cwd") != "${pid_directory#*:}" ]] || break; read -rt 0.1 <> <(:) || true; done
  [[ $(readlink "/proc/${pid_directory%%:*}/cwd") == "${pid_directory#*:}" ]]
done
rm -rf -- "$gone"
printf 'runtime unit\n' > "$UNIT_FILE"; cp "$UNIT_FILE" "$work_dir/service"
printf 'api unit\n' > "$API_UNIT_FILE"
runtime_key=$(key 51) build_environment=fixture
runtime_deployment_key > "$APP_DIR/.runtime-deployment"
cp "$ENV_FILE" "$test_root/environment.saved"
runtime_pid=$live_pid
runtime_stub() {
  case "$1" in
    is-active) [[ ! -f "$test_root/runtime-inactive" ]] ;;
    show) if [[ -f "$test_root/runtime-inactive" ]]; then echo 0; else echo "$runtime_pid"; fi ;;
  esac
}
expect_scope() {
  local actual
  actual=$(
    systemctl() { runtime_stub "$@"; }
    migration_settled() { [[ ! -f "$test_root/migration-pending" ]]; }
    activation_scope
  )
  [[ "$actual" == "$1" ]] || { echo "Expected activation scope $1, got $actual: $2" >&2; exit 1; }
}
[[ "$(systemctl() { runtime_stub "$@"; }; live_runtime_release)" == "$running" ]]
expect_scope api 'same runtime code, unit and configuration'
( old_release=; expect_scope full 'first installation' )
mv "$API_UNIT_FILE" "$test_root/api.hidden"; expect_scope full 'single unit before the split'; mv "$test_root/api.hidden" "$API_UNIT_FILE"
printf 'changed\n' >> "$work_dir/service"; expect_scope full 'runtime unit changed'; cp "$UNIT_FILE" "$work_dir/service"
printf 'changed\n' >> "$UNIT_FILE"; expect_scope full 'installed runtime unit edited'; cp "$work_dir/service" "$UNIT_FILE"
printf 'PORT=3200\n' >> "$ENV_FILE"; expect_scope full 'environment changed'; cp "$test_root/environment.saved" "$ENV_FILE"
( runtime_key=$(key 52); expect_scope full 'Node changed' )
( INSTALL_REVISION=999; expect_scope full 'installer revision changed' )
mv "$APP_DIR/.runtime-deployment" "$test_root/deployment.hidden"; expect_scope full 'no full activation recorded'; mv "$test_root/deployment.hidden" "$APP_DIR/.runtime-deployment"
( runtime_pid=$outside_pid; expect_scope full 'runtime outside the releases' )
( runtime_pid=$gone_pid; expect_scope full 'runtime release removed' )
rm "$running/.managed-release"; expect_scope full 'runtime release not managed'; touch "$running/.managed-release"
key 42 > "$release/.runtime-component-key"; expect_scope full 'runtime component changed'
rm "$release/.runtime-component-key"; expect_scope full 'candidate without a component key'
printf 'not-a-key\n' > "$release/.runtime-component-key"; key 41 | tr 4 x > "$running/.runtime-component-key"; expect_scope full 'invalid keys never match'
key 41 > "$release/.runtime-component-key"; key 41 > "$running/.runtime-component-key"; expect_scope api 'keys restored'
touch "$test_root/runtime-inactive"; expect_scope full 'runtime not running'; rm "$test_root/runtime-inactive"
touch "$test_root/migration-pending"; expect_scope full 'module migration outstanding'; rm "$test_root/migration-pending"
mkdir -p "$release/deploy"
DATA_PATH="$test_root/data"
for answer in 'print("committed")' 'print("pending")' 'raise SystemExit(3)'; do
  printf '%s\n' "$answer" > "$release/deploy/migrate-modules.py"
  if migration_settled "$release"; then [[ "$answer" == 'print("committed")' ]]; else [[ "$answer" != 'print("committed")' ]]; fi
done

# A failed API-only activation points current back and restarts only the API.
old_api_unit_backup="$test_root/previous-api.service"
printf 'previous api\n' > "$old_api_unit_backup"
atomic_link "$release" "$APP_DIR/current"
: > "$test_root/systemctl.calls"
set +e
( activation_scope=api; activation_started=1; (exit 7); rollback )
rollback_status=$?
set -e
[[ "$rollback_status" == 7 && "$(readlink "$APP_DIR/current")" == "$old_release" ]]
cmp -s "$old_api_unit_backup" "$API_UNIT_FILE"
[[ "$(cat "$UNIT_FILE")" == 'runtime unit' && -f "$APP_DIR/.runtime-deployment" ]]
grep -qx 'restart project-aggregation-api' "$test_root/systemctl.calls"
if grep -Eq '^(stop|restart) project-aggregation$' "$test_root/systemctl.calls"; then echo 'API rollback touched the runtime unit' >&2; exit 1; fi
# Rolling a full activation back past the split removes the managed API unit.
old_api_unit_backup=
printf '# Managed by project-aggregation installer\n' > "$API_UNIT_FILE"
atomic_link "$release" "$APP_DIR/current"
: > "$test_root/systemctl.calls"
set +e
( activation_scope=full; activation_started=1; (exit 8); rollback )
rollback_status=$?
set -e
[[ "$rollback_status" == 8 && "$(readlink "$APP_DIR/current")" == "$old_release" && ! -e "$API_UNIT_FILE" ]]
cmp -s "$old_unit_backup" "$UNIT_FILE"
grep -qx 'stop project-aggregation-api' "$test_root/systemctl.calls"
grep -qx 'restart project-aggregation' "$test_root/systemctl.calls"
# An earlier API unit is restored instead.
old_api_unit_backup="$test_root/previous-api.service"
printf 'candidate api\n' > "$API_UNIT_FILE"
set +e
( activation_scope=full; activation_started=1; (exit 8); rollback )
set -e
cmp -s "$old_api_unit_backup" "$API_UNIT_FILE"
old_api_unit_backup=
rm -f "$API_UNIT_FILE"

# Release pruning keeps the release the runtime still runs after API-only updates.
for name in dddddddddddd-eeeeeeeeeeeeeeee ffffffffffff-0000000000000000; do mkdir -p "$APP_DIR/releases/$name"; touch "$APP_DIR/releases/$name/.managed-release"; done
# While the running runtime's release is unknown nothing is removed.
( runtime_pid=$outside_pid; systemctl() { runtime_stub "$@"; }; previous_release=$old_release; prune_releases )
[[ -d "$APP_DIR/releases/dddddddddddd-eeeeeeeeeeeeeeee" && -d "$APP_DIR/releases/ffffffffffff-0000000000000000" ]]
( systemctl() { runtime_stub "$@"; }; previous_release=$old_release; prune_releases )
[[ -d "$release" && -d "$old_release" && -d "$running" ]]
[[ ! -e "$APP_DIR/releases/dddddddddddd-eeeeeeeeeeeeeeee" && ! -e "$APP_DIR/releases/ffffffffffff-0000000000000000" ]]
kill $live_pid $outside_pid $gone_pid 2>/dev/null || true
live_pid= outside_pid= gone_pid=
rm -rf -- "$running" "$APP_DIR/.runtime-deployment" "$release/deploy"

# Cache pruning keeps every entry that the active or rollback releases still use.
# These cases run with the runtime stopped; the cases below cover a running one.
inactive() ( systemctl() { [[ $1 != is-active ]]; }; "$@" )
cache="$APP_DIR/cache"
mkdir -p "$cache/archives" "$APP_DIR/python" "$APP_DIR/python-aster"
PROJECT_DEPLOY_MODE=source
dependency_key=$(key 1) runtime_dependency_key=$(key 2) build_key=$(key 3) embedded_key=$(key 6)
module_build_keys=([monitor]=$(key 7))
for name in "dependencies-$(key 1)" "dependencies-$(key 11)" "runtime-dependencies-$(key 2)" "runtime-dependencies-$(key 12)" \
    "runtime-dependencies-$(key 13)" "runtime-dependencies-$(key 14)" "build-$(key 3)" "build-$(key 13)" "embedded-$(key 6)" \
    "embedded-$(key 16)" "module-monitor-$(key 7)" "module-monitor-$(key 17)" ".build-$(key 3).tmp-abc123" \
    ".prune.embedded-$(key 26)" unrelated; do
  mkdir -p "$cache/$name/node_modules"
done
touch "$cache/typechecked-$(key 4)" "$cache/tested-$(key 15)"
release="$APP_DIR/releases/555555555555-6666666666666666"
previous_release="$APP_DIR/releases/777777777777-8888888888888888"
old_release=$previous_release
mkdir -p "$release/modules/asset" "$previous_release"
printf '%s\n' "$(key 2)" > "$release/.runtime-dependency-key"
ln -s "$cache/runtime-dependencies-$(key 2)/node_modules" "$release/modules/asset/node_modules"
printf '%s\n' "$(key 12)" > "$previous_release/.runtime-dependency-key"
# Older installer revisions linked dependencies without writing a marker.
ln -s "$cache/runtime-dependencies-$(key 13)/node_modules" "$previous_release/node_modules"
atomic_link "$release" "$APP_DIR/current"
atomic_link "$previous_release" "$APP_DIR/previous"
CI_RELEASE_SHA256=$(key 31)
touch "$cache/archives/$(key 31).tar.gz" "$cache/archives/$(key 32).tar.gz" "$cache/archives/.$(key 32).lock"
mkdir "$cache/archives/.$(key 33).parts"
work_dir="$APP_DIR/.install.Keep0000"
mkdir "$work_dir" "$APP_DIR/.install.AbCd1234" "$APP_DIR/.install.Zz999999"
GREEKS_PYTHON_PATH="$APP_DIR/python/$(key 21)/bin/python"
ASTER_PYTHON_PATH=/usr/bin/python3
mkdir -p "$APP_DIR/python/$(key 21)" "$APP_DIR/python/$(key 22)" "$APP_DIR/python/$(key 23)" "$APP_DIR/python/$(key 25)" \
  "$APP_DIR/python-aster/$(key 24)"
printf '%s\n' "$APP_DIR/python/$(key 22)/bin/python" > "$work_dir/previous-greeks-python-path"
# A version switch records the replaced interpreters, including an absent one, for the new rollback release.
previous_target=$(realpath -e "$previous_release")
remember_previous_python_paths "$previous_release"
[[ "$(cat "$APP_DIR/.previous-greeks-python-path")" == "$previous_target"$'\n'"$APP_DIR/python/$(key 22)/bin/python" ]]
[[ "$(cat "$APP_DIR/.previous-aster-python-path")" == "$previous_target" ]]
# The durable record outlives the work directory of the run that wrote it.
printf '%s\n%s\n' "$previous_target" "$APP_DIR/python/$(key 25)/bin/python" > "$APP_DIR/.previous-greeks-python-path"
(
  trap 'echo "Pruning triggered the installer ERR trap" >&2; exit 97' ERR
  inactive prune_caches || exit 3
)
for name in "dependencies-$(key 1)" "runtime-dependencies-$(key 2)" "runtime-dependencies-$(key 12)" "runtime-dependencies-$(key 13)" \
    "build-$(key 3)" "embedded-$(key 6)" "module-monitor-$(key 7)" unrelated "typechecked-$(key 4)" "tested-$(key 15)" \
    "archives/$(key 31).tar.gz"; do
  [[ -e "$cache/$name" ]] || { echo "Pruning removed a referenced entry: $name" >&2; exit 1; }
done
for name in "dependencies-$(key 11)" "runtime-dependencies-$(key 14)" "build-$(key 13)" "embedded-$(key 16)" "module-monitor-$(key 17)" \
    ".build-$(key 3).tmp-abc123" ".prune.embedded-$(key 26)" "archives/$(key 32).tar.gz" "archives/.$(key 32).lock" \
    "archives/.$(key 33).parts"; do
  [[ ! -e "$cache/$name" ]] || { echo "Pruning kept an unused entry: $name" >&2; exit 1; }
done
[[ -d "$APP_DIR/python/$(key 21)" && -d "$APP_DIR/python/$(key 22)" && -d "$APP_DIR/python/$(key 25)" && ! -e "$APP_DIR/python/$(key 23)" ]]
[[ -d "$APP_DIR/python-aster/$(key 24)" ]] # An unmanaged active interpreter leaves its directory untouched.
[[ -d "$work_dir" && ! -e "$APP_DIR/.install.AbCd1234" && ! -e "$APP_DIR/.install.Zz999999" ]]
[[ -z $(find "$APP_DIR" -name '.prune.*' -print -quit) ]]
# A record left for another release, such as after an interrupted switch, says nothing about the
# current rollback release; neither does a missing record, so every environment stays.
rm "$work_dir/previous-greeks-python-path"
mkdir "$APP_DIR/python/$(key 23)"
printf '%s\n%s\n' "$release" "$APP_DIR/python/$(key 25)/bin/python" > "$APP_DIR/.previous-greeks-python-path"
inactive prune_caches
[[ -d "$APP_DIR/python/$(key 22)" && -d "$APP_DIR/python/$(key 23)" && -d "$APP_DIR/python/$(key 25)" ]]
rm "$APP_DIR/.previous-greeks-python-path"
inactive prune_caches
[[ -d "$APP_DIR/python/$(key 22)" && -d "$APP_DIR/python/$(key 23)" && -d "$APP_DIR/python/$(key 25)" ]]

# A running runtime's release is a root; while that release is unknown, every managed release is
# one, as in prune_releases; a stopped runtime adds none.
other="$APP_DIR/releases/999999999999-bbbbbbbbbbbbbbbb"
mkdir -p "$other" "$cache/runtime-dependencies-$(key 18)/node_modules"
touch "$other/.managed-release"; printf '%s\n' "$(key 18)" > "$other/.runtime-dependency-key"
( systemctl() { [[ $1 != show ]] || echo 0; }; prune_caches )
[[ -d "$cache/runtime-dependencies-$(key 18)" ]]
( live_runtime_release() { printf '%s' "$other"; }; prune_caches )
[[ -d "$cache/runtime-dependencies-$(key 18)" ]]
( live_runtime_release() { printf '%s' "$release"; }; prune_caches )
[[ ! -e "$cache/runtime-dependencies-$(key 18)" ]]
mkdir -p "$cache/runtime-dependencies-$(key 18)/node_modules"
( systemctl() { [[ $1 != show ]] || echo 0; [[ $1 != is-active ]]; }; prune_caches )
[[ ! -e "$cache/runtime-dependencies-$(key 18)" ]]
rm -rf -- "$other"

# A failed removal is reported without the ERR trap and keeps the entry under its original key.
mkdir "$cache/embedded-$(key 36)"
set +e
(
  trap 'exit 97' ERR
  mv() { return 1; }
  prune_caches || exit 3
)
prune_status=$?
set -e
[[ "$prune_status" == 3 && -d "$cache/embedded-$(key 36)" ]]
# CI deployments never compute source keys, so source caches stay for a later source deployment.
PROJECT_DEPLOY_MODE=ci
prune_caches
[[ -d "$cache/embedded-$(key 36)" ]]

# The units the installer writes are the units the update registry and the
# recovery entry accept, with the recovery guard on each (design doc 6.3, 6.4).
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
for output in 'systemd 255 (255.4-1ubuntu8.17)' 'systemd 257.1 (257.1-1)' 'systemd 252 (252.33-1~deb12u1)' 'unexpected'; do
  expected=$(awk 'NR == 1 { print $2 + 0 }' <<< "$output"); expected=${expected%%.*}
  [[ $(systemctl() { printf '%s\n+PAM\n' "$output"; }; systemd_major) == "$expected" ]]
done
[[ $(systemctl() { return 1; }; systemd_major) == 0 ]]
(
  APP_DIR=/opt/project-aggregation SERVICE=project-aggregation API_SERVICE=project-aggregation-api SERVICE_USER=project-aggregation
  DATA_PATH=/var/lib/project-aggregation ENV_FILE=/etc/project-aggregation.env NODE_BIN=/usr/local/bin/node
  GREEKS_PYTHON_PATH=/usr/bin/python3 ASTER_PYTHON_PATH=/usr/bin/python3
  work_dir="$test_root/units" units="$test_root/filesystem/etc/systemd/system"
  mkdir -p "$work_dir" "$units"
  for systemd_version in 252 255; do
    write_unit
    # systemd before 254 ignores RestartSteps, so the API restarts at a fixed interval.
    if (( systemd_version < 254 )); then
      grep -qx 'RestartSec=5' "$work_dir/api.service"
      if grep -q '^RestartSteps=' "$work_dir/api.service"; then echo 'Backoff written for systemd < 254' >&2; exit 1; fi
    else
      grep -qx 'RestartSteps=5' "$work_dir/api.service" && grep -qx 'RestartSec=1' "$work_dir/api.service"
    fi
    cp "$work_dir/service" "$units/$SERVICE.service"
    cp "$work_dir/api.service" "$units/$API_SERVICE.service"
    python3 -I - "$repository" "$test_root/filesystem" <<'PY'
import importlib.util, sys
from pathlib import Path
from unittest.mock import patch
repository, filesystem = Path(sys.argv[1]), Path(sys.argv[2])
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, repository / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
registry = load('registry', 'server/update-service/registry.py')
operations = load('operations', 'server/recovery/operations.py')
units = filesystem / 'etc/systemd/system'
module = registry.BY_ID['hub']
# The drop-in exactly as the recovery entry writes it.
guard = operations.guard_dropin(Path('/usr/local/lib/project-aggregation-recovery/startup-guard.py'), '/usr/local/bin/node')
for name in (module.service, *module.extra_services):
    (units / (name + '.service.d')).mkdir(exist_ok=True)
    (units / (name + '.service.d/20-recovery-guard.conf')).write_bytes(guard)
def accepted():
    with patch.object(registry, 'text_file', lambda path, maximum=65536: path.read_text(encoding='utf-8').strip()):
        try:
            for name, entry in zip((module.service, *module.extra_services), module.entries, strict=True):
                registry.unit_source(module, name, '/opt/project-aggregation/current', filesystem, guard=True, entry=entry)
        except ValueError:
            registry_result = False
        else:
            registry_result = True
    with patch.object(operations, 'trusted', side_effect=lambda path, private=False: Path(path)):
        try:
            runtime = operations.managed_unit(units / 'project-aggregation.service', 'runtime/main.mjs')
            recovery_result = operations.managed_unit(units / 'project-aggregation-api.service', 'api/main.mjs') == runtime
        except ValueError:
            recovery_result = False
    return registry_result, recovery_result
assert accepted() == (True, True), accepted()
# Commands the recovery entry rejects are rejected by the registry too.
unit = units / 'project-aggregation-api.service'
source = unit.read_text(encoding='utf-8')
command = '/opt/project-aggregation/current/server/api/main.mjs'
for forged in ('/bin/sh -c x ' + command, '/usr/local/bin/node --require /tmp/x.js ' + command, '/usr/local/bin/node ' + command + ' extra'):
    unit.write_text(source.replace('/usr/local/bin/node ' + command, forged), encoding='utf-8')
    assert accepted() == (False, False), (forged, accepted())
unit.write_text(source, encoding='utf-8')
PY
  done
)
printf 'Installer helper and cache pruning checks passed.\n'
