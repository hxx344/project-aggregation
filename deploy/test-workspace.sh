#!/usr/bin/env bash
# Real, unprivileged TypeScript/Vite build and runtime import against immutable packages.
set -Eeuo pipefail
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
AGG_INSTALL_SOURCE_ONLY=1 source "$repository/deploy/install.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
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
dependencies="$test_root/dependencies"
mkdir -p "$APP_DIR/build-home" "$work_dir" "$dependencies"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/build-home"
git -c safe.directory="$repository" -c safe.directory="$repository/.git" clone -q --bare "$repository" "$APP_DIR/repository.git"
commit=$(git --git-dir="$APP_DIR/repository.git" rev-parse HEAD)
cp -a --reflink=auto "$repository/node_modules" "$dependencies/node_modules"
for importer in monitor asset crossex aster/dashboard; do
  mkdir -p "$dependencies/modules/$importer"
  cp -a --reflink=auto "$repository/modules/$importer/node_modules" "$dependencies/modules/$importer/node_modules"
done
chown -R root:root "$dependencies"
chmod -R go-w "$dependencies"
dependency_key=fixture-workspace
printf '%s\n' "$dependency_key" > "$dependencies/.complete"
cache_modules_hash=$(sha256sum "$dependencies/node_modules/.modules.yaml" | cut -d ' ' -f 1)
prepare_workspace
for importer in . modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
  [[ ! -L "$work_dir/source/$importer/node_modules" && -L "$work_dir/source/$importer/node_modules/react" ]]
  if run_as_service test -w "$dependencies/$importer/node_modules/react/package.json"; then
    echo 'The build account can modify shared packages' >&2; exit 1
  fi
  run_as_service test -w "$work_dir/source/$importer/node_modules"
done

# ========== OPTIMIZED PARALLEL EXECUTION ==========
# Phase 1: Parallel static checks (no dependencies)
printf '=== Phase 1: Running static checks in parallel ===\n'
check_failed=0
(cd "$work_dir/source"; run_as_service "$NODE_BIN" "$PNPM_BIN" run check) &
check_pid=$!
(cd "$work_dir/source/modules/aster/dashboard"; run_as_service "$NODE_BIN" "$PNPM_BIN" run typecheck) &
typecheck_pid=$!
(cd "$work_dir/source/modules/aster/dashboard"; run_as_service "$NODE_BIN" "$PNPM_BIN" run lint) &
lint_pid=$!

wait $check_pid || check_failed=1
wait $typecheck_pid || check_failed=1
wait $lint_pid || check_failed=1
[[ $check_failed == 0 ]] || { echo 'Static checks failed' >&2; exit 1; }
printf '✓ Static checks passed\n\n'

# Phase 2: Parallel Python environment setup (independent)
printf '=== Phase 2: Setting up Python environments in parallel ===\n'
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$test_root/python"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$test_root/python-aster"

python_failed=0
(
  run_as_service "${INSTALL_TEST_PYTHON:-/usr/bin/python3}" -m venv "$test_root/python"
  run_as_service "$test_root/python/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$work_dir/source/modules/greeks/requirements.lock"
) &
greeks_pid=$!

(
  run_as_service "${INSTALL_TEST_PYTHON:-/usr/bin/python3}" -m venv "$test_root/python-aster"
  run_as_service "$test_root/python-aster/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$work_dir/source/modules/aster/requirements.lock"
) &
aster_pid=$!

wait $greeks_pid || python_failed=1
wait $aster_pid || python_failed=1
[[ $python_failed == 0 ]] || { echo 'Python environment setup failed' >&2; exit 1; }
printf '✓ Python environments ready\n\n'

# Phase 3: Build modules (required by subsequent steps)
printf '=== Phase 3: Building modules ===\n'
(cd "$work_dir/source"; run_as_service "$NODE_BIN" "$PNPM_BIN" run build:modules)
printf '✓ Modules built\n\n'

# Phase 4: Parallel tests and runtime checks (depend on build)
printf '=== Phase 4: Running tests in parallel ===\n'
test_failed=0
(cd "$work_dir/source"; run_as_service "$NODE_BIN" --test modules/aster/dashboard/tests/*.test.mjs) &
node_test_pid=$!
(cd "$work_dir/source"; run_as_service "$NODE_BIN" -e 'await import("./server/app.mjs")') &
import_pid=$!
(cd "$work_dir/source/modules/aster"; run_as_service "$test_root/python-aster/bin/python" -m unittest tests.test_workspace tests.test_server_security tests.test_server_runtime tests.test_pair_margin tests.test_pair_trading tests.test_pair_symbol_api tests.test_pair_symbols_runtime tests.test_pair_market_symbols tests.test_risk_scenarios tests.test_cycle_engine tests.test_cycle_execution tests.test_migration_engine tests.test_migration_execution -q) &
python_test_pid=$!

wait $node_test_pid || test_failed=1
wait $import_pid || test_failed=1
wait $python_test_pid || test_failed=1
[[ $test_failed == 0 ]] || { echo 'Tests failed' >&2; exit 1; }
printf '✓ Tests passed\n\n'

# Phase 5: Integration tests (requires all Python environments)
printf '=== Phase 5: Running integration tests ===\n'
(cd "$work_dir/source"; run_as_service env GREEKS_PYTHON="$test_root/python/bin/python" ASTER_PYTHON="$test_root/python-aster/bin/python" "$NODE_BIN" "$PNPM_BIN" test)
printf '✓ Integration tests passed\n\n'

# Phase 6: Production build (final step)
printf '=== Phase 6: Building production bundle ===\n'
(cd "$work_dir/source"; run_as_service env NODE_ENV=production "$NODE_BIN" "$PNPM_BIN" run build:bundle)
printf '✓ Production build complete\n\n'
# ========== END OPTIMIZED PARALLEL EXECUTION ==========

[[ -s "$work_dir/source/dist/index.html" && -d "$work_dir/source/node_modules/.vite-temp" && ! -L "$work_dir/source/node_modules/.vite-temp" ]]
for importer in . modules/monitor modules/asset modules/crossex modules/aster/dashboard; do
  [[ ! -d "$dependencies/$importer/node_modules/.vite-temp" ]]
done
[[ "$(sha256sum "$dependencies/node_modules/.modules.yaml" | cut -d ' ' -f 1)" == "$cache_modules_hash" ]]
printf 'Real non-root build and backend import passed with immutable shared dependencies.\n'

if [[ ${INSTALL_TEST_PACKAGE:-0} == 1 ]]; then
  python3 "$repository/deploy/package-release.py" --source "$work_dir/source" --dependency-root "$dependencies" --node "$NODE_BIN" --repository "$repository" --output "$repository/output/release"
  mkdir "$test_root/package"
  tar -xzf "$repository/output/release/"*-linux-*.tar.gz -C "$test_root/package"
  run_as_service env GREEKS_PYTHON="$test_root/python/bin/python" ASTER_PYTHON="$test_root/python-aster/bin/python" "$NODE_BIN" "$repository/deploy/test-package.mjs" "$test_root/package"
fi
