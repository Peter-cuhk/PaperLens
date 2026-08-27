export class ProviderError extends Error {
  constructor(message, { code = "provider_error", status = 500, retryable = false, provider = "unknown", cause } = {}) {
    super(message, { cause });
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
  }
}

export function normalizeProviderError(error, provider = "unknown") {
  if (error instanceof ProviderError) return error;

  const status = Number(error?.status || error?.statusCode || 0);
  const rawCode = String(error?.code || error?.error?.code || "").toLowerCase();
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  const message = rawMessage.toLowerCase();
  const serviceName = provider === "mimo" ? "MiMo API" : provider === "openai" ? "OpenAI API" : provider === "cloudbase-hunyuan" ? "CloudBase Hy3" : provider === "chatgpt-web" ? "ChatGPT 网页" : "AI 服务";

  if (error?.name === "AbortError" || message.includes("aborted")) {
    return new ProviderError("请求已取消", { code: "request_aborted", status: 499, provider, cause: error });
  }
  if (error?.name === "APIConnectionTimeoutError" || rawCode.includes("timeout") || message.includes("timeout")) {
    return new ProviderError("AI 服务响应超时，请稍后重试", { code: "upstream_timeout", status: 504, retryable: true, provider, cause: error });
  }
  if (status === 401 || rawCode.includes("api_key") || message.includes("api key")) {
    return new ProviderError(`${serviceName} Key 无效或已失效`, { code: "invalid_api_key", status: 401, provider, cause: error });
  }
  if (status === 429 && (rawCode.includes("quota") || message.includes("quota") || message.includes("billing"))) {
    return new ProviderError(`${serviceName} 额度不足，请检查账户用量和账单设置`, { code: "quota_exceeded", status: 429, provider, cause: error });
  }
  if (status === 429) {
    return new ProviderError(`${serviceName} 请求过于频繁，请稍后重试`, { code: "rate_limited", status: 429, retryable: true, provider, cause: error });
  }
  if (rawCode.includes("concurrent") || message.includes("concurrent request limit")) {
    return new ProviderError(`${serviceName} 请求过于频繁，请稍后重试`, { code: "rate_limited", status: 429, retryable: true, provider, cause: error });
  }
  if (rawCode.includes("quota") || message.includes("resource package") || message.includes("额度") || message.includes("套餐")) {
    return new ProviderError(`${serviceName} 额度暂不可用`, { code: "quota_exceeded", status: 429, provider, cause: error });
  }
  if (status >= 500 || error?.name === "APIConnectionError") {
    return new ProviderError(`${serviceName} 暂时不可用，请稍后重试`, { code: "upstream_unavailable", status: 502, retryable: true, provider, cause: error });
  }
  if (status >= 400 && status < 500) {
    return new ProviderError(rawMessage || "AI 服务拒绝了请求", { code: rawCode || "invalid_request", status, provider, cause: error });
  }
  return new ProviderError(rawMessage || "AI 服务调用失败", { code: "provider_error", status: 500, provider, cause: error });
}
