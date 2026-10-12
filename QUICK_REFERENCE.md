# 深色主题快速参考

## 😎 已完成的模块

| 模块 | 路径 | 状态 | Design Tokens | Dark Theme |
|------|------|------|---------------|------------|
| ASTER 5X | `/d/project_aster_5x/dashboard/app/` | ✅ | ✓ | ✓ |
| Market Monitor | `/d/project_monitor/app/` | ✅ | ✓ | ✓ |
| Variational Grid | `/d/project_variational/variational_grid/web/` | ✅ | ✓ | ✓ |
| Gate CrossEx | `/d/project_crossex/src/` | ✅ | ✓ | ✓ |
| Greeks | `/d/project_greeks/app/static/` | ✅ | ✓ | ✓ |

## 🎨 核心颜色

### Backgrounds (Surface Layers)
```
--surface-0: #05080C  ← Most dark, main bg
--surface-1: #0A0F14  ← Navigation
--surface-2: #0F151C  ← Cards
--surface-3: #161E26  ← Hover states
--surface-4: #1E2831  ← Borders
--surface-5: #28333D  ← Dark borders
```

### Semantic Colors
```
--accent:   #38BDF8  ← Bright cyan (primary action)
--emerald:  #6EE7B7  ← Success (bright green)
--warning:  #FBBF24  ← Alert (amber)
--error:    #F87171  ← Danger (red)
```

### Text Colors
```
--text-primary:    #F0F4F8  ← Main text
--text-secondary:  #B0BEC8  ← Secondary
--text-tertiary:   #7A8A98  ← Muted
```

## 🚀 使用方法

### 在 CSS 中
```css
@import './design-tokens.css';
@import './dark-theme.css';

.my-button {
  background: var(--accent);
  color: var(--surface-0);
  border-radius: var(--radius-pill);
}
```

### 在 Tailwind 中
```html
<div class="bg-surface-2 text-text-primary">
  <button class="bg-accent hover:bg-accent-dim">Click me</button>
</div>
```

### 在 Styled-components 中
```jsx
const StyledButton = styled.button`
  background: var(--accent);
  &:hover { background: var(--accent-dim); }
`;
```

## 📐 间距与大小

| Token | 值 | 用途 |
|-------|-----|------|
| `--space-xs` | 0.5rem | 紧凑间距 |
| `--space-sm` | 0.75rem | 小间距 |
| `--space-md` | 1rem | 默认间距 |
| `--space-lg` | 1.5rem | 中等间距 |
| `--space-xl` | 2rem | 大间距 |
| `--space-2xl` | 3rem | 超大间距 |

## 🔲 圆角半径

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius-sm` | 0.5rem | 小圆角 |
| `--radius-md` | 0.75rem | 表单元素 |
| `--radius-lg` | 1rem | 卡片 |
| `--radius-pill` | 999px | 按钮 |

## 📦 组件样式

### 按钮
```html
<!-- Primary -->
<button class="button primary">确认</button>

<!-- Secondary -->
<button class="button secondary">取消</button>

<!-- Ghost -->
<button class="button ghost">关闭</button>
```

### 卡片
```html
<div class="card">
  <div class="card-header">
    <h3>标题</h3>
  </div>
  <div class="card-body">内容</div>
  <div class="card-footer">底部</div>
</div>
```

### 表单
```html
<div class="field">
  <label>标签</label>
  <input type="text" placeholder="...">
</div>
```

### 状态指示器
```html
<span class="status online">✓ 在线</span>
<span class="status warning">⚠ 警告</span>
<span class="status error">✕ 错误</span>
```

### 提示框
```html
<div class="success-box">✓ 操作成功</div>
<div class="warning-box">⚠ 请注意</div>
<div class="error-box">✕ 发生错误</div>
```

## ♿ 无障碍

### 焦点指示
```css
button:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}
```

### 对比度
- 文本对比度 >= 4.5:1（WCAG AA）
- 大文本对比度 >= 3:1（WCAG AA）

### 减少动画
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 📱 响应式断点

```css
@media (max-width: 1600px) { }  /* Large desktop */
@media (max-width: 1280px) { }  /* Desktop */
@media (max-width: 1024px) { }  /* Small desktop */
@media (max-width: 768px)  { }  /* Tablet */
@media (max-width: 480px)  { }  /* Mobile */
```

## 🔗 重要文件

| 文件 | 描述 |
|------|------|
| `design-tokens.css` | 统一设计令牌（所有模块共享） |
| `dark-theme.css` | 模块特定的深色主题补充 |
| `MODULE_STYLING_GUIDE.md` | 完整集成指南 |
| `FRONTEND_BEAUTIFICATION_COMPLETED.md` | 完成报告 |

## 💡 常见用例

### 设置深色卡片背景
```css
.my-card {
  background: var(--surface-2);
  border: 1px solid var(--surface-4);
  border-radius: var(--radius-lg);
}
```

### 高亮重要信息
```css
.important {
  color: var(--accent);
  font-weight: 600;
}
```

### 表示成功状态
```css
.success-indicator {
  color: var(--emerald);
  background: rgba(110, 231, 183, 0.15);
}
```

### 表示错误状态
```css
.error-indicator {
  color: var(--error);
  background: rgba(248, 113, 113, 0.15);
}
```

## ❓ 常见问题

**Q: 如何自定义特定模块的颜色？**
```css
/* 在模块的 dark-theme.css 中重新定义 */
.my-module {
  --accent: #FF6B6B;  /* 仅在此区域有效 */
}
```

**Q: 如何添加浅色主题？**
```css
@media (prefers-color-scheme: light) {
  :root {
    --surface-0: #FFFFFF;
    --text-primary: #000000;
    /* ... */
  }
}
```

**Q: Design Tokens 优先级如何？**
```
inline styles > dark-theme.css > design-tokens.css > browser defaults
```

**Q: 如何验证对比度？**
使用 Chrome DevTools：
1. 右键 → 检查
2. Elements → Styles
3. 选中元素 → 检查对比度

## 🎯 验证清单

- [ ] 导入 design-tokens.css
- [ ] 导入 dark-theme.css
- [ ] 所有背景使用 surface 颜色
- [ ] 所有文本使用 text 颜色
- [ ] 强调使用 accent 颜色
- [ ] 成功/警告/错误使用对应颜色
- [ ] 焦点指示清晰可见
- [ ] 移动端显示正确
- [ ] 减少动画模式支持

## 📞 获取帮助

1. **集成问题** → 查看 `MODULE_STYLING_GUIDE.md`
2. **样式问题** → 修改对应的 `dark-theme.css`
3. **设计决定** → 参考 `FRONTEND_BEAUTIFICATION_COMPLETED.md`
4. **CSS 变量** → 查看 `design-tokens.css`

---

**最后更新**：2024-10-12  
**版本**：1.0  
**状态**：✅ 所有模块已完成美化
