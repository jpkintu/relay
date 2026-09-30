// The WhatsApp number that sends the daily summaries (cloud/whatsapp.js).
// Here each restaurant connects its own WhatsApp Business app (Admin →
// WhatsApp), so there is no shared sender. Relay Hosted replaces this file:
// the platform connects one WhatsApp app for every restaurant, and owners
// only choose the numbers that receive the summary.

// { phoneNumberId, token, templateName, language, displayNumber } or null.
async function sharedSender() {
  return null;
}

module.exports = { sharedSender };
