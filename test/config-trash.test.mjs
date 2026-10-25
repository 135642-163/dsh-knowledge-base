/**
 * 0.25.0 复审修复：固定 trashRetentionDays 的默认值（0 = 关闭）与夹取边界。
 * Config 是导出 schema；夹取发生在 apply → registerKbWeb，因此用假 ctx 捕获
 * web 路由，再触发 GET /trash/docs，从实际清理结果验证 0 / 3650 边界。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/index.js";
import { createKb } from "../lib/kbmeta.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";
import { resetTrashSweepForTests } from "../lib/web/api.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function isoDaysAgo(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function deletedDoc(id, title, deletedAt) {
  return {
    id,
    title,
    type: "pdf-text",
    status: "deleted",
    deletedFromStatus: "ready",
    deletedAt,
    chars: 10,
    parts: 1,
    version: 1,
  };
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq(url = "/kb/api/trash/docs") {
  return {
    method: "GET",
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
    },
    async *[Symbol.asyncIterator]() {},
  };
}

/** 假宿主：捕获 registerKbWeb 注入的 /kb/api 路由，并等待启动清理完成。 */
function fakeCtx() {
  const routes = [];
  let pending = Promise.resolve();
  const ctx = {
    tools: { register() {} },
    systemPrompt: { section() {} },
    get() { return undefined; },
    inject(names, callback) {
      pending = Promise.resolve(callback({
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
        effect() {},
        get: ctx.get,
      }));
    },
    effect() {},
    subprocess: { spawn() { throw new Error("unused"); } },
  };
  return { ctx, routes, ready: () => pending };
}

async function runWithConfig(config, docs) {
  resetTrashSweepForTests();
  const root = await mkdtemp(join(tmpdir(), "kb-config-trash-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: "甲库" });
  const manifest = await readManifest(dir);
  manifest.docs.push(...docs);
  await writeManifestAtomic(dir, manifest);

  const { ctx, routes, ready } = fakeCtx();
  await apply(ctx, { kbRoot, defaultKb: "甲库", ...config });
  await ready();

  const route = routes.find((item) => item.path === "/kb/api");
  assert.ok(route, "应注册 /kb/api 路由");
  const res = makeRes();
  await route.handler(makeReq(), res);
  assert.equal(res.status, 200);

  const after = await readManifest(dir);
  return after.docs ?? [];
}

test("trashRetentionDays defaults to 0 and keeps the sweeper off", async () => {
  assert.equal(Config({}).trashRetentionDays, 0);

  const docs = await runWithConfig({}, [
    deletedDoc("old", "很久以前", isoDaysAgo(4000)),
  ]);
  assert.equal(docs.some((item) => item.id === "old"), true);
});

test("trashRetentionDays clamps to 0..3650 and rounds before sweeping", async () => {
  // 下界：负数按 0（关闭）处理，远超保留期的资料也不会被清理。
  const lower = await runWithConfig({ trashRetentionDays: -10 }, [
    deletedDoc("old", "下界旧资料", isoDaysAgo(4000)),
  ]);
  assert.equal(lower.some((item) => item.id === "old"), true);

  // 上界：100000 夹到 3650。4000 天前清理，3000 天前保留（若未夹取会一起删）。
  const upper = await runWithConfig({ trashRetentionDays: 100000 }, [
    deletedDoc("over", "超过 3650 天", isoDaysAgo(4000)),
    deletedDoc("under", "未超过 3650 天", isoDaysAgo(3000)),
  ]);
  assert.equal(upper.some((item) => item.id === "over"), false);
  assert.equal(upper.some((item) => item.id === "under"), true);

  // 小数按四舍五入：1.6 → 2 天；3 天前清理、1 天前保留。
  const rounded = await runWithConfig({ trashRetentionDays: 1.6 }, [
    deletedDoc("over", "超过 2 天", isoDaysAgo(3)),
    deletedDoc("under", "未超过 2 天", isoDaysAgo(1)),
  ]);
  assert.equal(rounded.some((item) => item.id === "over"), false);
  assert.equal(rounded.some((item) => item.id === "under"), true);
});
