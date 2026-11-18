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
