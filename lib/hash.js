/**
 * 源文件内容指纹：流式计算 sha256，避免把大文件读进内存。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function hashFile(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
