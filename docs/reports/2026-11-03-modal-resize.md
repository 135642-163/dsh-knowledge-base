# 弹窗可拖拽调大小（2026-11-03）

- 范围：知识库工作台弹窗（宿主内）、聊天回答里点来源卡片打开的原件预览、工作台内「查看原件」预览
- 目标：鼠标拖弹窗外框能调整大小；不破坏「点外部关闭」；尺寸可记忆
- 结果：三处弹窗均支持八向拖拽 + 尺寸记忆；`npm test` 1444（1440 通过、4 跳过）、`typecheck` 通过、
  新增 E2E「弹窗拖拽调大小」通过

## 一、原实现

三处弹窗的尺寸都写死在 CSS 里，用户无法调整：

| 弹窗 | 渲染位置 | 原尺寸 | 关闭方式 |
|---|---|---|---|
| 知识库工作台 | 客户端 bundle `src/client/index.tsx` | `min(1180px,100%) × min(860px,100%)` | 遮罩 `mousedown` + Esc + × |
| 聊天来源卡片 → 原件预览 | 客户端 bundle 同一文件 | `min(1120px,94vw) × min(90vh,900px)` | 遮罩 `mousedown` + × |
| 工作台内「查看原件」 | `/kb/` 静态页 `ui/views/modals.js` | `min(1080px,92vw) × 92vh`（正文 70vh） | 遮罩 `mousedown` + Esc |

弹窗都是「固定定位遮罩 + grid 居中」，所以单纯给弹窗加 CSS `resize: both` 会出现：只有右下角一个把手、
居中布局导致把手不跟手、无法持久化、且 iframe 内容不随高度伸缩。

## 二、设计

1. **把手挂在遮罩上、贴在弹窗外侧**（6px 边 / 12px 角），而不是弹窗内部：
   - 不覆盖 iframe 的滚动条与正文边缘；
   - `mousedown` 的 `target` 是把手，不是遮罩，遮罩的关闭判据 `target === 遮罩` 自然不成立。
2. **第一次拖动才切成 `position: fixed`**：把当前 `getBoundingClientRect()` 原样写成 `left/top/width/height`，
   视觉上不跳；之后拖哪条边只动哪条边，对边锚定。
3. **尺寸记忆**：松手把 `{width,height}` 写进 `localStorage`（`dsh-kb:size:workbench` / `dsh-kb:size:preview`），
   下次打开按记忆尺寸居中恢复，并按当前视口重新夹取（`fitRect`）。
4. **最小/最大**：工作台 640×420、预览 480×360；最大 = 视口减 8px 边距；视口比最小尺寸还小时以可推进距离为准。
5. **预览正文自适应**：调过尺寸的 `preview-modal` 加 `kb-sized`，正文由 `70vh` 改为 `flex: 1` 跟随弹窗高度，
   避免调小后出现双滚动条、调大后下方留白。

## 三、为什么不会「点外部就消失」

- 三处关闭都监听 **`mousedown`**，判据是 `event.target === 遮罩`。拖拽从把手开始，把手是遮罩的子元素但
  不是遮罩本身，而且 `pointerdown` 里 `stopPropagation()` + `preventDefault()`（后者会抑制兼容 `mousedown`）。
- 真正危险的路径是 **click**：按下在把手、松开在遮罩时，浏览器把 `click` 派发到两者最近公共祖先＝遮罩。
  当前代码不用 click 关闭，但仍加了一道守卫：拖完吞掉这一次手势尾巴上的 click。
- 守卫只吞「拖拽自己的」那一下：新的手势从 `pointerdown` 开始就撤掉守卫，所以拖完立刻点遮罩仍能关闭
  （第一版用 400ms 固定延时，会把用户拖完后紧接着的点击吃掉，E2E 抓到的就是这个）。
- 拖拽中按 Esc 只结束拖拽并 `stopPropagation`，不会把弹窗关掉导致 `pointerup` 丢失。
- iframe 会吞 `pointermove`：拖拽期间给弹窗内 iframe 设 `pointer-events: none`，并用 `pointerCapture` 兜底。
- 拖到一半组件卸载/窗口失焦：统一清理监听、光标、`user-select` 与 iframe 状态。

## 四、实现位置

- `ui/resize-geometry.js`：纯几何（`fitRect` / `resizeRect` / `clampNumber`），可脱离 DOM 单测。
- `ui/resizable.js`：DOM 绑定（八向把手、`pointer` 事件、尺寸记忆、点击守卫），被客户端 bundle 与
  `/kb/` 静态页共用；`ui/resizable.d.ts` 给 TSX 提供类型。
- `src/client/index.tsx`：工作台与聊天预览在 `useEffect` 里 `mountResize(...)`，关闭时 `destroy()`。
- `ui/views/modals.js`：`openPreviewModal` 挂载；`closeOverlay`/`close` 时销毁。
- `ui/style.css` 与客户端内联 CSS：把手光标与 `kb-sized` 布局。

## 五、验证

- 单测 `test/ui-resize.test.mjs`：11 条，覆盖几何夹取、八向方向、最小尺寸、视口回夹、尺寸记忆脏数据，
  以及最小假 DOM 上的「拖拽不冒泡 + 尺寸落盘 + destroy 清把手」。
- E2E `scripts/e2e/tests/resize.mjs`：真浏览器（WebKit）里打开工作台与预览弹窗，用鼠标拖右边 140px，
  断言宽度收窄、左边不动、弹窗仍开着、尺寸写入 localStorage、重开恢复、拖完点遮罩仍能关，
  并检查预览正文随高度伸缩、弹窗内无溢出。
- `npm test` 1444（1440 通过、4 跳过）；`npm run typecheck` 通过；
  全量 E2E **18 passed / 0 failed / 1 skipped**（skip 为「来源面板」既有用例：宿主未投影 tool/result meta）。

## 六、取舍

- 只做拖拽，没有做「双击标题栏最大化」；需要时可再加一个按钮。
- 记忆的是尺寸，不记忆位置：重开总是居中，避免上次拖到屏幕边缘后找不回来。
- 聊天预览与工作台内预览共用 `preview` 尺寸（同源 localStorage），两处大小保持一致。
