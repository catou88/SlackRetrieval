// Owns the Slack transport: checking a token is usable, creating the Web API
// client (with the browser-session cookie when there is one), and the raw
// HTTP downloads of shared files and profile photos. Knows nothing about the
// archive format; services/ingest.js decides what to fetch and where it goes.
import { WebClient } from "@slack/web-api";
import { CONFIG } from "../config.js";

const API_RETRIES = 10; // long syncs hit rate limits; the SDK backs off between tries
const PLACEHOLDER_TOKEN_MARK = "your-token"; // the value shipped in .env.example
const BROWSER_SESSION_TOKEN_PREFIX = "xoxc-";
const AUTH_FAILURE_STATUSES = [401, 403];

/**
 * Throw a setup hint when the token cannot work.
 * @param {string} token
 * @throws {Error} placeholder/missing token, or an xoxc- token without SLACK_COOKIE
 */
export function assertUsableSlackToken(token) {
  if (!token || token.includes(PLACEHOLDER_TOKEN_MARK))
    throw new Error("Put your real token in .env as SLACK_USER_TOKEN (see README).");
  if (token.startsWith(BROWSER_SESSION_TOKEN_PREFIX) && !CONFIG.slack.cookie)
    throw new Error("xoxc- tokens also need SLACK_COOKIE (the d cookie, starts with xoxd-) in .env.");
}

/**
 * A Web API client that retries through rate limits. Browser-session tokens
 * (xoxc-) only work together with the d cookie from the same session.
 * @param {string} token
 * @returns {WebClient}
 */
export function createSlackClient(token) {
  return new WebClient(token, { retryConfig: { retries: API_RETRIES }, headers: sessionCookieHeader() });
}

/**
 * Download one file shared in Slack (needs the files:read scope).
 * @param {{ url: string, mimetype: string }} file  an archived file record
 * @param {string} token
 * @returns {Promise<{ outcome: "saved", bytes: Buffer } | { outcome: "unauthorized" } | { outcome: "unavailable" }>}
 *   unauthorized: the token cannot read files at all, so further downloads are pointless;
 *   unavailable: this one file is deleted or gone
 * @throws {Error} on network failure
 */
export async function downloadSlackFile(file, token) {
  const response = await fetch(file.url, { headers: { Authorization: `Bearer ${token}`, ...sessionCookieHeader() } });
  const contentType = response.headers.get("content-type") || "";
  // Slack answers with its HTML login page when the token lacks files:read.
  const isLoginPage = contentType.includes("text/html") && !file.mimetype.includes("html");
  if (isLoginPage || AUTH_FAILURE_STATUSES.includes(response.status)) return { outcome: "unauthorized" };
  if (!response.ok) return { outcome: "unavailable" };
  return { outcome: "saved", bytes: Buffer.from(await response.arrayBuffer()) };
}

/**
 * Download a profile photo (public CDN URL, no auth).
 * @param {string} url
 * @returns {Promise<Buffer | null>} null when the server answers with an error status
 * @throws {Error} on network failure
 */
export async function downloadProfilePhoto(url) {
  const response = await fetch(url);
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

// ---------------------------------------------------------------- private helpers
function sessionCookieHeader() {
  let cookie = CONFIG.slack.cookie.replace(/^d=/, "");
  if (!cookie) return {};
  if (!cookie.includes("%")) cookie = encodeURIComponent(cookie); // Slack expects the URL-encoded value
  return { Cookie: `d=${cookie}` };
}
