/**
 * 0.14.0 标准号检索归一化：GB/T = GBT = GB_T = GB∕T，年份分隔符 -—–~～，
 * 且 GB 与 GB/T 不互相混淆。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { expandStdQuery } from "../lib/query.js";

test("expandStdQuery handles common standard-number spellings", () => {
  const rx = expandStdQuery("GBT 11032");
  assert.ok(rx);
  const re = new RegExp(rx, "i");
  assert.match("GB/T 11032-2020", re);
  assert.match("GBT 11032", re);
  assert.doesNotMatch("GB/T 11032.2-2020", re, "partial number must not match");
  assert.doesNotMatch("GB 11032", re, "GB must not match GB/T");

  const yearRx = new RegExp(expandStdQuery("GB/T 11032-2020"), "i");
  assert.match("GB/T 11032-2020", yearRx);
  assert.match("GB/T 11032—2020", yearRx);
  assert.match("GB/T11032-2020", yearRx);
  assert.doesNotMatch("GB/T 11032-2019", yearRx);

  assert.ok(expandStdQuery("GB∕T 11032"), "U+2215 must be normalized");
  assert.match("Q/GDW 10650.1-2019", new RegExp(expandStdQuery("Q_GDW 10650.1"), "i"));
  assert.match("DL/T 506-2018", new RegExp(expandStdQuery("DL/T 506"), "i"));
  assert.match("DL/T 506-2018", new RegExp(expandStdQuery("DLT 506"), "i"));

  assert.equal(expandStdQuery("电压 偏差"), null, "plain Chinese query is untouched");
  assert.equal(expandStdQuery("GB/T \\d+"), null, "explicit regex is untouched");
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-query-std-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
    subprocess: {
      spawn({ argv, cwd }) {
        const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = Buffer.alloc(0);
        child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
        const done = new Promise((resolve) =>
          child.on("close", (exitCode, signal) => resolve({ exitCode, signal }))
        );
        return {
          done,
          collected: {
            stdout: { readFrom: (off) => ({ text: out.subarray(off).toString("utf8"), nextOffset: out.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
          },
          terminate: () => child.kill(),
        };
      },
    },
  };
  await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  const src = join(root, "标准.md");
  await writeFile(
    src,
    "# GB/T 11032-2020\n\n交流无间隙金属氧化物避雷器。\n\n# 范围\n\n本标准适用于 11032 系列产品。\n",
    "utf8"
  );
  await tools.get("kb_import").execute({ path: src, kb: "测试库", title: "GB/T 11032-2020 避雷器" }, exec);
  return { root, tools, exec };
}

test("kb_query expands standard-number variants", async () => {
  const { root, tools, exec } = await setup();
  try {
    const hit = await tools.get("kb_query").execute(
      { kb: "测试库", pattern: "GBT 11032" },
      exec
    );
    assert.ok(hit.total > 0, "GBT 11032 must hit GB/T 11032-2020");
    assert.ok(hit.expandedPattern, "expandedPattern must be reported");
    const text = tools.get("kb_query").output.render({ kb: "测试库" }, hit)[0].text;
    assert.match(text, /变体扩展检索/);

    const plain = await tools.get("kb_query").execute(
      { kb: "测试库", pattern: "GB 11032" },
      exec
    );
    assert.equal(plain.total, 0, "GB 11032 must not match GB/T 11032");

    const text2 = await tools.get("kb_query").execute(
      { kb: "测试库", pattern: "避雷器" },
      exec
    );
    assert.ok(text2.total > 0);
    assert.equal(text2.expandedPattern, undefined, "plain queries are not expanded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
