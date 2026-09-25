# Relay — notes for Claude

Single-restaurant delivery ops app (riders take orders for customers, cashiers
run the kitchen board and cash handovers, the owner administers everything).
React + Vite frontend in `src/`, Parse Cloud Code in `cloud/main.js`, deployed
on Back4App.

**Before starting any work, read `docs/ROADMAP.md`.** It holds the product
brief, the current-state inventory, the known bugs (S*/B*/U* ids), the
conventions, and the phased checklist. When you finish something, tick its box
and add a line to the change log there.

Key rules (details in the roadmap, §4):
- Every mutation goes through a Cloud function; the client only reads.
- Prices, totals, commission and the rider float are computed on the server. The float is derived from orders, not stored.
- Audit every mutation with `audit(...)`.
- Currency and timezone come from `Configuration`. Never hard-code `UGX`.

Checks: `npx tsc --noEmit` and `npm run build` (no tests/lint yet).
