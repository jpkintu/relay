const {
  MASTER,
  DEFAULT_CONFIG,
  requireUser,
  getRoleName,
  loadConfig,
  countUsers,
  withRiderLimit,
} = require('./lib/core');
const { canBootstrapOwner } = require('./admin');
const { previewEnabled } = require('./preview');
const { merchantAccounts, cardAccount } = require('./lib/mobileMoney');

// Settings every signed-in screen needs. Configuration itself is not
// client-readable; this is the public subset.
function publicConfig(values) {
  return {
    restaurantName: values.restaurantName,
    restaurantLogo: values.restaurantLogo,
    loginImages: values.loginImages,
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
    // Card machine at the counter; null while card payments are off.
    card: cardAccount(values),
    // False until the owner saves a restaurant name in Settings.
    restaurantNameSet: values.restaurantName !== DEFAULT_CONFIG.restaurantName,
  };
}

// Pre-login info for the sign-in screen.
Parse.Cloud.define('getAppInfo', async () => {
  const [{ values }, users] = await Promise.all([loadConfig(), countUsers()]);
  return {
    restaurantName: values.restaurantName,
    restaurantLogo: values.restaurantLogo,
    loginImages: values.loginImages,
    theme: { ink: values.themeInk, accent: values.themeAccent },
    currencySymbol: values.currencySymbol,
    currencyCode: values.currencyCode,
    timezone: values.timezone,
    ownerSetupOpen: users === 0,
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
  const [role, { values }, branches, features] = await Promise.all([
    getRoleName(user),
    loadConfig(),
    new Parse.Query('Branch').notEqualTo('active', false).find(MASTER),
    require('./lib/limits').features(),
  ]);
  const own = branches.find((row) => row.id === user.get('branch')?.id);
  return {
    id: user.id,
    username: user.getUsername(),
    name: user.get('name') || user.getUsername(),
    phone: user.get('phone') || '',
    role,
    code: user.get('riderCode') || user.get('cashierCode') || user.get('financeCode') || '',
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
    canInitialize: role === null && (await canBootstrapOwner()),
    // Where they work (riders and cashiers), and how many open branches the
    // restaurant has (branch filters show when there are two or more).
    branch: own ? { id: own.id, name: own.get('name') } : null,
    branchCount: branches.length,
    // Parts of the app this restaurant has (lib/limits.js).
    features,
    config: publicConfig(role === 'rider' ? withRiderLimit(values, user) : values),
  };
});
