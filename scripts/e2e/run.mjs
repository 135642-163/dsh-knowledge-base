/**
 * DSH 知识库插件端到端测试入口。
 *
 * 默认自托管：临时 profile（e2e-<6hex>，软链真实 web profile 的 node_modules）
 * + 临时 kbRoot（os.tmpdir()/kb-e2e-*）。`DSH_E2E_URL` 可复用外部宿主，但只有
 * kbRoot 位于系统临时目录或显式 DSH_E2E_ALLOW_MUTATE=1 时才会写入固定数据。
 *
 * 用法：
 *   npm run e2e:install   # 首次安装浏览器
 *   npm run test:e2e
 *
 * 环境变量：DSH_E2E_URL / DSH_E2E_BROWSER=webkit|chromium / DSH_E2E_KEEP=1 /
 *          DSH_E2E_VERBOSE=1 / DSH_E2E_PYTHON=<python>。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startHost } from "./host.mjs";
import { createApi } from "./api.mjs";
import { seedFixtures } from "./seed.mjs";
import { launchBrowser, TestContext, SkipError } from "./ui.mjs";
import * as trash from "./tests/trash.mjs";
import * as move from "./tests/move.mjs";
import * as retry from "./tests/retry.mjs";
import * as preview from "./tests/preview.mjs";
import * as previewOffice from "./tests/preview-office.mjs";
import * as capsule from "./tests/capsule.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const runStartedAt = new Date();
const stamp = runStartedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const artifactsDir = join(root, "test", "e2e", ".artifacts", stamp);
const tests = [trash, move, retry, preview, previewOffice, capsule];

const logLines = [];
let activeHost = null;
let activeBrowser = null;
function log(message) {
  const line = `[E2E] ${message}`;
  console.log(line);
  logLines.push(line);
}

function errorLine(error) {
  return String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 8).join("\n");
}

function assertExternalRootIsSafe(host, env) {
  if (host.mode !== "external") return;
  if (String(env?.DSH_E2E_ALLOW_MUTATE ?? "") === "1") return;
  const tempRoot = resolve(tmpdir());
  const kbRoot = resolve(host.kbRoot);
  if (!kbRoot.startsWith(`${tempRoot}${sep}`)) {
    throw new Error(
      [
        "DSH_E2E_URL 指向的宿主 kbRoot 不在系统临时目录，拒绝写入 E2E 固定数据。",
        `kbRoot=${kbRoot}`,
        "请使用临时 kbRoot 的宿主，或显式设置 DSH_E2E_ALLOW_MUTATE=1。",
      ].join("\n"),
    );
  }
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });
  log(`artifacts: ${artifactsDir}`);
  log(`repo: ${root}`);

  let host = null;
  let browser = null;
  let setupError = null;
  const results = [];
  const seedInfo = { office: null };

  try {
    host = await startHost({ artifactsDir, log });
    activeHost = host;
    assertExternalRootIsSafe(host, process.env);

    const api = createApi(host.baseUrl);
    log("seeding fixtures via HTTP + manifests …");
    const seeded = await seedFixtures({ api, kbRoot: host.kbRoot, artifactsDir, log });
    Object.assign(seedInfo, seeded);
    log(`seed ready: ${seedInfo.deletedTotal} deleted docs, ${seedInfo.archivedTotal} archived kb, office=${seedInfo.office ? seedInfo.office.method : "none"}`);

    browser = await launchBrowser({ log });
    activeBrowser = browser;

    for (const test of tests) {
      if (shuttingDown) return;
      const ctx = new TestContext({
        browser: browser.browser,
        baseUrl: host.baseUrl,
        api,
        artifactsDir,
        slug: test.name,
        log,
      });
      ctx.office = seedInfo.office;
      const started = Date.now();
      try {
        log(`RUN  ${test.name}`);
        await test.run(ctx);
        const ms = Date.now() - started;
        results.push({ name: test.name, status: "pass", ms });
        log(`PASS ${test.name} (${ms}ms)`);
      } catch (error) {
        const ms = Date.now() - started;
        if (shuttingDown) return;
        if (error instanceof SkipError) {
          results.push({ name: test.name, status: "skip", ms, reason: error.message });
          log(`SKIP ${test.name} — ${error.message}`);
        } else {
          const evidence = await ctx.captureFailure(error);
          results.push({
            name: test.name,
            status: "fail",
            ms,
            error: String(error?.message ?? error),
            stack: String(error?.stack ?? ""),
            screenshot: evidence.screenshot || null,
            url: evidence.url,
            consoleErrors: evidence.consoleErrors,
          });
          log(`FAIL ${test.name} (${ms}ms): ${String(error?.message ?? error).split("\n")[0]}`);
          log(`     screenshot: ${evidence.screenshot || "(none)"}  url: ${evidence.url || "(none)"}`);
          if (evidence.consoleErrors.length > 0) {
            log(`     console errors: ${evidence.consoleErrors.slice(0, 5).join(" | ")}`);
          }
        }
      } finally {
        await ctx.close();
      }
    }
  } catch (error) {
    setupError = error;
    log(`SETUP ERROR: ${String(error?.message ?? error).split("\n")[0]}`);
    console.error(errorLine(error));
  } finally {
    // 信号中断时由 shutdown() 负责清理，不再落一份半截 summary。
    if (shuttingDown) return;
    const passed = results.filter((item) => item.status === "pass").length;
    const failed = results.filter((item) => item.status === "fail").length;
    const skipped = results.filter((item) => item.status === "skip").length;
    const durationMs = Date.now() - runStartedAt.getTime();

    const summary = {
      startedAt: runStartedAt.toISOString(),
      durationMs,
      mode: host?.mode ?? "none",
      baseUrl: host?.baseUrl ?? "",
      kbRoot: host?.kbRoot ?? "",
      profile: host?.profileName ?? "",
      browser: browser?.engine ?? "",
      seed: seedInfo,
      results,
      setupError: setupError ? String(setupError?.message ?? setupError) : null,
    };

    await writeFile(join(artifactsDir, "run.log"), `${logLines.join("\n")}\n`, "utf8").catch(() => {});
    await writeFile(join(artifactsDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8").catch(() => {});
    if (browser?.browser) await browser.browser.close().catch(() => {});
    activeBrowser = null;
    if (host) await host.stop().catch(() => {});
    activeHost = null;
    if (host?.keep) log(`kept temp paths: profile=${host.profileDir} kbRoot=${host.kbRoot}`);

    const counts = [
      `${passed} passed`,
      `${failed} failed`,
      `${skipped} skipped`,
      `${(durationMs / 1000).toFixed(1)}s`,
    ].join(", ");
    console.log(`\n[E2E] summary: ${counts}`);
    if (skipped > 0) {
      for (const item of results.filter((entry) => entry.status === "skip")) {
        console.log(`[E2E]   skip: ${item.name} — ${item.reason}`);
      }
    }
    if (setupError) {
      console.log(`[E2E] setup failed; artifacts: ${artifactsDir}`);
      process.exitCode = 1;
    } else {
      console.log(`[E2E] artifacts: ${artifactsDir}`);
      process.exitCode = failed > 0 || results.length === 0 ? 1 : 0;
    }
  }
}

// 中断时也要杀掉宿主进程树、删掉临时 profile/kbRoot。
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[E2E] ${signal}: cleaning up temporary host …`);
  try { await activeBrowser?.browser?.close(); } catch { /* ignore */ }
  try { await activeHost?.stop(); } catch { /* ignore */ }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await main();
