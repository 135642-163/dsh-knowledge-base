/**
 * 标准缺口台账：未收录（排除站外体系）/分册歧义跨轮累计，命中后自动移除。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeStdGaps, readStdGaps, stdGapSummary, updateStdGaps, STD_GAPS_FILE,
} from "../lib/gaps.js";

function notFound({ number = "436", prefix = "DL", offSite = false } = {}) {
  return {
    key: `${prefix}:${number}`,
    number,
    prefix,
    offSite,
    docs: [{ title: `DL/T ${number}-2021 测试标准`, standardNo: `DL/T ${number}-2021`, year: 2021 }],
  };
}

function ambiguous({ number = "20840", prefix = "GB", siteNo = "GB/T 20840.10-2025" } = {}) {
  return {
    key: `${prefix}:${number}`,
    number,
    prefix,
    siteNo,
    docs: [{ title: `GB/T ${number}-2007 互感器`, standardNo: `GB/T ${number}-2007` }],
  };
}

test("未收录（非站外）与分册歧义入账；站外体系不入账", () => {
  const result = mergeStdGaps({ items: {} }, {
    notFound: [notFound(), notFound({ number: "618", prefix: "QGDW", offSite: true })],
    ambiguous: [ambiguous()],
  });
  assert.equal(result.active, 2);
  assert.equal(result.added.length, 2);
  const items = Object.values(result.ledger.items);
  const dl = items.find((item) => item.prefix === "DL");
  assert.equal(dl.reason, "notfound");
  assert.equal(dl.rounds, 1);
  assert.match(dl.title, /DL\/T 436/);
  const gb = items.find((item) => item.prefix === "GB");
  assert.equal(gb.reason, "ambiguous");
  assert.equal(gb.siteHit, "GB/T 20840.10-2025");
});

test("跨轮累计 rounds，站点收录后自动移除", () => {
  const first = mergeStdGaps({ items: {} }, { notFound: [notFound()] }).ledger;
  const second = mergeStdGaps(first, { notFound: [notFound()] });
  assert.equal(second.ledger.items["DL:436"].rounds, 2);
  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 1);

  const third = mergeStdGaps(second.ledger, {
    notFound: [],
    currents: [{ number: "436", prefix: "DL" }],
  });
  assert.equal(third.active, 0);
  assert.equal(third.removed.length, 1);
  assert.equal(third.removed[0].rounds, 2);
});

test("台账落盘、读回与摘要；内容不变不重写", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-gaps-"));
  try {
    const summary = await updateStdGaps(root, { notFound: [notFound()], ambiguous: [ambiguous()] });
    assert.equal(summary.active, 2);
    assert.equal(summary.notFound, 1);
    assert.equal(summary.ambiguous, 1);
    const ledger = await readStdGaps(root);
    assert.equal(Object.keys(ledger.items).length, 2);
    const raw = JSON.parse(await readFile(join(root, STD_GAPS_FILE), "utf8"));
    assert.equal(raw.version, 1);
    assert.ok(raw.updatedAt);

    const again = await stringifyFile(root);
    const second = await updateStdGaps(root, { notFound: [notFound()], ambiguous: [ambiguous()] });
    assert.equal(second.active, 2);
    assert.notEqual(await stringifyFile(root), again, "rounds changed → file rewritten");

    const brief = await stdGapSummary(root);
    assert.equal(brief.total, 2);
    assert.equal(brief.items.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function stringifyFile(root) {
  return readFile(join(root, STD_GAPS_FILE), "utf8");
}
