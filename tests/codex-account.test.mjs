import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { CodexAccountClient, normalizeCodexAccount } from "../bridge/codex-account.mjs";

test("normalizes Codex login separately from rate-limit state", () => {
  const status = normalizeCodexAccount({ account: { type: "chatgpt", email: "reader@example.com", planType: "plus" } }, {
    rateLimitsByLimitId: {
      codex: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 }, rateLimitReachedType: null },
    },
  });
  assert.equal(status.loggedIn, true);
  assert.equal(status.authMode, "chatgpt");
  assert.equal(status.rateLimits[0].remainingPercent, 75);
  assert.equal(status.rateLimitReached, false);
});

function fakeAppServerSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit("close", 0); };
  let buffer = "";
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result = {};
        if (request.method === "account/read") result = { account: { type: "chatgpt", email: "reader@example.com", planType: "plus" } };
        if (request.method === "account/rateLimits/read") result = { rateLimits: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 }, rateLimitReachedType: null } };
        if (request.method === "account/login/start") result = { type: "chatgpt", loginId: "login-1", authUrl: "https://chatgpt.com/auth" };
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      }
      callback();
    },
  });
  return child;
}

test("Codex app-server client initializes, reads account limits, and starts browser login", async () => {
  const client = new CodexAccountClient("codex", { spawn: fakeAppServerSpawn });
  try {
    const status = await client.readStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.rateLimits[0].remainingPercent, 60);
    const login = await client.startLogin();
    assert.equal(login.authUrl, "https://chatgpt.com/auth");
  } finally {
    client.close();
  }
});
