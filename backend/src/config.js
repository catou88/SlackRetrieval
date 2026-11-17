// Owns every environment read. All other modules take their settings from the
// frozen CONFIG object below, so `.env.example` documents the full surface.
// Loading `.env` is main.js's job (it imports "dotenv/config" first); this
// module only reads process.env, so tests and scripts stay hermetic.
import path from "node:path";
import { fileURLToPath } from "node:url";

// backend/src/config.js -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MS_PER_UNIT = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
const DEFAULT_PORT = 3000;
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const DEFAULT_CLAUDE_TIMEOUT_MS = 60_000;
const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_CATEGORY_THRESHOLD = 0.45;
const DEFAULT_PG_PORT = 5433;
const DEFAULT_QWEN_BASE_URL = "http://localhost:11434/v1"; // Ollama's OpenAI-compatible endpoint
const DEFAULT_QWEN_MODEL = "qwen3:8b";
const DEFAULT_QWEN_TIMEOUT_MS = 120_000;
const DEFAULT_HTTP_MIN_INTERVAL_MS = 1000; // politeness floor: >=1s between requests to one host
const PLACEHOLDER_KEY_MARK = "your-key"; // the value shipped in .env.example

/**
 * Parse a duration: "300" (seconds), "90s", "5m", "24h", "7d", "inf"; "0" disables.
 * @param {string | number | undefined} value
 * @param {number} fallbackMs  used when value is empty or invalid
 * @returns {number} milliseconds (Infinity for "inf")
 */
export function parseDuration(value, fallbackMs) {
  if (value === undefined || value === null || String(value).trim() === "") return fallbackMs;
  const text = String(value).trim().toLowerCase();
  if (["inf", "infinity", "never"].includes(text)) return Infinity;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(text);
  if (!match) {
    console.warn(`Ignoring invalid duration "${value}"`);
    return fallbackMs;
  }
  return Number(match[1]) * MS_PER_UNIT[match[2] || "s"];
}

/**
 * Build the settings object from an environment. Exported so tests can build
 * a config from a fake environment without touching process.env.
 * @param {Record<string, string | undefined>} env
 * @returns {Readonly<object>} deeply frozen settings
 */
export function buildConfig(env) {
  return deepFreeze({
    repoRoot: REPO_ROOT,
    dataDir: path.resolve(REPO_ROOT, env.DATA_DIR || "data"),
    frontendDir: path.join(REPO_ROOT, "frontend"),
    host: "127.0.0.1", // never exposed to the network
    port: Number(env.PORT) || DEFAULT_PORT,
    embedModel: env.EMBED_MODEL || DEFAULT_EMBED_MODEL,
    categoryThreshold: Number(env.CATEGORY_THRESHOLD) || DEFAULT_CATEGORY_THRESHOLD,
    claude: claudeConfig(env),
    slack: { token: env.SLACK_USER_TOKEN || "", cookie: (env.SLACK_COOKIE || "").trim() },
    pg: pgConfig(env),
    qwen: qwenConfig(env),
    intel: intelConfig(env),
    cache: cacheConfig(env),
    systemRoot: env.SystemRoot || "C:\\Windows", // where Windows keeps tar.exe
  });
}

/** The process-wide settings. */
export const CONFIG = buildConfig(process.env);

// ---------------------------------------------------------------- private helpers
function claudeConfig(env) {
  const apiKey = env.ANTHROPIC_API_KEY || "";
  const hasRealKey = !!apiKey && !apiKey.includes(PLACEHOLDER_KEY_MARK);
  return {
    model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    timeoutMs: Number(env.CLAUDE_TIMEOUT_MS) || DEFAULT_CLAUDE_TIMEOUT_MS,
    isConfigured: hasRealKey || !!env.ANTHROPIC_AUTH_TOKEN,
  };
}

function qwenConfig(env) {
  return {
    baseUrl: (env.QWEN_BASE_URL || DEFAULT_QWEN_BASE_URL).replace(/\/+$/, ""),
    model: env.QWEN_MODEL || DEFAULT_QWEN_MODEL,
    timeoutMs: Number(env.QWEN_TIMEOUT_MS) || DEFAULT_QWEN_TIMEOUT_MS,
  };
}

// Why a floor on minInterval: scrapers must never hammer a site, so even a
// misconfigured env cannot go below one request per second per host.
function intelConfig(env) {
  const requested = Number(env.INTEL_MIN_INTERVAL_MS);
  return {
    githubToken: env.GITHUB_TOKEN || "",
    http: {
      minIntervalMs: Math.max(requested || DEFAULT_HTTP_MIN_INTERVAL_MS, DEFAULT_HTTP_MIN_INTERVAL_MS),
      userAgent: "HackathonIntelBot/1.0 (research; respects robots.txt)",
    },
  };
}

function pgConfig(env) {
  const port = Number(env.PG_PORT) || DEFAULT_PG_PORT;
  const user = "slack";
  const password = "slack"; // local-only container bound to 127.0.0.1
  const database = "slack";
  return {
    url: env.PG_URL || `postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
    port, user, password, database,
    container: "slack-pgvector",
    volume: "slack-pgvector-data",
    image: "pgvector/pgvector:pg17",
  };
}

// Why these defaults: Claude answers are expensive and keyed by the data
// version, so a week is safe; API responses are also invalidated on any data
// change, so their TTL only bounds memory; embeddings are deterministic per
// model; avatars/attachments revalidate hourly via their ETag.
function cacheConfig(env) {
  return {
    isEnabled: env.CACHE !== "0",
    ttl: {
      llmMs: parseDuration(env.CACHE_TTL_LLM, 7 * MS_PER_UNIT.d),
      apiMs: parseDuration(env.CACHE_TTL_API, 5 * MS_PER_UNIT.m),
      embedMs: parseDuration(env.CACHE_TTL_EMBED, 24 * MS_PER_UNIT.h),
      staticMs: parseDuration(env.CACHE_TTL_STATIC, 1 * MS_PER_UNIT.h),
      memoMs: parseDuration(env.CACHE_TTL_MEMO, 1 * MS_PER_UNIT.h),
      sweepMs: parseDuration(env.CACHE_SWEEP, 1 * MS_PER_UNIT.m),
    },
  };
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
  return Object.freeze(value);
}
