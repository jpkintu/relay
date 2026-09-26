// Relay Cloud Code entry point. Back4App loads this file; each module
// registers its Cloud functions, triggers and jobs.
//
//   security.js  write guards, _User rules, applySecurity migration
//   profile.js   getAppInfo, getMyProfile
//   orders.js    createOrder, transitionOrder (incl. cancel/reject), order issues
//   customers.js customer records, searchCustomers
//   notifications.js in-app notifications, reminders, getNotifications
//   payments.js  mobile money: verifyPayment, resubmitPayment, ledger
//   menu.js      getOperationalMenu, getStock, setAvailability
//   cash.js      cash handovers and disputes
//   shifts.js    rider and cashier shifts
//   admin.js     owner setup, team, menu, settings
//   reports.js   payments ledger, order/commission ledgers, earnings, reports
//   preview.js   optional demo mode (RELAY_ENABLE_PREVIEW=true)

require('./security');
require('./notifications');
require('./customers');
require('./payments');
require('./orders');
require('./menu');
require('./cash');
require('./shifts');
require('./admin');
require('./preview');
require('./reports');
require('./profile');
