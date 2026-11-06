// Retrieval + generation: find the most relevant Slack messages with vector
// similarity, then have Claude answer using only that context.
import Anthropic from "@anthropic-ai/sdk";
import { readJSON } from "./store.js";
import { search, loadIndex } from "./vectors.js";
import { findPerson } from "./people.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

function loadAll() {
  const messages = readJSON("messages.json", []);
  return {
    messages,
    byId: new Map(messages.map((m) => [m.id, m])),
    people: readJSON("people.json", {}),
    state: readJSON("state.json", {}),
  };
}

function fmtMsg(m) {
  return `[${m.date.slice(0, 16).replace("T", " ")}] ${m.channel} — ${m.user_name}: ${m.text}`;
}

function fmtPerson(p) {
  const lines = [
    `Name: ${p.name}${p.handle ? ` (@${p.handle})` : ""}`,
    p.title && `Title: ${p.title}`,
    p.pronouns && `Pronouns: ${p.pronouns}`,
    p.roles.length && `Roles: ${p.roles.join(", ")}`,
    p.linkedin.length && `LinkedIn: ${p.linkedin.join(", ")}`,
    p.other_links.length && `Other links: ${p.other_links.join(", ")}`,
    p.email && `Email: ${p.email}`,
    ...p.profile_fields.filter((f) => f.value).map((f) => `${f.label || "Profile"}: ${f.value}`),
    `Active in: ${p.channels.slice(0, 10).join(", ")}`,
    `Messages: ${p.message_count} (DMs: ${p.dm_count}), last seen ${p.last_seen?.slice(0, 10)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function callClaude(system, user) {
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // If a safety classifier declines, the API retries on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") {
    return `(Claude declined to answer: ${res.stop_details?.explanation || "no details"})`;
  }
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

const SYSTEM = `You help the user remember and follow up with people they met in a hackathon Slack workspace.
Answer only from the Slack messages and contact records provided. Cite who said what and in which channel.
If the context doesn't contain the answer, say so plainly instead of guessing. Never invent LinkedIn URLs.`;

// Free-form question over all messages.
export async function ask(question, { k = 25, person, mentorsOnly = false } = {}) {
  const { byId, people } = loadAll();
  const target = person ? findPerson(people, person) : null;
  if (person && !target) throw new Error(`No one matching "${person}".`);
  const filter = (id) => {
    const m = byId.get(id);
    if (!m) return false;
    if (target && m.user_id !== target.id && m.dm_with !== target.id && !m.text.includes(`@${target.name}`))
      return false;
    if (mentorsOnly && !people[m.user_id]?.is_mentor) return false;
    return true;
  };
  const hits = await search(question, { k, filter });
  const context = hits.map((h) => fmtMsg(byId.get(h.id))).join("\n");
  const involved = [...new Set(hits.map((h) => byId.get(h.id).user_id))]
    .map((id) => people[id])
    .filter(Boolean);
  const contacts = involved.map(fmtPerson).join("\n\n");
  const answer = await callClaude(
    SYSTEM,
    `<contacts>\n${contacts}\n</contacts>\n\n<slack_messages>\n${context}\n</slack_messages>\n\nQuestion: ${question}`
  );
  return { answer, hits: hits.map((h) => ({ ...h, message: byId.get(h.id) })) };
}

// Everything you need before reaching out to one person: who they are, what
// you talked about, open threads, and a draft message.
export async function brief(personQuery, { goal = "" } = {}) {
  const { messages, byId, people, state } = loadAll();
  const p = findPerson(people, personQuery);
  if (!p) throw new Error(`No one matching "${personQuery}". Try \`npm run people\`.`);
  const me = people[state.me];

  // 1) Every direct interaction (DMs + threads you were both in), verbatim.
  const threadKey = (m) => `${m.channel_id}:${m.thread_ts || m.ts}`;
  const myThreads = new Set(messages.filter((m) => m.user_id === state.me).map(threadKey));
  const theirThreads = new Set(messages.filter((m) => m.user_id === p.id).map(threadKey));
  const direct = messages.filter(
    (m) =>
      m.dm_with === p.id ||
      (myThreads.has(threadKey(m)) && theirThreads.has(threadKey(m))) ||
      (m.user_id === state.me && m.text.includes(`@${p.name}`)) ||
      (m.user_id === p.id && me && m.text.includes(`@${me.name}`))
  );

  // 2) Their most relevant public messages (expertise, intro, advice) via vectors.
  const directIds = new Set(direct.map((m) => m.id));
  const index = loadIndex();
  const query = `${p.name} introduction background expertise advice offer help ${goal}`;
  const theirs = await search(query, {
    k: 30,
    index,
    filter: (id) => !directIds.has(id) && byId.get(id)?.user_id === p.id,
  });
  // 3) What others said about them.
  const about = await search(`${p.name} ${goal}`, {
    k: 10,
    index,
    filter: (id) => {
      const m = byId.get(id);
      return m && !directIds.has(id) && m.user_id !== p.id && m.text.includes(p.name.split(" ")[0]);
    },
  });

  const section = (title, list) =>
    list.length ? `<${title}>\n${list.map(fmtMsg).join("\n")}\n</${title}>` : `<${title}>(none)</${title}>`;
  const context = [
    `<contact>\n${fmtPerson(p)}\n${p.role_evidence.length ? "Role evidence: " + p.role_evidence.join("; ") : ""}\n</contact>`,
    me ? `<me>${me.name}${me.title ? ", " + me.title : ""}</me>` : "",
    section("direct_conversations", direct.slice(-150)),
    section("their_messages", theirs.map((h) => byId.get(h.id))),
    section("others_about_them", about.map((h) => byId.get(h.id))),
  ].join("\n\n");

  const answer = await callClaude(
    SYSTEM,
    `${context}

I want to reconnect with ${p.name}${goal ? ` — my goal: ${goal}` : ""}. Write me a brief with:
1. **Who they are** — role, company, expertise, LinkedIn (only if present above).
2. **How we know each other** — what we actually discussed, with dates.
3. **What they helped with / offered** — advice, intros, follow-ups they or I promised.
4. **What to tell them** — 3–5 concrete updates or talking points worth sharing, based on what we discussed.
5. **Draft message** — a short, warm LinkedIn/Slack message I could send now.`
  );
  return { person: p, answer, directCount: direct.length };
}
