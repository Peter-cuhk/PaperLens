import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function signalProcessGroup(pid, signal, { platform = process.platform } = {}) {
  const attempts = platform === "darwin" ? 11 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (error.code === "ESRCH") return;
      if (error.code !== "EPERM" || attempt === attempts - 1) throw error;
      // Darwin killpg can report EPERM while a group contains only zombies.
      // Let the OS reap them; persistent permission failures still propagate.
      await delay(10);
    }
  }
}

// The caller must spawn an independent process group on POSIX and pass a
// promise registered for the child's close event immediately after spawning.
export async function stopProcessTree({ child, closed, graceMs = 2000 }) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
      await execFileAsync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
    } catch (error) {
      // A service can exit while taskkill is starting.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        throw error;
      }
    }
  } else {
    await signalProcessGroup(child.pid, "SIGTERM");
    const timeout = new AbortController();
    try {
      await Promise.race([closed, delay(graceMs, undefined, { signal: timeout.signal })]);
    } finally {
      timeout.abort();
    }
    await signalProcessGroup(child.pid, "SIGKILL");
  }

  await closed;
}
