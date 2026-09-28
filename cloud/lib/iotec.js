// Relay Hosted: ioTec Pay mobile money collections, for restaurants paying
// their Relay subscription (docs/HOSTED.md). The keys are the Back4App app's
// environment variables, never stored in the database:
//   IOTEC_CLIENT_ID, IOTEC_CLIENT_SECRET, IOTEC_WALLET_ID
//   IOTEC_ENV=sandbox       test currency (ITX) instead of real money
//   IOTEC_API_URL           default https://pay.iotec.io
//   IOTEC_AUTH_URL          default https://id.iotec.io/connect/token
//
// ioTec tokens last 300 seconds, so one is fetched for each call (as in the
// Embiro BI platform). There is no documented webhook: payments are checked
// until ioTec says Success or Failed.

const { ProviderError, call } = require('./momoApi');

const env = (name) => String(process.env[name] || '').trim();
const apiUrl = () => (env('IOTEC_API_URL') || 'https://pay.iotec.io').replace(/\/+$/, '');
const authUrl = () => env('IOTEC_AUTH_URL') || 'https://id.iotec.io/connect/token';
const sandbox = () => env('IOTEC_ENV').toLowerCase() === 'sandbox';

function configured() {
  return !!(env('IOTEC_CLIENT_ID') && env('IOTEC_CLIENT_SECRET') && env('IOTEC_WALLET_ID'));
}

async function token() {
  if (!configured()) throw new ProviderError('ioTec is not set up on the server', 0);
  const { data } = await call('POST', authUrl(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('IOTEC_CLIENT_ID'),
      client_secret: env('IOTEC_CLIENT_SECRET'),
      grant_type: 'client_credentials',
    }).toString(),
  });
  if (!data?.access_token) throw new ProviderError('ioTec did not return an access token', 0);
  return data.access_token;
}

// Ugandan numbers as ioTec takes them (07… / 03…); anything else unchanged.
function payerMsisdn(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^256\d{9}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^\d{9}$/.test(digits)) return `0${digits}`;
  return digits;
}

// Asks the payer's phone to approve a payment. → { id, status, message }
async function collect({ externalId, amount, currency, payer, payerName, note }) {
  const bearer = await token();
  const { data } = await call('POST', `${apiUrl()}/api/collections/collect`, {
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: {
      category: 'MobileMoney',
      currency: sandbox() ? 'ITX' : currency,
      walletId: env('IOTEC_WALLET_ID'),
      externalId: String(externalId).slice(0, 100),
      payer: payerMsisdn(payer),
      payerName: String(payerName || '').slice(0, 150),
      // What the payer sees: say what is being paid for.
      payerNote: String(note).slice(0, 100),
      payeeNote: String(note).slice(0, 100),
      amount,
      transactionChargesCategory: 'ChargeWallet',
    },
  });
  if (!data?.id) throw new ProviderError('ioTec did not return a transaction ID', 0);
  return { id: String(data.id), ...outcome(data) };
}

// Pending | Success | Failed, with ioTec's own message and the mobile money
// reference once there is one.
function outcome(data) {
  const raw = String(data?.status || '').toLowerCase();
  const status = raw === 'success' ? 'paid' : raw === 'failed' ? 'failed' : 'pending';
  return {
    status,
    message: String(data?.statusMessage || '').slice(0, 200),
    reference: String(data?.vendorTransactionId || '').slice(0, 100),
  };
}

async function checkStatus(id) {
  const bearer = await token();
  const { data } = await call(
    'GET',
    `${apiUrl()}/api/collections/status/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  );
  return outcome(data);
}

module.exports = { configured, sandbox, collect, checkStatus, payerMsisdn, outcome };
