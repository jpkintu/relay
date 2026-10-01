// Relay Cloud Code entry point. Back4App loads this file; each module
// registers its Cloud functions, triggers and jobs.
//
//   errors.js    error reporting: wraps every function and job, ErrorLog
//   adminLock.js PIN re-entry for the Admin area (unlockAdmin, requireAdminUnlock)
//   restaurants.js Relay Hosted: restaurants, sign-up, platform role (docs/HOSTED.md)
//   billing.js     Relay Hosted: subscription payments (ioTec) and reminders
//   security.js  write guards, _User rules, applySecurity migration
//   profile.js   getAppInfo, getMyProfile
//   orders.js    createOrder, transitionOrder (incl. cancel/reject), order issues
//   counter.js   cashier-created orders: call-in delivery, eat-in, pick-up
//   customers.js customer records, searchCustomers
//   push.js      Web Push: VAPID keys, device subscriptions, sending
//   notifications.js in-app notifications, reminders, getNotifications
//   payments.js  mobile money: verifyPayment, resubmitPayment, ledger
//   collections.js automatic MTN MoMo / Airtel Money payment requests
//   serverAddress.js the server's public IP (Airtel's allowed list), change alerts
//   menu.js      getOperationalMenu, getStock, setAvailability
//   cash.js      cash handovers, partial acceptance, disputes and resolutions
//   payouts.js   money paid out of the till (rider pay, expenses)
//   cashcheck.js nightly cash check (Cloud Job "cashCheck")
//   shifts.js    rider and cashier shifts
//   people.js    PIN change/reset, rider availability, the owner's member page
//   admin.js     owner setup, team, menu, settings
//   onboarding.js Get started: setup progress, menu import, finish setup
//   data.js      owner's data export (backups, spreadsheets)
//   privacy.js   customer data retention, forget a customer
//   restore.js   putting records back from a backup file
//   efris.js     URA EFRIS fiscal receipts (Admin → Tax)
//   reports.js   payments ledger, order/commission ledgers, earnings, reports
//   owner.js     dashboard, audit log, daily Z-report (Cloud Job "dailyZReport")
//   overrides.js the owner's order page and overrides
//   preview.js   optional demo mode (RELAY_ENABLE_PREVIEW=true)

require('./errors');
require('./adminLock');
require('./restaurants');
require('./billing');
require('./security');
require('./push');
require('./notifications');
require('./customers');
require('./payments');
require('./collections');
require('./serverAddress');
require('./orders');
require('./counter');
require('./menu');
require('./cash');
require('./payouts');
require('./drawer');
require('./cashcheck');
require('./shifts');
require('./branches');
require('./spending');
require('./accounting');
require('./whatsapp');
require('./platformWhatsapp');
require('./platformEmail');
require('./platformBroadcast');
require('./platformRevenue');
require('./offers');
require('./downgrade');
require('./platformAccounting');
require('./people');
require('./admin');
require('./onboarding');
require('./data');
require('./privacy');
require('./restore');
require('./efris');
require('./preview');
require('./reports');
require('./owner');
require('./overrides');
require('./profile');
