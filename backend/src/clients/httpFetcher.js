// Owns polite outbound HTTP for scrapers: >=1s between requests to one host,
// retry with backoff on transient failures, a robots.txt check, a generic
// User-Agent, and an on-disk cache of raw responses (data/raw/, gitignored) so
// re-runs never re-hit a site. Fetch, clock, and sleep are injectable so tests
// run offline and instantly.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CONFIG } from "../config.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[|.*\.(local|internal)$)/i;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {string} [options.cacheDir]   where raw responses are stored; null disables
 * @param {number} [options.minIntervalMs]
 * @param {string} [options.userAgent]
 * @param {boolean} [options.respectRobots]
 * @returns {{ getText(url: string, init?: object): Promise<string>, getJson(url: string, init?: object): Promise<any> }}
 */
export function createHttpFetcher(options = {}) {
  const settings = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
    cacheDir: options.cacheDir === undefined ? path.join(CONFIG.dataDir, "raw") : options.cacheDir,
    minIntervalMs: Math.max(options.minIntervalMs ?? CONFIG.intel.http.minIntervalMs, 0),
    userAgent: options.userAgent ?? CONFIG.intel.http.userAgent,
    respectRobots: options.respectRobots ?? true,
  };
  const lastRequestAt = new Map(); // host -> ms timestamp
  const robotsRules = new Map(); // origin -> string[] of disallowed path prefixes

  async function getText(url, init = {}) {
    assertPublicHttps(url);
    const cached = readCache(settings.cacheDir, url);
    if (cached !== null) return cached;
    if (settings.respectRobots && !(await isAllowed(url))) throw new Error(`Blocked by robots.txt: ${url}`);
    const text = await requestWithRetry(url, init);
    writeCache(settings.cacheDir, url, text);
    return text;
  }

  async function getJson(url, init = {}) {
    return JSON.parse(await getText(url, init));
  }

  async function requestWithRetry(url, init) {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await settings.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      try {
        const response = await fetchFollowingRedirects(url, init);
        if (response.ok) return await response.text();
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        if (!RETRYABLE_STATUS.has(response.status)) throw lastError;
      } catch (error) {
        lastError = error;
        if (/^HTTP 4\d\d/.test(error.message) && !/^HTTP 429/.test(error.message)) throw error;
      }
    }
    throw lastError;
  }

  // Redirects are followed by hand so every hop is re-validated (public https
  // only), rate-limited per host and robots-checked: a Devpost link must not be
  // able to bounce us to an internal address or around the politeness rules.
  async function fetchFollowingRedirects(url, init) {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertPublicHttps(target);
      if (hop > 0 && settings.respectRobots && !(await isAllowed(target))) throw new Error(`HTTP 403 blocked by robots.txt: ${target}`);
      await waitForTurn(target);
      const response = await settings.fetchImpl(target, { ...withUserAgent(init, settings.userAgent), redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const location = response.headers?.get?.("location");
      if (response.status < 300 || response.status >= 400 || !location) return response;
      target = new URL(location, target).href;
    }
    throw new Error(`HTTP 400 too many redirects for ${url}`);
  }

  async function waitForTurn(url) {
    const host = new URL(url).host;
    const earliest = (lastRequestAt.get(host) ?? -Infinity) + settings.minIntervalMs;
    const wait = earliest - settings.now();
    if (wait > 0) await settings.sleep(wait);
    lastRequestAt.set(host, settings.now());
  }

  async function isAllowed(url) {
    const { origin, pathname } = new URL(url);
    if (!robotsRules.has(origin)) robotsRules.set(origin, await loadDisallowed(origin));
    return !robotsRules.get(origin).some((prefix) => pathname.startsWith(prefix));
  }

  async function loadDisallowed(origin) {
    try {
      return parseRobotsDisallowed(await requestWithRetry(`${origin}/robots.txt`, {}));
    } catch (error) {
      // A missing robots.txt (4xx) means everything is allowed; an unreachable one
      // (5xx/network) is treated as disallow-all per RFC 9309 — fetch less, not more.
      return /^HTTP 4\d\d/.test(error.message) ? [] : ["/"];
    }
  }

  return { getText, getJson };
}

/**
 * Disallowed path prefixes that apply to every crawler (`User-agent: *`).
 * Deliberately minimal: no wildcards or Allow overrides. Rules containing `*`
 * or `$` are skipped, so such paths may still be fetched — adapters must only
 * request ordinary public pages. Consecutive User-agent lines form one group.
 * @param {string} text
 * @returns {string[]}
 */
export function parseRobotsDisallowed(text) {
  const disallowed = [];
  let appliesToUs = false;
  let previousWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(field)) {
      appliesToUs = value === "*" || (previousWasAgent && appliesToUs);
      previousWasAgent = true;
      continue;
    }
    if (line) previousWasAgent = false;
    if (appliesToUs && /^disallow$/i.test(field) && value) disallowed.push(value);
  }
  return disallowed.filter((prefix) => !/[*$]/.test(prefix));
}

// ---------------------------------------------------------------- private helpers
function assertPublicHttps(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" || PRIVATE_HOST_RE.test(hostname)) throw new Error(`HTTP 400 refusing non-public or non-https URL: ${url}`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withUserAgent(init, userAgent) {
  return { ...init, headers: { "User-Agent": userAgent, ...init.headers } };
}

function cachePath(cacheDir, url) {
  return path.join(cacheDir, createHash("sha256").update(url).digest("hex") + ".txt");
}

function readCache(cacheDir, url) {
  if (!cacheDir) return null;
  try {
    return fs.readFileSync(cachePath(cacheDir, url), "utf8");
  } catch {
    return null;
  }
}

function writeCache(cacheDir, url, text) {
  if (!cacheDir) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = cachePath(cacheDir, url);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file); // atomic: a crash never leaves a truncated cache entry
}
