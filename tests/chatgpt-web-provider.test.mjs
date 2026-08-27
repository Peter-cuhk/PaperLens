import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";

import { createChatGPTWebProvider } from "../bridge/providers/chatgpt-web.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function connectExtension(port) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
          origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

test("ChatGPT Web provider crosses the MCP boundary and receives a browser answer", async () => {
  const port = await freePort();
  const previousPort = process.env.PAPERLENS_CHATGPT_WEB_PORT;
  process.env.PAPERLENS_CHATGPT_WEB_PORT = String(port);
  const provider = createChatGPTWebProvider({ enabled: true });
  let socket;
  try {
    assert.equal((await provider.refreshStatus()).ok, false);
    socket = await connectExtension(port);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "status-request") {
        socket.send(JSON.stringify({ type: "status", signedIn: true, url: "https://chatgpt.com/" }));
      }
      if (message.type === "ask") {
        assert.match(message.prompt, /selected paragraph/);
        socket.send(JSON.stringify({
          type: "result",
          requestId: message.requestId,
          ok: true,
          answer: "PAPERLENS_WEB_CHAT_OK\nMCP browser bridge returned the answer.",
          conversationUrl: "https://chatgpt.com/c/test",
        }));
      }
    });
    socket.send(JSON.stringify({ type: "hello", signedIn: true, url: "https://chatgpt.com/" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await provider.testConnection()).ok, true);
    const result = await provider.invoke({ mode: "chat" }, { prompt: "selected paragraph", signal: new AbortController().signal });
    assert.equal(result.provider, "chatgpt-web");
    assert.match(result.answer, /^PAPERLENS_WEB_CHAT_OK/);
    assert.equal(result.conversationUrl, "https://chatgpt.com/c/test");
  } finally {
    socket?.close();
    await provider.close();
    if (previousPort === undefined) delete process.env.PAPERLENS_CHATGPT_WEB_PORT;
    else process.env.PAPERLENS_CHATGPT_WEB_PORT = previousPort;
  }
});
