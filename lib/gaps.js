/**
 * 标准缺口台账（<kb>/.std-gaps.json）：跨轮追踪
 *  - 站点未收录（排除站外体系，如 Q/GDW、IEC、IEEE）；
 *  - 编号分册歧义（库内裸号 ↔ 站点分册）。
 *
 * 站点后续收录（current/update/released/superseded/newer-in-kb）时自动移除。
 * 只读写台账文件，不发网络请求；纯合并函数 mergeStdGaps 便于单测。
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STD_GAPS_FILE = ".std-gaps.json";
export const STD_GAPS_VERSION = 1;

function gapKey(prefix, number) {
  return `${String(prefix ?? "").trim() || "?"}:${String(number ?? "").trim() || "?"}`;
}

function entryKey(entry) {
  return gapKey(entry?.prefix, entry?.number);
}

function docTitle(entry) {
  return String(entry?.docs?.[0]?.title ?? entry?.siteTitle ?? entry?.title ?? "").slice(0, 200);
}

function docStdNo(entry) {
  return String(entry?.docs?.[0]?.standardNo ?? entry?.siteNo ?? entry?.number ?? "").slice(0, 80);
}

/**
 * 把一轮检查结果合并进台账。
 * @param prev 上一版台账 {version, updatedAt, items}
 * @param report runStdCheck 的 report
 * @returns {ledger, added, removed, updated, active}
 */
export function mergeStdGaps(prev, report, { now = new Date() } = {}) {
  const items = { ...(prev?.items ?? {}) };
  const added = [];
  const removed = [];
  const changed = [];
  const stamp = now.toISOString();
  const upsert = (entry, reason, extra = {}) => {
    const key = entryKey(entry);
    if (key === "?:?") return;
    const existing = items[key];
    const next = {
      key,
      stdNo: docStdNo(entry),
      prefix: String(entry?.prefix ?? ""),
      number: String(entry?.number ?? ""),
      title: docTitle(entry),
      reason,
      ...(extra.siteHit ? { siteHit: String(extra.siteHit).slice(0, 80) } : {}),
      ...(Number.isFinite(extra.docs) ? { docs: extra.docs } : {}),
      firstSeenAt: existing?.firstSeenAt ?? stamp,
      lastSeenAt: stamp,
      rounds: (Number(existing?.rounds) || 0) + 1,
    };
    items[key] = next;
    if (!existing) added.push(next);
    else changed.push(next);
  };

  for (const entry of report?.notFound ?? []) {
    // 站外体系（Q/GDW、IEC、IEEE…）站点本就不收，不算缺口。
    if (entry?.offSite === true) {
      const key = entryKey(entry);
      if (items[key]) {
        removed.push(items[key]);
        delete items[key];
      }
      continue;
    }
    upsert(entry, "notfound", { docs: entry?.docs?.length });
  }
  for (const entry of report?.ambiguous ?? []) {
    upsert(entry, "ambiguous", { siteHit: entry?.siteNo, docs: entry?.docs?.length });
  }
  for (const list of [
    report?.updates,
    report?.draftsReleased,
    report?.currents,
    report?.newerInKb,
    report?.superseded,
  ]) {
    for (const entry of list ?? []) {
      const key = entryKey(entry);
      if (items[key]) {
        removed.push(items[key]);
        delete items[key];
      }
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(items).sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-Hans-CN"))
  );
  return {
    ledger: {
      version: STD_GAPS_VERSION,
      updatedAt: stamp,
      items: sorted,
    },
    added,
    removed,
    updated: changed,
    active: Object.keys(sorted).length,
  };
}

export async function readStdGaps(kbDir) {
  try {
    const raw = JSON.parse(await readFile(join(kbDir, STD_GAPS_FILE), "utf8"));
    if (raw && typeof raw === "object" && raw.items && typeof raw.items === "object") return raw;
  } catch {
    /* 没有台账或损坏时当空台账 */
  }
  return { version: STD_GAPS_VERSION, updatedAt: "", items: {} };
}

/** 原子写台账；内容未变时不写盘。 */
export async function writeStdGaps(kbDir, ledger) {
  const file = join(kbDir, STD_GAPS_FILE);
  const text = JSON.stringify(ledger, null, 2);
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    current = "";
  }
  if (current === text) return false;
  const tmp = `${file}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

/** 检查结束后调用：读台账 → 合并 → 写回；返回本轮变化摘要。 */
export async function updateStdGaps(kbDir, report, { now = new Date() } = {}) {
  const prev = await readStdGaps(kbDir);
  const result = mergeStdGaps(prev, report, { now });
  await writeStdGaps(kbDir, result.ledger);
  return {
    active: result.active,
    added: result.added.length,
    removed: result.removed.length,
    updated: result.updated.length,
    notFound: Object.values(result.ledger.items).filter((item) => item.reason === "notfound").length,
    ambiguous: Object.values(result.ledger.items).filter((item) => item.reason === "ambiguous").length,
  };
}

/** 工作台/报告用：只读摘要。 */
export async function stdGapSummary(kbDir) {
  const ledger = await readStdGaps(kbDir);
  const items = Object.values(ledger.items ?? {});
  return {
    updatedAt: ledger.updatedAt ?? "",
    total: items.length,
    notFound: items.filter((item) => item.reason === "notfound").length,
    ambiguous: items.filter((item) => item.reason === "ambiguous").length,
    items: items.slice(0, 200),
  };
}
