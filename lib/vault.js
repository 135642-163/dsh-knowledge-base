/**
 * Obsidian Vault 导出：把知识库排成可直接用 Obsidian 打开的目录结构。
 *
 *   README.md            导出说明
 *   index.md             内容索引（双链）
 *   schema.md / log.md   维护规范 / 操作流水（存在时）
 *   raw/                 原始文件（includeSources=true 时）
 *   wiki/topics|entities|concepts|summaries|notes/<标题>.md   笔记（编译页）
 *   wiki/sources/<标题>.md                                    每份资料的摘要页
 *
 * 链接统一用 [[文件名]]（Obsidian 按文件名解析）；标题会做文件系统安全化并去重。
 * 资料页只放摘要/元数据/反链，正文回 raw/ 看原件，避免 Vault 体积翻倍。
 */
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { typeLabel, noteKindLabel } from "./labels.js";
import { frontmatterFor } from "./wiki.js";

const KIND_DIRS = {
  summary: "summaries",
  entity: "entities",
  concept: "concepts",
  topic: "topics",
  note: "notes",
};

function safeName(input, used, fallback = "untitled") {
  let base = String(input ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();
  if (!base) base = fallback;
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base} (${i})`;
    i += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function oneLine(text, max = 200) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function fmtDate(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "-";
}

function parseSourceRef(ref) {
  const [idPart, pagePart] = String(ref ?? "").split("#");
  const page = pagePart ? Number(String(pagePart).replace(/^p/i, "")) : null;
  return { id: idPart, page: Number.isInteger(page) && page > 0 ? page : null };
}

function backlinksFor(manifest, docId) {
  return (manifest.docs ?? []).filter(
    (d) =>
      d.type === "note" &&
      d.status === "ready" &&
      !d.deletedAt &&
      (Array.isArray(d.linksOut) && d.linksOut.includes(docId))
  );
}

/** 生成 Vault 的 index.md（带双链，比纯文本索引更适合 Obsidian）。 */
export function renderVaultIndex(manifest, nameById) {
  const docs = (manifest.docs ?? []).filter((d) => d.status === "ready" && !d.deletedAt);
  const notes = docs.filter((d) => d.type === "note");
  const sources = docs.filter((d) => d.type !== "note");
  const lines = [
    `# 知识库「${manifest.name}」`,
    "",
    `> 导出于 ${fmtDate(new Date().toISOString())}｜共 ${docs.length} 篇（笔记 ${notes.length}，资料 ${sources.length}）`,
    "> 编译页是模型沉淀的结论，优先阅读；资料页用于溯源。",
    "",
    "## 编译页（笔记）",
    "",
  ];
  if (notes.length === 0) lines.push("（暂无笔记）");
  const byKind = new Map();
  for (const doc of notes) {
    const kind = doc.kind ?? "note";
    const arr = byKind.get(kind) ?? [];
    arr.push(doc);
    byKind.set(kind, arr);
  }
  for (const [kind, list] of byKind) {
    lines.push(`### ${noteKindLabel(kind)}`, "");
    for (const doc of list.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"))) {
      const summary = oneLine(doc.summary, 120) || "（未编目）";
      lines.push(`- [[${nameById.get(doc.id)}]] — ${summary}`);
    }
    lines.push("");
  }
  lines.push("## 原始资料", "");
  if (sources.length === 0) lines.push("（暂无资料）");
  for (const doc of sources.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"))) {
    const summary = oneLine(doc.summary, 120) || "（未编目）";
    const meta = [typeLabel(doc.type), doc.pages ? `${doc.pages}页` : ""].filter(Boolean).join("，");
    lines.push(`- [[${nameById.get(doc.id)}]] — ${summary}（${meta}）`);
  }
  return lines.join("\n") + "\n";
}

function renderSourcePage(doc, manifest, { rawName, nameById }) {
  const frontmatter = [
    "---",
    `title: "${String(doc.title).replace(/"/g, '\\"')}"`,
    `type: ${doc.type}`,
    `doc_id: ${doc.id}`,
    `pages: ${doc.pages ?? 0}`,
    `chars: ${doc.chars ?? 0}`,
    ...(rawName ? [`raw: "raw/${rawName}"`] : []),
    ...(doc.summary ? [`summary: "${String(doc.summary).replace(/"/g, '\\"')}"`] : []),
    ...(Array.isArray(doc.tags) && doc.tags.length > 0 ? [`tags: [${doc.tags.join(", ")}]`] : []),
    `updated: ${fmtDate(doc.updatedAt)}`,
    "---",
    "",
  ].join("\n");
  const lines = [
    frontmatter,
    `# ${doc.title}`,
    "",
    doc.summary ? `> ${oneLine(doc.summary, 300)}` : "> （未编目）",
    "",
    `- 原始文件：${rawName ? `[[${rawName}]]` : "（本次导出未包含，可用 kb_export includeSources=true 重新导出）"}`,
    `- 类型：${typeLabel(doc.type)}${doc.pages ? `｜页数：${doc.pages}` : ""}｜字数：${doc.chars ?? 0}`,
    `- 插件溯源：doc_id \`${doc.id}\`｜版本 v${doc.version ?? 1}｜更新 ${fmtDate(doc.updatedAt)}`,
  ];
  const backlinks = backlinksFor(manifest, doc.id);
  if (backlinks.length > 0) {
    lines.push("", "## 被引用", "");
    for (const note of backlinks) {
      lines.push(`- [[${nameById.get(note.id)}]]（${noteKindLabel(note.kind)}）`);
    }
  }
  return lines.join("\n") + "\n";
}

function renderNotePage(doc, manifest, { nameById }) {
  const lines = [frontmatterFor(doc) || "", `# ${doc.title}`, ""];
  // 正文（合并版去掉首行 H1，避免与上方标题重复）
  lines.push(`<!-- 正文见知识库 markdown/${doc.id}/${doc.id}.md -->`, "");
  const body = doc.__body ?? "";
  lines.push(body);
  const sources = Array.isArray(doc.sources) ? doc.sources : [];
  if (sources.length > 0) {
    lines.push("", "## 依据来源", "");
    for (const ref of sources) {
      const { id, page } = parseSourceRef(ref);
      const target = (manifest.docs ?? []).find((d) => d.id === id);
      const label = target ? nameById.get(target.id) : id;
      lines.push(`- [[${label}]]${page ? `（第 ${page} 页）` : ""}`);
    }
  }
  const backlinks = backlinksFor(manifest, doc.id);
  if (backlinks.length > 0) {
    lines.push("", "## 被引用", "");
    for (const note of backlinks) lines.push(`- [[${nameById.get(note.id)}]]`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

const VAULT_README = `# Obsidian Vault 导出说明

本目录由 dsh-knowledge-base 导出，可直接作为 Obsidian Vault 打开：

- index.md                内容索引（双链）：编译页（笔记）在前，原始资料在后
- schema.md / log.md      知识库维护规范与操作流水（存在时）
- wiki/topics/            专题页（笔记 kind=topic）
- wiki/entities/          实体页
- wiki/concepts/          概念页
- wiki/summaries/         来源摘要页
- wiki/notes/             普通笔记
- wiki/sources/           每份资料的摘要页（含原始文件链接与被引用笔记）
- raw/                    原始文件（导出时 includeSources=true 才有）

Obsidian 按文件名解析 [[双链]]，因此文件名做过安全化与去重；
检索与精读仍建议回到插件（kb_query / kb_read），Vault 用于浏览与图谱。
`;

/** 导出 Obsidian Vault（zip）。 */
export async function exportVault(dir, manifest, outPath, options = {}) {
  const { default: JSZip } = await import("jszip");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const includeSources = options.includeSources === true;
  const docs = (manifest.docs ?? []).filter((d) => d.status === "ready" && !d.deletedAt);
  const notes = docs.filter((d) => d.type === "note");
  const sources = docs.filter((d) => d.type !== "note");

  // 1) 文件名分配（全局去重；笔记与资料页共用一个命名空间，避免双链歧义）
  const used = new Set(["readme", "index", "schema", "log"]);
  const nameById = new Map();
  for (const doc of [...notes, ...sources]) {
    nameById.set(doc.id, safeName(doc.title, used, doc.id));
  }
  const rawUsed = new Set();
  const rawNameById = new Map();
  for (const doc of sources) {
    const original = doc.sourceFile || `${doc.id}${doc.sourceExt ?? ""}`;
    rawNameById.set(doc.id, safeName(original, rawUsed, `${doc.id}.bin`));
  }

  // 2) 笔记正文（合并版去掉首行 H1）
  for (const doc of notes) {
    try {
      const merged = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
      const lines = merged.split("\n");
      if (/^#\s/.test(lines[0] ?? "")) lines.shift();
      doc.__body = lines
        .filter((line) => !line.startsWith("<!-- doc:"))
        .join("\n")
        .replace(/^\n+/, "")
        .trim();
    } catch {
      doc.__body = "";
    }
  }

  const zip = new JSZip();
  const STORE = /\.(pdf|png|jpe?g|gif|webp|zip|gz|7z|docx?|pptx?|xlsx?|epub|mobi|azw3)$/i;
  zip.file("README.md", VAULT_README, { compression: "DEFLATE" });
  zip.file("index.md", renderVaultIndex(manifest, nameById), { compression: "DEFLATE" });
  for (const name of ["schema.md", "log.md"]) {
    try {
      zip.file(name, await readFile(join(dir, name), "utf8"), { compression: "DEFLATE" });
    } catch {
      /* 旧库可能没有 */
    }
  }
  for (const doc of notes) {
    const folder = KIND_DIRS[doc.kind] ?? "notes";
    zip.file(`wiki/${folder}/${nameById.get(doc.id)}.md`, renderNotePage(doc, manifest, { nameById }), {
      compression: "DEFLATE",
    });
  }
  for (const doc of sources) {
    zip.file(
      `wiki/sources/${nameById.get(doc.id)}.md`,
      renderSourcePage(doc, manifest, {
        rawName: includeSources ? rawNameById.get(doc.id) : null,
        nameById,
      }),
      { compression: "DEFLATE" }
    );
  }
  if (includeSources) {
    let sourceList = [];
    try {
      sourceList = await readdir(join(dir, "sources"));
    } catch {
      sourceList = [];
    }
    for (const doc of sources) {
      const rawName = rawNameById.get(doc.id);
      const candidates = [`${doc.id}${doc.sourceExt ?? ""}`, doc.sourceFile].filter(Boolean);
      let found = null;
      for (const candidate of candidates) {
        try {
          await stat(join(dir, "sources", candidate));
          found = candidate;
          break;
        } catch {
          /* 继续尝试 */
        }
      }
      if (!found) {
        const hit = sourceList.find((f) => f.startsWith(doc.id));
        if (hit) found = hit;
      }
      if (!found) continue;
      zip.file(`raw/${rawName}`, createReadStream(join(dir, "sources", found)), {
        compression: STORE.test(rawName) ? "STORE" : "DEFLATE",
      });
    }
  }

  try {
    await pipeline(
      zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE" }),
      createWriteStream(outPath)
    );
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
  const { size } = await stat(outPath);
  return {
    bytes: size,
    docs: docs.length,
    notes: notes.length,
    sources: sources.length,
    includeSources,
  };
}
