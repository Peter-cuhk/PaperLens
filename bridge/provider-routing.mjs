export const PROVIDER_IDS = ["local-codex", "chatgpt-web", "cloudbase-hunyuan", "openai", "mimo"];
export const INVOCATION_MODES = ["translate", "terms", "chat", "auto", "repository"];

const REPOSITORY_QUESTION = /(?:代码|源码|仓库|github|实现|复现|训练脚本|评估脚本|配置|参数|命令行|数据格式|文件|目录|class|function|config|script|implementation|codebase|repository|repo\b|cli\b)/i;

export function requiresRepositoryVerification(payload) {
  return payload?.mode === "repository" || (payload?.mode === "auto" && REPOSITORY_QUESTION.test(String(payload?.question || "")));
}

export function resolveProviderRoute(payload, requestedProvider, availability) {
  const selected = PROVIDER_IDS.includes(requestedProvider) ? requestedProvider : "local-codex";
  const repositoryRequired = requiresRepositoryVerification(payload);

  if (selected !== "local-codex" && repositoryRequired) {
    if (availability?.["local-codex"]) {
      return {
        provider: "local-codex",
        payload,
        fallbackReason: "代码实现问题需要实时核实资料对应仓库，已切换到本机 Codex",
      };
    }
    return {
      provider: "openai",
      payload,
      unsupportedReason: "这个问题需要核实真实仓库，但本机 Codex 当前不可用",
    };
  }

  if (selected === "chatgpt-web" && (payload?.mode === "translate" || payload?.mode === "terms")) {
    if (availability?.mimo) {
      return {
        provider: "mimo",
        payload,
        fallbackReason: "ChatGPT 网页实验通道只用于问答，翻译与术语已切换到 MiMo",
      };
    }
    return {
      provider: "chatgpt-web",
      payload,
      unsupportedReason: "ChatGPT 网页实验通道只用于问答；请先配置 MiMo 完成翻译与术语任务",
    };
  }

  if (selected !== "local-codex" && payload?.mode === "auto") {
    return {
      provider: selected,
      payload: { ...payload, mode: "chat" },
      repositoryDecision: "skipped",
    };
  }

  return { provider: selected, payload };
}

export function shouldFallbackToMiMo(providerId, errorCode, availability) {
  return providerId === "cloudbase-hunyuan"
    && errorCode !== "request_aborted"
    && Boolean(availability?.mimo);
}
