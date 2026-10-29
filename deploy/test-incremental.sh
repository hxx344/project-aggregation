#!/usr/bin/env bash
# Full installer decision paths with local git and isolated, fake runtimes/services.
set -Eeuo pipefail
export PROJECT_DEPLOY_MODE=source
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
export FIXTURE_ROOT=$fixture
export FIXTURE_REAL_NODE=$(command -v node)
mkdir -p "$fixture/source/src" "$fixture/source/server" "$fixture/source/tests" "$fixture/source/public" "$fixture/source/deploy" "$fixture/source/scripts" "$fixture/runtime"
cp "$repository/deploy/build-artifact-cache.py" "$fixture/source/deploy/build-artifact-cache.py"
cp "$repository/scripts/install-hooks.mjs" "$fixture/source/scripts/install-hooks.mjs"
mkdir -p "$fixture/source/tools/entropy-lighter-lab"
cp "$repository"/tools/entropy-lighter-lab/{cli.mjs,core.mjs,feeds.mjs,binance-scalper.mjs,config.example.json} "$fixture/source/tools/entropy-lighter-lab/"
mkdir -p "$fixture/source/tools/aero-lp"
cp "$repository"/tools/aero-lp/{cli.mjs,core.mjs,chain.mjs,config.example.json} "$fixture/source/tools/aero-lp/"
printf '{"name":"fixture","version":"1.0.0","type":"module","scripts":{"prepare":"node scripts/install-hooks.mjs"}}\n' > "$fixture/source/package.json"
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
commit_source() {
  git -C "$fixture/source" add .
  git -C "$fixture/source" commit -qm "$1"
  git -C "$fixture/source" rev-parse HEAD > "$fixture/stable-commit"
}
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
if [[ $1 == -e ]]; then
  if [[ -n ${VITE_FIXTURE_VALUE:-} ]]; then printf '[["VITE_FIXTURE_VALUE","%s"]]\n' "$VITE_FIXTURE_VALUE"; else printf '[]\n'; fi
  exit
fi
shift # pnpm path
if [[ $1 == --version ]]; then printf '11.25.0\n'; exit; fi
case "$1 ${2:-}" in
  'install --frozen-lockfile')
    echo install >> "$FIXTURE_ROOT/pnpm.calls"
    "$FIXTURE_REAL_NODE" scripts/install-hooks.mjs
    mkdir -p node_modules/.bin node_modules/example
    printf 'immutable package\n' > node_modules/example/index.js
    for importer in modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
      if [[ -f "$importer/package.json" ]]; then mkdir -p "$importer/node_modules"; fi
    done
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
  'run prepare')
    [[ "$PWD" == */modules/asset ]] || { echo 'Prepare ran outside Asset' >&2; exit 46; }
    printf 'asset\n' >> "$FIXTURE_ROOT/module-prepare.calls"
    mkdir -p lib
    printf 'prepared asset input\n' > lib/imported-ledger.json
    ;;
  'run build')
    case "$PWD" in
      */modules/monitor) module=monitor; artifact=dist; entry=client/index.html ;;
      */modules/asset) module=asset; artifact=.next; entry=BUILD_ID
        [[ -f lib/imported-ledger.json ]] || { echo 'Asset build omitted prepare' >&2; exit 47; } ;;
      */modules/crossex) module=crossex; artifact=dist; entry=index.html ;;
      */modules/aster/dashboard) module=aster; artifact=dist; entry=client/index.html ;;
      *) echo "Module build used the wrong working directory: $PWD" >&2; exit 45 ;;
    esac
    printf '%s\n' "$module" >> "$FIXTURE_ROOT/module.calls"
    printf '%s\n' "${PWD%/modules/*}" >> "$FIXTURE_ROOT/module-workspaces"
    [[ ! -f "$FIXTURE_ROOT/fail-module-$module" ]] || exit 44
    mkdir -p "$artifact/$(dirname "$entry")" "$artifact/assets"
    printf '%s entry\n' "$module" > "$artifact/$entry"
    printf '%s chunk\n' "$module" > "$artifact/assets/chunk.js"
    if [[ $module == monitor ]]; then printf '{}\n' > "$artifact/build-manifest.json"; fi
    ;;
  *) printf 'Unexpected pnpm call: %s\n' "$*" >&2; exit 1 ;;
esac
NODE
chmod +x "$fixture/runtime/node"
cp "$fixture/runtime/node" "$fixture/runtime/pnpm"
# Exercise the real pinned-manager bootstrap with a local archive, including
# cache reuse and corruption rejection before any downloaded code is evaluated.
mkdir -p "$fixture/pnpm-package/package/bin"
printf 'fixture package manager\n' > "$fixture/pnpm-package/package/bin/pnpm.mjs"
tar -czf "$fixture/pnpm-package.tgz" -C "$fixture/pnpm-package" package
python3 - "$fixture/pnpm-package.tgz" > "$fixture/pnpm-integrity" <<'INTEGRITY'
import base64, hashlib, sys
from pathlib import Path
print(base64.b64encode(hashlib.sha512(Path(sys.argv[1]).read_bytes()).digest()).decode())
INTEGRITY
cat > "$fixture/bootstrap.sh" <<'BOOTSTRAP'
#!/usr/bin/env bash
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$FIXTURE_ROOT/installer.sh"
APP_DIR="$FIXTURE_ROOT/${BOOTSTRAP_APP:-pnpm-bootstrap}"
work_dir="$APP_DIR/work"
NODE_BIN="$FIXTURE_ROOT/runtime/node"
PNPM_INTEGRITY=$(cat "$FIXTURE_ROOT/pnpm-integrity")
mkdir -p "$work_dir"
curl() { echo download >> "$FIXTURE_ROOT/bootstrap.calls"; cp "$FIXTURE_ROOT/pnpm-package.tgz" "${@: -1}"; }
ensure_pnpm
ensure_pnpm
[[ -L "$APP_DIR/runtime/pnpm-$PNPM_VERSION/bin/pnpm" ]]
BOOTSTRAP
bash "$fixture/bootstrap.sh"
[[ $(grep -c '^download$' "$fixture/bootstrap.calls") == 1 ]]
printf corrupt >> "$fixture/pnpm-package.tgz"
if BOOTSTRAP_APP=pnpm-corrupt bash "$fixture/bootstrap.sh" > "$fixture/bootstrap-error.log" 2>&1; then
  echo 'Corrupted pnpm archive was accepted' >&2; exit 1
fi
grep -q 'pnpm package integrity mismatch' "$fixture/bootstrap-error.log"
[[ ! -e "$fixture/pnpm-corrupt/runtime" ]]
cat > "$fixture/run.sh" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$FIXTURE_ROOT/installer.sh"
REPOSITORY="$FIXTURE_ROOT/source"
SERVICE_USER=root
ensure_tools() { :; }
# The mock systemd covers the single API unit; the dual-slot units run under real systemd (test-slots-systemd.sh).
target_layout() { printf single; }
validate_embedded_runtime() { :; }
prepare_greeks_runtime() { :; }
prepare_aster_runtime() { :; }
migrate_embedded_modules() { :; }
ensure_node() { NODE_BIN="$FIXTURE_ROOT/runtime/node"; }
ensure_pnpm() { [[ "$PROJECT_DEPLOY_MODE" == source ]] || { echo "Unexpected pnpm preparation" >&2; return 92; }; PNPM_BIN="$FIXTURE_ROOT/runtime/pnpm"; }
run_as_service() { "$@"; }
ci_release_resolve() {
  [[ ! -f "$FIXTURE_ROOT/fail-release" ]] || return 70
  CI_RELEASE_COMMIT=$(cat "$FIXTURE_ROOT/stable-commit")
  CI_RELEASE_NODE_VERSION=$NODE_VERSION
  printf '%s\n' "$CI_RELEASE_COMMIT" > "$FIXTURE_ROOT/selected-commit"
  if [[ -f "$FIXTURE_ROOT/advance-main-on-resolve" ]]; then
    printf 'main moved after release selection\n' >> "$FIXTURE_ROOT/source/src/app.ts"
    command git -C "$FIXTURE_ROOT/source" add src/app.ts
    command git -C "$FIXTURE_ROOT/source" commit -qm moving-main
    rm "$FIXTURE_ROOT/advance-main-on-resolve"
  fi
}
git() {
  [[ "$1" != ls-remote ]] || { echo 'Source deployment must not resolve a branch' >&2; return 91; }
  local argument
  for argument in "$@"; do
    if [[ "$argument" == fetch && -f "$FIXTURE_ROOT/fail-fetch" ]]; then
      printf 'fetch\n' >> "$FIXTURE_ROOT/failed-fetch.calls"
      printf 'error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF\n' >&2
      return 128
    fi
  done
  command git "$@"
}
systemctl() {
  printf '%s\n' "$*" >> "$FIXTURE_ROOT/systemctl.calls"
  case "$1" in
    is-active) [[ -f "$FIXTURE_ROOT/running-port" ]] ;;
    restart)
      if [[ $(read_setting PORT 0) == 4999 ]]; then rm -f "$FIXTURE_ROOT/running-port"
      else
        read_setting PORT 0 > "$FIXTURE_ROOT/running-port"
        [[ $2 != "$SERVICE" ]] || readlink "$APP_DIR/current" > "$FIXTURE_ROOT/runtime-cwd"
      fi ;;
    stop) rm -f "$FIXTURE_ROOT/running-port" ;;
    *) return 0 ;;
  esac
}
live_runtime_release() {
  [[ -f "$FIXTURE_ROOT/running-port" && -f "$FIXTURE_ROOT/runtime-cwd" ]] || return 1
  managed_release "$(cat "$FIXTURE_ROOT/runtime-cwd")"
}
# Scoped activation stays off (every activation restarts both units) until the
# last scenario creates scope-enabled.
migration_settled() { [[ -f "$FIXTURE_ROOT/scope-enabled" ]]; }
# Two units answer on /api/ready, one unit on /api/health.
curl() { [[ -f "$FIXTURE_ROOT/running-port" && "${@: -1}" == "http://127.0.0.1:$(cat "$FIXTURE_ROOT/running-port")/api/$([[ -f "$API_UNIT_FILE" ]] && echo ready || echo health)" ]]; }
wait_healthy() { healthy; }
ci_update_progress() { printf '%s\n' "$1" >> "$FIXTURE_ROOT/progress.calls"; }
ci_finish_progress() { printf 'closed\n' >> "$FIXTURE_ROOT/timings.calls"; }
main
RUN
run_install() {
  local status=0
  : > "$fixture/progress.calls"
  : > "$fixture/timings.calls"
  bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || status=$?
  printf '%s\n' "$status" > "$fixture/last-exit"
  if (( status != 0 )); then cat "$fixture/last.log"; return "$status"; fi
  # Covers normal installation and both no-op returns through the real EXIT trap.
  [[ $(cat "$fixture/timings.calls") == closed ]]
}
count() { grep -c "^$1$" "$fixture/pnpm.calls" || true; }
restarts() { grep -c '^restart ' "$fixture/systemctl.calls" || true; }
releases() { find "$fixture/application/releases" -mindepth 1 -maxdepth 1 -type d | wc -l; }
expect_counts() {
  [[ $(count install) == "$1" && $(count check) == "$2" && $(count test) == "$3" && $(count build) == "$4" && $(restarts) == "$5" ]] || {
    cat "$fixture/pnpm.calls" "$fixture/systemctl.calls" >&2; return 1;
  }
}
# The module fixture reuses this isolated installer harness, then adds its own sources and assertions.
if [[ ${INCREMENTAL_SETUP_ONLY:-0} == 1 ]]; then return 0; fi

# Default deployment builds and starts without running tests or inventing a
# successful test stamp. Explicit validation of the same commit must still run.
unset PROJECT_DEPLOY_TESTS
stable=$(cat "$fixture/stable-commit")
printf 'unpublished frontend\n' >> "$fixture/source/src/app.ts"
git -C "$fixture/source" add src/app.ts
git -C "$fixture/source" commit -qm unpublished-main
touch "$fixture/advance-main-on-resolve"
run_install
expect_counts 1 1 0 1 1
for stage in preflight download extract prepare verify build switch finalize; do
  grep -qx "$stage" "$fixture/progress.calls"
done
[[ $(tail -n1 "$fixture/progress.calls") == finalize ]]
[[ -z $(find "$fixture/application/cache" -maxdepth 1 -name 'tested-*' -print -quit) ]]
initial=$(readlink "$fixture/application/current")
[[ $(cat "$initial/.source-sha") == "$stable" && $(cat "$fixture/selected-commit") == "$stable" ]]
[[ $(git -C "$fixture/source" rev-parse HEAD) != "$stable" ]]
# Keep the later incremental scenarios on the original source tree without publishing the branch-only commits.
git -C "$fixture/source" restore --source="$stable" src/app.ts
git -C "$fixture/source" commit -qam restore-unpublished-frontend
touch "$fixture/fail-release"
cp "$fixture/application/.deployed-state" "$fixture/success-state"
if run_install; then echo 'Missing stable release fell back to main' >&2; exit 1; fi
[[ $(cat "$fixture/last-exit") == 70 ]]
[[ $(cat "$fixture/timings.calls") == closed ]] # rollback closes before cleanup and never counts recovery time
expect_counts 1 1 0 1 1
[[ $(readlink "$fixture/application/current") == "$initial" ]]
cmp "$fixture/success-state" "$fixture/application/.deployed-state"
rm "$fixture/fail-release"
run_install
expect_counts 1 1 0 1 1
[[ $(cat "$fixture/progress.calls") == $'preflight\nfinalize' ]]
if PROJECT_DEPLOY_TESTS=invalid run_install; then echo 'Invalid test mode accepted' >&2; exit 1; fi
expect_counts 1 1 0 1 1
export PROJECT_DEPLOY_TESTS=1
run_install
expect_counts 1 1 1 1 1
[[ $(readlink "$fixture/application/current") == "$initial" && $(releases) == 1 ]]
initial_sha=$(cat "$initial/.source-sha")
run_install
expect_counts 1 1 1 1 1
echo docs > "$fixture/source/README.md"; commit_source docs
run_install
expect_counts 1 1 1 1 1
[[ $(readlink "$fixture/application/current") == "$initial" && $(cat "$initial/.source-sha") == "$initial_sha" ]]
echo extra >> "$fixture/source/tests/app.test.mjs"; commit_source tests
run_install
expect_counts 1 1 2 1 1
[[ $(releases) == 1 && $(readlink "$fixture/application/current") == "$initial" ]]
echo extra >> "$fixture/source/server/index.mjs"; commit_source backend
# Exhausted source retries must stop before dependencies, tests, builds or activation.
touch "$fixture/fail-fetch"
cp "$fixture/application/.deployed-state" "$fixture/success-state"
if run_install; then echo 'Failed source fetch was accepted' >&2; exit 1; fi
[[ $(wc -l < "$fixture/failed-fetch.calls") == 3 ]]
expect_counts 1 1 2 1 1
[[ $(readlink "$fixture/application/current") == "$initial" && $(releases) == 1 ]]
cmp "$fixture/success-state" "$fixture/application/.deployed-state"
! grep -Eq '^(prepare|verify|build|switch|finalize)$' "$fixture/progress.calls"
rm "$fixture/fail-fetch"
# Retrying the same install reuses dependencies and frontend build results.
run_install
expect_counts 1 1 3 1 2
[[ $(releases) == 2 && $(readlink "$fixture/application/current") != "$initial" ]]
echo extra >> "$fixture/source/src/app.ts"; commit_source frontend
run_install
expect_counts 1 2 4 2 3
current=$(readlink "$fixture/application/current")
sed -i 's/^PORT=.*/PORT=4100/' "$fixture/environment"
run_install
expect_counts 1 2 4 2 4
[[ $(readlink "$fixture/application/current") == "$current" && $(releases) == 2 ]]
# Failed test: no new release or cache success, then only that test is retried.
echo failed >> "$fixture/source/tests/app.test.mjs"; commit_source fail-test
touch "$fixture/fail-test"
verified_before=$(find "$fixture/application/cache" -maxdepth 1 -name 'tested-*' | wc -l)
PROJECT_DEPLOY_TESTS=0 run_install
expect_counts 1 2 4 2 4
[[ $(find "$fixture/application/cache" -maxdepth 1 -name 'tested-*' | wc -l) == "$verified_before" ]]
[[ $(readlink "$fixture/application/current") == "$current" ]]
if run_install; then echo 'Failed test was accepted' >&2; exit 1; fi
[[ $(cat "$fixture/last-exit") == 42 ]]
expect_counts 1 2 5 2 4
[[ $(find "$fixture/application/cache" -maxdepth 1 -name 'tested-*' | wc -l) == "$verified_before" ]]
[[ $(readlink "$fixture/application/current") == "$current" && $(releases) == 2 ]]
rm "$fixture/fail-test"
run_install
expect_counts 1 2 6 2 4
# Failed build keeps successful validation stamps and the previous running release.
echo failed >> "$fixture/source/src/app.ts"; commit_source fail-build
touch "$fixture/fail-build"
if run_install; then echo 'Failed build was accepted' >&2; exit 1; fi
[[ $(cat "$fixture/last-exit") == 43 ]]
[[ $(tail -n1 "$fixture/progress.calls") == build ]]
! grep -Eq '^(switch|finalize)$' "$fixture/progress.calls"
expect_counts 1 3 7 3 4
[[ $(readlink "$fixture/application/current") == "$current" ]]
rm "$fixture/fail-build"
run_install
expect_counts 1 3 7 4 5
current=$(readlink "$fixture/application/current")
# Config failure restores the prior port without rebuilding or replacing the release.
sed -i 's/^PORT=.*/PORT=4999/' "$fixture/environment"
if run_install; then echo 'Failed health was accepted' >&2; exit 1; fi
expect_counts 1 3 7 4 7
grep -q '^PORT=4100$' "$fixture/environment"
[[ $(readlink "$fixture/application/current") == "$current" ]]
run_install
expect_counts 1 3 7 4 7
printf 'v24.16.0\n' > "$fixture/node-version"
run_install
expect_counts 2 4 8 5 8
# Dependency changes invalidate all dependent results.
echo ' ' >> "$fixture/source/pnpm-lock.yaml"; commit_source dependencies
run_install
expect_counts 3 5 9 6 9
# Actual git path inputs: compiler config affects validation/build; Vite env only assets.
echo ' ' >> "$fixture/source/tsconfig.json"; commit_source compiler-config
run_install
expect_counts 3 6 10 7 10
printf 'VITE_FIXTURE_FILE=changed\n' > "$fixture/source/.env.production"; commit_source vite-file
run_install
expect_counts 3 6 10 8 11
# Build environment invalidates assets, not dependencies or source verification.
VITE_FIXTURE_VALUE=new run_install
expect_counts 3 6 10 9 12
# A failed lifecycle script cannot publish a dependency cache or switch services.
current=$(readlink "$fixture/application/current")
cp "$fixture/application/.deployed-state" "$fixture/before-prepare-state"
dependency_caches=$(find "$fixture/application/cache" -maxdepth 1 -type d -name 'dependencies-*' | wc -l)
active_dependency_cache=$(find "$fixture/application/cache" -maxdepth 1 -type d -name 'dependencies-*')
# Earlier successful activations pruned every dependency cache except the active one.
[[ "$dependency_caches" == 1 ]]
printf '\nthrow new Error("fixture prepare failure");\n' >> "$fixture/source/scripts/install-hooks.mjs"
commit_source fail-prepare
if run_install; then echo 'Failed prepare was accepted' >&2; exit 1; fi
[[ $(cat "$fixture/last-exit") == 1 ]]
grep -q 'fixture prepare failure' "$fixture/last.log"
! grep -Eq '^(switch|finalize)$' "$fixture/progress.calls"
expect_counts 4 6 10 9 12
[[ $(readlink "$fixture/application/current") == "$current" ]]
cmp -s "$fixture/before-prepare-state" "$fixture/application/.deployed-state"
[[ $(find "$fixture/application/cache" -maxdepth 1 -type d -name 'dependencies-*' | wc -l) == "$dependency_caches" ]]
[[ -z $(find "$fixture/application" -path '*/dependencies/.complete' -print -quit) ]]
cp "$repository/scripts/install-hooks.mjs" "$fixture/source/scripts/install-hooks.mjs"
printf '\n// Repaired prepare input.\n' >> "$fixture/source/scripts/install-hooks.mjs"
commit_source repair-prepare
run_install
expect_counts 5 7 11 10 13
# The repaired install publishes a new cache, then prunes the superseded one.
repaired_dependency_cache=$(find "$fixture/application/cache" -maxdepth 1 -type d -name 'dependencies-*')
[[ $(wc -l <<< "$repaired_dependency_cache") == 1 && "$repaired_dependency_cache" != "$active_dependency_cache" ]]
run_install
expect_counts 5 7 11 10 13
# Source mode, design doc 6.2: a frontend change restarts only the API; a
# change to code the runtime unit runs restarts both units.
touch "$fixture/scope-enabled"
calls=$(wc -l < "$fixture/systemctl.calls")
new_calls() { tail -n "+$((calls + 1))" "$fixture/systemctl.calls"; }
runtime_release=$(cat "$fixture/runtime-cwd")
echo scoped >> "$fixture/source/src/app.ts"; commit_source scoped-frontend
run_install
new_calls | grep -qx "restart $service-api"
if new_calls | grep -Eq "^(restart|stop) $service\$"; then echo 'Frontend change restarted the runtime unit' >&2; exit 1; fi
[[ $(readlink "$fixture/application/current") != "$runtime_release" && $(cat "$fixture/runtime-cwd") == "$runtime_release" ]]
calls=$(wc -l < "$fixture/systemctl.calls")
echo scoped >> "$fixture/source/server/index.mjs"; commit_source scoped-runtime
run_install
new_calls | grep -qx "restart $service"
[[ $(cat "$fixture/runtime-cwd") == "$(readlink "$fixture/application/current")" ]]
calls=$(wc -l < "$fixture/systemctl.calls")
tool_inputs_before="$(count install) $(count check) $(count build)"
echo '// research runtime update' >> "$fixture/source/tools/entropy-lighter-lab/core.mjs"; commit_source research-runtime
run_install
new_calls | grep -qx "restart $service"
[[ $(cat "$fixture/runtime-cwd") == "$(readlink "$fixture/application/current")" ]]
[[ "$(count install) $(count check) $(count build)" == "$tool_inputs_before" ]]
cmp -s "$fixture/source/tools/entropy-lighter-lab/core.mjs" "$fixture/application/current/tools/entropy-lighter-lab/core.mjs"
printf 'Incremental installer paths passed (docs/tests/backend/frontend/config, failures and environment).\n'
