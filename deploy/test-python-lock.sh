#!/usr/bin/env bash
# Exact git provenance runs on native Git Bash; Linux additionally verifies UID/modes.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/install.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
APP_DIR="$fixture/application"
work_dir="$fixture/work"
mkdir -p "$APP_DIR" "$work_dir/source/modules/greeks" "$fixture/repository/modules/greeks" "$work_dir/source/modules/aster" "$fixture/repository/modules/aster"
git -C "$fixture/repository" init -q -b main
git -C "$fixture/repository" config user.name fixture
git -C "$fixture/repository" config user.email fixture@example.invalid
printf 'trusted-package==1.0 --hash=sha256:trusted\n' > "$fixture/repository/modules/greeks/requirements.lock"
printf 'aster-package==1.0 --hash=sha256:aster-trusted\n' > "$fixture/repository/modules/aster/requirements.lock"
git -C "$fixture/repository" add .
git -C "$fixture/repository" commit -qm pinned
git clone -q --bare "$fixture/repository" "$APP_DIR/repository.git"
commit=$(git -C "$fixture/repository" rev-parse HEAD)
printf '/tmp/service-controlled/evil.tar.gz --hash=sha256:valid-attacker-hash\n' > "$work_dir/source/modules/greeks/requirements.lock"
original_prepare=$(declare -f prepare_greeks_runtime)
original_prepare_aster=$(declare -f prepare_aster_runtime)
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
prepare_aster_runtime() {
  [[ "$1" == "$work_dir/python-lock" ]]
  cmp "$1/modules/aster/requirements.lock" "$fixture/repository/modules/aster/requirements.lock"
  if grep -q service-controlled "$1/modules/aster/requirements.lock"; then return 99; fi
}
for payload in '/tmp/service-controlled/evil.tar.gz --hash=sha256:valid-attacker-hash' '--requirement /tmp/evil.txt'; do
  printf '%s\n' "$payload" > "$work_dir/source/modules/aster/requirements.lock"
  prepare_source_aster_runtime
done
printf 'Pinned ASTER requirements ignore both malicious workspace variants.\n'

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
  eval "$original_prepare_aster"
  rejected_aster() { if prepare_aster_runtime "$1"; then echo 'Untrusted ASTER Python install source accepted' >&2; exit 1; fi; }
  chmod 0777 "$work_dir/source"
  rejected_aster "$work_dir/source"
  chmod 0755 "$work_dir/source"
  chown 65534 "$work_dir/source/modules/aster/requirements.lock"
  rejected_aster "$work_dir/source"
  chown 0 "$work_dir/source/modules/aster/requirements.lock"
  chmod 0666 "$work_dir/source/modules/aster/requirements.lock"
  rejected_aster "$work_dir/source"
  chmod 0644 "$work_dir/source/modules/aster/requirements.lock"
  mv "$work_dir/source/modules/aster/requirements.lock" "$fixture/untrusted-aster.lock"
  ln -s "$fixture/untrusted-aster.lock" "$work_dir/source/modules/aster/requirements.lock"
  rejected_aster "$work_dir/source"
  [[ ! -e "$APP_DIR/python-aster" ]]
  updater_safe_path "$work_dir/python-lock/modules/aster/requirements.lock"
  printf 'ASTER also rejects writable ancestry, leaf and symlink inputs before pip.\n'
  # Reusing either cached environment does not invoke its interpreter/pip or
  # overwrite the other module's selected path. Invalid receipts cannot count.
  for module in greeks aster; do
    fingerprint=$({ cat "$work_dir/python-lock/modules/$module/requirements.lock"; /usr/bin/python3 -VV; uname -m; } | hash)
    cache_root="$APP_DIR/python"
    if [[ "$module" == aster ]]; then cache_root="$APP_DIR/python-aster"; fi
    runtime="$cache_root/$fingerprint"
    mkdir -p "$runtime/bin"
    printf '#!/bin/sh\nexit 98\n' > "$runtime/bin/python"
    chmod 0755 "$runtime/bin/python"
    printf '%s\n' "$fingerprint" > "$runtime/.complete"
    "prepare_${module}_runtime" "$work_dir/python-lock"
    if [[ "$module" == greeks ]]; then [[ "$GREEKS_PYTHON_PATH" == "$runtime/bin/python" ]]; saved_greeks=$GREEKS_PYTHON_PATH;
    else [[ "$ASTER_PYTHON_PATH" == "$runtime/bin/python" && "$GREEKS_PYTHON_PATH" == "$saved_greeks" ]]; fi
    printf 'wrong-fingerprint\n' > "$runtime/.complete"
    if "prepare_${module}_runtime" "$work_dir/python-lock"; then echo 'Invalid runtime receipt was accepted' >&2; exit 1; fi
    printf '%s\n' "$fingerprint" > "$runtime/.complete"
  done
  printf 'Greeks and ASTER caches remain independent and skip installation only for matching receipts.\n'
fi
