#!/usr/bin/env bash
# Complete source installs with real Git/cache helpers and the shared isolated service/runtime fixture.
set -Eeuo pipefail
INCREMENTAL_SETUP_ONLY=1 source "$(dirname "$0")/test-incremental.sh"
unset PROJECT_DEPLOY_TESTS

for module in monitor asset crossex aster; do
  importer="modules/$module"
  [[ "$module" != aster ]] || importer+=/dashboard
  mkdir -p "$fixture/source/$importer"
  printf '{"name":"fixture-%s","version":"1.0.0"}\n' "$module" > "$fixture/source/$importer/package.json"
  printf '%s source\n' "$module" > "$fixture/source/$importer/input.txt"
done
mkdir -p "$fixture/source/modules/greeks" "$fixture/source/modules/aster/trading" "$fixture/source/scripts"
printf 'greeks runtime\n' > "$fixture/source/modules/greeks/runtime.py"
printf 'greeks requirements\n' > "$fixture/source/modules/greeks/requirements.lock"
printf 'aster runtime\n' > "$fixture/source/modules/aster/trading/runtime.py"
printf 'aster requirements\n' > "$fixture/source/modules/aster/requirements.lock"
printf 'fixture build dispatch\n' > "$fixture/source/scripts/modules.mjs"
printf 'fixture migration\n' > "$fixture/source/deploy/migrate-modules.py"
printf 'fixture runtime lock\n' > "$fixture/source/deploy/pnpm-runtime-lock.mjs"
# Package only the fixture's already-built outputs; no real dependencies, service or strategy is executed.
cat > "$fixture/source/deploy/package-release.py" <<'PACKAGE'
import argparse
import os
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--stage-only', type=Path, required=True)
parser.add_argument('--embedded-only', action='store_true')
parser.add_argument('--dependencies-only', action='store_true')
args, _ = parser.parse_known_args()
assert args.embedded_only != args.dependencies_only
if args.dependencies_only:
    for importer in ('.', 'modules/monitor', 'modules/asset', 'modules/crossex'):
        (args.stage_only / importer / 'node_modules').mkdir(parents=True)
    (args.stage_only / 'node_modules/runtime.txt').write_text('production dependency')
    with (Path(os.environ['FIXTURE_ROOT']) / 'runtime-dependencies.calls').open('a') as calls:
        calls.write('materialize\n')
else:
    assert not (args.source / 'dist').exists(), 'embedded assembly restored unused hub output'
    shutil.copytree(args.source / 'modules', args.stage_only / 'modules', ignore=shutil.ignore_patterns('node_modules'))
    shutil.copytree(args.source / 'deploy', args.stage_only / 'deploy')
PACKAGE
commit_source modules

# Observe the actual installer entry points while keeping the shared fixture
# unchanged. Test execution must receive every module's cached build output.
python3 - "$fixture/run.sh" <<'INSTRUMENT'
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
assert source.count('\nmain\n') == 1
instrument = r'''
eval "$(declare -f prepare_workspace | sed '1s/prepare_workspace/fixture_prepare_workspace/')"
prepare_workspace() {
  [[ ! -f "$FIXTURE_ROOT/forbid-workspace" ]] || { echo 'Unexpected build workspace preparation' >&2; return 94; }
  printf 'workspace\n' >> "$FIXTURE_ROOT/workspace.calls"
  fixture_prepare_workspace
}
eval "$(declare -f prepare_module_builds | sed '1s/prepare_module_builds/fixture_prepare_module_builds/')"
prepare_module_builds() {
  if [[ -f "$FIXTURE_ROOT/check-cache-promotion" && ${1:-hydrate} == hydrate ]]; then
    fixture_prepare_module_builds cache-only
  fi
  fixture_prepare_module_builds "$@"
}
run_as_service() {
  if [[ ${@: -1} == test ]]; then
    for output in modules/monitor/dist/client/index.html modules/asset/.next/BUILD_ID \
        modules/crossex/dist/index.html modules/aster/dashboard/dist/client/index.html; do
      [[ -s "$output" ]] || { echo "Test workspace is missing $output" >&2; return 95; }
    done
    printf 'hydrated\n' >> "$FIXTURE_ROOT/hydrated-test.calls"
  fi
  "$@"
}
'''
path.write_text(source.replace('\nmain\n', '\n' + instrument + '\nmain\n'))
INSTRUMENT

module_count() { grep -c "^$1$" "$fixture/module.calls" || true; }
expect_modules() {
  [[ $(module_count monitor) == "$1" && $(module_count asset) == "$2" &&
     $(module_count crossex) == "$3" && $(module_count aster) == "$4" ]] || {
    cat "$fixture/module.calls" >&2; return 1;
  }
}
stops() { grep -c '^stop ' "$fixture/systemctl.calls" || true; }
aster_caches() { find "$fixture/application/cache" -mindepth 1 -maxdepth 1 -type d -name 'module-aster-*' | wc -l; }

run_install
expect_counts 1 1 0 1 1
expect_modules 1 1 1 1
[[ $(wc -l < "$fixture/runtime-dependencies.calls") == 1 ]]
first_workspace=$(head -n 1 "$fixture/module-workspaces")
[[ ! -e "$first_workspace" ]]

# The frontend changes in a fresh workspace; every module reuses its published runtime/cache.
printf 'changed frontend\n' >> "$fixture/source/src/app.ts"
commit_source frontend
run_install
expect_counts 1 2 0 2 2
expect_modules 1 1 1 1

# A module change repackages the runtime with only that module rebuilt across install directories.
printf 'changed crossex\n' >> "$fixture/source/modules/crossex/input.txt"
commit_source crossex
run_install
expect_counts 1 2 0 2 3
expect_modules 1 1 2 1
[[ $(tail -n 1 "$fixture/module-workspaces") != "$first_workspace" ]]

# Corruption outside an entry file is detected when another runtime update consumes the cache.
monitor_cache=$(find "$fixture/application/cache" -mindepth 1 -maxdepth 1 -type d -name 'module-monitor-*')
[[ -d "$monitor_cache" && -s "$monitor_cache/artifact/client/index.html" ]]
printf 'corruption\n' >> "$monitor_cache/artifact/assets/chunk.js"
printf 'changed runtime\n' >> "$fixture/source/modules/greeks/runtime.py"
commit_source python-runtime
current=$(readlink "$fixture/application/current")
saved_stops=$(stops)
cp "$fixture/application/.deployed-state" "$fixture/success-state"
touch "$fixture/fail-module-monitor"
if run_install; then echo 'Damaged cache with a failed rebuild was accepted' >&2; exit 1; fi
[[ $(stops) == "$saved_stops" && $(readlink "$fixture/application/current") == "$current" ]]
cmp "$fixture/success-state" "$fixture/application/.deployed-state"
rm "$fixture/fail-module-monitor"
run_install
expect_counts 1 2 0 2 4
expect_modules 3 1 2 1
[[ $(cat "$fixture/application/current/modules/monitor/dist/assets/chunk.js") == 'monitor chunk' ]]

# A failed build publishes no cache for that input and cannot reach service activation.
current=$(readlink "$fixture/application/current")
cp "$fixture/application/.deployed-state" "$fixture/success-state"
saved_caches=$(aster_caches)
saved_aster_cache=$(find "$fixture/application/cache" -mindepth 1 -maxdepth 1 -type d -name 'module-aster-*')
saved_stops=$(stops)
printf 'changed aster\n' >> "$fixture/source/modules/aster/dashboard/input.txt"
commit_source aster
touch "$fixture/fail-module-aster"
if run_install; then echo 'Failed module build was accepted' >&2; exit 1; fi
expect_counts 1 2 0 2 4
expect_modules 3 1 2 2
[[ $(aster_caches) == "$saved_caches" && $(stops) == "$saved_stops" ]]
[[ $(readlink "$fixture/application/current") == "$current" && -f "$fixture/running-port" ]]
cmp "$fixture/success-state" "$fixture/application/.deployed-state"
rm "$fixture/fail-module-aster"
run_install
expect_counts 1 2 0 2 5
expect_modules 3 1 2 3
# Activation keeps only the rebuilt module cache; the superseded key is pruned.
[[ $(aster_caches) == 1 && $(find "$fixture/application/cache" -mindepth 1 -maxdepth 1 -type d -name 'module-aster-*') != "$saved_aster_cache" ]]
[[ $(sort -u "$fixture/module-workspaces" | wc -l) -ge 4 ]]

# A Python-only change updates the runtime without rebuilding the dashboard or
# extracting a build workspace when all frontend outputs already have caches.
workspace_count=$(wc -l < "$fixture/workspace.calls")
touch "$fixture/forbid-workspace"
printf 'backend only\n' >> "$fixture/source/modules/aster/trading/runtime.py"
commit_source aster-backend
run_install
expect_counts 1 2 0 2 6
expect_modules 3 1 2 3
[[ $(wc -l < "$fixture/workspace.calls") == "$workspace_count" ]]
grep -q 'backend only' "$fixture/application/current/modules/aster/trading/runtime.py"
rm "$fixture/forbid-workspace"

# Explicit tests still hydrate every output. Promote cache-only preparation in
# the same installer process to ensure its completion marker cannot skip this.
touch "$fixture/check-cache-promotion"
PROJECT_DEPLOY_TESTS=1 run_install
expect_counts 1 2 1 2 6
expect_modules 3 1 2 3
[[ $(cat "$fixture/hydrated-test.calls") == hydrated ]]
rm "$fixture/check-cache-promotion"
[[ $(wc -l < "$fixture/runtime-dependencies.calls") == 1 ]]

# A dependency change builds a new production cache. Older releases keep their
# original immutable targets, so rollback never observes the new dependency set.
old_release=$(readlink "$fixture/application/current")
old_dependencies=$(readlink "$old_release/node_modules")
printf 'changed lock\n' >> "$fixture/source/pnpm-lock.yaml"
commit_source dependencies
run_install
expect_counts 2 3 1 3 7
expect_modules 4 2 3 4
[[ $(wc -l < "$fixture/runtime-dependencies.calls") == 2 ]]
current=$(readlink "$fixture/application/current")
[[ $(readlink "$old_release/node_modules") == "$old_dependencies" && -f "$old_dependencies/runtime.txt" ]]
[[ $(readlink "$current/node_modules") != "$old_dependencies" ]]
[[ -f "$current/node_modules/runtime.txt" ]]

# Same-commit fast paths and existing-candidate reuse must both reject missing
# or redirected importer links before activation, without changing old caches.
target=$(readlink "$current/modules/asset/node_modules")
saved_stops=$(stops)
cp "$fixture/application/.deployed-state" "$fixture/success-state"
for state in missing redirected; do
  rm "$current/modules/asset/node_modules"
  if [[ "$state" == redirected ]]; then ln -s "$(readlink "$current/node_modules")" "$current/modules/asset/node_modules"; fi
  if run_install; then echo "Invalid $state runtime dependency link was accepted" >&2; exit 1; fi
  [[ $(stops) == "$saved_stops" && $(restarts) == 7 && $(readlink "$fixture/application/current") == "$current" ]]
  cmp "$fixture/success-state" "$fixture/application/.deployed-state"
  [[ ! -L "$current/modules/asset/node_modules" ]] || rm "$current/modules/asset/node_modules"
  ln -s "$target" "$current/modules/asset/node_modules"
done
[[ $(wc -l < "$fixture/runtime-dependencies.calls") == 2 ]]

# Direct dispatch must retain the old runner's rejection of module source links.
# A rejected source cannot reach a compiler or change the running deployment.
ln -s "$fixture/outside-source" "$fixture/source/modules/crossex/unsafe-source.ts"
commit_source linked-source
if run_install; then echo 'A module source link reached direct compilation' >&2; exit 1; fi
expect_modules 4 2 3 4
[[ $(stops) == "$saved_stops" && $(restarts) == 7 && $(readlink "$fixture/application/current") == "$current" ]]
cmp "$fixture/success-state" "$fixture/application/.deployed-state"
rm "$fixture/source/modules/crossex/unsafe-source.ts"

# With a recognized lockfile, a root-only dependency (like ethers for server/
# tools) reinstalls the workspace but rebuilds no module; a change inside one
# importer's locked closure rebuilds only that module.
cp "$repository/deploy/pnpm-module-inputs.py" "$fixture/source/deploy/pnpm-module-inputs.py"
write_closure_lock() {
  local root_extra=$1 leaf=$2 importer name
  {
    printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n"
    printf '  .:\n    dependencies:\n'
    [[ -z $root_extra ]] || printf '      root-extra:\n        specifier: %s\n        version: %s\n' "$root_extra" "$root_extra"
    printf '      root-only:\n        specifier: 1.0.0\n        version: 1.0.0\n\n'
    for importer in modules/asset modules/aster/dashboard modules/crossex modules/monitor; do
      name=shared
      [[ $importer != modules/monitor ]] || name=monitor-tool
      printf '  %s:\n    dependencies:\n      %s:\n        specifier: 1.0.0\n        version: 1.0.0\n\n' "$importer" "$name"
    done
    printf 'packages:\n\n'
    printf '  leaf@%s:\n    resolution: {integrity: sha512-leaf}\n\n' "$leaf"
    printf '  monitor-tool@1.0.0:\n    resolution: {integrity: sha512-tool}\n\n'
    [[ -z $root_extra ]] || printf '  root-extra@%s:\n    resolution: {integrity: sha512-extra}\n\n' "$root_extra"
    printf '  root-only@1.0.0:\n    resolution: {integrity: sha512-root}\n\n  shared@1.0.0:\n    resolution: {integrity: sha512-shared}\n\n'
    printf 'snapshots:\n\n  leaf@%s: {}\n\n  monitor-tool@1.0.0:\n    dependencies:\n      leaf: %s\n\n' "$leaf" "$leaf"
    [[ -z $root_extra ]] || printf '  root-extra@%s: {}\n\n' "$root_extra"
    printf '  root-only@1.0.0: {}\n\n  shared@1.0.0: {}\n'
  } > "$fixture/source/pnpm-lock.yaml"
  printf '{"name":"fixture","version":"1.0.0","type":"module","scripts":{"prepare":"node scripts/install-hooks.mjs"},"dependencies":{"root-only":"1.0.0"%s}}\n' \
    "${root_extra:+,\"root-extra\":\"$root_extra\"}" > "$fixture/source/package.json"
}
write_closure_lock '' 1.0.0
commit_source closure-lock
run_install
expect_modules 5 3 4 5
installs=$(count install)
write_closure_lock 2.0.0 1.0.0
commit_source root-only-dependency
run_install
expect_modules 5 3 4 5
[[ $(count install) == $((installs + 1)) ]]
write_closure_lock 2.0.0 1.0.1
commit_source monitor-closure
run_install
expect_modules 6 3 4 5

bash "$repository/deploy/test-module-cache-migration.sh"
printf 'Module cache reuse, lazy workspaces, test hydration, complete artifact checks and pre-activation failure recovery passed.\n'
