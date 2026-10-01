# RelayEats Hosted: the multi-restaurant edition

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

**Revenue** (top of the console, `platformRevenue`): money received this
month against last month, monthly recurring revenue (what paid restaurants
pay a month, and the yearly rate), paying restaurants, trial-to-paid
conversion (restaurants that ever paid, of those whose trial ended), the
amount due in the next 30 days and the overdue amount; a bar chart of money
received per month over 12 months; and tables of what is coming up (renewals
and trials ending), who is overdue (in grace days, with the closing date) and
paying restaurants per plan. Months are Kampala months.

**Email owners** (`platformBroadcastPreview`, `platformSendBroadcast`,
`platformListBroadcasts`): choose who (all, on trial, paid, overdue, closed;
any plan or one), write a subject and message (`{restaurant}` and `{owner}`
become each restaurant's own), send a test to yourself, then send. It goes in
the background, one email per owner through the email service (the
`announcement` kind, so it can use a Resend template too) at about two a
second; the list below shows each send with how many went out and failed.
Suspended restaurants and owners without an email are left out.

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

## Changing plan

The plan in force and the plan of the next paid period can differ
(`Restaurant.nextPlan` from `nextPlanFrom`; `lib/limits.js` `planOf` /
`renewalPlanOf`):

- **Moving up while a paid period runs** (`startPlanUpgrade { plan, phone }`):
  the owner pays only the difference for the days left, at the yearly rate
  when the running period was paid as a year:
  (new rate − current rate) × days left ÷ (365 / 12), rounded up to 100. The
  paid-until date stays. The plan (and its limits and parts of the app)
  changes once that payment succeeds; until then the current plan stays. Under
  UGX 500 (a few days left) the plan changes at once without a payment.
- **Moving up from the trial, or with no paid period running** (grace days,
  closed): pay a period on the bigger plan (`startSubscriptionPayment {
months, phone, plan }`); the plan changes when it is paid.
- **Moving down** (`changePlan { plan }`): only from the next period. The
  current plan stays until the paid period (or trial) ends; the next period
  is priced on the smaller plan. Choosing the current plan again cancels it.
  When the restaurant has more than the smaller plan allows, the owner
  chooses what stays (`getDowngradeChoices`, then `changePlan { plan, keep:
{ branches, members } }`): the branch(es) to keep open, then per limited
  role the team members to keep (only from the kept branches). Billing shows
  what stays and what closes. On the date (`downgrade.js`, run by the next
  request, the owner's app or the `billing` job) the other branches are closed
  (the main branch moves to a kept one) and the other members are deactivated
  and signed out. Nothing is deleted: orders, payments, shifts and handovers
  of every branch stay in orders, ledgers and reports (closed branches remain
  in the owner's branch filters), and branches and members can be reopened
  after moving up again. Members added after the choice are deactivated unless
  they fit; with no choice saved, the main branch and the longest-serving
  members within the limits stay.
- A price agreed with Relay (`priceOverride`) changes plan through Relay only;
  platform staff changing the plan in the console apply it at once.

Each payment records `kind` (period | upgrade) and `plan`; upgrade invoices
and receipts read "Upgrade to … for the days left".

## Referrals in Billing

Admin → Billing → **Refer a restaurant** shows the restaurant's code, a
**Refer** button (the phone's share sheet, or WhatsApp) and **Copy link**
(`/?ref=code` opens the sign-up page on Pay now with the code applied), the
terms (the referral discount and reward from Platform settings, only when
paying now, once per restaurant, none if they switch to the trial), and the
restaurants that used the code: rewarded (with the months and date), not paid
yet, or chose the trial (`Restaurant.referredBy`, `referralCredit`).

## Codes: pay now with a discount or referral

Sign-up offers two starts: the **free trial** (no code) or **Pay now**. Only
Pay now takes a code, and the code only counts on the first payment:

- **Discount codes** (Platform console → Codes): percent (1–90) or an amount
  off, optionally only when paying 3, 6 or 12 months, with a use limit and an
  expiry date. The list shows uses and how much each code has given.
- **Referral codes**: any restaurant's own code. The new restaurant gets the
  referral discount (Platform settings → Referral discount, default 10%); once
  it has paid, the restaurant whose code it used gets free months (Referral
  reward, default 1) added to its paid-until date, a notification and the
  `referral_credit` email. 0% turns referrals off.

`checkSignupCode { code, plan }` (public, 30 tries an hour per address) shows
what the code takes off on the sign-up page; `signUpRestaurant` takes
`start: 'pay'` and `offerCode`. A Pay-now restaurant (`Restaurant.payFirst`) is
closed until the first payment: the owner signs in to "Pay to start" with the
discounted prices (in the app, or recorded by Relay at the same price) and can
**start the free trial instead** (`startTrialInstead`), which drops the code.
The first payment records `listAmount`, `discount` and `discountCode`; its
invoice and receipt show the discount line.

## Accounting and Zoho Books

Platform console → **Accounting** (`platformAccounting.js`, `lib/earnings.js`).
Subscription money is received when paid and **earned day by day over the
period it pays for** (periodStart to periodEnd): a year paid on 1 October earns
31/365 in October; the rest is a prepayment (unearned revenue). For a chosen
month (Kampala time) it shows money received, revenue earned (from that
month's payments and from earlier prepayments), what this month's payments
prepaid, and the prepayment balance at the month's end, with every invoice:
amount, earned before, earned this month, prepaid after.

- **Download CSV**: the invoices with those columns and the month's totals.
- **Print the month's invoices**: one print window, an invoice per page, to
  save as one PDF.

**Zoho Books** (Zoho Books API v3):

1. In api-console.zoho.com (the Zoho account of your books): Add client →
   **Self Client**; copy the client ID and secret. Generate code with scope
   `ZohoBooks.fullaccess.all` (10 minutes).
2. Accounting → Zoho Books: data centre, organization ID (Zoho Books →
   Settings → Organization profile), client ID, secret, the grant code →
   **Connect** (the code is exchanged for a refresh token, kept on
   PlatformSettings, master key only).
3. Choose the three accounts: **Prepayments** (a liability, e.g. Unearned
   revenue), **Subscription revenue** (income) and **where the money lands**
   (the bank or mobile money wallet account), and the month to start with
   (earlier payments stay out; enter opening balances in Zoho). Books should
   use the same currency as Relay.

Then for each paid payment Relay makes, once: the restaurant as a Zoho
customer, an invoice (Relay's invoice number, the line booked to
Prepayments) marked sent, and a customer payment against it into the deposit
account (**Send invoices to Zoho Books**). For each month that is over,
**Post earnings** makes one journal on its last day: debit Prepayments, credit
Subscription revenue, for what was earned in the month (only from payments in
Zoho). With **Automatically** on, each payment goes to Zoho when it is
received and closed months are posted by the `billing` job. A failed send is
shown on its row and retried with the next send.

## Deleting restaurants

Platform console → Restaurants → open one → **Delete this restaurant**
(`platformDeleteRestaurant`, cloud/purge.js). Type the restaurant code to confirm.

- **Everything (a test restaurant)**: every record, order, transaction, cash
  record, report, image, staff account (with its sessions), the restaurant's
  roles, its subscription payments and the restaurant itself. Nothing is left;
  its code is free again.
- **Its data, keeping its subscription payments**: the same, except the
  payments it made to Relay. The restaurant stays as a closed shell
  (`deleted`, `deletedAt`, `deletedCode`; name, plan and Zoho contact kept;
  contact details cleared; a new code nobody can sign in with) so Accounting,
  the revenue figures and Zoho still name it. Shown as "Data deleted"; it can
  be removed completely later with Everything.

With Everything, **Also delete it in Zoho Books** (on by default) first
deletes the restaurant's customer payments, then its invoices, then its
customer in Zoho Books (that order: Zoho keeps an invoice that has a payment
and a customer that has invoices). If Zoho refuses, or the restaurant was sent
to Zoho but Zoho is no longer connected, nothing is deleted in Relay; what was
already removed from Zoho stays removed, so trying again carries on. Then each
month whose earnings journal counted the restaurant is posted again without it
(the old journal deleted in Zoho). Keeping the payments leaves Zoho as it is.
A deleted restaurant's kept payments keep their invoice numbers (from
`deletedCode`).

The console's history (`platform.restaurant_deleted`) keeps who deleted what
and the counts (Zoho included).

**Unpaid restaurants** are deleted automatically (keeping their payments):
`deleteAfterDays` (default 30; 0 = never) after the app closes for lack of
payment (end of the trial or paid period plus the grace days; a pay-now
sign-up that never paid: from sign-up). The owner is emailed
**Account to be deleted** (`account_deletion`) `deleteWarnDays` (default 3)
before, and it is never deleted sooner than that after the warning. Paying,
or the platform extending its dates, stops it; a warning from an earlier time
it closed does not count. Suspended restaurants and those marked **Never
delete automatically** are left alone. Both numbers are in Settings & errors →
Platform settings; the restaurants list shows "Deleted on …" for those on
their way. The rules are in `cloud/lib/retention.js`.

It runs without a job: at most hourly on the back of any owner using the app
(`RELAY_RETENTION_CHECK_MS`), whenever platform staff open the console, and in
the `billing` job when one is scheduled.

## Sign-in lockout and session length (S5, S7)

One Back4App setting covers every restaurant: Server Settings → Custom Parse
Options `{"accountLockout": {"threshold": 5, "duration": 15}, "sessionLength":
2592000}` (docs/ROADMAP.md §2). Platform console → Settings & errors →
**Sign-in protection** shows whether it is on (`platformSecurityStatus`);
restaurants see the same under Admin → Access & security, and are told
Relay sets it. An owner unlocks their team (Team → Unlock sign-in); platform
staff unlock an owner with **Reset owner password**. Sign-ins end after 30
days for staff, 14 for owners and finance, and **1 day for platform staff**
(`RELAY_PLATFORM_SESSION_DAYS`), checked inside the restaurant's context on
every Cloud function call.

## Restaurant addresses (aldea.relayeats.app)

Each restaurant opens at its own subdomain once platform staff set
**Restaurant domain** (Settings & errors → Platform settings), e.g.
`relayeats.app`: `aldea.relayeats.app` opens straight on Aldea's sign-in,
with its logo and name. The app reads the code from the address
(src/lib/restaurant.ts `subdomainCode`; `www`, `app`, `api`, `admin`,
`platform`, `mail`, `help` are never restaurants, and `www`, `mail`,
`relayeats` cannot be taken as codes). Welcome, billing and other owner
emails, the console's restaurant list and the sign-up form use the subdomain
(`restaurantLink` in restaurants.js). Old `/r/<code>` links keep working;
with the setting empty, links are `/r/<code>` as before.

Setting it up (once):

1. **DNS:** an `A`/`CNAME` record for `relayeats.app` and a wildcard record
   `*.relayeats.app`, both pointing at where the frontend is hosted.
2. **Hosting:** the frontend host must accept the wildcard domain and serve
   it with HTTPS (`.app` is HTTPS-only in every browser). If Back4App's web
   hosting cannot take a wildcard custom domain, host the built frontend
   (`npm run build`, the `dist/` folder) on a host that can, e.g. Cloudflare
   (DNS + a Worker or Pages in front, wildcard certificate included) or
   Vercel (wildcard domains with its nameservers). The Cloud Code stays on
   Back4App; only the static files move.
3. **Platform console:** Settings & errors → Restaurant domain →
   `relayeats.app` → Save. Email → app address: `https://relayeats.app`.
4. Optional: build with `VITE_RESTAURANT_DOMAIN=relayeats.app` so a
   subdomain is recognised before the first server answer (otherwise it is
   picked up a moment later and remembered on the device).

Each origin keeps its own sign-in: someone signed in at
`relayeats.app` signs in once more at `aldea.relayeats.app`.

## Online ordering

Each restaurant's public menu (cloud/online.js, OnlineOrder.tsx) lives at
its own address: `https://<code>.relayeats.app/order` once the restaurant
domain is set, else `/order/<code>`. Customers order and pay there without
signing in. The public functions (`getOnlineMenu`, `placeOnlineOrder`,
`getOnlineOrder`, `cancelOnlineOrder`) take the restaurant from that address
(`restaurant: '<code>'`). Without it they refuse with “Open the restaurant’s
own link to order”. A restaurant that is suspended, or whose trial or
subscription has lapsed, answers “This restaurant is not taking online
orders right now”. The order throttles are counted per restaurant. Admin →
Online orders shows the restaurant's own link and QR code, and prints A4 or
A5 fliers and table cards carrying that QR code.

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
| `welcome`           | after sign-up                           | RESTAURANT_CODE, USERNAME, PLAN_NAME, TRIAL_ENDS, START_LINE, SIGN_IN_URL                                   |
| `password_reset`    | forgot password                         | RESET_URL, EXPIRES_IN                                                                                       |
| `billing_due_soon`  | 7 and 3 days before the end             | HEADLINE, DAYS_LEFT, PLAN_NAME, AMOUNT, ANNUAL_AMOUNT, DUE_DATE, INVOICE_NUMBER, BILLING_URL                |
| `billing_due_today` | the last day                            | HEADLINE, PLAN_NAME, AMOUNT, ANNUAL_AMOUNT, DUE_DATE, INVOICE_NUMBER, BILLING_URL                           |
| `billing_overdue`   | after the end, and the day before close | HEADLINE, CLOSES_ON, DAYS_TO_CLOSE, PLAN_NAME, AMOUNT, ANNUAL_AMOUNT, DUE_DATE, INVOICE_NUMBER, BILLING_URL |
| `payment_received`  | a payment is received                   | PLAN_NAME, AMOUNT, PERIOD, PAID_UNTIL, INVOICE_NUMBER, REFERENCE, BILLING_URL                               |
| `announcement`      | Email owners (console)                  | SUBJECT, MESSAGE                                                                                            |
| `referral_credit`   | a referred restaurant's first payment   | REFERRED_NAME, MONTHS_TEXT, PAID_UNTIL, BILLING_URL                                                         |

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
