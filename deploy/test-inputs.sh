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
capture() { before=($dependency_key $typecheck_key $test_key $build_key $application_key); runtime_before=$runtime_dependency_key; }
compare() {
  local after=($dependency_key $typecheck_key $test_key $build_key $application_key) index=0 changed
  for changed in "$@"; do
    if [[ $changed == 1 ]]; then [[ ${before[$index]} != "${after[$index]}" ]]
    else [[ ${before[$index]} == "${after[$index]}" ]]; fi
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
echo frontend >> "$source_dir/src/app.ts"; refresh; compare 0 1 1 1 1
capture
echo config >> "$source_dir/tsconfig.json"; refresh; compare 0 1 1 1 1
capture
echo VITE_PUBLIC=fixture > "$source_dir/.env.production"; refresh; compare 0 0 0 1 1
capture
build_environment=$(NODE_ENV=production VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=initial read_build_environment); input_keys; compare 0 0 0 1 1
capture
build_environment=$(NODE_ENV=production VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=changed read_build_environment); input_keys; compare 0 0 0 1 1
capture
build_environment=$(NODE_ENV=development VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=changed read_build_environment); input_keys; compare 0 0 0 1 1
capture
build_environment=$(NODE_ENV=development VITE_FIXTURE_VALUE=changed NEXT_PUBLIC_FIXTURE_VALUE=changed UNRELATED_FIXTURE_VALUE=changed read_build_environment); input_keys; compare 0 0 0 0 0
capture
echo dependency >> "$source_dir/pnpm-lock.yaml"; refresh; compare 1 1 1 1 1
capture
echo catalog >> "$source_dir/pnpm-workspace.yaml"; refresh; compare 1 1 1 1 1
capture
echo settings >> "$source_dir/.npmrc"; refresh; compare 1 1 1 1 1
capture
PNPM_VERSION=changed-pnpm; input_keys; compare 1 1 1 1 1
capture
runtime_key=another-node; input_keys; compare 1 1 1 1 1
capture
for importer in monitor asset crossex aster/dashboard; do
  mkdir -p "$source_dir/modules/$importer"
  echo module > "$source_dir/modules/$importer/package.json"; refresh; compare 1 1 1 1 1
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
echo cycle > "$source_dir/modules/aster/trading/cycle-config.json"; refresh; compare 1 1 1 1 1
capture
module_before=(${module_build_keys[monitor]} ${module_build_keys[asset]} ${module_build_keys[crossex]} ${module_build_keys[aster]})
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
commit=invalid-source
if input_keys 2>/dev/null; then echo 'Invalid git source was silently hashed' >&2; exit 1; fi
printf 'Git input classification passed, including tsconfig, Vite env and failed reads.\n'
