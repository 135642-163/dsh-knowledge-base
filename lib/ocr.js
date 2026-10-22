/**
 * 扫描版 PDF 的 OCR 多后端，按速度自动择优（engine: "auto" 默认）：
 * 1. rapidocr：micromamba 用户环境 ~/.dsh/tools/rapidocr-env（ONNX CPU 推理，
 *    对密集中文印刷页比 tesseract 快数倍）；常驻帧协议进程，模型只加载一次；
 * 2. tesserocr：tesseract-env 中的常驻 Python 进程（tesserocr 绑定 libtesseract，
 *    引擎常驻内存，免去每页进程启动与模型重载）；
 * 3. native tesseract CLI：每页一个进程（模型每页重载，兜底）；
 * 4. wasm：tesseract.js（纯 JS/WASM，零系统依赖，兜底保证可移植性）。
 */
import { spawn, execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RAPIDOCR_SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", "rapidocr", "ocr.py");
const TESSEROCR_SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", "tesseract", "ocr.py");
const tesseractCache = new Map();

/** 异步执行外部命令（promisified execFile + 超时），避免同步探测阻塞宿主事件循环。 */
async function execFileAsync(bin, args, { timeoutMs = 30000 } = {}) {
  return await new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? "");
        error.stderr = String(stderr ?? "");
        reject(error);
      } else {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    });
  });
}

/** 探测结果按 explicitBin 键控缓存（结果与调用参数相关）。 */
const rapidPythonCache = new Map();
const tesseractBinaryCache = new Map();
const tesserocrPythonCache = new Map();

/** 解析 rapidocr 的 python 解释器：显式配置 > micromamba 用户环境（mac/win 布局）> PATH。 */
async function resolveRapidPython(explicitBin) {
  const key = String(explicitBin ?? "");
  if (rapidPythonCache.has(key)) return rapidPythonCache.get(key);
  const promise = (async () => {
    const candidates = [];
    if (explicitBin) candidates.push(explicitBin);
    const envRoot = join(homedir(), ".dsh", "tools", "rapidocr-env");
    candidates.push(join(envRoot, "python"));
    candidates.push(join(envRoot, "bin", "python"));
    candidates.push(join(envRoot, "python.exe"));
    candidates.push(join(envRoot, "Scripts", "python.exe"));
    candidates.push("python3");
    candidates.push("python");
    for (const bin of candidates) {
      try {
        await execFileAsync(bin, ["-c", "from rapidocr_onnxruntime import RapidOCR"], {
          timeoutMs: 30000,
        });
        return bin;
      } catch {
        /* 尝试下一个 */
      }
    }
    return null;
  })();
  rapidPythonCache.set(key, promise);
  return promise;
}

/** 解析原生 tesseract 二进制：显式配置 > PATH > micromamba 用户环境（mac/win 布局）。 */
async function resolveTesseractBinary(explicitBin) {
  const key = String(explicitBin ?? "");
  if (tesseractBinaryCache.has(key)) return tesseractBinaryCache.get(key);
  const promise = (async () => {
    const candidates = [];
    if (explicitBin) candidates.push(explicitBin);
    candidates.push("tesseract");
    const envRoot = join(homedir(), ".dsh", "tools", "tesseract-env");
    candidates.push(join(envRoot, "bin", "tesseract"));
    candidates.push(join(envRoot, "bin", "tesseract.exe"));
    candidates.push(join(envRoot, "Library", "bin", "tesseract.exe"));
    candidates.push(join(envRoot, "Scripts", "tesseract.exe"));
    candidates.push(join(envRoot, "tesseract.exe"));
    for (const bin of candidates) {
      try {
        const { stdout } = await execFileAsync(bin, ["--version"], { timeoutMs: 15000 });
        if (/tesseract\s+\d/.test(stdout)) return bin;
      } catch {
        /* 尝试下一个 */
      }
    }
    return null;
  })();
  tesseractBinaryCache.set(key, promise);
  return promise;
}

/** 解析 tesserocr 的 python 解释器（tesseract-env 内需装 tesserocr + pillow）。 */
async function resolveTesserocrPython(explicitBin) {
  const key = String(explicitBin ?? "");
  if (tesserocrPythonCache.has(key)) return tesserocrPythonCache.get(key);
  const promise = (async () => {
    const candidates = [];
    if (explicitBin) candidates.push(explicitBin);
    const envRoot = join(homedir(), ".dsh", "tools", "tesseract-env");
    candidates.push(join(envRoot, "python"));
    candidates.push(join(envRoot, "bin", "python"));
    candidates.push(join(envRoot, "python.exe"));
    candidates.push(join(envRoot, "Scripts", "python.exe"));
    candidates.push("python3");
    candidates.push("python");
    for (const bin of candidates) {
      try {
        await execFileAsync(bin, ["-c", "import tesserocr, PIL"], { timeoutMs: 30000 });
        return bin;
      } catch {
        /* 尝试下一个 */
      }
    }
    return null;
  })();
  tesserocrPythonCache.set(key, promise);
  return promise;
}

/**
 * 检查 OCR 语言模型是否齐全。`chi_sim+eng` 必须两个模型都在——
 * 旧实现只检查第一个语言，导致 eng 缺失时仍选中原生后端，最后在
 * tesseract 内部报一个与真实原因无关的错。
 * @returns { langs, missing, langPath }
 */
export async function tessDataStatus(lang, langPath) {
  const langs = String(lang ?? "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const dir = String(langPath ?? "").trim();
  if (dir === "") return { langs, missing: [...langs], langPath: "" };
  const missing = [];
  for (const name of langs) {
    let found = false;
    for (const ext of ["traineddata", "traineddata.gz"]) {
      try {
        await access(join(dir, `${name}.${ext}`));
        found = true;
        break;
      } catch {
        /* 继续尝试下一扩展名 */
      }
    }
    if (!found) missing.push(name);
  }
  return { langs, missing, langPath: dir };
}

/** 语言模型缺失时的可执行错误（含下载命令），而不是 tesseract 的底层异常。 */
export function missingTessdataError(lang, langPath) {
  const langs = String(lang ?? "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const dir = String(langPath ?? "").trim() || "（未配置 langPath）";
  const files = langs.map((l) => `${l}.traineddata.gz`).join("、");
  const curl = langs
    .map(
      (l) =>
        `curl -fL "https://tessdata.projectnaptha.com/4.0.0_best_int/${l}.traineddata.gz" -o "${l}.traineddata.gz"`
    )
    .join("\n  ");
  return new Error(
    `OCR 语言模型缺失（${dir} 下缺少 ${files}）。\n` +
      `请先下载模型，再重试：\n  mkdir -p "${dir}"\n  cd "${dir}"\n  ${curl}\n` +
      `或配置 ocrEngine / ocrNativeBin 使用已安装模型的原生 tesseract 或 rapidocr 环境。`
  );
}

/** 语言数据是否齐全（原生/常驻后端用，.traineddata 或 .traineddata.gz 均可）。 */
async function tessDataPresent(lang, langPath) {
  const { missing } = await tessDataStatus(lang, langPath);
  return missing.length === 0;
}

/** tesseract 后端可用性（二进制 + 语言数据，结果缓存）。 */
async function tesseractAvailable(lang, langPath, explicitBin) {
  const key = `tesseract|${langPath}|${lang}`;
  if (tesseractCache.has(key)) return tesseractCache.get(key);
  let available = false;
  const bin = await resolveTesseractBinary(explicitBin);
  if (bin !== null) {
    available = await tessDataPresent(lang, langPath);
  }
  tesseractCache.set(key, available);
  return available;
}

/**
 * 解析 OCR worker 的一帧：新版返回 JSON {text, confidence}，
 * 旧版/异常输出退回纯文本（confidence=null）。
 */
export function parseOcrFrame(raw) {
  const text = String(raw ?? "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
      const confidence =
        parsed.confidence === null || parsed.confidence === undefined
          ? null
          : Number(parsed.confidence);
      return { text: parsed.text, confidence: Number.isFinite(confidence) ? confidence : null };
    }
  } catch {
    /* 旧版纯文本帧 */
  }
  return { text, confidence: null };
}

/**
 * 识别一批 PNG 缓冲。
 * @param jobs [{ png: Uint8Array, page: number }]
 * @param options { lang, workers, langPath, engine: "auto"|"rapidocr"|"tesseract"|"wasm",
 *                  nativeBin, pythonBin, onProgress }
 * @returns [{ page, text, confidence?, error? }]，与输入顺序一致
 */
export async function ocrImageBatch(jobs, options) {
  const { lang = "chi_sim+eng", workers = 2, langPath, engine = "auto", nativeBin, pythonBin, onProgress } = options ?? {};
  if (!jobs || jobs.length === 0) return [];

  if (engine !== "wasm") {
    if (engine === "rapidocr" || engine === "auto") {
      const rapidBin = await resolveRapidPython(pythonBin);
      if (rapidBin !== null) {
        return ocrRapidBatch(rapidBin, jobs, { workers, onProgress });
      }
    }
    if (engine === "tesseract" || engine === "auto") {
      // 常驻 tesserocr 优先（引擎常驻内存），不可用时回退每页进程的 CLI 后端
      if (await tessDataPresent(lang, langPath)) {
        const tcrBin = await resolveTesserocrPython(nativeBin);
        if (tcrBin !== null) {
          return ocrTesserocrBatch(tcrBin, jobs, { lang, workers, langPath, onProgress });
        }
      }
      if (await tesseractAvailable(lang, langPath, nativeBin)) {
        const bin = await resolveTesseractBinary(nativeBin);
        if (bin !== null) return ocrTesseractBatch(bin, jobs, { lang, workers, langPath, onProgress });
      }
    }
  }
  return ocrWasmBatch(jobs, { lang, workers, langPath, onProgress });
}

// ---------------------------------------------------------------------------
// rapidocr / tesserocr 常驻后端：每 worker 一个 python 进程，4 字节大端长度帧协议
// ---------------------------------------------------------------------------

function submitFrame(child, png) {
  const frame = Buffer.from(png);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(frame.length);
  child.stdin.write(header);
  child.stdin.write(frame);
}

async function* readFrames(stream) {
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      yield buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
    }
  }
}

/**
 * 常驻帧协议批量识别（rapidocr / tesserocr 共用）：
 * @param procSpecs [{ argv: string[] }]，数量 = 并发进程数
 * @returns 与 jobs 顺序一致的 [{ page, text }]
 */
export async function runFrameWorkers(procSpecs, jobs, onProgress) {
  const results = new Array(jobs.length);
  const procs = [];
  for (const spec of procSpecs) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const queue = []; // FIFO: { resolve, reject }
    const pump = (async () => {
      try {
        for await (const raw of readFrames(child.stdout)) {
          const head = queue.shift();
          if (head) head.resolve(parseOcrFrame(raw));
        }
        while (queue.length > 0) queue.shift().resolve({ text: "", confidence: null });
      } catch (error) {
        while (queue.length > 0) queue.shift().reject(error);
      }
    })();
    let stderrText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrText += chunk;
    });
    procs.push({ child, queue, pump, stderr: () => stderrText });
  }
  let next = 0;
  const pending = [];
  for (const job of jobs) {
    const proc = procs[next % procs.length];
    next += 1;
    submitFrame(proc.child, job.png);
    pending.push(
      new Promise((resolve, reject) => {
        proc.queue.push({ resolve, reject });
      })
    );
  }
  for (const proc of procs) proc.child.stdin.end();
  const texts = await Promise.all(pending);
  for (let i = 0; i < jobs.length; i++) {
    const parsed = texts[i] ?? { text: "", confidence: null };
    results[i] = {
      page: jobs[i].page,
      text: String(parsed.text ?? "").trim(),
      ...(Number.isFinite(parsed.confidence) ? { confidence: parsed.confidence } : {}),
    };
  }
  await Promise.allSettled(procs.map((p) => p.pump));
  if (typeof onProgress === "function") onProgress(jobs.length, jobs.length);
  return results;
}

async function ocrRapidBatch(pythonBin, jobs, { workers, onProgress }) {
  const procCount = Math.max(1, Math.min(Math.max(1, workers), jobs.length));
  const procSpecs = Array.from({ length: procCount }, () => ({ argv: [pythonBin, RAPIDOCR_SCRIPT] }));
  return runFrameWorkers(procSpecs, jobs, onProgress);
}

async function ocrTesserocrBatch(pythonBin, jobs, { lang, workers, langPath, onProgress }) {
  const procCount = Math.max(1, Math.min(Math.max(1, workers), jobs.length));
  const procSpecs = Array.from({ length: procCount }, () => ({
    argv: [pythonBin, TESSEROCR_SCRIPT, lang, langPath],
  }));
  return runFrameWorkers(procSpecs, jobs, onProgress);
}

// ---------------------------------------------------------------------------
// tesseract 原生后端：每页一个进程
// ---------------------------------------------------------------------------

function ocrOneTesseract(bin, png, lang, langPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["stdin", "stdout", "-l", lang, "--tessdata-dir", langPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`tesseract 退出码 ${code}: ${err.trim().slice(0, 200)}`));
    });
    child.stdin.end(Buffer.from(png));
  });
}

async function ocrTesseractBatch(bin, jobs, { lang, workers, langPath, onProgress }) {
  const results = new Array(jobs.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= jobs.length) break;
      const job = jobs[idx];
      try {
        results[idx] = { page: job.page, text: String(await ocrOneTesseract(bin, job.png, lang, langPath)).trim() };
      } catch (error) {
        results[idx] = { page: job.page, text: "", error: String(error?.message ?? error) };
      }
      if (typeof onProgress === "function") onProgress(idx + 1, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, workers) }, runner));
  return results;
}

// ---------------------------------------------------------------------------
// wasm 后端（tesseract.js，兜底）
// ---------------------------------------------------------------------------

async function ocrWasmBatch(jobs, { lang, workers, langPath, onProgress }) {
  const status = await tessDataStatus(lang, langPath);
  if (status.missing.length > 0) throw missingTessdataError(lang, langPath);
  const { createWorker } = await import("tesseract.js");
  const pool = [];
  const errors = [];
  for (let i = 0; i < Math.max(1, workers); i++) {
    try {
      pool.push(
        await createWorker(lang, 1, {
          langPath,
          gzip: true,
          cachePath: join(tmpdir(), "dsh-kb-tess-cache"),
        })
      );
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }
  if (pool.length === 0) {
    throw new Error(
      `OCR 引擎初始化失败: ${errors[0] || "未知错误"}（请确认 data/tessdata 下存在 ${lang
        .split("+")
        .map((l) => l + ".traineddata.gz")
        .join("、")}）`
    );
  }
  const results = new Array(jobs.length);
  let next = 0;
  const runner = async (worker) => {
    for (;;) {
      const idx = next++;
      if (idx >= jobs.length) break;
      const job = jobs[idx];
      try {
        const { data } = await worker.recognize(job.png);
        results[idx] = {
          page: job.page,
          text: String(data?.text ?? "").trim(),
          confidence: data?.confidence ?? 0,
        };
      } catch (error) {
        results[idx] = { page: job.page, text: "", error: String(error?.message ?? error) };
      }
      if (typeof onProgress === "function") onProgress(idx + 1, jobs.length);
    }
  };
  await Promise.all(pool.map(runner));
  await Promise.allSettled(pool.map((w) => w.terminate()));
  if (errors.length > 0 && errors.length === Math.max(1, workers)) {
    throw new Error(`OCR 引擎初始化失败: ${errors[0]}`);
  }
  return results;
}
