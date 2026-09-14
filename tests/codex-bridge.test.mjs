import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { codexFixture, processExists, startBridge, waitForCapture } from "./fixtures/codex-test-helpers.mjs";

test("bridge remains healthy without a CLI and reports an actionable missing-path error", async (t) => {
  const fixture = await codexFixture(t);
  const { base, post } = await startBridge(t, { ...fixture.env, PAPERLENS_CODEX_PATH: join(fixture.directory, "missing.exe") });
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.providers["local-codex"].installed, false);
  const result = await post("/invoke", { mode: "chat", question: "test" });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "codex_not_found");
});

test("bridge distinguishes login status and observes login changes without restarting", async (t) => {
  const fixture = await codexFixture(t);
  await fixture.setState({ login: "out" });
  const { base, post } = await startBridge(t, fixture.env);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.providers["local-codex"].installed, true);
  assert.equal(health.providers["local-codex"].loggedIn, false);
  assert.equal(health.providers["local-codex"].available, false);
  assert.equal((await post("/test-provider", { provider: "local-codex" })).body.code, "codex_not_logged_in");
  await fixture.setState({});
  const connected = await post("/test-provider", { provider: "local-codex" });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.loggedIn, true);
  assert.equal((await post("/invoke", { mode: "chat", question: "test" })).status, 200);
  await fixture.setState({ login: "out" });
  assert.equal((await post("/invoke", { mode: "chat", question: "test" })).status, 401);
});

for (const withSkill of [false, true]) {
  test(`bridge passes prompts and image files with the optional skill ${withSkill ? "present" : "absent"}`, async (t) => {
    const fixture = await codexFixture(t);
    if (withSkill) await writeFile(fixture.env.PAPERLENS_SKILL_PATH, "PAPERLENS_OPTIONAL_SKILL_TEST");
    const { post } = await startBridge(t, fixture.env);
    const bytes = Buffer.from("image fixture bytes");
    const result = await post("/invoke", {
      mode: "translate", pageText: "English 中文 & %PATH%", paperTitle: 'Title "with quotes"',
      images: [{ dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, label: "中文图示" }],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.threadId, "fixture-thread");
    const echoed = JSON.parse(result.body.answer);
    assert.equal(echoed.input.includes("PAPERLENS_OPTIONAL_SKILL_TEST"), withSkill);
    assert.match(echoed.input, /English 中文 & %PATH%/);
    assert.equal(echoed.codexHome, fixture.env.CODEX_HOME);
    assert.equal(echoed.args.at(-1), "-");
    assert.ok(echoed.args.includes("--ephemeral"));
    assert.ok(!echoed.args.includes(echoed.input));
    assert.equal(echoed.images[0].base64, bytes.toString("base64"));
    assert.match(echoed.images[0].path, /临时 images/);
    await assert.rejects(access(dirname(echoed.images[0].path)), { code: "ENOENT" });
  });
}

test("bridge returns intact Unicode and rejects failed or empty exec output", async (t) => {
  const fixture = await codexFixture(t);
  const { post } = await startBridge(t, fixture.env);
  await fixture.setState({ mode: "unicode" });
  assert.equal((await post("/invoke", { mode: "chat", question: "test" })).body.answer, "中文答案🙂");
  for (const mode of ["failure", "empty"]) {
    await fixture.setState({ mode });
    const result = await post("/invoke", { mode: "chat", question: "test" });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, "codex_exec_failed");
    if (mode === "failure") assert.equal(result.body.error, "fixture upstream failed");
  }
});

test("disconnecting a request stops its process tree before cleaning up images and activity", async (t) => {
  const fixture = await codexFixture(t);
  const capturePath = join(fixture.directory, "running.json");
  await fixture.setState({ mode: "tree", capturePath });
  const { base, post } = await startBridge(t, fixture.env);
  const controller = new AbortController();
  const running = post("/invoke", { mode: "chat", question: "test", images: [{ dataUrl: "data:image/png;base64,dGVzdA==" }] }, controller.signal);
  const rejected = assert.rejects(running, { name: "AbortError" });
  const tree = await waitForCapture(capturePath);
  assert.equal(await readFile(tree.images[0].path, "utf8"), "test");
  controller.abort();
  await rejected;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const health = await (await fetch(`${base}/health`)).json();
    if (!health.providers["local-codex"].busy) break;
    await delay(50);
  }
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.providers["local-codex"].busy, false);
  assert.equal(processExists(tree.parentPid), false);
  for (let attempt = 0; attempt < 40 && processExists(tree.pid); attempt += 1) await delay(50);
  assert.equal(processExists(tree.pid), false);
  await assert.rejects(access(dirname(tree.images[0].path)), { code: "ENOENT" });
});

test("stopping the bridge also stops an active CLI process group", async (t) => {
  const fixture = await codexFixture(t);
  const capturePath = join(fixture.directory, "shutdown.json");
  await fixture.setState({ mode: "tree", capturePath });
  const { post, stop } = await startBridge(t, fixture.env);
  // Windows taskkill disconnects the socket; POSIX graceful shutdown returns 499.
  const running = post("/invoke", { mode: "chat", question: "test" }).catch((error) => error);
  const tree = await waitForCapture(capturePath);
  await stop();
  const result = await running;
  if (!(result instanceof Error)) assert.equal(result.status, 499);
  assert.equal(processExists(tree.parentPid), false);
  for (let attempt = 0; attempt < 40 && processExists(tree.pid); attempt += 1) await delay(50);
  assert.equal(processExists(tree.pid), false);
});
