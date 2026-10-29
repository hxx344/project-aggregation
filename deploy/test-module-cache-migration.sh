#!/usr/bin/env bash
# Exercise the old on-disk protocol independently of the new migration key builder.
set -Eeuo pipefail
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
AGG_INSTALL_SOURCE_ONLY=1 source "$repository/deploy/install.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
source_dir="$fixture/source"
mkdir -p "$source_dir/deploy" "$source_dir/scripts" "$source_dir/server"
cp "$repository/deploy/build-artifact-cache.py" "$source_dir/deploy/"
# Keep the audited legacy bytes as fixture data so future local-runner changes
# do not silently redefine the cache format this migration has to recognize.
cp "$repository/deploy/fixtures/module-runner-v1.mjs" "$source_dir/scripts/modules.mjs"
[[ $(git hash-object "$source_dir/scripts/modules.mjs") == e7eb0c0c6bc14fb450bea423294fe56f75dbb768 ]]
for file in package.json pnpm-lock.yaml pnpm-workspace.yaml; do printf '{}\n' > "$source_dir/$file"; done
for module in "${MODULE_BUILD_IDS[@]}"; do
  importer=${MODULE_BUILD_IMPORTERS[$module]}
  mkdir -p "$source_dir/$importer"
  printf '{"name":"%s"}\n' "$module" > "$source_dir/$importer/package.json"
  printf '%s input\n' "$module" > "$source_dir/$importer/input.txt"
done
git -C "$source_dir" init -q -b main
git -C "$source_dir" config user.name fixture
git -C "$source_dir" config user.email fixture@example.invalid
commit_source() { git -C "$source_dir" add .; git -C "$source_dir" commit -qm "$1"; }
commit_source initial
known_commit=$(git -C "$source_dir" rev-parse HEAD)

NODE_BIN="$fixture/node"
PNPM_BIN="$fixture/pnpm"
SERVICE_USER=root
runtime_key=fixture-node
build_environment='[]'
export MIGRATION_FIXTURE=$fixture
cat > "$NODE_BIN" <<'NODE'
#!/usr/bin/env bash
set -Eeuo pipefail
shift # pnpm entry
[[ $1 == run ]]
module=$(basename "$PWD")
[[ $module != dashboard ]] || module=aster
if [[ $2 == prepare ]]; then
  [[ $module == asset ]]
  mkdir -p lib
  printf 'prepared\n' > lib/imported-ledger.json
  printf 'asset\n' >> "$MIGRATION_FIXTURE/prepare.calls"
  exit
fi
[[ $2 == build ]]
printf '%s\n' "$module" >> "$MIGRATION_FIXTURE/build.calls"
case "$module" in
  asset) artifact=.next; entry=BUILD_ID; [[ -f lib/imported-ledger.json ]] ;;
  monitor|aster) artifact=dist; entry=client/index.html ;;
  crossex) artifact=dist; entry=index.html ;;
  *) exit 81 ;;
esac
mkdir -p "$artifact/$(dirname "$entry")" "$artifact/assets"
printf 'rebuilt\n' > "$artifact/$entry"
printf 'rebuilt chunk\n' > "$artifact/assets/chunk.js"
if [[ $module == monitor ]]; then printf '{}\n' > "$artifact/build-manifest.json"; fi
NODE
chmod +x "$NODE_BIN"
touch "$PNPM_BIN" "$fixture/build.calls" "$fixture/prepare.calls"
run_as_service() { "$@"; }
prepare_workspace() {
  [[ ${allow_workspace:-0} == 1 ]] || { echo 'Migration unnecessarily prepared a build workspace' >&2; return 82; }
  [[ ! -d "$work_dir/source" ]] || return 0
  mkdir "$work_dir/source"
  git --git-dir="$APP_DIR/repository.git" archive "$commit" | tar -x -C "$work_dir/source"
}

# This is the v1 protocol shipped before direct module dispatch. Do not use
# legacy_module_build_keys to seed it: a wrong migration formula must fail here.
v1_key() {
  local module=$1 tree
  local -a inputs=("modules/$module")
  if [[ $module == aster ]]; then
    inputs=(modules/aster/dashboard modules/aster/trading/cycle-config.json
      modules/aster/.env modules/aster/.env.local modules/aster/.env.production modules/aster/.env.production.local)
  elif [[ $module == monitor || $module == crossex ]]; then
    inputs+=(server/hub-navigation.mjs server/hub-navigation.d.mts server/asset-identity.mjs server/asset-identity.d.mts)
  fi
  tree=$(git --git-dir="$APP_DIR/repository.git" ls-tree -r "$commit" -- "${inputs[@]}" scripts/modules.mjs \
    deploy/build-artifact-cache.py .env .env.local .env.production .env.production.local | sha256sum | cut -d ' ' -f 1)
  printf 'module-artifacts-v1\n%s\n%s\n%s\n%s' "$module" "$tree" "$dependency_key" "$build_environment" | sha256sum | cut -d ' ' -f 1
}
# v2 keyed every module by the whole pnpm workspace; v3 narrows that input.
v2_key() {
  local module=$1 tree
  local -a inputs=("modules/$module")
  if [[ $module == aster ]]; then
    inputs=(modules/aster/dashboard modules/aster/.env modules/aster/.env.local modules/aster/.env.production modules/aster/.env.production.local)
  elif [[ $module == monitor || $module == crossex ]]; then
    inputs+=(server/hub-navigation.mjs server/hub-navigation.d.mts server/asset-identity.mjs server/asset-identity.d.mts
      server/capital-metrics.mjs server/capital-metrics.d.mts)
  fi
  tree=$(git --git-dir="$APP_DIR/repository.git" ls-tree -r "$commit" -- "${inputs[@]}" \
    deploy/build-artifact-cache.py .env .env.local .env.production .env.production.local | sha256sum | cut -d ' ' -f 1)
  printf 'module-artifacts-v2\n%s\n%s\n%s\n%s\n%s' "$module" "$tree" "$dependency_key" "$build_environment" \
    "$(module_build_recipe "$module")" | sha256sum | cut -d ' ' -f 1
}
declare -A old_keys=()
start_case() {
  APP_DIR="$fixture/$1"
  work_dir="$APP_DIR/work"
  mkdir -p "$APP_DIR/cache" "$work_dir"
  git clone -q --bare "$source_dir" "$APP_DIR/repository.git"
  commit=$(git --git-dir="$APP_DIR/repository.git" rev-parse HEAD)
  input_keys
  prepare_build_cache_helper
  modules_prepared=0
  module_outputs_prepared=()
  old_keys=()
  for module in "${MODULE_BUILD_IDS[@]}"; do
    key=$("${seed_key:-v1_key}" "$module")
    old_keys[$module]=$key
    artifact="$APP_DIR/seed/$module/$(basename "${MODULE_BUILD_OUTPUTS[$module]}")"
    mkdir -p "$artifact/$(dirname "${MODULE_BUILD_ENTRIES[$module]}")" "$artifact/assets"
    printf 'old %s entry\n' "$module" > "$artifact/${MODULE_BUILD_ENTRIES[$module]}"
    printf 'old %s chunk\n' "$module" > "$artifact/assets/chunk.js"
    if [[ $module == monitor ]]; then printf '{}\n' > "$artifact/build-manifest.json"; fi
    build_artifact_cache store "$artifact" "$APP_DIR/cache/module-$module-$key" "$key"
  done
}
build_count() { wc -l < "$fixture/build.calls"; }

start_case valid
prepare_module_builds cache-only
[[ ! -e "$work_dir/source" && $(build_count) == 0 && ! -s "$fixture/prepare.calls" ]]
for module in "${MODULE_BUILD_IDS[@]}"; do
  build_artifact_cache verify "$APP_DIR/cache/module-$module-${old_keys[$module]}" "${old_keys[$module]}"
  build_artifact_cache verify "$APP_DIR/cache/module-$module-${module_build_keys[$module]}" "${module_build_keys[$module]}"
  [[ $(cat "$APP_DIR/cache/module-$module-${module_build_keys[$module]}/artifact/assets/chunk.js") == "old $module chunk" ]]
done
# Hydration after migration still restores every module into a fresh workspace.
allow_workspace=1
prepare_module_builds hydrate
[[ $(build_count) == 0 ]]
for module in "${MODULE_BUILD_IDS[@]}"; do
  [[ -s "$work_dir/source/${MODULE_BUILD_OUTPUTS[$module]}/${MODULE_BUILD_ENTRIES[$module]}" ]]
done

start_case damaged
printf 'corrupt\n' >> "$APP_DIR/cache/module-monitor-${old_keys[monitor]}/artifact/assets/chunk.js"
wrong_key=$(printf wrong | sha256sum | cut -d ' ' -f 1)
build_artifact_cache store "$APP_DIR/seed/asset/.next" "$APP_DIR/cache/module-asset-${old_keys[asset]}" "$wrong_key"
prepare_module_builds cache-only
[[ $(build_count) == 2 && $(cat "$fixture/prepare.calls") == asset ]]
[[ $(cat "$APP_DIR/cache/module-monitor-${module_build_keys[monitor]}/artifact/assets/chunk.js") == 'rebuilt chunk' ]]
[[ $(cat "$APP_DIR/cache/module-aster-${module_build_keys[aster]}/artifact/assets/chunk.js") == 'old aster chunk' ]]

# The v2 -> v3 key upgrade reuses verified artifacts of identical inputs
# without a workspace; a damaged v2 cache still rebuilds only that module.
seed_key=v2_key start_case v2-valid
prepare_module_builds cache-only
[[ $(build_count) == 2 && ! -e "$work_dir/source" ]]
for module in "${MODULE_BUILD_IDS[@]}"; do
  [[ ${old_keys[$module]} == "${previous_module_build_keys[$module]}" && ${old_keys[$module]} != "${module_build_keys[$module]}" ]]
  build_artifact_cache verify "$APP_DIR/cache/module-$module-${old_keys[$module]}" "${old_keys[$module]}"
  [[ $(cat "$APP_DIR/cache/module-$module-${module_build_keys[$module]}/artifact/assets/chunk.js") == "old $module chunk" ]]
done
seed_key=v2_key start_case v2-damaged
printf 'corrupt\n' >> "$APP_DIR/cache/module-crossex-${old_keys[crossex]}/artifact/assets/chunk.js"
prepare_module_builds cache-only
[[ $(build_count) == 3 && $(tail -n 1 "$fixture/build.calls") == crossex ]]
[[ $(cat "$APP_DIR/cache/module-crossex-${module_build_keys[crossex]}/artifact/assets/chunk.js") == 'rebuilt chunk' ]]
[[ $(cat "$APP_DIR/cache/module-monitor-${module_build_keys[monitor]}/artifact/assets/chunk.js") == 'old monitor chunk' ]]

printf '// unknown dispatcher\n' >> "$source_dir/scripts/modules.mjs"
commit_source unknown-runner
start_case unknown
for module in "${MODULE_BUILD_IDS[@]}"; do [[ -z ${legacy_module_build_keys[$module]:-} ]]; done
prepare_module_builds cache-only
[[ $(build_count) == 7 ]]

git -C "$source_dir" restore --source="$known_commit" scripts/modules.mjs
commit_source restore-runner
start_case changed-recipe
before_key=${module_build_keys[asset]}
eval "$(declare -f run_module_build | sed '1s/run_module_build/original_module_build/')"
run_module_build() { original_module_build "$@"; }
input_keys
[[ ${module_build_keys[asset]} != "$before_key" ]]
for module in "${MODULE_BUILD_IDS[@]}"; do [[ -z ${legacy_module_build_keys[$module]:-} ]]; done
prepare_module_builds cache-only
[[ $(build_count) == 11 ]]
printf 'Verified v1 and v2 migration, direct module commands, hydration and invalid-cache fallback passed.\n'
