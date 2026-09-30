// Relay Hosted: the platform's WhatsApp number sends every restaurant's daily
// summary (cloud/whatsapp.js). Platform staff connect one WhatsApp Business
// app in the platform console (cloud/platformWhatsapp.js); owners only choose
// the numbers that receive their summary. Until it is connected and switched
// on, each restaurant can still use its own WhatsApp app.

const MASTER = { useMasterKey: true };

// The platform's sender as saved: { enabled, phoneNumberId, token,
// templateName, language, displayNumber }. Kept on PlatformSettings (read by
// the master key only), outside the settings the console lists.
async function loadSender() {
  const tenancy = require('./tenant');
  const row = await tenancy.withoutTenant(() => new Parse.Query('PlatformSettings').first(MASTER));
  return { row, sender: { language: 'en', ...(row?.get('whatsapp') || {}) } };
}

let cache = null;
const clearSender = () => {
  cache = null;
};

// { phoneNumberId, token, templateName, language, displayNumber } or null.
async function sharedSender() {
  if (!cache || Date.now() - cache.at > 30000) {
    const { sender } = await loadSender();
    cache = {
      at: Date.now(),
      value:
        sender.enabled === true && sender.phoneNumberId && sender.token
          ? {
              phoneNumberId: sender.phoneNumberId,
              token: sender.token,
              templateName: sender.templateName || '',
              language: sender.language || 'en',
              displayNumber: sender.displayNumber || '',
            }
          : null,
    };
  }
  return cache.value;
}

module.exports = { sharedSender, loadSender, clearSender };
