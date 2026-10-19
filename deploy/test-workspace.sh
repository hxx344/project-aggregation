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
  prepare_module_builds
}
workspace_python_checks() {
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
  (cd "$work_dir/source/modules/aster"; run_as_service "$test_root/python-aster/bin/python" -m unittest tests.test_margin_t0 -q)
  (cd "$work_dir/source/modules/aster"; run_as_service "$test_root/python-aster/bin/python" -m unittest tests.test_account_writer tests.test_managed_margin_transfer tests.test_workspace tests.test_server_security tests.test_server_runtime tests.test_hub_summary tests.test_transfer_account_snapshot tests.test_pair_margin_independent tests.test_pair_margin_only_switch tests.test_pair_margin tests.test_pair_margin_status tests.test_pair_margin_bounded_recovery tests.test_pair_margin_budget_wait tests.test_pair_margin_ws tests.test_bounded_recovery tests.test_recovery_engine tests.test_pair_bounded_recovery tests.test_pair_reality_backoff tests.test_pair_late_receipt_recovery tests.test_pair_recovery_budget tests.test_pair_unknown_observation tests.test_pair_submit_evidence tests.test_pair_order_recovery tests.test_pair_manual_baseline tests.test_pair_recovery_check tests.test_ws_evidence tests.test_pair_ws_reconciliation tests.test_pair_trading tests.test_pair_position_scope tests.test_pair_archived_baseline tests.test_pair_paused_adoption tests.test_pair_symbol_api tests.test_pair_symbol_change tests.test_pair_symbol_history tests.test_pair_symbol_watch tests.test_pair_symbols_runtime tests.test_pair_market_symbols tests.test_pair_upgrade_capacity tests.test_opening_messages tests.test_risk_scenarios tests.test_cycle_engine tests.test_cycle_execution tests.test_migration_engine tests.test_migration_execution -q)
  (cd "$work_dir/source/modules/aster"; run_as_service "$test_root/python-aster/bin/python" -m unittest tests.test_monitoring_settings tests.test_monitoring_migration tests.test_listing_alerts tests.test_listings tests.test_capacity_notification_samples tests.test_capacity_relay_integration tests.test_public_data_sharing tests.test_hourly_summary tests.test_hourly_notification_engine tests.test_feishu_summary_cards -q)
  (cd "$work_dir/source/modules/aster"; run_as_service "$test_root/python-aster/bin/python" -m unittest tests.test_adl_config tests.test_adl_pair_config tests.test_adl_api tests.test_adl_view tests.test_adl_events tests.test_adl_exchange tests.test_adl_budget tests.test_adl_controller tests.test_adl_recovery tests.test_adl_liveness tests.test_adl_notifications tests.test_adl_integration tests.test_adl_monitoring tests.test_adl_workspace -q)
}
prepare_build_cache_helper
workspace_start_job python-setup/tests workspace_python_checks
workspace_start_job frontend-checks/builds workspace_frontend_checks
workspace_wait_jobs
# The frontend lane published verified artifacts and its stamp to disk. This is
# the only in-memory prepare_module_builds result needed by prepare_application.
modules_prepared=1
stage_started=$SECONDS
(cd "$work_dir/source"; run_as_service "$NODE_BIN" -e 'await import("./server/app.mjs")')
(cd "$work_dir/source"; run_as_service env GREEKS_PYTHON="$test_root/python/bin/python" ASTER_PYTHON="$test_root/python-aster/bin/python" "$NODE_BIN" "$PNPM_BIN" test)
printf '[workspace] root-behavior-tests: %ss\n' "$((SECONDS - stage_started))"
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
isolated_package_check() {
  # Real restored workers may read stale notification configuration. A separate
  # network namespace allows their loopback/private IPC, with no outside route.
  unshare --net -- bash -c 'ip link set dev lo up; exec runuser -u "$1" -- env GREEKS_PYTHON="$2" ASTER_PYTHON="$3" "$4" "$5" "$6"' \
    recovery-drill "$SERVICE_USER" "$test_root/python/bin/python" "$test_root/python-aster/bin/python" "$NODE_BIN" "$repository/deploy/test-package.mjs" "$1"
}
isolated_package_check "$release"
printf '[workspace] source-assembly-and-package-check: %ss\n' "$((SECONDS - stage_started))"
[[ -s "$work_dir/source/dist/index.html" && -d "$work_dir/source/node_modules/.vite-temp" && ! -L "$work_dir/source/node_modules/.vite-temp" ]]
for importer in . modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
  [[ ! -d "$dependencies/$importer/node_modules/.vite-temp" ]]
done
[[ "$(sha256sum "$dependencies/node_modules/.modules.yaml" | cut -d ' ' -f 1)" == "$cache_modules_hash" ]]
printf 'Real non-root build and backend import passed with immutable shared dependencies.\n'

if [[ ${INSTALL_TEST_PACKAGE:-0} == 1 ]]; then
  stage_started=$SECONDS
  python3 "$repository/deploy/package-release.py" --source "$work_dir/source" --dependency-root "$dependencies" --node "$NODE_BIN" --parser-user "$SERVICE_USER" --repository "$repository" --output "$repository/output/release"
  mkdir "$test_root/package"
  tar -xzf "$repository/output/release/"*-linux-*.tar.gz -C "$test_root/package"
  isolated_package_check "$test_root/package"
  printf '[workspace] archive-and-unpack-check: %ss\n' "$((SECONDS - stage_started))"
fi

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
