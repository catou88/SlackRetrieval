// Find potential teammates: rank people from past hackathon projects by how
// well their skills, stack, bio and prizes match a free-text query.
import { listProjects, listPeople } from "../data/intelStore.js";

const MAX_RESULTS = 20;
const WINNER_BONUS = 1;
const SKILL_WEIGHT = 3;
const STACK_WEIGHT = 2;
const TEXT_WEIGHT = 1;

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} query  e.g. "python langgraph"
 * @param {{ limit?: number }} [opts]
 * @returns {{ id: number, name: string, score: number, why: string[], links: object, projects: object[] }[]}
 *   best matches first; people with no matching term are omitted
 */
export function findTeammates(db, query, { limit = MAX_RESULTS } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const stackByPerson = stackOf(db);
  return listPeople(db)
    .map((person) => scorePerson(person, terms, stackByPerson.get(person.id) ?? []))
    .filter((r) => r.matched > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ matched, ...result }) => result);
}

// ---------------------------------------------------------------- private helpers
function tokenize(text) {
  return [...new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 1))];
}

// Technologies used on each person's projects (built_with is per project, not per person).
function stackOf(db) {
  const byPerson = new Map();
  for (const project of listProjects(db)) {
    for (const member of project.members) {
      byPerson.set(member.id, [...(byPerson.get(member.id) ?? []), ...project.built_with]);
    }
  }
  return byPerson;
}

function scorePerson(person, terms, stack) {
  const skills = person.skills.map((s) => s.toLowerCase());
  const stackLower = stack.map((s) => String(s).toLowerCase());
  const text = `${person.bio ?? ""} ${person.projects.map((p) => p.title).join(" ")}`.toLowerCase();
  const why = [];
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const inSkills = skills.some((s) => s.includes(term));
    const inStack = stackLower.some((s) => s.includes(term));
    const inText = text.includes(term);
    if (!inSkills && !inStack && !inText) continue;
    matched++;
    score += (inSkills ? SKILL_WEIGHT : 0) + (inStack ? STACK_WEIGHT : 0) + (inText ? TEXT_WEIGHT : 0);
    why.push(`${term}: ${[inSkills && "skills", inStack && "project stack", inText && "bio/projects"].filter(Boolean).join(", ")}`);
  }
  const wins = person.projects.filter((p) => p.is_winner).length;
  if (matched && wins) { score += WINNER_BONUS; why.push(`${wins} winning project${wins > 1 ? "s" : ""}`); }
  return { id: person.id, name: person.name, score, matched, why, projects: person.projects,
    links: { devpost: person.devpost_url, github: person.github_url, linkedin: person.linkedin_url } };
}
