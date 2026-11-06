// Picks out only the messages worth keeping for networking:
//   linkedin      – someone sharing their LinkedIn / contact to connect
//   mentor_intro  – a mentor, judge, or sponsor introducing themselves
//   offer         – someone offering help: advice, mentorship, resume review,
//                   referrals, coffee chats, "DM me"
//   sponsor_opportunity – sponsor jobs, events, credits, sponsor info
//   teammate      – people looking for teams / to hack together
// Exact signals use rules; the fuzzier ones use vector similarity to example
// sentences. Everything runs locally. Output: data/categories.json
import { readJSON, writeJSON } from "./store.js";
import { embed, loadIndex } from "./vectors.js";

export const COLLECTIONS = {
  linkedin: { label: "LinkedIn shares (to connect)", examples: [] },
  mentor_intro: {
    label: "Mentor & judge introductions",
    examples: [
      "Hi everyone, I'm a mentor for this hackathon, I'm a senior software engineer at Google working on infrastructure",
      "Hey hackers! I'm one of the judges, I work in product at a startup and I'm excited to see what you build",
      "I'm a mentor from Stripe, ask me anything about payments, APIs, and backend systems",
    ],
  },
  offer: {
    label: "Offers: advice, mentorship, resume reviews, referrals",
    examples: [
      "Happy to review resumes, feel free to DM me yours",
      "If anyone wants career advice or a coffee chat about breaking into tech, reach out to me",
      "I can refer a few people for internships at my company, send me your LinkedIn",
      "Feel free to ping me if you need help with machine learning or want feedback on your project",
      "I'm offering mock interviews and mentorship after the hackathon, connect with me on LinkedIn",
    ],
  },
  sponsor_opportunity: {
    label: "Sponsor jobs, events & opportunities",
    examples: [
      "We're hiring software engineering interns and new grads, apply at the link and mention Cal Hacks",
      "Join our upcoming event next month in San Francisco, RSVP here",
      "All participants get free API credits, sign up with this link to keep building after the hackathon",
      "Our fellowship and accelerator applications are open, we'd love to see your project",
      "Fill out this form to get fast-tracked to an interview with our recruiting team",
    ],
  },
  teammate: {
    label: "Teammates & people to hack with",
    examples: [
      "Looking for teammates! I'm a full-stack developer experienced with React and Python",
      "Solo hacker here, looking to join a team, I do machine learning and backend",
      "Our team of two is looking for a designer and a hardware person",
      "Anyone want to team up for future hackathons? Here's my LinkedIn and GitHub",
    ],
  },
};

const LINKEDIN_RE = /linkedin\.com\/(in|pub)\//i;
const SELF_MENTOR_RE =
  /\b(?:(?:i['’]?m|i am|i['’]?ll be)\s+(?:a|an|one of the|your|the)\s+(?:[\w-]+\s+){0,3}|(?:joining|here|attending)\s+(?:[\w.]+\s+){0,3}as\s+(?:a\s+|an\s+)?(?:[\w-]+\s+){0,2})(mentor|judge|recruiter)s?\b/i;
const OFFER_RE =
  /\b(review(ing)? (your )?resumes?|resume review|send (me )?your resume|dm me|reach out|happy to (help|chat|connect|review|mentor)|coffee chat|refer(ral|rals)?|mock interviews?|office hours|mentorship)\b/i;

const HACKER_RE =
  /\b(table ?#?\d+[a-z]?|at \d{2,3}[a-z]?\b|our (project|team|hack|demo|submission|table)|we (built|made|are building|'re building)|check out our|my team(mate)?s?|come (check|see|visit)|i (built|developed|made))/i;

const THRESHOLD = Number(process.env.CATEGORY_THRESHOLD) || 0.45;

export async function categorize({ log = console.log } = {}) {
  const messages = readJSON("messages.json", []);
  const people = readJSON("people.json", {});
  const index = loadIndex();
  const pos = new Map(index.ids.map((id, i) => [id, i]));
  const { flat, dims } = index;

  const protos = {};
  for (const [key, c] of Object.entries(COLLECTIONS)) if (c.examples.length) protos[key] = await embed(c.examples);
  const sim = (i, vecs) => {
    let best = -1;
    for (const v of vecs) {
      let s = 0;
      for (let d = 0; d < dims; d++) s += flat[i * dims + d] * v[d];
      if (s > best) best = s;
    }
    return best;
  };

  // Who speaks for a sponsor: posts announcements in #spons-*/#cohost-* channels
  // and never pitches their own hack ("our project at table 74").
  const sponsorChan = (ch) => /spons|sponsor|cohost|partner/i.test(ch);
  const repScore = {};
  for (const m of messages) {
    if (!sponsorChan(m.channel) || m.raw?.subtype) continue;
    if (HACKER_RE.test(m.text)) repScore[m.user_id] = -99;
    else if (!m.thread_ts && m.text.length > 60 && !/\?\s*$/.test(m.text.trim()))
      repScore[m.user_id] = (repScore[m.user_id] || 0) + 1;
  }
  const isRep = (uid) => people[uid]?.roles?.includes("sponsor") || (repScore[uid] || 0) >= 2;

  const out = {};
  const counts = Object.fromEntries(Object.keys(COLLECTIONS).map((k) => [k, 0]));
  for (const m of messages) {
    if (m.text.trim().length < 12 || m.raw?.subtype) continue; // skip joins/renames/bot notices
    const cats = new Set();
    const author = people[m.user_id];
    const i = pos.get(m.id);

    const isQuestion = /\?\s*$/.test(m.text.trim()) || /\b(can|could) (someone|anyone)\b/i.test(m.text);
    if (LINKEDIN_RE.test(m.text)) cats.add("linkedin");

    const mentorish = author?.is_mentor || SELF_MENTOR_RE.test(m.text);
    const long = m.text.length > 80; // semantic matches need a real sentence, not "got it resolved"
    if (mentorish && (SELF_MENTOR_RE.test(m.text) || (long && !m.thread_ts && i !== undefined && sim(i, protos.mentor_intro) >= THRESHOLD)))
      cats.add("mentor_intro");

    // Offers need a concrete signal (keyword) or a strong semantic match, and
    // must not be a question ("can anyone review my resume?").
    // Offers come from mentors, judges, sponsors, organizers — a hacker saying
    // "DM me" while looking for a team is a teammate post, not an offer.
    const helper = author?.is_mentor || author?.is_sponsor || author?.is_organizer;
    if (!isQuestion && !HACKER_RE.test(m.text)) {
      const score = i !== undefined ? sim(i, protos.offer) : 0;
      const teamPost = /team|intro|first-time/i.test(m.channel);
      if (helper && ((OFFER_RE.test(m.text) && score >= THRESHOLD - 0.1) || (long && score >= THRESHOLD + 0.05))) cats.add("offer");
      else if (!helper && !teamPost && OFFER_RE.test(m.text) && score >= THRESHOLD + 0.12) cats.add("offer");
    }

    // Sponsor info: announcements by sponsor reps in their channels, or strong
    // job/event/credit matches anywhere — never hackers pitching their project.
    const oppScore = i !== undefined ? sim(i, protos.sponsor_opportunity) : 0;
    const rep = isRep(m.user_id);
    if (!isQuestion && !HACKER_RE.test(m.text) &&
        ((rep && sponsorChan(m.channel) && m.text.length > 60) ||
         (long && sponsorChan(m.channel) && oppScore >= THRESHOLD + 0.05) ||
         (long && rep && oppScore >= THRESHOLD)))
      cats.add("sponsor_opportunity");

    // Teammates: team-formation posts and hacker intros (skills + "looking for").
    const teamChannel = /team|intro|looking/i.test(m.channel);
    const teamScore = i !== undefined ? sim(i, protos.teammate) : 0;
    const sponsorAuthor = isRep(m.user_id);
    const noisyChannel = /ask|announce|general|director|spons|cohost/i.test(m.channel);
    if (!author?.is_mentor && !sponsorAuthor && m.text.length > 60 && (!noisyChannel || teamScore >= THRESHOLD + 0.08) &&
        (teamScore >= THRESHOLD || (teamChannel && /looking for|team ?mates?|join (a|your) team|team up/i.test(m.text))))
      cats.add("teammate");

    if (cats.size) {
      out[m.id] = [...cats];
      for (const c of cats) counts[c]++;
    }
  }
  writeJSON("categories.json", out);
  log(
    `Kept ${Object.keys(out).length} of ${messages.length} messages — ` +
      Object.entries(counts).map(([k, n]) => `${COLLECTIONS[k].label}: ${n}`).join(" · ")
  );
  return out;
}
