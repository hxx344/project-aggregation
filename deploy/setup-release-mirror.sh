#!/usr/bin/env bash
# Cache immutable releases locally behind an existing TLS proxy.
set -Eeuo pipefail
umask 022
die() { printf '[mirror] %s\n' "$*" >&2; exit 1; }
LISTEN=${RELEASE_MIRROR_LISTEN:-127.0.0.1:8090}
CACHE_DIR=${RELEASE_CACHE_DIR:-/var/cache/github-releases}
RESOLVERS=${RELEASE_MIRROR_RESOLVERS:-}
while (($#)); do
  case "$1" in
    --listen|--cache-dir|--resolver)
      (($# >= 2)) || die "$1 缺少参数"
      case "$1" in --listen) LISTEN=$2;; --cache-dir) CACHE_DIR=$2;; --resolver) RESOLVERS=$2;; esac
      shift 2;;
    --help) printf '用法: setup-release-mirror.sh [--listen IP:PORT] [--cache-dir /absolute/path] [--resolver "IP[:PORT] ..."]\n默认监听 127.0.0.1:8090，DNS 使用系统 resolv.conf；公网使用已有 HTTPS 反向代理。\n'; exit 0;;
    *) die "未知参数: $1";;
  esac
done
[[ $EUID == 0 ]] || die '请以 root 运行'
command -v python3 >/dev/null || die '需要 python3'
GLOBAL_CONF=/etc/nginx/conf.d/github-releases-cache.conf
SITE_CONF=/etc/nginx/sites-available/release-mirror
ENABLED_CONF=/etc/nginx/sites-enabled/release-mirror
python3 -I - "$LISTEN" "$CACHE_DIR" "$GLOBAL_CONF" "$SITE_CONF" "$ENABLED_CONF" <<'MIRROR_PATHS_PY'
import hashlib, ipaddress, os, re, sys
from pathlib import Path
try:
    listen, cache, global_conf, site, enabled = sys.argv[1:]
    match = re.fullmatch(r'(\[[0-9a-fA-F:]+\]|[0-9.]+):([0-9]+)', listen)
    if not match or not 1 <= int(match[2]) <= 65535:
        raise ValueError('listen must be a literal IP:PORT')
    ipaddress.ip_address(match[1].strip('[]'))
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', cache) or any(x in ('', '.', '..') for x in cache[1:].split('/')):
        raise ValueError('invalid cache directory')
    if cache in ('/var', '/var/cache', '/etc', '/usr', '/opt', '/run', '/root', '/tmp', '/home') or len(Path(cache).parts) < 3:
        raise ValueError('cache directory is too broad')
    for value in (cache, global_conf, site, enabled, '/run/project-aggregation-release-mirror/setup.lock'):
        path = Path(value)
        for item in reversed((path, *path.parents)):
            if item.is_symlink():
                if item == Path(enabled) and os.readlink(item) == site:
                    continue
                raise ValueError('symlink path: ' + str(item))
            if not item.exists(): continue
            info = item.stat()
            if os.name != 'nt' and item != Path(cache) and (info.st_uid != 0 or info.st_mode & 0o022):
                raise ValueError('untrusted ownership/mode: ' + str(item))
            if item == path and path != Path(cache) and item.is_dir():
                raise ValueError('expected file: ' + str(item))
        if value == cache and path.exists() and not path.is_dir():
            raise ValueError('cache is not a directory')
    for filename, legacy_hash in ((global_conf, '16e0ca6e6cb507cb1827a9f1d48d7bed899ebb5b03e8a71e738e3f7e8a152c6d'),
                                   (site, '64096cd38cba4e25645d50d6fb45fee15017d9bf969b97d135859e6cbb5f02b9')):
        path = Path(filename)
        if path.exists():
            content = path.read_text(encoding='utf-8')
            normalized = re.sub(r'(?m)^    server_name [A-Za-z0-9.-]+;$', '    server_name DOMAIN_PLACEHOLDER;', content) if filename == site else content
            if not content.startswith('# Managed by project-aggregation release mirror v2\n') and hashlib.sha256(normalized.encode()).hexdigest() != legacy_hash:
                raise ValueError('refusing to overwrite user nginx configuration: ' + filename)
    if Path(enabled).exists() and not Path(enabled).is_symlink():
        raise ValueError('refusing to replace existing enabled configuration')
except (ValueError, OSError) as error:
    sys.exit('[mirror] ' + str(error))
MIRROR_PATHS_PY
RESOLVERS=$(python3 -I - "$RESOLVERS" <<'MIRROR_DNS_PY'
import ipaddress, re, sys
from pathlib import Path
try:
    values = sys.argv[1].split()
    if not values:
        values = [line.split()[1] for line in Path('/etc/resolv.conf').read_text().splitlines()
                  if re.match(r'^\s*nameserver\s+\S+', line)]
    result = []
    for value in values:
        try:
            address, port = ipaddress.ip_address(value), None
        except ValueError:
            match = re.fullmatch(r'(\[[a-fA-F0-9:]+\]|[0-9.]+):([0-9]+)', value)
            if not match or not 1 <= int(match[2]) <= 65535: raise ValueError('invalid resolver: ' + value)
            address, port = ipaddress.ip_address(match[1].strip('[]')), match[2]
        item = '[' + str(address) + ']' if address.version == 6 else str(address)
        if port: item += ':' + port
        if item not in result: result.append(item)
    if not result: raise ValueError('no DNS resolver found; use --resolver IP')
    print(' '.join(result))
except (OSError, ValueError) as error:
    sys.exit('[mirror] ' + str(error))
MIRROR_DNS_PY
)
if ! command -v nginx >/dev/null; then
  command -v apt-get >/dev/null || die '未安装 nginx，且系统没有 apt-get'
  apt-get update
  apt-get install -y nginx
fi
[[ -f /etc/ssl/certs/ca-certificates.crt ]] || die '缺少系统 CA 证书'
mkdir -p -m 0700 -- /run/project-aggregation-release-mirror
exec 9>/run/project-aggregation-release-mirror/setup.lock
flock 9
WORK=$(mktemp -d /run/project-aggregation-release-mirror/setup.XXXXXXXX)
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p -- "$(dirname "$GLOBAL_CONF")" "$(dirname "$SITE_CONF")" "$(dirname "$ENABLED_CONF")" "$CACHE_DIR"
chown www-data:www-data -- "$CACHE_DIR"
chmod 0750 -- "$CACHE_DIR"
cat > "$WORK/global" <<'NGINX_GLOBAL'
# Managed by project-aggregation release mirror v2
proxy_cache_path CACHE_DIRECTORY levels=1:2 keys_zone=project_release_mirror:10m
                 max_size=50g inactive=90d use_temp_path=off;
map $upstream_http_location $project_release_asset_url {
    default "";
    "~^https://release-assets[.]githubusercontent[.]com/[A-Za-z0-9/_?=&%+.,:;@~-]+$" $upstream_http_location;
}
map $upstream_status $project_release_skip_cache {
    default 1;
    ~200$ 0;
}
NGINX_GLOBAL
cat > "$WORK/site" <<'NGINX_SITE'
# Managed by project-aggregation release mirror v2
server {
    listen MIRROR_LISTEN;
    server_name _;
    recursive_error_pages on;
    resolver MIRROR_RESOLVERS valid=300s;
    resolver_timeout 10s;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_verify_depth 3;
    proxy_ssl_server_name on;
    proxy_cache project_release_mirror;
    proxy_cache_key "release-mirror-v2:$request_uri";
    proxy_cache_valid 200 90d;
    proxy_no_cache $project_release_skip_cache;
    proxy_cache_lock on;
    proxy_cache_lock_timeout 300s;
    proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
    proxy_ignore_headers Expires Cache-Control Set-Cookie;
    proxy_hide_header Set-Cookie;
    proxy_hide_header Location;
    set $mirror_upstream_host github.com;
    proxy_set_header Host $mirror_upstream_host;
    proxy_ssl_name $mirror_upstream_host;
    proxy_set_header Cookie "";
    proxy_set_header Authorization "";
    proxy_set_header Range "";
    proxy_set_header If-Range "";
    proxy_set_header Accept-Encoding "";
    proxy_force_ranges on;
    proxy_connect_timeout 15s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    add_header X-Cache-Status $upstream_cache_status always;
    location = /health {
        access_log off;
        default_type text/plain;
        return 200 "OK\n";
    }
    location ~ "^/hxx344/project-aggregation/releases/download/deploy-[a-f0-9]{40}/[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$" {
        if ($args != "") { return 400; }
        limit_except GET HEAD { deny all; }
        # Only the final-body writer takes the lock; the redirect stage must not
        # wait on its own lock when re-entering the same original-URL cache key.
        proxy_cache_lock off;
        proxy_intercept_errors on;
        error_page 301 302 303 307 308 = @release_asset;
        proxy_pass https://github.com;
    }
    location @release_asset {
        set $release_asset_url $project_release_asset_url;
        if ($release_asset_url = "") { return 502; }
        set $mirror_upstream_host release-assets.githubusercontent.com;
        proxy_pass $release_asset_url;
        proxy_intercept_errors on;
        error_page 301 302 303 307 308 =502 /invalid-asset-redirect;
    }
    location = /invalid-asset-redirect { internal; return 502; }
    location / { return 404; }
}
NGINX_SITE
sed -i "s|CACHE_DIRECTORY|$CACHE_DIR|g" "$WORK/global"
sed -i "s|MIRROR_LISTEN|$LISTEN|g" "$WORK/site"
sed -i "s|MIRROR_RESOLVERS|$RESOLVERS|g" "$WORK/site"
if cmp -s "$WORK/global" "$GLOBAL_CONF" && cmp -s "$WORK/site" "$SITE_CONF" &&
   [[ -L $ENABLED_CONF && $(readlink "$ENABLED_CONF") == "$SITE_CONF" ]]; then
  if systemctl is-active --quiet nginx; then
    printf '[mirror] 配置无变化，复用已验证配置；跳过安装、nginx -t 和 reload。\n'
  else
    nginx -t
    systemctl start nginx
    printf '[mirror] 配置无变化，已启动 nginx。\n'
  fi
  exit 0
fi
had_global=0; had_site=0; had_link=0; changed=0
if [[ -f $GLOBAL_CONF ]]; then cp -p -- "$GLOBAL_CONF" "$WORK/old-global"; had_global=1; fi
if [[ -f $SITE_CONF ]]; then cp -p -- "$SITE_CONF" "$WORK/old-site"; had_site=1; fi
[[ ! -L $ENABLED_CONF ]] || had_link=1
atomic_install() {
  local source=$1 target=$2 staged
  staged=$(mktemp "${target}.XXXXXXXX")
  if ! install -m 0644 -- "$source" "$staged" || ! mv -fT -- "$staged" "$target"; then
    rm -f -- "$staged"
    return 1
  fi
}
rollback() {
  local result=$?
  trap - ERR INT TERM
  if ((changed)); then
    if ((had_global)); then atomic_install "$WORK/old-global" "$GLOBAL_CONF"; else rm -f -- "$GLOBAL_CONF"; fi
    if ((had_site)); then atomic_install "$WORK/old-site" "$SITE_CONF"; else rm -f -- "$SITE_CONF"; fi
    if ((!had_link)); then rm -f -- "$ENABLED_CONF"; fi
    printf '[mirror] nginx 配置验证或启动失败，已恢复原配置；工作台服务未改动。\n' >&2
  fi
  exit "${result:-1}"
}
trap rollback ERR
trap 'false' INT TERM
changed=1
atomic_install "$WORK/global" "$GLOBAL_CONF"
atomic_install "$WORK/site" "$SITE_CONF"
if ((!had_link)); then ln -s -- "$SITE_CONF" "$ENABLED_CONF"; fi
nginx -t
if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl start nginx; fi
changed=0
trap - ERR INT TERM
printf '[mirror] 已更新并验证缓存配置，监听 %s；HTTPS 请使用已有 TLS 反向代理。\n' "$LISTEN"
