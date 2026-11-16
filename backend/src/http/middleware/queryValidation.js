// Owns strict query-string checks used by route definitions. They run before
// any cache lookup, so a bad request always gets its normal 400.
import { checkText, InvalidInputError, MAX_INPUT_CHARS } from "../../lib/errors.js";

/**
 * A required, single, non-blank text parameter.
 * @param {URLSearchParams} params
 * @throws {InvalidInputError}
 */
export function requireTextParam(params, name, maxChars = MAX_INPUT_CHARS) {
  if (!params.has(name)) throw new InvalidInputError(`${name} is required`);
  rejectRepeatedParam(params, name);
  checkText(params.get(name), name, { isRequired: true, maxChars });
}

/** An optional, single text parameter. @throws {InvalidInputError} */
export function optionalTextParam(params, name, maxChars = MAX_INPUT_CHARS) {
  rejectRepeatedParam(params, name);
  if (params.has(name)) checkText(params.get(name), name, { maxChars });
}

/** An optional non-negative integer no larger than `max`. @throws {InvalidInputError} */
export function optionalIntegerParam(params, name, max) {
  if (!params.has(name)) return;
  rejectRepeatedParam(params, name);
  const value = params.get(name);
  if (!/^\d+$/.test(value) || Number(value) > max) throw new InvalidInputError(`${name} must be an integer 0-${max}`);
}

/** An optional parameter restricted to `allowed` values. @throws {InvalidInputError} */
export function optionalChoiceParam(params, name, allowed) {
  optionalTextParam(params, name);
  if (params.has(name) && !allowed.includes(params.get(name))) {
    throw new InvalidInputError(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

/** @returns {number | undefined} the integer value of a validated parameter */
export function integerParam(params, name) {
  return params.has(name) ? Number(params.get(name)) : undefined;
}

// ---------------------------------------------------------------- private helpers
function rejectRepeatedParam(params, name) {
  if (params.getAll(name).length > 1) throw new InvalidInputError(`${name} given more than once`);
}
