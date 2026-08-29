import { spawn as spawnChild } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 12_000;

function capture(command, args, { spawn = spawnChild, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\nCommand timed out`.trim() });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-20_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on("error", (error) => finish({ ok: false, code: null, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

export async function detectCodexInstallation({ env = process.env, spawn = spawnChild } = {}) {
  const candidates = [
    env.PAPERLENS_CODEX_PATH,
    ...(env.PATH || "").split(delimiter).filter(Boolean).map((directory) => join(directory, "codex")),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);

  for (const command of [...new Set(candidates)]) {
    try {
      await access(command, constants.X_OK);
    } catch {
      continue;
    }
    const version = await capture(command, ["--version"], { spawn });
    if (version.ok) return { installed: true, command, version: version.stdout || "Codex CLI" };
  }
  return { installed: false, command: "codex", version: "" };
}

export async function readCodexCliLoginStatus(command, { spawn = spawnChild } = {}) {
  const result = await capture(command, ["login", "status"], { spawn });
  const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    loggedIn: result.ok,
    authMode: /chatgpt/i.test(message) ? "chatgpt" : /api key/i.test(message) ? "apikey" : result.ok ? "unknown" : null,
    message,
  };
}

function normalizeRateLimitBucket(bucket) {
  if (!bucket || typeof bucket !== "object") return null;
  const usedPercent = Number(bucket.primary?.usedPercent);
  return {
    id: String(bucket.limitId || "codex"),
    name: typeof bucket.limitName === "string" && bucket.limitName ? bucket.limitName : null,
    usedPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : null,
    remainingPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, 100 - usedPercent)) : null,
    windowDurationMins: Number.isFinite(Number(bucket.primary?.windowDurationMins)) ? Number(bucket.primary.windowDurationMins) : null,
    resetsAt: Number.isFinite(Number(bucket.primary?.resetsAt)) ? Number(bucket.primary.resetsAt) : null,
    reachedType: typeof bucket.rateLimitReachedType === "string" ? bucket.rateLimitReachedType : null,
    planType: typeof bucket.planType === "string" ? bucket.planType : null,
  };
}

export function normalizeCodexAccount(accountResult, rateLimitResult = null) {
  const account = accountResult?.account || null;
  const byId = rateLimitResult?.rateLimitsByLimitId;
  const rawBuckets = byId && typeof byId === "object"
    ? Object.values(byId)
    : rateLimitResult?.rateLimits ? [rateLimitResult.rateLimits] : [];
  const rateLimits = rawBuckets.map(normalizeRateLimitBucket).filter(Boolean);
  return {
    loggedIn: Boolean(account),
    authMode: account?.type || null,
    email: typeof account?.email === "string" ? account.email : null,
    planType: typeof account?.planType === "string" ? account.planType : null,
    rateLimits,
    rateLimitReached: rateLimits.some((bucket) => Boolean(bucket.reachedType) || bucket.remainingPercent === 0),
  };
}

export class CodexAccountClient {
  constructor(command, { spawn = spawnChild } = {}) {
    this.command = command;
    this.spawn = spawn;
    this.process = null;
    this.reader = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastNotification = null;
  }

  async ensureStarted() {
    if (this.process && !this.process.killed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const process = this.spawn(this.command, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...globalThis.process.env, NO_COLOR: "1" },
      });
      this.process = process;
      this.reader = readline.createInterface({ input: process.stdout });
      this.reader.on("line", (line) => this.handleLine(line));
      process.stderr.on("data", () => {});
      process.on("error", (error) => this.handleExit(error));
      process.on("close", (code) => this.handleExit(new Error(`Codex app-server exited with status ${code}`)));
      await this.requestRaw("initialize", {
        clientInfo: { name: "paperlens_local", title: "PaperLens Local", version: "0.1.0" },
      });
      this.notify("initialized", {});
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.lastNotification = message;
  }

  handleExit(error) {
    if (!this.process && !this.pending.size) return;
    this.reader?.close();
    this.reader = null;
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  requestRaw(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.process?.stdin?.writable) this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.ensureStarted();
    return this.requestRaw(method, params, timeoutMs);
  }

  async readStatus({ refreshToken = false } = {}) {
    const accountResult = await this.request("account/read", { refreshToken });
    let rateLimitResult = null;
    if (accountResult?.account?.type === "chatgpt") {
      try {
        rateLimitResult = await this.request("account/rateLimits/read", {});
      } catch {
        rateLimitResult = null;
      }
    }
    return normalizeCodexAccount(accountResult, rateLimitResult);
  }

  startLogin() {
    return this.request("account/login/start", {
      type: "chatgpt",
      useHostedLoginSuccessPage: true,
      appBrand: "codex",
    }, 30_000);
  }

  logout() {
    return this.request("account/logout", {});
  }

  close() {
    this.reader?.close();
    this.reader = null;
    this.process?.kill("SIGTERM");
    this.process = null;
  }
}
