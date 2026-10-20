#!/usr/bin/env bash
# ASTER Python unit tests against the locked dependencies, from a fixed Git
# extraction of HEAD, as concurrent shards (Linux CI).
set -Eeuo pipefail
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
source "$repository/deploy/workspace-test-jobs.sh"
python=${ASTER_TEST_PYTHON:?Pass the Python 3.12 executable}
trading_shards=${ASTER_TEST_TRADING_SHARDS:-4}
[[ $trading_shards =~ ^[1-9][0-9]?$ ]] || { echo 'ASTER_TEST_TRADING_SHARDS must be 1-99.' >&2; exit 1; }
test_root=$(mktemp -d)
trap workspace_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The four groups keep the boundaries they had as separate processes. Only the
# large trading group is split, by module, so no module runs twice or is dropped.
margin_group=(tests.test_margin_t0)
trading_group=(tests.test_account_writer tests.test_managed_margin_transfer tests.test_workspace tests.test_server_security tests.test_server_runtime tests.test_hub_summary tests.test_transfer_account_snapshot tests.test_pair_margin_independent tests.test_pair_margin_only_switch tests.test_pair_margin tests.test_pair_margin_status tests.test_pair_margin_bounded_recovery tests.test_pair_margin_budget_wait tests.test_pair_margin_ws tests.test_bounded_recovery tests.test_recovery_engine tests.test_pair_bounded_recovery tests.test_pair_reality_backoff tests.test_pair_late_receipt_recovery tests.test_pair_recovery_budget tests.test_pair_unknown_observation tests.test_pair_submit_evidence tests.test_pair_order_recovery tests.test_pair_manual_baseline tests.test_pair_recovery_check tests.test_ws_evidence tests.test_pair_ws_reconciliation tests.test_pair_trading tests.test_pair_position_scope tests.test_pair_archived_baseline tests.test_pair_paused_adoption tests.test_pair_symbol_api tests.test_pair_symbol_change tests.test_pair_symbol_history tests.test_pair_symbol_watch tests.test_pair_symbols_runtime tests.test_pair_market_symbols tests.test_pair_upgrade_capacity tests.test_opening_messages tests.test_risk_scenarios tests.test_cycle_engine tests.test_cycle_execution tests.test_migration_engine tests.test_migration_execution)
monitoring_group=(tests.test_monitoring_settings tests.test_monitoring_migration tests.test_listing_alerts tests.test_listings tests.test_capacity_notification_samples tests.test_capacity_relay_integration tests.test_public_data_sharing tests.test_hourly_summary tests.test_hourly_notification_engine tests.test_feishu_summary_cards)
adl_group=(tests.test_adl_config tests.test_adl_pair_config tests.test_adl_api tests.test_adl_view tests.test_adl_events tests.test_adl_exchange tests.test_adl_budget tests.test_adl_controller tests.test_adl_recovery tests.test_adl_liveness tests.test_adl_notifications tests.test_adl_integration tests.test_adl_monitoring tests.test_adl_workspace)

git -c safe.directory="$repository" -c safe.directory="$repository/.git" -C "$repository" archive -o "$test_root/source.tar" HEAD
"$python" -m venv "$test_root/venv"
mkdir "$test_root/locked"
tar -xf "$test_root/source.tar" -C "$test_root/locked" modules/aster/requirements.lock
"$test_root/venv/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$test_root/locked/modules/aster/requirements.lock"

run_unittest_shard() {
  local name=$1 source="$test_root/$1" log="$test_root/$1.log" status
  shift
  # A private tree per shard: tests resolve repository paths from __file__ and
  # may write next to the sources, which must not race with another shard.
  mkdir "$source"
  tar -xf "$test_root/source.tar" -C "$source"
  if (cd "$source/modules/aster" && "$test_root/venv/bin/python" -m unittest "$@" -q) > "$log" 2>&1; then
    printf '[aster] %s: %s\n' "$name" "$(grep -E '^Ran [0-9]+ tests? ' "$log" | tail -n 1)"
  else
    status=$?
    cat -- "$log" >&2
    return "$status"
  fi
}

workspace_start_job margin run_unittest_shard margin "${margin_group[@]}"
for ((shard = 0; shard < trading_shards; shard++)); do
  selected=()
  for index in "${!trading_group[@]}"; do
    if (( index % trading_shards == shard )); then selected+=("${trading_group[$index]}"); fi
  done
  (( ${#selected[@]} )) || continue
  workspace_start_job "trading-$shard" run_unittest_shard "trading-$shard" "${selected[@]}"
done
workspace_start_job monitoring run_unittest_shard monitoring "${monitoring_group[@]}"
workspace_start_job adl run_unittest_shard adl "${adl_group[@]}"
workspace_wait_jobs

total=0
for log in "$test_root"/*.log; do
  count=$(sed -nE 's/^Ran ([0-9]+) tests? .*/\1/p' "$log" | tail -n 1)
  [[ -n $count ]] || { echo "No unittest summary in $log" >&2; exit 1; }
  total=$((total + count))
done
printf '[aster] all shards passed: %s tests.\n' "$total"
