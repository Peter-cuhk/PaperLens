import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { vinextArgs } from "../scripts/process-runner.mjs";

const project = new URL("../", import.meta.url);
const controller = new URL("./fixtures/startup-controller.mjs", import.meta.url).href;
const service = new URL("./fixtures/startup-service.mjs", import.meta.url);

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function waitFor(check, description) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(25);
  }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperlens 中文 with spaces-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["scripts", "bridge", "node_modules/vinext/dist"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const name of ["dev.mjs", "vinext.mjs", "process-runner.mjs"]) {
    await copyFile(new URL(`scripts/${name}`, project), join(root, "scripts", name));
  }
  await copyFile(new URL("bridge/process-tree.mjs", project), join(root, "bridge/process-tree.mjs"));
  await writeFile(join(root, "node_modules/vinext/package.json"), JSON.stringify({
    name: "vinext", type: "module", exports: "./dist/index.js",
  }));
  await writeFile(join(root, "node_modules/vinext/dist/index.js"), "");
  for (const name of ["bridge/server.mjs", "scripts/usb-gateway.mjs", "node_modules/vinext/dist/cli.js"]) {
    await copyFile(service, join(root, name));
  }
  return root;
}

function launch(t, root, script, args = [], env = {}) {
  const child = fork(join(root, "scripts", script), args, {
    cwd: tmpdir(), // Launchers must use their project root, not the caller's cwd.
    execArgv: ["--import", controller],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PAPERLENS_STARTUP_FIXTURE_DIR: root, PAPERLENS_STARTUP_INHERITED: "inherited 中文 value", ...env },
    windowsHide: true,
  });
  let output = "";
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const records = () => output.split(/\r?\n/).filter((line) => line.startsWith("fixture ")).flatMap((line) => {
    try { return [JSON.parse(line.slice(8))]; } catch { return []; }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.send("SIGINT");
      await Promise.race([finished, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    // Clean up only these fixtures, even when an assertion fails.
    for (const record of records()) {
      for (const pid of [record.pid, record.descendant].filter(Boolean)) {
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
    }
    await finished;
  });
  return { child, records, finished, output: () => output };
}

test("resolves the installed Vinext CLI declared by the pinned package", async () => {
  const entry = new URL(import.meta.resolve("vinext"));
  const manifest = new URL("../package.json", entry);
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(vinextArgs([])[0], fileURLToPath(new URL(metadata.bin.vinext, manifest)));
});

for (const command of ["build", "start"]) {
  for (const code of [0, 23]) {
    test(`${command} preserves arguments, project cwd, environment and exit code ${code}`, { timeout: 15000 }, async (t) => {
      const root = await fixture(t);
      const args = [command, "--port", "3456", "中文 with spaces", 'literal "quote" & %value% $value;'];
      const app = launch(t, root, "vinext.mjs", args, { PAPERLENS_STARTUP_EXIT_CODE: String(code) });
      assert.deepEqual(await app.finished, { code, signal: null }, app.output());
      const [record] = app.records();
      assert.equal(app.records().length, 1, "build/start must launch only the web tool");
      assert.deepEqual(record.args, args);
      assert.equal(record.cwd, root);
      assert.equal(record.logPath, ".wrangler/wrangler.log");
      assert.equal(record.inherited, "inherited 中文 value");
    });
  }
}

for (const hostname of [[], ["--hostname", "127.0.0.1"], ["-H", "127.0.0.1"], ["--hostname=127.0.0.1"]]) {
  test(`dev forwards ${hostname.join(" ") || "the default localhost"} and stops its process trees`, { timeout: 20000 }, async (t) => {
    const root = await fixture(t);
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    await once(sentinel, "spawn");
    t.after(async () => { const stopped = once(sentinel, "close"); sentinel.kill(); await stopped; });
    const extra = ["--port", "3456", "中文 with spaces", "literal & argument"];
    const app = launch(t, root, "dev.mjs", [...hostname, ...extra]);
    await waitFor(() => app.records().length === 3, "all services to start");
    const web = app.records().find(({ name }) => name === "cli");
    assert.deepEqual(web.args, ["dev", ...(hostname.length ? hostname : ["--hostname", "localhost"]), ...extra]);
    for (const record of app.records()) assert.equal(record.cwd, root);
    app.child.send(hostname.length ? "SIGTERM" : "SIGINT");
    assert.deepEqual(await app.finished, { code: 0, signal: null }, app.output());
    for (const record of app.records()) {
      await waitFor(() => !isRunning(record.pid), `service ${record.pid} to stop`);
      if (record.descendant) await waitFor(() => !isRunning(record.descendant), `descendant ${record.descendant} to stop`);
    }
    assert.ok(isRunning(sentinel.pid), "unrelated Node processes must survive shutdown");
  });
}

for (const code of [0, 17]) {
  test(`dev stops the other services when Vinext exits ${code}`, { timeout: 20000 }, async (t) => {
    const root = await fixture(t);
    const app = launch(t, root, "dev.mjs");
    await waitFor(() => app.records().length === 3, "all services to start");
    await writeFile(join(root, "exit-cli"), String(code));
    assert.deepEqual(await app.finished, { code, signal: null }, app.output());
    for (const record of app.records()) {
      assert.ok(!isRunning(record.pid));
      if (record.descendant) await waitFor(() => !isRunning(record.descendant), "bridge descendant to stop");
    }
  });
}

test("dev stops its peers when a service receives an unexpected termination signal", { timeout: 20000 }, async (t) => {
  const root = await fixture(t);
  const app = launch(t, root, "dev.mjs");
  await waitFor(() => app.records().length === 3, "all services to start");
  process.kill(app.records().find(({ name }) => name === "cli").pid, "SIGTERM");
  const result = await app.finished;
  assert.notEqual(result.code, 0, app.output());
  for (const record of app.records()) assert.ok(!isRunning(record.pid));
});

test("a failed spawn reports the service name and exits without an unhandled error", { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "scripts", "missing-cwd.mjs"), `
    import { runProcesses } from './process-runner.mjs';
    process.exitCode = await runProcesses([{ name: 'missing service', args: [] }],
      { cwd: ${JSON.stringify(join(root, "does-not-exist"))} });
  `);
  const app = launch(t, root, "missing-cwd.mjs");
  assert.equal((await app.finished).code, 1);
  assert.match(app.output(), /could not start missing service:.*ENOENT/);
  assert.doesNotMatch(app.output(), /Unhandled 'error' event/);
});

test("a missing Vinext installation fails before starting bridge or USB services", { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  const app = launch(t, root, "dev.mjs");
  assert.equal((await app.finished).code, 1);
  assert.deepEqual(app.records(), []);
  assert.match(app.output(), /ERR_MODULE_NOT_FOUND/);
});
