#!/usr/bin/env bash
# Unit tests of the built-in Monitor, Crossex, Asset and Greeks modules, which
# need no build output, as concurrent suites (Linux CI). Files listed in
# deploy/test-exclusions.txt for a suite are skipped; a stale entry fails.
set -Eeuo pipefail
repository=$(cd -- "$(dirname -- "$0")/.." && pwd)
source "$repository/deploy/workspace-test-jobs.sh"
python=${MODULE_TEST_PYTHON:?Pass the Python 3.12 executable}
node=${MODULE_TEST_NODE:-node}
exclusions="$repository/deploy/test-exclusions.txt"
[[ -f $exclusions ]] || { echo "Missing $exclusions." >&2; exit 1; }
test_root=$(mktemp -d)
trap workspace_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
shopt -s nullglob

# Sets selected_files to the given test files minus the suite's exclusions.
select_files() {
  local suite=$1 module=$2 file name
  shift 2
  local -A skip=()
  while read -r name; do skip[$name]=1; done < <(sed -nE "s/^$suite[[:space:]]+([^[:space:]]+).*/\1/p" "$exclusions")
  for name in "${!skip[@]}"; do
    [[ -f $repository/modules/$module/tests/$name ]] || { echo "$suite exclusion $name has no file under modules/$module/tests." >&2; return 1; }
  done
  selected_files=()
  for file in "$@"; do
    [[ -n ${skip[${file#tests/}]:-} ]] || selected_files+=("$file")
  done
  (( ${#selected_files[@]} )) || { echo "No $suite test files under modules/$module/tests." >&2; return 1; }
}

run_suite() {
  local name=$1 module=$2 log="$test_root/$1.log" status
  shift 2
  if (cd "$repository/modules/$module" && "$@") > "$log" 2>&1; then
    printf '[modules] %s: %s\n' "$name" "$(grep -E '^(ℹ tests [0-9]+|Ran [0-9]+ tests? )' "$log" | tr '\n' ' ')"
  else
    status=$?
    cat -- "$log" >&2
    return "$status"
  fi
}

# Each suite runs in its own job subshell, so changing directory stays local.
node_suite() {
  local name=$1 module=$2 pattern=$3
  shift 3
  cd "$repository/modules/$module"
  select_files "$name" "$module" tests/$pattern
  run_suite "$name" "$module" "$node" "$@" --test --test-concurrency=4 "${selected_files[@]}"
}

python_suite() {
  local name=$1 module=$2 interpreter=$3
  cd "$repository/modules/$module"
  select_files "$name" "$module" tests/test_*.py
  run_suite "$name" "$module" "$interpreter" -m unittest "${selected_files[@]}" -q
}

greeks_python() {
  "$python" -m venv "$test_root/greeks-venv"
  "$test_root/greeks-venv/bin/python" -m pip install --disable-pip-version-check --require-hashes -q -r "$repository/modules/greeks/requirements.lock"
  python_suite greeks greeks "$test_root/greeks-venv/bin/python"
}

# Flags match each module's package.json test script.
workspace_start_job monitor node_suite monitor monitor '*.test.mjs' --experimental-strip-types
workspace_start_job crossex node_suite crossex crossex '*.test.mjs'
workspace_start_job asset node_suite asset asset '*.test.ts' --experimental-strip-types
workspace_start_job greeks-node node_suite greeks-node greeks 'test_*.cjs'
workspace_start_job asset-python python_suite asset-python asset "$python"
workspace_start_job greeks greeks_python
workspace_wait_jobs
printf '[modules] all suites passed.\n'
