# Classifier evaluation (held-out set)

Measures `categorize.js` (collections `linkedin`, `mentor_intro`, `offer`,
`sponsor_opportunity`, `teammate`) and the person page's keyword `mention` net
against hand-checked labels.

Everything containing message text lives in `data/eval/` (git-ignored). The
files in this folder contain code and definitions only.

| File | Tracked | What |
|---|---|---|
| `scripts/eval/sample.js` | yes | draws the stratified held-out sample |
| `scripts/eval/LABELING_GUIDE.md` | yes | class definitions and edge cases |
| `scripts/eval/build-review.js` | yes | builds the review page |
| `scripts/eval/import-review.js` | yes | brings an exported review back into `data/eval/` |
| `scripts/eval/evaluate.js` | yes | precision/recall/F1, errors, calibration, threshold sweep |
| `data/eval/heldout.json` | no | 200 messages + the classifier's snapshot `prediction` |
| `data/eval/labels.claude.json` | no | Claude's blind labels (labels, confidence, rationale) |
| `data/eval/labels.reviewed.json` | no | your reviewed labels (after import) |
| `data/eval/review.html` | no | self-contained review page (open it directly, works offline) |
| `data/eval/report.*.txt` | no | saved evaluation reports |

## Commands

Run from the repo root (Node 18+).

```sh
# 1. Sample (already done; deterministic. --force overwrites and invalidates labels)
node backend/scripts/eval/sample.js --seed 13 --size 200

# 2. Review Claude's labels in the browser
node backend/scripts/eval/build-review.js          # writes data/eval/review.html
#    open data/eval/review.html, step through, click "Export reviewed labels"
node backend/scripts/eval/import-review.js ~/Downloads/labels.reviewed.json

# 3. Evaluate (uses labels.reviewed.json if present, else labels.claude.json)
node backend/scripts/eval/evaluate.js > data/eval/report.reviewed.txt
node backend/scripts/eval/evaluate.js --gold data/eval/labels.claude.json --no-sweep   # force Claude labels, skip sweep
node backend/scripts/eval/evaluate.js --frozen        # score the sampling-time predictions instead of data/categories.json
node backend/scripts/eval/evaluate.js --code HEAD     # sweep a committed classifier version
```

PowerShell: same commands. Windows PowerShell 5.1's `>` can write UTF-16, so
use `node backend/scripts/eval/evaluate.js | Out-File -Encoding utf8 data/eval/report.reviewed.txt`.

## How the sample is built

About 200 messages, seeded RNG, deduplicated by id and by text. Skips Slack
system rows (`raw.subtype`), texts under 12 characters, and DMs.

- `pos:<class>` (15 each): predicted positives, about half picked closest to
  `THRESHOLD` (borderline) and the rest at random. `linkedin` is rule-based,
  so all 15 are random.
- `near:<class>` (8 each): predicted negatives with a similarity score in
  `[THRESHOLD − 0.08, THRESHOLD)`, the near misses.
- `kw` (40): uncategorized messages containing outreach keywords (linkedin,
  resume, DM me, mentor, hiring, intern, team, connect, referral). These are
  hard negatives.
- `random` (~50): uniform over eligible messages.

Each stratum is split 60% `dev` / 40% `test`. Tune on dev only and read test
once at the end. Strata over-sample positives and hard cases, so the metrics
here are **not** population rates: precision on the full archive is usually
higher, because there are many easy negatives.

`prediction` holds the classifier's output at sampling time: collections, the
`mention` flag, cosine similarity per class (max over the class's example
sentences, computed the same way as `categorize.js`), threshold, confidence
(high/medium/low) and stratum. The review page hides it by default so labels
stay blind.

## Workflow when changing the classifier

1. Edit the classifier, then run `npm run categorize`.
2. Run `node backend/scripts/eval/evaluate.js --split dev` and iterate.
3. When you're done, run the full report once and look at TEST.
4. Don't add held-out messages to the classifier's example sentences. That
   leaks the test set.

The threshold sweep re-runs `categorize()` in `data/eval/.sweep/`, which uses
hard links of `messages.json`, `people.json` and the index. It never writes
`data/categories.json`. If the working tree's `categorize.js` can't load
(for example during a refactor), the sweep falls back to `git HEAD`'s copy
and says so.

## Notes

- The keyword regex for `mention` in `backend/scripts/eval/common.js` is a copy of
  the one in the server's `GET /api/person` handler. Keep them in sync.
- Source files are looked up by name under `backend/src/`
  (`findSrc("categorize.js")`), so the scripts keep working if `backend/src/` is
  reorganized.
