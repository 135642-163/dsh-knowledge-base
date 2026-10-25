/**
 * 查重精度回归：标题相似但不同的文件不能被自动跳过。
 * 这些用例直接覆盖 2026-10-19 上传报告中真实发生的误判。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDuplicates, titleKeys } from "../lib/dedup.js";

async function makeKb(root, name, titles, manifestName = name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const docs = titles.map((title, i) => ({
    id: `doc${i}`,
    title,
    type: "text",
    status: "ready",
    chars: 1200,
    parts: 1,
    version: 1,
  }));
  await writeFile(
    join(dir, "kb.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: manifestName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        docs,
      },
      null,
      2
    ),
    "utf8"
  );
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "kb-dedup-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("common organization prefix is not treated as a duplicate", async () => {
  await withRoot(async (root) => {
    await makeKb(root, "变电试验", [
      "国网浙江省电力有限公司关于印发组合电器全过程质量管控提升措施的通知",
    ]);
    await makeKb(root, "电能质量", []);
    const files = [
      {
        sourcePath: "/tmp/x.doc",
        relKey: "x.doc",
        title: "国网浙江省电力有限公司电能质量管理规定 浙电规〔2020〕1号",
      },
    ];
    const r = await scanDuplicates({ root, targetKb: "电能质量", files });
    assert.equal(r.kept.length, 1);
    assert.equal(r.duplicates.length, 0);
    assert.equal((r.similar ?? []).length, 0, "not even a similar match should be reported");
  });
});

test("exact same title is still a same-kb duplicate", async () => {
  await withRoot(async (root) => {
    await makeKb(root, "标准", ["国网浙江省电力有限公司电能质量管理规定"]);
    const files = [
      {
        sourcePath: "/tmp/y.doc",
        relKey: "y.doc",
        title: "1.国网浙江省电力有限公司电能质量管理规定",
      },
    ];
    const r = await scanDuplicates({ root, targetKb: "标准", files });
    assert.equal(r.kept.length, 0);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].scope, "same-kb");
  });
});

test("different parts of a series are not duplicates", async () => {
  await withRoot(async (root) => {
    await makeKb(root, "标准", ["电能质量评估技术导则 第1部分"]);
    const files = [
      {
        sourcePath: "/tmp/p2.pdf",
        relKey: "p2.pdf",
        title: "电能质量评估技术导则 第2部分",
      },
    ];
    const r = await scanDuplicates({ root, targetKb: "标准", files });
    assert.equal(r.kept.length, 1);
    assert.equal(r.duplicates.length, 0);
    assert.equal((r.similar ?? []).length, 0);
  });
});

test("prefix-only title is reported as similar but still imported", async () => {
  await withRoot(async (root) => {
    await makeKb(root, "标准", ["电能质量评估技术导则"]);
    const files = [
      {
        sourcePath: "/tmp/trial.pdf",
        relKey: "trial.pdf",
        title: "电能质量评估技术导则（试行）",
      },
    ];
    const r = await scanDuplicates({ root, targetKb: "标准", files });
    assert.equal(r.kept.length, 1, "a similar title must not be auto-skipped");
    assert.equal(r.duplicates.length, 0);
    assert.equal((r.similar ?? []).length, 1);
    assert.equal(r.similar[0].title, "电能质量评估技术导则（试行）");
  });
});

test("allowCrossKb still imports an exact cross-kb duplicate", async () => {
  await withRoot(async (root) => {
    await makeKb(root, "标准", ["供电营业规则"]);
    await makeKb(root, "电能质量", []);
    const files = [{ sourcePath: "/tmp/rule.pdf", relKey: "rule.pdf", title: "供电营业规则" }];
    const blocked = await scanDuplicates({ root, targetKb: "电能质量", files });
    assert.equal(blocked.duplicates.length, 1);
    assert.equal(blocked.duplicates[0].scope, "cross-kb");
    const allowed = await scanDuplicates({
      root,
      targetKb: "电能质量",
      files,
      allowCrossKb: true,
    });
    assert.equal(allowed.kept.length, 1);
  });
});

test("same directory is same-kb even when manifest.name differs", async () => {
  await withRoot(async (root) => {
    await makeKb(root, "目录名", ["电能质量评估技术导则"], "显示名");
    const files = [
      { sourcePath: "/tmp/guide.pdf", relKey: "guide.pdf", title: "电能质量评估技术导则" },
    ];
    const r = await scanDuplicates({ root, targetKb: "目录名", files });
    assert.equal(r.kept.length, 0);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].scope, "same-kb");
    // 报告里仍用清单显示名，避免用户看到内部目录名。
    assert.equal(r.duplicates[0].matched[0].kb, "显示名");
  });
});

test("titleKeys extracts part markers", () => {
  assert.equal(titleKeys("电能质量评估技术导则 第2部分").part, "部分:2");
  assert.equal(titleKeys("国家电网公司变电检测管理规定（试行） 第36分册 主回路电阻测量细则").part, "分册:36");
  assert.equal(titleKeys("GB/T 12325-2008 电能质量 供电电压偏差").part, "");
});
