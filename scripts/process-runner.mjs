import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopProcessTree } from "../bridge/process-tree.mjs";

const isWindows = process.platform === "win32";

export function vinextArgs(args) {
  // The pinned Vinext package keeps its CLI beside its exported dist/index.js.
  // Invoke JavaScript with our Node executable, without an npm .cmd shim/shell.
  return [fileURLToPath(new URL("./cli.js", import.meta.resolve("vinext"))), ...args];
}

export function runProcesses(commands, { cwd }) {
  return new Promise((resolve) => {
    const children = [];
    let closing = false;

    async function close(code) {
      if (closing) return;
      closing = true;
      const results = await Promise.allSettled(children.map(stopProcessTree));
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(`PaperLens: could not stop a child process: ${result.reason.message}`);
          code = 1;
        }
      }
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(code);
    }

    const onSignal = () => { void close(0); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    for (const { name, args, env } of commands) {
      try {
        const child = spawn(process.execPath, args, {
          cwd,
          stdio: "inherit",
          env: { ...process.env, ...env },
          windowsHide: true,
          // POSIX process groups let us stop workerd/esbuild as well as Node.
          detached: !isWindows,
        });
        const closed = new Promise((done) => child.once("close", done));
        children.push({ child, closed });
        child.on("error", (error) => {
          console.error(`PaperLens: could not start ${name}: ${error.message}`);
          void close(1);
        });
        child.once("exit", (code) => { void close(code ?? 1); });
      } catch (error) {
        console.error(`PaperLens: could not start ${name}: ${error.message}`);
        void close(1);
        break;
      }
    }
  });
}
