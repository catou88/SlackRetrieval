// Outreach draft templates (no API key needed). Pure: the caller passes the person, their role
// flags, the post being referenced and the user's own details.
//
// Tone rules from the outreach critique: you were a hacker writing to a mentor, judge or recruiter
// (not peers); refer to "the Cal Hacks Slack", not internal channel names; never greet a raw user
// id; never open with a referral request; recruiters get a role question, not mentorship.
import { greetingName } from "./people.js";

/** Ask options, in menu order. */
export const ASK_LABELS = {
  advice: "A quick question",
  resume: "Resume review",
  roles: "About open roles",
  coffee: "A 15-minute call",
  team: "Team up next time",
  stay: "Stay in touch",
  referral: "Referral (only if you know them)",
};

/** LinkedIn's connection-note limit for free accounts. */
export const LINKEDIN_NOTE_LIMIT = 200;

const RECRUITER_TITLE_RE = /recruit|talent|university|campus|early career|emerging/i;
const SLACK_PLACE = "the Cal Hacks Slack";
const OFFER_TYPE_ASKS = { resume: "resume", coffee: "coffee", interview: "advice", mentorship: "advice", advice: "advice", hiring: "roles", office_hours: "advice" };

/** Is this person someone who hires (sponsor rep or recruiting title)? */
export function isRecruiter(person, role) {
  return role.sponsor || RECRUITER_TITLE_RE.test(person.title || "");
}

/** The ask that fits who they are and what they offered. Never "referral" by default. */
export function defaultAsk({ person, role, offerType }) {
  if (isRecruiter(person, role) || offerType === "hiring") return "roles";
  if (OFFER_TYPE_ASKS[offerType]) return OFFER_TYPE_ASKS[offerType];
  if (role.mentor || role.judge || role.likely) return "advice";
  if (role.teammate || role.seeking) return "team";
  return "stay";
}

/**
 * Draft text.
 * @param {{person: object, role: object, highlight?: object, ask: string, myName?: string,
 *   project?: string, isNote?: boolean}} input  isNote → LinkedIn connection note (≤200 chars)
 */
export function draftText(input) {
  const context = { ...input, me: input.myName?.trim() || "[your name]", project: input.project?.trim() || "", greeting: greetingLine(input.person) };
  return input.isNote ? noteDraft(context) : fullDraft(context);
}

/** One-line summary for the "Reached out" note line. */
export function askSummary(ask) {
  return ASK_LABELS[ask] || ASK_LABELS.stay;
}

// ---------- private helpers ----------

function greetingLine(person) {
  const name = greetingName(person);
  return name ? `Hi ${name},` : "Hi there,";
}

function fullDraft(context) {
  const opener = `${context.greeting} ${openerSentence(context)} ${referenceSentence(context)}`.replace(/\s+$/, "");
  return `${opener}\n\n${askSentence(context)}\n\nThanks either way!\n${context.me}`;
}

function noteDraft(context) {
  const note = `${context.greeting} ${shortOpener(context)} ${shortAsk(context)} – ${context.me}`;
  if (note.length <= LINKEDIN_NOTE_LIMIT) return note;
  // A long name or org can push it over; the opener is the part that can go.
  return `${context.greeting} ${shortAsk(context)} – ${context.me}`;
}

function projectPhrase(context) {
  return context.project ? ` (we built ${context.project})` : " (we built [project])";
}

function openerSentence(context) {
  const { role, person } = context;
  if (isRecruiter(person, role)) return `I met the ${person.org || "your"} team at Cal Hacks 13.0${projectPhrase(context)}.`;
  if (role.judge) return `I was a hacker at Cal Hacks 13.0${projectPhrase(context)}. Thanks for judging!`;
  if (role.mentor || role.likely) return `I was a hacker at Cal Hacks 13.0${projectPhrase(context)}. Thanks for mentoring!`;
  if (role.organizer) return `I was a hacker at Cal Hacks 13.0${projectPhrase(context)}. Thanks for running it!`;
  return `We were both hacking at Cal Hacks 13.0${projectPhrase(context)}.`;
}

// Ties the draft to what they actually posted, in words the recipient will recognize.
function referenceSentence({ highlight }) {
  if (!highlight) return "";
  const kinds = new Set(highlight.collections.map((collection) => collection.key));
  const offerSentences = {
    resume: `Your offer in ${SLACK_PLACE} to look over resumes stuck with me.`,
    interview: `Your offer in ${SLACK_PLACE} to help with interview prep stuck with me.`,
    coffee: `You mentioned in ${SLACK_PLACE} that you were up for a chat.`,
    hiring: `I saw your post about open roles in ${SLACK_PLACE}.`,
    referral: `I saw your post about roles at your company in ${SLACK_PLACE}.`,
  };
  if (offerSentences[highlight.offer_type]) return offerSentences[highlight.offer_type];
  if (kinds.has("offer")) return `Your offer to help people in ${SLACK_PLACE} stuck with me.`;
  if (kinds.has("linkedin")) return `You shared your LinkedIn in ${SLACK_PLACE}, so I wanted to connect.`;
  if (kinds.has("mentor_intro")) return `I enjoyed your intro in ${SLACK_PLACE}.`;
  if (kinds.has("sponsor_opportunity")) return `I saw your post in ${SLACK_PLACE}.`;
  return "";
}

function askSentence({ ask, person, highlight }) {
  const org = person.org || "";
  const offeredResume = highlight?.offer_type === "resume";
  const sentences = {
    advice: "Would you be open to a quick question about [specific topic]? Something like: [one-sentence question].",
    resume: offeredResume
      ? "You offered to look at resumes. Could I send you mine? I'm targeting [role] for [season]."
      : "Would you be open to a quick look at my resume? I'm targeting [role] for [season].",
    roles: "I'm interested in [role]. Is there anything you'd recommend I highlight when applying, or someone on the team I should talk to?",
    coffee: `Would you be up for a 15-minute call in the next couple of weeks? I'd love to hear how you got into ${org ? `your work at ${org}` : "your field"}.`,
    team: "I'm putting a team together for the next hackathon. Would you want to build something together?",
    referral: `If it seems like a fit after a look at my background, would you be open to referring me for [role]${org ? ` at ${org}` : ""}? No worries at all if not.`,
    stay: "I'd love to stay in touch and follow what you're working on.",
  };
  return sentences[ask] || sentences.stay;
}

function shortOpener({ role, person }) {
  if (isRecruiter(person, role)) return person.org ? `I met the ${person.org} team at Cal Hacks 13.0.` : "I met your team at Cal Hacks 13.0.";
  if (role.judge) return "I was a hacker at Cal Hacks 13.0. Thanks for judging!";
  if (role.mentor || role.likely) return "I was a hacker at Cal Hacks 13.0. Thanks for mentoring!";
  if (role.organizer) return "Thanks for running Cal Hacks 13.0!";
  return "We were both at Cal Hacks 13.0.";
}

function shortAsk({ ask }) {
  const sentences = {
    advice: "Could I ask you a quick question about [topic]?",
    resume: "Could I send you my resume for a quick look?",
    roles: "I'm interested in [role] and would love to connect.",
    coffee: "Open to a 15-minute chat sometime?",
    team: "Up for teaming up at a future hackathon?",
    referral: "I'd love to connect about [role].",
    stay: "Would love to stay connected.",
  };
  return sentences[ask] || sentences.stay;
}
