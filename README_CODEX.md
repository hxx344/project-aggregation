# Codex 性能优化任务

## 任务概述

对 6 个独立项目应用已验证的性能优化技术（database statement cache + React.memo）。

## 完整指南

👉 **[CODEX_OPTIMIZATION_GUIDE.md](./CODEX_OPTIMIZATION_GUIDE.md)** - 992行完整实施指南

包含：
- ✅ 每个项目的详细分析和优化点
- ✅ 代码修改before/after对比
- ✅ 具体文件路径和行号
- ✅ 30分钟快速开始流程
- ✅ 测试和发布checklist

## 快速参考

### 项目优先级
1. 🔥 **Market Monitor** - 最高ROI，立即执行
2. ⚠️ **Asset Ledger** - 补充已有优化
3. ⚙️ **ASTER 5X** - 前端组件优化
4. 📊 其他项目 - 根据需要

### 核心技术
- **Statement Cache**: 20-40% 数据库性能提升
- **React.memo**: 60-80% 减少重渲染
- **预计算**: 项目特定的累积计算优化

### 参考实现
- 工作台 PR: https://github.com/hxx344/project-aggregation/pull/1
- CrossEx: commit `281813a` ✅ 已完成
- Asset Ledger: commit `5ea37c8` ⚠️ 部分完成

## 开始执行

```bash
# 1. 阅读完整指南
code CODEX_OPTIMIZATION_GUIDE.md

# 2. 从 Market Monitor 开始
cd D:\project_monitor
# 按照"快速开始"章节执行

# 3. 参考 CrossEx 的实现
cd D:\project_crossex
git show 281813a
```

## 预期结果

- 6个项目各有性能提升
- 统一的优化模式
- 更好的代码可维护性
- 每个项目 30-60分钟完成

---

**Created**: 基于 project-aggregation v0.2.0 优化经验  
**For**: Codex 自动化执行
