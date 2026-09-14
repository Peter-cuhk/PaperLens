import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const recordPath = process.env.PAPERLENS_SOFFICE_FIXTURE_RECORD;

async function publishRecord(path, contents) {
  // Readers use these files as readiness signals; never expose a partial record.
  const pending = `${path}.${process.pid}.tmp`;
  await writeFile(pending, contents);
  await rename(pending, path);
}

if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  await publishRecord(`${recordPath}.child`, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const args = process.argv.slice(2);
  const input = args.at(-1);
  const output = join(args[args.indexOf("--outdir") + 1], `${parse(input).name}.pdf`);
  const profile = fileURLToPath(args.find((arg) => arg.startsWith("-env:UserInstallation=")).slice(22));
  const bytes = await readFile(input);
  const configuredMode = process.env.PAPERLENS_SOFFICE_FIXTURE_MODE || "success";
  const mode = configuredMode === "from-input" ? bytes.toString() : configuredMode;
  const record = { args, input, profile, directory: dirname(profile), pid: process.pid, bytes: bytes.toString("base64") };
  if (mode === "hang") {
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant"], {
      stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    });
    record.descendant = descendant.pid;
    setInterval(() => {}, 1000);
  }
  await publishRecord(recordPath, JSON.stringify(record));
  if (mode === "success") await writeFile(output, "%PDF-1.7\nOffice fixture\n%%EOF\n");
  if (mode === "empty") await writeFile(output, "");
  if (mode === "invalid") await writeFile(output, "not a PDF");
  if (mode === "failure") {
    const diagnostic = Buffer.from("转换失败：测试文件损坏");
    process.stderr.write(diagnostic.subarray(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stderr.write(diagnostic.subarray(2));
    process.exitCode = 23;
  }
}
