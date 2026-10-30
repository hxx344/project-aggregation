#!/usr/bin/env bash
# 副服务器一键部署主服务器巡检：每分钟探测一次，连续失败发飞书告警，恢复后通知。
# 可重复执行升级；未传参数时保留已有配置，内容未变且定时器正常时直接结束。
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
unset PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH
say() { printf '[main-watch] %s\n' "$*"; }
die() { printf '[main-watch] %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
用法: sudo bash install-main-watch.sh [选项]
  --main HOST:PORT     主服务器工作台地址，检查 http://HOST:PORT/api/ready
  --checks "目标 ..."  额外检查目标：http(s)://... 或 tcp://主机:端口，空格分隔；传空串清除
                       --main 与 --checks 分开保存，只改其中一项不影响另一项
  --webhook URL        飞书群机器人 Webhook
  --secret SECRET      机器人开启“签名校验”时的密钥
  --name NAME          告警里显示的服务器名称，默认“主服务器”
  --threshold N        连续失败几次才告警（每分钟一次），默认 3
  --remind MINUTES     故障持续时每隔多少分钟再提醒，默认 30
  --test               部署后发送测试消息（配置变化时总会发送）
  --uninstall          停止并移除巡检服务，保留 /etc/main-watch 配置
首次安装需要 --main 或 --checks，以及 --webhook；之后不带参数重复执行即为升级。
USAGE
}
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || die '请在 Linux 上以 root 或 sudo 运行。'
[[ -d /run/systemd/system ]] || die '需要正在运行的 systemd。'

root=/opt/main-watch
etc=/etc/main-watch
config=$etc/config
service=main-watch
unit=/etc/systemd/system/main-watch.service
timer=/etc/systemd/system/main-watch.timer
command_path=/usr/local/bin/main-watch
repository=hxx344/project-aggregation
files=(tools/main-watch/main_watch.py deploy/install-main-watch.sh)

args=("$@") source_dir='' source_revision='' send_test=0 uninstall=0
settings=()
while (($#)); do
  case $1 in
    --main|--checks|--webhook|--secret|--name|--threshold|--remind|--source|--revision)
      [[ $# -ge 2 ]] || die "$1 需要一个值"
      case $1 in
        --main)
          [[ $2 =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ || $2 =~ ^\[[0-9A-Fa-f:]+\]:[0-9]{1,5}$ ]] || die '--main 格式应为 主机:端口，例如 1.2.3.4:3100'
          settings+=("MAIN=$2") ;;
        --checks) settings+=("CHECKS=$2") ;;
        --webhook) settings+=("FEISHU_WEBHOOK=$2") ;;
        --secret) settings+=("FEISHU_SECRET=$2") ;;
        --name) settings+=("NAME=$2") ;;
        --threshold) settings+=("FAIL_THRESHOLD=$2") ;;
        --remind) settings+=("REMIND_MINUTES=$2") ;;
        --source) source_dir=$2 ;;
        --revision) source_revision=$2 ;;
      esac
      shift 2 ;;
    --test) send_test=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "未知参数：$1" ;;
  esac
done
[[ -z $source_revision || $source_revision =~ ^[a-f0-9]{40}$ ]] || die '--revision 必须是 40 位提交号。'

system_ready() {
  local tool
  for tool in python3 curl flock systemctl useradd runuser install cmp; do command -v "$tool" >/dev/null || return 1; done
  python3 -I -c 'import sys, ssl; ssl.create_default_context(); sys.exit(sys.version_info < (3, 8))' 2>/dev/null
}
if ! system_ready; then
  command -v apt-get >/dev/null || die '缺少 python3(>=3.8)/curl，且系统不是 apt 系，请先手工安装。'
  say '安装缺少的依赖：python3 curl ca-certificates'
  # 经 curl | bash 运行时脚本在标准输入里，不能让 apt 读走。
  apt-get update -qq </dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl ca-certificates util-linux passwd diffutils </dev/null >/dev/null
fi
system_ready || die '需要 python3 3.8+、curl 与 systemd。'
# 不解析符号链接：系统升级换掉 python3.X 后，单元仍指向有效的 python3。
python_bin=/usr/bin/python3
[[ -x $python_bin ]] || python_bin=$(command -v python3)

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
download() {
  # 最多三次尝试；连接、单次与总重试时长都有上限。
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --retry-max-time 120 \
    --connect-timeout 15 --max-time 60 --max-filesize 1048576 -fsSL "$1" -o "$2"
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

trusted "$root" "$etc" "$unit" "$timer" "$command_path"
install -d -m 755 "$root" "$root/sources"
exec 9>"$root/upgrade.lock"
flock -n 9 || die '另一个 main-watch 安装正在运行。'

if ((uninstall)); then
  systemctl disable --now main-watch.timer >/dev/null 2>&1 || true
  systemctl stop main-watch.service >/dev/null 2>&1 || true
  rm -f -- "$unit" "$timer" "$command_path"
  rm -rf -- "$root"
  systemctl daemon-reload
  systemctl reset-failed main-watch.service main-watch.timer >/dev/null 2>&1 || true
  say "已移除巡检服务。配置保留在 $etc，状态在 /var/lib/$service；不再需要时可手工删除，并执行 userdel $service。"
  exit 0
fi

scratch=$(mktemp -d "$root/.install-XXXXXX")
backup="$scratch/backup" switched=0 timer_was_enabled=0 timer_was_active=0
systemctl is-enabled --quiet main-watch.timer 2>/dev/null && timer_was_enabled=1
systemctl is-active --quiet main-watch.timer 2>/dev/null && timer_was_active=1
targets=("$root/main_watch.py" "$unit" "$timer" "$command_path" "$config")
restore() {
  local index target
  for index in "${!targets[@]}"; do
    target=${targets[$index]}
    if [[ -f $backup/$index ]]; then cp -p -- "$backup/$index" "$target"; else rm -f -- "$target"; fi
  done
  systemctl daemon-reload || true
  if ((timer_was_enabled)); then systemctl enable main-watch.timer >/dev/null 2>&1 || true; else systemctl disable main-watch.timer >/dev/null 2>&1 || true; fi
  if ((timer_was_active)); then systemctl restart main-watch.timer || true; else systemctl stop main-watch.timer >/dev/null 2>&1 || true; fi
}
cleanup() {
  local result=$?
  trap - EXIT HUP INT TERM
  if ((result != 0 && switched)); then
    printf '[main-watch] 部署失败，已恢复原有文件与定时器状态。\n' >&2
    restore
  fi
  [[ $scratch == "$root"/.install-* ]] && rm -rf -- "$scratch"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z $source_dir ]]; then
  # 引导阶段：取最新正式发布的固定提交，只下载白名单文件，再用该版本的安装器完成部署。
  download "https://github.com/$repository/releases/latest/download/release-manifest.json" "$scratch/manifest.json"
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
  if [[ -f $source_dir/.source-complete ]]; then
    trusted "$source_dir/.source-complete" "${files[@]/#/$source_dir/}" || die "源码缓存归属异常，请检查或删除：$source_dir"
    [[ $(source_digest "$source_dir") == "$(cat "$source_dir/.source-complete")" ]] || die '源码缓存校验失败，请删除后重试：'"$source_dir"
    say "正式版 ${source_revision:0:12} 已缓存，跳过下载。"
  else
    [[ ! -e $source_dir ]] || rm -rf -- "$source_dir"
    say "下载正式版 ${source_revision:0:12} 的巡检文件。"
    for name in "${files[@]}"; do
      mkdir -p "$scratch/source/$(dirname -- "$name")"
      download "https://raw.githubusercontent.com/$repository/$source_revision/$name" "$scratch/source/$name"
    done
    source_digest "$scratch/source" > "$scratch/source/.source-complete"
    chmod -R go-w,a+rX "$scratch/source"
    mv -T "$scratch/source" "$source_dir"
  fi
  # 只保留当前正式版的源码缓存。
  find "$root/sources" -mindepth 1 -maxdepth 1 -type d ! -name "$source_revision" -exec rm -rf -- {} +
  rm -rf -- "$scratch"
  trap - EXIT HUP INT TERM
  exec 9>&-
  exec bash "$source_dir/deploy/install-main-watch.sh" "${args[@]}" --source "$source_dir" --revision "$source_revision"
fi

trusted "$source_dir" "${files[@]/#/$source_dir/}" || die "--source 及其上级目录须归 root 所有且不可被他人写入：$source_dir"
program="$source_dir/tools/main-watch/main_watch.py"
revision_label=${source_revision:-local:$(source_digest "$source_dir" | cut -c1-12)}

# 合并配置：命令行给出的项覆盖已有配置，其余保留；未传参数时不改动配置文件。
if [[ ! -f $config && ${#settings[@]} -eq 0 ]]; then usage >&2; die '首次安装需要 --main 或 --checks，以及 --webhook。'; fi
if ((${#settings[@]})); then
  python3 -I -B - "$(dirname -- "$program")" "$config" "$scratch/config" "${settings[@]}" <<'PY'
import os, sys
sys.path.insert(0, sys.argv[1])
import main_watch
existing = {}
try:
    if os.path.exists(sys.argv[2]):
        with open(sys.argv[2], encoding='utf-8') as handle:
            existing = main_watch.parse_config(handle.read())
    for item in sys.argv[4:]:
        key, _, value = item.partition('=')
        if any(ch in value for ch in '\r\n'):
            raise main_watch.ConfigError(f'{key} 不能包含换行')
        existing[key] = value.strip()
    main_watch.validate(existing)
except main_watch.ConfigError as error:
    sys.exit(f'[main-watch] 配置无效，未做任何改动：{error}')
lines = ['# 由 install-main-watch.sh 维护；手工修改后执行 sudo main-watch check 校验']
lines += [f'{key}={existing[key]}' for key in main_watch.KEYS if key in existing]
with open(sys.argv[3], 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(lines) + '\n')
PY
else
  cp -p -- "$config" "$scratch/config"
fi
"$python_bin" -I "$program" --config "$scratch/config" --check >/dev/null || die '配置无效，未做任何改动。'

cat > "$scratch/service" <<UNIT
[Unit]
Description=Main server watch with Feishu alerts
Documentation=https://github.com/$repository/blob/main/docs/main-watch.md
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$service
Group=$service
StateDirectory=$service
WorkingDirectory=/var/lib/$service
ExecStart=$python_bin -I $root/main_watch.py --config $config
TimeoutStartSec=15min
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
UNIT
cat > "$scratch/timer" <<'UNIT'
[Unit]
Description=Run main-watch every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
cat > "$scratch/command" <<CMD
#!/bin/sh
# main-watch 管理命令，由 install-main-watch.sh 生成。
case "\$1" in
  check|probe|test) exec $python_bin -I $root/main_watch.py --config $config --"\$1" ;;
  status) systemctl list-timers main-watch.timer --no-pager; exec systemctl status main-watch.service --no-pager ;;
  logs) exec journalctl -u main-watch.service -n "\${2:-50}" --no-pager ;;
  *) echo "用法: sudo main-watch check|probe|test|status|logs [行数]" >&2; exit 2 ;;
esac
CMD
desired=("$program" "$scratch/service" "$scratch/timer" "$scratch/command" "$scratch/config")
modes=(644 644 644 755 640)

changed=()
for index in "${!targets[@]}"; do
  cmp -s -- "${desired[$index]}" "${targets[$index]}" || changed+=("$index")
done
id "$service" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /var/lib/$service --shell /usr/sbin/nologin "$service"
[[ $(id -u "$service") != 0 ]] || die '服务账号不能是 root。'
# 跳过标准与部署成功标准一致：文件与权限不变、定时器在运行，且 systemd 下最近一轮巡检成功。
healthy=0
if [[ -f $config && $(stat -c '%U:%G %a' "$config") == "root:$service 640" && $(stat -c '%U:%G %a' "$etc") == "root:$service 750" ]] &&
    systemctl is-enabled --quiet main-watch.timer && systemctl is-active --quiet main-watch.timer &&
    [[ $(systemctl show --property=NeedDaemonReload --value main-watch.service) == no &&
       $(systemctl show --property=NeedDaemonReload --value main-watch.timer) == no &&
       $(systemctl show --property=Result --value main-watch.service) == success ]]; then healthy=1; fi
if ((${#changed[@]} == 0 && healthy)); then
  say "版本 $revision_label：程序、配置与定时器均未变化，跳过部署。"
  if ((send_test)); then runuser -u "$service" -- "$python_bin" -I "$root/main_watch.py" --config "$config" --test; fi
  exit 0
fi

mkdir -p "$backup"
for index in "${!targets[@]}"; do
  [[ ! -f ${targets[$index]} ]] || cp -p -- "${targets[$index]}" "$backup/$index"
done
install -d -m 750 -o root -g "$service" "$etc"
switched=1
for index in "${!targets[@]}"; do
  group=root
  if ((index == 4)); then group=$service; fi
  install -m "${modes[$index]}" -o root -g "$group" "${desired[$index]}" "${targets[$index]}.next"
  mv -f -- "${targets[$index]}.next" "${targets[$index]}"
done
systemctl daemon-reload
config_changed=0
for index in "${changed[@]}"; do if ((index == 4)); then config_changed=1; fi; done
if ((send_test || config_changed)); then
  say '发送飞书测试消息，确认告警通道可用。'
  runuser -u "$service" -- "$python_bin" -I "$root/main_watch.py" --config "$config" --test || die '飞书测试消息发送失败，请检查 Webhook 与签名密钥。'
fi
# 按 systemd 的真实启动路径跑一轮，确认服务账号能读配置、写状态。
systemctl reset-failed main-watch.service >/dev/null 2>&1 || true
systemctl start main-watch.service || { journalctl -u main-watch.service -n 20 --no-pager >&2 || true; die '首轮巡检在 systemd 下运行失败。'; }
systemctl enable main-watch.timer >/dev/null 2>&1
systemctl restart main-watch.timer
systemctl is-active --quiet main-watch.timer || die '定时器未能启动。'
switched=0
say "已部署版本 $revision_label，每分钟巡检一次。当前探测结果："
"$python_bin" -I "$root/main_watch.py" --config "$config" --probe || say '注意：有目标当前不可达。若主服务器实际正常，请检查地址、端口放通和工作台监听地址。'
say '管理命令：sudo main-watch status | logs | probe | test'
