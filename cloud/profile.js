const { MASTER, requireUser, getRoleName, loadConfig, countUsers } = require('./lib/core');
const { canBootstrapOwner } = require('./admin');
const { previewEnabled } = require('./preview');

// Settings every signed-in screen needs. Configuration itself is not
// client-readable; this is the public subset.
function publicConfig(values) {
  return {
    restaurantName: values.restaurantName,
    currencySymbol: values.currencySymbol,
    currencyCode: values.currencyCode,
    timezone: values.timezone,
    defaultDeliveryFee: values.defaultDeliveryFee,
    maxRiderFloat: values.maxRiderFloat,
    allowBatching: values.allowBatching,
  };
}

// Pre-login info for the sign-in screen.
Parse.Cloud.define('getAppInfo', async () => {
  const [{ values }, users] = await Promise.all([loadConfig(), countUsers()]);
  return {
    restaurantName: values.restaurantName,
    ownerSetupOpen: users === 0,
    previewEnabled: previewEnabled(),
  };
});

// Who the signed-in user is and what they may do. Roles are not
// client-readable, so the app must ask here instead of querying _Role.
Parse.Cloud.define('getMyProfile', async (request) => {
  const user = requireUser(request);
  await user.fetch(MASTER);
  const [role, { values }] = await Promise.all([getRoleName(user), loadConfig()]);
  return {
    id: user.id,
    username: user.getUsername(),
    name: user.get('name') || user.getUsername(),
    phone: user.get('phone') || '',
    role,
    code: user.get('riderCode') || user.get('cashierCode') || '',
    commission:
      role === 'rider'
        ? {
            type: user.get('commissionType') || 'per_order',
            perOrder: user.get('commissionPerOrder') || 0,
            percent: user.get('commissionPercent') || 0,
          }
        : null,
    canInitialize: role === null && (await canBootstrapOwner()),
    config: publicConfig(values),
  };
});
