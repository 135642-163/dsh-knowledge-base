/**
 * 知识库圆点色。
 *
 * 旧实现直接按名称哈希生成连续 HSL（侧栏 55%/52%，卡片 82%/56% 还是两套参数），
 * 黄、橙、橄榄等色相在低明度下容易发灰发脏，而且侧栏和卡片对同一个库显示的颜色
 * 并不一致。这里改成一组经过挑选的高明度色板：所有色相都保持明亮、饱和度足够，
 * 同时侧栏与卡片共用同一个取色函数。
 */

// 16 色明亮色板。相邻项刻意跨色系，两个库即使落在相邻下标也不会糊成一片。
export const KB_COLORS = [
  "#f472b6", // 粉
  "#fb923c", // 橙
  "#38bdf8", // 天蓝
  "#a3e635", // 青柠
  "#a78bfa", // 紫罗兰
  "#fbbf24", // 琥珀
  "#34d399", // 薄荷绿
  "#fb7185", // 珊瑚
  "#60a5fa", // 蓝
  "#2dd4bf", // 青
  "#e879f9", // 洋红
  "#facc15", // 黄
  "#818cf8", // 靛
  "#c084fc", // 紫
  "#22d3ee", // 青蓝
  "#4ade80", // 绿
];

/** 名称 → 32 位哈希；乘法后做一次雪崩，短名称也能散开。 */
function hashName(name) {
  let hash = 0;
  for (const char of String(name ?? "")) {
    hash = (Math.imul(hash, 41) + char.codePointAt(0)) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** 按名称稳定取色；同一个库在侧栏、总览卡片等处颜色一致。 */
export function colorFor(name) {
  return KB_COLORS[hashName(name) % KB_COLORS.length];
}
