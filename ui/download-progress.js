/**
 * 工作台大文件下载：把「浏览器直接下载、看不到进度」改成可观测的下载。
 *
 * 三条路径：
 * 1. 小文件（≤ BLOB_DOWNLOAD_LIMIT）：fetch + ReadableStream 读进内存，边读边报进度，
 *    完成后用 Blob + <a download> 保存；适用于几十 MB 的正文包。
 * 2. 大文件且宿主支持 File System Access（Chromium/Electron）：先 showSaveFilePicker
 *    选保存位置，再把响应流直接写盘——不占内存，进度来自 Content-Length。
 * 3. 大文件且不支持文件选择器（Safari/Firefox）：交回浏览器原生下载，UI 只能提示
 *    「已交给浏览器下载」，不伪造进度。
 */

export const BLOB_DOWNLOAD_LIMIT = 384 * 1024 * 1024;

export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** 0–100 的整数；总大小未知时返回 null（UI 显示不确定进度）。 */
export function progressPercent(loaded, total) {
  const done = Number(loaded);
  const all = Number(total);
  if (!Number.isFinite(done) || done < 0) return null;
  if (!Number.isFinite(all) || all <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((done / all) * 100)));
}

/** 下载进度文案：已知总长度显示「62% · 12 MB / 20 MB」，未知只显示已下载量。 */
export function progressText(loaded, total) {
  const percent = progressPercent(loaded, total);
  if (percent === null) return `${formatBytes(loaded)} 已下载`;
  return `${percent}% · ${formatBytes(loaded)} / ${formatBytes(total)}`;
}

/**
 * 读取 fetch 响应体并持续回调进度。返回 Uint8Array。
 * 不依赖 DOM，便于 Node 单测；signal 取消时抛 AbortError。
 */
export async function readBodyWithProgress(response, onProgress = () => {}, { signal } = {}) {
  if (!response) throw new Error("下载响应为空");
  const headerTotal = Number(response.headers?.get?.("content-length"));
  let total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : 0;

  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (total === 0) total = buffer.byteLength;
    onProgress({ loaded: buffer.byteLength, total });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let reported = -1;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      loaded += value.byteLength;
      reported = loaded;
      onProgress({ loaded, total });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (loaded !== reported) onProgress({ loaded, total: total || loaded });
  return bytes;
}

function abortError() {
  const error = new Error("下载已取消");
  error.name = "AbortError";
  return error;
}

function triggerAnchorDownload(url, fileName, documentImpl) {
  const doc = documentImpl ?? (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("当前环境无法触发下载");
  const link = doc.createElement("a");
  link.href = url;
  link.download = fileName || "";
  link.rel = "noopener";
  doc.body.appendChild(link);
  link.click();
  link.remove();
}

function saveBlob(bytes, fileName, type, { documentImpl, urlImpl } = {}) {
  const doc = documentImpl ?? (typeof document !== "undefined" ? document : null);
  const urls = urlImpl ?? (typeof URL !== "undefined" ? URL : null);
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });
  const href = urls.createObjectURL(blob);
  try {
    triggerAnchorDownload(href, fileName, doc);
  } finally {
    // 立刻 revoke 会让部分浏览器的下载中断，留一段时间；Node 测试里不能让定时器吊住进程。
    const timer = setTimeout(() => urls.revokeObjectURL?.(href), 60_000);
    timer?.unref?.();
  }
}

async function streamToFile({ url, fileName, totalBytes, onProgress, signal, fetchImpl, windowImpl }) {
  // picker 必须在用户手势的同一个任务里调用：先打开保存对话框，再开始联网。
  const handle = await windowImpl.showSaveFilePicker({ suggestedName: fileName });
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`下载失败 (${response.status})`);
  const headerTotal = Number(response.headers?.get?.("content-length"));
  const total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : Number(totalBytes) || 0;
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    onProgress({ loaded: bytes.byteLength, total: total || bytes.byteLength });
    return { mode: "file", bytes: bytes.byteLength };
  }
  const writable = await handle.createWritable();
  const reader = response.body.getReader();
  let loaded = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      await writable.write(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      /* 放弃写盘失败时不再掩盖原始错误 */
    }
    throw error;
  }
  onProgress({ loaded, total: total || loaded });
  return { mode: "file", bytes: loaded };
}

/**
 * 下载导出文件。
 * 返回 { mode: "blob" | "file" | "browser" | "canceled", bytes? }。
 * 大文件无法流式写盘时退回浏览器原生下载（mode=browser，无伪造进度）。
 */
export async function downloadExportFile({
  url,
  fileName,
  totalBytes = 0,
  onProgress = () => {},
  signal,
  fetchImpl = globalThis.fetch,
  windowImpl = globalThis.window,
  documentImpl = globalThis.document,
  urlImpl = globalThis.URL,
} = {}) {
  const size = Number(totalBytes) || 0;
  const canStream = size > BLOB_DOWNLOAD_LIMIT
    && typeof windowImpl?.showSaveFilePicker === "function";

  if (canStream) {
    try {
      return await streamToFile({ url, fileName, totalBytes: size, onProgress, signal, fetchImpl, windowImpl });
    } catch (error) {
      if (error?.name === "AbortError" && !signal?.aborted) {
        // 用户在保存对话框里点了取消：这不是错误，什么都不下载。
        return { mode: "canceled" };
      }
      throw error;
    }
  }

  if (size > BLOB_DOWNLOAD_LIMIT) {
    triggerAnchorDownload(url, fileName, documentImpl);
    return { mode: "browser" };
  }

  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`下载失败 (${response.status})`);
  const bytes = await readBodyWithProgress(response, ({ loaded, total }) => {
    onProgress({ loaded, total: total || size });
  }, { signal });
  saveBlob(bytes, fileName, "application/octet-stream", { documentImpl, urlImpl });
  return { mode: "blob", bytes: bytes.byteLength };
}
