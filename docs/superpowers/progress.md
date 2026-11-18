# Progress


## Tasks (plan: docs/superpowers/plans/2026-11-17-hackathon-intel.md)
- [x] T1 Config additions (qwen + intel config, .env.example; interval floor 1s)
- [x] T2 httpFetcher (rate limit, retry, robots, disk cache; 9 tests)
- [x] T3 intelStore (9 tables, idempotent upserts by source_url, stub-then-fill, filtered reads; 9 tests)
- [x] T4 adapter registry + record validation (lib/records.js, adapters/registry.js)
- [x] T5 Devpost parser (cheerio; pure parse* fns + fetchRecords; SYNTHETIC fixtures, selectors unverified vs live Devpost)
- [x] T6 eval harness v1 (extraction evals on devpost-gold.json; intel:eval writes docs/evals + history.csv; all 1.0 on SYNTHETIC fixtures)
- [x] T7 intelIngest + CLI (intel:ingest --adapter --max-hackathons --file; ingestAll isolates failures)
- [x] T8 GitHub adapter (README/tree/languages/contributors -> projects.github_stats; token via GITHUB_TOKEN)
- [x] T9 HF + manualImport + slack adapters (hf_info column; CSV/JSON import)
- [x] T10 jobs adapter: Greenhouse/Lever/Ashby, boards only from sponsors.jobs_board or options.boards (never guessed), https-only links, strict slugs
- [x] T11 qwen client (OpenAI-compatible, strips <think>, throws on truncation)
- [x] T12 projectSummaries + groundedness (lexical proxy); uncited/<0.5 grounded output stored as Unknown; intel:summarize
- [x] T13 contributions: model only called with GitHub commit share or project-text mention; bio/skills alone => Unknown quoting the bio
- [x] T14 intelRag: in-memory index, fenced sources, uncited answer => unknown, minScore 0.25 gate; intel:ask
- [x] T15 RAG eval: 42 SYNTHETIC questions (27 dev/15 heldout), recall@5/MRR/unknown-gate; answer metrics skipped (no Qwen)
- [x] T16 intel:bench -> docs/evals/bench-<date>.md + bench-history.csv
- [ ] T17 HTTP routes
- [ ] T18 practice + teammateFinder
- [ ] T19 frontend Winners/Detail
- [ ] T20 frontend remaining pages + design/a11y review
- [ ] L1 live Devpost scrape
- [ ] L2 live GitHub/jobs
- [ ] F final report + Claude Doc

## Notes
- Baseline: 32 tests pass. Now 77 (session 2).
- BLOCKED (session 1): devpost.com:443 refused by the cloud egress proxy (403 CONNECT). L1 cannot run until the host is allowed (env network settings) or run locally. Never faked data: fixtures under backend/test/fixtures/devpost/ are hand-written and labelled SYNTHETIC; re-validate selectors on real captures.
- Gotcha: a bare `cat > file` with no heredoc hangs the shell; always use heredocs.
- Next up: T6 eval harness (extraction evals on labeled fixtures + intel:eval + history.csv), then T7 intelIngest + CLI.
- Session 1 skipped the parallel critic/judge round (time); T1-T5 should get a code-review + architecture pass at the start of session 2 before T6.
- Session 2: review round done for T1-T9 (see decisions.md). Next: T10 jobs adapter, T11 qwen client, T12 projectSummaries, then T13/T14. `npm ci` is needed in a fresh container. Reminder: use heredocs only.

- Session 3: T10-T16 done; review round done (findings fixed: prompt fencing, citation enforcement, bio-only evidence, think truncation, jobs URL/slug validation). Tests 104 pass.
- Evals (hash embedder, SYNTHETIC corpus): dev recall@5 1.0 MRR 0.938; heldout recall@5 1.0 MRR 0.917; unknown_gate heldout 0.667 (dev 1.0; NOT tuned on heldout). Real MiniLM embedder + Qwen answer metrics still unmeasured.
- Bench (hash embedder, mock Qwen): ingest ~19.9k rec/s, retrieval p50 0.02ms, p95 0.22ms.
- Deferred from review (low priority): summary re-generation on source change (hash), QWEN api key header, citation source URLs in ask results, per-project README chunk URLs, non-zero exit on summarize failures.
- Next up: T17 HTTP routes (/api/intel/*, add intelRag instance + ask), T18 practice + teammateFinder, T19/T20 frontend. See backend/src/http/routes for existing route style.
