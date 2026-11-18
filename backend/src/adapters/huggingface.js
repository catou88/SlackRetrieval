// Adapter for Hugging Face: for projects that link a Space or model, records
// the SDK/likes/tags from the public API so the UI can show a live demo badge.
// Only already-ingested projects with an hf_url are touched.
import { makeRecord } from "../lib/records.js";

export const name = "huggingface";

const API = "https://huggingface.co/api";
const HF_RE = /^https?:\/\/(?:www\.)?huggingface\.co\/(spaces\/|datasets\/)?([^/\s]+)\/([^/\s?#]+)\/?$/i;

/**
 * @param {object} options  unused
 * @param {{ http: object, projects?: object[] }} deps
 * @returns {Promise<object[]>} project records carrying hfInfo
 */
export async function fetchRecords(options, { http, projects = [] }) {
  const records = [];
  for (const project of projects) {
    const target = parseHfUrl(project.hf_url);
    if (!target) continue;
    const info = await http.getJson(`${API}/${target.kind}/${target.owner}/${target.repo}`).catch(() => null);
    if (info) records.push(makeRecord("project", name, project.source_url, { title: project.title, hfInfo: parseHfInfo(info) }));
  }
  return records;
}

/** @returns {{ kind: "spaces"|"models"|"datasets", owner: string, repo: string } | null} */
export function parseHfUrl(url) {
  const match = HF_RE.exec(url ?? "");
  if (!match) return null;
  const kind = (match[1] ?? "models/").replace("/", "");
  return { kind, owner: match[2], repo: match[3] };
}

/** @returns {{ sdk: string | null, likes: number, tags: string[] }} */
export function parseHfInfo(json) {
  return { sdk: json.sdk ?? null, likes: json.likes ?? 0, tags: (json.tags ?? []).filter((t) => !t.startsWith("region:")) };
}
