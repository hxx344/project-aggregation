# 发布包镜像与下载验证

工作台默认采用 `source` 部署：从正式版本锁定的 Git 提交获取源码，再按变化增量构建。这里的镜像只用于 **`PROJECT_DEPLOY_MODE=ci` 的预构建包下载**。测速结果不代表 Git fetch 的速度，配置镜像也不会改变网页更新的源码模式。

官方发布清单与安装脚本仍从 GitHub HTTPS 获取。镜像只提供固定 `deploy-<完整提交号>` 下的压缩包，下载器使用官方清单中的 SHA-256 验证正文后才允许解包。镜像失败时按配置回源，取消操作、本地权限或磁盘错误直接返回失败。

## 先测速

在仓库中执行：

```bash
bash deploy/test-mirror-performance.sh
```

也可以从已发布的官方入口执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/one-click-optimize.sh | bash
```

默认只测试，不安装服务或写入配置。入口优先使用可信路径中的本地工具；独立运行时，从官方正式清单锁定的提交获取辅助脚本。显式部署时另外核对本地部署脚本是否与该正式提交一致；不会从镜像获取可执行代码。

测试取得官方清单后，按同一个提交、架构、文件和摘要比较 GitHub 与已配置镜像。成功必须下载完整正文并通过 SHA-256；失败、未配置、缓存命中分别显示。GitHub 基线失败时不计算提速倍数，超时的部分文件不算成功样本。重复测试可设置 `TEST_ITERATIONS`，单次超时可设置 `DOWNLOAD_TIMEOUT`。

```bash
TEST_ITERATIONS=3 DOWNLOAD_TIMEOUT=120 bash deploy/test-mirror-performance.sh
```

根目录 `test-download-speed.sh` 保留为 GitHub 下载检查的兼容入口。源码获取中断应查看安装器的 Git 重试日志，不能用这份预构建包测速报告判断是否恢复。

## 本机缓存的一键部署

需要缓存同一发布包的重复下载时，可明确选择部署：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/one-click-optimize.sh | sudo bash -s -- --deploy-local
```

默认监听 `http://127.0.0.1:8090`。只有缺少 Nginx 时才安装；配置无变化时跳过重载。配置发生变化后先检查 Nginx，再应用；失败返回非零状态并恢复旧配置。该流程不重启工作台，也不改变部署模式。

同机缓存的首次下载仍需访问 GitHub；新版本的包也需要首次回源。只有相同版本的已缓存正文可以复用，不保证固定速度或提速倍数。部署验收必须实际下载并验证摘要，`/health` 返回成功不能代替文件验收。

## 配置已有 HTTPS 镜像

```bash
sudo bash deploy/configure-release-mirror.sh \
  --url https://releases.example.com \
  --kind github \
  --priority fallback \
  --timeout 60
```

配置使用完整 URL。远端必须提供可验证证书的 HTTPS；HTTP 仅接受显式字面地址 `127.0.0.1` 或 `::1`。Nginx 部署脚本默认只开放本机端口，不自动安装证书工具。远端服务可由已有 HTTPS 入口转发到该端口。

配置工具先验证真实发布包，再原子写入 `/etc/project-aggregation/release-mirror.conf`。验证失败保留旧配置；相同且已经验证的配置直接复用，追加 `--verify` 可以重新验收。配置是数据文件，不作为 Shell 脚本执行，也不注入应用服务环境。

```text
# release-mirror-config-v1
RELEASE_MIRROR_URL=https://releases.example.com
RELEASE_MIRROR_KIND=github
RELEASE_MIRROR_PRIORITY=fallback
RELEASE_MIRROR_TIMEOUT=60
```

| 字段 | 含义 |
| --- | --- |
| `RELEASE_MIRROR_URL` | 镜像源地址，包含协议与可选端口，不含路径、查询参数或凭据 |
| `RELEASE_MIRROR_KIND` | `github` 使用固定发布路径；`oss` 使用下面的对象路径 |
| `RELEASE_MIRROR_PRIORITY` | `fallback` 先镜像，失败回 GitHub；`always` 镜像失败即停止；`disabled` 禁用 |
| `RELEASE_MIRROR_TIMEOUT` | 镜像下载时限，整数 1–300 秒 |

下载器直接读取可信配置，不需要重启工作台。旧版只有 `RELEASE_MIRROR_DOMAIN` 的无效配置不会被当成已启用镜像；重新运行配置工具即可迁移。

禁用镜像：

```bash
sudo bash deploy/configure-release-mirror.sh --priority disabled
```

## OSS 同步

同步器使用已有 `ossutil`。配置 `ALIYUN_OSS_BUCKET`、`ALIYUN_OSS_ENDPOINT`、`ALIYUN_ACCESS_KEY_ID` 和 `ALIYUN_ACCESS_KEY_SECRET` 后执行：

```bash
python3 deploy/sync-release-to-oss.py
```

上传前按官方清单核对文件摘要，缓存按版本隔离，不能复用另一版本的同名包。缺少配置或校验失败返回失败；已核实相同的对象可以跳过上传。

对象路径统一为：

```text
releases/hxx344/project-aggregation/deploy-<40位提交号>/<发布包文件名>
```

工作台使用同一配置入口，指定 `--kind oss`；不要手工修改更新器代码或简单替换 GitHub 域名：

```bash
sudo bash deploy/configure-release-mirror.sh \
  --url https://cdn.example.com --kind oss --priority fallback
```

## 验证范围

- `deploy/test-mirror-tools.py`：下载状态、重定向、摘要、报告和入口行为。
- `deploy/test-release-mirror.py`：生产下载器镜像选择、回源、可信配置、缓存和取消边界。
- `deploy/test-mirror-setup.py`：配置校验、幂等、失败恢复和非交互调用。
- `deploy/test-mirror-nginx.py`：Linux CI 中的真实 Nginx、HTTPS 上游跳转、正文缓存及 Range 响应。

测试使用本地夹具；服务器到 GitHub 或实际 CDN 的网络质量，需在目标服务器执行测速后判断。
