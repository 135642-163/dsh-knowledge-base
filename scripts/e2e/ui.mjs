/**
 * 浏览器侧工具：优先 WebKit（DSH 桌面端引擎），失败回退 Chromium；
 * 每个测试独立 context/page，失败时落截图 + URL + console 错误。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";

export class SkipError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SkipError";
  }
}

export class BrowserError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "BrowserError";
    this.cause = cause;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

function engineOrder(env = process.env) {
  const requested = String(env?.DSH_E2E_BROWSER ?? "").trim().toLowerCase();
  if (requested === "chromium" || requested === "webkit") return [requested];
  return ["webkit", "chromium"];
}

async function launchOne(name, log) {
  const engine = name === "chromium" ? chromium : webkit;
  log(`launching ${name} (headless, 1280x800)`);
  return engine.launch({
    headless: true,
    args: name === "chromium" ? ["--disable-dev-shm-usage"] : [],
  });
}

/** 启动浏览器；两个引擎都失败时抛 BrowserError（附安装命令）。 */
export async function launchBrowser({ log = () => {}, env = process.env } = {}) {
  const failures = [];
  for (const name of engineOrder(env)) {
    try {
      const browser = await launchOne(name, log);
      log(`browser ready: ${name} ${browser.version()}`);
      return { browser, engine: name };
    } catch (error) {
      failures.push(`${name}: ${String(error?.message ?? error).split("\n")[0]}`);
      log(`browser launch failed for ${name}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
  throw new BrowserError(
    [
      "无法启动 Playwright 浏览器（WebKit 与 Chromium 都不可用）。",
      ...failures.map((line) => `  - ${line}`),
      "请先运行：npm run e2e:install",
      "若下载被网络拦截，可设置 PLAYWRIGHT_DOWNLOAD_HOST 指向可用镜像后重试。",
    ].join("\n"),
  );
}

/** 全新 DSH_HOME 的宿主需要 ?token= 才能通过浏览器信任检查。 */
function withToken(url, token) {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("token")) parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** 页面控件的小工具：不引入 @playwright/test，仍保持清晰断言。 */
export function createPageHelpers(page, token = "") {
  const helpers = {
    page,
    token,
    async goto(path) {
      const raw = path.startsWith("http") ? path : `${helpers.baseUrl}${path}`;
      await page.goto(withToken(raw, helpers.token), { waitUntil: "domcontentloaded" });
      return page;
    },
    async toast(text, timeout = 15_000) {
      const toast = page.locator("#toast");
      await toast.waitFor({ state: "visible", timeout });
      await poll(async () => (await toast.textContent())?.includes(text) ?? false, {
        timeout,
        message: `等待 toast 包含「${text}」，实际：${await toast.textContent().catch(() => "")}`,
      });
      return toast;
    },
    async modal(timeout = 10_000) {
      const modal = page.locator(".overlay .modal-form").last();
      await modal.waitFor({ state: "visible", timeout });
      return modal;
    },
  };
  return helpers;
}

/** 轮询一个同步/异步判定，超时抛错并带最后一次原因。 */
export async function poll(check, { timeout = 15_000, interval = 100, message = "等待条件超时" } = {}) {
  const started = Date.now();
  let lastError = "";
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      lastError = "";
    } catch (error) {
      lastError = String(error?.message ?? error).split("\n")[0];
    }
    if (Date.now() - started >= timeout) {
      throw new Error(`${message}（${timeout}ms）${lastError ? `：${lastError}` : ""}`);
    }
    await new Promise((done) => setTimeout(done, interval));
  }
}

function sanitizeSlug(value) {
  return String(value ?? "test")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "test";
}

/**
 * 一个测试的浏览器上下文：懒创建 page，失败时统一落盘。
 */
export class TestContext {
  constructor({ browser, baseUrl, token = "", api, artifactsDir, slug, log = () => {} }) {
    this.browser = browser;
    this.baseUrl = baseUrl;
    this.token = token;
    this.api = api;
    this.artifactsDir = artifactsDir;
    this.slug = sanitizeSlug(slug);
    this.log = log;
    this.contexts = [];
    this.pages = [];
    this.consoleErrors = [];
    this.page = null;
    this.helpers = null;
  }

  async openPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
    });
    this.contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);
    page.on("console", (message) => {
      if (message.type() === "error") this.consoleErrors.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      this.consoleErrors.push(`pageerror: ${String(error?.message ?? error)}`);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "";
      if (!failure.includes("net::ERR_ABORTED")) {
        this.consoleErrors.push(`requestfailed: ${request.method()} ${request.url()} ${failure}`);
      }
    });
    this.page = page;
    this.helpers = createPageHelpers(page, this.token);
    this.helpers.baseUrl = this.baseUrl;
    // 全新 DSH_HOME 的 token 只在根入口接受一次，先打开根页面让浏览器保存会话，
    // 否则直接访问 /kb/ 会停在授权页导致首个用例超时。
    if (this.token) {
      await page.goto(withToken(`${this.baseUrl}/`, this.token), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
    }
    this.pages.push(page);
    return page;
  }

  async goto(path) {
    const page = await this.openPage();
    await this.helpers.goto(path);
    return page;
  }

  async close() {
    for (const context of this.contexts) {
      await context.close().catch(() => {});
    }
    this.contexts = [];
    this.pages = [];
    this.page = null;
    this.helpers = null;
  }

  /** 失败证据：截图 + URL + console/pageerror；宿主日志由 runner 单独写。 */
  async captureFailure(error) {
    const page = this.page;
    const base = `fail-${this.slug}`;
    let screenshot = "";
    let url = "";
    if (page && !page.isClosed()) {
      screenshot = join(this.artifactsDir, `${base}.png`);
      url = page.url();
      await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {
        screenshot = "";
      });
    }
    const payload = {
      test: this.slug,
      time: new Date().toISOString(),
      url,
      screenshot: screenshot === "" ? null : screenshot,
      consoleErrors: [...new Set(this.consoleErrors)],
      error: {
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? ""),
      },
    };
    await writeFile(join(this.artifactsDir, `${base}.json`), JSON.stringify(payload, null, 2), "utf8");
    return { screenshot, url, consoleErrors: payload.consoleErrors };
  }

  skip(reason) {
    throw new SkipError(reason);
  }
}

