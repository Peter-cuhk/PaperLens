import assert from "node:assert/strict";
import { copyFile, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { detectCodexInstallation, readCodexLoginStatus, resolveCodexCommand, runCodexCommand } from "../bridge/codex-cli.mjs";
import { codexFixture, processExists, waitForCapture } from "./fixtures/codex-test-helpers.mjs";

test("detects and probes an explicit JavaScript CLI in a Unicode path with spaces", async (t) => {
  const fixture = await codexFixture(t);
  const installation = await detectCodexInstallation({ env: fixture.env });
  assert.equal(installation.installed, true);
  assert.equal(installation.command, process.execPath);
  assert.deepEqual(installation.args, [await realpath(fixture.executable)]);
  assert.equal(installation.version, "codex-cli 0.146.0");
});

test("an explicit missing or broken override does not silently select another CLI", async (t) => {
  const fixture = await codexFixture(t);
  const env = { ...fixture.env, Path: fixture.directory, PAPERLENS_CODEX_PATH: join(fixture.directory, "missing.exe") };
  const missing = await detectCodexInstallation({ env });
  assert.equal(missing.installed, false);
  assert.equal(missing.error.code, "codex_not_found");
  const broken = join(fixture.directory, "broken.mjs");
  await writeFile(broken, 'console.log("not the Codex CLI");');
  const result = await detectCodexInstallation({ env: { ...env, PAPERLENS_CODEX_PATH: broken } });
  assert.equal(result.installed, false);
  assert.equal(result.error.code, "codex_start_failed");
});

test("Windows PATH lookup recognizes npm shims and passes arguments without a shell", async (t) => {
  const fixture = await codexFixture(t);
  const root = join(fixture.directory, "npm prefix");
  const packageRoot = join(root, "node_modules", "@openai", "codex");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", type: "module", bin: { codex: "bin/codex.js" } }));
  const script = join(packageRoot, "bin", "codex.js");
  await copyFile(fixture.executable, script);
  for (const extension of ["cmd", "ps1", "bat"]) {
    const shim = join(root, `codex.${extension}`);
    await writeFile(shim, '@echo off\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
    const command = await resolveCodexCommand(shim, { platform: "win32" });
    assert.equal(command.command, process.execPath);
    assert.deepEqual(command.args, [script]);
    const args = ["exec", "--image", 'C:\\中文 folder\\a & b %PATH% !quoted! "x".png'];
    // Test shell metacharacters as ordinary values without requiring an image.
    args[1] = "--fixture-value";
    const result = await runCodexCommand(command, args, { env: fixture.env, input: "中文\n$() & %PATH%" });
    const event = JSON.parse(result.stdout.trim().split("\n").at(-1));
    const echoed = JSON.parse(event.item.text);
    assert.deepEqual(echoed.args, args);
    assert.equal(echoed.input, "中文\n$() & %PATH%");
  }
  const env = Object.fromEntries(Object.entries(fixture.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.Path = `${join(fixture.directory, "missing")};${root}`;
  env.PAPERLENS_CODEX_PATH = "";
  const installation = await detectCodexInstallation({ env, platform: "win32" });
  assert.equal(installation.installed, true);
  assert.equal(installation.source, join(root, "codex.cmd"));
  env.PAPERLENS_CODEX_PATH = "codex.ps1";
  assert.equal((await detectCodexInstallation({ env, platform: "win32" })).source, join(root, "codex.ps1"));
});

test("rejects unknown Windows shell wrappers and resolves native executables directly", async (t) => {
  const fixture = await codexFixture(t);
  const shim = join(fixture.directory, "custom.cmd");
  await writeFile(shim, "@echo off\necho custom launcher\n");
  await assert.rejects(resolveCodexCommand(shim, { platform: "win32" }), { code: "codex_unsupported_wrapper" });
  const executable = await resolveCodexCommand(process.execPath);
  assert.equal(executable.command, await realpath(process.execPath));
  assert.deepEqual(executable.args, []);
});

test("POSIX PATH lookup follows npm's codex symlink to its JavaScript entry", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await codexFixture(t);
  await symlink(fixture.executable, join(fixture.directory, "codex"));
  const installation = await detectCodexInstallation({ env: { ...fixture.env, PATH: fixture.directory, PAPERLENS_CODEX_PATH: "" } });
  assert.equal(installation.installed, true);
  assert.equal(installation.command, process.execPath);
});

test("login probing distinguishes signed out and probe failures without exposing credentials", async (t) => {
  const fixture = await codexFixture(t);
  const installation = await detectCodexInstallation({ env: fixture.env });
  assert.deepEqual(await readCodexLoginStatus(installation, { env: fixture.env }), { loggedIn: true });
  await fixture.setState({ login: "out" });
  const signedOut = await readCodexLoginStatus(installation, { env: fixture.env });
  assert.equal(signedOut.loggedIn, false);
  assert.equal(signedOut.error.code, "codex_not_logged_in");
  assert.equal(signedOut.error.status, 401);
  await fixture.setState({ login: "error" });
  const failure = await readCodexLoginStatus(installation, { env: fixture.env });
  assert.equal(failure.error.code, "codex_login_check_failed");
  assert.doesNotMatch(failure.error.message, /TEST_SECRET/);
});

test("captures split UTF-8 output and a final line without a newline", async (t) => {
  const fixture = await codexFixture(t);
  await fixture.setState({ mode: "unicode" });
  const result = await runCodexCommand(await resolveCodexCommand(fixture.executable), ["exec"], { env: fixture.env });
  assert.equal(JSON.parse(result.stdout.split("\n").at(-1)).item.text, "中文答案🙂");
});

test("spawn errors and a CLI closing stdin early are handled without crashing", async (t) => {
  const fixture = await codexFixture(t);
  await assert.rejects(runCodexCommand({ command: join(fixture.directory, "missing.exe"), args: [] }, []), { code: "codex_start_failed" });
  const result = await runCodexCommand(await resolveCodexCommand(fixture.executable), ["--fixture-exit"], {
    env: fixture.env, input: "x".repeat(4 * 1024 * 1024),
  });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "fixture rejected arguments");
});

test("bounds captured output and honors cancellation before spawning", async (t) => {
  const fixture = await codexFixture(t);
  const command = await resolveCodexCommand(fixture.executable);
  await assert.rejects(runCodexCommand(command, ["--fixture-flood"], { env: fixture.env, maxOutputBytes: 1024 }), { code: "codex_output_limit" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCodexCommand({ command: "missing", args: [] }, [], { signal: controller.signal }), { code: "request_aborted" });
});

for (const reason of ["cancel", "timeout"]) {
  test(`${reason} stops the CLI wrapper and its child before settling`, async (t) => {
    const fixture = await codexFixture(t);
    const capturePath = join(fixture.directory, "tree.json");
    await fixture.setState({ capturePath });
    const controller = new AbortController();
    const command = await resolveCodexCommand(fixture.executable);
    const running = runCodexCommand(command, ["--fixture-tree"], {
      env: fixture.env, signal: controller.signal, timeoutMs: reason === "timeout" ? 5000 : 15000,
    });
    const rejected = assert.rejects(running, { code: reason === "timeout" ? "upstream_timeout" : "request_aborted" });
    const tree = await waitForCapture(capturePath);
    assert.equal(processExists(tree.pid), true);
    if (reason === "cancel") controller.abort();
    await rejected;
    assert.equal(processExists(tree.parentPid), false);
    // Allow the OS to reap the descendant after the parent has closed its pipes.
    for (let attempt = 0; attempt < 40 && processExists(tree.pid); attempt += 1) await delay(50);
    assert.equal(processExists(tree.pid), false);
  });
}
