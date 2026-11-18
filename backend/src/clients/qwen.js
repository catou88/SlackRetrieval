// OpenAI-compatible chat client for open-source Qwen (Ollama by default, or
// any vLLM/llama.cpp server). fetch is injectable so tests use a mock; all
// services depend on `chat()` only, never on a vendor SDK.
import { CONFIG } from "../config.js";

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {{ chat(messages: {role: string, content: string}[], opts?: { temperature?: number, maxTokens?: number }): Promise<string>, isReachable(): Promise<boolean>, model: string }}
 */
export function createQwenClient(options = {}) {
  const settings = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    baseUrl: (options.baseUrl ?? CONFIG.qwen.baseUrl).replace(/\/+$/, ""),
    model: options.model ?? CONFIG.qwen.model,
    timeoutMs: options.timeoutMs ?? CONFIG.qwen.timeoutMs,
  };
  return {
    model: settings.model,
    chat: (messages, opts) => chat(settings, messages, opts),
    isReachable: () => isReachable(settings),
  };
}

/**
 * Qwen3 models may emit <think>…</think> reasoning; callers want only the answer.
 * @param {string} text
 * @returns {string}
 */
export function stripThinking(text) {
  return String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
}

// ---------------------------------------------------------------- private helpers
async function chat(settings, messages, { temperature = 0.1, maxTokens = 800 } = {}) {
  const response = await settings.fetchImpl(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: settings.model, messages, temperature, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  if (!response.ok) throw new Error(`Qwen endpoint returned ${response.status}`);
  const json = await response.json();
  const choice = json?.choices?.[0];
  // Thinking tokens count against max_tokens: a truncated reply is incomplete, so fail instead of storing half an answer.
  if (choice?.finish_reason === "length") throw new Error("Qwen reply was cut off (raise max tokens)");
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new Error("Qwen endpoint returned no message content");
  return stripThinking(content);
}

async function isReachable(settings) {
  try {
    const response = await settings.fetchImpl(`${settings.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}
