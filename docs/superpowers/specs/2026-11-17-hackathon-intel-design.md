# Hackathon Intel — Design (approved)

## Why
The owner (CS student preparing for AI-engineer internships) wants one tool for: (1) job hunting: job/internship postings shared in the Slack chats and Discord servers the owner provides; (2) learning what wins: how 2026 San Francisco winning projects were built; (3) hackathon practice: drills based on real past prize tracks and winners; (4) finding teammates: people who won, what they built, how to reach them.

## Goals
- Database of 2026 San Francisco hackathon winners: hackathon, prize/track, Devpost + GitHub (+ Hugging Face) links, a paragraph on what the project is, a paragraph on its code architecture.
- Teammates per project: name, Devpost/GitHub/LinkedIn links, 2-3 sentences on what they contributed.
- Sponsors of each hackathon and of each winning team's prize.
- Jobs section: postings extracted ONLY from owner-provided Slack archives and Discord exports (company, title, location, link, posted date, channel, message permalink), linked to sponsors/companies when names match. No public job-board scraping.
- Ask agent on open-source Qwen answering questions about winners (RAG over the DB).
- Adapters: one plug-in per data source so new sites can be added without touching services.

## Non-goals / anti-goals
- No scraping LinkedIn (ToS). LinkedIn URLs only from Devpost/GitHub profiles, READMEs, or manual import.
- No fabricated contributions: if evidence is thin, say unknown. Every summary cites its sources.
- No ATS/company job-board scraping (Greenhouse, Lever, Ashby, etc.). No live Discord scraping or self-bots; Discord data comes from DiscordChatExporter JSON exports dropped in data/discord/.
- Don't break existing Slack features or tests. No secrets committed. Don't hammer sites.

## Approaches considered
1. Adapters -> normalized records -> SQLite + existing vector index (CHOSEN). Reuses backend/src/data/db.js and clients/embedder.js; offline; testable with fixtures.
2. Everything in Postgres + pgvector: needs Docker; mirror later if wanted.
3. Headless-browser crawler: heavy, brittle; only if an adapter can't work from HTML/APIs.

## Architecture (http -> services -> data/clients -> lib)
- backend/src/adapters/: each exports `name` and `async function fetchRecords(options, deps)` returning normalized records { kind: hackathon|project|person|contribution|sponsor|job, source, sourceUrl, data }. adapters/registry.js lists them. Initial: devpost, github, huggingface, manualImport (JSON/CSV), slack (wraps existing archive), slackJobs (job/internship posts from the Slack archive), discord (DiscordChatExporter JSON in data/discord/; job/internship posts).
- clients/httpFetcher.js: rate limit, retry, on-disk cache in data/raw/, generic User-Agent.
- data/intelStore.js: SQLite tables hackathons, projects, people, project_members, contributions, sponsors, hackathon_sponsors, project_prizes, jobs (with source channel + message permalink); idempotent upserts keyed by source URL.
- clients/qwen.js: OpenAI-compatible chat client; QWEN_BASE_URL default http://localhost:11434/v1, QWEN_MODEL default qwen3:8b.
- Services: intelIngest, projectSummaries, contributions, intelRag, practice, teammateFinder.
- CLI: intel:ingest (--adapter), intel:summarize, intel:ask, intel:eval, intel:bench.
- HTTP: /api/intel/{hackathons,projects,projects/:id,people,people/:id,sponsors,jobs,ask,practice}.
- Frontend pages (vanilla JS router in frontend/src): Winners, Project detail, Teammate finder, Jobs (filter by source Slack/Discord, channel, company), Ask, Practice. Designed in code (Figma not connected).

## Quality bar
imports -> constants -> exported functions -> private helpers; named exports only; no import-time side effects; file header comment, JSDoc, WHY comments; small functions; no nested ternaries. node --test with saved fixtures; no live network in tests.

## Evals and benchmarks (run every session once the harness exists)
- npm run intel:eval writes docs/evals/intel-eval-<date>.md and appends to docs/evals/history.csv.
- Extraction evals on hand-labeled fixtures: winner detection P/R, team-member parsing F1, sponsor/prize linking accuracy, SF-and-2026 filter accuracy.
- RAG evals: >=30 questions with gold project IDs/answers, dev/held-out split (tune only on dev). recall@5, MRR, answer correctness, citation accuracy, correct 'unknown' rate.
- Summary groundedness: % of claims traceable to source text.
- Benchmarks (npm run intel:bench): ingest throughput, retrieval p50/p95, ask latency p50/p95 (mocked Qwen; real if reachable), embedding time per 100 chunks.
- No commit may drop a held-out metric by >2 points without a written reason in progress.md.

- Services also: jobPostDetector (rule-based first, optional Qwen fallback) shared by the slackJobs and discord adapters.
