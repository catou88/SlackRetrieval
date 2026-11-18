// Writes 2-3 sentences per team member about what they contributed, strictly
// from evidence we hold: their GitHub commit share, their Devpost bio/skills,
// and the project text. With only a name and nothing else the answer is
// "unknown" and the model is never called, so no contribution is invented.
import { upsertRecord, listProjects } from "../data/intelStore.js";

const MAX_SENTENCES_NOTE = "2-3 sentences";

/**
 * Describe each member's contribution to one project and store it.
 * @param {import("better-sqlite3").Database} db
 * @param {{ chat: Function }} qwen
 * @param {object} project  from listProjects/getProject (with members)
 * @returns {Promise<{ person: string, summary: string, evidence: string[] }[]>}
 */
export async function summarizeContributions(db, qwen, project) {
  const results = [];
  for (const member of project.members) {
    const evidence = gatherEvidence(project, member);
    const summary = evidence.length ? await askModel(qwen, project, member, evidence) : unknownSummary(member);
    upsertRecord(db, { kind: "contribution", source: "intel", sourceUrl: `${project.source_url}#${member.source_url}`,
      data: { projectUrl: project.source_url, personUrl: member.source_url, summary, evidence } });
    results.push({ person: member.name, summary, evidence });
  }
  return results;
}

/** Run over every project; one failing project does not stop the rest. */
export async function summarizeAllContributions(db, qwen) {
  const result = { projects: 0, people: 0, failed: [] };
  for (const project of listProjects(db)) {
    try {
      result.people += (await summarizeContributions(db, qwen, project)).length;
      result.projects++;
    } catch (err) {
      result.failed.push({ id: project.id, error: err.message });
    }
  }
  return result;
}

/**
 * Evidence lines, each a fact we can show the user.
 * @returns {string[]}
 */
export function gatherEvidence(project, member) {
  const lines = [];
  const login = githubLogin(member.github_url);
  const contributors = project.github_stats?.contributors ?? [];
  const total = contributors.reduce((sum, c) => sum + c.commits, 0);
  const mine = contributors.find((c) => login && c.login.toLowerCase() === login);
  if (mine) lines.push(`GitHub: ${mine.commits} of ${total} commits in the project repository (${mine.login}).`);
  if (member.bio) lines.push(`Devpost bio: ${member.bio}`);
  if (member.skills?.length) lines.push(`Skills listed: ${member.skills.join(", ")}.`);
  return lines;
}

// ---------------------------------------------------------------- private helpers
async function askModel(qwen, project, member, evidence) {
  const system = [
    `Write ${MAX_SENTENCES_NOTE} about what this person contributed to the hackathon project.`,
    "Use ONLY the evidence lines. Do not infer roles that the evidence does not show.",
    "Commit counts show effort, not which feature they built; say so if that is all you know.",
    "Plain text, no JSON.",
  ].join(" ");
  const user = `Project: ${project.title}\n${project.tagline ?? ""}\nPerson: ${member.name}\nEvidence:\n${evidence.map((e) => `- ${e}`).join("\n")}`;
  return (await qwen.chat([{ role: "system", content: system }, { role: "user", content: user }], { temperature: 0.1, maxTokens: 200 })).trim();
}

function unknownSummary(member) {
  return `Unknown: no evidence of ${member.name}'s specific contribution is available (no linked GitHub commits or profile details).`;
}

function githubLogin(url) {
  const match = /github\.com\/([^/?#\s]+)/i.exec(url ?? "");
  return match ? match[1].toLowerCase() : null;
}
