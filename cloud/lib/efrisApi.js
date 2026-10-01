// URA EFRIS (Electronic Fiscal Receipting and Invoicing System), system to
// system API (appId AP04), as described in URA's "API documentation for
// system to system users" v24. Relay uses it to give each sale a fiscal
// document number (FDN), verification code and QR code for the receipt.
//
// Every call is one POST of an envelope { data, globalInfo, returnStateInfo }
// to .../efrisws/ws/taapp/getInformation. data.content is base64: the JSON
// itself, or (for encrypted interfaces) the JSON encrypted with AES/ECB/PKCS5
// using a symmetric key the server hands out (T104), itself encrypted with
// the taxpayer's RSA public key. Requests are signed (SHA1withRSA over the
// content) with the taxpayer's private key, whose certificate the taxpayer
// uploads on the EFRIS portal.
//
// T101 server time · T103 login (taxpayer, device, tax types) · T104 key ·
// T115 dictionary (units, currencies) · T130 goods upload · T109 invoice
// upload · T106 invoice query · T108 invoice details.
//
// The owner's keys come from cloud/efris.js; nothing here is stored except
// symmetric keys, cached in memory for an hour.

const crypto = require('crypto');
const zlib = require('zlib');
const forge = require('node-forge');

const URLS = {
  test: 'https://efristest.ura.go.ug/efrisws/ws/taapp/getInformation',
  production: 'https://efrisws.ura.go.ug/ws/taapp/getInformation',
};
// Tests point this at a local stand-in (RELAY_EFRIS_URL).
const urlOf = (settings) => process.env.RELAY_EFRIS_URL || URLS[settings.environment] || URLS.test;

const APP_ID = 'AP04';
const VERSION = '1.1.20191201';
const TIMEZONE = 'Africa/Kampala';

class EfrisError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = String(code || '');
  }
}

// ---- Keys --------------------------------------------------------------

// The taxpayer's private key from what the owner uploads: a keystore
// (.pfx / .p12, with its password) or a PEM private key. → PEM (PKCS#8).
const CERTIFICATE_NOT_KEY =
  'That file is a certificate (the public key): upload it on the EFRIS portal. RelayEats needs the private key instead; if you made the key pair in RelayEats, it is already saved and nothing needs uploading here.';

function isCertificate(bytes, text) {
  if (/-----BEGIN (TRUSTED )?CERTIFICATE-----/.test(text)) return true;
  if (text.includes('-----BEGIN')) return false;
  try {
    // DER (.cer): parses as an X.509 certificate.
    new crypto.X509Certificate(bytes);
    return true;
  } catch {
    return false;
  }
}

function privateKeyPem(fileBase64, password = '') {
  const bytes = Buffer.from(String(fileBase64 || ''), 'base64');
  if (!bytes.length) throw new EfrisError('Choose the private key file');
  const text = bytes.toString('utf8');
  // A certificate (.crt / .cer) is the public half: it goes to the EFRIS
  // portal, not here. Said plainly, as it is the easy mistake to make.
  if (isCertificate(bytes, text)) throw new EfrisError(CERTIFICATE_NOT_KEY);
  if (text.includes('-----BEGIN')) {
    try {
      const key = crypto.createPrivateKey({ key: text, passphrase: password || undefined });
      return key.export({ type: 'pkcs8', format: 'pem' });
    } catch {
      throw new EfrisError('That PEM file is not a private key (or the password is wrong)');
    }
  }
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bytes.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(password || ''));
  } catch {
    throw new EfrisError('Could not open the keystore: check the file and its password');
  }
  const bags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const key = bags.find((bag) => bag.key)?.key;
  if (!key) throw new EfrisError('The keystore has no private key in it');
  const pem = forge.pki.privateKeyToPem(key);
  return crypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' });
}

// A new key pair for EFRIS, made on the server so the owner needs no tools:
// the private key stays with Relay; the certificate (the public key, self
// signed, as keytool makes it) is what the owner uploads on the EFRIS
// portal. → { privateKey (PEM, PKCS#8), certificate (PEM), certificateDer
// (base64), fingerprint, validUntil }.
function generateKeyPair({ tin, name = '', years = 5 } = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const key = forge.pki.privateKeyFromPem(pem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = `01${crypto.randomBytes(8).toString('hex')}`;
  const from = new Date(Date.now() - 86400000);
  const until = new Date(from);
  until.setFullYear(until.getFullYear() + years);
  cert.validity.notBefore = from;
  cert.validity.notAfter = until;
  const subject = [
    { name: 'commonName', value: String(tin || 'RelayEats') },
    ...(name ? [{ name: 'organizationName', value: String(name).slice(0, 64) }] : []),
    { name: 'countryName', value: 'UG' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
  ]);
  cert.sign(key, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    privateKey: pem,
    certificate: forge.pki.certificateToPem(cert),
    certificateDer: Buffer.from(der, 'binary').toString('base64'),
    fingerprint: crypto.createHash('sha1').update(Buffer.from(der, 'binary')).digest('hex'),
    validUntil: until.toISOString(),
  };
}

const sign = (content, pem) =>
  crypto.createSign('RSA-SHA1').update(content, 'utf8').sign(pem, 'base64');

// T104's passowrdDes: RSA (PKCS#1 v1.5) with the taxpayer's public key. The
// plain value is the AES key, usually base64 encoded; both forms are taken.
function decryptSymmetricKey(passwordDes, pem) {
  const key = forge.pki.privateKeyFromPem(pem);
  let plain;
  try {
    plain = key.decrypt(forge.util.decode64(String(passwordDes || '')), 'RSAES-PKCS1-V1_5');
  } catch {
    throw new EfrisError(
      'EFRIS sent a key this private key cannot open: is it the key whose certificate you uploaded to the EFRIS portal?',
    );
  }
  const raw = Buffer.from(plain, 'binary');
  if ([16, 24, 32].includes(raw.length) && !/^[A-Za-z0-9+/=]+$/.test(plain)) return raw;
  const decoded = Buffer.from(plain, 'base64');
  if ([16, 24, 32].includes(decoded.length)) return decoded;
  if ([16, 24, 32].includes(raw.length)) return raw;
  throw new EfrisError('EFRIS sent a symmetric key of an unexpected length');
}

const aesName = (key) => `aes-${key.length * 8}-ecb`;
const aesEncrypt = (buffer, key) => {
  const cipher = crypto.createCipheriv(aesName(key), key, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
};
const aesDecrypt = (buffer, key) => {
  const decipher = crypto.createDecipheriv(aesName(key), key, null);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
};

// ---- Envelope ----------------------------------------------------------

// "yyyy-MM-dd HH:mm:ss" in Uganda time (EFRIS refuses requests more than
// ten minutes off its clock).
function ugandaTime(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function envelope(settings, interfaceCode, content, { encrypted, signature }) {
  return {
    data: {
      content,
      signature: signature || '',
      dataDescription: { codeType: encrypted ? '1' : '0', encryptCode: '2', zipCode: '0' },
    },
    globalInfo: {
      appId: APP_ID,
      version: VERSION,
      dataExchangeId: crypto.randomUUID().replace(/-/g, ''),
      interfaceCode,
      requestCode: 'TP',
      requestTime: ugandaTime(),
      responseCode: 'TA',
      userName: 'admin',
      deviceMAC: 'FFFFFFFFFFFF',
      deviceNo: settings.deviceNo,
      tin: settings.tin,
      brn: settings.ninBrn || '',
      taxpayerID: '1',
      longitude: String(settings.longitude ?? '32.5825'),
      latitude: String(settings.latitude ?? '0.3476'),
      agentType: '0',
      extendField: {
        responseDateFormat: 'dd/MM/yyyy',
        responseTimeFormat: 'dd/MM/yyyy HH:mm:ss',
        referenceNo: '',
        operatorName: '',
      },
    },
    returnStateInfo: { returnCode: '', returnMessage: '' },
  };
}

// Opens a response's content: base64, then (in either order the server
// chooses) AES decryption and gzip.
function openContent(data, key) {
  const text = data?.content;
  if (!text) return null;
  let bytes = Buffer.from(String(text), 'base64');
  const description = data.dataDescription || {};
  const gzipped = (buffer) => buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (gzipped(bytes)) bytes = zlib.gunzipSync(bytes);
  if (String(description.codeType) === '1') {
    if (!key) throw new EfrisError('EFRIS sent an encrypted answer before a key was agreed');
    bytes = aesDecrypt(bytes, key);
  }
  if (gzipped(bytes)) bytes = zlib.gunzipSync(bytes);
  const body = bytes.toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new EfrisError('EFRIS sent an answer RelayEats could not read');
  }
}

async function post(settings, body) {
  let response;
  try {
    response = await fetch(urlOf(settings), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch (error) {
    throw new EfrisError(`Could not reach EFRIS (${error.message})`);
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EfrisError(`EFRIS answered with an error (HTTP ${response.status})`);
  }
  return json;
}

// Symmetric keys, per TIN and device, for an hour.
const keys = new Map();
// Per key too: a new private key never reuses a session agreed under the old.
const keyId = (settings) =>
  `${settings.environment}:${settings.tin}:${settings.deviceNo}:${crypto
    .createHash('sha1')
    .update(String(settings.privateKey || ''))
    .digest('hex')}`;

async function symmetricKey(settings, { fresh = false } = {}) {
  const id = keyId(settings);
  const cached = keys.get(id);
  if (!fresh && cached && cached.until > Date.now()) return cached.key;
  const reply = await post(settings, envelope(settings, 'T104', '', { encrypted: false }));
  check(reply);
  const body = openContent(reply.data, null);
  const key = decryptSymmetricKey(body?.passowrdDes ?? body?.passwordDes, settings.privateKey);
  keys.set(id, { key, until: Date.now() + 3600000 });
  return key;
}

function check(reply) {
  const state = reply?.returnStateInfo || {};
  const code = String(state.returnCode ?? '');
  if (code && code !== '00')
    throw new EfrisError(`EFRIS: ${state.returnMessage || 'request refused'} (${code})`, code);
}

// One call. encrypted: the request content is AES encrypted (and the answer
// read with the same key).
async function call(settings, interfaceCode, payload, { encrypted = true, retried = false } = {}) {
  if (!settings.privateKey) throw new EfrisError('Add the private key first');
  const json = payload === undefined || payload === null ? '' : JSON.stringify(payload);
  const key = encrypted || interfaceCode !== 'T101' ? await symmetricKey(settings) : null;
  const content = !json
    ? ''
    : encrypted
      ? aesEncrypt(Buffer.from(json, 'utf8'), key).toString('base64')
      : Buffer.from(json, 'utf8').toString('base64');
  const signature = content ? sign(content, settings.privateKey) : '';
  const reply = await post(
    settings,
    envelope(settings, interfaceCode, content, { encrypted: encrypted && !!json, signature }),
  );
  const code = String(reply?.returnStateInfo?.returnCode ?? '');
  // An expired or refused key: agree a new one once.
  if (!retried && ['02', '03', '38', '402'].includes(code)) {
    keys.delete(keyId(settings));
    return call(settings, interfaceCode, payload, { encrypted, retried: true });
  }
  check(reply);
  let body;
  try {
    body = openContent(reply.data, key);
  } catch (error) {
    if (retried) throw error;
    keys.delete(keyId(settings));
    return call(settings, interfaceCode, payload, { encrypted, retried: true });
  }
  return body;
}

// ---- Interfaces --------------------------------------------------------

const serverTime = (settings) => call(settings, 'T101', null, { encrypted: false });
const login = (settings) => call(settings, 'T103', null, { encrypted: false });
const dictionary = (settings) => call(settings, 'T115', null, { encrypted: false });
const uploadGoods = (settings, goods) => call(settings, 'T130', goods);
const uploadInvoice = (settings, invoice) => call(settings, 'T109', invoice);
const queryInvoices = (settings, query) => call(settings, 'T106', query);
const invoiceDetails = (settings, invoiceNo) => call(settings, 'T108', { invoiceNo });

// ---- Money -------------------------------------------------------------

// Tax treatments a restaurant uses. VAT registered: standard 18 %; not
// registered (receipts): exempt or zero, as URA has set the taxpayer up.
const TAX = {
  standard: { code: '01', rate: 0.18, label: 'Standard (18%)', text: '0.18' },
  zero: { code: '02', rate: 0, label: 'Zero (0%)', text: '0' },
  exempt: { code: '03', rate: 0, label: 'Exempt (-)', text: '-' },
};

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value) => round2(value).toFixed(2);
// EFRIS truncates qty × unit price to two decimals (return code 1316).
const lineTotal = (qty, unitPrice) => Math.trunc(qty * unitPrice * 100 + 1e-6) / 100;

// Prices in Relay include VAT: the tax inside a gross amount.
const taxIn = (gross, tax) => (tax.rate ? round2((gross * tax.rate) / (1 + tax.rate)) : 0);

// The T109 invoice for one sale. lines: [{ code, name, qty, unitPrice }]
// (unit prices include tax); settings: seller details and defaults.
function buildInvoice({ settings, reference, operator, buyer, lines, payment, issuedAt }) {
  const tax = TAX[settings.taxCategory] || TAX.standard;
  const goods = lines.map((line, index) => {
    const total = lineTotal(line.qty, line.unitPrice);
    return {
      item: line.name,
      itemCode: line.code,
      qty: String(line.qty),
      unitOfMeasure: settings.unitOfMeasure,
      unitPrice: money(line.unitPrice),
      total: money(total),
      taxRate: tax.text,
      tax: money(taxIn(total, tax)),
      discountTotal: '',
      discountTaxRate: '',
      orderNumber: String(index),
      discountFlag: '2',
      deemedFlag: '2',
      exciseFlag: '2',
      categoryId: '',
      categoryName: '',
      goodsCategoryId: line.category || settings.commodityCategoryId,
      goodsCategoryName: '',
      exciseRate: '',
      exciseRule: '',
      exciseTax: '',
      pack: '',
      stick: '',
      exciseUnit: '',
      exciseCurrency: '',
      exciseRateName: '',
      vatApplicableFlag: '1',
    };
  });
  const gross = round2(goods.reduce((sum, line) => sum + Number(line.total), 0));
  const taxAmount = round2(goods.reduce((sum, line) => sum + Number(line.tax), 0));
  const net = round2(gross - taxAmount);
  return {
    sellerDetails: {
      tin: settings.tin,
      ninBrn: settings.ninBrn || '',
      legalName: settings.legalName,
      businessName: settings.businessName || settings.legalName,
      address: settings.address || '',
      mobilePhone: settings.mobilePhone || '',
      linePhone: '',
      emailAddress: settings.emailAddress,
      placeOfBusiness: settings.placeOfBusiness || settings.address || '',
      referenceNo: reference,
      branchId: '',
      // EFRIS refuses a second invoice with the same reference, so a retry
      // can never fiscalise one sale twice.
      isCheckReferenceNo: '1',
    },
    basicInformation: {
      invoiceNo: '',
      antifakeCode: '',
      deviceNo: settings.deviceNo,
      issuedDate: ugandaTime(issuedAt),
      operator: String(operator || 'RelayEats').slice(0, 150),
      currency: 'UGX',
      oriInvoiceId: '',
      invoiceType: '1',
      invoiceKind: settings.invoiceKind === 'invoice' ? '1' : '2',
      dataSource: '103',
      invoiceIndustryCode: '101',
      isBatch: '0',
    },
    buyerDetails: {
      buyerTin: '',
      buyerNinBrn: '',
      buyerPassportNum: '',
      buyerLegalName: String(buyer?.name || 'Walk-in customer').slice(0, 256),
      buyerBusinessName: '',
      buyerAddress: '',
      buyerEmail: '',
      buyerMobilePhone: String(buyer?.phone || '').slice(0, 30),
      buyerLinePhone: '',
      buyerPlaceOfBusi: '',
      buyerType: '1',
      buyerCitizenship: '',
      buyerSector: '',
      buyerReferenceNo: '',
    },
    goodsDetails: goods,
    taxDetails: [
      {
        taxCategoryCode: tax.code,
        netAmount: money(net),
        taxRate: tax.text,
        taxAmount: money(taxAmount),
        grossAmount: money(gross),
        exciseUnit: '',
        exciseCurrency: '',
        taxRateName: '',
      },
    ],
    summary: {
      netAmount: money(net),
      taxAmount: money(taxAmount),
      grossAmount: money(gross),
      itemCount: String(goods.length),
      modeCode: '1',
      remarks: String(settings.remarks || '').slice(0, 500),
      qrCode: '',
    },
    payWay: [
      {
        paymentMode: payment === 'mobile_money' ? '105' : payment === 'card' ? '106' : '102',
        paymentAmount: money(gross),
        orderNumber: 'a',
      },
    ],
    extend: {},
  };
}

// T130: one menu item (or the delivery charge) as a service good, so no
// stock has to be kept in EFRIS.
function goodsEntry({ code, name, price, settings, currency = '101', modify = false }) {
  return {
    operationType: modify ? '102' : '101',
    goodsName: String(name).slice(0, 200),
    goodsCode: code,
    measureUnit: settings.unitOfMeasure,
    unitPrice: money(price),
    currency,
    commodityCategoryId: settings.commodityCategoryId,
    haveExciseTax: '102',
    description: '',
    stockPrewarning: '0',
    havePieceUnit: '102',
    haveOtherUnit: '102',
    goodsTypeCode: '101',
    haveCustomsUnit: '102',
  };
}

module.exports = {
  generateKeyPair,
  URLS,
  TAX,
  EfrisError,
  privateKeyPem,
  decryptSymmetricKey,
  aesEncrypt,
  aesDecrypt,
  openContent,
  ugandaTime,
  lineTotal,
  taxIn,
  buildInvoice,
  goodsEntry,
  serverTime,
  login,
  dictionary,
  uploadGoods,
  uploadInvoice,
  queryInvoices,
  invoiceDetails,
  symmetricKey,
};
