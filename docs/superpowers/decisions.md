# Decisions made on the owner's behalf

- `npm test` changed from `node --test backend/test/` to `node --test`: Node 22 treats a directory arg as a module path and fails; bare `node --test` auto-discovers `*.test.js` on 18+ and 22.
- Branch `feature/hackathon-intel` created from `origin/refactor/frontend-backend-layout` (required base).
- Request interval floored at 1000ms in config even if INTEL_MIN_INTERVAL_MS is lower: the spec forbids hammering sites.
- robots.txt parser is minimal (wildcard agent, prefix Disallow only; pattern rules skipped): fewer deps; skipped rules mean we may fetch a path a pattern would block, so adapters must only hit normal public pages.
- intelStore lives in the existing slack.db (same connection, CREATE IF NOT EXISTS) rather than a second file: one backup unit, one vector index location. Tables are not dropped by the Slack rebuild.
- Cross-record references use source URLs and create stub rows when the target hasn't arrived, so adapters may emit in any order. Sponsors dedupe by slug of name when no URL is given.
- Eval gold labels are hand-written against SYNTHETIC fixtures, so extraction metrics are 1.0 by construction; they guard against parser regressions only. Real-capture labels come with task L1 (devpost.com was blocked by the egress proxy).
- ingestAll isolates adapter failures (reported in the summary, not thrown): one blocked site must not stop other sources.
- Eval history rows are appended per run, one CSV row per metric, with the short commit hash, so deltas can be diffed across sessions.
- GitHub adapter enriches existing projects (reads them from the store via ingest deps) instead of crawling: it only fetches repos Devpost linked, keeping request volume low. Commit stats live in a new projects.github_stats JSON column (added by an ALTER if missing).
- Project upsert no longer clobbers: tagline/description/built_with/github_stats use COALESCE, is_winner uses MAX, source is never overwritten — so enrichment records can't erase Devpost data.
- Review round 1 (T1-T9): fixed SSRF/redirect bypass (https + public hosts only, manual redirects re-validated and rate-limited, 20s timeout), atomic cache writes, robots grouping + unreachable-robots => disallow-all, sponsor dedupe by name slug, COALESCE prize sponsors, member URL resolution, RECORD_KINDS moved to lib/records.js (layering), CLI flag validation + db close.
- Not fixed (why): bare `node --test` kept (Node 22 requires it; frontend has no tests so no stray pickup); cache TTL deferred (cache is for dev re-runs; delete data/raw to refresh); prize pruning on re-run deferred (rare; is_winner only ratchets up); robots `*`/`$` patterns still skipped (documented).
- Hackathon ordering uses year, then start_date (dates from Devpost are free text and not parsed yet).

## Session 3
- Jobs boards are never guessed from sponsor names: probing unknown slugs would hammer sites with 404s; boards come from manual import or options.
- Contribution summaries require commit/project-text evidence: a self-written bio is not proof of contribution (spec: no fabrication).
- Uncited RAG answers and summaries with groundedness < 0.5 are stored/returned as unknown: spec demands cited sources.
- RAG index is in memory and built per process: corpus is small; avoids a second on-disk index format.
- Eval uses a hash embedder offline (labelled "hash-embedder"); numbers are plumbing checks, not semantic quality.
- RAG eval questions are template-generated from a SYNTHETIC corpus plus hand-written unanswerable ones; replace after live ingest (L1).
- Source text is fenced in <source> tags with citation lookalikes stripped to blunt prompt injection from scraped pages.

## Session 4
- Owner scope change (2026-11-17): dropped public ATS job-board scraping; jobs come only from Slack archive and Discord exports (no bot tokens, no live Discord). Removed adapters/jobs.js, its fixtures/tests; kept the jobs table and sponsor linking. Superseded the 'jobs boards never guessed' decision above. Legacy sponsors.jobs_board column left in old DBs, unused.
- Jobs link to a sponsor only when a sponsor with the same name already exists; a company named in a chat post does not create a sponsor row (would pollute the sponsor list).
- slackJobs skips DMs/group DMs and system subtypes (private, not shared postings); permalinks need SLACK_WORKSPACE_URL (validated as https://*.slack.com), otherwise null.
- Job links are stored only when https (chat text is untrusted; frontend renders them as anchors).
- jobs-gold.json fixture was written alongside the rules: P/R 1.0 is a regression guard, not independent evidence. Extend with real labelled messages after live use.
- Review round: Discord DM exports (Direct* type / guild id 0) are refused; Slack bot posts kept (job bots are a main source); seeker rule only wins when no 'we're hiring' phrase; questions about hiring rejected; job link taken from the Slack href side only and must be https without userinfo; sponsor link by case-insensitive name; eval field accuracy is 0 when nothing detected.
- Detail endpoints use ?id= (router matches exact paths; /api/intel/projects/:id would need router changes). Intel tables created at server start.
