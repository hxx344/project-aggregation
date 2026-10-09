#!/usr/bin/env bash
# The shared release helper is tested separately; exercise orchestration before any mutation.
set -Eeuo pipefail
unset PROJECT_DEPLOY_MODE PROJECT_DEPLOY_TESTS
AGG_STACK_SOURCE_ONLY=1 source "$(dirname "$0")/../install-all.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
export STACK_CI_FIXTURE=$fixture
STACK_CACHE="$fixture/cache"
STACK_LOGS="$fixture/logs"
mkdir -p "$STACK_CACHE" "$STACK_LOGS"
stack_private_dir() { mkdir -p "$1"; }
stack_stream() { return 0; }
if [[ $(uname -s) != Linux ]]; then setsid() { "$@"; }; fi
new_run() {
  stack_run=$(mktemp -d "$STACK_LOGS/run.XXXXXXXX")
  stack_workers=() stack_status=() stack_seconds=()
  stack_active='' stack_child='' stack_viewer=''
}
ci_release_resolve() {
  [[ ! -f "$fixture/no-manifest-${1##*/}" ]] || return 1
  CI_RELEASE_REPOSITORY=$1
  CI_RELEASE_TAG=deploy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  CI_RELEASE_FILE=fixture.tar.gz
  mkdir -p "$2"
  printf '%s\n' "$1" > "$2/release-manifest.json"
  printf '%s\n' "$1" >> "$fixture/manifests"
}
curl() {
  local argument output='' etag='' url='' head=0 item=''
  while (($#)); do
    argument=$1; shift
    case "$argument" in
      --output) output=$1; shift ;;
      --etag-save) etag=$1; shift ;;
      --etag-compare|--proto|--retry|--connect-timeout|--max-time|--write-out) shift ;;
      --head) head=1 ;;
      https://*) url=$argument ;;
    esac
  done
  if (( head )); then
    printf '%s\n' "$url" >> "$fixture/heads"
    [[ "$url" == */releases/download/deploy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/fixture.tar.gz ]]
    [[ ! -f "$fixture/missing-asset" ]] || return 22
    return
  fi
  for item in "${STACK_ORDER[@]}"; do
    [[ "$url" != "https://raw.githubusercontent.com/hxx344/${STACK_REPOS[$item]}/main/${STACK_PATHS[$item]}" ]] || break
  done
  cat > "$output" <<SCRIPT
#!/usr/bin/env bash
set -Eeuo pipefail
[[ \$PROJECT_DEPLOY_MODE == ci && \$# == 0 ]]
[[ -f \$PROJECT_DEPLOY_MANIFEST_FILE && \$(cat "\$PROJECT_DEPLOY_MANIFEST_FILE") == 'hxx344/${STACK_REPOS[$item]}' ]]
printf '%s\\n' '$item' >> "\$STACK_CI_FIXTURE/executed"
SCRIPT
  printf '"fixture"\n' > "$etag"
  printf 200
}
stack_parse
[[ "$stack_mode" == ci ]]
if PROJECT_DEPLOY_MODE=invalid stack_parse; then echo 'Invalid mode accepted' >&2; exit 1; fi
stack_parse --only monitor,hub
dpkg-query() { printf '%s\n' "${@: -1}" >> "$fixture/packages"; printf 'install ok installed'; }
apt-get() { echo 'Unexpected package reinstall' >&2; return 90; }
stack_ensure_tools
grep -qx python3 "$fixture/packages"
if grep -qx git "$fixture/packages"; then echo 'CI mode requested git' >&2; exit 1; fi

new_run
touch "$fixture/no-manifest-project-aggregation"
set +e
(set -e; stack_prefetch; stack_run_installers)
status=$?
set -e
[[ "$status" != 0 && ! -e "$fixture/executed" ]]
rm "$fixture/no-manifest-project-aggregation"

new_run
touch "$fixture/missing-asset"
set +e
(set -e; stack_prefetch; stack_run_installers)
status=$?
set -e
[[ "$status" != 0 && ! -e "$fixture/executed" ]]
rm "$fixture/missing-asset"

new_run
stack_prefetch
[[ $(wc -l < "$fixture/manifests") -ge 2 && $(wc -l < "$fixture/heads") -ge 2 ]]
stack_run_installers
printf 'monitor\nhub\n' > "$fixture/expected"
cmp "$fixture/expected" "$fixture/executed"
printf 'CI stack preflight, failure isolation, runtime dependencies and mode propagation passed.\n'
