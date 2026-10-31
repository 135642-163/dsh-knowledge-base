/**
 * 流式 ZIP 读取：不把整包读进内存，按中央目录索引逐条读取/解压。
 * 支持 STORE / DEFLATE、ZIP64（>4GB 或 >65535 条目）、UTF-8 文件名；
 * 拒绝加密条目；符号链接由调用方基于 unixPermissions 判断。
 *
 * 用于 kbpack / 快照的大包导入（真实「标准」库带 sources 的包约 4.7GB，
 * 用 JSZip.loadAsync 会整包进内存）。导出仍用 JSZip 流式写盘。
 *
 * 每次读取都短暂 open 文件后关闭，reader 本身不长期持有 fd。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createInflateRaw } from "node:zlib";
import { pipeline } from "node:stream/promises";

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export class ZipReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ZipReadError";
    this.code = code;
  }
}

function readU64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipReadError("ZIP64_UNSUPPORTED", "ZIP64 数值超过安全整数范围");
  }
  return Number(value);
}

async function readRange(path, length, position) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * JSZip 流式写盘在 >4GB 时会把 offset 按 32 位回绕（字段值 + n*2^32 才是真实偏移）。
 * 这里按签名尝试回绕值；正常 zip 第一次命中，兼容自家导出的超大包。
 */
async function resolveSignatureOffset(path, fieldOffset, signature, fileSize, minBytes) {
  let offset = fieldOffset;
  for (let round = 0; round < 4; round += 1) {
    if (offset >= 0 && offset + minBytes <= fileSize) {
      const head = await readRange(path, 4, offset);
      if (head.length === 4 && head.readUInt32LE(0) === signature) return offset;
    }
    offset += 2 ** 32;
  }
  return -1;
}

function findEocd(tail) {
  for (let i = tail.length - EOCD_MIN; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    if (i + EOCD_MIN + commentLength === tail.length) return i;
  }
  return -1;
}

function parseZip64Extra(extra, fields) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const data = extra.subarray(offset + 4, offset + 4 + size);
    offset += 4 + size;
    if (id !== 0x0001 || data.length === 0) continue;
    let cursor = 0;
    if (fields.uncompressedSize === 0xffffffff) {
      if (cursor + 8 > data.length) break;
      fields.uncompressedSize = readU64(data, cursor);
      cursor += 8;
    }
    if (fields.compressedSize === 0xffffffff) {
      if (cursor + 8 > data.length) break;
      fields.compressedSize = readU64(data, cursor);
      cursor += 8;
    }
    if (fields.localOffset === 0xffffffff) {
      if (cursor + 8 > data.length) break;
      fields.localOffset = readU64(data, cursor);
      cursor += 8;
    }
  }
}

/**
 * 打开 zip 并读取中央目录（只读一次中央目录，不加载文件内容）。
 */
export async function openZipReader(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ZipReadError("ZIP_NOT_FOUND", `zip 不存在: ${path}`);
  }
  const size = info.size;
  if (size < EOCD_MIN) throw new ZipReadError("ZIP_INVALID", "文件太小，不是 zip");
  const tailLength = Math.min(size, EOCD_MIN + MAX_COMMENT + 20 + 56);
  const tail = await readRange(path, tailLength, size - tailLength);
  const eocd = findEocd(tail);
  if (eocd < 0) throw new ZipReadError("ZIP_INVALID", "找不到 zip 中央目录结尾");

  let entriesCount = tail.readUInt16LE(eocd + 10);
  let centralSize = tail.readUInt32LE(eocd + 12);
  let centralOffset = tail.readUInt32LE(eocd + 16);
  const needsZip64 =
    entriesCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;

  if (needsZip64) {
    const locatorPos = size - tailLength + eocd - 20;
    if (locatorPos < 0) throw new ZipReadError("ZIP64_INVALID", "缺少 ZIP64 定位器");
    const locator = await readRange(path, 20, locatorPos);
    if (locator.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) {
      throw new ZipReadError("ZIP64_INVALID", "ZIP64 定位器签名不对");
    }
    const zip64Offset = readU64(locator, 8);
    const zip64 = await readRange(path, 56, zip64Offset);
    if (zip64.readUInt32LE(0) !== SIG_ZIP64_EOCD) {
      throw new ZipReadError("ZIP64_INVALID", "ZIP64 中央目录结尾签名不对");
    }
    entriesCount = readU64(zip64, 32);
    centralSize = readU64(zip64, 40);
    centralOffset = readU64(zip64, 48);
  }
  centralOffset = await resolveSignatureOffset(path, centralOffset, SIG_CENTRAL, size, 46);
  if (centralOffset < 0) throw new ZipReadError("ZIP_INVALID", "找不到中央目录");
  if (centralOffset + centralSize > size) throw new ZipReadError("ZIP_INVALID", "中央目录越界");
  const central = await readRange(path, centralSize, centralOffset);
  const entries = new Map();
  let offset = 0;
  for (let i = 0; i < entriesCount; i += 1) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new ZipReadError("ZIP_INVALID", `中央目录第 ${i + 1} 条损坏`);
    }
    const flags = central.readUInt16LE(offset + 8);
    const method = central.readUInt16LE(offset + 10);
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const externalAttributes = central.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const name = central.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const extra = central.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    const fields = {
      compressedSize: central.readUInt32LE(offset + 20),
      uncompressedSize: central.readUInt32LE(offset + 24),
      localOffset: central.readUInt32LE(offset + 42),
    };
    if (
      fields.compressedSize === 0xffffffff ||
      fields.uncompressedSize === 0xffffffff ||
      fields.localOffset === 0xffffffff
    ) {
      parseZip64Extra(extra, fields);
    }
    if ((flags & 0x0001) !== 0) {
      throw new ZipReadError("ZIP_ENCRYPTED", `不支持加密条目: ${name}`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipReadError("ZIP_METHOD_UNSUPPORTED", `不支持的压缩方法 ${method}: ${name}`);
    }
    const mode = externalAttributes >>> 16;
    entries.set(name, {
      name,
      method,
      flags,
      compressedSize: fields.compressedSize,
      uncompressedSize: fields.uncompressedSize,
      localOffset: fields.localOffset,
      unixPermissions: mode,
      isSymlink: (mode & 0o170000) === 0o120000,
      isDirectory: name.endsWith("/"),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  const entryFor = (nameOrEntry) => {
    const entry = typeof nameOrEntry === "string" ? entries.get(nameOrEntry) : nameOrEntry;
    if (!entry) throw new ZipReadError("ZIP_ENTRY_NOT_FOUND", `zip 内不存在条目: ${String(nameOrEntry)}`);
    return entry;
  };
  const dataStartFor = async (entry) => {
    const localOffset = await resolveSignatureOffset(path, entry.localOffset, SIG_LOCAL, size, 30);
    if (localOffset < 0) {
      throw new ZipReadError("ZIP_INVALID", `找不到本地文件头: ${entry.name}`);
    }
    const local = await readRange(path, 30, localOffset);
    return localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  };

  return {
    size,
    entries,
    list: () => [...entries.values()],
    async readEntryBuffer(nameOrEntry) {
      const entry = entryFor(nameOrEntry);
      if (entry.isDirectory) return Buffer.alloc(0);
      const start = await dataStartFor(entry);
      if (entry.method === 0) {
        const buffer = await readRange(path, entry.compressedSize, start);
        if (buffer.length !== entry.compressedSize) {
          throw new ZipReadError("ZIP_TRUNCATED", `条目数据被截断: ${entry.name}`);
        }
        return buffer;
      }
      const chunks = [];
      let total = 0;
      const stream = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
      for await (const chunk of stream.pipe(createInflateRaw())) {
        total += chunk.length;
        if (total > entry.uncompressedSize) {
          throw new ZipReadError("ZIP_BOMB", `解压体积超过声明: ${entry.name}`);
        }
        chunks.push(chunk);
      }
      if (total !== entry.uncompressedSize) {
        throw new ZipReadError("ZIP_TRUNCATED", `解压长度与声明不符: ${entry.name}`);
      }
      return Buffer.concat(chunks);
    },
    async readText(nameOrEntry) {
      return (await this.readEntryBuffer(nameOrEntry)).toString("utf8");
    },
    async extractEntry(nameOrEntry, dest) {
      const entry = entryFor(nameOrEntry);
      if (entry.isDirectory) return;
      await mkdir(dirname(dest), { recursive: true });
      const start = await dataStartFor(entry);
      const source = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
      if (entry.method === 0) await pipeline(source, createWriteStream(dest));
      else await pipeline(source, createInflateRaw(), createWriteStream(dest));
    },
    async close() {
      /* 无长期 fd；保留该方法方便调用方统一清理 */
    },
  };
}
