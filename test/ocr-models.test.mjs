/**
 * 0.6.0 OCR 模型自举：市场/GitHub 安装没有 data/tessdata 时，
 * 首次 OCR 自动下载到用户缓存，或复用已有模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTessdata, tessDataStatus } from "../lib/ocr.js";

function fakeFetch() {
  const calls = [];
  return {
    calls,
    impl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(`model:${url}`),
      };
    },
  };
}

test("downloads missing models into the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-models-"));
  try {
    const langPath = join(root, "lang");
    const cacheDir = join(root, "cache");
    await mkdir(langPath, { recursive: true });
    const fetch = fakeFetch();
    const result = await ensureTessdata("chi_sim+eng", langPath, {
      cacheDir,
      fetchImpl: fetch.impl,
    });
    assert.equal(result.langPath, cacheDir);
    assert.deepEqual(new Set(result.downloaded), new Set(["chi_sim", "eng"]));
    assert.equal(fetch.calls.length, 2);
    await access(join(cacheDir, "chi_sim.traineddata.gz"));
    await access(join(cacheDir, "eng.traineddata.gz"));
    assert.deepEqual((await tessDataStatus("chi_sim+eng", cacheDir)).missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses an existing model and downloads only the missing one", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-models-reuse-"));
  try {
    const langPath = join(root, "lang");
    const cacheDir = join(root, "cache");
    await mkdir(langPath, { recursive: true });
    await writeFile(join(langPath, "chi_sim.traineddata.gz"), "existing", "utf8");
    const fetch = fakeFetch();
    const result = await ensureTessdata("chi_sim+eng", langPath, {
      cacheDir,
      fetchImpl: fetch.impl,
    });
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0], /eng\.traineddata\.gz$/);
    await access(join(cacheDir, "chi_sim.traineddata.gz"));
    assert.deepEqual((await tessDataStatus("chi_sim+eng", cacheDir)).missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("autoDownload=false reports missing without network", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-models-off-"));
  try {
    const langPath = join(root, "lang");
    await mkdir(langPath, { recursive: true });
    const fetch = fakeFetch();
    const result = await ensureTessdata("chi_sim", langPath, {
      autoDownload: false,
      cacheDir: join(root, "cache"),
      fetchImpl: fetch.impl,
    });
    assert.deepEqual(result.missing, ["chi_sim"]);
    assert.equal(fetch.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed download surfaces the URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-models-fail-"));
  try {
    const langPath = join(root, "lang");
    await mkdir(langPath, { recursive: true });
    await assert.rejects(
      () =>
        ensureTessdata("chi_sim", langPath, {
          cacheDir: join(root, "cache"),
          fetchImpl: async () => ({ ok: false, status: 404 }),
        }),
      /下载 OCR 模型失败.*HTTP 404/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("falls back to the second mirror when the first returns 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-models-fallback-"));
  try {
    const langPath = join(root, "lang");
    await mkdir(langPath, { recursive: true });
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes("cdn.jsdelivr.net")) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("model") };
    };
    const result = await ensureTessdata("eng", langPath, {
      cacheDir: join(root, "cache"),
      fetchImpl,
    });
    assert.deepEqual(result.downloaded, ["eng"]);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /cdn\.jsdelivr\.net/);
    assert.match(calls[1], /tessdata\.projectnaptha\.com/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
