/**
 * 升级检查脚本：版本比较、兼容范围、npm/GitHub 数据拼装与报告文案。
 * 网络全部注入，不依赖真实 npm/GitHub。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkUpdates,
  compareVersions,
  detectDshVersion,
  renderReport,
  satisfiesRange,
} from "../scripts/update-check.mjs";

function fakeFetch(handlers) {
  return async (url, options = {}) => {
    const target = handlers[url];
    if (!target) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => target, options };
  };
}

test("compareVersions 处理 rc/alpha 与正式版", () => {
  assert.equal(compareVersions("0.2.1-rc.5", "0.2.1"), -1);
  assert.equal(compareVersions("0.2.2-alpha.3", "0.2.2-rc.1"), -1);
  assert.equal(compareVersions("0.2.1-rc.5", "0.2.1-rc.5"), 0);
  assert.equal(compareVersions("0.2.2", "0.2.1"), 1);
  assert.equal(compareVersions("bad", "0.2.1"), null);
});

test("satisfiesRange 支持 >= / < / ^ / ~ 与 ||", () => {
  assert.equal(satisfiesRange("0.2.1-rc.5", ">=0.1.0-rc.6 <0.3.0"), true);
  assert.equal(satisfiesRange("0.3.0", ">=0.1.0-rc.6 <0.3.0"), false);
  assert.equal(satisfiesRange("0.2.5", "^0.2.1"), true);
  assert.equal(satisfiesRange("0.3.0", "^0.2.1"), false);
  assert.equal(satisfiesRange("0.2.9", "~0.2.1"), true);
  assert.equal(satisfiesRange("0.2.1", "0.1.x || 0.2.x"), null);
  assert.equal(satisfiesRange("0.2.1", "bad-range"), null);
});

test("checkUpdates 汇总本机、npm 与 GitHub 并判断需要动作", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-update-check-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      version: "0.41.0",
      repository: { url: "git+https://github.com/135642-163/dsh-knowledge-base.git" },
      peerDependencies: { "@deepseek-ai/dsh-tools": ">=0.1.0-rc.6 <0.3.0" },
    }));
    const result = await checkUpdates({
      pluginRoot: root,
      dshVersion: "0.2.1-rc.5",
      fetchImpl: fakeFetch({
        "https://registry.npmjs.org/@deepseek-ai%2Fdsh": {
          "dist-tags": { latest: "0.2.2", next: "0.2.2-rc.1" },
        },
        "https://raw.githubusercontent.com/135642-163/dsh-knowledge-base/main/package.json": {
          version: "0.42.0",
          peerDependencies: { "@deepseek-ai/dsh-tools": ">=0.3.0 <0.4.0" },
        },
      }),
    });
    assert.equal(result.local.pluginVersion, "0.41.0");
    assert.equal(result.local.dshVersion, "0.2.1-rc.5");
    assert.equal(result.remote.pluginVersion, "0.42.0");
    assert.equal(result.pluginUpdate, true);
    assert.equal(result.dshUpdate, true);
    assert.equal(result.compatibility, false);
    assert.equal(result.actionNeeded, true);
    assert.deepEqual(result.errors, []);
    const report = renderReport(result, { now: new Date("2026-11-04T00:00:00Z") });
    assert.match(report, /# DSH \/ 知识库插件升级检查（2026-11-04）/);
    assert.match(report, /插件可升级：是/);
    assert.match(report, /DSH 可升级（latest）：是/);
    assert.match(report, /兼容范围内：否/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("网络失败不抛错：来源标 unknown、不误报需要动作", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-update-offline-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.41.1" }));
    const result = await checkUpdates({
      pluginRoot: root,
      dshVersion: "0.2.1-rc.5",
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal(result.remote.pluginVersion, null);
    assert.equal(result.npm.latest, null);
    assert.equal(result.actionNeeded, false);
    assert.equal(result.errors.length >= 2, true);
    const report = renderReport(result);
    assert.match(report, /## 检查异常/);
    assert.match(report, /offline/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectDshVersion 优先参数与环境变量", async () => {
  assert.deepEqual(await detectDshVersion({ explicit: "0.2.2-rc.1" }), {
    version: "0.2.2-rc.1",
    source: "参数 --dsh-version",
  });
  assert.deepEqual(await detectDshVersion({ env: { DSH_VERSION: "9.9.9" }, platform: "linux" }), {
    version: "9.9.9",
    source: "环境变量",
  });
});
