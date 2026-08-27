import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod/v4";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PAPERLENS_CHATGPT_WEB_PORT || 43124);
const REQUEST_TIMEOUT_MS = Number(process.env.PAPERLENS_CHATGPT_WEB_TIMEOUT_MS || 240_000);

let extensionSocket = null;
let extensionState = { connected: false, signedIn: false, url: "" };
const pendingRequests = new Map();

function sendExtension(payload) {
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
    throw new Error("PaperLens ChatGPT 浏览器扩展尚未连接");
  }
  extensionSocket.send(JSON.stringify(payload));
}

function rejectPending(message) {
  for (const { reject, timer } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(new Error(message));
  }
  pendingRequests.clear();
}

function extensionStatus() {
  return {
    connected: Boolean(extensionSocket && extensionSocket.readyState === WebSocket.OPEN),
    signedIn: extensionState.signedIn,
    url: extensionState.url,
  };
}

function askExtension(prompt, signal) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("等待 ChatGPT 网页回答超时"));
    }, REQUEST_TIMEOUT_MS);
    const abort = () => {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      try {
        sendExtension({ type: "cancel", requestId });
      } catch {
        // The browser may already be disconnected.
      }
      reject(new DOMException("请求已取消", "AbortError"));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    pendingRequests.set(requestId, {
      timer,
      resolve: (value) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    });
    try {
      sendExtension({ type: "ask", requestId, prompt, timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      signal?.removeEventListener("abort", abort);
      reject(error);
    }
  });
}

const socketServer = new WebSocketServer({ host: HOST, port: PORT });
socketServer.on("connection", (socket, request) => {
  const remoteAddress = request.socket.remoteAddress || "";
  const origin = request.headers.origin || "";
  const localClient = remoteAddress.includes("127.0.0.1") || remoteAddress === "::1";
  const paperLensExtension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  if (!localClient || !paperLensExtension) {
    socket.close(1008, "PaperLens extension connections only");
    return;
  }
  if (extensionSocket && extensionSocket !== socket) extensionSocket.close(1012, "New PaperLens extension connection");
  extensionSocket = socket;
  extensionState = { connected: true, signedIn: false, url: "" };
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "hello" || message.type === "status") {
      extensionState = {
        connected: true,
        signedIn: Boolean(message.signedIn),
        url: typeof message.url === "string" ? message.url : "",
      };
      return;
    }
    if (message.type !== "result" || typeof message.requestId !== "string") return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(message.requestId);
    if (message.ok && typeof message.answer === "string" && message.answer.trim()) {
      pending.resolve({
        answer: message.answer.trim(),
        conversationUrl: typeof message.conversationUrl === "string" ? message.conversationUrl : "",
      });
    } else {
      pending.reject(new Error(typeof message.error === "string" ? message.error : "ChatGPT 网页没有返回回答"));
    }
  });
  socket.on("close", () => {
    if (extensionSocket !== socket) return;
    extensionSocket = null;
    extensionState = { connected: false, signedIn: false, url: "" };
    rejectPending("PaperLens ChatGPT 浏览器扩展已断开");
  });
  socket.send(JSON.stringify({ type: "status-request" }));
});

const mcpServer = new McpServer({ name: "paperlens-chatgpt-web", version: "0.1.0" });

mcpServer.registerTool("chatgpt_web_status", {
  title: "ChatGPT Web status",
  description: "Return whether the local PaperLens browser extension is connected to a signed-in ChatGPT tab.",
  inputSchema: {},
}, async () => {
  const status = extensionStatus();
  return {
    content: [{ type: "text", text: JSON.stringify(status) }],
    structuredContent: status,
  };
});

mcpServer.registerTool("ask_chatgpt_web", {
  title: "Ask ChatGPT Web",
  description: "Send PaperLens document context and a question through the user's visible signed-in ChatGPT web chat and return the final visible answer.",
  inputSchema: {
    prompt: z.string().min(1).max(2_000_000),
  },
}, async ({ prompt }, extra) => {
  const status = extensionStatus();
  if (!status.connected) throw new Error("PaperLens ChatGPT 浏览器扩展尚未连接");
  if (!status.signedIn) throw new Error("请先在浏览器中登录 ChatGPT");
  const result = await askExtension(prompt, extra.signal);
  return {
    content: [{ type: "text", text: result.answer }],
    structuredContent: result,
  };
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);

process.on("SIGTERM", () => {
  socketServer.close();
  process.exit(0);
});
