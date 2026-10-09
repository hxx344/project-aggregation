#!/usr/bin/env bash
# Full installer decision paths with local git and isolated, fake runtimes/services.
set -Eeuo pipefail
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
if [[ "${FRESH_INSTALL:-0}" == 1 ]]; then
  APP_DIR="$FIXTURE_ROOT/fresh-application"
  ENV_FILE="$FIXTURE_ROOT/fresh-environment"
  UNIT_FILE="$FIXTURE_ROOT/fresh-unit"
fi
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
    [[ -f "$FIXTURE_ROOT/running-port" && "$url" == "http://127.0.0.1:$(cat "$FIXTURE_ROOT/running-port")/api/health" ]]
  fi
}
wait_healthy() { healthy; }
if [[ "$PROJECT_DEPLOY_MODE" == ci ]]; then
  git() { echo 'Unexpected server-side git invocation' >&2; return 91; }
fi
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

make_package() {
  python3 - "$fixture" "$service" "$1" <<'PACKAGE'
import hashlib, io, json, subprocess, sys, tarfile
from pathlib import Path
root = Path(sys.argv[1])
commit = subprocess.check_output(['git', '-C', str(root / 'source'), 'rev-parse', 'HEAD'], text=True).strip()
key = hashlib.sha256(sys.argv[3].encode()).hexdigest()
contents = {'.release-commit': commit, '.release-application-key': key,
            'server/app.mjs': 'export {};', 'server/index.mjs': 'export {};',
            'package.json': '{"type":"module"}', 'dist/index.html': '<html>' + sys.argv[3] + '</html>',
            'node_modules/ws/package.json': '{}', 'node_modules/decimal.js/package.json': '{}'}
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
run_install
expect_counts 1 1 0 1 1
legacy=$(readlink "$fixture/application/current")
cp "$fixture/environment" "$fixture/original.env"
printf 'keep this data\n' > "$fixture/data/keep.txt"
make_package initial
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

# A new application is downloaded and activated, without npm/git/build.
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
printf 'CI package migration, no-op, content identity, corruption and rollback checks passed.\n'
