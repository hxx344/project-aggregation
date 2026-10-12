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
NPM_BIN="$(dirname "$NODE_BIN")/npm"
work_dir="$test_root/work"
dependencies="$test_root/dependencies"
mkdir -p "$APP_DIR/build-home" "$work_dir" "$dependencies"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/build-home"
git -c safe.directory="$repository" -c safe.directory="$repository/.git" clone -q --bare "$repository" "$APP_DIR/repository.git"
commit=$(git --git-dir="$APP_DIR/repository.git" rev-parse HEAD)
cp -a --reflink=auto "$repository/node_modules" "$dependencies/node_modules"
chown -R root:root "$dependencies"
chmod -R go-w "$dependencies"
touch "$dependencies/.complete"
prepare_workspace
[[ ! -L "$work_dir/source/node_modules" && -L "$work_dir/source/node_modules/react" ]]
if runuser -u "$SERVICE_USER" -- test -w "$dependencies/node_modules/react/package.json"; then
  echo 'The build account can modify shared packages' >&2; exit 1
fi
(cd "$work_dir/source"; run_as_service "$NODE_BIN" "$NPM_BIN" run check)
(cd "$work_dir/source"; run_as_service "$NODE_BIN" "$NPM_BIN" run install:modules)
(cd "$work_dir/source"; run_as_service "$NODE_BIN" "$NPM_BIN" run build:modules)
(cd "$work_dir/source"; run_as_service "$NODE_BIN" -e 'await import("./server/app.mjs")')
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$test_root/python"
run_as_service "${INSTALL_TEST_PYTHON:-/usr/bin/python3}" -m venv "$test_root/python"
run_as_service "$test_root/python/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$work_dir/source/modules/greeks/requirements.lock"
(cd "$work_dir/source"; run_as_service env GREEKS_PYTHON="$test_root/python/bin/python" "$NODE_BIN" "$NPM_BIN" test)
(cd "$work_dir/source"; run_as_service env NODE_ENV=production "$NODE_BIN" "$NPM_BIN" run build:bundle)
[[ -s "$work_dir/source/dist/index.html" && -d "$work_dir/source/node_modules/.vite-temp" && ! -L "$work_dir/source/node_modules/.vite-temp" ]]
[[ ! -d "$dependencies/node_modules/.vite-temp" ]]
printf 'Real non-root build and backend import passed with immutable shared dependencies.\n'

if [[ ${INSTALL_TEST_PACKAGE:-0} == 1 ]]; then
  python3 "$repository/deploy/package-release.py" --source "$work_dir/source" --repository "$repository" --output "$repository/output/release"
  mkdir "$test_root/package"
  tar -xzf "$repository/output/release/"*-linux-*.tar.gz -C "$test_root/package"
  run_as_service env GREEKS_PYTHON="$test_root/python/bin/python" "$NODE_BIN" "$repository/deploy/test-package.mjs" "$test_root/package"
fi
