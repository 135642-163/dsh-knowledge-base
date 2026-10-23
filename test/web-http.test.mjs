/**
 * /kb 路由的 HTTP 基础设施：信任围栏、同源、工作台请求头。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isTrustedApiRequest,
  assertSameOrigin,
  requireUiHeader,
} from "../lib/web/http.js";

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
