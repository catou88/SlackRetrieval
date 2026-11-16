// Owns the Anthropic Messages API transport: whether Claude is configured, one
// request with a hard timeout, response validation, and mapping provider /
// transport failures to domain errors. Knows nothing about prompts or caching
// (services/rag.js builds the request, services/llmCache.js stores answers).
import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.js";
import {
  DomainError, ClaudeDisabledError, ModelUnavailableError, ModelTimeoutError, ModelRejectedError, InvalidModelOutputError,
} from "../lib/errors.js";

const SDK_MAX_RETRIES = 1; // our own timeout bounds the whole call; one quick retry is enough
const REJECTED_STATUSES = [400, 404, 413, 422];
const AUTH_STATUSES = [401, 403];
const CACHEABLE_STOP_REASONS = ["end_turn", "stop_sequence"];

/** @returns {boolean} whether an API key or auth token is configured */
export function isClaudeConfigured() {
  return CONFIG.claude.isConfigured;
}

/** @returns {Anthropic} a client using the key/token from the environment */
export function createClaudeClient() {
  return new Anthropic();
}

/**
 * One request with a hard timeout. Our own timer (not just the SDK option)
 * guarantees the call settles even if the client ignores the abort signal.
 * @param {{ beta: { messages: { create: Function } } }} client
 * @param {object} params  a full Messages API request
 * @param {number} timeoutMs
 * @returns {Promise<{ answer: string, usage: object, ok: boolean }>} see validateResponse
 * @throws {DomainError}
 */
export async function invokeClaude(client, params, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = Object.assign(new Error("timeout"), { name: "TimeoutError" });
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    const request = client.beta.messages.create(params, { signal: controller.signal, timeout: timeoutMs, maxRetries: SDK_MAX_RETRIES });
    return validateResponse(await Promise.race([request, timeout]));
  } catch (err) {
    throw toDomainError(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate a Messages API response.
 * @returns {{ answer: string, usage: object, ok: boolean }} ok means "safe to
 *   cache": false for refusals and max_tokens-truncated answers (shown, not stored)
 * @throws {InvalidModelOutputError} malformed response or no text
 */
export function validateResponse(response) {
  if (!response || typeof response !== "object" || !Array.isArray(response.content)) throw new InvalidModelOutputError();
  if (response.stop_reason === "refusal") return refusalResult(response);
  const answer = response.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!answer) throw new InvalidModelOutputError("Claude returned an empty answer");
  return { answer, usage: response.usage, ok: CACHEABLE_STOP_REASONS.includes(response.stop_reason) };
}

/**
 * Map any provider/transport failure to a domain error. The provider message
 * is kept only as `cause` (server logs), never in the public message.
 * @param {unknown} err
 * @returns {DomainError}
 */
export function toDomainError(err) {
  if (err instanceof DomainError) return err;
  if (isTimeout(err)) return new ModelTimeoutError(err);
  const status = err?.status;
  if (AUTH_STATUSES.includes(status)) return new ClaudeDisabledError(err);
  if (REJECTED_STATUSES.includes(status)) return new ModelRejectedError(err);
  // 429 rate limit, 500/502/503 outage, 529 overloaded, connection errors, unknown.
  return new ModelUnavailableError(err);
}

// ---------------------------------------------------------------- private helpers
function refusalResult(response) {
  const explanation = response.stop_details?.explanation;
  const why = typeof explanation === "string" ? explanation : "no details";
  return { answer: `(Claude declined to answer: ${why})`, usage: response.usage, ok: false };
}

function isTimeout(err) {
  const name = err?.name || "";
  return err instanceof Anthropic.APIConnectionTimeoutError || name === "TimeoutError" || name === "AbortError";
}
