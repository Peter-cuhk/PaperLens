import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readCodexModels, codexModelForRequest, codexEffortForRequest } from "../bridge/codex-models.mjs";
import { codexFixture, startBridge } from "./fixtures/codex-test-helpers.mjs";

test("defaults to Luna/medium for translation and terms, Sol/high for questions", () => {
  const catalog = { "gpt-5.6-luna": ["medium", "high"], "gpt-5.6-sol": ["high", "xhigh"] };
  for (const mode of ["translate", "terms", "chat", "auto", "repository"]) {
    const translation = mode === "translate" || mode === "terms";
    const model = codexModelForRequest(mode, {}, Object.keys(catalog));
    assert.equal(model, translation ? "gpt-5.6-luna" : "gpt-5.6-sol");
    assert.equal(codexEffortForRequest(mode, {}, model, catalog), translation ? "medium" : "high");
  }
  assert.equal(codexModelForRequest("chat", { provider: "mimo", chatModel: "mimo-v2.5" }, Object.keys(catalog)), "gpt-5.6-sol");
  assert.throws(() => codexEffortForRequest("chat", { chatReasoningEffort: "ultra" }, "gpt-5.6-luna", catalog), /不支持/);
});

test("bridge passes independent translation/chat choices to the CLI and reports the chosen model", async (t) => {
  const fixture = await codexFixture(t);
  const directory = fixture.env.CODEX_HOME;
  await writeFile(join(directory, "models_cache.json"), JSON.stringify({ models: [
    { slug: "test-translation", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] },
    { slug: "test-chat", visibility: "list", supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }] },
    { slug: "internal-model", visibility: "hide" },
  ] }));
  assert.deepEqual(await readCodexModels(directory), ["test-translation", "test-chat"]);
  assert.deepEqual(await readCodexModels(join(directory, "missing")), []);
  const { base } = await startBridge(t, fixture.env);
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health.providers["local-codex"].allowedModels, ["test-translation", "test-chat"]);
  for (const mode of ["translate", "terms", "chat", "auto", "repository"]) {
    const response = await fetch(`${base}/invoke`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "local-codex", mode, question: "test", pageText: "test", repositoryUrl: "https://github.com/example/example", translationModel: "test-translation", chatModel: "test-chat", translationReasoningEffort: "medium", chatReasoningEffort: "xhigh" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const { args } = JSON.parse(result.answer);
    const expected = mode === "translate" || mode === "terms" ? "test-translation" : "test-chat";
    assert.equal(args[args.indexOf("--model") + 1], expected);
    assert.equal(result.model, expected);
    const expectedEffort = mode === "translate" || mode === "terms" ? "medium" : "xhigh";
    assert.ok(args.includes(`model_reasoning_effort="${expectedEffort}"`));
    assert.equal(result.reasoningEffort, expectedEffort);
    assert.ok(args.includes("read-only"));
    assert.equal(args.includes("--ignore-user-config"), mode !== "auto" && mode !== "repository");
  }
  for (const selected of ["", "not-in-catalog"]) {
    const response = await fetch(`${base}/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "local-codex", mode: "chat", question: "test", chatModel: selected }) });
    const result = await response.json();
    if (selected) { assert.equal(response.status, 400); assert.equal(result.code, "invalid_model"); }
    else { assert.equal(response.status, 200); assert.ok(!JSON.parse(result.answer).args.includes("--model")); }
  }
});
