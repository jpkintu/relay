// Mobile money (Airtel Money / MTN MoMo merchant payments). Pure helpers,
// unit-tested. The restaurant's merchant codes live in Configuration.

const PROVIDERS = [
  {
    provider: 'airtel',
    label: 'Airtel Money',
    codeField: 'airtelMerchantCode',
    nameField: 'airtelMerchantName',
    autoField: 'airtelAutoCollect',
  },
  {
    provider: 'mtn',
    label: 'MTN MoMo',
    codeField: 'mtnMerchantCode',
    nameField: 'mtnMerchantName',
    autoField: 'mtnAutoCollect',
  },
];

// The providers riders can offer: those with a merchant code set, or with
// automatic payments switched on (Admin → Payments). `auto`: the app can ask
// the customer's phone to pay instead of waiting for a transaction ID.
function merchantAccounts(config) {
  return PROVIDERS.filter(
    (p) => String(config[p.codeField] || '').trim() || config[p.autoField] === true,
  ).map((p) => ({
    provider: p.provider,
    label: p.label,
    code: String(config[p.codeField] || '').trim(),
    name: String(config[p.nameField] || '').trim(),
    auto: config[p.autoField] === true,
  }));
}

// Transaction IDs from the customer's confirmation SMS: letters, digits,
// dots and dashes. Spaces are dropped and letters upper-cased so the same
// ID typed twice compares equal.
function cleanReference(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .slice(0, 40);
}

function referenceProblem(reference) {
  if (!reference) return 'Enter the transaction ID from the customer’s payment message';
  if (!/^[A-Z0-9.-]{4,40}$/.test(reference))
    return 'A transaction ID has 4 to 40 letters or digits';
  return '';
}

module.exports = { PROVIDERS, merchantAccounts, cleanReference, referenceProblem };
