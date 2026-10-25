/**
 * 合成一个只读 session（CLI 0.1.x 的 session.jsonl.zstd），用于无模型凭据的
 * 来源面板 E2E：包含一次 kb_query tool/result 与 data.meta.sources。
 * 只写临时 DSH_HOME；不触碰真实会话。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { FIXTURES } from "./seed.mjs";

function projectKey(cwd) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const char = String.fromCharCode(code);
    if (char === "/" || char === "\\" || char === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (char !== "~" && /[A-Za-z0-9._-]/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

export function sessionDirFor(home, cwd) {
  return join(home, "sessions", projectKey(String(cwd)));
}

/** @returns {{sessionId, dir, file}} */
export async function writeSourcesSession({ home, profileDir, cwd = profileDir }) {
  const sessionId = `session-${randomUUID()}`;
  const dir = join(sessionDirFor(home, cwd), sessionId);
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  const callId = "call_00_kbSourcesFixture123456789";
  const sources = [{
    kb: FIXTURES.kbs.primary,
    docId: FIXTURES.docs.pdf.id,
    title: "GB/T 19963.2-2024 风电场接入电力系统技术规定",
    page: 12,
    clause: "5.2.2",
    snippet: "5.2.2 风电场接入电力系统应满足电压偏差要求。",
    deepLink: `/kb/?kb=${encodeURIComponent(FIXTURES.kbs.primary)}&doc=${FIXTURES.docs.pdf.id}&page=12&clause=5.2.2`,
  }];
  const header = {
    type: "session",
    version: 0,
    id: sessionId,
    createdAt: now,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  };
  const events = [
    { type: "sandbox/mode", seq: 0, time: now, data: { mode: "workspace-write" } },
    { type: "approval/policy", seq: 1, time: now, data: { policy: "never" } },
    { type: "turn/start", seq: 2, time: now, data: { turn: 1 } },
    { type: "step/start", seq: 3, time: now, data: { turn: 1, step: 1 } },
    {
      type: "user/message", seq: 4, time: now,
      data: {
        content: [{ type: "text", text: "来源面板验收：请检索电压偏差。" }],
        source: { kind: "user", rpcId: "e2e-sources-fixture" },
        role: "user",
        id: randomUUID(),
      },
      surfaceOp: "append",
    },
    {
      type: "session/title", seq: 5, time: now,
      data: { title: "来源面板验收", messageSeqs: [4], source: { kind: "fallback" } },
    },
    {
      type: "assistant/message", seq: 6, time: now,
      surfaceOp: "append",
      data: {
        turn: 1, step: 1,
        message: {
          id: randomUUID(),
          role: "assistant",
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
          content: [
            { type: "reasoning", text: "需要检索知识库。" },
            { type: "tool-call", id: callId, name: "kb_query", arguments: JSON.stringify({ pattern: "电压偏差" }) },
          ],
        },
      },
    },
    {
      type: "tool/call", seq: 7, time: now,
      data: { turn: 1, step: 1, callId, name: "kb_query", arguments: JSON.stringify({ pattern: "电压偏差" }) },
    },
    {
      type: "tool/result", seq: 8, time: now,
      sourceEventSeqs: [7],
      surfaceOp: "append",
      data: {
        turn: 1, step: 1,
        meta: { sources },
        message: {
          source: { kind: "tool", callId },
          content: [{
            type: "tool-result",
            toolCallId: callId,
            content: [{ type: "text", text: "找到 1 处匹配。" }],
            isError: false,
          }],
          role: "user",
          id: randomUUID(),
        },
      },
    },
    {
      type: "assistant/message", seq: 9, time: now,
      surfaceOp: "append",
      data: {
        turn: 1, step: 1,
        message: {
          id: randomUUID(),
          role: "assistant",
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
          content: [{ type: "text", text: "检索完成。" }],
        },
      },
    },
    { type: "step/end", seq: 10, time: now, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 11, time: now, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  // CLI 的 zstd 读取器要求第一帧恰好是一行 header；其余事件放在第二帧。
  const headerLine = `${JSON.stringify(header)}\n`;
  const rest = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const file = join(dir, "session.jsonl.zstd");
  await writeFile(file, Buffer.concat([
    zstdCompressSync(Buffer.from(headerLine, "utf8")),
    zstdCompressSync(Buffer.from(rest, "utf8")),
  ]));
  return { sessionId, dir, file };
}

/** 把合成 session 临时挂到 workspace 注册表；返回恢复所需信息。 */
export async function attachSessionToWorkspace({ home, sessionId, cwd }) {
  const file = join(home, "storages", "workspace.json");
  const original = await readFile(file, "utf8");
  const data = JSON.parse(original);
  const workspaces = data?.tables?.workspaces ?? {};
  const entry = Object.entries(workspaces).find(([, workspace]) => workspace?.path === cwd);
  if (!entry) return { file, original, attached: false };
  const [workspaceId, workspace] = entry;
  if (!Array.isArray(workspace.sessionIds)) workspace.sessionIds = [];
  if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.unshift(sessionId);
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
  return { file, original, attached: true, workspaceId };
}

/** 只移除合成 session，不覆盖测试期间其它 workspace 变更。 */
export async function detachSessionFromWorkspace(snapshot, sessionId) {
  if (!snapshot) return;
  try {
    const data = JSON.parse(await readFile(snapshot.file, "utf8"));
    for (const workspace of Object.values(data?.tables?.workspaces ?? {})) {
      if (Array.isArray(workspace.sessionIds)) {
        workspace.sessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
      }
    }
    await writeFile(snapshot.file, JSON.stringify(data, null, 2), "utf8");
  } catch {
    await writeFile(snapshot.file, snapshot.original, "utf8").catch(() => {});
  }
}
