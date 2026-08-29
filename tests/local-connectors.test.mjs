import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("local edition exposes only Codex and ChatGPT Web Chat providers", async () => {
  const [page, server, routing, doctor, env, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("bridge/server.mjs", root), "utf8"),
    readFile(new URL("bridge/provider-routing.mjs", root), "utf8"),
    readFile(new URL("scripts/doctor.mjs", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  assert.match(routing, /PROVIDER_IDS = \["local-codex", "chatgpt-web"\]/);
  assert.match(doctor, /"Codex account"/);
  assert.match(doctor, /"Codex quota"/);
  for (const source of [page, server, routing, env, packageJson]) {
    assert.doesNotMatch(source, /cloudbase-hunyuan|CLOUDBASE_APIKEY|MIMO_API_KEY|OPENAI_API_KEY|Xiaomi MiMo|OpenAI API/);
  }
});

test("ChatGPT Web extension carries structured tasks and image attachments through visible Chat", async () => {
  const [page, recovery, provider, background, content] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/ai-recovery.ts", root), "utf8"),
    readFile(new URL("bridge/providers/chatgpt-web.mjs", root), "utf8"),
    readFile(new URL("browser-extension/background.js", root), "utf8"),
    readFile(new URL("browser-extension/content.js", root), "utf8"),
  ]);
  assert.match(provider, /structuredOutput: true/);
  assert.match(provider, /models: \{ translation: "chatgpt-web", chat: "chatgpt-web" \}/);
  assert.match(background, /images: Array\.isArray\(message\.images\)/);
  assert.match(content, /async function attachImages/);
  assert.match(content, /input\.files = transfer\.files/);
  assert.doesNotMatch(page, /repairAttempt > 0[^\n]+local-codex/);
  assert.doesNotMatch(recovery, /provider: "local-codex"/);
});
