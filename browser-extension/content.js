const PROMPT_SELECTORS = [
  "#prompt-textarea",
  "textarea[placeholder]",
  '[contenteditable="true"][data-lexical-editor="true"]',
];
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="停止生成"]',
  'button[aria-label*="Stop generating"]',
];
const cancelledRequests = new Set();

function firstVisible(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && element.getBoundingClientRect().width > 0) return element;
  }
  return null;
}

function signedIn() {
  return Boolean(firstVisible(PROMPT_SELECTORS)) && !document.querySelector('a[href*="/auth/login"]');
}

function setPrompt(element, text) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, text);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function findSendButton() {
  return firstVisible([
    'button[data-testid="send-button"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="Send prompt"]',
  ]);
}

function generationActive() {
  if (firstVisible(STOP_SELECTORS)) return true;
  return [...document.querySelectorAll("button")].some((button) => {
    const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.textContent || ""}`;
    return /停止生成|stop generating/i.test(label) && button.getBoundingClientRect().width > 0;
  });
}

function latestAnswer() {
  const nodes = [...document.querySelectorAll(ASSISTANT_SELECTOR)];
  const message = nodes.at(-1);
  if (!message) return "";
  const markdown = message.querySelector(".markdown");
  if (markdown) return (markdown.innerText || "").trim();
  const clone = message.cloneNode(true);
  clone.querySelectorAll("button, [role='button'], svg").forEach((element) => element.remove());
  return (clone.textContent || "").trim();
}

async function waitForAnswer(requestId, beforeCount, timeoutMs) {
  const started = Date.now();
  let lastAnswer = "";
  let lastChangeAt = 0;
  while (Date.now() - started < timeoutMs) {
    if (cancelledRequests.delete(requestId)) throw new DOMException("请求已取消", "AbortError");
    const count = document.querySelectorAll(ASSISTANT_SELECTOR).length;
    const answer = count > beforeCount ? latestAnswer() : "";
    if (answer && answer !== lastAnswer) lastChangeAt = Date.now();
    lastAnswer = answer;
    if (answer && !generationActive() && lastChangeAt && Date.now() - lastChangeAt >= 6_000) return answer;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("等待 ChatGPT 网页回答超时");
}

async function ask({ requestId, prompt, timeoutMs }) {
  if (!signedIn()) throw new Error("请先在 ChatGPT 网页登录");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("PaperLens 没有提供问题");
  const editor = firstVisible(PROMPT_SELECTORS);
  if (!editor) throw new Error("没有找到 ChatGPT 输入框");
  const beforeCount = document.querySelectorAll(ASSISTANT_SELECTOR).length;
  setPrompt(editor, prompt);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sendButton = findSendButton();
  if (!sendButton || sendButton.disabled) throw new Error("ChatGPT 发送按钮不可用");
  sendButton.click();
  const answer = await waitForAnswer(requestId, beforeCount, Math.max(10_000, Number(timeoutMs) || 240_000));
  return { ok: true, answer, conversationUrl: location.href };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "paperlens:status") {
    sendResponse({ signedIn: signedIn(), url: location.href });
    return false;
  }
  if (message?.type === "paperlens:cancel" && typeof message.requestId === "string") {
    cancelledRequests.add(message.requestId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type !== "paperlens:ask") return false;
  ask(message).then(sendResponse).catch((error) => sendResponse({
    ok: false,
    error: error instanceof Error ? error.message : "ChatGPT 网页调用失败",
  }));
  return true;
});
