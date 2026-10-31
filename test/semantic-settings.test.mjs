/**
 * 0.31.2 语义开关持久化：<kbRoot>/.semantic.json 的读写、默认值与损坏回退。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEMANTIC_SETTINGS_FILE,
  readSemanticEnabled,
  readSemanticProfile,
  readSemanticSettings,
  writeSemanticEnabled,
  writeSemanticProfile,
} from "../lib/semantic-settings.js";

test("没有设置文件时用配置默认值", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-sem-settings-"));
  try {
    assert.equal(await readSemanticEnabled(root, false), false);
    assert.equal(await readSemanticEnabled(root, true), true);
    const settings = await readSemanticSettings(root);
    assert.equal(settings.enabled, null);
    assert.equal(settings.source, "config");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("写入后覆盖默认值，文件 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-sem-settings-"));
  try {
    assert.equal(await writeSemanticEnabled(root, true), true);
    assert.equal(await readSemanticEnabled(root, false), true);
    const path = join(root, SEMANTIC_SETTINGS_FILE);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const data = JSON.parse(await readFile(path, "utf8"));
    assert.equal(data.enabled, true);
    assert.ok(Number.isFinite(Date.parse(data.updatedAt)));
    assert.equal(await writeSemanticEnabled(root, false), false);
    assert.equal(await readSemanticEnabled(root, true), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("设置文件损坏时回退默认值，不抛错", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-sem-settings-"));
  try {
    await writeFile(join(root, SEMANTIC_SETTINGS_FILE), "{not json", "utf8");
    assert.equal(await readSemanticEnabled(root, true), true);
    assert.equal((await readSemanticSettings(root)).enabled, null);
    await writeFile(join(root, SEMANTIC_SETTINGS_FILE), JSON.stringify({ enabled: "on" }), "utf8");
    assert.equal(await readSemanticEnabled(root, false), false, "非布尔值按未设置处理");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile 可独立持久化，改 enabled 不丢 profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-sem-settings-"));
  try {
    assert.equal(await readSemanticProfile(root, "summary"), "summary");
    assert.equal(await writeSemanticProfile(root, "window"), "window");
    assert.equal(await readSemanticProfile(root, "summary"), "window");
    assert.equal(await writeSemanticEnabled(root, true), true);
    const settings = await readSemanticSettings(root);
    assert.equal(settings.enabled, true);
    assert.equal(settings.profile, "window");
    assert.equal(await writeSemanticProfile(root, "summary"), "summary");
    assert.equal(await readSemanticEnabled(root, false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
