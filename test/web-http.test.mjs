/**
 * /kb 路由的 HTTP 基础设施：信任围栏、同源、工作台请求头、静态文件流错误。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  isTrustedApiRequest,
  assertSameOrigin,
  requireUiHeader,
  relativeApiPath,
  relativeUiPath,
  serveFile,
} from "../lib/web/http.js";

const CHMOD_GUARD = {
  skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
};

function fakeRes() {
  const res = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  res.status = 0;
  res.headers = null;
  res.destroyedByError = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  const destroy = res.destroy.bind(res);
  res.destroy = (error) => {
    res.destroyedByError = true;
    return destroy(error);
  };
  return res;
}

function req(headers = {}) {
  return { headers };
}

test("loopback hosts are trusted", () => {
  assert.equal(isTrustedApiRequest(req({ host: "127.0.0.1:55929" }), []), true);
  assert.equal(isTrustedApiRequest(req({ host: "localhost:55929" }), []), true);
  assert.equal(isTrustedApiRequest(req({ host: "[::1]:55929" }), []), true);
});

test("external hosts require trustedHosts", () => {
  assert.equal(isTrustedApiRequest(req({ host: "evil.example:55929" }), []), false);
  assert.equal(isTrustedApiRequest(req({ host: "192.168.1.5:55929" }), ["192.168.1.5:55929"]), true);
  assert.equal(isTrustedApiRequest(req({ host: "192.168.1.5:55929" }), ["192.168.1.5"]), true);
});

test("cross-site origin is rejected", () => {
  assert.doesNotThrow(() => assertSameOrigin(req({ host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929" })));
  assert.throws(() => assertSameOrigin(req({ host: "127.0.0.1:55929", origin: "http://evil.example" })), /跨站/);
  assert.throws(() => assertSameOrigin(req({ host: "127.0.0.1:55929", "sec-fetch-site": "cross-site" })), /跨站/);
});

test("mutations require x-kb-ui header", () => {
  assert.doesNotThrow(() => requireUiHeader(req({ "x-kb-ui": "1" })));
  assert.throws(() => requireUiHeader(req({})), /请求头/);
});

test("host may pass full or prefix-stripped paths to handlers", () => {
  assert.equal(relativeApiPath("/kb/api/status"), "/status");
  assert.equal(relativeApiPath("/status"), "/status");
  assert.equal(relativeApiPath("/kb/api"), "/");
  assert.equal(relativeApiPath("/kbs/%E6%A0%87%E5%87%86/docs"), "/kbs/%E6%A0%87%E5%87%86/docs");

  assert.equal(relativeUiPath("/kb/"), "index.html");
  assert.equal(relativeUiPath("/"), "index.html");
  assert.equal(relativeUiPath("/kb/app.js"), "app.js");
  assert.equal(relativeUiPath("/app.js"), "app.js");
  assert.equal(relativeUiPath("/kb/api.js"), "api.js");
  assert.equal(relativeUiPath("/api.js"), "api.js");
});

test("serveFile destroys the response when the read stream fails", CHMOD_GUARD, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-serve-"));
  const file = join(dir, "unreadable.txt");
  await writeFile(file, "hello", "utf8");
  await chmod(file, 0o000);
  try {
    const res = fakeRes();
    const closed = new Promise((resolve) => res.on("close", resolve));
    assert.equal(await serveFile(res, file), true);
    await closed;
    assert.equal(res.status, 200);
    assert.equal(res.destroyedByError, true, "stream error must destroy the response instead of crashing");
  } finally {
    await chmod(file, 0o644).catch(() => {});
  }
});
