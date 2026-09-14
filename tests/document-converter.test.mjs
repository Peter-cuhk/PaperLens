import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stopProcessTree } from "../bridge/process-tree.mjs";

import {
  DocumentConversionError,
  OFFICE_DOCUMENT_EXTENSIONS,
  createDocumentConverter,
  findSoffice,
  normalizeOfficeFileName,
} from "../bridge/document-converter.mjs";

const executableName = process.platform === "win32" ? "soffice.com" : "soffice";
const sofficeFixture = fileURLToPath(new URL("./fixtures/soffice.mjs", import.meta.url));

async function directoryFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperlens Office 中文 with spaces-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executableFixture(directory, name = executableName) {
  await mkdir(directory, { recursive: true });
  const executable = join(directory, name);
  await writeFile(executable, "fixture", { mode: 0o700 });
  return executable;
}

test("Office conversion accepts Word and PowerPoint formats and sanitizes file names", () => {
  assert.deepEqual(OFFICE_DOCUMENT_EXTENSIONS, [".doc", ".docx", ".ppt", ".pptx"]);
  assert.equal(normalizeOfficeFileName("../Method: Notes.DOCX"), "Method_ Notes.docx");
  assert.equal(normalizeOfficeFileName("slides.PPTX"), "slides.pptx");
  assert.equal(normalizeOfficeFileName("C:\\fakepath\\课程 notes.DOC"), "课程 notes.doc");
});

test("Office conversion rejects unrelated formats before invoking LibreOffice", () => {
  assert.throws(
    () => normalizeOfficeFileName("paper.pages"),
    (error) => error instanceof DocumentConversionError && error.status === 415 && error.code === "unsupported_document_type",
  );
});

test("LibreOffice discovery returns empty for an explicit missing path", async () => {
  assert.equal(await findSoffice(["/paperlens/definitely-missing/soffice"]), "");
});

test("LibreOffice discovery accepts absolute paths containing spaces and Chinese", async (t) => {
  const executable = await executableFixture(await directoryFixture(t));
  assert.equal(await findSoffice([executable]), executable);
  assert.equal(await findSoffice(undefined, { env: { PAPERLENS_SOFFICE_PATH: `"${executable}"` } }), executable);
});

test("LibreOffice discovery searches PATH entries using the platform delimiter", async (t) => {
  const root = await directoryFixture(t);
  const directory = join(root, "安装目录 with spaces");
  const executable = await executableFixture(directory);
  const env = { PATH: [join(root, "missing"), directory].join(delimiter) };
  assert.equal(await findSoffice(["soffice"], { env }), executable);
});

test("LibreOffice discovery honors an explicit override before PATH", async (t) => {
  const root = await directoryFixture(t);
  const executable = await executableFixture(join(root, "custom 中文"));
  const alternate = await executableFixture(join(root, "path"));
  const env = { PAPERLENS_SOFFICE_PATH: executable, PATH: join(root, "path") };
  assert.notEqual(executable, alternate);
  assert.equal(await findSoffice(undefined, { env }), executable);
  env.PAPERLENS_SOFFICE_PATH = join(root, "missing", executableName);
  assert.equal(await findSoffice(undefined, { env }), "", "a typo must not silently select a different installation");
});

test("LibreOffice discovery rejects a directory named like an executable", async (t) => {
  const directory = join(await directoryFixture(t), executableName);
  await mkdir(directory);
  assert.equal(await findSoffice([directory]), "");
});

test("Windows discovery prefers the console launcher and preserves PATH order", { skip: process.platform !== "win32" }, async (t) => {
  const root = await directoryFixture(t);
  const first = join(root, "first");
  const second = join(root, "second");
  const exe = await executableFixture(first, "soffice.exe");
  await executableFixture(second);
  const env = { Path: `"${first}";${second}` };
  assert.equal(await findSoffice(["soffice"], { env }), exe);
  const com = await executableFixture(first);
  assert.equal(await findSoffice(["soffice"], { env }), com);
  assert.equal(await findSoffice([join(first, "soffice")], { env }), com);
});

for (const variable of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]) {
  test(`Windows discovery searches the ${variable} LibreOffice installation`, { skip: process.platform !== "win32" }, async (t) => {
    const root = await directoryFixture(t);
    const executable = await executableFixture(join(root, "LibreOffice", "program"));
    const env = { PATH: "", ProgramW6432: join(root, "none"), ProgramFiles: join(root, "none"), "ProgramFiles(x86)": join(root, "none"), [variable]: root };
    assert.equal(await findSoffice(undefined, { env }), executable);
  });
}

function isRunning(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "expected a positive fixture process ID");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function conversionFixture(t, { mode = "success", timeoutMs = 10_000, ...options } = {}) {
  const root = await directoryFixture(t);
  const temporaryDirectory = join(root, "临时 files");
  await mkdir(temporaryDirectory);
  const recordPath = join(root, "invocation.json");
  const launches = [];
  const converter = await createDocumentConverter({
    candidates: [process.execPath], temporaryDirectory, timeoutMs,
    env: { ...process.env, PAPERLENS_SOFFICE_FIXTURE_MODE: mode, PAPERLENS_SOFFICE_FIXTURE_RECORD: recordPath },
    spawnProcess(executable, args, options) {
      launches.push({ executable, args, options });
      const child = spawn(executable, [sofficeFixture, ...args], options);
      const closed = new Promise((resolve) => child.once("close", resolve));
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) await stopProcessTree({ child, closed, graceMs: 100 });
      });
      return child;
    },
    ...options,
  });
  async function record() { return JSON.parse(await readFile(recordPath, "utf8")); }
  async function waitForDescendant() {
    const deadline = Date.now() + 8000;
    while (true) {
      try {
        const pid = Number(await readFile(`${recordPath}.child`, "utf8"));
        const parent = await record();
        if (Number.isSafeInteger(pid) && pid > 0 && parent.descendant === pid) {
          t.after(() => { if (isRunning(pid)) process.kill(pid, "SIGKILL"); });
          return pid;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      assert.ok(Date.now() < deadline, "timed out waiting for a complete fixture process record");
      await delay(20);
    }
  }
  return { converter, temporaryDirectory, launches, record, waitForDescendant };
}

for (const extension of OFFICE_DOCUMENT_EXTENSIONS) {
  test(`Office ${extension} conversion preserves Unicode bytes and literal paths, then removes its temporary files`, async (t) => {
    const fixture = await conversionFixture(t);
    const bytes = Buffer.from("课程 内容 & literal arguments");
    const name = `课程 notes & literal %VALUE%${extension}`;
    const result = await fixture.converter.convert(bytes, name);
    const record = await fixture.record();
    assert.equal(result.fileName, "课程 notes & literal %VALUE%.pdf");
    assert.match(result.pdf.toString(), /^%PDF-/);
    assert.equal(record.bytes, bytes.toString("base64"));
    assert.equal(basename(record.input), name);
    assert.ok(record.profile.startsWith(fixture.temporaryDirectory));
    assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
    assert.equal(fixture.launches[0].options.windowsHide, true);
    assert.ok(!fixture.launches[0].options.shell);
    assert.ok(record.args.includes("--headless"));
    assert.ok(record.args.includes("--norestore"));
  });
}

for (const [mode, message] of [["empty", /空的 PDF/], ["missing", /没有生成 PDF/], ["invalid", /不是有效的 PDF/], ["failure", /转换失败：测试文件损坏/]]) {
  test(`Office conversion reports ${mode} output and cleans the input/profile`, async (t) => {
    const fixture = await conversionFixture(t, { mode });
    await assert.rejects(fixture.converter.convert(Buffer.from("data"), "课程.docx"), (error) => {
      assert.equal(error.code, "conversion_failed");
      assert.match(error.message, message);
      return true;
    });
    assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
  });
}

test("Office conversion maps a failed spawn to an unavailable converter and removes temporary files", async (t) => {
  const fixture = await conversionFixture(t, {
    spawnProcess: (_executable, args, options) => spawn(join(tmpdir(), "paperlens-definitely-missing", "soffice"), args, options),
  });
  await assert.rejects(fixture.converter.convert(Buffer.from("data"), "课程.docx"), { code: "converter_unavailable", status: 503 });
  assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
});

test("Office conversion rejects unsupported input and pre-cancelled requests before spawning", async (t) => {
  const fixture = await conversionFixture(t);
  await assert.rejects(fixture.converter.convert(Buffer.from("data"), "paper.pdf"), { code: "unsupported_document_type", status: 415 });
  await assert.rejects(fixture.converter.convert(Buffer.from("data"), "paper.docx", { signal: AbortSignal.abort() }), { code: "conversion_cancelled" });
  assert.equal(fixture.launches.length, 0);
  assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
});

test("missing LibreOffice reports installation guidance without creating temporary files", async (t) => {
  const fixture = await conversionFixture(t, { candidates: [] });
  assert.equal(fixture.converter.available, false);
  await assert.rejects(fixture.converter.convert(Buffer.from("data"), "paper.docx"), (error) => {
    assert.equal(error.status, 503);
    assert.match(error.message, /PAPERLENS_SOFFICE_PATH/);
    assert.match(error.message, /PDF/);
    return true;
  });
  assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
});

for (const reason of ["timeout", "abort"]) {
  test(`Office conversion ${reason} stops its process tree before rejection and cleanup`, { timeout: 20_000 }, async (t) => {
    const fixture = await conversionFixture(t, { mode: "hang", timeoutMs: reason === "timeout" ? 3000 : 10_000 });
    const controller = new AbortController();
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const sentinelClosed = new Promise((resolve) => sentinel.once("close", resolve));
    t.after(async () => { sentinel.kill(); await sentinelClosed; });
    const conversion = fixture.converter.convert(Buffer.from("data"), "课程.docx", { signal: controller.signal });
    const rejected = assert.rejects(conversion, { code: reason === "timeout" ? "conversion_timeout" : "conversion_cancelled" });
    const descendant = await fixture.waitForDescendant();
    const record = await fixture.record();
    assert.ok(isRunning(record.pid));
    assert.ok(isRunning(descendant));
    assert.equal((await readdir(fixture.temporaryDirectory)).length, 1);
    if (reason === "abort") controller.abort();
    await rejected;
    assert.equal(isRunning(record.pid), false);
    // A killed POSIX descendant can remain a zombie briefly before the OS reaps it.
    const reapDeadline = Date.now() + 5000;
    while (isRunning(descendant) && Date.now() < reapDeadline) await delay(25);
    assert.equal(isRunning(descendant), false);
    assert.equal(isRunning(sentinel.pid), true, "unrelated processes must survive");
    assert.deepEqual(await readdir(fixture.temporaryDirectory), []);
  });
}
