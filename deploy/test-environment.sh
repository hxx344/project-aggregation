#!/usr/bin/env bash
# Regression: a failed PORT change must restore the previously healthy environment.
# The service and pointer operations are mocked; no real systemd or symlinks are needed.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/../install.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
APP_DIR="$test_root/application"
ENV_FILE="$test_root/environment"
UNIT_FILE="$test_root/current.service"
work_dir="$test_root/work"
mkdir -p "$APP_DIR/old-release" "$APP_DIR/new-release" "$work_dir"
old_release="$APP_DIR/old-release"
release="$APP_DIR/new-release"
old_unit_backup="$work_dir/previous.service"
printf 'previous service\n' > "$old_unit_backup"
printf 'candidate service\n' > "$UNIT_FILE"
printf 'HOST=127.0.0.1\nPORT=3100\nDATA_DIR=/var/lib/project-aggregation\n' > "$ENV_FILE"
cp "$ENV_FILE" "$test_root/expected-good.env"
remember_environment
if [[ "$(uname -s)" == Linux ]]; then [[ "$(stat -c %a "$APP_DIR/.last-successful.env")" == 600 ]]; fi
printf 'HOST=0.0.0.0\nPORT=4200\nDATA_DIR=/var/lib/project-aggregation\n' > "$ENV_FILE"
cp "$ENV_FILE" "$test_root/expected-candidate.env"
prepare_environment_rollback
HEALTH_URL=$(health_url 0.0.0.0 4200)
activation_started=1
atomic_link() { printf '%s\n' "$1" > "$test_root/current.target"; }
systemctl() {
  printf '%s\n' "$*" >> "$test_root/systemctl.calls"
  case "$1" in
    restart)
      if [[ "$(read_setting PORT 0)" != 3100 ]]; then return 1; fi
      printf 'running\n' > "$test_root/service.running"
      ;;
    is-active) [[ -f "$test_root/service.running" ]] ;;
    *) return 0 ;;
  esac
}
curl() {
  local requested="${@: -1}"
  printf '%s\n' "$requested" > "$test_root/health.request"
  [[ "$requested" == http://127.0.0.1:3100/api/health ]]
}
wait_healthy() { healthy; }
set +e
( systemctl restart "$SERVICE"; rollback )
rollback_status=$?
set -e
[[ "$rollback_status" == 1 ]]
cmp -s "$test_root/expected-good.env" "$ENV_FILE"
cmp -s "$test_root/expected-good.env" "$APP_DIR/.last-successful.env"
failed_candidates=("$ENV_FILE".failed-*)
[[ "${#failed_candidates[@]}" == 1 && -f "${failed_candidates[0]}" ]]
cmp -s "$test_root/expected-candidate.env" "${failed_candidates[0]}"
if [[ "$(uname -s)" == Linux ]]; then [[ "$(stat -c %a "${failed_candidates[0]}")" == 600 ]]; fi
[[ "$(cat "$test_root/current.target")" == "$old_release" ]]
[[ "$(cat "$test_root/health.request")" == http://127.0.0.1:3100/api/health ]]
cmp -s "$old_unit_backup" "$UNIT_FILE"

# A first installation has no successful snapshot: leave its user's environment intact.
APP_DIR="$test_root/first-install"
ENV_FILE="$test_root/first-environment"
UNIT_FILE="$test_root/first.service"
mkdir -p "$APP_DIR"
printf 'HOST=127.0.0.1\nPORT=4200\n' > "$ENV_FILE"
cp "$ENV_FILE" "$test_root/expected-first.env"
printf '# Managed by project-aggregation installer\n' > "$UNIT_FILE"
old_release=
old_unit_backup=
old_environment=
old_health_url=
set +e
( (exit 7); rollback )
rollback_status=$?
set -e
[[ "$rollback_status" == 7 ]]
cmp -s "$ENV_FILE" "$test_root/expected-first.env"
[[ ! -e "$APP_DIR/.last-successful.env" ]]
if compgen -G "$ENV_FILE.failed-*" >/dev/null; then echo 'First install should not rename user configuration' >&2; exit 1; fi

# If a prior app exists but its trustworthy snapshot is missing, fail before activation.
old_release="$test_root/application/old-release"
if prepare_environment_rollback; then echo 'Missing successful configuration was accepted' >&2; exit 1; fi
cmp -s "$ENV_FILE" "$test_root/expected-first.env"
printf 'Environment rollback regression checks passed.\n'
