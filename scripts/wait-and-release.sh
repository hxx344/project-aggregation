#!/bin/bash
set -e

start_time=$(date +%s)
commit_sha="$1"

if [ -z "$commit_sha" ]; then
  echo "用法: $0 <full-commit-sha>"
  exit 1
fi

echo "开始监控 commit $commit_sha 的 CI 和发布流程"

# 1. 等待 CI 完成
echo ""
echo "=== 阶段 1: 监控 CI ==="
while true; do
  elapsed=$(($(date +%s) - start_time))

  # 获取 CI run
  ci_runs=$(gh run list --commit "$commit_sha" --workflow=ci.yml --json status,conclusion,databaseId --limit 1)

  if [ "$(echo "$ci_runs" | jq length)" -eq 0 ]; then
    echo "[$(date +%H:%M:%S)] 等待 CI 启动... (${elapsed}s)"
    sleep 10
    continue
  fi

  ci_status=$(echo "$ci_runs" | jq -r '.[0].status')
  ci_conclusion=$(echo "$ci_runs" | jq -r '.[0].conclusion')
  ci_run_id=$(echo "$ci_runs" | jq -r '.[0].databaseId')

  echo "[$(date +%H:%M:%S)] CI run $ci_run_id: status=$ci_status, conclusion=$ci_conclusion (${elapsed}s)"

  # 主动检查：超过 3 分钟警告
  if [ $elapsed -gt 180 ] && [ "$ci_status" = "in_progress" ]; then
    echo "⚠️  警告：CI 已运行超过 3 分钟，可能存在配置问题"
  fi

  if [ "$ci_status" = "completed" ]; then
    if [ "$ci_conclusion" != "success" ]; then
      echo "❌ CI 失败: $ci_conclusion"
      gh run view "$ci_run_id" --log-failed
      exit 1
    fi
    echo "✅ CI 成功通过！耗时 ${elapsed}s"
    break
  fi

  sleep 15
done

# 2. 等待 prerelease 创建完成
echo ""
echo "=== 阶段 2: 等待 prerelease 创建 ==="
tag="deploy-$commit_sha"
max_wait=300  # 最多等待 5 分钟
wait_start=$(date +%s)

while true; do
  wait_elapsed=$(($(date +%s) - wait_start))

  if [ $wait_elapsed -gt $max_wait ]; then
    echo "❌ 超时：等待 prerelease 创建超过 ${max_wait}s"
    exit 1
  fi

  # 检查 release 是否存在
  if gh api "repos/hxx344/project-aggregation/releases/tags/$tag" >/dev/null 2>&1; then
    release_info=$(gh api "repos/hxx344/project-aggregation/releases/tags/$tag" --jq '{prerelease, draft, assets: [.assets[] | .name]}')
    echo "[$(date +%H:%M:%S)] Release 状态: $release_info"

    is_prerelease=$(echo "$release_info" | jq -r '.prerelease')
    is_draft=$(echo "$release_info" | jq -r '.draft')
    asset_count=$(echo "$release_info" | jq '.assets | length')

    if [ "$is_prerelease" = "true" ] && [ "$is_draft" = "false" ] && [ "$asset_count" -gt 0 ]; then
      echo "✅ Prerelease 已创建完成！(等待 ${wait_elapsed}s)"
      break
    fi

    echo "[$(date +%H:%M:%S)] Prerelease 尚未完成 (prerelease=$is_prerelease, draft=$is_draft, assets=$asset_count)，继续等待..."
  else
    echo "[$(date +%H:%M:%S)] Release 尚未创建，继续等待... (${wait_elapsed}s)"
  fi

  sleep 5
done

# 3. 触发发布
echo ""
echo "=== 阶段 3: 触发稳定版发布 ==="
echo "触发发布: $commit_sha"
gh workflow run promote-release.yml -f commit="$commit_sha"
sleep 5

# 4. 监控发布
echo ""
echo "=== 阶段 4: 监控发布 ==="
release_run=$(gh run list --workflow=promote-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
echo "监控发布 run: $release_run"

while true; do
  release_status=$(gh run view "$release_run" --json status,conclusion --jq '{status, conclusion}')
  status=$(echo "$release_status" | jq -r '.status')
  conclusion=$(echo "$release_status" | jq -r '.conclusion')

  echo "[$(date +%H:%M:%S)] Release run $release_run: status=$status, conclusion=$conclusion"

  if [ "$status" = "completed" ]; then
    if [ "$conclusion" = "success" ]; then
      echo "✅✅ 发布成功！"
      echo ""
      echo "最新稳定版本: $tag"
      echo "用户现在可以在前端点击'应用更新'完成升级"
      exit 0
    else
      echo "❌ 发布失败: $conclusion"
      gh run view "$release_run" --log-failed
      exit 1
    fi
  fi

  sleep 15
done
