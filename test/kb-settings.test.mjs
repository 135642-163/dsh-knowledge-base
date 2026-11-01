/**
 * 0.38 数据目录：知识库根目录设置的持久化、启动解析与 Web API。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearKbRootSetting,
  kbSettingsPath,
  normalizeKbRootInput,
  readKbRootSetting,
  resolveKbRoot,
  writeKbRootSetting,
} from "../lib/kb-settings.js";
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
function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}
async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

test("normalizeKbRootInput：展开 ~、拒绝相对路径", () => {
  const home = normalizeKbRootInput("~/kb");
  assert.ok(home.startsWith("/"));
  assert.ok(home.endsWith("/kb"));
  assert.equal(normalizeKbRootInput("relative/dir"), "");
  assert.equal(normalizeKbRootInput("   "), "");
  assert.equal(normalizeKbRootInput("/tmp/kb-root"), "/tmp/kb-root");
});

test("write/read/clear 设置文件", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "kb-settings-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const target = join(base, "new-root");
  const saved = await writeKbRootSetting(target, { base });
  assert.equal(saved, target);
  assert.ok((await stat(join(base, "knowledge-wiki", "settings.json"))).isFile());
  assert.equal(await readKbRootSetting({ base }), target);
  await clearKbRootSetting({ base });
  assert.equal(await readKbRootSetting({ base }), null);
});

test("write 拒绝文件路径与不可写目标", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "kb-settings-bad-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "a-file");
  await writeFile(file, "x");
  await assert.rejects(writeKbRootSetting(file, { base }), /不是目录/);
  await assert.rejects(writeKbRootSetting("relative", { base }), /绝对路径/);
});

test("resolveKbRoot：保存值优先，KB_SETTINGS_DISABLED=1 时忽略", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "kb-settings-resolve-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const saved = join(base, "saved-root");
  await writeKbRootSetting(saved, { base });
  const configured = join(base, "config-root");
  const enabled = await resolveKbRoot({ configured, base, env: {} });
  assert.equal(enabled.kbRoot, saved);
  assert.equal(enabled.kbRootSource, "setting");
  assert.equal(enabled.configKbRoot, configured);
  const disabled = await resolveKbRoot({ configured, base, env: { KB_SETTINGS_DISABLED: "1" } });
  assert.equal(disabled.kbRoot, configured);
  assert.equal(disabled.kbRootSource, "config");
});

test("API：GET/PUT/清空数据目录，并标出重启生效", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "kb-settings-api-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const kbRoot = join(base, "current-root");
  await mkdir(kbRoot, { recursive: true });
  const opts = {
    kbRoot,
    configKbRoot: kbRoot,
    kbRootSource: "config",
    kbSettingsBase: base,
    defaultKb: "default",
    jobs: null,
  };

  const initial = await call(opts, makeReq({ url: "/kb/api/settings" }));
  assert.equal(initial.res.status, 200);
  assert.equal(initial.json.kbRoot, kbRoot);
  assert.equal(initial.json.savedKbRoot, "");
  assert.equal(initial.json.restartRequired, false);

  const nextRoot = join(base, "next-root");
  const saved = await call(opts, makeReq({
    method: "PUT",
    url: "/kb/api/settings",
    body: { kbRoot: nextRoot },
  }));
  assert.equal(saved.res.status, 200);
  assert.equal(saved.json.savedKbRoot, nextRoot);
  assert.equal(saved.json.kbRoot, kbRoot, "运行中的生效目录不热切换");
  assert.equal(saved.json.restartRequired, true);
  assert.equal(await readKbRootSetting({ base }), nextRoot);

  const cleared = await call(opts, makeReq({
    method: "PUT",
    url: "/kb/api/settings",
    body: { kbRoot: "" },
  }));
  assert.equal(cleared.res.status, 200);
  assert.equal(cleared.json.savedKbRoot, "");
  assert.equal(cleared.json.restartRequired, false);
  assert.equal(await readKbRootSetting({ base }), null);
});

test("API：非法路径返回 400", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "kb-settings-api-bad-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const kbRoot = join(base, "current-root");
  await mkdir(kbRoot, { recursive: true });
  const opts = { kbRoot, configKbRoot: kbRoot, kbSettingsBase: base, defaultKb: "default" };
  const { res, json } = await call(opts, makeReq({
    method: "PUT",
    url: "/kb/api/settings",
    body: { kbRoot: "relative/path" },
  }));
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "INVALID_KBROOT");
});

test("status API 带上根目录来源", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "kb-settings-status-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const kbRoot = join(base, "root");
  const opts = { kbRoot, configKbRoot: kbRoot, kbRootSource: "config", kbSettingsBase: base, defaultKb: "default" };
  const { json } = await call(opts, makeReq({ url: "/kb/api/status" }));
  assert.equal(json.kbRoot, kbRoot);
  assert.equal(json.kbRootSource, "config");
  assert.equal(json.configKbRoot, kbRoot);
});
