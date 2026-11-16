// Owns the contact book (data/people.json), built from the stored messages:
// who each person is, their LinkedIn and other links, whether they look like
// a mentor/judge/sponsor/organizer (and the evidence), and how you've
// interacted with them. Also owns looking a person up by a free-text query.
import { readJSON, writeJSON, readLines, FILES } from "../data/jsonStore.js";
import {
  extractLinkedIn, selfIntroRole, NAME_TAG_RE, SPONSOR_ORG_CHANNEL_RE,
} from "../lib/patterns.js";

// Signals in a profile title / custom fields that someone has a role.
const PROFILE_ROLE_PATTERNS = {
  mentor: /\bmentor(s|ing)?\b/i,
  judge: /\bjudg(e|es|ing)\b/i,
  sponsor: /\bsponsor(s|ed|ing)?\b|\brecruit(er|ing)\b/i,
  organizer: /\borganiz(er|ers|ing)\b|\bstaff\b|\bcal ?hacks\b.*\bteam\b/i,
};
// "my LinkedIn", "connect with me": a link that is the poster's own.
const ABOUT_SELF_RE = /\b(my|me|i['’]?m|connect with me)\b/i;
const LINKEDIN_HOST_RE = /linkedin\.com/i;
// Personal pages worth keeping next to LinkedIn: GitHub/Devpost profiles, Twitter/X, portfolios.
const PERSONAL_LINK_RE = /github\.com\/[^/\s]+\/?$|devpost\.com\/[^/\s]+\/?$|twitter\.com|x\.com\/|\.dev\b|portfolio/i;
const MENTOR_CHANNEL_RE = /mentor/i;
// Deliberately narrower than patterns.isQuestion: only a trailing "?" disqualifies an answer.
const ENDS_WITH_QUESTION_RE = /\?\s*$/;
// Name-tag vocabulary (matched against the lowercased tag).
const MENTOR_TAG_RE = /mentor/;
const JUDGE_TAG_RE = /judge/;
const ORGANIZER_TAG_RE = /cal ?hacks|volunteer|\bmlh\b|organi[sz]er|staff|director/;
const EVIDENCE_TAG_RE = /mentor|judge|cal ?hacks|volunteer|mlh/;
const MIN_ORG_SLUG_CHARS = 3; // "ai" or "x" would match half the tags
const SELF_INTRO_EVIDENCE_CHARS = 140;
const MAX_ROLE_EVIDENCE = 5;
const UNKNOWN_AUTHOR = "unknown";

/**
 * Rebuild data/people.json from messages.json, users.json, state.json and the
 * optional data/mentors.txt (one name or Slack ID per line).
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Record<string, object>} the contact book, by person id
 */
export function buildContactBook({ log = console.log } = {}) {
  const messages = readJSON(FILES.messages, []);
  const users = readJSON(FILES.users, {});
  const me = readJSON(FILES.state, {}).me;
  const manualMentors = new Set(readLines(FILES.mentorList).map((line) => line.toLowerCase()));

  const contacts = new ContactDraftSet(users, me);
  for (const message of messages) {
    if (users[message.user_id]?.is_bot || message.user_id === UNKNOWN_AUTHOR) continue;
    absorbMessage(contacts, message, users, me);
  }
  // Make sure DM partners show up even if they never wrote back.
  for (const message of messages) if (message.dm_with) contacts.get(message.dm_with);

  const sponsorOrgs = findSponsorOrgs(messages);
  for (const contact of contacts.all()) {
    applyNameTags(contact, users[contact.id] || {}, sponsorOrgs);
    applyProfileRoles(contact);
    applyManualMentorList(contact, manualMentors);
    if (contact.roles.has("mentor")) contact.roles.delete("mentor?");
  }

  const book = {};
  for (const contact of contacts.all()) book[contact.id] = toStoredContact(contact);
  writeJSON(FILES.people, book);
  logSummary(book, log);
  return book;
}

/**
 * Fuzzy lookup, in priority order: id, handle, exact name, name substring,
 * handle substring. Case-insensitive; a leading "@" is ignored.
 * @param {Record<string, object>} people  the contact book
 * @param {string} query
 * @returns {object | undefined}
 */
export function findPersonByQuery(people, query) {
  const needle = query.toLowerCase().replace(/^@/, "");
  const list = Object.values(people);
  return (
    list.find((person) => person.id.toLowerCase() === needle) ||
    list.find((person) => person.handle.toLowerCase() === needle) ||
    list.find((person) => person.name.toLowerCase() === needle) ||
    list.find((person) => person.name.toLowerCase().includes(needle)) ||
    list.find((person) => person.handle.toLowerCase().includes(needle))
  );
}

// ---------------------------------------------------------------- private helpers
// Working contacts (with Sets) in first-seen order, which is people.json's key order.
class ContactDraftSet {
  constructor(users, me) {
    this.users = users;
    this.me = me;
    this.byId = {};
  }

  /** @returns {object} the draft for `id`, created from the user directory on first use */
  get(id) {
    this.byId[id] ??= newContactDraft(id, this.users[id] || {}, this.me);
    return this.byId[id];
  }

  all() {
    return Object.values(this.byId);
  }
}

function newContactDraft(id, user, me) {
  return {
    id,
    name: user.name || id,
    handle: user.handle || "",
    title: user.title || "",
    email: user.email || "",
    timezone: user.timezone || "",
    pronouns: user.pronouns || "",
    profile_fields: user.profile_fields || [],
    linkedin: new Set(user.linkedin_from_profile || []),
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

function absorbMessage(contacts, message, users, me) {
  const author = contacts.get(message.user_id);
  countActivity(author, message, users[me]?.name);
  attributeLinkedIn(contacts, author, message, users);
  collectPersonalLinks(author, message);
  applySelfIntro(author, message);
  applyMentorChannelAnswer(author, message);
}

function countActivity(contact, message, myName) {
  contact.message_count++;
  contact.channels.add(message.channel);
  if (message.channel_type === "im") contact.dm_count++;
  if (!contact.first_seen || message.date < contact.first_seen) contact.first_seen = message.date;
  if (!contact.last_seen || message.date > contact.last_seen) contact.last_seen = message.date;
  if (myName && message.text.includes(`@${myName}`)) contact.mentions_of_me++;
}

// LinkedIn links a person posts are almost always their own (intros). A single
// link posted by someone else, not about themselves, belongs to whoever is
// the only person @mentioned in the message, if anyone.
function attributeLinkedIn(contacts, author, message, users) {
  const links = extractLinkedIn(message.text);
  if (!links.length) return;
  const mentioned = Object.values(users).filter(
    (user) => user.name && user.id !== message.user_id && message.text.includes(`@${user.name}`)
  );
  const isAboutSelf = ABOUT_SELF_RE.test(message.text);
  const isAboutOther = !isAboutSelf && links.length === 1 && mentioned.length === 1;
  const owner = isAboutOther ? contacts.get(mentioned[0].id) : author;
  for (const link of links) owner.linkedin.add(link);
}

function collectPersonalLinks(contact, message) {
  for (const url of message.raw_urls || []) {
    if (LINKEDIN_HOST_RE.test(url)) continue;
    if (PERSONAL_LINK_RE.test(url)) contact.other_links.add(url);
  }
}

function applySelfIntro(contact, message) {
  const role = selfIntroRole(message.text);
  if (!role) return;
  contact.roles.add(role.replace("recruiter", "sponsor"));
  contact.role_evidence.push(`said in ${message.channel}: "${message.text.slice(0, SELF_INTRO_EVIDENCE_CHARS)}"`);
}

// Answering in a mentor channel is a decent signal; asking isn't.
function applyMentorChannelAnswer(contact, message) {
  if (!MENTOR_CHANNEL_RE.test(message.channel) || message.channel_type === "im") return;
  if (!ENDS_WITH_QUESTION_RE.test(message.text.trim())) contact.roles.add("mentor?");
}

/** @returns {Map<string, string>} company slug -> display name, from #spons-capital-one / #cohost-anthropic */
function findSponsorOrgs(messages) {
  const sponsorOrgs = new Map();
  for (const message of messages) {
    const hit = message.channel.match(SPONSOR_ORG_CHANNEL_RE);
    if (hit) sponsorOrgs.set(slugOf(hit[1]), titleCase(hit[1].replace(/-/g, " ")));
  }
  return sponsorOrgs;
}

function slugOf(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function titleCase(text) {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Workspace name tags are the strongest signal: "Alex [Judge] [Mentor]",
// "Sam [ACME]", "Jordan Lee (Acme Corp)", "Riley [Cal Hacks]".
function applyNameTags(contact, user, sponsorOrgs) {
  const tags = [user.name, user.display_name]
    .filter(Boolean)
    .flatMap((name) => [...name.matchAll(NAME_TAG_RE)].map((match) => match[1].trim()));
  for (const tag of new Set(tags)) {
    const lowerTag = tag.toLowerCase();
    if (MENTOR_TAG_RE.test(lowerTag)) contact.roles.add("mentor");
    if (JUDGE_TAG_RE.test(lowerTag)) contact.roles.add("judge");
    if (ORGANIZER_TAG_RE.test(lowerTag)) contact.roles.add("organizer");
    const orgName = sponsorOrgForTag(tag, sponsorOrgs);
    if (orgName) {
      contact.roles.add("sponsor");
      contact.org = orgName;
    }
    if (EVIDENCE_TAG_RE.test(lowerTag) || orgName) contact.role_evidence.push(`name tag [${tag}]`);
  }
}

/** @returns {string | undefined} the sponsor whose slug and the tag's slug contain one another */
function sponsorOrgForTag(tag, sponsorOrgs) {
  const tagSlug = slugOf(tag);
  if (tagSlug.length < MIN_ORG_SLUG_CHARS) return undefined;
  for (const [orgSlug, orgName] of sponsorOrgs) {
    if (orgSlug.length >= MIN_ORG_SLUG_CHARS && (tagSlug.includes(orgSlug) || orgSlug.includes(tagSlug))) return orgName;
  }
  return undefined;
}

function applyProfileRoles(contact) {
  const titleBlob = [contact.title, ...contact.profile_fields.map((field) => `${field.label} ${field.value}`)].join(" ");
  for (const [role, pattern] of Object.entries(PROFILE_ROLE_PATTERNS)) {
    if (!pattern.test(titleBlob)) continue;
    contact.roles.add(role);
    contact.role_evidence.push(`profile: "${contact.title}"`);
  }
}

function applyManualMentorList(contact, manualMentors) {
  if (!manualMentors.has(contact.name.toLowerCase()) && !manualMentors.has(contact.id.toLowerCase())) return;
  contact.roles.add("mentor");
  contact.role_evidence.push("listed in data/mentors.txt");
}

// Sets -> arrays, plus the derived flags. `org` keeps its key position when a
// name tag set it earlier (the spread), so people.json's layout is stable.
function toStoredContact(contact) {
  const { roles } = contact;
  return {
    ...contact,
    linkedin: [...contact.linkedin],
    other_links: [...contact.other_links],
    roles: [...roles],
    role_evidence: [...new Set(contact.role_evidence)].slice(0, MAX_ROLE_EVIDENCE),
    channels: [...contact.channels],
    // Confirmed only (name tag, title, self-intro, or mentors.txt). "mentor?" = answered in a mentor channel.
    is_mentor: roles.has("mentor") || roles.has("judge"),
    likely_mentor: roles.has("mentor?") && !roles.has("mentor") && !roles.has("judge"),
    is_sponsor: roles.has("sponsor"),
    is_organizer: roles.has("organizer"),
    org: contact.org || "",
  };
}

function logSummary(book, log) {
  const contacts = Object.values(book);
  const withLinkedIn = contacts.filter((contact) => contact.linkedin.length).length;
  const mentorCount = contacts.filter((contact) => contact.is_mentor).length;
  log(`Built ${contacts.length} contacts — ${withLinkedIn} with LinkedIn, ${mentorCount} mentors/judges.`);
}
