// Relay Hosted, platform console → WhatsApp sender: the one WhatsApp Business
// app that sends every restaurant's daily summary (lib/whatsappSender.js).
// The access token is kept with the platform settings and never sent back.

const { invalid, audit } = require('./lib/core');
const tenancy = require('./lib/tenant');
const { requirePlatform } = require('./restaurants');
const { loadSender, clearSender } = require('./lib/whatsappSender');
const { send, phoneOf } = require('./whatsapp');

const MASTER = { useMasterKey: true };

const view = (sender) => ({
  enabled: sender.enabled === true,
  phoneNumberId: sender.phoneNumberId || '',
  displayNumber: sender.displayNumber || '',
  tokenSet: !!sender.token,
  templateName: sender.templateName || '',
  language: sender.language || 'en',
});

Parse.Cloud.define('platformGetWhatsApp', async (request) => {
  await requirePlatform(request);
  return view((await loadSender()).sender);
});

// { enabled, phoneNumberId, displayNumber, token (empty keeps it),
//   templateName, language }
Parse.Cloud.define('platformSaveWhatsApp', async (request) => {
  const actor = await requirePlatform(request);
  const p = request.params || {};
  const { row, sender } = await loadSender();
  if (!row) throw invalid('Save the platform settings first');
  const next = {
    ...sender,
    enabled: p.enabled === true,
    phoneNumberId: String(p.phoneNumberId ?? sender.phoneNumberId ?? '')
      .replace(/[^\d]/g, '')
      .slice(0, 30),
    displayNumber: String(p.displayNumber ?? sender.displayNumber ?? '')
      .trim()
      .slice(0, 40),
    templateName: String(p.templateName ?? sender.templateName ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 60),
    language: String(p.language || sender.language || 'en')
      .trim()
      .slice(0, 10),
  };
  if (p.token) next.token = String(p.token).trim().slice(0, 1000);
  if (next.enabled && (!next.phoneNumberId || !next.token))
    throw invalid('Enter the phone number ID and the access token');
  if (next.enabled && !next.templateName)
    throw invalid(
      'Enter the approved template: without one WhatsApp only delivers to numbers that wrote first',
    );
  row.set('whatsapp', next);
  await tenancy.withoutTenant(() => row.save(null, MASTER));
  clearSender();
  await tenancy.withoutTenant(() =>
    audit(actor, 'platform.whatsapp_saved', row, view(sender), view(next)),
  );
  return view(next);
});

// Sends a short test message (with the template) to one number.
Parse.Cloud.define('platformTestWhatsApp', async (request) => {
  await requirePlatform(request);
  const to = phoneOf(request.params?.to);
  if (!to) throw invalid('Enter the number to send the test to');
  const { sender } = await loadSender();
  if (!sender.phoneNumberId || !sender.token)
    throw invalid('Save the phone number ID and the access token first');
  const text = 'RelayEats test: WhatsApp summaries can reach this number.';
  try {
    await send({ ...sender, managed: true }, to, { text, line: text, full: text });
  } catch (error) {
    throw invalid(`Not sent: ${error.message}`);
  }
  return { sent: 1 };
});
