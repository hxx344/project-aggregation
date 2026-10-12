# Asset 模块文件夹重命名指南

## 📋 背景说明

**问题**: 本地文件夹名称拼写错误  
**现状**: `/d/project_assest` (错误拼写)  
**目标**: `/d/project_asset` (正确拼写)  
**远程仓库**: `https://github.com/hxx344/asset-ledger.git` (名称正确，无需改动)

---

## ⚠️ 重要说明

- **Git 历史不受影响** - 只是本地文件夹名改变
- **远程仓库不需要动** - GitHub 上的仓库名本来就是正确的
- **只影响本地路径引用** - 需要更新配置文件中的硬编码路径

---

## 🔧 重命名步骤

### 步骤 1: 关闭占用进程

**需要关闭的程序：**
- [ ] VS Code / IDE（如果打开了 `/d/project_assest`）
- [ ] 终端窗口（如果 `cd` 到了该目录）
- [ ] 开发服务器（如果正在运行 `npm run dev`）
- [ ] 文件资源管理器（如果正在浏览该文件夹）
- [ ] Git GUI 工具

**检查方法：**
```bash
# 在 PowerShell 中运行
Get-Process | Where-Object {$_.Path -like "*project_assest*"}
```

### 步骤 2: 重命名文件夹

**在文件资源管理器中：**
1. 导航到 `D:\`
2. 找到 `project_assest` 文件夹
3. 右键 → 重命名
4. 改为 `project_asset`
5. 按 Enter 确认

**或者在 PowerShell 中：**
```powershell
Rename-Item -Path "D:\project_assest" -NewName "project_asset"
```

**或者在 Git Bash 中：**
```bash
mv /d/project_assest /d/project_asset
```

### 步骤 3: 验证 Git 状态

```bash
cd /d/project_asset
git status
git remote -v
```

**预期结果：**
- Git 工作正常
- 远程仓库地址不变
- 没有未跟踪的文件

---

## 📝 需要更新的文件

### 1. 工作台配置文件 (可能需要)

**文件位置**: `D:\project_aggregation\server\app.mjs`

**检查是否有硬编码路径：**
```bash
cd /d/project_aggregation
grep -r "project_assest" server/
```

**如果有，需要替换：**
```javascript
// 旧路径
const assetPath = '/d/project_assest';

// 新路径
const assetPath = '/d/project_asset';
```

### 2. 环境变量文件

**检查这些文件：**
- `D:\project_aggregation\.env`
- `D:\project_aggregation\.env.local`
- 任何包含 `project_assest` 的配置

**替换方法：**
```bash
# 搜索所有引用
grep -r "project_assest" /d/project_aggregation/
```

### 3. 文档文件

**需要更新的文档：**
- `MODULES_BEAUTIFICATION_SUMMARY.md`
- `MODULE_STYLING_GUIDE.md`
- `QUICK_REFERENCE.md`
- `frontend-beautification-complete.md` (在 memory/ 目录)

**查找命令：**
```bash
cd /d/project_aggregation
grep -l "project_assest" *.md memory/*.md
```

### 4. 快捷方式和脚本

**检查：**
- 桌面快捷方式
- 启动脚本
- 构建脚本
- IDE 项目配置

---

## ✅ 验证清单

完成后，检查这些功能是否正常：

- [ ] Asset 模块可以正常启动 (`npm run dev`)
- [ ] 工作台可以加载 Asset 模块（iframe 嵌入）
- [ ] Git 操作正常 (`git pull`, `git push`)
- [ ] 深色主题样式加载正常
- [ ] 所有文档路径引用正确

---

## 🔍 自动化脚本

**一键查找所有需要更新的地方：**

```bash
#!/bin/bash
# 文件名: find-assest-references.sh

echo "🔍 搜索所有 'project_assest' 引用..."
echo ""

echo "📁 工作台配置文件:"
grep -rn "project_assest" /d/project_aggregation/server/ 2>/dev/null || echo "  ✅ 无引用"
echo ""

echo "📁 环境变量文件:"
grep -rn "project_assest" /d/project_aggregation/.env* 2>/dev/null || echo "  ✅ 无引用"
echo ""

echo "📁 文档文件:"
grep -l "project_assest" /d/project_aggregation/*.md 2>/dev/null || echo "  ✅ 无引用"
echo ""

echo "📁 记忆文件:"
grep -l "project_assest" /d/project_aggregation/memory/*.md 2>/dev/null || echo "  ✅ 无引用"
echo ""

echo "✅ 搜索完成！"
```

**运行方法：**
```bash
chmod +x find-assest-references.sh
./find-assest-references.sh
```

---

## 🚨 如果重命名失败

**错误提示：** `Device or resource busy`

**原因：** 文件或文件夹被某个进程占用

**解决方法：**

1. **重启电脑** (最简单)
2. **或者使用 Process Explorer 找出占用进程：**
   - 下载 Process Explorer (Microsoft Sysinternals)
   - Ctrl+F 搜索 "project_assest"
   - 关闭占用进程
   - 重试重命名

3. **或者使用 LockHunter：**
   - 下载 LockHunter 工具
   - 右键文件夹 → "What is locking this folder?"
   - 解锁后重命名

---

## 📊 修改影响范围

| 影响项 | 状态 | 说明 |
|--------|------|------|
| **Git 历史** | ✅ 无影响 | 只是本地文件夹名，Git 跟踪的是仓库内容 |
| **远程仓库** | ✅ 无影响 | GitHub 仓库名本来就是 asset-ledger |
| **本地路径引用** | ⚠️ 需检查 | 配置文件、脚本中的硬编码路径 |
| **深色主题样式** | ✅ 无影响 | 样式文件在仓库内，不受文件夹名影响 |
| **其他开发者** | ✅ 无影响 | 只影响你的本地环境 |

---

## 📌 快速参考

**重命名前：**
```
/d/project_assest/          ← 本地文件夹（错误拼写）
  └── Git 远程: asset-ledger ← GitHub 仓库（正确拼写）
```

**重命名后：**
```
/d/project_asset/           ← 本地文件夹（正确拼写）
  └── Git 远程: asset-ledger ← GitHub 仓库（无变化）
```

---

## 💡 最佳实践建议

1. **先备份** - 虽然只是重命名，但保险起见
2. **选择空闲时段** - 确保没有程序在使用该目录
3. **逐步验证** - 改完一项测试一项
4. **更新文档** - 同步更新所有相关文档

---

**生成时间**: 2024-10-13  
**创建者**: Claude Opus 5.5  
**用途**: 指导 Codex 理解并执行文件夹重命名操作
