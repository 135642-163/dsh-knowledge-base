/**
 * /kb 工作台的 HTTP 挂载：
 * - GET /kb          → 308 /kb/
 * - GET /kb/...      → ui/ 下的静态文件
 * - /kb/api/...      → api.js
 * 只在宿主提供 webServer 时注册；desktop/headless 不受影响。
 */
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./api.js";
import { createJobRegistry } from "./jobs.js";
import {
  isTrustedApiRequest,
  relativeUiPath,
  sendError,
  sendRedirect,
  serveFile,
} from "./http.js";

const pluginRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const uiRoot = join(pluginRoot, "ui");

function trustedHostsOf(ctx) {
  try {
    const runtime = ctx.get?.("webRuntime");
    return Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : [];
  } catch {
    return [];
  }
}

export function registerKbWeb(ctx, opts = {}) {
  if (opts.uiEnabled === false) return;
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["webServer"], (sctx) => {
    const webServer = sctx.webServer;
    if (!webServer) return;
    // 注册表按挂载点创建一次：每次请求都新建会丢失运行中任务与进度。
    const jobs = createJobRegistry();
    const runtimeOpts = {
      ...opts,
      // 预览引擎配置由 apply 传入；previewEngine 供测试注入转换器（cliPath/convert）。
      officeKitCli: typeof opts.officeKitCli === "string" ? opts.officeKitCli : "",
      // Office 引擎一键安装：默认实现来自 office-install.js；测试/宿主可注入。
      officeStatus: typeof opts.officeStatus === "function" ? opts.officeStatus : undefined,
      officeInstaller: typeof opts.officeInstaller === "function" ? opts.officeInstaller : undefined,
      previewEngine: opts.previewEngine ?? null,
      jobs,
      spawn: (spec) => ctx.subprocess.spawn(spec),
      importConfig: opts.importConfig ?? (() => ({})),
    };
    const fence = (req) => isTrustedApiRequest(req, trustedHostsOf(sctx));
    const add = (route, label) => {
      const dispose = webServer.register(route);
      try {
        sctx.effect?.(() => dispose, label);
      } catch {
        /* effect 不可用时仍保留路由，进程退出时由 webServer 统一释放 */
      }
    };
    add({
      kind: "exact",
      path: "/kb",
      handler: (req, res) => {
        if (!fence(req)) return sendError(res, 403, "FORBIDDEN", "请求来源不受信任");
        sendRedirect(res, "/kb/");
      },
    }, "kb-web: /kb");
    // DSH 的 prefix 语义是 p 或 p/<anything>；不能写成 "/kb/" 或 "/kb/api/"。
    // /kb/api 只吃 /kb/api 与 /kb/api/...，/kb/api.js 会落到更短的 /kb 前缀。
    add({
      kind: "prefix",
      path: "/kb/api",
      handler: (req, res) => handleApi(req, res, { ctx: sctx, opts: runtimeOpts, fence }),
    }, "kb-web: /kb/api");
    add({
      kind: "prefix",
      path: "/kb",
      handler: (req, res) => serveUi(req, res, fence),
    }, "kb-web: /kb");
    try {
      sctx.effect?.(() => () => jobs.cancelAll(), "kb-web: jobs-dispose");
    } catch {
      /* effect 不可用时任务随进程退出 */
    }
  });
}

async function serveUi(req, res, fence) {
  if (!fence(req)) return sendError(res, 403, "FORBIDDEN", "请求来源不受信任");
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendError(res, 405, "BAD_REQUEST", "method not allowed");
  }
  let rel;
  try {
    const url = new URL(req.url ?? "/", "http://dsh.internal");
    rel = decodeURIComponent(relativeUiPath(url.pathname));
  } catch {
    return sendError(res, 400, "BAD_REQUEST", "invalid path");
  }
  if (rel === "" || rel === "/") rel = "index.html";
  if (rel.includes("\0")) return sendError(res, 400, "BAD_REQUEST", "invalid path");
  const abs = resolve(uiRoot, rel);
  if (abs !== uiRoot && !abs.startsWith(uiRoot + sep)) {
    return sendError(res, 404, "NOT_FOUND", "not found");
  }
  const ok = await serveFile(res, abs);
  if (!ok) sendError(res, 404, "NOT_FOUND", "not found");
}
