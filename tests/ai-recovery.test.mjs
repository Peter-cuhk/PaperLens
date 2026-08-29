import assert from "node:assert/strict";
import test from "node:test";

import { runWithProviderRecovery } from "../app/ai-recovery.ts";

test("retries a failed AI task with the same selected provider", async () => {
  const calls = [];
  const progress = [];
  const recovery = await runWithProviderRecovery({
    settings: { provider: "chatgpt-web", model: "translation" },
    run: async (settings, repairError) => {
      calls.push({ provider: settings.provider, repairError });
      if (!repairError) throw new Error("段落映射不完整");
      return "ChatGPT 网页修复结果";
    },
    onRepair: (message) => progress.push(message),
  });

  assert.deepEqual(calls, [
    { provider: "chatgpt-web", repairError: "" },
    { provider: "chatgpt-web", repairError: "段落映射不完整" },
  ]);
  assert.deepEqual(progress, ["段落映射不完整"]);
  assert.equal(recovery.value, "ChatGPT 网页修复结果");
  assert.equal(recovery.recovered, true);
});

test("does not turn an explicit cancellation into a Codex repair task", async () => {
  let calls = 0;
  await assert.rejects(runWithProviderRecovery({
    settings: { provider: "chatgpt-web" },
    run: async () => {
      calls += 1;
      throw new DOMException("Aborted", "AbortError");
    },
  }), (error) => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("surfaces the retry error when the selected provider still fails", async () => {
  let calls = 0;
  await assert.rejects(runWithProviderRecovery({
    settings: { provider: "chatgpt-web" },
    run: async () => {
      calls += 1;
      throw new Error(calls === 1 ? "网页响应不完整" : "网页重试仍失败");
    },
  }), /网页重试仍失败/);
  assert.equal(calls, 2);
});
