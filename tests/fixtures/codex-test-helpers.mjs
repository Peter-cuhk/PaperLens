import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stopProcessTree } from "../../bridge/process-tree.mjs";

export async function codexFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "PaperLens Codex 中文 with spaces "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "codex.mjs");
  const statePath = join(directory, "state.json");
  const temp = join(directory, "临时 images");
  const codexHome = join(directory, "codex home");
  await mkdir(temp);
  await mkdir(codexHome);
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-5.6-luna", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] },
    { slug: "gpt-5.6-sol", visibility: "list", supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }] },
  ] }));
  await copyFile(new URL("./fake-codex.mjs", import.meta.url), executable);
  const setState = (state) => writeFile(statePath, JSON.stringify(state));
  await setState({});
  const env = {
    ...process.env, CODEX_HOME: codexHome, PAPERLENS_CODEX_PATH: executable,
    PAPERLENS_TEST_CODEX_STATE: statePath, PAPERLENS_SKILL_PATH: join(directory, "optional-skill.md"),
    TMP: temp, TEMP: temp, TMPDIR: temp, PAPERLENS_CHATGPT_WEB_ENABLED: "0",
    OPENAI_API_KEY: "", MIMO_API_KEY: "", CLOUDBASE_APIKEY: "",
  };
  return { directory, executable, env, setState };
}

export async function startBridge(t, env) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ["bridge/server.mjs"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...env, PAPERLENS_CODEX_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const stop = () => stopProcessTree({ child, closed });
  t.after(stop);
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Bridge startup timed out: ${output}`)), 20000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("PaperLens AI bridge:")) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Bridge exited ${code}: ${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const post = async (path, payload, signal) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal,
    });
    return { status: response.status, body: await response.json() };
  };
  return { base, post, stop };
}

export async function waitForCapture(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch { await delay(50); }
  }
  throw new Error(`Fixture did not become ready: ${path}`);
}

export function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
