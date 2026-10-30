/**
 * 0.31.1 知识库根目录：`~` / `~\` / `$HOME` / `%USERPROFILE%` 展开、启动可写校验，
 * 以及 /kb/api/status 的 kbRootOk / kbRootError。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { apply, ensureWritableRoot } from "../lib/index.js";
import { expandRoot } from "../lib/store.js";
import { handleApi } from "../lib/web/api.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

async function statusOf(opts) {
  const res = makeRes();
  await handleApi({
    method: "GET",
    url: "/kb/api/status",
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929" },
    on() {},
    off() {},
  }, res, { opts, fence: () => true });
  return { res, json: JSON.parse(res.body) };
}

function makeCtx() {
  const tools = new Map();
  return {
    tools,
    ctx: {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
      logger: { warn() {} },
      subprocess: { spawn() { throw new Error("not used"); } },
    },
  };
}

test("expandRoot：~ / ~\\ / $HOME / ${HOME} / %USERPROFILE% 都展开到用户目录", () => {
  const home = homedir();
  assert.equal(expandRoot("~"), home);
  assert.equal(expandRoot("~/知识库"), join(home, "知识库"));
  assert.equal(expandRoot("~\\知识库"), join(home, "知识库"), "Windows 反斜杠写法");
  assert.equal(expandRoot("$HOME/kb"), join(home, "kb"));
  assert.equal(expandRoot("${HOME}/kb"), join(home, "kb"));
  assert.equal(expandRoot("%USERPROFILE%\\kb"), join(home, "kb"));
  assert.equal(expandRoot("/data/kb"), "/data/kb");
  assert.equal(expandRoot("D:\\知识库"), "D:\\知识库");
  assert.equal(expandRoot(""), "");
});

test("ensureWritableRoot：可建可写目录返回空；路径是文件或不可写时返回原因", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-root-check-"));
  try {
    assert.equal(await ensureWritableRoot(join(root, "kb")), "");
    const file = join(root, "not-a-dir");
    await writeFile(file, "x", "utf8");
    assert.ok((await ensureWritableRoot(file)).length > 0, "文件当目录应报错");
    const locked = join(root, "locked");
    await ensureWritableRoot(locked);
    await chmod(locked, 0o500);
    assert.ok((await ensureWritableRoot(locked)).length > 0, "不可写目录应报错");
    await chmod(locked, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("启动自检失败不阻塞 apply（工具照常注册）", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-root-apply-"));
  try {
    const file = join(root, "not-a-dir");
    await writeFile(file, "x", "utf8");
    const { ctx, tools } = makeCtx();
    await apply(ctx, { kbRoot: file });
    assert.ok(tools.has("kb_query"));
    assert.ok(tools.has("kb_list"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /status：kbRootOk / kbRootError 反映启动自检结果", async () => {
  const ok = await statusOf({ kbRoot: "/data/kb", kbRootError: "" });
  assert.equal(ok.json.kbRootOk, true);
  assert.equal(ok.json.kbRootError, "");
  const bad = await statusOf({ kbRoot: "/data/kb", kbRootError: "EACCES: permission denied" });
  assert.equal(bad.json.kbRootOk, false);
  assert.match(bad.json.kbRootError, /EACCES/);
});
