// Adapter for GitHub: enriches already-ingested projects that link a repo with
// README text, languages, a trimmed file tree and contributor commit counts.
// Parsers are pure (API JSON in, plain data out) and tested against fixtures;
// fetchRecords wires them to the polite fetcher. An optional GITHUB_TOKEN lifts
// the unauthenticated rate limit.
import { makeRecord } from "../lib/records.js";

export const name = "github";

const API = "https://api.github.com";
const REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i;
const MAX_TREE_PATHS = 200;
const MAX_README_CHARS = 20_000;
const MAX_CONTRIBUTORS = 10;

/**
 * @param {{ token?: string }} options
 * @param {{ http: object, projects?: { source_url: string, title: string, github_url: string | null }[] }} deps
 *   `projects` is supplied by the ingest service from the store.
 * @returns {Promise<object[]>} project records carrying readme/fileTree/githubStats
 */
export async function fetchRecords(options, { http, projects = [] }) {
  const init = options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : {};
  const records = [];
  for (const project of projects) {
    const repo = parseRepoUrl(project.github_url);
    if (!repo) continue;
    const data = await fetchRepoData(repo, http, init).catch(() => null);
    if (data) records.push(makeRecord("project", name, project.source_url, { title: project.title, ...data }));
  }
  return records;
}

/** @returns {{ owner: string, repo: string } | null} null unless the URL names a repo (not just a user) */
export function parseRepoUrl(url) {
  const match = REPO_RE.exec(url ?? "");
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** @returns {string} decoded README text, capped so huge READMEs don't bloat the DB */
export function parseReadme(json) {
  if (json?.encoding !== "base64" || typeof json.content !== "string") return "";
  return Buffer.from(json.content, "base64").toString("utf8").slice(0, MAX_README_CHARS);
}

/** @returns {string[]} blob paths only, capped; directories are implied by the paths */
export function parseTree(json) {
  return (json?.tree ?? []).filter((n) => n.type === "blob").map((n) => n.path).slice(0, MAX_TREE_PATHS);
}

/** @returns {{ name: string, share: number }[]} languages by share of bytes, largest first */
export function parseLanguages(json) {
  const entries = Object.entries(json ?? {});
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (!total) return [];
  return entries.sort((a, b) => b[1] - a[1]).map(([language, bytes]) => ({ name: language, share: Math.round((bytes / total) * 100) / 100 }));
}

/** @returns {{ login: string, commits: number, url: string }[]} top contributors by commits */
export function parseContributors(json) {
  return (Array.isArray(json) ? json : []).slice(0, MAX_CONTRIBUTORS)
    .map((c) => ({ login: c.login, commits: c.contributions, url: c.html_url }));
}

// ---------------------------------------------------------------- private helpers
async function fetchRepoData({ owner, repo }, http, init) {
  const base = `${API}/repos/${owner}/${repo}`;
  const meta = await http.getJson(base, init);
  const [languages, contributors, readme, tree] = await Promise.all([
    http.getJson(`${base}/languages`, init).catch(() => ({})),
    http.getJson(`${base}/contributors?per_page=${MAX_CONTRIBUTORS}`, init).catch(() => []),
    http.getJson(`${base}/readme`, init).catch(() => null),
    http.getJson(`${base}/git/trees/${encodeURIComponent(meta.default_branch ?? "HEAD")}?recursive=1`, init).catch(() => null),
  ]);
  return {
    readme: parseReadme(readme) || null,
    fileTree: parseTree(tree),
    githubStats: { stars: meta.stargazers_count ?? 0, languages: parseLanguages(languages), contributors: parseContributors(contributors) },
  };
}
