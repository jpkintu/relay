# Relay Hosted: the multi-restaurant edition

Relay comes in two editions from one codebase:

|         | Self-hosted (`main`)                                | Hosted (`hosted`, this branch)                 |
| ------- | --------------------------------------------------- | ---------------------------------------------- |
| Who     | One restaurant, bought once, optional maintenance   | Many smaller restaurants, monthly subscription |
| Where   | Its own Back4App app (own database, own Cloud Code) | One shared Back4App app for every restaurant   |
| Sign-up | The first owner sets it up                          | Self sign-up with a free trial                 |
| Billing | None in the app                                     | Monthly, collected with ioTec Pay              |

`hosted` is the hosted edition's permanent home: a long-lived branch made from
`main` that is **never merged into `main`** (that would turn every self-hosted
restaurant into the multi-restaurant edition). Fixes and features for both
editions land on `main` first (pull request, green CI) and `main` is then
merged into `hosted` (`git merge main`), so both stay current. Only the
multi-restaurant parts live here. CI runs on every push to `hosted`; there is
no open pull request from `hosted` into `main`.

## How restaurants are kept apart

Every business record carries a `tenant` pointer to its `Restaurant`. The
isolation is enforced on the server, in one place, so no Cloud function can
forget it:

- **Request context.** Every Cloud function and job runs inside a tenant
  context (Node `AsyncLocalStorage`): the signed-in person's restaurant, or
  the restaurant named in a public request (sign-in screen), or none (platform
  functions).
- **Reads.** In a tenant context, every query on a restaurant's classes gets
  `tenant = <this restaurant>` added automatically (`cloud/lib/tenant.js`
  wraps `Parse.Query#toJSON`, which every find, first, count, get, each and
  sub-query goes through). A record of another restaurant cannot be found,
  counted or fetched by id.
- **Writes.** New records get the tenant set before they are saved.
- **Roles.** Each restaurant has its own roles (`admin__<id>`, `cashier__<id>`,
  `rider__<id>`). ACLs use them, so what a phone can read directly and what
  live updates it receives are limited to its own restaurant by Parse itself.
- **People.** Usernames are unique per restaurant: stored as
  `name@restaurant-code`, typed as just `name` on the restaurant's sign-in page.
- **Tests.** The e2e suite runs two restaurants side by side and checks that
  every function refuses or cannot see the other restaurant's data.

## Restaurants, trials and subscriptions

- `Restaurant`: name, code (used in its web address and usernames), trial end,
  paid-until date, monthly price override, the owner's billing phone, and a
  `suspended` switch.
- **Access is worked out from the dates every time** (`cloud/lib/access.js`),
  never kept as a stored status that a job must flip: the later of the trial
  end and the paid-until date, plus the grace days. Statuses: `trial`,
  `active`, `past_due` (grace days, still usable, warning shown), `expired`
  (staff cannot work; the owner can still reach the billing page and pay), and
  `suspended` (set by you, independent of billing; nothing is deleted).
- **Price.** One platform price (set in the platform console); any restaurant
  can have its own price, higher or lower, set by you.
- **Trial.** New restaurants get a free trial (length set in the console).
- **Billing (ioTec Pay).** The owner taps Pay on the billing page and approves
  the mobile money prompt on the billing phone (ioTec has no saved payment
  method: a person always approves). Each attempt gets its own unique
  reference (`externalId`). Pending payments are checked every few minutes
  until `Success` or `Failed`. A successful payment moves the paid-until date
  to one month after the later of today and the current paid-until date, so a
  late or repeated status answer can never shorten it. You can also record a
  payment by hand (cash, bank) with its reference. Reminders go to the owner
  before the paid period ends.
- **ioTec keys** live in the Back4App app's environment variables, not in the
  app: `IOTEC_CLIENT_ID`, `IOTEC_CLIENT_SECRET`, `IOTEC_WALLET_ID`, and
  optionally `IOTEC_ENV=sandbox` (test currency `ITX`) and `IOTEC_API_URL` /
  `IOTEC_AUTH_URL` if ioTec's addresses differ.

## Plans

Plans are set by platform staff in the console (Plans), stored in the `Plan`
class (Relay's own, not any restaurant's; `cloud/lib/plans.js`). Each has a
price a month, limits (branches, cashiers, riders, finance staff; empty = no
limit) and the parts of the app it includes (several branches, finance role,
purchases/expenses/accounting, reports & analytics, EFRIS, WhatsApp
summaries). Staff can create new plans and change any plan; a change applies
to its restaurants at once. A plan is never deleted: taken off offer, it is
no longer offered at sign-up or when owners change plan, and its restaurants
stay on it.

The first time plans are needed, two are made (owner's decision 2026-09-30):

| Plan       | Price a month | Limits and parts                                                                                  |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------- |
| Basic      | 100,000       | 1 branch, 2 cashiers, 5 riders, no finance; no purchases/expenses/accounting or Reports analytics |
| Enterprise | 200,000       | no limits, everything                                                                             |

- A restaurant chooses a plan at sign-up (the first on offer by default) and
  the owner switches under Subscription → Plans (`changePlan`; to a smaller
  plan only within its limits). The console can put a restaurant on any plan.
- A negotiated price (`priceOverride`) wins over the plan's price.
- Limits are checked when something is added (a branch, a member, a role
  change, a member switched back on); nothing a restaurant has is taken away.
  Parts left out are refused on the server (`lib/limits.js` → `features()`)
  and hidden in the app.

## Lessons carried over from Embiro BI

The Embiro BI platform (Superset, `Embiro-Concepts/embiro-bi`,
`superset/embiro/`) already keeps its tenants apart and bills them with ioTec.
What Relay Hosted takes from it:

- **A record without a restaurant is visible to nobody**, never to everybody.
  Scoped queries always carry `tenant = <this restaurant>`, so an unstamped
  row cannot leak.
- **Stamp the tenant automatically on create** from the caller's context,
  unless already set (`tenant_scoping.py`'s before-insert hook; here the
  `save` wrapper in `cloud/lib/tenant.js`). Existing records keep theirs.
- **Access from dates, checked live** (`Organization.has_valid_subscription`),
  and a separate platform on/off switch (`is_active`), as above.
- **One enforcement point with an allow-list** (`paywall.py`): sign-in,
  sign-out, the profile, the billing page and payments stay reachable when a
  restaurant is expired; the owner lands on the billing page, other staff on
  an explanation that the owner must renew.
- **Platform staff belong to no restaurant** and are recognised by an
  explicit check (`requirePlatform`), not by a role that could bypass the
  scoping.
- **ioTec:** fetch a fresh token for every call (tokens last 300 s), from
  `https://id.iotec.io/connect/token` with the client-credentials grant
  (form-encoded); `payerNote` is what the payer sees, so it names what is
  being paid for; poll status because no webhook is documented.

## ioTec Pay API (as used for billing)

From ioTec's documentation (<https://iotec.io/api-docs/pay>):

- **Token.** `POST https://id.iotec.io/connect/token`, form-encoded
  `client_id`, `client_secret`, `grant_type=client_credentials` →
  `access_token` (valid 300 s), sent as `Authorization: Bearer <token>`.
- **Collect.** `POST https://pay.iotec.io/api/collections/collect` with
  `{ category: "MobileMoney", currency: "UGX" (or "ITX" in the sandbox),
walletId, externalId (our invoice id, ≤100 chars), payer (MSISDN), payerName,
payerNote, payeeNote (≤100 chars each), amount (≥ 500),
transactionChargesCategory: "ChargeWallet" }`. The reply carries the
  transaction `id` and `status`.
- **Status.** `GET https://pay.iotec.io/api/collections/status/{id}`: `status`
  is `Pending` until the payer approves (`Success`) or declines or the request
  times out (`Failed`); `statusMessage` says why, `vendorTransactionId` is the
  mobile money reference.
- Card collections (`POST …/collect/card`, payer = e-mail, `redirectUrl`) are
  not used yet.

## Platform console

Relay's own staff sign in at `/platform` with a platform account (no
restaurant). To create one (running it again resets the password):

1. App Settings → Environment Variables: `RELAY_PLATFORM_USERNAME` (lowercase
   letters, digits, `.` `-` `_`), `RELAY_PLATFORM_PASSWORD` (10+ characters),
   optionally `RELAY_PLATFORM_NAME`.
2. Cloud Code → Jobs → `createPlatformAdmin` → **Run now**. Its status reads
   "Platform account ready: …".
3. Remove `RELAY_PLATFORM_PASSWORD` once you can sign in.

Or, with the master key, call the function `createPlatformAdmin` with `{
"username": "…", "password": "…", "name": "…" }` (API console → REST → POST
`functions/createPlatformAdmin`, Use Master Key).

The console shows every restaurant's name, code, owner, billing phone, status,
trial or paid-until date, price, staff count and orders in the last 30 days,
never its orders, customers or money. For each restaurant you can set its own
price (empty = the platform price), move the trial end, set the paid-until date
("+ one month" for a payment received by hand), suspend or lift a suspension,
and keep a private note. Platform settings: monthly price, currency, trial
days, grace days and the support contact restaurants see. Every change is
logged under Recent changes.

**After each upload of `main.js`:** console → **Apply security rules to all
restaurants**, once. It adds new database fields and class permissions (shared
by the whole app, done on the first step), then re-applies record permissions,
staff codes and repairs for each restaurant in turn, suspended ones included,
with progress; a restaurant that fails is listed and the rest carry on
(`platformApplySecurity`, one restaurant per call; audited). Restaurants do
not need to do anything; their own "Apply security rules" button only redoes
their records.

**Errors.** Console → Errors lists problems from every restaurant, and from
the sign-in screen, the console and jobs, with a filter per restaurant. The
same problem in several restaurants is one entry (grouped by fingerprint),
with its total count and the restaurants it hit. Once the fix is deployed,
**Mark fixed** marks it fixed in each of those restaurants too; their own
Admin → Errors page shows it fixed "by Relay". If it happens again it comes
back as open (`platformListErrors`, `platformResolveErrors`; audited).

**Owner locked out?** Console → the restaurant → **Reset owner password**
gives the owner account a new password (shown once; read it out to them) and
signs it out everywhere. They can change it under their profile.

**Terms.** `/terms` shows Relay's terms for restaurants (trial, price, grace
days, payments, their data, your support contact); the sign-up form links to
it. Have the text checked against the law that applies before relying on it.

**Receipts.** Every paid subscription payment has a printable receipt
(Receipt, on the owner's Past payments and in the console's payment list).

**What restaurants see.** During the grace days everyone gets a banner (the
owner: renew within N days). Expired: staff see that the owner must renew; the
owner can still sign in and sees the price and how to renew. Suspended: nobody
can sign in. The server enforces all of this (`checkAccess` in
`cloud/restaurants.js`, called for every function; `beforeLogin` for
suspensions); only sign-in details, the profile, PIN changes, sign-out and crash
reports stay open.

## Billing (phase 3)

**Owner.** Admin → **Billing** holds everything about the subscription: the
plan, its status and paid-until date, the monthly and annual price, the
payment form, the plan cards (with a **Monthly / Annual** switch), the account
email and the **invoices**: one paid invoice per payment received, plus the
next month's invoice (unpaid, then overdue) from 14 days before the paid month
ends. Each invoice downloads as a PDF (the browser's print to PDF). The
Overview shows a short notice with **Billing** / **Pay now** only when
something needs doing: a trial, a payment due within 7 days or overdue, or no
owner email. When the restaurant has expired, the owner signs in to the same
payment form. Choose 1, 3, 6 or 12 months (12 months is "1 year" at the annual
price) and the mobile money number, tap Pay, approve the prompt on the phone;
the page follows it and opens the app as soon as ioTec says Success.

**Annual price.** Paying a year at once costs the plan's annual price: by
default 10 months (two months free). Platform staff can set a plan's own
"Price for a year" in the console (empty = the 10-month default). A restaurant
with a negotiated monthly price pays 10 of those months for a year.

**Server** (`cloud/billing.js`, `cloud/lib/iotec.js`):

- `getBilling`, `startSubscriptionPayment { months, phone }`,
  `checkSubscriptionPayment { id }` (the owner; open while expired).
- One `SubscriptionPayment` row per attempt with its own `externalId`; one
  waiting prompt at a time; a prompt nobody approves is given up after 30
  minutes.
- A successful payment moves `paidUntil` on by its months from the later of
  today, the trial end and the current paid-until date, exactly once (a
  claim guards against two checks at the same moment).
- `platformRecordPayment { id, months, amount?, reference? }` records money
  received by hand the same way; `platformListPayments { id? }`.
- The **`billing` job** (optional; the same runs on the owner's app activity)
  follows up waiting payments and reminds owners (in the app and by push) 3 days before the trial or paid month ends and during the
  grace days, once per date.

**Setting it up on Back4App** (the hosted app):

1. App Settings → Environment variables: `IOTEC_CLIENT_ID`,
   `IOTEC_CLIENT_SECRET`, `IOTEC_WALLET_ID` from your ioTec account; for
   testing also `IOTEC_ENV=sandbox` (ITX test currency; pay from an ioTec test
   number such as 256111777777, real numbers are refused). Remove it to take
   real money. Without the three keys the owner is told to contact you.
2. Scheduled jobs are optional (Back4App's scheduler is a paid feature).
   Without them, each restaurant's waiting payments and reminders are followed
   up whenever its owner has the app open (at most every 5 minutes), and its
   daily upkeep (cash check, retention) runs on the first staff activity of
   the day. Scheduling **`billing`** every 5 minutes and `cashCheck` /
   `dailyZReport` nightly also covers restaurants nobody opens.
3. Platform console → Platform settings: your price, currency (UGX), trial and
   grace days and the support contact.

## Phases

1. **Tenancy core** (done): context, scoped reads and writes, per-restaurant roles,
   usernames, per-restaurant sign-in page, sign-up with trial, isolation tests.
2. **Platform console** (done): restaurants list, price overrides, trial and
   paid-until dates, suspension, platform settings, the access gate.
3. **Billing** (done): ioTec collection requests and status checks, the
   `billing` job and reminders, manual payments, the owner's payment form.

## WhatsApp summaries

Platform console → **WhatsApp sender** connects one WhatsApp Business app for
every restaurant: the phone number ID, a system-user access token that never
expires, an approved Utility template whose body has one variable (for example
"Daily summary: {{1}}"; the variable starts with the restaurant's name), the
template language and the number shown to restaurants. _Send a test_ checks it.
Once it is switched on, Admin → WhatsApp in each restaurant only asks for the
numbers that receive the nightly summary (`cloud/lib/whatsappSender.js`,
`cloud/platformWhatsapp.js`). Until then, a restaurant can still connect its
own WhatsApp app there.

## Owner email and password reset

Sign-up asks for the owner's email (`Restaurant.ownerEmail`). Relay writes to
it through the email service set in Platform console → **Email** (Resend or
Brevo: API key, sending address on a verified domain, sender name, and the
app's address for links; _Send a test_ checks it). It sends:

- **Forgot password**: on the sign-in page, "Owner? Forgot your password"
  asks for the email; if it is the restaurant's owner email, a link valid for
  one hour is emailed (`/?reset=…`; only its hash is kept). The link sets a
  new password and signs the owner out everywhere. The answer never says
  whether the email matched. Riders and cashiers still get new PINs from the
  owner; platform staff can still reset an owner by hand.
- **Welcome** after sign-up, with the restaurant code and username.
- **Billing reminders**: 7 and 3 days before the trial or paid period ends
  (`billing_due_soon`), on the last day (`billing_due_today`), once it has
  ended (`billing_overdue`, during the grace days) and again the day before
  the app closes. Each goes once per stage and end date. They are sent when the
  `billing` job runs, or when the owner has the app open.
- **Payment received** with the invoice number, the period and the paid-until
  date, whenever a payment is settled (in the app or recorded by hand).

### Email templates (Resend or Brevo)

Every email has Relay's own designed HTML and text (`cloud/lib/emailTemplates.js`)
and goes out as is unless platform staff point it at a template of their own
in Platform console → Email → **Templates**:

| Kind                | Sent                                    | Variables (besides OWNER_NAME, RESTAURANT_NAME, SUPPORT_LINE)                                               |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `welcome`           | after sign-up                           | RESTAURANT_CODE, USERNAME, PLAN_NAME, TRIAL_DAYS, TRIAL_ENDS, SIGN_IN_URL                                   |
| `password_reset`    | forgot password                         | RESET_URL, EXPIRES_IN                                                                                       |
| `billing_due_soon`  | 7 and 3 days before the end             | HEADLINE, DAYS_LEFT, PLAN_NAME, AMOUNT, ANNUAL_AMOUNT, DUE_DATE, INVOICE_NUMBER, BILLING_URL                |
| `billing_due_today` | the last day                            | HEADLINE, PLAN_NAME, AMOUNT, ANNUAL_AMOUNT, DUE_DATE, INVOICE_NUMBER, BILLING_URL                           |
| `billing_overdue`   | after the end, and the day before close | HEADLINE, CLOSES_ON, DAYS_TO_CLOSE, PLAN_NAME, AMOUNT, ANNUAL_AMOUNT, DUE_DATE, INVOICE_NUMBER, BILLING_URL |
| `payment_received`  | a payment is received                   | PLAN_NAME, AMOUNT, PERIOD, PAID_UNTIL, INVOICE_NUMBER, REFERENCE, BILLING_URL                               |

**Setting one up in Resend** (Templates → Create template):

1. Upload or paste the HTML: _Copy HTML_ in the console, or the file in
   `docs/email-templates/resend/<kind>.html`.
2. Subject: the one shown in the console (e.g. `{{{RESTAURANT_NAME}}}: {{{HEADLINE}}}`).
   From can stay empty: Relay sends from the console's sender.
3. Add each variable in the table above (type string; a fallback is
   optional, Relay always sends every one). Publish the template.
4. Copy its ID or alias into the kind's box in the console. Enter your
   address in **Send tests to** and click **Send test** on that row: it sends
   example values through the ID in the box (saved or not) and says on the
   row whether the service took it. Then **Save templates**.

Relay then sends `template: { id, variables }` instead of its own body;
variable values are plain text, already formatted (`UGX 100,000`, `15 October 2026`).
For **Brevo**, use `docs/email-templates/brevo/` (its `{{ params.NAME }}`
syntax) and enter the template's number. An empty box goes back to Relay's
own copy. `npm run email:templates` rewrites the docs files after changing
the built-in emails (a unit test fails while they differ).

### Invoices and receipts

Admin → Billing lists the invoices; each opens as a printable page (save as
PDF) laid out like a standard invoice: number and dates, **From** (Platform
console → Platform settings → "Invoices and receipts are from": name,
address, email, TIN, one per line) and **Bill to** (restaurant, owner, phone,
email), the amount line with _Pay online_, the item, totals, and on a
receipt the payment history. Paid invoices also have a **Receipt**; platform
staff print receipts from the restaurant's payments.

Owners change their email in Admin → Billing → Account;
platform staff can change it in the restaurant's panel (and write to them).
