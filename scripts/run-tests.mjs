/**
 * 跨平台测试入口：枚举 test/*.test.mjs 后交给 node --test。
 * 不用 shell glob（Windows cmd 不展开）也不用裸 node --test（会误跑 dev/ 下的手工探针脚本）。
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let names;
try {
  names = readdirSync(join(root, "test"));
} catch (error) {
  console.error(`cannot read test directory: ${String(error?.message ?? error)}`);
  process.exit(1);
}

const files = names
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));

if (files.length === 0) {
  console.error("no test files found under test/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
  // 隔离「数据目录」设置：测试不能读到开发者本机保存的 kbRoot。
  env: { ...process.env, KB_SETTINGS_DISABLED: "1" },
});
process.exit(result.status ?? 1);
