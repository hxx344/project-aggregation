#!/usr/bin/env bash
# Contract tests for orchestration; no real network, package install or service changes.
set -Eeuo pipefail
AGG_STACK_SOURCE_ONLY=1 source "$(dirname "$0")/../install-all.sh"
test_parent=$(realpath "${TMPDIR:-/tmp}")
test_root=$(mktemp -d "$test_parent/project-stack-test.XXXXXXXX")
test_cleanup() {
  local resolved
  resolved=$(realpath -e "$test_root")
  [[ ! -L "$test_root" && "$resolved" == "$test_parent/project-stack-test."* ]] || return 1
  rm -rf -- "$resolved"
}
trap test_cleanup EXIT
STACK_CACHE="$test_root/cache"
STACK_LOGS="$test_root/logs"
mkdir -p "$STACK_CACHE" "$STACK_LOGS" "$test_root/upstream"
umask 077

assert() { "$@" || { printf 'Assertion failed: %s\n' "$*" >&2; exit 1; }; }
new_run() {
  stack_run=$(mktemp -d "$STACK_LOGS/run.XXXXXX")
  stack_status=() stack_seconds=() stack_workers=()
  stack_child='' stack_active='' stack_viewer='' stack_refresh=0
}
# Windows uses different owner IDs. Linux CI exercises the actual root-owned check separately.
original_private_dir=$(declare -f stack_private_dir)
stack_private_dir() { mkdir -p "$1"; chmod 700 "$1"; }
export STACK_TEST_ROOT="$test_root"
for item in "${STACK_ORDER[@]}"; do
  cat > "$test_root/upstream/$item.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' '$item' >> "\$STACK_TEST_ROOT/executed"
printf 'Checked $item configuration and health; unchanged inputs are skipped.\\n'
if [[ -f "\$STACK_TEST_ROOT/fail-$item" ]]; then exit 23; fi
EOF
done

# Mock only curl's boundary, preserving real cached files, hash checks and bash -n.
curl() {
  local output='' etag='' compare='' url='' arg item
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --output) output=$1; shift ;;
      --etag-save) etag=$1; shift ;;
      --etag-compare) compare=$1; shift ;;
      --proto|--tls-max|--retry|--connect-timeout|--max-time|--write-out) shift ;;
      https://*) url=$arg ;;
    esac
  done
  for item in "${STACK_ORDER[@]}"; do
    if [[ "$url" == "https://raw.githubusercontent.com/hxx344/${STACK_REPOS[$item]}/main/${STACK_PATHS[$item]}" ]]; then break; fi
  done
  printf '%s\t%s\n' "$item" "$compare" >> "$test_root/downloads"
  if [[ -f "$test_root/network-$item" ]]; then
    printf 'partial download' > "$output"
    return 22
  fi
  local tag
  tag=$(sha256sum "$test_root/upstream/$item.sh" | cut -d ' ' -f1)
  printf '"%s"\n' "$tag" > "$etag"
  if [[ -n "$compare" && $(cat "$compare") == "\"$tag\"" ]]; then
    printf 304
  else
    cp "$test_root/upstream/$item.sh" "$output"
    printf 200
  fi
}
# setsid is unavailable in some Git Bash distributions; child scripts still run in real Bash.
# Dedicated process-group handling is exercised using real setsid on Linux CI below.
if [[ $(uname -s) != Linux ]]; then
  setsid() { "$@"; }
  stack_stream() { return 0; }
fi

stack_parse
[[ ${stack_selected[*]} == 'aster monitor asset crossex hub' ]]
stack_parse --only hub,monitor,monitor,aster
[[ ${stack_selected[*]} == 'aster monitor hub' ]]
for invalid in unknown ',hub' 'hub,' 'aster,,hub'; do
  if (stack_parse --only "$invalid"); then echo "Invalid selection accepted: $invalid" >&2; exit 1; fi
done
if (stack_parse --only); then echo 'Missing selection accepted' >&2; exit 1; fi
if (stack_parse --only hub --only asset); then echo 'Duplicate option accepted' >&2; exit 1; fi
if (stack_parse --bogus); then echo 'Unknown option accepted' >&2; exit 1; fi

# All dependencies present means zero apt traffic; multiple missing packages are batched once.
dpkg-query() {
  case ${@: -1} in
    curl|python3-venv) [[ ! -f "$test_root/missing-packages" ]] || return 1 ;;
  esac
  printf 'install ok installed'
}
apt-get() { printf '%s\n' "$*" >> "$test_root/apt"; }
stack_parse
stack_ensure_tools
[[ ! -e "$test_root/apt" ]]
touch "$test_root/missing-packages"
stack_ensure_tools
[[ $(wc -l < "$test_root/apt") == 2 ]]
grep -q '^update -qq$' "$test_root/apt"
grep -q 'install .*curl' "$test_root/apt"
grep -q 'install .*python3-venv' "$test_root/apt"
rm "$test_root/missing-packages"

# Fresh deployment prefetches every script and runs all five, with the hub last.
new_run
stack_prefetch
for item in "${STACK_ORDER[@]}"; do assert stack_cache_valid "$STACK_CACHE/$item"; done
stack_run_installers
printf '%s\n' "${STACK_ORDER[@]}" > "$test_root/expected"
cmp "$test_root/expected" "$test_root/executed"

# A cached script is revalidated and still executed: configuration/health must never be skipped.
: > "$test_root/executed"
: > "$test_root/downloads"
new_run
stack_prefetch
[[ $(grep -c $'\t.*/etag$' "$test_root/downloads") == 5 ]]
for item in "${STACK_ORDER[@]}"; do grep -q '复用缓存' "$stack_run/$item.download.log"; done
stack_run_installers
cmp "$test_root/expected" "$test_root/executed"

# A single installer change refreshes only that body; corrupt/missing caches force a full GET.
printf '\n# updated installer\n' >> "$test_root/upstream/monitor.sh"
new_run
stack_prefetch
grep -q '获取并校验' "$stack_run/monitor.download.log"
grep -q '复用缓存' "$stack_run/asset.download.log"
printf '\n# tampered\n' >> "$STACK_CACHE/hub/install.sh"
rm "$STACK_CACHE/asset/install.sh"
: > "$test_root/downloads"
new_run
stack_prefetch
grep -q $'^hub\t$' "$test_root/downloads"
grep -q $'^asset\t$' "$test_root/downloads"
assert stack_cache_valid "$STACK_CACHE/hub"

# Network errors fail closed before any installer runs and preserve the previous usable cache.
: > "$test_root/executed"
touch "$test_root/network-crossex"
new_run
# Use the production errexit context, not an 'if function' that disables Bash errexit.
rm "$test_root/executed"
set +e
(set -e; stack_prefetch; stack_run_installers)
result=$?
set -e
[[ $result != 0 && ! -e "$test_root/executed" ]]
assert stack_cache_valid "$STACK_CACHE/crossex"
rm "$test_root/network-crossex"

# Reject malformed downloads without poisoning an already valid cache.
cp "$test_root/upstream/hub.sh" "$test_root/good-hub"
printf '#!/usr/bin/env bash\nif then\n' > "$test_root/upstream/hub.sh"
new_run
set +e
(set -e; stack_prefetch; stack_run_installers)
result=$?
set -e
[[ $result != 0 && ! -e "$test_root/executed" ]]
assert stack_cache_valid "$STACK_CACHE/hub"
mv "$test_root/good-hub" "$test_root/upstream/hub.sh"

# Failure exit code is preserved, later modules never run, retry checks successful ones again.
touch "$test_root/fail-monitor"
new_run
stack_prefetch
if stack_run_installers; then echo 'Installer failure accepted' >&2; exit 1; else result=$?; fi
[[ $result == 23 && ${stack_status[monitor]} == '失败（23）' ]]
printf 'aster\nmonitor\n' > "$test_root/expected-failure"
cmp "$test_root/expected-failure" "$test_root/executed"
[[ ! -e "$stack_run/asset.log" && ! -e "$stack_run/hub.log" ]]
rm "$test_root/fail-monitor"
: > "$test_root/executed"
new_run
stack_prefetch
stack_run_installers
cmp "$test_root/expected" "$test_root/executed"

# Targeted deployment keeps canonical order and only fetches/runs selected modules.
: > "$test_root/executed"
: > "$test_root/downloads"
new_run
stack_parse --only hub,crossex --refresh
stack_prefetch
stack_run_installers
printf 'crossex\nhub\n' > "$test_root/expected-subset"
cmp "$test_root/expected-subset" "$test_root/executed"
[[ $(wc -l < "$test_root/downloads") == 2 ]]
grep -q $'^hub\t$' "$test_root/downloads"

if [[ $(uname -s) == Linux ]]; then
  [[ $(stat -c %a "$stack_run") == 700 && $(stat -c %a "$stack_run/hub.log") == 600 ]]
  # Real signal/lock test, with no actual application or system services.
  cat > "$test_root/signal-installer.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf restored > "$STACK_TEST_ROOT/restored"; exit 143' TERM
printf ready > "$STACK_TEST_ROOT/ready"
while true; do sleep 1; done
SH
  (
    exec 8>"$test_root/lock"
    flock -n 8
    stack_selected=(hub)
    stack_run=$(mktemp -d "$STACK_LOGS/signal.XXXXXX")
    cp "$test_root/signal-installer.sh" "$stack_run/hub.sh"
    trap 'stack_signal 143' TERM
    stack_run_installers
  ) > "$test_root/signal.log" 2>&1 &
  parent=$!
  for attempt in {1..50}; do [[ ! -f "$test_root/ready" ]] || break; sleep 0.1; done
  [[ -f "$test_root/ready" ]]
  if flock -n "$test_root/lock" true; then echo 'Coordinator lock released too soon' >&2; exit 1; fi
  kill -TERM "$parent"
  if wait "$parent"; then echo 'Signal exit code lost' >&2; exit 1; else [[ $? == 143 ]]; fi
  [[ -f "$test_root/restored" ]]
  flock -n "$test_root/lock" true
  eval "$original_private_dir"
  if [[ $EUID == 0 ]]; then
    stack_private_dir "$test_root/private"
    [[ $(stat -c %a "$test_root/private") == 700 ]]
    ln -s "$test_root/private" "$test_root/private-link"
    if stack_private_dir "$test_root/private-link"; then echo 'Symlink accepted' >&2; exit 1; fi
    # Execute the actual coordinator and EXIT summary with only the host preflight mocked.
    stack_preflight() { return 0; }
    STACK_LOCK="$test_root/main.lock"
    (stack_main --only hub) > "$test_root/main.log" 2>&1
    grep -q '所选项目均已完成' "$test_root/main.log"
    touch "$test_root/fail-hub"
    set +e
    (set -e; stack_main --only hub) > "$test_root/main-failed.log" 2>&1
    result=$?
    set -e
    [[ $result == 23 ]]
    grep -q '失败（23）' "$test_root/main-failed.log"
    if grep -q '所选项目均已完成' "$test_root/main-failed.log"; then echo 'False success summary' >&2; exit 1; fi
    rm "$test_root/fail-hub"
  fi
fi
printf 'All stack installer contract checks passed.\n'
