const {
  MASTER,
  DEFAULT_CONFIG,
  requireUser,
  getRoleName,
  loadConfig,
  withRiderLimit,
} = require('./lib/core');
const tenancy = require('./lib/tenant');
const { restaurantSummary } = require('./restaurants');
const { previewEnabled } = require('./preview');
const { merchantAccounts } = require('./lib/mobileMoney');

// Settings every signed-in screen needs. Configuration itself is not
// client-readable; this is the public subset.
function publicConfig(values) {
  return {
    restaurantName: values.restaurantName,
    restaurantLogo: values.restaurantLogo,
    theme: { ink: values.themeInk, accent: values.themeAccent },
    currencySymbol: values.currencySymbol,
    currencyCode: values.currencyCode,
    timezone: values.timezone,
    defaultDeliveryFee: values.defaultDeliveryFee,
    maxRiderFloat: values.maxRiderFloat,
    allowBatching: values.allowBatching,
    commissionRounding: values.commissionRounding,
    requireCashierConfirmForPickup: values.requireCashierConfirmForPickup,
    floatWarningPercent: values.floatWarningPercent,
    receipt: {
      width: Number(values.receiptWidth) === 58 ? 58 : 80,
      header: values.receiptHeader || '',
      footer: values.receiptFooter || '',
      autoPrintKitchen: values.autoPrintKitchen === true,
    },
    modules: {
      riderOrders: values.moduleRiderOrders !== false,
      callIn: values.moduleCallIn === true,
      counter: values.moduleCounter === true,
    },
    mapCenter: { lat: Number(values.restaurantLat), lng: Number(values.restaurantLng) },
    mobileMoney: merchantAccounts(values),
    // False until the owner saves a restaurant name in Settings.
    restaurantNameSet: values.restaurantName !== DEFAULT_CONFIG.restaurantName,
  };
}

// Pre-login info for the sign-in screen. Relay Hosted: for the restaurant
// named by { restaurant: '<code>' }; without one (or an unknown code) the app
// shows "find your restaurant" and the sign-up page.
Parse.Cloud.define('getAppInfo', async () => {
  if (!tenancy.current())
    return { hosted: true, found: false, signUpOpen: true, previewEnabled: previewEnabled() };
  const [{ values }, restaurant] = await Promise.all([loadConfig(), restaurantSummary()]);
  return {
    hosted: true,
    found: true,
    signUpOpen: true,
    restaurant,
    restaurantName: values.restaurantName,
    restaurantLogo: values.restaurantLogo,
    theme: { ink: values.themeInk, accent: values.themeAccent },
    currencySymbol: values.currencySymbol,
    currencyCode: values.currencyCode,
    timezone: values.timezone,
    ownerSetupOpen: false,
    // For the privacy notice (/privacy), which anyone can read.
    privacy: {
      contact: values.privacyContact || '',
      retentionMonths: Number(values.retentionMonths) || 0,
    },
    previewEnabled: previewEnabled(),
  };
});

// Who the signed-in user is and what they may do. Roles are not
// client-readable, so the app must ask here instead of querying _Role.
Parse.Cloud.define('getMyProfile', async (request) => {
  const user = requireUser(request);
  await user.fetch(MASTER);
  const [role, { values }, restaurant] = await Promise.all([
    getRoleName(user),
    loadConfig(),
    restaurantSummary(),
  ]);
  return {
    // Relay Hosted: the person's restaurant (null for platform staff).
    restaurant,
    id: user.id,
    username: user.getUsername(),
    name: user.get('name') || user.getUsername(),
    phone: user.get('phone') || '',
    role,
    code: user.get('riderCode') || user.get('cashierCode') || '',
    // Riders only: false while on a break (new orders are refused).
    available: role === 'rider' ? user.get('available') !== false : null,
    commission:
      role === 'rider'
        ? {
            type: user.get('commissionType') || 'per_order',
            perOrder: user.get('commissionPerOrder') || 0,
            percent: user.get('commissionPercent') || 0,
          }
        : null,
    canInitialize: false,
    config: publicConfig(role === 'rider' ? withRiderLimit(values, user) : values),
  };
});
