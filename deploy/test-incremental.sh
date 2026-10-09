#!/usr/bin/env bash
# Full installer decision paths with local git and isolated, fake runtimes/services.
set -Eeuo pipefail
export PROJECT_DEPLOY_MODE=source
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
export FIXTURE_ROOT=$fixture
mkdir -p "$fixture/source/src" "$fixture/source/server" "$fixture/source/tests" "$fixture/source/public" "$fixture/runtime"
printf '{"name":"fixture","version":"1.0.0","type":"module"}\n' > "$fixture/source/package.json"
printf '{}\n' > "$fixture/source/package-lock.json"
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
service=$(sed -n 's/^SERVICE=//p' "$repository/install.sh")
sed -e "s|/opt/$service|$fixture/application|g" \
    -e "s|/var/lib/$service|$fixture/data|g" \
    -e "s|/etc/$service.env|$fixture/environment|g" \
    -e "s|/etc/systemd/system/$service.service|$fixture/unit|g" \
    -e "s|/run/lock/$service-install.lock|$fixture/install.lock|g" \
    -e "s|/run/systemd/system|$fixture|g" "$repository/install.sh" > "$fixture/installer.sh"
cat > "$fixture/runtime/node" <<'NODE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == --version ]]; then cat "$FIXTURE_ROOT/node-version"; exit; fi
if [[ $1 == -e ]]; then
  if [[ -n ${VITE_FIXTURE_VALUE:-} ]]; then printf '[["VITE_FIXTURE_VALUE","%s"]]\n' "$VITE_FIXTURE_VALUE"; else printf '[]\n'; fi
  exit
fi
shift # npm path
if [[ $1 == --version ]]; then printf '11.0.0\n'; exit; fi
case "$1 ${2:-}" in
  'ci '*)
    echo ci >> "$FIXTURE_ROOT/npm.calls"
    mkdir -p node_modules/.bin node_modules/example
    printf 'immutable package\n' > node_modules/example/index.js
    ;;
  'run check')
    echo check >> "$FIXTURE_ROOT/npm.calls"
    [[ ! -f "$FIXTURE_ROOT/fail-check" ]] || exit 41
    ;;
  'test ')
    echo test >> "$FIXTURE_ROOT/npm.calls"
    [[ -L node_modules/example && -r node_modules/example/index.js ]]
    [[ ! -f "$FIXTURE_ROOT/fail-test" ]] || exit 42
    ;;
  'run build:bundle')
    echo build >> "$FIXTURE_ROOT/npm.calls"
    mkdir -p node_modules/.vite-temp dist
    printf 'workspace only\n' > node_modules/.vite-temp/build.mjs
    [[ ! -f "$FIXTURE_ROOT/fail-build" ]] || exit 43
    printf '<html>built</html>\n' > dist/index.html
    ;;
  *) printf 'Unexpected npm call: %s\n' "$*" >&2; exit 1 ;;
esac
NODE
chmod +x "$fixture/runtime/node"
cp "$fixture/runtime/node" "$fixture/runtime/npm"
cat > "$fixture/run.sh" <<'RUN'
#!/usr/bin/env bash
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$FIXTURE_ROOT/installer.sh"
REPOSITORY="$FIXTURE_ROOT/source"
SERVICE_USER=root
ensure_tools() { :; }
ensure_node() { NODE_BIN="$FIXTURE_ROOT/runtime/node"; }
run_as_service() { "$@"; }
systemctl() {
  printf '%s\n' "$*" >> "$FIXTURE_ROOT/systemctl.calls"
  case "$1" in
    is-active) [[ -f "$FIXTURE_ROOT/running-port" ]] ;;
    restart)
      if [[ $(read_setting PORT 0) == 4999 ]]; then rm -f "$FIXTURE_ROOT/running-port"
      else read_setting PORT 0 > "$FIXTURE_ROOT/running-port"; fi ;;
    stop) rm -f "$FIXTURE_ROOT/running-port" ;;
    *) return 0 ;;
  esac
}
curl() { [[ -f "$FIXTURE_ROOT/running-port" && "${@: -1}" == "http://127.0.0.1:$(cat "$FIXTURE_ROOT/running-port")/api/health" ]]; }
wait_healthy() { healthy; }
main
RUN
run_install() { bash "$fixture/run.sh" > "$fixture/last.log" 2>&1 || { cat "$fixture/last.log"; return 1; }; }
count() { grep -c "^$1$" "$fixture/npm.calls" || true; }
restarts() { grep -c '^restart ' "$fixture/systemctl.calls" || true; }
releases() { find "$fixture/application/releases" -mindepth 1 -maxdepth 1 -type d | wc -l; }
expect_counts() {
  [[ $(count ci) == "$1" && $(count check) == "$2" && $(count test) == "$3" && $(count build) == "$4" && $(restarts) == "$5" ]] || {
    cat "$fixture/npm.calls" "$fixture/systemctl.calls" >&2; return 1;
  }
}
# Default deployment builds and starts without running tests or inventing a
# successful test stamp. Explicit validation of the same commit must still run.
unset PROJECT_DEPLOY_TESTS
run_install
expect_counts 1 1 0 1 1
[[ -z $(find "$fixture/application/cache" -maxdepth 1 -name 'tested-*' -print -quit) ]]
initial=$(readlink "$fixture/application/current")
run_install
expect_counts 1 1 0 1 1
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
echo ' ' >> "$fixture/source/package-lock.json"; commit_source dependencies
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
printf 'Incremental installer paths passed (docs/tests/backend/frontend/config, failures and environment).\n'
