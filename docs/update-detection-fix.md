# 更新检测延迟问题修复方案

## 问题总结

推送新正式版本后，工作台更新面板长时间无法检测到更新，主要有三个根本原因：

### 1. GitHub API 限流导致长时间阻塞（最严重）

**现象**：
- 匿名 API 限额 60次/小时耗尽后，返回 HTTP 403 + `X-RateLimit-Remaining=0`
- 更新器将 `nextCheckNotBefore` 设为 1 小时后
- **所有检查请求（包括用户手动点击）都被 `_check_delay()` 静默拦截**
- 界面只显示"已是最新"，完全看不出被限流阻塞

**根因**：
```python
# releases.py:128-134
if headers.get('X-RateLimit-Remaining') == '0':
    reason = '匿名请求额度已用尽'
    raise ReleaseError(..., retry_at=deadline)  # deadline 可能是 3600 秒后

# updater.py:270-271
if self._check_delay(state, minimum_interval) > 0:
    return self.public(state)  # 静默返回，不显示真实原因
```

**影响范围**：L013 已记录，但当前修复不完整。

---

### 2. 限流恢复后仍需等待退避延迟

**现象**：
- 即使 GitHub API 限流已恢复（1 小时后），仍需等待指数退避延迟
- 失败 4 次后，每次重试间隔 30 分钟

**根因**：
```python
# updater.py:206-212
delay = min(30*60, 5*60 * 2 ** min(count - 1, 3))  # 最长 30 分钟
state.update(nextCheckNotBefore=max(now + delay, retry_at))
# 同时受两个延迟约束：退避延迟 AND 限流恢复时间
```

---

### 3. 用户无法区分"已是最新"与"检查被阻塞"

**现象**：
- `_check_delay() > 0` 时，`check()` 直接返回当前状态
- 界面把 `checking=False` + `checkError=None` 统一显示为"已是最新"
- 用户看不到"正在等待限流恢复"的真实状态

---

## 修复方案

### 方案 A：最小化修复（推荐优先执行）

**目标**：让用户看到真实的阻塞原因，而不是误以为"已是最新"。

#### A1. 在 `updater.py` 中暴露阻塞状态

```python
# updater.py:196-203 修改 public() 方法
def public(self, state):
    result = {'enabled': True, **{key: state.get(key) for key in
            ('checking', 'checkedAt', 'checkError', 'planId', 'expiresAt', 'job')},
            'modules': [{key: item[key] for key in PUBLIC_MODULE if key in item} for item in state['modules']]}
    remaining = state.get('nextCheckNotBefore', 0) - self.clock()
    
    # 新增：明确区分限流阻塞与普通重试
    if remaining > 0:
        if result['checkError']:
            result['checkError'] += f'；已暂停重试，约 {math.ceil(remaining / 60)} 分钟后自动重试'
        else:
            # 关键修复：有阻塞但无错误信息时，说明是旧的限流状态
            result['blocked'] = True
            result['blockedUntil'] = iso(state.get('nextCheckNotBefore', 0))
            result['blockedMessage'] = f'正在等待 GitHub API 限流恢复，约 {math.ceil(remaining / 60)} 分钟后可重试'
    
    return result
```

#### A2. 在 `UpdateStatus.tsx` 中显示阻塞状态

```typescript
// src/UpdateStatus.tsx 修改显示逻辑
{data.blocked && (
  <div className="update-blocked">
    <svg>⏳</svg>
    <div>
      <div className="update-status-text">{data.blockedMessage}</div>
      <div className="update-time">预计 {data.blockedUntil} 后恢复</div>
    </div>
  </div>
)}

{!data.blocked && !data.checking && !data.checkError && !hasUpdates && (
  <div className="update-current">
    <svg>✓</svg>
    <div>已是最新正式版本</div>
  </div>
)}
```

**优点**：
- 代码改动最小
- 立即解决"用户看不到真实状态"的问题
- 不改变现有限流处理逻辑

---

### 方案 B：优化限流恢复策略（中期改进）

**目标**：限流恢复后立即重试，不再等待退避延迟。

#### B1. 区分限流与普通失败

```python
# updater.py:205-212 修改失败记录逻辑
def _record_check_failure(self, state, message, retry_at=0, is_rate_limit=False):
    count = state.get('failureCount', 0)
    count = count + 1 if type(count) is int and count >= 0 else 1
    
    if is_rate_limit:
        # 限流：只等待 retry_at，不叠加退避延迟
        delay = 0
        # 限流失败不累计到 failureCount
        count = state.get('failureCount', 0)
    else:
        # 普通失败：指数退避
        delay = min(CHECK_RETRY_MAX_INTERVAL, AUTO_CHECK_INTERVAL * 2 ** min(count - 1, 3))
    
    now = self.clock()
    state.update(checking=False, checkedAt=iso(now), checkError=message,
                 failureCount=count, nextCheckNotBefore=max(now + delay, retry_at),
                 rateLimited=is_rate_limit)  # 新增标记
```

#### B2. 在 `perform_check()` 中传递限流标记

```python
# updater.py:380-391 修改异常处理
except ReleaseError as error:
    # 检查是否是限流错误
    is_rate_limit = error.retry_at and '额度已用尽' in str(error)
    with self.lock():
        state = self.load()
        retry_at = max((item.pop('retryAt', 0) for item in state.get('modules', [])), 
                      default=error.retry_at if hasattr(error, 'retry_at') else 0)
        self._record_check_failure(state, str(error), retry_at, is_rate_limit=is_rate_limit)
        self.save(state)
```

**优点**：
- 限流恢复后立即检查，不再等待额外 5-30 分钟
- 保留普通失败的退避逻辑，防止服务器过载

---

### 方案 C：通过更新面板配置 GitHub Token

**目标**：使用个人 Token 的认证额度降低匿名 API 限流概率；普通账号通常为共享的 5000 次/小时，仍受 GitHub 限流规则约束。

#### C1. 在工作台配置

1. 在 GitHub 创建 fine-grained personal access token，公开仓库只读访问即可，不需要写权限。
2. 打开工作台“系统更新”，在“GitHub Token”区域粘贴 Token 并保存。已有配置可替换或移除，旧 Token 不回显。
3. 保存后，后续实际访问 GitHub API 时使用新 Token，并报告无效或过期等错误；缓存命中时可能不发起 API 请求。保存操作只确认配置已写入，不表示已通过 GitHub 验证。

旧更新服务不支持配置时，面板会提示通过原一键部署命令升级一次。检查或更新期间不能修改 Token。保存、更换、移除和服务重启都不会清除已有的限流等待。

#### C2. 配置与认证边界

Token 经工作台登录、同源与 CSRF 校验后，通过固定 Unix socket 写入 `/var/lib/project-aggregation-updater/credentials.json`。目录为 root/0700，文件为 root/0600，原子保存并随升级保留。控制服务与独立更新 worker 按请求读取，不需要设置 `GITHUB_TOKEN` 环境变量或重启服务。

公开状态仅包含是否配置。认证头仅发送给 `api.github.com`，跨域重定向会移除；Token 不进入安装脚本环境、更新计划、事件流或日志。此实现仍只支持现有公开仓库发布流程，不包含私有仓库下载支持。部署说明见 [deployment.md](deployment.md)。

---

## 推荐执行顺序

1. **立即执行方案 A**：让用户看到真实状态（1-2 小时开发）
2. **短期执行方案 B**：优化恢复速度（2-3 小时开发 + 测试）
3. **可选执行方案 C**：如果限流仍然频繁（需要 Token 管理流程）

---

## 测试验证

### 测试 A：阻塞状态显示

```bash
# 模拟限流阻塞
# 1. 手动设置 nextCheckNotBefore 为 1 小时后
# 2. 清空 checkError
# 3. 访问更新面板，应显示"正在等待 GitHub API 限流恢复"
```

### 测试 B：限流恢复后立即检查

```bash
# 1. 触发限流错误（连续调用 API 直到 403）
# 2. 等待 retry_at 时间
# 3. 手动触发检查，应立即执行（不等待退避延迟）
```

### 测试 C：Token 认证

通过更新面板保存、替换和移除 Token，确认状态不回显凭据、关闭面板清空输入。自动化测试模拟 GitHub 响应，检查认证头只发往 API、跨域重定向移除认证，以及无效 Token 的脱敏提示；Linux CI 检查权限和重复部署保留。使用真实 Token 时可按实际 API 响应头核实认证额度。

---

## 相关文件

- `server/update-service/updater.py` - 更新协调器
- `server/update-service/releases.py` - GitHub API 客户端
- `src/UpdateStatus.tsx` - 更新状态界面
- `LESSONS.md` - L013 限流重试经验

---

## 注意事项

1. **方案 A 不改变现有行为**，只是暴露隐藏的状态
2. **方案 B 需要仔细测试**退避逻辑，避免引入新的边界问题
3. **方案 C 的 Token 必须妥善保护**，不能提交到代码仓库
4. Token 的持久化与服务边界由 `deploy/test-updater.py` 覆盖，出站认证由 `deploy/test-release-cache.py` 覆盖，工作台接口和页面另有对应验收

---

## 问题定位命令

```bash
# 查看当前阻塞状态
cat /var/lib/project-aggregation-updater/state.json | jq '{checking, checkError, nextCheckNotBefore, checkedAt}'

# 查看最近的 API 错误
journalctl -u project-aggregation-updater.service --since "1 hour ago" | grep -i "rate\|403\|额度"

# 手动触发检查（会受阻塞限制）
curl -X POST http://localhost:3100/api/updates/check

# 清除阻塞状态（仅测试用）
# 警告：生产环境不要随意清除，可能导致继续触发限流
```
