#!/usr/bin/env bash
# The installer's runtime and API units under real systemd on a disposable runner
# (design doc 6.1 and 6.7), with stand-in entries: Wants=/PartOf=, the runtime
# directory, a socket connect from the API's read-only /run, an API-only restart
# that keeps the runtime and its release, crash restarts and the stop order.
set -Eeuo pipefail
[[ ${AGG_UNITS_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires a disposable Linux root CI runner.' >&2; exit 1;
}
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'Real systemd is required.' >&2; exit 1; }
repository=$(cd -- "$(dirname "$0")/.." && pwd -P)
node=$(realpath -e "${UNITS_TEST_NODE:?Pass the verified Node executable}")
name=agg-units-fixture
for target in "/opt/$name" "/var/lib/$name" "/etc/$name.env" "/etc/systemd/system/$name.service" "/etc/systemd/system/$name-api.service" "/run/$name"; do
  [[ ! -e "$target" && ! -L "$target" ]] || { echo "Refusing existing $target" >&2; exit 1; }
done
! getent passwd "$name" >/dev/null || { echo "Refusing an existing $name account." >&2; exit 1; }
AGG_INSTALL_SOURCE_ONLY=1 source "$repository/deploy/install.sh"
SERVICE=$name API_SERVICE=$name-api SERVICE_USER=$name APP_DIR=/opt/$name DATA_PATH=/var/lib/$name ENV_FILE=/etc/$name.env
UNIT_FILE=/etc/systemd/system/$name.service API_UNIT_FILE=/etc/systemd/system/$name-api.service
NODE_BIN=$node GREEKS_PYTHON_PATH=/usr/bin/python3 ASTER_PYTHON_PATH=/usr/bin/python3
work_dir=$(mktemp -d)
cleanup() {
  local result=$?
  trap - EXIT
  systemctl stop "$SERVICE" "$API_SERVICE" >/dev/null 2>&1 || true
  for unit in "$UNIT_FILE" "$API_UNIT_FILE"; do
    if [[ -f "$unit" ]] && grep -qx '# Managed by project-aggregation installer' "$unit"; then rm -f -- "$unit"; fi
  done
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE" "$API_SERVICE" >/dev/null 2>&1 || true
  rm -rf -- "$APP_DIR" "$DATA_PATH" "$ENV_FILE" "$work_dir"
  if getent passwd "$name" >/dev/null; then userdel "$name"; fi
  if getent group "$name" >/dev/null; then groupdel "$name"; fi
  exit "$result"
}
trap cleanup EXIT
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
install -m 0640 -o root -g "$name" /dev/null "$ENV_FILE"
printf 'HOST=127.0.0.1\nPORT=%s\nDATA_DIR=%s\n' "$port" "$DATA_PATH" > "$ENV_FILE"
install -d -m 0700 -o "$name" -g "$name" "$DATA_PATH"
HEALTH_URL=$(health_url 127.0.0.1 "$port")

# Stand-ins for server/runtime/main.mjs and server/api/main.mjs: each reports
# its pid and the file it runs; the API connects to the runtime per request.
release_one="$APP_DIR/releases/111111111111-aaaaaaaaaaaaaaaa"
mkdir -p "$release_one/server/runtime" "$release_one/server/api"
cat > "$release_one/server/runtime/main.mjs" <<'JS'
import net from 'node:net';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
const dir = process.env.WORKBENCH_RUNTIME_DIR;
writeFileSync(path.join(process.env.DATA_DIR, 'runtime-wrote'), String(process.pid));
const server = net.createServer(socket => socket.end(JSON.stringify({ pid: process.pid, url: import.meta.url })));
server.listen(path.join(dir, 'runtime.sock'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
JS
cat > "$release_one/server/api/main.mjs" <<'JS'
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
const dir = process.env.WORKBENCH_RUNTIME_DIR;
let runDirWritable = true;
try { writeFileSync(path.join(dir, 'api-probe'), ''); } catch { runDirWritable = false; }
const runtime = () => new Promise((resolve, reject) => {
  let body = '';
  const socket = net.connect(path.join(dir, 'runtime.sock'));
  socket.on('data', chunk => { body += chunk; }).on('end', () => resolve(JSON.parse(body))).on('error', reject);
});
const server = http.createServer(async (request, response) => {
  try {
    const value = { api: { pid: process.pid, url: import.meta.url, runDirWritable }, runtime: await runtime() };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  } catch (error) { response.writeHead(503).end(String(error)); }
});
server.listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
JS
touch "$release_one/.managed-release"
chmod -R a+rX,go-w "$APP_DIR"
atomic_link "$release_one" "$APP_DIR/current"
systemd_version=$(systemd_major)
(( systemd_version > 0 ))
write_unit
if (( systemd_version >= 254 )); then grep -qx 'RestartSteps=5' "$work_dir/api.service"; else grep -qx 'RestartSec=5' "$work_dir/api.service"; fi
install -m 0644 "$work_dir/service" "$UNIT_FILE"
install -m 0644 "$work_dir/api.service" "$API_UNIT_FILE"
systemctl daemon-reload

state() { curl --fail --silent --max-time 3 "${HEALTH_URL%/api/health}/api/ready"; }
field() { python3 -c 'import json, sys; value = json.load(sys.stdin)
for key in sys.argv[1].split("."): value = value[key]
print(value)' "$1"; }
main_pid() { systemctl show -p MainPID --value "$1"; }
wait_until() { local attempt; for ((attempt = 0; attempt < 100; attempt++)); do if "$@"; then return 0; fi; sleep .2; done; "$@"; }
wait_main_pid() { local previous=$2; wait_until bash -c "pid=\$(systemctl show -p MainPID --value $1); [[ \$pid != 0 && \$pid != $previous ]]"; }

# The runtime unit pulls in the API (Wants=); both run as the service user.
systemctl start "$SERVICE"
wait_healthy
runtime_pid=$(main_pid "$SERVICE") api_pid=$(main_pid "$API_SERVICE")
snapshot=$(state)
[[ $(field runtime.pid <<< "$snapshot") == "$runtime_pid" && $(field api.pid <<< "$snapshot") == "$api_pid" ]]
[[ $(field runtime.url <<< "$snapshot") == "file://$release_one/server/runtime/main.mjs" ]] # Node runs the release, not current.
[[ $(field api.runDirWritable <<< "$snapshot") == False ]]
[[ $(live_runtime_release) == "$release_one" ]] # The installer reads the release from the runtime's working directory.
[[ $(stat -c '%U %a' "/run/$SERVICE") == "$name 700" && $(stat -c %U "$DATA_PATH/runtime-wrote") == "$name" ]]
[[ $(ps -o uid= -p "$runtime_pid" | tr -d ' ') == "$(id -u "$name")" && $(ps -o uid= -p "$api_pid" | tr -d ' ') == "$(id -u "$name")" ]]

# An API-only update: current moves, only the API restarts, the runtime keeps its release.
release_two="$APP_DIR/releases/222222222222-bbbbbbbbbbbbbbbb"
cp -a "$release_one" "$release_two"
atomic_link "$release_two" "$APP_DIR/current"
systemctl restart "$API_SERVICE"
wait_healthy
snapshot=$(state)
[[ $(main_pid "$SERVICE") == "$runtime_pid" && $(field runtime.pid <<< "$snapshot") == "$runtime_pid" ]]
[[ $(field runtime.url <<< "$snapshot") == "file://$release_one/server/runtime/main.mjs" ]]
[[ $(field api.url <<< "$snapshot") == "file://$release_two/server/api/main.mjs" && $(field api.pid <<< "$snapshot") != "$api_pid" ]]
[[ $(live_runtime_release) == "$release_one" ]]

# A crashed API restarts alone.
api_pid=$(main_pid "$API_SERVICE")
kill -KILL "$api_pid"
wait_main_pid "$API_SERVICE" "$api_pid"
wait_healthy
[[ $(main_pid "$SERVICE") == "$runtime_pid" ]]

# Restarting the runtime unit restarts the API too (PartOf=), into the new release.
api_pid=$(main_pid "$API_SERVICE")
systemctl restart "$SERVICE"
wait_healthy
snapshot=$(state)
[[ $(main_pid "$SERVICE") != "$runtime_pid" && $(main_pid "$API_SERVICE") != "$api_pid" ]]
[[ $(field runtime.url <<< "$snapshot") == "file://$release_two/server/runtime/main.mjs" ]]
[[ $(live_runtime_release) == "$release_two" ]]

# A crashed runtime restarts (RestartSec=5), the API restarts with it (PartOf=
# carries the automatic restart) and reaches the new instance.
runtime_pid=$(main_pid "$SERVICE") api_pid=$(main_pid "$API_SERVICE")
kill -KILL "$runtime_pid"
wait_main_pid "$SERVICE" "$runtime_pid"
wait_main_pid "$API_SERVICE" "$api_pid"
wait_healthy
printf 'Runtime crash restart: API pid %s -> %s\n' "$api_pid" "$(main_pid "$API_SERVICE")"

# A stopped API is started again with the runtime unit (Wants=).
systemctl stop "$API_SERVICE"
if healthy; then echo 'Healthy without the API unit' >&2; exit 1; fi
systemctl restart "$SERVICE"
wait_healthy

# Stopping the runtime unit stops the API first, then removes the runtime directory.
systemctl stop "$SERVICE"
[[ $(systemctl is-active "$SERVICE" "$API_SERVICE" | sort -u) == inactive && ! -e "/run/$SERVICE" ]]
api_stopped=$(systemctl show -p InactiveEnterTimestampMonotonic --value "$API_SERVICE")
runtime_stopped=$(systemctl show -p InactiveEnterTimestampMonotonic --value "$SERVICE")
(( api_stopped <= runtime_stopped ))
echo 'Real systemd runtime and API units, PartOf/Wants, runtime directory and API-only restarts passed.'
