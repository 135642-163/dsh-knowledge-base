# 知识库工作台 Slice 2B 设计：会话范围 + 胶囊 + 工具硬约束

> 状态：已与用户逐项确认（2026-10-24），待 spec review。
> 基线：`dsh-knowledge-wiki` 0.20.4，`npm test` 312/312，`git 8af72cf`。
> 关联：`2026-10-24-kb-workbench-slice2-brief.md`（范围与交接）、`2026-10-24-kb-workbench-slice2a-design.md` §14（2B 待验证项）、`2026-10-23-kb-workbench-design.md` §6（胶囊与范围）、`2026-10-24-kb-workbench-sidebar-entry-design.md`（客户端 bundle/弹窗模式）。
> 本文所有“已实测”结论来自第 4 节的宿主 spike，证据可复现。
>
> **0.22.0 更新（2026-10-24）**：空选择语义改为「未启用」（`mode:"none"`，破坏性变更），并补齐资料
> 分页/搜索、原件预览、笔记/徽标/重命名与临时文件过滤；详见 **§21**。§2.1/§6/§7/§8/§10.2/§12.3/§15 中
> 旧的「`selected` + 空 = `all`」规则已就地更正。

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
- `.scopes.json` v1：`mode: all|selected|none`（0.22.0 起新增 `none`，见 §21.1）、TTL 惰性清理、原子写、串行队列、重命名/归档同步。
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
| 2 | 工具接入 | **一次性全接 21 个工具**，公共 `resolveExecScope`/`resolveSingleKb`/`resolveDocTarget`/`assertInScope` 收口，表驱动测试 |
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
  scope-store.js    新增：.scopes.json 文件层（原子读写/串行队列/mtime+size 同步视图/库名同步）
  scope.js          新增：校验/清理/继承/解析/ScopeError（工具与 API 共用）
  scope-view.js     新增：纯函数（chipLabel/selectionPayload/mergeSelection）
  index.js          改：21 工具接入 + 动态提示段 + config scopeTtlDays/scopeLintMaxKbs
  dedup.js          改：导入查重限定在会话范围内（kbNames 白名单，null = 全部）
  kbmeta.js         改：archiveKb/purgeKb 剔除库名（复用 removeScopeKb）
  store.js          改：renameKb 说明（.scopes.json 同步由工具与 HTTP 两个入口负责）
  version.js        改：0.21.0
  web/api.js        改：GET/PUT /kb/api/scope；features.scope
  web/http.js       不改（复用 requireUiHeader/assertSameOrigin/isTrustedApiRequest）
src/client/index.tsx  改：抽 WorkbenchModal + 注册胶囊
lib/client.js         改：构建产物（esbuild）
test/
  scope-store.test.mjs     新增
  scope.test.mjs           新增（存储语义 + 继承 + 入口解析）
  scope-tools.test.mjs     新增
  scope-prompt.test.mjs    新增
  scope-api.test.mjs       新增
  scope-sync.test.mjs      新增（Task 10）
  scope-view.test.mjs      新增
  scope-client.test.mjs    新增（Task 12：effect-running VM）
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

- `mode`: `all | selected | none`（0.22.0 起，见 §21.1）。**只有显式 `all` 表示全部库**；
  `selected` 且 `kbs: []` 归一化为 `none`（= 本会话未启用知识库），不再视为 `all`；
  未知/缺失 `mode` 的条目按 `none` 处理（fail closed）。
- `kbs`：字符串数组，≤50；逐项 `sanitizeKbName`；去重保序；必须存在且未归档（`listKbs` 不含 `.trash/`）；`mergedInto != null` 的库剔除。
- `updatedAt`：ISO 时间；`inheritedFrom`：父 sessionId 或 `null`。
- 写入：临时文件（`<path>.<pid>.<ts>.tmp`）+ `rename` 原子替换，权限 `0600`；**按 kbRoot 的进程内串行队列**（模块级 `Map<root, Promise>`），并发 PUT 不互相覆盖。
- 读取：JSON 解析失败、结构非法、读取 EACCES → 按空库处理并保留原文件（不删）；单条条目结构非法跳过该条。
- 清理（惰性，仅读路径发现变化才回写）：**只有 `selected` 条目**在 `updatedAt` 超过 `scopeTtlDays`（默认 30）时删除；`none`/`all` 条目不做 TTL 清理（`none` 是显式关闭，过期删除会静默退回 `all`；`all` 过期后解析结果不变）。`kbs` 中已不存在/已归档/已合并的库名剔除；剔除后 `selected` 且空 → `none`（0.22.0 起；0.21.x 曾回退 `all`）。
- 归档/重命名同步：现有 `removeScopesReferences(root, name)` 只在**彻底删除归档库**（`purgeKb`）时调用，归档与重命名都没接。2B 把它迁移到 `lib/scope-store.js`（`removeScopeKb` / `renameScopeKb`）：`archiveKb` / `purgeKb` 内 best-effort 剔除库名；重命名由 `kb_rename` 工具与 `PATCH /kbs/:name` 两个入口在 `renameKb` 之后调用 `renameScopeKb`（`lib/store.js` 的 `renameKb` 保持纯目录操作）。
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
- 归一化只在 `selected` 且 `kbs` 非空时成立：`selected` + 空 `kbs` 解析为 `none`（0.22.0 起，见 §21.1），
  与「`sessionId` 为空 → `all`」的 fail-open 是两件事，后者保持不变。

### 7.2 同步只读视图（系统提示用）

- `systemPrompt.section` 的 `text` 是同步函数，因此提供 `readScopeSync(root)`：
  - `readFileSync` + **mtime+size 缓存**（同一路径且 mtime/size 未变时复用；写入成功后主动失效）；
    文件 >1MB、解析失败、结构非法或不可读 → 视为空（`all`）。
  - 返回的视图被**冻结**（顶层、每个条目与 `kbs` 数组都 `Object.freeze`），调用方不能改坏缓存。
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
resolveExecScope(exec, { kbRoot, ttlDays }) -> { mode, kbs, inheritedFrom, stored }
resolveSingleKb(exec, requestedKb, { kbRoot, defaultKb, ttlDays }, { policy }) -> { scope, kb }
// policy: "single"（默认）| "std"（默认「标准」）| "kbAdmin"（同 single，要求显式 kb）
resolveDocTarget(exec, requestedKb, docRef, { kbRoot, defaultKb, ttlDays, includeDeleted }) -> { scope, kb, doc? }
assertInScope(scope, name) -> name（范围外抛 ScopeError）
// kb_list / kb_query / kb_lint 用 resolveExecScope + assertInScope 自行处理多库分支
```

`kb` 显式指定时一律先 `sanitizeKbName` 再校验在范围内，范围外抛 `ScopeError`（`code: "KB_OUT_OF_SCOPE"`）。`exec` 允许为 `undefined`（现有测试存在只传 args 的调用）：按 fail-open 处理，不限制。

`resolveDocTarget` 的 `includeDeleted=true` 供 `kb_restore` / `kb_history` / `kb_remove(soft=false)` 使用：跨库解析时连软删除文档一起扫描，否则恢复/查看历史的入口会先报“范围内找不到”。其它 doc 类工具保持 `false`。

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

- 范围为空（`selected` 且 `kbs=[]`）→ 归一化为 `none`：21 个工具统一报 `KB_DISABLED`，不再等价 `all`
  （0.22.0 起，见 §21.1；0.21.x 曾按「空范围 = all，不报错」处理）。
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
- `parentSession` 从**活的 agent 注册表**解析（`ctx.get("agents")` 取该会话 header 的 `parentSession`，取不到按 `null`），因此继承来的父范围无需落快照即可在响应里看到。
- `updatedAt` 只在请求会话**自己有条目**时返回（继承视图返回 `null`）。
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
- 响应同 GET；`mode=all` 或 `mode=none` 时忽略并清空 `kbs`（0.22.0 起接受 `none`，见 §21.1）。
- 服务端不做「全选→all」规范化：胶囊在“全选”时直接提交 `mode=all`（以后新增库自动包含）；
  空 `selected` 落盘成 `none`，不再回退 `all`。

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

`KB_REQUIRED` 与 `KB_AMBIGUOUS` 是**工具专用**错误码（HTTP API 不会产生）；`KB_NOT_FOUND` 在工具里也用于“范围内跨库解析 0 命中”。**5xx 响应永不携带 `details`**（`mapError` 对 `status >= 500` 剥离），只有 4xx 才回传 `details`，避免内部路径、库名列表等被回传给浏览器。

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
- 展开态才输出 `aria-expanded="true"`（只按面板**真正挂载**计算，加载中/未挂载不声明）；`title` 提示。

### 12.3 展开态

- portal 到 `document.body`；按 chip `getBoundingClientRect()` 定位（resize/scroll 重算；拿不到 rect 时屏幕居中兜底）。**空间自适应**：优先在胶囊上方展开；上方不足约 240px（胶囊贴近视口顶部）时改为下方展开，两个方向都按可用空间动态限制 `max-height`（上限 420px）。宽度约 320px、列表滚动。
- 内容：
  - 标题「本会话使用哪些知识库？」。
  - 搜索框（按名称/简介过滤，输入即过滤）。
  - 库列表：复选框 + 名称 + 文档数 + 空库徽标；不显示已归档/已合并库。打开面板时按当前范围预置勾选：`all` 模式**全部勾选**（收窄靠取消勾选），`selected` 模式只勾选范围内库。
  - 快捷：`全选` / `清空`。
  - 底部：`应用` / `取消` / `打开知识库工作台`（打开 `WorkbenchModal`）。
- 列表里没有任何可用库时：显示「暂无知识库」+「去工作台新建」。
- 应用：
  - `全选` → 提交 `mode: "all"`；`清空` → 提交 `mode: "none"`（0.22.0 起；0.21.x 曾按 M1「`selected` + 空视为 all」提交 `all`，见 §21.1）。
  - 其余 → `mode: "selected"` + 勾选列表。
  - 成功：toast（自绘，portal 到 `document.body`，底部居中，`role="status"` + `aria-live="polite"`，2.4s 消失，不依赖宿主 API）「已限定为 N 个知识库」/「已改为全部知识库」；关闭面板；chip 更新。
  - 失败：面板保留、同一 toast 报错、chip 不变（等价回滚）。
  - `取消`：丢弃本地勾选并关闭。
- 数据：打开面板时并行 GET `/kb/api/scope` 与 `/kb/api/kbs`；防重复请求（同一时刻只保留一次在途请求）；`PUT` 期间按钮禁用。
- 请求一律用**同源相对路径**（`/kb/api/...`）：桌面端页面由插件所在 webServer 提供（Slice 1.5 已用同源 iframe 验证），不要写死 `dsh-app://` 或绝对主机；PUT 带 `x-kb-ui: 1`。
- 无障碍：面板 `role="dialog"`、Esc 关闭、打开时聚焦搜索框。

## 13. 安全、并发、降级

- 复用 `isTrustedApiRequest` / `assertSameOrigin` / `requireUiHeader`；响应不返回 `bzCookie`，也不返回 `.scopes.json` 原文（只回库名与计数）。
- `.scopes.json` 权限 `0600`、原子写、串行队列；读无锁（原子替换保证读到完整 JSON）。
- **范围不是权限边界**：sessionId 由客户端提供、不做身份认证；用户始终可以用胶囊改范围；工作台 HTTP API/UI 不受范围影响（M1 §7.9）。README 明确。
- 降级顺序：无 `webServer` → 无 API（胶囊不渲染，工具/提示照常）；`features.scope` 缺失 → 胶囊不渲染；scope 文件损坏 → 读按 `all`、写报错；`exec.agent` 缺失 → fail-open。
- 同步读文件在提示组装路径上：文件小、mtime+size 缓存、>1MB 忽略；损坏绝不抛错。

## 14. 配置

新增两个配置项（`lib/index.js` 的 `Config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `scopeTtlDays` | `30` | 范围条目过期天数；0 表示不过期 |
| `scopeLintMaxKbs` | `20` | `kb_lint` 在 `selected` 模式下最多跑多少个库 |

## 15. 测试计划

### 15.1 自动化（`node:test`；0.21.0 新增 188 例，312 → **500**；0.21.1 复审后 **508**；0.22.0 **620**；0.23.0 **733**；0.24.0 **768**——见 §15.3–§15.5 与 §21.8、§22.7、§23.4）

- `scope-store.test.mjs`（17）：**文件层**——缺失文件读空、原子写 + `0600`、进程内串行队列（20 并发）、mutator 返回 falsy 时不写盘、同步视图 mtime+size 缓存与冻结视图、损坏/超限文件（读空、拒写 `SCOPE_UNUSABLE`）、清理回写只在变化时发生、`removeScopeKb`/`renameScopeKb` 库名同步、未知条目字段保留。sessionId 校验、mode/kbs 结构校验、50 上限、TTL 过期与失效库 prune、归档/合并判定由 `scope.test.mjs` / `scope-api.test.mjs` 覆盖。
- `scope.test.mjs`（37）：条目归一化/50 上限/非法 sessionId、子会话快照 + `inheritedFrom`、父无条目 → all、父变化不回溯、只读解析（GET）不落快照、写失败降级为只读解析、`setScope` 严格校验（不存在/归档/合并）、`resolveSingleKb`/`resolveDocTarget` 单测（含软删除与虚拟文档）。
- `scope-tools.test.mjs`（52）：表驱动矩阵——每个 policy 选代表工具测「显式内/显式外/省略 0 库/省略 1 库/省略多库」；`kb_query` 的 `*`；跨库 doc 单命中/多候选/0 命中；`kb_restore`/`kb_history`/永久删除解析软删除文档；`kb_list` 过滤 + `scope` 字段；`kb_lint` 逐库分组与 `truncated`/`omittedKbs`；`kb_std_check` 默认「标准」与范围外；`kb_remove(removeKb=true)`；`kb_edit_batch` 单库事务；`mode=all` 回归（现有行为不变）。
- `scope-prompt.test.mjs`（10）：selected/all/空/损坏/无 session/子继承/写完刷新/同步视图缓存（mtime+size）/超 20 个库名截断；函数永不抛错。
- `scope-api.test.mjs`（19）：GET/PUT 正常、非法 session、非法 mode、缺 `x-kb-ui`、跨源拒绝、`features.scope`、写失败、归档库、`mode=all` 忽略 kbs、GET 从 live agent 注册表解析父会话且不落快照、`updatedAt` 为空。
- `scope-sync.test.mjs`（6）：`kb_rename` 工具与 `PATCH /kbs/:name` 两个调用点都同步 `.scopes.json`；`archiveKb` / `purgeKb` 剔除库名（含名字被现存库复用的情况）。
- `scope-view.test.mjs`（7）：`lib/scope-view.js` 纯函数（chipLabel/selectionPayload/isAllSelection/mergeSelection）。
- `scope-client.test.mjs`（40）：effect-running VM 加载 `lib/client.js`（替代原计划的非 effect stub），断言注册 `conversation.input.left`、chip 状态/面板空间自适应/勾选与提交/失败回滚/`aria-expanded`。产物与源码同步由**独立门禁** `npm run check:client` 校验，不属于本套件的用例数。
- 现有 312 个用例全绿：除 `test/client-entry.test.mjs` 需要扩展注册断言（新增 `conversation.input.left`）外，其余断言不变（`mode=all` 行为与 0.20.4 一致；fake exec 无 session.id 走 fail-open）。

### 15.2 真实宿主验收（2026-10-24 已完成，记录见 §20）

- 临时 `dsh --profile web --port 55940` + 临时 `kbRoot /tmp/kb-2b-accept/kb-root` + 真实插件（探针式插入 profile，结束已还原）。
- WKWebView 实测：chip「知识库：全部」→ 开面板（2 个库）→ 清空并勾选「验收甲库」→ 应用 → chip「知识库：1 个」+ toast 可见；重开面板勾选保持；「打开知识库工作台」弹窗可开可关。
- 失败注入：`.scopes.json` 只读 → toast「范围保存失败，请重试」、chip 不变、面板保留。
- 真实模型轮次里让模型调用 `kb_list`：只返回「验收甲库」，「验收乙库」不出现。
- 降级：没有 `webServer` 时胶囊不渲染（由 `features.scope` / status 探测决定）。

### 15.3 0.22.0 新增与变更用例（`npm test` 620/620）

- 0.21.1（`e3b5ad8`）基线 **508**；0.22.0 净增 **112** 例（原有文件 +24，新文件 +80，复审跟进 +8）。
- 新增文件：
  - `web-preview.test.mjs`（27）：`source?inline=1` 白名单/响应头/路径穿越、HTML/SVG 415、
    `preview.pdf` 引擎缺失 501、非 Office 415、转换一次后命中缓存、并发合并、失败 500 不带路径、
    `/content` 笔记/文本/截断/415、缓存路径与旧缓存清理、`resolveOfficeCli` 探测顺序。
  - `ui-preview.test.mjs`（8）：预览 URL、`previewKindFor` 类型判定、PDF/Office/图片/文本/笔记正文渲染与转义、
    失败与未知格式的下载兜底、重命名输入校验。
  - `ui-docs.test.mjs`（19）：工具栏/顶底分页/页码收敛/每页条数/空态/搜索中/状态筛选/笔记 tab/
    `statusBadges`/页头重命名入口。
  - `ui-docs-controls.test.mjs`（10）：防抖合并、IME 组合、Enter、每页条数、跳页收敛、清除、`detach`、
    请求门与旧响应丢弃。
  - `web-docs-search.test.mjs`（4）：标题/摘要/标签命中、大小写、与状态/可信度/类型过滤及分页共存。
  - `temp-files.test.mjs`（12）：`~$*` / `.~lock.*` / 系统垃圾文件识别、大小写、basename、目录收集跳过计数、
    上传校验与批次排除、`kb_lint` 分组、`kb_import` 报告数量。
- 变更文件（0.21.1 → 0.22.0）：`scope.test.mjs` 39 → 47、`scope-tools.test.mjs` 54 → 55、
  `scope-api.test.mjs` 20 → 24、`scope-prompt.test.mjs` 10 → 12、`scope-sync.test.mjs` 7 → 8、
  `scope-view.test.mjs` 7 → 9、`scope-client.test.mjs` 41 → 46、`ui-api.test.mjs` 9 → 10。
- 0.22.0 复审跟进（2026-10-24，+8 例）：`scope.test.mjs` 47 → 51（`none` 免 TTL 三例 + 同步视图一例）、
  `ui-preview.test.mjs` 8 → 9（笔记错误分支不渲染下载入口）、`ui-docs.test.mjs` 19 → 20
  （笔记超过返回上限的提示）、`web-api-read.test.mjs` 6 → 7（`findSource` 只认普通文件）、
  `web-http.test.mjs` 5 → 6（`serveFile` 读流错误销毁响应）。
- 全部用例使用临时目录，不依赖本机知识库；`check:client` / `check-ui` 为独立门禁，不计入用例数。

### 15.4 0.23.0 新增与变更用例（`npm test` 733/733）

- 0.22.0（`afe344d`）基线 **620**；0.23.0 净增 **110** 例：新增文件 88 例，现有文件 +22 例
  （含发布前终审补的 8 例）。
- 新增文件：
  - `web-docs-lifecycle.test.mjs`（11）：delete 默认软删、`permanent` 需 `confirm` 精确匹配标题（400）且只能在回收站发起（409 `DOC_NOT_DELETED`）、导入中软删 409、31 分钟卡死导入可用永久删逃生口、不存在 404；默认重试实现失败只报「重试失败：<标题>」；restore 回到 `deletedFromStatus`（failed 保持 failed）；reparse 仅 failed（409）、原件缺失 409、202 + `kb-reparse` 任务；列表/详情 `error`/`sourceFile`/`errorAt`/`movedTo` 投影；POST 的 `x-kb-ui` 与同源校验。
  - `transfer.test.mjs`（19）：预检去重/大小/三类冲突；同库、不存在、已合并目标、非 ready/已删除、原件缺失拒绝；`MAX_MOVE_DOCS=50` 与 `MAX_MOVE_BYTES=500 MB` 上限；move 复制文件、写目标清单、软删源文档且保留文件；skip 默认（两边不动）与 rename（标题/同 ID 让路、同内容仍跳过）；单篇失败不影响批次；undo 恢复源库并软删目标副本、目标副本被 edited/version 改过或状态变化时拒绝；commit-skip 不删既有目标文件、mounted 清理语义；sweep 处理「目标已提交/未提交/伪造 transferId/损坏 journal/越界路径」与预检前清理。
  - `web-docs-move.test.mjs`（4）：preflight/move/undo 三条路由的往返；`TransferError` → 404/409/413 映射；50 篇上限的 HTTP 413；POST 的 `x-kb-ui` 与同源校验且不回传 `kbRoot`。
  - `ui-docs-actions.test.mjs`（26）：仅 ready/failed 可勾选、全选/补齐/取消、已删除行无复选框、工具条三操作与 busy 禁用、`已删除` 筛选与空状态、行内操作矩阵（失败=重试+移除、就绪=移除、已删除=恢复/撤销移动+彻底删除）、彻底删除逐字比较与空标题拒绝、冲突分组、移动确认状态、切换目标重置确认、预检摘要、结果分组与转义、失败弹窗 error/warnings/重试、`waitForJob` 轮询/立即结算/超时 `REPARSE_TIMEOUT`、`retryFailedDoc` 通知与缺 jobId。
  - `ui-overview.test.mjs`（12）：每卡只有一条类型条、不再有可信度比例条；分段只为非零类型、宽度合计 100%；低饱和配色与未知类型回落；类型条 title/aria-label；可信度圆点只渲染非零项、颜色与完整 title；全零不占位；空库占位条；名称转义与样式约定。
  - `office-install.test.mjs`（16）：平台→引擎包映射与未知平台；安装目录默认 `~/.dsh/tools/libreoffice-kit` 与 `DSH_OFFICE_KIT_HOME`；工具链探测（DSH 自带 pnpm → `DSH_PNPM` → PATH）；`buildInstallPlan` 锁定 `0.2.2`；写 package.json + `add --ignore-scripts` + `capabilities` 校验；缺包管理器/非零退出/超时杀进程组/校验失败的错误码与固定文案；并发单飞；状态缓存 5 秒与 `running`；`DSH_OFFICE_KIT_HOME` 影响 `resolveOfficeCli`/status。
  - `web-office-api.test.mjs`（8）：`GET /office/status` 注入状态；`POST /office/install` 必须显式 `confirm`；202 + `office-install` 任务成功/失败；已安装短路 200 `alreadyInstalled`；并发安装 409；缺 Node/npm 409；UI 头与同源校验。
- 变更文件：
  - `soft-delete.test.mjs` 2 → 3：failed 文档可软删除，恢复后保持 failed。
  - `ui-api.test.mjs` 10 → 11：新增 `deleteDoc` / `restoreDoc` / `reparseDoc` / `movePreflight` / `moveDocs` / `undoMove` / `officeStatus` / `installOffice` 的请求形状。
  - `ui-preview.test.mjs` 9 → 21：Office 安装态渲染（同意勾选解锁、已安装、进度、失败重试、缺工具链）、安装轮询/超时/完成后重载预览、状态查询失败兜底。
  - `ui-docs.test.mjs` 20（用例数不变）：断言随新行内操作/状态筛选更新。
- 全部用例使用临时目录，不依赖本机知识库；`check:client` / `check-ui` 为独立门禁，不计入用例数。

### 15.5 0.24.0 新增与变更用例（`npm test` 768/768）

- 0.23.0（`474b40d`）基线 **733**；0.24.0 净增 **35** 例：新增文件 32 例，现有文件 +3 例。
- 新增文件：
  - `web-trash-docs.test.mjs`（10）：`GET /trash/docs` 只列活跃非合并库（归档/合并/在用各一例）、
    字段投影与空值归一、`deletedAt` 倒序与缺失日期排最后、500 条上限与 `truncated`（恰好 500 不截断）；
    purge 的库名确认（400 `CONFIRM_REQUIRED`）、`all` 与 `ids` 二选一（400 `INVALID_ARGS`）、
    `ids` 仅接受本库已删除条目（409 `DOC_NOT_DELETED`）、去重/日志/索引刷新、`all` 清空与空回收站
    （409 `NO_DELETED_DOCS`）、部分失败不回传路径、归档库与穿越库名、写请求 UI 头与同源校验。
  - `ui-trash.test.mjs`（22）：`?tab=docs` 才进已删除资料、未知值回落归档库、页签计数取服务端 `total`
    而非 500 条；归档库分区保留原列表/空态/加载错误态；已删除资料表的库徽标、行内操作、总数、
    500 提示与独立加载/错误态；防御性过滤混入的在用资料；跨库选择判定与 `kb+id` 去重；
    `toggleOne`/`toggleAll`；批量工具条同库可删/跨库禁用并说明原因；busy 禁用；确认正文
    （最多 10 标题/总篇数/不可恢复警告/清空本库的仅 `total`）；空选择与跨库 purge 目标拒绝；名称与原因转义。
- 变更文件：
  - `ui-api.test.mjs` 11 → 12：`trashDocs()` 与 `purgeDocs()` 的 URL/方法/请求体（`all` 优先于 `ids`、
    只读接口不带 `x-kb-ui`）。
  - `ui-docs-actions.test.mjs` 29 → 30：「清空本库已删除资料」入口只在「已删除」筛选且库内有回收站内容时出现，
    无结果/忙碌/无已删除资料的分支。
  - `ui-router.test.mjs` 6 → 7：`#/trash?tab=docs` 的 query 解析。
- 全部用例使用临时目录，不依赖本机知识库；`check:client` / `check-ui` 为独立门禁，不计入用例数。

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
- **同步文件读**：提示组装路径上的同步读；mtime+size 缓存 + 1MB 上限，损坏降级 `all`。
- **身份缺失 fail-open**：无 session id 的调用不受限制（测试与非常规宿主路径）。
- **`kb_edit_batch`/`kb_add_note` 单库策略**：偏离 M1 字面表述，已在第 8 节记录。
- **`conversation.session.header.utilities` 未实现**：首页没有会话头部，`input.left` 覆盖主场景；若未来某些视图没有 composer，胶囊不出现（可后续补 header 注册）。
- **服务端不认证 sessionId**：范围是产品约束，不是安全边界。
- **CLI 0.1.1 与桌面 0.2.1 的差异**：`agent/created` 的 `source` 字段在 0.1.1 实测缺失；本设计不依赖该字段。

## 19. 与 2A 的衔接

- 复用 2A 的 `/kb/api/*` 路由分发、错误包装（`WebError`/`mapError`）、静态资源与工作台 UI；不新增任务类型。
- 复用 2A 的临时宿主 + WKWebView 验收手法（`.acceptance/`）。
- 2A 交接项（2A design §14）四项全部落实：slot（结论 1）、session 事件（结论 2）、父会话字段（结论 3）、工具公共入口（结论 4 + 第 8 节）。

## 20. 2B 验收记录（2026-10-24，0.21.0）

- [x] 自动化：`npm test` **500/500** 通过（含 `check:client`、`check-ui`）；`npm run typecheck`、`npm run check:client`、`node scripts/check-ui.mjs` 均通过。
- [x] 真实宿主（临时 `dsh --profile web --port 55940` + 临时 kbRoot `/tmp/kb-2b-accept/kb-root`，WKWebView）：
  - chip「知识库：全部」→ 打开面板（2 个库）→ 清空 + 勾选「验收甲库」→ 应用 → chip「知识库：1 个」+ 可见 toast；
  - 重新打开面板，勾选保持；
  - 从胶囊「打开知识库工作台」可打开/关闭 DSH 内弹窗；
  - 只读 `.scopes.json` 注入：toast「范围保存失败，请重试」、chip 不变、面板保留；
  - 真实模型轮次要求模型调用 `kb_list`：只返回「验收甲库」，「验收乙库」不出现。
  - 口径说明：范围化 `kb_list` 真实轮次只返回「验收甲库」；系统提示注入机制由设计 spike（§4.3）证明，Task 13 期间未重新读取实际渲染的 `[知识库范围]` 行。
- 截图：`.acceptance/screenshot-2b-chip-all.png`、`screenshot-2b-chip-selected.png`、`screenshot-2b-workbench-modal.png`、`screenshot-2b-write-failed.png`、`screenshot-2b-scoped-tool-turn.png`。
- 说明：「全部」模式打开面板时所有复选框预勾选，因此收窄范围靠**取消勾选**（第 12.3 节已记录）。
- **0.21.1 复审跟进（2026-10-24）**：
  - 库身份统一为目录名：`/kb/api/scope` 的 `resolved` 按 `kb.dir` 匹配；胶囊按目录身份勾选/全选/提交（可见标签仍是清单 `name`）；导入查重用 `catalog.dir === targetKb` 判定同库（报告仍用清单名）；`purgeKb` 同时清理清单名与归档前目录名两个别名（均带现存库保护）。
  - 文档解析单一来源：`kb_read` / `kb_view` / `kb_edit` / `kb_describe` / `kb_keep` / `kb_trust` / `kb_retitle` / `kb_remove` / `kb_restore` / `kb_history` 直接消费 `resolveDocTarget().doc`，仅在其缺失时回退 `resolveDoc`。
  - 范围 TTL 活跃续期：工具路径在 prune 前按 24h 粒度续期会话自己的条目；GET（`snapshot:false`）与系统提示的同步读不续期，`scopeTtlDays` 只淘汰从未被工具使用的会话。
  - 系统提示措辞：order 106 静态提示的导入查重范围改为「当前库及本会话范围内的知识库（未限定范围时为全部）」。
  - 测试：`npm test` **508/508** 通过（较 0.21.0 新增 8 例：scope +2、scope-tools +2、scope-api 1、scope-client 1、dedup 1、scope-sync 1）；`npm run typecheck`、`npm run check:client`、`node scripts/check-ui.mjs` 均通过。

## 21. 0.22.0 交互完善

> 版本：0.22.0（基线 0.21.1 / `npm test` 508/508；本版 **620/620**，含复审跟进 +8）。
> 本轮把 §6/§7/§8/§12 里「`selected` + 空 = `all`」的旧规则改为「空 = `none`」（**破坏性变更**），
> 并补齐工作台资料分页/搜索、原件预览、笔记、徽标、重命名与临时/锁文件过滤。
> 相关提交：`0733c59`（none 模式）、`092506e`（范围门先于参数校验）、`076f59d` + `5563ee8`（资料页与工具栏）、
> `f23714e`（预览基础设施）、`5d4afb0`（预览 UI/笔记/徽标/重命名）、`5bb98f6`（临时/锁文件）。

### 21.1 破坏性变更：空选择 = 未启用（`none`）

**语义修订**（覆盖 §6 第 1 条与 §8 末条）：

- `mode` 取值 `all | selected | none`；`none` 表示「本会话不启用知识库」。
- **只有显式 `all` 表示全部库**（以后新增的库自动包含）。
- `selected` + 空 `kbs` 在读取（`normalizeScope`）与写入（`setScope`）两侧都归一化为 `none`；
  未知/缺失 `mode` 的条目按 `none` 处理（fail closed）。
- 清理：TTL 只清理 `selected` 条目（`none` 是显式关闭，过期删除会静默退回 `all`；`all` 过期后语义不变）；
  `selected` 的库名全部失效（删除/归档/合并）后写回 `none`（0.21.x 曾回退 `all`）；
  手工写进 `none` 条目的 `kbs` 在清理时清空。

**工具**（21 个 `kb_*` 全部）：

- `lib/scope.js` 的 `assertScopeEnabled(scope)` 是统一门禁：`none` 下在读取/检索任何库数据之前抛
  `ScopeError`（`code: "KB_DISABLED"`，message 逐字为 README 中的提示）。
- `assertInScope` 先过 enabled 门，`resolveSingleKb` / `resolveDocTarget` / `kb_list` / `kb_query` /
  `kb_lint` 都经过它。
- 参数校验分工：工具 schema 中标 `required: true` 的参数（如 `kb_import` 的 `path`、`kb_read` 的 `doc`、
  `kb_edit` 的 `old_string`）由框架在 `execute` 之前校验，缺参时会先返回 `INVALID_ARGS`，不会走到范围门。
  `kb_remove` / `kb_rename` 的参数都不是 schema-required，缺参在 `execute` 内、门禁之后校验，
  因此 `kb_rename({})` / `kb_remove({})` 在 `none` 下保证返回 `KB_DISABLED`，而不是参数形状错误；
  其余工具在通过 schema 校验后、读取/检索任何库数据之前过范围门。
- 参数 schema 相应调整：`kb_rename` 的 `newName` 不再是 schema-required（由工具内校验），以便先报范围错误。

**系统提示**（覆盖 §9 的行为）：

- `all` → `""`（不注入）；`selected` → 原有范围说明；`none` → 固定一行
  「[知识库范围] 本会话未启用知识库：不要调用 kb_* 工具，也不要检索知识库；…」。
- `selected` 但没有可用库时也按 `none` 注入（服务端正常会先归一化）。
- 文本仍逐字稳定，异常一律 `""`。

**API**（覆盖 §10.2）：

- `PUT /kb/api/scope` 接受 `{session, mode:"none"}`；`kbs` 被忽略（即使带已归档/不存在的名字也不报错）。
- 空 `selected` 落盘为 `none`；响应里的 `scope.mode` 反映归一化后的值。
- `GET` 原样返回 `none`；`features.scope` 不变。

**胶囊**（覆盖 §12.2/§12.3）：

- 新增收起态文案 `知识库：未启用`（`chipLabel`）；
- `清空` + `应用` → `PUT {mode:"none"}`，toast 报「已关闭本会话的知识库」；
- `全选` + `应用` → `PUT {mode:"all"}`；
- 打开 `none` 范围的面板时所有复选框不勾选；不做修改直接应用仍提交 `none`（不回退 all）；
- `none` 下不发起任何额外的 `kb_*` 请求（胶囊测试断言了这一点）。

**继承与兼容**：父会话 `none` 快照为子会话 `none`；0.21.x 用「清空 + 应用」表达「全部」的会话升级后
变为「未启用」，README 已写迁移提示（点「全选」恢复全部）。

### 21.2 胶囊：外部点击与焦点时机

- 关闭触发：`document` 级 `pointerdown` 捕获面板/胶囊之外的点击 → 立即 `setOpen(false)` 并丢弃草稿；
  不提交范围、不触发 `kb_*`；`Esc` 走 `keydown`，同步关闭并还焦点。
- 焦点归位：外部点击把 `chipRef.focus()` 放进 `setTimeout(…, 0)`，等浏览器完成这次点击的默认聚焦动作
  之后再聚焦，避免被默认动作覆盖；`Esc` 立即聚焦。
- 定时器生命周期：`focusTimerRef` 在卸载、重开面板、再次外部点击时清理，避免对已卸载节点调用 `focus()`。
- 测试：`test/scope-client.test.mjs` 用 effect-running VM 断言「pointerdown 立即关面板 + 延迟聚焦」、
  「Esc 同步聚焦并摘监听」、「卸载清理定时器」。

### 21.3 工作台资料页：分页、搜索、状态筛选

**服务端**（`lib/web/data.js#listDocs`）：

- `query`：`trim().toLowerCase()` 后对 `title`、`summary`、`tags` 拼成的 haystack 做 `includes`
  （标题 + 摘要 + 标签，不区分大小写；**不是全文检索**）。
- `status`：`failed|importing`（以及 `ready|deleted`）过滤；删除文档默认排除。
- `offset/limit`：`limit` 收敛到 1–200（默认 50）；排序仍为标题 `localeCompare("zh-Hans-CN")`；
  返回 `{docs,total,offset,limit}`。

**视图**（`ui/views/detail.js`）：

- `DOCS_PAGE_SIZES = [50,100,200]`；`docsPageSize` 把其它值回落 50；`docsPageCount`、`clampDocsPage` 收敛页码。
- 顶部/底部分页统一 `第 X / Y 页 · 共 N 篇` + 上一页/下一页 + 页码输入框（Enter 或按钮跳页）；
  表格底部显示 `第 a–b 篇`；`total=0` 时不渲染分页。
- 状态筛选 `全部/有失败/导入中` 渲染为按钮组（当前项高亮）；有筛选/搜索无结果时保留工具栏；
  新条件结果未回来时只渲染工具栏与「正在搜索…」，旧查询的行/表格与分页都不渲染。

**交互接线**（`ui/docs-controls.js`）：

- `attachDocsControls({app, state, load, timers})` 在每次 render 后重新挂载，返回 `detach()`（清定时器 + 摘监听）。
- 搜索 300ms 防抖（`DOCS_SEARCH_DELAY`）；`compositionstart` 取消计时、`compositionend` 立即应用；
  `input` 事件在 `isComposing` 时忽略；Enter 立即搜索并 `preventDefault`。
- 清除搜索同时取消挂起的防抖、清空 `query/offset`；重绘后把焦点与光标送回搜索框末尾。
- 竞态：`createRequestGate()` 单调 token + `app.js` 的 `detailGate`；`attachDocsControls` 只允许最新一次
  请求写 `state.docs.appliedQuery` 并恢复焦点；`loadDetail` 在 await 后复核 `query/status`，过期响应丢弃。
- 每页条数变化/跳页/搜索/切筛选都会把 offset 归零或按页码换算。

### 21.4 原件预览

**路由**（`lib/web/api.js`，均在同源 + 可信围栏之后）：

| 路由 | 行为 |
|---|---|
| `GET /kb/api/kbs/:name/docs/:id/source` | 附件下载（`content-disposition: attachment`） |
| `GET …/source?inline=1` | 白名单内联：`.pdf/.png/.jpg/.jpeg/.webp/.gif/.txt/.md`；命中返回精确 `content-type` + `inline` + `x-content-type-options: nosniff` + `cache-control: private, no-store`；不在白名单（含 HTML/SVG）→ 415 `SOURCE_NOT_PREVIEWABLE`；原件缺失 → 404 |
| `GET …/preview.pdf` | 仅 Office 扩展名（`.doc/.docx/.odt/.xls/.xlsx/.ods/.ppt/.pptx/.odp`）→ 转换后内联 PDF；非 Office → 415 `PREVIEW_UNSUPPORTED`；无引擎 → 501 `PREVIEW_ENGINE_MISSING`；转换失败 → 500 `PREVIEW_FAILED`（固定文案，细节只进日志） |
| `GET …/content` | 笔记 → 合并版 `markdown/<docId>/<docId>.md`；txt/md 资料 → 原件；其它 → 415；返回 `{title, markdown, truncated?}`，上限 2 MB（超出截断并去尾部 U+FFFD） |

**引擎探测**（`lib/web/preview.js#resolveOfficeCli`）：`officeKitCli` → `DSH_OFFICE_KIT_CLI` →
`~/.dsh/tools/libreoffice-kit/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js` → PATH 的 `dsoffice`；
支持裸命令名、`~` 与相对路径。CLI 为 `.js` 时用当前 Node 执行，否则直接 spawn
（`convert --input <src> --output <tmp>`，默认 120s 超时，POSIX 下杀整个进程组）。

**缓存**（`getOrCreateOfficePreview`）：

- 路径 `<kbDir>/.preview/<safeDocId>-<mtimeMs>-<size>.pdf`；源文件变化自然换名。
- 复用前校验文件非空且头 5 字节为 `%PDF-`；损坏缓存会被替换。
- 进程内 `Map` 按目标路径合并并发转换；转换写 `.tmp-…` 临时文件，校验后原子 rename，
  Windows 上先删旧目标再 rename；成功/失败都清理临时文件，并删除同 docId 的旧预览。

**安全**：白名单只放行 PDF/位图/纯文本，HTML/SVG 仍只能下载（防同源 XSS）；5xx 与转换错误不回传
本机路径；`preview.pdf` / `inline` 响应都带 `nosniff` 且不缓存。

### 21.5 笔记、徽标、重命名

- 笔记：`ui/app.js` 打开笔记 tab 时请求 `GET /docs?type=note&limit=200`；`ui/views/detail.js#notes`
  渲染标题/更新日期/摘要（120 字截断）；点标题走 `openPreviewModal`（`previewKindFor` 对 `type=note`
  返回 `note`），用 `/content` 的合并版 markdown 以 `<pre>` + HTML 转义展示（超过 2 MB 提示截断）。
  笔记没有原件，列表本身与预览失败分支（`renderPreviewBody`）都不提供下载入口，只留「关闭」；
  总数超过返回条数（200）时列表底部提示「仅显示前 N 篇（共 M 篇）」，不做分页。
- 徽标：`ui/views/badges.js#statusBadges` 输出 `导入中 N` / `有失败 N`（只渲染非零项），
  `title` 为 `成功 X · 导入中 Y · 失败 Z`；详情页 `interactiveFailed=true` 时「有失败」是
  `data-action="docs-status" data-docs-status="failed"` 按钮（跳资料 tab 并过滤），总览卡片保持 span。
- 重命名：详情页页头新增 `data-action="rename-kb-modal"` 按钮；`openRenameModal` 校验空白/同名后
  `PATCH /kbs/:name`，成功后刷新库列表并跳到新库名的同一 tab；设置页的旧表单保留。

### 21.6 临时/锁文件

- `lib/temp-files.js`：`isTempFileName`（只按 basename、大小写不敏感）识别 `~$*`、`.~lock.*`、
  `Thumbs.db`、`desktop.ini`、`.DS_Store`；普通 `.tmp` **不**算；`TEMP_FILE_PATTERNS` 提供可读规则。
- 导入：`lib/pipeline.js` 的 `collectSources` 跳过并计数（不占 `maxFiles` 额度），单文件是临时文件时报错，
  目录里全是临时文件时抛「目录中没有可导入的文件（已跳过 N 个临时文件）」；报告渲染输出
  「已跳过 N 个临时/锁文件」。
- 工作台上传：`lib/web/upload.js` 的 `addBatchFile` 在读取批次前拒绝（415 `TEMP_FILE`）；
  `ui/upload-core.js` 与服务端同一套分类；上传面板显示跳过数。
- `kb_lint`：新增 `temp-files` 组（warning），列出清单里已是这类文件的文档，建议 `kb_remove`
  （`soft=false` 彻底删除）；计数进 `counts.tempFiles`。

### 21.7 破坏性变更说明

- 升级前：0.21.x 中「限定 + 一个都不选」= 全部库。
- 升级后：同样的操作 = 本会话**不启用知识库**（`none`），工具返回 `KB_DISABLED`。
- 只有显式「全选」/「全部」才代表全部库。README「0.22.0 交互完善」与「会话知识库范围与胶囊（0.21.0）」
  两处都已写明，并给迁移提示（点「全选」恢复）。
- 其它 API/存储结构不变（`.scopes.json` 仍是 v1，只是多了一个合法 `mode` 值）。

### 21.8 测试与验收

- `npm test`：**620/620** 通过（0.21.1 基线 508，净增 112：原有文件 +24、新文件 +80、复审跟进 +8），
  含 `check:client` 与 `check-ui`；逐文件明细见 §15.3。
- `npm run typecheck`、`npm run check:client`、`node scripts/check-ui.mjs` 全绿。
- 真实宿主验收（2026-10-24，临时 `dsh --profile web --port 55941` + 临时 kbRoot，WKWebView 脚本）：
  - 胶囊「全部」→ 清空 + 应用 → **未启用**（toast、`.scopes.json` 写 `mode:"none"`）→ 全选恢复「全部」；
  - 面板打开时点击页面空白 → 关闭；焦点在事件完成后回到胶囊；
  - 资料页：搜索「验收文档」得到 2 行；每页 100 生效；分页文案「第 1 / 1 页 · 共 5 篇」；
  - 查看原件：PDF 内嵌浏览器阅读器；docx 首次约 0.7s 转 PDF 后内嵌，转换完成后「正在转换」提示消失；
  - 笔记 Tab 列出「验收笔记」，点击显示正文；底部不再出现「下载原件」；
  - 「有失败 1」徽标 hover 显示「成功 4 · 导入中 0 · 失败 1」，点击筛出失败文档（筛选 chip 高亮「有失败」）；
  - 标题旁「重命名」弹窗改名为「验收库2」并生效（`PATCH` + `.scopes.json` 同步）；
  - 服务端拒收 `~$` 临时文件（上传 415 `TEMP_FILE`）；真实一轮模型调用 `kb_list` 在 none 模式下返回
    精确文案「本会话未启用知识库…」，全程无库名泄漏。
  - 截图：`.acceptance/screenshot-22-scope-disabled.png`、`-scope-disabled`、`-docs-search`、
    `-preview-pdf`、`-preview-office-fixed`、`-note-preview-fixed`、`-failed-filter`、`-renamed`、
    `-none-tool-block`。
- 真实浏览器自动化（Playwright）仍未接入；上述为一次性 WKWebView 脚本验收，UI 回归仍靠
  fake DOM / 纯函数单测与 `check-ui` 语法门禁。
- 已知跟进：
  - Office 预览仅在单页 docx 上人工验过；大表格、扫描件附件、字体替换与超大文件耗时仍建议抽检；
  - 笔记预览内容以纯文本渲染（不解析 markdown 样式），如需排版后续再加安全渲染。

## 22. 0.23.0 资料治理与失败处理

> 版本 0.23.0（基线 0.22.0 / `npm test` 620；本版 **733**，见 §15.4、§22.7）。
> 本轮补齐工作台的资料生命周期（软删除/恢复/彻底删除）、同根目录内的跨库安全移动与撤销、
> 失败资料重试；总览卡片改为「单条类型条 + 可信度圆点」方案 B；Office 原件预览增加一键安装
> LibreOfficeKit 转换引擎（需用户显式同意）。
> 相关提交：`1d4e74e`（生命周期 API 与失败详情）、`b9cc1f6`（移动引擎）、`b62f74d`（删除/移动/重试 UI）、
> `33d000a`（类型条方案 B）、`176d4d6`（Office 一键安装）、`6446e83`（可信度行标签）。

### 22.1 资料生命周期 API（删除 / 恢复 / 重试）

三个接口都在工作台路由下，沿用 Slice 2A 的 `x-kb-ui` 与同源校验：

| 方法 / 路由 | 请求体 | 成功响应 | 主要错误 |
|---|---|---|---|
| `POST /kb/api/kbs/:name/docs/:id/delete` | `{permanent?: boolean, confirm?: string}` | 软删 `200 {docId, deletedAt, soft: true}`；永久删 `200 {docId, removed: true}` | `404 DOC_NOT_FOUND`、`409 DOC_IMPORTING`、`409 DOC_NOT_DELETED`、`409 DOC_DELETED`、`400 CONFIRM_REQUIRED` |
| `POST /kb/api/kbs/:name/docs/:id/restore` | — | `200 {doc}`（`readDoc` 投影） | `404 DOC_NOT_FOUND`、`409 DOC_NOT_DELETED`、`409 DOC_CONTENT_MISSING` |
| `POST /kb/api/kbs/:name/docs/:id/reparse` | — | `202 {jobId}` | `404 DOC_NOT_FOUND`、`409 DOC_NOT_FAILED`、`409 SOURCE_MISSING` |

- **删除**：`permanent !== true` 即软删除，走 `store.softDeleteDoc`——只把清单项改为 `status: "deleted"`，
  记 `deletedAt` 与 `deletedFromStatus`，原件、`markdown/<id>/`、`history/<id>/` 全部保留；`error` 字段
  也原样保留。允许 `ready` 与 `failed`，拒绝 `importing`（避免半成品进回收站）与已删除。接口在调用前
  再判一次 `importing`（`409 DOC_IMPORTING`，文案「文档正在导入，暂不能删除」）；**软删除始终拒绝导入中**。
- **彻底删除**：必须 `body.permanent === true`，且 `String(confirm).trim()` 与 `doc.title.trim()` 逐字相等，
  否则 `400 CONFIRM_REQUIRED`（附标题）。`store.removeDoc` 删除清单项 + `markdown/<id>/` + `history/<id>/`
  + `sources/<id>*`；不可恢复。**只允许从回收站发起**：非导入中且 `isDeleted(doc) === false` 时
  `409 DOC_NOT_DELETED`（文案「彻底删除只能从回收站发起」）。
  唯一例外是卡死的导入中任务：`status === "importing"` 且 `Date.now() - Date.parse(updatedAt) > 30 分钟`
  （或 `updatedAt` 缺失/非法）时允许永久删除，作为清理半成品的逃生口；未满 30 分钟仍
  `409 DOC_IMPORTING`，且同样需要标题逐字确认。
- **恢复**：要求 `markdown/<id>/` 仍存在（否则 `409 DOC_CONTENT_MISSING`）；状态回到
  `deletedFromStatus === "failed" ? "failed" : "ready"`（旧清单没有该字段时按 `ready`，兼容 0.9.0 以来的
  软删除），清掉 `deletedAt` / `deletedFromStatus`。
- **失败重试**：只有 `status === "failed"` 可重试；先 `findSource` 找 `sources/` 下唯一以 `<docId>` 开头的
  普通文件（找不到即 `409 SOURCE_MISSING`）。服务端起后台任务 `kind: "kb-reparse"`、
  `label: "重试 <库>: <标题>"`，`202 {jobId}`；任务里调用 `importFileInto({sourcePath, relKey, title,
  docId, sourceFile, storedSourcePath, forceReparse: true})` 从已存原件重跑完整解析，`finally` 刷新
  `index.md`，成功返回 `{status: "succeeded", detail: "重试完成：<标题>", result}`。任务进度仍用既有
  `GET /kb/api/jobs/:id` 轮询。默认实现失败时任务详情固定为 `重试失败：<标题>`（不带任何绝对路径），
  且 `index.md` 刷新失败不会把一个已成功的重试改判为失败。
- **日志与索引**：软删 / 永久删各写一条 `remove`（detail「软删除」/「永久删除」），恢复写 `restore`；
  三种操作之后都 `refreshKbIndex`（重试由导入收尾刷新）。
- **投影**：`listDocs` 增加 `error`、`sourceFile`、`movedTo`（无移动为 `null`）与既有 `deleted`；
  `status=deleted` 只返回已删除，其余状态过滤排除已删除。`readDoc` 增加 `movedTo`，并保留
  `error` / `errorAt` / `warnings` / `deleted`。列表因此可以直接显示失败原因与原件名。
- **批量**：HTTP 只有逐篇接口，工作台多选时逐篇 `allSettled` 调用（失败按篇报告）；批量仅软删除，
  没有批量彻底删除（见 §22.6）。

### 22.2 跨库移动（`lib/transfer.js`）

#### 22.2.1 路由

| 方法 / 路由 | 请求体 | 成功响应 |
|---|---|---|
| `POST /kb/api/kbs/:name/docs/move/preflight` | `{target: string, ids: string[]}` | `200 {docs: [{id, title, sourceFile, size, conflict}], totalBytes}`，`conflict` 为 `null` 或 `{kind: "id" / "hash" / "title", withTitle}` |
| `POST /kb/api/kbs/:name/docs/move` | `{target, ids, onConflict?: "skip" / "rename"}`（默认 `skip`） | `200 {transferId?, results, moved, skipped, failed}`；单篇结果 `status: "moved" / "skipped" / "failed"`，moved 带 `newId`/`newTitle`/`transferId`，skipped 带 `reason`/`conflict`，failed 带 `error` |
| `POST /kb/api/kbs/:name/docs/:id/undo-move` | `{target: string}` | `200 {source, target}`（两边 `readDoc` 投影） |

- 预检是只读的（不写清单、不复制文件），但会先 `sweepTransfers` 收敛上次崩溃遗留的 journal；它与
  move/undo 共用同一把 `kbRoot` 级进程锁，避免预检的 sweep 清掉另一个进行中的暂存。
- move 是**逐篇同步事务**：单篇失败不中断批次，结果按请求顺序返回；`moved === 1` 时顶层附带
  `transferId`（供结果页/日志关联）。
- `TransferError` 由 `mapError` 映射：`TRANSFER_INVALID_REQUEST` / `TRANSFER_SAME_KB` → 400；
  `TRANSFER_KB_NOT_FOUND` / `TRANSFER_DOC_NOT_FOUND` → 404；`TRANSFER_DOC_NOT_READY` /
  `TRANSFER_DOC_DELETED` / `TRANSFER_SOURCE_MISSING` / `TRANSFER_TARGET_MERGED` / `TRANSFER_CONFLICT` /
  `TRANSFER_SOURCE_CHANGED` / `TRANSFER_UNDO_UNAVAILABLE` → 409；`TRANSFER_TOO_MANY` /
  `TRANSFER_TOO_LARGE` → 413；未列出的按 500。错误文案只含标题/库名，绝不含 `kbRoot` 绝对路径。

#### 22.2.2 前置校验与上限

- 目标：`sanitizeKbName` 后按 `kbDirPath(kbRoot, name)` 定位，必须存在 `kb.json`；源库与目标库同一目录
  → `TRANSFER_SAME_KB`；目标 `manifest.mergedInto != null` → `TRANSFER_TARGET_MERGED`。由于路径都由
  同一个 `kbRoot` 拼出，**天然不支持跨根移动**（也没有入口）。
- `ids`：必须是非空字符串数组；去重保序；空数组 → 400；超过 `MAX_MOVE_DOCS = 50` → 413
  `TRANSFER_TOO_MANY`；原件大小合计超过 `MAX_MOVE_BYTES = 500 * 1024 * 1024` → 413
  `TRANSFER_TOO_LARGE`。上限在预检和 move 内各校验一次（move 在锁内重新预检）。
- 每篇文档：必须存在（404）、未删除（409 `TRANSFER_DOC_DELETED`）、`status === "ready"`
  （409 `TRANSFER_DOC_NOT_READY`）、`findSource` 能找到唯一原件（409 `TRANSFER_SOURCE_MISSING`）。
  因此**没有原件的笔记不能移动**；失败/导入中的资料也不能移动（UI 只发送 ready）。

#### 22.2.3 冲突策略

- 目标库冲突判定顺序：**同 ID → 同内容（`sourceHash`）→ 同标题**。标题比较用 `NFKC`、空白折叠、
  trim、小写；返回冲突对象的 `withTitle` 供 UI 显示「目标库已有「X」」。
- `onConflict: "skip"`（默认）：任一冲突都跳过该篇，两边都不动，结果里给 `reason`。
- `onConflict: "rename"`：同 ID 冲突换随机新 id（`randomBytes(6).toString("hex")`，避开目标库已有 id）；
  同标题冲突把标题唯一化为「（副本）」「（副本 2）」…；**同内容冲突始终跳过**——改名只会制造真正的
  重复。非法 `onConflict` → 400。

#### 22.2.4 事务、journal 与崩溃恢复

目标库的单篇提交流程（任何清单写入之前，文件都已复制并校验）：

1. **暂存**：`<target>/.transfer/<transferId>/sources/<newId><suffix>` 与 `.../markdown/<newId>/`；
   原件 `copyFile` 后比较源/暂存 `stat.size`；markdown 用 `cp` 复制后再 `measureTree` 比较文件数与
   总字节，任一不等即中止并清理。
2. **journal**：`<kbRoot>/.transfers/<transferId>.json`（`version: 1`），记录源/目标库名、`docId`、
   `newId`、标题、源文件名、暂存与目标相对路径、`stage`（`staging` → `staged` → `target-done` →
   `source-done`）；写入用临时文件 + rename 原子落盘。
3. **目标提交**（持目标库清单锁）：重新判 ID → 同内容 → 同标题；必要时把暂存文件改到新 id；
   改暂存合并版 markdown 的标题行与文件名（`<docId>.md` → `<newId>.md`）；**落位前先把
   `journal.mounted = true` 写盘**，再由 `mountStaged` 把暂存文件 rename 到正式 `sources/` /
   `markdown/`；把条目 push 进目标清单（`status: "ready"`，带 `sourceFile`、`storedSourcePath`、
   `transferId`、`movedFrom`（含移动时的源文档 `version`；目标条目从该版本开始）与条目自身的
   `version`，**删除 `history` 字段**），最后才 `writeManifestAtomic`——写成功即视为目标侧已提交。
   落位前任何失败都只清暂存；`discardAttempt` 只有在 `mounted === true` 且目标清单没有同 id 文档时
   才删除 journal 记录的目标路径，因此 commit 阶段才判出的 id 冲突（skip）不会误删既有文档。
4. **源库收尾**（持源库清单锁）：文档仍需 `ready`（否则回滚目标条目与文件并抛
   `TRANSFER_SOURCE_CHANGED`）；写 `status: "deleted"`、`deletedAt`、`deletedFromStatus`、
   `movedTo: {kb: target, docId: newId, transferId, at}`，原子写清单。
5. **附属动作**：两库各写一条 `move` 日志、刷新索引、删除 journal；这些失败不影响移动结果。

- **崩溃恢复**：`sweepTransfers(kbRoot)` 在预检 / 移动 / 撤销开始时扫描 `.transfers/*.json`：
  - 目标清单里已有该 `transferId`：幂等补齐源文档的 `deleted` + `movedTo`（仅在源文档仍存在时），
    清暂存目录与 journal，写一条「崩溃恢复」日志；
  - 目标清单没有：删除 journal 记录过的目标路径（若目标库没有占用该 `newId`）与暂存目录，再删 journal；
  - 损坏的 journal 不猜、跳过；`transferId` 必须是 `^[0-9a-f]{8,64}$`，`targetSource` 必须位于
    `sources/` 下、`targetMarkdown` 必须位于 `markdown/` 下（相对路径、不含 `..`、不能是目录根本身），
    避免伪造 journal 越界删文件；不满足的路径直接忽略，只清暂存与 journal。
- **并发**：同一 `kbRoot` 的 move/undo 用进程内根锁串行；每个库的清单写入另有 `withManifestLock`。
  不同 `kbRoot` 互不影响。

#### 22.2.5 撤销移动

- 前置：源文档存在且已删除、`movedTo.kb === target`；目标副本存在、未删除、`status === "ready"` 且
  `transferId` 与 `movedTo.transferId` 一致；目标副本还不能被改过——`targetDoc.edited === true` 或
  `targetDoc.version !== movedFrom.version`（移动提交时记录源文档版本，默认 1；目标条目从该版本开始，
  任何 `kb_edit`/`touchDoc` 都会递增 version）同样拒绝。任一不满足 → `409 TRANSFER_UNDO_UNAVAILABLE`
  （被改/删就拒绝，避免覆盖用户在目标库里的新内容；version 被改时的文案为「目标副本已被修改，无法
  撤销移动」）。
- 顺序：**先**把目标副本软删除（`deletedFromStatus: "ready"`、`movedFromUndo: true`），**再**恢复源文档
  （`failed` 则回 `failed`，否则 `ready`；删除 `deletedAt` / `deletedFromStatus` / `movedTo`）。源库恢复
  失败时把目标副本回滚为原状态，避免两边都被删。
- **两边文件都保留**：源库恢复用原有的 sources/markdown/history；目标副本只是软删除，文件进目标库
  回收站。日志：源库 `restore`「撤销跨库移动：从「目标」移回」，目标库 `remove`「撤销跨库移动：保留
  文件并软删除副本」。

#### 22.2.6 边界与不变量

- 同一 `kbRoot` 才能移动；跨根没有入口（后续如要做，需要新的导入/搬运管线）。
- **历史版本不复制**：目标条目删除 `history`，目标库从零积累；源库历史随软删除保留，撤销后仍在。
- 无原件的笔记不可移动；移动前后文档 id 可能变化（`rename` 的同 ID 冲突），源库 `movedTo.docId`
  记录目标新 id。
- 单批 50 篇 / 500 MB；逐篇事务，部分成功是允许的（UI 结果页分组报告）。

### 22.3 失败资料：重试链路

- 失败行：`status === "failed"` 时显示「失败」徽标（`badge.warn`）与行内「重试」「移除」按钮；
  重试中按钮禁用并显示「重试中…」，同一行不重复触发。
- 文档弹窗：显示 `<pre>` 等宽的 `doc.error`（无 error 时回落「导入失败」）与 `doc.warnings` 列表；
  底部「重新导入」「移入回收站」都只在失败资料出现。
- 重试调用 `POST .../reparse` → 任务 id → 每 1 秒 `GET /jobs/:id` 轮询（`REPARSE_POLL_TIMEOUT_MS =
  120000`）；任务结算后 `onSettled` 刷新列表/库计数，成功 toast 用任务 detail，失败提示 detail；超过
  2 分钟抛 `REPARSE_TIMEOUT`「重试超时：任务仍在运行，稍后可在资料列表查看结果」。
- 服务端重试成功会把文档写回 `ready` 并清空 `error`/`errorAt`（导入管线写清单），再次失败则保留
  `failed` 与新的错误原因；这两种结果都刷新 `index.md`。

### 22.4 卡片可视化（方案 B）

- `ui/views/overview.js` 的 `typeBar(types)`：**只渲染一条** `.bar`，按非零类型篇数分段（宽度百分比、
  颜色见 `TYPE_COLORS`，未知类型回落灰色），`role="img"`，`title`/`aria-label` 为
  「类型 pdf-text 3 · docx 1」；全部为零时渲染 `.bar.empty` 的中性空条。旧的可信度比例条删除。
- `trustDots(trust)`：一行 `.trust-dots`（`role="group"`，行级 `aria-label` 给完整计数），行首
  `<span class="trust-label muted">可信度</span>`（`6446e83` 补入），随后按高/中/低/未知顺序只渲染
  非零档的 `● N`；圆点颜色 `TRUST_COLORS`，单项 `role="img"`，`title`/`aria-label`「高 3」，整行
  `title`/`aria-label` 给四档完整计数「可信度：高 3 · 中 2 · 低 1 · 未知 0」；四档全为零时整行不渲染。
- 样式：`.bar` / `.bar i`（胶囊分段）、`.trust-dots`、`.trust-label`、`.trust-dot`、`.trust-dot-mark`；
  不再有第二条可信度比例条。

### 22.5 Office 转换引擎一键安装

#### 22.5.1 接口

| 方法 / 路由 | 请求体 | 成功响应 | 主要错误 |
|---|---|---|---|
| `GET /kb/api/office/status` | — | `200 {available, version?, running, installDir, platform, arch, canInstall, toolchain, reason?}` | — |
| `POST /kb/api/office/install` | `{confirm: true}` | 已安装 `200 {alreadyInstalled: true, status}`；否则 `202 {jobId}` | `400 CONSENT_REQUIRED`、`409 OFFICE_INSTALL_RUNNING`、`409 OFFICE_TOOLCHAIN_MISSING` |

- `available`：解析到的 CLI 存在且 `<node> <cli> capabilities` 的 JSON 含 `conversions`（成功/失败缓存
  5 秒）；`running`：当前进程有一次安装；`canInstall`：平台受支持且探测到包管理器。
  `reason` ∈ `installing` / `engine-missing` / `toolchain-missing` / `unsupported-platform` /
  `engine-broken`；`toolchain` 为 `"pnpm" | "npm" | null`，`version` 取 capabilities 的
  `runtime.version`。
- 安装：`confirm !== true` 直接 400；已可用 → 200 短路（不启动任务）；正在装 → 409；缺 Node/npm →
  409；否则启动后台任务 `kind: "office-install"`、`label: "安装 Office 转换引擎"`，先写进度
  `{phase: "download", text: "正在下载并安装…"}`，任务结果 `{status: "succeeded", detail: "已安装
  Office 转换引擎", result}`。
- 安装器：安装目录默认 `~/.dsh/tools/libreoffice-kit`，`DSH_OFFICE_KIT_HOME` 可覆盖（`~`/`~/` 展开）；
  工具链探测顺序为 **DSH 自带 pnpm → `DSH_PNPM` → PATH 的 pnpm/npm**；安装计划固定
  `@deepseek-ai/libreoffice-kit@0.2.2` + 当前平台引擎包（`darwin-arm64`/`darwin-x64`/`win32-x64`/
  `win32-arm64`，Linux 用 `libreoffice-kit-wasm`），pnpm 用 `add`、npm 用 `install`，都带
  `--ignore-scripts`；安装超时 20 分钟，超时杀进程组；完成后跑 `capabilities`（20 秒超时）确认
  `conversions`。失败错误码 `OFFICE_TOOLCHAIN_MISSING` / `OFFICE_INSTALL_FAILED` /
  `OFFICE_INSTALL_TIMEOUT` / `OFFICE_VERIFY_FAILED` / `OFFICE_PLATFORM_UNSUPPORTED`，message 固定文案，
  退出码/日志尾部只放在 `details`，并做路径脱敏。
- CLI 探测顺序更新为：`officeKitCli` → `DSH_OFFICE_KIT_CLI` → `DSH_OFFICE_KIT_HOME` 下的 CLI →
  `~/.dsh/tools/libreoffice-kit` 默认安装 → PATH 的 `dsoffice`。

#### 22.5.2 预览中的安装流程

- 打开 Office 预览先查 `GET /office/status`：`available === true` 才直接渲染 `preview.pdf`；否则渲染
  安装面板。
- 面板：说明「未安装 Office 转换引擎（LibreOfficeKit）……约 300 MB，转换只在本机进行」+ 复选框
  「我同意下载并安装（约 300 MB）」+「安装转换引擎」按钮；**未勾选时按钮 disabled**，勾选后才解锁。
- 点击安装：`POST /office/install {confirm: true}` → 每 1.5 秒轮询任务（上限 20 分钟，双重终止条件：
  轮询次数与截止时间），阶段 `starting` → `installing`（显示任务 progress.text）→ `verifying` →
  `done`/`error`；成功后再查一次 status，确认可用后**自动重载预览**（URL 加 cache-bust），失败显示
  错误并可重试（保留同意状态）。已安装时根本不进入安装面板；缺 Node/npm 时面板换成
  「缺少 Node/npm，无法自动安装，请按 README 手动安装」，不发起请求。

### 22.6 工作台 UI 行为

- 资料 tab：状态筛选 `全部` / `有失败` / `导入中` / **已删除**（`deleted`；只有存在已删除资料或当前
  正选中时显示）。选中「已删除」后行内操作是 恢复 / 撤销移动（有 `movedTo` 时）/ 彻底删除。
- 多选：只有 `ready` 与 `failed` 行有复选框；已删除行没有复选框但保留行内操作。工具条显示
  「已选 N 篇」+「移动到…」「移入回收站」「取消选择」，busy 时禁用。
- 行内操作矩阵：`ready → 移除`；`failed → 重试 + 移除`；`deleted →（movedTo ? 撤销移动 : 恢复）+ 彻底删除`。
- 删除确认：软删弹窗列出标题（超过 20 条折叠），确认文案「移入回收站」；彻底删除弹窗说明不可恢复，
  必须逐字输入标题（去首尾空白比较），服务端错误内联显示在弹窗里。
- 移动弹窗：目标下拉排除当前库与已合并库；选择目标立即预检（请求代号丢弃晚到的旧响应）；显示
  「将移动 N 篇（约 X MB）到「目标」」+ 冲突分组（同 ID / 同内容 / 同标题）；有冲突时才启用
  「跳过 / 重命名为副本」；必须勾选「我已了解：移动=复制到目标库并软删除源库文档，可在源库回收站
  撤销」才能点「开始移动」，**切换目标库会重置该勾选并重新预检**；结果页分组显示已移动 / 已跳过
  （原因）/ 失败（原因），并提供「撤销全部
  已移动」（逐篇撤销、显示进度与失败清单）。
- 失败重试：行内“重试中…”与弹窗“正在重新解析，最长等待约 2 分钟…”两个入口共用同一轮询逻辑；
  结算后刷新库列表、详情与计数。
- 预览：Office 安装面板与安装进度如上；其它格式（PDF/图片/文本/笔记）行为沿用 0.22.0。
- 日志可见性：删除/恢复/移动/撤销都会出现在库详情的「日志」tab（`log.md`）。

### 22.7 测试

- `npm test`：**733/733** 通过（0.22.0 基线 620，净增 113：新增文件 88 例、现有文件 +25 例，
  其中发布前终审补 8 例），含 `check:client` 与 `check-ui`；逐文件明细见 §15.4。
- `npm run typecheck`、`npm run check:client`、`node scripts/check-ui.mjs` 全绿。
- 重点覆盖：软删/恢复原状态/彻底删除标题确认（含「只能从回收站发起」409 与 31 分钟卡死导入的
  永久删逃生口）、reparse 任务与失败投影（默认实现失败文案不含路径）、跨库预检与三类冲突、
  skip/rename（同内容始终跳过）、commit 阶段 id 冲突不误删既有文档、50 篇/500 MB 上限、
  逐篇事务与部分失败、撤销（目标副本被 edited/version 改过时拒绝）、journal 崩溃恢复与不可信
  journal（含路径白名单）、删除/移动/重试 UI、类型条 + 可信度圆点（group/img 语义）、Office 状态与
  一键安装（同意/已装/缺工具链/后台任务/capabilities 校验/超时杀进程）。
- 发布前终审补 8 例：`transfer.test.mjs` +5（commit-skip 保留既有文件、mounted 清理、edited/version
  撤销拒绝、journal 越界路径、源文档 version>1 的撤销往返）、`web-docs-lifecycle.test.mjs` +2
  （回收站外 409 / 卡死导入逃生口、重试失败文案）、`ui-docs-actions.test.mjs` +1（切换目标重置确认）。

### 22.8 验收记录（2026-10-25）

- [x] 自动化：`npm test` **733/733**（含 `check:client`、`check-ui`）；`npm run typecheck`、
  `npm run check:client`、`node scripts/check-ui.mjs` 均通过。
- [x] 真实宿主（临时 `dsh --profile web --port 55942` + 临时 `kbRoot` + WKWebView 脚本）：
  - 跨库移动：资料 tab 勾选「移动测试文档」→「移动到…」→ 目标「乙库」→ 预检 → 确认 → 结果
    「成功 1 · 跳过 0 · 失败 0」；源库「甲库」的该文档进入 **已删除**，行内为 **撤销移动**；点
    「撤销移动」后源文档恢复为就绪，目标副本进入乙库回收站（两边文件都保留）。
  - 删除/回收站：软删除后文档出现在「已删除」筛选；逐字输入标题执行 **彻底删除**，清单项与
    `sources/` / `markdown/` / `history/` 文件被删除。
  - 失败资料：失败行的「重试」启动 `kb-reparse` 后台任务并轮询；任务成功后该行变为就绪
    （`status: ready`），错误原因清空，toast 显示重试完成。
  - 卡片：总览库卡片渲染单条类型条 + 可信度圆点行（高/中/低/未知计数与 hover title），不再有
    第二条比例条。
  - 截图：`.acceptance/screenshot-23-move-result.png`、`-undo.png`、`-purge.png`、`-retry-fixed.png`、
    `-overview-bars.png`（另有 `-error.png` 为一次失败态留档）。
- **口径说明**：
  - Office 一键安装的 UI（同意勾选、已安装短路、后台任务与进度、失败重试）由 `office-install` /
    `ui-preview` / `web-office-api` 单测覆盖；本机此前已装好 LibreOfficeKit，因此本次**没有做真实
    重新下载**（约 300 MB）的现场验证。
  - 删除/移动/重试的**真实 DOM 流程**通过一次性 WKWebView 脚本（`wkflow` + 注入的 `flow.js`）验证，
    不是 Playwright 自动化；UI 回归仍靠 fake DOM / 纯函数单测与 `check-ui` 语法门禁。
  - `screenshot-23-overview-bars.png` 拍摄于 `6446e83` 之前：截图中类型条与可信度圆点已渲染，行首
    「可信度」标签由 `6446e83` 补入，标签渲染经 `renderOverview` 模板检查（输出含
    `<span class="trust-label muted">可信度</span>`）确认；未重新截图。
- 与 §15 的对应：本轮用例总数在 §15.1 更新为 **733**，逐文件明细补在 §15.4。

### 22.9 已知限制与跟进

- 移动仅限同一 `kbRoot`；跨根迁移没有入口。
- 单批 50 篇 / 500 MB；批量只软删除，彻底删除只能逐篇确认标题，且只从回收站发起
  （唯一例外是 `updatedAt` 超过 30 分钟未更新的卡死 importing 文档）。
- 笔记（无原件）不可移动；历史版本不复制；撤销仅在目标副本仍可用、未被 edited/version 改过时成立。
- Office 一键安装未做真实下载验收（本机已装引擎）；安装包约 300 MB，弱网/代理环境需人工抽检。
- 真实浏览器自动化（Playwright）仍未接入；本轮 UI 验收是一次性 WKWebView 脚本。
- 后续可做：批量彻底删除、笔记移动（需设计无原件语义）、移动时复制历史、跨根迁移、Playwright
  回归套件、Office 安装的真实下载/失败重试现场验收。

## 23. 0.24.0 回收站治理

> 版本 0.24.0（基线 0.23.0 / `npm test` 733；本版 **768**，见 §15.5、§23.4）。
> 本轮把回收站从「整库」扩展到「单篇资料」：新增全局已删除资料列举与按库批量彻底删除，
> 工作台回收站拆成「归档库 / 已删除资料」两个分区。
> 相关提交：`ce163c2`（回收站列举与批量彻底删除 API，含 10 例 API 测试）、
> `b1420f3`（回收站页签与资料操作 UI，含 22 例 UI 测试与三处既有用例扩展）。

### 23.1 `GET /kb/api/trash/docs`

- **扫描范围**：逐库调用 `listKbs(kbRoot)`；归档库已被 `archiveKb` 移到
  `<kbRoot>/.trash/<库名>-<YYYY-MM-DD-HH-mm-ss>[-N]/`，而 `listKbs` 只列一级非隐藏目录，
  **归档库天然排除**；合并库（`mergedInto != null`）显式 `continue`，避免其清单里的资料与目标库重复列出。
- **只读**：只读清单，不移动、不改写任何文件；GET 不要求 `x-kb-ui`（与写接口区分）。
- **容错**：单库清单损坏（`readManifest` 抛错）只跳过该库，其余库的回收站照常返回。
- **字段投影**：`{ kb, id, title, type, deleted, deletedAt, deletedFromStatus, movedTo, sourceFile, error }`；
  `deleted` 恒为 `true`，缺失字段归一为空串，`movedTo` 非对象归一 `null`（源库回收站的「撤销移动」
  依赖该记录）。响应里不含 `kbRoot` 等本机绝对路径。
- **排序**：`deletedAt` 倒序；日期缺失/非法排最后（两者都不合法时保持相对顺序稳定）；
  同一时刻按 `kb + "\u0000" + id` 做 `localeCompare`，保证重复请求/后续分页顺序一致。
- **上限**：`TRASH_DOCS_CAP = 500`。`items` 最多 500 条，`total` 始终是真实总数，
  `total > 500` 时 `truncated: true`（恰好 500 不截断）。归档库内的资料不计入 `items` 与 `total`。
- **响应**：`{ items, total, truncated }`。

### 23.2 `POST /kb/api/kbs/:name/docs/purge`

- **鉴权**：沿用工作台写请求的 `x-kb-ui` 与同源校验（缺失 UI 头、跨源或 `sec-fetch-site: cross-site`
  都是 `403 FORBIDDEN`）；归档库、不存在或穿越（`..`、分隔符）的库名在 `ensureKb` 处 `404 KB_NOT_FOUND`；
  错误方法与未知路径不命中该路由（`404 NOT_FOUND`，不返回 405）。
- **确认**：body `confirm` 去首尾空白后必须与库名完全一致，否则 `400 CONFIRM_REQUIRED`
  （文案「彻底删除需要输入库名：`<name>`」）。
- **参数**：`all`（必须为布尔 `true`）与 `ids` **恰好二选一**——同时给出或都没给都算
  `400 INVALID_ARGS`。`ids` 逐项 `trim`、丢弃空串并去重（同一 id 重复提交只删一次）。
- **条目校验**：`all=true` 只取清单里 `isDeleted` 的条目，为空则 `409 NO_DELETED_DOCS`；
  `ids` 里每个 id 必须属于本库且 `isDeleted`，不存在/在用/属于别的库一律 `409 DOC_NOT_DELETED`
  （details 带 `id` 与标题）。**绝不触碰在用资料**（`all` 也只选回收站）。
- **执行**：逐篇调用 `store.removeDoc(dir, id)`——移除原件（`sources/`）、`markdown/` 解析内容与
  `history/` 历史版本。单篇异常**不中断**批次（例如条目在校验后被并发删除时 `removeDoc` 抛
  「文档不存在」），只把 `{ id, title, error: "彻底删除失败" }` 记入 `failed`；错误文案固定，
  不把 errno/绝对路径跨 API 边界回传。
- **副作用**：每篇成功写库日志 `remove`（`detail: "彻底删除"`），全部处理完统一 `refreshKbIndex`
  刷新 `index.md`（即使有部分失败也刷新）。
- **响应**：`{ kb, purged, failed: [{ id, title, error }] }`；有部分失败仍是 HTTP 200，
  全失败时 `purged` 为 0。

### 23.3 工作台回收站 UI

- **两个页签**：`#/trash`（归档库，默认）与 `#/trash?tab=docs`（已删除资料）。`trashTab()` 只认
  `query.tab === "docs"`，手改 URL 的其它值回落归档库；页签是普通 `<a href>`，刷新与浏览器后退
  都能回到同一分区。页签计数：归档库 = 归档库列表长度；已删除资料 = 服务端 `total`
  （不是被 500 条上限截断后的条数）。
- **归档库分区**：保留 0.23.0 的列表、空状态、加载/错误态，逐库恢复与彻底删除。
- **已删除资料分区**：表头为 库 / 标题 / 类型 / 删除时间 / 操作，**每行带库徽标**；数据来自
  `GET /trash/docs`，渲染前再用 `deleted !== false` 挡一次脏数据；头部展示 `total`，
  `truncated` 时额外显示「仅显示前 500 篇」。归档库里的资料不在该分区出现，整库恢复后回到正常状态。
- **勾选**：选择项以 `kb + "\u0000" + id` 为键（同一 id 可能出现在不同库，不能混为一篇）；
  `trashSelectionToggleOne` 按显式 `checked` 增删，`trashSelectionToggleAll` 补齐当前列表、
  再点取消当前列表并保留其它页/库的选择；选择随刷新清空。
- **恢复所选（允许跨库）**：逐篇调用 `restoreDoc(kb, id)`；失败不中断其余条目，最后统一 toast
  （全成功「已恢复」/「已恢复 N 篇」，部分失败「X 篇已恢复，Y 篇失败：`<原因>`」）；完成后刷新
  回收站、侧栏库计数，并在当前详情页属于受影响库时重载详情。
- **彻底删除所选（只能同库）**：`trashPurgeTarget` 对空选择与跨库选择都返回可展示的原因；
  跨库时按钮禁用并显示「彻底删除一次只能处理同一个库的资料」。确认弹窗
  `purgeDocsConfirmBody` 列出库名、最多 10 个标题、「共 N 篇」与固定警告；`requireText: kb`
  要求逐字输入库名。行内单篇、多选批量、清空本库共用同一确认组件与同一 API；资料页「已删除」
  筛选里的单篇「彻底删除」仍是 0.23.0 的逐字输入**标题**确认，走 `docs/:id/delete`，不属于本 API。
- **移动资料警告**：警告常量 `PURGE_DOCS_WARNING` =「彻底删除会移除原件、解析内容与历史版本，
  且撤销移动将不再可用。」被移动过的资料在源库清单里带 `movedTo`，永久删除后该记录消失，
  `undo-move` 不再可用——因此确认弹窗必须提示，不能只写「不可恢复」。
- **清空本库**：资料页切到「已删除」筛选（`status=deleted`）且库内 `deleted > 0` 时，工具栏渲染
  「清空本库已删除资料」；确认后调用 `purgeDocs(name, { all: true, confirm: name })`，
  成功/失败同样按 `purged/failed` 汇总 toast。没有已删除资料的库不显示入口；该筛选下搜索无结果
  但库内仍有回收站内容时入口保留。
- **竞态**：`loadTrash` 用自增 `trashToken`，响应返回时 token 不匹配直接丢弃（快速切页签/连续刷新
  不会把旧结果盖到新页签）；归档库与已删除资料用 `Promise.allSettled` 并行拉取，一边失败不影响
  另一边展示（各自给出错误与重试）；加载时清空跨页选择。
- 操作完成后统一 `refreshAfterTrashChange`（回收站 + 库计数 + 必要时详情）；`busy` 期间行内与
  批量按钮禁用，避免重复提交。

### 23.4 测试

- `npm test` **768/768** 通过（0.23.0 基线 733，净增 35：新增文件 32 例——`web-trash-docs.test.mjs` 10、
  `ui-trash.test.mjs` 22；现有文件 +3——`ui-api.test.mjs` 11 → 12、`ui-docs-actions.test.mjs` 29 → 30、
  `ui-router.test.mjs` 6 → 7）；逐文件明细见 §15.5。
- `npm run typecheck`、`npm run check:client`、`node scripts/check-ui.mjs` 全绿；
  `check:client` / `check-ui` 为独立门禁，不计入用例数。

### 23.5 验收记录（2026-10-25）

- [x] 自动化：`npm test` **768/768**（含 `check:client`、`check-ui`）；`npm run typecheck`、
  `npm run check:client`、`node scripts/check-ui.mjs` 均通过。
- [x] 真实宿主（临时 `dsh --profile web --port 55943` + 临时 `kbRoot` + WKWebView 脚本）：
  - 造数：活跃库 **甲库 / 乙库** + 归档库 **丙库**；甲库软删除 A1、A2、A4，乙库软删除 B1，
    丙库归档前软删除 C1（丙库另有在用资料 C2）。
  - 回收站页签：归档库 **1**、已删除资料 **4**；丙库的 C1 **不在**已删除资料里（归档库内的资料
    不单独列出，随库一起恢复）；已删除资料每行带 **甲库 / 乙库** 库徽标。
  - 操作：行内恢复 A1（甲库，恢复后 `status: ready`）→ 行内彻底删除 A2（确认弹窗输入 **甲库**）→
    多选彻底删除 B1（同库批量，输入 **乙库**）→ 资料页「已删除」筛选点「清空本库已删除资料」
    （输入 **甲库**）清掉 A4。
  - 结果：最终 `GET /kb/api/trash/docs` 的 `total` 为 **0**；丙库仍是归档库，其 C1/C2 完好
    （C1 保持软删除状态，未被全局列表列出或删除）。
  - 截图：`.acceptance/screenshot-24-trash-docs.png`（已删除资料页签、4 行库徽标与行内操作）、
    `-trash-after.png`（行内 + 同库批量彻底删除后列表只剩 A4、toast「已彻底删除 1 篇」的中间态）、
    `-library-trash-cleared.png`（资料页「已删除」筛选清空 A4 后的空态）。
- **口径说明**：真实 DOM 流程仍走一次性 WKWebView 脚本（`wkflow` + 注入的 `flow.js`），不是
  Playwright 自动化；UI 回归由纯函数 / fake DOM 单测与 `check-ui` 语法门禁兜底。
- 与 §15 的对应：本轮用例总数在 §15.1 更新为 **768**，逐文件明细补在 §15.5。

### 23.6 已知限制与跟进

- **不能跨库批量彻底删除**：一次 purge 只处理一个库，跨库需要逐库确认（恢复所选可以跨库，
  因为恢复是逐篇独立操作）。
- **回收站暂无搜索/排序**：已删除资料固定按 `deletedAt` 倒序、最多 500 篇；超过 500 篇时
  只能先恢复/清理，或按库分别处理（上限是全局列表，不随库数放大）。
- **归档库内的资料只能随库恢复**：不能在该列表里单独恢复或彻底删除归档库中的某一篇。
- **无自动过期清理**：已删除资料一直保留，需要手动恢复或彻底删除。
- 后续可做：跨库批量彻底删除（需逐库确认/多库事务设计）、回收站搜索与排序、
  自动过期保留天数配置、归档库内单篇资料的恢复粒度、Playwright 回归套件。
