#!/usr/bin/env bash
# Linux CI only: actual installer cleanup functions, isolated paths and command stubs.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/install.sh"
scale_root=$(mktemp -d)
trap 'rm -rf -- "$scale_root"' EXIT
key() { printf '%064x' "$1"; }
systemctl() { return 1; }
GREEKS_PYTHON_PATH=/usr/bin/python3
ASTER_PYTHON_PATH=/usr/bin/python3
PROJECT_DEPLOY_MODE=source
dependency_key=$(key 1) runtime_dependency_key=$(key 2) build_key=$(key 3) embedded_key=$(key 4)
declare -A module_build_keys=()

for count in 32 256 1024; do
  APP_DIR="$scale_root/$count"
  mkdir -p "$APP_DIR/releases" "$APP_DIR/cache"
  release="$APP_DIR/releases/aaaaaaaaaaaa-aaaaaaaaaaaaaaaa"
  previous_release="$APP_DIR/releases/bbbbbbbbbbbb-bbbbbbbbbbbbbbbb"
  runtime_release_fixture="$APP_DIR/releases/cccccccccccc-cccccccccccccccc"
  prepared_release_fixture="$APP_DIR/releases/dddddddddddd-dddddddddddddddd"
  live_runtime_release() { printf '%s' "$runtime_release_fixture"; }
  for item in "$release" "$previous_release" "$runtime_release_fixture" "$prepared_release_fixture"; do
    mkdir -p "$item"; touch "$item/.managed-release"
  done
  ln -s "$release" "$APP_DIR/current"
  ln -s "$previous_release" "$APP_DIR/previous"
  printf '%s\n' "$prepared_release_fixture" > "$APP_DIR/.prepared-release"
  ordinal=10
  for item in "$release" "$previous_release" "$runtime_release_fixture" "$prepared_release_fixture"; do
    mkdir -p "$APP_DIR/cache/runtime-dependencies-$(key "$ordinal")"
    printf '%s\n' "$(key "$ordinal")" > "$item/.runtime-dependency-key"
    ordinal=$((ordinal + 1))
  done
  for ((index=100; index<count+100; index++)); do
    mkdir -p "$APP_DIR/cache/embedded-$(key "$index")"
  done
  work_dir="$APP_DIR/.install.Keep0000"; mkdir "$work_dir"
  scanned=$(find "$APP_DIR/cache" -mindepth 1 -maxdepth 1 -type d | wc -l)
  started=$(date +%s%N)
  # Terminate a cleanup subprocess after the rename, before deleting its trash.
  set +e
  (
    rm() {
      if [[ "${*: -1}" == "$APP_DIR/cache/.prune.embedded-"* ]]; then exit 75; fi
      command rm "$@"
    }
    prune_caches
  )
  interrupted=$?
  set -e
  [[ "$interrupted" == 75 ]]
  [[ $(find "$APP_DIR/cache" -maxdepth 1 -name '.prune.*' | wc -l) == 1 ]]
  # One failing removal remains observable, while all other removable entries drain.
  stuck="$APP_DIR/cache/embedded-$(key $((count+99)))"
  set +e
  (
    mv() { [[ "${*: -2:1}" != "$stuck" ]] || return 1; command mv "$@"; }
    prune_caches
  )
  partial=$?
  set -e
  [[ "$partial" != 0 && -d "$stuck" ]]
  [[ $(find "$APP_DIR/cache" -mindepth 1 -maxdepth 1 -type d | wc -l) == 5 ]]
  prune_caches
  prune_releases
  for item in "$release" "$previous_release" "$runtime_release_fixture" "$prepared_release_fixture" "$work_dir"; do [[ -d "$item" ]]; done
  [[ $(find "$APP_DIR/cache" -mindepth 1 -maxdepth 1 -type d | wc -l) == 4 ]]
  elapsed=$(( ($(date +%s%N)-started) / 1000000 ))
  printf '{"installerCleanup":{"scale":%s,"scannedAtStart":%s,"deleted":%s,"retained":4,"interruptedAfterRename":true,"partialFailure":true,"retryComplete":true,"elapsedMs":%s,"protected":["current","previous","runtime","prepared","active-work"]}}\n' "$count" "$scanned" "$count" "$elapsed"
done
