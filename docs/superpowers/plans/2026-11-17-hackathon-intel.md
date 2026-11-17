# Hackathon Intel — Implementation Plan

Each task is <= ~45 min, TDD, fixtures only (no live network in tests). Tasks T1..T20 in order; later tasks may be parallelised when independent. Live-network tasks (L*) cache to data/raw/ and save sanitized fixtures.

| # | Task | Files | Tests |
|---|------|-------|-------|
| T1 | Config: QWEN_*, GITHUB_TOKEN, HTTP fetcher settings in config.js + .env.example | config.js | config.test |
| T2 | clients/httpFetcher.js: rate limit >=1s/host, retry/backoff, disk cache data/raw/, generic UA, robots.txt check; injectable fetch/clock | clients/httpFetcher.js | fake fetch + fake clock |
| T3 | data/intelStore.js: schema + idempotent upserts keyed by source URL; read queries | data/intelStore.js | in-memory sqlite |
| T4 | Adapter contract + registry + record validation (lib/records.js) | adapters/registry.js | contract test |
| T5 | Devpost adapter parsing (pure HTML->records) from fixtures: hackathon list, gallery winners, project page, team, prizes/sponsors; SF+2026 filter | adapters/devpost.js, test/fixtures/devpost/ | parser tests |
| T6 | Eval harness v1 (extraction evals on labeled fixtures) + `intel:eval` + history.csv | scripts/intel/eval*.js | eval runs |
| T7 | intelIngest service: adapters -> validate -> store; CLI intel:ingest --adapter | services/intelIngest.js, cli | ingest test |
| T8 | GitHub adapter (repo meta, README, languages, tree, contributors/commit stats), fixtures | adapters/github.js | fixtures |
| T9 | Hugging Face adapter + manualImport (JSON/CSV) + slack adapter wrapper | adapters/*.js | fixtures |
| T10 | Jobs adapter (Greenhouse/Lever/Ashby public JSON) + sponsor->job linking | adapters/jobs.js | fixtures |
| T11 | clients/qwen.js OpenAI-compatible chat client (mockable) | clients/qwen.js | mock server |
| T12 | projectSummaries service (what-it-is + architecture paragraphs, cited) + groundedness metric | services/projectSummaries.js | mock Qwen |
| T13 | contributions service (2-3 sentences/member, evidence, unknown if thin) | services/contributions.js | mock Qwen |
| T14 | intelRag: chunking, embed, retrieve, answer with citations, unknown handling | services/intelRag.js | mock Qwen |
| T15 | RAG eval set (>=30 Qs, dev/held-out) + metrics in intel:eval | scripts/intel/, fixtures | metrics |
| T16 | intel:bench benchmarks | scripts/intel/bench.js | runs |
| T17 | HTTP /api/intel/* routes (read endpoints + ask) | http/routes/intelRoutes.js | route tests |
| T18 | practice + teammateFinder services and routes | services/*.js | tests |
| T19 | Frontend: Winners + Project detail pages | frontend/src/pages | manual/a11y review |
| T20 | Frontend: Teammates, Jobs, Ask, Practice pages; design critique + a11y audit |
| L1 | Live scrape Devpost (SF 2026) politely; record blockers; save fixtures |
| L2 | Live GitHub/jobs enrichment |
| F  | Final report, Claude Doc, STATUS: ALL DONE |
