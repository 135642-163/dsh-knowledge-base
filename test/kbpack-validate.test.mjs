/**
 * kbpack 安全校验：坏包 / 路径穿越 / 符号链接 / 版本过高 / dry-run 不落盘。
 * 用 JSZip 现场构造恶意包，不依赖二进制夹具。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { apply } from "../lib/index.js";
import { SCHEMA_VERSION } from "../lib/store.js";
import { inspectKbpack, validateKbpackManifest } from "../lib/kbpack.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-kbpack-validate-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "默认库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  return { root, kbRoot, tools, exec };
}

function manifestFor(overrides = {}) {
  return {
    format: "kbpack/v1",
    schemaVersion: SCHEMA_VERSION,
    parserVersion: "test",
    kbName: "包库",
    exportedAt: new Date().toISOString(),
    exporter: { plugin: "dsh-knowledge-wiki", version: "0.33.0" },
    withSources: false,
    counts: { docs: 1, notes: 0, sourceFiles: 0, contentBytes: 10 },
    docs: [
      {
        id: "abcdef123456",
        title: "包内资料",
        standardNo: "",
        type: "text",
        stage: "unknown",
        sourceHash: "",
        textHash: "t",
        contentHash: "t",
        chars: 4,
        pages: 0,
        parts: 1,
        trust: "unknown",
        sourceFile: "资料.txt",
        hasSource: false,
        hasMarkdown: true,
        version: 1,
        updatedAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

async function writePack(root, { manifest = manifestFor(), markdown = true, extra = [] } = {}) {
  const zip = new JSZip();
  if (manifest !== null) zip.file("manifest.json", JSON.stringify(manifest));
  if (markdown) zip.file("markdown/abcdef123456/abcdef123456.md", "# 包内资料\n\n正文。\n");
  for (const [name, content, options] of extra) zip.file(name, content, options);
  const out = join(root, `pack-${Math.random().toString(16).slice(2)}.zip`);
  await writeFile(out, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  return out;
}

test("坏包：不是 zip / 缺 manifest / format 错", async () => {
  const { root } = await setup();
  try {
    const notZip = join(root, "bad.zip");
    await writeFile(notZip, "this is not a zip", "utf8");
    await assert.rejects(() => inspectKbpack(notZip), (error) => error.code === "KBPACK_INVALID");

    const missing = await writePack(root, { manifest: null });
    await assert.rejects(() => inspectKbpack(missing), (error) => error.code === "KBPACK_INVALID");

    const wrongFormat = await writePack(root, { manifest: manifestFor({ format: "zip/v1" }) });
    await assert.rejects(() => inspectKbpack(wrongFormat), (error) => error.code === "KBPACK_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("包格式版本高于插件：拒绝而不是静默降级", async () => {
  const { root } = await setup();
  try {
    const pack = await writePack(root, { manifest: manifestFor({ schemaVersion: SCHEMA_VERSION + 1 }) });
    await assert.rejects(
      () => inspectKbpack(pack),
      (error) => error.code === "KBPACK_VERSION_TOO_NEW" && error.details.supported === SCHEMA_VERSION
    );
    assert.throws(
      () => validateKbpackManifest(manifestFor({ schemaVersion: SCHEMA_VERSION + 1 })),
      (error) => error.code === "KBPACK_VERSION_TOO_NEW"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("路径穿越与绝对路径：拒绝解压", async () => {
  const { root } = await setup();
  try {
    const traverse = await writePack(root, {
      extra: [["markdown/../../evil.md", "evil"]],
    });
    await assert.rejects(
      () => inspectKbpack(traverse),
      (error) => error.code === "KBPACK_UNSAFE_PATH"
    );

    const absolute = await writePack(root, {
      extra: [["/tmp/kbpack-evil.md", "evil"]],
    });
    await assert.rejects(
      () => inspectKbpack(absolute),
      (error) => error.code === "KBPACK_UNSAFE_PATH"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("符号链接：拒绝导入", async () => {
  const { root } = await setup();
  try {
    const pack = await writePack(root, {
      extra: [["sources/abcdef123456.pdf", "x", { unixPermissions: 0o120777 }]],
    });
    await assert.rejects(
      () => inspectKbpack(pack),
      (error) => error.code === "KBPACK_SYMLINK"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("声明有正文但包内缺失：拒绝", async () => {
  const { root } = await setup();
  try {
    const pack = await writePack(root, { markdown: false });
    await assert.rejects(
      () => inspectKbpack(pack),
      (error) => error.code === "KBPACK_MISSING_MARKDOWN"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dryRun 只预演，不创建目标库", async () => {
  const { root, kbRoot, tools, exec } = await setup();
  try {
    const pack = await writePack(root);
    const result = await tools.get("kb_import_package").execute(
      { path: pack, kb: "预演库", dryRun: true },
      exec
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.created, 1);
    await assert.rejects(() => stat(join(kbRoot, "预演库")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("包内既无正文也无原件：跳过并提示，不阻断其它文档", async () => {
  const { root, tools, exec } = await setup();
  try {
    const manifest = manifestFor();
    manifest.docs.push({
      id: "ffffffffffff",
      title: "空壳文档",
      standardNo: "",
      type: "text",
      stage: "unknown",
      sourceHash: "",
      textHash: "",
      contentHash: "",
      chars: 0,
      pages: 0,
      parts: 1,
      trust: "unknown",
      sourceFile: "",
      hasSource: false,
      hasMarkdown: false,
      version: 0,
      updatedAt: "",
    });
    const pack = await writePack(root, { manifest });
    const result = await tools.get("kb_import_package").execute({ path: pack, kb: "跳过库" }, exec);
    assert.equal(result.ok, true);
    assert.equal(result.created, 1);
    assert.equal(result.unimportable, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("空壳文档")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_import_package 输出字段与 schema 一致（宿主会拒绝多余字段）", async () => {
  const { root, tools, exec } = await setup();
  try {
    const tool = tools.get("kb_import_package");
    const declared = new Set(Object.keys(tool.output.schema.properties));
    const pack = await writePack(root);
    const result = await tool.execute({ path: pack, kb: "字段库" }, exec);
    for (const key of Object.keys(result)) {
      assert.ok(declared.has(key), `返回值多出未声明字段: ${key}`);
    }
    const dry = await tool.execute({ path: pack, kb: "字段库", mode: "merge", dryRun: true }, exec);
    for (const key of Object.keys(dry)) {
      assert.ok(declared.has(key), `dry-run 返回值多出未声明字段: ${key}`);
    }
    assert.equal(dry.created, 0, "target kb was just created by the actual import; dry-run sees identical doc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import 结果中的本机路径不泄漏到返回值", async () => {
  const { root, tools, exec } = await setup();
  try {
    const pack = await writePack(root);
    const result = await tools.get("kb_import_package").execute({ path: pack, kb: "路径库" }, exec);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(result.package.path, undefined, "package output must not echo the local path");
    assert.ok(result.package.filename);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
