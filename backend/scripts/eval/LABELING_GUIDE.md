# Labeling guide — networking message classifier

Gold labels for `data/eval/heldout.json`. Label each message from its **text,
channel, author, and author roles only**. Do not look at the classifier's
`prediction` field (the review tool hides it by default) — the point is an
independent judgment.

A message can have **several labels**. If none apply, the label is `none`
(and nothing else). The question behind every class is: *would the user want
this message in that collection when looking for people to network with?*

## Classes

### `linkedin` — sharing a LinkedIn profile to connect
- **Yes:** the message contains a LinkedIn profile link (`linkedin.com/in/...`
  or `/pub/...`) belonging to the author or someone they are introducing, or
  the author explicitly invites people to connect on LinkedIn ("add me on
  LinkedIn, I'm Jane Doe").
- **No:** a LinkedIn *company* page, post or job link (`linkedin.com/company`,
  `/posts`, `/jobs`) — that may be `sponsor_opportunity`. Asking "what's your
  LinkedIn?" without sharing one. Talking about LinkedIn ("I saw it on
  LinkedIn").
- A profile link inside a team-formation intro is `linkedin` **and** `teammate`.

### `mentor_intro` — a mentor, judge, or sponsor rep introducing themselves
- **Yes:** the author says who they are in a mentor/judge/sponsor/recruiter
  capacity: "Hi, I'm a mentor, SWE at Google, ask me about infra"; "I'm one of
  the judges"; "I'm X from <sponsor>, here to help with our API". Self
  introductions by people whose roles say mentor/judge/sponsor, when the text
  is an introduction (name, background, what they can help with).
- **No:** a hacker introducing themselves (that is `teammate` if they are
  looking for people, else `none`). A mentor answering a technical question
  without introducing themselves. Organizers making logistics announcements.
  A hacker saying "I'm looking for a mentor".
- Often co-occurs with `offer` ("I'm a mentor … DM me if you want resume help").

### `offer` — the author offers help to others
- **Yes:** the author offers advice, mentorship, resume reviews, referrals,
  mock interviews, office hours, coffee chats, career chats, project feedback,
  or technical help to anyone who asks: "happy to review resumes", "DM me if
  you're stuck on ML", "I can refer people to my company", "come find me at
  the Stripe table for help". Mentors/sponsors saying "feel free to reach out /
  DM me with questions" count.
- **No:** a hacker *asking* for help ("can someone review my resume?",
  "anyone know how to fix X?"). A hacker saying "DM me" to find teammates —
  that is `teammate`, not `offer`. Organizers answering logistics questions
  ("the bus leaves at 5") — that's support, not a networking offer. A one-off
  answer in a thread ("try restarting the server") is not an offer of ongoing
  help unless it invites further contact.
- Sponsor reps offering help with their API in their sponsor channel
  ("ping me if you have questions about our SDK") count as `offer` (and the
  announcement around it may also be `sponsor_opportunity`).

### `sponsor_opportunity` — sponsor jobs, events, credits, prizes, programs
- **Yes:** concrete opportunities from sponsors/companies/organizers that a
  hacker could act on: hiring/internship/new-grad postings, recruiting forms,
  fast-track interviews, events/workshops/talks/mixers, free credits or API
  keys, fellowship/accelerator applications, sponsor prize track details,
  swag/raffle with a call to action. Usually posted by a sponsor rep, often in
  `#spons-*` / `#cohost-*` / `#partner-*` / `#2-opportunities`.
- **No:** hackers pitching their project ("come see our demo at table 74"),
  hackers asking about a prize ("is the prize per person?"), generic logistics
  from organizers (food, wifi, buses, check-in) — unless they announce a
  sponsor event/workshop. A short reply in a thread with no actionable
  opportunity ("yes, you can use it").
- Questions *about* the opportunity are `none` unless they also contain one.

### `teammate` — looking for teammates / people to hack with
- **Yes:** looking for a team or team members, offering to join a team,
  "our team of 2 needs a designer", hacker intros with skills + intent to team
  up, "anyone want to team up for future hackathons", "DM me if you want to
  team up".
- **No:** mentors/sponsors (they are not hacking). Hackers introducing
  themselves with no teaming intent ("hi I'm from UCLA, excited to be here!")
  — `none`. Logistics questions about team size rules ("can teams be 5
  people?") — `none`. Showing off a finished project — `none`.
- A reply in a team-formation thread like "interested! DM'd you" counts as
  `teammate` if it clearly expresses wanting to join that team.

## General rules
- Judge **intent of the author**, not keywords. "Mentor" in the text doesn't
  make it `mentor_intro`; "team" doesn't make it `teammate`.
- Thread replies are labeled on their own text (you don't see the parent).
  If the reply alone is ambiguous ("sure, DM me"), lean `none` and mark
  `unsure`.
- Author roles are evidence, not proof: a person tagged mentor can still post
  a question; a person with no role can still be a sponsor rep (look at the
  channel and wording: "we at <company>", "our API").
- `none` is exclusive: never combine `none` with a class.
- Confidence: `sure` when a reasonable second labeler would agree; `unsure`
  when it's a judgment call — those get reviewed first.
- Rationale: one line, naming the deciding evidence ("mentor self-intro + DM
  me offer", "hacker asking for help, not an offer").

## Output schema
`data/eval/labels.claude.json` / `labels.reviewed.json`:
```json
{
  "meta": { "labeler": "claude", "guide": "scripts/eval/LABELING_GUIDE.md", "heldout_seed": 13 },
  "items": {
    "<message id>": { "labels": ["offer", "mentor_intro"], "confidence": "sure", "rationale": "..." }
  }
}
```
Reviewed files add `"reviewed": true` and `"changed": true|false` per item.
