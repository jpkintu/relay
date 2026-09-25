// Relay Cloud Code entry point. Back4App loads this file; each module
// registers its Cloud functions, triggers and jobs.
//
//   security.js  write guards, _User rules, applySecurity migration
//   profile.js   getAppInfo, getMyProfile
//   orders.js    createOrder, transitionOrder (incl. cancel/reject), order issues
//   customers.js customer records, searchCustomers
//   menu.js      getOperationalMenu, getStock, setAvailability
//   cash.js      cash handovers and disputes
//   shifts.js    rider and cashier shifts
//   admin.js     owner setup, team, menu, settings
//   preview.js   optional demo mode (RELAY_ENABLE_PREVIEW=true)

require('./security');
require('./customers');
require('./orders');
require('./menu');
require('./cash');
require('./shifts');
require('./admin');
require('./preview');
require('./profile');
