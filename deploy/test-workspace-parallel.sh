#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $(uname -s) != Linux ]]; then
  printf 'Workspace process-group checks require Linux; skipped.\n'
  exit 0
fi
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
suite_root=$(mktemp -d)
trap 'result=$?; if ((result)); then cat "$suite_root"/*/log >&2; fi; rm -rf -- "$suite_root"' EXIT
cat > "$suite_root/runner.sh" <<'SH'
set -Eeuo pipefail
source "$1/deploy/workspace-test-jobs.sh"
case_root=$2
mode=$3
test_root="$case_root/work"
mkdir "$test_root"
trap workspace_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ready() {
  for attempt in {1..100}; do [[ ! -f "$1" ]] || return 0; sleep 0.02; done
  return 99
}
success() {
  touch "$case_root/$1.ready"
  ready "$case_root/$2.ready"
  sleep 0.1
  [[ -d "$test_root" ]]
  touch "$case_root/$1.done"
}
busy() {
  (
    if [[ "$mode" == stubborn ]]; then
      trap '' TERM
    else
      trap '[[ -d "$test_root" ]] && touch "$case_root/cleaned-before-removal"; exit 0' TERM
    fi
    printf '%s\n' "$BASHPID" > "$case_root/descendant.pid"
    touch "$case_root/busy.ready"
    while true; do sleep 0.05; done
  ) &
  wait "$!"
}
fail() {
  ready "$case_root/busy.ready"
  bash -c 'exit 23'
  touch "$case_root/masked-failure"
}
case "$mode" in
  success) workspace_start_job first success first second; workspace_start_job second success second first ;;
  immediate-success) workspace_start_job first true; workspace_start_job second true; sleep 0.1 ;;
  immediate-failure) workspace_start_job first bash -c 'exit 23'; workspace_start_job second true; sleep 0.1 ;;
  immediate-second-failure) workspace_start_job first true; workspace_start_job second bash -c 'exit 23'; sleep 0.1 ;;
  exit-127) workspace_start_job first bash -c 'exit 127'; workspace_start_job second true; sleep 0.1 ;;
  fail-first) workspace_start_job failure fail; workspace_start_job sibling busy ;;
  fail-second) workspace_start_job sibling busy; workspace_start_job failure fail ;;
  signal|stubborn) workspace_start_job sibling busy; workspace_start_job other sleep 30 ;;
esac
workspace_wait_jobs
touch "$case_root/joined"
SH

run_case() {
  local mode=$1 expected=$2 signal=${3:-} parent status case_root="$suite_root/$1"
  mkdir "$case_root"
  # Keep INT meaningful for the runner, rather than Bash's ignored signal for
  # non-job-controlled asynchronous commands.
  set -m
  bash "$suite_root/runner.sh" "$repository" "$case_root" "$mode" > "$case_root/log" 2>&1 &
  parent=$!
  set +m
  if [[ -n "$signal" ]]; then
    for attempt in {1..100}; do [[ ! -f "$case_root/busy.ready" ]] || break; sleep 0.02; done
    [[ -f "$case_root/busy.ready" ]]
    kill -"$signal" "$parent"
  fi
  if wait "$parent"; then status=0; else status=$?; fi
  if [[ "$status" != "$expected" ]]; then cat "$case_root/log" >&2; return 1; fi
  [[ ! -d "$case_root/work" && ! -f "$case_root/masked-failure" ]]
  if (( expected == 0 )); then
    [[ -f "$case_root/joined" ]]
    if [[ "$mode" == success ]]; then [[ -f "$case_root/first.done" && -f "$case_root/second.done" ]]; fi
  else
    [[ ! -f "$case_root/joined" ]]
  fi
  if [[ -f "$case_root/descendant.pid" ]]; then
    if [[ "$mode" != stubborn ]]; then [[ -f "$case_root/cleaned-before-removal" ]]; fi
    # An orphan can briefly remain as a zombie until PID 1 reaps it, but must
    # never still execute after the fixture removes its working directory.
    local descendant state
    descendant=$(cat "$case_root/descendant.pid")
    for attempt in {1..25}; do
      state=$(ps -o stat= -p "$descendant" || true)
      [[ -n "$state" && "$state" != Z* ]] || break
      sleep 0.02
    done
    [[ -z "$state" || "$state" == Z* ]]
  fi
}
run_case success 0
run_case immediate-success 0
run_case immediate-failure 23
run_case immediate-second-failure 23
run_case exit-127 127
run_case fail-first 23
run_case fail-second 23
run_case signal 130 INT
mv "$suite_root/signal" "$suite_root/signal-int"
run_case signal 143 TERM
run_case stubborn 143 TERM
printf 'Workspace lanes overlap, preserve failures, and clean up descendants before files.\n'
