// Owns the networking collections: their keys, display labels and the example
// sentences the classifier compares messages against. Plain data, so the data
// layer (pgvector) and the services (categorize, http) can share it without
// the data layer importing a service.

/** Every collection key, by name, so no module spells them out. */
export const COLLECTION_KEYS = Object.freeze({
  linkedin: "linkedin",
  mentorIntro: "mentor_intro",
  offer: "offer",
  sponsorOpportunity: "sponsor_opportunity",
  teammate: "teammate",
});

/** Collections whose posts count as outreach highlights on a person's page. */
export const OUTREACH_COLLECTION_KEYS = new Set([
  COLLECTION_KEYS.linkedin, COLLECTION_KEYS.mentorIntro, COLLECTION_KEYS.offer, COLLECTION_KEYS.sponsorOpportunity,
]);

/** Collection key -> { label, examples }. linkedin is rule-only (no examples). */
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
