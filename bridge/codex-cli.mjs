import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ProviderError } from "./provider-errors.mjs";
import { stopProcessTree } from "./process-tree.mjs";

function cliError(message, code, status = 503, cause) {
  return new ProviderError(message, { code, status, provider: "local-codex", cause });
}

function envPath(env) {
  const key = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return key ? env[key] : "";
}

export async function resolveCodexCommand(candidate, { platform = process.platform, cwd = process.cwd() } = {}) {
  const source = resolve(cwd, candidate);
  if (!(await stat(source)).isFile()) throw cliError("Codex 路径不是文件", "codex_start_failed");
  const target = await realpath(source);
  const extension = extname(target).toLowerCase();

  if (platform === "win32" && [".cmd", ".bat", ".ps1"].includes(extension)) {
    // Recognize npm's Codex shim without sending user arguments through cmd.exe.
    // Arbitrary shell wrappers need an explicit executable/JavaScript entry.
    const packageRoot = join(dirname(source), "node_modules", "@openai", "codex");
    try {
      const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      const entry = metadata.bin?.codex;
      const shim = (await readFile(source, "utf8")).replaceAll("\\", "/");
      if (metadata.name !== "@openai/codex" || entry !== "bin/codex.js" || !shim.includes("node_modules/@openai/codex/bin/codex.js")) throw new Error("Not an npm Codex shim");
      const script = join(packageRoot, entry);
      if (!(await stat(script)).isFile()) throw new Error("Missing Codex JavaScript entry");
      return { command: process.execPath, args: [script], source };
    } catch (cause) {
      throw cliError("无法识别 Codex 包装脚本，请将 PAPERLENS_CODEX_PATH 指向 codex.exe 或 Codex 的 JavaScript 入口", "codex_unsupported_wrapper", 503, cause);
    }
  }

  if ([".js", ".mjs", ".cjs"].includes(extension)) return { command: process.execPath, args: [target], source };
  await access(target, constants.X_OK);
  return { command: target, args: [], source };
}

export async function runCodexCommand(installation, args, {
  cwd = process.cwd(), env = process.env, input = "", signal, timeoutMs = 12000,
  maxOutputBytes = 8 * 1024 * 1024,
} = {}) {
  if (signal?.aborted) throw cliError("请求已取消", "request_aborted", 499);

  let child;
  try {
    child = spawn(installation.command, [...installation.args, ...args], {
      cwd, env: { ...env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, detached: process.platform !== "win32",
    });
  } catch (cause) {
    throw cliError(`无法启动 Codex CLI：${cause.message}`, "codex_start_failed", 503, cause);
  }
  const closed = new Promise((done) => child.once("close", (code) => done(code)));
  let failure;
  let stopping;
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  const stop = (error) => {
    if (failure) return;
    failure = error;
    // Finish before the development supervisor's two-second shutdown deadline.
    stopping = stopProcessTree({ child, closed, graceMs: 1000 }).catch((cause) => {
      failure = cliError(`无法停止 Codex CLI：${cause.message}`, "codex_stop_failed", 500, cause);
    });
  };
  const abort = () => stop(cliError("请求已取消", "request_aborted", 499));
  const timer = setTimeout(() => stop(new ProviderError("Codex 响应超时，请稍后重试", {
    code: "upstream_timeout", status: 504, retryable: true, provider: "local-codex",
  })), timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maxOutputBytes) stop(cliError("Codex 输出超过允许大小", "codex_output_limit", 502));
    else stdout += chunk;
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
  child.on("error", (cause) => {
    failure ??= cliError(`无法启动 Codex CLI：${cause.message}`, "codex_start_failed", 503, cause);
  });
  child.stdin.on("error", (cause) => {
    // A rejected command may close stdin before reading the prompt. Its exit
    // code/stderr is more useful than EPIPE, and must not crash the bridge.
    if (!["EPIPE", "ECONNRESET", "EOF"].includes(cause.code)) stop(cliError(`无法向 Codex 发送请求：${cause.message}`, "codex_stdin_failed", 502, cause));
  });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdin.end(input);

  try {
    const code = await closed;
    if (stopping) await stopping;
    if (failure) throw failure;
    return { code, stdout, stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function detectCodexInstallation({ env = process.env, cwd = process.cwd(), platform = process.platform, timeoutMs = 3000, signal } = {}) {
  const override = env.PAPERLENS_CODEX_PATH?.trim();
  const directories = (envPath(env) || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex.ps1"] : ["codex"];
  const candidates = override
    ? (isAbsolute(override) || /[\\/]/.test(override) ? [resolve(cwd, override)] : directories.map((directory) => join(directory, override)))
    : [
      ...directories.flatMap((directory) => names.map((name) => join(directory, name))),
      ...(platform === "darwin" ? ["/Applications/ChatGPT.app/Contents/Resources/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"] : []),
    ];
  let error;
  for (const candidate of new Set(candidates)) {
    try {
      const command = await resolveCodexCommand(candidate, { platform, cwd });
      const result = await runCodexCommand(command, ["--version"], { env, cwd, timeoutMs, signal, maxOutputBytes: 64000 });
      if (result.code !== 0 || !/^codex(?:-cli)?\s+\S+/i.test(result.stdout.trim())) {
        throw cliError("已找到命令，但无法通过 Codex CLI 版本检查，请检查安装或 PAPERLENS_CODEX_PATH", "codex_start_failed");
      }
      return { ...command, installed: true, version: result.stdout.trim() };
    } catch (cause) {
      if (signal?.aborted) return { installed: false, error: cause };
      if (cause.code !== "ENOENT" && cause.code !== "ENOTDIR") {
        error ??= cause instanceof ProviderError ? cause : cliError(`无法启动 Codex CLI：${cause.message}`, "codex_start_failed", 503, cause);
      }
    }
  }
  return { installed: false, error: error instanceof ProviderError ? error : cliError(
    override ? "PAPERLENS_CODEX_PATH 指向的 Codex 不可用，请检查路径" : "未检测到本机 Codex CLI，请安装 Codex 并将其加入 PATH",
    "codex_not_found", 503, error,
  ) };
}

export async function readCodexLoginStatus(installation, options = {}) {
  if (!installation.installed) return { loggedIn: false, error: installation.error };
  try {
    const result = await runCodexCommand(installation, ["login", "status"], options);
    if (result.code === 0) return { loggedIn: true };
    if (/not logged in/i.test(`${result.stdout}\n${result.stderr}`)) {
      return { loggedIn: false, error: cliError("本机 Codex 尚未登录，请在终端运行 codex login 后重试", "codex_not_logged_in", 401) };
    }
    return { loggedIn: false, error: cliError("无法读取 Codex 登录状态，请在终端运行 codex login status 检查", "codex_login_check_failed") };
  } catch (error) {
    return { loggedIn: false, error };
  }
}
