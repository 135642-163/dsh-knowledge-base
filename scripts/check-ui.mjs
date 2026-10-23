/**
 * 零构建工作台的语法门：逐个用 esbuild 解析 ui 目录下的所有 .js。
 * 让模板字符串/括号写错在 `npm test` 就失败，而不是等浏览器白屏。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uiRoot = join(root, "ui");

function listJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

let files = [];
try {
  files = listJsFiles(uiRoot).sort();
} catch (error) {
  console.error(`cannot read ui directory: ${String(error?.message ?? error)}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error("no ui js files found");
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const name = relative(root, file);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    failed = true;
    console.error(`${name}: ${String(error?.message ?? error)}`);
    continue;
  }
  try {
    transformSync(source, { loader: "js", format: "esm", sourcefile: name });
  } catch (error) {
    failed = true;
    const issues = Array.isArray(error?.errors) ? error.errors : [];
    if (issues.length === 0) {
      console.error(`${name}: ${String(error?.message ?? error)}`);
      continue;
    }
    for (const issue of issues) {
      const line = issue?.location?.line ?? "?";
      const column = issue?.location?.column;
      const where = column === undefined ? `${name}:${line}` : `${name}:${line}:${column + 1}`;
      console.error(`${where} ${String(issue?.text ?? issue?.message ?? "syntax error")}`);
    }
  }
}

if (failed) process.exit(1);
console.log(`checked ${files.length} ui modules`);
