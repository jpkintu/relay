// Relay Cloud Code entry point. Back4App loads this file; each module
// registers its Cloud functions, triggers and jobs.
//
//   security.js  write guards, _User rules, applySecurity migration
//   profile.js   getAppInfo, getMyProfile
//   orders.js    createOrder, transitionOrder, getOperationalMenu
//   cash.js      cash handovers and disputes
//   shifts.js    rider and cashier shifts
//   admin.js     owner setup, team, menu, settings
//   preview.js   optional demo mode (RELAY_ENABLE_PREVIEW=true)

require('./security');
require('./orders');
require('./cash');
require('./shifts');
require('./admin');
require('./preview');
require('./profile');
