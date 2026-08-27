const BRIDGE_URL = "ws://127.0.0.1:43124";
let socket;
let reconnectTimer;
let creatingChatGPTTab;

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

async function findChatGPTTab() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const lastFocusedWindow = await chrome.windows.getLastFocused().catch(() => null);
  const ready =
    tabs.find((tab) => tab.windowId === lastFocusedWindow?.id && tab.active && tab.status === "complete") ||
    tabs.find((tab) => tab.windowId === lastFocusedWindow?.id && tab.status === "complete") ||
    tabs.find((tab) => tab.active && tab.status === "complete") ||
    tabs.find((tab) => tab.status === "complete") ||
    tabs[0];
  if (ready?.id) return ready;
  if (!creatingChatGPTTab) {
    creatingChatGPTTab = chrome.tabs.create({ url: "https://chatgpt.com/", active: true }).finally(() => {
      creatingChatGPTTab = null;
    });
  }
  return creatingChatGPTTab;
}

async function waitForTab(tabId, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("等待 ChatGPT 页面加载超时");
}

async function sendToContent(tabId, message) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error("无法连接 ChatGPT 页面脚本");
}

async function reportStatus() {
  try {
    const tab = await findChatGPTTab();
    if (!tab.id) throw new Error("ChatGPT 标签页不可用");
    await waitForTab(tab.id);
    const status = await sendToContent(tab.id, { type: "paperlens:status" });
    send({ type: "status", signedIn: Boolean(status?.signedIn), url: status?.url || tab.url || "" });
  } catch {
    send({ type: "status", signedIn: false, url: "" });
  }
}

async function handleAsk(message) {
  try {
    const tab = await findChatGPTTab();
    if (!tab.id) throw new Error("ChatGPT 标签页不可用");
    await waitForTab(tab.id);
    const result = await sendToContent(tab.id, {
      type: "paperlens:ask",
      requestId: message.requestId,
      prompt: message.prompt,
      timeoutMs: message.timeoutMs,
    });
    send({
      type: "result",
      requestId: message.requestId,
      ok: Boolean(result?.ok),
      answer: result?.answer || "",
      conversationUrl: result?.conversationUrl || tab.url || "",
      error: result?.error || "",
    });
  } catch (error) {
    send({
      type: "result",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : "ChatGPT 网页调用失败",
    });
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket(BRIDGE_URL);
  socket.addEventListener("open", () => {
    send({ type: "hello", signedIn: false, url: "" });
    void reportStatus();
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "status-request") void reportStatus();
    if (message.type === "ask") void handleAsk(message);
    if (message.type === "cancel") {
      void findChatGPTTab().then((tab) => tab.id ? sendToContent(tab.id, {
        type: "paperlens:cancel",
        requestId: message.requestId,
      }) : null).catch(() => {});
    }
  });
  socket.addEventListener("close", () => {
    reconnectTimer = setTimeout(connect, 1200);
  });
  socket.addEventListener("error", () => socket.close());
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
