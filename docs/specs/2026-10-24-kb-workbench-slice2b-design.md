# 知识库工作台 Slice 2B 设计：会话范围 + 胶囊 + 工具硬约束

> 状态：已与用户逐项确认（2026-10-24），待 spec review。
> 基线：`dsh-knowledge-wiki` 0.20.4，`npm test` 312/312，`git 8af72cf`。
> 关联：`2026-10-24-kb-workbench-slice2-brief.md`（范围与交接）、`2026-10-24-kb-workbench-slice2a-design.md` §14（2B 待验证项）、`2026-10-23-kb-workbench-design.md` §6（胶囊与范围）、`2026-10-24-kb-workbench-sidebar-entry-design.md`（客户端 bundle/弹窗模式）。
> 本文所有“已实测”结论来自第 4 节的宿主 spike，证据可复现。

## 1. 背景与目标

Slice 2A 已交付工作台上传/导入任务与标准更新面板（0.20.x），但模型侧仍然“看到全部知识库”：工作台里做的库隔离只影响人，不影响 `kb_*` 工具。Slice 2B 补齐 M1 §6 的会话范围能力：

1. 会话级知识库范围：输入框旁的胶囊选择本会话可用的库，存 `kbRoot/.scopes.json`，子会话继承父范围。
2. 21 个 `kb_*` 工具按范围矩阵硬约束，范围外返回 `KB_OUT_OF_SCOPE`，不静默降级。
3. 系统提示按会话注入范围说明（仅限定时）。
4. 胶囊 UI（收起/展开/搜索/多选/应用/取消/打开工作台），无 API 时静默不渲染。
5. `/kb/api/scope` 读/写 API，`/kb/api/status.features.scope` 能力声明。

成功标准：一个会话选定「标准」后，模型 `kb_list` 只看到「标准」，`kb_query` 搜不到别的库，显式指定其它库报 `KB_OUT_OF_SCOPE`；子代理继承该范围；换一个会话仍是默认“全部”。

## 2. 范围与非目标

### 2.1 本切片做

- `lib/scope.js`（存储/校验/清理/继承/解析/错误类型）、`lib/scope-view.js`（纯函数）。
- `.scopes.json` v1：`mode: all|selected`、TTL 惰性清理、原子写、串行队列、重命名/归档同步。
- 懒解析 + 首次使用时快照继承（子会话）。
- 21 个 `kb_*` 工具按矩阵接入；`kb_list`/`kb_query` 输出带 `scope`。
- 动态系统提示段（order 120，仅 `selected` 注入）。
- `GET/PUT /kb/api/scope`；`/status.features.scope`。
- 客户端：复用弹窗 + `conversation.input.left` 胶囊。
- 测试与真实宿主验收；版本 0.21.0。

### 2.2 非目标

- 工作区/项目级范围、跨机器同步、范围变更审计日志。
- 设置页「知识库」入口（brief §6 Q6，独立事项）。
- 任务模板/批量派发（M2）。
- 范围影响工作台 HTTP API 或 UI 浏览：范围只约束 `kb_*` 工具，**不是权限边界**（M1 §7.9）。
- `kb_import` 自动建库等顺手功能。

## 3. 已确认决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 继承机制 | **懒解析 + 首次使用时快照继承**：子会话无显式条目且父有 → 复制一份写回（`inheritedFrom`）；不依赖事件；首次解析前父变化会传递，之后不回溯 |
| 2 | 工具接入 | **一次性全接 21 个工具**，公共 `resolveScopeTarget`/`resolveDocInScope` 收口，表驱动测试 |
| 3 | 提示段 | **仅 `mode=selected` 注入**；`all` 不注入（零 token 开销） |
| 4 | 胶囊 | **按 M1 §6.1 全量**：搜索、多选、全选/清空、应用/取消、打开工作台、三类降级 |
| 5 | 打开工作台 | **复用 DSH 内弹窗**：把 Slice 1.5 弹窗抽成可复用组件，侧栏与胶囊各持开关状态 |
| 6 | 多库 doc 解析 | **跨库解析 + 候选列表**：范围 >1 库且省略 `kb` 时按标题/id 在范围内找；1 命中直接用，多命中报候选（kb+docId+标题），0 命中报未找到 |
| 7 | 身份缺失 | **fail-open**：`exec.agent?.session?.id` 为空 → 不限制（现有测试的 fake exec 无 id；真实工具路径始终有 agent） |

## 4. 宿主 spike 结论（2026-10-24）

### 4.1 环境与方法

- **桌面宿主 0.2.1-rc.2**：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（解析 asar 头读取 `dsh/node_modules/@deepseek-ai/*` 源码与生成的 API 目录）。
- **实跑宿主 0.1.1-rc.2**：`dsh --profile web --port 55940`（临时把探针插件插入 `~/.dsh/profiles/web/cordis.patch.yml`，完成后已还原）。
- 探针插件 `/tmp/kb-spike-probe`：server 端监听 `agent/created`、注册动态 `systemPrompt.section` 并写 `/tmp/kb-spike-events.jsonl`；client 端向 `conversation.input.left` 与 `conversation.session.header.utilities` 各注册一个组件，把 props 写进 `window.__kbSpike`。
- 浏览器验收用 `.acceptance/wkflow`（WKWebView + `flow.js`）：注入流程脚本、读 `window.__kbSpike`、截图；并驱动了一轮真实对话（临时会话用完已删除）。
- 截图证据：`.acceptance/screenshot-spike-capsule-slot.png`。

### 4.2 结论 1：`conversation.input.left` 存在，props 带 `sessionId`

- 桌面版生成的 slot 目录（`app.asar` 内 `@deepseek-ai/dsh-cordis-client-runner/lib/client.js`）明确声明：
  - `key: "conversation.input.left"`、`kind: "list"`、`scope: "session"`、`declaredBy: "an entry in 'conversation.composer.bar'"`、`replaceRisk: "none"`。
  - `standardProps` 含 `sessionId: SessionId`、`useSessions`、`useSession`、`useInput`、`inputActions`、`session` 等。
- 实跑 props 实测：`input, inputActions, session, sessionId, useInput, useProjection, useSession, useSessions, useWorkspaces`；`sessionId` 形如 `session-3f76c894-…`。
- 位置实测：渲染在输入框工具行（`+ 按钮 / Workspace Write / 模型选择` 一行），chip 尺寸约 130×24px，**胶囊必须按 24px 行高设计**。
- 退路 `conversation.session.header.utilities` 在首页/空会话渲染 0 次（只在会话头部存在）→ 胶囊优先 `input.left`，header 只作为“有头部时”的备用位置；本切片不实现 header 注册。

### 4.3 结论 2：没有 `agent/session-start` 事件；动态提示段可用

- 桌面版事件目录（`dsh-tool-cordis/lib/types/api-catalog.js` 的 `EVENT_API`，共 82 项）**没有** `agent/session-start`；会话相关事件只有 `session/created|disposed|event|flush`。
- 可用替代：
  - `ctx.on("agent/created", ({ agent, source, signal }) => …)`：`mode: "serial"`，桌面版签名带 `source: SessionStartSource`（`'startup' | 'resume' | 'clear' | 'compact'`）。实跑 0.1.1 宿主**未传 `source`**（日志里缺失）→ 不能依赖该字段。
  - `ctx.systemPrompt.section({ text })` 的 `text` 是 `string | ((context: AssembleContext) => string)`（桌面版类型声明 `PromptSection`；源码 `typeof section.text === "function" ? section.text(context) : section.text`）。
- 实跑：组装时 `context` 键为 `agent, scope, signal`，`context.agent.session.id` 可拿到会话 id；渲染后的 system message 在 session log（zstd）中可 grep 到动态文本 `[KB SPIKE] dynamic session=…` → **不需要 `agent.inject()` 降级**。
- 含义：2B **不订阅 `agent/created`**，提示段用动态函数 + 同步只读缓存；继承走懒快照。

### 4.4 结论 3：父会话字段是 `session.header.parentSession`

- 桌面版 `dsh-session` 对 header 校验 `parentSession`（非空则必须 string）；fork 时写 `parentSession: liveSource.id`，并带 `origin: "subagent"`、`delegationDepth`。
- 实跑读取 `agent.session.header.parentSession` 得到 `null`（根会话）、`delegationDepth: 0`。
- 用法：工具/提示 = `exec.agent.session.header.parentSession` / `context.agent.session.header.parentSession`；API = `ctx.get("agents")` 取 live agent 的 header（拿不到就只看自己条目）。

### 4.5 结论 4：工具侧身份可用，公共入口可行

- 桌面版 `dsh-tools` 源码在多处使用 `exec.agent?.session`；`ToolExecutionInput.agent?: Agent`。
- 插件 21 个工具全部已是 `execute(args, exec)` 签名（`kb_read` 等少数忽略 `exec`，需补参数）。
- 现有 `execCwd(exec)` 已从 `exec.agent.session.header.cwd` 取值，说明 header 访问路径稳定；测试里的 fake exec 只有 `{ header: { cwd } }`，没有 `id` → 必须 fail-open（决策 7）。

## 5. 架构与文件

```
lib/
  scope.js          新增：存储/校验/清理/继承/解析/ScopeError
  scope-view.js     新增：纯函数（chipLabel/selectionPayload/mergeSelection）
  index.js          改：21 工具接入 + 动态提示段 + config scopeTtlDays
  kbmeta.js         改：归档/重命名同步 .scopes.json（复用 removeScopesReferences）
  version.js        改：0.21.0
  web/api.js        改：GET/PUT /kb/api/scope；features.scope
  web/http.js       不改（复用 requireUiHeader/assertSameOrigin/isTrustedApiRequest）
src/client/index.tsx  改：抽 WorkbenchModal + 注册胶囊
lib/client.js         改：构建产物（esbuild）
test/
  scope-store.test.mjs     新增
  scope-inherit.test.mjs   新增
  scope-tools.test.mjs     新增
  scope-prompt.test.mjs    新增
  scope-api.test.mjs       新增
  scope-client.test.mjs    新增
package.json / README.md   改
```

分层原则：`scope.js` 只认 `kbRoot` 与纯数据，不依赖工具/HTTP；`scope-view.js` 无 node 依赖，可被客户端 bundle 打包；工具与 API 都调用 `scope.js`，不各自实现语义。

## 6. 数据模型：`.scopes.json`

路径：`<kbRoot>/.scopes.json`（`kbRoot` 先 `expandRoot`）。

```json
{
  "version": 1,
  "scopes": {
    "<sessionId>": {
      "mode": "selected",
      "kbs": ["标准", "变电试验"],
      "updatedAt": "2026-10-24T02:00:00.000Z",
      "inheritedFrom": null
    }
  }
}
```

规则：

- `mode`: `all | selected`；`selected` 且 `kbs: []` 视为 `all`。
- `kbs`：字符串数组，≤50；逐项 `sanitizeKbName`；去重保序；必须存在且未归档（`listKbs` 不含 `.trash/`）；`mergedInto != null` 的库剔除。
- `updatedAt`：ISO 时间；`inheritedFrom`：父 sessionId 或 `null`。
- 写入：临时文件（`<path>.<pid>.<ts>.tmp`）+ `rename` 原子替换，权限 `0600`；**按 kbRoot 的进程内串行队列**（模块级 `Map<root, Promise>`），并发 PUT 不互相覆盖。
- 读取：JSON 解析失败、结构非法、读取 EACCES → 按空库处理并保留原文件（不删）；单条条目结构非法跳过该条。
- 清理（惰性，仅读路径发现变化才回写）：`updatedAt` 超过 `scopeTtlDays`（默认 30）的条目删除；`kbs` 中已不存在/已归档/已合并的库名剔除；剔除后 `selected` 且空 → `all`。
- 归档/重命名同步：现有 `removeScopesReferences(root, name)` 只在**彻底删除归档库**（`purgeKb`）时调用，归档与重命名都没接。2B 把它迁移到 `lib/scope-store.js`（`removeScopeKb` / `renameScopeKb`），并在 `archiveKb`（归档）与 `renameKb`（重命名，`lib/store.js` 单一入口）补齐 best-effort 同步。
- 隐私：只含 sessionId 与库名，无对话内容。

## 7. 范围解析与继承

### 7.1 解析顺序

`resolveScope({ sessionId, parentSession })`：

1. `sessionId` 为空 → `{ mode: "all", kbs: [], inheritedFrom: null, stored: false }`。
2. 有显式条目 → 用它（清理规则已应用）。
3. 无条目且 `parentSession` 有显式条目 → **复制父的范围**写子条目（`inheritedFrom = parentSession`，`updatedAt = now`），返回复制结果。
4. 否则 → `all`（不写盘）。

- 父条目本身是继承来的：复制其**生效值**，`inheritedFrom` 写直接父 id（不追到更早）。
- 父范围后续变化不回溯（快照已落盘）。

### 7.2 同步只读视图（系统提示用）

- `systemPrompt.section` 的 `text` 是同步函数，因此提供 `readScopeSync(root)`：
  - `readFileSync` + mtime/1s 缓存；文件 >1MB、解析失败、结构非法 → 视为空（`all`）。
  - 只做内存内清理与父链解析（子无条目 → 父条目值，`inheritedFrom=parent`），**不写盘**。
- 工具与 API 使用异步 `resolveScope`（会落快照/清理回写）。
- 由此产生的语义细节：一个只聊天、从未调用 `kb_*` 工具的子会话，提示段会一直跟随父范围变化；首次工具调用落快照后才固化。这是“懒快照”的预期行为，README 记录。

### 7.3 身份缺失与降级

- `exec.agent?.session?.id` 缺失 → `mode=all`，不限制、不报错（决策 7）。
- `exec.agent.session.header.parentSession` 缺失 → 无继承。
- `.scopes.json` 不可写但可读：读照常；需要落快照时失败 → 仅记录一次 `console.warn`，本次按父范围生效（不阻塞工具调用）；显式 PUT 失败 → `SCOPE_WRITE_FAILED`。

## 8. 工具行为矩阵

公共入口（`lib/scope.js`）：

```js
resolveScopeTarget(exec, requestedKb, policy) -> { mode, kbs, kb?, sessionId, inheritedFrom }
// policy: "list" | "query" | "doc" | "single" | "std" | "lint" | "snapshot" | "export" | "kbAdmin"
resolveDocInScope(exec, requestedKb, docRef) -> { kb, doc }
```

`kb` 显式指定时一律先 `sanitizeKbName` 再校验在范围内，范围外抛 `ScopeError`（`code: "KB_OUT_OF_SCOPE"`）。`exec` 允许为 `undefined`（现有测试存在只传 args 的调用）：按 fail-open 处理，不限制。

| 工具 | `kb` 显式 | `kb` 省略 | policy |
|---|---|---|---|
| `kb_list` | — | 只列范围内库；输出加 `scope` | `list` |
| `kb_query` | 必须在范围内 | `selected`：范围内跨库检索；`all`：维持现状（`defaultKb`） | `query` |
| `kb_query` 的 `kb:"*"` | — | 等价范围内全部（`all` 时现状：全部库） | `query` |
| `kb_read` / `kb_view` / `kb_edit` / `kb_describe` / `kb_retitle` / `kb_trust` / `kb_keep` / `kb_history` / `kb_restore` / `kb_remove`(文档级) | 必须在范围内 | `selected`：**跨库 doc 解析**；1 个库或 0 个库 → 它/`defaultKb`；`all`：维持现状 | `doc` |
| `kb_edit_batch` | 必须在范围内 | 1 个库→用它；多个→报「请指定 kb」；0→`defaultKb` | `single` |
| `kb_add_note` | 必须在范围内 | 1 个库→用它；多个→报「请指定 kb」；0→`defaultKb` | `single` |
| `kb_import` / `kb_reparse` | 必须在范围内 | 1 个库→用它；多个→报「请指定 kb」；0→`defaultKb` | `single` |
| `kb_std_check` | 必须在范围内 | 默认「标准」（2B 顺手修正：原实现误用 `defaultKb`，与工具描述/M1 不一致）；该库必须在范围内 | `std` |
| `kb_lint` | 必须在范围内 | `selected`：范围内逐库跑（≤ `scopeLintMaxKbs`，默认 20，按库分组）；`all`：现状 | `lint` |
| `kb_snapshot` / `kb_export` | 必须在范围内 | 1 个库→用它；多个→报「请指定 kb」；0→`defaultKb` | `snapshot`/`export` |
| `kb_rename` / `kb_remove(removeKb=true)` | 必须显式且范围内 | 无默认，保持现有报错 | `kbAdmin` |

补充语义：

- `kb_list` 结果在最外层加 `scope: { mode, kbs }`；`kb_query` 输出加 `scope`（`searchedKbs` 保留）。两者 schema 为 additive 可选字段，旧断言不受影响。
- `kb_edit_batch` 与 `kb_add_note` 是**单库事务/单库笔记**，因此按 `single` 处理（偏离 M1 §6.4 把它们并入 doc 组的字面表述，理由：跨库事务不在本切片范围）。
- 虚拟文档（`doc` 为 `schema` / `index` / `log`，见 `VIRTUAL_DOCS`）也按 `single` 处理，不做跨库解析：这些是库级维护文件，必须落到确定的一个库。
- 范围外统一文案（M1 §6.4）：

```text
本会话的知识库范围是「标准、变电试验」，不包含「电能质量」。
如需使用，请在输入框旁的知识库选择器里调整范围。
```

- 范围为空（`selected` 且 `kbs=[]`）= `all`，不报错。
- `mode=all` 时所有工具保持现有行为（含 `defaultKb` 语义），只多一个 `scope` 输出字段。

## 9. 系统提示

- 新增独立段，不动现有 order 106 的长提示：

```js
ctx.systemPrompt.section({
  name: "kb:scope",
  order: 120,
  text: (context) => {
    try {
      const session = context?.agent?.session;
      if (session?.id === undefined) return "";
      const scope = readScopeSync(kbRoot, session.id, session.header?.parentSession);
      if (scope.mode !== "selected" || scope.kbs.length === 0) return "";
      const names = scope.kbs.slice(0, 20).join("、");
      const suffix = scope.kbs.length > 20 ? ` 等 ${scope.kbs.length} 个` : "";
      return `[知识库范围] 本会话用户选定：${names}${suffix}。kb_* 工具只能访问这些库；范围外资料不要读取或检索。用户要求其他库时，提示其使用输入框旁的知识库选择器切换。`;
    } catch {
      return "";
    }
  },
});
```

- `all` 返回 `""`（不注入）；任何异常返回 `""`，绝不让提示组装失败。
- 文本逐字稳定（范围不变时）→ 不影响 prompt 前缀缓存；切换范围会改写首个 system 节点一次，缓存从该点失效（可接受，README 记录）。

## 10. HTTP API

### 10.1 `GET /kb/api/scope?session=<id>`

- 校验 `session`（1–200 字符、无控制字符）→ 否则 `SCOPE_INVALID` 400。
- 不创建继承快照；允许清理回写（超 TTL 条目、失效库名，可能因此删改文件里的任意条目），但不把请求会话“提升”为显式条目。
- 响应：

```json
{
  "scope": { "mode": "selected", "kbs": ["标准"], "inheritedFrom": null },
  "resolved": [ { "name": "标准", "docs": 935, "empty": false } ],
  "updatedAt": "2026-10-24T02:00:00.000Z"
}
```

- `resolved` 来自 `listKbs`：每项 `{ name, docs: <文档总数>, empty: <docs===0> }`；`mode=all` 时 `resolved` 为空数组。
- 胶囊的复选列表与“空库徽标”用 `/kb/api/kbs`（其 `docs` 是 `{total, ready, importing, failed, deleted, notes}`、`status` 有 `empty`）；`resolved` 只是当前范围的便捷视图。

### 10.2 `PUT /kb/api/scope`

- 请求体：`{ "session": "…", "mode": "selected", "kbs": ["标准", "变电试验"] }`。
- 非 GET → 已有中间件 `requireUiHeader`（`x-kb-ui: 1`）+ `assertSameOrigin`；不满足 403。
- 校验：`mode` 非法 → `SCOPE_INVALID` 400；`kbs` 含不存在 → `KB_NOT_FOUND` 404；含已归档/已合并 → `KB_ARCHIVED` 409；写失败 → `SCOPE_WRITE_FAILED` 500。
- 响应同 GET；`mode=all` 时忽略并清空 `kbs`。
- 服务端不做「全选→all」规范化：胶囊在“全选”时直接提交 `mode=all`（以后新增库自动包含）。

### 10.3 `/kb/api/status`

`features` 增加 `scope: true`；其余字段不变。

## 11. 错误码

| code | HTTP | 场景 | 提示 |
|---|---|---|---|
| `SCOPE_INVALID` | 400 | session/mode/kbs 形状非法 | 会话或范围参数无效 |
| `KB_NOT_FOUND` | 404 | kbs 含不存在库 | 知识库不存在: X |
| `KB_ARCHIVED` | 409 | kbs 含已归档/已合并库 | 知识库已归档: X |
| `SCOPE_WRITE_FAILED` | 500 | `.scopes.json` 写入失败 | 范围保存失败，请重试 |
| `KB_OUT_OF_SCOPE` | —（工具） | 工具访问范围外库 | M1 §6.4 文案 |
| `KB_REQUIRED` | —（工具） | 范围有多个库而工具是单库语义（import/add_note/edit_batch/snapshot/export、虚拟文档、库级管理），省略 `kb` | 本会话范围有 N 个知识库，请用 kb 参数指定一个：… |
| `KB_AMBIGUOUS` | —（工具） | 跨库 doc 解析命中多个 | 列出候选（kb/docId/标题）+ 请指定 kb |

`ScopeError` 属性：`code`、`message`、`details`（如 `{ scope: [...], requested: "电能质量" }`），工具直接抛出（DSH 以工具失败展示 message）。

## 12. 胶囊 UI

### 12.1 组件与注册

- `src/client/index.tsx`：
  - `WorkbenchModal`：从现有 `KbWorkbenchAction` 抽出的 portal 弹窗（`iframe src="/kb/?embed=1"`、×/Esc/遮罩关闭、打开时锁 body 滚动）。侧栏入口与胶囊各持自己的 `open` 状态，共用该组件。
  - `KbScopeCapsule`：注册到 `conversation.input.left`，`{ name, id: "kb-scope", order: 20 }`。
  - 侧栏 `sidebar.footer.action` 注册保持不变（id `kb-workbench`）。
- 客户端 bundle 只 require `react` / `react-dom`（仍 external）；`package.json` 的 `dsh.client.inject` 保持现状（`@deepseek-ai/dsh-client-ui-sidebar`），`ctx.slots.inject` 会等待目标 slot 出现，无需新增宿主包依赖。

### 12.2 收起态

- 尺寸对齐 24px 工具行：14px 图标 + 12px 文本，`max-width` 限宽省略。
- 文案：`知识库：全部` / `知识库：N 个`（`selected` 用强调色）/ 加载中 `知识库：…` / 失败 `知识库：—`（点击即重试）。
- 无 API（`/kb/api/status.features.scope` 不为 `true`，或 `/kb/api/status` 404/网络失败）→ **不渲染**（静默降级）。
- `aria-expanded`、`title` 提示。

### 12.3 展开态

- portal 到 `document.body`；按 chip `getBoundingClientRect()` 定位（resize/scroll 重算；拿不到 rect 时居中兜底），宽度约 320px、最大高度 420px、列表滚动。
- 内容：
  - 标题「本会话使用哪些知识库？」。
  - 搜索框（按名称/简介过滤，输入即过滤）。
  - 库列表：复选框 + 名称 + 文档数 + 空库徽标；不显示已归档/已合并库。
  - 快捷：`全选` / `清空`。
  - 底部：`应用` / `取消` / `打开知识库工作台`（打开 `WorkbenchModal`）。
- 列表里没有任何可用库时：显示「暂无知识库」+「去工作台新建」。
- 应用：
  - `全选` → 提交 `mode: "all"`；`清空` → 提交 `mode: "all"`（M1：`selected`+空视为 all）。
  - 其余 → `mode: "selected"` + 勾选列表。
  - 成功：面板内轻量 toast（自绘，2.4s 消失，不依赖宿主 API）「已限定为 N 个知识库」/「已改为全部知识库」；关闭面板；chip 更新。
  - 失败：面板保留、toast 报错、chip 不变（等价回滚）。
  - `取消`：丢弃本地勾选并关闭。
- 数据：打开面板时并行 GET `/kb/api/scope` 与 `/kb/api/kbs`；防重复请求（同一时刻只保留一次在途请求）；`PUT` 期间按钮禁用。
- 请求一律用**同源相对路径**（`/kb/api/...`）：桌面端页面由插件所在 webServer 提供（Slice 1.5 已用同源 iframe 验证），不要写死 `dsh-app://` 或绝对主机；PUT 带 `x-kb-ui: 1`。
- 无障碍：面板 `role="dialog"`、Esc 关闭、打开时聚焦搜索框。

## 13. 安全、并发、降级

- 复用 `isTrustedApiRequest` / `assertSameOrigin` / `requireUiHeader`；响应不返回 `bzCookie`，也不返回 `.scopes.json` 原文（只回库名与计数）。
- `.scopes.json` 权限 `0600`、原子写、串行队列；读无锁（原子替换保证读到完整 JSON）。
- **范围不是权限边界**：sessionId 由客户端提供、不做身份认证；用户始终可以用胶囊改范围；工作台 HTTP API/UI 不受范围影响（M1 §7.9）。README 明确。
- 降级顺序：无 `webServer` → 无 API（胶囊不渲染，工具/提示照常）；`features.scope` 缺失 → 胶囊不渲染；scope 文件损坏 → 读按 `all`、写报错；`exec.agent` 缺失 → fail-open。
- 同步读文件在提示组装路径上：文件小、1s 缓存、>1MB 忽略；损坏绝不抛错。

## 14. 配置

新增两个配置项（`lib/index.js` 的 `Config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `scopeTtlDays` | `30` | 范围条目过期天数；0 表示不过期 |
| `scopeLintMaxKbs` | `20` | `kb_lint` 在 `selected` 模式下最多跑多少个库 |

## 15. 测试计划

### 15.1 自动化（`node:test`，计划细化到新增 89 例；基线 312 → 401 全绿）

- `scope-store.test.mjs`：结构校验（sessionId/mode/kbs/50 上限/去重）、TTL 清理、缺失与归档/合并库剔除、损坏文件、原子写、串行并发、`0600`、清理回写只在变化时发生。
- `scope-inherit.test.mjs`：子会话快照 + `inheritedFrom`；父无条目 → all；父变化不回溯；孙链复制生效值；GET 不落快照；写失败降级为父范围。
- `scope-tools.test.mjs`：表驱动矩阵——每个 policy 选代表工具测「显式内/显式外/省略 0 库/省略 1 库/省略多库」；`kb_query` 的 `*`；跨库 doc 单命中/多候选/0 命中；`kb_list` 过滤 + `scope` 字段；`kb_lint` 循环分组；`kb_std_check` 标准不在范围；`kb_remove(removeKb=true)`；`kb_edit_batch` 单库事务；`mode=all` 回归（现有行为不变）。
- `scope-prompt.test.mjs`：selected/all/空/损坏/无 session/子继承/写完刷新/缓存 TTL/超 20 个库名截断；函数永不抛错。
- `scope-api.test.mjs`：GET/PUT 正常、非法 session、非法 mode、缺 `x-kb-ui`、跨源拒绝、`features.scope`、写失败、归档库、`mode=all` 忽略 kbs。
- `scope-sync.test.mjs`：`kb_rename` 工具与 `PATCH /kbs/:name` 两个调用点都同步 `.scopes.json`；`archiveKb` / `purgeKb` 剔除库名。
- `scope-client.test.mjs`：VM 加载 `lib/client.js`，断言同时注册 `sidebar.footer.action` 与 `conversation.input.left`；`lib/scope-view.js` 纯函数单测（chipLabel/selectionPayload/isAllSelection）；`check:client` 产物不漂移。
- 现有 312 个用例全绿：除 `test/client-entry.test.mjs` 需要扩展注册断言（新增 `conversation.input.left`）外，其余断言不变（`mode=all` 行为与 0.20.4 一致；fake exec 无 session.id 走 fail-open）。

### 15.2 真实宿主验收（沿用 spike 手法）

- 临时 `dsh --profile web --port <port>` + 临时 `kbRoot` + 真实插件（探针式插入 profile，结束还原）。
- WKWebView 流程：chip「全部」→ 开面板 → 勾选 1 库 → 应用 → toast + chip「1 个」→ 重新打开面板勾选状态保持 → 读 `.scopes.json` 断言 →「打开知识库工作台」弹窗可开可关。
- 失败注入：`.scopes.json` 所在目录只读 → 应用报错且 chip 不变；禁用 `webServer` → 胶囊不渲染。
- 桌面端重启后人工清单：chip 可见；切换范围后一轮对话里 `kb_list` 只返回范围内库；范围外 `kb_query` 收到 `KB_OUT_OF_SCOPE`；子代理（`subagent`）继承。

## 16. 验收标准

1. `npm test`（含 `check:client`、`check-ui`）、`npm run typecheck` 全绿；新增用例 ≥40。
2. `GET/PUT /kb/api/scope` 按第 10 节工作；`/status.features.scope === true`。
3. 21 个工具按第 8 节矩阵执行，范围外报 `KB_OUT_OF_SCOPE`；`mode=all` 行为与 0.20.4 一致。
4. 子会话继承父范围并落快照；父范围后续变化不影响子会话。
5. 系统提示仅 `selected` 注入；范围变化后下一轮生效。
6. 胶囊在真实宿主可用，三类降级符合第 12 节；「打开工作台」打开 DSH 内弹窗。
7. 工作台 API/UI 不受范围影响；README 记录“范围不是权限边界”。
8. 版本 0.21.0（`package.json` 与 `lib/version.js` 同步）。

## 17. 实施顺序（概要，plan 再细化）

1. `lib/scope.js` + `lib/scope-view.js` + store/inherit 测试。
2. 工具接入（21 个）+ 矩阵测试；先 `kb_list`/`kb_query` 后 doc 组与单库组。
3. 系统提示段 + 测试。
4. `/kb/api/scope` + status + API 测试。
5. 归档/重命名同步补齐 + 测试。
6. 客户端：抽 `WorkbenchModal`、胶囊、样式、bundle 测试。
7. 真实宿主验收 + 桌面端清单；README、版本 0.21.0。

## 18. 风险与已知限制

- **前缀缓存**：切换范围会改写首个 system 节点一次；范围不变时无影响。
- **同步文件读**：提示组装路径上的同步读；1s 缓存 + 1MB 上限，损坏降级 `all`。
- **身份缺失 fail-open**：无 session id 的调用不受限制（测试与非常规宿主路径）。
- **`kb_edit_batch`/`kb_add_note` 单库策略**：偏离 M1 字面表述，已在第 8 节记录。
- **`conversation.session.header.utilities` 未实现**：首页没有会话头部，`input.left` 覆盖主场景；若未来某些视图没有 composer，胶囊不出现（可后续补 header 注册）。
- **服务端不认证 sessionId**：范围是产品约束，不是安全边界。
- **CLI 0.1.1 与桌面 0.2.1 的差异**：`agent/created` 的 `source` 字段在 0.1.1 实测缺失；本设计不依赖该字段。

## 19. 与 2A 的衔接

- 复用 2A 的 `/kb/api/*` 路由分发、错误包装（`WebError`/`mapError`）、静态资源与工作台 UI；不新增任务类型。
- 复用 2A 的临时宿主 + WKWebView 验收手法（`.acceptance/`）。
- 2A 交接项（2A design §14）四项全部落实：slot（结论 1）、session 事件（结论 2）、父会话字段（结论 3）、工具公共入口（结论 4 + 第 8 节）。
