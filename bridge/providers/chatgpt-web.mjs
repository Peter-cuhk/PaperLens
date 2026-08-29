import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProviderError, normalizeProviderError } from "../provider-errors.mjs";

const MCP_SERVER_PATH = fileURLToPath(new URL("../chatgpt-web-mcp.mjs", import.meta.url));

function structuredResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { answer: text };
  }
}

export function createChatGPTWebProvider({
  enabled = process.env.PAPERLENS_CHATGPT_WEB_ENABLED !== "0",
  command = process.execPath,
  serverPath = MCP_SERVER_PATH,
  pairingToken = process.env.PAPERLENS_CHATGPT_WEB_TOKEN || randomUUID(),
  clientFactory,
} = {}) {
  let client = null;
  let transport = null;
  let connecting = null;
  let available = false;

  async function getClient() {
    if (client) return client;
    if (!enabled) throw new ProviderError("ChatGPT 网页功能尚未启用", { code: "provider_not_configured", status: 503, provider: "chatgpt-web" });
    if (!connecting) {
      connecting = (async () => {
        if (clientFactory) {
          client = await clientFactory();
          return client;
        }
        const nextClient = new Client({ name: "paperlens-local", version: "0.1.0" });
        const nextTransport = new StdioClientTransport({
          command,
          args: [serverPath],
          cwd: process.cwd(),
          env: {
            ...process.env,
            PAPERLENS_CHATGPT_WEB_PORT: process.env.PAPERLENS_CHATGPT_WEB_PORT || "43124",
            PAPERLENS_CHATGPT_WEB_TOKEN: pairingToken,
          },
          stderr: "inherit",
          maxBufferSize: 4 * 1024 * 1024,
        });
        await nextClient.connect(nextTransport);
        client = nextClient;
        transport = nextTransport;
        return client;
      })().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  async function refreshStatus() {
    try {
      const mcp = await getClient();
      const result = structuredResult(await mcp.callTool({ name: "chatgpt_web_status", arguments: {} }, undefined, { timeout: 10_000 }));
      available = Boolean(result.connected && result.signedIn);
      return { ok: available, ...result };
    } catch {
      available = false;
      return { ok: false, connected: false, signedIn: false, url: "" };
    }
  }

  async function testConnection() {
    const status = await refreshStatus();
    if (!status.connected) {
      throw new ProviderError("ChatGPT 网页扩展未连接；请先加载 PaperLens 扩展并打开 ChatGPT", { code: "provider_not_configured", status: 503, provider: "chatgpt-web" });
    }
    if (!status.signedIn) {
      throw new ProviderError("ChatGPT 网页尚未登录", { code: "provider_not_configured", status: 503, provider: "chatgpt-web" });
    }
    return status;
  }

  async function invoke(payload, { prompt, signal } = {}) {
    if (!prompt?.trim()) throw new ProviderError("ChatGPT 网页请求缺少提示词", { code: "invalid_request", status: 400, provider: "chatgpt-web" });
    const images = Array.isArray(payload?.images) ? payload.images.slice(0, 8).map((image, index) => ({
      label: typeof image?.label === "string" ? image.label.slice(0, 200) : `PaperLens image ${index + 1}`,
      dataUrl: typeof image?.dataUrl === "string" ? image.dataUrl : "",
    })).filter((image) => /^data:image\/(?:png|jpe?g|webp);base64,/i.test(image.dataUrl)) : [];
    try {
      const mcp = await getClient();
      const raw = await mcp.callTool({
        name: "ask_chatgpt_web",
        arguments: { prompt, images },
      }, undefined, {
        signal,
        timeout: 240_000,
        maxTotalTimeout: 300_000,
      });
      const result = structuredResult(raw);
      if (!result.answer?.trim()) throw new Error("ChatGPT 网页没有返回文本内容");
      available = true;
      return {
        answer: result.answer.trim(),
        provider: "chatgpt-web",
        model: "ChatGPT Web Chat",
        conversationUrl: result.conversationUrl || "",
      };
    } catch (error) {
      available = false;
      throw normalizeProviderError(error, "chatgpt-web");
    }
  }

  async function close() {
    client = null;
    available = false;
    if (transport) await transport.close();
    transport = null;
  }

  return {
    id: "chatgpt-web",
    label: "ChatGPT 网页 Chat",
    configured: Boolean(enabled),
    get available() { return available; },
    pairingToken,
    models: { translation: "chatgpt-web", chat: "chatgpt-web" },
    allowedModels: ["chatgpt-web"],
    capabilities: { text: true, images: true, structuredOutput: true, repositoryVerification: false, chatOnly: false },
    refreshStatus,
    testConnection,
    invoke,
    close,
  };
}
