import assert from "node:assert/strict";
import test from "node:test";
import { signalProcessGroup } from "../bridge/process-tree.mjs";

test("Darwin group cleanup tolerates transient EPERM until the group disappears", async (t) => {
  const pending = ["EPERM", "EPERM", "ESRCH"];
  const kill = t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -12345);
    assert.equal(signal, "SIGKILL");
    const code = pending.shift();
    if (code) throw Object.assign(new Error(code), { code });
    assert.fail("must stop once the process group no longer exists");
  });
  await signalProcessGroup(12345, "SIGKILL", { platform: "darwin" });
  assert.equal(kill.mock.callCount(), 3);
});

test("Darwin group cleanup reports a persistent permission error after a bounded retry", { timeout: 2000 }, async (t) => {
  const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
  const kill = t.mock.method(process, "kill", () => { throw denied; });
  await assert.rejects(signalProcessGroup(12345, "SIGTERM", { platform: "darwin" }), (error) => error === denied);
  assert.ok(kill.mock.callCount() > 1 && kill.mock.callCount() < 20);
});

test("group cleanup does not retry unrelated errors or non-Darwin permission failures", async (t) => {
  for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EINVAL"]]) {
    const error = Object.assign(new Error(code), { code });
    const kill = t.mock.method(process, "kill", () => { throw error; });
    await assert.rejects(signalProcessGroup(12345, "SIGTERM", { platform }), (caught) => caught === error);
    assert.equal(kill.mock.callCount(), 1);
    kill.mock.restore();
  }
});
