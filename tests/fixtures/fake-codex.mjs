import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const state = process.env.PAPERLENS_TEST_CODEX_STATE
  ? JSON.parse(await readFile(process.env.PAPERLENS_TEST_CODEX_STATE, "utf8")) : {};

if (args[0] === "--fixture-child") {
  process.on("SIGTERM", () => {});
  const server = createServer();
  server.listen(0, "127.0.0.1", () => process.send({ pid: process.pid, port: server.address().port }));
} else if (args[0] === "--version") {
  console.log("codex-cli 0.146.0");
} else if (args.join(" ") === "login status") {
  if (state.login === "out") { console.error("Not logged in"); process.exitCode = 1; }
  else if (state.login === "error") { console.error("Failed to read credentials: TEST_SECRET_MUST_NOT_LEAK"); process.exitCode = 2; }
  else console.log("Logged in using ChatGPT");
} else if (args[0] === "--fixture-exit") {
  console.error("fixture rejected arguments");
  process.exit(2);
} else if (args[0] === "--fixture-flood") {
  process.stdout.write("x".repeat(128 * 1024));
  setInterval(() => {}, 1000);
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const images = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--image") images.push({ path: args[index + 1], base64: (await readFile(args[index + 1])).toString("base64") });
  }
  if (state.mode === "tree" || args[0] === "--fixture-tree") {
    const child = spawn(process.execPath, [process.argv[1], "--fixture-child"], { stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
    child.on("message", async (message) => {
      await writeFile(state.capturePath, JSON.stringify({ ...message, parentPid: process.pid, args, input, images }));
    });
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else if (state.mode === "failure") {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial answer" } }));
    console.log(JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify({ error: { message: "fixture upstream failed" } }) } }));
    process.exitCode = 1;
  } else if (state.mode !== "empty") {
    console.log("fixture non-JSON diagnostic");
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "intermediate answer" } }));
    const text = state.mode === "unicode" ? "中文答案🙂" : JSON.stringify({ args, input, images, codexHome: process.env.CODEX_HOME });
    const output = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
    // Split a multibyte character and omit the final newline.
    const split = state.mode === "unicode" ? output.indexOf(Buffer.from("中")) + 1 : Math.floor(output.length / 2);
    process.stdout.write(output.subarray(0, split));
    await delay(20);
    process.stdout.write(output.subarray(split));
  }
}
