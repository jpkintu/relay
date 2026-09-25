# Relay — Product & Development Reference

> Living reference for building Relay into a commercial product. Read this first
> in every development session, keep the checklists current, and add to the
> **Change log** at the bottom when you finish a piece of work.
>
> Last full review: 2026-09-25 (commit `4ca66b7`, Back4App export "delivery-ledger").
> Phase 0 completed: 2026-09-25 (branch `claude/tender-babbage-2asgpw`).

---

## 1. What Relay is

A mobile-first web app for **one restaurant** whose **riders are the
customer-facing operators**. Customers never log in. Riders take orders from
walk-in, phone and WhatsApp customers, enter them in the app, pick them up,
deliver them, collect cash and hand the cash over to a cashier. Each delivery
earns the rider a commission.

| Role          | Login            | Main jobs                                                                           |
| ------------- | ---------------- | ----------------------------------------------------------------------------------- |
| Rider         | username + PIN   | Create orders, pick up, deliver, collect cash, hand over cash, see earnings         |
| Cashier       | username + PIN   | Accept tickets, mark ready, hand bags to riders, confirm cash handovers, close till |
| Admin / owner | email + password | Menu, team, commission rules, settings, everything else, disputes                   |
| Customer      | none (v1)        | Captured on the order as name, phone and address                                    |

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

| Layer       | What                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend    | React 18 + Vite 5 + TypeScript, plain CSS in `src/index.css` (Tailwind + shadcn/ui kit installed in `src/components/ui/` but **not used** by the app screens yet)                                                                                                                                            |
| Backend     | Parse Server on **Back4App**; business logic in Cloud Code under `cloud/` (`main.js` loads the modules, see §3.2)                                                                                                                                                                                            |
| Data access | Parse JS SDK 7.1.2 (`src/parse.ts`); server URL, app id and JS key from `VITE_PARSE_*` build env (local default: `/parse`)                                                                                                                                                                                   |
| Hosting     | **Two Back4App apps.** Backend: a Back4App **Parse app** (managed DB, Cloud Code from `cloud/`, dashboard, Jobs). Frontend: a Back4App **Container** built from this repo (static build served by `npm run preview`). `nginx.conf` / `README-EXPORT.md` are leftovers from the Agent export and are not used |
| Auth        | Parse username/password (PIN used as the password); optional Back4App-managed Google sign-in (`src/lib/googleSignIn.ts`)                                                                                                                                                                                     |

**Local dev:** Node 22, `npm install`, `npm run dev`. Point
`vite.config.ts → server.proxy['/parse'].target` at a Parse Server and set
`VITE_PARSE_APP_ID` in `.env.local` (see `.env.local.example` and
`README-EXPORT.md`). Remove the `server.hmr` block when running locally.

**Checks:** `npm run check` runs typecheck, ESLint, Prettier, Vitest unit tests
and the build. The Cloud Code end-to-end suite lives in `e2e/` (its own
`package.json`): it boots a real Parse Server in-process with `cloud/` and
drives it as each role.

```
cd e2e && npm ci
PARSE_TEST_DATABASE_URI=mongodb://localhost:27017/ npm test      # fresh DB per run
# or an EMPTY Postgres database:
PARSE_TEST_DATABASE_URI=postgres://postgres:postgres@localhost:5432/relaytest npm test
```

GitHub Actions (`.github/workflows/ci.yml`) runs both on every PR, with MongoDB 7
as a service for the e2e job.

### Deploying (backend + frontend)

A Back4App **Container** only serves the frontend. It does **not** run Parse or
Cloud Code. Without a backend, nothing can sign in. The backend is a separate
Back4App **Parse app**:

1. **Create the backend.** Back4App dashboard → New App → Backend as a Service
   (Parse). In Server Settings pick a recent Parse Server (6 or later).
2. **Deploy Cloud Code.** Upload the whole `cloud/` folder (`main.js`, the other
   `*.js` files, `lib/`, `package.json`) as the app's Cloud Code, using the
   dashboard Cloud Code page or the `b4a` CLI (`b4a deploy`), then deploy. The
   Cloud Code logs must not show load errors.
3. **Point the frontend at it.** On the Container app → Settings → Environment,
   set these and redeploy (Vite bakes them in at build time):
   - `VITE_PARSE_SERVER_URL=https://parseapi.back4app.com`
   - `VITE_PARSE_APP_ID=<Application ID>`
   - `VITE_PARSE_JS_KEY=<JavaScript key>`

   The IDs are under the Parse app → App Settings → Security & Keys. They are
   public client keys. If the Container does not pass environment variables to
   the build, commit them in a `.env.production` file instead.

4. **Check.** Open the site. On a new, empty Parse app the sign-in card shows
   "First owner? Create account". If it says "Can't reach the Relay server
   functions", step 2 or 3 is wrong.

The frontend is pinned to Node 22 (`engines`); `vite.config.ts` lets `vite
preview` answer on any host name (b4a.run URL or a custom domain).

### Back4App release checklist

Do this on every environment (staging and production) after deploying Cloud
Code:

1. **Environment variables.** Leave `RELAY_ENABLE_PREVIEW` (Cloud Code) and
   `VITE_ENABLE_PREVIEW` (frontend build) **unset** in production. Set both to
   `true` only on a demo app.
2. **App settings.** Turn **off** "Allow client class creation". Turn on
   account lockout (S5) and set the session length to 30 days (S7) if the
   Back4App plan exposes these Parse Server options; otherwise ask Back4App
   support.
3. **Apply security.** Sign in as the owner → Settings → **Apply security
   rules** (or run the Cloud Job `applySecurity` from the dashboard). This
   creates the business classes with their fields, applies class-level
   permissions, rewrites old ACLs (riders lose write access, users become
   private) and assigns missing `R-001` / `C-001` codes. Safe to re-run.
4. **Fresh restaurant.** On an empty database, the first person to open the app
   sees "First owner? Create account". Sign-up closes as soon as one account
   exists; that account then clicks **Initialize owner**. Do this yourself
   immediately after deploying so nobody else can claim the owner account.

**Bubble notes in the original brief → Parse equivalents**

| Brief (Bubble)          | Relay (Parse / Back4App)                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Option sets             | String enums validated in Cloud Code (see §4.2)                                                   |
| Backend workflow        | `Parse.Cloud.define` / `beforeSave` / `afterSave`                                                 |
| Scheduled workflow      | Back4App **Cloud Jobs** (`Parse.Cloud.job`) + dashboard schedule                                  |
| "Do every 10 s" refresh | Polling today; move to **LiveQuery** (enable it on the Parse app, set `VITE_PARSE_LIVEQUERY_URL`) |
| Privacy rules           | Class-Level Permissions (CLP) + per-object ACL + role checks in cloud functions                   |
| OneSignal               | Web Push (VAPID) or OneSignal via Cloud Code HTTP                                                 |
| PDF Conjurer / CSV      | Server-side HTML email or PDF from a Cloud Job; client CSV export (exists for orders)             |

### Can't sign in as owner? (recovery)

The in-app "First owner? Create account" link only appears while the database
has **no** accounts. If accounts already exist (for example from earlier
testing), or the owner password is lost, create or reset an owner with the
**master key**. This works even when accounts exist and never touches other
users. Use one of these:

- **Dashboard job:** Back4App dashboard → Cloud Code → Jobs → schedule/run
  `createOwner` with parameters
  `{"username": "owner", "password": "a-long-password", "email": "you@example.com", "name": "Your Name"}`.
- **REST (API console or curl)** with the app id and master key from App
  Settings → Security & Keys:

  ```
  curl -X POST https://<your-app-domain>/parse/functions/recoverOwner \
    -H "X-Parse-Application-Id: <APP_ID>" \
    -H "X-Parse-Master-Key: <MASTER_KEY>" \
    -H "Content-Type: application/json" \
    -d '{"username":"owner","password":"a-long-password","email":"you@example.com"}'
  ```

If the username exists, its password is reset and it is made an owner.
Otherwise a new owner account is created. Then sign in, open **Team**, and
create riders and cashiers (username + PIN) to test their flows.

If the sign-in screen shows "Can't reach the Relay server functions", the Cloud
Code is not running: check that the whole `cloud/` folder (including `lib/` and
`package.json`) was deployed and look at the Parse server logs for load errors.
---

## 3. Current state inventory (what exists)

### 3.1 Files

| File                                  | Purpose                                                                                     | State                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/App.tsx`                         | Router, role guards, owner-setup / no-access screens, preview role switcher                 | Routes by server role from `getMyProfile`                                    |
| `src/lib/session.tsx`                 | `SessionProvider`, `useSession`, `useConfig`, `useMoney`, `homePath`                        | Loads `getAppInfo` + `getMyProfile` once; logs out on an invalid session     |
| `src/lib/format.ts`, `people.ts`      | `formatMoney`, timezone-aware `isToday` / `formatDate` / `greeting`, `personLabel`          | Unit-tested                                                                  |
| `src/components/AuthScreen.tsx`       | Username + PIN login, owner sign-up (only while no accounts exist), Google, preview         | Works                                                                        |
| `src/components/RiderWorkspace.tsx`   | `/rider`, `/rider/new`, `/rider/active`, `/rider/cash`, `/rider/earnings`, `/rider/profile` | Real data; earnings list is "recent" (last 100 orders) only                  |
| `src/components/NewOrder.tsx`         | Order entry: name, address, menu grid, cart, place                                          | Minimal: no phone, channel, payment, notes, qty dialog or commission preview |
| `src/components/CashierWorkspace.tsx` | `/cashier` board, `/cashier/handovers`, `/cashier/shift`                                    | Tickets show rider code/name and item lines; live pending-handover badge     |
| `src/components/CashierHandovers.tsx` | Pending handovers, count-cash modal, confirm / dispute                                      | Works                                                                        |
| `src/components/ShiftPanel.tsx`       | Start / end shift for rider & cashier; cashier till variance                                | Works                                                                        |
| `src/components/AdminWorkspace.tsx`   | `/admin/{,orders,cash,commissions,team,menu,settings}`, dispute "reopen"                    | Basic; KPIs still computed client-side from the last 100 orders (B7)         |
| `src/components/AdminOrders.tsx`      | Searchable order table + CSV export                                                         | Basic; no filters or detail view                                             |
| `src/components/AdminSetup.tsx`       | Team (with codes), menu, settings (incl. currency code, timezone), Apply security rules     | Works (limited fields)                                                       |
| `cloud/*.js`, `cloud/lib/*.js`        | Cloud Code modules (see 3.2)                                                                | Write-protected, tested end to end                                           |
| `e2e/relay.test.mjs`                  | End-to-end suite on a real Parse Server                                                     | 23 tests: owner setup, roles, write protection, order-to-cash, preview gate  |
| `src/lib/googleSignIn.ts`             | Back4App managed Google OAuth                                                               | Platform boilerplate                                                         |

Every screen has a URL (deep links work; nginx falls back to `index.html`).
Riders can only open `/rider/*`; cashiers `/cashier/*`; admins `/admin/*` and
`/cashier/*`. Anything else redirects to the user's home.

### 3.2 Cloud Code (`cloud/`)

| Module                         | Contents                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`                      | Entry point; only `require`s the modules below                                                                                                                      |
| `lib/core.js`                  | `requireUser`, `getRoleName`, `requireRole`, `adminOnly`, `ensureRole`, `readAcl`, `userAcl`, `audit`, `loadConfig`, `nextDailyCode`, `nextStaffCode`, `countUsers` |
| `lib/money.js`, `lib/dates.js` | Pure, unit-tested: `computeCommission`, `roundCommission`, `sumBy`; `dateKey`, `isValidTimeZone`                                                                    |
| `lib/seed.js`                  | Starter menu                                                                                                                                                        |
| `security.js`                  | Write guards, `_User` rules, class schemas + CLPs, `applySecurity` job and `adminApplySecurity`                                                                     |
| `profile.js`                   | `getAppInfo` (public), `getMyProfile`                                                                                                                               |
| `orders.js`                    | `createOrder`, `transitionOrder`, `getOperationalMenu`, `riderFloat`                                                                                                |
| `cash.js`                      | `createHandover`, `confirmHandover`, `disputeHandover`, `reopenHandover`                                                                                            |
| `shifts.js`                    | `getMyShift`, `startShift`, `endShift`                                                                                                                              |
| `admin.js`                     | `bootstrapOwner`, `adminListSetup`, team, menu, settings                                                                                                            |
| `preview.js`                   | Demo functions, only when `RELAY_ENABLE_PREVIEW=true`                                                                                                               |

`cloud/package.json` marks the folder as CommonJS (the root package is ESM).

| Function                                                             | Who                  | What it does now                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createOrder`                                                        | rider                | Validates name, address, channel, payment method and items against `MenuItem` (active + availableToday, qty 1–50). Blocks if the rider has an in-flight order (unless `allowBatching`) or current float ≥ `maxRiderFloat`. Prices from the DB, snapshots on `OrderItem`, code `ORD-YYYYMMDD-0001`, read-only ACL, audit |
| `transitionOrder`                                                    | staff / owning rider | `accept`, `prepare`, `ready` (staff); `pickup`, `deliver` (rider or staff). On deliver: amount ≥ total, commission (per_order / percent / hybrid on subtotal, `Math.round`), cashStatus → `WITH_RIDER` for cash                                                                                                         |
| `createHandover`                                                     | rider                | Selected own DELIVERED + WITH_RIDER orders → `CashHandover` (pending), orders → `HANDOVER_PENDING`                                                                                                                                                                                                                      |
| `confirmHandover`                                                    | cashier / admin      | Counted amount must **equal** the claim. Orders → `RECONCILED`, handover → confirmed                                                                                                                                                                                                                                    |
| `disputeHandover`                                                    | cashier / admin      | Reason (≥ 5 chars) + counted amount → handover `disputed`. Orders stay HANDOVER_PENDING                                                                                                                                                                                                                                 |
| `reopenHandover`                                                     | admin                | disputed → pending with a resolution note (the only resolution path today)                                                                                                                                                                                                                                              |
| `bootstrapOwner`                                                     | first user           | If there is no admin role and exactly one user exists → make them admin, create roles, seed 6 menu items, run `applySecurity`                                                                                                                                                                                           |
| `recoverOwner` / job `createOwner`                                   | master key only      | Create an owner, or reset an existing account's password and make it owner (recovery; see §2)                                                                                                                                                                                                                           |
| `getAppInfo`                                                         | anyone               | Restaurant name, currency, timezone, whether owner sign-up is open, whether preview is enabled                                                                                                                                                                                                                          |
| `getMyProfile`                                                       | signed in            | Role (roles are not client-readable), name, code, commission rule, `canInitialize`, public config                                                                                                                                                                                                                       |
| `adminApplySecurity` / job `applySecurity`                           | admin / dashboard    | Create class schemas + CLPs, rewrite ACLs, assign staff codes                                                                                                                                                                                                                                                           |
| `adminListSetup`                                                     | admin                | Team (≤ 1000 users) with roles and codes, menu, categories, settings                                                                                                                                                                                                                                                    |
| `adminCreateTeamMember`                                              | admin                | Creates a rider or cashier user (PIN = password), private ACL, code `R-001` / `C-001`, adds the role                                                                                                                                                                                                                    |
| `adminUpdateMember`                                                  | admin                | active flag, commissionType / PerOrder / Percent                                                                                                                                                                                                                                                                        |
| `adminChangeRole`                                                    | admin                | Swap rider ↔ cashier                                                                                                                                                                                                                                                                                                    |
| `adminSaveCategory` / `adminSaveMenuItem` / `adminSaveSettings`      | admin                | CRUD with audit                                                                                                                                                                                                                                                                                                         |
| `getOperationalMenu`                                                 | signed in            | Active + available items, delivery fee, currency                                                                                                                                                                                                                                                                        |
| `getMyShift` / `startShift` / `endShift`                             | rider / cashier      | Shift rows. Rider end needs acknowledgment if float > 0; cashier end computes expected till + variance                                                                                                                                                                                                                  |
| `createPreviewOrder` / `getPreviewOrders` / `transitionPreviewOrder` | anyone, if enabled   | Demo data in `DemoOrder`; refused unless `RELAY_ENABLE_PREVIEW=true`                                                                                                                                                                                                                                                    |

**Access model.** Business classes (`Order`, `OrderItem`, `CashHandover`,
`Shift`, `AuditLog`, `Configuration`, `MenuItem`, `MenuCategory`, `Counter`,
`DemoOrder`) have `beforeSave`/`beforeDelete` guards that reject any non-master
write, plus CLPs with no client create/update/delete/addField. ACLs are read-only:
orders, items and handovers → owning rider + cashier + admin; shifts → operator +
admin; menu, config and audit → admin. `_User`: self read/write, admin
read/write, and cashier read on riders. A client `_User` save may only change
`password` or `email`.

### 3.3 Parse classes as actually used

| Class           | Fields in use                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_User`         | username, password (= PIN), email (owner), name, phone, active, commissionType, commissionPerOrder, commissionPercent, riderCode, cashierCode                                                                                                                             |
| `_Role`         | `admin`, `cashier`, `rider` (ACL: admin read/write only)                                                                                                                                                                                                                  |
| `Order`         | orderCode, channel, createdBy, customerName, customerPhone, deliveryAddress, subtotal, deliveryFee, total, paymentMethod, amountCollected, paymentCollectedBy, status, restaurantStatus, cashStatus, commissionAmount, commissionPaid, pickedUpAt, deliveredAt, settledAt |
| `OrderItem`     | order, itemNameSnapshot, unitPriceSnapshot, quantity, lineTotal, notes                                                                                                                                                                                                    |
| `CashHandover`  | handoverCode, rider, cashier, amount, countedAmount, orderCount, orders (array of pointers), status, handedOverAt, confirmedAt, disputedAt, disputeReason, notes, resolutionNote, resolvedBy, resolvedAt                                                                  |
| `MenuCategory`  | title, active, sortOrder                                                                                                                                                                                                                                                  |
| `MenuItem`      | title, price, category (**string**, not a pointer), active, availableToday, sortOrder                                                                                                                                                                                     |
| `Configuration` | restaurantName, currencySymbol, currencyCode, timezone, defaultDeliveryFee, maxRiderFloat, allowBatching, commissionRounding (server default `none`, no UI yet)                                                                                                           |
| `Counter`       | key (`ORD:20260925`, `HO:20260925`, `staff:R`, `staff:C`), value                                                                                                                                                                                                          |
| `Shift`         | operator, kind (rider / cashier), status (open / closed), openingFloat, startedAt, endedAt, closingFloat, acknowledgedCash, expectedTill, physicalCount, variance                                                                                                         |
| `AuditLog`      | actor, action, entityType, entityId, beforeJson, afterJson                                                                                                                                                                                                                |
| `DemoOrder`     | preview-only                                                                                                                                                                                                                                                              |

The field list for each class is defined in `SCHEMAS` in `cloud/security.js`.
Add new fields there too.

**Not yet created:** `Customer`, `CommissionPayout`, `TillPayout`,
`Notification`, `MenuItemOption`, `ZReport`.

### 3.4 Screen coverage vs. brief

Legend: ✅ done · 🟡 partial · ❌ missing

**Rider**

| Brief screen                    | State | Notes                                                                                                                                                                                                                                     |
| ------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home dashboard                  | ✅    | Name, code, greeting and date in the restaurant timezone, limit bar from `maxRiderFloat`, today's earnings. Nav: Home / Active / New / Cash / Earnings; profile via the avatar                                                            |
| New order                       | 🟡    | Missing: phone, channel pills, delivery notes, map pin, qty/notes dialog, payment pills, amount collected, bill block, commission preview, type-ahead, re-order, draft. The parent hard-codes `channel: walkin` and `paymentMethod: cash` |
| Active orders                   | 🟡    | List + Pick up / Deliver. No Cancel, no tap-through                                                                                                                                                                                       |
| Order detail `/rider/order/:id` | ❌    | No detail, no Google Maps link, no delivery form (deliver sends `amountCollected = total`)                                                                                                                                                |
| My cash                         | 🟡    | List + multi-select handover. No grouping by date, no over-limit colour, no notes field. Pending handovers not shown                                                                                                                      |
| Handover                        | 🟡    | Inline on the cash screen. No PIN, no "waiting for cashier" state list                                                                                                                                                                    |
| Earnings                        | 🟡    | All-time only (last 100 orders). No Today/Week/Month/Custom, average or payout request                                                                                                                                                    |
| Profile                         | 🟡    | Name, code, username, phone, commission rule, logout. No change PIN yet                                                                                                                                                                   |
| Shift start/end                 | ✅    | End with cash does **not** create the pending handover the brief asks for                                                                                                                                                                 |

**Cashier**

| Brief screen | State | Notes                                                                                                                                 |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Live board   | 🟡    | Rider code/name and item lines shown; live handover badge. Reject disabled. No notes, age timer, channel or payment. Polls every 10 s |
| Handovers    | ✅    | No search by rider or handover code. No partial acceptance                                                                            |
| Shift / till | 🟡    | Expected till ignores cash paid out (no payouts model)                                                                                |
| Profile      | ❌    |                                                                                                                                       |

**Admin**

| Brief screen                       | State | Notes                                                                                                               |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| Overview                           | 🟡    | 4 KPIs + feed. No top rider, no charts, "cash reconciled today" missing                                             |
| Orders                             | 🟡    | Search + CSV. No filters (date, rider, status, channel), no detail/override, max 100 rows                           |
| Riders list/detail                 | ❌    | Only the Team list with commission editor. No float, lifetime stats, per-rider max float, force handover or history |
| New rider / cashier                | ✅    | In Team, with auto codes `R-001` / `C-001`. No email                                                                |
| Menu                               | 🟡    | No description, image, prep time, sort, delete. Category is a free string                                           |
| Cash ledger                        | 🟡    | List + reopen dispute. No filters, totals, > 4 h highlight, write-off or amount edit                                |
| Commissions                        | 🟡    | Read-only list. No paid toggle, bulk pay or owed total                                                              |
| Settings                           | 🟡    | 7 of about 14 config fields, plus Apply security rules                                                              |
| Audit viewer                       | ❌    | Data is written but there is no UI                                                                                  |
| Reports (Z, rider, item, variance) | ❌    |                                                                                                                     |

---

## 4. Conventions & decisions (follow these)

### 4.1 Architecture rules

1. **Every state-changing action goes through a Cloud function.** The client may
   _read_ with `Parse.Query` where the ACL allows, but never `.save()` business
   objects directly. Enforced by `cloud/security.js` (guards + CLPs + ACLs).
   New business classes go into `PROTECTED_CLASSES` and `SCHEMAS` there.
2. **The rider float is derived, not stored.** Today it is computed as the sum of
   `amountCollected` over DELIVERED orders with cashStatus `WITH_RIDER` or
   `HANDOVER_PENDING` (`riderFloat` in `cloud/orders.js`). **Keep it derived**, so it can't drift
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
   `shift.started|closed`, `security.applied`.
6. **Store UTC and display in the restaurant timezone** (`Configuration.timezone`,
   default `Africa/Kampala`). Server: `dateKey()` in `cloud/lib/dates.js`.
   Client: `isToday` / `formatDate` in `src/lib/format.ts`. Dashboards should move
   "today" maths to the server (B7).
7. **Currency comes from `Configuration`.** Use `useMoney()` in components; never
   hard-code a symbol. Numbers always use the `en-US` grouping.
8. **Roles come from the server.** Roles are not client-readable; the app asks
   `getMyProfile`. Cloud functions check roles with `requireRole(request, [...])`.
9. **Sequential codes** come from `nextDailyCode` / `nextStaffCode` (atomic
   `Counter`), never from timestamps.
10. **Every change keeps `npm run check` and the e2e suite green.** Add an e2e
    test for every new Cloud function, including the roles that must be refused.

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

- [x] **S1 P0 — Riders can edit their own orders and handovers directly.** _Fixed in Phase 0: guards + CLPs + read-only ACLs; e2e-tested._
      `orderAcl(user)` gives the rider _write_ access on `Order`, `OrderItem`,
      `CashHandover` and `Shift`, so a rider can `PUT /classes/Order/:id` from the
      browser and change `cashStatus`, `amountCollected`, `commissionAmount` and so
      on. Fix: ACL owner = **read only**; set CLPs on all business classes to
      _no create/update/delete for clients_ (only master key / cloud writes); read
      via role-scoped CLP + ACL.
- [x] **S2 P0 — Unauthenticated cloud functions.** _Fixed: preview behind `RELAY_ENABLE_PREVIEW` / `VITE_ENABLE_PREVIEW`; menu needs sign-in._ `createPreviewOrder`,
      `getPreviewOrders` and `transitionPreviewOrder` let anyone write rows, and
      `getOperationalMenu` exposes the menu. Remove preview mode from the production
      build (or gate it behind a feature flag + rate limit) and require auth on
      `getOperationalMenu`.
- [x] **S3 P0 — Open sign-up.** _Fixed: client sign-up only while the database has no users; Google/other accounts get no role ("No access" screen). Remaining risk: someone signs up before the owner on a brand-new deploy, so follow the release checklist (§2)._ Anyone can `signUp` (owner-creation form, Google
      sign-in). On a fresh deploy, whoever signs up first can call `bootstrapOwner`.
      Fix: disable client class creation and public sign-up in Back4App app
      settings; create the owner with a one-time setup token or a master-key script.
      Decide whether Google sign-in stays (owner only?).
- [x] **S4 P1 — `_User` objects are publicly readable** _Fixed: private ACLs on create; `applySecurity` rewrites existing users._ (Parse default ACL), which
      exposes phone and commission fields. Set the user ACL to self + admin (+
      cashier read if needed) in `adminCreateTeamMember` and in a `beforeSave(_User)`.
- [ ] **S5 P1 — A 4-digit PIN can be brute-forced.** (Server setting; see §2.) Enable Parse `accountLockout`
      (for example 5 attempts / 15 min) and a minimum PIN length of 4–6. Keep PINs
      numeric only.
- [ ] **S6 P1 — No PIN re-entry** for handover, profile changes or shift end.
      Add a `verifyPin` cloud function and a short-lived step-up token.
- [ ] **S7 P1 — Session policy.** Configure Parse `sessionLength` to 30 days for
      riders and cashiers. Consider a shorter session for admin. (Server setting;
      see the release checklist in §2.)
- [x] **S8 P0 — Riders could raise their own commission.** Found in Phase 0: a
      rider could `save()` their own `_User` with a new `commissionPerOrder`,
      `active` or role-related field. _Fixed: `beforeSave(_User)` allows clients to
      change only `password` and `email`._

### Correctness (B)

- [x] **B1 P0 — Riders and cashiers can't read their own role.** _Fixed: `getMyProfile` + routes guarded by role._ `ensureRole`
      gives roles an admin-only read ACL, so `App.tsx`'s `Parse.Query(Parse.Role)`
      returns nothing for non-admins. **Cashiers get the rider UI** and every
      non-admin sees the "Initialize owner" banner. Fix: add a `getMyProfile` cloud
      function that returns `{role, name, riderCode, …}` and use it in `App.tsx`.
- [ ] **B2 P1 — Float limit checks the current float, not the float after the
      order.** It should block when `currentFloat + (cash order total) > maxRiderFloat`
      (brief §5.1), with a per-rider override.
- [x] **B3 P1 — Order and handover codes can collide.** _Fixed: `Counter`-based `ORD-YYYYMMDD-0001`, `HO-YYYYMMDD-001`, `R-001`, `C-001` (daily codes use the restaurant timezone)._ `Date.now().slice(-4 / -6)`
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
- [ ] **B7 P2 — "Today" is computed on the client** (now in the restaurant timezone, but still only over on client-loaded rows
      the last 100 orders). Move KPIs to a server `getDashboard` function.
- [ ] **B8 P2 — The home "Cash on me" tile** counts WITH_RIDER + HANDOVER_PENDING,
      while the Cash screen lists WITH_RIDER only. Show pending handovers as a
      separate section so the numbers reconcile on screen.
- [ ] **B9 P2 — `NewOrder` requires an address**, while the brief only requires a
      name (address is expected for delivery). Decide: required for delivery, optional
      for walk-in pickup.

### Leftover preview / mock UI (U)

- [x] U1 — Hard-coded `initial` tickets in `CashierWorkspace` render before the first load.
- [x] U2 — Hard-coded "Tuesday · Rider R-014", "Amina", "AK", 34% limit bar, handover badge "2".
- [x] U3 — The preview role switcher nav + "Preview roles" button show in production.
- [x] U4 — The `SAMPLE` menu in `NewOrder` and the `MENU` seed in Cloud Code are for demos only. _(Demo-only paths are now behind the preview flags; the seed menu lives in `cloud/lib/seed.js`.)_
- [x] U5 — `UGX` is hard-coded in about 10 places.
- [ ] U6 P2 — Preview only: two simultaneous first loads of `getPreviewOrders` both seed the demo tickets, so they show twice. Seed idempotently (fixed codes + existence check).

---

## 6. Target data model (additions to what exists)

Only the **deltas** from §3.3 are listed here.

- **`_User`**: `role` (a mirror of the Parse Role, for display), `hybridBase` (or reuse `commissionPerOrder` as the base — decide
  and document), `maxFloatOverride`, `available`, `lifetimeDeliveries`,
  `lifetimeCommission` (maintained in `deliver`), `currentShift` pointer.
  _(Or split these into `RiderProfile` / `CashierProfile` classes; recommended
  only if user reads must stay restricted.)_
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
- **`Notification`** (new, optional): `user`, `type`, `title`, `body`, `entity`,
  `readAt`, for the in-app bell and for push delivery.
- **`ZReport`** (new): `date`, a totals JSON, `sentTo`, `generatedAt`.
- **`Configuration`** add: `defaultCommissionType`, `defaultCommissionPerOrder`,
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
- [x] B1 `getMyProfile` cloud function; `App.tsx` routes by server role; owner setup screen only when the server says it applies
- [x] S1 guards + CLPs + read-only ACLs on every business class; schema defined in code (`SCHEMAS` in `cloud/security.js`) and applied by `applySecurity`
- [x] S2 / U3 / U4 Preview mode behind `RELAY_ENABLE_PREVIEW` (server) and `VITE_ENABLE_PREVIEW` (build)
- [x] S3 Close public sign-up; one-time owner setup
- [x] S4 User ACLs (+ S8 self-edit guard)
- [ ] S5 account lockout; S7 session length: Back4App server settings, see the release checklist in §2
- [x] Split Cloud Code into modules, readable formatting, shared `loadConfig()`
- [x] `react-router-dom` routes (`/rider/*`, `/cashier/*`, `/admin/*`) with role guards. `/rider/order/:id` comes with the order detail screen in Phase 1
- [x] Shared `formatMoney`, `useConfig`, `useMoney`, `useSession`; U1–U5 removed
- [x] Tooling: ESLint + Prettier + Vitest, e2e suite on a real Parse Server, GitHub Actions CI
- [x] Sequential codes via `Counter` (B3)

### Phase 1 — Orders complete

- [ ] New-order screen per brief §5.1: customer block (name, phone, channel pills), address + landmark notes, "Pin on map" (Google Maps / Leaflet, optional), category tabs, long-press qty/notes dialog, sticky cart, collapsible bill (editable fee), payment pills, amount collected, commission preview ("You'll earn X")
- [ ] Validation: shortfall needs an override note; B2 float-after-order check with a link to the handover screen
- [ ] Pass the real `channel`, `paymentMethod`, `customerPhone`, `deliveryNotes`, and line `notes` through `createOrder`
- [ ] `Customer` upsert + `searchCustomers(q)` (top 5 by orderCount) + address type-ahead + "Repeat last order"
- [ ] Order detail screen: header, customer, tap-to-map address, items, bill, a sticky cash bar, and one status-dependent action
- [ ] Delivery confirmation form (amount collected, payment confirmation, optional photo v2)
- [ ] `cancel` (rider, PLACED) and `reject` (cashier, with reason) transitions + UI
- [ ] Cashier ticket shows item notes, age timer, channel, payment (rider name/code and item lines done in Phase 0)
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

- [ ] Rider profile: change PIN (with old PIN). (Name, code, phone, commission rule and logout done in Phase 0)
- [ ] Cashier profile screen
- [ ] Admin rider detail: float, lifetime stats, per-rider max float, open orders, cash history, commission history, deactivate, reset PIN
- [ ] `available` toggle for the rider (auto codes done in Phase 0)
- [ ] Commission defaults from Configuration; `hybridBase` handling; rounding
- [ ] Update lifetime stats in `deliver`
- [ ] Extend `e2e/` to a full role/permission matrix: every function × every role (the harness and core cases exist)

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

| Date       | Change                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-25 | Initial review of the Back4App export; this roadmap created; `.gitignore` added. Typecheck + build pass.                                                                                                                                                                                  |
| 2026-09-25 | Phase 0: Cloud Code split + write protection (S1–S4, S8), `getMyProfile` + role routes (B1), sequential codes (B3), preview flags, config-driven money/timezone (U1–U5), ESLint/Prettier/Vitest, e2e suite (23 tests) and CI. S5/S7 need Back4App server settings.                        |
| 2026-09-25 | Deploy follow-up: master-key owner recovery (`recoverOwner` / job `createOwner`), sign-in shows when Cloud Code is unreachable, usernames no longer fail on phone auto-capitalisation.                                                                                                    |
| 2026-09-25 | Deployment fix: the Container served only a static frontend (no Parse), and `vite preview` blocked the b4a.run host. Frontend now reads `VITE_PARSE_SERVER_URL` / `VITE_PARSE_APP_ID` / `VITE_PARSE_JS_KEY`; backend runs as a Back4App Parse app; Node pinned to 22; deploy steps in §2. |
