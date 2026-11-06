// Builds a contact book from the stored messages: who each person is, their
// LinkedIn, whether they look like a mentor/judge/sponsor, and how you've
// interacted with them. Output: data/people.json
import { readJSON, writeJSON, readLines } from "./store.js";

const LINKEDIN_RE =
  /https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9_\-%.]+\/?/gi;
const LINKEDIN_BARE_RE = /(?<![\/\w])(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_\-%.]+\/?/gi;

export function extractUrls(text = "") {
  return [...text.matchAll(/<?(https?:\/\/[^\s|>]+)/g)].map((m) => m[1]);
}

export function extractLinkedIn(text = "") {
  const found = [
    ...(text.match(LINKEDIN_RE) || []),
    ...(text.match(LINKEDIN_BARE_RE) || []).map((u) => "https://" + u),
  ].map(normalizeLinkedIn);
  return [...new Set(found)];
}

function normalizeLinkedIn(u) {
  return u
    .replace(/^https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?/i, "https://www.")
    .replace(/[).,;]+$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

// Signals that someone is a mentor / judge / sponsor / organizer.
const ROLE_PATTERNS = {
  mentor: /\bmentor(s|ing)?\b/i,
  judge: /\bjudg(e|es|ing)\b/i,
  sponsor: /\bsponsor(s|ed|ing)?\b|\brecruit(er|ing)\b/i,
  organizer: /\borganiz(er|ers|ing)\b|\bstaff\b|\bcal ?hacks\b.*\bteam\b/i,
};
const SELF_INTRO_RE =
  /\b(?:(?:i['’]?m|i am|i['’]?ll be|we['’]?re)\s+(?:a|an|one of the|your|the)\s+(?:[\w-]+\s+){0,3}|(?:joining|here|attending)\s+(?:[\w.]+\s+){0,3}as\s+(?:a\s+|an\s+)?(?:[\w-]+\s+){0,2})(mentor|judge|sponsor|recruiter|organizer)s?\b/i;

export function buildPeople({ log = console.log } = {}) {
  const messages = readJSON("messages.json", []);
  const users = readJSON("users.json", {});
  const state = readJSON("state.json", {});
  const me = state.me;

  // Optional manual lists: one name or Slack ID per line.
  const manualMentors = new Set(readLines("mentors.txt").map((s) => s.toLowerCase()));

  const people = {};
  const get = (id) => {
    if (!people[id]) {
      const u = users[id] || {};
      people[id] = {
        id,
        name: u.name || id,
        handle: u.handle || "",
        title: u.title || "",
        email: u.email || "",
        timezone: u.timezone || "",
        pronouns: u.pronouns || "",
        profile_fields: u.profile_fields || [],
        linkedin: new Set(u.linkedin_from_profile || []),
        other_links: new Set(),
        roles: new Set(),
        role_evidence: [],
        channels: new Set(),
        message_count: 0,
        dm_count: 0,
        mentions_of_me: 0,
        first_seen: null,
        last_seen: null,
        is_me: id === me,
      };
    }
    return people[id];
  };

  for (const m of messages) {
    if (users[m.user_id]?.is_bot || m.user_id === "unknown") continue;
    const p = get(m.user_id);
    p.message_count++;
    p.channels.add(m.channel);
    if (m.channel_type === "im") p.dm_count++;
    if (!p.first_seen || m.date < p.first_seen) p.first_seen = m.date;
    if (!p.last_seen || m.date > p.last_seen) p.last_seen = m.date;
    const myName = users[me]?.name;
    if (myName && m.text.includes(`@${myName}`)) p.mentions_of_me++;

    // LinkedIn links a person posts are almost always their own (intros).
    // Links posted by someone else are attributed to whoever is @mentioned
    // right next to the link, if anyone.
    const links = extractLinkedIn(m.text);
    if (links.length) {
      const mentioned = Object.values(users).filter(
        (u) => u.name && u.id !== m.user_id && m.text.includes(`@${u.name}`)
      );
      const aboutSelf = /\b(my|me|i['’]?m|connect with me)\b/i.test(m.text);
      const owner = !aboutSelf && links.length === 1 && mentioned.length === 1 ? get(mentioned[0].id) : p;
      for (const li of links) owner.linkedin.add(li);
    }
    for (const url of m.raw_urls || []) {
      if (/linkedin\.com/i.test(url)) continue;
      if (/github\.com\/[^/\s]+\/?$|devpost\.com\/[^/\s]+\/?$|twitter\.com|x\.com\/|\.dev\b|portfolio/i.test(url))
        p.other_links.add(url);
    }

    if (SELF_INTRO_RE.test(m.text)) {
      const role = SELF_INTRO_RE.exec(m.text)[1].toLowerCase().replace("recruiter", "sponsor");
      p.roles.add(role);
      p.role_evidence.push(`said in ${m.channel}: "${m.text.slice(0, 140)}"`);
    }
    if (/mentor/i.test(m.channel) && m.channel_type !== "im") {
      // Answering in a mentor channel is a decent signal; asking isn't.
      if (!/\?\s*$/.test(m.text.trim())) {
        p.roles.add("mentor?");
      }
    }
  }

  // Make sure DM partners show up even if they never wrote back.
  for (const m of messages) if (m.dm_with) get(m.dm_with);

  // Sponsor company names, from channel names like #spons-capital-one / #cohost-anthropic.
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sponsorOrgs = new Map();
  for (const m of messages) {
    const hit = m.channel.match(/^#(?:spons|sponsor|cohost)-(.+)$/i);
    if (hit) sponsorOrgs.set(slug(hit[1]), hit[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  for (const p of Object.values(people)) {
    // Workspace name tags are the strongest signal: "Alex [Judge] [Mentor]",
    // "Sam [ACME]", "Jordan Lee (Acme Corp)", "Riley [Cal Hacks]".
    const u = users[p.id] || {};
    const tags = [u.name, u.display_name]
      .filter(Boolean)
      .flatMap((n) => [...n.matchAll(/[\[(]([^\])]{2,40})[\])]/g)].map((t) => t[1].trim()));
    for (const tag of new Set(tags)) {
      const t = tag.toLowerCase();
      if (/mentor/.test(t)) p.roles.add("mentor");
      if (/judge/.test(t)) p.roles.add("judge");
      if (/cal ?hacks|volunteer|\bmlh\b|organi[sz]er|staff|director/.test(t)) p.roles.add("organizer");
      const org = [...sponsorOrgs.entries()].find(([s]) => s.length > 2 && (slug(tag).includes(s) || s.includes(slug(tag))) && slug(tag).length > 2);
      if (org) {
        p.roles.add("sponsor");
        p.org = org[1];
      }
      if (/mentor|judge|cal ?hacks|volunteer|mlh/.test(t) || org) p.role_evidence.push(`name tag [${tag}]`);
    }

    const titleBlob = [p.title, ...p.profile_fields.map((f) => `${f.label} ${f.value}`)].join(" ");
    for (const [role, re] of Object.entries(ROLE_PATTERNS)) {
      if (re.test(titleBlob)) {
        p.roles.add(role);
        p.role_evidence.push(`profile: "${p.title}"`);
      }
    }
    if (manualMentors.has(p.name.toLowerCase()) || manualMentors.has(p.id.toLowerCase())) {
      p.roles.add("mentor");
      p.role_evidence.push("listed in data/mentors.txt");
    }
    if (p.roles.has("mentor")) p.roles.delete("mentor?");
  }

  const out = {};
  for (const p of Object.values(people)) {
    out[p.id] = {
      ...p,
      linkedin: [...p.linkedin],
      other_links: [...p.other_links],
      roles: [...p.roles],
      role_evidence: [...new Set(p.role_evidence)].slice(0, 5),
      channels: [...p.channels],
      // Confirmed only (name tag, title, self-intro, or mentors.txt). "mentor?" = answered in a mentor channel.
      is_mentor: p.roles.has("mentor") || p.roles.has("judge"),
      likely_mentor: p.roles.has("mentor?") && !p.roles.has("mentor") && !p.roles.has("judge"),
      is_sponsor: p.roles.has("sponsor"),
      is_organizer: p.roles.has("organizer"),
      org: p.org || "",
    };
  }
  writeJSON("people.json", out);
  const list = Object.values(out);
  log(
    `Built ${list.length} contacts — ${list.filter((p) => p.linkedin.length).length} with LinkedIn, ` +
      `${list.filter((p) => p.is_mentor).length} mentors/judges.`
  );
  return out;
}

// Fuzzy lookup by name, handle, or ID.
export function findPerson(people, query) {
  const q = query.toLowerCase().replace(/^@/, "");
  const list = Object.values(people);
  return (
    list.find((p) => p.id.toLowerCase() === q) ||
    list.find((p) => p.handle.toLowerCase() === q) ||
    list.find((p) => p.name.toLowerCase() === q) ||
    list.find((p) => p.name.toLowerCase().includes(q)) ||
    list.find((p) => p.handle.toLowerCase().includes(q))
  );
}
