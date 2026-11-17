# Decisions made on the owner's behalf

- `npm test` changed from `node --test backend/test/` to `node --test`: Node 22 treats a directory arg as a module path and fails; bare `node --test` auto-discovers `*.test.js` on 18+ and 22.
- Branch `feature/hackathon-intel` created from `origin/refactor/frontend-backend-layout` (required base).
- Request interval floored at 1000ms in config even if INTEL_MIN_INTERVAL_MS is lower: the spec forbids hammering sites.
- robots.txt parser is minimal (wildcard agent, prefix Disallow only; pattern rules skipped): fewer deps; skipped rules mean we may fetch a path a pattern would block, so adapters must only hit normal public pages.
