import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { CodexAccountClient, detectCodexInstallation, readCodexCliLoginStatus } from "../bridge/codex-account.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [];
const add = (name, status, detail, required = false) => checks.push({ name, status, detail, required });

const [major, minor] = process.versions.node.split(".").map(Number);
add("Node.js", major > 22 || (major === 22 && minor >= 13) ? "ok" : "error", process.version, true);

const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
add("npm", npm.status === 0 ? "ok" : "error", (npm.stdout || npm.stderr || "not found").trim(), true);

const codex = await detectCodexInstallation();
if (codex.installed) {
  add("Codex CLI", "ok", `${codex.version} · ${codex.command}`);
  const accountClient = new CodexAccountClient(codex.command);
  try {
    const account = await accountClient.readStatus();
    add("Codex account", account.loggedIn ? "ok" : "warn", account.loggedIn ? `${account.authMode || "unknown login"}${account.planType ? ` · ${account.planType}` : ""}` : "installed but not logged in");
    if (account.loggedIn) {
      const rateSummary = account.rateLimits.length
        ? account.rateLimits.map((limit) => `${limit.name || limit.id}: ${limit.remainingPercent ?? "unknown"}% remaining`).join(", ")
        : "rate-limit details unavailable";
      add("Codex quota", account.rateLimitReached ? "warn" : "ok", rateSummary);
    }
  } catch {
    const login = await readCodexCliLoginStatus(codex.command);
    add("Codex account", login.loggedIn ? "ok" : "warn", login.loggedIn ? login.message || "logged in; detailed quota unavailable" : "installed but not logged in");
    if (login.loggedIn) add("Codex quota", "warn", "rate-limit details unavailable from Codex App Server");
  } finally {
    accountClient.close();
  }
} else {
  add("Codex CLI", "warn", "not installed; ChatGPT Web Chat remains available");
  add("Codex account", "warn", "not checked because Codex CLI is missing");
}

const chromePath = "/Applications/Google Chrome.app";
add("Google Chrome", existsSync(chromePath) ? "ok" : "warn", existsSync(chromePath) ? chromePath : "not found at the standard macOS path");
add("ChatGPT extension source", existsSync(join(root, "browser-extension", "manifest.json")) ? "ok" : "error", join(root, "browser-extension"), true);
add("Dependencies", existsSync(join(root, "node_modules")) ? "ok" : "warn", existsSync(join(root, "node_modules")) ? "installed" : "run npm ci");

try {
  const response = await fetch("http://127.0.0.1:43123/health", { signal: AbortSignal.timeout(1_500) });
  const health = await response.json();
  const providers = Object.values(health.providers || {}).map((provider) => `${provider.label}:${provider.available ? "ready" : "not-ready"}`).join(", ");
  const currentCheckout = health.edition === "local-two-connectors" && health.projectRoot === root.replace(/\/$/, "");
  add("PaperLens bridge", response.ok && currentCheckout ? "ok" : "warn", currentCheckout ? providers : `another checkout is running (${health.projectRoot || "unknown path"}); stop it before starting this copy`);
} catch {
  add("PaperLens bridge", "warn", "not running; start with npm run dev or PaperLens.app");
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ok: !checks.some((check) => check.required && check.status === "error"), checks }, null, 2)}\n`);
} else {
  for (const check of checks) {
    const mark = check.status === "ok" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    process.stdout.write(`[${mark}] ${check.name}: ${check.detail}\n`);
  }
}

if (checks.some((check) => check.required && check.status === "error")) process.exitCode = 1;
