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
prepare_build_cache_helper
workspace_start_job python-setup workspace_python_setup
workspace_start_job frontend-checks workspace_frontend_checks
workspace_start_job module-builds prepare_module_builds
workspace_wait_jobs
# The module lane published verified artifacts and the check lane its stamp to
# disk. This is the only in-memory prepare_module_builds result needed later.
modules_prepared=1
stage_started=$SECONDS
(cd "$work_dir/source"; run_as_service "$NODE_BIN" -e 'await import("./server/app.mjs")')
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
isolated_package_check() {
  # Real restored workers may read stale notification configuration. A separate
  # network namespace allows their loopback/private IPC, with no outside route.
  unshare --net -- bash -c 'ip link set dev lo up; exec runuser -u "$1" -- env GREEKS_PYTHON="$2" ASTER_PYTHON="$3" "$4" "$5" "$6"' \
    recovery-drill "$SERVICE_USER" "$test_root/python/bin/python" "$test_root/python-aster/bin/python" "$NODE_BIN" "$repository/deploy/test-package.mjs" "$1"
}
if [[ ${INSTALL_TEST_PACKAGE:-0} == 1 ]]; then
  # Package before the behavior tests start: they run in this same source tree,
  # and the packager rejects files that appear or vanish while it copies.
  python3 "$repository/deploy/package-release.py" --source "$work_dir/source" --dependency-root "$dependencies" --node "$NODE_BIN" --parser-user "$SERVICE_USER" --repository "$repository" --output "$repository/output/release"
  mkdir "$test_root/package"
  tar -xzf "$repository/output/release/"*-linux-*.tar.gz -C "$test_root/package"
fi
printf '[workspace] source-assembly-and-packaging: %ss\n' "$((SECONDS - stage_started))"
workspace_root_tests() {
  (cd "$work_dir/source"; run_as_service env GREEKS_PYTHON="$test_root/python/bin/python" ASTER_PYTHON="$test_root/python-aster/bin/python" "$NODE_BIN" "$PNPM_BIN" test)
}
# Each package check owns a network namespace and a temporary data directory;
# both only read the root-owned trees and the Python environments.
workspace_start_job root-behavior-tests workspace_root_tests
workspace_start_job source-package-check isolated_package_check "$release"
if [[ ${INSTALL_TEST_PACKAGE:-0} == 1 ]]; then
  workspace_start_job archive-package-check isolated_package_check "$test_root/package"
fi
workspace_wait_jobs
[[ -s "$work_dir/source/dist/index.html" && -d "$work_dir/source/node_modules/.vite-temp" && ! -L "$work_dir/source/node_modules/.vite-temp" ]]
for importer in . modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
  [[ ! -d "$dependencies/$importer/node_modules/.vite-temp" ]]
done
[[ "$(sha256sum "$dependencies/node_modules/.modules.yaml" | cut -d ' ' -f 1)" == "$cache_modules_hash" ]]
printf 'Real non-root build and backend import passed with immutable shared dependencies.\n'

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
for module in "${MODULE_BUILD_IDS[@]}"; do
  cache="$APP_DIR/cache/module-$module-${module_build_keys[$module]}"
  build_artifact_cache verify "$cache" "${module_build_keys[$module]}"
  [[ -s "$work_dir/source/${MODULE_BUILD_OUTPUTS[$module]}/${MODULE_BUILD_ENTRIES[$module]}" ]]
  if runuser -u "$SERVICE_USER" -- test -w "$cache/artifact/${MODULE_BUILD_ENTRIES[$module]}"; then
    echo 'The build account can modify a published artifact cache' >&2; exit 1
  fi
done
printf 'Real source deployment and cross-workspace module reuse passed.\n'
