#!/usr/bin/env bash
# ASTER Python unit tests against the locked dependencies, from a fixed Git
# extraction of HEAD, as concurrent shards (Linux CI).
# ASTER_TEST_PART selects listed, discovered, slow or all (default) so CI can
# spread the parts over runners; every part checks the complete test layout.
set -Eeuo pipefail
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
source "$repository/deploy/workspace-test-jobs.sh"
python=${ASTER_TEST_PYTHON:?Pass the Python 3.12 executable}
part=${ASTER_TEST_PART:-all}
trading_shards=${ASTER_TEST_TRADING_SHARDS:-4}
discovered_shards=${ASTER_TEST_DISCOVERED_SHARDS:-4}
[[ $part =~ ^(all|listed|discovered|slow)$ ]] || { echo 'ASTER_TEST_PART must be all, listed, discovered or slow.' >&2; exit 1; }
[[ $trading_shards =~ ^[1-9][0-9]?$ ]] || { echo 'ASTER_TEST_TRADING_SHARDS must be 1-99.' >&2; exit 1; }
[[ $discovered_shards =~ ^[1-9][0-9]?$ ]] || { echo 'ASTER_TEST_DISCOVERED_SHARDS must be 1-99.' >&2; exit 1; }
test_root=$(mktemp -d)
trap workspace_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The four listed groups keep the boundaries they had as separate processes.
# Only the large trading group is split, by module, so no module runs twice or is dropped.
margin_group=(tests.test_margin_t0)
trading_group=(tests.test_account_writer tests.test_managed_margin_transfer tests.test_workspace tests.test_server_security tests.test_server_runtime tests.test_hub_summary tests.test_transfer_account_snapshot tests.test_pair_margin_independent tests.test_pair_margin_only_switch tests.test_pair_margin tests.test_pair_margin_status tests.test_pair_margin_bounded_recovery tests.test_pair_margin_budget_wait tests.test_pair_margin_ws tests.test_bounded_recovery tests.test_recovery_engine tests.test_pair_bounded_recovery tests.test_pair_reality_backoff tests.test_pair_late_receipt_recovery tests.test_pair_recovery_budget tests.test_pair_unknown_observation tests.test_pair_submit_evidence tests.test_pair_order_recovery tests.test_pair_manual_baseline tests.test_pair_recovery_check tests.test_ws_evidence tests.test_pair_ws_reconciliation tests.test_pair_trading tests.test_pair_position_scope tests.test_pair_archived_baseline tests.test_pair_paused_adoption tests.test_pair_symbol_api tests.test_pair_symbol_change tests.test_pair_symbol_history tests.test_pair_symbol_watch tests.test_pair_symbols_runtime tests.test_pair_market_symbols tests.test_pair_upgrade_capacity tests.test_opening_messages tests.test_risk_scenarios tests.test_cycle_engine tests.test_cycle_execution tests.test_migration_engine tests.test_migration_execution)
monitoring_group=(tests.test_monitoring_settings tests.test_monitoring_migration tests.test_listing_alerts tests.test_listings tests.test_capacity_notification_samples tests.test_capacity_relay_integration tests.test_public_data_sharing tests.test_hourly_summary tests.test_hourly_notification_engine tests.test_feishu_summary_cards)
adl_group=(tests.test_adl_config tests.test_adl_pair_config tests.test_adl_api tests.test_adl_view tests.test_adl_events tests.test_adl_exchange tests.test_adl_budget tests.test_adl_controller tests.test_adl_recovery tests.test_adl_liveness tests.test_adl_notifications tests.test_adl_integration tests.test_adl_monitoring tests.test_adl_workspace)
# These two methods take about 50 s each (tens of thousands of fills), so each
# gets its own shard and the rest of their module runs in a third.
slow_module=tests.test_cycle_volume_execution
slow_tests=(
  tests.test_cycle_volume_execution.LiveCycleTradeTests.test_large_partial_fill_chunk_failure_restarts_without_duplicate_accounting
  tests.test_cycle_volume_execution.LiveCycleTradeTests.test_order_with_over_twenty_thousand_fills_is_recorded_in_bounded_chunks
)

git -c safe.directory="$repository" -c safe.directory="$repository/.git" -C "$repository" archive -o "$test_root/source.tar" HEAD
mkdir "$test_root/locked"
tar -xf "$test_root/source.tar" -C "$test_root/locked" modules/aster/requirements.lock deploy/test-exclusions.txt

# Every test module is in exactly one place: a listed group, the slow module,
# the exclusion list, or (by default) the discovered group, so a new file runs.
mapfile -t all_modules < <(tar -tf "$test_root/source.tar" | sed -nE 's#^modules/aster/tests/(test_[A-Za-z0-9_]+)\.py$#tests.\1#p' | sort)
mapfile -t excluded < <(sed -nE 's/^aster[[:space:]]+(test_[A-Za-z0-9_]+)([[:space:]].*)?$/tests.\1/p' "$test_root/locked/deploy/test-exclusions.txt")
declare -A owner=() present=()
for module in "${all_modules[@]}"; do present[$module]=1; done
claim() {
  local group=$1 module
  shift
  for module; do
    if [[ -n ${owner[$module]:-} ]]; then echo "$module is in both ${owner[$module]} and $group." >&2; return 1; fi
    if [[ -z ${present[$module]:-} ]]; then echo "$module ($group) has no file under modules/aster/tests." >&2; return 1; fi
    owner[$module]=$group
  done
}
claim margin "${margin_group[@]}"
claim trading "${trading_group[@]}"
claim monitoring "${monitoring_group[@]}"
claim adl "${adl_group[@]}"
claim slow "$slow_module"
claim excluded "${excluded[@]}"
discovered_group=()
for module in "${all_modules[@]}"; do
  [[ -n ${owner[$module]:-} ]] || discovered_group+=("$module")
done
printf '[aster] %s test modules: %s discovered, %s excluded in deploy/test-exclusions.txt.\n' \
  "${#all_modules[@]}" "${#discovered_group[@]}" "${#excluded[@]}"

"$python" -m venv "$test_root/venv"
"$test_root/venv/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$test_root/locked/modules/aster/requirements.lock"

# Runs the named tests of one module: "only" the given IDs or all "except" them.
read -r -d '' select_tests <<'PY' || true
import sys, unittest

mode, module, *ids = sys.argv[1:]

def flatten(suite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from flatten(test)
        else:
            yield test

tests = list(flatten(unittest.defaultTestLoader.loadTestsFromName(module)))
unknown = set(ids) - {test.id() for test in tests}
if unknown:
    sys.exit(f"Unknown tests in {module}: {sorted(unknown)}")
selected = [test for test in tests if (test.id() in ids) == (mode == "only")]
result = unittest.TextTestRunner(verbosity=0).run(unittest.TestSuite(selected))
sys.exit(not result.wasSuccessful())
PY

run_shard() {
  local name=$1 source="$test_root/$1" log="$test_root/$1.log" status
  shift
  # A private tree per shard: tests resolve repository paths from __file__ and
  # may write next to the sources, which must not race with another shard.
  mkdir "$source"
  tar -xf "$test_root/source.tar" -C "$source"
  if (cd "$source/modules/aster" && "$test_root/venv/bin/python" "$@") > "$log" 2>&1; then
    printf '[aster] %s: %s\n' "$name" "$(grep -E '^Ran [0-9]+ tests? ' "$log" | tail -n 1)"
  else
    status=$?
    cat -- "$log" >&2
    return "$status"
  fi
}

start_sharded() {
  local name=$1 shards=$2 shard index
  shift 2
  local -a group=("$@") selected
  for ((shard = 0; shard < shards; shard++)); do
    selected=()
    for index in "${!group[@]}"; do
      if (( index % shards == shard )); then selected+=("${group[$index]}"); fi
    done
    (( ${#selected[@]} )) || continue
    workspace_start_job "$name-$shard" run_shard "$name-$shard" -m unittest "${selected[@]}" -q
  done
}

if [[ $part == all || $part == listed ]]; then
  workspace_start_job margin run_shard margin -m unittest "${margin_group[@]}" -q
  start_sharded trading "$trading_shards" "${trading_group[@]}"
  workspace_start_job monitoring run_shard monitoring -m unittest "${monitoring_group[@]}" -q
  workspace_start_job adl run_shard adl -m unittest "${adl_group[@]}" -q
fi
if [[ $part == all || $part == discovered ]]; then
  start_sharded discovered "$discovered_shards" "${discovered_group[@]}"
fi
if [[ $part == all || $part == slow ]]; then
  for index in "${!slow_tests[@]}"; do
    workspace_start_job "slow-$index" run_shard "slow-$index" -c "$select_tests" only "$slow_module" "${slow_tests[$index]}"
  done
  workspace_start_job slow-rest run_shard slow-rest -c "$select_tests" except "$slow_module" "${slow_tests[@]}"
fi
workspace_wait_jobs

total=0
for log in "$test_root"/*.log; do
  count=$(sed -nE 's/^Ran ([0-9]+) tests? .*/\1/p' "$log" | tail -n 1)
  [[ -n $count ]] || { echo "No unittest summary in $log" >&2; exit 1; }
  total=$((total + count))
done
printf '[aster] all %s shards passed: %s tests.\n' "$part" "$total"
