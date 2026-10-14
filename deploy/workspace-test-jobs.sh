#!/usr/bin/env bash
# Process groups for the two independent lanes in test-workspace.sh (Linux CI).
workspace_jobs=()

workspace_start_job() {
  local name=$1
  shift
  # Job control gives this subshell its own group. Disable it inside the lane so
  # commands and grandchildren stay in that group when the fixture is cancelled.
  set -m
  (
    set +m
    trap - EXIT INT TERM
    started=$SECONDS
    trap 'result=$?; printf "[workspace] %s: %ss (exit %s)\n" "$name" "$((SECONDS - started))" "$result"; exit "$result"' EXIT
    printf '[workspace] Starting %s\n' "$name"
    "$@"
  ) &
  workspace_jobs+=("$!")
  set +m
}

workspace_wait_jobs() {
  local completed result pid
  local -a pending=("${workspace_jobs[@]}") remaining
  while ((${#pending[@]})); do
    # Only wait is conditional: invoking the lane itself under `if` would
    # disable errexit throughout its functions and hide intermediate failures.
    if wait -n -p completed "${pending[@]}"; then result=0; else result=$?; fi
    # Some Bash versions no longer offer already-finished jobs to wait -n.
    # Explicit waits still retain their status. A real exit 127 has a completed
    # PID and must propagate, rather than being mistaken for this empty set.
    if [[ "$result" == 127 && -z ${completed:-} ]]; then
      for pid in "${pending[@]}"; do wait "$pid" || return "$?"; done
      break
    fi
    (( result == 0 )) || return "$result"
    remaining=()
    for pid in "${pending[@]}"; do
      [[ "$pid" == "$completed" ]] || remaining+=("$pid")
    done
    pending=("${remaining[@]}")
  done
  workspace_jobs=()
}

workspace_cleanup() {
  local result=$? pid active deadline=$((SECONDS + 3))
  trap - EXIT
  trap '' INT TERM
  # Include jobs launched just before a signal, before their PID was recorded.
  local -a pending=("${workspace_jobs[@]}")
  while read -r pid; do pending+=("$pid"); done < <(jobs -p)
  for pid in "${pending[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  while ((${#pending[@]} && SECONDS < deadline)); do
    active=0
    for pid in "${pending[@]}"; do
      if kill -0 -- "-$pid" 2>/dev/null; then active=1; fi
    done
    (( active )) || break
    sleep 0.1
  done
  for pid in "${pending[@]}"; do
    # Bound cancellation even if a command ignores TERM. Reap lane leaders
    # before removing files; surviving descendants receive KILL as a group.
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$test_root"
  exit "$result"
}
