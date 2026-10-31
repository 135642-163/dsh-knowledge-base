/**
 * 扫描页 OCR 前的水印净化。
 *
 * 思路：水印通常是**浅灰/浅色、大面积、离正文笔画较远**的叠加层；
 * 正文笔画（含抗锯齿边缘）附近一定有深色核心。因此：
 *  1. 用亮度直方图估计纸张亮度与墨色亮度，没有明显中间调 → 不动（干净页/低对比扫描）；
 *  2. 生成“深色核心”掩膜并做半径 2 的膨胀，得到“正文邻域”；
 *  3. 亮度高于水印阈值、且不在正文邻域的像素置白（auto）；
 *     strong 模式进一步放宽（不要求远离正文），用于水印压在正文上的重扫描件。
 *
 * 只改 OCR 用的内存 pixmap，不写回原件；无中间调或中间调过少时整页跳过。
 */

export const WATERMARK_MODES = ["auto", "off", "strong"];
const MAX_SAMPLE = 600_000;

function lumaAt(samples, offset) {
  return (samples[offset] * 299 + samples[offset + 1] * 587 + samples[offset + 2] * 114) / 1000;
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * 在像素缓冲上原地去水印。
 * @param samples Uint8ClampedArray/Uint8Array（RGB 或 RGBA）
 * @param opts {width,height,stride,components,mode}
 * @returns {changed, removed, ratio, paper, ink, threshold}
 */
export function removeWatermarkPixels(samples, opts = {}) {
  const mode = WATERMARK_MODES.includes(String(opts.mode ?? "")) ? String(opts.mode) : "auto";
  const width = Math.max(0, Math.floor(Number(opts.width) || 0));
  const height = Math.max(0, Math.floor(Number(opts.height) || 0));
  const components = Number(opts.components) || 3;
  const stride = Math.max(width * components, Math.floor(Number(opts.stride) || width * components));
  const result = { changed: false, removed: 0, ratio: 0, paper: 0, ink: 0, threshold: 0 };
  if (mode === "off" || width < 8 || height < 8 || !samples || samples.length < stride * height) {
    return result;
  }

  // 1) 抽样亮度直方图（大页降采样，避免多一次全图扫描）
  const totalPixels = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(totalPixels / MAX_SAMPLE)));
  const hist = new Uint32Array(256);
  let sampled = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * stride;
    for (let x = 0; x < width; x += step) {
      const offset = row + x * components;
      hist[clampByte(Math.round(lumaAt(samples, offset)))] += 1;
      sampled += 1;
    }
  }
  if (sampled === 0) return result;

  // 2) 纸张亮度：高亮区的众数（平滑 ±3 邻域）
  let paperBin = -1;
  let paperCount = 0;
  for (let bin = 160; bin <= 255; bin += 1) {
    let count = 0;
    for (let d = -2; d <= 2; d += 1) count += hist[clampByte(bin + d)];
    if (count > paperCount) {
      paperCount = count;
      paperBin = bin;
    }
  }
  if (paperBin < 0 || paperCount < sampled * 0.2) return result; // 没有足够的纸张底色

  // 3) 墨色亮度：从 0 向上累计 1.5% 采样
  let cumulative = 0;
  let inkBin = 0;
  for (let bin = 0; bin < 256; bin += 1) {
    cumulative += hist[bin];
    if (cumulative >= sampled * 0.015) {
      inkBin = bin;
      break;
    }
  }
  // 低对比扫描（纸灰、字浅）不做净化，避免把正文洗掉。
  if (paperBin - inkBin < 70) return result;

  // 4) 中间调是否足够多（水印候选）；抗锯齿边缘也会贡献少量，阈值取高一些。
  let mid = 0;
  const midStart = Math.min(paperBin - 8, inkBin + 28);
  for (let bin = midStart; bin < paperBin - 4; bin += 1) mid += hist[bin];
  const minRatio = mode === "strong" ? 0.0015 : 0.004;
  if (mid / sampled < minRatio) return result;

  const paper = paperBin;
  const ink = inkBin;
  // 水印阈值：auto 只去掉明显浅于正文的层；strong 连压在正文上的浅灰也洗掉。
  const threshold = mode === "strong"
    ? Math.round(paper - (paper - ink) * 0.5)
    : Math.round(paper - (paper - ink) * 0.32);
  const darkCut = Math.min(ink + 45, Math.round((paper + ink) / 2));
  const radius = mode === "strong" ? 1 : 2;

  // 5) 深色核心掩膜 + 半径膨胀（水平/垂直两趟滑动窗口）。
  const dark = new Uint8Array(totalPixels);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const base = y * width;
    for (let x = 0; x < width; x += 1) {
      const offset = row + x * components;
      dark[base + x] = lumaAt(samples, offset) < darkCut ? 1 : 0;
    }
  }
  const horizontal = new Uint8Array(totalPixels);
  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let count = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x += 1) count += dark[base + x];
    for (let x = 0; x < width; x += 1) {
      horizontal[base + x] = count > 0 ? 1 : 0;
      const add = x + radius + 1;
      const remove = x - radius;
      if (add < width) count += dark[base + add];
      if (remove >= 0) count -= dark[base + remove];
    }
  }
  const nearDark = new Uint8Array(totalPixels);
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y += 1) count += horizontal[y * width + x];
    for (let y = 0; y < height; y += 1) {
      nearDark[y * width + x] = count > 0 ? 1 : 0;
      const add = y + radius + 1;
      const remove = y - radius;
      if (add < height) count += horizontal[add * width + x];
      if (remove >= 0) count -= horizontal[remove * width + x];
    }
  }

  // 6) 置白：高于阈值且（strong 或）远离正文。
  let removed = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const base = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mode !== "strong" && nearDark[base + x] === 1) continue;
      const offset = row + x * components;
      if (lumaAt(samples, offset) < threshold) continue;
      // 只统计真的被改写的像素：白纸本来就 255，不能算“去除水印”。
      if (samples[offset] === 255 && samples[offset + 1] === 255 && samples[offset + 2] === 255) continue;
      samples[offset] = 255;
      samples[offset + 1] = 255;
      samples[offset + 2] = 255;
      removed += 1;
    }
  }
  // 只洗掉极少数像素的页不算“去水印”，避免无谓改动干净页。
  if (removed < Math.max(50, totalPixels * 0.0005)) return result;
  result.changed = true;
  result.removed = removed;
  result.ratio = removed / totalPixels;
  result.paper = paper;
  result.ink = ink;
  result.threshold = threshold;
  return result;
}

/** 直接处理 mupdf Pixmap（getPixels() 是 wasm 堆视图，原地改即可影响 asPNG）。 */
export function preprocessPixmap(pixmap, { mode = "auto" } = {}) {
  if (!pixmap || mode === "off") return { changed: false, removed: 0, ratio: 0 };
  let width = 0;
  let height = 0;
  let stride = 0;
  let components = 0;
  let samples = null;
  try {
    width = pixmap.getWidth();
    height = pixmap.getHeight();
    stride = pixmap.getStride();
    components = pixmap.getNumberOfComponents();
    samples = pixmap.getPixels();
  } catch {
    return { changed: false, removed: 0, ratio: 0 };
  }
  if (!samples || components < 3) return { changed: false, removed: 0, ratio: 0 };
  return removeWatermarkPixels(samples, { width, height, stride, components, mode });
}
