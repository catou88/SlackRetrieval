# Slack Retrieval — Cal Hacks 2026

Saves every Slack message you can see in the hackathon workspace, builds a contact
book (LinkedIn links, titles, who's a mentor/judge/sponsor), and lets you ask
questions or get a "what should I tell them" brief per person. It uses vector
similarity search (local embeddings) for retrieval and Claude for answers.

```
Slack API ──► data/messages.json ──► data/people.json (LinkedIn, roles, DMs)
                     │
                     └─► local embeddings (all-MiniLM-L6-v2) ──► data/index.bin
                                                                     │
          question / person ──► cosine top-k ──► Claude (claude-opus-5-5) ──► answer / brief
```

## Setup (one time)

1. **Create a Slack app in the hackathon workspace.** Go to https://api.slack.com/apps, choose
   **Create New App → From a manifest**, pick the Cal Hacks workspace, and paste
   [slack-app-manifest.yaml](slack-app-manifest.yaml).
2. **Install it to the workspace** (Install App → Allow). If the workspace needs admin
   approval, request it. Hackathon workspaces often do this; see *Troubleshooting*.
3. Copy the **User OAuth Token** (`xoxp-…`) from *OAuth & Permissions*.
4. `copy .env.example .env` and fill in `SLACK_USER_TOKEN` and `ANTHROPIC_API_KEY`.
5. `npm install` (Node 18+).

The token is a *user* token, so it reads exactly what you can already see: your
channels, private channels, DMs, and group DMs. The app only asks for read scopes.

## Before you lose access: save everything

```powershell
npm run save-all      # pulls every message, thread, file, photo, and profile, then zips data/ into a backup
```

Run it now, and again just before you lose access. Then copy the
`slack-backup-*.zip` file somewhere safe (OneDrive, Google Drive, a USB stick).
After that, everything works offline from `data/`, and Slack is never needed again.
(The "Ask" and "brief" features still need internet to reach Claude.)

What gets saved locally:
- `data/slack.db`: SQLite database (messages, people, channels, files, plus your notes and briefs)
- `data/messages.json`, `users.json`, `channels.json`: the same data as plain JSON, including the full raw Slack payload for each message
- `data/files/`: every file and image shared in channels you can see (needs the `files:read` scope)
- `data/avatars/`: profile photos
- `data/index.bin` + `data/models/`: the vector index and the embedding model for meaning-search

## Networking collections in pgvector

`npm run pg` keeps only the messages worth following up on, tags them, and stores them
with their embeddings in Postgres + pgvector (Docker container `slack-pgvector`, local only
on port 5433). It also writes a plain SQL copy to `data/pgvector-dump.sql`.

| Collection | What is in it |
|---|---|
| `mentors` | Mentor and judge introductions, with their LinkedIn when they shared it |
| `offers` | Offers of advice, mentorship, resume reviews, referrals, and coffee chats |
| `sponsors` | Jobs, events, credits, and other info sponsors posted (#spons-* channels and others) |
| `teammates` | People you hacked with (group DMs and private channels), people you DMed, and anyone looking for a team |
| `linkedin-directory` | Everyone who shared a LinkedIn, with their intro |

```powershell
npm run pg                                   # sort + load (needs Docker Desktop running)
npm run collection -- mentors                # or offers | sponsors | teammates | linkedin-directory
npm run pg:search -- "resume review" --in offer
```

To open it in any SQL tool (pgAdmin, DBeaver, TablePlus), use `postgres://slack:slack@127.0.0.1:5433/slack`.
The views are `mentor_introductions`, `offers`, `sponsor_opportunities`, `teammates`, and `linkedin_directory`.
Tags are rule- and similarity-based. Tune them with `CATEGORY_THRESHOLD` in `.env` (default 0.45; lower keeps more).

## Local website

```powershell
npm run serve         # then open http://localhost:3000
```

- **People:** filter by mentors or people with LinkedIn. Each profile shows LinkedIn, links, DMs, and their messages, plus
  a notes box (saved in the database) and a **"What should I tell them?"** button that writes a reconnect brief with a draft message.
- **Channels & DMs:** read any conversation, including threads and images.
- **Search:** by meaning (vector similarity) or exact words.
- **Ask:** a question answered by Claude from your messages, with sources.

It only listens on your own computer (127.0.0.1); nobody else on the network can open it.

## Command line

```powershell
npm run sync                     # pull messages, build contacts, embed (re-run any time; incremental)
npm run sync -- --all            # also read public channels you never joined
npm run sync -- --full           # re-read everything (picks up new replies to old threads)
npm run backup -- --to D:\       # zip data/ to another drive

npm run people                   # everyone, sorted by how much you DM'd them
npm run people -- --mentors      # just mentors / judges
npm run people -- --linkedin     # just people with a LinkedIn found
npm run export                   # data/contacts.csv for Excel / Google Sheets

npm run brief -- "Jane Park"                                   # who they are, what you discussed, what to tell them, draft message
npm run brief -- "Jane" --goal "ask about summer internships"  # saved to data/briefs/

npm run ask -- "which mentors offered to review resumes?"
npm run ask -- "what did they suggest for our auth bug?" --person "Jane" --sources
npm run ask -- "who works on payments?" --mentors

npm run search -- "android firebase login"    # raw vector search, no Claude call
```

## Where LinkedIn and mentor info comes from

- **LinkedIn:** `linkedin.com/in/...` links in the person's own messages (mostly
  #introductions), their Slack profile title, status, and custom profile fields. A
  link someone posts about one other @mentioned person goes to that person.
- **Mentor / judge / sponsor / organizer:** their Slack title ("Mentor | SWE at
  Google"), self-introductions ("I'm a mentor from…"), and answers in channels
  with "mentor" in the name (marked `mentor?`).
- **Manual override:** put names or Slack IDs, one per line, in `data/mentors.txt`, then
  run `node src/cli.js people:build`.

## Troubleshooting

- **`not_allowed_token_type` / can't install app:** the workspace admins block
  custom apps. Ask an organizer to approve it.
- **`missing_scope`:** add the scope from the error to the app, reinstall, and copy the new token.
- **A channel shows `skipped (not_in_channel)`:** join it in Slack, or run with `--all` for public channels.
- Everything in `data/` is private, including your messages and embeddings. It's in `.gitignore`.
