# Relay — Product & Development Reference

> Living reference for building Relay into a commercial product. Read this first
> in every development session, keep the checklists current, and add to the
> **Change log** at the bottom when you finish a piece of work.
>
> Last full review: 2026-09-25 (commit `4ca66b7`, Back4App export "delivery-ledger").

---

## 1. What Relay is

A mobile-first web app for **one restaurant** whose **riders are the
customer-facing operators**. Customers never log in. Riders take orders from
walk-in, phone and WhatsApp customers, enter them in the app, pick them up,
deliver them, collect cash and hand the cash over to a cashier. Each delivery
earns the rider a commission.

| Role | Login | Main jobs |
|---|---|---|
| Rider | username + PIN | Create orders, pick up, deliver, collect cash, hand over cash, see earnings |
| Cashier | username + PIN | Accept tickets, mark ready, hand bags to riders, confirm cash handovers, close till |
| Admin / owner | email + password | Menu, team, commission rules, settings, everything else, disputes |
| Customer | none (v1) | Captured on the order as name, phone and address |

What sets it apart: **order entry has to be fast (< 30 s)**, riders must always
see what they will earn, and **every shilling must be reconciled**.

### Success metrics to design for
- Rider order entry: under 30 s from opening the app to a placed order
- Handover-to-confirmation lag: under 15 min
- More than 98% of orders have customer name, phone and address
- Less than 0.5% variance across all handovers
- More than 90% of orders go through the app rather than informal channels by week 4

### Out of scope for v1
Customer-facing app or QR menu, live GPS tracking, multiple restaurants, native
apps (a wrapper can come in v2), automated rider payouts, POS integration, and a
mobile-money gateway (phase 2).

---

## 2. Stack & deployment

| Layer | What |
|---|---|
| Frontend | React 18 + Vite 5 + TypeScript, plain CSS in `src/index.css` (Tailwind + shadcn/ui kit installed in `src/components/ui/` but **not used** by the app screens yet) |
| Backend | Parse Server on **Back4App**; all business logic in `cloud/main.js` (Cloud Code) |
| Data access | Parse JS SDK 7.1.2 (`src/parse.ts`); client talks to `/parse` |
| Hosting | Back4App "promote" build: nginx (`nginx.conf`) serves `dist/` and proxies `/parse` (REST + LiveQuery WS) to Parse on `127.0.0.1:1337` |
| Auth | Parse username/password (PIN used as the password); optional Back4App-managed Google sign-in (`src/lib/googleSignIn.ts`) |

**Local dev:** Node 20, `npm install`, `npm run dev`. Point
`vite.config.ts → server.proxy['/parse'].target` at a Parse Server and set
`VITE_PARSE_APP_ID` in `.env.local` (see `.env.local.example` and
`README-EXPORT.md`). Remove the `server.hmr` block when running locally.

**Checks available today:** `npx tsc --noEmit` and `npm run build`, which both
passed on 2026-09-25. There is **no lint, no test runner and no CI** yet.

**Bubble notes in the original brief → Parse equivalents**

| Brief (Bubble) | Relay (Parse / Back4App) |
|---|---|
| Option sets | String enums validated in Cloud Code (see §4.2) |
| Backend workflow | `Parse.Cloud.define` / `beforeSave` / `afterSave` |
| Scheduled workflow | Back4App **Cloud Jobs** (`Parse.Cloud.job`) + dashboard schedule |
| "Do every 10 s" refresh | Polling today; move to **LiveQuery** (already proxied in nginx + `parse.ts`) |
| Privacy rules | Class-Level Permissions (CLP) + per-object ACL + role checks in cloud functions |
| OneSignal | Web Push (VAPID) or OneSignal via Cloud Code HTTP |
| PDF Conjurer / CSV | Server-side HTML email or PDF from a Cloud Job; client CSV export (exists for orders) |

---

## 3. Current state inventory (what exists)

### 3.1 Files

| File | Purpose | State |
|---|---|---|
| `src/App.tsx` | Session, role lookup, workspace switch, "Initialize owner" banner, preview role switcher | Works for admin. **Role lookup is broken for riders and cashiers** (bug B1) |
| `src/components/AuthScreen.tsx` | Username + PIN login, owner sign-up, Google, preview | Works. Public sign-up stays open (S3) |
| `src/components/RiderWorkspace.tsx` | Rider home, active list, cash + handover, earnings, profile placeholder | Partly real; several hard-coded values |
| `src/components/NewOrder.tsx` | Order entry: name, address, menu grid, cart, place | Minimal: no phone, channel, payment, notes, qty dialog or commission preview |
| `src/components/CashierWorkspace.tsx` | Kitchen board (Incoming / Preparing / Ready), tabs | Works with real data, but shows mock tickets on first render, rider **id** instead of name, and no item lines |
| `src/components/CashierHandovers.tsx` | Pending handovers, count-cash modal, confirm / dispute | Works |
| `src/components/ShiftPanel.tsx` | Start / end shift for rider & cashier; cashier till variance | Works |
| `src/components/AdminWorkspace.tsx` | Overview KPIs, orders, cash ledger, commission list, dispute "reopen" | Basic; rider shown as object id |
| `src/components/AdminOrders.tsx` | Searchable order table + CSV export | Basic; no filters or detail view |
| `src/components/AdminSetup.tsx` | Team create / activate / role / commission; menu categories & items; settings | Works (limited fields) |
| `cloud/main.js` | All Cloud Code (see 3.2) | Core flows implemented; hardening needed |
| `src/lib/googleSignIn.ts` | Back4App managed Google OAuth | Platform boilerplate |

`react-router-dom` is installed, but navigation is done with `useState` screens,
so there are no URLs or deep links.

### 3.2 Cloud functions (`cloud/main.js`)

| Function | Who | What it does now |
|---|---|---|
| `createOrder` | rider | Validates name, address and items against `MenuItem` (active + availableToday, qty 1–50). Blocks if the rider has an in-flight order (unless `allowBatching`) or current float ≥ `maxRiderFloat`. Prices from the DB, snapshots on `OrderItem`, ACL, audit |
| `transitionOrder` | staff / owning rider | `accept`, `prepare`, `ready` (staff); `pickup`, `deliver` (rider or staff). On deliver: amount ≥ total, commission (per_order / percent / hybrid on subtotal, `Math.round`), cashStatus → `WITH_RIDER` for cash |
| `createHandover` | rider | Selected own DELIVERED + WITH_RIDER orders → `CashHandover` (pending), orders → `HANDOVER_PENDING` |
| `confirmHandover` | cashier / admin | Counted amount must **equal** the claim. Orders → `RECONCILED`, handover → confirmed |
| `disputeHandover` | cashier / admin | Reason (≥ 5 chars) + counted amount → handover `disputed`. Orders stay HANDOVER_PENDING |
| `reopenHandover` | admin | disputed → pending with a resolution note (the only resolution path today) |
| `bootstrapOwner` | first user | If there is no admin role and exactly one user exists → make them admin, seed 6 menu items |
| `adminListSetup` | admin | Team (≤ 100 users) with roles, menu, categories, settings |
| `adminCreateTeamMember` | admin | Creates a rider or cashier user (PIN = password) and adds the role |
| `adminUpdateMember` | admin | active flag, commissionType / PerOrder / Percent |
| `adminChangeRole` | admin | Swap rider ↔ cashier |
| `adminSaveCategory` / `adminSaveMenuItem` / `adminSaveSettings` | admin | CRUD with audit |
| `getOperationalMenu` | **anyone (no auth)** | Active + available items, delivery fee, currency |
| `getMyShift` / `startShift` / `endShift` | rider / cashier | Shift rows. Rider end needs acknowledgment if float > 0; cashier end computes expected till + variance |
| `createPreviewOrder` / `getPreviewOrders` / `transitionPreviewOrder` | **anyone (no auth)** | Demo data in the `DemoOrder` class for the preview mode |

Helpers: `requireUser`, `isRider`, `isStaff` (cashier or admin), `adminOnly`,
`ensureRole`, `audit` (writes `AuditLog`, admin-read ACL), `orderAcl` (owner
read/write + cashier/admin read/write), `shiftBalance`.

### 3.3 Parse classes as actually used

| Class | Fields in use |
|---|---|
| `_User` | username, password (= PIN), email (owner), name, phone, active, commissionType, commissionPerOrder, commissionPercent |
| `_Role` | `admin`, `cashier`, `rider` (ACL: admin read/write only) |
| `Order` | orderCode, channel, createdBy, customerName, customerPhone, deliveryAddress, subtotal, deliveryFee, total, paymentMethod, amountCollected, paymentCollectedBy, status, restaurantStatus, cashStatus, commissionAmount, commissionPaid, pickedUpAt, deliveredAt, settledAt |
| `OrderItem` | order, itemNameSnapshot, unitPriceSnapshot, quantity, lineTotal, notes |
| `CashHandover` | handoverCode, rider, cashier, amount, countedAmount, orderCount, orders (array of pointers), status, handedOverAt, confirmedAt, disputedAt, disputeReason, notes, resolutionNote, resolvedBy, resolvedAt |
| `MenuCategory` | title, active, sortOrder |
| `MenuItem` | title, price, category (**string**, not a pointer), active, availableToday, sortOrder |
| `Configuration` | restaurantName, currencySymbol, defaultDeliveryFee, maxRiderFloat, allowBatching |
| `Shift` | operator, kind (rider / cashier), status (open / closed), openingFloat, startedAt, endedAt, closingFloat, acknowledgedCash, expectedTill, physicalCount, variance |
| `AuditLog` | actor, action, entityType, entityId, beforeJson, afterJson |
| `DemoOrder` | preview-only |

**Not yet created:** `Customer`, `CommissionPayout`, `TillPayout`,
`Notification`, `MenuItemOption`, `ZReport`, rider or cashier codes.

### 3.4 Screen coverage vs. brief

Legend: ✅ done · 🟡 partial · ❌ missing

**Rider**

| Brief screen | State | Notes |
|---|---|---|
| Home dashboard | 🟡 | Tiles are real, but the greeting, "R-014", "Amina" and "34% of limit" are hard-coded. "Today's earnings" is not filtered to today. The nav has no Cash tab |
| New order | 🟡 | Missing: phone, channel pills, delivery notes, map pin, qty/notes dialog, payment pills, amount collected, bill block, commission preview, type-ahead, re-order, draft. The parent hard-codes `channel: walkin` and `paymentMethod: cash` |
| Active orders | 🟡 | List + Pick up / Deliver. No Cancel, no tap-through |
| Order detail `/rider/order/:id` | ❌ | No detail, no Google Maps link, no delivery form (deliver sends `amountCollected = total`) |
| My cash | 🟡 | List + multi-select handover. No grouping by date, no over-limit colour, no notes field. Pending handovers not shown |
| Handover | 🟡 | Inline on the cash screen. No PIN, no "waiting for cashier" state list |
| Earnings | 🟡 | All-time only (last 100 orders). No Today/Week/Month/Custom, average or payout request |
| Profile | ❌ | Placeholder text only |
| Shift start/end | ✅ | End with cash does **not** create the pending handover the brief asks for |

**Cashier**

| Brief screen | State | Notes |
|---|---|---|
| Live board | 🟡 | Reject disabled. Items show the placeholder "Items recorded on ticket". Rider shown as id. Mock tickets flash on load. Handover badge hard-coded "2". Polls every 10 s |
| Handovers | ✅ | No search by rider or handover code. No partial acceptance |
| Shift / till | 🟡 | Expected till ignores cash paid out (no payouts model) |
| Profile | ❌ | |

**Admin**

| Brief screen | State | Notes |
|---|---|---|
| Overview | 🟡 | 4 KPIs + feed. No top rider, no charts, "cash reconciled today" missing |
| Orders | 🟡 | Search + CSV. No filters (date, rider, status, channel), no detail/override, max 100 rows |
| Riders list/detail | ❌ | Only the Team list with commission editor. No float, lifetime stats, per-rider max float, force handover or history |
| New rider / cashier | ✅ | In Team. No email, no auto rider code |
| Menu | 🟡 | No description, image, prep time, sort, delete. Category is a free string |
| Cash ledger | 🟡 | List + reopen dispute. No filters, totals, > 4 h highlight, write-off or amount edit |
| Commissions | 🟡 | Read-only list. No paid toggle, bulk pay or owed total |
| Settings | 🟡 | 5 of about 14 config fields |
| Audit viewer | ❌ | Data is written but there is no UI |
| Reports (Z, rider, item, variance) | ❌ | |

---

## 4. Conventions & decisions (follow these)

### 4.1 Architecture rules
1. **Every state-changing action goes through a Cloud function.** The client may
   *read* with `Parse.Query` where the ACL allows, but never `.save()` business
   objects directly. Enforce this with CLPs (see S1).
2. **The rider float is derived, not stored.** Today it is computed as the sum of
   `amountCollected` over DELIVERED orders with cashStatus `WITH_RIDER` or
   `HANDOVER_PENDING` (`shiftBalance`). **Keep it derived**, so it can't drift
   from the orders. If a cached `floatBalance` is added for dashboards, recompute
   it inside the same cloud function and never trust it for limits.
3. **Money is stored as whole integers in the currency's minor unit.** UGX has
   no minor unit in practice, so store whole shillings. Round commission with
   `Configuration.commissionRounding`.
4. **Snapshot prices and names** on `OrderItem`. Always compute totals
   server-side from `MenuItem`. Never trust client prices.
5. **Audit every mutation** with `audit(actor, 'domain.verb', obj, before, after)`.
   Action names in use: `order.placed`, `order.<accept|prepare|ready|pickup|deliver>`,
   `cash.handover_created|confirmed|disputed`, `cash.dispute_reopened`,
   `owner.initialized`, `team.created|updated|role_changed`,
   `menu.category_saved`, `menu.saved`, `configuration.saved`,
   `shift.started|closed`.
6. **Store UTC and display in the restaurant timezone** (add
   `Configuration.timezone`, e.g. `Africa/Kampala`). "Today" boundaries must be
   computed in that timezone **on the server**.
7. **Currency comes from `Configuration`** through one `formatMoney()` helper.
   Remove every hard-coded `UGX`.

### 4.2 Status enums (canonical)

```
Order.status           DRAFT | PLACED | ACCEPTED | PREPARING | READY | PICKED_UP | DELIVERED | CANCELLED
Order.restaurantStatus pending | accepted | preparing | ready | picked_up   (+ rejected)
Order.cashStatus       NOT_COLLECTED (cash, not yet delivered) | NOT_APPLICABLE (non-cash)
                       | WITH_RIDER | HANDOVER_PENDING | RECONCILED | DISPUTED | WRITTEN_OFF
Order.paymentMethod    cash | mobile_money | card | prepaid
Order.channel          walkin | phone | whatsapp | other
CashHandover.status    pending | confirmed | disputed | (partially_confirmed, written_off — to add)
Shift.status           open | closed        Shift.kind rider | cashier
User commissionType    per_order | percent | hybrid
```

Transitions (server-enforced in `transitionOrder`):
`PLACED→ACCEPTED→PREPARING→READY→PICKED_UP→DELIVERED`.
**To add:** `cancel` from PLACED/ACCEPTED (rider: PLACED only; staff: any
pre-pickup; reason required) and `reject` from PLACED (staff, reason required).
Consider letting "Mark ready" accept ACCEPTED directly instead of making two calls.

### 4.3 Commission formula
```
per_order: commissionPerOrder
percent:   subtotal × commissionPercent / 100
hybrid:    commissionPerOrder (hybrid base) + subtotal × commissionPercent / 100
then apply Configuration.commissionRounding (none | up_100 | up_500 | up_1000)
```
Fall back to `Configuration.default*` when the rider has no rule. Commission is
calculated on the **subtotal** (not the delivery fee) and **frozen at delivery**.

---

## 5. Known bugs & risks (fix before selling)

Priority: **P0** = release blocker, **P1** = before first paying client, **P2** = soon.

### Security (S)
- [ ] **S1 P0 — Riders can edit their own orders and handovers directly.**
  `orderAcl(user)` gives the rider *write* access on `Order`, `OrderItem`,
  `CashHandover` and `Shift`, so a rider can `PUT /classes/Order/:id` from the
  browser and change `cashStatus`, `amountCollected`, `commissionAmount` and so
  on. Fix: ACL owner = **read only**; set CLPs on all business classes to
  *no create/update/delete for clients* (only master key / cloud writes); read
  via role-scoped CLP + ACL.
- [ ] **S2 P0 — Unauthenticated cloud functions.** `createPreviewOrder`,
  `getPreviewOrders` and `transitionPreviewOrder` let anyone write rows, and
  `getOperationalMenu` exposes the menu. Remove preview mode from the production
  build (or gate it behind a feature flag + rate limit) and require auth on
  `getOperationalMenu`.
- [ ] **S3 P0 — Open sign-up.** Anyone can `signUp` (owner-creation form, Google
  sign-in). On a fresh deploy, whoever signs up first can call `bootstrapOwner`.
  Fix: disable client class creation and public sign-up in Back4App app
  settings; create the owner with a one-time setup token or a master-key script.
  Decide whether Google sign-in stays (owner only?).
- [ ] **S4 P1 — `_User` objects are publicly readable** (Parse default ACL), which
  exposes phone and commission fields. Set the user ACL to self + admin (+
  cashier read if needed) in `adminCreateTeamMember` and in a `beforeSave(_User)`.
- [ ] **S5 P1 — A 4-digit PIN can be brute-forced.** Enable Parse `accountLockout`
  (for example 5 attempts / 15 min) and a minimum PIN length of 4–6. Keep PINs
  numeric only.
- [ ] **S6 P1 — No PIN re-entry** for handover, profile changes or shift end.
  Add a `verifyPin` cloud function and a short-lived step-up token.
- [ ] **S7 P1 — Session policy.** Configure Parse `sessionLength` to 30 days for
  riders and cashiers. Consider a shorter session for admin.

### Correctness (B)
- [ ] **B1 P0 — Riders and cashiers can't read their own role.** `ensureRole`
  gives roles an admin-only read ACL, so `App.tsx`'s `Parse.Query(Parse.Role)`
  returns nothing for non-admins. **Cashiers get the rider UI** and every
  non-admin sees the "Initialize owner" banner. Fix: add a `getMyProfile` cloud
  function that returns `{role, name, riderCode, …}` and use it in `App.tsx`.
- [ ] **B2 P1 — Float limit checks the current float, not the float after the
  order.** It should block when `currentFloat + (cash order total) > maxRiderFloat`
  (brief §5.1), with a per-rider override.
- [ ] **B3 P1 — Order and handover codes can collide.** `Date.now().slice(-4 / -6)`
  is not unique or sequential. Use a `Counter` class with an atomic `increment`
  per day → `ORD-YYYYMMDD-0001`, `HO-YYYYMMDD-001`, and rider codes `R-001`.
- [ ] **B4 P1 — Handover confirm and create are not atomic.** Orders and the
  handover are saved in separate calls. If the second fails, the state diverges.
  Use Parse transactions (`saveAll(..., {transaction: true})` needs MongoDB
  replica set or Postgres; check Back4App support), or order the writes so a
  retry is idempotent: handover `status` as the lock (conditional update),
  orders keyed by `handoverId`, and a repair job.
- [ ] **B5 P1 — Concurrency.** Two cashiers can confirm the same handover at the
  same time, and a rider can double-submit the same orders. Add an idempotency
  key param + a `beforeSave` guard (`status` must equal the expected previous
  value), and disable buttons while a request is in flight (partly done already).
- [ ] **B6 P2 — Row limits.** Several queries use `limit(100)` / `limit(1000)`
  (float, admin lists, `adminListSetup` users). Paginate, or use aggregates on
  the server.
- [ ] **B7 P2 — "Today" is computed in browser time** on client-loaded rows
  (the last 100 only). Move KPIs to a server `getDashboard` function.
- [ ] **B8 P2 — The home "Cash on me" tile** counts WITH_RIDER + HANDOVER_PENDING,
  while the Cash screen lists WITH_RIDER only. Show pending handovers as a
  separate section so the numbers reconcile on screen.
- [ ] **B9 P2 — `NewOrder` requires an address**, while the brief only requires a
  name (address is expected for delivery). Decide: required for delivery, optional
  for walk-in pickup.

### Leftover preview / mock UI (U)
- [ ] U1 — Hard-coded `initial` tickets in `CashierWorkspace` render before the first load.
- [ ] U2 — Hard-coded "Tuesday · Rider R-014", "Amina", "AK", 34% limit bar, handover badge "2".
- [ ] U3 — The preview role switcher nav + "Preview roles" button show in production.
- [ ] U4 — The `SAMPLE` menu in `NewOrder` and the `MENU` seed in Cloud Code are for demos only.
- [ ] U5 — `UGX` is hard-coded in about 10 places.

---

## 6. Target data model (additions to what exists)

Only the **deltas** from §3.3 are listed here.

- **`_User`**: `role` (a mirror of the Parse Role, for display), `riderCode` /
  `cashierCode`, `hybridBase` (or reuse `commissionPerOrder` as the base — decide
  and document), `maxFloatOverride`, `available`, `lifetimeDeliveries`,
  `lifetimeCommission` (maintained in `deliver`), `currentShift` pointer.
  *(Or split these into `RiderProfile` / `CashierProfile` classes; recommended
  only if user reads must stay restricted.)*
- **`Order`**: `deliveryNotes`, `deliveryLat`, `deliveryLng`, `customer`
  (pointer), `cancelledReason`, `cancelledBy`, `cancelledAt`, `acceptedAt`,
  `readyAt`, `disputeFlag` + `disputeNote` (food issue, independent of cash),
  `shortfallNote` (when the amount collected is below the total), `handover`
  (pointer to the current handover), `commissionPayout` (pointer), `clientId`
  (idempotency / offline draft id), `proofPhoto` (file, v2), `voiceNote` (file, v2).
- **`MenuItem`**: `description`, `image` (Parse File), `prepTimeMinutes`,
  `categoryRef` (pointer to MenuCategory; migrate from the string).
  **`MenuCategory`**: `description`, `image`.
- **`Customer`** (new): `name`, `phone` (normalised E.164, unique),
  `addresses` (array of `{label, text, lat, lng, notes}`), `orderCount`,
  `lastOrderAt`, `lastOrder` (pointer). Upsert in `createOrder`.
- **`CashHandover`**: `acceptedOrders` / `disputedOrders` (for partial
  confirmation), `writtenOffAmount`, `forcedBy` (admin force handover),
  `idempotencyKey`.
- **`CommissionPayout`** (new): `rider`, `amount`, `orders` (relation),
  `periodStart`, `periodEnd`, `status` (requested | pending | paid), `paidBy`,
  `paidAt`, `method`, `reference`.
- **`TillPayout`** (new): `shift`, `cashier`, `amount`, `reason`
  (commission payout, expense, …), `createdAt`. This feeds expected till.
- **`Counter`** (new): `key` (e.g. `order:20260925`), `value` for sequential codes.
- **`Notification`** (new, optional): `user`, `type`, `title`, `body`, `entity`,
  `readAt`, for the in-app bell and for push delivery.
- **`ZReport`** (new): `date`, a totals JSON, `sentTo`, `generatedAt`.
- **`Configuration`** add: `currencyCode`, `timezone`,
  `defaultCommissionType`, `defaultCommissionPerOrder`,
  `defaultCommissionPercent`, `commissionRounding`,
  `requireCashierConfirmForPickup`, `requireHandoverBeforeNextOrder`,
  `reconciliationCutoffTime` (HH:mm), `handoverStaleHours` (default 4),
  `reportEmails` (array), `allowShortfall` (bool).

---

## 7. Roadmap

Work top-down. Each phase should end with the build passing, a manual
end-to-end run with real accounts (rider + cashier + admin), and a change-log
entry. The phases fold together the brief's build order (§12) and the Back4App
agent's "remaining" list.

### Phase 0 — Foundations & release blockers
- [x] Add `.gitignore` (node_modules, dist, .env.local) — done 2026-09-25
- [ ] B1 `getMyProfile` cloud function; `App.tsx` routes by server role; show the owner banner only when the server says it applies
- [ ] S1 CLPs + read-only owner ACLs on Order, OrderItem, CashHandover, Shift, AuditLog, Configuration, Menu*, Customer. Document CLPs in `docs/parse-schema.md` (or a schema migration script)
- [ ] S2 / U3 / U4 Remove or feature-flag preview mode (`VITE_ENABLE_PREVIEW`); delete the `DemoOrder` functions from production Cloud Code
- [ ] S3 Close public sign-up; one-time owner setup
- [ ] S4 User ACLs; S5 account lockout; S7 session length
- [ ] Split `cloud/main.js` into modules (`cloud/orders.js`, `cash.js`, `admin.js`, `shifts.js`, `lib/*.js`), readable formatting, shared `config()` loader
- [ ] Introduce `react-router-dom` routes (`/rider`, `/rider/new`, `/rider/order/:id`, `/cashier`, `/admin/...`) inside a role guard
- [ ] Shared `formatMoney`, `useConfig`, `useProfile` hooks; remove U1–U5
- [ ] Tooling: ESLint + Prettier, Vitest for pure logic (commission, rounding, float), GitHub Action running typecheck + build + tests
- [ ] Sequential codes via `Counter` (B3)

### Phase 1 — Orders complete
- [ ] New-order screen per brief §5.1: customer block (name, phone, channel pills), address + landmark notes, "Pin on map" (Google Maps / Leaflet, optional), category tabs, long-press qty/notes dialog, sticky cart, collapsible bill (editable fee), payment pills, amount collected, commission preview ("You'll earn X")
- [ ] Validation: shortfall needs an override note; B2 float-after-order check with a link to the handover screen
- [ ] Pass the real `channel`, `paymentMethod`, `customerPhone`, `deliveryNotes`, and line `notes` through `createOrder`
- [ ] `Customer` upsert + `searchCustomers(q)` (top 5 by orderCount) + address type-ahead + "Repeat last order"
- [ ] Order detail screen: header, customer, tap-to-map address, items, bill, a sticky cash bar, and one status-dependent action
- [ ] Delivery confirmation form (amount collected, payment confirmation, optional photo v2)
- [ ] `cancel` (rider, PLACED) and `reject` (cashier, with reason) transitions + UI
- [ ] Cashier ticket shows rider name/code, item lines with notes, age timer, channel, payment
- [ ] `requireCashierConfirmForPickup`: when on, only a cashier's "Hand to rider" moves an order to PICKED_UP
- [ ] Draft mode: cart kept in `localStorage` with a "Not submitted" badge; `clientId` idempotency on submit
- [ ] Order `disputeFlag` (food complaint) set by rider/cashier/admin

### Phase 2 — Cash integrity (the critical piece)
- [ ] S6 PIN re-entry (`verifyPin`) for handover submit, profile change, shift end
- [ ] B4 / B5 atomic, idempotent `createHandover` / `confirmHandover` / `disputeHandover`
- [ ] Partial confirmation: the cashier ticks the orders that are physically covered; the rest go back to `WITH_RIDER` or become `DISPUTED`
- [ ] Admin dispute resolution: (a) reopen for recount (exists), (b) edit amount + confirm, (c) mark specific orders `DISPUTED`, (d) write off an amount (`WRITTEN_OFF`, audit, variance report). Every path writes to `AuditLog`
- [ ] Admin "Force handover": creates a pending handover for all of a rider's WITH_RIDER orders (for a rider who is offline)
- [ ] Rider end-shift with cash auto-creates a pending handover (brief §7)
- [ ] Handovers covering orders from previous days, grouped by date on the rider cash screen
- [ ] Rider cash screen: over-limit red state, limit bar from config/override, list of pending handovers with status
- [ ] Cashier handover search by rider code / handover code
- [ ] `TillPayout` + expected till = opening + confirmed handovers − payouts
- [ ] Server-side invariant check job: float = Σ orders; flags any handover whose orders are in an inconsistent state

### Phase 3 — People & access
- [ ] Rider profile screen: name, phone, rider code, commission rule (read-only), change PIN (with old PIN), logout
- [ ] Cashier profile screen
- [ ] Admin rider detail: float, lifetime stats, per-rider max float, open orders, cash history, commission history, deactivate, reset PIN
- [ ] Auto rider/cashier codes; `available` toggle for the rider
- [ ] Commission defaults from Configuration; `hybridBase` handling; rounding
- [ ] Update lifetime stats in `deliver`
- [ ] End-to-end role/permission test matrix (automated against a test Parse Server): every function × every role, plus direct REST writes must fail

### Phase 4 — Operations & notifications
- [ ] Replace 10 s polling with LiveQuery subscriptions (cashier board, rider active orders, handovers), keeping polling as a fallback
- [ ] Notifications (in-app `Notification` + Web Push): new order → cashiers; order ready → rider; handover created → cashiers; handover disputed / float over max / handover stale > N h → admin
- [ ] Commission payouts: the rider requests a payout; the admin marks it paid per line or in bulk for a period; `commissionPaid` flags; optional TillPayout link
- [ ] Rider earnings: Today / Week / Month / Custom, count, average, list (server aggregate)
- [ ] PWA: manifest, icons, install prompt, offline shell (makes the web app feel native)

### Phase 5 — Admin & reporting
- [ ] Server `getDashboard`: orders today, gross sales, cash in transit, reconciled today, commission today, top rider; charts for orders/hour today and orders/day over 30 days (recharts is already installed)
- [ ] Orders table: server-side filters (date range, rider, cashStatus, restaurantStatus, channel), search (code, phone, rider code), pagination, detail + admin override (audited), full CSV export via cloud function
- [ ] Cash ledger: filters, totals (with riders / confirmed today / disputed), > 4 h pending highlight
- [ ] Commission ledger with the paid toggle and an owed total
- [ ] Settings form with every Configuration field
- [ ] Audit viewer filtered by actor, action and entity, with a before/after diff
- [ ] Reports: Daily Z-report, rider reconciliation (per rider per day: opening float, collected, handed over, closing, commission), item sales (top 20 by qty/revenue), variance report
- [ ] Cloud Job `dailyZReport` at `reconciliationCutoffTime` (restaurant timezone), emailed as HTML (via Back4App email adapter / Mailgun / SendGrid)
- [ ] Menu: description, image upload, prep time, sort order, category pointer migration, archive instead of delete

### Phase 6 — Release readiness & commercialisation
- [ ] Mobile usability pass: 44 px tap targets, contrast, one-hand reach, gloves; test on low-end Android Chrome over 3G
- [ ] Performance: code-split the admin workspace (the bundle is 497 kB, 156 kB gzip)
- [ ] Error reporting (e.g. Sentry) + a cloud-code structured log
- [ ] Backups / export of the Back4App DB; staging vs. production apps with separate app IDs
- [ ] Seed/onboarding wizard for a new restaurant (menu import CSV, first rider/cashier)
- [ ] Legal: privacy notice (customer phone numbers are personal data), terms, data retention
- [ ] Commercial: decide whether each client gets **a Back4App app per restaurant** (simplest, matches the single-vendor design) or a multi-tenant build later; white-label name/logo/colours from Configuration; pricing & billing outside the app
- [ ] Phase 2 features: mobile money via API (MTN MoMo / Airtel / Flutterwave), customer QR menu, rider GPS, native wrapper

---

## 8. Non-functional requirements (checklist for every change)
- Mobile-first for riders (phone) and cashiers (tablet/phone); admin is desktop
- Tap targets ≥ 44 px, high contrast, usable outdoors
- Optimistic UI, no full-page reloads, every action shows a busy/disabled state
- Rider session lasts 30 days; PIN step-up for sensitive actions
- Every status change, amount edit, dispute and override is audited
- Currency from Configuration; timezone from Configuration; store UTC
- Server is the source of truth for prices, totals, commission and float

---

## 9. Open questions for the client
1. Is an address required for walk-in orders collected at the counter, or are they always delivered?
2. Is commission on subtotal only (current) or subtotal + delivery fee? Does the rider keep the delivery fee?
3. Should shortfalls (collected < total) be allowed with a note, or blocked (current behaviour)?
4. Are commissions paid out of the till (affects expected till) or separately?
5. Does Google sign-in stay (owner only), or go?
6. Is there one cashier device or several at the same time (affects concurrency and shift model)?
7. Which notification channel is acceptable: web push (needs HTTPS + install), SMS, or WhatsApp?

---

## 10. Change log
| Date | Change |
|---|---|
| 2026-09-25 | Initial review of the Back4App export; this roadmap created; `.gitignore` added. Typecheck + build pass. |
