#!/usr/bin/env bash
# Install only the read-only public-data relay from a fixed stable release.
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
die() { printf '[relay] %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || die 'Run this Linux installer as root or with sudo.'
[[ -d /run/systemd/system ]] || die 'A running systemd is required.'
address='' source_dir='' source_revision=''
while (($#)); do
  case $1 in
    --address) [[ $# -ge 2 ]] || die '--address requires a public IP'; address=$2; shift 2 ;;
    --source) [[ $# -ge 2 ]] || die '--source requires a root-owned checkout'; source_dir=$2; shift 2 ;;
    --revision) [[ $# -ge 2 ]] || die '--revision requires a fixed commit'; source_revision=$2; shift 2 ;;
    --help|-h) printf 'Usage: sudo bash install-aster-relay.sh [--address PUBLIC_IP] [--source ROOT_OWNED_CHECKOUT]\n'; exit 0 ;;
    *) die 'Unknown argument; use --help.' ;;
  esac
done
[[ -z $source_revision || ( -n $source_dir && $source_revision =~ ^[a-f0-9]{40}$ ) ]] || die 'Invalid fixed source revision.'
root=/opt/aster-capacity-relay
etc=/etc/aster-capacity-relay
unit=/etc/systemd/system/aster-capacity-relay.service
cli=/usr/local/bin/aster-capacity-relay
service=aster-capacity-relay
repository=hxx344/project-aggregation
system_ready() {
  local tool
  for tool in python3 curl openssl sha256sum flock systemctl systemd-run useradd; do command -v "$tool" >/dev/null || return 1; done
  python3 -I -c 'import sys,venv,ensurepip,ssl; assert sys.version_info >= (3,11); ssl.create_default_context()' 2>/dev/null
}
if ! system_ready; then
  command -v apt-get >/dev/null || die 'Automatic dependency setup requires an apt-based system.'
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv curl openssl ca-certificates util-linux systemd passwd
fi
system_ready || die 'Python 3.11+, venv, OpenSSL and systemd are required.'

# This bootstrap check is self-contained: no local helper is run before its
# complete parent chain has passed the root ownership/write/link boundary.
trusted() {
  python3 -I - "$@" <<'PY'
import os, stat, sys
from pathlib import Path
for raw in sys.argv[1:]:
    path = Path(os.path.abspath(raw))
    for item in reversed((path, *path.parents)):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if (info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode)
                or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))):
            sys.exit('[relay] Untrusted path: ' + str(item))
PY
}
trusted "$root/releases" "$root/cache" "$root/sources" "$root/upgrade.lock" "$etc" "$unit" "$cli"
mkdir -p "$root/releases" "$root/cache" "$root/sources"
chmod 755 "$root" "$root/releases" "$root/cache" "$root/sources"
exec 9>"$root/upgrade.lock"
flock -n 9 || die 'Another relay installation is running.'
stage='' scratch='' old='' switched=0 was_active=0 was_enabled=0
if [[ -L $root/current ]]; then
  old=$(readlink -f "$root/current")
  [[ $old == "$root"/releases/release-* && -d $old ]] || die 'Invalid current release link.'
  trusted "$old"
elif [[ -e $root/current ]]; then
  die 'Current release must be an installer-managed symbolic link.'
fi
systemctl is-active --quiet "$service" && was_active=1
systemctl is-enabled --quiet "$service" && was_enabled=1
cleanup() {
  local result=$?
  trap - EXIT HUP INT TERM
  if ((result != 0 && switched)); then
    printf '[relay] Upgrade failed; restoring the previous release and service state.\n' >&2
    systemctl stop "$service" >/dev/null 2>&1 || true
    systemctl disable "$service" >/dev/null 2>&1 || true
    if [[ -n $old ]]; then
      ln -s "$old" "$scratch/current.rollback"
      mv -Tf "$scratch/current.rollback" "$root/current"
    else
      rm -f -- "$root/current"
    fi
    if [[ -f $scratch/previous.service ]]; then install -m 644 "$scratch/previous.service" "$unit"; else rm -f -- "$unit"; fi
    if [[ -f $scratch/previous.cli ]]; then install -m 755 "$scratch/previous.cli" "$cli"; else rm -f -- "$cli"; fi
    systemctl daemon-reload || true
    if ((was_enabled)); then systemctl enable "$service" || true; fi
    if ((was_active)); then
      systemctl start "$service" || printf '[relay] Previous service could not restart; inspect systemctl status.\n' >&2
    fi
  fi
  if [[ -n $stage && $stage == "$root"/releases/release-* && -f $stage/.install-owned &&
        $(readlink -f "$root/current" 2>/dev/null || true) != "$stage" ]]; then
    rm -rf -- "$stage"
  fi
  if [[ -n $scratch && $scratch == "$root"/.source-* ]]; then rm -rf -- "$scratch"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
scratch=$(mktemp -d "$root/.source-XXXXXX")

download() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --connect-timeout 20 --max-time 300 \
    --max-filesize "$3" -fsSL "$1" -o "$2"
}
if [[ -z $source_dir ]]; then
  download "https://github.com/$repository/releases/latest/download/release-manifest.json" "$scratch/manifest.json" 1048576
  source_revision=$(python3 -I - "$scratch/manifest.json" "$repository" <<'PY'
import json, re, sys
from pathlib import Path
data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
if (not isinstance(data, dict) or type(data.get('schema')) is not int or data['schema'] != 1
        or data.get('repository') != sys.argv[2] or not isinstance(data.get('commit'), str)
        or not re.fullmatch(r'[a-f0-9]{40}', data['commit']) or data.get('tag') != 'deploy-' + data['commit']):
    sys.exit('[relay] Invalid stable release manifest')
print(data['commit'])
PY
  )
  source_dir="$root/sources/$source_revision"
  trusted "$source_dir"
  if [[ -f $source_dir/.source-complete ]]; then
    trusted "$source_dir/deploy/aster-relay-source.py" "$source_dir/.source-complete"
    python3 -I "$source_dir/deploy/aster-relay-source.py" trust-source "$source_dir"
    printf '[relay] Stable revision unchanged; source download skipped.\n'
  else
    [[ ! -e $source_dir ]] || die 'Incomplete source cache; remove it after checking ownership.'
    printf '[relay] Downloading relay source for stable commit %.12s.\n' "$source_revision"
    # Fetch the extractor independently from the same fixed Git object over TLS.
    download "https://raw.githubusercontent.com/$repository/$source_revision/deploy/aster-relay-source.py" "$scratch/extract.py" 262144
    download "https://codeload.github.com/$repository/tar.gz/$source_revision" "$scratch/source.tar.gz" 134217728
    python3 -I "$scratch/extract.py" extract "$scratch/source.tar.gz" "$scratch/source" "$source_revision"
    python3 -I "$scratch/extract.py" trust-source "$scratch/source"
    touch "$scratch/source/.source-complete"
    mv -T "$scratch/source" "$source_dir"
  fi
  # Always execute the installation logic from that stable commit, including on
  # later upgrades invoked through an older, fixed bootstrap URL.
  rm -rf -- "$scratch"
  scratch=''
  exec 9>&-
  exec bash "$source_dir/deploy/install-aster-relay.sh" --source "$source_dir" --revision "$source_revision" --address "$address"
fi
trusted "$source_dir/deploy/aster-relay-source.py"
source_dir=$(cd -- "$source_dir" && pwd -P)
helper="$source_dir/deploy/aster-relay-source.py"
python3 -I "$helper" trust-source "$source_dir"
mapfile -t files < <(python3 -I "$helper" files)
fingerprints=$(python3 -I "$helper" fingerprints "$source_dir")
mapfile -t keys <<< "$fingerprints"
[[ ${keys[0]:-} =~ ^[a-f0-9]{64}$ && ${keys[1]:-} =~ ^[a-f0-9]{64}$ ]] || die 'Invalid source fingerprints.'
[[ -n $source_revision ]] || source_revision="local:${keys[1]}"
python_env="$root/cache/python-${keys[0]}"
trusted "$python_env" "$etc/environment" "$etc/server.crt" "$etc/server.key" "$etc/address" "$etc/connection.json"
if [[ -e $python_env ]]; then python3 -I "$helper" trust-cache "$python_env"; fi
installed_state() {
  python3 -I "$helper" state "$etc/environment" "$etc/server.crt" "$etc/server.key" "$etc/address" "$etc/connection.json" "$unit" "$cli"
}
if [[ -n $address && -f $etc/address ]]; then
  python3 -I - "$address" "$etc/address" <<'PY'
import ipaddress, pathlib, sys
if ipaddress.ip_address(sys.argv[1]) != ipaddress.ip_address(pathlib.Path(sys.argv[2]).read_text().strip()):
    sys.exit('[relay] Installed address and certificate are preserved; --address must match.')
PY
fi
if [[ -n $old ]]; then python3 -I "$helper" trust-cache "$old"; fi
if [[ -n $old && -f $old/.install-ready && -f $python_env/.complete && -x $python_env/bin/python &&
      $(cat "$old/.install-key" 2>/dev/null || true) == "${keys[1]}" &&
      $(cat "$old/.install-state" 2>/dev/null || true) == "$(installed_state 2>/dev/null || true)" ]] &&
    systemctl is-active --quiet "$service" && systemctl is-enabled --quiet "$service" &&
    [[ $(systemctl show --property=NeedDaemonReload --value "$service") == no ]] &&
    python3 -I "$source_dir/deploy/configure-aster-relay.py" health >/dev/null 2>&1; then
  printf '%s\n' "$source_revision" > "$scratch/revision"
  install -m 644 "$scratch/revision" "$old/.install-revision.next"
  mv -Tf "$old/.install-revision.next" "$old/.install-revision"
  printf '[relay] Stable identity recorded; content, dependencies and configuration unchanged. Installation, validation and restart skipped.\n'
  exit 0
fi
if [[ ! -f $etc/address && -z $address ]]; then
  if { true </dev/tty; } 2>/dev/null; then
    IFS= read -r -p 'Relay server public IP address: ' address </dev/tty
  else
    die 'First installation requires --address PUBLIC_IP (or an interactive terminal).'
  fi
fi
id "$service" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$root" --no-create-home --shell /usr/sbin/nologin "$service"
install -d -m 750 -o root -g "$service" "$etc"
python3 -I "$source_dir/deploy/configure-aster-relay.py" prepare-server --address "$address"
chmod 600 "$etc/environment" "$etc/connection.json" "$etc/address"
chown root:"$service" "$etc/server.key" "$etc/server.crt"
chmod 640 "$etc/server.key" "$etc/server.crt"
stage=$(mktemp -d "$root/releases/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
touch "$stage/.install-owned"
for name in "${files[@]}"; do
  mkdir -p "$(dirname -- "$stage/$name")"
  install -m 644 "$source_dir/$name" "$stage/$name"
done
if [[ -x $python_env/bin/python && -f $python_env/.complete ]]; then
  printf '[relay] Python dependencies unchanged; completed environment reused.\n'
else
  if [[ -e $python_env ]]; then rm -rf -- "$python_env"; fi
  python3 -I -m venv "$python_env"
  "$python_env/bin/python" -I -m pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: -q \
    -r "$stage/modules/aster/requirements-relay.lock"
  "$python_env/bin/python" -I -m pip check
  touch "$python_env/.complete"
  chmod -R a+rX "$python_env"
  printf '[relay] Python dependencies installed with verified hashes.\n'
fi
ln -s "$python_env" "$stage/.venv"
"$python_env/bin/python" -I - "$stage" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for path in root.rglob('*.py'):
    if '.venv' not in path.parts:
        compile(path.read_text(encoding='utf-8'), str(path), 'exec')
PY
chmod -R a+rX "$stage"
systemd-run --quiet --wait --pipe --collect --unit="aster-capacity-relay-check-$$" \
  --uid="$service" --gid="$service" --property="EnvironmentFile=$etc/environment" \
  --property="WorkingDirectory=$stage/modules/aster" --property=Environment=PYTHONDONTWRITEBYTECODE=1 \
  --property="UnsetEnvironment=PYTHONPATH PYTHONHOME" \
  "$python_env/bin/python" -m trading.capacity_relay_server --check-config
if [[ -f $unit ]]; then cp -p "$unit" "$scratch/previous.service"; fi
if [[ -f $cli ]]; then cp -p "$cli" "$scratch/previous.cli"; fi
switched=1
ln -s "$stage" "$scratch/current.next"
mv -Tf "$scratch/current.next" "$root/current"
install -m 644 "$stage/deploy/aster-capacity-relay.service" "$unit"
install -m 755 "$stage/deploy/aster-capacity-relay" "$cli"
systemctl daemon-reload
systemctl enable "$service"
systemctl restart "$service"
healthy=0
for attempt in {1..20}; do
  if systemctl is-active --quiet "$service" && python3 -I "$stage/deploy/configure-aster-relay.py" health >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 1
done
[[ $healthy == 1 ]] || die 'Relay liveness check failed.'
printf '%s\n' "${keys[1]}" > "$stage/.install-key"
printf '%s\n' "$source_revision" > "$stage/.install-revision"
installed_state > "$stage/.install-state"
touch "$stage/.install-ready"
# The transaction ends only after durable installation identity/state exist.
switched=0
printf '[relay] Installed and listening with authenticated TLS (default port 8766). Upstream sample readiness is reported separately.\n'
python3 -I "$stage/deploy/configure-aster-relay.py" status || printf '[relay] Collector status is not yet available; inspect the service logs.\n'
printf 'Status: sudo aster-capacity-relay status\nLogs: sudo aster-capacity-relay logs\n'
printf 'Export private connection JSON: sudo aster-capacity-relay export-connect\n'
