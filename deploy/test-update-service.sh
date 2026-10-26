#!/usr/bin/env bash
# Linux fixture: real ownership/modes/Unix sockets, mocked systemd; no network or apt.
set -Eeuo pipefail
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run this fixture with sudo on Linux (not WSL).' >&2; exit 1; }
umask 022
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/install.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
SERVICE_USER=root
case_root= active_file= enabled_file= unknown_fragment= unknown_dropins= fail_reload=0
fresh_case() {
  case_root="$fixture/$1"
  mkdir -p "$case_root/release/server/update-service" "$case_root/lib" "$case_root/var" "$case_root/run" "$case_root/units" "$case_root/work"
  chmod 0755 "$case_root" "$case_root/release" "$case_root/release/server" "$case_root/release/server/update-service"
  printf 'verified-release\n' > "$case_root/release/.managed-release"
  printf 'print("fixture updater")\n' > "$case_root/release/server/update-service/updater.py"
  printf 'MODULES = ()\n' > "$case_root/release/server/update-service/registry.py"
  printf 'RELEASE = "stable"\n' > "$case_root/release/server/update-service/releases.py"
  printf 'def get_progress(*args): return None\n' > "$case_root/release/server/update-service/progress.py"
  printf 'EXTRA = True\n' > "$case_root/release/server/update-service/utility.py"
  printf 'not a runtime file\n' > "$case_root/release/server/update-service/README.txt"
  chmod 0644 "$case_root/release/.managed-release" "$case_root/release/server/update-service/"*
  UPDATER_DIR="$case_root/lib/updater"
  UPDATER_STATE_DIR="$case_root/var/updater"
  UPDATER_RUN_DIR="$case_root/run/updater"
  UPDATER_UNIT_FILE="$case_root/units/updater.service"
  UPDATER_WORKER_UNIT_FILE="$case_root/units/worker.service"
  work_dir="$case_root/work"
  active_file="$case_root/api-active"
  enabled_file="$case_root/api-enabled"
  unknown_fragment= unknown_dropins= fail_reload=0
  : > "$case_root/systemctl.calls"
  printf 'worker remains active\n' > "$case_root/worker-active"
}
systemctl() {
  printf '%s\n' "$*" >> "$case_root/systemctl.calls"
  local name=${@: -1}
  case "$1" in
    show)
      case "$2" in
        --property=FragmentPath)
          if [[ -n "$unknown_fragment" ]]; then printf '%s\n' "$unknown_fragment"
          elif [[ "$name" == "$UPDATER_SERVICE" && -f "$UPDATER_UNIT_FILE" ]]; then printf '%s\n' "$UPDATER_UNIT_FILE"
          elif [[ "$name" == "$UPDATER_WORKER_SERVICE" && -f "$UPDATER_WORKER_UNIT_FILE" ]]; then printf '%s\n' "$UPDATER_WORKER_UNIT_FILE"; fi ;;
        --property=DropInPaths) printf '%s' "$unknown_dropins" ;;
        *) return 91 ;;
      esac ;;
    daemon-reload) [[ "$fail_reload" == 0 ]] ;;
    is-enabled) [[ "$name" == "$UPDATER_SERVICE" && -f "$enabled_file" ]] ;;
    is-active) [[ "$name" == "$UPDATER_SERVICE" && -f "$active_file" ]] ;;
    enable) [[ "$name" == "$UPDATER_SERVICE" ]] && touch "$enabled_file" ;;
    start|restart) [[ "$name" == "$UPDATER_SERVICE" ]] && touch "$active_file" ;;
    *) printf 'Unexpected service mutation: %s\n' "$*" >&2; return 92 ;;
  esac
}
count() { grep -c "^$1$" "$case_root/systemctl.calls" || true; }
expect_rejected() {
  if ensure_update_service "$case_root/release"; then echo "Unsafe fixture accepted: $1" >&2; exit 1; fi
}
no_worker_mutations() {
  [[ $(cat "$case_root/worker-active") == 'worker remains active' ]]
  if grep -Eq "^(start|stop|restart|enable|disable|try-restart|reload) $UPDATER_WORKER_SERVICE$" "$case_root/systemctl.calls"; then
    echo 'Installer interrupted or enabled the worker' >&2; exit 1
  fi
}

fresh_case lifecycle
ensure_update_service "$case_root/release"
[[ $(stat -c '%u:%g:%a' "$UPDATER_DIR") == 0:0:755 ]]
[[ $(stat -c '%u:%g:%a' "$UPDATER_STATE_DIR") == 0:0:700 ]]
[[ $(stat -c '%u:%g:%a' "$UPDATER_RUN_DIR") == 0:0:750 ]]
[[ $(stat -c '%u:%g:%a' "$UPDATER_DIR/updater.py") == 0:0:644 ]]
[[ $(stat -c '%u:%g:%a' "$UPDATER_DIR/progress.py") == 0:0:644 ]]
[[ -f "$UPDATER_DIR/utility.py" && ! -e "$UPDATER_DIR/README.txt" ]]
[[ $(count daemon-reload) == 1 && $(count "start $UPDATER_SERVICE") == 1 && $(count "enable $UPDATER_SERVICE") == 1 ]]
grep -qx "ExecStart=/usr/bin/python3 -I $UPDATER_DIR/updater.py serve" "$UPDATER_UNIT_FILE"
grep -qx 'NoNewPrivileges=true' "$UPDATER_UNIT_FILE"
grep -qx 'ProtectSystem=strict' "$UPDATER_UNIT_FILE"
grep -qx 'ProtectHome=true' "$UPDATER_UNIT_FILE"
grep -qx "ReadWritePaths=$UPDATER_STATE_DIR $UPDATER_RUN_DIR" "$UPDATER_UNIT_FILE"
grep -qx 'Type=oneshot' "$UPDATER_WORKER_UNIT_FILE"
grep -qx "ExecStart=/usr/bin/python3 -I $UPDATER_DIR/updater.py run" "$UPDATER_WORKER_UNIT_FILE"
! grep -q '^\[Install\]' "$UPDATER_WORKER_UNIT_FILE"
printf '{"schema":1,"token":"github_pat_fixture_preserved_by_upgrade"}\n' > "$UPDATER_STATE_DIR/credentials.json"
chmod 0600 "$UPDATER_STATE_DIR/credentials.json"
credentials_hash=$(sha256sum "$UPDATER_STATE_DIR/credentials.json")
inode=$(stat -c %i "$UPDATER_DIR/updater.py")
ensure_update_service "$case_root/release"
[[ $(stat -c %i "$UPDATER_DIR/updater.py") == "$inode" ]]
[[ $(sha256sum "$UPDATER_STATE_DIR/credentials.json") == "$credentials_hash" ]]
[[ $(stat -c '%u:%g:%a' "$UPDATER_STATE_DIR/credentials.json") == 0:0:600 ]]
[[ $(count daemon-reload) == 1 && $(count "start $UPDATER_SERVICE") == 1 && $(count "restart $UPDATER_SERVICE") == 0 && $(count "enable $UPDATER_SERVICE") == 1 ]]

# A root-owned live/stale socket is the only allowed runtime entry.
python3 - "$UPDATER_RUN_DIR/control.sock" <<'SOCKET'
import os, socket, sys
with socket.socket(socket.AF_UNIX) as endpoint:
    endpoint.bind(sys.argv[1])
os.chmod(sys.argv[1], 0o660)
SOCKET
printf '# changed application\n' >> "$case_root/release/server/update-service/updater.py"
ensure_update_service "$case_root/release"
[[ $(count "restart $UPDATER_SERVICE") == 1 && $(count daemon-reload) == 2 ]]
[[ $(sha256sum "$UPDATER_STATE_DIR/credentials.json") == "$credentials_hash" ]]
[[ $(stat -c '%u:%g:%a' "$UPDATER_STATE_DIR/credentials.json") == 0:0:600 ]]
no_worker_mutations
rm -- "$active_file"
ensure_update_service "$case_root/release"
[[ $(count "start $UPDATER_SERVICE") == 2 && $(count "restart $UPDATER_SERVICE") == 1 && $(count daemon-reload) == 2 ]]

# A failed systemd reload cannot be mistaken for a completed identical upgrade.
printf '# another revision\n' >> "$case_root/release/server/update-service/releases.py"
fail_reload=1
expect_rejected 'failed systemd reload'
[[ $(count "restart $UPDATER_SERVICE") == 1 ]]
fail_reload=0
ensure_update_service "$case_root/release"
[[ $(count daemon-reload) == 4 && $(count "restart $UPDATER_SERVICE") == 2 ]]
no_worker_mutations

fresh_case unknown-directory
mkdir "$UPDATER_DIR"
printf 'keep\n' > "$UPDATER_DIR/user-data"
expect_rejected 'unknown code directory'
[[ $(cat "$UPDATER_DIR/user-data") == keep && ! -e "$UPDATER_STATE_DIR" ]]

fresh_case unknown-state
mkdir "$UPDATER_STATE_DIR"
expect_rejected 'unknown state directory'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case unknown-runtime
mkdir "$UPDATER_RUN_DIR"
expect_rejected 'unknown runtime directory'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case incomplete
rm -- "$case_root/release/server/update-service/registry.py"
expect_rejected 'incomplete release'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case incomplete-progress
rm -- "$case_root/release/server/update-service/progress.py"
expect_rejected 'missing progress dependency'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case invalid-python
printf 'this is invalid python !\n' > "$case_root/release/server/update-service/registry.py"
expect_rejected 'invalid Python source'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case source-symlink
mv -- "$case_root/release/server/update-service/registry.py" "$case_root/registry-original.py"
ln -s "$case_root/registry-original.py" "$case_root/release/server/update-service/registry.py"
expect_rejected 'source symlink'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case parent-symlink
mkdir "$case_root/outside"
rm -d -- "$case_root/lib"
ln -s "$case_root/outside" "$case_root/lib"
expect_rejected 'symlink ancestor'
[[ -z $(ls -A "$case_root/outside") ]]

fresh_case target-symlink
ensure_update_service "$case_root/release"
printf 'keep original\n' > "$case_root/outside.py"
rm -- "$UPDATER_DIR/updater.py"
ln -s "$case_root/outside.py" "$UPDATER_DIR/updater.py"
expect_rejected 'target symlink'
[[ $(cat "$case_root/outside.py") == 'keep original' ]]
no_worker_mutations

fresh_case writable-source
chmod 0664 "$case_root/release/server/update-service/registry.py"
expect_rejected 'group-writable source'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case foreign-owner
chown 65534 "$case_root/release/server/update-service/registry.py"
expect_rejected 'non-root source owner'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case unknown-unit
printf '[Service]\nExecStart=/custom/user-program\n' > "$UPDATER_UNIT_FILE"
expect_rejected 'unknown service unit'
grep -qx 'ExecStart=/custom/user-program' "$UPDATER_UNIT_FILE"
[[ ! -e "$UPDATER_DIR" ]]

fresh_case alternate-unit
unknown_fragment=/usr/lib/systemd/system/unrelated.service
expect_rejected 'service loaded from another location'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case unit-dropin
unknown_dropins=/etc/systemd/system/project-aggregation-updater.service.d/custom.conf
expect_rejected 'unknown service override'
[[ ! -e "$UPDATER_DIR" ]]

fresh_case legacy-release
rm -- "$case_root/release/server/update-service/"*
rmdir "$case_root/release/server/update-service"
ensure_update_service "$case_root/release"
[[ ! -e "$UPDATER_DIR" && ! -s "$case_root/systemctl.calls" ]]

# Exercise the producer and privileged consumer together. Git archives carry
# 0775/0664 by default, and root tar preserves them even with umask 022.
fresh_case source-publication
repository=$(cd -- "$(dirname "$0")/.." && pwd)
APP_DIR="$case_root/application"
source_dir="$case_root/source"
mkdir -p "$APP_DIR/releases" "$APP_DIR/cache" "$source_dir/server/update-service" "$source_dir/deploy" "$source_dir/dist"
cp "$case_root/release/server/update-service/"*.py "$source_dir/server/update-service/"
cp "$repository/deploy/build-artifact-cache.py" "$source_dir/deploy/build-artifact-cache.py"
mkdir -p "$source_dir/tools/entropy-lighter-lab"
cp "$repository"/tools/entropy-lighter-lab/{cli.mjs,core.mjs,feeds.mjs,config.example.json} "$source_dir/tools/entropy-lighter-lab/"
printf '{"name":"source-permission-fixture"}\n' > "$source_dir/package.json"
printf '#!/bin/sh\nexit 0\n' > "$source_dir/server/executable.sh"
chmod 0755 "$source_dir/server/executable.sh"
printf '<html>verified cached build</html>\n' > "$source_dir/dist/index.html"
git -C "$source_dir" init -q -b main
git -C "$source_dir" config user.name fixture
git -C "$source_dir" config user.email fixture@example.invalid
git -C "$source_dir" add server package.json deploy tools
git -C "$source_dir" commit -qm source-permission-fixture
git clone -q --bare "$source_dir" "$APP_DIR/repository.git"
git --git-dir="$APP_DIR/repository.git" config tar.umask 0002
commit=$(git -C "$source_dir" rev-parse HEAD)
runtime_key=fixture-runtime
build_environment=fixture-build-environment
RUNTIME_DEPENDENCIES=0
PROJECT_DEPLOY_TESTS=0
input_keys
prepare_build_cache_helper
build_artifact_cache store "$source_dir/dist" "$built" "$build_key"
atomic_record "$typecheck_stamp" "$typecheck_key"
cache_inode=$(stat -c %i "$built/artifact/index.html")
prepare_workspace() { echo 'Cached source publication unexpectedly requested a build workspace' >&2; return 1; }

# Reproduce a prior install that became healthy before updater bootstrap failed.
# Its packaging key must no longer qualify for the current-release fast path.
runtime_tree=$(tree_hash server package.json deploy/migrate-modules.py)
legacy_key=$(printf 'application-v3\n%s\n%s\n%s\n%s' "$runtime_tree" "$build_key" "$embedded_key" "$RUNTIME_DEPENDENCIES" | hash)
old_release="$APP_DIR/releases/${commit:0:12}-${legacy_key:0:16}"
mkdir "$old_release"
git --git-dir="$APP_DIR/repository.git" archive "$commit" server package.json | tar -x -C "$old_release"
mkdir "$old_release/dist"
cp "$source_dir/dist/index.html" "$old_release/dist/index.html"
atomic_record "$old_release/.managed-release" "$commit"
atomic_record "$old_release/.source-sha" "$commit"
atomic_record "$old_release/.application-key" "$legacy_key"
atomic_record "$old_release/.install-ready" "$legacy_key"
[[ $(stat -c %a "$old_release/server/update-service") == 775 ]]
[[ $(stat -c %a "$old_release/server/update-service/updater.py") == 664 ]]
if application_ready; then echo 'Legacy writable source release was reused' >&2; exit 1; fi
legacy_release=$old_release

prepare_application
[[ "$release" != "$legacy_release" && $(stat -c %a "$legacy_release/server/update-service") == 775 ]]
[[ $(stat -c '%u:%g:%a' "$release/server/update-service") == 0:0:755 ]]
[[ $(stat -c '%u:%g:%a' "$release/server/update-service/updater.py") == 0:0:644 ]]
[[ $(stat -c '%u:%g:%a' "$release/server/executable.sh") == 0:0:755 ]]
finish_update_service "$release"
[[ -f "$UPDATER_DIR/.service-ready" && $(count "start $UPDATER_SERVICE") == 1 ]]
no_worker_mutations
atomic_record "$release/.install-ready" "$application_key"
old_release=$release
ready_release=$release
inode=$(stat -c %i "$UPDATER_DIR/updater.py")
prepare_application
finish_update_service "$release"
[[ "$release" == "$ready_release" && $(stat -c %i "$UPDATER_DIR/updater.py") == "$inode" ]]
[[ $(stat -c %i "$built/artifact/index.html") == "$cache_inode" ]]
[[ $(count "start $UPDATER_SERVICE") == 1 && $(count "restart $UPDATER_SERVICE") == 0 ]]
[[ $(find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d | wc -l) == 2 ]]

# A later candidate with writable updater sources is rejected without changing
# permissions or copying its code into the privileged updater installation.
chmod 0775 "$ready_release/server/update-service"
old_release=
if prepare_application; then echo 'Writable existing source candidate was accepted' >&2; exit 1; fi
[[ $(stat -c %a "$ready_release/server/update-service") == 775 ]]
[[ $(stat -c %i "$UPDATER_DIR/updater.py") == "$inode" ]]
printf 'Update service ownership, isolation, idempotence, recovery and rejection fixtures passed.\n'
