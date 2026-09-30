const {
  MASTER,
  DEFAULT_CONFIG,
  requireUser,
  getRoleName,
  loadConfig,
  withRiderLimit,
} = require('./lib/core');
const tenancy = require('./lib/tenant');
const { isPlatform, platformSettings, restaurantSummary } = require('./restaurants');
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

// Relay Hosted: what Relay's terms page (/terms) needs.
const platformInfo = (platform) => ({
  monthlyPrice: Number(platform.monthlyPrice) || 0,
  currency: platform.currency,
  graceDays: Number(platform.graceDays) || 0,
  supportContact: platform.supportContact || '',
});

// Pre-login info for the sign-in screen. Relay Hosted: for the restaurant
// named by { restaurant: '<code>' }; without one (or an unknown code) the app
// shows "find your restaurant" and the sign-up page.
Parse.Cloud.define('getAppInfo', async () => {
  if (!tenancy.current()) {
    const { values: platform } = await platformSettings();
    return {
      hosted: true,
      found: false,
      signUpOpen: true,
      trialDays: Number(platform.trialDays) || 0,
      platform: platformInfo(platform),
      previewEnabled: previewEnabled(),
    };
  }
  const [{ values }, restaurant, { values: platform }] = await Promise.all([
    loadConfig(),
    restaurantSummary(),
    platformSettings(),
  ]);
  return {
    hosted: true,
    found: true,
    signUpOpen: true,
    restaurant,
    platform: platformInfo(platform),
    restaurantName: values.restaurantName,
    restaurantLogo: values.restaurantLogo,
    loginImages: values.loginImages,
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
  const [role, { values }, restaurant, branches, features] = await Promise.all([
    getRoleName(user),
    loadConfig(),
    restaurantSummary(),
    new Parse.Query('Branch').notEqualTo('active', false).find(MASTER),
    require('./lib/limits').features(),
  ]);
  const own = branches.find((row) => row.id === user.get('branch')?.id);
  return {
    // Relay Hosted: the person's restaurant (null for platform staff).
    restaurant,
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
    canInitialize: false,
    // Relay Hosted: platform staff (no restaurant) get the platform console.
    platform: !restaurant && role === null ? await isPlatform(user) : false,
    // Where they work (riders and cashiers), and how many open branches the
    // restaurant has (branch filters show when there are two or more).
    branch: own ? { id: own.id, name: own.get('name') } : null,
    branchCount: branches.length,
    // Parts of the app this restaurant has (lib/limits.js).
    features,
    config: publicConfig(role === 'rider' ? withRiderLimit(values, user) : values),
  };
});
