#!/usr/bin/env bash
# Exact git provenance runs on native Git Bash; Linux additionally verifies UID/modes.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/install.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
APP_DIR="$fixture/application"
work_dir="$fixture/work"
mkdir -p "$APP_DIR" "$work_dir/source/modules/greeks" "$fixture/repository/modules/greeks"
git -C "$fixture/repository" init -q -b main
git -C "$fixture/repository" config user.name fixture
git -C "$fixture/repository" config user.email fixture@example.invalid
printf 'trusted-package==1.0 --hash=sha256:trusted\n' > "$fixture/repository/modules/greeks/requirements.lock"
git -C "$fixture/repository" add .
git -C "$fixture/repository" commit -qm pinned
git clone -q --bare "$fixture/repository" "$APP_DIR/repository.git"
commit=$(git -C "$fixture/repository" rev-parse HEAD)
printf '/tmp/service-controlled/evil.tar.gz --hash=sha256:valid-attacker-hash\n' > "$work_dir/source/modules/greeks/requirements.lock"
original_safe_path=$(declare -f updater_safe_path)
original_prepare=$(declare -f prepare_greeks_runtime)
if [[ $(uname -s) != Linux ]]; then
  updater_safe_path() { :; } # Windows has no Unix UID/mode semantics.
else
  [[ $EUID == 0 ]] || { echo 'Run the Linux ownership fixture through sudo.' >&2; exit 1; }
fi
prepare_greeks_runtime() {
  [[ "$1" == "$work_dir/python-lock" ]]
  cmp "$1/modules/greeks/requirements.lock" "$fixture/repository/modules/greeks/requirements.lock"
  if grep -q service-controlled "$1/modules/greeks/requirements.lock"; then return 99; fi
}
prepare_source_greeks_runtime
# A changed build workspace still cannot change the selected requirements.
printf -- '--requirement /tmp/evil.txt\n' > "$work_dir/source/modules/greeks/requirements.lock"
prepare_source_greeks_runtime
printf 'Pinned Greeks requirements ignore both malicious workspace variants.\n'

if [[ $(uname -s) == Linux ]]; then
  eval "$original_prepare"
  rejected() { if prepare_greeks_runtime "$1"; then echo 'Untrusted Python install source accepted' >&2; exit 1; fi; }
  # Failures occur before Python/pip/cache preparation; no package installation runs.
  chmod 0777 "$work_dir/source"
  rejected "$work_dir/source"
  chmod 0755 "$work_dir/source"
  chown 65534 "$work_dir/source/modules/greeks/requirements.lock"
  rejected "$work_dir/source"
  chown 0 "$work_dir/source/modules/greeks/requirements.lock"
  chmod 0666 "$work_dir/source/modules/greeks/requirements.lock"
  rejected "$work_dir/source"
  chmod 0644 "$work_dir/source/modules/greeks/requirements.lock"
  mv "$work_dir/source/modules/greeks/requirements.lock" "$fixture/untrusted.lock"
  ln -s "$fixture/untrusted.lock" "$work_dir/source/modules/greeks/requirements.lock"
  rejected "$work_dir/source"
  [[ ! -e "$APP_DIR/python" ]]
  updater_safe_path "$work_dir/python-lock/modules/greeks/requirements.lock"
  printf 'Root-owned pinned lock accepted; writable ancestry, leaf and symlink inputs rejected before pip.\n'
fi
