# Relay — notes for Claude

Single-restaurant delivery ops app (riders take orders for customers, cashiers
run the kitchen board and cash handovers, the owner administers everything).
React + Vite frontend in `src/`, Parse Cloud Code in `cloud/` (entry
`cloud/main.js`), deployed on Back4App.

**Before starting any work, read `docs/ROADMAP.md`.** It holds the product
brief, the current-state inventory, the known bugs (S*/B*/U* ids), the
conventions, the Back4App release checklist, and the phased checklist. When
you finish something, tick its box and add a line to the change log there.

Key rules (details in the roadmap, §4):

- Every mutation goes through a Cloud function; the client only reads. New
  business classes go into `PROTECTED_CLASSES` and `SCHEMAS` in `cloud/security.js`.
- Prices, totals, commission and the rider float are computed on the server. The float is derived from orders, not stored.
- Audit every mutation with `audit(...)`.
- Roles come from `getMyProfile` / `requireRole`, never from client `_Role` queries.
- Currency and timezone come from `Configuration` (`useMoney()`, `src/lib/format.ts`). Never hard-code `UGX`.

Checks:

- `npm run check`: typecheck, lint, format, unit tests, build.
- `cd e2e && npm ci && PARSE_TEST_DATABASE_URI=... npm test`: Cloud Code end to
  end on a real Parse Server (MongoDB URI ending in `/`, or an empty Postgres
  database). Add an e2e test for every new Cloud function.
