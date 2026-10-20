# 系统更新进度

在工作台打开“系统更新”，检查正式版本、确认本次更新后，可以查看当前任务和安装阶段。关闭页面不会取消服务器上的更新，重新打开后会读取同一任务的最新状态。

## 阶段与百分比

默认采用源码安装，依次按实际需要准备源码、依赖、构建、校验、切换服务和完成安装。缓存命中时会跳过不需要的步骤；阶段顺序也会随安装内容调整。

只有能测量的阶段显示“本阶段 N%”。发布包下载可同时显示速度与预计下载剩余时间；源码获取在接收 Git 对象时显示“对象接收 N%”，按对象数量计算，下载字节总量未知；构建和安装收尾等没有可靠总量的步骤显示“进行中”。这些数值不代表整次更新的剩余时间。

进度详情缺失、格式异常或超过五分钟没有新样本时，页面继续显示任务状态。这不代表任务失败，也不会自动取消更新。是否成功以完成安装、健康检查和更新服务收尾后的任务结果为准。

## 断线与失败

服务切换期间可能短暂断线。页面会自动重连，并通过状态读取确认结果。版本已对齐但上次任务失败时，仍显示未完成；重新检查更新后，只有服务端确认存在可恢复任务才显示恢复入口。

首次从旧版本升级时，原有前端和更新进程仍按旧状态通道工作；升级完成后，后续任务才具备新的阶段详情。没有进度字段的旧更新服务仍然兼容。

## 命令行更新

也可重新执行仓库的一键更新命令，保留已有配置和数据：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/deploy/install-all.sh | sudo bash
```

安装器锁定所选正式版本，复用有效的依赖、构建及验证缓存，按变化更新。命令行运行通过终端日志查看过程，不会将详情写入另一个网页更新任务。

## 回归入口

- `deploy/test-updater.py`、`deploy/test-progress.py`：当前任务隔离、异常进度不影响控制状态与旧服务兼容。
- `tests/updates-http.test.mjs`、`tests/update-stream.test.mjs`：进度经过真实认证接口及既有 SSE 通道。
- `tests/update-progress.browser.mjs`：在端口 4188 的生产预览上使用 `playwright-cli run-code --filename tests/update-progress.browser.mjs`，检查阶段显示、断线恢复、任务切换和退出清理。
- Linux CI：`deploy/test-release-progress.py`、`deploy/test-incremental.sh`、`deploy/test-update-systemd.sh` 验证权限、增量升级和服务隔离；Windows 结果不代替这些检查。
