#!/usr/bin/env bash
# Full installer decision paths with local git and isolated, fake runtimes/services.
set -Eeuo pipefail
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
export FIXTURE_ROOT=$fixture
mkdir -p "$fixture/source/src" "$fixture/source/server" "$fixture/source/tests" "$fixture/source/public" "$fixture/source/deploy" "$fixture/runtime"
cp "$repository/deploy/build-artifact-cache.py" "$fixture/source/deploy/build-artifact-cache.py"
mkdir -p "$fixture/source/tools/entropy-lighter-lab"
cp "$repository"/tools/entropy-lighter-lab/{cli.mjs,core.mjs,feeds.mjs,binance-scalper.mjs,config.example.json} "$fixture/source/tools/entropy-lighter-lab/"
printf '{"name":"fixture","version":"1.0.0","type":"module"}\n' > "$fixture/source/package.json"
printf '{}\n' > "$fixture/source/pnpm-lock.yaml"
printf 'packages: []\n' > "$fixture/source/pnpm-workspace.yaml"
printf '{}\n' > "$fixture/source/tsconfig.json"
printf 'frontend\n' > "$fixture/source/src/app.ts"
printf 'backend\n' > "$fixture/source/server/index.mjs"
printf 'tests\n' > "$fixture/source/tests/app.test.mjs"
printf 'assets\n' > "$fixture/source/public/icon.svg"
printf 'v24.15.0\n' > "$fixture/node-version"
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
    -e "s|/run/lock/$service-install.lock|$fixture/install.lock|g" \
    -e "s|/run/systemd/system|$fixture|g" "$repository/deploy/install.sh" > "$fixture/installer.sh"
cat > "$fixture/runtime/node" <<'NODE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == --version ]]; then cat "$FIXTURE_ROOT/node-version"; exit; fi
if [[ $1 == --input-type=module ]]; then shift; fi
if [[ $1 == -e ]]; then
  [[ ! -f "$FIXTURE_ROOT/fail-import" || ${3:-} != import-check ]] || exit 75
  if [[ -n ${VITE_FIXTURE_VALUE:-} ]]; then printf '[["VITE_FIXTURE_VALUE","%s"]]\n' "$VITE_FIXTURE_VALUE"; else printf '[]\n'; fi
  exit
fi
shift # pnpm path
if [[ $1 == --version ]]; then printf '11.25.0\n'; exit; fi
case "$1 ${2:-}" in
  'install --frozen-lockfile')
    echo install >> "$FIXTURE_ROOT/pnpm.calls"
    mkdir -p node_modules/.bin node_modules/example
    printf 'immutable package\n' > node_modules/example/index.js
    ;;
  'run check')
    echo check >> "$FIXTURE_ROOT/pnpm.calls"
    [[ ! -f "$FIXTURE_ROOT/fail-check" ]] || exit 41
    ;;
  'test ')
    echo test >> "$FIXTURE_ROOT/pnpm.calls"
    [[ -L node_modules/example && -r node_modules/example/index.js ]]
    [[ ! -f "$FIXTURE_ROOT/fail-test" ]] || exit 42
    ;;
  'run build:bundle')
    echo build >> "$FIXTURE_ROOT/pnpm.calls"
    mkdir -p node_modules/.vite-temp dist
    printf 'workspace only\n' > node_modules/.vite-temp/build.mjs
    [[ ! -f "$FIXTURE_ROOT/fail-build" ]] || exit 43
    printf '<html>built</html>\n' > dist/index.html
    ;;
  *) printf 'Unexpected pnpm call: %s\n' "$*" >&2; exit 1 ;;
esac
NODE
chmod +x "$fixture/runtime/node"
cp "$fixture/runtime/node" "$fixture/runtime/pnpm"
cat > "$fixture/run.sh" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$FIXTURE_ROOT/installer.sh"
REPOSITORY="$FIXTURE_ROOT/source"
SERVICE_USER=root
if [[ "${FRESH_INSTALL:-0}" == 1 ]]; then
  APP_DIR="$FIXTURE_ROOT/fresh-application"
  ENV_FILE="$FIXTURE_ROOT/fresh-environment"
  UNIT_FILE="$FIXTURE_ROOT/fresh-unit"
  API_UNIT_FILE="$FIXTURE_ROOT/fresh-api-unit"
  ENTRY_UNIT_FILE="$FIXTURE_ROOT/fresh-entry-unit"
  SLOT_UNIT_FILE="$FIXTURE_ROOT/fresh-slot-unit"
fi
ensure_tools() { :; }
# The mock systemd covers the single API unit; the dual-slot units run under real systemd (test-slots-systemd.sh).
target_layout() { printf single; }
validate_embedded_runtime() { :; }
prepare_greeks_runtime() { :; }
prepare_aster_runtime() { :; }
migrate_embedded_modules() { :; }
migration_settled() { [[ ! -f "$FIXTURE_ROOT/migration-pending" ]]; }
ensure_node() { NODE_BIN="$FIXTURE_ROOT/runtime/node"; }
ensure_pnpm() { [[ "$PROJECT_DEPLOY_MODE" == source ]] || { echo "Unexpected pnpm preparation" >&2; return 92; }; PNPM_BIN="$FIXTURE_ROOT/runtime/pnpm"; }
run_as_service() { "$@"; }
systemctl() {
  printf '%s\n' "$*" >> "$FIXTURE_ROOT/systemctl.calls"
  case "$1" in
    is-active) [[ -f "$FIXTURE_ROOT/running-port" ]] ;;
    restart)
      # fail-api fails the next API restart once.
      if [[ $(read_setting PORT 0) == 4999 || ( $2 == *-api && -f "$FIXTURE_ROOT/fail-api" ) ]]; then
        rm -f "$FIXTURE_ROOT/running-port" "$FIXTURE_ROOT/fail-api"
      else
        read_setting PORT 0 > "$FIXTURE_ROOT/running-port"
        # The runtime runs the release current pointed to when its unit started.
        [[ $2 != "$SERVICE" ]] || printf '%s\n' "$(readlink "$APP_DIR/current")" > "$FIXTURE_ROOT/runtime-cwd-${APP_DIR##*/}"
      fi ;;
    stop) rm -f "$FIXTURE_ROOT/running-port" ;;
    *) return 0 ;;
  esac
}
live_runtime_release() {
  [[ -f "$FIXTURE_ROOT/running-port" && -f "$FIXTURE_ROOT/runtime-cwd-${APP_DIR##*/}" ]] || return 1
  managed_release "$(cat "$FIXTURE_ROOT/runtime-cwd-${APP_DIR##*/}")"
}
curl() {
  local url='' output='' argument
  while (($#)); do
    argument=$1; shift
    case "$argument" in
      -o) output=$1; shift ;;
      --proto|--retry|--connect-timeout|--max-time|--max-filesize) shift ;;
      https://*|http://*) url=$argument ;;
    esac
  done
  if [[ -n "$output" ]]; then
    printf '%s\n' "$url" >> "$FIXTURE_ROOT/download.calls"
    [[ ! -f "$FIXTURE_ROOT/fail-download" ]] || return 22
    case "$url" in
      */latest/download/release-manifest.json) cp "$FIXTURE_ROOT/release-manifest.json" "$output" ;;
      */releases/download/deploy-*/fixture.tar.gz) cp "$FIXTURE_ROOT/package.tar.gz" "$output" ;;
      *) return 23 ;;
    esac
  else
    # Two units answer on /api/ready, one unit on /api/health.
    local expected=/api/health
    [[ ! -f "$API_UNIT_FILE" ]] || expected=/api/ready
    [[ -f "$FIXTURE_ROOT/running-port" && "$url" == "http://127.0.0.1:$(cat "$FIXTURE_ROOT/running-port")$expected" ]]
  fi
}
ci_release_download() {
  mkdir -p -- "$1"
  if [[ -f "$1/$3.tar.gz" && $(sha256sum "$1/$3.tar.gz" | cut -d ' ' -f1) == "$3" ]]; then return; fi
  curl "$2" -o "$1/$3.tar.gz"
}
wait_healthy() { healthy; }
if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then
  git() { echo 'Unexpected server-side git invocation' >&2; return 91; }
fi
main
RUN
run_install() { bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || { cat "$fixture/last.log"; return 1; }; }
count() { grep -c "^$1$" "$fixture/pnpm.calls" || true; }
restarts() { grep -c '^restart ' "$fixture/systemctl.calls" || true; }
releases() { find "$fixture/application/releases" -mindepth 1 -maxdepth 1 -type d | wc -l; }
expect_counts() {
  [[ $(count install) == "$1" && $(count check) == "$2" && $(count test) == "$3" && $(count build) == "$4" && $(restarts) == "$5" ]] || {
    cat "$fixture/pnpm.calls" "$fixture/systemctl.calls" >&2; return 1;
  }
}

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
for name in ('cli.mjs', 'core.mjs', 'feeds.mjs', 'binance-scalper.mjs', 'config.example.json'):
    relative = 'tools/entropy-lighter-lab/' + name
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
archives() { grep -c '/releases/download/' "$fixture/download.calls" || true; }

# First migrate an existing source deployment; its configuration/data survive.
export PROJECT_DEPLOY_MODE=source PROJECT_DEPLOY_TESTS=0
make_package initial
run_install
expect_counts 1 1 0 1 1
legacy=$(readlink "$fixture/application/current")
cp "$fixture/environment" "$fixture/original.env"
printf 'keep this data\n' > "$fixture/data/keep.txt"
export PROJECT_DEPLOY_MODE=ci
run_install
expect_counts 1 1 0 1 2
[[ $(readlink "$fixture/application/current") != "$legacy" && $(archives) == 1 ]]
cmp -s "$fixture/environment" "$fixture/original.env"
[[ $(cat "$fixture/data/keep.txt") == 'keep this data' ]]
first=$(readlink "$fixture/application/current")
run_install
expect_counts 1 1 0 1 2
[[ $(archives) == 1 ]]

# New commit with identical application content does not download or restart.
echo docs > "$fixture/source/README.md"; commit_source docs
make_package initial
run_install
expect_counts 1 1 0 1 2
[[ $(readlink "$fixture/application/current") == "$first" && $(archives) == 1 ]]
PROJECT_DEPLOY_TESTS=1 run_install
expect_counts 1 1 0 1 2

# A new application is downloaded and activated, without pnpm/git/build.
echo changed >> "$fixture/source/server/index.mjs"; commit_source changed
make_package upgraded
run_install
expect_counts 1 1 0 1 3
second=$(readlink "$fixture/application/current")
[[ "$first" != "$second" && $(archives) == 2 ]]

# A broken package is rejected before activation or successful state recording.
echo next >> "$fixture/source/server/index.mjs"; commit_source next
make_package next
cp "$fixture/application/.deployed-state" "$fixture/success-state"
printf corrupt > "$fixture/package.tar.gz"
if run_install; then echo 'Corrupt package accepted' >&2; exit 1; fi
[[ $(readlink "$fixture/application/current") == "$second" ]]
cmp -s "$fixture/application/.deployed-state" "$fixture/success-state"
expect_counts 1 1 0 1 3

# Valid package + failing new port restores previous program/configuration.
make_package next
sed -i 's/^PORT=.*/PORT=4999/' "$fixture/environment"
if run_install; then echo 'Unhealthy activation accepted' >&2; exit 1; fi
[[ $(readlink "$fixture/application/current") == "$second" && $(cat "$fixture/running-port") != 4999 ]]
cmp -s "$fixture/environment" "$fixture/original.env"
cmp -s "$fixture/application/.deployed-state" "$fixture/success-state"

# Retrying the valid candidate reuses its package and succeeds.
run_install
expect_counts 1 1 0 1 6
[[ $(cat "$fixture/data/keep.txt") == 'keep this data' ]]
third=$(readlink "$fixture/application/current")
[[ "$third" != "$second" ]]
run_install
expect_counts 1 1 0 1 6
touch "$fixture/fail-download"
if run_install; then echo 'Missing release silently accepted' >&2; exit 1; fi
[[ $(readlink "$fixture/application/current") == "$third" ]]
rm -- "$fixture/fail-download"
FRESH_INSTALL=1 run_install
expect_counts 1 1 0 1 7
[[ -f "$fixture/fresh-application/current/.install-ready" && -f "$fixture/fresh-environment" ]]
FRESH_INSTALL=1 run_install
expect_counts 1 1 0 1 7

# Design doc 6.2: with the same runtime component only the API restarts, and the
# runtime keeps its release until a full restart.
new_calls() { tail -n "+$((calls + 1))" "$fixture/systemctl.calls"; }
api_only() { new_calls | grep -qx "restart $service-api" && ! new_calls | grep -Eq "^(restart|stop) $service\$"; }
full_restart() { new_calls | grep -qx "restart $service"; }
live() { cat "$fixture/runtime-cwd-application"; }
[[ -f "$fixture/api-unit" && -f "$fixture/application/.runtime-deployment" && $(live) == "$third" ]]
grep -q '^ExecStart=.*/server/runtime/main.mjs$' "$fixture/unit"
grep -q '^ExecStart=.*/server/api/main.mjs$' "$fixture/api-unit"
calls=$(wc -l < "$fixture/systemctl.calls")
echo page >> "$fixture/source/src/app.ts"; commit_source page
make_package page next
run_install
fourth=$(readlink "$fixture/application/current")
[[ "$fourth" != "$third" && $(live) == "$third" ]]
api_only
calls=$(wc -l < "$fixture/systemctl.calls")
echo page >> "$fixture/source/src/app.ts"; commit_source page-two
make_package page-two next
run_install
fifth=$(readlink "$fixture/application/current")
[[ "$fifth" != "$fourth" && -d "$third" && -d "$fourth" ]] # Pruning keeps the runtime's release.
api_only
# A failed API-only activation returns only the API to the earlier release.
calls=$(wc -l < "$fixture/systemctl.calls")
echo page >> "$fixture/source/src/app.ts"; commit_source page-three
make_package page-three next
touch "$fixture/fail-api"
if run_install; then echo 'Unhealthy API accepted' >&2; exit 1; fi
[[ $(readlink "$fixture/application/current") == "$fifth" && $(live) == "$third" ]]
[[ $(new_calls | grep -cx "restart $service-api") == 2 ]]
api_only
# Outstanding module migration and changed runtime code both restart the two units.
calls=$(wc -l < "$fixture/systemctl.calls")
touch "$fixture/migration-pending"
run_install
full_restart
rm "$fixture/migration-pending"
sixth=$(readlink "$fixture/application/current")
[[ $(live) == "$sixth" && -f "$fixture/application/.runtime-deployment" ]]
# A changed environment file restarts both units.
calls=$(wc -l < "$fixture/systemctl.calls")
echo page >> "$fixture/source/src/app.ts"; commit_source page-four
make_package page-four next
printf 'EXTRA_SETTING=1\n' >> "$fixture/environment"
run_install
full_restart
# Design doc 6.5: an update admitted as API-only never widens. Changed runtime
# code is refused before activation with the update service's status.
calls=$(wc -l < "$fixture/systemctl.calls")
before=$(readlink "$fixture/application/current")
cp "$fixture/application/.deployed-state" "$fixture/success-state"
echo changed >> "$fixture/source/server/index.mjs"; commit_source runtime
make_package runtime runtime-two
code=0; PROJECT_DEPLOY_SCOPE=api bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
[[ $code == 75 && $(readlink "$fixture/application/current") == "$before" && $(live) == "$before" ]] || { cat "$fixture/last.log"; exit 1; }
cmp -s "$fixture/application/.deployed-state" "$fixture/success-state"
if new_calls | grep -Eq '^(restart|stop|start|daemon-reload)'; then echo 'Refused api-scope update touched a unit' >&2; exit 1; fi
code=0; PROJECT_DEPLOY_SCOPE=other bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
[[ $code != 0 && $code != 75 && $(readlink "$fixture/application/current") == "$before" ]]
calls=$(wc -l < "$fixture/systemctl.calls")
PROJECT_DEPLOY_SCOPE=full run_install
full_restart
[[ $(live) == "$(readlink "$fixture/application/current")" ]]
# An API-only change admitted as such restarts only the API.
calls=$(wc -l < "$fixture/systemctl.calls")
echo page >> "$fixture/source/src/app.ts"; commit_source page-five
make_package page-five runtime-two
PROJECT_DEPLOY_SCOPE=api run_install
api_only
# Status 75 of any other step is an ordinary failure, never a scope refusal.
before=$(readlink "$fixture/application/current")
echo page >> "$fixture/source/src/app.ts"; commit_source page-six
make_package page-six runtime-two
touch "$fixture/fail-import"
code=0; PROJECT_DEPLOY_SCOPE=api bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
rm "$fixture/fail-import"
[[ $code == 1 && $(readlink "$fixture/application/current") == "$before" ]] || { cat "$fixture/last.log"; exit 1; }
# A failed activation admitted as API-only returns only the API and is no scope refusal.
calls=$(wc -l < "$fixture/systemctl.calls")
runtime_before=$(live)
cp "$fixture/application/.deployed-state" "$fixture/success-state"
cp "$fixture/application/.runtime-deployment" "$fixture/success-runtime"
echo page >> "$fixture/source/src/app.ts"; commit_source page-seven
make_package page-seven runtime-two
touch "$fixture/fail-api"
code=0; PROJECT_DEPLOY_SCOPE=api bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
[[ $code == 1 && $(readlink "$fixture/application/current") == "$before" && $(live) == "$runtime_before" ]] || { cat "$fixture/last.log"; exit 1; }
cmp -s "$fixture/application/.deployed-state" "$fixture/success-state"
cmp -s "$fixture/application/.runtime-deployment" "$fixture/success-runtime"
[[ $(new_calls | grep -cx "restart $service-api") == 2 ]]
api_only
# Design doc 6.9: a prepare run builds and verifies the release, then stops
# before activation; the activation run that follows switches to that release.
calls=$(wc -l < "$fixture/systemctl.calls")
before=$(readlink "$fixture/application/current")
runtime_before=$(live)
cp "$fixture/application/.deployed-state" "$fixture/success-state"
echo prepared >> "$fixture/source/server/index.mjs"; commit_source prepared
make_package prepared runtime-three
code=0; PROJECT_DEPLOY_PHASE=prepare bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
[[ $code == 76 && $(readlink "$fixture/application/current") == "$before" && $(live) == "$runtime_before" ]] || { cat "$fixture/last.log"; exit 1; }
cmp -s "$fixture/application/.deployed-state" "$fixture/success-state"
if new_calls | grep -Eq '^(restart|stop|start|daemon-reload)'; then echo 'A prepare run touched a unit' >&2; exit 1; fi
prepared=$(sed -n 1p "$fixture/application/.prepared-release")
[[ -d "$prepared" && "$prepared" != "$before" && ! -f "$prepared/.install-ready" ]]
code=0; PROJECT_DEPLOY_PHASE=prepare PROJECT_DEPLOY_SCOPE=api bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
[[ $code != 0 && $code != 76 && $(readlink "$fixture/application/current") == "$before" ]]
code=0; PROJECT_DEPLOY_PHASE=activate bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || code=$?
[[ $code != 0 && $code != 76 && $(readlink "$fixture/application/current") == "$before" ]]
run_install
full_restart
[[ $(readlink "$fixture/application/current") == "$prepared" && $(live) == "$prepared" && ! -e "$fixture/application/.prepared-release" ]]
printf 'CI package migration, no-op, content identity, corruption, rollback and activation scope checks passed.\n'
