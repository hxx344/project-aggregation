#!/usr/bin/env bash
# Real, unprivileged TypeScript/Vite build and runtime import against immutable packages.
set -Eeuo pipefail
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
AGG_INSTALL_SOURCE_ONLY=1 source "$repository/deploy/install.sh"
source "$repository/deploy/workspace-test-jobs.sh"
test_root=$(mktemp -d)
trap workspace_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0755 "$test_root"
APP_DIR="$test_root/application"
SERVICE_USER=${SUDO_USER:?Run through sudo from the CI account}
NODE_BIN=${INSTALL_TEST_NODE:?Pass the setup-node executable}
PNPM_BIN=$(realpath "${INSTALL_TEST_PNPM:?Pass the pnpm JavaScript entry file (node_modules/pnpm/bin/pnpm.mjs)}")
[[ "$("$NODE_BIN" "$PNPM_BIN" --version)" == "$PNPM_VERSION" ]] || {
  echo "INSTALL_TEST_PNPM must be the pnpm $PNPM_VERSION JavaScript entry file executable by INSTALL_TEST_NODE." >&2
  exit 1
}
# CI runs the two halves on separate runners; local runs default to both.
lane=${INSTALL_TEST_LANE:-all}
case "$lane" in
  all|behavior|package) ;;
  *) echo 'INSTALL_TEST_LANE must be all, behavior or package.' >&2; exit 1 ;;
esac
work_dir="$test_root/work"
mkdir -p "$APP_DIR/build-home" "$APP_DIR/cache" "$APP_DIR/releases" "$work_dir"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/build-home"
if [[ -n ${INSTALL_TEST_PNPM_STORE:-} ]]; then
  # Reuse only downloaded package contents. The production installer still runs
  # its frozen copy install and lifecycle scripts into a fresh dependency cache.
  [[ $INSTALL_TEST_PNPM_STORE == /* && -d $INSTALL_TEST_PNPM_STORE && ! -L $INSTALL_TEST_PNPM_STORE ]] ||
    { echo 'INSTALL_TEST_PNPM_STORE must be an existing absolute directory.' >&2; exit 1; }
  runuser -u "$SERVICE_USER" -- test -w "$INSTALL_TEST_PNPM_STORE" ||
    { echo 'The build account cannot write to INSTALL_TEST_PNPM_STORE.' >&2; exit 1; }
  ln -s -- "$INSTALL_TEST_PNPM_STORE" "$APP_DIR/build-home/pnpm-store"
  # Checkout installs share this store; replaying their recorded build results
  # would skip the dependency build hooks a server runs on a cold install.
  export pnpm_config_side_effects_cache=false
  printf '[workspace] pnpm content store: %s\n' "$INSTALL_TEST_PNPM_STORE"
fi
git -c safe.directory="$repository" -c safe.directory="$repository/.git" clone -q --bare "$repository" "$APP_DIR/repository.git"
commit=$(git --git-dir="$APP_DIR/repository.git" rev-parse HEAD)
runtime_key=$(printf '%s\n%s\n%s\n%s\n' "$("$NODE_BIN" --version)" "$PNPM_VERSION" "$(uname -s)" "$(uname -m)" | hash)
build_environment=$(read_build_environment)
input_keys
# Exercise the same cold, fixed-Git extraction and lifecycle scripts as a server.
mkdir -p "$APP_DIR/cache"
prepare_dependencies
cache_modules_hash=$(sha256sum "$dependencies/node_modules/.modules.yaml" | cut -d ' ' -f 1)
prepare_workspace
for importer in . modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
  [[ ! -L "$work_dir/source/$importer/node_modules" && -L "$work_dir/source/$importer/node_modules/react" ]]
  if run_as_service test -w "$dependencies/$importer/node_modules/react/package.json"; then
    echo 'The build account can modify shared packages' >&2; exit 1
  fi
  run_as_service test -w "$work_dir/source/$importer/node_modules"
done
workspace_frontend_checks() {
  (cd "$work_dir/source"; run_as_service "$NODE_BIN" "$PNPM_BIN" run check)
  atomic_record "$typecheck_stamp" "$typecheck_key"
  (cd "$work_dir/source/modules/aster/dashboard"; run_as_service "$NODE_BIN" "$PNPM_BIN" run typecheck)
  (cd "$work_dir/source/modules/aster/dashboard"; run_as_service "$NODE_BIN" "$PNPM_BIN" run lint)
  (cd "$work_dir/source"; run_as_service "$NODE_BIN" --test modules/aster/dashboard/tests/*.test.mjs)
}
# ASTER's Python unit tests run in deploy/test-aster-python.sh as a separate CI
# job. These environments serve the root behavior tests and package checks.
workspace_python_setup() {
  local pip_cache=${INSTALL_TEST_PIP_CACHE:-$APP_DIR/build-home/.cache/pip}
  [[ "$pip_cache" == /* ]] || { echo 'INSTALL_TEST_PIP_CACHE must be an absolute directory.' >&2; return 1; }
  run_as_service mkdir -p -- "$pip_cache"
  run_as_service test -w "$pip_cache" || { echo 'The build account cannot write to the Python pip cache.' >&2; return 1; }
  printf '[workspace] Python pip download cache: %s\n' "$pip_cache"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$test_root/python"
  run_as_service "${INSTALL_TEST_PYTHON:-/usr/bin/python3}" -m venv "$test_root/python"
  run_as_service "$test_root/python/bin/python" -m pip --cache-dir "$pip_cache" install --disable-pip-version-check --require-hashes -r "$work_dir/source/modules/greeks/requirements.lock"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$test_root/python-aster"
  run_as_service "${INSTALL_TEST_PYTHON:-/usr/bin/python3}" -m venv "$test_root/python-aster"
  run_as_service "$test_root/python-aster/bin/python" -m pip --cache-dir "$pip_cache" install --disable-pip-version-check --require-hashes -r "$work_dir/source/modules/aster/requirements.lock"
}
workspace_module_build() {
  # The production build path for one module per lane. Each module builds in
  # its own importer and publishes its own trusted cache.
  MODULE_BUILD_IDS=("$1")
  prepare_module_builds
}
workspace_root_tests() {
  # A separate extraction hydrated from the verified module caches, as an
  # upgrade with PROJECT_DEPLOY_TESTS=1 does. Packaging reads the first tree
  # concurrently and rejects files that appear or vanish while it copies.
  work_dir="$test_root/test-work"
  mkdir "$work_dir"
  modules_prepared=0
  module_outputs_prepared=()
  prepare_build_cache_helper
  prepare_module_builds
  (cd "$work_dir/source"; run_as_service env GREEKS_PYTHON="$test_root/python/bin/python" ASTER_PYTHON="$test_root/python-aster/bin/python" "$NODE_BIN" "$PNPM_BIN" test)
}
workspace_reuse_check() {
  # A fresh extraction on the next upgrade must hydrate all four module outputs
  # without invoking a compiler, and the service account cannot edit the caches.
  work_dir="$test_root/reuse-work"
  mkdir "$work_dir"
  modules_prepared=0
  module_outputs_prepared=()
  prepare_build_cache_helper
  # The default update path only needs trusted caches. It must not extract a
  # disposable build workspace or materialize dependencies on a warm reuse.
  prepare_module_builds cache-only
  [[ ! -e "$work_dir/source" ]]
  prepare_runtime_dependencies
  [[ ! -e "$work_dir/trusted-dependencies" && ! -e "$work_dir/runtime-dependencies" ]]
  prepare_workspace
  run_as_service() {
    [[ "$1" == /usr/bin/python3 && "$2" == -I ]] || { echo 'Unexpected rebuild while reusing verified module artifacts' >&2; return 91; }
    runuser -u "$SERVICE_USER" -- "$@"
  }
  prepare_module_builds
  local module cache
  for module in "${MODULE_BUILD_IDS[@]}"; do
    cache="$APP_DIR/cache/module-$module-${module_build_keys[$module]}"
    build_artifact_cache verify "$cache" "${module_build_keys[$module]}"
    [[ -s "$work_dir/source/${MODULE_BUILD_OUTPUTS[$module]}/${MODULE_BUILD_ENTRIES[$module]}" ]]
    if runuser -u "$SERVICE_USER" -- test -w "$cache/artifact/${MODULE_BUILD_ENTRIES[$module]}"; then
      echo 'The build account can modify a published artifact cache' >&2; return 1
    fi
  done
  printf 'Real source deployment and cross-workspace module reuse passed.\n'
}
isolated_package_check() {
  # Real restored workers may read stale notification configuration. A separate
  # network namespace allows their loopback/private IPC, with no outside route.
  unshare --net -- bash -c 'ip link set dev lo up; exec runuser -u "$1" -- env GREEKS_PYTHON="$2" ASTER_PYTHON="$3" "$4" "$5" "$6"' \
    recovery-drill "$SERVICE_USER" "$test_root/python/bin/python" "$test_root/python-aster/bin/python" "$NODE_BIN" "$repository/deploy/test-package.mjs" "$1"
}
workspace_archive_check() {
  mkdir "$test_root/package"
  tar -xzf "$repository/output/release/"*-linux-*.tar.gz -C "$test_root/package"
  isolated_package_check "$test_root/package"
}
assert_shared_dependencies_unchanged() {
  local importer
  for importer in . modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
    [[ ! -d "$dependencies/$importer/node_modules/.vite-temp" ]]
  done
  [[ "$(sha256sum "$dependencies/node_modules/.modules.yaml" | cut -d ' ' -f 1)" == "$cache_modules_hash" ]]
}
imported_modules=0
workspace_import_module_caches() {
  local source=$1 module key name stage artifact
  [[ $source == /* && -d $source && ! -L $source ]] ||
    { echo 'INSTALL_TEST_MODULE_CACHE must be an existing absolute directory.' >&2; return 1; }
  for module in "${MODULE_BUILD_IDS[@]}"; do
    key=${module_build_keys[$module]}
    name="module-$module-$key"
    [[ -d "$source/$name" && ! -L "$source/$name" ]] || continue
    stage=$(mktemp -d "$work_dir/module-cache-import-$module.XXXXXXXX")
    artifact="$stage/${MODULE_BUILD_OUTPUTS[$module]##*/}"
    # Re-hash the restored bytes into a root-owned cache, as a legacy cache
    # migration does. The content key still names every build input; a
    # mismatch only means this module builds again.
    if build_artifact_cache restore "$source/$name" "$key" "$artifact" &&
        build_artifact_cache store "$artifact" "$APP_DIR/cache/$name" "$key"; then
      chown -R root:root "$APP_DIR/cache/$name"
      chmod -R a+rX,go-w "$APP_DIR/cache/$name"
      imported_modules=$((imported_modules + 1))
      printf '[workspace] Imported the verified %s build from an earlier CI run.\n' "$module"
    else
      rm -rf -- "$APP_DIR/cache/$name"
      printf '[workspace] Discarded an unverifiable %s build cache.\n' "$module"
    fi
    rm -rf -- "$stage"
  done
}
workspace_export_module_caches() {
  local target=$1 module name
  (( imported_modules < ${#MODULE_BUILD_IDS[@]} )) || return 0
  # Keep exactly the current module caches so the saved entry does not grow.
  find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  for module in "${MODULE_BUILD_IDS[@]}"; do
    name="module-$module-${module_build_keys[$module]}"
    cp -R -- "$APP_DIR/cache/$name" "$target/$name"
  done
  chown -R "$SERVICE_USER:$SERVICE_USER" "$target"
  : > "$target.updated"
  printf '[workspace] Exported the current module builds for later CI runs.\n'
}
prepare_build_cache_helper
if [[ -n ${INSTALL_TEST_MODULE_CACHE:-} ]]; then workspace_import_module_caches "$INSTALL_TEST_MODULE_CACHE"; fi
workspace_start_job python-setup workspace_python_setup
if [[ $lane != package ]]; then workspace_start_job frontend-checks workspace_frontend_checks; fi
for module in "${MODULE_BUILD_IDS[@]}"; do
  workspace_start_job "module-build-$module" workspace_module_build "$module"
done
workspace_wait_jobs
# The module lanes published verified artifacts and the check lane its stamp to
# disk. This is the only in-memory prepare_module_builds result needed later.
modules_prepared=1
if [[ -n ${INSTALL_TEST_MODULE_CACHE:-} && ${INSTALL_TEST_MODULE_CACHE_EXPORT:-0} == 1 ]]; then
  workspace_export_module_caches "$INSTALL_TEST_MODULE_CACHE"
fi
(cd "$work_dir/source"; run_as_service "$NODE_BIN" -e 'for (const file of ["app", "launcher", "runtime/main", "api/main"]) await import(`./server/${file}.mjs`)')
if [[ $lane != package ]]; then workspace_start_job root-behavior-tests workspace_root_tests; fi
if [[ $lane == behavior ]]; then
  workspace_wait_jobs
  assert_shared_dependencies_unchanged
  printf 'Real non-root checks and behavior tests passed with immutable shared dependencies.\n'
  exit 0
fi
stage_started=$SECONDS
prepare_application
validate_embedded_runtime "$release"
source_runtime_dependencies_ready "$release" "$runtime_dependency_key"
for importer in "${RUNTIME_DEPENDENCY_IMPORTERS[@]}"; do
  if run_as_service test -w "$runtime_dependencies/$importer/node_modules"; then
    echo 'The service account can modify the shared production dependency layout' >&2; exit 1
  fi
done
if run_as_service test -w "$runtime_dependencies/node_modules/react/package.json"; then
  echo 'The service account can modify a shared production package' >&2; exit 1
fi
printf '[workspace] source-assembly: %ss\n' "$((SECONDS - stage_started))"
# Each package check owns a network namespace and a temporary data directory;
# like the reuse check, it only reads root-owned trees, caches and the Python
# environments, so all of them overlap with packaging.
workspace_start_job source-package-check isolated_package_check "$release"
workspace_start_job cross-workspace-reuse workspace_reuse_check
if [[ ${INSTALL_TEST_PACKAGE:-0} == 1 ]]; then
  stage_started=$SECONDS
  python3 "$repository/deploy/package-release.py" --source "$work_dir/source" --dependency-root "$dependencies" --node "$NODE_BIN" --parser-user "$SERVICE_USER" --repository "$repository" --output "$repository/output/release"
  printf '[workspace] packaging: %ss\n' "$((SECONDS - stage_started))"
  workspace_start_job archive-package-check workspace_archive_check
fi
workspace_wait_jobs
[[ -s "$work_dir/source/dist/index.html" && -d "$work_dir/source/node_modules/.vite-temp" && ! -L "$work_dir/source/node_modules/.vite-temp" ]]
assert_shared_dependencies_unchanged
printf 'Real non-root build, backend import and source deployment reuse passed with immutable shared dependencies.\n'
