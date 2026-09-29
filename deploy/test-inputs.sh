#!/usr/bin/env bash
# Real git trees; runs on native Git Bash as well as Linux without services/symlinks.
set -Eeuo pipefail
AGG_INSTALL_SOURCE_ONLY=1 source "$(dirname "$0")/../install.sh"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
APP_DIR="$fixture/application"
source_dir="$fixture/source"
mkdir -p "$APP_DIR" "$source_dir/src" "$source_dir/server" "$source_dir/tests"
git -C "$source_dir" init -q -b main
git -C "$source_dir" config core.autocrlf false
git -C "$source_dir" config user.name fixture
git -C "$source_dir" config user.email fixture@example.invalid
for file in package.json package-lock.json tsconfig.json src/app.ts server/index.mjs tests/app.test.mjs; do
  printf '{}\n' > "$source_dir/$file"
done
git -C "$source_dir" add .
git -C "$source_dir" commit -qm initial
git clone -q --bare "$source_dir" "$APP_DIR/repository.git"
runtime_key=fixture-node
build_environment='[]'
refresh() {
  git -C "$source_dir" add .
  if ! git -C "$source_dir" diff --cached --quiet; then git -C "$source_dir" commit -qm change; fi
  git --git-dir="$APP_DIR/repository.git" fetch -q "$source_dir" main
  commit=$(git -C "$source_dir" rev-parse HEAD)
  input_keys
}
capture() { before=($dependency_key $typecheck_key $test_key $build_key $application_key); }
compare() {
  local after=($dependency_key $typecheck_key $test_key $build_key $application_key) index=0 changed
  for changed in "$@"; do
    if [[ $changed == 1 ]]; then [[ ${before[$index]} != "${after[$index]}" ]]
    else [[ ${before[$index]} == "${after[$index]}" ]]; fi
    index=$((index + 1))
  done
}
refresh
capture
echo docs > "$source_dir/README.md"; refresh; compare 0 0 0 0 0
capture
echo test >> "$source_dir/tests/app.test.mjs"; refresh; compare 0 0 1 0 0
capture
echo backend >> "$source_dir/server/index.mjs"; refresh; compare 0 0 1 0 1
capture
echo frontend >> "$source_dir/src/app.ts"; refresh; compare 0 1 1 1 1
capture
echo config >> "$source_dir/tsconfig.json"; refresh; compare 0 1 1 1 1
capture
echo VITE_PUBLIC=fixture > "$source_dir/.env.production"; refresh; compare 0 0 0 1 1
capture
build_environment='[["VITE_PUBLIC","new"]]'; input_keys; compare 0 0 0 1 1
capture
echo dependency >> "$source_dir/package-lock.json"; refresh; compare 1 1 1 1 1
capture
runtime_key=another-node; input_keys; compare 1 1 1 1 1
commit=invalid-source
if input_keys 2>/dev/null; then echo 'Invalid git source was silently hashed' >&2; exit 1; fi
printf 'Git input classification passed, including tsconfig, Vite env and failed reads.\n'
