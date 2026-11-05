#!/usr/bin/env bash
# The installer's main() through the dual-slot layout, with local packages and
# a stateful fake systemd, entry and API slots: the layout gate, first enable,
# API-only switches, full updates, the scope refusal, a failed candidate, a
# failure after the slot record moved, interrupted switches and a failed full
# update. test-slots-systemd.sh runs these units under real systemd, but calls
# the activation helpers directly, never main().
set -Eeuo pipefail
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
trap 'echo "Failed at line $LINENO." >&2; tail -n 40 "$fixture/last.log" >&2 2>/dev/null || true; tail -n 60 "$fixture/new.calls" >&2 2>/dev/null || true' ERR
export FIXTURE_ROOT=$fixture
mkdir -p "$fixture/source/src" "$fixture/source/server" "$fixture/source/deploy" "$fixture/runtime" "$fixture/updater"
mkdir -p "$fixture/source/tools/entropy-lighter-lab" "$fixture/source/tools/aero-lp" "$fixture/source/tools/aero-roles"
cp "$repository"/tools/entropy-lighter-lab/{cli.mjs,core.mjs,feeds.mjs,binance-scalper.mjs,config.example.json} "$fixture/source/tools/entropy-lighter-lab/"
cp "$repository"/tools/aero-lp/{cli.mjs,core.mjs,chain.mjs,config.example.json} "$fixture/source/tools/aero-lp/"
cp "$repository"/tools/aero-roles/{addresses.mjs,conditions.mjs,executor.mjs,permissions.mjs,policy.mjs,roles-calls.mjs} "$fixture/source/tools/aero-roles/"
printf '{"name":"fixture","version":"1.0.0","type":"module"}\n' > "$fixture/source/package.json"
printf 'frontend\n' > "$fixture/source/src/app.ts"
printf 'backend\n' > "$fixture/source/server/index.mjs"
git -C "$fixture/source" init -q -b main
git -C "$fixture/source" config user.name fixture
git -C "$fixture/source" config user.email fixture@example.invalid
commit_source() { git -C "$fixture/source" add .; git -C "$fixture/source" commit -qm "$1"; }
commit_source initial
service=$(sed -n 's/^SERVICE=//p' "$repository/deploy/install.sh")
sed -e "s|/opt/$service|$fixture/application|g" \
    -e "s|/var/lib/$service|$fixture/data|g" \
    -e "s|/etc/$service.env|$fixture/environment|g" \
    -e "s|/etc/systemd/system/$service.service|$fixture/unit|g" \
    -e "s|/etc/systemd/system/$service-api.service|$fixture/api-unit|g" \
    -e "s|/etc/systemd/system/$service-entry.service|$fixture/entry-unit|g" \
    -e "s|/etc/systemd/system/$service-api@.service|$fixture/slot-unit|g" \
    -e "s|/usr/local/lib/$service-updater|$fixture/updater|g" \
    -e "s|/run/lock|$fixture/locks|g" \
    -e "s|/run/systemd/system|$fixture|g" "$repository/deploy/install.sh" > "$fixture/installer.sh"
cat > "$fixture/runtime/node" <<'NODE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == --version ]]; then printf 'v24.15.0\n'; exit; fi
if [[ $1 == --input-type=module ]]; then shift; fi
[[ $1 == -e ]] || { printf 'Unexpected node call: %s\n' "$*" >&2; exit 1; }
NODE
chmod +x "$fixture/runtime/node"

# main() with the host replaced: units are files under $SD, each slot keeps the
# release its link named when it started, the entry forwards to one slot and
# every state-changing call is appended to $FIXTURE_ROOT/calls, so the tests
# check the order main() chose. A file crash-on holds a call pattern at which
# the installer is killed without its traps, like a power loss.
cat > "$fixture/run.sh" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$FIXTURE_ROOT/installer.sh"
REPOSITORY="$FIXTURE_ROOT/source"
SERVICE_USER=root
SD="$FIXTURE_ROOT/systemd"
if [[ "${FRESH_INSTALL:-0}" == 1 ]]; then
  APP_DIR="$FIXTURE_ROOT/fresh-application"
  ENV_FILE="$FIXTURE_ROOT/fresh-environment"
  UNIT_FILE="$FIXTURE_ROOT/fresh-unit"
  API_UNIT_FILE="$FIXTURE_ROOT/fresh-api-unit"
  ENTRY_UNIT_FILE="$FIXTURE_ROOT/fresh-entry-unit"
  SLOT_UNIT_FILE="$FIXTURE_ROOT/fresh-slot-unit"
  SD="$FIXTURE_ROOT/fresh-systemd"
fi
mkdir -p "$SD/active" "$SD/enabled"
note() { printf '%s\n' "$*" >> "$FIXTURE_ROOT/calls"; }
crash_point() {
  local pattern
  [[ -f "$FIXTURE_ROOT/crash-on" ]] || return 0
  pattern=$(cat "$FIXTURE_ROOT/crash-on")
  # shellcheck disable=SC2053 # The file holds a glob pattern.
  [[ "$1" == $pattern ]] || return 0
  rm -f -- "$FIXTURE_ROOT/crash-on"
  note "crash $1"
  kill -KILL $$
  # Control requests run in command substitutions: $$ is the installer, while
  # its surviving subshell must not carry on with the simulated promotion.
  exit 137
}
ensure_tools() { :; }
validate_embedded_runtime() { :; }
prepare_greeks_runtime() { :; }
prepare_aster_runtime() { :; }
migrate_embedded_modules() { note "migrate $1"; }
migration_settled() { [[ ! -f "$FIXTURE_ROOT/migration-pending" ]]; }
ensure_node() { NODE_BIN="$FIXTURE_ROOT/runtime/node"; }
sleep() { :; }

unit_file() {
  case "$1" in
    "$SERVICE") printf '%s' "$UNIT_FILE" ;;
    "$API_SERVICE") printf '%s' "$API_UNIT_FILE" ;;
    "$ENTRY_SERVICE") printf '%s' "$ENTRY_UNIT_FILE" ;;
    "$API_SERVICE"@[ab]) printf '%s' "$SLOT_UNIT_FILE" ;;
    *) printf '%s/no-unit/%s' "$SD" "$1" ;;
  esac
}
unit_active() { [[ -f "$SD/active/$1" ]]; }
unit_field() {
  local key value
  [[ -f "$SD/active/$1" ]] || return 1
  while IFS='=' read -r key value; do
    if [[ "$key" == "$2" ]]; then printf '%s\n' "$value"; fi
  done < "$SD/active/$1"
}
next_pid() {
  local pid
  pid=$(( $(cat "$SD/pid" 2>/dev/null || printf 1000) + 1 ))
  printf '%s\n' "$pid" > "$SD/pid"
  printf '%s' "$pid"
}
unit_start() {
  local unit=$1 pid release slot mode=candidate recorded file
  if unit_active "$unit"; then return 0; fi
  [[ -f "$(unit_file "$unit")" ]] || { printf 'Unit %s not found.\n' "$unit" >&2; return 5; }
  pid=$(next_pid)
  case "$unit" in
    "$SERVICE")
      release=$(realpath -e -- "$APP_DIR/current") || return 1
      if [[ -f "$FIXTURE_ROOT/unready-release" && "$(cat "$FIXTURE_ROOT/unready-release")" == "$release" ]]; then
        for file in unit entry-unit slot-unit environment; do
          cp -- "$FIXTURE_ROOT/$file" "$FIXTURE_ROOT/$file.candidate"
        done
      fi
      printf 'pid=%s\nrelease=%s\n' "$pid" "$release" > "$SD/active/$unit"
      if grep -Eq "^Wants=(.*[[:space:]])?$ENTRY_SERVICE\.service([[:space:]]|\$)" "$UNIT_FILE"; then unit_start "$ENTRY_SERVICE"; fi
      if grep -Eq "^Wants=(.*[[:space:]])?$API_SERVICE\.service([[:space:]]|\$)" "$UNIT_FILE"; then unit_start "$API_SERVICE"; fi
      ;;
    "$ENTRY_SERVICE")
      recorded=$(read_slot_record) || return 1
      printf 'pid=%s\ntarget=%s\n' "$pid" "${recorded%% *}" > "$SD/active/$unit"
      for slot in a b; do
        if [[ -f "$SD/enabled/$API_SERVICE@$slot" ]]; then unit_start "$API_SERVICE@$slot"; fi
      done
      ;;
    "$API_SERVICE"@[ab])
      slot=${unit##*@}
      release=$(realpath -e -- "$APP_DIR/slots/$slot") || return 1
      # A slot the record already names starts serving, as after a reboot.
      if recorded=$(read_slot_record) && [[ "$recorded" == "$slot $release" ]]; then mode=serving; fi
      printf 'pid=%s\nrelease=%s\nmode=%s\n' "$pid" "$release" "$mode" > "$SD/active/$unit"
      ;;
    *)
      release=$(realpath -e -- "$APP_DIR/current") || return 1
      printf 'pid=%s\nrelease=%s\n' "$pid" "$release" > "$SD/active/$unit"
      ;;
  esac
}
unit_stop() {
  local member
  # PartOf= the runtime unit.
  if [[ "$1" == "$SERVICE" ]]; then
    for member in "$API_SERVICE" "$ENTRY_SERVICE" "$API_SERVICE@a" "$API_SERVICE@b"; do rm -f -- "$SD/active/$member"; done
  fi
  rm -f -- "$SD/active/$1"
}
systemctl() {
  local verb=$1 property='' unit
  local -a units=()
  shift
  while (($#)); do
    case "$1" in
      -p|--property) property=$2; shift ;;
      --property=*) property=${1#*=} ;;
      -*) ;;
      *) units+=("${1%.service}") ;;
    esac
    shift
  done
  case "$verb" in
    is-active)
      for unit in "${units[@]}"; do
        if [[ "$unit" == "$UPDATER_WORKER_SERVICE" ]]; then [[ -f "$FIXTURE_ROOT/worker-active" ]] || return 3
        else unit_active "$unit" || return 3; fi
      done ;;
    is-enabled) [[ -f "$SD/enabled/${units[0]}" ]] || return 1 ;;
    show)
      unit=${units[0]}
      case "$property" in
        LoadState) if [[ -f "$(unit_file "$unit")" ]]; then printf 'loaded\n'; else printf 'not-found\n'; fi ;;
        ActiveState) if unit_active "$unit"; then printf 'active\n'; else printf 'inactive\n'; fi ;;
        MainPID) if unit_active "$unit"; then unit_field "$unit" pid; else printf '0\n'; fi ;;
        *) printf '\n' ;;
      esac ;;
    daemon-reload|enable|disable|start|stop|restart)
      note "systemctl $verb${units[*]:+ ${units[*]}}"
      crash_point "systemctl $verb${units[*]:+ ${units[*]}}"
      for unit in "${units[@]}"; do
        case "$verb" in
          enable) touch "$SD/enabled/$unit" ;;
          disable) rm -f -- "$SD/enabled/$unit" ;;
          start) unit_start "$unit" || return $? ;;
          stop) unit_stop "$unit" ;;
          restart) unit_stop "$unit"; unit_start "$unit" || return $? ;;
        esac
      done ;;
    *) return 0 ;;
  esac
}
# The release's directed probe: the slot runs the release in the mode named,
# as the unit's main process. A release named in broken-release never passes.
# A bare return inside the installer's ERR trap would return the trap's status.
run_as_service() {
  if [[ "${2:-}" == */server/entry/probe.mjs ]]; then shift 2; slot_probe_fixture "$@"; else "$@"; fi
}
slot_probe_fixture() {
  local slot='' release='' pid='' mode='' unit
  while (($#)); do
    case "$1" in --slot) slot=$2 ;; --release) release=$2 ;; --pid) pid=$2 ;; --mode) mode=$2 ;; esac
    shift 2
  done
  unit="$API_SERVICE@$slot"
  note "probe $slot $mode $release"
  if [[ -f "$FIXTURE_ROOT/broken-release" && "$(< "$FIXTURE_ROOT/broken-release")" == "$release" ]] ||
     ! unit_active "$unit" || [[ "$(unit_field "$unit" release)" != "$release" || "$(unit_field "$unit" mode)" != "$mode" ||
        "$(unit_field "$unit" pid)" != "$pid" ]]; then
    printf 'probe of slot %s failed\n' "$slot"
    return 1
  fi
  printf '{"instanceId":"%s"}\n' "$pid"
}
slot_control() {
  local slot=$1 method=$2 route=$3 unit="$API_SERVICE@$1"
  note "ctl $slot $method $route"
  unit_active "$unit" || return 7
  case "$method $route" in
    'GET /identity') ;;
    'POST /promote')
      crash_point "ctl $slot POST /promote"
      sed -i 's/^mode=.*/mode=serving/' "$SD/active/$unit" ;;
    *) return 22 ;;
  esac
  printf '{"mode":"%s","release":"%s","instanceId":"%s","pid":%s}\n' \
    "$(unit_field "$unit" mode)" "$(unit_field "$unit" release)" "$(unit_field "$unit" pid)" "$(unit_field "$unit" pid)"
}
entry_control() {
  local method=$1 route=$2 data=$3 slot instance unit
  note "ctl entry $method $route $data"
  unit_active "$ENTRY_SERVICE" || return 7
  case "$method $route" in
    'GET /status') printf '{"target":"%s","connections":{"a":0,"b":0}}\n' "$(unit_field "$ENTRY_SERVICE" target)" ;;
    'POST /switch')
      if [[ -f "$FIXTURE_ROOT/fail-switch" ]]; then rm -f -- "$FIXTURE_ROOT/fail-switch"; note 'switch refused'; return 22; fi
      slot=$(sed -n 's/.*"slot":"\([ab]\)".*/\1/p' <<< "$data")
      instance=$(sed -n 's/.*"instanceId":"\([^"]*\)".*/\1/p' <<< "$data")
      unit="$API_SERVICE@$slot"
      # The entry only switches to the serving instance the probe identified.
      unit_active "$unit" && [[ "$(unit_field "$unit" mode)" == serving && "$(unit_field "$unit" pid)" == "$instance" ]] || return 22
      sed -i "s/^target=.*/target=$slot/" "$SD/active/$ENTRY_SERVICE"
      printf '{"target":"%s"}\n' "$slot" ;;
    *) return 22 ;;
  esac
}
# /api/ready through the entry and its slot, or the single API unit. A release
# named in unready-release never gets ready as the runtime.
public_ready() {
  local target
  [[ "$1" == "http://127.0.0.1:$(read_setting PORT 0)/api/ready" ]] && unit_active "$SERVICE" || return 7
  if unit_active "$ENTRY_SERVICE"; then
    target=$(unit_field "$ENTRY_SERVICE" target)
    unit_active "$API_SERVICE@$target" && [[ "$(unit_field "$API_SERVICE@$target" mode)" == serving ]] || return 22
  else
    unit_active "$API_SERVICE" || return 7
  fi
  [[ ! -f "$FIXTURE_ROOT/unready-release" || "$(unit_field "$SERVICE" release)" != "$(cat "$FIXTURE_ROOT/unready-release")" ]] || return 22
}
curl() {
  local url='' output='' socket='' method=GET data='' argument
  while (($#)); do
    argument=$1; shift
    case "$argument" in
      -o) output=$1; shift ;;
      --unix-socket) socket=$1; shift ;;
      -X) method=$1; shift ;;
      --data) data=$1; shift ;;
      -H|--proto|--retry|--connect-timeout|--max-time|--max-filesize) shift ;;
      https://*|http://*) url=$argument ;;
    esac
  done
  if [[ -n "$output" ]]; then
    case "$url" in
      */latest/download/release-manifest.json) cp "$FIXTURE_ROOT/release-manifest.json" "$output" ;;
      */releases/download/deploy-*/fixture.tar.gz) cp "$FIXTURE_ROOT/package.tar.gz" "$output" ;;
      *) return 23 ;;
    esac
  elif [[ "$socket" == "/run/$ENTRY_SERVICE/ctl.sock" ]]; then
    entry_control "$method" "${url#http://localhost}" "$data"
  elif [[ "$socket" =~ ^/run/$API_SERVICE-([ab])/ctl\.sock$ ]]; then
    slot_control "${BASH_REMATCH[1]}" "$method" "${url#http://localhost}"
  elif [[ -z "$socket" ]]; then
    public_ready "$url"
  else
    return 7
  fi
}
ci_release_download() {
  mkdir -p -- "$1"
  if [[ -f "$1/$3.tar.gz" && $(sha256sum "$1/$3.tar.gz" | cut -d ' ' -f1) == "$3" ]]; then return 0; fi
  curl "$2" -o "$1/$3.tar.gz"
}
live_runtime_release() { unit_active "$SERVICE" && managed_release "$(unit_field "$SERVICE" release)"; }
git() { echo 'Unexpected server-side git invocation' >&2; return 91; }

# Each traced step and the layout and scope main() chose join the call log.
trace() {
  local name
  for name; do
    eval "__traced_$name() $(declare -f "$name" | tail -n +2)"
    eval "$name() { note \"$name\${*:+ \$*}\"; __traced_$name \"\$@\"; }"
  done
}
trace activate_dual_full api_cutover api_cutover_rollback resolve_cutover restore_dual_units dual_teardown finish_activation
eval "__traced_write_unit() $(declare -f write_unit | tail -n +2)"
write_unit() {
  local file
  __traced_write_unit
  if [[ -f "$FIXTURE_ROOT/candidate-units" ]]; then
    for file in service entry.service slot.service; do
      printf '\n# Candidate unit revision\n' >> "$work_dir/$file"
    done
  fi
}
eval "__traced_target_layout() $(declare -f target_layout | tail -n +2)"
target_layout() { local layout; layout=$(__traced_target_layout); note "layout $layout"; printf '%s' "$layout"; }
eval "__traced_activation_scope() $(declare -f activation_scope | tail -n +2)"
activation_scope() { local scope; scope=$(__traced_activation_scope); note "scope $scope"; printf '%s' "$scope"; }
eval "__traced_atomic_link() $(declare -f atomic_link | tail -n +2)"
atomic_link() {
  if [[ "$2" == "$APP_DIR/current" ]]; then crash_point "link current $1"; fi
  if [[ "$2" == "$APP_DIR/previous" ]]; then crash_point "link previous $1"; fi
  __traced_atomic_link "$@" || return $?
  if [[ "$2" == "$APP_DIR/previous" ]]; then crash_point "linked previous $1"; fi
}
eval "__traced_atomic_record() $(declare -f atomic_record | tail -n +2)"
atomic_record() {
  if [[ "$1" == "$APP_DIR/.greeks-python-path" && -f "$FIXTURE_ROOT/fail-finalize" ]]; then
    rm -f -- "$FIXTURE_ROOT/fail-finalize"
    note 'finalize refused'
    return 1
  fi
  __traced_atomic_record "$@"
}
rm() {
  local argument journal=0
  for argument; do
    if [[ "$argument" == "$APP_DIR/.api-cutover" && -f "$argument" ]]; then journal=1; fi
  done
  command rm "$@" || return $?
  if (( journal )); then crash_point 'removed cutover'; fi
  return 0
}
main
RUN

make_package() {
  python3 - "$fixture" "$service" "$1" "${2:-$1}" <<'PACKAGE'
import hashlib, io, json, subprocess, sys, tarfile
from pathlib import Path
root = Path(sys.argv[1])
commit = subprocess.check_output(['git', '-C', str(root / 'source'), 'rev-parse', 'HEAD'], text=True).strip()
key = hashlib.sha256(sys.argv[3].encode()).hexdigest()
contents = {'.release-commit': commit, '.release-application-key': key,
            '.release-runtime-key': hashlib.sha256(('runtime:' + sys.argv[4]).encode()).hexdigest(),
            'server/app.mjs': 'export {};', 'server/index.mjs': 'export {};', 'server/launcher.mjs': 'export {};',
            'server/runtime/main.mjs': 'export {};', 'server/api/main.mjs': 'export {};',
            'server/entry/main.mjs': 'export {};', 'server/entry/probe.mjs': 'export {};',
            'package.json': '{"type":"module"}', 'dist/index.html': '<html>' + sys.argv[3] + '</html>',
            'node_modules/ws/package.json': '{}', 'node_modules/decimal.js/package.json': '{}'}
for relative in [*('tools/entropy-lighter-lab/' + name for name in ('cli.mjs', 'core.mjs', 'feeds.mjs', 'binance-scalper.mjs', 'config.example.json')),
                 *('tools/aero-lp/' + name for name in ('cli.mjs', 'core.mjs', 'chain.mjs', 'config.example.json')),
                 *('tools/aero-roles/' + name for name in ('addresses.mjs', 'conditions.mjs', 'executor.mjs', 'permissions.mjs', 'policy.mjs', 'roles-calls.mjs'))]:
    contents[relative] = subprocess.check_output(['git', '-C', str(root / 'source'), 'show', commit + ':' + relative], text=True)
with tarfile.open(root / 'package.tar.gz', 'w:gz') as archive:
    for name, value in contents.items():
        member = tarfile.TarInfo(name)
        content = value.encode()
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))
item = {'file': 'fixture.tar.gz', 'sha256': hashlib.sha256((root / 'package.tar.gz').read_bytes()).hexdigest(), 'application_key': key}
(root / 'release-manifest.json').write_text(json.dumps({'schema': 1, 'repository': 'hxx344/' + sys.argv[2],
    'commit': commit, 'tag': 'deploy-' + commit, 'node_version': '24.15.0', 'artifacts': {'linux-x64': item, 'linux-arm64': item}}))
PACKAGE
}
# The release directory main() derives from the commit and the application key.
release_path() {
  printf '%s/%s-%s' "${2:-$fixture/application}/releases" "$(git -C "$fixture/source" rev-parse HEAD | cut -c 1-12)" \
    "$(printf '%s' "$1" | sha256sum | cut -c 1-16)"
}
new_package() { # name runtime: a new commit and its package
  printf '%s\n' "$1" >> "$fixture/source/src/app.ts"
  commit_source "$1"
  make_package "$1" "$2"
}

app=$fixture/application
sd=$fixture/systemd
touch "$fixture/calls"
code=0
# Runs main() with the given environment and keeps this run's calls in new.calls.
run_install() {
  local mark
  mark=$(wc -l < "$fixture/calls")
  code=0
  env "$@" bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
  tail -n "+$((mark + 1))" "$fixture/calls" > "$fixture/new.calls"
}
expect_code() { [[ $code == "$1" ]] || { printf 'Expected exit %s, got %s.\n' "$1" "$code" >&2; return 1; }; }
expect_api_rollback_log() {
  if ! grep -Fq '已恢复之前的 API 槽；' "$fixture/last.log" ||
     grep -Fq '之前的 API 槽未能恢复服务' "$fixture/last.log"; then
    printf 'A healthy API rollback was reported as failed.\n' >&2
    return 1
  fi
}
expect_cutover() {
  python3 - "$app/.api-cutover" "$@" <<'CUTOVER'
import json, sys
from pathlib import Path
expected = dict(zip(('from', 'to', 'release', 'phase', 'intent', 'previous'), sys.argv[2:]))
actual = json.loads(Path(sys.argv[1]).read_text())
assert actual == expected, (actual, expected)
CUTOVER
}
has_call() { grep -Eq -- "$1" "$fixture/new.calls" || { printf 'Missing call: %s\n' "$1" >&2; return 1; }; }
call_count() {
  local count
  count=$(grep -Ec -- "$2" "$fixture/new.calls") || true
  [[ "$count" == "$1" ]] || { printf 'Expected %s calls matching %s, got %s.\n' "$1" "$2" "$count" >&2; return 1; }
}
no_call() {
  if grep -Eq -- "$1" "$fixture/new.calls"; then printf 'Unexpected call: %s\n' "$(grep -Em1 -- "$1" "$fixture/new.calls")" >&2; return 1; fi
}
# Extended regular expressions that match this run's calls in this order.
in_order() {
  local pattern line=0 found
  for pattern; do
    found=$(pattern=$pattern awk -v start="$line" 'NR > start && $0 ~ ENVIRON["pattern"] { print NR; exit }' "$fixture/new.calls")
    [[ -n "$found" ]] || { printf 'Missing after call %s: %s\n' "$line" "$pattern" >&2; return 1; }
    line=$found
  done
}
link() { readlink -- "$app/$1" 2>/dev/null || true; }
unit_state() { if [[ -f "$sd/active/$1" ]]; then sed -n "s/^$2=//p" "$sd/active/$1"; fi; }
# What a failed or refused activation must leave as it was.
records() {
  local name
  for name in .api-slot .deployed-state .runtime-deployment; do printf '%s=%s\n' "$name" "$(cat -- "$app/$name" 2>/dev/null || true)"; done
  printf 'current=%s\nprevious=%s\n' "$(link current)" "$(link previous)"
}
processes() { printf '%s %s %s\n' "$(unit_state "$service" pid)" "$(unit_state "$service" release)" "$(unit_state "$service-entry" pid)"; }
# The dual-slot layout serving $2 from slot $1 with rollback target $3.
expect_dual() {
  local slot=$1 release=$2 previous=$3 other=a
  [[ $slot != a ]] || other=b
  [[ $(cat -- "$app/.api-slot") == "{\"slot\":\"$slot\",\"release\":\"$release\"}" ]]
  [[ $(link current) == "$release" && $(link "slots/$slot") == "$release" && $(link previous) == "$previous" && ! -e "$app/.api-cutover" ]]
  [[ -f "$fixture/entry-unit" && -f "$fixture/slot-unit" && ! -e "$fixture/api-unit" ]]
  grep -Eq "^Wants=.* $service-entry\.service$" "$fixture/unit"
  [[ -f "$sd/active/$service" && -f "$sd/active/$service-entry" && $(unit_state "$service-entry" target) == "$slot" ]]
  [[ -f "$sd/active/$service-api@$slot" && -f "$sd/enabled/$service-api@$slot" ]]
  [[ $(unit_state "$service-api@$slot" release) == "$release" && $(unit_state "$service-api@$slot" mode) == serving ]]
  [[ ! -f "$sd/active/$service-api@$other" && ! -f "$sd/enabled/$service-api@$other" ]]
}
export PROJECT_DEPLOY_MODE=ci PROJECT_DEPLOY_TESTS=0

# 1. A running update worker whose registry predates the dual-slot units keeps
# the first install on the single API unit (design doc api-dual-slot 6.2).
printf "LAYOUTS = ('single',)\n" > "$fixture/updater/registry.py"
touch "$fixture/worker-active"
make_package initial
r1=$(release_path initial)
run_install
expect_code 0
in_order '^layout single$' '^scope full$' '^dual_teardown' "^systemctl restart $service$" '^finish_activation'
no_call '^(activate_dual_full|api_cutover)'
[[ -f "$fixture/api-unit" && ! -e "$fixture/entry-unit" && ! -e "$fixture/slot-unit" && ! -e "$app/.api-slot" ]]
[[ $(link current) == "$r1" && -f "$sd/active/$service-api" && $(unit_state "$service" release) == "$r1" ]]

# 2. First enable: once the registry knows the layout, the same release moves to
# the dual-slot units in a full activation on slot a; the single API unit goes.
printf "LAYOUTS = ('single', 'dual-slot')\n" > "$fixture/updater/registry.py"
run_install
expect_code 0
in_order '^layout dual$' '^scope full$' '^activate_dual_full$' "^systemctl stop $service$" "^systemctl stop $service-api$" \
  "^migrate $r1$" '^systemctl daemon-reload$' "^systemctl disable $service-api@b$" "^systemctl enable $service-api@a$" \
  "^systemctl enable $service$" "^systemctl start $service$" '^finish_activation'
no_call '^(api_cutover|systemctl restart)'
expect_dual a "$r1" ''
[[ $(link slots/b) == "$r1" && -f "$app/.runtime-deployment" && $(unit_state "$service" release) == "$r1" ]]
[[ $(cat "$app/.deployed-state") == "$(git -C "$fixture/source" rev-parse HEAD) "* ]]
runtime_deployment=$(cat "$app/.runtime-deployment")

# 3. An API-only update moves only the API slots: slot b starts, passes its
# probe, takes the record and current, is promoted, and the entry switches to it
# before slot a drains. The runtime and the entry keep running.
new_package page initial
r2=$(release_path page)
before=$(processes)
run_install
expect_code 0
in_order '^layout dual$' '^scope api$' "^api_cutover b $r2$" "^systemctl stop $service-api@b$" "^systemctl disable $service-api@b$" \
  "^systemctl start $service-api@b$" "^probe b candidate $r2$" "^systemctl enable $service-api@b$" '^ctl b POST /promote$' \
  '^ctl entry POST /switch .*"slot":"b"' "^systemctl disable $service-api@a$" "^systemctl stop $service-api@a$" \
  '^ctl entry GET /status' '^finish_activation'
no_call "^(activate_dual_full|migrate |systemctl daemon-reload|systemctl (start|stop|restart) $service(-entry)?$)"
expect_dual b "$r2" "$r1"
[[ $(processes) == "$before" && $(link slots/a) == "$r1" && $(cat "$app/.runtime-deployment") == "$runtime_deployment" ]]
[[ $(cat "$app/.deployed-state") == "$(git -C "$fixture/source" rev-parse HEAD) "* ]]

# 4. A full update restarts the group on the new release and keeps slot b.
new_package runtime two
r3=$(release_path runtime)
run_install
expect_code 0
in_order '^layout dual$' '^scope full$' '^activate_dual_full$' "^systemctl stop $service$" "^migrate $r3$" '^systemctl daemon-reload$' \
  "^systemctl disable $service-api@a$" "^systemctl enable $service-api@b$" "^systemctl start $service$" '^finish_activation'
no_call '^api_cutover'
expect_dual b "$r3" "$r2"
[[ $(link slots/a) == "$r3" && $(unit_state "$service" release) == "$r3" && $(processes) != "$before" && -f "$app/.runtime-deployment" ]]
cp "$fixture/release-manifest.json" "$fixture/runtime.manifest.json"
cp "$fixture/package.tar.gz" "$fixture/runtime.package.tar.gz"

# 5. Admitted as API-only, a runtime change is refused with 75 before anything
# activates: no unit, slot, entry or record changes.
new_package refused three
before=$(processes) state=$(records)
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 75
has_call '^layout dual$'
has_call '^scope full$'
no_call '^(systemctl |ctl |probe |migrate |activate_dual_full|api_cutover|finish_activation)'
[[ $(processes) == "$before" && $(records) == "$state" ]]
expect_dual b "$r3" "$r2"

# 6. A candidate that fails its directed probe never takes the traffic: it is
# stopped and disabled, slot b and every record stay (status 1, not 75).
new_package page-two two
r5=$(release_path page-two)
printf '%s\n' "$r5" > "$fixture/broken-release"
run_install PROJECT_DEPLOY_SCOPE=api
rm -f -- "$fixture/broken-release"
expect_code 1
in_order '^scope api$' "^api_cutover a $r5$" "^systemctl start $service-api@a$" "^probe a candidate $r5$" '^api_cutover_rollback' \
  "^systemctl stop $service-api@a$" "^systemctl disable $service-api@a$"
no_call "^(ctl [ab] POST /promote|ctl entry POST /switch|finish_activation|systemctl (start|stop|restart) $service(-entry)?$)"
[[ $(processes) == "$before" && $(records) == "$state" ]]
expect_dual b "$r3" "$r2"
expect_api_rollback_log

# 7. A failure after the record and current moved (the entry refuses the switch)
# carries the traffic back to slot b and its release.
touch "$fixture/fail-switch"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 1
in_order "^api_cutover a $r5$" "^probe a candidate $r5$" "^systemctl enable $service-api@a$" '^ctl a POST /promote$' \
  '^ctl entry POST /switch .*"slot":"a"' '^switch refused$' '^api_cutover_rollback' "^api_cutover b $r3 3( |$)" \
  "^probe b serving $r3$" '^ctl b POST /promote$' '^ctl entry POST /switch .*"slot":"b"' "^systemctl disable $service-api@a$" \
  "^systemctl stop $service-api@a$"
no_call "^(finish_activation|systemctl (start|stop|restart) $service(-entry)?$)"
[[ ! -e "$fixture/fail-switch" && $(processes) == "$before" && $(records) == "$state" ]]
expect_dual b "$r3" "$r2"
expect_api_rollback_log

# 7a. Start every interruption at B=r3, previous=A=r2, candidate=C=r5.
# Run the real main() twice, not a reconstructed in-memory cutover. The
# checkpoint only isolates cases; all expected releases and slots are fixed.
mkdir "$fixture/checkpoint"
cp -a "$app" "$sd" "$fixture/checkpoint/"
restore_checkpoint() {
  rm -rf -- "$app" "$sd"
  cp -a "$fixture/checkpoint/application" "$fixture/checkpoint/systemd" "$fixture/"
}
regression_failures=0
for boundary in before-rollback-record rollback-promotion legacy-rollback-promotion; do
  restore_checkpoint
  touch "$fixture/fail-switch"
  if [[ "$boundary" == before-rollback-record ]]; then
    printf 'systemctl enable %s-api@b\n' "$service" > "$fixture/crash-on"
  else
    printf 'ctl b POST /promote\n' > "$fixture/crash-on"
  fi
  run_install PROJECT_DEPLOY_SCOPE=api
  expect_code 137
  [[ -f "$app/.api-cutover" && $(link previous) == "$r2" ]]
  if [[ "$boundary" == legacy-rollback-promotion ]]; then
    python3 - "$app/.api-cutover" <<'LEGACY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
value = json.loads(path.read_text())
path.write_text(json.dumps({key: value[key] for key in ('from', 'to', 'release', 'phase')}))
LEGACY
  fi
  # The next attempt at C also fails, after recovery of the interrupted
  # rollback. A failed candidate must never become B's rollback release.
  printf '%s\n' "$r5" > "$fixture/broken-release"
  run_install PROJECT_DEPLOY_SCOPE=api
  rm -f -- "$fixture/broken-release"
  expect_code 1
  has_call '^resolve_cutover$'
  if [[ $(link current) != "$r3" || $(link previous) != "$r2" ]]; then
    printf 'Regression %s: expected current=%s previous=%s; got current=%s previous=%s.\n' \
      "$boundary" "$r3" "$r2" "$(link current)" "$(link previous)" >&2
    regression_failures=$((regression_failures + 1))
  else
    expect_dual b "$r3" "$r2"
    expect_api_rollback_log
  fi
done

# 7b. A successful forward switch must retain B across both sides of its
# previous write and journal removal, even if the retry takes the no-op path.
for boundary in removed-cutover before-previous after-previous; do
  restore_checkpoint
  if [[ "$boundary" == removed-cutover ]]; then
    printf 'removed cutover\n' > "$fixture/crash-on"
  elif [[ "$boundary" == before-previous ]]; then
    printf 'link previous %s\n' "$r3" > "$fixture/crash-on"
  else
    printf 'linked previous %s\n' "$r3" > "$fixture/crash-on"
  fi
  run_install PROJECT_DEPLOY_SCOPE=api
  expect_code 137
  [[ $(link current) == "$r5" && $(unit_state "$service-entry" target) == a ]]
  run_install PROJECT_DEPLOY_SCOPE=api
  expect_code 0
  if [[ $(link previous) != "$r3" ]]; then
    printf 'Regression %s: expected previous=%s, got %s.\n' "$boundary" "$r3" "$(link previous)" >&2
    regression_failures=$((regression_failures + 1))
  else
    expect_dual a "$r5" "$r3"
    [[ $(processes) == "$before" ]]
    if [[ "$boundary" == removed-cutover ]]; then no_call '^api_cutover '; else call_count 1 '^api_cutover '; fi
  fi
done
# A later bookkeeping failure still rolls back in the same process. Even
# though the forward switch saved B as previous, that rollback must restore A.
restore_checkpoint
touch "$fixture/fail-finalize"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 1
in_order '^finalize refused$' '^api_cutover_rollback' "^api_cutover b $r3 1( |$)"
expect_dual b "$r3" "$r2"
expect_api_rollback_log
# Explicit absence is also part of the rollback state.
restore_checkpoint
rm -f -- "$app/previous"
touch "$fixture/fail-finalize"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 1
expect_dual b "$r3" ''
expect_api_rollback_log

# 7c. B has no previous. Its failed upgrade to C rolls back, but is killed
# after the slot record returns to B and before current leaves C. Reinstall B:
# recovery's explicit absence must clear the C captured at main() startup.
restore_checkpoint
rm -f -- "$app/previous"
cp "$fixture/release-manifest.json" "$fixture/checkpoint/candidate.manifest.json"
cp "$fixture/package.tar.gz" "$fixture/checkpoint/candidate.package.tar.gz"
touch "$fixture/fail-switch"
printf 'link current %s\n' "$r3" > "$fixture/crash-on"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 137
[[ $(link current) == "$r5" && ! -e "$app/previous" && ! -L "$app/previous" ]]
[[ $(cat "$app/.api-slot") == "{\"slot\":\"b\",\"release\":\"$r3\"}" ]]
expect_cutover a b "$r3" switching rollback -
cp "$fixture/runtime.manifest.json" "$fixture/release-manifest.json"
cp "$fixture/runtime.package.tar.gz" "$fixture/package.tar.gz"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 0
in_order '^resolve_cutover$' "^api_cutover b $r3 3 rollback -$" '^scope api$' '^finish_activation'
call_count 1 '^api_cutover '
[[ ! -e "$app/previous" && ! -L "$app/previous" ]] || {
  printf 'Reinstalling B after rollback recreated previous: expected absent, got %s.\n' "$(link previous)" >&2
  false
}
expect_dual b "$r3" ''
[[ $(processes) == "$before" ]]
cp "$fixture/checkpoint/candidate.manifest.json" "$fixture/release-manifest.json"
cp "$fixture/checkpoint/candidate.package.tar.gz" "$fixture/package.tar.gz"
restore_checkpoint
rm -rf -- "$fixture/checkpoint"
[[ $regression_failures == 0 ]] || { printf '%s interruption regressions failed.\n' "$regression_failures" >&2; false; }

# 8. Interrupted before the record moved: the next run stops the candidate the
# record never named, then switches anew.
printf 'systemctl enable %s-api@a\n' "$service" > "$fixture/crash-on"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 137
expect_cutover b a "$r5" switching forward "$r2"
[[ $(records) == "$state" && -f "$sd/active/$service-api@a" && $(unit_state "$service-entry" target) == b ]]
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 0
in_order '^resolve_cutover$' "^systemctl stop $service-api@a$" "^systemctl disable $service-api@a$" '^scope api$' \
  "^api_cutover a $r5$" "^probe a candidate $r5$" '^ctl entry POST /switch .*"slot":"a"' '^finish_activation'
[[ $(processes) == "$before" ]]
expect_dual a "$r5" "$r3"

# 9. Interrupted at promotion, after the record AND current moved. previous
# still names r3, but r5 was serving: recovery must retain r5 and finish on b
# exactly once, without flipping the same release back to a.
new_package page-three two
r6=$(release_path page-three)
printf 'ctl b POST /promote\n' > "$fixture/crash-on"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 137
[[ $(cat "$app/.api-slot") == "{\"slot\":\"b\",\"release\":\"$r6\"}" && $(link current) == "$r6" ]]
[[ $(link previous) == "$r3" && $(unit_state "$service-entry" target) == a ]]
[[ $(unit_state "$service-api@b" mode) == candidate ]]
expect_cutover a b "$r6" switching forward "$r3"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 0
in_order '^resolve_cutover$' "^api_cutover b $r6 3( |$)" '^ctl b GET /identity$' "^probe b candidate $r6$" '^ctl b POST /promote$' \
  '^ctl entry POST /switch .*"slot":"b"' "^systemctl stop $service-api@a$" '^scope api$' '^finish_activation'
no_call "^systemctl (start|stop|restart) $service(-entry)?$"
[[ $(processes) == "$before" ]]
[[ $(link previous) == "$r5" ]] || { printf 'Promotion recovery lost the previously serving release: expected %s, got %s.\n' "$r5" "$(link previous)" >&2; false; }
call_count 1 '^api_cutover '
call_count 1 '^ctl entry POST /switch '
no_call '^ctl a POST /promote$'
expect_dual b "$r6" "$r5"

# 10. The earlier crash boundary, between the record and current, also finishes
# on its fixed target a without a second cutover.
new_package page-four two
r7=$(release_path page-four)
printf 'link current %s\n' "$r7" > "$fixture/crash-on"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 137
[[ $(cat "$app/.api-slot") == "{\"slot\":\"a\",\"release\":\"$r7\"}" && $(link current) == "$r6" ]]
expect_cutover b a "$r7" switching forward "$r5"
run_install PROJECT_DEPLOY_SCOPE=api
expect_code 0
in_order '^resolve_cutover$' "^api_cutover a $r7 3( |$)" '^ctl a GET /identity$' "^probe a candidate $r7$" '^ctl a POST /promote$' \
  '^ctl entry POST /switch .*"slot":"a"' "^systemctl stop $service-api@b$" '^scope api$' '^finish_activation'
call_count 1 '^api_cutover '
call_count 1 '^ctl entry POST /switch '
no_call "^ctl b POST /promote$|^systemctl (start|stop|restart) $service(-entry)?$"
[[ $(processes) == "$before" ]]
expect_dual a "$r7" "$r6"

# 11. A failed full update restores the units, the recorded slot's link, the
# record, current and the environment, and restarts the group on that release.
# The candidate must really install different unit files AND environment before
# it fails; comparing unchanged inputs would not prove any restoration.
new_package runtime-four four
r8=$(release_path runtime-four)
before_slot=a
cp "$fixture/unit" "$fixture/unit.before"; cp "$fixture/entry-unit" "$fixture/entry-unit.before"; cp "$fixture/slot-unit" "$fixture/slot-unit.before"
cp "$fixture/environment" "$fixture/environment.before"
deployed=$(cat "$app/.deployed-state")
touch "$fixture/candidate-units"
sed -i 's/^PORT=.*/PORT=4200/' "$fixture/environment"
printf '%s\n' "$r8" > "$fixture/unready-release"
run_install
rm -f -- "$fixture/unready-release" "$fixture/candidate-units"
expect_code 1
in_order '^scope full$' '^activate_dual_full$' "^systemctl stop $service$" "^systemctl start $service$" '^restore_dual_units$' \
  "^systemctl enable $service-api@$before_slot$" "^systemctl restart $service$"
no_call '^(finish_activation|api_cutover)'
expect_dual "$before_slot" "$r7" "$r6"
[[ $(unit_state "$service" release) == "$r7" && $(cat "$app/.deployed-state") == "$deployed" ]]
for file in unit entry-unit slot-unit environment; do
  [[ -f "$fixture/$file.candidate" ]]
  if cmp -s "$fixture/$file.candidate" "$fixture/$file.before"; then
    printf 'The failed candidate never changed %s.\n' "$file" >&2; false
  fi
  cmp -s "$fixture/$file" "$fixture/$file.before"
done
failed_environments=("$fixture/environment".failed-*)
[[ ${#failed_environments[@]} == 1 ]]
cmp -s "${failed_environments[0]}" "$fixture/environment.candidate"
cmp -s "$app/.last-successful.env" "$fixture/environment.before"
# Retrying the same release after the restore activates it in full. Interrupt
# after that activation commits but before previous is persisted; a no-op
# retry must not leave the rollback pointer two successful releases behind.
printf 'link previous %s\n' "$r7" > "$fixture/crash-on"
run_install
expect_code 137
in_order '^scope full$' '^activate_dual_full$' '^finish_activation'
[[ $(link current) == "$r8" && $(link previous) == "$r6" ]]
[[ $(cat "$app/.pending-previous") == "$r8 $r7 full" ]]
run_install
expect_code 0
has_call '^scope full$'
expect_dual "$before_slot" "$r8" "$r7"
[[ ! -e "$app/.pending-previous" ]]

# 12. A fresh install with an update service that knows the layout starts on
# the dual-slot units, slot a.
make_package fresh
run_install FRESH_INSTALL=1
expect_code 0
in_order '^layout dual$' '^scope full$' '^activate_dual_full$' "^systemctl start $service$" '^finish_activation'
fresh=$(release_path fresh "$fixture/fresh-application")
[[ $(cat "$fixture/fresh-application/.api-slot") == "{\"slot\":\"a\",\"release\":\"$fresh\"}" ]]
[[ $(readlink "$fixture/fresh-application/current") == "$fresh" && -f "$fixture/fresh-entry-unit" && ! -e "$fixture/fresh-api-unit" ]]
[[ -f "$fixture/fresh-systemd/active/$service-api@a" && -f "$fixture/fresh-systemd/enabled/$service-api@a" ]]
printf 'Dual-slot main(): layout gate, first enable, API-only and full updates, scope refusal, failed candidate, rollback after the record moved, interrupted switches and failed full update passed.\n'
