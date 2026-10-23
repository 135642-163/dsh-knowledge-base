/**
 * 分发约束回归：
 * - 包名/loader id 与已收录的 htcqp802/dsh-knowledge-base 区分；
 * - peer 范围覆盖 DSH 0.2.x；
 * - 不再依赖带 postinstall 的 tesseract.js（pnpm 默认阻止 build script）；
 * - vendor/tesseract 存在，bundle patch 指向新 id。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package identity avoids the existing dsh-knowledge-base entry", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "dsh-knowledge-wiki");
  assert.match(pkg.peerDependencies["@deepseek-ai/dsh-tools"], /<0\.3\.0/);
  assert.equal(pkg.dependencies["tesseract.js"], undefined, "postinstall dep must not be installed");
  assert.ok(pkg.dependencies["tesseract.js-core"], "wasm core is still a normal dependency");
  assert.ok(pkg.files.includes("vendor"), "vendored tesseract.js must ship");
  const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id: knowledge-wiki/);
  assert.match(patch, /name: dsh-knowledge-wiki/);
});

test("vendored tesseract.js is present and marked CommonJS", async () => {
  await access(join(root, "vendor", "tesseract", "src", "index.js"));
  await access(join(root, "vendor", "tesseract", "LICENSE.md"));
  const marker = JSON.parse(await readFile(join(root, "vendor", "tesseract", "src", "package.json"), "utf8"));
  assert.equal(marker.type, "commonjs");
});
