# Decisions made on the owner's behalf

- `npm test` changed from `node --test backend/test/` to `node --test`: Node 22 treats a directory arg as a module path and fails; bare `node --test` auto-discovers `*.test.js` on 18+ and 22.
- Branch `feature/hackathon-intel` created from `origin/refactor/frontend-backend-layout` (required base).
