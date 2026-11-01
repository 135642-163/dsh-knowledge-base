#!/usr/bin/env node
/**
 * 把标准网 Cookie 写入系统安全存储（macOS Keychain / Linux Secret Service / Windows DPAPI）。
 *
 * 用法：
 *   pbpaste | node scripts/set-bz-cookie.mjs
 *   BZ_COOKIE='...' node scripts/set-bz-cookie.mjs
 *   node scripts/set-bz-cookie.mjs --status
 *   node scripts/set-bz-cookie.mjs --clear
 *
 * 不打印 Cookie；旧 profile 里的 bzCookie 明文建议迁移后删除。
 */
import { readFile } from "node:fs/promises";
import {
  clearSecureCookie,
  hasSecureCookie,
  readSecureCookie,
  saveSecureCookie,
  secureCookieMarkerPath,
  secureStorageKind,
} from "../lib/secure-cookie.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`用法:
  pbpaste | node scripts/set-bz-cookie.mjs
  BZ_COOKIE='...' node scripts/set-bz-cookie.mjs
  node scripts/set-bz-cookie.mjs --status
  node scripts/set-bz-cookie.mjs --clear`);
  process.exit(0);
}

const backend = secureStorageKind();
if (args.includes("--status")) {
  const enabled = await hasSecureCookie();
  const cookie = enabled ? await readSecureCookie() : null;
  console.log(JSON.stringify({
    backend,
    marker: secureCookieMarkerPath(),
    enabled,
    configured: Boolean(cookie),
  }, null, 2));
  process.exit(0);
}

if (args.includes("--clear")) {
  const r = await clearSecureCookie();
  console.log(r.ok ? `已清除安全存储中的 bzCookie（${backend}）` : `清除失败（${backend}）`);
  process.exit(r.ok ? 0 : 1);
}

let cookie = String(process.env.BZ_COOKIE ?? "").trim();
if (!cookie && !process.stdin.isTTY) {
  cookie = String(await readFile(0, "utf8")).trim();
}
if (!cookie) {
  console.error("未收到 Cookie。请用管道传入、设置 BZ_COOKIE 环境变量，或查看 --help。");
  process.exit(2);
}

try {
  const r = await saveSecureCookie(cookie);
  console.log(`已写入 bzCookie（${r.backend}，长度 ${cookie.length}）`);
  console.log("建议从 profile 配置中删除明文 bzCookie；插件会自动优先读取安全存储。");
} catch (error) {
  console.error(`写入失败：${error?.message ?? error}`);
  process.exit(1);
}
