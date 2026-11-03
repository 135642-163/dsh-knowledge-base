/**
 * 原生文件选择器：命令规格、输出归一、取消识别与 Linux 回退。
 * 不真正打开系统对话框：run 全部注入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOWS_PICKER_SCRIPT,
  isPickerCancel,
  kdialogCommand,
  normalizePickedPath,
  pickLocalFile,
  pickerCommand,
} from "../lib/web/file-picker.js";

test("pickerCommand 按平台生成免 shell 命令", () => {
  const mac = pickerCommand("darwin", { title: '选择 "包"' });
  assert.equal(mac.command, "osascript");
  assert.match(mac.args[1], /choose file with prompt/);
  assert.match(mac.args[1], /\\"包\\"/);
  assert.match(mac.args[1], /type \{"zip"\}/);

  const win = pickerCommand("win32");
  assert.equal(win.command, "powershell.exe");
  assert.ok(win.args.includes(WINDOWS_PICKER_SCRIPT));
  assert.ok(win.args.includes("-STA"));

  const linux = pickerCommand("linux", { title: "选包" });
  assert.equal(linux.command, "zenity");
  assert.ok(linux.args.includes("--file-selection"));
  assert.ok(linux.args.some((arg) => arg.includes("*.zip")));
  assert.equal(kdialogCommand({ title: "选包" }).command, "kdialog");
  assert.equal(pickerCommand("aix"), null);
});

test("normalizePickedPath 去掉引号/空行，空输出表示取消", () => {
  assert.equal(normalizePickedPath(" /tmp/标准.zip\n"), "/tmp/标准.zip");
  assert.equal(normalizePickedPath('"C:\\\\tmp\\\\a.zip"\r\n'), "C:\\\\tmp\\\\a.zip");
  assert.equal(normalizePickedPath("\n  \n"), "");
  assert.equal(normalizePickedPath(""), "");
});

test("isPickerCancel 只把取消错误当取消，命令缺失不算", () => {
  assert.equal(isPickerCancel({ code: 1, stderr: "User canceled. (-128)" }), true);
  assert.equal(isPickerCancel({ code: "1", stderr: "" }), true);
  assert.equal(isPickerCancel({ code: "ENOENT", message: "spawn zenity ENOENT" }), false);
  assert.equal(isPickerCancel({ code: 2, stderr: "boom" }), false);
});

test("pickLocalFile 返回路径；取消返回 canceled", async () => {
  let seen = null;
  const picked = await pickLocalFile({
    platform: "darwin",
    run: async (command, args) => {
      seen = { command, args };
      return { stdout: "/tmp/包.zip\n" };
    },
  });
  assert.deepEqual(picked, { canceled: false, path: "/tmp/包.zip" });
  assert.equal(seen.command, "osascript");

  const canceled = await pickLocalFile({
    platform: "darwin",
    run: async () => { throw Object.assign(new Error("canceled"), { code: 1, stderr: "User canceled. (-128)" }); },
  });
  assert.deepEqual(canceled, { canceled: true });
});

test("Linux zenity 缺失时回退 kdialog", async () => {
  const calls = [];
  const result = await pickLocalFile({
    platform: "linux",
    run: async (command, args) => {
      calls.push(command);
      if (command === "zenity") throw Object.assign(new Error("spawn zenity ENOENT"), { code: "ENOENT" });
      assert.ok(args.includes("*.zip"));
      return { stdout: "/data/库.zip\n" };
    },
  });
  assert.deepEqual(result, { canceled: false, path: "/data/库.zip" });
  assert.deepEqual(calls, ["zenity", "kdialog"]);
});

test("不支持的平台直接报错", async () => {
  await assert.rejects(() => pickLocalFile({ platform: "aix" }), /不支持原生文件选择器/);
});
