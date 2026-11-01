import test from "node:test";
import assert from "node:assert/strict";
import { renameWithRetry } from "../lib/store.js";

test("renameWithRetry：EPERM/EBUSY 短重试后成功", async () => {
  let calls = 0;
  const errors = ["EPERM", "EBUSY", ""];
  const result = await renameWithRetry("a", "b", {
    baseDelayMs: 1,
    renameImpl: async () => {
      const code = errors[calls];
      calls += 1;
      if (code) {
        const error = new Error(code);
        error.code = code;
        throw error;
      }
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("renameWithRetry：非可重试错误立即抛出", async () => {
  let calls = 0;
  await assert.rejects(
    () => renameWithRetry("a", "b", {
      baseDelayMs: 1,
      renameImpl: async () => {
        calls += 1;
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    }),
    (error) => error.code === "ENOENT"
  );
  assert.equal(calls, 1);
});
