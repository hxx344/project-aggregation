#!/usr/bin/env bash
# Linux CI helpers: no package installation, systemd changes, or network access.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/../install.sh"
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
printf 'Installer helper checks passed.\n'
