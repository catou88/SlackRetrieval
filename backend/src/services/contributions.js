// Writes 2-3 sentences per team member about what they contributed, strictly
// from evidence we hold: their GitHub commit share, their Devpost bio/skills,
// and the project text. With only a name and nothing else the answer is
// "unknown" and the model is never called, so no contribution is invented.
import { upsertRecord, listProjects } from "../data/intelStore.js";
import { fenceSource, DATA_ONLY_RULE } from "../lib/promptSafety.js";

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
    // A self-written bio is not proof of a contribution: only commits or a mention in the project text let the model speak.
    const summary = hasContributionEvidence(evidence) ? await safeAsk(qwen, project, member, evidence) : unknownSummary(member, evidence);
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

/** @returns {boolean} true when some evidence line shows work on this project (not just self-description) */
export function hasContributionEvidence(evidence) {
  return evidence.some((line) => line.startsWith("GitHub:") || line.startsWith("Project text:"));
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
  const mention = mentionIn(project, member);
  if (mention) lines.push(`Project text: ${mention}`);
  if (member.bio) lines.push(`Self-described bio (not proof of contribution): ${member.bio}`);
  if (member.skills?.length) lines.push(`Self-listed skills: ${member.skills.join(", ")}.`);
  return lines;
}

// ---------------------------------------------------------------- private helpers
// One member's model failure must not discard the rest of the team.
async function safeAsk(qwen, project, member, evidence) {
  try {
    return await askModel(qwen, project, member, evidence);
  } catch {
    return unknownSummary(member, evidence);
  }
}

function mentionIn(project, member) {
  const first = member.name.split(/\s+/)[0];
  const text = `${project.description ?? ""} ${project.readme ?? ""}`;
  const sentence = text.split(/(?<=[.!?\n])\s+/).find((s) => first.length > 2 && s.includes(member.name));
  return sentence ? sentence.trim().slice(0, 240) : null;
}

async function askModel(qwen, project, member, evidence) {
  const system = [
    "Write 2-3 sentences about what this person contributed to the hackathon project.",
    "Use ONLY the evidence lines. Do not infer roles that the evidence does not show.",
    "Bio and skills lines are self-reported and are not contributions.",
    DATA_ONLY_RULE,
    "Commit counts show effort, not which feature they built; say so if that is all you know.",
    "Plain text, no JSON.",
  ].join(" ");
  const user = `Project: ${project.title}\n${project.tagline ?? ""}\nPerson: ${member.name}\nEvidence:\n${evidence.map((e, i) => fenceSource(`E${i + 1}`, e)).join("\n")}`;
  return (await qwen.chat([{ role: "system", content: system }, { role: "user", content: user }], { temperature: 0.1, maxTokens: 200 })).trim();
}

function unknownSummary(member, evidence) {
  const bio = evidence.find((e) => e.startsWith("Self-described bio"));
  const note = bio ? ` Self-described: ${bio.replace("Self-described bio (not proof of contribution): ", "")}` : "";
  return `Unknown: no evidence of ${member.name}'s specific contribution is available (no linked GitHub commits or project-text mention).${note}`;
}

function githubLogin(url) {
  const match = /github\.com\/([^/?#\s]+)/i.exec(url ?? "");
  return match ? match[1].toLowerCase() : null;
}
