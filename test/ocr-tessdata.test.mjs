/**
 * OCR 模型缺失时必须给出可执行的错误，而不是把 tesseract 的底层异常抛给用户。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tessDataStatus, missingTessdataError, ocrImageBatch } from "../lib/ocr.js";

test("tessDataStatus checks every language in a chi_sim+eng request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-tess-"));
  try {
    let status = await tessDataStatus("chi_sim+eng", dir);
    assert.deepEqual(status.missing, ["chi_sim", "eng"]);

    await writeFile(join(dir, "chi_sim.traineddata.gz"), "");
    status = await tessDataStatus("chi_sim+eng", dir);
    assert.deepEqual(status.missing, ["eng"]);

    await writeFile(join(dir, "eng.traineddata"), "");
    status = await tessDataStatus("chi_sim+eng", dir);
    assert.deepEqual(status.missing, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missingTessdataError names the files and the download command", async () => {
  const dir = "/tmp/kb-tess-message";
  const error = missingTessdataError("chi_sim+eng", dir);
  const message = error.message;
  assert.match(message, /chi_sim\.traineddata\.gz/);
  assert.match(message, /eng\.traineddata\.gz/);
  assert.match(message, /cdn\.jsdelivr\.net/);
  assert.ok(message.includes(dir));
});

test("wasm OCR fails early with the model download instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-tess-missing-"));
  try {
    await assert.rejects(
      () =>
        ocrImageBatch([{ png: new Uint8Array([1]), page: 1 }], {
          lang: "chi_sim",
          workers: 1,
          langPath: join(root, "does-not-exist"),
          engine: "wasm",
          autoDownloadModels: false,
        }),
      /OCR 语言模型缺失/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
