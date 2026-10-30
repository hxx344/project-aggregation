#!/usr/bin/env bash
# 副服务器一键部署主服务器巡检：每分钟探测一次，连续失败发飞书告警，恢复后通知。
# 可选心跳模式：副服务器常驻接收签名心跳，主服务器用 --sender 安装每 30 秒一次的心跳推送。
# 可重复执行升级；未传参数时保留已有配置，内容未变且服务正常时直接结束。
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
unset PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH
say() { printf '[main-watch] %s\n' "$*"; }
die() { printf '[main-watch] %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
用法（副服务器，巡检与告警）: sudo bash install-main-watch.sh [选项]
  --main HOST:PORT     主服务器工作台地址，检查 http://HOST:PORT/api/ready
  --checks "目标 ..."  额外检查目标：http(s)://... 或 tcp://主机:端口，空格分隔；传空串清除
                       --main 与 --checks 分开保存，只改其中一项不影响另一项
  --heartbeat-listen HOST:PORT
                       接收主服务器心跳的监听地址，如 0.0.0.0:8792；传空串关闭心跳模式
  --heartbeat-token T  心跳共享令牌（32~256 位字母数字-_）；开启心跳且未设置时自动生成
  --webhook URL        飞书群机器人 Webhook
  --secret SECRET      机器人开启“签名校验”时的密钥
  --name NAME          告警里显示的服务器名称，默认“主服务器”
  --threshold N        连续失败几次才告警（每分钟一次），默认 3
  --remind MINUTES     故障持续时每隔多少分钟再提醒，默认 30
  --test               部署后发送测试消息（配置变化时总会发送）
  --uninstall          停止并移除巡检服务，保留 /etc/main-watch 配置
首次安装需要 --main、--checks 或 --heartbeat-listen 之一，以及 --webhook；之后不带参数重复执行即为升级。

用法（主服务器，心跳推送）: sudo bash install-main-watch.sh --sender [选项]
  --send-to URL        副服务器心跳地址，如 http://副服务器IP:8792/heartbeat
  --heartbeat-token T  与副服务器相同的心跳令牌
  --ready-url URL      本机工作台就绪接口，默认按 /etc/project-aggregation.env 的 HOST/PORT 推算
  --uninstall          停止并移除心跳推送，保留 /etc/main-watch/sender 配置
首次安装需要 --send-to 与 --heartbeat-token；之后 sudo bash install-main-watch.sh --sender 即为升级。
USAGE
}
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || die '请在 Linux 上以 root 或 sudo 运行。'
[[ -d /run/systemd/system ]] || die '需要正在运行的 systemd。'

root=/opt/main-watch
etc=/etc/main-watch
service=main-watch
systemd_dir=/etc/systemd/system
repository=hxx344/project-aggregation
files=(tools/main-watch/main_watch.py deploy/install-main-watch.sh)
# 两种角色共用程序目录与服务账号，各自的配置、单元与管理命令互不覆盖。
watch_units=(main-watch.service main-watch.timer main-watch-heartbeat.service)
sender_units=(main-watch-sender.service main-watch-sender.timer)

args=("$@") source_dir='' source_revision='' send_test=0 uninstall=0 sender=0
settings=() watch_only='' sender_only=''
while (($#)); do
  case $1 in
    --main|--checks|--webhook|--secret|--name|--threshold|--remind|--heartbeat-listen|--heartbeat-token|--send-to|--ready-url|--source|--revision)
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
        --heartbeat-listen) settings+=("HEARTBEAT_LISTEN=$2") ;;
        --heartbeat-token) settings+=("HEARTBEAT_TOKEN=$2") ;;
        --send-to) settings+=("HEARTBEAT_URL=$2") ;;
        --ready-url) settings+=("READY_URL=$2") ;;
        --source) source_dir=$2 ;;
        --revision) source_revision=$2 ;;
      esac
      case $1 in
        --send-to|--ready-url) sender_only=$1 ;;
        --heartbeat-token|--source|--revision) ;;
        *) watch_only=$1 ;;
      esac
      shift 2 ;;
    --test) send_test=1 watch_only=$1; shift ;;
    --sender) sender=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "未知参数：$1" ;;
  esac
done
[[ -z $source_revision || $source_revision =~ ^[a-f0-9]{40}$ ]] || die '--revision 必须是 40 位提交号。'
if ((sender)); then
  [[ -z $watch_only ]] || die "$watch_only 只用于副服务器巡检，不能与 --sender 一起使用。"
  config=$etc/sender command_path=/usr/local/bin/main-watch-sender units=("${sender_units[@]}") other_units=("${watch_units[@]}")
else
  [[ -z $sender_only ]] || die "$sender_only 只用于主服务器心跳推送，需要同时传 --sender。"
  config=$etc/config command_path=/usr/local/bin/main-watch units=("${watch_units[@]}") other_units=("${sender_units[@]}")
fi
role_args=()
if ((sender)); then role_args=(--sender); fi

# 不解析符号链接：系统升级换掉 python3.X 后，单元仍指向有效的 python3。依赖检查与服务使用同一个解释器。
pick_python() { if [[ -x /usr/bin/python3 ]]; then python_bin=/usr/bin/python3; else python_bin=$(command -v python3 || true); fi; }
system_ready() {
  local tool
  for tool in curl flock systemctl useradd runuser install cmp; do command -v "$tool" >/dev/null || return 1; done
  pick_python
  [[ -n $python_bin ]] && "$python_bin" -I -c 'import sys, ssl; ssl.create_default_context(); sys.exit(sys.version_info < (3, 8))' 2>/dev/null
}
if ! system_ready; then
  command -v apt-get >/dev/null || die '缺少 python3(>=3.8)/curl，且系统不是 apt 系，请先手工安装。'
  say '安装缺少的依赖：python3 curl ca-certificates'
  # 经 curl | bash 运行时脚本在标准输入里，不能让 apt 读走。
  apt-get update -qq </dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl ca-certificates util-linux passwd diffutils </dev/null >/dev/null
fi
system_ready || die '需要 python3 3.8+、curl 与 systemd。'

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

trusted "$root" "$etc" "${watch_units[@]/#/$systemd_dir/}" "${sender_units[@]/#/$systemd_dir/}" /usr/local/bin/main-watch /usr/local/bin/main-watch-sender
install -d -m 755 "$root" "$root/sources"
exec 9>"$root/upgrade.lock"
flock -n 9 || die '另一个 main-watch 安装正在运行。'

if ((uninstall)); then
  systemctl disable --now "${units[@]:1}" >/dev/null 2>&1 || true
  systemctl stop "${units[0]}" >/dev/null 2>&1 || true
  rm -f -- "${units[@]/#/$systemd_dir/}" "$command_path"
  # 另一角色仍在本机时保留共用的程序目录。
  other_left=0
  for name in "${other_units[@]}"; do [[ ! -e $systemd_dir/$name ]] || other_left=1; done
  ((other_left)) || rm -rf -- "$root"
  systemctl daemon-reload
  systemctl reset-failed "${units[@]}" >/dev/null 2>&1 || true
  if ((sender)); then say "已移除心跳推送。配置保留在 $config。"
  else say "已移除巡检服务。配置保留在 $etc，状态在 /var/lib/$service；不再需要时可手工删除，并执行 userdel $service。"; fi
  exit 0
fi

scratch=$(mktemp -d "$root/.install-XXXXXX")
backup="$scratch/backup" switched=0
# 记录定时器与心跳接收服务原来的启用与运行状态，失败时按原样恢复。
declare -A was_enabled=() was_active=()
for name in "${units[@]:1}"; do
  systemctl is-enabled --quiet "$name" 2>/dev/null && was_enabled[$name]=1
  systemctl is-active --quiet "$name" 2>/dev/null && was_active[$name]=1
done
targets=("$root/main_watch.py" "${units[@]/#/$systemd_dir/}" "$command_path" "$config")
config_index=$((${#targets[@]} - 1)) command_index=$((${#targets[@]} - 2))
restore() {
  local index target name
  for index in "${!targets[@]}"; do
    target=${targets[$index]}
    if [[ -f $backup/$index ]]; then cp -p -- "$backup/$index" "$target"; else rm -f -- "$target"; fi
  done
  systemctl daemon-reload || true
  for name in "${units[@]:1}"; do
    if [[ -n ${was_enabled[$name]:-} ]]; then systemctl enable "$name" >/dev/null 2>&1 || true; else systemctl disable "$name" >/dev/null 2>&1 || true; fi
    if [[ -n ${was_active[$name]:-} ]]; then systemctl restart "$name" || true; else systemctl stop "$name" >/dev/null 2>&1 || true; fi
  done
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
if [[ ! -f $config && ${#settings[@]} -eq 0 ]]; then
  usage >&2
  if ((sender)); then die '首次安装需要 --send-to 与 --heartbeat-token。'; fi
  die '首次安装需要 --main、--checks 或 --heartbeat-listen 之一，以及 --webhook。'
fi
# 主服务器首次安装且未指定 --ready-url 时，按工作台环境文件推算本机就绪接口。
ready_given=0
for item in "${settings[@]}"; do [[ $item != READY_URL=* ]] || ready_given=1; done
if ((sender && !ready_given)) && [[ ! -f $config && -f /etc/project-aggregation.env ]] && trusted /etc/project-aggregation.env 2>/dev/null; then
  app_host=$(sed -n 's/^HOST=//p' /etc/project-aggregation.env | tail -n 1 | tr -d "\"' ")
  app_port=$(sed -n 's/^PORT=//p' /etc/project-aggregation.env | tail -n 1 | tr -d "\"' ")
  app_host=${app_host:-127.0.0.1}
  case $app_host in 0.0.0.0) app_host=127.0.0.1 ;; ::) app_host='[::1]' ;; *:*) app_host="[$app_host]" ;; esac
  settings+=("READY_URL=http://$app_host:${app_port:-3100}/api/ready")
fi
if ((${#settings[@]})); then
  python3 -I -B - "$(dirname -- "$program")" "$config" "$scratch/config" "$sender" "${settings[@]}" <<'PY'
import os, secrets, sys
sys.path.insert(0, sys.argv[1])
import main_watch
sender = sys.argv[4] == '1'
keys, validate = main_watch.role(sender)
existing = {}
try:
    if os.path.exists(sys.argv[2]):
        with open(sys.argv[2], encoding='utf-8') as handle:
            existing = main_watch.parse_config(handle.read(), keys)
    for item in sys.argv[5:]:
        key, _, value = item.partition('=')
        if any(ch in value for ch in '\r\n'):
            raise main_watch.ConfigError(f'{key} 不能包含换行')
        existing[key] = value.strip()
    # 开启心跳且没有令牌时自动生成，部署结束时打印给主服务器使用。
    if not sender and existing.get('HEARTBEAT_LISTEN') and not existing.get('HEARTBEAT_TOKEN'):
        existing['HEARTBEAT_TOKEN'] = secrets.token_urlsafe(32)
    validate(existing)
except main_watch.ConfigError as error:
    sys.exit(f'[main-watch] 配置无效，未做任何改动：{error}')
lines = ['# 由 install-main-watch.sh 维护；手工修改后执行 sudo ' + ('main-watch-sender' if sender else 'main-watch') + ' check 校验']
lines += [f'{key}={existing[key]}' for key in keys if key in existing]
with open(sys.argv[3], 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(lines) + '\n')
PY
else
  cp -p -- "$config" "$scratch/config"
fi
"$python_bin" -I "$program" "${role_args[@]}" --config "$scratch/config" --check >/dev/null || die '配置无效，未做任何改动。'
# 副服务器开启心跳时取出：监听地址、本机可连地址与端口、令牌。
heartbeat=()
if ((!sender)); then
  read -r -a heartbeat < <("$python_bin" -I -B - "$(dirname -- "$program")" "$scratch/config" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import main_watch
with open(sys.argv[2], encoding='utf-8') as handle:
    config = main_watch.validate(main_watch.parse_config(handle.read()))
if config['heartbeat']:
    print(config['listen'], *main_watch.local_address(config['listen']), config['token'])
PY
  ) || true
fi

hardening='UMask=0077
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
LockPersonality=true'
documentation="https://github.com/$repository/blob/main/docs/main-watch.md"
if ((sender)); then
  cat > "$scratch/service" <<UNIT
[Unit]
Description=Push main server heartbeat to main-watch
Documentation=$documentation
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$service
Group=$service
WorkingDirectory=/
ExecStart=$python_bin -I $root/main_watch.py --sender --config $config
TimeoutStartSec=2min
$hardening
UNIT
  cat > "$scratch/timer" <<'UNIT'
[Unit]
Description=Push main-watch heartbeat every 30 seconds

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
  cat > "$scratch/command" <<CMD
#!/bin/sh
# main-watch-sender 管理命令，由 install-main-watch.sh 生成。
case "\$1" in
  check|probe) exec $python_bin -I $root/main_watch.py --sender --config $config --"\$1" ;;
  send) exec $python_bin -I $root/main_watch.py --sender --config $config ;;
  status) systemctl list-timers main-watch-sender.timer --no-pager; exec systemctl status main-watch-sender.service --no-pager ;;
  logs) exec journalctl -u main-watch-sender.service -n "\${2:-50}" --no-pager ;;
  *) echo "用法: sudo main-watch-sender check|probe|send|status|logs [行数]" >&2; exit 2 ;;
esac
CMD
  desired=("$program" "$scratch/service" "$scratch/timer" "$scratch/command" "$scratch/config")
else
  cat > "$scratch/service" <<UNIT
[Unit]
Description=Main server watch with Feishu alerts
Documentation=$documentation
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
$hardening
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
  cat > "$scratch/receiver" <<UNIT
[Unit]
Description=Receive main server heartbeats for main-watch
Documentation=$documentation
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$service
Group=$service
StateDirectory=$service
WorkingDirectory=/var/lib/$service
ExecStart=$python_bin -I $root/main_watch.py --config $config --serve
Restart=always
RestartSec=5
$hardening

[Install]
WantedBy=multi-user.target
UNIT
  cat > "$scratch/command" <<CMD
#!/bin/sh
# main-watch 管理命令，由 install-main-watch.sh 生成。
case "\$1" in
  check|probe|test) exec $python_bin -I $root/main_watch.py --config $config --"\$1" ;;
  status) systemctl list-timers main-watch.timer --no-pager; exec systemctl status main-watch.service main-watch-heartbeat.service --no-pager ;;
  logs) exec journalctl -u main-watch.service -u main-watch-heartbeat.service -n "\${2:-50}" --no-pager ;;
  *) echo "用法: sudo main-watch check|probe|test|status|logs [行数]" >&2; exit 2 ;;
esac
CMD
  desired=("$program" "$scratch/service" "$scratch/timer" "$scratch/receiver" "$scratch/command" "$scratch/config")
fi

changed=()
for index in "${!targets[@]}"; do
  cmp -s -- "${desired[$index]}" "${targets[$index]}" || changed+=("$index")
done
id "$service" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /var/lib/$service --shell /usr/sbin/nologin "$service"
[[ $(id -u "$service") != 0 ]] || die '服务账号不能是 root。'
# 跳过标准与部署成功标准一致：文件与权限不变、定时器在运行、最近一轮在 systemd 下成功，
# 心跳接收服务的运行状态与配置一致。
healthy=0
if [[ -f $config && $(stat -c '%U:%G %a' "$config") == "root:$service 640" && $(stat -c '%U:%G %a' "$etc") == "root:$service 750" ]] &&
    systemctl is-enabled --quiet "${units[1]}" && systemctl is-active --quiet "${units[1]}" &&
    [[ $(systemctl show --property=Result --value "${units[0]}") == success ]]; then healthy=1; fi
for name in "${units[@]}"; do
  [[ $(systemctl show --property=NeedDaemonReload --value "$name") == no ]] || healthy=0
done
if ((!sender)); then
  if ((${#heartbeat[@]})); then
    systemctl is-enabled --quiet main-watch-heartbeat.service && systemctl is-active --quiet main-watch-heartbeat.service || healthy=0
  elif systemctl is-active --quiet main-watch-heartbeat.service; then healthy=0; fi
fi
if ((${#changed[@]} == 0 && healthy)); then
  say "版本 $revision_label：程序、配置与服务均未变化，跳过部署。"
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
  group=root mode=644
  if ((index == config_index)); then group=$service mode=640; elif ((index == command_index)); then mode=755; fi
  install -m "$mode" -o root -g "$group" "${desired[$index]}" "${targets[$index]}.next"
  mv -f -- "${targets[$index]}.next" "${targets[$index]}"
done
systemctl daemon-reload
config_changed=0
for index in "${changed[@]}"; do if ((index == config_index)); then config_changed=1; fi; done

if ((sender)); then
  # 按 systemd 的真实启动路径推送首个心跳，确认地址、端口放通与令牌。
  say '向副服务器推送首个心跳，确认地址、端口与令牌。'
  systemctl reset-failed main-watch-sender.service >/dev/null 2>&1 || true
  systemctl start main-watch-sender.service || {
    journalctl -u main-watch-sender.service -n 20 --no-pager >&2 || true
    die '心跳推送失败：请确认副服务器已开启心跳接收、安全组放通本机到副服务器的端口，且两端令牌一致。'
  }
  systemctl enable main-watch-sender.timer >/dev/null 2>&1
  systemctl restart main-watch-sender.timer
  systemctl is-active --quiet main-watch-sender.timer || die '心跳定时器未能启动。'
  switched=0
  say "已部署版本 $revision_label，每 30 秒推送一次心跳。本机工作台就绪检查："
  "$python_bin" -I "$root/main_watch.py" --sender --config "$config" --probe || say '注意：本机工作台当前未就绪，副服务器会据此告警“自检未就绪”。'
  say '管理命令：sudo main-watch-sender status | logs | probe | send'
  exit 0
fi

if ((send_test || config_changed)); then
  say '发送飞书测试消息，确认告警通道可用。'
  runuser -u "$service" -- "$python_bin" -I "$root/main_watch.py" --config "$config" --test || die '飞书测试消息发送失败，请检查 Webhook 与签名密钥。'
fi
receiver_up() {
  # 只认本服务的应答（GET 返回 404 且 Server 为 main-watch），端口被其他程序占用不算启动成功。
  "$python_bin" -I - "$1" "$2" <<'PY'
import sys, urllib.error, urllib.request
host = f'[{sys.argv[1]}]' if ':' in sys.argv[1] else sys.argv[1]
try:
    urllib.request.build_opener(urllib.request.ProxyHandler({})).open(f'http://{host}:{sys.argv[2]}/heartbeat', timeout=2)
except urllib.error.HTTPError as error:
    sys.exit(0 if error.code == 404 and (error.headers.get('Server') or '').startswith('main-watch') else 1)
except Exception:
    pass
sys.exit(1)
PY
}
if ((${#heartbeat[@]})); then
  systemctl enable main-watch-heartbeat.service >/dev/null 2>&1
  systemctl restart main-watch-heartbeat.service
  up=0
  for _ in {1..40}; do if receiver_up "${heartbeat[1]}" "${heartbeat[2]}"; then up=1; break; fi; sleep 0.25; done
  ((up)) || { journalctl -u main-watch-heartbeat.service -n 20 --no-pager >&2 || true; die "心跳接收服务未能监听 ${heartbeat[0]}，端口可能已被占用。"; }
else
  systemctl disable --now main-watch-heartbeat.service >/dev/null 2>&1 || true
fi
# 按 systemd 的真实启动路径跑一轮，确认服务账号能读配置、写状态。
systemctl reset-failed main-watch.service >/dev/null 2>&1 || true
systemctl start main-watch.service || { journalctl -u main-watch.service -n 20 --no-pager >&2 || true; die '首轮巡检在 systemd 下运行失败。'; }
systemctl enable main-watch.timer >/dev/null 2>&1
systemctl restart main-watch.timer
systemctl is-active --quiet main-watch.timer || die '定时器未能启动。'
switched=0
say "已部署版本 $revision_label，每分钟巡检一次。当前探测结果："
"$python_bin" -I "$root/main_watch.py" --config "$config" --probe || say '注意：有目标当前不可达。若主服务器实际正常，请检查地址、端口放通、工作台监听地址或心跳推送。'
if ((${#heartbeat[@]} && config_changed)); then
  host=${heartbeat[0]%:*}
  case $host in 0.0.0.0|'[::]') host='<副服务器公网IP>' ;; esac
  say "心跳接收监听 ${heartbeat[0]}。请在安全组放通主服务器到本机 TCP ${heartbeat[2]}，然后在主服务器执行："
  printf '  curl -fsSL https://raw.githubusercontent.com/%s/main/deploy/install-main-watch.sh | sudo bash -s -- --sender --send-to http://%s:%s/heartbeat --heartbeat-token %s\n' \
    "$repository" "$host" "${heartbeat[2]}" "${heartbeat[3]}"
fi
say '管理命令：sudo main-watch status | logs | probe | test'
