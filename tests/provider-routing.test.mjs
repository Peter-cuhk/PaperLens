import assert from "node:assert/strict";
import test from "node:test";

import { requiresRepositoryVerification, resolveProviderRoute, shouldFallbackToMiMo } from "../bridge/provider-routing.mjs";

test("routes ordinary auto questions through the selected API provider", () => {
  const route = resolveProviderRoute({ mode: "auto", question: "这段方法的直觉是什么？" }, "mimo", { "local-codex": true, mimo: true });
  assert.equal(route.provider, "mimo");
  assert.equal(route.payload.mode, "chat");
  assert.equal(route.repositoryDecision, "skipped");
});

test("falls back to local Codex when an API question requires repository evidence", () => {
  const payload = { mode: "auto", question: "训练脚本中的配置参数在哪里？" };
  assert.equal(requiresRepositoryVerification(payload), true);
  const route = resolveProviderRoute(payload, "mimo", { "local-codex": true, mimo: true });
  assert.equal(route.provider, "local-codex");
  assert.match(route.fallbackReason, /核实资料对应仓库/);
});

test("reports a capability error when repository verification has no local provider", () => {
  const route = resolveProviderRoute({ mode: "repository", question: "核对实现" }, "openai", { "local-codex": false, openai: true });
  assert.equal(route.provider, "openai");
  assert.match(route.unsupportedReason, /本机 Codex 当前不可用/);
});

test("falls back from CloudBase Hy3 to MiMo without retrying explicit cancellations", () => {
  assert.equal(shouldFallbackToMiMo("cloudbase-hunyuan", "quota_exceeded", { mimo: true }), true);
  assert.equal(shouldFallbackToMiMo("cloudbase-hunyuan", "request_aborted", { mimo: true }), false);
  assert.equal(shouldFallbackToMiMo("mimo", "upstream_unavailable", { mimo: true }), false);
  assert.equal(shouldFallbackToMiMo("cloudbase-hunyuan", "upstream_unavailable", { mimo: false }), false);
});

test("keeps ChatGPT Web for chat but routes translation and terms to MiMo", () => {
  const chat = resolveProviderRoute({ mode: "chat", question: "解释选中段落" }, "chatgpt-web", { "chatgpt-web": true, mimo: true });
  assert.equal(chat.provider, "chatgpt-web");

  const translation = resolveProviderRoute({ mode: "translate", pageText: "paper" }, "chatgpt-web", { "chatgpt-web": true, mimo: true });
  assert.equal(translation.provider, "mimo");
  assert.match(translation.fallbackReason, /只用于问答/);

  const terms = resolveProviderRoute({ mode: "terms", pageText: "paper" }, "chatgpt-web", { "chatgpt-web": true, mimo: false });
  assert.equal(terms.provider, "chatgpt-web");
  assert.match(terms.unsupportedReason, /请先配置 MiMo/);
});
