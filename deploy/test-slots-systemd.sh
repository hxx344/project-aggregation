#!/usr/bin/env bash
# The installer's dual-slot units under real systemd on a disposable runner
# (design doc api-dual-slot 6.6): the real entry and API slots, the test
# runtime over fake modules (tests/fixtures/split-runtime.mjs) and a handmade
# frontend. First enable, API-only switches under continuous short and
# keep-alive requests, a failed candidate, the rollback after the record
# moved, interrupted switches, a full update that keeps the slot, the group
# stop and the way back to the single API unit.
set -Eeuo pipefail
[[ ${AGG_SLOTS_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires a disposable Linux root CI runner.' >&2; exit 1;
}
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'Real systemd is required.' >&2; exit 1; }
repository=$(cd -- "$(dirname "$0")/.." && pwd -P)
node=$(realpath -e "${SLOTS_TEST_NODE:?Pass the verified Node executable}")
[[ -d "$repository/node_modules/pino" ]] || { echo 'Install the dependencies first (pino).' >&2; exit 1; }
AGG_INSTALL_SOURCE_ONLY=1 source "$repository/deploy/install.sh"
# The entry finds the slots by the installed names (server/slot-protocol.mjs), so this test uses them.
DATA_PATH=/var/lib/$SERVICE NODE_BIN=$node GREEKS_PYTHON_PATH=/usr/bin/python3 ASTER_PYTHON_PATH=/usr/bin/python3
for target in "$APP_DIR" "$DATA_PATH" "$ENV_FILE" "$UNIT_FILE" "$API_UNIT_FILE" "$ENTRY_UNIT_FILE" "$SLOT_UNIT_FILE" "/run/$SERVICE" "/run/$ENTRY_SERVICE"; do
  [[ ! -e "$target" && ! -L "$target" ]] || { echo "Refusing existing $target" >&2; exit 1; }
done
! getent passwd "$SERVICE_USER" >/dev/null || { echo "Refusing an existing $SERVICE_USER account." >&2; exit 1; }
work_dir=$(mktemp -d)
load_pid=
cleanup() {
  local result=$? unit
  trap - EXIT
  [[ -z "$load_pid" ]] || kill "$load_pid" 2>/dev/null || true
  if (( result )); then
    journalctl --no-pager -n 60 -u "$SERVICE" -u "$ENTRY_SERVICE" -u "$API_SERVICE@a" -u "$API_SERVICE@b" -u "$API_SERVICE" >&2 || true
  fi
  systemctl stop "$SERVICE" "$ENTRY_SERVICE" "$API_SERVICE@a" "$API_SERVICE@b" "$API_SERVICE" >/dev/null 2>&1 || true
  systemctl disable "$API_SERVICE@a" "$API_SERVICE@b" "$SERVICE" >/dev/null 2>&1 || true
  for unit in "$UNIT_FILE" "$API_UNIT_FILE" "$ENTRY_UNIT_FILE" "$SLOT_UNIT_FILE"; do
    if [[ -f "$unit" ]] && grep -qx '# Managed by project-aggregation installer' "$unit"; then rm -f -- "$unit"; fi
  done
  rmdir -- "$ENTRY_UNIT_FILE.wants" 2>/dev/null || true
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE" "$ENTRY_SERVICE" "$API_SERVICE@a" "$API_SERVICE@b" "$API_SERVICE" >/dev/null 2>&1 || true
  rm -rf -- "$APP_DIR" "$DATA_PATH" "$ENV_FILE" "$work_dir"
  if getent passwd "$SERVICE_USER" >/dev/null; then userdel "$SERVICE_USER"; fi
  if getent group "$SERVICE_USER" >/dev/null; then groupdel "$SERVICE_USER"; fi
  exit "$result"
}
trap cleanup EXIT
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
PORT_VALUE=$port HEALTH_URL=$(health_url 127.0.0.1 "$port")
install -m 0640 -o root -g "$SERVICE_USER" /dev/null "$ENV_FILE"
printf 'HOST=127.0.0.1\nPORT=%s\nDATA_DIR=%s\nNODE_ENV=production\nINITIAL_PASSWORD=%s\nMODULE_SOCKET_DIR=%s/modules\n' \
  "$port" "$DATA_PATH" "$(python3 -c 'import secrets; print(secrets.token_hex(16))')" "$DATA_PATH" > "$ENV_FILE"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_PATH" "$DATA_PATH/modules"

# pino and what it needs, flat, from the checkout's locked install.
cat > "$work_dir/collect.mjs" <<'JS'
import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const [root, out] = process.argv.slice(2), seen = new Map();
const locate = (from, name) => {
  for (const base of createRequire(path.join(from, 'index.js')).resolve.paths(name) ?? []) {
    if (existsSync(path.join(base, name, 'package.json'))) return realpathSync(path.join(base, name));
  }
  return null;
};
const visit = (from, name, optional) => {
  const dir = locate(from, name);
  if (!dir) { if (optional) return; throw new Error(`${name} is not installed`); }
  if (seen.has(name)) { if (seen.get(name) !== dir) throw new Error(`Two versions of ${name}`); return; }
  seen.set(name, dir);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dir, dependency, false);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) visit(dir, dependency, true);
  cpSync(dir, path.join(out, name), { recursive: true, dereference: true });
};
visit(root, 'pino', false);
JS
"$node" "$work_dir/collect.mjs" "$repository" "$work_dir/node_modules"

# A release: the real server, the test runtime in place of server/runtime/main.mjs
# (the runtime unit runs that file) and a frontend of one page and one asset.
# Without the asset the directed probe refuses the release.
stage_release() {
  local dir="$APP_DIR/releases/$1" tag=$2
  mkdir -p "$dir/tests/fixtures" "$dir/dist/assets"
  cp -a "$repository/server" "$dir/server"
  # What server/ reads outside itself.
  install -D -m 0644 "$repository/modules/asset/lib/auth-core.ts" "$dir/modules/asset/lib/auth-core.ts"
  mkdir -p "$dir/tools" && cp -a "$repository/tools/entropy-lighter-lab" "$dir/tools/"
  cp -a "$work_dir/node_modules" "$dir/node_modules"
  cp "$repository/tests/fixtures/split-runtime.mjs" "$repository/tests/fixtures/split-modules.mjs" "$dir/tests/fixtures/"
  mv "$dir/server/runtime/main.mjs" "$dir/server/runtime/real-main.mjs"
  sed -i "s#'../../server/runtime/main.mjs'#'../../server/runtime/real-main.mjs'#" "$dir/tests/fixtures/split-runtime.mjs"
  printf "import '../../tests/fixtures/split-runtime.mjs';\n" > "$dir/server/runtime/main.mjs"
  printf '<!doctype html><title>%s</title><script type="module" src="/assets/app-%s.js"></script>\n' "$tag" "$tag" > "$dir/dist/index.html"
  [[ ${3:-} == broken ]] || printf 'document.title = %s;\n' "'$tag'" > "$dir/dist/assets/app-$tag.js"
  touch "$dir/.managed-release"
  chmod -R a+rX,go-w "$dir"
  printf '%s' "$dir"
}
mkdir -p "$APP_DIR/releases"
release_one=$(stage_release 111111111111-aaaaaaaaaaaaaaaa one)
release_two=$(stage_release 222222222222-bbbbbbbbbbbbbbbb two)
release_bad=$(stage_release 333333333333-cccccccccccccccc bad broken)
release_three=$(stage_release 444444444444-dddddddddddddddd three)
release_four=$(stage_release 555555555555-eeeeeeeeeeeeeeee four)
chmod a+rX,go-w "$APP_DIR" "$APP_DIR/releases"

# Continuous requests through the public port: two lanes of new connections and
# two of keep-alive connections. A request that fails on a reused keep-alive
# connection is retried once, as a browser does when the server closed it idle
# (RFC 9112 9.3.1); anything else that is not a 200 counts.
cat > "$work_dir/load.mjs" <<'JS'
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const port = Number(process.argv[2]), out = process.argv[3];
let running = true;
process.on('SIGTERM', () => { running = false; });
const once = agent => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent, timeout: 10_000, headers: agent ? {} : { Connection: 'close' } }, res => {
    res.on('error', error => resolve({ error: error.code || error.message, reused: req.reusedSocket }));
    res.on('end', () => resolve({ status: res.statusCode })).resume();
  });
  req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  req.on('error', error => resolve({ error: error.code || error.message, reused: req.reusedSocket }));
});
const lanes = {};
const lane = async (name, agent) => {
  const stats = lanes[name] = { ok: 0, http: {}, errors: {}, retried: 0, maxGapMs: 0 };
  let last = Date.now();
  while (running) {
    let result = await once(agent);
    if (result.error && result.reused) { stats.retried += 1; result = await once(agent); }
    const now = Date.now();
    if (result.status === 200) { stats.ok += 1; stats.maxGapMs = Math.max(stats.maxGapMs, now - last); last = now; }
    else if (result.status) stats.http[result.status] = (stats.http[result.status] ?? 0) + 1;
    else stats.errors[result.error] = (stats.errors[result.error] ?? 0) + 1;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const keepAlive = () => new http.Agent({ keepAlive: true, maxSockets: 1 });
await Promise.all([lane('short-1', false), lane('short-2', false), lane('keep-alive-1', keepAlive()), lane('keep-alive-2', keepAlive())]);
writeFileSync(out, JSON.stringify(lanes));
JS
start_load() { "$node" "$work_dir/load.mjs" "$port" "$work_dir/load.json" & load_pid=$!; sleep 1; }
# Stops the requests and fails on any refusal, reset or HTTP failure.
check_load() {
  kill -TERM "$load_pid"; wait "$load_pid"; load_pid=
  python3 -I - "$work_dir/load.json" "$1" <<'LOAD_PY'
import json, sys
lanes = json.load(open(sys.argv[1]))
print(f'{sys.argv[2]}: ' + '; '.join(f"{name} {value['ok']} ok, {value['retried']} retried, longest gap {value['maxGapMs']} ms" for name, value in lanes.items()))
bad = {name: value for name, value in lanes.items() if value['http'] or value['errors'] or not value['ok']}
if bad:
    sys.exit(f'Requests failed during {sys.argv[2]}: {json.dumps(bad)}')
LOAD_PY
}
main_pid() { systemctl show -p MainPID --value "$1"; }
identity() { ctl_request "$(slot_ctl "$1")" GET /identity; }
entry_status() { ctl_request "$(entry_ctl)" GET /status; }
inactive() { [[ $(systemctl is-active "$1") != active ]]; }
release_tag() { tr -d '\n' < "$1/dist/index.html" | sed 's#.*<title>\([^<]*\)</title>.*#\1#'; }
# The page the public port serves on the workbench's canonical host.
page_is() { [[ $(curl --fail --silent --max-time 3 -H "Host: hub.localhost:$port" "${HEALTH_URL%/api/health}/" | sed -n 's#.*<title>\([^<]*\)</title>.*#\1#p') == "$(release_tag "$1")" ]]; }

expect_state() { # slot release
  [[ $(read_slot_record) == "$1 $2" && $(readlink "$APP_DIR/current") == "$2" && $(readlink "$APP_DIR/slots/$1") == "$2" ]]
  [[ $(identity "$1" | json_field mode) == serving && $(identity "$1" | json_field release) == "$2" ]]
  [[ $(entry_status | json_field target) == "$1" && $(systemctl is-enabled "$(slot_unit "$1")") == enabled ]]
  inactive "$(slot_unit "$(other_slot "$1")")"
  [[ $(systemctl is-enabled "$(slot_unit "$(other_slot "$1")")") != enabled && ! -e "$APP_DIR/.api-cutover" ]]
  page_is "$2"
}
systemd_version=$(systemd_major)
(( systemd_version > 0 ))
migrate_embedded_modules() { :; } # Nothing to migrate in a fresh data directory.

# First enable (design doc 6.2): the group comes up on slot a.
slot_layout=dual release=$release_one
write_unit
activate_dual_full
wait_healthy
expect_state a "$release_one"
[[ $(stat -c '%U %a' "/run/$ENTRY_SERVICE") == "$SERVICE_USER 700" && $(stat -c '%U %a' "/run/$API_SERVICE-a") == "$SERVICE_USER 700" ]]
[[ ! -e "$API_UNIT_FILE" && $(identity a | json_field pid) == "$(main_pid "$API_SERVICE@a")" ]]
runtime_pid=$(main_pid "$SERVICE") entry_pid=$(main_pid "$ENTRY_SERVICE")

# An API-only update (design doc 3.5) moves the traffic to slot b under load;
# the runtime and the entry keep running.
start_load
api_cutover b "$release_two"
check_load 'switch a -> b'
expect_state b "$release_two"
[[ $(main_pid "$SERVICE") == "$runtime_pid" && $(main_pid "$ENTRY_SERVICE") == "$entry_pid" ]]
[[ $(entry_status | json_field connections.a) == 0 ]]

# A candidate that fails the directed probe never takes traffic; its rollback
# stops it and the serving slot never changed.
old_slot_record=$(read_slot_record) cutover_committed=0
start_load
if api_cutover a "$release_bad"; then echo 'A broken candidate took the traffic' >&2; exit 1; fi
(( ! cutover_committed ))
api_cutover_rollback
check_load 'failed candidate'
expect_state b "$release_two"

# A switch back to slot a, then the rollback of a switch whose record had moved
# (design doc 6.3): the traffic returns to slot b and its release.
old_slot_record=$(read_slot_record) cutover_committed=0
start_load
api_cutover a "$release_three"
expect_state a "$release_three"
(( cutover_committed ))
api_cutover_rollback
check_load 'switch a and its rollback'
expect_state b "$release_two"
[[ $(main_pid "$SERVICE") == "$runtime_pid" && $(main_pid "$ENTRY_SERVICE") == "$entry_pid" ]]

# Interrupted switches (design doc 3.5): a candidate the record never named is
# stopped; one it already names is carried through.
atomic_link "$release_three" "$APP_DIR/slots/a"
write_cutover b a "$release_three" candidate
systemctl start "$(slot_unit a)"
wait_slot a "$release_three" candidate
resolve_cutover
inactive "$(slot_unit a)"
expect_state b "$release_two"
write_cutover b a "$release_three" switching
write_slot_record a "$release_three"
start_load
resolve_cutover
check_load 'interrupted switch carried through'
expect_state a "$release_three"

# A full update (design doc 3.6) restarts the group and keeps the recorded slot.
release=$release_four
write_unit
activate_dual_full
wait_healthy
expect_state a "$release_four"
[[ $(readlink "$APP_DIR/slots/b") == "$release_four" && $(main_pid "$SERVICE") != "$runtime_pid" ]]

# The group stop ends the slot, and its draining, before the entry; the next
# start brings up only the recorded slot.
systemctl stop "$SERVICE"
[[ $(systemctl is-active "$SERVICE" "$ENTRY_SERVICE" "$(slot_unit a)" "$(slot_unit b)" | sort -u) == inactive ]]
(( $(systemctl show -p InactiveEnterTimestampMonotonic --value "$(slot_unit a)") <= $(systemctl show -p InactiveEnterTimestampMonotonic --value "$ENTRY_SERVICE") ))
systemctl start "$SERVICE"
wait_healthy
expect_state a "$release_four"

# Back to the single API unit (design doc 3.9): the dual-slot units and their state go.
systemctl stop "$SERVICE"
dual_teardown
slot_layout=single
write_unit
install -m 0644 "$work_dir/service" "$UNIT_FILE"
install -m 0644 "$work_dir/api.service" "$API_UNIT_FILE"
systemctl daemon-reload
systemctl start "$SERVICE"
wait_healthy
[[ ! -e "$ENTRY_UNIT_FILE" && ! -e "$SLOT_UNIT_FILE" && ! -e "$ENTRY_UNIT_FILE.wants" && ! -e "$APP_DIR/.api-slot" && ! -e "$APP_DIR/slots" ]]
inactive "$ENTRY_SERVICE"
[[ ! -e "/run/$ENTRY_SERVICE" ]]
page_is "$release_four"
echo 'Real systemd dual-slot entry, API-only switches under load, rollback, recovery, full update and back-out passed.'
