import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

async function waitFor(check) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "timed out waiting for Office conversion lifecycle");
    await delay(25);
  }
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function isRunning(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "expected a positive fixture process ID");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

test("bridge reports Office availability, rejects concurrent conversions, and cleans up on disconnect and shutdown", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paperlens Office bridge 中文-"));
  const recordPath = join(root, "invocation.json");
  const owned = new Set();
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const bridge = fork(new URL("../bridge/server.mjs", import.meta.url), [], {
    execArgv: ["--import", new URL("./fixtures/soffice-controller.mjs", import.meta.url).href],
    env: {
      ...process.env, PAPERLENS_CODEX_PORT: String(port), PAPERLENS_CHATGPT_WEB_ENABLED: "0",
      PAPERLENS_CODEX_PATH: join(root, "missing-codex"), PAPERLENS_SKILL_PATH: join(root, "missing-skill"),
      PAPERLENS_SOFFICE_PATH: process.execPath, PAPERLENS_SOFFICE_FIXTURE_RECORD: recordPath,
      PAPERLENS_SOFFICE_FIXTURE_MODE: "from-input",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  let output = "";
  bridge.stdout.on("data", (data) => { output += data; });
  bridge.stderr.on("data", (data) => { output += data; });
  const closed = new Promise((resolve) => bridge.once("close", resolve));
  t.after(async () => {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill();
    for (const pid of owned) if (isRunning(pid)) process.kill(pid, "SIGKILL");
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => {
    assert.equal(bridge.exitCode, null, output);
    return output.includes("PaperLens AI bridge:");
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.documentConversion.available, true);
  assert.equal(health.documentConversion.engine, "LibreOffice");
  const convert = (body, signal) => fetch(`${base}/convert-document`, {
    method: "POST", headers: { "x-paperlens-file-name": encodeURIComponent("课程 notes.docx") }, body, signal,
  });
  for (const termination of ["disconnect", "shutdown"]) {
    await rm(recordPath, { force: true });
    await rm(`${recordPath}.child`, { force: true });
    const controller = new AbortController();
    const pending = convert("hang", controller.signal).catch((error) => error);
    await waitFor(async () => (await exists(`${recordPath}.child`)) && (await exists(recordPath)));
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const descendant = Number(await readFile(`${recordPath}.child`, "utf8"));
    assert.ok(isRunning(record.pid));
    assert.ok(isRunning(descendant));
    assert.equal(record.descendant, descendant);
    owned.add(record.pid);
    owned.add(record.descendant);
    assert.ok(await exists(record.directory));
    const busy = await convert("success");
    assert.equal(busy.status, 429);
    assert.equal((await busy.json()).code, "converter_busy");
    if (termination === "disconnect") controller.abort();
    else bridge.send("SIGTERM");
    await pending;
    await waitFor(async () => !(await exists(record.directory)));
    await waitFor(() => !isRunning(record.descendant));
    assert.equal(isRunning(record.pid), false);
    assert.equal(isRunning(record.descendant), false);
    if (termination === "disconnect") {
      const retry = await convert("success");
      assert.equal(retry.status, 200);
      assert.match(retry.headers.get("content-type"), /application\/pdf/);
      assert.match(await retry.text(), /^%PDF-/);
    }
  }
  assert.equal(await closed, 0, output);
});
