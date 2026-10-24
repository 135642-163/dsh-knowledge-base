/**
 * 临时/锁文件：是否跳过的判定、导入管线/上传批次/工作台分类、kb_lint 与 kb_import。
 * 规则来源：Office 所有者文件（~$）、LibreOffice 锁（.~lock.）、系统垃圾
 * （Thumbs.db / desktop.ini / .DS_Store）；普通 .tmp 不跳过。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isTempFileName } from "../lib/temp-files.js";
import { collectSources } from "../lib/pipeline.js";
import { assertSupportedType, addBatchFile, buildImportFiles, validateRelPath } from "../lib/web/upload.js";
import { lintManifest } from "../lib/lint.js";
import { apply } from "../lib/index.js";
import { classifyFiles, isTempFileName as uiIsTempFileName } from "../ui/upload-core.js";

async function withTempRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "kb-temp-files-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("isTempFileName: Office/LibreOffice/系统垃圾各类写法", () => {
  const tempNames = [
    "~$a.docx",
    "~$节 试验作用.docx",
    "~$x.tmp", // .tmp 只在带 ~$ 前缀时命中
    ".~lock.a.docx#",
    ".~lock.x",
    "Thumbs.db",
    "thumbs.DB",
    "DESKTOP.INI",
    ".DS_Store",
    ".ds_store",
  ];
  for (const name of tempNames) assert.equal(isTempFileName(name), true, name);

  const normalNames = [
    "a.docx",
    "report.tmp", // 不广泛跳过 .tmp
    ".tmp",
    "thumbs.db.bak",
    "desktop.ini.bak",
    "$a.docx",
    "~a.docx",
    "README",
    "",
  ];
  for (const name of normalNames) assert.equal(isTempFileName(name), false, name);
});

test("isTempFileName: 只按 basename 匹配，目录名不触发跳过", () => {
  assert.equal(isTempFileName("资料/~$a.docx"), true);
  assert.equal(isTempFileName("C:\\资料\\~$a.docx"), true);
  // 上级目录看起来像临时文件，但文件本身正常 → 不跳过
  assert.equal(isTempFileName("~$归档/正常资料.md"), false);
  assert.equal(isTempFileName(".~lock.dir/a.md"), false);
  assert.equal(isTempFileName("Thumbs.db/a.md"), false);
});

test("工作台的分类规则与服务端一致，并跳过临时文件", () => {
  const names = ["~$a.docx", ".~lock.x", "Thumbs.db", "a.md", "report.tmp", "资料/正常.md"];
  for (const name of names) {
    assert.equal(uiIsTempFileName(name), isTempFileName(name), name);
  }
  const { accepted, rejected, skipped } = classifyFiles(
    ["~$a.docx", "Thumbs.db", "a.md", "report.tmp"].map((name) => ({ name, size: 1 })),
    { maxBytes: 10, maxFiles: 10, extensions: [".md", ".docx", ".tmp"] }
  );
  assert.deepEqual(accepted.map((item) => item.path), ["a.md", "report.tmp"]);
  assert.deepEqual(rejected, []);
  assert.deepEqual(skipped.map((item) => item.path), ["~$a.docx", "Thumbs.db"]);
  // 目录上传时 webkitRelativePath 也只按 basename 判断
  const nested = classifyFiles([{ name: "a.md", webkitRelativePath: "~$目录/a.md", size: 1 }], {
    maxBytes: 10,
    maxFiles: 10,
    extensions: [".md"],
  });
  assert.deepEqual(nested.accepted.map((item) => item.path), ["~$目录/a.md"]);
});

test("collectSources 目录：跳过临时文件并回调 onSkip，正常文件照常收集", async () => {
  await withTempRoot(async (root) => {
    const dir = join(root, "资料");
    await mkdir(dir);
    await writeFile(join(dir, "~$a.docx"), "");
    await writeFile(join(dir, ".~lock.x"), "");
    await writeFile(join(dir, "Thumbs.db"), "");
    await writeFile(join(dir, "a.md"), "# a\n");

    const skipped = [];
    const files = await collectSources(dir, { onSkip: (full) => skipped.push(full) });
    assert.deepEqual(files.map((file) => file.relKey), ["a.md"]);
    assert.equal(skipped.length, 3);
    assert.deepEqual(
      skipped.map((full) => basename(full)).sort(),
      [".~lock.x", "Thumbs.db", "~$a.docx"].sort()
    );
  });
});

test("collectSources 目录：临时文件不占 maxFiles 额度", async () => {
  await withTempRoot(async (root) => {
    const dir = join(root, "额度");
    await mkdir(dir);
    await writeFile(join(dir, "~$a.docx"), "");
    await writeFile(join(dir, "a.md"), "# a\n");
    const files = await collectSources(dir, { maxFiles: 1 });
    assert.deepEqual(files.map((file) => file.relKey), ["a.md"]);
  });
});

test("collectSources 单文件：本身是临时文件时报错", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "~$a.docx");
    await writeFile(file, "");
    await assert.rejects(collectSources(file), /临时\/锁文件不支持导入：~\$a\.docx/);
    await assert.rejects(collectSources(join(root, "Thumbs.db")), /路径不存在/);
  });
});

test("collectSources 目录：只有临时文件时报错并给出数量", async () => {
  await withTempRoot(async (root) => {
    const dir = join(root, "只有临时文件");
    await mkdir(dir);
    await writeFile(join(dir, "~$a.docx"), "");
    await writeFile(join(dir, ".~lock.x"), "");
    await assert.rejects(
      collectSources(dir),
      /目录中没有可导入的文件（已跳过 2 个临时文件）/
    );
  });
});

test("上传校验：validateRelPath / assertSupportedType 都返回 TEMP_FILE(415)", () => {
  const expectTemp = (fn, name) => {
    assert.throws(fn, (error) => {
      assert.equal(error.code, "TEMP_FILE");
      assert.equal(error.status, 415);
      assert.match(error.message, new RegExp(`临时/锁文件不支持导入：${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      return true;
    });
  };
  expectTemp(() => validateRelPath("~$a.docx"), "~$a.docx");
  expectTemp(() => validateRelPath("资料/Thumbs.db"), "Thumbs.db");
  expectTemp(() => assertSupportedType("~$a.docx"), "~$a.docx");
  // 普通文件名仍按原逻辑通过/按扩展名拒绝
  assert.equal(validateRelPath("资料/a.md"), "资料/a.md");
  assert.equal(assertSupportedType("a.md"), ".md");
  assert.equal(validateRelPath("report.tmp"), "report.tmp");
  assert.throws(() => assertSupportedType("report.tmp"), (error) => error.code === "UNSUPPORTED_TYPE");
});

test("buildImportFiles 防御性排除批次里的临时/锁文件", () => {
  const files = buildImportFiles("/tmp/kb-temp-fixture", {
    batchId: "b-0123456789ab",
    files: [
      { path: "~$a.docx", size: 1 },
      { path: "资料/Thumbs.db", size: 1 },
      { path: "ok.md", size: 2 },
    ],
  });
  assert.deepEqual(files.map((file) => file.relKey), ["ok.md"]);
});

test("addBatchFile 在读取批次前就拒绝临时文件", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      addBatchFile({
        kbDir: join(root, "kb"),
        batchId: "b-0123456789ab",
        relPath: "~$a.docx",
        source: Buffer.from("x"),
      }),
      (error) => error.code === "TEMP_FILE" && error.status === 415
    );
  });
});

test("lintManifest：temp-files 组只列临时/锁文件文档", () => {
  const manifest = {
    schemaVersion: 3,
    name: "临时文件库",
    docs: [
      {
        id: "t1",
        title: "~$节 试验作用.docx",
        type: "docx",
        status: "ready",
        sourceFile: "~$节 试验作用.docx",
        summary: "有摘要",
      },
      {
        id: "n1",
        title: "正常资料",
        type: "text",
        status: "ready",
        sourceFile: "资料/正常资料.md",
        summary: "有摘要",
      },
    ],
  };
  const report = lintManifest(manifest, { kbName: "临时文件库", hasSchema: true });
  const group = report.groups.find((item) => item.code === "temp-files");
  assert.ok(group, "temp-files group must exist");
  assert.equal(group.severity, "warning");
  assert.equal(group.label, "临时/锁文件");
  assert.equal(group.count, 1);
  assert.deepEqual(group.items, [
    {
      docId: "t1",
      title: "~$节 试验作用.docx",
      detail: "~$节 试验作用.docx",
    },
  ]);
  assert.match(group.hint, /kb_remove/);
  assert.equal(report.counts.tempFiles, 1);

  const clean = lintManifest(
    { ...manifest, docs: [manifest.docs[1]] },
    { kbName: "临时文件库", hasSchema: true }
  );
  assert.equal(clean.groups.some((item) => item.code === "temp-files"), false);
});

test("kb_import 跳过临时文件并在结果/渲染里报告数量", async () => {
  await withTempRoot(async (root) => {
    const kbRoot = join(root, "kb-root");
    await mkdir(kbRoot, { recursive: true });
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "a.txt"), "正常文档内容。\n", "utf8");
    await writeFile(join(src, "~$b.docx"), "");
    await writeFile(join(src, "Thumbs.db"), "");

    const tools = new Map();
    const ctx = {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
    };
    await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 2000 });
    const exec = {
      agent: { session: { header: { cwd: root } } },
      signal: new AbortController().signal,
    };

    const result = await tools.get("kb_import").execute({ path: src, kb: "测试库" }, exec);
    assert.equal(result.files, 1);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skippedTempFiles, 2);

    const render = tools.get("kb_import").output.render;
    const text = render({ path: src, kb: "测试库" }, result)[0].text;
    assert.match(text, /已跳过 2 个临时\/锁文件/);
  });
});
