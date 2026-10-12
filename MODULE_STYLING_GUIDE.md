# Project Aggregation 统一设计系统集成指南

## 概述
本指南说明如何为各个独立模块集成统一的深色主题设计系统。所有模块采用一致的 Design Tokens、颜色方案和组件样式。

## 设计令牌系统

### 核心特性
- **深色优先**：完全深色主题，符合现代应用趋势
- **6 层表面层级**：从 #05080C 到 #323F4A，提供丰富的视觉层次
- **高对比度文本**：满足 WCAG AA 无障碍标准
- **一致的 Tokens**：所有模块共享相同的颜色、间距、圆角定义
- **响应式设计**：5 个断点支持从移动到桌面的完整适配

## 设计 Tokens 定义

### 颜色调色板

#### Surface 层级（背景）
```css
--surface-0: #05080C;  /* 最深 - 主背景 */
--surface-1: #0A0F14;  /* 导航、次级背景 */
--surface-2: #0F151C;  /* 卡片、面板 */
--surface-3: #161E26;  /* 悬停状态、覆盖层 */
--surface-4: #1E2831;  /* 边框、分隔线 */
--surface-5: #28333D;  /* 深色边框 */
--surface-6: #323F4A;  /* 深阴影 */
```

#### 强调色
```css
--accent: #38BDF8;           /* 主操作 - 亮青色 */
--accent-dim: #0EA5E9;       /* 悬停状态 */
--accent-subtle: #1E3A52;    /* 背景色调 */
--emerald: #6EE7B7;          /* 成功 - 亮青绿 */
--emerald-dim: #34D399;      /* 悬停状态 */
--warning: #FBBF24;          /* 警告 - 琥珀 */
--error: #F87171;            /* 危险 - 红色 */
```

#### 文本色
```css
--text-primary: #F0F4F8;     /* 主文本 */
--text-secondary: #B0BEC8;   /* 次级文本 */
--text-tertiary: #7A8A98;    /* 第三级/静音文本 */
```

### 间距
```css
--space-xs: 0.5rem;    /* 4px */
--space-sm: 0.75rem;   /* 6px */
--space-md: 1rem;      /* 8px */
--space-lg: 1.5rem;    /* 12px */
--space-xl: 2rem;      /* 16px */
--space-2xl: 3rem;     /* 24px */
```

### 边框半径
```css
--radius-sm: 0.5rem;     /* 4px */
--radius-md: 0.75rem;    /* 6px */
--radius-lg: 1rem;       /* 8px */
--radius-pill: 999px;    /* 圆形按钮 */
--radius-circle: 50%;    /* 完全圆形 */
```

### 阴影
```css
--shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.3);    /* 小 */
--shadow-md: 0 4px 16px rgba(0, 0, 0, 0.4);   /* 中 */
--shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.5);  /* 大 */
```

## 集成步骤

### 对于 CSS-based 模块（Vanilla CSS 或 SCSS）

#### 1. 导入设计令牌
在你的全局样式文件顶部添加：

```css
@import '/path/to/design-tokens.css';
```

或直接在 HTML `<head>` 中引入：

```html
<link rel="stylesheet" href="/design-tokens.css">
```

#### 2. 更新现有样式
使用 CSS 变量替换硬编码的颜色值：

**之前：**
```css
.button {
  background: #007bff;
  color: white;
  border-radius: 4px;
}
```

**之后：**
```css
.button {
  background: var(--accent);
  color: var(--surface-0);
  border-radius: var(--radius-md);
}
```

#### 3. 应用到现有元素
```css
body {
  background: var(--surface-0);
  color: var(--text-primary);
}

.card {
  background: var(--surface-2);
  border: 1px solid var(--surface-4);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-md);
}

input, select, textarea {
  background: var(--surface-3);
  border-color: var(--surface-5);
  color: var(--text-primary);
}

input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.1);
}
```

### 对于 Tailwind CSS 模块

#### 1. 配置 Tailwind 使用 CSS 变量
在 `tailwind.config.js` 中：

```js
module.exports = {
  theme: {
    colors: {
      // Surface layers
      'surface-0': 'var(--surface-0)',
      'surface-1': 'var(--surface-1)',
      'surface-2': 'var(--surface-2)',
      'surface-3': 'var(--surface-3)',
      'surface-4': 'var(--surface-4)',
      'surface-5': 'var(--surface-5)',
      'surface-6': 'var(--surface-6)',
      
      // Semantic colors
      'primary': 'var(--accent)',
      'success': 'var(--emerald)',
      'warning': 'var(--warning)',
      'error': 'var(--error)',
      
      // Text
      'text-primary': 'var(--text-primary)',
      'text-secondary': 'var(--text-secondary)',
      'text-tertiary': 'var(--text-tertiary)',
    },
    extend: {
      spacing: {
        'xs': 'var(--space-xs)',
        'sm': 'var(--space-sm)',
        'md': 'var(--space-md)',
        'lg': 'var(--space-lg)',
        'xl': 'var(--space-xl)',
        '2xl': 'var(--space-2xl)',
      },
      borderRadius: {
        'sm': 'var(--radius-sm)',
        'md': 'var(--radius-md)',
        'lg': 'var(--radius-lg)',
        'pill': 'var(--radius-pill)',
      },
      boxShadow: {
        'sm': 'var(--shadow-sm)',
        'md': 'var(--shadow-md)',
        'lg': 'var(--shadow-lg)',
      },
    },
  },
};
```

#### 2. 在全局样式中导入 Tokens
在你的全局 CSS 文件中：

```css
@import './design-tokens.css';
@tailwind base;
@tailwind components;
@tailwind utilities;
```

#### 3. 在 HTML 中使用 Tailwind 类
```html
<!-- 背景 -->
<div class="bg-surface-2">
  <!-- 文本 -->
  <p class="text-text-primary">Primary text</p>
  <p class="text-text-secondary">Secondary text</p>
  
  <!-- 按钮 -->
  <button class="bg-primary hover:bg-accent-dim text-surface-0 px-md py-sm rounded-pill">
    Action
  </button>
  
  <!-- 卡片 -->
  <div class="bg-surface-2 border border-surface-4 rounded-lg shadow-sm hover:shadow-md">
    <h3 class="text-text-primary">Title</h3>
  </div>
</div>
```

### 对于 React + Styled-components/CSS-in-JS 模块

#### 1. 导入全局样式
```jsx
import './design-tokens.css';
```

#### 2. 使用 CSS 变量
```jsx
import styled from 'styled-components';

export const Button = styled.button`
  background: var(--accent);
  color: var(--surface-0);
  border-radius: var(--radius-pill);
  padding: 9px 15px;
  border: 2px solid var(--accent);
  
  &:hover {
    background: var(--accent-dim);
    transform: translateY(-1px);
  }
  
  &:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
`;

export const Card = styled.div`
  background: var(--surface-2);
  border: 1px solid var(--surface-4);
  border-radius: var(--radius-lg);
  padding: 22px 24px;
  box-shadow: var(--shadow-sm);
  
  &:hover {
    border-color: var(--accent);
    box-shadow: var(--shadow-md);
  }
`;
```

## 组件样式参考

### 按钮
```html
<!-- Primary Button -->
<button class="button primary">
  确认
</button>

<!-- Secondary Button -->
<button class="button secondary">
  取消
</button>

<!-- Ghost Button -->
<button class="button ghost">
  关闭
</button>

<!-- Icon Button -->
<button class="icon-button">
  <svg>...</svg>
</button>
```

### 表单
```html
<div class="field">
  <label>Email</label>
  <input type="email" placeholder="user@example.com">
  <small>Please enter a valid email</small>
</div>

<div class="field">
  <label>Select Option</label>
  <select>
    <option>Option 1</option>
    <option>Option 2</option>
  </select>
</div>
```

### 卡片
```html
<div class="card">
  <div class="card-header">
    <h3>Card Title</h3>
  </div>
  <div class="card-body">
    Card content here
  </div>
  <div class="card-footer">
    <span>Footer info</span>
  </div>
</div>
```

### 表格
```html
<table>
  <thead>
    <tr>
      <th>Column 1</th>
      <th>Column 2</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Data 1</td>
      <td>Data 2</td>
    </tr>
  </tbody>
</table>
```

### 状态指示器
```html
<!-- 在线 -->
<span class="status online">
  <span></span>
  Online
</span>

<!-- 警告 -->
<span class="status warning">
  <span></span>
  Warning
</span>

<!-- 错误 -->
<span class="status error">
  <span></span>
  Error
</span>
```

### 提示框
```html
<!-- 成功 -->
<div class="success-box">
  ✓ Operation completed successfully
</div>

<!-- 警告 -->
<div class="warning-box">
  ⚠ Please review before proceeding
</div>

<!-- 错误 -->
<div class="error-box">
  ✕ Error occurred during processing
</div>

<!-- 信息 -->
<div class="info-box">
  ℹ Additional information available
</div>
```

## 模块特定指南

### ASTER（交易管理）
- 需要深色主题处理交易界面中的图表和表格
- 导入 `design-tokens.css` 到 `dashboard/app/globals.css`
- 使用 Tailwind 扩展配置应用主题

### Monitor（市场监控）
- 交易对展示需要统一的卡片样式
- 使用 `--accent` 突出重要的价格变动
- 表格需要 `--surface-3` 悬停效果

### Asset（资产账户）
- 资产展示卡片使用 `--surface-2` 背景
- 数字显示使用 `--text-primary`
- 使用 `--warning` 和 `--error` 表示风险

### CrossEx（交叉交易）
- 对冲腿选择器使用 `--accent` 高亮
- 风险指示器使用 `--error` 和 `--warning`
- 表单验证使用统一的 Tokens

### Variational（变分网格）
- 网格数据表格使用 `--surface-3` 行悬停
- 收敛指示器使用 `--emerald` 表示成功
- 图表容器使用 `--surface-2` 背景

### Greeks（期权希腊字母）
- 期权链展示使用深色表格样式
- 风险指标使用颜色编码（`--error`, `--warning`, `--emerald`）
- 实时数据更新使用 `--accent` 动画效果

## 无障碍考量

### 颜色对比度（WCAG AA）
- 所有文本使用 `--text-primary`（#F0F4F8）和 `--text-secondary`（#B0BEC8）
- 对比度比率 > 4.5:1（正文）和 > 3:1（大文本）

### 焦点指示器
```css
button:focus-visible,
input:focus-visible,
a:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}
```

### 减少动画
支持 `prefers-reduced-motion` 偏好设置：
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 响应式断点

```css
/* Mobile First */
@media (min-width: 480px)   { /* Small devices */ }
@media (min-width: 768px)   { /* Tablets */ }
@media (min-width: 1024px)  { /* Small desktops */ }
@media (min-width: 1280px)  { /* Desktops */ }
@media (min-width: 1600px)  { /* Large desktops */ }
```

## 常见问题

### Q: 如何为特定的模块自定义颜色？
A: 在模块的局部样式中重新定义 CSS 变量：
```css
.my-module {
  --accent: #FF6B6B;  /* 仅在此区域有效 */
}
```

### Q: 如何在现有 Light 主题上添加深色切换？
A: 使用 `color-scheme` 和媒体查询：
```css
@media (prefers-color-scheme: light) {
  :root {
    --surface-0: #FFFFFF;
    --text-primary: #000000;
  }
}
```

### Q: 如何处理第三方组件的样式？
A: 使用 CSS 变量覆盖：
```css
.third-party-component {
  --custom-bg: var(--surface-2);
  --custom-text: var(--text-primary);
}
```

## 快速检查清单

- [ ] 导入 `design-tokens.css` 到全局样式
- [ ] 将硬编码颜色替换为 CSS 变量
- [ ] 测试深色主题在所有屏幕尺寸
- [ ] 验证文本对比度满足 WCAG AA
- [ ] 测试焦点指示器可见性
- [ ] 验证悬停/活跃状态正确
- [ ] 在移动设备上测试响应式设计
- [ ] 测试 `prefers-reduced-motion` 偏好设置

## 支持

如有问题或需要修改 Design Tokens，请联系主项目团队。

---

**版本：** 1.0  
**最后更新：** 2024-10-12  
**维护者：** Project Aggregation Team
