// Owns the domain error classes (stable `code`s that the HTTP layer maps to
// statuses) and the strict input validators that throw them. Messages are our
// own fixed text, safe to show; a provider error is kept only as `cause`.

export const MAX_INPUT_CHARS = 2000;

/** Base class: every error the app throws on purpose. */
export class DomainError extends Error {
  /**
   * @param {string} code  stable machine-readable code, e.g. "not_found"
   * @param {string} [message]  human text, safe to show to the user
   * @param {unknown} [cause]  the underlying error, for server logs only
   */
  constructor(code, message = code, cause) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** The caller sent something malformed. */
export class InvalidInputError extends DomainError {
  constructor(message) {
    super("invalid_request", message);
  }
}

/** A person, channel or other entity does not exist. */
export class NotFoundError extends DomainError {
  /** @param {string} entity  e.g. "person"; @param {string} [message] */
  constructor(entity, message = `${entity} not found`) {
    super("not_found", message);
    this.entity = entity;
  }
}

/** No Anthropic key or token is configured. */
export class ClaudeDisabledError extends DomainError {
  constructor(cause) {
    super("claude_disabled", "Claude is not configured", cause);
  }
}

/** Rate limit, outage, overload or connection failure. */
export class ModelUnavailableError extends DomainError {
  constructor(cause) {
    super("model_unavailable", "Claude is unavailable right now", cause);
  }
}

/** The call hit our timeout (or was aborted by it). */
export class ModelTimeoutError extends DomainError {
  constructor(cause) {
    super("model_timeout", "Claude took too long to answer", cause);
  }
}

/** The provider refused the request itself (400/404/413/422). */
export class ModelRejectedError extends DomainError {
  constructor(cause) {
    super("model_request_rejected", "Claude rejected the request", cause);
  }
}

/** The provider answered with something unusable. */
export class InvalidModelOutputError extends DomainError {
  constructor(message = "Claude returned an invalid response") {
    super("invalid_model_output", message);
  }
}

/** The vector index is missing or mid-rebuild. */
export class IndexUnavailableError extends DomainError {
  constructor(message = "The search index is not available — run `npm run index`, then try again.") {
    super("index_unavailable", message);
  }
}

/**
 * Strict text-input check. The value is returned exactly as given (never
 * trimmed or normalized) so it can be used in cache keys.
 * @param {unknown} value
 * @param {string} name  field name for the error message
 * @param {{ isRequired?: boolean, maxChars?: number }} [opts]
 * @returns {string | undefined} undefined for an optional field given as undefined/null/blank
 * @throws {InvalidInputError} non-string, missing/blank when required, or too long
 */
export function checkText(value, name, { isRequired = false, maxChars = MAX_INPUT_CHARS } = {}) {
  const isAbsent = value === undefined || value === null || value === "";
  if (!isAbsent && typeof value !== "string") throw new InvalidInputError(`${name} must be a string`);
  if (isAbsent || !value.trim()) {
    if (isRequired) throw new InvalidInputError(`${name} is required`);
    return undefined;
  }
  if (value.length > maxChars) throw new InvalidInputError(`${name} is too long (max ${maxChars})`);
  return value;
}

/**
 * Strict boolean check: undefined/null mean false, anything but a boolean throws.
 * @param {unknown} value
 * @param {string} name
 * @returns {boolean}
 * @throws {InvalidInputError}
 */
export function checkBool(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new InvalidInputError(`${name} must be a boolean`);
  return value;
}
