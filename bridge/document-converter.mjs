import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, extname, join, parse, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { stopProcessTree } from "./process-tree.mjs";

export const OFFICE_DOCUMENT_EXTENSIONS = Object.freeze([".doc", ".docx", ".ppt", ".pptx"]);

const isWindows = process.platform === "win32";

function environmentValue(env, name) {
  const key = isWindows ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) : name;
  return env[key] || "";
}

function defaultSofficeCandidates(env) {
  const override = environmentValue(env, "PAPERLENS_SOFFICE_PATH").trim();
  // An explicit selection is authoritative, including when it is misspelled.
  if (override) return [override];
  if (isWindows) {
    const roots = new Set([
      environmentValue(env, "ProgramW6432"),
      environmentValue(env, "ProgramFiles") || "C:\\Program Files",
      environmentValue(env, "ProgramFiles(x86)") || "C:\\Program Files (x86)",
    ].filter(Boolean));
    return ["soffice", ...[...roots].map((root) => join(root, "LibreOffice", "program", "soffice"))];
  }
  return [
    "soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
  ].filter(Boolean);
}

export class DocumentConversionError extends Error {
  constructor(message, { code = "conversion_failed", status = 500 } = {}) {
    super(message);
    this.name = "DocumentConversionError";
    this.code = code;
    this.status = status;
  }
}

function executableCandidates(candidate, env) {
  const unquoted = candidate.trim().replace(/^"(.*)"$/, "$1");
  // LibreOffice's console launcher waits for conversion and provides diagnostics.
  const names = isWindows && !extname(unquoted) ? [`${unquoted}.com`, `${unquoted}.exe`] : [unquoted];
  if (/[\\/]/.test(unquoted) || (isWindows && /^[a-z]:/i.test(unquoted))) return names.map((name) => resolve(name));
  return environmentValue(env, "PATH").split(delimiter).filter(Boolean).flatMap((directory) => {
    const path = directory.trim().replace(/^"(.*)"$/, "$1");
    return path ? names.map((name) => resolve(path, name)) : [];
  });
}

export async function findSoffice(candidates, { env = process.env } = {}) {
  for (const candidate of candidates ?? defaultSofficeCandidates(env)) {
    for (const path of executableCandidates(candidate, env)) {
      try {
        await access(path, constants.X_OK);
        if ((await stat(path)).isFile()) return path;
      } catch {
        // Continue through explicit paths and PATH entries.
      }
    }
  }
  return "";
}

export function normalizeOfficeFileName(fileName) {
  const safeBaseName = basename(win32.basename(String(fileName || ""))).replaceAll("\0", "").trim();
  const extension = extname(safeBaseName).toLowerCase();
  if (!OFFICE_DOCUMENT_EXTENSIONS.includes(extension)) {
    throw new DocumentConversionError("仅支持 Word（DOC/DOCX）和 PowerPoint（PPT/PPTX）文件", {
      code: "unsupported_document_type",
      status: 415,
    });
  }
  const stem = parse(safeBaseName).name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 140) || "document";
  return `${stem}${extension}`;
}

function cancelledConversion() {
  return new DocumentConversionError("文档转换已取消", { code: "conversion_cancelled", status: 499 });
}

async function runSoffice(executablePath, args, { timeoutMs, signal, env, spawnProcess }) {
  if (signal?.aborted) throw cancelledConversion();
  let child;
  try {
    child = spawnProcess(executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true, detached: !isWindows,
    });
  } catch (error) {
    throw new DocumentConversionError(`无法启动本机文档转换：${error.message}`, { code: "converter_unavailable", status: 503 });
  }
  let stdout = "";
  let stderr = "";
  let spawnError;
  let failure;
  let stopping;
  const closed = new Promise((done) => child.once("close", (code) => done(code)));
  child.on("error", (error) => { spawnError = error; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const stop = (error) => {
    if (failure) return;
    failure = error;
    // Do not release the bridge's busy slot or delete the profile until the
    // owned process tree has stopped and all output pipes have closed.
    stopping = stopProcessTree({ child, closed, graceMs: 1000 }).catch((error) => {
      failure = new DocumentConversionError(`无法停止文档转换：${error.message}`);
    });
  };
  const timeout = setTimeout(() => stop(new DocumentConversionError("文档转换超时，请检查文件是否损坏或过大", {
    code: "conversion_timeout", status: 504,
  })), timeoutMs);
  const onAbort = () => stop(cancelledConversion());
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const code = await closed;
    await stopping;
    if (failure) throw failure;
    if (spawnError) {
      throw new DocumentConversionError(`无法启动本机文档转换：${spawnError.message}`, { code: "converter_unavailable", status: 503 });
    }
    if (code !== 0) throw new DocumentConversionError(stderr.trim() || stdout.trim() || `文档转换失败（状态码 ${code}）`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function createDocumentConverter({
  candidates, timeoutMs = 120_000, env = process.env, temporaryDirectory = tmpdir(), spawnProcess = spawn,
} = {}) {
  const executablePath = await findSoffice(candidates, { env });
  return {
    available: Boolean(executablePath),
    engine: executablePath ? "LibreOffice" : "",
    formats: OFFICE_DOCUMENT_EXTENSIONS,
    async convert(bytes, fileName, { signal } = {}) {
      const normalizedName = normalizeOfficeFileName(fileName);
      if (signal?.aborted) throw cancelledConversion();
      if (!executablePath) {
        throw new DocumentConversionError("本机未检测到 LibreOffice，请安装或检查 PAPERLENS_SOFFICE_PATH 后重启 bridge；PDF 仍可直接导入", {
          code: "converter_unavailable",
          status: 503,
        });
      }
      const directory = await mkdtemp(join(temporaryDirectory, "paperlens-convert-"));
      const inputDirectory = join(directory, "input");
      const outputDirectory = join(directory, "output");
      const profileDirectory = join(directory, "profile");
      const inputPath = join(inputDirectory, normalizedName);
      try {
        for (const path of [inputDirectory, outputDirectory, profileDirectory]) await mkdir(path);
        await writeFile(inputPath, bytes, { flag: "wx" });
        await runSoffice(executablePath, [
          `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
          "--headless",
          "--nologo",
          "--nodefault",
          "--nolockcheck",
          "--norestore",
          "--convert-to",
          "pdf",
          "--outdir",
          outputDirectory,
          inputPath,
        ], { timeoutMs, signal, env, spawnProcess });
        const outputNames = await readdir(outputDirectory);
        const outputName = outputNames.find((name) => extname(name).toLowerCase() === ".pdf");
        if (!outputName) throw new DocumentConversionError("转换程序没有生成 PDF，请确认文件能在 Word 或 PowerPoint 中正常打开");
        const pdf = await readFile(join(outputDirectory, outputName));
        if (!pdf.length) throw new DocumentConversionError("转换生成了空的 PDF 文件");
        if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") throw new DocumentConversionError("转换结果不是有效的 PDF 文件");
        return { pdf, fileName: `${parse(normalizedName).name}.pdf`, engine: "LibreOffice" };
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}
