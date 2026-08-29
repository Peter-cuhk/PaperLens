import assert from "node:assert/strict";
import test from "node:test";

import { requiresRepositoryVerification, resolveProviderRoute } from "../bridge/provider-routing.mjs";

test("routes ordinary auto questions through ChatGPT Web Chat", () => {
  const route = resolveProviderRoute({ mode: "auto", question: "这段方法的直觉是什么？" }, "chatgpt-web", { "local-codex": true, "chatgpt-web": true });
  assert.equal(route.provider, "chatgpt-web");
  assert.equal(route.payload.mode, "chat");
  assert.equal(route.repositoryDecision, "skipped");
});

test("falls back to local Codex when a web question requires repository evidence", () => {
  const payload = { mode: "auto", question: "训练脚本中的配置参数在哪里？" };
  assert.equal(requiresRepositoryVerification(payload), true);
  const route = resolveProviderRoute(payload, "chatgpt-web", { "local-codex": true, "chatgpt-web": true });
  assert.equal(route.provider, "local-codex");
  assert.match(route.fallbackReason, /核实资料对应仓库/);
});

test("reports a capability error when repository verification has no local provider", () => {
  const route = resolveProviderRoute({ mode: "repository", question: "核对实现" }, "chatgpt-web", { "local-codex": false, "chatgpt-web": true });
  assert.equal(route.provider, "chatgpt-web");
  assert.match(route.unsupportedReason, /安装并登录本机 Codex/);
});

test("keeps chat, translation, and terms on ChatGPT Web Chat", () => {
  const chat = resolveProviderRoute({ mode: "chat", question: "解释选中段落" }, "chatgpt-web", { "chatgpt-web": true });
  assert.equal(chat.provider, "chatgpt-web");

  const translation = resolveProviderRoute({ mode: "translate", pageText: "paper" }, "chatgpt-web", { "chatgpt-web": true });
  assert.equal(translation.provider, "chatgpt-web");
  assert.equal(translation.unsupportedReason, undefined);

  const terms = resolveProviderRoute({ mode: "terms", pageText: "paper" }, "chatgpt-web", { "chatgpt-web": true });
  assert.equal(terms.provider, "chatgpt-web");
  assert.equal(terms.unsupportedReason, undefined);
});
