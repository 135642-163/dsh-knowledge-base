import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

async function makeTools() {
  const root = await mkdtemp(join(tmpdir(), "kb-skip-msg-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  await apply({
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  }, { kbRoot, defaultKb: "默认库", partMaxChars: 500 });
  return { root, tools };
}

function render(tool, imported, extra = {}) {
  return tool.output.render({}, {
    kb: "默认库", inline: true, files: imported.length,
    skipped: imported.filter((item) => item.skipped).length,
    imported,
    ...extra,
  })[0].text;
}

test("skipped 行按 reason 显示，不再一律说正在导入中", async () => {
  const { root, tools } = await makeTools();
  try {
    const importTool = tools.get("kb_import");
    const duplicate = render(importTool, [{
      docId: "d1", title: "重复资料", type: "skipped", skipped: true,
      reason: "duplicate", duplicate: { title: "已有资料" },
    }]);
    assert.match(duplicate, /重复/);
    assert.doesNotMatch(duplicate, /正在导入中/);
    assert.match(duplicate, /原因见下/);

    const importing = render(importTool, [{
      docId: "d2", title: "并发资料", type: "skipped", skipped: true, reason: "importing",
    }]);
    assert.match(importing, /正在导入中/);

    const unchanged = render(importTool, [{
      docId: "d3", title: "未变资料", type: "text", skippedUnchanged: true, version: 1,
    }]);
    assert.match(unchanged, /内容未变化，未新建版本/);
    assert.match(unchanged, /内容未变化（未新建版本）/);

    const similar = render(importTool, [{
      docId: "d4", title: "相似但重复", type: "skipped", skipped: true,
      reason: "duplicate", duplicate: { title: "已有相似" },
    }], { similar: [{ title: "相似但重复", scope: "same-kb", matched: [] }] });
    assert.match(similar, /已跳过/);
    assert.doesNotMatch(similar, /已照常导入/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
