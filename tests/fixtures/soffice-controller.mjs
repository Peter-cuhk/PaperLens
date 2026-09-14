import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const spawn = childProcess.spawn;
childProcess.spawn = (executable, args, options) => {
  if (args.includes("--convert-to")) {
    return spawn(process.execPath, [fileURLToPath(new URL("./soffice.mjs", import.meta.url)), ...args], options);
  }
  return spawn(executable, args, options);
};
syncBuiltinESMExports();

// Windows does not deliver Unix signals to Node; exercise the same registered
// shutdown handler over IPC, as the startup integration tests do.
process.on("message", (signal) => {
  if (signal === "SIGINT" || signal === "SIGTERM") process.emit(signal);
});
process.channel?.unref();
