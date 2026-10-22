/**
 * 软删除文档仍在 markdown/ 下；ripgrep 输出解析必须按 manifest 过滤。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseRgOutput } from "../lib/query.js";

function matchLine(docId, text) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: `/kb/markdown/${docId}/${docId}.md` },
      line_number: 3,
      lines: { text: `${text}\n` },
    },
  });
}

test("parseRgOutput drops matches from soft-deleted docs", () => {
  const manifest = {
    docs: [
      { id: "live", title: "在用文档", status: "ready" },
      { id: "gone", title: "已删文档", status: "deleted", deletedAt: "2026-10-22T00:00:00Z" },
    ],
  };
  const r = parseRgOutput(
    [matchLine("live", "电压偏差"), matchLine("gone", "电压偏差")].join("\n"),
    { manifest, kbDir: "/kb" }
  );
  assert.equal(r.total, 1);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].docId, "live");
});
