#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -z "${MONITOR_NODE:-}" && -x .runtime/bin/node ]]; then export MONITOR_NODE="$PWD/.runtime/bin/node"; fi
data_directory=$("${MONITOR_NODE:-node}" --env-file-if-exists=.env.linux --input-type=module -e 'import {resolve} from "node:path"; console.log(resolve(process.env.ALERT_DATA_DIR || "runtime-data"))')
export ALERT_DATA_DIR="$data_directory"
mkdir -p "$ALERT_DATA_DIR"
export MONITOR_EXTERNAL_LOCK=1
exec flock --no-fork --nonblock --conflict-exit-code 75 "$ALERT_DATA_DIR/instance.lock" "${MONITOR_NODE:-node}" --experimental-strip-types --env-file-if-exists=.env.linux server/linux.mjs "$@"
