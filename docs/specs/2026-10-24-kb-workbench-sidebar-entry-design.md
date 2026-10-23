# 知识库工作台：DSH 侧栏原生入口（Slice 1.5）设计

> 状态：Approved（2026-10-24）  
> 目标版本：`dsh-knowledge-wiki` 0.19.1  
> 依赖：Slice 1 已安装（`/kb/` 工作台、`lib/web/*` 服务端路由、180 tests；本切片完成后 186 tests）  
> 后续：本设计建立的客户端构建链由 Slice 2（上传/范围/胶囊）复用

## 1. 目标

在 DeepSeek Harness Web UI（含桌面端）的左侧栏底部增加一个原生「知识库」入口：

- 展开侧栏：数据库图标 + “知识库”
- 收起侧栏：仅图标，带 `title` / `aria-label`
- 点击在新标签/新窗口打开 `/kb/`，不离开当前会话
- 不改变现有 21 个 `kb_*` 工具和 `/kb/` 页面行为

同时建立一条可复用的 TypeScript/React 客户端构建链，供 Slice 2 的胶囊与范围选择器使用。

## 2. 非目标

- 不做 DSH 内嵌 iframe/面板；不在当前页跳转
- 不做命令面板入口、快捷键、胶囊/范围选择
- 不重构 Slice 1 的服务端路由、API、UI
- 不在本切片引入 tsdown 或官方 DSH 构建预设
- 不做英文/多语言（先中文；locale 在 Slice 2 再评估）

## 3. 背景与约束

### 3.1 已确认的 DSH 扩展点

DSH 的侧栏 `sidebar.footer.action` 是 **list slot**，位于侧栏底部、设置入口旁边，渲染时传入 `{ wide }`：

- `wide=true`：侧栏展开，可显示图标 + 文本
- `wide=false`：侧栏收起，只显示图标
- `sidebar.workspaces` 是 workspace picker 独占的 single slot，不抢占

### 3.2 DSH 客户端插件格式

客户端插件通过 `package.json` 声明：

```json
"exports": { "./client": "./lib/client.js" },
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar"] } }
```

客户端 bundle 必须是宿主模块加载器格式：

```js
(() => {
  const KB_CLIENT_IDS = ["dsh-knowledge-base", "dsh-knowledge-wiki"];
  const boot = typeof window !== "undefined" ? window.__DSH_BOOT__ : undefined;
  const rows = boot && Array.isArray(boot.entries) ? boot.entries : [];
  const known = new Set(rows.map((row) => row && row.id));
  const id = KB_CLIENT_IDS.find((candidate) => known.has(candidate)) || KB_CLIENT_IDS[0];
  window.__ModuleLoader__.load({
    id,
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      // bundle body
      return module.exports;
    }
  });
})();
```

**loader entry id 兼容：** 当前 profile 的 loader entry 名是历史别名 `dsh-knowledge-base`，
而 package name 是 `dsh-knowledge-wiki`。`client-modules` 用 loader entry 名作为 graph row id，
bundle 必须注册同一个 id，否则浏览器会报
`bundle /plugins/.../client.js loaded without registering "<id>"`。因此 bundle 从
`window.__DSH_BOOT__.entries` 中选择实际存在的候选 id（当前安装为 `dsh-knowledge-base`），
兼容未来按 package name 安装为 `dsh-knowledge-wiki` 的部署。

React 由宿主通过 `require("react")` 提供，不能打进第二份 React。

### 3.3 为什么选 B-lite

- 长期方向是 TypeScript/React 源码 + 构建产物（方案 B）
- 但官方 `tsdown` + DSH 客户端构建预设没有随当前仓库/安装包提供；为一个按钮从零复刻预设不划算
- 改用 **esbuild** 产出同样的 CJS + `__ModuleLoader__` 包装：依赖小、构建快、输出可控
- 组件与构建脚本分离；Slice 2 若要迁移 tsdown，只替换 `scripts/build-client.mjs`

## 4. 用户体验

### 4.1 侧栏入口

展开时：

```
[数据库图标] 知识库
```

收起时：

```
[数据库图标]
```

- 使用 `var(--dsw-alias-*)` 主题变量，不写死颜色
- hover / focus-visible 有背景与轮廓反馈
- `aria-label="知识库工作台"`，`title="知识库工作台"`
- 不挤压设置入口；`sidebar.footer.action` 的 list 顺序由 `order` 控制（建议 10）

### 4.2 点击行为

```js
window.open("/kb/", "_blank", "noopener,noreferrer");
```

- 使用相对路径 `/kb/`，桌面端端口变化也能正确打开
- 打开失败（弹窗被拦截）时不改变当前页；不静默跳转，避免丢会话
- 桌面端由 Electron/浏览器决定新窗口或新标签；两者都满足验收

## 5. 架构与文件

```text
src/client/index.tsx          # 新增：React 组件 + slot 注册 + CSS 注入
scripts/build-client.mjs      # 新增：esbuild 打包 + __ModuleLoader__ 包装 + --check
lib/client.js                 # 生成产物（提交）
test/client-entry.test.mjs    # 新增：VM 加载产物，验证 slot / 点击 / 折叠
package.json                  # 修改：exports、dsh.client、scripts、devDeps
tsconfig.json                 # 新增：typecheck
README.md                     # 修改：侧栏入口与客户端构建说明
```

服务端代码（`lib/index.js`、`lib/web/*`、`ui/*`）不改。

### 5.1 `src/client/index.tsx`

```tsx
import React from "react";

export const inject = ["slots"];

type SlotContext = {
  slots: {
    inject(name: string, callback: () => void): void;
    register(decl: Record<string, unknown>, component: React.ComponentType<{ wide?: boolean }>): void;
  };
};

const CSS_ID = "dsh-knowledge-wiki/sidebar-entry.css";
const CSS = `...`;

function ensureCss() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return;
  const style = document.createElement("style");
  style.dataset.pluginCss = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function DatabaseIcon() { /* inline SVG 18x18 */ }

export function KbWorkbenchAction({ wide }: { wide?: boolean }) {
  const open = () => window.open("/kb/", "_blank", "noopener,noreferrer");
  return (
    <button
      type="button"
      className={`dsh-kb-entry${wide ? "" : " dsh-kb-entry-collapsed"}`}
      title="知识库工作台"
      aria-label="知识库工作台"
      onClick={open}
    >
      <DatabaseIcon />
      {wide ? <span>知识库</span> : null}
    </button>
  );
}

export function apply(ctx: SlotContext) {
  ensureCss();
  ctx.slots.inject("sidebar.footer.action", () => {
    ctx.slots.register(
      { name: "sidebar.footer.action", id: "kb-workbench", order: 10 },
      KbWorkbenchAction
    );
  });
}
```

约束：

- 组件只依赖 `react`，不依赖 UI primitives 包
- SVG 内联，避免额外图标依赖
- CSS 注入使用固定 `data-plugin-css` id，防止 HMR/重复加载时重复插入
- `apply` 只做 slot 注册；不做网络请求

### 5.2 `scripts/build-client.mjs`

职责：

1. esbuild 打包 `src/client/index.tsx`
   - `bundle: true`、`format: "cjs"`、`platform: "browser"`、`target: "es2022"`
   - `external: ["react", "react/jsx-runtime", "react-dom"]`
   - `jsx: "automatic"`、`charset: "utf8"`、`legalComments: "none"`
2. 把 CJS 输出嵌入 `window.__ModuleLoader__.load({ id, factory })`；`id` 从 boot graph
   的 `dsh-knowledge-base` / `dsh-knowledge-wiki` 候选中选择实际存在的那个
3. 写 `lib/client.js`，首行注释：

```js
// Generated by scripts/build-client.mjs. Do not edit by hand.
```

4. `--check` 模式：在内存中重新构建，与磁盘产物逐字节比较；不一致时打印差异提示并以 1 退出
5. 输出包含 `require("react")` 的外部引用，不含 React 实现

### 5.3 `package.json`

新增/修改：

```json
{
  "version": "0.19.1",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar"]
    }
  },
  "scripts": {
    "build:client": "node scripts/build-client.mjs",
    "check:client": "node scripts/build-client.mjs --check",
    "typecheck": "tsc --noEmit",
    "test": "node scripts/build-client.mjs --check && node --test ..."
  },
  "devDependencies": {
    "@types/react": "^18.3.31",
    "esbuild": "^0.28.2",
    "react": "^18.3.1",
    "typescript": "^5.9.3"
  }
}
```

说明：

- `react` 只作为 devDependency（类型/lint 用），运行时由宿主提供；esbuild 将其 external
- `lib` 已在 `files` 中，产物会随 npm 包发布
- 现有 `dsh.bundle.patch` 不变
- `npm test` 前置 `check:client`，防止“改了源码忘了构建”

### 5.4 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["react"]
  },
  "include": ["src/client/**/*.tsx"]
}
```

## 6. 数据流

```text
DSH 启动
  → client-modules 扫描 package 的 dsh.client（loader entry 名当前为 dsh-knowledge-base）
  → 加载 /plugins/<loader-entry>/client.js
  → __ModuleLoader__ 执行 factory，exports.apply
  → apply(ctx) 注入 CSS，ctx.slots.inject("sidebar.footer.action", ...)
  → 侧栏底部渲染 KbWorkbenchAction
  → 用户点击 → window.open("/kb/")
  → 浏览器/Electron 新窗口加载 /kb/（服务端路由由 Slice 1 提供）
```

## 7. 错误处理

- `window.open` 返回 `null`（弹窗被拦截）：不改变当前页，不抛错；可在控制台 `console.warn`（可选）
- CSS 重复注入：固定 `data-plugin-css` id 去重
- slot 声明尚未注册：`slots.inject` 等待声明；不自己轮询 DOM
- 产物缺失/过期：`check:client` 在 `npm test` 前置失败
- `dsh.client.inject` 包名不存在：启动日志会报错；实现时先在桌面端确认，必要时去掉 `inject` 并依赖 `slots.inject` 的等待语义

## 8. 测试

### 8.1 `test/client-entry.test.mjs`（新）

用 `node:vm` 模拟：

```js
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { captured = entry; } } },
  document: undefined,
  console,
};
```

加载 `lib/client.js` 后：

1. 断言 `captured.id` 是 boot graph 中的实际 id（当前 profile 为 `dsh-knowledge-base`；
   package-name 安装为 `dsh-knowledge-wiki`）
2. 用 fake `require("react")` / `require("react/jsx-runtime")` 执行 factory
3. `exports.apply(fakeCtx)` 后断言：
   - `fakeCtx.slots.inject` 收到 `"sidebar.footer.action"`
   - `fakeCtx.slots.register` 收到 `id: "kb-workbench"`、`order: 10`
   - 注册的组件是函数
4. 直接渲染组件（fake `jsx/jsxs` 返回树对象）：
   - `wide=true` 时包含文本“知识库”
   - `wide=false` 时只有图标（无文本节点）
   - 点击 `props.onClick()` 调用 `window.open("/kb/", "_blank", ...)`
5. 断言产物包含 `require("react")`，不包含 React 实现标志（防止打包进第二份 React）
6. 断言 `package.json` 的 `dsh.client.platform === "web"`、`exports["./client"]` 存在

### 8.2 `npm test`

在现有 180 个测试前追加 `check:client`，并增加 6 个客户端测试（总计 186）：

```text
node scripts/build-client.mjs --check && node --test test/client-entry.test.mjs ...（现有列表）
```

### 8.3 不做

- 用临时 `dsh web --port 55930`（真实宿主）+ WebKit 做侧栏入口与点击验证
- 桌面端重启后的最终视觉确认仍由人工完成；不做截图回归

## 9. 验收标准

- [ ] `npm run check:client` 通过
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全通过（186）
- [ ] 安装/重启桌面端后，侧栏底部出现「知识库」入口
- [ ] 展开显示图标 + “知识库”，收起只显示图标
- [ ] 点击在新标签/新窗口打开 `/kb/`，显示 9 个库
- [ ] 当前会话不丢失；`kb_*` 工具与 `/kb/` 页面无回归
- [ ] 客户端 bundle 不包含第二份 React

## 10. 兼容与回滚

- 客户端入口是新增能力；服务端工具与 `/kb/` 不受影响
- 若 `dsh.client` 元数据在某个 DSH 版本不兼容，删除 `package.json` 的 `dsh.client` 与 `exports["./client"]` 即可回退，服务端功能保持
- 产物 `lib/client.js` 由 `scripts/build-client.mjs` 生成；回滚源码时同步回滚产物
- `dsh.client.inject` 只在 `sidebar` 客户端包存在时有效；桌面/网页 profile 都包含它

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| esbuild 包装格式与宿主加载器不兼容 | 侧栏入口不出现 | VM 测试 + 桌面端实测；必要时对照官方 `lib/client.js` 调整包装 |
| 打包进第二份 React | 运行时 hooks 冲突 | esbuild `external: ["react", ...]`；测试断言不含 React 实现 |
| `sidebar.footer.action` 样式与主题不一致 | 视觉突兀 | 只用 `--dsw-alias-*` 变量；内联 SVG；展开/收起两态验收 |
| 客户端 bundle 缓存/重启 | 改完看不到 | 验收时重启桌面端；`check:client` 保证产物最新 |
| loader entry id 与 package name 不一致 | bundle 注册 id 错误，入口不出现 | bundle 从 `__DSH_BOOT__.entries` 选择实际 graph id；VM 测试覆盖两种 id |
| `dsh.client.inject` 包名在不同版本变化 | 启动报错 | 先在当前桌面端验证；失败时去掉 `inject`，仅保留 `ctx.slots.inject` |
| `exports` 字段影响包解析 | 服务端加载失败 | 保留 `.`、`./client`、`./package.json`；安装后跑 `npm test` 与桌面端启动验证 |

## 12. 与 Slice 2 的关系

本切片建立的：

- `src/client/`
- `scripts/build-client.mjs`
- `lib/client.js`
- `dsh.client` 元数据
- slot 注册/组件测试模式

将直接用于 Slice 2 的：

- 胶囊（输入框旁的知识库范围选择）
- 上传批次/导入进度 UI
- 标准检查/下载 UI

Slice 2 计划只需在此基础上增加组件与状态，不再从零搭客户端构建链。

## 13. 决策记录

- **入口位置**：`sidebar.footer.action`（原生 list slot），而非 `sidebar.workspaces`（single，归 workspace picker）
- **打开方式**：新标签/新窗口，不内嵌、不当前页跳转
- **实现路线**：B-lite（TypeScript/React + esbuild + 提交产物），不是纯手写 bundle，也不是完整 tsdown 预设
- **构建器**：esbuild（官方预设不可用；产物格式用 `__ModuleLoader__` 包装手动生成）
- **bundle id**：从 `__DSH_BOOT__.entries` 选择 `dsh-knowledge-base` / `dsh-knowledge-wiki` 中实际存在的 id
- **测试**：VM 级 bundle/slot 测试 + 临时真实 DSH 宿主 WebKit 验证 + 桌面端手动验收


## Slice 1.5 验收记录（2026-10-24）

- [x] `npm run check:client` / `npm run typecheck` / `npm test`（186 tests / 0 fail）
- [x] `lib/client.js` 按 boot graph 注册 `dsh-knowledge-base`（当前 profile），也兼容 `dsh-knowledge-wiki`
- [x] 临时 `dsh web --port 55930`（真实宿主）+ WebKit：侧栏底部「知识库」入口可见
- [x] 点击入口：`window.open("/kb/", "_blank", "noopener,noreferrer")`；当前 GUI 不跳转
- [ ] 桌面端重启后视觉确认（客户端 bundle 只在宿主启动时扫描 `dsh.client`）
