/**
 * 逐页 PDF 转 PNG + 缓存（内存 LRU + 系统临时目录）。
 *
 * 只做加速，不参与正确性：缓存 miss 时用 mupdf 渲染；磁盘目录固定在
 * `os.tmpdir()/dsh-kb-pages`（不写知识库目录），系统清理后自动重建。
 * key 含源文件 mtime/size，源文件被替换后自然失效。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampViewerPage, normalizeRotate } from "./pdf-viewer.js";

const DEFAULT_MEMORY_ENTRIES = 64;
const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_DISK_FILES = 800;
const PRUNE_EVERY_WRITES = 64;

const limits = { maxEntries: DEFAULT_MEMORY_ENTRIES, maxBytes: DEFAULT_MEMORY_BYTES, diskFiles: DEFAULT_DISK_FILES };
let cacheDir = "";
let memory = new Map();
let memoryBytes = 0;
let writes = 0;
const stats = { hits: 0, diskHits: 0, misses: 0, writes: 0, pruned: 0, errors: 0 };

export function diskDir() {
  return cacheDir || join(tmpdir(), "dsh-kb-pages");
}

/** 测试/宿主用：换缓存目录与容量上限（会清空内存缓存）。 */
export function configurePageCache({ dir = "", maxEntries, maxBytes, diskFiles } = {}) {
  cacheDir = typeof dir === "string" ? dir : "";
  if (Number.isFinite(maxEntries) && maxEntries > 0) limits.maxEntries = Math.round(maxEntries);
  if (Number.isFinite(maxBytes) && maxBytes > 0) limits.maxBytes = Math.round(maxBytes);
  if (Number.isFinite(diskFiles) && diskFiles > 0) limits.diskFiles = Math.round(diskFiles);
  memory = new Map();
  memoryBytes = 0;
}

export function pageCacheStats() {
  return {
    ...stats,
    entries: memory.size,
    bytes: memoryBytes,
    maxEntries: limits.maxEntries,
    maxBytes: limits.maxBytes,
    diskFiles: limits.diskFiles,
    dir: diskDir(),
  };
}

export function resetPageCache() {
  memory = new Map();
  memoryBytes = 0;
  writes = 0;
  for (const key of Object.keys(stats)) stats[key] = 0;
}

export function pageCacheKey({ pdfPath, mtimeMs = 0, size = 0, page, dpi, rotate }) {
  return createHash("sha1")
    .update(`${pdfPath}\u0000${Math.round(mtimeMs)}\u0000${size}\u0000${page}\u0000${dpi}\u0000${rotate}`)
    .digest("hex");
}

function memoryGet(key) {
  const value = memory.get(key);
  if (!value) return null;
  memory.delete(key);
  memory.set(key, value);
  return value;
}

function memorySet(key, buffer) {
  if (memory.has(key)) {
    memoryBytes -= memory.get(key).length;
    memory.delete(key);
  }
  memory.set(key, buffer);
  memoryBytes += buffer.length;
  while (memory.size > limits.maxEntries || memoryBytes > limits.maxBytes) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    const value = memory.get(oldest.value);
    memory.delete(oldest.value);
    memoryBytes -= value.length;
  }
}

async function diskGet(key) {
  try {
    return await readFile(join(diskDir(), `${key}.png`));
  } catch {
    return null;
  }
}

async function diskSet(key, png) {
  const dir = diskDir();
  const target = join(dir, `${key}.png`);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, png);
    await rename(temp, target);
    stats.writes += 1;
    writes += 1;
    if (writes % PRUNE_EVERY_WRITES === 0) void pruneDisk();
  } catch {
    stats.errors += 1;
    await unlink(temp).catch(() => {});
  }
}

async function pruneDisk() {
  const dir = diskDir();
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".png"));
  if (names.length <= limits.diskFiles) return;
  const entries = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info) entries.push({ name, mtimeMs: info.mtimeMs });
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of entries.slice(0, Math.max(0, names.length - limits.diskFiles))) {
    await unlink(join(dir, entry.name)).catch(() => {});
    stats.pruned += 1;
  }
}

/** mupdf 渲染单页（不含缓存）；导出给测试/工具直接比对尺寸。 */
export async function renderPdfPageWithMupdf({ pdfPath, page = 1, dpi = 144, rotate = 0 }) {
  const data = await readFile(pdfPath);
  const { default: mupdf } = await import("mupdf");
  const doc = mupdf.Document.openDocument(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), "application/pdf");
  try {
    const total = Math.max(1, doc.countPages());
    const pageNo = clampViewerPage(page, total);
    const rotation = normalizeRotate(rotate);
    const scale = Math.min(200, Math.max(72, Math.round(Number(dpi) || 144))) / 72;
    const matrix = rotation === 0
      ? mupdf.Matrix.scale(scale, scale)
      : mupdf.Matrix.concat(mupdf.Matrix.rotate(rotation), mupdf.Matrix.scale(scale, scale));
    const pdfPage = doc.loadPage(pageNo - 1);
    const pixmap = pdfPage.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      return { png: Buffer.from(pixmap.asPNG()), total, page: pageNo, rotate: rotation };
    } finally {
      try { pixmap.destroy(); } catch { /* ignore */ }
    }
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

/**
 * 取一页 PNG：内存 → 磁盘 → mupdf。返回 `cached` 便于响应头与测试观察。
 * @returns {Promise<{png: Buffer, cached: "memory"|"disk"|"miss", total?: number}>}
 */
export async function renderPdfPage({ pdfPath, page = 1, dpi = 144, rotate = 0 }) {
  const info = await stat(pdfPath).catch(() => null);
  const key = pageCacheKey({
    pdfPath,
    mtimeMs: info?.mtimeMs ?? 0,
    size: info?.size ?? 0,
    page,
    dpi,
    rotate: normalizeRotate(rotate),
  });
  const memoryHit = memoryGet(key);
  if (memoryHit) {
    stats.hits += 1;
    return { png: memoryHit, cached: "memory" };
  }
  const diskHit = await diskGet(key);
  if (diskHit) {
    stats.diskHits += 1;
    memorySet(key, diskHit);
    return { png: diskHit, cached: "disk" };
  }
  stats.misses += 1;
  const rendered = await renderPdfPageWithMupdf({ pdfPath, page, dpi, rotate });
  memorySet(key, rendered.png);
  // 磁盘写是加速层：失败不影响本次响应，但等它完成让缓存/测试的时序可预期。
  await diskSet(key, rendered.png);
  return { png: rendered.png, cached: "miss", total: rendered.total };
}
