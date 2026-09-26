// Relay Cloud Code entry point. Back4App loads this file; each module
// registers its Cloud functions, triggers and jobs.
//
//   security.js  write guards, _User rules, applySecurity migration
//   profile.js   getAppInfo, getMyProfile
//   orders.js    createOrder, transitionOrder (incl. cancel/reject), order issues
//   customers.js customer records, searchCustomers
//   push.js      Web Push: VAPID keys, device subscriptions, sending
//   notifications.js in-app notifications, reminders, getNotifications
//   payments.js  mobile money: verifyPayment, resubmitPayment, ledger
//   menu.js      getOperationalMenu, getStock, setAvailability
//   cash.js      cash handovers, partial acceptance, disputes and resolutions
//   payouts.js   money paid out of the till (rider pay, expenses)
//   cashcheck.js nightly cash check (Cloud Job "cashCheck")
//   shifts.js    rider and cashier shifts
//   people.js    PIN change/reset, rider availability, the owner's member page
//   admin.js     owner setup, team, menu, settings
//   reports.js   payments ledger, order/commission ledgers, earnings, reports
//   preview.js   optional demo mode (RELAY_ENABLE_PREVIEW=true)

require('./security');
require('./push');
require('./notifications');
require('./customers');
require('./payments');
require('./orders');
require('./menu');
require('./cash');
require('./payouts');
require('./cashcheck');
require('./shifts');
require('./people');
require('./admin');
require('./preview');
require('./reports');
require('./profile');
