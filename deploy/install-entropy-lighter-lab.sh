#!/usr/bin/env bash
# Independent public-data research service. No credentials, orders or listening ports.
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
unset NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH
die() { printf '[entropy-lighter-lab] %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || die 'Run this Linux installer as root or with sudo.'
[[ -d /run/systemd/system ]] || die 'A running systemd is required.'
source_dir='' source_revision=''
while (($#)); do
  case $1 in
    --source) [[ $# -ge 2 ]] || die '--source requires a root-owned source directory'; source_dir=$2; shift 2 ;;
    --revision) [[ $# -ge 2 ]] || die '--revision requires a fixed commit'; source_revision=$2; shift 2 ;;
    --help|-h) printf 'Usage: sudo bash install-entropy-lighter-lab.sh [--source ROOT_OWNED_SOURCE]\n'; exit 0 ;;
    *) die 'Unknown argument; use --help.' ;;
  esac
done
[[ -z $source_revision || ( -n $source_dir && $source_revision =~ ^[a-f0-9]{40}$ ) ]] || die 'Invalid source revision.'
root=/opt/entropy-lighter-lab
etc=/etc/entropy-lighter-lab
data=/var/lib/entropy-lighter-lab
unit=/etc/systemd/system/entropy-lighter-lab.service
service=entropy-lighter-lab
repository=hxx344/project-aggregation
node_version=24.15.0
files=(tools/entropy-lighter-lab/cli.mjs tools/entropy-lighter-lab/core.mjs tools/entropy-lighter-lab/feeds.mjs tools/entropy-lighter-lab/binance-scalper.mjs tools/entropy-lighter-lab/config.example.json deploy/install-entropy-lighter-lab.sh)
system_ready() {
  local tool
  for tool in python3 curl sha256sum flock systemctl systemd-run useradd runuser tar xz; do command -v "$tool" >/dev/null || return 1; done
  python3 -I -c 'import ssl; ssl.create_default_context()' 2>/dev/null
}
if ! system_ready; then
  command -v apt-get >/dev/null || die 'Automatic dependency setup requires an apt-based system.'
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl ca-certificates util-linux systemd passwd tar xz-utils
fi
system_ready || die 'Python, curl, xz and systemd are required.'
trusted() {
  python3 -I - "$@" <<'PY'
# BEGIN TRUST_PATHS
import os, stat, sys
from pathlib import Path
def trust_paths(paths):
    for raw in paths:
        if '..' in Path(raw).parts:
            raise ValueError('Parent traversal in trusted path')
        path = Path(os.path.abspath(raw))
        for item in reversed((path, *path.parents)):
            try:
                info = item.lstat()
            except FileNotFoundError:
                continue
            if (info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode)
                    or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))):
                raise ValueError('Untrusted path: ' + str(item))
trust_paths(sys.argv[1:])
# END TRUST_PATHS
PY
}
trusted "$root/releases" "$root/sources" "$root/runtime" "$root/upgrade.lock" "$etc/config.json" "$unit" "$(dirname -- "$data")"
if [[ -e $unit.d ]]; then
  trusted "$unit.d"
  while IFS= read -r -d '' extra; do trusted "$extra"; done < <(find "$unit.d" -mindepth 1 -print0)
fi
mkdir -p "$root/releases" "$root/sources" "$root/runtime"
chmod 755 "$root" "$root/releases" "$root/sources" "$root/runtime"
exec 9>"$root/upgrade.lock"
flock -n 9 || die 'Another lab installation is running.'
stage='' scratch='' old='' switched=0 was_active=0 was_enabled=0
if [[ -L $root/current ]]; then
  old=$(readlink -f "$root/current")
  [[ $old == "$root"/releases/release-* && -d $old ]] || die 'Invalid current release link.'
  trusted "$old"
elif [[ -e $root/current ]]; then die 'Current release must be an installer-managed symbolic link.'; fi
systemctl is-active --quiet "$service" && was_active=1
systemctl is-enabled --quiet "$service" && was_enabled=1
cleanup() {
  local result=$?
  trap - EXIT HUP INT TERM
  if ((result != 0 && switched)); then
    printf '[entropy-lighter-lab] Activation failed; restoring the previous release and service state.\n' >&2
    systemctl stop "$service" >/dev/null 2>&1 || true
    systemctl disable "$service" >/dev/null 2>&1 || true
    if [[ -n $old ]]; then
      ln -s "$old" "$scratch/current.rollback"
      mv -Tf "$scratch/current.rollback" "$root/current"
    else rm -f -- "$root/current"; fi
    if [[ -f $scratch/previous.service ]]; then install -m 644 "$scratch/previous.service" "$unit"; else rm -f -- "$unit"; fi
    systemctl daemon-reload || true
    systemctl reset-failed "$service" >/dev/null 2>&1 || true
    if ((was_enabled)); then systemctl enable "$service" || true; fi
    if ((was_active)); then systemctl start "$service" || printf '[entropy-lighter-lab] Previous service could not restart; inspect systemctl status.\n' >&2; fi
  fi
  if [[ -n $stage && $stage == "$root"/releases/release-* && -f $stage/.install-owned &&
        $(readlink -f "$root/current" 2>/dev/null || true) != "$stage" ]]; then rm -rf -- "$stage"; fi
  if [[ -n $scratch && $scratch == "$root"/.install-* ]]; then rm -rf -- "$scratch"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
scratch=$(mktemp -d "$root/.install-XXXXXX")
download() {
  # At most three attempts; bounded connection, attempt and retry duration.
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --retry-max-time 180 \
    --connect-timeout 15 --max-time 90 --max-filesize "$3" -fsSL "$1" -o "$2"
}
source_digest() {
  python3 -I - "$1" "${files[@]}" <<'PY'
# BEGIN SOURCE_DIGEST
import hashlib, sys
from pathlib import Path
def source_digest(root, names):
    digest = hashlib.sha256()
    for name in names:
        path = Path(root) / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 1048576:
            raise ValueError('Missing, linked or oversized source: ' + name)
        digest.update(name.encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()
print(source_digest(sys.argv[1], sys.argv[2:]))
# END SOURCE_DIGEST
PY
}
if [[ -z $source_dir ]]; then
  download "https://github.com/$repository/releases/latest/download/release-manifest.json" "$scratch/manifest.json" 1048576
  source_revision=$(python3 -I - "$scratch/manifest.json" "$repository" <<'PY'
# BEGIN MANIFEST_COMMIT
import json, re, sys
from pathlib import Path
def manifest_commit(value, repository):
    if (not isinstance(value, dict) or type(value.get('schema')) is not int or value['schema'] != 1
            or value.get('repository') != repository or not isinstance(value.get('commit'), str)
            or not re.fullmatch(r'[a-f0-9]{40}', value['commit']) or value.get('tag') != 'deploy-' + value['commit']):
        raise ValueError('Invalid stable release manifest')
    return value['commit']
print(manifest_commit(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')), sys.argv[2]))
# END MANIFEST_COMMIT
PY
  )
  source_dir="$root/sources/$source_revision"
  trusted "$source_dir/.source-complete"
  if [[ -f $source_dir/.source-complete ]]; then
    for name in "${files[@]}"; do trusted "$source_dir/$name"; done
    [[ $(source_digest "$source_dir") == "$(cat "$source_dir/.source-complete")" ]] || die 'Source cache integrity check failed.'
    printf '[entropy-lighter-lab] Stable source unchanged; download skipped.\n'
  else
    [[ ! -e $source_dir ]] || die 'Incomplete source cache; inspect it before retrying.'
    printf '[entropy-lighter-lab] Downloading six allowlisted files from stable commit %.12s.\n' "$source_revision"
    for name in "${files[@]}"; do
      mkdir -p "$scratch/source/$(dirname -- "$name")"
      download "https://raw.githubusercontent.com/$repository/$source_revision/$name" "$scratch/source/$name" 1048576
    done
    source_digest "$scratch/source" > "$scratch/source/.source-complete"
    chmod -R a+rX "$scratch/source"
    mv -T "$scratch/source" "$source_dir"
  fi
  # Use the stable install recipe even when invoked through an older bootstrap.
  rm -rf -- "$scratch"
  scratch=''
  exec 9>&-
  exec bash "$source_dir/deploy/install-entropy-lighter-lab.sh" --source "$source_dir" --revision "$source_revision"
fi
for name in "${files[@]}"; do trusted "$source_dir/$name"; done
source_dir=$(cd -- "$source_dir" && pwd -P)
source_key=$(source_digest "$source_dir")
[[ -n $source_revision ]] || source_revision="local:$source_key"
node_supported() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a===24&&b>=15?0:1)' >/dev/null 2>&1; }
node_bin=''
case $(uname -m) in x86_64) machine=x64 ;; aarch64|arm64) machine=arm64 ;; *) die 'Only Linux x64 and arm64 are supported.' ;; esac
runtime_dir="$root/runtime/node-v${node_version}-linux-${machine}"
for candidate in "$(command -v node || true)" "/opt/project-aggregation/runtime/node-v${node_version}-linux-${machine}/bin/node" "$runtime_dir/bin/node"; do
  [[ -n $candidate && -x $candidate ]] || continue
  candidate=$(readlink -f "$candidate")
  if trusted "$candidate" 2>/dev/null && node_supported "$candidate"; then node_bin=$candidate; break; fi
done
if [[ -z $node_bin ]]; then
  trusted "$runtime_dir"
  [[ ! -e $runtime_dir ]] || die 'Existing Node runtime is incomplete or untrusted.'
  archive="node-v${node_version}-linux-${machine}.tar.xz"
  printf '[entropy-lighter-lab] Installing fixed Node %s with official SHA-256 verification.\n' "$node_version"
  download "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" "$scratch/SHASUMS256.txt" 1048576
  download "https://nodejs.org/dist/v${node_version}/$archive" "$scratch/$archive" 104857600
  checksum=$(awk -v name="$archive" '$2 == name { print $1 }' "$scratch/SHASUMS256.txt")
  [[ $checksum =~ ^[a-f0-9]{64}$ ]] || die 'Official Node checksum is missing or ambiguous.'
  (cd -- "$scratch" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status)
  # Validate the archive, then materialize only bin/node; npm links are never extracted.
  python3 -I - "$scratch/$archive" "node-v${node_version}-linux-${machine}" "$scratch/runtime" <<'PY'
# BEGIN NODE_ARCHIVE
import sys, tarfile
from pathlib import Path, PurePosixPath
def validate_node_archive(archive, prefix):
    seen, total = set(), 0
    with tarfile.open(archive, 'r:xz') as handle:
        for member in handle:
            parts = PurePosixPath(member.name).parts
            if (not parts or parts[0] != prefix or member.name.startswith('/') or '..' in parts
                    or '\\' in member.name or member.name in seen
                    or not (member.isdir() or member.isfile() or member.issym() or member.islnk())):
                raise ValueError('Unsafe Node archive member')
            seen.add(member.name)
            total += member.size
            if len(seen) > 20000 or total > 536870912:
                raise ValueError('Node archive exceeds limits')
        executable = handle.getmember(prefix + '/bin/node')
        if not executable.isfile() or not 0 < executable.size <= 268435456:
            raise ValueError('Node archive has no regular executable')
def extract_node(archive, prefix, destination):
    validate_node_archive(archive, prefix)
    target = Path(destination) / prefix / 'bin/node'
    target.parent.mkdir(parents=True)
    with tarfile.open(archive, 'r:xz') as handle, target.open('xb') as output:
        output.write(handle.extractfile(prefix + '/bin/node').read(268435457))
    target.chmod(0o755)
extract_node(sys.argv[1], sys.argv[2], sys.argv[3])
# END NODE_ARCHIVE
PY
  chmod -R go-w,a+rX "$scratch/runtime"
  node_supported "$scratch/runtime/node-v${node_version}-linux-${machine}/bin/node" || die 'Downloaded Node version is unsupported.'
  mv -T "$scratch/runtime/node-v${node_version}-linux-${machine}" "$runtime_dir"
  node_bin="$runtime_dir/bin/node"
else printf '[entropy-lighter-lab] Trusted Node 24 reused; dependency download skipped.\n'; fi
trusted "$node_bin"
node_key=$(printf '%s\n%s\n%s\n' "$node_bin" "$("$node_bin" --version)" "$(sha256sum "$node_bin" | cut -d ' ' -f1)" | sha256sum | cut -d ' ' -f1)
id "$service" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$data" --no-create-home --shell /usr/sbin/nologin "$service"
[[ $(id -u "$service") != 0 ]] || die 'Service account must not be root.'
install -d -m 750 -o root -g "$service" "$etc"
if [[ ! -e $etc/config.json ]]; then install -m 640 -o root -g "$service" "$source_dir/tools/entropy-lighter-lab/config.example.json" "$etc/config.json"; fi
trusted "$etc/config.json"
[[ ! -L $data ]] || die 'Data directory must not be a symbolic link.'
if [[ -e $data ]]; then
  [[ -d $data && $(stat -c %u "$data") == "$(id -u "$service")" && $(stat -c %a "$data") == 750 ]] || die 'Existing data directory ownership or mode is unexpected.'
else install -d -m 750 -o "$service" -g "$service" "$data"; fi
cat > "$scratch/service" <<UNIT
[Unit]
Description=Entropy and Lighter public-data research lab
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$service
Group=$service
WorkingDirectory=$root/current
ExecStart=$root/current/node $root/current/tools/entropy-lighter-lab/cli.mjs run --config $etc/config.json --data $data
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
UMask=0027
Environment=NODE_ENV=production
Environment=HOME=$data
UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SocketBindDeny=any
ReadWritePaths=$data

[Install]
WantedBy=multi-user.target
UNIT
state_key() { printf '%s\n%s\n%s\n%s\n' "$source_key" "$node_key" "$(sha256sum "$etc/config.json" | cut -d ' ' -f1)" "$(sha256sum "$1" | cut -d ' ' -f1)" | sha256sum | cut -d ' ' -f1; }
expected_state=$(state_key "$scratch/service")
status_live() {
  local pid
  pid=$(systemctl show --property=MainPID --value "$service")
  python3 -I - "$data/status.json" "$pid" <<'PY'
# BEGIN STATUS_LIVE
import datetime, json, os, stat, sys
def status_live(path, pid, now=None):
    expected = int(pid)
    if expected <= 0:
        raise ValueError('No running service PID')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 262144:
            raise ValueError('Invalid status file')
        value = json.loads(handle.read(262145))
    if (type(value.get('pid')) is not int or value['pid'] != expected
            or not isinstance(value.get('session'), str) or not value['session']
            or value.get('mode') not in ('research', 'paper') or value.get('stopped') is True):
        raise ValueError('Status does not belong to the running research process')
    current = now or datetime.datetime.now(datetime.timezone.utc)
    start = datetime.datetime.fromisoformat(value['startedAt'].replace('Z', '+00:00'))
    heartbeat = datetime.datetime.fromisoformat(value['heartbeatAt'].replace('Z', '+00:00'))
    if start.tzinfo is None or heartbeat.tzinfo is None or start > heartbeat or not -5 <= (current - heartbeat).total_seconds() <= 30:
        raise ValueError('Research heartbeat is stale or invalid')
status_live(sys.argv[1], sys.argv[2])
# END STATUS_LIVE
PY
}
if [[ -n $old ]]; then
  for name in "${files[@]}"; do trusted "$old/$name"; done
  trusted "$old/.install-state" "$old/.install-revision" "$old/.install-ready"
fi
if [[ -n $old && -f $old/.install-ready && -f $unit &&
      $(cat "$old/.install-state" 2>/dev/null || true) == "$expected_state" &&
      $(source_digest "$old") == "$source_key" && $(state_key "$unit") == "$expected_state" &&
      $(readlink -f "$old/node") == "$node_bin" ]] &&
    systemctl is-active --quiet "$service" && systemctl is-enabled --quiet "$service" &&
    [[ $(systemctl show --property=NeedDaemonReload --value "$service") == no ]] && status_live >/dev/null 2>&1; then
  printf '%s\n' "$source_revision" > "$scratch/revision"
  install -m 644 "$scratch/revision" "$old/.install-revision.next"
  mv -Tf "$old/.install-revision.next" "$old/.install-revision"
  printf '[entropy-lighter-lab] Stable identity recorded; content, Node and configuration unchanged. Validation and restart skipped.\n'
  exit 0
fi
stage=$(mktemp -d "$root/releases/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
touch "$stage/.install-owned"
for name in "${files[@]}"; do mkdir -p "$stage/$(dirname -- "$name")"; install -m 644 "$source_dir/$name" "$stage/$name"; done
ln -s "$node_bin" "$stage/node"
chmod -R a+rX "$stage"
systemd-run --quiet --wait --pipe --collect --unit="entropy-lighter-lab-check-$$" \
  --uid="$service" --gid="$service" --property=NoNewPrivileges=true --property=ProtectHome=true --property=PrivateNetwork=true \
  --property="WorkingDirectory=$stage" --property="UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH" \
  "$node_bin" "$stage/tools/entropy-lighter-lab/cli.mjs" check --config "$etc/config.json"
if [[ -f $unit ]]; then cp -p "$unit" "$scratch/previous.service"; fi
switched=1
ln -s "$stage" "$scratch/current.next"
mv -Tf "$scratch/current.next" "$root/current"
install -m 644 "$scratch/service" "$unit"
systemctl daemon-reload
systemctl enable "$service"
systemctl reset-failed "$service" >/dev/null 2>&1 || true
systemctl restart "$service"
healthy=0
for attempt in {1..25}; do
  if systemctl is-active --quiet "$service" && status_live >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
[[ $healthy == 1 ]] || die 'Research process/heartbeat check failed.'
printf '%s\n' "$expected_state" > "$stage/.install-state"
printf '%s\n' "$source_revision" > "$stage/.install-revision"
touch "$stage/.install-ready"
switched=0
printf '[entropy-lighter-lab] Installed. Process and heartbeat are healthy; upstream sample readiness is reported separately.\n'
printf 'Status: sudo systemctl status entropy-lighter-lab\nLogs: sudo journalctl -u entropy-lighter-lab -f\n'
printf 'Report: sudo %s/current/node %s/current/tools/entropy-lighter-lab/cli.mjs report --data %s\n' "$root" "$root" "$data"
