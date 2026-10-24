#!/usr/bin/env bash
# Linux CI helpers: no package installation, systemd changes, or network access.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/install.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
APP_DIR="$test_root/application"
mkdir -p "$APP_DIR/releases"
ENV_FILE="$test_root/environment"
printf 'HOST=127.0.0.1\nPORT=3100\n' > "$ENV_FILE"
[[ "$(read_setting HOST fallback)" == 127.0.0.1 ]]
[[ "$(read_setting DATA_DIR /var/lib/project-aggregation)" == /var/lib/project-aggregation ]]
[[ "$(health_url 0.0.0.0 3100)" == http://127.0.0.1:3100/api/health ]]
[[ "$(health_url :: 3100)" == http://\[::1\]:3100/api/health ]]
[[ "$(health_url ::1 3100)" == http://\[::1\]:3100/api/health ]]
mkdir "$test_root/first" "$test_root/second"
atomic_link "$test_root/first" "$APP_DIR/current"
atomic_link "$test_root/second" "$APP_DIR/current"
[[ "$(readlink "$APP_DIR/current")" == "$test_root/second" ]]
managed="$APP_DIR/releases/aaaaaaaaaaaa-bbbbbbbbbbbbbbbb"
unknown="$APP_DIR/releases/user-created"
mkdir "$managed" "$unknown"
touch "$managed/.managed-release" "$unknown/.managed-release"
safe_remove_release "$managed"
[[ ! -e "$managed" ]]
if safe_remove_release "$unknown"; then echo 'Unexpected acceptance of unknown release name' >&2; exit 1; fi
[[ -d "$unknown" ]]
outside="$test_root/cccccccccccc-dddddddddddddddd"
mkdir "$outside"
touch "$outside/.managed-release"
if safe_remove_release "$outside"; then echo 'Unexpected deletion outside releases' >&2; exit 1; fi
[[ -d "$outside" ]]
ln -s "$outside" "$APP_DIR/releases/eeeeeeeeeeee-ffffffffffffffff"
safe_remove_release "$APP_DIR/releases/eeeeeeeeeeee-ffffffffffffffff"
[[ -d "$outside" ]]

# Failed activation restores the previous app and unit; mocks never call real systemd.
mkdir -p "$APP_DIR/releases/111111111111-2222222222222222" "$APP_DIR/releases/333333333333-4444444444444444"
old_release="$APP_DIR/releases/111111111111-2222222222222222"
release="$APP_DIR/releases/333333333333-4444444444444444"
old_unit_backup="$test_root/previous.service"
UNIT_FILE="$test_root/current.service"
printf 'previous service\n' > "$old_unit_backup"
printf 'new service\n' > "$UNIT_FILE"
atomic_link "$release" "$APP_DIR/current"
systemctl() { printf '%s\n' "$*" >> "$test_root/systemctl.calls"; }
wait_healthy() { return 0; }
work_dir="$test_root/work"
mkdir "$work_dir"
remember_environment
prepare_environment_rollback
activation_started=1
set +e
( (exit 9); rollback )
rollback_status=$?
set -e
[[ "$rollback_status" == 9 ]]
[[ "$(readlink "$APP_DIR/current")" == "$old_release" ]]
cmp -s "$old_unit_backup" "$UNIT_FILE"
grep -q '^restart project-aggregation$' "$test_root/systemctl.calls"

# Cache pruning keeps every entry that the active or rollback releases still use.
key() { printf '%064d' "$1"; }
cache="$APP_DIR/cache"
mkdir -p "$cache/archives" "$APP_DIR/python" "$APP_DIR/python-aster"
PROJECT_DEPLOY_MODE=source
dependency_key=$(key 1) runtime_dependency_key=$(key 2) build_key=$(key 3) embedded_key=$(key 6)
module_build_keys=([monitor]=$(key 7))
for name in "dependencies-$(key 1)" "dependencies-$(key 11)" "runtime-dependencies-$(key 2)" "runtime-dependencies-$(key 12)" \
    "runtime-dependencies-$(key 13)" "runtime-dependencies-$(key 14)" "build-$(key 3)" "build-$(key 13)" "embedded-$(key 6)" \
    "embedded-$(key 16)" "module-monitor-$(key 7)" "module-monitor-$(key 17)" ".build-$(key 3).tmp-abc123" \
    ".prune.embedded-$(key 26)" unrelated; do
  mkdir -p "$cache/$name/node_modules"
done
touch "$cache/typechecked-$(key 4)" "$cache/tested-$(key 15)"
release="$APP_DIR/releases/555555555555-6666666666666666"
previous_release="$APP_DIR/releases/777777777777-8888888888888888"
old_release=$previous_release
mkdir -p "$release/modules/asset" "$previous_release"
printf '%s\n' "$(key 2)" > "$release/.runtime-dependency-key"
ln -s "$cache/runtime-dependencies-$(key 2)/node_modules" "$release/modules/asset/node_modules"
printf '%s\n' "$(key 12)" > "$previous_release/.runtime-dependency-key"
# Older installer revisions linked dependencies without writing a marker.
ln -s "$cache/runtime-dependencies-$(key 13)/node_modules" "$previous_release/node_modules"
atomic_link "$release" "$APP_DIR/current"
atomic_link "$previous_release" "$APP_DIR/previous"
CI_RELEASE_SHA256=$(key 31)
touch "$cache/archives/$(key 31).tar.gz" "$cache/archives/$(key 32).tar.gz" "$cache/archives/.$(key 32).lock"
mkdir "$cache/archives/.$(key 33).parts"
work_dir="$APP_DIR/.install.Keep0000"
mkdir "$work_dir" "$APP_DIR/.install.AbCd1234" "$APP_DIR/.install.Zz999999"
GREEKS_PYTHON_PATH="$APP_DIR/python/$(key 21)/bin/python"
ASTER_PYTHON_PATH=/usr/bin/python3
mkdir -p "$APP_DIR/python/$(key 21)" "$APP_DIR/python/$(key 22)" "$APP_DIR/python/$(key 23)" "$APP_DIR/python/$(key 25)" \
  "$APP_DIR/python-aster/$(key 24)"
printf '%s\n' "$APP_DIR/python/$(key 22)/bin/python" > "$work_dir/previous-greeks-python-path"
# A version switch records the replaced interpreters, including an absent one, for the new rollback release.
previous_target=$(realpath -e "$previous_release")
remember_previous_python_paths "$previous_release"
[[ "$(cat "$APP_DIR/.previous-greeks-python-path")" == "$previous_target"$'\n'"$APP_DIR/python/$(key 22)/bin/python" ]]
[[ "$(cat "$APP_DIR/.previous-aster-python-path")" == "$previous_target" ]]
# The durable record outlives the work directory of the run that wrote it.
printf '%s\n%s\n' "$previous_target" "$APP_DIR/python/$(key 25)/bin/python" > "$APP_DIR/.previous-greeks-python-path"
(
  trap 'echo "Pruning triggered the installer ERR trap" >&2; exit 97' ERR
  prune_caches || exit 3
)
for name in "dependencies-$(key 1)" "runtime-dependencies-$(key 2)" "runtime-dependencies-$(key 12)" "runtime-dependencies-$(key 13)" \
    "build-$(key 3)" "embedded-$(key 6)" "module-monitor-$(key 7)" unrelated "typechecked-$(key 4)" "tested-$(key 15)" \
    "archives/$(key 31).tar.gz"; do
  [[ -e "$cache/$name" ]] || { echo "Pruning removed a referenced entry: $name" >&2; exit 1; }
done
for name in "dependencies-$(key 11)" "runtime-dependencies-$(key 14)" "build-$(key 13)" "embedded-$(key 16)" "module-monitor-$(key 17)" \
    ".build-$(key 3).tmp-abc123" ".prune.embedded-$(key 26)" "archives/$(key 32).tar.gz" "archives/.$(key 32).lock" \
    "archives/.$(key 33).parts"; do
  [[ ! -e "$cache/$name" ]] || { echo "Pruning kept an unused entry: $name" >&2; exit 1; }
done
[[ -d "$APP_DIR/python/$(key 21)" && -d "$APP_DIR/python/$(key 22)" && -d "$APP_DIR/python/$(key 25)" && ! -e "$APP_DIR/python/$(key 23)" ]]
[[ -d "$APP_DIR/python-aster/$(key 24)" ]] # An unmanaged active interpreter leaves its directory untouched.
[[ -d "$work_dir" && ! -e "$APP_DIR/.install.AbCd1234" && ! -e "$APP_DIR/.install.Zz999999" ]]
[[ -z $(find "$APP_DIR" -name '.prune.*' -print -quit) ]]
# A record left for another release, such as after an interrupted switch, says nothing about the
# current rollback release; neither does a missing record, so every environment stays.
rm "$work_dir/previous-greeks-python-path"
mkdir "$APP_DIR/python/$(key 23)"
printf '%s\n%s\n' "$release" "$APP_DIR/python/$(key 25)/bin/python" > "$APP_DIR/.previous-greeks-python-path"
prune_caches
[[ -d "$APP_DIR/python/$(key 22)" && -d "$APP_DIR/python/$(key 23)" && -d "$APP_DIR/python/$(key 25)" ]]
rm "$APP_DIR/.previous-greeks-python-path"
prune_caches
[[ -d "$APP_DIR/python/$(key 22)" && -d "$APP_DIR/python/$(key 23)" && -d "$APP_DIR/python/$(key 25)" ]]

# A failed removal is reported without the ERR trap and keeps the entry under its original key.
mkdir "$cache/embedded-$(key 36)"
set +e
(
  trap 'exit 97' ERR
  mv() { return 1; }
  prune_caches || exit 3
)
prune_status=$?
set -e
[[ "$prune_status" == 3 && -d "$cache/embedded-$(key 36)" ]]
# CI deployments never compute source keys, so source caches stay for a later source deployment.
PROJECT_DEPLOY_MODE=ci
prune_caches
[[ -d "$cache/embedded-$(key 36)" ]]
printf 'Installer helper and cache pruning checks passed.\n'
