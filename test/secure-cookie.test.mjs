import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSecureCookie,
  hasSecureCookie,
  readSecureCookie,
  saveSecureCookie,
  secureStorageKind,
} from "../lib/secure-cookie.js";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "kb-cookie-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("平台后端识别", () => {
  assert.equal(secureStorageKind("darwin"), "macos-keychain");
  assert.equal(secureStorageKind("linux"), "secret-service");
  assert.equal(secureStorageKind("win32"), "windows-dpapi");
  assert.equal(secureStorageKind("freebsd"), "unsupported");
});

test("macOS Keychain 读/写/删命令", async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return cmd === "security" && args[0] === "find-generic-password" ? "session=abc\n" : "";
  };
  assert.equal(await readSecureCookie({ platform: "darwin", run }), "session=abc");
  assert.deepEqual(calls[0].args.slice(0, 2), ["find-generic-password", "-s"]);

  await withDir(async (dir) => {
    const marker = join(dir, "bzCookie.enabled");
    await saveSecureCookie("session=abc", { platform: "darwin", run, markerPath: marker });
    assert.equal(await hasSecureCookie(marker), true);
    assert.ok(calls.some((c) => c.args.includes("add-generic-password")));
    await clearSecureCookie({ platform: "darwin", run, markerPath: marker });
    assert.equal(await hasSecureCookie(marker), false);
  });
});

test("Linux Secret Service 通过 stdin 写入、不把 Cookie 放进程参数", async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return "";
  };
  await withDir(async (dir) => {
    await saveSecureCookie("session=secret", { platform: "linux", run, markerPath: join(dir, "m") });
  });
  const store = calls.find((c) => c.args.includes("store"));
  assert.equal(store.cmd, "secret-tool");
  assert.equal(store.opts.input, "session=secret");
  assert.ok(!store.args.includes("session=secret"));
  assert.equal(await readSecureCookie({ platform: "linux", run }), null);
});

test("Windows DPAPI 用环境变量传 Cookie", async () => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return "";
  };
  await withDir(async (dir) => {
    await saveSecureCookie("session=win", { platform: "win32", run, markerPath: join(dir, "m") });
  });
  const call = calls.find((c) => c.cmd === "powershell.exe");
  assert.equal(call.opts.env.DSH_SECURE_COOKIE, "session=win");
  assert.ok(!call.args.includes("session=win"));
});

test("空 Cookie 拒绝；不支持平台明确报错", async () => {
  await assert.rejects(() => saveSecureCookie("  ", { platform: "darwin", run: async () => "" }), /为空/);
  await assert.rejects(() => saveSecureCookie("x", { platform: "freebsd", run: async () => "" }), /不支持/);
});
