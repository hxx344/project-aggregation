#!/usr/bin/env bash
# Real git trees; runs on native Git Bash as well as Linux without services/symlinks.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/install.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
APP_DIR="$fixture/application"
source_dir="$fixture/source"
mkdir -p "$APP_DIR" "$source_dir/src" "$source_dir/server" "$source_dir/tests"
git -C "$source_dir" init -q -b main
git -C "$source_dir" config core.autocrlf false
git -C "$source_dir" config user.name fixture
git -C "$source_dir" config user.email fixture@example.invalid
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json src/app.ts server/index.mjs tests/app.test.mjs; do
  printf '{}\n' > "$source_dir/$file"
done
git -C "$source_dir" add .
git -C "$source_dir" commit -qm initial
git clone -q --bare "$source_dir" "$APP_DIR/repository.git"
runtime_key=fixture-node
NODE_BIN=$(command -v node)
build_environment=$(NODE_ENV=production VITE_FIXTURE_VALUE=initial NEXT_PUBLIC_FIXTURE_VALUE=initial read_build_environment)
[[ "$build_environment" == *'["NODE_ENV","production"]'* && "$build_environment" == *'["VITE_FIXTURE_VALUE","initial"]'* && "$build_environment" == *'["NEXT_PUBLIC_FIXTURE_VALUE","initial"]'* ]]
refresh() {
  git -C "$source_dir" add .
  if ! git -C "$source_dir" diff --cached --quiet; then git -C "$source_dir" commit -qm change; fi
  git --git-dir="$APP_DIR/repository.git" fetch -q "$source_dir" main
  commit=$(git -C "$source_dir" rev-parse HEAD)
  input_keys
}
capture() {
  before=($dependency_key $typecheck_key $test_key $build_key $application_key)
  runtime_before=$runtime_dependency_key
  module_inputs_before=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]})
}
compare() {
  local after=($dependency_key $typecheck_key $test_key $build_key $application_key) index=0 changed
  for changed in "$@"; do
    if [[ $changed == 1 ]]; then [[ ${before[$index]} != "${after[$index]}" ]]
    else [[ ${before[$index]} == "${after[$index]}" ]]; fi
    index=$((index + 1))
  done
}
compare_module_inputs() {
  local after=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]}) index=0 changed
  for changed in "$@"; do
    if [[ $changed == 1 ]]; then [[ ${module_inputs_before[$index]} != "${after[$index]}" ]]
    else [[ ${module_inputs_before[$index]} == "${after[$index]}" ]]; fi
    index=$((index + 1))
  done
}
refresh
capture
echo docs > "$source_dir/README.md"; refresh; compare 0 0 0 0 0
capture
echo test >> "$source_dir/tests/app.test.mjs"; refresh; compare 0 0 1 0 0
capture
echo backend >> "$source_dir/server/index.mjs"; refresh; compare 0 0 1 0 1
capture
# Research collection is a runtime input, independent of UI/module builds and dependencies.
mkdir -p "$source_dir/tools/entropy-lighter-lab"
for file in cli.mjs core.mjs feeds.mjs binance-scalper.mjs config.example.json; do
  embedded_before=$embedded_key
  runtime_component_before=$runtime_component_key
  echo research > "$source_dir/tools/entropy-lighter-lab/$file"; refresh; compare 0 0 1 0 1
  compare_module_inputs 0 0 0 0
  [[ $runtime_component_key != "$runtime_component_before" && $embedded_key == "$embedded_before" && $runtime_dependency_key == "$runtime_before" ]]
  capture
done
# The LP rebalancer runs in the runtime unit like the research collector.
mkdir -p "$source_dir/tools/aero-lp"
for file in cli.mjs core.mjs chain.mjs config.example.json; do
  embedded_before=$embedded_key
  runtime_component_before=$runtime_component_key
  echo lp > "$source_dir/tools/aero-lp/$file"; refresh; compare 0 0 1 0 1
  compare_module_inputs 0 0 0 0
  [[ $runtime_component_key != "$runtime_component_before" && $embedded_key == "$embedded_before" && $runtime_dependency_key == "$runtime_before" ]]
  capture
done
runtime_component_before=$runtime_component_key
echo frontend >> "$source_dir/src/app.ts"; refresh; compare 0 1 1 1 1
[[ $runtime_component_key == "$runtime_component_before" ]]
capture
mkdir -p "$source_dir/server/api"
echo api > "$source_dir/server/api/server.mjs"; refresh; compare 0 0 1 0 1
[[ $runtime_component_key == "$runtime_component_before" ]]
capture
echo config >> "$source_dir/tsconfig.json"; refresh; compare 0 1 1 1 1
capture
echo VITE_PUBLIC=fixture > "$source_dir/.env.production"; refresh; compare 0 0 0 1 1
compare_module_inputs 1 1 1 1
capture
build_environment=$(NODE_ENV=production VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=initial read_build_environment); input_keys; compare 0 0 0 1 1
compare_module_inputs 1 1 1 1
capture
build_environment=$(NODE_ENV=production VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=changed read_build_environment); input_keys; compare 0 0 0 1 1
compare_module_inputs 1 1 1 1
capture
build_environment=$(NODE_ENV=development VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=changed read_build_environment); input_keys; compare 0 0 0 1 1
compare_module_inputs 1 1 1 1
capture
build_environment=$(NODE_ENV=development VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=changed UNRELATED_FIXTURE_VALUE=changed read_build_environment); input_keys; compare 0 0 0 0 0
compare_module_inputs 0 0 0 0
capture
echo dependency >> "$source_dir/pnpm-lock.yaml"; refresh; compare 1 1 1 1 1
compare_module_inputs 1 1 1 1
capture
echo catalog >> "$source_dir/pnpm-workspace.yaml"; refresh; compare 1 1 1 1 1
capture
echo settings >> "$source_dir/.npmrc"; refresh; compare 1 1 1 1 1
capture
mkdir -p "$source_dir/scripts"
for change in added modified; do
  echo "$change hook" > "$source_dir/scripts/install-hooks.mjs"; refresh; compare 1 1 1 1 1
  compare_module_inputs 1 1 1 1
  capture
  refresh; compare 0 0 0 0 0
  compare_module_inputs 0 0 0 0
done
rm "$source_dir/scripts/install-hooks.mjs"; refresh; compare 1 1 1 1 1
compare_module_inputs 1 1 1 1
capture

PNPM_VERSION=changed-pnpm; input_keys; compare 1 1 1 1 1
compare_module_inputs 1 1 1 1
capture
runtime_key=another-node; input_keys; compare 1 1 1 1 1
compare_module_inputs 1 1 1 1
capture
for importer in monitor asset crossex aster/dashboard; do
  mkdir -p "$source_dir/modules/$importer"
  echo module > "$source_dir/modules/$importer/package.json"; refresh; compare 1 1 1 1 1
  compare_module_inputs 1 1 1 1
  capture
done
echo settings >> "$source_dir/modules/asset/.npmrc"; refresh; compare 1 1 1 1 1
capture
mkdir -p "$source_dir/modules/asset/scripts" "$source_dir/modules/asset/lib"
echo prepare > "$source_dir/modules/asset/scripts/prepare-ledger.mjs"; refresh; compare 1 1 1 1 1
capture
echo example > "$source_dir/modules/asset/lib/example-ledger.json"; refresh; compare 1 1 1 1 1
capture
mkdir -p "$source_dir/modules/aster/trading"
mkdir -p "$source_dir/scripts" "$source_dir/modules/monitor/scripts"
# Source deployment calls each importer directly. The optional local runner
# cannot invalidate any module's compiled output when its dispatch changes.
for change in initial changed; do
  echo "$change dispatch" > "$source_dir/scripts/modules.mjs"; refresh
  [[ $dependency_key == "${before[0]}" && $typecheck_key == "${before[1]}" && $build_key == "${before[3]}" ]]
  compare_module_inputs 0 0 0 0
  capture
done
echo build > "$source_dir/modules/monitor/scripts/build.mjs"; refresh; compare 0 0 1 0 1
compare_module_inputs 1 0 0 0
capture
echo VITE_MODULE=changed > "$source_dir/modules/crossex/.env.production"; refresh; compare 0 0 1 0 1
compare_module_inputs 0 0 1 0
capture
module_before=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]})
for file in hub-navigation.mjs hub-navigation.d.mts asset-identity.mjs asset-identity.d.mts; do
  capture
  embedded_before=$embedded_key
  echo shared-navigation > "$source_dir/server/$file"; refresh; compare 0 1 1 1 1
  [[ $embedded_key != "$embedded_before" && ${module_build_keys[monitor]} != "${module_before[0]}" &&
     ${module_build_keys[asset]} == "${module_before[1]}" && ${module_build_keys[crossex]} != "${module_before[2]}" &&
     ${module_build_keys[aster]} == "${module_before[3]}" ]]
  module_before=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]})
done
capture
for file in capital-metrics.mjs capital-metrics.d.mts; do
  capture
  embedded_before=$embedded_key
  echo shared-capital > "$source_dir/server/$file"; refresh; compare 0 0 1 0 1
  [[ $embedded_key != "$embedded_before" && ${module_build_keys[monitor]} != "${module_before[0]}" &&
     ${module_build_keys[asset]} == "${module_before[1]}" && ${module_build_keys[crossex]} != "${module_before[2]}" &&
     ${module_build_keys[aster]} == "${module_before[3]}" ]]
  module_before=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]})
done
capture
echo source > "$source_dir/modules/monitor/server.mjs"; refresh; compare 0 0 1 0 1
[[ ${module_build_keys[monitor]} != "${module_before[0]}" && ${module_build_keys[asset]} == "${module_before[1]}" &&
   ${module_build_keys[crossex]} == "${module_before[2]}" && ${module_build_keys[aster]} == "${module_before[3]}" ]]
module_before=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]})
for file in trading/runtime.py requirements.lock; do
  capture
  embedded_before=$embedded_key
  echo backend > "$source_dir/modules/aster/$file"; refresh; compare 0 0 1 0 1
  [[ $runtime_dependency_key == "$runtime_before" && $embedded_key != "$embedded_before" && ${module_build_keys[monitor]} == "${module_before[0]}" &&
     ${module_build_keys[asset]} == "${module_before[1]}" && ${module_build_keys[crossex]} == "${module_before[2]}" &&
     ${module_build_keys[aster]} == "${module_before[3]}" ]]
done
for file in dashboard/page.tsx .env.production; do
  capture
  echo frontend > "$source_dir/modules/aster/$file"; refresh; compare 0 0 1 0 1
  [[ $runtime_dependency_key == "$runtime_before" && ${module_build_keys[monitor]} == "${module_before[0]}" && ${module_build_keys[asset]} == "${module_before[1]}" &&
     ${module_build_keys[crossex]} == "${module_before[2]}" && ${module_build_keys[aster]} != "${module_before[3]}" ]]
  module_before[3]=${module_build_keys[aster]}
done
capture
mkdir -p "$source_dir/deploy"
module_before=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]})
echo helper > "$source_dir/deploy/pnpm-runtime-lock.mjs"; refresh; compare 0 0 0 0 1
[[ $runtime_dependency_key != "$runtime_before" ]]
[[ ${module_build_keys[monitor]} == "${module_before[0]}" && ${module_build_keys[asset]} == "${module_before[1]}" &&
   ${module_build_keys[crossex]} == "${module_before[2]}" && ${module_build_keys[aster]} == "${module_before[3]}" ]]
capture
echo frontend >> "$source_dir/src/app.ts"; refresh; compare 0 1 1 1 1
[[ ${module_build_keys[monitor]} == "${module_before[0]}" && ${module_build_keys[asset]} == "${module_before[1]}" &&
   ${module_build_keys[crossex]} == "${module_before[2]}" && ${module_build_keys[aster]} == "${module_before[3]}" ]]
capture
embedded_before=$embedded_key
echo helper > "$source_dir/deploy/build-artifact-cache.py"; refresh; compare 0 0 0 1 1
[[ $runtime_dependency_key == "$runtime_before" ]]
[[ $embedded_key != "$embedded_before" && ${module_build_keys[monitor]} != "${module_before[0]}" &&
   ${module_build_keys[asset]} != "${module_before[1]}" && ${module_build_keys[crossex]} != "${module_before[2]}" &&
   ${module_build_keys[aster]} != "${module_before[3]}" ]]
capture
embedded_before=$embedded_key
echo diagnostic > "$source_dir/deploy/diagnose-aster-margin.py"; refresh; compare 0 0 0 0 1
compare_module_inputs 0 0 0 0
[[ $embedded_key != "$embedded_before" && $runtime_dependency_key == "$runtime_before" ]]
capture
embedded_before=$embedded_key
# An actual compiler dispatch change invalidates both the module artifacts and
# the assembled runtime; an existing embedded cache cannot bypass the new recipe.
run_module_build() { printf 'changed build recipe\n'; }
input_keys
compare 0 0 0 0 1
compare_module_inputs 1 1 1 1
[[ $embedded_key != "$embedded_before" ]]
for module in "${MODULE_BUILD_IDS[@]}"; do
  [[ -z ${legacy_module_build_keys[$module]:-} ]]
done
commit=invalid-source
if input_keys 2>/dev/null; then echo 'Invalid git source was silently hashed' >&2; exit 1; fi
printf 'Git input classification passed, including module recipes, shared inputs, build env and failed reads.\n'
