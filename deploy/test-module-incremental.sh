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
mkdir -p "$fixture/source/modules/greeks" "$fixture/source/scripts"
printf 'greeks runtime\n' > "$fixture/source/modules/greeks/runtime.py"
printf 'fixture build dispatch\n' > "$fixture/source/scripts/modules.mjs"
printf 'fixture migration\n' > "$fixture/source/deploy/migrate-modules.py"
printf 'fixture runtime lock\n' > "$fixture/source/deploy/pnpm-runtime-lock.mjs"
# Package only the fixture's already-built outputs; no real dependencies, service or strategy is executed.
cat > "$fixture/source/deploy/package-release.py" <<'PACKAGE'
import argparse
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--stage-only', type=Path, required=True)
args, _ = parser.parse_known_args()
shutil.copytree(args.source / 'modules', args.stage_only / 'modules', ignore=shutil.ignore_patterns('node_modules'))
shutil.copytree(args.source / 'deploy', args.stage_only / 'deploy')
(args.stage_only / 'node_modules').mkdir()
PACKAGE
commit_source modules

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
run_install
expect_counts 1 2 0 2 4
expect_modules 2 1 2 1
[[ $(cat "$fixture/application/current/modules/monitor/dist/assets/chunk.js") == 'monitor chunk' ]]

# A failed build publishes no cache for that input and cannot reach service activation.
current=$(readlink "$fixture/application/current")
cp "$fixture/application/.deployed-state" "$fixture/success-state"
saved_caches=$(aster_caches)
saved_stops=$(stops)
printf 'changed aster\n' >> "$fixture/source/modules/aster/dashboard/input.txt"
commit_source aster
touch "$fixture/fail-module-aster"
if run_install; then echo 'Failed module build was accepted' >&2; exit 1; fi
expect_counts 1 2 0 2 4
expect_modules 2 1 2 2
[[ $(aster_caches) == "$saved_caches" && $(stops) == "$saved_stops" ]]
[[ $(readlink "$fixture/application/current") == "$current" && -f "$fixture/running-port" ]]
cmp "$fixture/success-state" "$fixture/application/.deployed-state"
rm "$fixture/fail-module-aster"
run_install
expect_counts 1 2 0 2 5
expect_modules 2 1 2 3
[[ $(aster_caches) == $((saved_caches + 1)) ]]
[[ $(sort -u "$fixture/module-workspaces" | wc -l) -ge 4 ]]
printf 'Module cache reuse, isolated rebuilds, complete artifact checks and pre-activation failure recovery passed.\n'
