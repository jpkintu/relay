// End-to-end tests for cloud/: boots a real Parse Server in-process with the
// repo's Cloud Code and drives it through the Parse JS SDK as each role.
//
// Needs a database: PARSE_TEST_DATABASE_URI, e.g.
//   mongodb://localhost:27017/          (a fresh database name is appended)
//   postgres://postgres:postgres@localhost:5432/relaytest   (must be empty)

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ParseServer } from 'parse-server';

const require = createRequire(import.meta.url);
const Parse = require('parse/node');
const FileSystemAdapter = require('@parse/fs-files-adapter');

// Check for stale handovers on every staff poll (the app throttles it).
process.env.RELAY_STALE_CHECK_MS = '0';
// The nightly Z-report is tested directly, not from the owner's polling.
process.env.RELAY_Z_CHECK_MS = '-1';
// So is the daily upkeep (cash check, retention, server address).
process.env.RELAY_UPKEEP_CHECK_MS = '-1';
// And the subscription follow-ups on the owner's activity (Relay Hosted).
process.env.RELAY_BILLING_CHECK_MS = '-1';
// Deleting unpaid restaurants in the background: only where a test asks.
process.env.RELAY_RETENTION_CHECK_MS = '-1';

const PORT = 1338;
const APP_ID = 'relay-e2e';
const MASTER_KEY = 'relay-e2e-master';
const SERVER_URL = `http://localhost:${PORT}/parse`;

function databaseUri() {
  const uri = process.env.PARSE_TEST_DATABASE_URI;
  if (!uri) throw new Error('Set PARSE_TEST_DATABASE_URI (see e2e/relay.test.mjs)');
  return uri.startsWith('mongodb') && uri.endsWith('/') ? `${uri}relay_e2e_${Date.now()}` : uri;
}

// RELAY_CLOUD_MAIN=../back4app/cloud/main.js tests the single-file bundle that
// is uploaded to Back4App; the default tests the cloud/ sources directly.
const CLOUD_MAIN = process.env.RELAY_CLOUD_MAIN
  ? path.resolve(process.env.RELAY_CLOUD_MAIN)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cloud/main.js');

// Stand-ins for the MTN MoMo and Airtel Money APIs (cloud/lib/momoApi.js
// talks to these instead of the real services).
const MOMO_PORT = 1341;
process.env.RELAY_MTN_URL = `http://localhost:${MOMO_PORT}/mtn`;
process.env.RELAY_AIRTEL_URL = `http://localhost:${MOMO_PORT}/airtel`;
process.env.RELAY_IP_URL = `http://localhost:${MOMO_PORT}/ip`;
process.env.RELAY_EFRIS_URL = `http://localhost:${MOMO_PORT}/efris`;
process.env.RELAY_WHATSAPP_URL = `http://localhost:${MOMO_PORT}/whatsapp`;
process.env.RELAY_EMAIL_URL = `http://localhost:${MOMO_PORT}/email`;
process.env.RELAY_BROADCAST_DELAY_MS = '0';
// The email service stand-in (Resend and Brevo APIs): emails it accepted.
const mailbox = [];
// The Zoho Books stand-in: what it was sent.
const zohoBooks = { contacts: [], invoices: [], payments: [], journals: [], tokens: 0 };
process.env.RELAY_ZOHO_ACCOUNTS_URL = `http://localhost:${MOMO_PORT}/zoho/accounts`;
process.env.RELAY_ZOHO_API_URL = `http://localhost:${MOMO_PORT}/zoho/books/v3`;
// The WhatsApp Cloud API stand-in: messages it accepted.
const whatsapp = { messages: [], refuse: '' };
process.env.RELAY_EFRIS_DELAY_MS = '300';
// A stand-in for URA's EFRIS: the taxpayer's key pair (the public half is
// what the taxpayer uploads to the EFRIS portal), and what it has recorded.
const EFRIS_KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const efris = {
  aes: null,
  goods: new Map(),
  invoices: new Map(),
  calls: [],
  lostAnswers: 0,
  badSignatures: 0,
  // The certificate the taxpayer has uploaded on the portal.
  publicKey: EFRIS_KEYS.publicKey,
};
// Relay Hosted: ioTec Pay, for subscription payments (cloud/lib/iotec.js).
process.env.IOTEC_AUTH_URL = `http://localhost:${MOMO_PORT}/iotec/connect/token`;
process.env.IOTEC_API_URL = `http://localhost:${MOMO_PORT}/iotec`;
process.env.IOTEC_CLIENT_ID = 'iotec-client';
process.env.IOTEC_CLIENT_SECRET = 'iotec-secret';
process.env.IOTEC_WALLET_ID = 'wallet-1';
const momo = {
  mtn: new Map(),
  airtel: new Map(),
  iotec: new Map(),
  polls: new Map(),
  ip: '203.0.113.10',
};
let momoServer;
function startMomoMock() {
  const app = express();
  app.use(express.json());
  // MTN: token (Basic auth + subscription key), request to pay, status.
  app.post('/mtn/collection/token/', (req, res) => {
    const [user, key] = Buffer.from(String(req.headers.authorization).split(' ')[1] || '', 'base64')
      .toString()
      .split(':');
    if (req.headers['ocp-apim-subscription-key'] !== 'mtn-sub' || !user || key === 'bad')
      return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ access_token: 'mtn-token', token_type: 'access_token', expires_in: 3600 });
  });
  app.post('/mtn/collection/v1_0/requesttopay', (req, res) => {
    if (req.headers.authorization !== 'Bearer mtn-token') return res.status(401).end();
    momo.mtn.set(req.headers['x-reference-id'], {
      ...req.body,
      target: req.headers['x-target-environment'],
    });
    res.status(202).end();
  });
  app.get('/mtn/collection/v1_0/requesttopay/:id', (req, res) => {
    const request = momo.mtn.get(req.params.id);
    if (!request) return res.status(404).json({ message: 'Not found' });
    const polls = (momo.polls.get(req.params.id) || 0) + 1;
    momo.polls.set(req.params.id, polls);
    // The customer answers on the second check; numbers ending 99 decline.
    if (polls < 2) return res.json({ status: 'PENDING' });
    if (request.payer.partyId.endsWith('99'))
      return res.json({ status: 'FAILED', reason: 'APPROVAL_REJECTED' });
    // MTN's own test numbers answer in a fixed way.
    if (request.payer.partyId === '46733123451') return res.json({ status: 'REJECTED' });
    if (request.payer.partyId === '46733123452') return res.json({ status: 'TIMEOUT' });
    res.json({
      status: 'SUCCESSFUL',
      financialTransactionId: `MTN${polls}${req.params.id.slice(0, 6)}`,
    });
  });
  app.post('/mtn/v1_0/apiuser', (req, res) => res.status(201).end());
  app.post('/mtn/v1_0/apiuser/:id/apikey', (req, res) =>
    res.status(201).json({ apiKey: 'sandbox-api-key' }),
  );
  // Airtel: token (client credentials), USSD push, status.
  app.post('/airtel/auth/oauth2/token', (req, res) => {
    if (req.body.client_secret !== 'airtel-secret')
      return res.status(401).json({ error: 'invalid_client', error_description: 'Bad client' });
    res.json({ access_token: 'airtel-token', expires_in: 180, token_type: 'bearer' });
  });
  app.post('/airtel/merchant/v1/payments/', (req, res) => {
    if (req.headers.authorization !== 'Bearer airtel-token') return res.status(401).end();
    momo.airtel.set(req.body.transaction.id, { ...req.body, country: req.headers['x-country'] });
    res.json({
      data: { transaction: { id: req.body.transaction.id, status: 'Success.' } },
      status: { code: '200', success: true, message: 'Success.' },
    });
  });
  app.get('/airtel/standard/v1/payments/:id', (req, res) => {
    const polls = (momo.polls.get(req.params.id) || 0) + 1;
    momo.polls.set(req.params.id, polls);
    res.json({
      data: {
        transaction: {
          id: req.params.id,
          status: polls < 2 ? 'TIP' : 'TS',
          airtel_money_id: polls < 2 ? '' : `AM${req.params.id.slice(0, 8)}`,
          message: 'Paid',
        },
      },
      status: { code: '200', success: true },
    });
  });
  // ioTec: token (form-encoded client credentials), collect, status.
  app.post('/iotec/connect/token', express.urlencoded({ extended: false }), (req, res) => {
    if (req.body.client_secret !== 'iotec-secret' || req.body.grant_type !== 'client_credentials')
      return res.status(400).json({ error: 'invalid_client' });
    res.json({ access_token: 'iotec-token', expires_in: 300, token_type: 'Bearer' });
  });
  app.post('/iotec/api/collections/collect', (req, res) => {
    if (req.headers.authorization !== 'Bearer iotec-token') return res.status(401).end();
    const id = `io-${momo.iotec.size + 1}`;
    momo.iotec.set(id, { ...req.body, polls: 0 });
    res.json({ id, status: 'Pending', statusMessage: 'Request is being processed' });
  });
  app.get('/iotec/api/collections/status/:id', (req, res) => {
    if (req.headers.authorization !== 'Bearer iotec-token') return res.status(401).end();
    const payment = momo.iotec.get(req.params.id);
    if (!payment) return res.status(404).send('Not Found');
    payment.polls += 1;
    // The payer answers on the second check; numbers ending 99 decline.
    if (payment.polls < 2) return res.json({ id: req.params.id, status: 'Pending' });
    if (payment.payer.endsWith('99'))
      return res.json({ id: req.params.id, status: 'Failed', statusMessage: 'Payer declined' });
    res.json({
      id: req.params.id,
      status: 'Success',
      statusMessage: 'Paid',
      vendorTransactionId: `MP${req.params.id}`,
    });
  });
  // The server's public address, as a "what is my IP" service reports it.
  app.get('/ip', (req, res) => res.type('text/plain').send(momo.ip));
  // EFRIS: one endpoint; the interface code is in the envelope.
  const aesKey = () => efris.aes;
  const cipher = (encrypt, buffer) => {
    const c = encrypt
      ? crypto.createCipheriv('aes-128-ecb', aesKey(), null)
      : crypto.createDecipheriv('aes-128-ecb', aesKey(), null);
    return Buffer.concat([c.update(buffer), c.final()]);
  };
  const answer = (res, body, { encrypted = true, code = '00', message = 'SUCCESS' } = {}) => {
    const json = body === null ? '' : JSON.stringify(body);
    res.json({
      data: {
        content: !json
          ? ''
          : encrypted
            ? cipher(true, Buffer.from(json)).toString('base64')
            : Buffer.from(json).toString('base64'),
        signature: '',
        dataDescription: {
          codeType: encrypted && json ? '1' : '0',
          encryptCode: '2',
          zipCode: '0',
        },
      },
      globalInfo: {},
      returnStateInfo: { returnCode: code, returnMessage: message },
    });
  };
  const refuse = (res, code, message) => answer(res, null, { code, message });
  app.post('/efris', (req, res) => {
    const { data = {}, globalInfo = {} } = req.body || {};
    const code = globalInfo.interfaceCode;
    efris.calls.push(code);
    if (globalInfo.appId !== 'AP04' || globalInfo.tin !== '1000029771')
      return refuse(res, '05', 'AppID error');
    if (globalInfo.deviceNo !== 'TCS9e0df01728335239')
      return refuse(res, '400', 'Device does not exist');
    const time = new Date(`${globalInfo.requestTime.replace(' ', 'T')}+03:00`);
    if (!(Math.abs(time - Date.now()) < 600000))
      return refuse(
        res,
        '28',
        'RequestTime differs from the current time by more than ten minutes',
      );
    if (data.content) {
      const signed = crypto.verify(
        'sha1',
        Buffer.from(data.content),
        efris.publicKey,
        Buffer.from(String(data.signature || ''), 'base64'),
      );
      if (!signed) {
        efris.badSignatures += 1;
        return refuse(res, '38', 'Signature value is invalid!');
      }
    }
    let body = null;
    if (data.content)
      body = JSON.parse(
        data.dataDescription?.codeType === '1'
          ? cipher(false, Buffer.from(data.content, 'base64')).toString()
          : Buffer.from(data.content, 'base64').toString(),
      );
    if (code === 'T104') {
      efris.aes = crypto.randomBytes(16);
      const passowrdDes = crypto
        .publicEncrypt(
          { key: efris.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(efris.aes.toString('base64')),
        )
        .toString('base64');
      return answer(res, { passowrdDes, sign: 'x' }, { encrypted: false });
    }
    if (!efris.aes) return refuse(res, '402', 'Device key expired');
    if (code === 'T103')
      return answer(res, {
        device: { deviceNo: globalInfo.deviceNo, deviceStatus: '252' },
        taxpayer: {
          tin: '1000029771',
          ninBrn: '80020000000001',
          legalName: 'MAMA ROSE KITCHEN LIMITED',
          businessName: 'Mama Rose Kitchen',
          contactEmail: 'tax@mamarose.example',
          contactMobile: '0772000000',
          placeOfBusiness: 'Plot 1 Kampala Road',
        },
        taxType: [{ taxTypeName: 'Value Added Tax', taxTypeCode: '301' }],
        environment: '1',
      });
    if (code === 'T115')
      return answer(res, {
        rateUnit: [
          { value: 'PP', name: 'Piece' },
          { value: '101', name: 'per stick' },
        ],
        currencyType: [
          { value: '101', name: 'UGX' },
          { value: '102', name: 'USD' },
        ],
      });
    if (code === 'T130') {
      const failures = [];
      for (const goods of body) {
        const known = efris.goods.has(goods.goodsCode);
        const problem =
          goods.commodityCategoryId !== '90101501'
            ? ['616', 'commodityCategoryId: invalid field value!']
            : goods.measureUnit !== 'PP'
              ? ['606', 'measureUnit:Invalid field value']
              : known && goods.operationType === '101'
                ? ['602', 'goodsCode already exists']
                : !known && goods.operationType === '102'
                  ? ['684', 'product does not exist!']
                  : null;
        if (problem) failures.push({ ...goods, returnCode: problem[0], returnMessage: problem[1] });
        else efris.goods.set(goods.goodsCode, goods.goodsName);
      }
      return answer(res, failures.length ? failures : null);
    }
    if (code === 'T109') {
      const reference = body.sellerDetails.referenceNo;
      if (efris.invoices.has(reference))
        return refuse(res, '2253', "The seller's reference number already exists!");
      for (const line of body.goodsDetails)
        if (efris.goods.get(line.itemCode) !== line.item)
          return refuse(
            res,
            '2122',
            `goodsDetails-->itemCode:Item code and Name is not configured with URA. item code ${line.itemCode}, item name ${line.item}.`,
          );
      const [tax] = body.taxDetails;
      if (Math.abs(Number(tax.netAmount) + Number(tax.taxAmount) - Number(tax.grossAmount)) > 0.001)
        return refuse(res, '1342', "'netAmount' plus 'taxAmount' must equal 'grossAmount'!");
      const number = String(322000150000 + efris.invoices.size + 1);
      const record = {
        body,
        basicInformation: {
          ...body.basicInformation,
          invoiceId: `id${number}`,
          invoiceNo: number,
          antifakeCode: `3135${number}`,
        },
        summary: { ...body.summary, qrCode: `https://efris.example/verify/${number}` },
      };
      efris.invoices.set(reference, record);
      // The answer is lost on its way back (the invoice was still issued).
      if (efris.lostAnswers > 0) {
        efris.lostAnswers -= 1;
        return res.status(502).send('Bad gateway');
      }
      return answer(res, { ...body, ...record, body: undefined });
    }
    if (code === 'T106') {
      const record = efris.invoices.get(body.referenceNo);
      return answer(res, {
        page: { pageNo: '1', pageSize: '10', totalSize: record ? '1' : '0' },
        records: record ? [{ invoiceNo: record.basicInformation.invoiceNo }] : [],
      });
    }
    if (code === 'T108') {
      const record = [...efris.invoices.values()].find(
        (r) => r.basicInformation.invoiceNo === body.invoiceNo,
      );
      if (!record) return refuse(res, '1561', 'invoiceNo:Invoice does not exist!');
      return answer(res, { basicInformation: record.basicInformation, summary: record.summary });
    }
    return refuse(res, '01', 'Interface coding error');
  });
  // Zoho: OAuth (the Self Client's grant code, then refresh tokens) and the
  // Books API, checking the token and the organization on every call.
  app.post('/zoho/accounts/oauth/v2/token', express.urlencoded({ extended: false }), (req, res) => {
    const b = req.body;
    if (b.client_id !== 'zoho-client' || b.client_secret !== 'zoho-secret')
      return res.json({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      if (b.code !== 'grant-ok') return res.json({ error: 'invalid_code' });
      zohoBooks.tokens += 1;
      return res.json({
        access_token: `zat-${zohoBooks.tokens}`,
        refresh_token: 'zrt',
        expires_in: 3600,
      });
    }
    if (b.grant_type === 'refresh_token' && b.refresh_token === 'zrt') {
      zohoBooks.tokens += 1;
      return res.json({ access_token: `zat-${zohoBooks.tokens}`, expires_in: 3600 });
    }
    res.json({ error: 'invalid_grant' });
  });
  app.use('/zoho/books/v3', express.json(), (req, res, next) => {
    if (!/^Zoho-oauthtoken zat-\d+$/.test(req.headers.authorization || ''))
      return res.status(401).json({ code: 57, message: 'You are not authorized' });
    if (req.query.organization_id !== '123456')
      return res.status(400).json({ code: 6041, message: 'Organization does not exist' });
    next();
  });
  app.get('/zoho/books/v3/organizations/:id', (req, res) =>
    res.json({ code: 0, organization: { organization_id: req.params.id, name: 'Relay Ltd' } }),
  );
  app.get('/zoho/books/v3/chartofaccounts', (req, res) =>
    res.json({
      code: 0,
      chartofaccounts: [
        {
          account_id: 'acc-def',
          account_name: 'Unearned revenue',
          account_type: 'other_current_liability',
        },
        { account_id: 'acc-rev', account_name: 'Subscription revenue', account_type: 'income' },
        { account_id: 'acc-bank', account_name: 'ioTec wallet', account_type: 'bank' },
      ],
    }),
  );
  app.get('/zoho/books/v3/contacts', (req, res) =>
    res.json({
      code: 0,
      contacts: zohoBooks.contacts.filter((c) => c.contact_name === req.query.contact_name),
    }),
  );
  app.post('/zoho/books/v3/contacts', (req, res) => {
    const contact = { ...req.body, contact_id: `c-${zohoBooks.contacts.length + 1}` };
    zohoBooks.contacts.push(contact);
    res.json({ code: 0, contact });
  });
  app.post('/zoho/books/v3/invoices', (req, res) => {
    if (req.query.ignore_auto_number_generation !== 'true')
      return res.json({ code: 4097, message: 'Invoice number is auto-generated' });
    if (zohoBooks.invoices.some((i) => i.invoice_number === req.body.invoice_number))
      return res.json({ code: 1001, message: 'Invoice number already exists' });
    const invoice = {
      ...req.body,
      invoice_id: `i-${zohoBooks.invoices.length + 1}`,
      status: 'draft',
    };
    zohoBooks.invoices.push(invoice);
    res.json({ code: 0, invoice });
  });
  app.post('/zoho/books/v3/invoices/:id/status/sent', (req, res) => {
    const invoice = zohoBooks.invoices.find((i) => i.invoice_id === req.params.id);
    if (!invoice) return res.status(404).json({ code: 5, message: 'Invoice not found' });
    invoice.status = 'sent';
    res.json({ code: 0, message: 'Invoice status has been changed to Sent.' });
  });
  app.post('/zoho/books/v3/customerpayments', (req, res) => {
    const applied = req.body.invoices?.[0];
    const invoice = zohoBooks.invoices.find((i) => i.invoice_id === applied?.invoice_id);
    if (!invoice || invoice.status !== 'sent')
      return res.json({ code: 24016, message: 'Payments cannot be recorded for draft invoices' });
    const payment = { ...req.body, payment_id: `p-${zohoBooks.payments.length + 1}` };
    zohoBooks.payments.push(payment);
    res.json({ code: 0, payment });
  });
  app.post('/zoho/books/v3/journals', (req, res) => {
    const lines = req.body.line_items || [];
    const sum = (side) =>
      lines.filter((l) => l.debit_or_credit === side).reduce((n, l) => n + l.amount, 0);
    if (sum('debit') !== sum('credit'))
      return res.json({ code: 13002, message: 'Debits and credits do not match' });
    const journal = { ...req.body, journal_id: `j-${zohoBooks.journals.length + 1}` };
    zohoBooks.journals.push(journal);
    res.json({ code: 0, journal });
  });
  // Deleting, as Zoho does: not an invoice with a payment on it, nor a
  // customer with invoices.
  const drop = (list, key, id) => {
    const i = list.findIndex((x) => x[key] === id);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  };
  app.delete('/zoho/books/v3/customerpayments/:id', (req, res) =>
    drop(zohoBooks.payments, 'payment_id', req.params.id)
      ? res.json({ code: 0, message: 'The payment has been deleted.' })
      : res.status(404).json({ code: 1002, message: 'Payment does not exist.' }),
  );
  app.delete('/zoho/books/v3/invoices/:id', (req, res) => {
    if (zohoBooks.payments.some((p) => p.invoices?.[0]?.invoice_id === req.params.id))
      return res.json({ code: 1037, message: 'Invoices with payments cannot be deleted.' });
    return drop(zohoBooks.invoices, 'invoice_id', req.params.id)
      ? res.json({ code: 0, message: 'The invoice has been deleted.' })
      : res.status(404).json({ code: 1002, message: 'Invoice does not exist.' });
  });
  app.delete('/zoho/books/v3/contacts/:id', (req, res) => {
    if (zohoBooks.invoices.some((i) => i.customer_id === req.params.id))
      return res.json({ code: 3021, message: 'The contact has transactions.' });
    return drop(zohoBooks.contacts, 'contact_id', req.params.id)
      ? res.json({ code: 0, message: 'The contact has been deleted.' })
      : res.status(404).json({ code: 1002, message: 'Contact does not exist.' });
  });
  app.delete('/zoho/books/v3/journals/:id', (req, res) =>
    drop(zohoBooks.journals, 'journal_id', req.params.id)
      ? res.json({ code: 0, message: 'The journal has been deleted.' })
      : res.status(404).json({ code: 1002, message: 'Journal does not exist.' }),
  );
  app.post('/email/emails', express.json(), (req, res) => {
    if (req.headers.authorization !== 'Bearer email-key')
      return res.status(401).json({ message: 'API key is invalid' });
    mailbox.push({
      to: req.body.to[0],
      subject: req.body.subject,
      text: req.body.text,
      html: req.body.html,
      template: req.body.template,
    });
    res.json({ id: `email-${mailbox.length}` });
  });
  app.post('/email/smtp/email', express.json(), (req, res) => {
    if (req.headers['api-key'] !== 'email-key')
      return res.status(401).json({ message: 'Key not found' });
    mailbox.push({
      to: req.body.to[0].email,
      subject: req.body.subject,
      text: req.body.textContent,
      html: req.body.htmlContent,
      template: req.body.templateId
        ? { id: req.body.templateId, variables: req.body.params }
        : undefined,
    });
    res.json({ messageId: `email-${mailbox.length}` });
  });
  app.post('/whatsapp/:phoneId/messages', express.json(), (req, res) => {
    if (req.headers.authorization !== 'Bearer wa-token')
      return res.status(401).json({ error: { message: 'Invalid OAuth access token' } });
    if (whatsapp.refuse === req.body.to)
      return res.status(400).json({ error: { message: 'Recipient not on WhatsApp' } });
    whatsapp.messages.push({ phoneId: req.params.phoneId, ...req.body });
    res.json({ messages: [{ id: `wamid.${whatsapp.messages.length}` }] });
  });
  momoServer = app.listen(MOMO_PORT);
}

let httpServer;
let parseServer;
const LIVE_CLASSES = ['Order', 'CashHandover', 'Notification'];

before(async () => {
  startMomoMock();
  parseServer = new ParseServer({
    databaseURI: databaseUri(),
    cloud: CLOUD_MAIN,
    appId: APP_ID,
    masterKey: MASTER_KEY,
    serverURL: SERVER_URL,
    // Worst-case server settings: the Cloud Code must stay safe even when the
    // host leaves these permissive.
    allowClientClassCreation: true,
    enforcePrivateUsers: false,
    masterKeyIps: ['0.0.0.0/0', '::/0'],
    silent: true,
    logsFolder: null,
    // Back4App runs Cloud Code with direct access (no HTTP round trip), which
    // changes what save() returns. RELAY_DIRECT_ACCESS=true reproduces it.
    directAccess: process.env.RELAY_DIRECT_ACCESS === 'true',
    // Dish photos: stored on disk (e2e/files/), so Postgres runs need no GridFS.
    filesAdapter: new FileSystemAdapter(),
    // The classes the app subscribes to for live updates (see src/lib/live.ts).
    liveQuery: { classNames: LIVE_CLASSES },
    // The release checklist's Custom Parse Options (docs/ROADMAP.md §2):
    // five wrong PINs lock sign-in for 15 minutes (S5); sessions last 30
    // days (S7).
    accountLockout: { duration: 15, threshold: 5 },
    sessionLength: 30 * 86400,
  });
  await parseServer.start();
  const app = express();
  app.use('/parse', parseServer.app);
  httpServer = app.listen(PORT);
  await ParseServer.createLiveQueryServer(httpServer);
  Parse.initialize(APP_ID, undefined, MASTER_KEY);
  Parse.serverURL = SERVER_URL;
});

after(async () => {
  momoServer?.close();
  httpServer?.close();
  await parseServer?.handleShutdown?.();
});

const as = (user) => ({ sessionToken: user.getSessionToken() });
// Each person's PIN, so steps that ask for it again get it by default.
const PINS = {
  rita: '2468', // changed from 1234 in "a rider changes their PIN only through the app"
  carl: '5678',
  ron: '4321',
  cora: '8642',
  nia: '2468',
  cleo: '9753',
  owner: 'owner-pass',
};
const PIN_STEPS = ['createHandover', 'endShift', 'payRider', 'recordTillPayout'];
// Relay Hosted: usernames are stored as name@restaurant-code.
const CODE = 'mama-rose';
const plainName = (user) => String(user?.get('username') || '').split('@')[0];
const run = (name, params, user) => {
  const pin = PINS[plainName(user)];
  const withPin =
    PIN_STEPS.includes(name) && params && !('pin' in params) && pin ? { ...params, pin } : params;
  // The Admin area asks for the owner's PIN again, as the app does.
  return Parse.Cloud.run(name, withPin, user ? as(user) : {}).catch(async (error) => {
    if (!user || !pin || !/Admin is locked/.test(String(error.message))) throw error;
    await Parse.Cloud.run('unlockAdmin', { pin }, as(user));
    return Parse.Cloud.run(name, withPin, as(user));
  });
};
const login = (username, password, code = CODE) =>
  Parse.User.logIn(username.includes('@') ? username : `${username}@${code}`, password);

async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.match(String(error.message), pattern);
    return true;
  });
}

// Shared state across the ordered tests below.
const s = {};

describe('restaurant sign-up (Relay Hosted)', () => {
  test('without a restaurant the sign-in screen offers the sign-up page', async () => {
    const info = await run('getAppInfo');
    assert.equal(info.hosted, true);
    assert.equal(info.found, false);
    assert.equal(info.signUpOpen, true);
    assert.equal(info.trialDays, 14);
    assert.equal(info.restaurantName, undefined);
    assert.equal((await run('getAppInfo', { restaurant: 'nobody-here' })).found, false);
  });

  test('a restaurant signs up and its owner can sign in', async () => {
    assert.deepEqual(await run('checkRestaurantCode', { code: 'Mama Rose' }), {
      code: CODE,
      free: true,
    });
    await rejects(
      run('signUpRestaurant', {
        restaurantName: 'Mama Rose',
        ownerName: 'Rose',
        username: 'owner',
      }),
      /PIN or password/,
    );
    const result = await run('signUpRestaurant', {
      restaurantName: 'Mama Rose',
      // The tests use every part of the app: the Enterprise plan.
      plan: 'enterprise',
      ownerName: 'Rose Owner',
      username: 'owner',
      pin: 'owner-pass',
      phone: '0772 123456',
      email: 'rose@example.com',
    });
    assert.deepEqual(result, { code: CODE, username: `owner@${CODE}` });
    assert.equal((await run('checkRestaurantCode', { code: CODE })).free, false);
    s.owner = await login('owner', 'owner-pass');
    const profile = await run('getMyProfile', {}, s.owner);
    assert.equal(profile.role, 'admin');
    assert.equal(profile.username, 'owner');
    assert.equal(profile.canInitialize, false);
    assert.equal(profile.config.currencySymbol, 'UGX');
    assert.equal(profile.config.restaurantName, 'Mama Rose');
    assert.equal(profile.restaurant.code, CODE);
    s.restaurantId = profile.restaurant.id;
    assert.equal(profile.restaurant.status, 'trial');
    assert.ok(new Date(profile.restaurant.trialEndsAt) > new Date(Date.now() + 13 * 86400000));
    const info = await run('getAppInfo', { restaurant: CODE });
    assert.equal(info.found, true);
    assert.equal(info.restaurantName, 'Mama Rose');
    assert.equal(info.ownerSetupOpen, false);
  });

  test('codes are unique and reserved words are refused', async () => {
    await rejects(
      run('signUpRestaurant', {
        restaurantName: 'Mama Rose',
        ownerName: 'Someone',
        username: 'boss',
        pin: 'secret-99',
        phone: '0772000000',
        email: 'someone@example.com',
      }),
      /is taken/,
    );
    assert.equal((await run('checkRestaurantCode', { code: 'admin' })).free, false);
  });

  test('nobody signs up as a plain Parse user', async () => {
    await rejects(
      new Parse.User({ username: 'intruder', password: 'x1234' }).signUp(),
      /created by the restaurant administrator/,
    );
    await rejects(run('bootstrapOwner', {}, s.owner), /sign-up page/);
  });

  test('a user created outside the app gets no role', async () => {
    const outsider = new Parse.User({ username: 'google-user', password: 'g-pass-123' });
    await outsider.signUp(null, { useMasterKey: true });
    const signedIn = await Parse.User.logIn('google-user', 'g-pass-123');
    const profile = await run('getMyProfile', {}, signedIn);
    assert.equal(profile.role, null);
    assert.equal(profile.restaurant, null);
    assert.equal(profile.canInitialize, false);
  });
});

describe('team and roles (B1)', () => {
  test('owner creates rider and cashier with sequential codes', async () => {
    const rider = await run(
      'adminCreateTeamMember',
      { name: 'Rita Rider', username: 'rita', pin: '1234', role: 'rider' },
      s.owner,
    );
    const cashier = await run(
      'adminCreateTeamMember',
      { name: 'Carl Cashier', username: 'carl', pin: '5678', role: 'cashier' },
      s.owner,
    );
    const rider2 = await run(
      'adminCreateTeamMember',
      { name: 'Ron Rider', username: 'ron', pin: '4321', role: 'rider' },
      s.owner,
    );
    assert.equal(rider.code, 'R-001');
    assert.equal(rider2.code, 'R-002');
    assert.equal(cashier.code, 'C-001');
    await run(
      'adminUpdateMember',
      { id: rider.id, commissionType: 'hybrid', commissionPerOrder: 1000, commissionPercent: 10 },
      s.owner,
    );
    s.rider = await login('rita', '1234');
    s.rider2 = await login('ron', '4321');
    s.cashier = await login('carl', '5678');
    // Cashiers work the board only inside a shift with a counted till.
    await run('startShift', { kind: 'cashier', openingFloat: 50000 }, s.cashier);
  });

  test('riders and cashiers learn their own role from getMyProfile', async () => {
    const rider = await run('getMyProfile', {}, s.rider);
    assert.equal(rider.role, 'rider');
    assert.equal(rider.code, 'R-001');
    assert.equal(rider.name, 'Rita Rider');
    assert.equal(rider.canInitialize, false);
    assert.deepEqual(rider.commission, { type: 'hybrid', perOrder: 1000, percent: 10 });
    const cashier = await run('getMyProfile', {}, s.cashier);
    assert.equal(cashier.role, 'cashier');
    assert.equal(cashier.canInitialize, false);
  });

  test('changing role assigns the new code', async () => {
    const ron = await run('getMyProfile', {}, s.rider2);
    await run('adminChangeRole', { userId: ron.id, role: 'cashier' }, s.owner);
    const after = await run('getMyProfile', {}, s.rider2);
    assert.equal(after.role, 'cashier');
    await run('adminChangeRole', { userId: ron.id, role: 'rider' }, s.owner);
  });
});

describe('write protection (S1, S4, S8)', () => {
  test('menu is only served to signed-in users (S2)', async () => {
    await rejects(run('getOperationalMenu'), /Sign in required/);
    s.menu = (await run('getOperationalMenu', {}, s.rider)).items;
    assert.equal(s.menu.length, 6);
  });

  test('a rider cannot edit their own commission, status or code', async () => {
    const me = Parse.User.createWithoutData(s.rider.id);
    me.set('commissionPerOrder', 50000);
    await rejects(me.save(null, as(s.rider)), /cannot change commissionPerOrder/);
    const again = Parse.User.createWithoutData(s.rider.id);
    again.set('active', true);
    await rejects(again.save(null, as(s.rider)), /cannot change active/);
  });

  test('a rider changes their PIN only through the app, with the old PIN', async () => {
    const me = Parse.User.createWithoutData(s.rider.id);
    me.set('password', '2468');
    await rejects(me.save(null, as(s.rider)), /cannot change password/);
    await run('changeMyPin', { oldPin: '1234', newPin: '2468' }, s.rider);
    s.rider = await login('rita', '2468');
  });

  test('user records are not publicly readable', async () => {
    const query = new Parse.Query(Parse.User);
    query.equalTo('username', `rita@${CODE}`);
    assert.equal(await query.first(), undefined);
    const byRider2 = new Parse.Query(Parse.User);
    byRider2.equalTo('username', `rita@${CODE}`);
    assert.equal(await byRider2.first(as(s.rider2)), undefined);
  });

  test('applySecurity runs for the owner and not for others', async () => {
    // An account made with the master key and a public-read ACL, like
    // accounts made before this release.
    const old = new Parse.User({ username: `legacy@${CODE}`, password: 'legacy-pass-1' });
    old.set('tenant', { __type: 'Pointer', className: 'Restaurant', objectId: s.restaurantId });
    await old.signUp(null, { useMasterKey: true });
    const legacy = new Parse.Query(Parse.User).equalTo('username', `legacy@${CODE}`);
    assert.ok(await legacy.first(), 'legacy user starts out publicly readable');
    const result = await run('adminApplySecurity', {}, s.owner);
    assert.ok(result._User >= 1);
    assert.equal(await legacy.first(), undefined);
    await rejects(run('adminApplySecurity', {}, s.cashier), /admin role required/);
  });
});

describe('order to cash', () => {
  test('rider places an order with a sequential daily code', async () => {
    const item = s.menu.find((m) => m.title === 'Smoky chicken bowl');
    const placed = await run(
      'createOrder',
      {
        customerName: 'Joel',
        deliveryAddress: 'Kololo',
        items: [{ id: item.id, quantity: 2 }],
        channel: 'phone',
        paymentMethod: 'cash',
      },
      s.rider,
    );
    assert.match(placed.orderCode, /^ORD-\d{8}-0001$/);
    assert.equal(placed.total, 18500 * 2 + 3000);
    s.orderId = placed.id;
  });

  test('the rider cannot rewrite the order through the REST API', async () => {
    const order = await new Parse.Query('Order').get(s.orderId, as(s.rider));
    order.set({ cashStatus: 'RECONCILED', commissionAmount: 999999 });
    await rejects(
      order.save(null, as(s.rider)),
      /must go through the app|Permission denied|Object not found/,
    );
    await rejects(
      order.destroy(as(s.rider)),
      /must go through the app|Permission denied|Object not found/,
    );
  });

  test('another rider cannot see the order', async () => {
    await rejects(new Parse.Query('Order').get(s.orderId, as(s.rider2)), /Object not found/);
  });

  test('clients cannot create business objects directly (S1)', async () => {
    const order = new Parse.Object('Order', { total: 1, status: 'DELIVERED' });
    await rejects(order.save(null, as(s.rider)), /must go through the app|Permission denied/);
    const config = new Parse.Object('Configuration', { maxRiderFloat: 0 });
    await rejects(config.save(null, as(s.owner)), /must go through the app|Permission denied/);
  });

  test('cashier sees the ticket with the rider name and items', async () => {
    const query = new Parse.Query('Order');
    query.include('createdBy');
    const order = await query.get(s.orderId, as(s.cashier));
    assert.equal(order.get('createdBy').get('name'), 'Rita Rider');
    const items = await new Parse.Query('OrderItem').equalTo('order', order).find(as(s.cashier));
    assert.equal(items[0].get('quantity'), 2);
  });

  test('kitchen and rider move the order to delivered, commission is computed', async () => {
    await rejects(
      run('transitionOrder', { orderId: s.orderId, action: 'accept' }, s.rider),
      /Staff access required/,
    );
    for (const action of ['accept', 'prepare', 'ready'])
      await run('transitionOrder', { orderId: s.orderId, action }, s.cashier);
    await run('transitionOrder', { orderId: s.orderId, action: 'pickup' }, s.rider);
    await run(
      'transitionOrder',
      { orderId: s.orderId, action: 'deliver', amountCollected: 40000 },
      s.rider,
    );
    const order = await new Parse.Query('Order').get(s.orderId, as(s.rider));
    assert.equal(order.get('status'), 'DELIVERED');
    assert.equal(order.get('cashStatus'), 'WITH_RIDER');
    // hybrid: 1000 + 10% of 37000 subtotal, plus the 3000 delivery fee
    assert.equal(order.get('commissionBase'), 4700);
    assert.equal(order.get('deliveryPay'), 3000);
    assert.equal(order.get('commissionAmount'), 7700);
  });

  test('cash handover is created by the rider and confirmed by the cashier', async () => {
    const handover = await run('createHandover', { orderIds: [s.orderId] }, s.rider);
    assert.equal(handover.amount, 40000);
    const row = await new Parse.Query('CashHandover').get(handover.id, as(s.cashier));
    assert.match(row.get('handoverCode'), /^HO-\d{8}-001$/);
    await rejects(
      run('confirmHandover', { handoverId: handover.id, countedAmount: 39000 }, s.cashier),
      /must match the ticked orders/,
    );
    await rejects(
      run('confirmHandover', { handoverId: handover.id, countedAmount: 40000 }, s.rider),
      /cashier or admin role required/,
    );
    await run('confirmHandover', { handoverId: handover.id, countedAmount: 40000 }, s.cashier);
    const order = await new Parse.Query('Order').get(s.orderId, as(s.rider));
    assert.equal(order.get('cashStatus'), 'RECONCILED');
  });

  test('the second order of the day gets the next code', async () => {
    const placed = await run(
      'createOrder',
      {
        customerName: 'Ann',
        deliveryAddress: 'Ntinda',
        items: [{ id: s.menu[0].id, quantity: 1 }],
      },
      s.rider,
    );
    assert.match(placed.orderCode, /^ORD-\d{8}-0002$/);
  });
});

describe('preview mode (S2)', () => {
  test('is off unless RELAY_ENABLE_PREVIEW=true', async () => {
    delete process.env.RELAY_ENABLE_PREVIEW;
    assert.equal((await run('getAppInfo')).previewEnabled, false);
    await rejects(run('getPreviewOrders'), /Preview mode is disabled/);
    await rejects(
      run('createPreviewOrder', {
        customerName: 'x',
        deliveryAddress: 'y',
        items: [{ id: '1', quantity: 1 }],
      }),
      /Preview mode is disabled/,
    );
  });

  test('two first loads at once seed the demo tickets once (U6)', async () => {
    process.env.RELAY_ENABLE_PREVIEW = 'true';
    try {
      const [a, b] = await Promise.all([run('getPreviewOrders'), run('getPreviewOrders')]);
      assert.equal(a.length, 3);
      assert.deepEqual(b.map((row) => row.id).sort(), a.map((row) => row.id).sort());
      assert.equal(new Set(a.map((row) => row.code)).size, 3);
    } finally {
      delete process.env.RELAY_ENABLE_PREVIEW;
    }
  });

  test('works when enabled and stays out of operational orders', async () => {
    process.env.RELAY_ENABLE_PREVIEW = 'true';
    try {
      const demo = await run('createPreviewOrder', {
        customerName: 'x',
        deliveryAddress: 'y',
        items: [{ id: '1', quantity: 1 }],
      });
      assert.match(demo.orderCode, /^DEMO-/);
      await rejects(new Parse.Query('DemoOrder').get(demo.id, as(s.owner)), /not found|Permission/);
    } finally {
      delete process.env.RELAY_ENABLE_PREVIEW;
    }
  });
});

describe('owner recovery (master key only)', () => {
  const master = { useMasterKey: true };

  test('is refused without the master key', async () => {
    await rejects(
      run('recoverOwner', { username: 'boss', password: 'boss-pass-1' }, s.owner),
      /Master key required/,
    );
    await rejects(
      run('recoverOwner', { username: 'boss', password: 'boss-pass-1' }),
      /Master key required/,
    );
  });

  test('needs the restaurant code', async () => {
    await rejects(
      Parse.Cloud.run('recoverOwner', { username: 'boss', password: 'boss-pass-1' }, master),
      /restaurant code/,
    );
  });

  test('creates a new owner even though accounts already exist', async () => {
    const result = await Parse.Cloud.run(
      'recoverOwner',
      { username: 'Boss', password: 'boss-pass-1', email: 'boss@example.com', restaurant: CODE },
      master,
    );
    assert.deepEqual(result, { username: 'boss', created: true, role: 'admin' });
    const boss = await login('boss', 'boss-pass-1');
    assert.equal((await run('getMyProfile', {}, boss)).role, 'admin');
  });

  test('resets the password of an existing account', async () => {
    const result = await Parse.Cloud.run(
      'recoverOwner',
      { username: 'boss', password: 'new-boss-pass', restaurant: CODE },
      master,
    );
    assert.equal(result.created, false);
    await rejects(login('boss', 'boss-pass-1'), /Invalid username\/password/);
    const boss = await login('boss', 'new-boss-pass');
    assert.equal((await run('getMyProfile', {}, boss)).role, 'admin');
  });

  test('rejects weak passwords', async () => {
    await rejects(
      Parse.Cloud.run(
        'recoverOwner',
        { username: 'boss', password: 'short', restaurant: CODE },
        master,
      ),
      /at least 8 characters/,
    );
  });
});

describe('phase 1: accompaniments, stock and the full order flow', () => {
  const ids = {};
  const settings = async (overrides) => {
    const { settings: current } = await run('adminListSetup', {}, s.owner);
    const base = { defaultDeliveryFee: 3000, maxRiderFloat: 200000 };
    await run('adminSaveSettings', { ...base, ...current, ...overrides }, s.owner);
  };
  const order = (extra = {}) =>
    run(
      'createOrder',
      {
        customerName: 'Joan Nakato',
        customerPhone: '+256 700 111222',
        deliveryAddress: 'Plot 4, Bukoto',
        deliveryNotes: 'Blue gate',
        channel: 'whatsapp',
        paymentMethod: 'cash',
        items: [{ id: ids.stew, quantity: 1, accompaniments: [ids.friedrice, ids.matooke] }],
        ...extra,
      },
      s.rider2,
    );
  const get = (id, user = s.rider2) => new Parse.Query('Order').get(id, as(user));

  before(async () => {
    s.rider2 = await login('ron', '4321');
    await settings({
      allowBatching: true,
      maxRiderFloat: 1000000,
      mtnMerchantCode: '123456',
      mtnMerchantName: 'Relay Foods',
      airtelMerchantCode: '654321',
      airtelMerchantName: 'Relay Foods',
    });
  });

  test('owner sets up accompaniments and a dish with "one rice, any sides"', async () => {
    for (const [key, title] of [
      ['matooke', 'Matooke'],
      ['vegrice', 'Vegetable rice'],
      ['friedrice', 'Fried rice'],
      ['pumpkin', 'Pumpkin'],
      ['yams', 'Yams'],
    ])
      ids[key] = (await run('adminSaveAccompaniment', { title }, s.owner)).id;
    const groups = [
      { label: 'Rice', options: [ids.vegrice, ids.friedrice], min: 0, max: 1 },
      { label: 'Sides', options: [ids.matooke, ids.pumpkin, ids.yams], min: 0, max: 3 },
    ];
    await rejects(
      run(
        'adminSaveMenuItem',
        { title: 'Bad', price: 1, accompanimentGroups: [{ label: 'X', options: ['nope'] }] },
        s.owner,
      ),
      /does not exist/,
    );
    ids.stew = (
      await run(
        'adminSaveMenuItem',
        { title: 'Chicken stew', price: 25000, category: 'Mains', accompanimentGroups: groups },
        s.owner,
      )
    ).id;
    const menu = await run('getOperationalMenu', {}, s.rider2);
    const stew = menu.items.find((item) => item.id === ids.stew);
    assert.deepEqual(
      stew.accompanimentGroups.map((g) => [g.label, g.max, g.options.map((o) => o.title)]),
      [
        ['Rice', 1, ['Vegetable rice', 'Fried rice']],
        ['Sides', 3, ['Matooke', 'Pumpkin', 'Yams']],
      ],
    );
  });

  test('cashier marks fried rice sold out; riders stop seeing it and cannot order it', async () => {
    await rejects(
      run(
        'setAvailability',
        { type: 'accompaniment', id: ids.friedrice, available: false },
        s.rider2,
      ),
      /cashier or admin role required/,
    );
    await run(
      'setAvailability',
      { type: 'accompaniment', id: ids.friedrice, available: false },
      s.cashier,
    );
    const stock = await run('getStock', {}, s.cashier);
    assert.equal(stock.accompaniments.find((a) => a.id === ids.friedrice).available, false);
    const menu = await run('getOperationalMenu', {}, s.rider2);
    const rice = menu.items
      .find((item) => item.id === ids.stew)
      .accompanimentGroups.find((g) => g.label === 'Rice');
    assert.deepEqual(
      rice.options.map((o) => o.title),
      ['Vegetable rice'],
    );
    await rejects(order(), /Chicken stew: An accompaniment is not available/);
    await run(
      'setAvailability',
      { type: 'accompaniment', id: ids.friedrice, available: true },
      s.cashier,
    );
  });

  test('vegetable rice and fried rice cannot both be ordered', async () => {
    await rejects(
      order({
        items: [{ id: ids.stew, quantity: 1, accompaniments: [ids.vegrice, ids.friedrice] }],
      }),
      /Choose only one rice option/,
    );
  });

  test('a charged accompaniment adds its price to each portion on the bill', async () => {
    const M = { useMasterKey: true };
    await rejects(
      run('adminSaveAccompaniment', { title: 'Chips', price: -500 }, s.owner),
      /whole amount/,
    );
    ids.chips = (await run('adminSaveAccompaniment', { title: 'Chips', price: 2500 }, s.owner)).id;
    const listed = (await run('adminListSetup', {}, s.owner)).accompaniments;
    assert.equal(listed.find((a) => a.id === ids.chips).price, 2500);
    assert.equal(listed.find((a) => a.id === ids.matooke).price, 0, 'others stay free');
    const groups = [
      { label: 'Rice', options: [ids.vegrice, ids.friedrice], min: 0, max: 1 },
      { label: 'Sides', options: [ids.matooke, ids.pumpkin, ids.yams, ids.chips], min: 0, max: 4 },
    ];
    await run(
      'adminSaveMenuItem',
      {
        id: ids.stew,
        title: 'Chicken stew',
        price: 25000,
        category: 'Mains',
        accompanimentGroups: groups,
      },
      s.owner,
    );
    const menu = await run('getOperationalMenu', {}, s.rider2);
    const sides = menu.items
      .find((item) => item.id === ids.stew)
      .accompanimentGroups.find((g) => g.label === 'Sides');
    assert.equal(sides.options.find((o) => o.id === ids.chips).price, 2500);
    assert.equal(sides.options.find((o) => o.id === ids.matooke).price, 0);

    const placed = await order({
      items: [{ id: ids.stew, quantity: 2, accompaniments: [ids.chips, ids.matooke] }],
    });
    const saved = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(saved.get('subtotal'), 2 * (25000 + 2500), 'the side is charged per portion');
    assert.equal(saved.get('total'), saved.get('subtotal') + saved.get('deliveryFee'));
    const [line] = await new Parse.Query('OrderItem').equalTo('order', saved).find(M);
    assert.equal(line.get('unitPriceSnapshot'), 25000);
    assert.equal(line.get('extrasPerUnit'), 2500);
    assert.equal(line.get('lineTotal'), 55000);
    assert.deepEqual(line.get('accompanimentNames'), ['Chips', 'Matooke']);
    assert.deepEqual(line.get('accompanimentPrices'), [2500, 0]);
    const receipt = await run('getReceipt', { orderId: placed.id }, s.owner);
    assert.deepEqual(receipt.lines[0].accompanimentPrices, [2500, 0]);
    const detail = await run('adminGetOrder', { id: placed.id }, s.owner);
    assert.deepEqual(detail.items[0].accompanimentPrices, [2500, 0]);

    // A price change applies to new orders only; the placed order keeps its bill.
    await run('adminSaveAccompaniment', { id: ids.chips, title: 'Chips', price: 3000 }, s.owner);
    assert.equal((await new Parse.Query('Order').get(placed.id, M)).get('subtotal'), 55000);
    await run('adminSaveAccompaniment', { id: ids.chips, title: 'Chips', price: 0 }, s.owner);
    const free = await order({
      items: [{ id: ids.stew, quantity: 1, accompaniments: [ids.chips] }],
    });
    assert.equal((await new Parse.Query('Order').get(free.id, M)).get('subtotal'), 25000);
    for (const id of [placed.id, free.id])
      await run('transitionOrder', { orderId: id, action: 'cancel', reason: 'test' }, s.rider2);
  });

  test('a delivery needs a written address or a map pin', async () => {
    const M = { useMasterKey: true };
    await rejects(order({ deliveryAddress: '' }), /delivery address or pin it on the map/);
    const pinned = await order({ deliveryAddress: '', location: { lat: 0.35, lng: 32.6 } });
    const saved = await new Parse.Query('Order').get(pinned.id, M);
    assert.equal(saved.get('deliveryAddress'), 'Pinned on the map');
    assert.equal(saved.get('location').latitude, 0.35);
    await run(
      'transitionOrder',
      { orderId: pinned.id, action: 'cancel', reason: 'test' },
      s.rider2,
    );
  });

  test('a full order records channel, phone, notes and accompaniments, once', async () => {
    const placed = await order({
      clientId: 'draft-1',
      items: [
        {
          id: ids.stew,
          quantity: 2,
          notes: 'Extra soup',
          accompaniments: [ids.friedrice, ids.matooke],
        },
      ],
    });
    const again = await order({ clientId: 'draft-1' });
    assert.equal(again.id, placed.id);
    assert.equal(again.duplicate, true);
    const row = await get(placed.id, s.cashier);
    assert.equal(row.get('channel'), 'whatsapp');
    assert.equal(row.get('customerPhone'), '+256700111222');
    assert.equal(row.get('deliveryNotes'), 'Blue gate');
    assert.equal(row.get('total'), 25000 * 2 + 3000);
    const [line] = await new Parse.Query('OrderItem').equalTo('order', row).find(as(s.cashier));
    assert.deepEqual(line.get('accompanimentNames'), ['Fried rice', 'Matooke']);
    assert.equal(line.get('notes'), 'Extra soup');
    s.joanOrder = placed.id;
  });

  test('customer search returns the saved customer and their last order for repeat', async () => {
    for (const q of ['joan', '700111']) {
      const [match] = await run('searchCustomers', { q }, s.rider2);
      assert.equal(match.name, 'Joan Nakato');
      assert.equal(match.addresses[0].text, 'Plot 4, Bukoto');
      assert.equal(match.lastOrder[0].menuItemId, ids.stew);
      assert.deepEqual(match.lastOrder[0].accompanimentIds, [ids.friedrice, ids.matooke]);
    }
  });

  test('a rider can cancel only before the kitchen accepts; the cashier can reject or cancel', async () => {
    await rejects(
      run('transitionOrder', { orderId: s.joanOrder, action: 'cancel' }, s.rider2),
      /Give a reason/,
    );
    const second = await order();
    await run(
      'transitionOrder',
      { orderId: second.id, action: 'cancel', reason: 'Customer changed mind' },
      s.rider2,
    );
    assert.equal((await get(second.id)).get('status'), 'CANCELLED');

    const third = await order();
    await run('transitionOrder', { orderId: third.id, action: 'accept' }, s.cashier);
    await rejects(
      run('transitionOrder', { orderId: third.id, action: 'cancel', reason: 'oops' }, s.rider2),
      /Ask the cashier to cancel/,
    );
    await rejects(
      run('transitionOrder', { orderId: third.id, action: 'reject', reason: 'late' }, s.cashier),
      /Invalid status transition/,
    );
    await run(
      'transitionOrder',
      { orderId: third.id, action: 'cancel', reason: 'Out of chicken' },
      s.cashier,
    );
    const row = await get(third.id);
    assert.equal(row.get('cancelledReason'), 'Out of chicken');

    const fourth = await order();
    await run(
      'transitionOrder',
      { orderId: fourth.id, action: 'reject', reason: 'Kitchen closed' },
      s.cashier,
    );
    assert.equal((await get(fourth.id)).get('restaurantStatus'), 'rejected');
  });

  test('customers pay the full total: part payments are refused', async () => {
    await rejects(
      order({ amountToCollect: 20000, shortfallNote: 'Pays the rest tomorrow' }),
      /must pay the full total/,
    );
    const full = await order({});
    const row = await get(full.id);
    assert.equal(row.get('amountToCollect'), row.get('total'));
    await run('transitionOrder', { orderId: full.id, action: 'cancel', reason: 'test' }, s.rider2);
  });

  test('cash limit: the order that crosses the limit goes ahead, the next one waits', async () => {
    // What the rider already has: cash held plus cash still to collect.
    const M = { useMasterKey: true };
    const mine = await new Parse.Query('Order').equalTo('createdBy', s.rider2).limit(1000).find(M);
    const held = mine
      .filter(
        (o) =>
          o.get('status') === 'DELIVERED' &&
          ['WITH_RIDER', 'HANDOVER_PENDING'].includes(o.get('cashStatus')),
      )
      .reduce((n, o) => n + o.get('amountCollected'), 0);
    const toCollect = mine
      .filter(
        (o) =>
          !['DELIVERED', 'CANCELLED'].includes(o.get('status')) &&
          o.get('paymentMethod') === 'cash',
      )
      .reduce((n, o) => n + (o.get('amountToCollect') ?? o.get('total')), 0);
    // Just under the limit (e.g. limit 50,000 with 0 held) …
    await settings({ maxRiderFloat: held + toCollect + 1000 });
    try {
      // … an order far bigger than the room left is still allowed …
      const big = await order({
        items: [{ id: ids.stew, quantity: 4, accompaniments: [ids.matooke] }],
      });
      assert.equal(big.cashLimitReached, true);
      // … but nothing else until the cash is cleared, whatever the payment type.
      await rejects(order(), /Cash limit reached.*Deliver and hand over cash/);
      await rejects(
        order({
          paymentMethod: 'mobile_money',
          paymentProvider: 'mtn',
          paymentReference: 'B2TEST001',
        }),
        /Cash limit reached/,
      );
      // Clearing it (here: cancelling the big order) lets the rider order again.
      await run('transitionOrder', { orderId: big.id, action: 'cancel', reason: 'test' }, s.rider2);
      const next = await order({
        paymentMethod: 'mobile_money',
        paymentProvider: 'mtn',
        paymentReference: 'B2TEST002',
      });
      assert.equal(next.cashLimitReached, false);
      await run(
        'transitionOrder',
        { orderId: next.id, action: 'cancel', reason: 'test' },
        s.rider2,
      );
    } finally {
      await settings({ maxRiderFloat: 1000000 });
    }
  });

  test('with cashier-confirmed pickup on, only staff can hand the bag over', async () => {
    await settings({ requireCashierConfirmForPickup: true });
    try {
      for (const action of ['accept', 'ready'])
        await run('transitionOrder', { orderId: s.joanOrder, action }, s.cashier);
      await rejects(
        run('transitionOrder', { orderId: s.joanOrder, action: 'pickup' }, s.rider2),
        /cashier confirms pickup/,
      );
      await run('transitionOrder', { orderId: s.joanOrder, action: 'pickup' }, s.cashier);
    } finally {
      await settings({ requireCashierConfirmForPickup: false });
    }
  });

  test('delivery can record that the customer paid by mobile money instead', async () => {
    await run(
      'transitionOrder',
      {
        orderId: s.joanOrder,
        action: 'deliver',
        paymentMethod: 'mobile_money',
        paymentProvider: 'airtel',
        paymentReference: 'AT-DOOR-77',
      },
      s.rider2,
    );
    const row = await get(s.joanOrder);
    assert.equal(row.get('status'), 'DELIVERED');
    assert.equal(row.get('paymentMethod'), 'mobile_money');
    assert.equal(row.get('paymentStatus'), 'PENDING_VERIFICATION');
    assert.equal(row.get('paymentReference'), 'AT-DOOR-77');
    assert.equal(row.get('cashStatus'), 'NOT_APPLICABLE');
    assert.equal(row.get('amountCollected'), 0);
  });

  test('order issues are flagged by the rider or staff and resolved by the owner', async () => {
    await rejects(
      run('flagOrderIssue', { orderId: s.joanOrder, note: 'Soup spilled' }, s.rider),
      /Not allowed/,
    );
    await run('flagOrderIssue', { orderId: s.joanOrder, note: 'Soup spilled' }, s.rider2);
    assert.equal((await get(s.joanOrder)).get('disputeFlag'), true);
    await rejects(
      run('resolveOrderIssue', { orderId: s.joanOrder, resolution: 'Refunded' }, s.cashier),
      /admin role required/,
    );
    await run('resolveOrderIssue', { orderId: s.joanOrder, resolution: 'Refunded soup' }, s.owner);
    assert.equal((await get(s.joanOrder)).get('disputeFlag'), false);
  });

  test('riders get the configured merchant codes', async () => {
    const profile = await run('getMyProfile', {}, s.rider2);
    assert.deepEqual(profile.config.mobileMoney, [
      // auto: automatic payments are off until the owner adds API keys.
      {
        provider: 'airtel',
        label: 'Airtel Money',
        code: '654321',
        name: 'Relay Foods',
        auto: false,
      },
      { provider: 'mtn', label: 'MTN MoMo', code: '123456', name: 'Relay Foods', auto: false },
    ]);
  });

  test('a mobile money order needs a provider and a transaction ID, used only once', async () => {
    const momo = (extra) => order({ paymentMethod: 'mobile_money', ...extra });
    await rejects(momo({ paymentProvider: 'mtn' }), /Enter the transaction ID/);
    await rejects(
      momo({ paymentProvider: 'visa', paymentReference: 'X1234' }),
      /Choose Airtel Money or MTN MoMo/,
    );
    const placed = await momo({ paymentProvider: 'mtn', paymentReference: ' mp 2409 25 ' });
    const row = await get(placed.id);
    assert.equal(row.get('paymentStatus'), 'PENDING_VERIFICATION');
    assert.equal(row.get('paymentReference'), 'MP240925');
    assert.equal(row.get('cashStatus'), 'NOT_APPLICABLE');
    await rejects(
      momo({ paymentProvider: 'mtn', paymentReference: 'MP240925' }),
      /already used on ORD-/,
    );
    s.momoOrder = placed.id;
  });

  test('the kitchen cannot accept until the cashier confirms the money arrived', async () => {
    await rejects(
      run('transitionOrder', { orderId: s.momoOrder, action: 'accept' }, s.cashier),
      /Confirm the mobile money payment/,
    );
    await rejects(
      run('verifyPayment', { orderId: s.momoOrder, received: true }, s.rider2),
      /cashier or admin role required/,
    );
    await rejects(
      run('verifyPayment', { orderId: s.momoOrder, received: false }, s.cashier),
      /Say why/,
    );
    await run(
      'verifyPayment',
      { orderId: s.momoOrder, received: false, reason: 'Not on MTN statement' },
      s.cashier,
    );
    let row = await get(s.momoOrder);
    assert.equal(row.get('paymentStatus'), 'REJECTED');
    assert.equal(row.get('paymentRejectReason'), 'Not on MTN statement');

    // The rider corrects the transaction ID; it goes back to the cashier.
    await run(
      'resubmitPayment',
      { orderId: s.momoOrder, provider: 'mtn', reference: 'MP240926' },
      s.rider2,
    );
    await run('verifyPayment', { orderId: s.momoOrder, received: true }, s.cashier);
    row = await get(s.momoOrder);
    assert.equal(row.get('paymentStatus'), 'VERIFIED');
    await run('transitionOrder', { orderId: s.momoOrder, action: 'accept' }, s.cashier);
  });

  test("the cashier ledger shows pending payments and today's totals per provider", async () => {
    const ledger = await run('getMobileMoneyLedger', {}, s.cashier);
    assert.ok(ledger.pending.some((row) => row.reference === 'AT-DOOR-77'));
    const mtn = ledger.totals.find((t) => t.provider === 'mtn');
    assert.equal(mtn.count, 1);
    assert.equal(mtn.amount, 25000 + 3000);
    assert.ok(
      ledger.rejected.length === 0 || ledger.rejected.every((r) => r.paymentStatus === 'REJECTED'),
    );
    await rejects(run('getMobileMoneyLedger', {}, s.rider2), /cashier or admin role required/);
  });

  after(async () => {
    await settings({ allowBatching: false });
  });
});

describe('ledgers, earnings and reports', () => {
  // Everything in this database was created during this run, so a range from
  // yesterday to tomorrow (restaurant time) covers it all.
  const kampalaDay = (offset) =>
    new Date(Date.now() + 3 * 3600e3 + offset * 864e5).toISOString().slice(0, 10);
  const range = { from: kampalaDay(-1), to: kampalaDay(1) };
  const all = async (build) => {
    const query = new Parse.Query('Order');
    build?.(query);
    query.limit(1000);
    return query.find({ useMasterKey: true });
  };
  const sum = (rows, field) => rows.reduce((n, row) => n + (row.get(field) || 0), 0);

  test('getReportOptions lists riders for staff only', async () => {
    const { riders } = await run('getReportOptions', {}, s.owner);
    const labels = riders.map((r) => r.label);
    assert.ok(labels.includes('R-001 · Rita Rider'));
    assert.ok(labels.includes('R-002 · Ron Rider'));
    s.ritaId = riders.find((r) => r.label.includes('Rita')).id;
    s.ronId = riders.find((r) => r.label.includes('Ron')).id;
    await rejects(
      run('getReportOptions', {}, s.rider),
      /cashier or admin or finance role required/,
    );
  });

  test('the payments ledger lists every cash and mobile money transaction', async () => {
    const ledger = await run('getPaymentsLedger', range, s.owner);
    const cash = await all((q) => {
      q.equalTo('paymentMethod', 'cash');
      q.equalTo('status', 'DELIVERED');
    });
    const momo = await all((q) => q.equalTo('paymentMethod', 'mobile_money'));
    assert.ok(cash.length > 0 && momo.length > 0);
    assert.equal(ledger.transactions.filter((t) => t.kind === 'cash').length, cash.length);
    assert.equal(ledger.transactions.filter((t) => t.kind === 'mobile_money').length, momo.length);
    assert.equal(ledger.summary.cash.collected, sum(cash, 'amountCollected'));
    const verified = momo.filter((o) => o.get('paymentStatus') === 'VERIFIED');
    assert.equal(ledger.summary.mobileMoney.verified, sum(verified, 'total'));
    assert.equal(
      ledger.summary.mobileMoney.byProvider.reduce((n, p) => n + p.amount, 0),
      sum(verified, 'total'),
    );
    const door = ledger.transactions.find((t) => t.reference === 'AT-DOOR-77');
    assert.equal(door.status, 'PENDING_VERIFICATION');
    // Cash confirmed through a handover carries the handover code.
    const reconciled = ledger.transactions.find((t) => t.status === 'RECONCILED');
    assert.match(reconciled.reference, /^HO-\d{8}-\d{3}$/);
    assert.ok(ledger.handovers.some((h) => h.status === 'confirmed'));
  });

  test('the payments ledger filters by payment type and rider', async () => {
    const momoOnly = await run('getPaymentsLedger', { ...range, method: 'mobile_money' }, s.owner);
    assert.ok(momoOnly.transactions.every((t) => t.kind === 'mobile_money'));
    assert.equal(momoOnly.handovers.length, 0);
    const rita = await run('getPaymentsLedger', { ...range, riderId: s.ritaId }, s.cashier);
    assert.ok(rita.transactions.length > 0);
    assert.ok(rita.transactions.every((t) => t.riderId === s.ritaId));
    assert.ok(rita.handovers.every((h) => h.riderId === s.ritaId));
    const empty = await run('getPaymentsLedger', { from: '2020-01-01', to: '2020-01-31' }, s.owner);
    assert.equal(empty.transactions.length, 0);
    await rejects(
      run('getPaymentsLedger', range, s.rider),
      /cashier or admin or finance role required/,
    );
    await rejects(
      run('getPaymentsLedger', { from: '2026-02-30', to: '2026-03-01' }, s.owner),
      /Dates must look like/,
    );
    await rejects(
      run('getPaymentsLedger', { ...range, method: 'cheque' }, s.owner),
      /Payment type/,
    );
  });

  test('admin order search filters by date, rider and status', async () => {
    const everything = await all();
    const result = await run('adminSearchOrders', range, s.owner);
    assert.equal(result.rows.length, everything.length);
    assert.equal(result.summary.orders, everything.length);
    const delivered = everything.filter((o) => o.get('status') === 'DELIVERED');
    assert.equal(result.summary.revenue, sum(delivered, 'total'));
    const ron = await run('adminSearchOrders', { ...range, riderId: s.ronId }, s.owner);
    assert.ok(ron.rows.length > 0 && ron.rows.every((r) => r.riderId === s.ronId));
    const done = await run('adminSearchOrders', { ...range, status: 'DELIVERED' }, s.owner);
    assert.equal(done.rows.length, delivered.length);
    const past = await run('adminSearchOrders', { from: '2020-01-01', to: '2020-01-02' }, s.owner);
    assert.equal(past.rows.length, 0);
    await rejects(run('adminSearchOrders', range, s.cashier), /admin or finance role required/);
  });

  test('admin order search filters by channel and cash status, and pages', async () => {
    const everything = await all();
    const result = await run('adminSearchOrders', range, s.owner);
    assert.deepEqual(
      [result.page, result.pages, result.pageSize, result.totalRows],
      [0, 1, 2000, everything.length],
    );
    for (const channel of new Set(everything.map((o) => o.get('channel')).filter(Boolean))) {
      const byChannel = await run('adminSearchOrders', { ...range, channel }, s.owner);
      assert.equal(
        byChannel.totalRows,
        everything.filter((o) => o.get('channel') === channel).length,
        channel,
      );
      assert.ok(byChannel.rows.every((r) => r.channel === channel));
    }
    const reconciled = await run(
      'adminSearchOrders',
      { ...range, cashStatus: 'RECONCILED' },
      s.owner,
    );
    assert.equal(
      reconciled.totalRows,
      everything.filter((o) => o.get('cashStatus') === 'RECONCILED').length,
    );
    const beyond = await run('adminSearchOrders', { ...range, page: 1 }, s.owner);
    assert.equal(beyond.rows.length, 0, 'past the last page is empty');
    assert.equal(beyond.summary.orders, everything.length, 'the summary covers every match');
    await rejects(run('adminSearchOrders', { ...range, channel: 'fax' }, s.owner), /channel/);
    await rejects(
      run('adminSearchOrders', { ...range, cashStatus: 'LOST' }, s.owner),
      /cash status/,
    );
    await rejects(run('adminSearchOrders', { ...range, page: -1 }, s.owner), /page/);
  });

  test('the commission ledger totals per rider', async () => {
    const delivered = await all((q) => q.equalTo('status', 'DELIVERED'));
    const ledger = await run('getCommissionLedger', range, s.owner);
    assert.equal(ledger.total, sum(delivered, 'commissionAmount'));
    assert.equal(
      ledger.riders.reduce((n, r) => n + r.commission, 0),
      ledger.total,
    );
    const rita = await run('getCommissionLedger', { ...range, riderId: s.ritaId }, s.owner);
    assert.ok(rita.rows.every((r) => r.riderId === s.ritaId));
    assert.deepEqual(
      rita.riders.map((r) => r.riderId),
      [s.ritaId],
    );
    await rejects(run('getCommissionLedger', range, s.rider), /admin or finance role required/);
  });

  test('riders see only their own earnings, by week or month', async () => {
    const mine = await all((q) => {
      q.equalTo('status', 'DELIVERED');
      q.equalTo('createdBy', Parse.User.createWithoutData(s.ronId));
    });
    // Asking for someone else's earnings still returns your own.
    const weekly = await run(
      'getRiderEarnings',
      { ...range, period: 'week', riderId: s.ritaId },
      s.rider2,
    );
    assert.equal(weekly.summary.deliveries, mine.length);
    assert.equal(weekly.summary.earnings, sum(mine, 'commissionAmount'));
    assert.equal(
      weekly.series.reduce((n, row) => n + row.earnings, 0),
      weekly.summary.earnings,
    );
    assert.ok(weekly.series.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.key)));
    assert.equal(weekly.previous.deliveries, 0);
    const monthly = await run('getRiderEarnings', { ...range, period: 'month' }, s.rider2);
    assert.ok(monthly.series.every((row) => /^\d{4}-\d{2}$/.test(row.key)));
    // The owner can look at any rider.
    const rita = await run('getRiderEarnings', { ...range, riderId: s.ritaId }, s.owner);
    assert.ok(rita.deliveries.length > 0);
    await rejects(
      run('getRiderEarnings', range, s.cashier),
      /rider or admin or finance role required/,
    );
  });

  test('the operations report covers revenue, growth and menu item sales', async () => {
    const everything = await all();
    const delivered = everything.filter((o) => o.get('status') === 'DELIVERED');
    const report = await run('getOperationsReport', { ...range, period: 'day' }, s.owner);
    assert.equal(report.summary.orders, everything.length);
    assert.equal(report.summary.revenue, sum(delivered, 'total'));
    assert.equal(report.series.length, 3);
    assert.equal(
      report.series.reduce((n, row) => n + row.revenue, 0),
      report.summary.revenue,
    );
    assert.ok(report.monthly.length >= 1);
    assert.equal(report.change.revenue, null); // nothing the period before
    const stew = report.items.find((item) => /stew/i.test(item.name));
    assert.ok(stew && stew.qty > 0 && stew.revenue > 0);
    assert.equal(
      report.items.reduce((n, item) => n + item.revenue, 0),
      sum(delivered, 'subtotal'),
    );
    assert.ok(report.accompaniments.some((a) => a.name === 'Matooke'));
    assert.equal(report.hours.length, 24);
    assert.equal(report.weekdays.length, 7);
    // The payment mix counts confirmed money only; the rest is reported apart.
    const confirmed = delivered.filter((o) =>
      o.get('paymentMethod') === 'cash'
        ? o.get('cashStatus') === 'RECONCILED'
        : o.get('paymentStatus') === 'VERIFIED',
    );
    assert.equal(
      report.payments.reduce((n, p) => n + p.amount, 0),
      sum(confirmed, 'total'),
    );
    assert.equal(report.summary.unconfirmedSales, report.summary.revenue - sum(confirmed, 'total'));
    assert.equal(
      report.summary.riderCommission,
      report.summary.commission - report.summary.deliveryFees,
    );
    assert.ok(report.riders.length >= 2);
    await rejects(run('getOperationsReport', range, s.cashier), /admin or finance role required/);
    await rejects(
      run('getOperationsReport', { from: '2025-01-01', to: '2026-06-30' }, s.owner),
      /at most 366 days/,
    );
  });
});

describe('broken codes from the Back4App counter bug', () => {
  const M = { useMasterKey: true };
  const first = (className, build) => {
    const query = new Parse.Query(className);
    build?.(query);
    return query.first(M);
  };

  test('new codes stay valid and unique even when the counter value is unusable', async () => {
    const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const counter = await first('Counter', (q) => q.equalTo('key', `ORD:${today}`));
    counter.set('value', { __op: 'Increment', amount: 1 });
    await counter.save(null, M);
    await run(
      'adminCreateTeamMember',
      { name: 'Cora Counter', username: 'cora', pin: '8642', role: 'rider' },
      s.owner,
    );
    const cora = await login('cora', '8642');
    const codes = new Set();
    for (let i = 0; i < 2; i += 1) {
      const { id, orderCode } = await run(
        'createOrder',
        {
          customerName: 'Counter Check',
          deliveryAddress: 'Plot 9',
          items: [{ id: (await first('MenuItem')).id, quantity: 1 }],
        },
        cora,
      );
      assert.match(orderCode, /^ORD-\d{8}-\d{4}$/);
      codes.add(orderCode);
      await run(
        'transitionOrder',
        { orderId: id, action: 'cancel', reason: 'Test order' },
        s.owner,
      );
    }
    assert.equal(codes.size, 2);
    const all = await new Parse.Query('Order').limit(1000).find(M);
    assert.equal(new Set(all.map((o) => o.get('orderCode'))).size, all.length);
  });

  test('Apply security rules repairs broken order, handover and staff codes', async () => {
    const order = await first('Order', (q) => q.ascending('createdAt'));
    order.set('orderCode', 'ORD-20260925-[object Object]');
    await order.save(null, M);
    const handover = await first('CashHandover');
    handover.set('handoverCode', 'HO-20260925-[object Object]');
    await handover.save(null, M);
    const rita = await first(Parse.User, (q) => q.equalTo('username', `rita@${CODE}`));
    rita.set('riderCode', 'R-[object Object]');
    await rita.save(null, M);

    const result = await run('adminApplySecurity', {}, s.owner);
    assert.equal(result.repairedCodes, 2);
    await order.fetch(M);
    await handover.fetch(M);
    await rita.fetch(M);
    assert.match(order.get('orderCode'), /^ORD-\d{8}-\d{4}$/);
    assert.match(handover.get('handoverCode'), /^HO-\d{8}-\d{3}$/);
    assert.match(rita.get('riderCode'), /^R-\d{3}$/);
    const riders = await new Parse.Query(Parse.User).exists('riderCode').find(M);
    assert.equal(new Set(riders.map((u) => u.get('riderCode'))).size, riders.length);
    const orders = await new Parse.Query('Order').limit(1000).find(M);
    assert.equal(new Set(orders.map((o) => o.get('orderCode'))).size, orders.length);
  });
});

test('the profile says whether the restaurant name has been set', async () => {
  // Relay Hosted: the name is given on the sign-up page.
  const before = await run('getMyProfile', {}, s.owner);
  assert.equal(before.config.restaurantNameSet, true);
  const { settings } = await run('adminListSetup', {}, s.owner);
  await run('adminSaveSettings', { ...settings, restaurantName: 'Mama Rose Kitchen' }, s.owner);
  const after = await run('getMyProfile', {}, s.rider);
  assert.equal(after.config.restaurantName, 'Mama Rose Kitchen');
  assert.equal(after.config.restaurantNameSet, true);
});

describe('notifications, cash limits and reported problems', () => {
  const M = { useMasterKey: true };
  const saveSettings = async (overrides) => {
    const { settings } = await run('adminListSetup', {}, s.owner);
    await run('adminSaveSettings', { ...settings, ...overrides }, s.owner);
  };
  const inbox = async (user) => (await run('getNotifications', {}, user)).items;
  const kinds = async (user) => (await inbox(user)).map((n) => n.kind);
  const clear = (...users) =>
    Promise.all(users.map((u) => run('markNotificationsRead', { all: true }, u)));
  const place = async (extra = {}) => {
    const { items } = await run('getOperationalMenu', {}, s.nia);
    const item = items.find((i) => !(i.accompanimentGroups || []).some((g) => g.min > 0));
    return run(
      'createOrder',
      {
        customerName: 'Amina Kato',
        customerPhone: '0700999888',
        deliveryAddress: 'Plot 12, Ntinda',
        items: [{ id: item.id, quantity: 1 }],
        ...extra,
      },
      s.nia,
    );
  };
  const deliver = async (id) => {
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: id, action }, s.cashier);
    await run('transitionOrder', { orderId: id, action: 'pickup' }, s.nia);
    await run('transitionOrder', { orderId: id, action: 'deliver' }, s.nia);
  };

  before(async () => {
    await run(
      'adminCreateTeamMember',
      { name: 'Nia Nansubuga', username: 'nia', pin: '2468', role: 'rider' },
      s.owner,
    );
    s.nia = await login('nia', '2468');
    await saveSettings({ maxRiderFloat: 1000000, allowBatching: true, cashReminderHour: 23 });
    await clear(s.nia, s.cashier, s.owner);
  });

  test('the kitchen hears about new orders; the rider hears about their order', async () => {
    const order = await place();
    const staffNote = (await inbox(s.cashier)).find((n) => n.kind === 'order.new');
    assert.equal(staffNote.title, `New order ${order.orderCode}`);
    assert.equal(staffNote.tone, 'new');
    assert.equal(staffNote.link, '/cashier');
    assert.match(staffNote.body, /Nia Nansubuga · Amina Kato/);
    assert.ok((await kinds(s.owner)).includes('order.new'));

    await run('transitionOrder', { orderId: order.id, action: 'accept' }, s.cashier);
    await run('transitionOrder', { orderId: order.id, action: 'ready' }, s.cashier);
    const riderInbox = await inbox(s.nia);
    const ready = riderInbox.find((n) => n.kind === 'order.ready');
    assert.equal(ready.title, `${order.orderCode} is ready for pickup`);
    assert.equal(ready.tone, 'alert');
    assert.equal(ready.link, `/rider/order/${order.id}`);
    assert.ok(riderInbox.some((n) => n.kind === 'order.accept'));
    s.readyOrder = order.id;

    const { unread } = await run('getNotifications', {}, s.nia);
    assert.ok(unread >= 2);
    await run('markNotificationsRead', { ids: [ready.id] }, s.nia);
    const after = await run('getNotifications', {}, s.nia);
    assert.equal(after.unread, unread - 1);
    // The list holds unread notifications only: the one just read is gone.
    assert.ok(!after.items.some((n) => n.id === ready.id));
    assert.ok(after.items.every((n) => !n.read));
    await run('markNotificationsRead', { all: true }, s.nia);
    const cleared = await run('getNotifications', {}, s.nia);
    assert.equal(cleared.unread, 0);
    assert.equal(cleared.items.length, 0);
  });

  test('notifications are private to their recipient', async () => {
    const theirs = await new Parse.Query('Notification').find(as(s.cashier));
    const niaUser = await new Parse.Query(Parse.User).equalTo('username', `nia@${CODE}`).first(M);
    assert.ok(theirs.every((n) => n.get('recipient').id !== niaUser.id));
    await rejects(
      new Parse.Object('Notification').save({ title: 'x' }, as(s.nia)),
      /Permission denied|Changes must go through the app/,
    );
  });

  test('handovers and mobile money checks notify both sides', async () => {
    await run('transitionOrder', { orderId: s.readyOrder, action: 'pickup' }, s.nia);
    await run('transitionOrder', { orderId: s.readyOrder, action: 'deliver' }, s.nia);
    const handover = await run('createHandover', { orderIds: [s.readyOrder] }, s.nia);
    const note = (await inbox(s.cashier)).find((n) => n.kind === 'cash.handover');
    assert.match(note.body, /Nia Nansubuga/);
    assert.equal(note.link, '/cashier/handovers');
    await run(
      'confirmHandover',
      { handoverId: handover.id, countedAmount: handover.amount },
      s.cashier,
    );
    assert.ok((await kinds(s.nia)).includes('cash.handover_confirmed'));

    const momo = await place({
      paymentMethod: 'mobile_money',
      paymentProvider: 'mtn',
      paymentReference: 'NIA-CHECK-001',
    });
    await run(
      'verifyPayment',
      { orderId: momo.id, received: false, reason: 'Not on the statement' },
      s.cashier,
    );
    const rejected = (await inbox(s.nia)).find((n) => n.kind === 'payment.rejected');
    assert.match(rejected.body, /Not on the statement/);
    await run('transitionOrder', { orderId: momo.id, action: 'cancel', reason: 'Test' }, s.nia);
  });

  test('cash limit: warning, then every new order is blocked until cash is handed over', async () => {
    const first = await place();
    await deliver(first.id);
    const second = await place();
    await deliver(second.id);
    const float = first.total + second.total;

    // Exactly at the limit: a "limit reached" alert and no new orders at all.
    await saveSettings({ maxRiderFloat: float });
    assert.ok((await kinds(s.nia)).includes('cash.limit_reached'));
    await rejects(place(), /Cash limit reached/);
    await rejects(
      place({ paymentMethod: 'mobile_money', paymentProvider: 'mtn', paymentReference: 'NIA-LIM' }),
      /Cash limit reached/,
    );

    // Raise the limit so the rider is at 80-99%: a warning, and orders allowed again.
    await saveSettings({ maxRiderFloat: Math.ceil(float / 0.9), floatWarningPercent: 80 });
    const alerts = await inbox(s.nia);
    const near = alerts.find((n) => n.kind === 'cash.limit_near');
    assert.equal(near.tone, 'alert');
    assert.equal(near.link, '/rider/cash');
    // Reminders are sent once per day, not on every check.
    await inbox(s.nia);
    assert.equal((await kinds(s.nia)).filter((k) => k === 'cash.limit_near').length, 1);
  });

  test('riders are reminded to hand over cash at the end of the day', async () => {
    await saveSettings({ cashReminderHour: 0, maxRiderFloat: 1000000 });
    const reminders = (await kinds(s.nia)).filter((k) => k === 'cash.handover_reminder');
    assert.equal(reminders.length, 1);
    assert.equal((await kinds(s.nia)).filter((k) => k === 'cash.handover_reminder').length, 1);
    await rejects(saveSettings({ cashReminderHour: 24 }), /0-23/);
    await saveSettings({ cashReminderHour: 20 });
  });

  test('limit 50,000 with nothing held: a 100,000 order goes ahead, then deposit first', async () => {
    const handOver = async () => {
      const cash = await new Parse.Query('Order')
        .equalTo('createdBy', Parse.User.createWithoutData(s.nia.id))
        .equalTo('cashStatus', 'WITH_RIDER')
        .find(M);
      if (!cash.length) return;
      const h = await run('createHandover', { orderIds: cash.map((o) => o.id) }, s.nia);
      await run('confirmHandover', { handoverId: h.id, countedAmount: h.amount }, s.cashier);
    };
    await handOver();
    await saveSettings({ maxRiderFloat: 50000 });
    try {
      const { items } = await run('getOperationalMenu', {}, s.nia);
      const item = items.find((i) => !(i.accompanimentGroups || []).some((g) => g.min > 0));
      const quantity = Math.ceil(100000 / item.price);
      const big = await place({ items: [{ id: item.id, quantity }] });
      assert.ok(big.total >= 100000);
      assert.equal(big.cashLimitReached, true);
      await rejects(place(), /Cash limit reached/);
      await deliver(big.id);
      await rejects(place(), /Cash limit reached: you hold/);
      await handOver();
      const next = await place();
      assert.equal(next.cashLimitReached, false);
      await run('transitionOrder', { orderId: next.id, action: 'cancel', reason: 'Test' }, s.nia);
    } finally {
      await saveSettings({ maxRiderFloat: 1000000 });
    }
  });

  test('the owner sees reported problems and resolves them', async () => {
    const order = await new Parse.Query('Order')
      .equalTo('status', 'DELIVERED')
      .equalTo('customerName', 'Amina Kato')
      .first(M);
    await run('flagOrderIssue', { orderId: order.id, note: 'Soup was cold on arrival' }, s.nia);
    const alert = (await inbox(s.owner)).find((n) => n.kind === 'order.issue');
    assert.match(alert.body, /Soup was cold/);
    assert.equal(alert.link, '/admin/problems');

    const open = await run('adminListIssues', { state: 'open' }, s.owner);
    const issue = open.issues.find((i) => i.id === order.id);
    assert.equal(issue.note, 'Soup was cold on arrival');
    assert.match(issue.reportedBy, /Nia Nansubuga/);
    assert.ok(open.open >= 1);

    await run(
      'resolveOrderIssue',
      { orderId: order.id, resolution: 'Refunded the delivery fee' },
      s.owner,
    );
    const resolved = await run('adminListIssues', { state: 'resolved' }, s.owner);
    const done = resolved.issues.find((i) => i.id === order.id);
    assert.equal(done.resolution, 'Refunded the delivery fee');
    assert.ok(done.resolvedAt);
    assert.ok((await kinds(s.nia)).includes('order.issue_resolved'));
    await rejects(run('adminListIssues', {}, s.cashier), /admin role required/);
  });
});

describe('Web Push to phones (lock screen)', () => {
  const crypto = require('node:crypto');
  const ece = require('http_ece');
  const PUSH_PORT = 1340;
  const received = [];
  let pushServer;
  const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
  const device = () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const authSecret = crypto.randomBytes(16);
    return {
      ecdh,
      authSecret,
      keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(authSecret) },
    };
  };
  const waitFor = async (check) => {
    for (let i = 0; i < 40; i += 1) {
      const hit = check();
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };
  const placeFor = async (rider) => {
    const { items } = await run('getOperationalMenu', {}, rider);
    const item = items.find((i) => !(i.accompanimentGroups || []).some((g) => g.min > 0));
    const order = await run(
      'createOrder',
      {
        customerName: 'Push Test',
        deliveryAddress: 'Kololo',
        items: [{ id: item.id, quantity: 1 }],
      },
      rider,
    );
    await run('transitionOrder', { orderId: order.id, action: 'cancel', reason: 'Test' }, rider);
    return order;
  };

  before(async () => {
    process.env.RELAY_PUSH_TEST_HOSTS = `localhost:${PUSH_PORT}`;
    // web-push only speaks HTTPS: serve the fake push service with a throwaway
    // self-signed certificate and trust it for the duration of these tests.
    const { execSync } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-push-'));
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -keyout ${dir}/key.pem -out ${dir}/cert.pem`,
      { stdio: 'ignore' },
    );
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const app = express();
    // Read the body by hand: body parsers reject the aes128gcm content encoding.
    app.post('/push/:name', (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ name: req.params.name, headers: req.headers, body: Buffer.concat(chunks) });
        const status = { gone: 410, stale: 403, broken: 500 }[req.params.name] || 201;
        res.status(status).end(status === 403 ? 'VAPID credentials do not match' : '');
      });
    });
    pushServer = require('node:https')
      .createServer(
        { key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) },
        app,
      )
      .listen(PUSH_PORT);
  });
  after(() => {
    pushServer?.close();
    delete process.env.RELAY_PUSH_TEST_HOSTS;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  test('the app gets the public key; only real push services are accepted', async () => {
    const { publicKey } = await run('getPushConfig', {}, s.cashier);
    assert.match(publicKey, /^[A-Za-z0-9_-]{87}$/);
    assert.equal((await run('getPushConfig', {}, s.nia)).publicKey, publicKey);
    await rejects(
      run(
        'savePushSubscription',
        { subscription: { endpoint: 'https://attacker.example.com/x', keys: device().keys } },
        s.cashier,
      ),
      /Unsupported push service/,
    );
    await rejects(run('getPushConfig', {}), /Sign in required/);
  });

  test('a new order is pushed, encrypted, to the cashier’s phone', async () => {
    const phone = device();
    await run(
      'savePushSubscription',
      {
        subscription: { endpoint: `https://localhost:${PUSH_PORT}/push/cashier`, keys: phone.keys },
        userAgent: 'test-phone',
      },
      s.cashier,
    );
    const order = await placeFor(s.nia);
    const hit = await waitFor(() =>
      received.find((r) => r.name === 'cashier' && r.headers.urgency === 'high'),
    );
    assert.ok(hit, 'push delivered');
    assert.equal(hit.headers['content-encoding'], 'aes128gcm');
    assert.match(hit.headers.authorization, /^vapid t=.+, k=.+/);
    const payload = JSON.parse(
      ece
        .decrypt(hit.body, {
          version: 'aes128gcm',
          privateKey: phone.ecdh,
          authSecret: b64url(phone.authSecret),
        })
        .toString(),
    );
    assert.equal(payload.title, `New order ${order.orderCode}`);
    assert.equal(payload.tone, 'new');
    assert.equal(payload.link, '/cashier');
  });

  test('a test notification reports each device; stale registrations are dropped', async () => {
    const M = { useMasterKey: true };
    for (const name of ['stale', 'broken'])
      await run(
        'savePushSubscription',
        {
          subscription: {
            endpoint: `https://localhost:${PUSH_PORT}/push/${name}`,
            keys: device().keys,
          },
          userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile',
        },
        s.cashier,
      );
    const result = await run('sendTestPush', {}, s.cashier);
    assert.equal(result.sent, 1, 'the cashier phone got it');
    assert.equal(result.failed, 2);
    assert.ok(result.devices.every((d) => d.device));
    assert.ok(
      result.devices.some((d) => !d.ok && /403/.test(d.problem) && /removed/.test(d.problem)),
    );
    assert.ok(result.devices.some((d) => !d.ok && /500/.test(d.problem)));
    const hit = await waitFor(() => received.find((r) => r.name === 'cashier' && r.body.length));
    assert.ok(hit);
    const stale = await new Parse.Query('PushSubscription')
      .equalTo('endpoint', `https://localhost:${PUSH_PORT}/push/stale`)
      .first(M);
    assert.equal(stale, undefined, 'a 403 registration is removed');
    const broken = await new Parse.Query('PushSubscription')
      .equalTo('endpoint', `https://localhost:${PUSH_PORT}/push/broken`)
      .first(M);
    assert.match(broken.get('lastError'), /500/);
    const ok = await new Parse.Query('PushSubscription')
      .equalTo('endpoint', `https://localhost:${PUSH_PORT}/push/cashier`)
      .first(M);
    assert.ok(ok.get('lastSuccessAt'));
    await broken.destroy(M);
    assert.deepEqual(await run('sendTestPush', {}, s.nia), {
      testId: '',
      sent: 0,
      failed: 0,
      devices: [],
    });
  });

  test('expired subscriptions are removed; devices can be unregistered', async () => {
    const gone = device();
    const endpoint = `https://localhost:${PUSH_PORT}/push/gone`;
    await run('savePushSubscription', { subscription: { endpoint, keys: gone.keys } }, s.owner);
    await placeFor(s.nia);
    await waitFor(() => received.find((r) => r.name === 'gone'));
    const left = await new Parse.Query('PushSubscription')
      .equalTo('endpoint', endpoint)
      .first({ useMasterKey: true });
    assert.equal(left, undefined);

    const cashierEndpoint = `https://localhost:${PUSH_PORT}/push/cashier`;
    assert.equal(
      (await run('removePushSubscription', { endpoint: cashierEndpoint }, s.nia)).ok,
      false,
    );
    assert.equal(
      (await run('removePushSubscription', { endpoint: cashierEndpoint }, s.cashier)).ok,
      true,
    );
  });

  test('subscriptions and keys are never readable by clients', async () => {
    for (const className of ['PushSubscription', 'Secret'])
      await rejects(new Parse.Query(className).find(as(s.owner)), /Permission denied/);
  });
});

test('a rider cannot end their shift with open orders or unreconciled cash', async () => {
  const M = { useMasterKey: true };
  const outstanding = async () => (await run('getMyShift', {}, s.nia)).shift.outstanding;
  // Start from a clean slate: cancel open orders, hand over and confirm cash.
  const open = await new Parse.Query('Order')
    .equalTo('createdBy', Parse.User.createWithoutData(s.nia.id))
    .notContainedIn('status', ['DELIVERED', 'CANCELLED'])
    .find(M);
  for (const o of open)
    await run(
      'transitionOrder',
      { orderId: o.id, action: 'cancel', reason: 'Clean up' },
      s.cashier,
    );
  const settle = async () => {
    const cash = await new Parse.Query('Order')
      .equalTo('createdBy', Parse.User.createWithoutData(s.nia.id))
      .equalTo('cashStatus', 'WITH_RIDER')
      .find(M);
    if (!cash.length) return null;
    return run('createHandover', { orderIds: cash.map((o) => o.id) }, s.nia);
  };
  const confirm = async (h) =>
    h && run('confirmHandover', { handoverId: h.id, countedAmount: h.amount }, s.cashier);
  await confirm(await settle());

  const { shift: existing } = await run('getMyShift', {}, s.nia);
  if (!existing) await run('startShift', { kind: 'rider' }, s.nia);
  const { shift } = await run('getMyShift', {}, s.nia);

  const { items } = await run('getOperationalMenu', {}, s.nia);
  const item = items.find((i) => !(i.accompanimentGroups || []).some((g) => g.min > 0));
  const order = await run(
    'createOrder',
    {
      customerName: 'Shift Check',
      deliveryAddress: 'Bugolobi',
      items: [{ id: item.id, quantity: 1 }],
    },
    s.nia,
  );
  assert.equal((await outstanding()).openOrders, 1);
  await rejects(
    run('endShift', { shiftId: shift.id }, s.nia),
    /Finish or cancel your 1 open order/,
  );

  for (const action of ['accept', 'ready'])
    await run('transitionOrder', { orderId: order.id, action }, s.cashier);
  await run('transitionOrder', { orderId: order.id, action: 'pickup' }, s.nia);
  await run('transitionOrder', { orderId: order.id, action: 'deliver' }, s.nia);
  assert.equal((await outstanding()).cashWithRider, order.total);
  await rejects(run('endShift', { shiftId: shift.id }, s.nia), /Hand over the cash/);

  const handover = await settle();
  assert.equal((await outstanding()).cashPending, order.total);
  await rejects(run('endShift', { shiftId: shift.id }, s.nia), /Wait for the cashier to confirm/);

  await confirm(handover);
  assert.deepEqual(await outstanding(), {
    openOrders: 0,
    cashWithRider: 0,
    cashPending: 0,
    momoPending: 0,
  });
  await run('endShift', { shiftId: shift.id }, s.nia);
  assert.equal((await run('getMyShift', {}, s.nia)).shift, null);
});

describe('cashier shifts and till reconciliation', () => {
  before(async () => {
    await run(
      'adminCreateTeamMember',
      { name: 'Cleo Cashier', username: 'cleo', pin: '9753', role: 'cashier' },
      s.owner,
    );
    s.cleo = await login('cleo', '9753');
  });

  test('a cashier cannot work the board before starting a shift', async () => {
    const pending = await new Parse.Query('Order')
      .equalTo('status', 'PLACED')
      .first({ useMasterKey: true });
    const blocked = /Start your shift and count the cash in the till first/;
    if (pending)
      await rejects(
        run('transitionOrder', { orderId: pending.id, action: 'accept' }, s.cleo),
        blocked,
      );
    await rejects(run('verifyPayment', { orderId: 'x', received: true }, s.cleo), blocked);
    await rejects(run('confirmHandover', { handoverId: 'x', countedAmount: 1 }, s.cleo), blocked);
    await rejects(
      run('disputeHandover', { handoverId: 'x', countedAmount: 1, reason: 'short' }, s.cleo),
      blocked,
    );
    await rejects(
      run('setAvailability', { type: 'menuItem', id: 'x', available: false }, s.cleo),
      blocked,
    );
    // Admins are not till operators and may act without a shift.
    assert.equal((await run('getMyShift', {}, s.owner)).shift, null);
  });

  test('the opening till count is required, even when it is zero', async () => {
    await rejects(run('startShift', { kind: 'cashier' }, s.cleo), /Count the cash in the till/);
    await run('startShift', { kind: 'cashier', openingFloat: 0 }, s.cleo);
    const { shift } = await run('getMyShift', {}, s.cleo);
    assert.equal(shift.openingFloat, 0);
    assert.equal(shift.expectedTill, 0);
  });

  test('a till difference must be explained; the owner is told and sees it in the report', async () => {
    // Cleo confirms a handover so the till should hold its amount.
    const { items } = await run('getOperationalMenu', {}, s.nia);
    const item = items.find((i) => !(i.accompanimentGroups || []).some((g) => g.min > 0));
    const order = await run(
      'createOrder',
      {
        customerName: 'Till Check',
        deliveryAddress: 'Naguru',
        items: [{ id: item.id, quantity: 1 }],
      },
      s.nia,
    );
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: order.id, action }, s.cleo);
    await run('transitionOrder', { orderId: order.id, action: 'pickup' }, s.nia);
    await run('transitionOrder', { orderId: order.id, action: 'deliver' }, s.nia);
    const handover = await run('createHandover', { orderIds: [order.id] }, s.nia);
    await run(
      'confirmHandover',
      { handoverId: handover.id, countedAmount: handover.amount },
      s.cleo,
    );
    const { shift } = await run('getMyShift', {}, s.cleo);
    assert.equal(shift.expectedTill, handover.amount);

    await run('markNotificationsRead', { all: true }, s.owner);
    const short = handover.amount - 1000;
    await rejects(
      run('endShift', { shiftId: shift.id, physicalCount: short }, s.cleo),
      /explain the difference/,
    );
    await rejects(
      run('endShift', { shiftId: shift.id, physicalCount: short, varianceNote: 'short' }, s.cleo),
      /explain the difference/,
    );
    const result = await run(
      'endShift',
      {
        shiftId: shift.id,
        physicalCount: short,
        varianceNote: 'Gave change twice to one customer',
      },
      s.cleo,
    );
    assert.equal(result.variance, -1000);

    const alert = (await run('getNotifications', {}, s.owner)).items.find(
      (n) => n.kind === 'shift.variance',
    );
    assert.match(alert.title, /Till short by/);
    assert.match(alert.body, /Gave change twice/);

    const report = await run('getShiftReport', {}, s.owner);
    const row = report.shifts.find((r) => r.id === shift.id);
    assert.equal(row.variance, -1000);
    assert.equal(row.varianceNote, 'Gave change twice to one customer');
    assert.equal(row.status, 'closed');
    assert.ok(report.shifts.some((r) => r.status === 'open')); // carl is still on shift
    // Till differences across days: the short till counts on the day it closed.
    assert.ok(report.trend.closedShifts >= 1);
    assert.ok(report.trend.days.some((d) => d.short >= 1000 && d.net <= -1000));
    const cashierRow = report.trend.cashiers.find((c) => c.cashier === row.cashier);
    assert.ok(cashierRow.short >= 1000);
    await rejects(run('getShiftReport', {}, s.cleo), /admin or finance role required/);

    // The owner settles it: 600 was a till payment nobody recorded, the rest is written off.
    const M = { useMasterKey: true };
    await rejects(
      run(
        'adminSettleTillDifference',
        { shiftId: shift.id, mode: 'payout', amount: 600, note: 'Fees paid' },
        s.cleo,
      ),
      /admin role required/,
    );
    await rejects(
      run(
        'adminSettleTillDifference',
        { shiftId: shift.id, mode: 'payout', amount: 5000, note: 'Fees paid' },
        s.owner,
      ),
      /amount from 1 to/,
    );
    await rejects(
      run(
        'adminSettleTillDifference',
        { shiftId: shift.id, mode: 'payout', amount: 600, note: 'x' },
        s.owner,
      ),
      /at least 5 characters/,
    );
    const part = await run(
      'adminSettleTillDifference',
      { shiftId: shift.id, mode: 'payout', amount: 600, note: 'Delivery fees paid to riders' },
      s.owner,
    );
    assert.deepEqual([part.variance, part.settled], [-400, false]);
    const payout = await new Parse.Query('TillPayout')
      .equalTo('payoutCode', part.payoutCode)
      .first(M);
    assert.equal(payout.get('amount'), 600);
    assert.equal(payout.get('shift').id, shift.id);
    const closed = await new Parse.Query('Shift').get(shift.id, M);
    assert.equal(
      payout.get('paidAt').getTime(),
      closed.get('endedAt').getTime(),
      'dated in the shift',
    );
    assert.equal(closed.get('originalVariance'), -1000);
    const done = await run(
      'adminSettleTillDifference',
      { shiftId: shift.id, mode: 'writeoff', note: 'Counting error, accepted' },
      s.owner,
    );
    assert.equal(done.settled, true);
    const settledRow = (await run('getShiftReport', {}, s.owner)).shifts.find(
      (r) => r.id === shift.id,
    );
    assert.equal(settledRow.settled, true);
    assert.equal(settledRow.variance, -400);
    assert.equal(settledRow.originalVariance, -1000);
    assert.match(settledRow.settlementNote, /Delivery fees paid to riders · Counting error/);
    await rejects(
      run(
        'adminSettleTillDifference',
        { shiftId: shift.id, mode: 'writeoff', note: 'Again please' },
        s.owner,
      ),
      /no difference left/,
    );
  });

  test('a till that matches closes without an explanation', async () => {
    await run('startShift', { kind: 'cashier', openingFloat: 20000 }, s.cleo);
    const { shift } = await run('getMyShift', {}, s.cleo);
    const result = await run('endShift', { shiftId: shift.id, physicalCount: 20000 }, s.cleo);
    assert.equal(result.variance, 0);
  });
});

describe('cash integrity: PINs, one cashier per order, safe handovers, payouts', () => {
  const M = { useMasterKey: true };
  const shiftOf = async (user) => (await run('getMyShift', {}, user)).shift;
  let item;
  let orderSeq = 0;

  // A cash order by Pia taken all the way to delivered, with `cashier` in
  // the kitchen. Returns the order id and total.
  async function deliveredOrder(cashier = s.dina) {
    orderSeq += 1;
    const placed = await run(
      'createOrder',
      {
        customerName: `Integrity ${orderSeq}`,
        deliveryAddress: 'Kololo',
        items: [{ id: item.id, quantity: 1 }],
      },
      s.pia,
    );
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: placed.id, action }, cashier);
    await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.pia);
    await run('transitionOrder', { orderId: placed.id, action: 'deliver' }, s.pia);
    return { id: placed.id, total: placed.total };
  }

  before(async () => {
    const { settings: current } = await run('adminListSetup', {}, s.owner);
    await run(
      'adminSaveSettings',
      { ...current, maxRiderFloat: 5000000, allowBatching: true, defaultDeliveryFee: 3000 },
      s.owner,
    );
    const pia = await run(
      'adminCreateTeamMember',
      { name: 'Pia Pikipiki', username: 'pia', pin: '1357', role: 'rider' },
      s.owner,
    );
    await run(
      'adminUpdateMember',
      { id: pia.id, commissionType: 'per_order', commissionPerOrder: 1000 },
      s.owner,
    );
    for (const [name, username, pin] of [
      ['Dina Desk', 'dina', '2244'],
      ['Eli Desk', 'eli', '3355'],
    ])
      await run('adminCreateTeamMember', { name, username, pin, role: 'cashier' }, s.owner);
    Object.assign(PINS, { pia: '1357', dina: '2244', eli: '3355' });
    s.pia = await login('pia', '1357');
    s.dina = await login('dina', '2244');
    s.eli = await login('eli', '3355');
    await run('startShift', { kind: 'cashier', openingFloat: 10000 }, s.dina);
    await run('startShift', { kind: 'cashier', openingFloat: 0 }, s.eli);
    await run('startShift', { kind: 'rider' }, s.pia);
    const menu = (await run('getOperationalMenu', {}, s.pia)).items;
    item = menu.find((i) => !i.accompanimentGroups.length);
  });

  test('sensitive steps ask for the PIN again; five wrong PINs lock them', async () => {
    const { id } = await deliveredOrder();
    await rejects(run('createHandover', { orderIds: [id], pin: '' }, s.pia), /Enter your PIN/);
    await rejects(
      run('createHandover', { orderIds: [id], pin: '0000' }, s.pia),
      /Wrong PIN \(4 tries left\)/,
    );
    for (let i = 0; i < 3; i += 1)
      await rejects(run('createHandover', { orderIds: [id], pin: '0000' }, s.pia), /Wrong PIN/);
    await rejects(run('createHandover', { orderIds: [id], pin: '0000' }, s.pia), /Locked for 15/);
    // Even the right PIN waits out the lock.
    await rejects(run('createHandover', { orderIds: [id], pin: '1357' }, s.pia), /Try again in/);
    // The owner lifts it (both the in-app lock and the sign-in lockout).
    await run('adminUnlockSignIn', { id: s.pia.id }, s.owner);
    const handover = await run('createHandover', { orderIds: [id] }, s.pia);
    assert.ok(handover.id);
    s.piaFirstHandover = handover.id;
  });

  test('the full total is collected at the door', async () => {
    const placed = await run(
      'createOrder',
      {
        customerName: 'Full Pay',
        deliveryAddress: 'Ntinda',
        items: [{ id: item.id, quantity: 1 }],
      },
      s.pia,
    );
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: placed.id, action }, s.dina);
    await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.pia);
    await rejects(
      run(
        'transitionOrder',
        { orderId: placed.id, action: 'deliver', amountCollected: placed.total - 1000 },
        s.pia,
      ),
      /Collect the full/,
    );
    await run('transitionOrder', { orderId: placed.id, action: 'deliver' }, s.pia);
    const row = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(row.get('amountCollected'), placed.total);
    // Rider pay: 1000 commission + the 3000 delivery fee.
    assert.equal(row.get('commissionAmount'), 4000);
  });

  test('an order belongs to the cashier who took it; they can pass it on', async () => {
    const placed = await run(
      'createOrder',
      {
        customerName: 'Assigned',
        deliveryAddress: 'Naguru',
        items: [{ id: item.id, quantity: 1 }],
      },
      s.pia,
    );
    await run('transitionOrder', { orderId: placed.id, action: 'accept' }, s.dina);
    let row = await new Parse.Query('Order').get(placed.id, as(s.eli));
    assert.equal(row.get('cashier').id, s.dina.id);
    assert.match(row.get('cashierName'), /Dina Desk/);
    await rejects(
      run('transitionOrder', { orderId: placed.id, action: 'ready' }, s.eli),
      /Dina Desk is handling this order/,
    );
    await rejects(
      run('transferOrder', { orderId: placed.id, toUserId: s.dina.id }, s.eli),
      /is handling this order/,
    );
    // The owner can act on any order without taking it.
    await run('transitionOrder', { orderId: placed.id, action: 'prepare' }, s.owner);

    const colleagues = await run('getOnShiftCashiers', {}, s.dina);
    assert.ok(colleagues.some((c) => c.id === s.eli.id));
    assert.ok(!colleagues.some((c) => c.id === s.dina.id));
    await rejects(
      run('transferOrder', { orderId: placed.id, toUserId: s.pia.id }, s.dina),
      /not on shift/,
    );
    await run('transferOrder', { orderId: placed.id, toUserId: s.eli.id }, s.dina);
    const told = (await run('getNotifications', {}, s.eli)).items.find(
      (n) => n.kind === 'order.transferred',
    );
    assert.match(told.title, /passed to you/);
    await rejects(
      run('transitionOrder', { orderId: placed.id, action: 'ready' }, s.dina),
      /Eli Desk is handling this order/,
    );
    await run('transitionOrder', { orderId: placed.id, action: 'ready' }, s.eli);

    // Released orders can be taken by anyone again.
    await run('transferOrder', { orderId: placed.id, toUserId: '' }, s.eli);
    row = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(row.get('cashier'), undefined);
    await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.dina);
  });

  test('two cashiers accepting at the same moment: exactly one gets the order', async () => {
    const placed = await run(
      'createOrder',
      { customerName: 'Race', deliveryAddress: 'Bukoto', items: [{ id: item.id, quantity: 1 }] },
      s.pia,
    );
    const results = await Promise.allSettled([
      run('transitionOrder', { orderId: placed.id, action: 'accept' }, s.dina),
      run('transitionOrder', { orderId: placed.id, action: 'accept' }, s.eli),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const row = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(row.get('status'), 'ACCEPTED');
    s.heldOrder = { id: placed.id, holder: row.get('cashier').id === s.dina.id ? s.dina : s.eli };
  });

  test('a cashier cannot end their shift while holding kitchen orders', async () => {
    const { holder, id } = s.heldOrder;
    const shift = await shiftOf(holder);
    await rejects(
      run('endShift', { shiftId: shift.id, physicalCount: 0 }, holder),
      /still hold 1 kitchen order/,
    );
    await run('transitionOrder', { orderId: id, action: 'ready' }, holder);
    await run('transitionOrder', { orderId: id, action: 'pickup' }, s.pia);
    await run('transitionOrder', { orderId: id, action: 'deliver' }, s.pia);
  });

  test('a handover is created once, even when sent twice at the same moment', async () => {
    const pending = await new Parse.Query('Order')
      .equalTo('createdBy', s.pia)
      .equalTo('cashStatus', 'WITH_RIDER')
      .find(M);
    const ids = pending.map((o) => o.id);
    const results = await Promise.allSettled([
      run('createHandover', { orderIds: ids }, s.pia),
      run('createHandover', { orderIds: ids }, s.pia),
    ]);
    const made = results.filter((r) => r.status === 'fulfilled');
    assert.equal(made.length, 1);
    s.raceHandover = made[0].value.id;
    // The same request retried (same requestId) returns the same handover.
    const { id } = await deliveredOrder();
    const first = await run('createHandover', { orderIds: [id], requestId: 'req-42' }, s.pia);
    const again = await run('createHandover', { orderIds: [id], requestId: 'req-42' }, s.pia);
    assert.equal(again.id, first.id);
    assert.equal(again.duplicate, true);
    s.singleHandover = first.id;
  });

  test('two cashiers counting the same handover: only one counts it', async () => {
    const row = await new Parse.Query('CashHandover').get(s.singleHandover, M);
    const amount = row.get('amount');
    const results = await Promise.allSettled([
      run('confirmHandover', { handoverId: row.id, countedAmount: amount }, s.dina),
      run('confirmHandover', { handoverId: row.id, countedAmount: amount }, s.eli),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const confirmed = await new Parse.Query('CashHandover').get(row.id, M);
    s.singleCounter = confirmed.get('cashier').id === s.dina.id ? s.dina : s.eli;
  });

  test('the cashier can accept part of a handover; the rest goes back to the rider', async () => {
    const row = await new Parse.Query('CashHandover').get(s.raceHandover, M);
    const orders = row.get('orders');
    assert.ok(orders.length >= 2);
    const keep = orders[0].id;
    const keepRow = await new Parse.Query('Order').get(keep, M);
    await rejects(
      run(
        'confirmHandover',
        { handoverId: row.id, receivedOrderIds: [keep], countedAmount: row.get('amount') },
        s.dina,
      ),
      /must match the ticked orders/,
    );
    const result = await run(
      'confirmHandover',
      {
        handoverId: row.id,
        receivedOrderIds: [keep],
        countedAmount: keepRow.get('amountCollected'),
      },
      s.dina,
    );
    assert.equal(result.returned, orders.length - 1);
    const back = await new Parse.Query('Order').get(orders[1].id, M);
    assert.equal(back.get('cashStatus'), 'WITH_RIDER');
    const note = (await run('getNotifications', {}, s.pia)).items.find(
      (n) => n.kind === 'cash.handover_confirmed' && /back with you/.test(n.body),
    );
    assert.ok(note);
    const mine = await run('getMyHandovers', {}, s.pia);
    const listed = mine.find((h) => h.id === row.id);
    assert.equal(listed.returnedCount, orders.length - 1);
    // Returned orders can be handed over again.
    const again = await run(
      'createHandover',
      { orderIds: orders.slice(1).map((o) => o.id) },
      s.pia,
    );
    s.disputeHandover = again.id;
  });

  test('a short count is disputed; the owner can charge the rider, and pay nets it off', async () => {
    const row = await new Parse.Query('CashHandover').get(s.disputeHandover, M);
    const counted = row.get('amount') - 2000;
    await rejects(
      run(
        'disputeHandover',
        { handoverId: row.id, countedAmount: row.get('amount'), reason: 'All there' },
        s.dina,
      ),
      /confirm the handover instead/,
    );
    await run(
      'disputeHandover',
      { handoverId: row.id, countedAmount: counted, reason: 'One note missing' },
      s.dina,
    );
    await rejects(
      run('adminResolveHandover', { handoverId: row.id, action: 'deduct', note: 'ok' }, s.owner),
      /resolution note/,
    );
    await rejects(
      run(
        'adminResolveHandover',
        { handoverId: row.id, action: 'deduct', note: 'Rider agreed' },
        s.dina,
      ),
      /admin role required/,
    );
    const result = await run(
      'adminResolveHandover',
      { handoverId: row.id, action: 'deduct', note: 'Rider agreed to repay' },
      s.owner,
    );
    assert.equal(result.shortage, 2000);
    const pay = await run('getMyPay', {}, s.pia);
    assert.equal(pay.deductions, 2000);
    assert.equal(pay.owed, pay.earned - 2000);
    s.piaOwed = pay.owed;
    const staffView = (await run('getRiderPay', {}, s.dina)).find((r) => r.riderId === s.pia.id);
    assert.equal(staffView.owed, pay.owed);
  });

  test('paying a rider comes out of the till, once, and marks the orders paid', async () => {
    const before = await shiftOf(s.dina);
    await rejects(run('payRider', { riderId: s.pia.id, pin: '9999' }, s.dina), /Wrong PIN/);
    await rejects(run('payRider', { riderId: s.pia.id }, s.pia), /cashier or admin/);
    const results = await Promise.allSettled([
      run('payRider', { riderId: s.pia.id }, s.dina),
      run('payRider', { riderId: s.pia.id }, s.dina),
    ]);
    const paid = results.filter((r) => r.status === 'fulfilled');
    assert.equal(paid.length, 1);
    assert.equal(paid[0].value.amount, s.piaOwed);
    const after = await shiftOf(s.dina);
    assert.equal(after.paidOut - before.paidOut, s.piaOwed);
    assert.equal(after.expectedTill, before.expectedTill - s.piaOwed);
    const pay = await run('getMyPay', {}, s.pia);
    assert.equal(pay.owed, 0);
    assert.equal(pay.payouts[0].amount, s.piaOwed);
    assert.equal(pay.payouts[0].deductions, 2000);
    await rejects(run('payRider', { riderId: s.pia.id }, s.dina), /Nothing to pay/);
  });

  test('other till payouts need a reason and the PIN, and lower the expected till', async () => {
    const before = await shiftOf(s.dina);
    await rejects(run('recordTillPayout', { amount: 5000, note: 'x' }, s.dina), /what the money/);
    await rejects(
      run('recordTillPayout', { amount: 5000, note: 'Charcoal' }, s.owner),
      /cashier role/,
    );
    await run('recordTillPayout', { amount: 5000, note: 'Bought charcoal' }, s.dina);
    const after = await shiftOf(s.dina);
    assert.equal(after.expectedTill, before.expectedTill - 5000);
    const told = (await run('getNotifications', {}, s.owner)).items.find(
      (n) => n.kind === 'payout.expense',
    );
    assert.match(told.body, /Bought charcoal/);
    const { payouts } = await run('getTillPayouts', {}, s.owner);
    assert.ok(payouts.some((p) => p.kind === 'expense' && p.note === 'Bought charcoal'));
    assert.ok(payouts.some((p) => p.kind === 'rider' && p.rider.includes('Pia')));
  });

  test('the cash drawer: openings are recorded; without a sale they need the PIN and a reason', async () => {
    await rejects(run('logDrawerOpen', { reason: 'sale' }, s.dina), /switched off/);
    const settings = (await run('adminListSetup', {}, s.owner)).settings;
    await run(
      'adminSaveSettings',
      { ...settings, cashDrawer: true, drawerOnShift: false },
      s.owner,
    );
    const { config } = await run('getMyProfile', {}, s.dina);
    assert.deepEqual(config.drawer, {
      onSale: true,
      onHandover: true,
      onPayout: true,
      onShift: false,
    });
    await rejects(run('logDrawerOpen', { reason: 'party' }, s.dina), /Unknown reason/);
    await rejects(run('logDrawerOpen', { reason: 'sale' }, s.pia), /cashier|admin/);
    const sale = await run('logDrawerOpen', { reason: 'sale', ref: 'abc123' }, s.dina);
    assert.equal(sale.opened, true);
    await rejects(
      run('logDrawerOpen', { reason: 'no_sale', note: 'x', pin: '2244' }, s.dina),
      /Say why/,
    );
    await rejects(
      run('logDrawerOpen', { reason: 'no_sale', note: 'Change for float', pin: '0000' }, s.dina),
      /Wrong PIN/,
    );
    const noSale = await run(
      'logDrawerOpen',
      { reason: 'no_sale', note: 'Change for float', pin: '2244' },
      s.dina,
    );
    assert.equal(noSale.drawerOpens, sale.drawerOpens + 1);
    assert.equal(noSale.noSaleOpens, 1);
    const told = (await run('getNotifications', {}, s.owner)).items.find(
      (n) => n.kind === 'till.no_sale',
    );
    assert.match(told.body, /Change for float/);
    const report = await run('getDrawerOpenings', {}, s.owner);
    assert.ok(report.items.some((i) => i.reason === 'no_sale' && i.note === 'Change for float'));
    assert.ok(report.items.some((i) => i.reason === 'sale' && i.ref === 'abc123'));
    const dina = report.people.find((p) => p.noSale === 1);
    assert.ok(dina.opens >= 2);
    await rejects(run('getDrawerOpenings', {}, s.dina), /admin|finance/);
    await run('adminSaveSettings', { ...settings, cashDrawer: false }, s.owner);
  });

  test('the owner can write off a shortage, reopen a count, or take cash in person', async () => {
    const make = async () => {
      const { id } = await deliveredOrder();
      return run('createHandover', { orderIds: [id] }, s.pia);
    };
    const a = await make();
    await run(
      'disputeHandover',
      { handoverId: a.id, countedAmount: a.amount - 500, reason: 'Coins missing' },
      s.eli,
    );
    await run(
      'adminResolveHandover',
      { handoverId: a.id, action: 'write_off', note: 'Small amount, absorbed' },
      s.owner,
    );
    const written = await new Parse.Query('CashHandover').get(a.id, M);
    assert.equal(written.get('shortageStatus'), 'written_off');
    assert.equal((await run('getMyPay', {}, s.pia)).deductions, 0);

    const b = await make();
    await run(
      'disputeHandover',
      { handoverId: b.id, countedAmount: 0, reason: 'Envelope was empty' },
      s.eli,
    );
    await run(
      'adminResolveHandover',
      { handoverId: b.id, action: 'reopen', note: 'Recount with the rider present' },
      s.owner,
    );
    await run('confirmHandover', { handoverId: b.id, countedAmount: b.amount }, s.eli);

    const { id } = await deliveredOrder();
    await rejects(
      run('adminReceiveCash', { riderId: s.pia.id, note: 'x' }, s.owner),
      /where the cash is/,
    );
    const taken = await run(
      'adminReceiveCash',
      { riderId: s.pia.id, orderIds: [id], note: 'Owner collected at the stage' },
      s.owner,
    );
    const order = await new Parse.Query('Order').get(id, M);
    assert.equal(order.get('cashStatus'), 'RECONCILED');
    assert.ok(taken.amount > 0);
  });

  test('handovers waiting over 4 hours are flagged to cashiers and the owner', async () => {
    const { id } = await deliveredOrder();
    const h = await run('createHandover', { orderIds: [id] }, s.pia);
    const row = await new Parse.Query('CashHandover').get(h.id, M);
    row.set('handedOverAt', new Date(Date.now() - 5 * 3600 * 1000));
    await row.save(null, M);
    const stale = (await run('getNotifications', {}, s.eli)).items.find(
      (n) => n.kind === 'cash.handover_stale',
    );
    assert.match(stale.title, /waiting 5 h/);
    assert.ok(
      (await run('getNotifications', {}, s.owner)).items.some(
        (n) => n.kind === 'cash.handover_stale',
      ),
    );
    await run('confirmHandover', { handoverId: h.id, countedAmount: h.amount }, s.eli);
  });

  test('the cash check finds records that disagree', async () => {
    const clean = await run('adminRunCashCheck', {}, s.owner);
    assert.deepEqual(
      clean.problems.filter((p) => p.kind !== 'shift_open'),
      [],
      JSON.stringify(clean.problems),
    );
    const { id } = await deliveredOrder();
    const order = await new Parse.Query('Order').get(id, M);
    order.set('cashStatus', 'HANDOVER_PENDING');
    await order.save(null, M);
    const found = await run('adminRunCashCheck', {}, s.owner);
    assert.equal(found.ok, false);
    assert.ok(found.problems.some((p) => p.kind === 'order_handover'));
    const alert = (await run('getNotifications', {}, s.owner)).items.find(
      (n) => n.kind === 'cash.check',
    );
    assert.match(alert.title, /Cash check/);
    await rejects(run('adminRunCashCheck', {}, s.dina), /admin role required/);
    order.set('cashStatus', 'WITH_RIDER');
    await order.save(null, M);
  });
});

describe('rider pay includes the delivery fee; pay at handover', () => {
  const M = { useMasterKey: true };
  let item;
  const deliveredFor = async (name) => {
    const placed = await run(
      'createOrder',
      { customerName: name, deliveryAddress: 'Muyenga', items: [{ id: item.id, quantity: 1 }] },
      s.pia,
    );
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: placed.id, action }, s.dina);
    await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.pia);
    await run('transitionOrder', { orderId: placed.id, action: 'deliver' }, s.pia);
    return placed.id;
  };

  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
  });

  test('older deliveries stored without the fee are still paid it, and repaired', async () => {
    const id = await deliveredFor('Before the fee rule');
    // Shape of an order delivered before rider pay included the fee.
    const order = await new Parse.Query('Order').get(id, M);
    const base = order.get('commissionBase');
    order.set('commissionAmount', base);
    order.unset('deliveryPay');
    order.unset('commissionBase');
    await order.save(null, M);
    const fee = order.get('deliveryFee');
    assert.ok(fee > 0);

    const ledger = await run('getCommissionLedger', { riderId: s.pia.id }, s.owner);
    assert.equal(ledger.rows.find((r) => r.id === id).commission, base + fee);
    const row = (await run('getRiderPay', {}, s.dina)).find((r) => r.riderId === s.pia.id);
    assert.ok(row.deliveryFees >= fee);
    assert.equal(row.earned, row.commission + row.deliveryFees);

    await run('adminApplySecurity', {}, s.owner);
    const fixed = await new Parse.Query('Order').get(id, M);
    assert.equal(fixed.get('deliveryPay'), fee);
    assert.equal(fixed.get('commissionAmount'), base + fee);
    assert.equal(
      (await run('getCommissionLedger', { riderId: s.pia.id }, s.owner)).rows.find(
        (r) => r.id === id,
      ).commission,
      base + fee,
    );
  });

  test('revenue after rider pay takes the delivery fees off too', async () => {
    const report = await run('getOperationsReport', {}, s.owner);
    const s1 = report.summary;
    assert.ok(s1.commission >= s1.deliveryFees);
    assert.equal(s1.net, s1.revenue - s1.commission);
  });

  test('at the handover the cashier can pay the delivery fees; commission comes later', async () => {
    // Settle what Pia is already owed so only the new order is unpaid.
    await run('payRider', { riderId: s.pia.id }, s.dina).catch(() => undefined);
    const id = await deliveredFor('Pay at handover');
    const row = await new Parse.Query('Order').get(id, M);
    const fee = row.get('deliveryPay');
    const commission = row.get('commissionBase');
    assert.ok(fee > 0 && commission > 0);
    const h = await run('createHandover', { orderIds: [id] }, s.pia);
    const before = (await run('getMyShift', {}, s.dina)).shift;
    await rejects(
      run(
        'confirmHandover',
        { handoverId: h.id, countedAmount: h.amount, payRider: true, pin: '0000' },
        s.dina,
      ),
      /Wrong PIN/,
    );
    const result = await run(
      'confirmHandover',
      { handoverId: h.id, countedAmount: h.amount, payRider: true, pin: '2244' },
      s.dina,
    );
    assert.equal(result.paid, fee);
    assert.equal(result.payProblem, '');
    const after = (await run('getMyShift', {}, s.dina)).shift;
    assert.equal(after.cashIn - before.cashIn, h.amount);
    assert.equal(after.paidOut - before.paidOut, fee);
    let order = await new Parse.Query('Order').get(id, M);
    assert.equal(order.get('deliveryFeePaid'), true);
    assert.notEqual(order.get('commissionPaid'), true);
    assert.equal(order.get('cashStatus'), 'RECONCILED');
    let mine = await run('getMyPay', {}, s.pia);
    assert.equal(mine.payouts[0].amount, fee);
    assert.equal(mine.payouts[0].feesOnly, true);
    // Only the commission is still owed for that order.
    assert.equal(mine.owed, commission);
    assert.equal(mine.deliveryFees, 0);
    await run('payRider', { riderId: s.pia.id }, s.dina);
    order = await new Parse.Query('Order').get(id, M);
    assert.equal(order.get('commissionPaid'), true);
    mine = await run('getMyPay', {}, s.pia);
    assert.equal(mine.payouts[0].amount, commission);
    assert.equal(mine.owed, 0);
  });
});

describe('mobile money taken at the door must be confirmed', () => {
  const M = { useMasterKey: true };
  let item;
  const deliveredByMomo = async (name, reference) => {
    const placed = await run(
      'createOrder',
      { customerName: name, deliveryAddress: 'Kabalagala', items: [{ id: item.id, quantity: 1 }] },
      s.pia,
    );
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: placed.id, action }, s.dina);
    await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.pia);
    await run(
      'transitionOrder',
      {
        orderId: placed.id,
        action: 'deliver',
        paymentMethod: 'mobile_money',
        paymentProvider: 'mtn',
        paymentReference: reference,
      },
      s.pia,
    );
    return placed;
  };

  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
  });

  test('an unconfirmed door payment stays on the rider; rejected, it is owed as cash', async () => {
    const placed = await deliveredByMomo('Door MoMo', 'MP260926D001');
    let row = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(row.get('paidAtDoor'), true);
    assert.equal(row.get('paymentStatus'), 'PENDING_VERIFICATION');
    assert.equal((await run('getMyShift', {}, s.pia)).shift.outstanding.momoPending, 1);

    await run(
      'verifyPayment',
      { orderId: placed.id, received: false, reason: 'Not on the MTN statement' },
      s.dina,
    );
    row = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(row.get('paymentMethod'), 'cash');
    assert.equal(row.get('cashStatus'), 'WITH_RIDER');
    assert.equal(row.get('amountCollected'), placed.total);
    const told = (await run('getNotifications', {}, s.pia)).items.find(
      (n) => n.kind === 'payment.rejected' && n.title.includes(row.get('orderCode')),
    );
    assert.match(told.body, /You owe/);
    const outstanding = (await run('getMyShift', {}, s.pia)).shift.outstanding;
    assert.equal(outstanding.momoPending, 0);
    assert.ok(outstanding.cashWithRider >= placed.total);

    // A correct transaction ID takes it off the cash list again, pending a check.
    await run(
      'resubmitPayment',
      { orderId: placed.id, provider: 'mtn', reference: 'MP260926D002' },
      s.pia,
    );
    row = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(row.get('paymentMethod'), 'mobile_money');
    assert.equal(row.get('cashStatus'), 'NOT_APPLICABLE');
    assert.equal(row.get('paymentStatus'), 'PENDING_VERIFICATION');
    await run('verifyPayment', { orderId: placed.id, received: true }, s.dina);
    assert.equal((await run('getMyShift', {}, s.pia)).shift.outstanding.momoPending, 0);
  });

  test('once the owed cash is handed over, it cannot switch back to mobile money', async () => {
    const placed = await deliveredByMomo('Door MoMo 2', 'MP260926D003');
    await run(
      'verifyPayment',
      { orderId: placed.id, received: false, reason: 'Wrong amount received' },
      s.dina,
    );
    await run('createHandover', { orderIds: [placed.id] }, s.pia);
    await rejects(
      run(
        'resubmitPayment',
        { orderId: placed.id, provider: 'mtn', reference: 'MP260926D004' },
        s.pia,
      ),
      /already handed over as cash/,
    );
  });
});

test('Apply security rules puts door payments rejected before the rule on the rider', async () => {
  const M = { useMasterKey: true };
  const item = (await run('getOperationalMenu', {}, s.pia)).items.find(
    (i) => !i.accompanimentGroups.length,
  );
  const placed = await run(
    'createOrder',
    {
      customerName: 'Old rejection',
      deliveryAddress: 'Kansanga',
      items: [{ id: item.id, quantity: 1 }],
    },
    s.pia,
  );
  for (const action of ['accept', 'ready'])
    await run('transitionOrder', { orderId: placed.id, action }, s.dina);
  await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.pia);
  await run('transitionOrder', { orderId: placed.id, action: 'deliver' }, s.pia);
  // How such an order was left before the rule: still mobile money, rejected.
  const order = await new Parse.Query('Order').get(placed.id, M);
  order.set({
    paymentMethod: 'mobile_money',
    paymentProvider: 'airtel',
    paymentReference: 'AT34678OLD',
    paymentStatus: 'REJECTED',
    cashStatus: 'NOT_APPLICABLE',
    amountCollected: 0,
  });
  await order.save(null, M);
  const result = await run('adminApplySecurity', {}, s.owner);
  assert.ok(result.rejectedDoorPayments >= 1);
  const fixed = await new Parse.Query('Order').get(placed.id, M);
  assert.equal(fixed.get('paymentMethod'), 'cash');
  assert.equal(fixed.get('cashStatus'), 'WITH_RIDER');
  assert.equal(fixed.get('amountCollected'), placed.total);
  // The rider can now hand it over like any other cash.
  await run('createHandover', { orderIds: [placed.id] }, s.pia);
});

describe("people: PINs, availability, cash limits and the owner's member page", () => {
  const M = { useMasterKey: true };
  let item;
  let pat;
  let cass;
  const profile = (user) => run('getMyProfile', {}, user);
  const orderFor = (name) =>
    run(
      'createOrder',
      { customerName: name, deliveryAddress: 'Ntinda', items: [{ id: item.id, quantity: 1 }] },
      s.pat,
    );

  before(async () => {
    pat = await run(
      'adminCreateTeamMember',
      { name: 'Pat Boda', username: 'pat', pin: '1470', role: 'rider' },
      s.owner,
    );
    cass = await run(
      'adminCreateTeamMember',
      { name: 'Cass Till', username: 'cass', pin: '2580', role: 'cashier' },
      s.owner,
    );
    Object.assign(PINS, { pat: '1470', cass: '2580' });
    s.pat = await login('pat', '1470');
    s.cass = await login('cass', '2580');
    item = (await run('getOperationalMenu', {}, s.pat)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
  });

  test('a rider on a break cannot take orders; starting a shift makes them available', async () => {
    assert.equal((await profile(s.pat)).available, true);
    await run('setMyAvailability', { available: false }, s.pat);
    assert.equal((await profile(s.pat)).available, false);
    await rejects(orderFor('On break'), /on a break/);
    await rejects(run('setMyAvailability', { available: true }, s.cass), /rider role required/);
    await run('startShift', { kind: 'rider' }, s.pat);
    assert.equal((await profile(s.pat)).available, true);
    await run('setMyAvailability', { available: false }, s.pat);
    await run('setMyAvailability', { available: true }, s.pat);
    const placed = await orderFor('Back from break');
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: placed.id, action }, s.dina);
    await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.pat);
    await run('transitionOrder', { orderId: placed.id, action: 'deliver' }, s.pat);
    s.patOrder = placed;
  });

  test('the owner can give one rider their own cash limit', async () => {
    const standard = (await profile(s.pat)).config.maxRiderFloat;
    await run('adminUpdateMember', { id: pat.id, maxFloat: s.patOrder.total }, s.owner);
    assert.equal((await profile(s.pat)).config.maxRiderFloat, s.patOrder.total);
    await rejects(orderFor('Over my limit'), /Cash limit reached/);
    const team = (await run('adminListSetup', {}, s.owner)).team;
    const row = team.find((m) => m.id === pat.id);
    assert.equal(row.cashLimit, s.patOrder.total);
    assert.equal(row.cashHeld, s.patOrder.total);
    assert.equal(row.onShift, true);
    await rejects(run('adminUpdateMember', { id: pat.id, maxFloat: -5 }, s.owner), /cash limit/);
    await run('adminUpdateMember', { id: pat.id, maxFloat: '' }, s.owner);
    assert.equal((await profile(s.pat)).config.maxRiderFloat, standard);
    assert.equal((await profile(s.dina)).config.maxRiderFloat, standard);
  });

  test("the owner's rider page shows cash, open orders, lifetime figures and history", async () => {
    await rejects(run('adminGetMember', { id: pat.id }, s.dina), /admin role required/);
    const open = await orderFor('Still open');
    const page = await run('adminGetMember', { id: pat.id }, s.owner);
    assert.equal(page.role, 'rider');
    assert.equal(page.code, pat.code);
    assert.equal(page.available, true);
    assert.ok(page.onShiftSince);
    assert.equal(page.rider.cash.held, s.patOrder.total);
    assert.equal(page.rider.cash.withRider, s.patOrder.total);
    assert.deepEqual(
      page.rider.openOrders.map((o) => o.id),
      [open.id],
    );
    assert.equal(page.rider.lifetime.deliveries, 1);
    assert.equal(page.rider.lifetime.sales, s.patOrder.total);
    assert.equal(page.rider.lifetime.cashSales, s.patOrder.total);
    assert.equal(page.rider.pay.deliveries, 1);
    assert.equal(page.rider.pay.owed, page.rider.lifetime.riderPay);
    await run('createHandover', { orderIds: [s.patOrder.id] }, s.pat);
    const after = await run('adminGetMember', { id: pat.id }, s.owner);
    assert.equal(after.rider.handovers.length, 1);
    assert.equal(after.rider.handovers[0].status, 'pending');
    assert.equal(after.rider.cash.pending, s.patOrder.total);
    await run('transitionOrder', { orderId: open.id, action: 'cancel', reason: 'Test' }, s.pat);
    const done = await run('adminGetMember', { id: pat.id }, s.owner);
    assert.equal(done.rider.lifetime.cancelled, 1);
    assert.equal(done.rider.openOrders.length, 0);
  });

  test("the owner's cashier page shows shifts and orders held", async () => {
    await run('startShift', { kind: 'cashier', openingFloat: 2500 }, s.cass);
    const page = await run('adminGetMember', { id: cass.id }, s.owner);
    assert.equal(page.role, 'cashier');
    assert.equal(page.rider, null);
    assert.equal(page.cashier.shifts.length, 1);
    assert.equal(page.cashier.shifts[0].openingFloat, 2500);
    assert.equal(page.cashier.shifts[0].status, 'open');
    assert.deepEqual(page.cashier.heldOrders, []);
  });

  test('changing a PIN needs the old one and signs out every device', async () => {
    const other = await login('cass', '2580');
    await rejects(run('changeMyPin', { oldPin: '0000', newPin: '9999' }, s.cass), /Wrong PIN/);
    await rejects(run('changeMyPin', { oldPin: '2580', newPin: '12' }, s.cass), /4 to 32/);
    await rejects(run('changeMyPin', { oldPin: '2580', newPin: '2580' }, s.cass), /different/);
    await run('changeMyPin', { oldPin: '2580', newPin: '3691' }, s.cass);
    await rejects(profile(other), /session/i);
    await rejects(login('cass', '2580'), /Invalid username\/password/);
    s.cass = await login('cass', '3691');
    PINS.cass = '3691';
    assert.equal((await profile(s.cass)).role, 'cashier');
    await rejects(
      run('changeMyPin', { oldPin: 'owner-pass', newPin: 'short' }, s.owner),
      /8 to 64/,
    );
  });

  test('the owner can reset a forgotten PIN; it clears the lock and signs them out', async () => {
    const locked = await new Parse.Query(Parse.User).get(pat.id, M);
    locked.set({ pinFailures: 3, pinLockedUntil: new Date(Date.now() + 600000) });
    await locked.save(null, M);
    assert.equal((await run('adminGetMember', { id: pat.id }, s.owner)).pinLocked, true);
    await rejects(run('adminResetPin', { id: pat.id, pin: '8080' }, s.dina), /admin role required/);
    await rejects(run('adminResetPin', { id: s.owner.id, pin: '80808080' }, s.owner), /own/);
    await rejects(run('adminResetPin', { id: pat.id, pin: '80' }, s.owner), /4 to 32/);
    await run('adminResetPin', { id: pat.id, pin: '8080' }, s.owner);
    await rejects(profile(s.pat), /session/i);
    s.pat = await login('pat', '8080');
    PINS.pat = '8080';
    const page = await run('adminGetMember', { id: pat.id }, s.owner);
    assert.equal(page.pinLocked, false);
    const audit = await new Parse.Query('AuditLog').equalTo('action', 'team.pin_reset').first(M);
    assert.equal(audit.get('entityId'), pat.id);
  });

  test('deactivating someone signs them out; the owner can edit name and phone', async () => {
    await run(
      'adminUpdateMember',
      { id: cass.id, name: 'Cass Tills', phone: '0772 000111' },
      s.owner,
    );
    const page = await run('adminGetMember', { id: cass.id }, s.owner);
    assert.equal(page.name, 'Cass Tills');
    assert.equal(page.phone, '0772 000111');
    await rejects(run('adminUpdateMember', { id: cass.id, name: ' ' }, s.owner), /name/);
    await run('adminUpdateMember', { id: cass.id, active: false }, s.owner);
    await rejects(profile(s.cass), /session|inactive/i);
    // Parse still lets them sign in, but every Cloud function refuses them.
    await rejects(profile(await login('cass', '3691')), /inactive/);
    await run('adminUpdateMember', { id: cass.id, active: true }, s.owner);
    s.cass = await login('cass', '3691');
  });

  test('new riders get the default commission rule from Settings', async () => {
    const { settings: current } = await run('adminListSetup', {}, s.owner);
    await rejects(
      run('adminSaveSettings', { ...current, commissionRounding: 'constructor' }, s.owner),
      /rounding/,
    );
    await rejects(
      run('adminSaveSettings', { ...current, defaultCommissionPercent: 150 }, s.owner),
      /percent/,
    );
    await run(
      'adminSaveSettings',
      {
        ...current,
        defaultCommissionType: 'hybrid',
        defaultCommissionPerOrder: 700,
        defaultCommissionPercent: 5,
      },
      s.owner,
    );
    const quinn = await run(
      'adminCreateTeamMember',
      { name: 'Quinn Moto', username: 'quinn', pin: '1122', role: 'rider' },
      s.owner,
    );
    const page = await run('adminGetMember', { id: quinn.id }, s.owner);
    assert.deepEqual(page.commission, { type: 'hybrid', perOrder: 700, percent: 5 });
    await run('adminSaveSettings', current, s.owner);
  });
});

describe('owner reporting and control', () => {
  const M = { useMasterKey: true };
  let item;
  let val;
  const orderBy = (rider, name) =>
    run(
      'createOrder',
      { customerName: name, deliveryAddress: 'Bukoto', items: [{ id: item.id, quantity: 1 }] },
      rider,
    );
  const toReady = async (id) => {
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: id, action }, s.dina);
  };
  const override = (params) => run('adminOverrideOrder', params, s.owner);
  const fetchOrder = (id) => new Parse.Query('Order').get(id, M);

  before(async () => {
    val = await run(
      'adminCreateTeamMember',
      { name: 'Val Wheels', username: 'val', pin: '5151', role: 'rider' },
      s.owner,
    );
    await run(
      'adminUpdateMember',
      { id: val.id, commissionType: 'per_order', commissionPerOrder: 1500 },
      s.owner,
    );
    PINS.val = '5151';
    s.val = await login('val', '5151');
    item = (await run('getOperationalMenu', {}, s.val)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
  });

  test('the dashboard is computed on the server, for the owner only', async () => {
    await rejects(run('getDashboard', {}, s.dina), /admin or finance role required/);
    const d = await run('getDashboard', {}, s.owner);
    assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(d.days.length, 30);
    assert.equal(d.hours.length, 24);
    assert.ok(d.recent.length > 0 && d.recent.length <= 15);
    assert.equal(d.today.kept, d.today.sales - d.today.riderPay);
    const held = await new Parse.Query('Order')
      .equalTo('status', 'DELIVERED')
      .containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING'])
      .limit(1000)
      .find(M);
    assert.equal(
      d.cash.total,
      held.reduce((n, o) => n + (o.get('amountCollected') || 0), 0),
    );
    assert.equal(typeof d.attention.momoPending, 'number');
  });

  test('the owner can cancel an order the kitchen already accepted, with a reason', async () => {
    const placed = await orderBy(s.val, 'Cancel me');
    await run('transitionOrder', { orderId: placed.id, action: 'accept' }, s.dina);
    await rejects(
      run('transitionOrder', { orderId: placed.id, action: 'cancel', reason: 'No' }, s.val),
      /kitchen has accepted/,
    );
    await rejects(override({ id: placed.id, action: 'cancel', reason: 'no' }), /Say why/);
    await rejects(
      override({ id: placed.id, action: 'refund', reason: 'Because' }),
      /Unknown override/,
    );
    await rejects(
      run(
        'adminOverrideOrder',
        { id: placed.id, action: 'cancel', reason: 'Customer left' },
        s.dina,
      ),
      /admin role required/,
    );
    await override({ id: placed.id, action: 'cancel', reason: 'Customer left' });
    const order = await fetchOrder(placed.id);
    assert.equal(order.get('status'), 'CANCELLED');
    assert.equal(order.get('cancelledReason'), 'Customer left');
    const note = await new Parse.Query('Notification')
      .equalTo('recipient', Parse.User.createWithoutData(val.id))
      .equalTo('kind', 'order.override_cancel')
      .first(M);
    assert.ok(note, 'the rider is told');
    await rejects(
      override({ id: placed.id, action: 'cancel', reason: 'Again please' }),
      /not yet delivered/,
    );
  });

  test('the owner can move an open order to another rider', async () => {
    const placed = await orderBy(s.val, 'Move me');
    await rejects(
      override({ id: placed.id, action: 'move', reason: 'Bike broke', riderId: s.dina.id }),
      /Choose a rider/,
    );
    await override({ id: placed.id, action: 'move', reason: 'Bike broke down', riderId: s.pat.id });
    const order = await fetchOrder(placed.id);
    assert.equal(order.get('createdBy').id, s.pat.id);
    assert.equal(
      await new Parse.Query('Order').equalTo('objectId', placed.id).first(as(s.val)),
      undefined,
    );
    assert.ok(await new Parse.Query('Order').equalTo('objectId', placed.id).first(as(s.pat)));
    const lines = await new Parse.Query('OrderItem').equalTo('order', order).find(as(s.pat));
    assert.equal(lines.length, 1);
    await override({ id: placed.id, action: 'cancel', reason: 'Clean up test' });
  });

  test('mark delivered, switch the payment, and undo the delivery', async () => {
    const placed = await orderBy(s.val, 'Stuck order');
    await rejects(
      override({ id: placed.id, action: 'deliver', reason: 'Rider phone died' }),
      /ready or picked-up/,
    );
    await toReady(placed.id);
    await override({ id: placed.id, action: 'deliver', reason: 'Rider phone died' });
    let order = await fetchOrder(placed.id);
    assert.equal(order.get('status'), 'DELIVERED');
    assert.equal(order.get('cashStatus'), 'WITH_RIDER');
    assert.equal(order.get('amountCollected'), placed.total);
    assert.equal(order.get('commissionAmount'), 1500 + order.get('deliveryFee'));

    await rejects(
      override({
        id: placed.id,
        action: 'payment',
        method: 'mobile_money',
        reason: 'Paid by MoMo',
        provider: 'mtn',
        reference: '',
      }),
      /transaction ID/,
    );
    await override({
      id: placed.id,
      action: 'payment',
      method: 'mobile_money',
      reason: 'Customer paid by MoMo',
      provider: 'mtn',
      reference: 'OVR12345',
    });
    order = await fetchOrder(placed.id);
    assert.equal(order.get('paymentMethod'), 'mobile_money');
    assert.equal(order.get('paymentStatus'), 'PENDING_VERIFICATION');
    assert.equal(order.get('cashStatus'), 'NOT_APPLICABLE');
    assert.equal(order.get('amountCollected'), 0);

    await override({
      id: placed.id,
      action: 'payment',
      method: 'cash',
      reason: 'It was cash after all',
    });
    order = await fetchOrder(placed.id);
    assert.equal(order.get('paymentMethod'), 'cash');
    assert.equal(order.get('paymentStatus'), undefined);
    assert.equal(order.get('cashStatus'), 'WITH_RIDER');

    await override({ id: placed.id, action: 'reopen', reason: 'Marked delivered by mistake' });
    order = await fetchOrder(placed.id);
    assert.equal(order.get('status'), 'PICKED_UP');
    assert.equal(order.get('deliveredAt'), undefined);
    assert.equal(order.get('commissionAmount'), 0);
    assert.equal(order.get('cashStatus'), 'NOT_COLLECTED');
    // The rider delivers it for real, then hands the cash over: no more undo.
    await run('transitionOrder', { orderId: placed.id, action: 'deliver' }, s.val);
    await run('createHandover', { orderIds: [placed.id] }, s.val);
    await rejects(
      override({ id: placed.id, action: 'reopen', reason: 'Try to undo' }),
      /still with the rider/,
    );
    await rejects(
      override({
        id: placed.id,
        action: 'payment',
        method: 'mobile_money',
        reason: 'Try to switch',
        provider: 'mtn',
        reference: 'OVR99999',
      }),
      /still with the rider/,
    );
    s.valHandedOver = placed.id;

    const page = await run('adminGetOrder', { id: placed.id }, s.owner);
    assert.equal(page.code, order.get('orderCode'));
    assert.equal(page.items.length, 1);
    assert.equal(page.handovers.length, 1);
    assert.equal(page.can.reopen, false);
    const actions = page.history.map((h) => h.action);
    for (const action of [
      'order.placed',
      'order.override_deliver',
      'order.override_payment',
      'order.override_reopen',
      'order.deliver',
    ])
      assert.ok(actions.includes(action), action);
    await rejects(run('adminGetOrder', { id: placed.id }, s.val), /admin or finance role required/);
  });

  test('the audit log filters by kind, person and record', async () => {
    await rejects(run('adminGetAuditLog', {}, s.dina), /admin role required/);
    const all = await run('adminGetAuditLog', {}, s.owner);
    assert.ok(all.rows.length > 0 && all.rows.length <= 100);
    assert.ok(all.next, 'more than one page');
    const second = await run('adminGetAuditLog', { before: all.next }, s.owner);
    assert.ok(new Date(second.rows[0].at) <= new Date(all.rows.at(-1).at));
    const orders = await run('adminGetAuditLog', { group: 'order' }, s.owner);
    assert.ok(orders.rows.every((r) => r.action.startsWith('order.')));
    const mine = await run('adminGetAuditLog', { actorId: val.id }, s.owner);
    assert.ok(mine.rows.length && mine.rows.every((r) => r.actorId === val.id));
    const one = await run('adminGetAuditLog', { entityId: s.valHandedOver }, s.owner);
    assert.ok(one.rows.some((r) => r.action === 'order.override_reopen'));
    assert.match(one.rows[0].entity, /^ORD-/);
    const reopen = one.rows.find((r) => r.action === 'order.override_reopen');
    assert.equal(reopen.before.status, 'DELIVERED');
    assert.equal(reopen.after.status, 'PICKED_UP');
    assert.equal(reopen.after.reason, 'Marked delivered by mistake');
    await rejects(run('adminGetAuditLog', { group: 'nope' }, s.owner), /kind of action/);
  });

  test('the commission ledger shows paid and owed', async () => {
    const placed = await orderBy(s.val, 'Pay me');
    await toReady(placed.id);
    await run('transitionOrder', { orderId: placed.id, action: 'pickup' }, s.val);
    await run('transitionOrder', { orderId: placed.id, action: 'deliver' }, s.val);
    assert.ok((await run('getMyPay', {}, s.val)).owed > 0);
    // Riders no longer ask to be paid: the cashier pays from the Payouts page.
    await rejects(run('requestPayout', {}, s.val), /Invalid function/);

    const ledger = await run('getCommissionLedger', { riderId: val.id }, s.owner);
    assert.equal(ledger.owed, ledger.total);
    assert.ok(ledger.rows.every((r) => r.payState === 'owed'));
    await run('payRider', { riderId: val.id }, s.owner);
    const paid = await run('getCommissionLedger', { riderId: val.id, paid: 'paid' }, s.owner);
    assert.equal(paid.owed, 0);
    assert.equal(paid.rows.length, ledger.rows.length);
    const owed = await run('getCommissionLedger', { riderId: val.id, paid: 'owed' }, s.owner);
    assert.equal(owed.rows.length, 0);
    assert.equal((await run('getMyPay', {}, s.val)).owed, 0);
    await rejects(run('getCommissionLedger', { paid: 'maybe' }, s.owner), /all, paid or owed/);
  });

  test('the Z-report sums the day; past days are saved; the nightly job tells the owner', async () => {
    const today = await run('adminGetZReport', {}, s.owner);
    assert.equal(today.live, true);
    const z = today.report;
    assert.ok(z.orders.delivered >= 2);
    assert.equal(z.sales.kept, z.sales.total - z.sales.riderPay);
    assert.equal(z.sales.total, z.sales.food + z.sales.deliveryFees);
    assert.ok(z.riders.some((r) => r.rider.includes('Val')));
    assert.ok(z.items.length >= 1);
    await rejects(run('adminGetZReport', {}, s.dina), /admin or finance role required/);
    await rejects(run('adminGetZReport', { day: '2999-01-01' }, s.owner), /up to today/);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const past = await run('adminGetZReport', { day: yesterday }, s.owner);
    assert.equal(past.live, false);
    assert.ok(past.savedAt);
    assert.ok((await run('adminListZReports', {}, s.owner)).some((r) => r.day === yesterday));
    await rejects(new Parse.Query('ZReport').find(as(s.owner)), /Permission denied|unauthorized/i);

    const { settings } = await run('adminListSetup', {}, s.owner);
    await rejects(run('adminSaveSettings', { ...settings, zReportHour: 24 }, s.owner), /0-23/);
    await run('adminSaveSettings', { ...settings, zReportHour: 0 }, s.owner);
    const jobId = await Parse.Cloud.startJob('dailyZReport', {});
    let status;
    for (let i = 0; i < 50; i += 1) {
      status = await new Parse.Query('_JobStatus').get(jobId, M);
      if (['succeeded', 'failed'].includes(status.get('status'))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(status.get('status'), 'succeeded', status.get('message'));
    const note = await new Parse.Query('Notification')
      .equalTo('recipient', s.owner)
      .equalTo('kind', 'report.z')
      .first(M);
    assert.ok(note, 'the owner is told');
    assert.match(note.get('link'), /^\/admin\/reports\/z\//);
    await run('adminSaveSettings', settings, s.owner);
  });

  test('menu categories: order, rename moves dishes, hidden ones leave the menu; prep time', async () => {
    const M = { useMasterKey: true };
    const a = await run('adminSaveCategory', { title: 'Grills' }, s.owner);
    const b = await run('adminSaveCategory', { title: 'Juices' }, s.owner);
    await rejects(run('adminSaveCategory', { title: 'grills' }, s.owner), /already a category/);
    await rejects(
      run('adminSaveMenuItem', { title: 'Loose', price: 1000, category: 'Nowhere' }, s.owner),
      /Choose one of the menu categories/,
    );
    await rejects(
      run(
        'adminSaveMenuItem',
        { title: 'Slow', price: 1000, category: 'Grills', prepMinutes: 999 },
        s.owner,
      ),
      /Prep time/,
    );
    const dish = await run(
      'adminSaveMenuItem',
      { title: 'Goat skewer', price: 7000, category: 'Grills', prepMinutes: 25 },
      s.owner,
    );
    let menu = await run('getOperationalMenu', {}, s.val);
    assert.deepEqual(menu.categories, ['Grills', 'Juices']);
    assert.equal(menu.items.find((i) => i.id === dish.id).prepMinutes, 25);

    await run('adminSortCategories', { ids: [b.id, a.id] }, s.owner);
    assert.deepEqual((await run('getOperationalMenu', {}, s.val)).categories, ['Juices', 'Grills']);
    // Saving a name keeps the position.
    const renamed = await run('adminSaveCategory', { id: a.id, title: 'BBQ' }, s.owner);
    assert.equal(renamed.dishesMoved, 1);
    menu = await run('getOperationalMenu', {}, s.val);
    assert.deepEqual(menu.categories, ['Juices', 'BBQ']);
    assert.equal(menu.items.find((i) => i.id === dish.id).category, 'BBQ');

    // The order remembers the longest prep time of its dishes.
    const placed = await run(
      'createOrder',
      {
        customerName: 'Prep Pat',
        deliveryAddress: 'Kyanja',
        paymentMethod: 'cash',
        items: [{ id: dish.id, quantity: 1 }],
      },
      s.val,
    );
    assert.equal((await new Parse.Query('Order').get(placed.id, M)).get('prepMinutes'), 25);
    await run('transitionOrder', { orderId: placed.id, action: 'cancel', reason: 'test' }, s.val);

    await run('adminSaveCategory', { id: a.id, title: 'BBQ', active: false }, s.owner);
    menu = await run('getOperationalMenu', {}, s.val);
    assert.ok(!menu.items.some((i) => i.id === dish.id), 'a hidden category leaves the menu');
    assert.deepEqual(menu.categories, ['Juices']);

    // Leave the menu as the other tests expect it: no categories set up.
    await run(
      'adminSaveMenuItem',
      { id: dish.id, title: 'Goat skewer', price: 7000, category: 'BBQ', archived: true },
      s.owner,
    );
    await Parse.Object.destroyAll(await new Parse.Query('MenuCategory').find(M), M);
  });

  test('dishes get a description, a photo, an order and can be archived', async () => {
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const dish = await run(
      'adminSaveMenuItem',
      {
        title: 'Rolex Special',
        price: 6000,
        category: 'Snacks',
        description: 'Eggs rolled in chapati',
      },
      s.owner,
    );
    let menu = (await run('getOperationalMenu', {}, s.val)).items;
    assert.equal(menu.at(-1).id, dish.id, 'a new dish goes to the end');
    assert.equal(menu.at(-1).description, 'Eggs rolled in chapati');
    await rejects(
      run('adminSetMenuImage', { id: dish.id, image: 'aGVsbG8=' }, s.owner),
      /JPEG, PNG or WebP/,
    );
    await rejects(
      run('adminSetMenuImage', { id: dish.id, image: PNG }, s.dina),
      /admin role required/,
    );
    const { image } = await run('adminSetMenuImage', { id: dish.id, image: PNG }, s.owner);
    assert.match(image, /^https?:\/\/.+dish\.png$/);
    menu = (await run('getOperationalMenu', {}, s.val)).items;
    assert.equal(menu.find((i) => i.id === dish.id).image, image);

    const ids = menu.map((i) => i.id);
    await run('adminSortMenu', { ids: [dish.id, ...ids.filter((id) => id !== dish.id)] }, s.owner);
    menu = (await run('getOperationalMenu', {}, s.val)).items;
    assert.equal(menu[0].id, dish.id);
    await rejects(run('adminSortMenu', { ids: [dish.id, dish.id] }, s.owner), /new order/);

    await run(
      'adminSaveMenuItem',
      { id: dish.id, title: 'Rolex Special', price: 6000, category: 'Snacks', archived: true },
      s.owner,
    );
    menu = (await run('getOperationalMenu', {}, s.val)).items;
    assert.ok(!menu.some((i) => i.id === dish.id));
    const listed = (await run('adminListSetup', {}, s.owner)).menu.find((i) => i.id === dish.id);
    assert.equal(listed.archived, true);
    assert.equal(listed.description, 'Eggs rolled in chapati');
    await run(
      'adminSaveMenuItem',
      { id: dish.id, title: 'Rolex Special', price: 6000, category: 'Snacks', archived: false },
      s.owner,
    );
    assert.ok((await run('getOperationalMenu', {}, s.val)).items.some((i) => i.id === dish.id));
    await run('adminSetMenuImage', { id: dish.id, remove: true }, s.owner);
    assert.equal(
      (await run('adminListSetup', {}, s.owner)).menu.find((i) => i.id === dish.id).image,
      null,
    );
  });

  test('the owner uploads a restaurant logo for sign-in and receipts', async () => {
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await rejects(run('adminSetRestaurantLogo', { image: PNG }, s.dina), /admin role required/);
    await rejects(
      run('adminSetRestaurantLogo', { image: 'aGVsbG8=' }, s.owner),
      /JPEG, PNG or WebP/,
    );
    const { logo } = await run('adminSetRestaurantLogo', { image: PNG }, s.owner);
    assert.match(logo, /^https?:\/\/.+logo\.png$/);
    assert.equal(
      (await run('getAppInfo', { restaurant: CODE })).restaurantLogo,
      logo,
      'shown before sign-in',
    );
    assert.equal((await run('getMyProfile', {}, s.val)).config.restaurantLogo, logo);
    assert.equal((await run('adminListSetup', {}, s.owner)).settings.restaurantLogo, logo);
    const order = await new Parse.Query('Order').first(M);
    assert.equal((await run('getReceipt', { orderId: order.id }, s.owner)).logo, logo);
    const settings = (await run('adminListSetup', {}, s.owner)).settings;
    await run('adminSaveSettings', settings, s.owner);
    assert.equal(
      (await run('getAppInfo', { restaurant: CODE })).restaurantLogo,
      logo,
      'saving settings keeps it',
    );
    await run('adminSetRestaurantLogo', { remove: true }, s.owner);
    assert.equal((await run('getAppInfo', { restaurant: CODE })).restaurantLogo, '');
  });

  test('the owner picks the sign-in pictures, up to six, in order', async () => {
    const JPEG =
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
    await rejects(run('adminSetLoginImages', { add: JPEG }, s.dina), /admin role required/);
    await rejects(run('adminSetLoginImages', { add: 'aGVsbG8=' }, s.owner), /JPEG, PNG or WebP/);
    await rejects(run('adminSetLoginImages', {}, s.owner), /Nothing to change/);
    assert.deepEqual((await run('getAppInfo', { restaurant: CODE })).loginImages, []);
    for (const caption of ['Grilled tilapia', 'Rolex', 'Our terrace'])
      await run('adminSetLoginImages', { add: JPEG, caption }, s.owner);
    let { images } = await run('adminSetLoginImages', { move: 2, to: 0 }, s.owner);
    assert.deepEqual(
      images.map((i) => i.caption),
      ['Our terrace', 'Grilled tilapia', 'Rolex'],
    );
    assert.match(images[0].url, /^https?:\/\/.+signin\.jpg$/);
    ({ images } = await run(
      'adminSetLoginImages',
      { index: 2, caption: '  Rolex, rolled fresh ' },
      s.owner,
    ));
    assert.equal(images[2].caption, 'Rolex, rolled fresh');
    await rejects(run('adminSetLoginImages', { remove: 7 }, s.owner), /No such picture/);
    ({ images } = await run('adminSetLoginImages', { remove: 1 }, s.owner));
    assert.deepEqual(
      images.map((i) => i.caption),
      ['Our terrace', 'Rolex, rolled fresh'],
    );
    const info = await run('getAppInfo', { restaurant: CODE });
    assert.deepEqual(info.loginImages, images, 'shown before sign-in');
    assert.deepEqual((await run('getMyProfile', {}, s.val)).config.loginImages, images);
    for (let i = images.length; i < 6; i += 1)
      await run('adminSetLoginImages', { add: JPEG }, s.owner);
    await rejects(run('adminSetLoginImages', { add: JPEG }, s.owner), /At most 6/);
    const settings = (await run('adminListSetup', {}, s.owner)).settings;
    await run('adminSaveSettings', settings, s.owner);
    assert.equal(
      (await run('getAppInfo', { restaurant: CODE })).loginImages.length,
      6,
      'saving settings keeps them',
    );
    for (let i = 0; i < 6; i += 1) await run('adminSetLoginImages', { remove: 0 }, s.owner);
    assert.deepEqual((await run('getAppInfo', { restaurant: CODE })).loginImages, []);
  });

  test('the owner sets theme colours, checked for readable contrast', async () => {
    await rejects(run('adminSaveBranding', { ink: '#123524' }, s.dina), /admin role required/);
    await rejects(run('adminSaveBranding', { ink: 'green' }, s.owner), /must look like/);
    await rejects(run('adminSaveBranding', { ink: '#99bb99' }, s.owner), /too light/);
    await rejects(
      run('adminSaveBranding', { ink: '#0b1633', accent: '#1d2b55' }, s.owner),
      /too close/,
    );
    const saved = await run('adminSaveBranding', { ink: '#123524', accent: '#E0A526' }, s.owner);
    assert.deepEqual(saved, { ink: '#123524', accent: '#e0a526' });
    assert.deepEqual(
      (await run('getAppInfo', { restaurant: CODE })).theme,
      saved,
      'the sign-in screen gets them',
    );
    assert.deepEqual((await run('getMyProfile', {}, s.val)).config.theme, saved);
    const settings = (await run('adminListSetup', {}, s.owner)).settings;
    await run('adminSaveSettings', settings, s.owner);
    assert.deepEqual(
      (await run('getAppInfo', { restaurant: CODE })).theme,
      saved,
      'saving settings keeps them',
    );
    await run('adminSaveBranding', { ink: '', accent: '' }, s.owner);
    assert.deepEqual((await run('getAppInfo', { restaurant: CODE })).theme, {
      ink: '',
      accent: '',
    });
  });
});

describe('live updates (LiveQuery) respect who may read what', () => {
  let item;
  const clients = [];
  // A LiveQuery connection as a signed-in user, without the master key.
  async function liveAs(user) {
    const client = new Parse.LiveQueryClient({
      applicationId: APP_ID,
      serverURL: `ws://localhost:${PORT}/parse`,
      sessionToken: user.getSessionToken(),
    });
    client.open();
    clients.push(client);
    return client;
  }
  // Collects events of `className` seen by `user`.
  async function watch(user, className, configure = () => {}) {
    const client = await liveAs(user);
    const query = new Parse.Query(className);
    configure(query);
    const subscription = client.subscribe(query, user.getSessionToken());
    const events = [];
    await new Promise((resolve, reject) => {
      subscription.on('open', resolve);
      subscription.on('error', reject);
    });
    for (const kind of ['create', 'update', 'enter'])
      subscription.on(kind, (object) => events.push({ kind, id: object.id, object }));
    return events;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));

  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
  });
  after(() => clients.forEach((client) => client.close()));

  test('cashiers see new orders live; other riders do not', async () => {
    const kitchen = await watch(s.dina, 'Order');
    const mine = await watch(s.pia, 'Order');
    const someoneElse = await watch(s.val, 'Order');
    const placed = await run(
      'createOrder',
      { customerName: 'Live one', deliveryAddress: 'Kira', items: [{ id: item.id, quantity: 1 }] },
      s.pia,
    );
    await settle();
    assert.ok(
      kitchen.some((e) => e.id === placed.id),
      'the kitchen sees it',
    );
    assert.ok(
      mine.some((e) => e.id === placed.id),
      'the rider sees their own order',
    );
    assert.ok(!someoneElse.some((e) => e.id === placed.id), 'another rider does not');
    await run('transitionOrder', { orderId: placed.id, action: 'accept' }, s.dina);
    await settle();
    assert.ok(mine.some((e) => e.id === placed.id && e.object.get('status') === 'ACCEPTED'));
    await run(
      'transitionOrder',
      { orderId: placed.id, action: 'cancel', reason: 'Live test' },
      s.dina,
    );
  });

  test("each person's notifications arrive live, to them only", async () => {
    const riderBell = await watch(s.pia, 'Notification');
    const otherBell = await watch(s.val, 'Notification');
    const placed = await run(
      'createOrder',
      { customerName: 'Live two', deliveryAddress: 'Kira', items: [{ id: item.id, quantity: 1 }] },
      s.pia,
    );
    await run('transitionOrder', { orderId: placed.id, action: 'accept' }, s.dina);
    await settle();
    assert.ok(riderBell.some((e) => e.object.get('kind') === 'order.accept'));
    assert.ok(!otherBell.some((e) => e.object.get('kind') === 'order.accept'));
    await run(
      'transitionOrder',
      { orderId: placed.id, action: 'cancel', reason: 'Live test' },
      s.dina,
    );
  });

  test('without signing in, nothing is streamed', async () => {
    const client = new Parse.LiveQueryClient({
      applicationId: APP_ID,
      serverURL: `ws://localhost:${PORT}/parse`,
    });
    client.open();
    clients.push(client);
    const subscription = client.subscribe(new Parse.Query('Order'));
    const events = [];
    const opened = await Promise.race([
      new Promise((resolve) => subscription.on('open', () => resolve(true))),
      new Promise((resolve) => subscription.on('error', () => resolve(false))),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
    subscription.on('create', (object) => events.push(object.id));
    await run(
      'createOrder',
      {
        customerName: 'Live three',
        deliveryAddress: 'Kira',
        items: [{ id: item.id, quantity: 1 }],
      },
      s.pia,
    );
    await settle();
    assert.deepEqual(events, [], `no events (subscription opened: ${opened})`);
  });
});

describe('delivery map pins', () => {
  const M = { useMasterKey: true };
  let item;
  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
  });
  const place = (extra) =>
    run(
      'createOrder',
      {
        customerName: 'Pinned Paula',
        customerPhone: '0772555101',
        deliveryAddress: 'Plot 4, Kisementi',
        items: [{ id: item.id, quantity: 1 }],
        ...extra,
      },
      s.pia,
    );

  test('an order can carry a pin; the customer address keeps it for next time', async () => {
    await rejects(place({ location: { lat: 200, lng: 32 } }), /not a valid location/);
    const placed = await place({ location: { lat: 0.33412345678, lng: 32.59876543 } });
    const order = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(order.get('location').latitude, 0.334123);
    assert.equal(order.get('location').longitude, 32.598765);
    const [paula] = await run('searchCustomers', { q: 'Pinned Paula' }, s.pia);
    assert.deepEqual(
      { lat: paula.addresses[0].lat, lng: paula.addresses[0].lng },
      { lat: 0.334123, lng: 32.598765 },
    );
    // The next order to the same address without a pin keeps the saved one.
    const again = await place({});
    const [still] = await run('searchCustomers', { q: 'Pinned Paula' }, s.pia);
    assert.equal(still.addresses[0].lat, 0.334123);
    const page = await run('adminGetOrder', { id: placed.id }, s.owner);
    assert.deepEqual(page.location, { lat: 0.334123, lng: 32.598765 });
    for (const id of [placed.id, again.id])
      await run('transitionOrder', { orderId: id, action: 'cancel', reason: 'Pin test' }, s.pia);
  });

  test('the rider (or staff) can pin or move the pin later, and remove it', async () => {
    const placed = await place({});
    await rejects(
      run('setOrderLocation', { orderId: placed.id, location: { lat: 0.3, lng: 32.6 } }, s.val),
      /Not your order/,
    );
    await rejects(
      run('setOrderLocation', { orderId: placed.id, location: { lat: 0, lng: 0 } }, s.pia),
      /Drop the pin/,
    );
    await run(
      'setOrderLocation',
      { orderId: placed.id, location: { lat: 0.31, lng: 32.61 } },
      s.pia,
    );
    let order = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(order.get('location').latitude, 0.31);
    const [paula] = await run('searchCustomers', { q: 'Pinned Paula' }, s.pia);
    assert.equal(paula.addresses[0].lat, 0.31);
    await run(
      'setOrderLocation',
      { orderId: placed.id, location: { lat: 0.32, lng: 32.62 } },
      s.dina,
    );
    await run('setOrderLocation', { orderId: placed.id, location: null }, s.pia);
    order = await new Parse.Query('Order').get(placed.id, M);
    assert.equal(order.get('location'), undefined);
    const logged = await new Parse.Query('AuditLog')
      .equalTo('entityId', placed.id)
      .equalTo('action', 'order.location')
      .count(M);
    assert.equal(logged, 3);
    await run(
      'transitionOrder',
      { orderId: placed.id, action: 'cancel', reason: 'Pin test' },
      s.pia,
    );
    await rejects(
      run('setOrderLocation', { orderId: placed.id, location: { lat: 0.3, lng: 32.6 } }, s.pia),
      /cancelled/,
    );
  });

  test('the owner sets where the map opens', async () => {
    const { settings } = await run('adminListSetup', {}, s.owner);
    assert.deepEqual((await run('getMyProfile', {}, s.pia)).config.mapCenter, {
      lat: settings.restaurantLat,
      lng: settings.restaurantLng,
    });
    await rejects(
      run('adminSaveSettings', { ...settings, restaurantLat: 95, restaurantLng: 32 }, s.owner),
      /Restaurant location/,
    );
    await run(
      'adminSaveSettings',
      { ...settings, restaurantLat: 0.3136, restaurantLng: 32.5811 },
      s.owner,
    );
    assert.deepEqual((await run('getMyProfile', {}, s.pia)).config.mapCenter, {
      lat: 0.3136,
      lng: 32.5811,
    });
    await run('adminSaveSettings', settings, s.owner);
  });
});

describe('counter modules: call-in delivery, eat-in and pick-up', () => {
  const M = { useMasterKey: true };
  let item;
  let settings;
  const counter = (params, user = s.dina) =>
    run(
      'createCounterOrder',
      { items: [{ id: item.id, quantity: 1 }], customerPhone: '', ...params },
      user,
    );
  const move = async (id, actions, user = s.dina) => {
    for (const action of actions) await run('transitionOrder', { orderId: id, action }, user);
  };
  const till = async () => (await run('getMyShift', {}, s.dina)).shift;
  const fetch = (id) => new Parse.Query('Order').get(id, M);

  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
    ({ settings } = await run('adminListSetup', {}, s.owner));
  });
  after(async () => run('adminSaveSettings', settings, s.owner));

  test('the modules are off until the owner switches them on', async () => {
    assert.deepEqual((await run('getMyProfile', {}, s.dina)).config.modules, {
      riderOrders: true,
      callIn: false,
      counter: false,
    });
    await rejects(
      counter({ orderType: 'delivery', customerName: 'Off', deliveryAddress: 'Ntinda' }),
      /switched off/,
    );
    await rejects(counter({ orderType: 'eat_in' }), /switched off/);
    await run(
      'adminSaveSettings',
      { ...settings, moduleCallIn: true, moduleCounter: true },
      s.owner,
    );
    assert.deepEqual((await run('getMyProfile', {}, s.dina)).config.modules, {
      riderOrders: true,
      callIn: true,
      counter: true,
    });
    await rejects(counter({ orderType: 'eat_in' }, s.pia), /cashier or admin role required/);
    const riders = await run('getAssignableRiders', {}, s.dina);
    assert.ok(riders.some((r) => r.id === s.val.id));
  });

  test('a call-in delivery assigned to a rider pays the rider the delivery fee only', async () => {
    const placed = await counter({
      orderType: 'delivery',
      customerName: 'Caller Carla',
      customerPhone: '0772123999',
      deliveryAddress: 'Naguru',
      deliveryFee: 4000,
      riderId: s.val.id,
      channel: 'phone',
    });
    let order = await fetch(placed.id);
    assert.equal(order.get('source'), 'counter');
    assert.equal(order.get('orderType'), 'delivery');
    assert.equal(order.get('createdBy').id, s.val.id);
    assert.equal(order.get('cashier').id, s.dina.id);
    assert.equal(order.get('cashStatus'), 'NOT_COLLECTED');
    assert.ok(
      await new Parse.Query('Notification')
        .equalTo('recipient', s.val)
        .equalTo('kind', 'order.assigned')
        .first(M),
    );
    assert.ok(await new Parse.Query('Order').equalTo('objectId', placed.id).first(as(s.val)));
    await move(placed.id, ['accept', 'ready']);
    await move(placed.id, ['pickup', 'deliver'], s.val);
    order = await fetch(placed.id);
    assert.equal(order.get('commissionBase'), 0);
    assert.equal(order.get('commissionAmount'), 4000);
    assert.equal(order.get('cashStatus'), 'WITH_RIDER');
    assert.equal(order.get('amountCollected'), placed.total);
    await run('createHandover', { orderIds: [placed.id] }, s.val);
  });

  test('a rider on a break cannot be given a call-in delivery', async () => {
    await run('startShift', { kind: 'rider' }, s.val).catch(() => null);
    await run('setMyAvailability', { available: false }, s.val);
    const listed = (await run('getAssignableRiders', {}, s.dina)).find((r) => r.id === s.val.id);
    assert.equal(listed.onShift && listed.available, false, 'shown as on a break');
    const call = { orderType: 'delivery', customerName: 'Break Ben', deliveryAddress: 'Kyanja' };
    await rejects(counter({ ...call, riderId: s.val.id }), /on a break/);
    const later = await counter(call);
    await rejects(
      run('assignOrderRider', { orderId: later.id, riderId: s.val.id }, s.dina),
      /on a break/,
    );
    await run('setMyAvailability', { available: true }, s.val);
    await run('assignOrderRider', { orderId: later.id, riderId: s.val.id }, s.dina);
    assert.equal((await fetch(later.id)).get('createdBy').id, s.val.id);
    await run('transitionOrder', { orderId: later.id, action: 'cancel', reason: 'test' }, s.dina);
  });

  test('a prepaid call-in delivery waits for the check and for a rider', async () => {
    const placed = await counter({
      orderType: 'delivery',
      customerName: 'Prepaid Pat',
      deliveryAddress: 'Bugolobi',
      paymentMethod: 'mobile_money',
      paymentProvider: 'mtn',
      paymentReference: 'CNT55501',
    });
    let order = await fetch(placed.id);
    assert.equal(order.get('createdBy'), undefined);
    assert.equal(order.get('paymentStatus'), 'PENDING_VERIFICATION');
    await rejects(move(placed.id, ['accept']), /Confirm the mobile money/);
    await run('verifyPayment', { orderId: placed.id, received: true }, s.dina);
    await move(placed.id, ['accept', 'ready']);
    await rejects(move(placed.id, ['pickup']), /Assign a rider/);
    await run('assignOrderRider', { orderId: placed.id, riderId: s.pia.id }, s.dina);
    await rejects(
      run('assignOrderRider', { orderId: placed.id, riderId: s.pia.id }, s.dina),
      /already has/,
    );
    await run('assignOrderRider', { orderId: placed.id, riderId: s.val.id }, s.dina);
    assert.equal(
      await new Parse.Query('Order').equalTo('objectId', placed.id).first(as(s.pia)),
      undefined,
    );
    assert.ok(
      await new Parse.Query('Notification')
        .equalTo('recipient', s.pia)
        .equalTo('kind', 'order.unassigned')
        .first(M),
    );
    await move(placed.id, ['pickup', 'deliver'], s.val);
    order = await fetch(placed.id);
    assert.equal(order.get('cashStatus'), 'NOT_APPLICABLE');
    assert.equal(order.get('commissionAmount'), order.get('deliveryFee'));
    await rejects(
      run('assignOrderRider', { orderId: placed.id, riderId: s.pia.id }, s.dina),
      /left the kitchen/,
    );
  });

  test('eat-in paid in cash goes into the till and is served', async () => {
    const before = await till();
    const placed = await counter({ orderType: 'eat_in', table: 'Table 4' });
    let order = await fetch(placed.id);
    assert.equal(order.get('customerName'), 'Eat-in guest');
    assert.equal(order.get('tableLabel'), 'Table 4');
    assert.equal(order.get('deliveryFee'), 0);
    assert.equal(order.get('cashStatus'), 'IN_TILL');
    assert.equal(order.get('tillCashier').id, s.dina.id);
    const after = await till();
    assert.equal(after.expectedTill - before.expectedTill, placed.total);
    assert.equal(after.counterCash - (before.counterCash || 0), placed.total);
    await rejects(move(placed.id, ['complete']), /Invalid status transition/);
    await move(placed.id, ['accept', 'ready']);
    await rejects(move(placed.id, ['pickup']), /Served \/ Collected/);
    await move(placed.id, ['complete']);
    order = await fetch(placed.id);
    assert.equal(order.get('status'), 'DELIVERED');
    assert.equal(order.get('restaurantStatus'), 'served');
    assert.equal(order.get('commissionAmount'), 0);
    const report = await run('getOperationsReport', {}, s.owner);
    assert.ok(report.summary.cashSales >= placed.total, 'counts as confirmed cash');
  });

  test('pick-up paid later: the bill must be paid before it is collected or the shift ends', async () => {
    const placed = await counter({
      orderType: 'pickup',
      customerName: 'Later Lou',
      payLater: true,
    });
    let order = await fetch(placed.id);
    assert.equal(order.get('billOpen'), true);
    assert.equal(order.get('cashStatus'), 'UNPAID');
    await move(placed.id, ['accept', 'ready']);
    await rejects(move(placed.id, ['complete']), /Take payment/);
    await rejects(
      run('endShift', { shiftId: (await till()).id, physicalCount: 0 }, s.dina),
      /not paid yet/,
    );
    await run(
      'takeCounterPayment',
      {
        orderId: placed.id,
        paymentMethod: 'mobile_money',
        paymentProvider: 'airtel',
        paymentReference: 'CNT77702',
      },
      s.dina,
    );
    await rejects(move(placed.id, ['complete']), /mobile money check/);
    await run(
      'verifyPayment',
      { orderId: placed.id, received: false, reason: 'Not in the account' },
      s.dina,
    );
    order = await fetch(placed.id);
    assert.equal(order.get('billOpen'), true, 'a rejected payment reopens the bill');
    await run('takeCounterPayment', { orderId: placed.id, paymentMethod: 'cash' }, s.dina);
    await rejects(
      run('takeCounterPayment', { orderId: placed.id, paymentMethod: 'cash' }, s.dina),
      /already paid/,
    );
    await move(placed.id, ['complete']);
    order = await fetch(placed.id);
    assert.equal(order.get('restaurantStatus'), 'collected');
  });

  test('cancelling a paid eat-in order takes the cash back out of the till', async () => {
    const before = await till();
    const placed = await counter({ orderType: 'eat_in' });
    await run(
      'transitionOrder',
      { orderId: placed.id, action: 'cancel', reason: 'Guest left' },
      s.dina,
    );
    assert.equal((await fetch(placed.id)).get('cashStatus'), 'REFUNDED');
    assert.equal((await till()).expectedTill, before.expectedTill);
  });

  test('the owner can stop riders from creating their own orders', async () => {
    await run(
      'adminSaveSettings',
      { ...settings, moduleCallIn: true, moduleCounter: true, moduleRiderOrders: false },
      s.owner,
    );
    await rejects(
      run(
        'createOrder',
        { customerName: 'Nope', deliveryAddress: 'Kira', items: [{ id: item.id, quantity: 1 }] },
        s.pia,
      ),
      /counter creates them/,
    );
    await run('adminSaveSettings', settings, s.owner);
  });
});

describe('printed receipts', () => {
  let item;
  let settings;
  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
    ({ settings } = await run('adminListSetup', {}, s.owner));
    await run(
      'adminSaveSettings',
      {
        ...settings,
        moduleCounter: true,
        receiptWidth: 58,
        receiptHeader: 'Plot 12 Kampala Road\nTel 0772 000000',
        receiptFooter: 'Asante!',
        autoPrintKitchen: true,
      },
      s.owner,
    );
  });
  after(async () => run('adminSaveSettings', settings, s.owner));

  test('staff get what to print; riders do not', async () => {
    const profile = await run('getMyProfile', {}, s.dina);
    assert.deepEqual(profile.config.receipt, {
      width: 58,
      header: 'Plot 12 Kampala Road\nTel 0772 000000',
      footer: 'Asante!',
      autoPrintKitchen: true,
    });
    const placed = await run(
      'createCounterOrder',
      {
        orderType: 'eat_in',
        table: 'Table 9',
        items: [{ id: item.id, quantity: 2, notes: 'No onions' }],
      },
      s.dina,
    );
    const receipt = await run('getReceipt', { orderId: placed.id }, s.dina);
    assert.equal(receipt.code, placed.orderCode);
    assert.equal(receipt.width, 58);
    assert.equal(receipt.table, 'Table 9');
    assert.equal(receipt.type, 'eat_in');
    assert.equal(receipt.lines[0].qty, 2);
    assert.equal(receipt.lines[0].notes, 'No onions');
    assert.equal(receipt.total, placed.total);
    assert.equal(receipt.payment.state, 'paid');
    assert.match(receipt.staff, /Dina/);
    await rejects(
      run('getReceipt', { orderId: placed.id }, s.pia),
      /cashier or admin role required/,
    );
    const later = await run(
      'createCounterOrder',
      { orderType: 'pickup', payLater: true, items: [{ id: item.id, quantity: 1 }] },
      s.dina,
    );
    assert.equal((await run('getReceipt', { orderId: later.id }, s.dina)).payment.state, 'unpaid');
    for (const id of [placed.id, later.id])
      await run(
        'transitionOrder',
        { orderId: id, action: 'cancel', reason: 'Receipt test' },
        s.dina,
      );
  });

  test('a split order is one order and one bill, with each split kept apart', async () => {
    const M = { useMasterKey: true };
    const placed = await run(
      'createCounterOrder',
      {
        orderType: 'eat_in',
        table: 'Table 4',
        items: [
          { id: item.id, quantity: 1, notes: 'No onions', split: 'Anna' },
          { id: item.id, quantity: 2, split: 'Ben' },
          { id: item.id, quantity: 1, split: 'Anna' },
        ],
      },
      s.dina,
    );
    const order = await new Parse.Query('Order').get(placed.id, M);
    assert.deepEqual(order.get('splits'), ['Anna', 'Ben']);
    assert.equal(order.get('subtotal'), item.price * 4);
    assert.equal(placed.total, item.price * 4);
    const receipt = await run('getReceipt', { orderId: placed.id }, s.dina);
    assert.deepEqual(receipt.splits, ['Anna', 'Ben']);
    assert.equal(receipt.lines.length, 3);
    assert.deepEqual(receipt.lines.map((line) => line.split).sort(), ['Anna', 'Anna', 'Ben']);
    const owner = await run('adminGetOrder', { id: placed.id }, s.owner);
    assert.deepEqual(owner.splits, ['Anna', 'Ben']);
    assert.equal(owner.items.find((line) => line.split === 'Ben').qty, 2);
    // Every line needs a split once any has one; one split is a plain order.
    await rejects(
      run(
        'createCounterOrder',
        {
          orderType: 'eat_in',
          items: [
            { id: item.id, quantity: 1, split: 'Anna' },
            { id: item.id, quantity: 1, notes: 'Extra hot' },
          ],
        },
        s.dina,
      ),
      /Put every item in a split/,
    );
    const single = await run(
      'createCounterOrder',
      { orderType: 'eat_in', items: [{ id: item.id, quantity: 1, split: 'Anna' }] },
      s.dina,
    );
    assert.equal((await new Parse.Query('Order').get(single.id, M)).get('splits'), undefined);
    const plain = await run('getReceipt', { orderId: single.id }, s.dina);
    assert.deepEqual(plain.splits, []);
    assert.equal(plain.lines[0].split, '');
    for (const id of [placed.id, single.id])
      await run('transitionOrder', { orderId: id, action: 'cancel', reason: 'Split test' }, s.dina);
  });
});

describe('reports agree across order sources', () => {
  let item;
  let settings;
  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
    ({ settings } = await run('adminListSetup', {}, s.owner));
    await run(
      'adminSaveSettings',
      { ...settings, moduleCallIn: true, moduleCounter: true },
      s.owner,
    );
  });
  after(async () => run('adminSaveSettings', settings, s.owner));

  test('overview, Z-report, reports and ledgers count counter orders the same way', async () => {
    const lines = [{ id: item.id, quantity: 1 }];
    // An eat-in paid in cash, a pick-up paid later in cash, both served.
    const eatIn = await run('createCounterOrder', { orderType: 'eat_in', items: lines }, s.dina);
    const pickup = await run(
      'createCounterOrder',
      { orderType: 'pickup', payLater: true, items: lines },
      s.dina,
    );
    await run('takeCounterPayment', { orderId: pickup.id, paymentMethod: 'cash' }, s.dina);
    for (const id of [eatIn.id, pickup.id])
      for (const action of ['accept', 'ready', 'complete'])
        await run('transitionOrder', { orderId: id, action }, s.dina);

    const today = (await run('getDashboard', {}, s.owner)).today;
    const z = (await run('adminGetZReport', {}, s.owner)).report;
    assert.equal(today.sales, z.sales.total, 'overview and Z-report sales agree');
    assert.equal(today.kept, z.sales.kept);
    assert.equal(today.cashReceived, today.riderCash + today.counterCash);
    assert.equal(z.till.cashReceived, z.till.riderCash + z.till.counterCash);
    assert.ok(today.counterCash >= eatIn.total + pickup.total);
    const eatInKind = today.byType.find((k) => k.key === 'eat_in');
    assert.ok(eatInKind.orders >= 1);
    assert.equal(z.sales.total, z.sales.riderOrders + z.sales.counterOrders);

    const report = await run('getOperationsReport', {}, s.owner);
    assert.equal(report.summary.revenue, report.summary.riderSales + report.summary.counterSales);
    assert.ok(!report.riders.some((r) => !r.riderId), 'no rider-less rows in the rider table');

    const commission = await run('getCommissionLedger', {}, s.owner);
    assert.ok(
      commission.rows.every((r) => r.riderId),
      'rider pay is for rider deliveries only',
    );
    assert.ok(!commission.rows.some((r) => [eatIn.id, pickup.id].includes(r.id)));

    const ledger = await run('getPaymentsLedger', { method: 'cash' }, s.owner);
    const rows = ledger.transactions.filter((r) => [eatIn.id, pickup.id].includes(r.id));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'IN_TILL' && /^Counter · /.test(r.rider)));
    const c = ledger.summary.cash;
    assert.equal(c.collected, c.withRiders + c.handoverPending + c.reconciled + c.inTill);
  });
});

describe('card payments at the counter', () => {
  const M = { useMasterKey: true };
  let item;
  let settings;
  const made = [];
  const counter = async (params, user = s.dina) => {
    const placed = await run(
      'createCounterOrder',
      { items: [{ id: item.id, quantity: 1 }], ...params },
      user,
    );
    made.push(placed.id);
    return placed;
  };
  const fetch = (id) => new Parse.Query('Order').get(id, M);

  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
    ({ settings } = await run('adminListSetup', {}, s.owner));
    await run(
      'adminSaveSettings',
      { ...settings, moduleCallIn: true, moduleCounter: true, cardEnabled: false },
      s.owner,
    );
  });
  after(async () => {
    for (const id of made) {
      const order = await fetch(id);
      if (!['DELIVERED', 'CANCELLED'].includes(order.get('status')))
        await run(
          'transitionOrder',
          { orderId: id, action: 'cancel', reason: 'Card test' },
          s.dina,
        );
    }
    await run('adminSaveSettings', settings, s.owner);
  });

  test('card is refused until the owner switches it on', async () => {
    assert.equal((await run('getMyProfile', {}, s.dina)).config.card, null);
    await rejects(
      counter({ orderType: 'eat_in', paymentMethod: 'card', paymentReference: 'RRN1234' }),
      /Card payments are not set up/,
    );
    await run(
      'adminSaveSettings',
      {
        ...settings,
        moduleCallIn: true,
        moduleCounter: true,
        cardEnabled: true,
        cardLabel: 'Stanbic card machine',
        cardTerminalId: ' 40012345 ',
      },
      s.owner,
    );
    assert.deepEqual((await run('getMyProfile', {}, s.dina)).config.card, {
      provider: 'card',
      label: 'Stanbic card machine',
      code: '40012345',
      name: '',
    });
  });

  test('riders and deliveries cannot pay by card', async () => {
    await rejects(
      run(
        'createOrder',
        {
          customerName: 'Card Carl',
          deliveryAddress: 'Kololo',
          paymentMethod: 'card',
          paymentReference: 'RRN1234',
          items: [{ id: item.id, quantity: 1 }],
        },
        s.pia,
      ),
      /Card is taken at the counter only/,
    );
    await rejects(
      counter({
        orderType: 'delivery',
        customerName: 'Card Carl',
        deliveryAddress: 'Kololo',
        paymentMethod: 'card',
        paymentReference: 'RRN1234',
      }),
      /eat-in and pick-up orders only/,
    );
  });

  test('a card payment waits for a cashier to check its transaction ID', async () => {
    await rejects(
      counter({ orderType: 'eat_in', paymentMethod: 'card' }),
      /transaction ID from the card machine slip/,
    );
    const placed = await counter({
      orderType: 'eat_in',
      paymentMethod: 'card',
      paymentReference: 'rrn 5566 7788',
    });
    let order = await fetch(placed.id);
    assert.equal(order.get('paymentMethod'), 'card');
    assert.equal(order.get('paymentProvider'), 'card');
    assert.equal(order.get('paymentReference'), 'RRN55667788');
    assert.equal(order.get('paymentStatus'), 'PENDING_VERIFICATION');
    assert.equal(order.get('cashStatus'), 'NOT_APPLICABLE');
    assert.equal(
      (await run('getReceipt', { orderId: placed.id }, s.dina)).payment.state,
      'checking',
    );
    await rejects(
      counter({ orderType: 'pickup', paymentMethod: 'card', paymentReference: 'RRN55667788' }),
      /already used on/,
    );

    const ledger = await run('getMobileMoneyLedger', {}, s.dina);
    assert.ok(ledger.pending.some((r) => r.id === placed.id && r.provider === 'card'));
    assert.ok(ledger.totals.some((t) => t.provider === 'card' && t.code === '40012345'));

    await run('verifyPayment', { orderId: placed.id, received: true }, s.dina);
    order = await fetch(placed.id);
    assert.equal(order.get('paymentStatus'), 'VERIFIED');
    assert.equal((await run('getReceipt', { orderId: placed.id }, s.dina)).payment.state, 'paid');
    for (const action of ['accept', 'ready', 'complete'])
      await run('transitionOrder', { orderId: placed.id, action }, s.dina);

    const payments = await run('getPaymentsLedger', { method: 'card' }, s.owner);
    const row = payments.transactions.find((t) => t.id === placed.id);
    assert.equal(row.kind, 'card');
    assert.equal(row.status, 'VERIFIED');
    assert.ok(payments.summary.card.verified >= placed.total);
    assert.ok(payments.transactions.every((t) => t.kind === 'card'));
    const z = (await run('adminGetZReport', {}, s.owner)).report;
    assert.ok(z.payments.cardVerified >= placed.total);
  });

  test('an open bill paid by card; a slip that does not check out opens it again', async () => {
    const later = await counter({ orderType: 'pickup', payLater: true });
    await rejects(
      run('takeCounterPayment', { orderId: later.id, paymentMethod: 'card' }, s.dina),
      /transaction ID/,
    );
    await run(
      'takeCounterPayment',
      { orderId: later.id, paymentMethod: 'card', paymentReference: 'APP99881' },
      s.dina,
    );
    let order = await fetch(later.id);
    assert.equal(order.get('billOpen'), false);
    assert.equal(order.get('paymentMethod'), 'card');
    assert.equal(order.get('paymentStatus'), 'PENDING_VERIFICATION');
    await run(
      'verifyPayment',
      { orderId: later.id, received: false, reason: 'Not on the machine report' },
      s.dina,
    );
    order = await fetch(later.id);
    assert.equal(order.get('paymentStatus'), 'REJECTED');
    assert.equal(order.get('billOpen'), true);
    await rejects(
      run('resubmitPayment', { orderId: later.id, reference: 'APP99882' }, s.pia),
      /Not allowed/,
    );
    await run('resubmitPayment', { orderId: later.id, reference: 'APP99882' }, s.dina);
    order = await fetch(later.id);
    assert.equal(order.get('paymentReference'), 'APP99882');
    assert.equal(order.get('paymentStatus'), 'PENDING_VERIFICATION');
  });
});

describe('branches', () => {
  const M = { useMasterKey: true };
  let settings;
  let items;
  let main;
  let ntinda;
  let nia;
  let nora;
  const made = [];
  const line = (item) => [{ id: item.id, quantity: 1 }];
  const counter = async (params, user) => {
    const placed = await run('createCounterOrder', params, user);
    made.push([placed.id, user]);
    return placed;
  };
  const fetch = (id) => new Parse.Query('Order').get(id, M);

  before(async () => {
    ({ settings } = await run('adminListSetup', {}, s.owner));
    await run(
      'adminSaveSettings',
      { ...settings, moduleCallIn: true, moduleCounter: true },
      s.owner,
    );
    items = (await run('getOperationalMenu', {}, s.dina)).items.filter(
      (i) => !i.accompanimentGroups.length,
    );
  });
  after(async () => {
    for (const [id, user] of made) {
      const order = await fetch(id);
      if (!['DELIVERED', 'CANCELLED'].includes(order.get('status')))
        await run(
          'transitionOrder',
          { orderId: id, action: 'cancel', reason: 'Branch test' },
          user,
        );
    }
    for (const item of items.slice(0, 2))
      await run('adminSaveMenuItem', { ...(await menuItem(item.id)), branchIds: [] }, s.owner);
    await run('adminSaveSettings', settings, s.owner);
  });
  const menuItem = async (id) => {
    const row = (await run('adminListSetup', {}, s.owner)).menu.find((m) => m.id === id);
    return {
      id: row.id,
      title: row.title,
      price: row.price,
      category: row.category,
      active: row.active,
      availableToday: row.availableToday,
    };
  };

  test("the owner's first branch list makes the main branch and puts everything in it", async () => {
    const before = await new Parse.Query('Order').descending('createdAt').first(M);
    assert.equal(before.get('branch'), undefined);
    assert.equal((await run('getMyProfile', {}, s.owner)).branchCount, 0);
    // Team → Create asks for the branches before Branches was ever opened.
    const first = await run('getBranches', {}, s.owner);
    assert.equal(first.branches.length, 1);
    assert.equal(first.branches[0].main, true);
    const { branches } = await run('adminListBranches', {}, s.owner);
    assert.equal(branches.length, 1);
    main = branches[0];
    assert.equal(main.main, true);
    assert.equal(main.name, 'Main branch');
    assert.equal((await fetch(before.id)).get('branch').id, main.id);
    const dina = await new Parse.Query(Parse.User).get(s.dina.id, M);
    assert.equal(dina.get('branch').id, main.id);
    assert.equal((await run('getMyProfile', {}, s.dina)).branch.name, 'Main branch');
    await rejects(run('adminListBranches', {}, s.dina), /admin role required/);
  });

  test('the owner adds a branch and staff work there', async () => {
    ntinda = await run(
      'adminSaveBranch',
      { name: 'Ntinda', address: 'Ntinda shopping centre', phone: '0772000222' },
      s.owner,
    );
    await rejects(run('adminSaveBranch', { name: 'ntinda' }, s.owner), /already a branch/);
    await rejects(
      run('adminSaveBranch', { id: main.id, name: main.name, active: false }, s.owner),
      /main branch cannot be closed/,
    );
    assert.equal((await run('getMyProfile', {}, s.owner)).branchCount, 2);
    const cashier = await run(
      'adminCreateTeamMember',
      {
        name: 'Nia Ntinda',
        username: 'nia-ntinda',
        pin: '4455',
        role: 'cashier',
        branchId: ntinda.id,
      },
      s.owner,
    );
    const rider = await run(
      'adminCreateTeamMember',
      {
        name: 'Nora Ntinda',
        username: 'nora-ntinda',
        pin: '5566',
        role: 'rider',
        branchId: ntinda.id,
      },
      s.owner,
    );
    nia = await login('nia-ntinda', '4455');
    nora = await login('nora-ntinda', '5566');
    assert.equal((await run('getMyProfile', {}, nia)).branch.id, ntinda.id);
    await run('startShift', { kind: 'cashier', openingFloat: 0 }, nia);
    const riders = await run('getAssignableRiders', {}, nia);
    assert.deepEqual(
      riders.map((r) => r.id),
      [rider.id],
      'a cashier sends only their branch riders',
    );
    assert.ok((await run('getAssignableRiders', {}, s.owner)).length > 1);
    // A branch with people working at it cannot be closed.
    await rejects(
      run('adminSaveBranch', { id: ntinda.id, name: 'Ntinda', active: false }, s.owner),
      /Move its 2 team member/,
    );
    const listed = (await run('adminListBranches', {}, s.owner)).branches.find(
      (b) => b.id === ntinda.id,
    );
    assert.deepEqual(listed.members, { riders: 1, cashiers: 1 });
    // A member can be moved; a rider's orders go to their branch.
    const { team } = await run('adminListSetup', {}, s.owner);
    assert.equal(team.find((m) => m.id === cashier.id).branchId, ntinda.id);
    await rejects(
      run('adminUpdateMember', { id: cashier.id, branchId: 'nope' }, s.owner),
      /Unknown branch/,
    );
    await run('startShift', { kind: 'rider' }, nora);
    const placed = await run(
      'createOrder',
      {
        customerName: 'Branch Beth',
        deliveryAddress: 'Ntinda',
        paymentMethod: 'cash',
        items: line(items[0]),
      },
      nora,
    );
    made.push([placed.id, nora]);
    assert.equal((await fetch(placed.id)).get('branch').id, ntinda.id);
  });

  test('dishes are offered per branch and sold out per branch', async () => {
    const [onlyMain, both] = items;
    await run(
      'adminSaveMenuItem',
      { ...(await menuItem(onlyMain.id)), branchIds: [main.id] },
      s.owner,
    );
    const ntindaMenu = (await run('getOperationalMenu', {}, nia)).items.map((i) => i.id);
    assert.ok(!ntindaMenu.includes(onlyMain.id), 'not offered at Ntinda');
    assert.ok(
      (await run('getOperationalMenu', {}, s.dina)).items.some((i) => i.id === onlyMain.id),
    );
    await rejects(counter({ orderType: 'eat_in', items: line(onlyMain) }, nia), /is not available/);
    // Sold out at Ntinda only.
    await run('setAvailability', { type: 'menuItem', id: both.id, available: false }, nia);
    assert.ok(!(await run('getOperationalMenu', {}, nia)).items.some((i) => i.id === both.id));
    assert.ok((await run('getOperationalMenu', {}, s.dina)).items.some((i) => i.id === both.id));
    const stock = await run('getStock', { branchId: ntinda.id }, s.owner);
    assert.equal(stock.branch.name, 'Ntinda');
    assert.equal(stock.items.find((i) => i.id === both.id).available, false);
    assert.ok(!stock.items.some((i) => i.id === onlyMain.id), 'Ntinda does not list it');
    const mainStock = await run('getStock', {}, s.dina);
    assert.equal(mainStock.items.find((i) => i.id === both.id).available, true);
    await run('setAvailability', { type: 'menuItem', id: both.id, available: true }, nia);
    assert.ok((await run('getOperationalMenu', {}, nia)).items.some((i) => i.id === both.id));
  });

  test('orders, payments and reports split by branch', async () => {
    const [, dish] = items;
    const here = await counter({ orderType: 'eat_in', items: line(dish) }, nia);
    const there = await counter({ orderType: 'eat_in', items: line(dish) }, s.dina);
    assert.equal((await fetch(here.id)).get('branch').id, ntinda.id);
    assert.equal((await fetch(there.id)).get('branch').id, main.id);
    for (const [order, user] of [
      [here, nia],
      [there, s.dina],
    ])
      for (const action of ['accept', 'ready', 'complete'])
        await run('transitionOrder', { orderId: order.id, action }, user);

    const found = await run('adminSearchOrders', { branchId: ntinda.id }, s.owner);
    assert.ok(found.rows.some((r) => r.id === here.id));
    assert.ok(!found.rows.some((r) => r.id === there.id));
    const report = await run('getOperationsReport', { branchId: ntinda.id }, s.owner);
    const all = await run('getOperationsReport', {}, s.owner);
    assert.ok(report.summary.orders < all.summary.orders);
    assert.ok(all.branches.some((b) => b.name === 'Ntinda' && b.delivered >= 1));
    assert.ok(all.branches.some((b) => b.name === 'Main branch'));
    const today = await run('getDashboard', { branchId: ntinda.id }, s.owner);
    assert.ok(today.today.orders >= 1);
    assert.ok(today.today.orders < (await run('getDashboard', {}, s.owner)).today.orders);
    const z = await run('adminGetZReport', { branchId: ntinda.id }, s.owner);
    assert.equal(z.branchId, ntinda.id);
    assert.equal(z.live, true);
    // The Ntinda cashier's payments ledger is their branch's only.
    const ledger = await run('getPaymentsLedger', { method: 'cash' }, nia);
    assert.ok(ledger.transactions.some((t) => t.id === here.id));
    assert.ok(!ledger.transactions.some((t) => t.id === there.id));
    const shifts = await run('getShiftReport', { branchId: ntinda.id }, s.owner);
    assert.ok(shifts.shifts.every((row) => /Nia/.test(row.cashier)));
    await rejects(run('getDashboard', { branchId: 'bogus!' }, s.owner), /Unknown branch/);
  });
});

describe('purchases, expenses, suppliers and customers', () => {
  let supplier;
  let fiona;
  before(async () => {
    await run(
      'adminCreateTeamMember',
      { name: 'Farida Finance', username: 'farida', pin: '9753', role: 'finance' },
      s.owner,
    );
    fiona = await login('farida', '9753');
  });

  test('suppliers: finance adds and edits them; others cannot', async () => {
    supplier = await run(
      'saveSupplier',
      { name: 'Owino Market Traders', phone: '0772111222', tin: '1000123456' },
      fiona,
    );
    assert.equal(supplier.owed, 0);
    await rejects(
      run('saveSupplier', { name: 'owino market traders' }, s.owner),
      /already a supplier/,
    );
    await rejects(run('saveSupplier', { name: 'Nope' }, s.dina), /admin or finance role required/);
    const edited = await run(
      'saveSupplier',
      { id: supplier.id, name: 'Owino Market Traders', phone: '0772111333' },
      s.owner,
    );
    assert.equal(edited.phone, '0772111333');
  });

  test('a purchase on credit is owed until it is paid', async () => {
    await rejects(
      run('recordPurchase', { supplierId: supplier.id, lines: [] }, fiona),
      /at least one line/,
    );
    const bought = await run(
      'recordPurchase',
      {
        supplierId: supplier.id,
        category: 'food',
        lines: [
          { description: 'Tomatoes', quantity: 2, unit: 'crate', unitCost: 45000 },
          { description: 'Onions', quantity: 10, unit: 'kg', unitCost: 3500 },
        ],
        paid: 50000,
        method: 'cash',
        invoice: 'INV-77',
      },
      fiona,
    );
    assert.equal(bought.total, 125000);
    assert.equal(bought.paid, 50000);
    assert.equal(bought.owed, 75000);
    assert.equal(bought.status, 'partial');
    assert.match(bought.code, /^PU-\d{8}-\d{3}$/);
    await rejects(
      run(
        'recordPurchase',
        {
          supplierId: supplier.id,
          lines: [{ description: 'X', quantity: 1, unitCost: 10 }],
          paid: 20,
        },
        fiona,
      ),
      /Paid more than the total/,
    );
    const owed = (await run('listSuppliers', {}, s.owner)).suppliers.find(
      (x) => x.id === supplier.id,
    );
    assert.equal(owed.owed, 75000);
    await rejects(
      run('payPurchase', { purchaseId: bought.id, amount: 80000, method: 'bank' }, fiona),
      /more than is owed/,
    );
    const paid = await run(
      'payPurchase',
      { purchaseId: bought.id, amount: 75000, method: 'mobile_money' },
      s.owner,
    );
    assert.equal(paid.status, 'paid');
    assert.equal(paid.payments.length, 2);
    const list = await run('listPurchases', {}, fiona);
    assert.ok(list.purchases.some((row) => row.id === bought.id));
    assert.ok(list.summary.total >= 125000);
    assert.equal(
      (await run('listPurchases', { status: 'owed' }, fiona)).purchases.some(
        (r) => r.id === bought.id,
      ),
      false,
    );
    // Voided: it leaves the totals but stays listed.
    const mistake = await run(
      'recordPurchase',
      { supplierId: supplier.id, lines: [{ description: 'Oops', quantity: 1, unitCost: 1000 }] },
      fiona,
    );
    await rejects(run('voidPurchase', { id: mistake.id, reason: '' }, fiona), /Say why/);
    const voided = await run('voidPurchase', { id: mistake.id, reason: 'Entered twice' }, fiona);
    assert.equal(voided.status, 'void');
    assert.equal(voided.owed, 0);
    await rejects(run('listPurchases', {}, s.dina), /admin or finance role required/);
  });

  test('expenses are recorded by kind and can be voided', async () => {
    await rejects(
      run('recordExpense', { category: 'nonsense', description: 'x', amount: 1 }, fiona),
      /kind of expense/,
    );
    await rejects(
      run('recordExpense', { category: 'rent', description: 'Rent', amount: 0 }, fiona),
      /Enter the amount/,
    );
    await rejects(
      run(
        'recordExpense',
        { category: 'rent', description: 'Rent', amount: 5, day: '2099-01-01' },
        fiona,
      ),
      /up to today/,
    );
    const rent = await run(
      'recordExpense',
      {
        category: 'rent',
        description: 'October rent',
        amount: 1500000,
        method: 'bank',
        payee: 'Landlord',
      },
      fiona,
    );
    const power = await run(
      'recordExpense',
      { category: 'utilities', description: 'Yaka', amount: 200000, method: 'mobile_money' },
      s.owner,
    );
    let list = await run('listExpenses', {}, fiona);
    assert.ok(list.summary.total >= 1700000);
    assert.equal(list.summary.byCategory[0].category, 'rent');
    await run('voidExpense', { id: power.id, reason: 'Wrong amount' }, fiona);
    list = await run('listExpenses', { category: 'utilities' }, fiona);
    assert.equal(list.expenses.find((e) => e.id === power.id).status, 'void');
    assert.equal(list.summary.total, 0);
    assert.match(rent.code, /^EX-/);
    await rejects(run('recordExpense', {}, s.rider), /admin or finance role required/);
  });

  test('customers: listed, opened and corrected', async () => {
    const { customers, total } = await run('listCustomers', { sort: 'orders' }, fiona);
    assert.ok(total >= 1);
    const first = customers[0];
    const detail = await run('getCustomer', { id: first.id }, fiona);
    assert.equal(detail.id, first.id);
    assert.ok(Array.isArray(detail.orders));
    const saved = await run(
      'saveCustomer',
      { id: first.id, name: first.name, phone: first.phone, notes: 'No onions, ever' },
      s.owner,
    );
    assert.equal(saved.notes, 'No onions, ever');
    const found = await run('listCustomers', { q: first.name.slice(0, 4) }, fiona);
    assert.ok(found.customers.some((c) => c.id === first.id));
    const other = customers.find((c) => c.phone && c.phone !== first.phone);
    if (other && first.phone)
      await rejects(run('saveCustomer', { id: other.id, phone: first.phone }, fiona), /already/);
    await rejects(run('listCustomers', {}, s.dina), /admin or finance role required/);
  });
});

describe('accounting statements', () => {
  let farida;
  before(async () => {
    farida = await login('farida', '9753');
  });
  const statements = async () => ({
    pl: (await run('getProfitAndLoss', { preset: 'today' }, farida)).current,
    sheet: (await run('getBalanceSheet', {}, farida)).sheet,
    flow: await run('getCashFlow', {}, farida),
  });

  test('the statements agree with each other', async () => {
    const { pl, sheet, flow } = await statements();
    assert.equal(pl.grossProfit, pl.revenue.total - pl.costOfSales.total);
    assert.equal(pl.netProfit, pl.grossProfit - pl.operating.total);
    assert.equal(sheet.equity.total, sheet.assets.total - sheet.liabilities.total);
    assert.equal(
      sheet.equity.opening + sheet.equity.profit + sheet.equity.other,
      sheet.equity.total,
    );
    assert.equal(flow.closing, flow.opening + flow.net);
    // The cash flow ends where the balance sheet's cash is.
    assert.equal(flow.closing, sheet.assets.cash);
  });

  test('a purchase on credit, then paid: cost, liability and cash move together', async () => {
    const before = await statements();
    const supplier = (await run('listSuppliers', {}, farida)).suppliers[0];
    const bought = await run(
      'recordPurchase',
      {
        supplierId: supplier.id,
        category: 'drinks',
        lines: [{ description: 'Soda crates', quantity: 4, unitCost: 25000 }],
        paid: 0,
      },
      farida,
    );
    let after = await statements();
    assert.equal(after.pl.costOfSales.total - before.pl.costOfSales.total, 100000);
    assert.equal(after.sheet.liabilities.suppliers - before.sheet.liabilities.suppliers, 100000);
    assert.equal(after.sheet.assets.cash, before.sheet.assets.cash, 'nothing paid yet');
    await run('payPurchase', { purchaseId: bought.id, amount: 100000, method: 'cash' }, farida);
    after = await statements();
    assert.equal(after.sheet.liabilities.suppliers, before.sheet.liabilities.suppliers);
    assert.equal(before.sheet.assets.cash - after.sheet.assets.cash, 100000);
    assert.equal(before.flow.closing - after.flow.closing, 100000);
    const expense = await run(
      'recordExpense',
      { category: 'marketing', description: 'Flyers', amount: 30000, method: 'cash' },
      farida,
    );
    const withExpense = await statements();
    assert.equal(withExpense.pl.operating.total - after.pl.operating.total, 30000);
    assert.equal(withExpense.pl.netProfit, after.pl.netProfit - 30000);
    await run('voidExpense', { id: expense.id, reason: 'Test' }, farida);
    assert.equal((await statements()).pl.netProfit, after.pl.netProfit);
  });

  test('the opening balance adds to cash and equity', async () => {
    const before = (await run('getBalanceSheet', {}, farida)).sheet;
    await rejects(run('saveOpeningBalance', { amount: -5 }, farida), /opening cash/);
    await run('saveOpeningBalance', { amount: 1000000 }, s.owner);
    const after = (await run('getBalanceSheet', {}, farida)).sheet;
    assert.equal(after.assets.cash - before.assets.cash, 1000000 - before.equity.opening);
    assert.equal(after.equity.opening, 1000000);
    await rejects(run('getBalanceSheet', { day: '2099-01-01' }, farida), /up to today/);
    await rejects(run('getProfitAndLoss', {}, s.dina), /admin or finance role required/);
  });

  test('tax receipts list the sales for EFRIS follow-up', async () => {
    const list = await run('listEfrisReceipts', {}, farida);
    assert.equal(typeof list.enabled, 'boolean');
    assert.ok(list.rows.every((row) => ['issued', 'failed', 'pending'].includes(row.status)));
    await rejects(run('listEfrisReceipts', {}, s.dina), /admin or finance role required/);
  });
});

describe('WhatsApp daily summaries', () => {
  const M = { useMasterKey: true };

  test('the owner connects WhatsApp and tests it', async () => {
    assert.equal((await run('adminGetWhatsAppSettings', {}, s.owner)).tokenSet, false);
    await rejects(
      run('adminSaveWhatsAppSettings', { enabled: true, recipients: ['0772 000111'] }, s.owner),
      /phone number ID, the access token/,
    );
    await rejects(
      run('adminSaveWhatsAppSettings', { recipients: ['hello'] }, s.owner),
      /not a phone number/,
    );
    const saved = await run(
      'adminSaveWhatsAppSettings',
      {
        enabled: true,
        phoneNumberId: '1098765',
        token: 'wa-token',
        templateName: 'Daily Summary',
        recipients: ['0772 000111', '+256 701 222333'],
      },
      s.owner,
    );
    assert.equal(saved.tokenSet, true);
    assert.equal(saved.templateName, 'dailysummary');
    assert.deepEqual(saved.recipients, ['256772000111', '256701222333']);
    assert.equal(JSON.stringify(saved).includes('wa-token'), false, 'the token is never sent back');
    whatsapp.messages.length = 0;
    const result = await run('adminTestWhatsApp', {}, s.owner);
    assert.equal(result.sent, 2);
    const [first] = whatsapp.messages;
    assert.equal(first.phoneId, '1098765');
    assert.equal(first.type, 'template');
    assert.equal(first.template.name, 'dailysummary');
    const line = first.template.components[0].parameters[0].text;
    assert.match(line, /Orders: \d+ delivered/);
    assert.ok(!line.includes('\n'), 'template values have no line breaks');
    await rejects(run('adminGetWhatsAppSettings', {}, s.dina), /admin role required/);
  });

  test('the nightly Z-report goes out once, as text without a template', async () => {
    await run(
      'adminSaveWhatsAppSettings',
      { enabled: true, templateName: '', recipients: ['0772000111', '0701222333'] },
      s.owner,
    );
    const { settings } = await run('adminListSetup', {}, s.owner);
    await run('adminSaveSettings', { ...settings, zReportHour: 0 }, s.owner);
    // Today's Z-report was saved by an earlier test; let the job make it again.
    await Parse.Object.destroyAll(await new Parse.Query('ZReport').find(M), M);
    whatsapp.messages.length = 0;
    whatsapp.refuse = '256701222333';
    const runJob = async () => {
      const jobId = await Parse.Cloud.startJob('dailyZReport', {});
      for (let i = 0; i < 50; i += 1) {
        const status = await new Parse.Query('_JobStatus').get(jobId, M);
        if (['succeeded', 'failed'].includes(status.get('status'))) return status;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    };
    try {
      assert.equal((await runJob()).get('status'), 'succeeded');
      assert.equal(whatsapp.messages.length, 1, 'one number took it, the other was refused');
      const [message] = whatsapp.messages;
      assert.equal(message.type, 'text');
      assert.equal(message.to, '256772000111');
      assert.match(message.text.body, /Z-report \d{4}-\d{2}-\d{2}\nOrders:/);
      const status = await run('adminGetWhatsAppSettings', {}, s.owner);
      assert.equal(status.lastResult.sent, 1);
      assert.equal(status.lastResult.failed, 1);
      assert.match(status.lastResult.error, /Recipient not on WhatsApp/);
      // Once a day: the saved Z-report is not sent again.
      await runJob();
      assert.equal(whatsapp.messages.length, 1);
    } finally {
      whatsapp.refuse = '';
      await run('adminSaveWhatsAppSettings', { enabled: false, recipients: [] }, s.owner);
      await run('adminSaveSettings', settings, s.owner);
    }
  });
});

describe('getting started: setup progress and menu import', () => {
  test('setup progress counts the restaurant own dishes and team', async () => {
    const progress = await run('getSetupProgress', {}, s.owner);
    assert.equal(progress.steps.riders, progress.riders > 0);
    assert.equal(progress.steps.cashiers, progress.cashiers > 0);
    assert.ok(progress.riders >= 1 && progress.cashiers >= 1);
    assert.equal(typeof progress.complete, 'boolean');
    // Orders already exist: a set-up restaurant is not asked to get started.
    if (progress.complete) assert.equal(progress.finished, true);
    await rejects(run('getSetupProgress', {}, s.dina), /admin role required/);
  });

  test('a menu import is checked first and saves nothing when a row is wrong', async () => {
    const rows = [
      { title: 'Import Pilau', price: '14,000', category: 'Import Mains', prepMinutes: '25' },
      { title: 'Import Chai', price: 2500, category: 'import drinks', description: 'Spiced' },
      { title: 'Import Chai', price: 3000 },
      { title: 'Import Broken', price: 'n/a' },
    ];
    const dry = await run('adminImportMenu', { rows, dryRun: true }, s.owner);
    assert.deepEqual(
      dry.errors.map((e) => e.row),
      [4, 5],
    );
    await rejects(run('adminImportMenu', { rows }, s.owner), /Row 4: .*already on row 3.*1 more/);
    const { menu } = await run('adminListSetup', {}, s.owner);
    assert.ok(!menu.some((item) => item.title.startsWith('Import ')), 'nothing was saved');
  });

  test('a clean import adds dishes and categories; existing dishes are skipped or updated', async () => {
    const rows = [
      { title: 'Import Pilau', price: '14,000', category: 'Import Mains', prepMinutes: '25' },
      { title: 'Import Chai', price: 2500, category: 'Import Drinks', description: 'Spiced' },
    ];
    const first = await run('adminImportMenu', { rows }, s.owner);
    assert.equal(first.created, 2);
    // No categories were set up yet: the ones existing dishes use are created too.
    for (const title of ['Import Drinks', 'Import Mains', 'Mains'])
      assert.ok(first.categoriesCreated.includes(title), title);
    let setup = await run('adminListSetup', {}, s.owner);
    const pilau = setup.menu.find((item) => item.title === 'Import Pilau');
    assert.equal(pilau.price, 14000);
    assert.equal(pilau.prepMinutes, 25);
    assert.ok(setup.categories.some((c) => c.title === 'Import Mains'));
    // Same file again: skipped. With updateExisting: new prices, and a
    // category typed in another case lands in the existing one.
    const again = await run('adminImportMenu', { rows }, s.owner);
    assert.deepEqual([again.created, again.skipped], [0, 2]);
    const update = await run(
      'adminImportMenu',
      {
        rows: [{ title: 'import pilau', price: 15000, category: 'IMPORT MAINS' }],
        updateExisting: true,
      },
      s.owner,
    );
    assert.deepEqual([update.created, update.updated, update.categoriesCreated], [0, 1, []]);
    setup = await run('adminListSetup', {}, s.owner);
    const updated = setup.menu.find((item) => item.title === 'Import Pilau');
    assert.equal(updated.price, 15000);
    assert.equal(updated.category, 'Import Mains');
    // The imported dishes can be ordered.
    const menu = await run('getOperationalMenu', {}, s.pia);
    assert.ok(menu.items.some((item) => item.title === 'Import Chai'));
    const log = await run('adminGetAuditLog', { group: 'menu' }, s.owner);
    assert.ok(log.rows.some((row) => row.action === 'menu.imported'));
    await rejects(run('adminImportMenu', { rows }, s.pia), /admin role required/);
  });

  test('the owner marks setup finished and can reopen it', async () => {
    assert.equal((await run('adminFinishSetup', {}, s.owner)).finished, true);
    assert.equal((await run('getSetupProgress', {}, s.owner)).finished, true);
    await run('adminFinishSetup', { done: false }, s.owner);
    assert.equal((await run('getSetupProgress', {}, s.owner)).finished, false);
  });
});

describe('error reporting', () => {
  test('app crash reports are grouped, listed for the owner only and can be marked fixed', async () => {
    const report = {
      message: 'TypeError: order.items is undefined (id 8f3a9c21d0)',
      where: 'RiderWorkspace',
      stack: 'at RiderWorkspace (index.js:1:2)',
      url: 'https://relay.example/rider',
      appVersion: 'test',
    };
    assert.equal((await run('reportClientError', report, s.pia)).recorded, true);
    // The same bug with another id is the same entry, counted twice.
    await run(
      'reportClientError',
      { ...report, message: report.message.replace('8f3a9c21d0', 'aa11bb22cc33') },
      s.dina,
    );
    // Signed out (the sign-in screen) may report too.
    await run('reportClientError', {
      message: 'Sign-in screen crashed',
      where: 'AuthScreen',
      restaurant: CODE,
    });
    await rejects(run('reportClientError', { message: '' }), /Nothing to report/);

    const list = await run('adminListErrors', {}, s.owner);
    const entry = list.rows.find((row) => row.where === 'RiderWorkspace');
    assert.equal(entry.count, 2);
    assert.equal(entry.source, 'app');
    assert.ok(['rider', 'cashier'].includes(entry.role));
    assert.ok(list.rows.some((row) => row.role === 'signed out'));
    assert.equal((await run('adminListErrors', { countOnly: true }, s.owner)).open, list.open);
    await rejects(run('adminListErrors', {}, s.dina), /admin role required/);
    // Clients cannot read the log directly.
    await rejects(new Parse.Query('ErrorLog').find(as(s.owner)), /Permission denied|unauthorized/i);

    const resolved = await run('adminResolveErrors', { ids: [entry.id] }, s.owner);
    assert.equal(resolved.resolved, 1);
    const after = await run('adminListErrors', {}, s.owner);
    assert.ok(!after.rows.some((row) => row.id === entry.id));
    const fixed = await run('adminListErrors', { state: 'fixed' }, s.owner);
    assert.ok(fixed.rows.some((row) => row.id === entry.id && row.resolved));
    // It happens again: a new open entry.
    await run('reportClientError', report, s.pia);
    const reopened = (await run('adminListErrors', {}, s.owner)).rows.find(
      (row) => row.where === 'RiderWorkspace',
    );
    assert.ok(reopened && reopened.id !== entry.id && reopened.count === 1);
  });

  test('an unexpected failure in a Cloud function is recorded; expected errors are not', async () => {
    // Registered after startup, so it goes through the same wrapper as every
    // function in cloud/.
    globalThis.Parse.Cloud.define('e2eCrash', async (request) => {
      if (request.params.expected) throw new globalThis.Parse.Error(141, 'Expected problem');
      return request.params.missing.field;
    });
    await rejects(run('e2eCrash', {}, s.pia), /Cannot read properties of undefined/);
    await rejects(run('e2eCrash', { expected: true }, s.pia), /Expected problem/);
    const rows = (await run('adminListErrors', {}, s.owner)).rows.filter(
      (row) => row.where === 'e2eCrash',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'server');
    assert.match(rows[0].message, /Cannot read properties/);
    await run('adminResolveErrors', { all: true }, s.owner);
    assert.equal((await run('adminListErrors', { countOnly: true }, s.owner)).open, 0);
  });
});

describe('data export and customer privacy', () => {
  const exportAll = async (className) => {
    const rows = [];
    let after = null;
    do {
      const page = await run('adminExportData', { className, after }, s.owner);
      rows.push(...page.rows);
      after = page.next;
    } while (after);
    return rows;
  };

  test('the owner downloads every record; team members come without credentials', async () => {
    const summary = await run('adminExportSummary', {}, s.owner);
    assert.ok(summary.classes.includes('Order'));
    const orders = await exportAll('Order');
    assert.equal(orders.length, summary.counts.Order);
    assert.ok(orders.every((row) => row.objectId && !('ACL' in row)));
    const users = await exportAll('_User');
    assert.ok(users.some((row) => row.username === 'owner' && row.role === 'admin'));
    for (const row of users)
      for (const secret of ['password', '_hashed_password', 'sessionToken', 'authData'])
        assert.ok(!(secret in row), `${secret} is not exported`);
    await rejects(run('adminExportData', { className: 'Secret' }, s.owner), /Unknown kind/);
    await rejects(run('adminExportData', { className: 'Order' }, s.pia), /admin role required/);
    const log = await run('adminGetAuditLog', { group: 'data' }, s.owner);
    assert.ok(log.rows.some((row) => row.action === 'data.exported'));
  });

  test('privacy settings appear on the public privacy notice', async () => {
    await rejects(run('adminSavePrivacy', { retentionMonths: 5 }, s.owner), /how long/);
    await run(
      'adminSavePrivacy',
      { retentionMonths: 12, privacyContact: 'privacy@example.com · 0700 000000' },
      s.owner,
    );
    const info = await run('getAppInfo', { restaurant: CODE });
    assert.deepEqual(info.privacy, {
      contact: 'privacy@example.com · 0700 000000',
      retentionMonths: 12,
    });
  });

  test('a customer who asks is forgotten: finished orders lose their details, amounts stay', async () => {
    const customers = await exportAll('Customer');
    const orders = await exportAll('Order');
    const target = customers.find(
      (c) =>
        c.phone &&
        orders.some(
          (o) =>
            o.customerPhone === c.phone &&
            ['DELIVERED', 'CANCELLED'].includes(o.status) &&
            !['WITH_RIDER', 'HANDOVER_PENDING', 'DISPUTED'].includes(o.cashStatus),
        ),
    );
    assert.ok(target, 'a customer with a finished order');
    const preview = await run(
      'adminForgetCustomer',
      { phone: target.phone, dryRun: true },
      s.owner,
    );
    assert.equal(preview.found, true);
    assert.ok(preview.orders >= 1);
    const before = orders.filter((o) => o.customerPhone === target.phone);
    const done = await run('adminForgetCustomer', { phone: target.phone }, s.owner);
    assert.equal(done.orders, preview.orders);
    const after = await exportAll('Order');
    for (const order of before) {
      const now = after.find((o) => o.objectId === order.objectId);
      if (!now.anonymisedAt) continue;
      assert.equal(now.customerName, 'Customer (details removed)');
      assert.equal(now.customerPhone, '');
      assert.equal(now.deliveryAddress, '');
      assert.ok(!now.location);
      assert.equal(now.total, order.total, 'amounts stay for the books');
    }
    assert.equal(after.filter((o) => o.anonymisedAt).length >= done.orders, true);
    if (!done.inProgress)
      assert.ok(!(await exportAll('Customer')).some((c) => c.objectId === target.objectId));
    await rejects(run('adminForgetCustomer', { phone: '12' }, s.owner), /phone number/);
  });

  test('retention removes details older than the chosen period, nothing newer', async () => {
    const today = await run('adminApplyRetention', { dryRun: true }, s.owner);
    assert.deepEqual([today.orders, today.customers], [0, 0], 'nothing is a year old yet');
    // Two years from now, everything finished is past the 12 months.
    const asOf = new Date(Date.now() + 2 * 365 * 86400000).toISOString();
    const later = await Parse.Cloud.run(
      'adminApplyRetention',
      { asOf, dryRun: true },
      { useMasterKey: true },
    );
    assert.ok(later.orders > 0 && later.customers > 0);
    const applied = await Parse.Cloud.run('adminApplyRetention', { asOf }, { useMasterKey: true });
    assert.equal(applied.orders, later.orders);
    const orders = await exportAll('Order');
    const finished = orders.filter(
      (o) =>
        ['DELIVERED', 'CANCELLED'].includes(o.status) &&
        !['WITH_RIDER', 'HANDOVER_PENDING', 'DISPUTED'].includes(o.cashStatus) &&
        o.billOpen !== true,
    );
    assert.ok(finished.every((o) => o.anonymisedAt && o.customerPhone === ''));
    assert.ok(
      orders
        .filter((o) => !finished.includes(o))
        .every((o) => !o.anonymisedAt || o.customerPhone === ''),
    );
    assert.equal((await exportAll('Customer')).length, 0);
    // An order still in progress keeps its details.
    const open = orders.find((o) => ['PLACED', 'ACCEPTED', 'READY'].includes(o.status));
    if (open) assert.notEqual(open.customerName, 'Customer (details removed)');
    await run('adminSavePrivacy', { retentionMonths: 0, privacyContact: '' }, s.owner);
    await rejects(run('adminApplyRetention', {}, s.owner), /how long to keep/);
  });
});

describe('tax: EFRIS fiscal receipts', () => {
  const pem = EFRIS_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const KEY = Buffer.from(pem).toString('base64');
  const connection = {
    environment: 'test',
    tin: '1000029771',
    deviceNo: 'TCS9e0df01728335239',
    key: KEY,
    keyName: 'relay.pem',
  };
  let item;
  let settings;
  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
    ({ settings } = await run('adminListSetup', {}, s.owner));
    await run('adminSaveSettings', { ...settings, moduleCounter: true }, s.owner);
  });
  after(async () => {
    await run('adminSaveEfrisSettings', { enabled: false }, s.owner);
    await run('adminSaveSettings', settings, s.owner);
  });
  const paidOrder = (params = {}) =>
    run(
      'createCounterOrder',
      {
        orderType: 'pickup',
        items: [{ id: item.id, quantity: 2 }],
        customerName: 'Jane Achan',
        ...params,
      },
      s.owner,
    );
  // The background issue runs just after the order is saved.
  const settled = async (orderId) => {
    for (let i = 0; i < 40; i += 1) {
      const order = await new Parse.Query('Order').get(orderId, { useMasterKey: true });
      if (['issued', 'failed'].includes(order.get('efrisStatus'))) return order;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('EFRIS never answered for the order');
  };

  test('only the owner sets it up; the key is checked and never sent back', async () => {
    await rejects(run('adminGetEfrisSettings', {}, s.dina), /admin role required/);
    await rejects(run('adminSaveEfrisSettings', connection, s.dina), /admin role required/);
    await rejects(
      run('adminSaveEfrisSettings', { enabled: true }, s.owner),
      /Add the TIN, device number, private key/,
    );
    await rejects(
      run('adminSaveEfrisSettings', { ...connection, tin: '123' }, s.owner),
      /10 digits/,
    );
    await rejects(
      run(
        'adminSaveEfrisSettings',
        { ...connection, key: Buffer.from('nope').toString('base64') },
        s.owner,
      ),
      /keystore|private key/,
    );
    const saved = await run('adminSaveEfrisSettings', connection, s.owner);
    assert.equal(saved.keyLoaded, true);
    assert.equal(saved.keyName, 'relay.pem');
    assert.equal(JSON.stringify(saved).includes('PRIVATE KEY'), false, 'key stays on the server');
    assert.equal(saved.enabled, false);
    await rejects(
      run('adminSaveEfrisSettings', { enabled: true }, s.owner),
      /Add the legal name, email address, commodity category, unit of measure/,
    );
  });

  test('testing the connection signs, agrees a key and reads the taxpayer', async () => {
    const calls = efris.calls.length;
    const tested = await run('adminTestEfris', {}, s.owner);
    assert.equal(tested.lastTest.ok, true, tested.lastTest.message);
    assert.equal(tested.lastTest.vatRegistered, true);
    assert.equal(tested.lastTest.taxpayer, 'MAMA ROSE KITCHEN LIMITED');
    assert.deepEqual(efris.calls.slice(calls), ['T104', 'T103', 'T115']);
    assert.equal(efris.badSignatures, 0);
    // Filled from EFRIS where the owner had typed nothing.
    assert.equal(tested.legalName, 'MAMA ROSE KITCHEN LIMITED');
    assert.equal(tested.emailAddress, 'tax@mamarose.example');
    assert.equal(tested.invoiceKind, 'invoice');
    assert.equal(tested.taxCategory, 'standard');
    assert.deepEqual(
      tested.units.map((u) => u.value),
      ['PP', '101'],
    );
    // Another device: not tested any more.
    const moved = await run('adminSaveEfrisSettings', { deviceNo: 'TCS000' }, s.owner);
    assert.equal(moved.lastTest, null);
    const failed = await run('adminTestEfris', {}, s.owner);
    assert.equal(failed.lastTest.ok, false);
    assert.match(failed.lastTest.message, /Device does not exist \(400\)/);
    await run('adminSaveEfrisSettings', { deviceNo: connection.deviceNo }, s.owner);
    assert.equal((await run('adminTestEfris', {}, s.owner)).lastTest.ok, true);
  });

  test('the menu is registered as goods; a wrong category is reported per dish', async () => {
    await run(
      'adminSaveEfrisSettings',
      { commodityCategoryId: '12345678', unitOfMeasure: 'PP' },
      s.owner,
    );
    const wrong = await run('adminRegisterEfrisGoods', {}, s.owner);
    assert.ok(wrong.failures.length > 0);
    assert.match(wrong.failures[0].message, /commodityCategoryId: invalid field value! \(616\)/);
    await run('adminSaveEfrisSettings', { commodityCategoryId: '90101501' }, s.owner);
    const done = await run('adminRegisterEfrisGoods', {}, s.owner);
    assert.deepEqual(done.failures, []);
    assert.equal(efris.goods.get(`RLY-${item.id}`), item.title);
    assert.ok(efris.goods.has('RELAY-DELIVERY'));
    // Again: nothing new to send; all: updated, not duplicated (602 → modify).
    const calls = efris.calls.length;
    await run('adminRegisterEfrisGoods', {}, s.owner);
    assert.equal(efris.calls.slice(calls).includes('T130'), false);
    assert.deepEqual((await run('adminRegisterEfrisGoods', { all: true }, s.owner)).failures, []);
  });

  test('sales before switching on are never issued; paid sales after are', async () => {
    const before = await paidOrder();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const on = await run('adminSaveEfrisSettings', { enabled: true }, s.owner);
    assert.equal(on.enabled, true);
    assert.ok(on.since);
    const old = await run('getReceipt', { orderId: before.id }, s.owner);
    assert.equal(old.efris.status, 'not_due');
    assert.equal(old.efris.fdn, '');

    const placed = await paidOrder({ customerPhone: '0772123456' });
    const order = await settled(placed.id);
    assert.equal(order.get('efrisStatus'), 'issued', order.get('efrisError'));
    const record = efris.invoices.get(placed.orderCode);
    assert.equal(order.get('efrisFdn'), record.basicInformation.invoiceNo);
    const invoice = record.body;
    assert.equal(invoice.sellerDetails.isCheckReferenceNo, '1');
    assert.equal(invoice.sellerDetails.legalName, 'MAMA ROSE KITCHEN LIMITED');
    assert.equal(invoice.basicInformation.invoiceKind, '1');
    assert.equal(invoice.buyerDetails.buyerLegalName, 'Jane Achan');
    assert.equal(Number(invoice.summary.grossAmount), placed.total);
    assert.equal(invoice.goodsDetails[0].item, item.title);
    assert.equal(invoice.goodsDetails[0].qty, '2');
    assert.equal(invoice.payWay[0].paymentMode, '102');

    const receipt = await run('getReceipt', { orderId: placed.id }, s.dina);
    assert.equal(receipt.efris.status, 'issued');
    assert.equal(receipt.efris.fdn, record.basicInformation.invoiceNo);
    assert.equal(receipt.efris.verification, record.basicInformation.antifakeCode);
    assert.equal(receipt.efris.qr, record.summary.qrCode);
    assert.equal(receipt.efris.tin, '1000029771');
    assert.equal(receipt.efris.kind, 'invoice');
    const detail = await run('adminGetOrder', { id: placed.id }, s.owner);
    assert.equal(detail.efris.fdn, record.basicInformation.invoiceNo);
    // Printing again never issues again.
    const issued = efris.invoices.size;
    await run('getReceipt', { orderId: placed.id }, s.dina);
    await run('issueEfrisReceipt', { orderId: placed.id }, s.dina);
    assert.equal(efris.invoices.size, issued);
  });

  test('an open bill is issued when it is paid, not before', async () => {
    const bill = await paidOrder({ payLater: true });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await run('getReceipt', { orderId: bill.id }, s.owner)).efris.status, 'not_due');
    await rejects(run('issueEfrisReceipt', { orderId: bill.id }, s.owner), /not complete yet/);
    assert.equal(efris.invoices.has(bill.orderCode), false);
    await run('takeCounterPayment', { orderId: bill.id, paymentMethod: 'cash' }, s.owner);
    const receipt = await run('getReceipt', { orderId: bill.id }, s.owner);
    assert.equal(receipt.efris.status, 'issued');
    assert.ok(efris.invoices.has(bill.orderCode));
  });

  test('a lost answer is recovered from EFRIS, never issued twice', async () => {
    efris.lostAnswers = 1;
    const placed = await paidOrder();
    const order = await settled(placed.id);
    assert.equal(order.get('efrisStatus'), 'failed');
    assert.match(order.get('efrisError'), /EFRIS/);
    assert.equal((await run('adminGetOrder', { id: placed.id }, s.owner)).efris.status, 'failed');
    const view = await run('issueEfrisReceipt', { orderId: placed.id }, s.dina);
    assert.equal(view.status, 'issued', view.error);
    assert.equal(view.fdn, efris.invoices.get(placed.orderCode).basicInformation.invoiceNo);
    assert.equal([...efris.invoices.keys()].filter((code) => code === placed.orderCode).length, 1);
  });

  test('a renamed dish is renamed in EFRIS before its next sale', async () => {
    const dish = (await run('adminListSetup', {}, s.owner)).menu.find((i) => i.id === item.id);
    await run('adminSaveMenuItem', { ...dish, title: `${dish.title} Deluxe` }, s.owner);
    try {
      const placed = await paidOrder();
      const order = await settled(placed.id);
      assert.equal(order.get('efrisStatus'), 'issued', order.get('efrisError'));
      assert.equal(efris.goods.get(`RLY-${item.id}`), `${dish.title} Deluxe`);
    } finally {
      await run('adminSaveMenuItem', dish, s.owner);
    }
  });

  test('Relay makes a key pair; its certificate, once on the portal, connects', async () => {
    await rejects(run('adminGenerateEfrisKey', {}, s.dina), /admin role required/);
    await rejects(run('adminGenerateEfrisKey', {}, s.owner), /already saved/);
    await rejects(run('adminGetEfrisCertificate', {}, s.owner), /No certificate here/);
    const made = await run('adminGenerateEfrisKey', { replace: true }, s.owner);
    assert.match(made.crt.text, /^-----BEGIN CERTIFICATE-----/);
    assert.equal(made.crt.name, 'efris-1000029771.crt');
    assert.equal(made.view.certificate.fingerprint, made.fingerprint);
    assert.equal(made.view.keyLoaded, true);
    assert.equal(JSON.stringify(made).includes('PRIVATE KEY'), false, 'the key stays here');
    // The easy mistake: choosing the certificate as the private key.
    for (const file of [Buffer.from(made.crt.text).toString('base64'), made.cer.base64])
      await rejects(
        run('adminSaveEfrisSettings', { key: file, keyName: 'efris.crt' }, s.owner),
        /is a certificate \(the public key\).*already saved/,
      );
    const cert = new crypto.X509Certificate(made.crt.text);
    assert.match(cert.subject, /CN=1000029771/);
    // Before the certificate is uploaded, EFRIS refuses the new key.
    assert.equal((await run('adminTestEfris', {}, s.owner)).lastTest.ok, false);
    // The owner uploads the certificate on the portal.
    efris.publicKey = cert.publicKey;
    const tested = await run('adminTestEfris', {}, s.owner);
    assert.equal(tested.lastTest.ok, true, tested.lastTest.message);
    const again = await run('adminGetEfrisCertificate', {}, s.owner);
    assert.equal(again.fingerprint, made.fingerprint);
    assert.equal(
      new crypto.X509Certificate(Buffer.from(again.cer.base64, 'base64')).fingerprint,
      cert.fingerprint,
    );
    // Uploading a key of one's own replaces it, and its certificate with it.
    efris.publicKey = EFRIS_KEYS.publicKey;
    const own = await run('adminSaveEfrisSettings', { key: KEY, keyName: 'relay.pem' }, s.owner);
    assert.equal(own.certificate, null);
    assert.equal((await run('adminTestEfris', {}, s.owner)).lastTest.ok, true);
  });

  test('switched off: receipts carry nothing and no sale goes to EFRIS', async () => {
    const off = await run('adminSaveEfrisSettings', { enabled: false }, s.owner);
    assert.equal(off.enabled, false);
    const placed = await paidOrder();
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await run('getReceipt', { orderId: placed.id }, s.owner)).efris, null);
    assert.equal(efris.invoices.has(placed.orderCode), false);
    await rejects(run('issueEfrisReceipt', { orderId: placed.id }, s.owner), /not switched on/);
  });
});

describe('automatic mobile money (MTN MoMo and Airtel Money)', () => {
  let item;
  let settings;
  before(async () => {
    item = (await run('getOperationalMenu', {}, s.pia)).items.find(
      (i) => !i.accompanimentGroups.length,
    );
    ({ settings } = await run('adminListSetup', {}, s.owner));
    await run('adminSaveSettings', { ...settings, moduleCounter: true }, s.owner);
  });
  after(async () => {
    await run('adminSavePaymentSettings', { provider: 'mtn', enabled: false }, s.owner);
    await run('adminSavePaymentSettings', { provider: 'airtel', enabled: false }, s.owner);
    await run('adminSaveSettings', settings, s.owner);
  });
  // Asks until the request is settled (the stand-in answers on the 2nd check).
  const settle = async (orderId) => {
    for (let i = 0; i < 10; i += 1) {
      const state = await run('checkPaymentRequest', { orderId }, s.owner);
      if (!['queued', 'pending'].includes(state.payRequestStatus)) return state;
      await new Promise((resolve) => setTimeout(resolve, 3200));
    }
    throw new Error('the payment request never settled');
  };
  const counterOrder = (params) =>
    run(
      'createCounterOrder',
      { orderType: 'pickup', items: [{ id: item.id, quantity: 1 }], ...params },
      s.owner,
    );

  test('the owner stores the keys: masked on the way back, checked with the provider', async () => {
    await rejects(
      run('adminSavePaymentSettings', { provider: 'mtn', enabled: true }, s.owner),
      /Add all the MTN MoMo keys/,
    );
    await run(
      'adminSavePaymentSettings',
      { provider: 'mtn', environment: 'sandbox', subscriptionKey: 'mtn-sub', enabled: false },
      s.owner,
    );
    // Sandbox: Relay makes the API user and key from the subscription key.
    const made = await run('adminMtnSandboxUser', {}, s.owner);
    assert.match(made.apiKey, /^••••/);
    await run(
      'adminSavePaymentSettings',
      { provider: 'mtn', environment: 'sandbox', enabled: true },
      s.owner,
    );
    const view = await run('adminGetPaymentSettings', {}, s.owner);
    assert.equal(view.mtn.enabled, true);
    assert.equal(view.mtn.configured, true);
    assert.equal(view.mtn.keys.subscriptionKey, '••••-sub');
    assert.ok(!JSON.stringify(view).includes('sandbox-api-key'), 'keys never come back in full');
    assert.deepEqual(await run('adminTestPaymentConnection', { provider: 'mtn' }, s.owner), {
      ok: true,
      message: 'Connected: the keys work.',
    });
    await run(
      'adminSavePaymentSettings',
      { provider: 'airtel', environment: 'sandbox', clientId: 'airtel-id', clientSecret: 'wrong' },
      s.owner,
    );
    const bad = await run('adminTestPaymentConnection', { provider: 'airtel' }, s.owner);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /401/);
    const log = await run('adminGetAuditLog', { group: 'payment' }, s.owner);
    assert.ok(log.rows.some((r) => r.action === 'payment.settings_saved'));
    assert.ok(!JSON.stringify(log).includes('mtn-sub'), 'keys never reach the audit log');
    await rejects(run('adminGetPaymentSettings', {}, s.dina), /admin role required/);
    const profile = await run('getMyProfile', {}, s.pia);
    assert.ok(profile.config.mobileMoney.some((a) => a.provider === 'mtn' && a.auto));
  });

  test('MTN: no transaction ID sends a request to the customer; approval confirms the payment', async () => {
    await rejects(
      counterOrder({ paymentMethod: 'mobile_money', paymentProvider: 'mtn', customerPhone: '12' }),
      /Enter the customer’s MTN MoMo number/,
    );
    const order = await counterOrder({
      paymentMethod: 'mobile_money',
      paymentProvider: 'mtn',
      customerPhone: '0772 123456',
    });
    const state = await settle(order.id);
    assert.equal(state.payRequestStatus, 'successful');
    assert.equal(state.paymentStatus, 'VERIFIED');
    assert.match(state.reference, /^MTN/);
    const sent = [...momo.mtn.values()].at(-1);
    assert.equal(sent.payer.partyId, '256772123456');
    assert.equal(sent.currency, 'EUR', 'the MTN sandbox only takes EUR');
    assert.equal(sent.amount, String(order.total));
    assert.equal(sent.target, 'sandbox');
    const ledger = await run('getMobileMoneyLedger', {}, s.owner);
    assert.ok(ledger.verified.some((row) => row.id === order.id && row.auto));
    // The owner's order page shows the provider's ID and the request reference.
    const detail = await run('adminGetOrder', { id: order.id }, s.owner);
    assert.equal(detail.payment.auto, true);
    assert.equal(detail.payment.reference, state.reference);
    assert.ok(momo.mtn.has(detail.payment.requestReference), 'the X-Reference-Id MTN got');
    assert.equal(detail.payment.requestPhone, '0772 123456');
  });

  test('MTN: approved after the order was cancelled: recorded as a refund due', async () => {
    const order = await counterOrder({
      paymentMethod: 'mobile_money',
      paymentProvider: 'mtn',
      customerPhone: '0772 123457',
    });
    // Cancelled while the request is still on the customer's phone.
    await run(
      'transitionOrder',
      { orderId: order.id, action: 'cancel', reason: 'payment failed' },
      s.owner,
    );
    const state = await settle(order.id);
    assert.equal(state.paymentStatus, 'VERIFIED');
    const row = await new Parse.Query('Order').get(order.id, { useMasterKey: true });
    assert.equal(row.get('status'), 'CANCELLED');
    assert.equal(row.get('refundDue'), true);
    assert.equal(row.get('billOpen'), false);
    const detail = await run('adminGetOrder', { id: order.id }, s.owner);
    assert.equal(detail.payment.refundDue, true);
    assert.equal(detail.can.refunded, true);
    const log = await run('adminGetAuditLog', { group: 'payment' }, s.owner);
    assert.ok(log.rows.some((r) => r.action === 'payment.after_cancel'));
    // The balance sheet: the money is in cash, and owed back (a liability).
    const owing = await run('getBalanceSheet', {}, s.owner);
    const owed = owing.refunds.owed.find((r) => r.id === order.id);
    assert.equal(owed.amount, order.total);
    assert.ok(owing.sheet.liabilities.refunds >= order.total);
    assert.equal(
      owing.sheet.liabilities.total,
      owing.sheet.liabilities.suppliers +
        owing.sheet.liabilities.riders +
        owing.sheet.liabilities.refunds,
    );
    // Sent back: the owner records how.
    await run(
      'adminOverrideOrder',
      { id: order.id, action: 'refunded', reason: 'MTN MoMo back to 0772123457, ID 998877' },
      s.owner,
    );
    const done = await run('adminGetOrder', { id: order.id }, s.owner);
    assert.equal(done.payment.refundDue, false);
    assert.ok(done.payment.refundedAt);
    assert.match(done.payment.refundNote, /998877/);
    // Cleared: off the liabilities, the cash gone back out.
    const after = await run('getBalanceSheet', {}, s.owner);
    assert.equal(
      after.refunds.owed.some((r) => r.id === order.id),
      false,
    );
    const cleared = after.refunds.cleared.find((r) => r.id === order.id);
    assert.ok(cleared.refundedAt);
    assert.match(cleared.note, /998877/);
    assert.equal(after.sheet.liabilities.refunds, owing.sheet.liabilities.refunds - order.total);
    assert.equal(after.sheet.assets.cash, owing.sheet.assets.cash - order.total);
    const flow = await run('getCashFlow', {}, s.owner);
    assert.ok(flow.inflows.some((r) => r.key === 'refund_receipts' && r.amount >= order.total));
    assert.ok(flow.outflows.some((r) => r.key === 'refunds' && r.amount >= order.total));
    await rejects(
      run(
        'adminOverrideOrder',
        { id: order.id, action: 'refunded', reason: 'again please' },
        s.owner,
      ),
      /No refund is due/,
    );
  });

  test('MTN: a declined request leaves the payment not received, and the bill open again', async () => {
    const order = await counterOrder({
      orderType: 'eat_in',
      paymentMethod: 'mobile_money',
      paymentProvider: 'mtn',
      payerPhone: '0772000099',
    });
    const state = await settle(order.id);
    assert.equal(state.payRequestStatus, 'failed');
    assert.equal(state.paymentStatus, 'REJECTED');
    assert.match(state.reason, /did not go through/);
    // The cashier takes it another way; a typed transaction ID still works.
    await run(
      'takeCounterPayment',
      {
        orderId: order.id,
        paymentMethod: 'mobile_money',
        paymentProvider: 'mtn',
        paymentReference: 'MP12345678',
      },
      s.owner,
    );
  });

  test('MTN test numbers: declined and timed-out requests are not received', async () => {
    for (const [phone, reason] of [
      ['46733123451', /declined/],
      ['46733123452', /did not answer in time/],
    ]) {
      const order = await counterOrder({
        orderType: 'eat_in',
        paymentMethod: 'mobile_money',
        paymentProvider: 'mtn',
        payerPhone: phone,
      });
      const state = await settle(order.id);
      assert.equal(state.paymentStatus, 'REJECTED');
      assert.match(state.reason, reason);
      assert.equal([...momo.mtn.values()].at(-1).payer.partyId, phone, 'sent unchanged');
    }
    const view = await run('adminGetPaymentSettings', {}, s.owner);
    assert.equal(view.mtnTestNumbers['46733123451'], 'is declined');
  });

  test('Airtel: the national number is used and the payment confirms itself', async () => {
    await run(
      'adminSavePaymentSettings',
      { provider: 'airtel', environment: 'sandbox', clientSecret: 'airtel-secret', enabled: true },
      s.owner,
    );
    assert.equal(
      (await run('adminTestPaymentConnection', { provider: 'airtel' }, s.owner)).ok,
      true,
    );
    const order = await counterOrder({ orderType: 'eat_in', payLater: true });
    await run(
      'takeCounterPayment',
      {
        orderId: order.id,
        paymentMethod: 'mobile_money',
        paymentProvider: 'airtel',
        payerPhone: '+256 752 123 456',
      },
      s.owner,
    );
    const state = await settle(order.id);
    assert.equal(state.paymentStatus, 'VERIFIED');
    assert.match(state.reference, /^AM/);
    const sent = [...momo.airtel.values()].at(-1);
    assert.equal(sent.subscriber.msisdn, '752123456');
    assert.equal(sent.country, 'UG');
    assert.equal(sent.transaction.amount, order.total);
  });

  test('the server address for Airtel’s allowed list, and a warning when it changes', async () => {
    const first = await run('adminGetServerAddress', {}, s.owner);
    assert.equal(first.ip, '203.0.113.10');
    assert.equal((await run('adminGetServerAddress', {}, s.owner)).changed, false);
    momo.ip = '203.0.113.99';
    const moved = await run('adminGetServerAddress', {}, s.owner);
    assert.deepEqual(
      [moved.ip, moved.previous, moved.changed],
      ['203.0.113.99', '203.0.113.10', true],
    );
    assert.ok(moved.changedAt);
    assert.deepEqual(
      moved.history.map((h) => h.ip),
      ['203.0.113.99', '203.0.113.10'],
    );
    await rejects(run('adminGetServerAddress', {}, s.dina), /admin role required/);
  });

  test('with automatic payments off, the transaction ID is required again', async () => {
    await run('adminSavePaymentSettings', { provider: 'mtn', enabled: false }, s.owner);
    await rejects(
      counterOrder({
        paymentMethod: 'mobile_money',
        paymentProvider: 'mtn',
        customerPhone: '0772123456',
      }),
      /Enter the transaction ID|Choose/,
    );
  });
});

describe('the Admin area opens only with the PIN', () => {
  test('a fresh owner session must re-enter the PIN; it can be locked again', async () => {
    // Fresh sessions straight from the REST API (the SDK would reuse the
    // shared owner object and change the session the other tests use).
    const session = async () => {
      const response = await fetch(`${SERVER_URL}/login`, {
        method: 'POST',
        headers: { 'X-Parse-Application-Id': APP_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `owner@${CODE}`, password: PINS.owner }),
      });
      return (await response.json()).sessionToken;
    };
    const token = await session();
    const call = (name, params = {}) => Parse.Cloud.run(name, params, { sessionToken: token });
    for (const name of [
      'adminGetAuditLog',
      'adminSaveBranding',
      'adminExportSummary',
      'adminListErrors',
    ])
      await rejects(call(name), /Admin is locked/);
    // The menu's error count works without opening Admin.
    assert.equal(typeof (await call('adminListErrors', { countOnly: true })).open, 'number');
    assert.equal((await call('getAdminUnlock')).unlocked, false);
    await rejects(call('unlockAdmin', { pin: 'wrong-pin' }), /Wrong PIN/);
    const opened = await call('unlockAdmin', { pin: PINS.owner });
    assert.equal(opened.unlocked, true);
    assert.ok((await call('adminGetAuditLog')).rows.some((r) => r.action === 'admin.unlocked'));
    assert.equal((await call('getAdminUnlock')).unlocked, true);
    // Another session of the same owner is still locked.
    const other = await session();
    await rejects(
      Parse.Cloud.run('adminExportSummary', {}, { sessionToken: other }),
      /Admin is locked/,
    );
    await call('lockAdmin');
    await rejects(call('adminExportSummary'), /Admin is locked/);
    await rejects(run('unlockAdmin', { pin: PINS.dina }, s.dina), /admin role required/);
  });
});

// Who may call each Cloud function. Every function the server registers must
// be listed here, so a new function cannot ship without deciding who may use
// it. public: anyone, signed in or not; signedIn: any active team member
// (the function checks the person's own records); nobody: master key only,
// or switched off (preview mode).
const ACCESS = {
  public: [
    'getAppInfo',
    'reportClientError',
    'checkRestaurantCode',
    'signUpRestaurant',
    'getPlans',
    'requestOwnerReset',
    'completeOwnerReset',
    'checkSignupCode',
    'getOnlineMenu',
    'placeOnlineOrder',
    'getOnlineOrder',
    'cancelOnlineOrder',
    'getMyOnlineOrders',
  ],
  nobody: [
    'bootstrapOwner',
    'recoverOwner',
    'createPlatformAdmin',
    // Platform staff only (tested in "platform console and access").
    'platformListRestaurants',
    'platformUpdateRestaurant',
    'platformSaveSettings',
    'platformListPlans',
    'platformSavePlan',
    'platformGetEmail',
    'platformSaveEmail',
    'platformTestEmail',
    'platformEmailTemplate',
    'platformBroadcastPreview',
    'platformSendBroadcast',
    'platformListBroadcasts',
    'platformRevenue',
    'platformListDiscountCodes',
    'platformGetAccounting',
    'platformGetZoho',
    'platformConnectZoho',
    'platformSaveZoho',
    'platformDisconnectZoho',
    'platformSyncZoho',
    'platformPostEarnings',
    'platformSaveDiscountCode',
    'platformGetWhatsApp',
    'platformSaveWhatsApp',
    'platformTestWhatsApp',
    'platformGetAudit',
    'platformRecordPayment',
    'platformListPayments',
    'platformResetOwner',
    'platformDeleteRestaurant',
    'platformSecurityStatus',
    'platformApplySecurity',
    'platformListErrors',
    'platformResolveErrors',
    'createPreviewOrder',
    'getPreviewOrders',
    'transitionPreviewOrder',
  ],
  signedIn: [
    'getMyProfile',
    'getPushConfig',
    'savePushSubscription',
    'removePushSubscription',
    'sendTestPush',
    'getNotifications',
    'markNotificationsRead',
    'changeMyPin',
    'getMyShift',
    'startShift',
    'endShift',
    'transitionOrder',
    'setOrderLocation',
    'flagOrderIssue',
    'resubmitPayment',
    'checkPaymentRequest',
  ],
  rider: ['createOrder', 'createHandover', 'getMyHandovers', 'getMyPay', 'setMyAvailability'],
  riderOrReports: ['getRiderEarnings'],
  anyRole: ['searchCustomers', 'getOperationalMenu'],
  everyRole: ['getBranches'],
  cashier: ['recordTillPayout'],
  staff: [
    'setOnlineOpen',
    'getTables',
    'moveOrderTable',
    'logDrawerOpen',
    'confirmHandover',
    'disputeHandover',
    'createCounterOrder',
    'assignOrderRider',
    'takeCounterPayment',
    'getAssignableRiders',
    'getReceipt',
    'getStock',
    'setAvailability',
    'getOnShiftCashiers',
    'transferOrder',
    'verifyPayment',
    'getMobileMoneyLedger',
    'getRiderPay',
    'payRider',
  ],
  staffOrFinance: ['getTillPayouts', 'getReportOptions', 'getPaymentsLedger', 'issueEfrisReceipt'],
  reports: [
    'getDrawerOpenings',
    'getProfitAndLoss',
    'getBalanceSheet',
    'getCashFlow',
    'saveOpeningBalance',
    'listEfrisReceipts',
    'listSuppliers',
    'saveSupplier',
    'recordPurchase',
    'payPurchase',
    'voidPurchase',
    'listPurchases',
    'recordExpense',
    'voidExpense',
    'listExpenses',
    'listCustomers',
    'getCustomer',
    'saveCustomer',
    'getDashboard',
    'adminGetZReport',
    'adminListZReports',
    'adminGetOrder',
    'adminSearchOrders',
    'getCommissionLedger',
    'getOperationsReport',
    'getShiftReport',
  ],
  admin: [
    'updateOwnerEmail',
    // Relay Hosted: paying the subscription.
    'getBilling',
    'changePlan',
    'startSubscriptionPayment',
    'checkSubscriptionPayment',
    'startTrialInstead',
    'startPlanUpgrade',
    'getDowngradeChoices',
    'adminListTables',
    'adminSaveTable',
    'adminSaveOnlineOrdering',
    'adminGetOnlineOrdering',
    'adminGetEfrisSettings',
    'adminSaveEfrisSettings',
    'adminTestEfris',
    'adminRegisterEfrisGoods',
    'adminGenerateEfrisKey',
    'adminGetEfrisCertificate',
    'adminRestoreData',
    'adminRestoreFinish',
    'adminListSetup',
    'adminCreateTeamMember',
    'adminUpdateMember',
    'adminChangeRole',
    'adminSaveCategory',
    'adminSortCategories',
    'adminSaveMenuItem',
    'adminSortMenu',
    'adminSetMenuImage',
    'adminSetRestaurantLogo',
    'adminSetLoginImages',
    'adminSaveAccompaniment',
    'adminSaveBranding',
    'adminSaveSettings',
    'adminResolveHandover',
    'reopenHandover',
    'adminReceiveCash',
    'adminRunCashCheck',
    'resolveOrderIssue',
    'adminListIssues',
    'adminOverrideOrder',
    'adminGetAuditLog',
    'adminSettleTillDifference',
    'adminResetPin',
    'adminUnlockSignIn',
    'adminSecurityStatus',
    'adminGetMember',
    'adminApplySecurity',
    'getSetupProgress',
    'adminImportMenu',
    'adminFinishSetup',
    'adminListErrors',
    'adminResolveErrors',
    'adminExportData',
    'adminExportSummary',
    'adminSavePrivacy',
    'adminApplyRetention',
    'adminForgetCustomer',
    'unlockAdmin',
    'getAdminUnlock',
    'lockAdmin',
    'adminGetPaymentSettings',
    'adminSavePaymentSettings',
    'adminTestPaymentConnection',
    'adminMtnSandboxUser',
    'adminGetServerAddress',
    'adminGetWhatsAppSettings',
    'adminSaveWhatsAppSettings',
    'adminTestWhatsApp',
    'adminListBranches',
    'adminSaveBranch',
  ],
};
const ALLOWED = {
  public: ['anonymous', 'rider', 'cashier', 'finance', 'admin'],
  nobody: [],
  signedIn: ['rider', 'cashier', 'finance', 'admin'],
  rider: ['rider'],
  riderOrReports: ['rider', 'finance', 'admin'],
  anyRole: ['rider', 'cashier', 'admin'],
  everyRole: ['rider', 'cashier', 'finance', 'admin'],
  cashier: ['cashier'],
  staff: ['cashier', 'admin'],
  staffOrFinance: ['cashier', 'finance', 'admin'],
  // Owner-end reporting: the owner and the finance role.
  reports: ['finance', 'admin'],
  admin: ['admin'],
};
// Finance has no shifts: nothing to start at a till or on the road.
const REFUSED = { startShift: ['finance'] };
// How the server says "not you": no session, the wrong role, master key
// only, or switched off. Other errors (a missing field, no open shift) mean
// the caller got past the permission check.
const DENIED =
  /Sign in required|role required|Master key required|Preview mode is disabled|Owner already configured|sign-up page|Not allowed to start this shift|Account is inactive/;

// Parameters a probe needs to reach the permission check at all.
const PROBE_PARAMS = {
  startShift: (who) => ({ kind: who === 'rider' ? 'rider' : 'cashier' }),
};

describe('permission matrix: every Cloud function × every role', () => {
  const callers = {};
  before(async () => {
    for (const [username, pin, role] of [
      ['matrix-rider', '7001', 'rider'],
      ['matrix-cashier', '7002', 'cashier'],
      ['matrix-finance', '7004', 'finance'],
      ['matrix-gone', '7003', 'rider'],
    ])
      await run('adminCreateTeamMember', { name: username, username, pin, role }, s.owner);
    callers.rider = await login('matrix-rider', '7001');
    callers.cashier = await login('matrix-cashier', '7002');
    callers.finance = await login('matrix-finance', '7004');
    callers.admin = s.owner;
    // A deactivated member keeps a session token but may call nothing.
    const gone = await login('matrix-gone', '7003');
    const { team } = await run('adminListSetup', {}, s.owner);
    await run(
      'adminUpdateMember',
      { id: team.find((m) => m.username === 'matrix-gone').id, active: false },
      s.owner,
    );
    callers.inactive = gone;
  });

  test('every registered function has an access rule', async () => {
    const { getFunctionNames } = require('parse-server/lib/triggers');
    const listed = Object.values(ACCESS).flat();
    assert.equal(new Set(listed).size, listed.length, 'a function is listed twice');
    const registered = getFunctionNames(APP_ID).filter((name) => name !== 'e2eCrash');
    assert.deepEqual(
      registered.filter((name) => !listed.includes(name)),
      [],
      'functions without an access rule',
    );
    assert.deepEqual(
      listed.filter((name) => !registered.includes(name)),
      [],
      'rules for functions that do not exist',
    );
  });

  test('each role can call exactly what its rule allows', async () => {
    const wrong = [];
    for (const [rule, names] of Object.entries(ACCESS))
      for (const name of names)
        for (const who of ['anonymous', 'rider', 'cashier', 'finance', 'admin', 'inactive']) {
          const user = callers[who];
          let denied = false;
          let message = '';
          try {
            await Parse.Cloud.run(name, PROBE_PARAMS[name]?.(who) || {}, user ? as(user) : {});
          } catch (error) {
            message = String(error.message);
            denied = error.code === Parse.Error.INVALID_SESSION_TOKEN || DENIED.test(message);
          }
          const expected =
            ALLOWED[rule].includes(who) && who !== 'inactive' && !REFUSED[name]?.includes(who);
          if (denied === expected)
            wrong.push(
              `${name} as ${who}: ${expected ? 'denied' : 'allowed'} (${message || 'ok'})`,
            );
        }
    assert.deepEqual(wrong, []);
  });
});

describe('restaurants are kept apart (Relay Hosted)', () => {
  const M = { useMasterKey: true };
  const OTHER = 'kato-grill';
  const day = (offset) =>
    new Date(Date.now() + 3 * 3600e3 + offset * 864e5).toISOString().slice(0, 10);
  const range = { from: day(-1), to: day(1) };
  const other = {};

  before(async () => {
    await run('signUpRestaurant', {
      restaurantName: 'Kato Grill',
      ownerName: 'Kato',
      username: 'owner',
      pin: PINS.owner,
      phone: '0701 234567',
      email: 'kato@example.com',
    });
    other.owner = await login('owner', PINS.owner, OTHER);
    // Same username and PIN as the first restaurant's rider.
    other.rider = await run(
      'adminCreateTeamMember',
      { name: 'Rita Two', username: 'rita', pin: PINS.rita, role: 'rider' },
      other.owner,
    );
    other.riderUser = await login('rita', PINS.rita, OTHER);
    other.theirOrder = await new Parse.Query('Order').descending('createdAt').first(M);
  });

  test('usernames and codes are per restaurant', async () => {
    assert.equal(other.rider.code, 'R-001');
    assert.equal(other.rider.username, 'rita');
    const profile = await run('getMyProfile', {}, other.riderUser);
    assert.equal(profile.name, 'Rita Two');
    assert.equal(profile.role, 'rider');
    assert.equal(profile.restaurant.code, OTHER);
    assert.equal(profile.config.restaurantName, 'Kato Grill');
    assert.notEqual(other.riderUser.id, s.rider.id);
    await rejects(login('rita', 'wrong-pin', OTHER), /Invalid username\/password/);
  });

  test('the team, menu, orders and settings are the restaurant’s own', async () => {
    const { team } = await run('adminListSetup', {}, other.owner);
    assert.deepEqual(team.map((m) => m.username).sort(), ['owner', 'rita']);
    const menu = (await run('getOperationalMenu', {}, other.riderUser)).items;
    assert.ok(menu.length > 0);
    const firstIds = new Set(s.menu.map((item) => item.id));
    assert.ok(menu.every((item) => !firstIds.has(item.id)));
    assert.equal((await run('adminSearchOrders', range, other.owner)).rows.length, 0);
    const { rows } = await run('adminExportData', { className: 'Order' }, other.owner);
    assert.equal(rows.length, 0);
    const info = await run('getAppInfo', { restaurant: OTHER });
    assert.equal(info.restaurantName, 'Kato Grill');
    // A signed-in person always gets their own restaurant, whatever they name.
    const mine = await run('getAppInfo', { restaurant: OTHER }, s.owner);
    assert.equal(mine.restaurant.code, CODE);
  });

  test('another restaurant’s records cannot be reached by id', async () => {
    const id = other.theirOrder.id;
    await rejects(run('adminGetOrder', { id }, other.owner), /not found|Object not found/i);
    await rejects(
      run('transitionOrder', { orderId: id, action: 'deliver' }, other.riderUser),
      /not found|Object not found/i,
    );
    await rejects(new Parse.Query('Order').get(id, as(other.owner)), /Object not found/);
    const direct = await new Parse.Query('Order').find(as(other.owner));
    assert.equal(direct.length, 0);
    const people = await new Parse.Query(Parse.User).find(as(other.owner));
    assert.ok(people.some((user) => user.get('username') === `rita@${OTHER}`));
    assert.ok(people.every((user) => !user.get('username').endsWith(`@${CODE}`)));
  });

  test('new orders stay in their restaurant', async () => {
    const menu = (await run('getOperationalMenu', {}, other.riderUser)).items;
    const dish = menu.find((item) => !item.accompanimentGroups.length) || menu[0];
    const created = await run(
      'createOrder',
      {
        customerName: 'Kato Customer',
        customerPhone: '+256 701 000111',
        deliveryAddress: 'Ntinda',
        channel: 'whatsapp',
        paymentMethod: 'cash',
        items: [{ id: dish.id, quantity: 1 }],
      },
      other.riderUser,
    );
    assert.match(created.orderCode, /-0001$/);
    const theirs = await run('adminSearchOrders', range, other.owner);
    assert.equal(theirs.rows.length, 1);
    const ours = await run('adminSearchOrders', range, s.owner);
    assert.ok(ours.rows.every((row) => row.id !== created.id));
    await rejects(run('adminGetOrder', { id: created.id }, s.owner), /not found/i);
    const firstNotes = await run('getNotifications', {}, s.owner);
    assert.ok(firstNotes.items.every((row) => !JSON.stringify(row).includes('Kato Customer')));
  });
});

describe('platform console and access (Relay Hosted)', () => {
  const M = { useMasterKey: true };
  const OTHER = 'kato-grill';
  const DAY = 86400000;
  const when = (days) => new Date(Date.now() + days * DAY).toISOString();
  const other = {};
  let ops;
  const update = (params) => run('platformUpdateRestaurant', { id: other.id, ...params }, ops);

  before(async () => {
    await Parse.Cloud.run(
      'createPlatformAdmin',
      { username: 'ops', password: 'ops-pass-123', name: 'Relay Ops' },
      M,
    );
    ops = await Parse.User.logIn('ops', 'ops-pass-123');
    other.owner = await login('owner', PINS.owner, OTHER);
    other.rider = await login('rita', PINS.rita, OTHER);
  });

  const planByKey = async (key) =>
    (await run('platformListPlans', {}, ops)).plans.find((plan) => plan.key === key);
  const savePlan = async (key, changes) => {
    const plan = await planByKey(key);
    // The listed annual price is computed unless set; send it back only then.
    const annualPrice = plan.annualSet ? plan.annualPrice : null;
    return run('platformSavePlan', { ...plan, annualPrice, ...changes }, ops);
  };

  after(async () => {
    await run(
      'platformSaveSettings',
      { currency: 'UGX', trialDays: 14, graceDays: 7, supportContact: '' },
      ops,
    );
    // The payment tests that follow price Basic at 50,000.
    await savePlan('basic', { price: 50000 });
  });

  test('the job creates the platform account from environment variables', async () => {
    const run = (params) =>
      fetch(`${SERVER_URL}/jobs/createPlatformAdmin`, {
        method: 'POST',
        headers: {
          'X-Parse-Application-Id': APP_ID,
          'X-Parse-Master-Key': MASTER_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });
    Object.assign(process.env, {
      RELAY_PLATFORM_USERNAME: 'ops2',
      RELAY_PLATFORM_PASSWORD: 'ops2-pass-123',
      RELAY_PLATFORM_NAME: 'Ops Two',
    });
    try {
      assert.equal((await run({})).status, 200);
      let signedIn = null;
      for (let i = 0; i < 50 && !signedIn; i += 1) {
        signedIn = await Parse.User.logIn('ops2', 'ops2-pass-123').catch(() => null);
        if (!signedIn) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(signedIn, 'the account was created');
      assert.equal((await Parse.Cloud.run('getMyProfile', {}, as(signedIn))).platform, true);
    } finally {
      delete process.env.RELAY_PLATFORM_USERNAME;
      delete process.env.RELAY_PLATFORM_PASSWORD;
      delete process.env.RELAY_PLATFORM_NAME;
    }
  });

  test('only platform staff use the console', async () => {
    const profile = await run('getMyProfile', {}, ops);
    assert.equal(profile.platform, true);
    assert.equal(profile.role, null);
    assert.equal(profile.restaurant, null);
    assert.equal((await run('getMyProfile', {}, s.owner)).platform, false);
    await rejects(run('platformListRestaurants', {}, s.owner), /platform role required/);
    await rejects(run('platformListRestaurants', {}, other.rider), /platform role required/);
    await rejects(
      run('createPlatformAdmin', { username: 'x', password: 'long-enough-1' }, ops),
      /Master key required/,
    );

    const { rows } = await run('platformListRestaurants', {}, ops);
    // Plans (owner's decision 2026-09-30): Basic 100,000, Enterprise 200,000.
    const basic = await planByKey('basic');
    assert.equal(basic.price, 100000);
    assert.deepEqual(basic.limits, { branches: 1, cashier: 2, rider: 5, finance: 0 });
    assert.equal(basic.features.accounting, false);
    assert.equal((await planByKey('enterprise')).price, 200000);
    assert.deepEqual(rows.map((row) => row.code).sort(), [OTHER, CODE]);
    const mine = rows.find((row) => row.code === CODE);
    const theirs = rows.find((row) => row.code === OTHER);
    other.id = theirs.id;
    assert.ok(mine.staff >= 5);
    assert.ok(mine.orders30 > 0);
    assert.equal(theirs.orders30, 1);
    assert.equal(theirs.staff, 2);
    assert.equal(theirs.status, 'trial');
    assert.equal(theirs.monthlyPrice, 100000);
    assert.equal(theirs.priceOverride, null);
    assert.equal(theirs.billingPhone, '0701234567');
    // Size and subscription only: no orders, customers or money.
    assert.deepEqual(
      Object.keys(theirs).filter((key) => /order(?!s30)|customer|cash|revenue/i.test(key)),
      [],
    );
  });

  test('platform settings are checked, saved and shown to restaurants', async () => {
    const base = { currency: 'ugx', trialDays: 21, graceDays: 5 };
    await rejects(run('platformSaveSettings', { ...base, currency: 'shillings' }, ops), /Currency/);
    await rejects(run('platformSaveSettings', { ...base, graceDays: 90 }, ops), /Grace days/);
    await rejects(run('platformSaveSettings', base, s.owner), /platform role required/);
    const saved = await run(
      'platformSaveSettings',
      { ...base, supportContact: 'Relay support 0700 000000' },
      ops,
    );
    assert.equal(saved.currency, 'UGX');
    assert.equal((await run('getAppInfo')).trialDays, 21);
    // Prices are on the plans.
    await rejects(savePlan('basic', { price: -1 }), /Price/);
    await rejects(run('platformSavePlan', { name: 'x' }, s.owner), /platform role required/);
    await savePlan('basic', { price: 60000 });
    await savePlan('enterprise', { price: 150000 });
    // This restaurant is on Enterprise.
    const { restaurant } = await run('getMyProfile', {}, s.owner);
    assert.equal(restaurant.monthlyPrice, 150000);
    assert.equal(restaurant.plan, 'enterprise');
    assert.equal(restaurant.graceDays, 5);
    assert.equal(restaurant.supportContact, 'Relay support 0700 000000');
  });

  test('each restaurant can have its own price, higher or lower', async () => {
    await rejects(update({ priceOverride: -5 }), /Price/);
    await rejects(
      run('platformUpdateRestaurant', { id: 'nope', priceOverride: 1 }, ops),
      /not found/,
    );
    assert.equal((await update({ priceOverride: 35000 })).monthlyPrice, 35000);
    assert.equal((await run('getMyProfile', {}, other.owner)).restaurant.monthlyPrice, 35000);
    // The other restaurant (Enterprise) keeps its plan's price.
    assert.equal((await run('getMyProfile', {}, s.owner)).restaurant.monthlyPrice, 150000);
    assert.equal((await update({ priceOverride: 90000 })).monthlyPrice, 90000);
    // The plan is the platform's to set too; a negotiated price stays.
    assert.equal((await update({ plan: 'enterprise' })).monthlyPrice, 90000);
    await rejects(update({ plan: 'gold' }), /Unknown plan/);
    assert.equal((await update({ plan: 'basic' })).plan, 'basic');
    const back = await update({ priceOverride: null });
    assert.equal(back.priceOverride, null);
    assert.equal(back.monthlyPrice, 60000);
  });

  test('after the trial: grace days keep it working, then only the owner signs in', async () => {
    // Two days past the trial, inside the five grace days.
    const late = await update({ trialEndsAt: when(-2) });
    assert.equal(late.status, 'past_due');
    assert.equal(late.usable, true);
    assert.ok((await run('getOperationalMenu', {}, other.rider)).items.length > 0);

    const expired = await update({ trialEndsAt: when(-10) });
    assert.equal(expired.status, 'expired');
    await rejects(run('getOperationalMenu', {}, other.rider), /subscription has ended/);
    await rejects(run('adminListSetup', {}, other.owner), /subscription has ended/);
    const profile = await run('getMyProfile', {}, other.owner);
    assert.equal(profile.restaurant.status, 'expired');
    assert.equal(profile.restaurant.usable, false);
    assert.equal(profile.role, 'admin');
    // The owner can still sign in (to renew); the first restaurant is unaffected.
    other.owner = await login('owner', PINS.owner, OTHER);
    assert.ok((await run('getOperationalMenu', {}, s.rider)).items.length > 0);

    // Paid by hand until next month: open again.
    const paid = await update({ paidUntil: when(30) });
    assert.equal(paid.status, 'active');
    assert.ok((await run('getOperationalMenu', {}, other.rider)).items.length > 0);
  });

  test('a suspended restaurant cannot sign in or work until it is lifted', async () => {
    const suspended = await update({ suspended: true, note: 'Asked to pause' });
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.note, 'Asked to pause');
    await rejects(login('owner', PINS.owner, OTHER), /suspended.*0700 000000/);
    await rejects(run('getOperationalMenu', {}, other.rider), /suspended/);
    assert.equal((await run('getMyProfile', {}, other.rider)).restaurant.status, 'suspended');
    // Signing in to the first restaurant is unaffected.
    await login('carl', PINS.carl);

    assert.equal((await update({ suspended: false })).status, 'active');
    other.owner = await login('owner', PINS.owner, OTHER);
    assert.ok((await run('getOperationalMenu', {}, other.rider)).items.length > 0);
  });

  test('console changes are audited for platform staff only', async () => {
    const { rows } = await run('platformGetAudit', {}, ops);
    assert.ok(rows.some((row) => row.action === 'platform.settings_saved'));
    const change = rows.find(
      (row) => row.action === 'platform.restaurant_updated' && row.after.suspended === true,
    );
    assert.equal(change.entityId, other.id);
    assert.equal(change.by, 'Relay Ops');
    await rejects(run('platformGetAudit', {}, s.owner), /platform role required/);
  });

  test('Relay applies the security rules for every restaurant, one at a time', async () => {
    await rejects(run('platformApplySecurity', {}, other.owner), /platform role required/);
    await rejects(run('platformApplySecurity', { after: '../x' }, ops), /Bad restaurant/);
    // Another restaurant's order that lost its permissions, and one here.
    const restaurants = await new Parse.Query('Restaurant').ascending('objectId').find(M);
    const broken = [];
    for (const restaurant of restaurants) {
      const order = await new Parse.Query('Order')
        .equalTo('tenant', restaurant)
        .exists('createdBy')
        .first(M);
      if (!order) continue;
      order.setACL(new Parse.ACL());
      await order.save(null, M);
      broken.push(order);
    }
    assert.ok(broken.length >= 2, 'orders in two restaurants');

    const seen = [];
    let step = await run('platformApplySecurity', {}, ops);
    assert.equal(step.total, restaurants.length);
    for (;;) {
      assert.equal(step.failed, '');
      seen.push(step.restaurant.code);
      if (!step.next) break;
      step = await run('platformApplySecurity', { after: step.next }, ops);
      assert.equal(step.total, null, 'counted on the first call only');
    }
    assert.deepEqual(
      seen,
      restaurants.map((r) => r.get('code')),
      'every restaurant once, suspended ones too',
    );
    for (const order of broken) {
      await order.fetch(M);
      const reader = order.get('createdBy').id;
      assert.equal(order.getACL().getReadAccess(reader), true, 'the rider reads it again');
    }
    const { rows } = await run('platformGetAudit', {}, ops);
    assert.equal(rows[0].action, 'platform.security_applied');
    assert.equal(rows[0].after.restaurants, restaurants.length);
  });

  test('Relay sees every restaurant’s errors; fixing one fixes it in each restaurant', async () => {
    const crash = {
      message: 'TypeError: chart failed for report 7c1d2e3f4a',
      where: 'Reports',
      stack: 'at Reports (index.js:9:9)',
      appVersion: 'test',
    };
    await run('reportClientError', crash, s.owner);
    await run(
      'reportClientError',
      { ...crash, message: crash.message.replace('7c1d2e3f4a', '0b9a8c7d6e') },
      other.owner,
    );
    await rejects(run('platformListErrors', {}, other.owner), /platform role required/);
    await rejects(run('platformResolveErrors', { all: true }, s.owner), /platform role required/);

    const list = await run('platformListErrors', {}, ops);
    const entry = list.rows.find((row) => row.message.startsWith('TypeError: chart failed'));
    assert.ok(entry, 'the problem is listed once for all restaurants');
    assert.equal(
      list.rows.filter((row) => row.message.startsWith('TypeError: chart failed')).length,
      1,
    );
    assert.equal(entry.count, 2);
    assert.deepEqual(entry.restaurants.map((r) => r.code).sort(), [CODE, OTHER].sort());
    const mine = list.restaurants.find((r) => r.code === OTHER);
    const filtered = await run('platformListErrors', { restaurant: mine.id }, ops);
    assert.ok(filtered.rows.every((row) => row.restaurants.some((r) => r.id === mine.id)));

    const ownOpen = (user) =>
      run('adminListErrors', {}, user).then((r) =>
        r.rows.filter((row) => row.message.startsWith('TypeError: chart failed')),
      );
    assert.equal((await ownOpen(s.owner)).length, 1);
    assert.equal((await ownOpen(other.owner)).length, 1);

    const done = await run('platformResolveErrors', { ids: [entry.id] }, ops);
    assert.equal(done.resolved, 2);
    // Fixed on each restaurant's own page too, marked as done by Relay.
    assert.equal((await ownOpen(s.owner)).length, 0);
    assert.equal((await ownOpen(other.owner)).length, 0);
    const fixed = (await run('adminListErrors', { state: 'fixed' }, other.owner)).rows.find((row) =>
      row.message.startsWith('TypeError: chart failed'),
    );
    assert.equal(fixed.resolvedByRelay, true);
    const after = await run('platformListErrors', { state: 'fixed' }, ops);
    assert.ok(after.rows.some((row) => row.id === entry.id));
    const { rows } = await run('platformGetAudit', {}, ops);
    assert.equal(rows[0].action, 'platform.errors_resolved');
  });

  test('Relay gives a locked-out owner a new password', async () => {
    await rejects(run('platformResetOwner', { id: other.id }, s.owner), /platform role required/);
    await rejects(
      run('platformResetOwner', { id: other.id, username: 'nobody' }, ops),
      /No owner called/,
    );
    const reset = await run('platformResetOwner', { id: other.id }, ops);
    assert.equal(reset.username, 'owner');
    assert.match(reset.password, /^[a-z2-9]{10}$/);
    // Signed out everywhere; the new password works, the old one does not.
    await rejects(run('getMyProfile', {}, other.owner), /Invalid session token/);
    await rejects(login('owner', PINS.owner, OTHER), /Invalid username\/password/);
    const back = await login('owner', reset.password, OTHER);
    assert.equal((await run('getMyProfile', {}, back)).restaurant.code, OTHER);
    // The first restaurant's owner is untouched.
    assert.equal((await run('getMyProfile', {}, s.owner)).role, 'admin');
    // The owner sets their own password again (later tests use it).
    await Parse.Cloud.run(
      'changeMyPin',
      { oldPin: reset.password, newPin: PINS.owner },
      { sessionToken: back.getSessionToken() },
    );
    other.owner = await login('owner', PINS.owner, OTHER);
    const { rows } = await run('platformGetAudit', {}, ops);
    assert.ok(
      rows.some((row) => row.action === 'platform.owner_reset' && row.entityId === other.id),
    );
  });

  test('Relay’s terms page gets the price, grace days and contact', async () => {
    const info = await run('getAppInfo');
    assert.equal(info.platform.currency, 'UGX');
    assert.ok(info.platform.monthlyPrice > 0);
    assert.equal(typeof info.platform.graceDays, 'number');
    assert.equal(
      typeof (await run('getAppInfo', { restaurant: CODE })).platform.supportContact,
      'string',
    );
  });
});

describe('subscription payments with ioTec (Relay Hosted)', () => {
  const OTHER = 'kato-grill';
  const DAY = 86400000;
  const when = (days) => new Date(Date.now() + days * DAY).toISOString();
  const k = {};
  const pay = (params) => run('startSubscriptionPayment', params, k.owner);
  const check = (id) => run('checkSubscriptionPayment', { id }, k.owner);
  const lastSent = () => [...momo.iotec.values()].at(-1);

  before(async () => {
    k.ops = await Parse.User.logIn('ops', 'ops-pass-123');
    k.owner = await login('owner', PINS.owner, OTHER);
    k.rider = await login('rita', PINS.rita, OTHER);
    const { rows } = await run('platformListRestaurants', {}, k.ops);
    k.id = rows.find((row) => row.code === OTHER).id;
  });

  test('the owner pays with mobile money and the paid month moves on', async () => {
    const billing = await run('getBilling', {}, k.owner);
    assert.equal(billing.payInApp, true);
    assert.equal(billing.restaurant.monthlyPrice, 50000);
    assert.equal(billing.billingPhone, '0701234567');
    assert.deepEqual(billing.payments, []);
    await rejects(run('getBilling', {}, k.rider), /admin role required/);
    await rejects(pay({ months: 2, phone: '0772555111' }), /Choose 1, 3, 6, 12 months/);
    await rejects(pay({ months: 1, phone: '07' }), /mobile money number/);

    const before = billing.restaurant.paidUntil;
    const started = await pay({ months: 3, phone: '0772 555 111' });
    assert.equal(started.status, 'pending');
    assert.equal(started.amount, 150000);
    assert.equal(started.currency, 'UGX');
    const sent = lastSent();
    assert.equal(sent.payer, '0772555111');
    assert.equal(sent.amount, 150000);
    assert.equal(sent.currency, 'UGX');
    assert.equal(sent.walletId, 'wallet-1');
    assert.equal(sent.category, 'MobileMoney');
    assert.match(sent.payerNote, /RelayEats for Kato Grill: .*3 months/);
    assert.match(sent.externalId, /^relay-kato-grill-/);
    // One prompt at a time.
    await rejects(pay({ months: 1, phone: '0772555111' }), /already waiting for approval/);

    const done = await check(started.id);
    assert.equal(done.payment.status, 'paid');
    assert.match(done.payment.reference, /^MPio-/);
    assert.equal(done.restaurant.status, 'active');
    const days = (new Date(done.restaurant.paidUntil) - new Date(before)) / DAY;
    assert.ok(days >= 89 && days <= 92, `moved on ${days} days`);
    // Checking again never adds the months twice.
    const again = await check(started.id);
    assert.equal(again.restaurant.paidUntil, done.restaurant.paidUntil);
    const after = await run('getBilling', {}, k.owner);
    assert.equal(after.billingPhone, '0772555111');
    assert.equal(after.payments[0].status, 'paid');
    assert.equal(after.payments[0].periodEnd, done.restaurant.paidUntil);
  });

  test('a declined payment changes nothing', async () => {
    const { restaurant } = await run('getBilling', {}, k.owner);
    const started = await pay({ months: 1, phone: '0772 000 099' });
    assert.equal((await check(started.id)).payment.status, 'pending');
    const done = await check(started.id);
    assert.equal(done.payment.status, 'failed');
    assert.equal(done.payment.message, 'Payer declined');
    assert.equal(done.restaurant.paidUntil, restaurant.paidUntil);
  });

  test('an expired restaurant’s owner can still pay, which opens it again', async () => {
    const expired = await run(
      'platformUpdateRestaurant',
      { id: k.id, trialEndsAt: when(-40), paidUntil: null },
      k.ops,
    );
    assert.equal(expired.status, 'expired');
    await rejects(run('getOperationalMenu', {}, k.rider), /subscription has ended/);
    const started = await pay({ months: 1, phone: '0772555111' });
    await check(started.id);
    const done = await check(started.id);
    assert.equal(done.payment.status, 'paid');
    assert.equal(done.restaurant.status, 'active');
    const days = (new Date(done.restaurant.paidUntil) - Date.now()) / DAY;
    assert.ok(days >= 27 && days <= 32, `open for ${days} days`);
    assert.ok((await run('getOperationalMenu', {}, k.rider)).items.length > 0);
  });

  test('Relay records a payment received by hand', async () => {
    await rejects(
      run('platformRecordPayment', { id: k.id, months: 2 }, k.owner),
      /platform role required/,
    );
    await rejects(run('platformRecordPayment', { id: k.id, months: 0 }, k.ops), /Months/);
    const { restaurant } = await run('getBilling', {}, k.owner);
    const recorded = await run(
      'platformRecordPayment',
      { id: k.id, months: 2, reference: 'Bank slip 889' },
      k.ops,
    );
    assert.equal(recorded.method, 'manual');
    assert.equal(recorded.status, 'paid');
    assert.equal(recorded.amount, 100000);
    assert.equal(recorded.reference, 'Bank slip 889');
    assert.equal(recorded.periodStart, restaurant.paidUntil);
    const billing = await run('getBilling', {}, k.owner);
    assert.equal(billing.payments[0].method, 'manual');
    assert.equal(billing.restaurant.paidUntil, recorded.periodEnd);

    const { rows } = await run('platformListPayments', { id: k.id }, k.ops);
    assert.ok(rows.length >= 4);
    assert.ok(rows.every((row) => row.restaurant === 'Kato Grill'));
    // The first restaurant sees none of these.
    assert.deepEqual((await run('getBilling', {}, s.owner)).payments, []);
    const audit = await run('platformGetAudit', {}, k.ops);
    const entry = audit.rows.find((row) => row.action === 'platform.payment_recorded');
    assert.equal(entry.entityId, k.id);
    assert.equal(entry.after.reference, 'Bank slip 889');
  });

  test('a year at once costs the annual price; invoices list paid and due', async () => {
    const billing = await run('getBilling', {}, k.owner);
    // The plan cards get each plan's price for a year too.
    const offered = (await run('getPlans', {})).plans;
    assert.ok(offered.every((plan) => plan.annualPrice === plan.price * 10));
    assert.equal(billing.prices[3], 150000);
    // No annual price set: ten months (two months free).
    assert.equal(billing.prices[12], 500000);
    assert.equal(billing.restaurant.annualPrice, 500000);
    const started = await pay({ months: 12, phone: '0772555111' });
    assert.equal(started.amount, 500000);
    await check(started.id);
    const done = await check(started.id);
    assert.equal(done.payment.status, 'paid');
    const days = (new Date(done.payment.periodEnd) - new Date(done.payment.periodStart)) / DAY;
    assert.ok(days >= 364 && days <= 366, `a year is ${days} days`);
    const after = await run('getBilling', {}, k.owner);
    const paid = after.invoices.filter((inv) => inv.status === 'paid');
    assert.ok(paid.length >= 4);
    assert.equal(paid[0].amount, 500000);
    assert.equal(paid[0].months, 12);
    assert.match(paid[0].number, /^INV-KATO-GRILL-/);
    // Far from the end of the period: no unpaid invoice yet.
    assert.ok(!after.invoices.some((inv) => inv.status !== 'paid'));
    await run('platformUpdateRestaurant', { id: k.id, paidUntil: when(3) }, k.ops);
    const due = (await run('getBilling', {}, k.owner)).invoices[0];
    assert.equal(due.status, 'due');
    assert.equal(due.amount, 50000);
    assert.equal(due.paymentId, null);
    await run('platformUpdateRestaurant', { id: k.id, paidUntil: when(-2) }, k.ops);
    assert.equal((await run('getBilling', {}, k.owner)).invoices[0].status, 'overdue');
    // Platform staff can set a plan's annual price.
    const basic = (await run('platformListPlans', {}, k.ops)).plans.find((p) => p.key === 'basic');
    assert.equal(basic.annualSet, false);
    await run('platformSavePlan', { ...basic, annualPrice: 450000 }, k.ops);
    assert.equal((await run('getBilling', {}, k.owner)).prices[12], 450000);
    await rejects(run('platformSavePlan', { ...basic, annualPrice: -1 }, k.ops), /Annual price/);
    await run('platformSavePlan', { ...basic, annualPrice: '' }, k.ops);
    assert.equal((await run('getBilling', {}, k.owner)).prices[12], 500000);
    await run('platformUpdateRestaurant', { id: k.id, paidUntil: when(30) }, k.ops);
  });

  test('owners are reminded before the month ends, once', async () => {
    await run('platformUpdateRestaurant', { id: k.id, paidUntil: when(2) }, k.ops);
    const reminders = async () =>
      (await run('getNotifications', {}, k.owner)).items.filter((n) =>
        /month ends in/.test(n.title),
      );
    const waitFor = async (count) => {
      for (let i = 0; i < 50 && (await reminders()).length < count; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
    };
    await Parse.Cloud.startJob('billing', {});
    await waitFor(1);
    assert.equal((await reminders()).length, 1);
    await Parse.Cloud.startJob('billing', {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await reminders()).length, 1);
    // The first restaurant's owner is not told about another restaurant.
    const theirs = await run('getNotifications', {}, s.owner);
    assert.ok(theirs.items.every((n) => !/month ends in/.test(n.title)));
  });

  test('without the billing job, the owner’s app follows up payments and reminders', async () => {
    process.env.RELAY_BILLING_CHECK_MS = '0';
    try {
      const started = await pay({ months: 1, phone: '0772555111' });
      await run('platformUpdateRestaurant', { id: k.id, paidUntil: when(1) }, k.ops);
      const status = async () =>
        (await run('platformListPayments', { id: k.id }, k.ops)).rows.find(
          (row) => row.id === started.id,
        ).status;
      // Nobody opens the payment again: the owner's notification checks move it on.
      for (let i = 0; i < 50 && (await status()) !== 'paid'; i += 1) {
        await run('getNotifications', {}, k.owner);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await status(), 'paid');
      // And the paid month moved on, so the reminder is for the new end date.
      const { restaurant } = await run('getBilling', {}, k.owner);
      const days = (new Date(restaurant.paidUntil) - Date.now()) / DAY;
      assert.ok(days > 27, `paid for ${days} more days`);
    } finally {
      process.env.RELAY_BILLING_CHECK_MS = '-1';
    }
  });

  test('without ioTec keys the owner is told to contact Relay', async () => {
    const saved = process.env.IOTEC_CLIENT_ID;
    delete process.env.IOTEC_CLIENT_ID;
    try {
      assert.equal((await run('getBilling', {}, k.owner)).payInApp, false);
      await rejects(pay({ months: 1, phone: '0772555111' }), /not switched on yet/);
    } finally {
      process.env.IOTEC_CLIENT_ID = saved;
    }
  });
});

describe('the finance role', () => {
  test('finance reads the owner end but changes nothing sensitive', async () => {
    const created = await run(
      'adminCreateTeamMember',
      { name: 'Fiona Finance', username: 'fiona', pin: '8642', role: 'finance' },
      s.owner,
    );
    assert.match(created.code, /^F-\d{3}$/);
    const fiona = await login('fiona', '8642');
    const profile = await run('getMyProfile', {}, fiona);
    assert.equal(profile.role, 'finance');
    const order = (await run('adminSearchOrders', {}, fiona)).rows[0];
    if (order) {
      const detail = await run('adminGetOrder', { id: order.id }, fiona);
      assert.deepEqual(detail.can, {}, 'finance gets no override actions');
      await rejects(
        run('adminOverrideOrder', { id: order.id, action: 'cancel', reason: 'x' }, fiona),
        /admin role required/,
      );
    }
    await rejects(run('getStock', {}, fiona), /role required/);
    await rejects(run('adminListSetup', {}, fiona), /admin role required/);
    // The owner can move them to another role and back.
    await run('adminChangeRole', { userId: created.id, role: 'cashier' }, s.owner);
    assert.equal((await run('getMyProfile', {}, fiona)).role, 'cashier');
    await run('adminChangeRole', { userId: created.id, role: 'finance' }, s.owner);
    assert.equal((await run('getMyProfile', {}, fiona)).role, 'finance');
    s.fiona = fiona;
  });
});

describe('daily upkeep without scheduled jobs', () => {
  test('the first staff activity of the day runs it once, in the background', async () => {
    const claims = () =>
      new Parse.Query('Counter').startsWith('key', 'upkeep:').find({ useMasterKey: true });
    const settle = async (value) => {
      for (let i = 0; i < 50; i += 1) {
        const rows = await claims();
        if (rows.length && rows[0].get('value') >= value) return rows;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return claims();
    };
    process.env.RELAY_UPKEEP_CHECK_MS = '0';
    const before = momo.ip;
    momo.ip = '203.0.113.77';
    try {
      assert.deepEqual(await claims(), []);
      await run('getNotifications', {}, s.owner);
      const rows = await settle(1);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].get('value'), 1);
      // The server address check ran with it: the owner hears about the change.
      let told = false;
      for (let i = 0; i < 50 && !told; i += 1) {
        const { items } = await run('getNotifications', {}, s.owner);
        told = items.some((n) => /address changed/.test(n.title) && /203\.0\.113\.77/.test(n.body));
        if (!told) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(told, 'the owner was told the server address changed');
      // Later activity the same day does not run it again.
      await run('getNotifications', {}, s.owner);
      const again = await settle(2);
      assert.equal(again[0].get('value'), 2, 'the second attempt found the day taken');
    } finally {
      process.env.RELAY_UPKEEP_CHECK_MS = '-1';
      momo.ip = before;
    }
  });
});

describe('restore from a backup file', () => {
  const M = { useMasterKey: true };
  const CLASSES = [
    'Configuration',
    '_User',
    'MenuCategory',
    'Accompaniment',
    'MenuItem',
    'Customer',
    'Shift',
    'TillPayout',
    'Order',
    'OrderItem',
    'CashHandover',
    'ZReport',
    'AuditLog',
  ];
  const backup = {};
  const exportAll = async () => {
    for (const className of CLASSES) {
      const rows = [];
      let after = null;
      do {
        const page = await run('adminExportData', { className, after }, s.owner);
        rows.push(...page.rows);
        after = page.next;
      } while (after);
      // As the app's backup file holds them (JSON), not as SDK objects.
      backup[className] = JSON.parse(JSON.stringify(rows));
    }
  };
  const restore = async (className, rows = backup[className]) => {
    const total = { created: 0, updated: 0, skipped: 0, pins: [] };
    for (let i = 0; i < rows.length; i += 200) {
      const part = await run(
        'adminRestoreData',
        { className, rows: rows.slice(i, i + 200) },
        s.owner,
      );
      total.created += part.created;
      total.updated += part.updated;
      total.skipped += part.skipped;
      total.pins.push(...(part.pins || []));
    }
    return total;
  };
  const finish = async () => {
    for (let i = 0; i < 50; i += 1) {
      const step = await run('adminRestoreFinish', { counts: {} }, s.owner);
      if (step.done) return step;
    }
    throw new Error('restore did not finish');
  };

  before(async () => {
    await exportAll();
  });

  test('only the owner can restore', async () => {
    await rejects(
      run('adminRestoreData', { className: 'Order', rows: [] }, s.rider),
      /admin role required/,
    );
    await rejects(
      run('adminRestoreData', { className: 'Secret', rows: [] }, s.owner),
      /Unknown kind/,
    );
    await rejects(
      run('adminRestoreData', { className: 'Order', rows: new Array(201).fill({}) }, s.owner),
      /At most 200/,
    );
  });

  test('restoring into the same app changes nothing: every record is still here', async () => {
    for (const className of CLASSES) {
      const result = await restore(className);
      assert.equal(result.created, 0, `${className} created nothing`);
    }
  });

  test('lost records come back, linked, with their original times', async () => {
    // An order with lines, lost.
    const lost = backup.Order.find(
      (row) =>
        row.status === 'DELIVERED' &&
        row.createdBy &&
        backup.OrderItem.some((i) => i.order?.objectId === row.objectId),
    );
    const lines = backup.OrderItem.filter((i) => i.order?.objectId === lost.objectId);
    const order = await new Parse.Query('Order').get(lost.objectId, M);
    const items = await new Parse.Query('OrderItem').equalTo('order', order).find(M);
    await Parse.Object.destroyAll([...items, order], M);

    // As if the backup were old: the order was placed ten days ago.
    const placed = new Date(Date.now() - 10 * 864e5);
    placed.setUTCHours(9, 0, 0, 0);
    const oldRows = backup.Order.map((row) =>
      row.objectId === lost.objectId ? { ...row, createdAt: placed.toISOString() } : row,
    );

    const orders = await restore('Order', oldRows);
    assert.equal(orders.created, 1);
    assert.equal(orders.skipped, backup.Order.length - 1);
    const back = await new Parse.Query('Order').equalTo('restoredFrom', lost.objectId).first(M);
    assert.equal(back.get('orderCode'), lost.orderCode);
    assert.equal(back.get('total'), lost.total);
    assert.equal(back.get('createdBy').id, lost.createdBy.objectId, 'still the same rider');
    assert.equal(back.get('restoredCreatedAt').toISOString(), placed.toISOString());

    const restoredLines = await restore('OrderItem');
    assert.equal(restoredLines.created, lines.length);
    const newLines = await new Parse.Query('OrderItem').equalTo('order', back).find(M);
    assert.equal(newLines.length, lines.length);
    // Sent again: nothing is created twice.
    assert.equal((await restore('Order', oldRows)).created, 0);
    assert.equal((await restore('OrderItem')).created, 0);

    await finish();
    assert.equal(await new Parse.Query('Order').exists('restoreLinks').count(M), 0);
    // Normal access again: the rider who took it can read it.
    const riderName = backup._User.find((u) => u.objectId === lost.createdBy.objectId).username;
    const rider = await login(riderName, PINS[riderName]);
    assert.equal((await new Parse.Query('Order').get(back.id, as(rider))).id, back.id);
    // Reports count it on the day it was placed, not the day it came back.
    const kampala = (date) => new Date(date.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
    const then = kampala(placed);
    const today = kampala(new Date());
    const onThatDay = await run('adminSearchOrders', { from: then, to: then }, s.owner);
    assert.ok(
      onThatDay.rows.some((row) => row.id === back.id),
      'listed on the day it was placed',
    );
    const onToday = await run('adminSearchOrders', { from: today, to: today }, s.owner);
    assert.ok(
      onToday.rows.every((row) => row.id !== back.id),
      'not listed as today',
    );
  });

  test('a lost team member comes back with a new PIN and their role', async () => {
    const created = await run(
      'adminCreateTeamMember',
      { name: 'Lost Rider', username: 'lostrider', pin: '4455', role: 'rider' },
      s.owner,
    );
    await exportAll();
    await Parse.Object.destroyAll([await new Parse.Query(Parse.User).get(created.id, M)], M);
    const team = await restore('_User');
    assert.equal(team.created, 1);
    assert.equal(team.pins.length, 1);
    assert.equal(team.pins[0].username, 'lostrider');
    assert.equal(team.pins[0].role, 'rider');
    assert.match(team.pins[0].pin, /^\d{6}$/);
    await finish();
    const back = await login('lostrider', team.pins[0].pin);
    assert.equal((await run('getMyProfile', {}, back)).role, 'rider');
    // Everyone else was matched, not duplicated.
    assert.equal(team.skipped + team.updated, backup._User.length - 1);
  });
});

describe('plans: Basic and Enterprise (Relay Hosted)', () => {
  const CODE2 = 'basic-bites';
  let owner;
  const member = (username, role) =>
    run('adminCreateTeamMember', { name: username, username, pin: '7777', role }, owner);

  before(async () => {
    await run('signUpRestaurant', {
      restaurantName: 'Basic Bites',
      ownerName: 'Bea',
      username: 'owner',
      pin: PINS.owner,
      phone: '0701 999888',
      email: 'bea@example.com',
    });
    owner = await login('owner', PINS.owner, CODE2);
  });

  test('a new restaurant is on Basic, with no finance or reporting', async () => {
    const profile = await run('getMyProfile', {}, owner);
    assert.deepEqual(profile.features, {
      branches: false,
      finance: false,
      accounting: false,
      reports: false,
      efris: true,
      whatsapp: true,
    });
    const billing = await run('getBilling', {}, owner);
    assert.equal(billing.restaurant.plan, 'basic');
    const { plans } = await run('getPlans', {});
    const price = (key) => plans.find((plan) => plan.key === key).price;
    assert.equal(billing.restaurant.monthlyPrice, price('basic'));
    await rejects(run('listPurchases', {}, owner), /not part of your plan/);
    await rejects(run('getProfitAndLoss', {}, owner), /not part of your plan/);
    await rejects(run('getOperationsReport', {}, owner), /not part of your plan/);
    // The Z-report stays.
    assert.equal((await run('adminGetZReport', {}, owner)).live, true);
  });

  test('Basic allows one branch, 2 cashiers, 5 riders and no finance', async () => {
    await member('cash1', 'cashier');
    await member('cash2', 'cashier');
    await rejects(member('cash3', 'cashier'), /allows 2 cashiers.*Move to a bigger plan/);
    for (const n of [1, 2, 3, 4, 5]) await member(`ride${n}`, 'rider');
    await rejects(member('ride6', 'rider'), /allows 5 riders/);
    await rejects(member('fin1', 'finance'), /no finance role/);
    assert.equal((await run('adminListBranches', {}, owner)).branches.length, 1);
    await rejects(run('adminSaveBranch', { name: 'Second' }, owner), /has 1 branch/);
    // A rider cannot be moved into a full cashier role either.
    const { team } = await run('adminListSetup', {}, owner);
    const rider = team.find((m) => m.username === 'ride1');
    await rejects(
      run('adminChangeRole', { userId: rider.id, role: 'cashier' }, owner),
      /allows 2 cashiers/,
    );
  });

  test('moving up from the trial is paid first; the plan changes once paid', async () => {
    await rejects(
      run('changePlan', { plan: 'enterprise' }, owner),
      /Moving up to Enterprise is paid/,
    );
    const { plans } = await run('getPlans', {});
    const enterprise = plans.find((plan) => plan.key === 'enterprise');
    const billing = await run('getBilling', {}, owner);
    assert.equal(billing.plan.current, 'basic');
    assert.equal(billing.plan.choosePlanWhenPaying, true);
    assert.deepEqual(billing.plan.upgrades, {});
    assert.equal(billing.planPrices.enterprise[1], enterprise.price);
    assert.equal(billing.planPrices.enterprise[12], enterprise.annualPrice);
    const started = await run(
      'startSubscriptionPayment',
      { months: 1, phone: '0772555111', plan: 'enterprise' },
      owner,
    );
    assert.equal(started.amount, enterprise.price);
    assert.equal(started.plan, 'enterprise');
    // Basic until the payment goes through.
    assert.equal((await run('getMyProfile', {}, owner)).restaurant.plan, 'basic');
    await rejects(member('cash3', 'cashier'), /allows 2 cashiers/);
    await run('checkSubscriptionPayment', { id: started.id }, owner);
    const done = await run('checkSubscriptionPayment', { id: started.id }, owner);
    assert.equal(done.payment.status, 'paid');
    assert.equal(done.restaurant.plan, 'enterprise');
    assert.equal(done.restaurant.monthlyPrice, enterprise.price);
    assert.equal((await run('getMyProfile', {}, owner)).features.accounting, true);
    await member('cash3', 'cashier');
    await member('fin1', 'finance');
    await run('adminSaveBranch', { name: 'Second' }, owner);
    assert.ok(Array.isArray((await run('listPurchases', {}, owner)).purchases));
    // Back to Basic only once it fits again.
    await rejects(run('changePlan', { plan: 'basic' }, owner), /Basic allows less than you have/);
    await rejects(run('changePlan', { plan: 'gold' }, owner), /plans on offer/);
  });

  test('while paid: moving up pays the difference; moving down waits for the period end', async () => {
    const DAY = 86400000;
    const ops = await Parse.User.logIn('ops', 'ops-pass-123');
    // (Master key: the tests have used this address's sign-ups for the hour.)
    await Parse.Cloud.run(
      'signUpRestaurant',
      {
        restaurantName: 'Step Cafe',
        ownerName: 'Sam',
        username: 'owner',
        pin: PINS.owner,
        phone: '0701 444555',
        email: 'sam@example.com',
      },
      { useMasterKey: true },
    );
    const step = await login('owner', PINS.owner, 'step-cafe');
    const row = (await run('platformListRestaurants', {}, ops)).rows.find(
      (r) => r.code === 'step-cafe',
    );
    // Paid a month after a trial that has ended: a paid period runs.
    await run(
      'platformUpdateRestaurant',
      { id: row.id, trialEndsAt: new Date(Date.now() - DAY).toISOString() },
      ops,
    );
    await run('platformRecordPayment', { id: row.id, months: 1, reference: 'Cash' }, ops);
    const { plans } = await run('getPlans', {});
    const basic = plans.find((plan) => plan.key === 'basic');
    const enterprise = plans.find((plan) => plan.key === 'enterprise');
    const before = await run('getBilling', {}, step);
    assert.equal(before.restaurant.status, 'active');
    assert.equal(before.plan.choosePlanWhenPaying, false);
    const quote = before.plan.upgrades.enterprise;
    const days = (new Date(before.restaurant.paidUntil) - Date.now()) / DAY;
    const expected = ((enterprise.price - basic.price) * days) / (365 / 12);
    assert.ok(
      quote.amount >= expected && quote.amount <= expected + 100,
      `${quote.amount} for ${days} days`,
    );
    assert.equal(before.plan.upgrades.basic, undefined);
    await rejects(
      run('startSubscriptionPayment', { months: 1, phone: '0772555111', plan: 'enterprise' }, step),
      /use Upgrade/,
    );
    const started = await run(
      'startPlanUpgrade',
      { plan: 'enterprise', phone: '0772555111' },
      step,
    );
    assert.equal(started.amount, quote.amount);
    assert.equal(started.kind, 'upgrade');
    assert.equal((await run('getMyProfile', {}, step)).restaurant.plan, 'basic');
    await run('checkSubscriptionPayment', { id: started.id }, step);
    const done = await run('checkSubscriptionPayment', { id: started.id }, step);
    assert.equal(done.payment.status, 'paid');
    assert.equal(done.restaurant.plan, 'enterprise');
    // The days paid for stay; nothing is added.
    assert.equal(done.restaurant.paidUntil, before.restaurant.paidUntil);
    const after = await run('getBilling', {}, step);
    const invoice = after.invoices.find((inv) => inv.paymentId === started.id);
    assert.equal(invoice.kind, 'upgrade');
    assert.equal(invoice.planName, 'Enterprise');
    assert.equal(invoice.months, 0);
    assert.deepEqual(after.plan.upgrades, {});

    // Moving down: Enterprise stays until the paid period ends.
    const down = await run('changePlan', { plan: 'basic' }, step);
    assert.equal(down.plan.current, 'enterprise');
    assert.equal(down.plan.renewal, 'basic');
    assert.equal(down.plan.renewalFrom, before.restaurant.paidUntil);
    assert.equal(down.restaurant.plan, 'enterprise');
    assert.equal(down.prices[1], basic.price);
    assert.equal((await run('getMyProfile', {}, step)).features.accounting, true);
    // Paying the next period pays Basic; Enterprise still runs until then.
    const next = await run('startSubscriptionPayment', { months: 1, phone: '0772555111' }, step);
    assert.equal(next.amount, basic.price);
    assert.equal(next.plan, 'basic');
    await run('checkSubscriptionPayment', { id: next.id }, step);
    const renewed = await run('checkSubscriptionPayment', { id: next.id }, step);
    assert.equal(renewed.payment.status, 'paid');
    assert.equal(renewed.restaurant.plan, 'enterprise');
    // Changing their mind: keep Enterprise.
    const kept = await run('changePlan', { plan: 'enterprise' }, step);
    assert.equal(kept.plan.renewal, 'enterprise');
    assert.equal(kept.plan.renewalFrom, null);
    await rejects(run('changePlan', { plan: 'enterprise' }, step), /on Enterprise already/);
  });

  test('moving down: the owner keeps one branch and the team within the limits; history stays', async () => {
    // Basic Bites is on Enterprise (paid), with two branches, 3 cashiers and
    // a finance member: more than Basic allows.
    await rejects(
      run('changePlan', { plan: 'basic' }, owner),
      /choose the branch and team that stay/,
    );
    const choices = await run('getDowngradeChoices', { plan: 'basic' }, owner);
    assert.equal(choices.fits, false);
    assert.equal(choices.maxBranches, 1);
    assert.equal(choices.branches.length, 2);
    assert.equal(choices.roles.cashier.max, 2);
    assert.equal(choices.roles.cashier.members.length, 3);
    assert.equal(choices.roles.finance.max, 0);
    const main = choices.branches.find((b) => b.main);
    const second = choices.branches.find((b) => !b.main);
    const id = (username) =>
      [...choices.roles.cashier.members, ...choices.roles.rider.members].find(
        (m) => m.username === username,
      ).id;
    const riders = choices.roles.rider.members.map((m) => m.id);
    await rejects(
      run(
        'changePlan',
        {
          plan: 'basic',
          keep: {
            branches: [main.id],
            members: [id('cash1'), id('cash2'), id('cash3'), ...riders],
          },
        },
        owner,
      ),
      /allows 2 cashiers/,
    );
    await rejects(
      run(
        'changePlan',
        { plan: 'basic', keep: { branches: [main.id, second.id], members: [] } },
        owner,
      ),
      /allows 1 branch/,
    );
    const billing = await run(
      'changePlan',
      {
        plan: 'basic',
        keep: { branches: [main.id], members: [id('cash1'), id('cash2'), ...riders] },
      },
      owner,
    );
    assert.equal(billing.plan.current, 'enterprise');
    assert.equal(billing.plan.renewal, 'basic');
    assert.deepEqual(billing.plan.pending.keepBranches, [main.name]);
    assert.deepEqual(billing.plan.pending.closeBranches, [second.name]);
    assert.deepEqual(billing.plan.pending.deactivate.sort(), ['cash3', 'fin1']);
    // Nothing changes before the date.
    assert.equal((await run('adminListBranches', {}, owner)).branches.length, 2);

    // The date comes (set directly for the test): the next request applies it.
    const row = await new Parse.Query('Restaurant')
      .equalTo('code', CODE2)
      .first({ useMasterKey: true });
    row.set('nextPlanFrom', new Date(Date.now() - 60000));
    await row.save(null, { useMasterKey: true });
    // A console change clears the server's short restaurant cache.
    await run(
      'platformUpdateRestaurant',
      { id: row.id, note: 'Moving to Basic' },
      await Parse.User.logIn('ops', 'ops-pass-123'),
    );
    let profile;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      profile = await run('getMyProfile', {}, owner);
      const branches = (await run('adminListBranches', {}, owner)).branches;
      if (branches.some((b) => !b.active)) break;
    }
    assert.equal(profile.restaurant.plan, 'basic');
    assert.equal(profile.features.accounting, false);
    const branches = (await run('adminListBranches', {}, owner)).branches;
    assert.equal(branches.find((b) => b.id === second.id).active, false);
    assert.equal(branches.find((b) => b.id === main.id).active, true);
    // Closed branches stay in the owner's filters, for their history.
    assert.ok((await run('getBranches', {}, owner)).branches.some((b) => b.id === second.id));
    const { team } = await run('adminListSetup', {}, owner);
    const active = (username) => team.find((m) => m.username === username).active;
    assert.equal(active('cash3'), false);
    assert.equal(active('fin1'), false);
    assert.equal(active('cash1'), true);
    assert.equal(active('ride5'), true);
    await rejects(run('getMyProfile', {}, await login('cash3', '7777', CODE2)), /inactive/);
    const { items } = await run('getNotifications', {}, owner);
    assert.ok(items.some((n) => /You are now on Basic/.test(n.title)));
    const billingAfter = await run('getBilling', {}, owner);
    assert.equal(billingAfter.plan.current, 'basic');
    assert.equal(billingAfter.plan.pending, null);
  });

  test('platform staff create a plan with its own limits and parts of the app', async () => {
    const ops = await Parse.User.logIn('ops', 'ops-pass-123');
    await rejects(
      run('platformSavePlan', { name: 'Growth', price: 150000, limits: { branches: 0 } }, ops),
      /at least 1 branch/,
    );
    await rejects(
      run('platformSavePlan', { name: 'Growth', price: 150000, limits: { rider: 2.5 } }, ops),
      /rider limit/,
    );
    const growth = await run(
      'platformSavePlan',
      {
        name: 'Growth',
        description: 'Two outlets with finance',
        price: 150000,
        limits: { branches: 2, cashier: 4, rider: 10, finance: 1 },
        features: { branches: true, finance: true, accounting: true, reports: false },
        active: true,
      },
      ops,
    );
    assert.equal(growth.key, 'growth');
    assert.equal(growth.features.reports, false);
    assert.equal(growth.features.efris, false, 'what is not ticked is left out');
    await rejects(
      run('platformSavePlan', { name: 'growth', price: 1 }, ops),
      /already a plan called/,
    );
    const listed = await run('platformListPlans', {}, ops);
    assert.ok(listed.features.includes('whatsapp'));
    assert.ok(listed.plans.some((plan) => plan.key === 'growth' && plan.restaurants === 0));
    assert.ok((await run('getPlans', {})).plans.some((plan) => plan.key === 'growth'));

    // A restaurant moves to it: its limits and parts of the app follow.
    const code = 'growth-grill';
    await run('signUpRestaurant', {
      restaurantName: 'Growth Grill',
      ownerName: 'Gil',
      username: 'owner',
      pin: PINS.owner,
      phone: '0701 555444',
      email: 'gil@example.com',
      plan: 'growth',
    });
    const owner = await login('owner', PINS.owner, code);
    const profile = await run('getMyProfile', {}, owner);
    assert.equal(profile.restaurant.plan, 'growth');
    assert.equal(profile.restaurant.monthlyPrice, 150000);
    assert.equal(profile.features.accounting, true);
    assert.equal(profile.features.reports, false);
    assert.equal(profile.features.efris, false);
    await rejects(run('getOperationsReport', {}, owner), /not part of your plan/);
    await run(
      'adminCreateTeamMember',
      { name: 'F', username: 'fin1', pin: '7777', role: 'finance' },
      owner,
    );
    await rejects(
      run(
        'adminCreateTeamMember',
        { name: 'F', username: 'fin2', pin: '7777', role: 'finance' },
        owner,
      ),
      /allows 1 finance/,
    );
    await run('adminListBranches', {}, owner);
    await run('adminSaveBranch', { name: 'Second' }, owner);
    await rejects(run('adminSaveBranch', { name: 'Third' }, owner), /has 2 branches/);

    // Changing the plan changes what its restaurants get straight away.
    await run(
      'platformSavePlan',
      { ...growth, features: { ...growth.features, reports: true } },
      ops,
    );
    assert.ok(Array.isArray((await run('getOperationsReport', {}, owner)).items));
    // Taken off offer: not offered to new restaurants; its restaurants stay on it.
    await run('platformSavePlan', { ...growth, active: false }, ops);
    assert.ok(!(await run('getPlans', {})).plans.some((plan) => plan.key === 'growth'));
    assert.equal((await run('getMyProfile', {}, owner)).restaurant.plan, 'growth');
  });
});

describe('one WhatsApp sender for every restaurant (Relay Hosted)', () => {
  let ops;
  before(async () => {
    ops = await Parse.User.logIn('ops', 'ops-pass-123');
  });
  after(async () => {
    await run('platformSaveWhatsApp', { enabled: false }, ops);
    await run('adminSaveWhatsAppSettings', { enabled: false, recipients: [] }, s.owner);
  });

  test('platform staff connect it; owners only choose the numbers', async () => {
    assert.equal((await run('adminGetWhatsAppSettings', {}, s.owner)).managed, false);
    await rejects(
      run('platformSaveWhatsApp', { enabled: true, phoneNumberId: '5550001' }, ops),
      /phone number ID and the access token/,
    );
    await rejects(
      run('platformSaveWhatsApp', { enabled: true, phoneNumberId: '5550001', token: 't' }, ops),
      /approved template/,
    );
    const saved = await run(
      'platformSaveWhatsApp',
      {
        enabled: true,
        phoneNumberId: '5550001',
        token: 'wa-token',
        templateName: 'relay_summary',
        displayNumber: '+256 700 000000',
      },
      ops,
    );
    assert.equal(saved.tokenSet, true);
    assert.equal(JSON.stringify(saved).includes('wa-token'), false);
    await rejects(
      run('platformSaveWhatsApp', { enabled: false }, s.owner),
      /platform role required/,
    );

    const page = await run('adminGetWhatsAppSettings', {}, s.owner);
    assert.equal(page.managed, true);
    assert.equal(page.sender, '+256 700 000000');
    await rejects(
      run('adminSaveWhatsAppSettings', { enabled: true, recipients: [] }, s.owner),
      /at least one number/,
    );
    await run('adminSaveWhatsAppSettings', { enabled: true, recipients: ['0772 000111'] }, s.owner);
    whatsapp.messages.length = 0;
    assert.equal((await run('adminTestWhatsApp', {}, s.owner)).sent, 1);
    const [message] = whatsapp.messages;
    assert.equal(message.phoneId, '5550001');
    assert.equal(message.to, '256772000111');
    assert.equal(message.template.name, 'relay_summary');
    const name = (await run('getMyProfile', {}, s.owner)).config.restaurantName;
    assert.ok(message.template.components[0].parameters[0].text.startsWith(name));

    whatsapp.messages.length = 0;
    assert.equal((await run('platformTestWhatsApp', { to: '0701 222333' }, ops)).sent, 1);
    assert.equal(whatsapp.messages[0].to, '256701222333');
    await rejects(run('platformTestWhatsApp', { to: 'nobody' }, ops), /number to send/);
  });
});

describe('owner email: password reset and emails from Relay (Relay Hosted)', () => {
  let ops;
  const CODE3 = 'mail-cafe';
  const M = { useMasterKey: true };
  before(async () => {
    ops = await Parse.User.logIn('ops', 'ops-pass-123');
  });

  test('platform staff set up the email service and test it', async () => {
    await rejects(run('platformSaveEmail', { provider: 'pigeon' }, ops), /Choose Resend or Brevo/);
    await rejects(run('platformSaveEmail', { from: 'nope' }, ops), /not an email address/);
    await rejects(run('platformSaveEmail', { appUrl: 'relay.app' }, ops), /https/);
    const saved = await run(
      'platformSaveEmail',
      {
        provider: 'resend',
        apiKey: 'email-key',
        from: 'no-reply@relay.example',
        fromName: 'Relay',
        appUrl: 'https://relay.example/',
      },
      ops,
    );
    assert.equal(saved.ready, true);
    assert.equal(saved.appUrl, 'https://relay.example');
    assert.equal(JSON.stringify(saved).includes('email-key'), false, 'the key is never sent back');
    mailbox.length = 0;
    assert.equal((await run('platformTestEmail', { to: 'ops@relay.example' }, ops)).sent, 1);
    assert.equal(mailbox[0].to, 'ops@relay.example');
    // Brevo works the same way.
    await run('platformSaveEmail', { provider: 'brevo' }, ops);
    await run('platformTestEmail', { to: 'ops@relay.example' }, ops);
    assert.equal(mailbox.length, 2);
    await run('platformSaveEmail', { provider: 'resend' }, ops);
    await rejects(run('platformGetEmail', {}, s.owner), /platform role required/);
  });

  test('sign-up needs the owner email and sends a welcome', async () => {
    const base = {
      restaurantName: 'Mail Cafe',
      ownerName: 'Mary',
      username: 'owner',
      pin: PINS.owner,
      phone: '0701 111222',
    };
    await rejects(run('signUpRestaurant', base), /Enter your email/);
    await rejects(run('signUpRestaurant', { ...base, email: 'mary@' }), /Enter your email/);
    mailbox.length = 0;
    // (Master key: the tests have used this address's sign-ups for the hour.)
    await Parse.Cloud.run('signUpRestaurant', { ...base, email: 'Mary@Example.com' }, M);
    for (let i = 0; i < 20 && !mailbox.length; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mailbox[0].to, 'mary@example.com');
    assert.match(mailbox[0].subject, /Welcome to RelayEats, Mail Cafe/);
    assert.match(mailbox[0].text, /Restaurant code: mail-cafe/);
    const owner = await login('owner', PINS.owner, CODE3);
    assert.equal((await run('getMyProfile', {}, owner)).restaurant.ownerEmail, 'mary@example.com');
    const listed = (await run('platformListRestaurants', {}, ops)).rows.find(
      (row) => row.code === CODE3,
    );
    assert.equal(listed.ownerEmail, 'mary@example.com');
  });

  test('a forgotten owner password is reset through an emailed link', async () => {
    mailbox.length = 0;
    // A wrong email gets the same answer and no email.
    assert.deepEqual(
      await run('requestOwnerReset', { code: CODE3, email: 'someone@example.com' }),
      { sent: true },
    );
    assert.equal(mailbox.length, 0);
    await run('requestOwnerReset', { code: CODE3, email: 'MARY@example.com' });
    assert.equal(mailbox.length, 1);
    const link = mailbox[0].text.match(/https:\/\/relay\.example\/\?reset=([a-f0-9]{64})/);
    assert.ok(link, 'the email has the reset link');
    const token = link[1];
    // Only the hash is kept.
    const row = await new Parse.Query('Restaurant').equalTo('code', CODE3).first(M);
    assert.notEqual(row.get('resetTokenHash'), token);
    await rejects(run('completeOwnerReset', { token, password: '123' }), /at least 6/);
    await rejects(
      run('completeOwnerReset', { token: 'f'.repeat(64), password: 'new-pass-9' }),
      /expired or was already used/,
    );
    const done = await run('completeOwnerReset', { token, password: 'new-pass-9' });
    assert.deepEqual(done, { code: CODE3, username: 'owner' });
    await rejects(login('owner', PINS.owner, CODE3), /Invalid username\/password/);
    const owner = await login('owner', 'new-pass-9', CODE3);
    assert.equal((await run('getMyProfile', {}, owner)).role, 'admin');
    await rejects(
      run('completeOwnerReset', { token, password: 'again-pass-9' }),
      /expired or was already used/,
    );
  });

  test('the owner and platform staff can change the email', async () => {
    const owner = await login('owner', 'new-pass-9', CODE3);
    await rejects(run('updateOwnerEmail', { email: 'bad' }, owner), /valid email/);
    await run('updateOwnerEmail', { email: 'mary.new@example.com' }, owner);
    assert.equal(
      (await run('getMyProfile', {}, owner)).restaurant.ownerEmail,
      'mary.new@example.com',
    );
    const row = (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.code === CODE3);
    await rejects(
      run('platformUpdateRestaurant', { id: row.id, ownerEmail: 'x@' }, ops),
      /not an email address/,
    );
    const updated = await run(
      'platformUpdateRestaurant',
      { id: row.id, ownerEmail: 'MARY@cafe.example' },
      ops,
    );
    assert.equal(updated.ownerEmail, 'mary@cafe.example');
  });

  test('billing emails: 7 and 3 days before, the last day, overdue, closing, paid', async () => {
    const row = (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.code === CODE3);
    const owner = await login('owner', 'new-pass-9', CODE3);
    const { graceDays } = (await run('getBilling', {}, owner)).restaurant;
    assert.ok(graceDays >= 3, 'the test needs a few grace days');
    const DAY = 86400000;
    const when = (days) => new Date(Date.now() + days * DAY).toISOString();
    const mine = () => mailbox.filter((m) => m.to === 'mary@cafe.example');
    // Runs the billing job twice: a stage's email goes out once.
    const remindAt = async (paidUntil, count) => {
      await run('platformUpdateRestaurant', { id: row.id, trialEndsAt: when(-60), paidUntil }, ops);
      for (const _ of [1, 2]) {
        await Parse.Cloud.startJob('billing', {});
        for (let i = 0; i < 50 && mine().length < count; i += 1)
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(mine().length, count);
      return mine().at(-1);
    };
    mailbox.length = 0;
    let mail = await remindAt(when(20), 0);
    mail = await remindAt(when(6), 1);
    assert.equal(mail.subject, 'Mail Cafe: Your paid period ends in 6 days');
    assert.match(mail.text, /A month: UGX [\d,]+/);
    assert.match(mail.text, /INV-MAIL-CAFE-\d{8}/);
    assert.match(mail.text, /https:\/\/relay\.example\/admin\/site\/billing/);
    assert.match(mail.html, /<!doctype html>/);
    assert.equal(mail.html.includes('{{{'), false, 'every variable is filled in');
    mail = await remindAt(when(2.5), 2);
    assert.match(mail.subject, /ends in 3 days/);
    mail = await remindAt(when(0.5), 3);
    assert.match(mail.subject, /Your paid period ends today/);
    mail = await remindAt(when(-1), 4);
    assert.match(mail.subject, /Payment overdue: RelayEats closes in \d+ days/);
    assert.match(mail.text, /The app keeps working until/);
    mail = await remindAt(when(-(graceDays - 0.5)), 5);
    assert.match(mail.subject, /RelayEats closes tomorrow/);

    // Platform staff point a kind at their own Resend template.
    await rejects(
      run('platformSaveEmail', { templates: { billing_overdue: 'not ok!' } }, ops),
      /Payment overdue: use the Resend template ID or alias/,
    );
    await rejects(
      run('platformSaveEmail', { provider: 'brevo', templates: { welcome: 'abc' } }, ops),
      /Welcome: a Brevo template is its number/,
    );
    const saved = await run(
      'platformSaveEmail',
      { templates: { billing_overdue: 'relay-overdue', nonsense: 'x' } },
      ops,
    );
    assert.equal(saved.templates.billing_overdue, 'relay-overdue');
    assert.equal(saved.templates.welcome, '');
    assert.equal(saved.templates.nonsense, undefined);
    assert.ok(
      saved.kinds.find((k) => k.key === 'payment_received').variables.includes('PAID_UNTIL'),
    );
    const copy = await run('platformEmailTemplate', { kind: 'billing_overdue' }, ops);
    assert.match(copy.html, /\{\{\{CLOSES_ON\}\}\}/);
    assert.match(copy.brevoHtml, /\{\{ params\.CLOSES_ON \}\}/);
    await rejects(
      run('platformEmailTemplate', { kind: 'billing_overdue' }, owner),
      /platform role/,
    );
    mailbox.length = 0;
    await run('platformTestEmail', { to: 'ops@relay.example', kind: 'billing_overdue' }, ops);
    assert.deepEqual(mailbox[0].template.id, 'relay-overdue');
    assert.equal(mailbox[0].template.variables.CLOSES_ON, '22 October 2026');
    assert.equal(mailbox[0].html, undefined, 'the template holds the body');
    // A template ID typed in the console is tried before it is saved.
    await run(
      'platformTestEmail',
      { to: 'ops@relay.example', kind: 'welcome', template: 'relay-welcome' },
      ops,
    );
    assert.equal(mailbox[1].template.id, 'relay-welcome');
    assert.equal((await run('platformGetEmail', {}, ops)).templates.welcome, '');
    await rejects(
      run('platformTestEmail', { to: 'ops@relay.example', kind: 'welcome', template: 'no!' }, ops),
      /Resend template ID or alias/,
    );
    // The next reminder goes through the template, with this restaurant's values.
    await remindAt(when(-2), 1);
    assert.equal(mine()[0].template.id, 'relay-overdue');
    assert.equal(mine()[0].template.variables.RESTAURANT_NAME, 'Mail Cafe');
    await run('platformSaveEmail', { templates: {} }, ops);

    // A payment received sends the receipt.
    mailbox.length = 0;
    await run('platformRecordPayment', { id: row.id, months: 12, reference: 'Bank slip 77' }, ops);
    for (let i = 0; i < 50 && !mine().length; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mine()[0].subject, 'Mail Cafe: payment received, thank you');
    assert.match(mine()[0].text, /Paid for: 1 year/);
    assert.match(mine()[0].text, /Reference: Bank slip 77/);
    assert.match(mine()[0].text, /Invoice: INV-MAIL-CAFE-/);
  });

  test('platform staff email owners: audience, test, send, history', async () => {
    const owner = await login('owner', 'new-pass-9', CODE3);
    await rejects(run('platformBroadcastPreview', {}, owner), /platform role required/);
    await rejects(
      run('platformSendBroadcast', { subject: 'Hi', message: 'x'.repeat(20) }, ops),
      /Subject: 3 to 150/,
    );
    await rejects(
      run('platformSendBroadcast', { subject: 'Hello', message: 'short' }, ops),
      /Message: 10 to 5,000/,
    );
    const all = await run('platformBroadcastPreview', { status: 'all' }, ops);
    assert.ok(all.count >= 3, `reaches ${all.count}`);
    const paid = await run('platformBroadcastPreview', { status: 'active' }, ops);
    assert.ok(paid.count >= 1 && paid.count < all.count);
    const draft = {
      subject: 'News for {restaurant}',
      message: 'Hello {owner}, prices stay the same next year.\nThank you.',
      status: 'all',
    };
    mailbox.length = 0;
    const test = await run('platformSendBroadcast', { ...draft, testTo: 'ops@relay.example' }, ops);
    assert.equal(test.sent, 1);
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].to, 'ops@relay.example');
    assert.match(mailbox[0].subject, /^News for /);
    assert.equal(mailbox[0].html.includes('{{{'), false);
    assert.equal(
      (await run('platformListBroadcasts', {}, ops)).rows.length,
      0,
      'a test is not kept',
    );

    mailbox.length = 0;
    const started = await run('platformSendBroadcast', draft, ops);
    assert.equal(started.total, all.count);
    let row;
    for (let i = 0; i < 100; i += 1) {
      row = (await run('platformListBroadcasts', {}, ops)).rows.find((r) => r.id === started.id);
      if (row.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(row.state, 'done');
    assert.equal(row.sent, all.count);
    assert.equal(row.failed, 0);
    assert.equal(mailbox.length, all.count);
    const mary = mailbox.find((m) => m.to === 'mary@cafe.example');
    assert.equal(mary.subject, 'News for Mail Cafe');
    assert.match(mary.text, /Hello Mary, prices stay the same next year\.\nThank you\./);
    const audit = await run('platformGetAudit', {}, ops);
    assert.ok(audit.rows.some((r) => r.action === 'platform.broadcast_sent'));
  });

  test('the revenue dashboard adds up for platform staff only', async () => {
    const owner = await login('owner', 'new-pass-9', CODE3);
    await rejects(run('platformRevenue', {}, owner), /platform role required/);
    const revenue = await run('platformRevenue', {}, ops);
    const { rows } = await run('platformListRestaurants', {}, ops);
    const payments = (await run('platformListPayments', {}, ops)).rows.filter(
      (p) => p.status === 'paid',
    );
    assert.equal(revenue.months.length, 12);
    assert.equal(revenue.restaurants, rows.length);
    assert.equal(
      Object.values(revenue.status).reduce((a, b) => a + b, 0),
      rows.length,
    );
    const total = payments.reduce((sum, p) => sum + p.amount, 0);
    assert.equal(revenue.allTime, total);
    // Every payment in the tests was made this month.
    assert.equal(revenue.thisMonth, total);
    assert.equal(revenue.months[11].amount, total);
    assert.equal(revenue.months[11].payments, payments.length);
    const paying = rows.filter((r) => r.status === 'active' || r.status === 'past_due');
    assert.equal(
      revenue.mrr,
      paying.reduce((sum, r) => sum + r.monthlyPrice, 0),
    );
    assert.equal(
      revenue.plans.reduce((sum, plan) => sum + plan.restaurants, 0),
      paying.length,
    );
    const paidIds = new Set(payments.map((p) => p.restaurantId));
    assert.equal(revenue.conversion.converted, paidIds.size);
    assert.ok(revenue.conversion.eligible >= paidIds.size);
    assert.equal(
      revenue.dueIn30Days,
      revenue.upcoming.reduce((sum, row) => sum + row.amount, 0),
    );
    for (const row of revenue.upcoming)
      assert.ok(new Date(row.dueAt) - Date.now() <= 30 * 86400000);
  });
});

describe('sign-up codes: pay now with a discount or referral (Relay Hosted)', () => {
  let ops;
  const M = { useMasterKey: true };
  const DAY = 86400000;
  const base = (code, name) => ({
    restaurantName: name,
    code,
    ownerName: 'Pat',
    username: 'owner',
    pin: PINS.owner,
    phone: '0701 222333',
    email: `${code}@example.com`,
  });
  const listed = async () => run('platformListRestaurants', {}, ops);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  before(async () => {
    ops = await Parse.User.logIn('ops', 'ops-pass-123');
  });

  test('platform staff make discount codes and set the referral terms', async () => {
    const save = (params) => run('platformSaveDiscountCode', params, ops);
    await rejects(save({ code: 'x', kind: 'percent', value: 10 }), /Code: 3 to 30/);
    await rejects(save({ code: 'BIG', kind: 'percent', value: 95 }), /1 to 90/);
    await rejects(save({ code: 'mail-cafe', kind: 'percent', value: 10 }), /restaurant’s code/);
    const saved = await save({ code: 'launch20', kind: 'percent', value: 20, maxUses: 1 });
    assert.equal(saved.code, 'LAUNCH20');
    assert.equal(saved.used, 0);
    await rejects(save({ code: 'LAUNCH20', kind: 'percent', value: 20 }), /already exists/);
    await save({
      code: 'OLD10',
      kind: 'percent',
      value: 10,
      expiresAt: new Date(Date.now() - DAY).toISOString(),
    });
    await rejects(
      run('platformListDiscountCodes', {}, await login('owner', 'new-pass-9', 'mail-cafe')),
      /platform role required/,
    );
    const { settings: s } = await listed();
    const terms = {
      currency: s.currency,
      trialDays: s.trialDays,
      graceDays: s.graceDays,
      supportContact: s.supportContact,
    };
    await rejects(
      run('platformSaveSettings', { ...terms, referralPercent: 80 }, ops),
      /Referral discount/,
    );
    const next = await run(
      'platformSaveSettings',
      { ...terms, referralPercent: 15, referralMonths: 2 },
      ops,
    );
    assert.equal(next.referralPercent, 15);
    assert.equal(next.referralMonths, 2);
  });

  test('the sign-up page checks a code; codes only work when paying now', async () => {
    const plan = (await listed()).settings.plans.find((p) => p.active);
    const check = await Parse.Cloud.run(
      'checkSignupCode',
      { code: ' launch20 ', plan: plan.key },
      M,
    );
    assert.equal(check.code, 'LAUNCH20');
    assert.equal(check.type, 'code');
    assert.equal(check.prices[1].discount, Math.round(plan.price * 0.2));
    assert.equal(check.prices[12].list, plan.annualPrice);
    assert.match(check.label, /20% off your first payment/);
    await rejects(Parse.Cloud.run('checkSignupCode', { code: 'OLD10' }, M), /expired/);
    await rejects(Parse.Cloud.run('checkSignupCode', { code: 'NOPE' }, M), /not valid/);
    const referral = await Parse.Cloud.run('checkSignupCode', { code: 'Mail Cafe' }, M);
    assert.equal(referral.type, 'referral');
    assert.equal(referral.code, 'mail-cafe');
    assert.equal(referral.referrerName, 'Mail Cafe');
    assert.match(referral.label, /15% off/);
    await rejects(
      Parse.Cloud.run(
        'signUpRestaurant',
        { ...base('code-cafe', 'Code Cafe'), offerCode: 'LAUNCH20' },
        M,
      ),
      /Codes apply when you pay now/,
    );
    await rejects(
      Parse.Cloud.run(
        'signUpRestaurant',
        { ...base('code-cafe', 'Code Cafe'), start: 'pay', offerCode: 'NOPE' },
        M,
      ),
      /not valid/,
    );
  });

  test('paying now with a code: closed until paid, then the code is used once', async () => {
    await Parse.Cloud.run(
      'signUpRestaurant',
      { ...base('code-cafe', 'Code Cafe'), start: 'pay', offerCode: 'launch20' },
      M,
    );
    const owner = await login('owner', PINS.owner, 'code-cafe');
    const { restaurant } = await run('getMyProfile', {}, owner);
    assert.equal(restaurant.usable, false);
    assert.equal(restaurant.payFirst, true);
    assert.equal(restaurant.offerCode, 'LAUNCH20');
    await rejects(run('getDashboard', {}, owner), /subscription/);
    const billing = await run('getBilling', {}, owner);
    assert.equal(billing.offer.code, 'LAUNCH20');
    assert.equal(
      billing.prices[1],
      billing.listPrices[1] - Math.round(billing.listPrices[1] * 0.2),
    );
    assert.equal(billing.invoices[0].status, 'due');
    assert.equal(billing.invoices[0].amount, billing.prices[1]);
    assert.equal(billing.invoices[0].discountCode, 'LAUNCH20');

    const started = await run(
      'startSubscriptionPayment',
      { months: 1, phone: '0772555111' },
      owner,
    );
    assert.equal(started.amount, billing.prices[1]);
    assert.equal(started.discountCode, 'LAUNCH20');
    await run('checkSubscriptionPayment', { id: started.id }, owner);
    const done = await run('checkSubscriptionPayment', { id: started.id }, owner);
    assert.equal(done.payment.status, 'paid');
    assert.equal(done.restaurant.status, 'active');
    assert.equal(done.restaurant.payFirst, false);
    const after = await run('getBilling', {}, owner);
    assert.equal(after.offer, null);
    assert.equal(after.prices[1], after.listPrices[1]);
    const invoice = after.invoices.find((inv) => inv.status === 'paid');
    assert.equal(invoice.discountCode, 'LAUNCH20');
    assert.equal(invoice.discount, billing.listPrices[1] - billing.prices[1]);

    let code;
    for (let i = 0; i < 50; i += 1) {
      code = (await run('platformListDiscountCodes', {}, ops)).rows.find(
        (row) => row.code === 'LAUNCH20',
      );
      if (code.used === 1) break;
      await wait(100);
    }
    assert.equal(code.used, 1);
    assert.equal(code.given, invoice.discount);
    // One use only: used up for the next restaurant.
    await rejects(Parse.Cloud.run('checkSignupCode', { code: 'LAUNCH20' }, M), /used up/);
  });

  test('a referral: the new restaurant saves; the referrer gets free months once it pays', async () => {
    const mailCafe = async () => (await listed()).rows.find((r) => r.code === 'mail-cafe');
    const before = new Date((await mailCafe()).paidUntil);
    await Parse.Cloud.run(
      'signUpRestaurant',
      { ...base('ref-cafe', 'Ref Cafe'), start: 'pay', offerCode: 'mail-cafe' },
      M,
    );
    const owner = await login('owner', PINS.owner, 'ref-cafe');
    const billing = await run('getBilling', {}, owner);
    assert.equal(billing.offer.type, 'referral');
    assert.equal(billing.offer.referrerName, 'Mail Cafe');
    assert.equal(
      billing.prices[3],
      billing.listPrices[3] - Math.round(billing.listPrices[3] * 0.15),
    );
    // A payment recorded by hand gets the same price.
    mailbox.length = 0;
    const row = (await listed()).rows.find((r) => r.code === 'ref-cafe');
    const paid = await run(
      'platformRecordPayment',
      { id: row.id, months: 3, reference: 'Cash at the office' },
      ops,
    );
    assert.equal(paid.amount, billing.prices[3]);
    assert.equal(paid.discountCode, 'mail-cafe');
    let after = before;
    for (let i = 0; i < 50 && after <= before; i += 1) {
      await wait(100);
      after = new Date((await mailCafe()).paidUntil);
    }
    const days = (after - before) / DAY;
    assert.ok(days >= 58 && days <= 63, `credited ${days} days`);
    const referrer = await login('owner', 'new-pass-9', 'mail-cafe');
    const { items } = await run('getNotifications', {}, referrer);
    assert.ok(items.some((n) => /2 months free: Ref Cafe joined/.test(n.title)));
    for (let i = 0; i < 50 && !mailbox.some((m) => /referral/.test(m.subject)); i += 1)
      await wait(100);
    const email = mailbox.find((m) => /referral/.test(m.subject));
    assert.equal(email.to, 'mary@cafe.example');
    assert.match(email.text, /Ref Cafe joined RelayEats with your restaurant code/);
    // Once only, even if a second payment comes.
    await run('platformRecordPayment', { id: row.id, months: 1 }, ops);
    await wait(500);
    assert.equal(new Date((await mailCafe()).paidUntil).getTime(), after.getTime());
  });

  test('the free trial instead: the code no longer applies', async () => {
    await Parse.Cloud.run(
      'signUpRestaurant',
      { ...base('trial-cafe', 'Trial Cafe'), start: 'pay', offerCode: 'mail-cafe' },
      M,
    );
    const owner = await login('owner', PINS.owner, 'trial-cafe');
    await run('startTrialInstead', {}, owner);
    const { restaurant } = await run('getMyProfile', {}, owner);
    assert.equal(restaurant.usable, true);
    assert.equal(restaurant.status, 'trial');
    assert.equal(restaurant.payFirst, false);
    assert.equal((await run('getBilling', {}, owner)).offer, null);
    await rejects(run('startTrialInstead', {}, owner), /not waiting for its first payment/);
    // The referrer sees who used its code.
    const referrer = await login('owner', 'new-pass-9', 'mail-cafe');
    const { referrals } = await run('getBilling', {}, referrer);
    assert.equal(referrals.code, 'mail-cafe');
    assert.equal(referrals.percent, 15);
    assert.equal(referrals.months, 2);
    const byName = Object.fromEntries(referrals.rows.map((row) => [row.name, row]));
    assert.equal(byName['Ref Cafe'].status, 'rewarded');
    assert.equal(byName['Ref Cafe'].months, 2);
    assert.equal(byName['Trial Cafe'].status, 'trial');
  });
});

describe('platform accounting: earned vs received, and Zoho Books (Relay Hosted)', () => {
  let ops;
  const DAY = 86400000;
  const kampalaMonth = (offsetMonths = 0) => {
    const d = new Date(Date.now() + 3 * 3600000);
    d.setUTCDate(15);
    d.setUTCMonth(d.getUTCMonth() + offsetMonths);
    return d.toISOString().slice(0, 7);
  };
  const month = kampalaMonth();
  const previous = kampalaMonth(-1);
  before(async () => {
    ops = await Parse.User.logIn('ops', 'ops-pass-123');
  });

  test('a month: money received, revenue earned and what is prepaid', async () => {
    const owner = await login('owner', 'new-pass-9', 'mail-cafe');
    await rejects(run('platformGetAccounting', { month }, owner), /platform role required/);
    const data = await run('platformGetAccounting', { month }, ops);
    assert.equal(data.month, month);
    assert.equal(data.closed, false);
    const paid = data.rows.filter((r) => r.paidInMonth);
    assert.ok(paid.length >= 5);
    const t = data.totals;
    assert.equal(
      t.received,
      paid.reduce((n, r) => n + r.amount, 0),
    );
    // All the tests' payments are this month: nothing earned from earlier.
    assert.equal(t.earnedFromEarlier, 0);
    assert.equal(t.earnedFromThisMonth + t.deferredFromThisMonth, t.received);
    assert.equal(t.prepaidAtEnd, t.deferredFromThisMonth);
    for (const r of data.rows)
      assert.equal(r.earnedBefore + r.earnedInMonth + r.deferredAfter, r.amount);
    // A year paid now is mostly prepaid.
    const year = paid.find((r) => r.months === 12);
    assert.ok(year.deferredAfter > year.amount * 0.8);
  });

  test('Zoho Books: connect, choose the accounts, send the month, post earnings', async () => {
    await rejects(run('platformSyncZoho', { month }, ops), /Connect Zoho Books first/);
    const details = {
      dc: 'com',
      orgId: '123456',
      clientId: 'zoho-client',
      clientSecret: 'zoho-secret',
    };
    await rejects(
      run('platformConnectZoho', { ...details, grantCode: 'old' }, ops),
      /grant code is wrong/,
    );
    await rejects(
      run('platformConnectZoho', { ...details, orgId: 'abc', grantCode: 'grant-ok' }, ops),
      /Organization ID/,
    );
    const connected = await run('platformConnectZoho', { ...details, grantCode: 'grant-ok' }, ops);
    assert.equal(connected.connected, true);
    assert.equal(connected.ready, false);
    assert.equal(connected.orgName, 'Relay Ltd');
    assert.equal(JSON.stringify(connected).includes('zoho-secret'), false, 'the secret stays');
    const view = await run('platformGetZoho', {}, ops);
    assert.equal(view.chart.length, 3);
    await rejects(run('platformSyncZoho', { month }, ops), /Choose the three Zoho accounts/);
    await run(
      'platformSaveZoho',
      {
        accounts: { deferred: 'acc-def', revenue: 'acc-rev', deposit: 'acc-bank' },
        accountNames: {
          deferred: 'Unearned revenue',
          revenue: 'Subscription revenue',
          deposit: 'ioTec wallet',
        },
        autoSync: false,
        fromMonth: month,
      },
      ops,
    );

    const result = await run('platformSyncZoho', { month }, ops);
    const data = await run('platformGetAccounting', { month }, ops);
    const paid = data.rows.filter((r) => r.paidInMonth && r.amount > 0);
    assert.deepEqual(result.errors, []);
    assert.equal(result.synced, paid.length);
    assert.equal(zohoBooks.invoices.length, paid.length);
    assert.equal(zohoBooks.payments.length, paid.length);
    for (const invoice of zohoBooks.invoices) {
      assert.match(invoice.invoice_number, /^INV-/);
      assert.equal(invoice.line_items[0].account_id, 'acc-def');
      assert.equal(invoice.status, 'sent');
    }
    assert.ok(zohoBooks.payments.every((p) => p.account_id === 'acc-bank'));
    assert.ok(data.rows.filter((r) => r.paidInMonth && r.amount > 0).every((r) => r.zohoPaymentId));
    // One customer per restaurant, made once.
    const names = zohoBooks.contacts.map((c) => c.contact_name);
    assert.equal(new Set(names).size, names.length);
    // Sending again sends nothing twice.
    assert.equal((await run('platformSyncZoho', { month }, ops)).synced, 0);
    // The current month is not over.
    await rejects(run('platformPostEarnings', { month }, ops), /once it is over/);
    await rejects(run('platformPostEarnings', { month: previous }, ops), /starts with/);

    // Last month: a year paid then (put in place for the test).
    const mail = (await run('platformListRestaurants', {}, ops)).rows.find(
      (r) => r.code === 'mail-cafe',
    );
    const [y, m] = previous.split('-').map(Number);
    const paidAt = new Date(Date.UTC(y, m - 1, 10, 9));
    const year = new Parse.Object('SubscriptionPayment');
    year.set({
      tenant: Parse.Object.extend('Restaurant').createWithoutData(mail.id),
      amount: 1200000,
      currency: 'UGX',
      months: 12,
      kind: 'period',
      method: 'manual',
      status: 'paid',
      paidAt,
      periodStart: paidAt,
      periodEnd: new Date(paidAt.getTime() + 365 * DAY),
    });
    await year.save(null, { useMasterKey: true });
    await run('platformSaveZoho', { fromMonth: previous }, ops);
    const before = await run('platformGetAccounting', { month: previous }, ops);
    assert.equal(before.closed, true);
    assert.ok(before.totals.earned > 0 && before.totals.earned < 1200000 / 12 + 1);
    const posted = await run('platformPostEarnings', { month: previous }, ops);
    assert.equal(posted.amount, before.totals.earned);
    const journal = zohoBooks.journals.at(-1);
    assert.equal(journal.reference_number, `RELAY-EARNED-${previous}`);
    assert.deepEqual(
      journal.line_items.map((l) => [l.account_id, l.debit_or_credit, l.amount]),
      [
        ['acc-def', 'debit', before.totals.earned],
        ['acc-rev', 'credit', before.totals.earned],
      ],
    );
    assert.ok(
      zohoBooks.invoices.some((i) => i.reference_number === year.id),
      'synced first',
    );
    await rejects(run('platformPostEarnings', { month: previous }, ops), /already posted/);
    assert.equal(
      (await run('platformGetAccounting', { month: previous }, ops)).posting.amount,
      posted.amount,
    );
    // This month now also earns from last month's prepayment.
    const now = await run('platformGetAccounting', { month }, ops);
    assert.ok(now.totals.earnedFromEarlier > 0);

    // Automatic: a payment received goes to Zoho by itself.
    await run('platformSaveZoho', { autoSync: true }, ops);
    const count = zohoBooks.payments.length;
    await run('platformRecordPayment', { id: mail.id, months: 1, reference: 'Bank 42' }, ops);
    for (let i = 0; i < 50 && zohoBooks.payments.length === count; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(zohoBooks.payments.length, count + 1);
    assert.equal(zohoBooks.payments.at(-1).reference_number, 'Bank 42');
    await run('platformSaveZoho', { autoSync: false }, ops);
    const off = await run('platformDisconnectZoho', {}, ops);
    assert.equal(off.connected, false);
  });
});

describe('deleting restaurants (Relay Hosted)', () => {
  let ops;
  const M = { useMasterKey: true };
  const DAY = 86400000;
  const when = (days) => new Date(Date.now() + days * DAY).toISOString();
  const pointer = (id) => ({ __type: 'Pointer', className: 'Restaurant', objectId: id });
  const signUp = async (code, email) => {
    await Parse.Cloud.run(
      'signUpRestaurant',
      {
        restaurantName: code.replace(/-/g, ' '),
        ownerName: 'Test Owner',
        username: 'owner',
        pin: PINS.owner,
        phone: '0701 333444',
        email,
      },
      M,
    );
    return (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.code === code);
  };
  // Every record left that belongs to the restaurant.
  const leftOf = async (id) => {
    const counts = {};
    for (const className of ['_User', 'Configuration', 'MenuCategory', 'Customer', 'AuditLog']) {
      const query = new Parse.Query(className);
      query.equalTo('tenant', pointer(id));
      const n = await query.count(M);
      if (n) counts[className] = n;
    }
    const roles = await new Parse.Query(Parse.Role)
      .containedIn(
        'name',
        ['admin', 'finance', 'cashier', 'rider'].map((r) => `${r}__${id}`),
      )
      .count(M);
    if (roles) counts.roles = roles;
    return counts;
  };
  const payments = (id) =>
    new Parse.Query('SubscriptionPayment').equalTo('tenant', pointer(id)).count(M);
  before(async () => {
    ops = await Parse.User.logIn('ops', 'ops-pass-123');
  });

  test('a test restaurant is deleted completely, payments and all', async () => {
    const row = await signUp('del-test-cafe', 'test@del.example');
    const owner = await login('owner', PINS.owner, row.code);
    await new Parse.Object('MenuCategory', { tenant: pointer(row.id), title: 'Mains' }).save(
      null,
      M,
    );
    await new Parse.Object('Customer', { tenant: pointer(row.id), name: 'A customer' }).save(
      null,
      M,
    );
    await run('platformRecordPayment', { id: row.id, months: 1, reference: 'Cash' }, ops);
    assert.ok((await leftOf(row.id))._User >= 1);
    assert.equal(await payments(row.id), 1);

    await rejects(
      run('platformDeleteRestaurant', { id: row.id, confirm: row.code, everything: true }, owner),
      /platform role required/,
    );
    await rejects(
      run('platformDeleteRestaurant', { id: row.id, confirm: 'nope', everything: true }, ops),
      /Type the restaurant code \(del-test-cafe\)/,
    );
    const { counts } = await run(
      'platformDeleteRestaurant',
      { id: row.id, confirm: 'DEL-TEST-CAFE', everything: true },
      ops,
    );
    assert.ok(counts.users >= 1 && counts.roles >= 1);
    assert.equal(counts.SubscriptionPayment, 1);
    assert.deepEqual(await leftOf(row.id), {});
    assert.equal(await payments(row.id), 0);
    const listed = (await run('platformListRestaurants', {}, ops)).rows;
    assert.equal(
      listed.some((r) => r.id === row.id),
      false,
    );
    await rejects(login('owner', PINS.owner, row.code), /Invalid username\/password/);
    // Its code is free again.
    assert.equal((await run('checkRestaurantCode', { code: row.code })).free, true);
    // The console's history says who did it.
    const audit = await run('platformGetAudit', {}, ops);
    const entry = audit.rows.find(
      (r) => r.action === 'platform.restaurant_deleted' && r.entityId === row.id,
    );
    assert.equal(entry.after.reason, 'test');
  });

  test('an unpaid restaurant is warned by email, then deleted keeping its payments', async () => {
    const row = await signUp('del-lapsed-cafe', 'lapsed@del.example');
    await run('platformRecordPayment', { id: row.id, months: 1, reference: 'Cash' }, ops);
    const settings = (await run('platformListRestaurants', {}, ops)).settings;
    await run('platformSaveSettings', { ...settings, deleteAfterDays: 30, deleteWarnDays: 3 }, ops);
    // Paid until 60 days ago: closed for more than 30 days.
    await run(
      'platformUpdateRestaurant',
      { id: row.id, trialEndsAt: when(-90), paidUntil: when(-60) },
      ops,
    );
    const mine = () => mailbox.filter((m) => m.to === 'lapsed@del.example');
    mailbox.length = 0;
    await Parse.Cloud.startJob('billing', {});
    for (let i = 0; i < 50 && !mine().length; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mine().length, 1);
    const mail = mine()[0];
    assert.match(
      mail.subject,
      /^del lapsed cafe: your RelayEats account will be deleted on \d+ \w+ \d{4}$/,
    );
    assert.match(mail.text, /deleted for good/);
    assert.match(mail.text, /https:\/\/relay\.example\/admin\/site\/billing/);
    assert.equal(mail.html.includes('{{{'), false);
    let listed = (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.id === row.id);
    assert.ok(listed.deletion.warnedAt);
    // The full notice from the warning: deleted 3 days later at the soonest.
    assert.ok(new Date(listed.deletion.deleteAt) - Date.now() > 2.9 * DAY);

    // Run again: no second email, nothing deleted yet.
    await Parse.Cloud.startJob('billing', {});
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(mine().length, 1);
    assert.ok((await leftOf(row.id))._User >= 1);

    // Kept by the platform: never deleted.
    await run('platformUpdateRestaurant', { id: row.id, neverDelete: true }, ops);
    listed = (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.id === row.id);
    assert.equal(listed.deletion, null);
    await run('platformUpdateRestaurant', { id: row.id, neverDelete: false }, ops);

    // Four days after the warning.
    const restaurant = await new Parse.Query('Restaurant').get(row.id, M);
    restaurant.set('deletionWarnedAt', new Date(Date.now() - 4 * DAY));
    await restaurant.save(null, M);
    await Parse.Cloud.startJob('billing', {});
    for (let i = 0; i < 100; i += 1) {
      const left = await leftOf(row.id);
      if (!left._User) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(await leftOf(row.id), {});
    assert.equal(await payments(row.id), 1, 'the subscription payment is kept');
    listed = (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.id === row.id);
    assert.equal(listed.deleted, true);
    assert.equal(listed.deletedCode, 'del-lapsed-cafe');
    assert.notEqual(listed.code, 'del-lapsed-cafe');
    assert.equal(listed.ownerEmail, '');
    assert.equal(listed.deletion, null);
    assert.equal((await run('checkRestaurantCode', { code: 'del-lapsed-cafe' })).free, true);
    await rejects(login('owner', PINS.owner, 'del-lapsed-cafe'), /Invalid username\/password/);

    // Removed completely afterwards: the payment goes too.
    await rejects(
      run('platformDeleteRestaurant', { id: row.id, confirm: 'del-lapsed-cafe' }, ops),
      /already deleted/,
    );
    await run(
      'platformDeleteRestaurant',
      { id: row.id, confirm: 'del-lapsed-cafe', everything: true },
      ops,
    );
    assert.equal(await payments(row.id), 0);
    await run('platformSaveSettings', { ...settings, deleteAfterDays: 0 }, ops);
  });

  test('a test restaurant leaves Zoho Books too, and the earnings journal is posted again', async () => {
    const twoAgo = (() => {
      const d = new Date(Date.now() + 3 * 3600000);
      d.setUTCDate(15);
      d.setUTCMonth(d.getUTCMonth() - 2);
      return d.toISOString().slice(0, 7);
    })();
    await run(
      'platformConnectZoho',
      {
        dc: 'com',
        orgId: '123456',
        clientId: 'zoho-client',
        clientSecret: 'zoho-secret',
        grantCode: 'grant-ok',
      },
      ops,
    );
    await run(
      'platformSaveZoho',
      {
        accounts: { deferred: 'acc-def', revenue: 'acc-rev', deposit: 'acc-bank' },
        autoSync: true,
        fromMonth: twoAgo,
      },
      ops,
    );
    const row = await signUp('del-zoho-cafe', 'zoho@del.example');
    // Paid two months ago (put in place), and now (sent to Zoho by itself).
    const [y, m] = twoAgo.split('-').map(Number);
    const paidAt = new Date(Date.UTC(y, m - 1, 5, 9));
    await new Parse.Object('SubscriptionPayment', {
      tenant: pointer(row.id),
      amount: 300000,
      currency: 'UGX',
      months: 3,
      kind: 'period',
      method: 'manual',
      status: 'paid',
      paidAt,
      periodStart: paidAt,
      periodEnd: new Date(paidAt.getTime() + 90 * DAY),
    }).save(null, M);
    const before = zohoBooks.payments.length;
    await run('platformRecordPayment', { id: row.id, months: 1, reference: 'Cash 7' }, ops);
    for (let i = 0; i < 50 && zohoBooks.payments.length === before; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    // Two months ago: its earnings journal counts this restaurant.
    const posted = await run('platformPostEarnings', { month: twoAgo }, ops);
    assert.ok(posted.amount > 0);
    const contact = (await new Parse.Query('Restaurant').get(row.id, M)).get('zohoContactId');
    assert.ok(contact);
    const mine = () => ({
      invoices: zohoBooks.invoices.filter((i) => i.customer_id === contact).length,
      payments: zohoBooks.payments.filter((p) => p.customer_id === contact).length,
      contact: zohoBooks.contacts.some((c) => c.contact_id === contact),
    });
    assert.deepEqual(mine(), { invoices: 2, payments: 2, contact: true });
    const oldJournal = posted.zohoJournalId;

    // Zoho off: the deletion stops before anything here is deleted.
    const z = await run('platformGetZoho', {}, ops);
    await run('platformDisconnectZoho', {}, ops);
    await rejects(
      run('platformDeleteRestaurant', { id: row.id, confirm: row.code, everything: true }, ops),
      /Zoho is not connected/,
    );
    assert.ok((await leftOf(row.id))._User >= 1);
    await run(
      'platformConnectZoho',
      {
        dc: 'com',
        orgId: '123456',
        clientId: 'zoho-client',
        clientSecret: 'zoho-secret',
        grantCode: 'grant-ok',
      },
      ops,
    );
    await run(
      'platformSaveZoho',
      { accounts: z.accounts, autoSync: false, fromMonth: twoAgo },
      ops,
    );

    const { counts } = await run(
      'platformDeleteRestaurant',
      { id: row.id, confirm: row.code, everything: true },
      ops,
    );
    assert.deepEqual(
      {
        payments: counts.zoho.payments,
        invoices: counts.zoho.invoices,
        contact: counts.zoho.contact,
      },
      { payments: 2, invoices: 2, contact: true },
    );
    assert.deepEqual(mine(), { invoices: 0, payments: 0, contact: false });
    assert.deepEqual(counts.zoho.errors, []);
    assert.deepEqual(counts.zoho.reposted, [twoAgo]);
    assert.equal(
      zohoBooks.journals.some((j) => j.journal_id === oldJournal),
      false,
      'the old journal is gone',
    );
    // Nothing else earned then: posted again at 0, without a journal.
    const again = await run('platformGetAccounting', { month: twoAgo }, ops);
    assert.equal(again.posting.amount, 0);
    assert.equal(again.totals.earned, 0);
    assert.deepEqual(await leftOf(row.id), {});
    assert.equal(await payments(row.id), 0);
    await run('platformDisconnectZoho', {}, ops);
  });

  test('a paying restaurant is never on its way to deletion', async () => {
    const rows = (await run('platformListRestaurants', {}, ops)).rows;
    for (const r of rows.filter((x) => x.usable)) assert.equal(r.deletion, null, r.code);
  });
});

describe('sign-in lockout and session length (S5, S7)', () => {
  const M = { useMasterKey: true };
  const profile = (user) => run('getMyProfile', {}, user);
  test('five wrong PINs lock sign-in; the owner unlocks it, the PIN stays', async () => {
    for (let i = 0; i < 5; i += 1)
      await rejects(login('nia', '0000'), /Invalid username\/password/);
    // Even the right PIN is refused now, and the password check says nothing.
    await rejects(login('nia', PINS.nia), /locked due to multiple failed login attempts/);
    const verify = await fetch(
      `${SERVER_URL}/verifyPassword?username=nia@${CODE}&password=${PINS.nia}`,
      {
        headers: { 'X-Parse-Application-Id': APP_ID },
      },
    );
    assert.match(await verify.text(), /locked/);
    const nia = await new Parse.Query(Parse.User).equalTo('username', `nia@${CODE}`).first(M);
    const carl = await login('carl', PINS.carl);
    await rejects(run('adminUnlockSignIn', { id: nia.id }, carl), /admin role required/);
    await run('adminUnlockSignIn', { id: nia.id }, s.owner);
    s.nia = await login('nia', PINS.nia);
    // A new PIN from the owner unlocks it too.
    for (let i = 0; i < 5; i += 1) await rejects(login('nia', '0000'), /Invalid/);
    await run('adminResetPin', { id: nia.id, pin: '1357' }, s.owner);
    PINS.nia = '1357';
    s.nia = await login('nia', PINS.nia);
  });

  test('the owner sees whether the sign-in protections are on', async () => {
    const status = await run('adminSecurityStatus', {}, s.owner);
    assert.deepEqual(status.lockout, { threshold: 5, minutes: 15 });
    assert.equal(status.serverSessionDays, 30);
    assert.equal(status.staffDays, 30);
    assert.equal(status.ownerDays, 14);
    // Relay Hosted: platform staff see it too, with their own (1 day).
    const ops = await Parse.User.logIn('ops', 'ops-pass-123');
    const platform = await run('platformSecurityStatus', {}, ops);
    assert.deepEqual(platform.lockout, status.lockout);
    assert.equal(platform.platformDays, 1);
    await rejects(run('platformSecurityStatus', {}, s.owner), /platform role required/);
  });

  test('a sign-in past its days ends: 14 for the owner, 30 for staff', async () => {
    const owner = await login('owner', PINS.owner);
    const rider = await login('nia', PINS.nia);
    // A few hundred milliseconds instead of days.
    process.env.RELAY_ADMIN_SESSION_DAYS = String(0.3 / 86400);
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await rejects(profile(owner), /Your sign-in has expired/);
      // Gone for good: the session itself was deleted.
      await rejects(profile(owner), /Invalid session token/);
      assert.equal((await profile(rider)).role, 'rider');
    } finally {
      delete process.env.RELAY_ADMIN_SESSION_DAYS;
    }
    process.env.RELAY_SESSION_DAYS = String(0.3 / 86400);
    try {
      const fresh = await login('nia', PINS.nia);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await rejects(profile(fresh), /Your sign-in has expired/);
    } finally {
      delete process.env.RELAY_SESSION_DAYS;
    }
    // The SDK keeps one copy of each user, so s.owner took the expired
    // sign-in above: sign in again for the tests after this one.
    s.owner = await login('owner', PINS.owner);
  });
});

describe('restaurant subdomains (Relay Hosted)', () => {
  let ops;
  before(async () => {
    ops = await Parse.User.logIn('ops', 'ops-pass-123');
  });

  test('platform staff set the restaurant domain; links and emails use it', async () => {
    const { settings } = await run('platformListRestaurants', {}, ops);
    await rejects(
      run('platformSaveSettings', { ...settings, restaurantDomain: 'not a domain' }, ops),
      /a domain such as relayeats.app/,
    );
    const saved = await run(
      'platformSaveSettings',
      { ...settings, restaurantDomain: 'https://RelayEats.app/' },
      ops,
    );
    assert.equal(saved.restaurantDomain, 'relayeats.app');
    // The app learns it before anyone signs in.
    assert.equal((await run('getAppInfo', {})).platform.restaurantDomain, 'relayeats.app');
    assert.equal(
      (await run('getAppInfo', { restaurant: CODE })).platform.restaurantDomain,
      'relayeats.app',
    );
    const row = (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.code === CODE);
    assert.equal(row.link, `https://${CODE}.relayeats.app`);

    // A new restaurant's welcome email links to its own address.
    mailbox.length = 0;
    await Parse.Cloud.run(
      'signUpRestaurant',
      {
        restaurantName: 'Sub Cafe',
        ownerName: 'Sam',
        username: 'owner',
        pin: PINS.owner,
        phone: '0701 555666',
        email: 'sam@sub.example',
      },
      { useMasterKey: true },
    );
    for (let i = 0; i < 30 && !mailbox.length; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(mailbox[0].text, /https:\/\/sub-cafe\.relayeats\.app/);
    assert.equal(mailbox[0].text.includes('/r/sub-cafe'), false);

    // Names used by the platform's own subdomains are never restaurant codes.
    for (const code of ['www', 'mail', 'relayeats'])
      assert.equal((await run('checkRestaurantCode', { code })).free, false, code);

    // Back to /r/<code> links when the domain is cleared.
    await run('platformSaveSettings', { ...settings, restaurantDomain: '' }, ops);
    const plain = (await run('platformListRestaurants', {}, ops)).rows.find((r) => r.code === CODE);
    assert.match(plain.link, new RegExp(`/r/${CODE}$`));
  });
});

describe('online orders: the public menu, a QR code away (online.js)', () => {
  const M = { useMasterKey: true };
  let dish;
  const order = (extra = {}) => ({
    items: [{ id: dish.id, quantity: 2 }],
    customerName: 'Web Customer',
    customerPhone: '0772 123 456',
    orderType: 'pickup',
    paymentMethod: 'cash',
    ...extra,
  });
  // RelayEats Hosted: the public menu names its restaurant.
  const pub = (name, params = {}) => run(name, { restaurant: CODE, ...params });
  const byToken = (token) => new Parse.Query('Order').equalTo('onlineToken', token).first(M);

  test('a restaurant’s own link is needed', async () => {
    await rejects(run('getOnlineMenu', {}), /restaurant’s own link/);
  });

  test('off until the owner switches it on, with at least one way to get and pay', async () => {
    assert.equal((await pub('getOnlineMenu', {})).enabled, false);
    await rejects(pub('placeOnlineOrder', {}), /does not take online orders/);
    await rejects(
      run(
        'adminSaveOnlineOrdering',
        { onlineOrders: true, onlinePickup: false, onlineDelivery: false },
        s.owner,
      ),
      /pick-up, delivery or both/,
    );
    const saved = await run(
      'adminSaveOnlineOrdering',
      {
        onlineOrders: true,
        onlinePickup: true,
        onlineDelivery: true,
        onlineCash: true,
        onlineMobileMoney: true,
        onlineNote: 'Delivery within Kampala',
      },
      s.owner,
    );
    assert.equal(saved.onlineOrders, true);
    assert.equal((await run('getMyProfile', {}, s.owner)).config.online.open, true);
  });

  test('anyone sees the live menu, with the ways to pay', async () => {
    const menu = await pub('getOnlineMenu', {});
    assert.equal(menu.enabled, true);
    assert.equal(menu.open, true);
    assert.equal(menu.note, 'Delivery within Kampala');
    assert.ok(menu.items.length > 0);
    assert.ok(menu.mobileMoney.length > 0, 'merchant codes are offered');
    dish = menu.items.find((item) => item.accompanimentGroups.every((g) => g.min === 0));
    assert.ok(dish, 'a dish without required sides');
  });

  test('a pick-up paid in cash: an open bill on the kitchen board, nobody holding it', async () => {
    await rejects(pub('placeOnlineOrder', order({ customerName: '' })), /Enter your name/);
    await rejects(pub('placeOnlineOrder', order({ customerPhone: '12' })), /phone number/);
    await rejects(pub('placeOnlineOrder', order({ orderType: 'eat_in' })), /pick-up or delivery/);
    const placed = await pub('placeOnlineOrder', order({ requestId: 'web-test-1' }));
    assert.match(placed.token, /^[a-f0-9]{32}$/);
    assert.equal(placed.total, dish.price * 2);
    // Sent twice (a lost connection): one order.
    const again = await pub('placeOnlineOrder', order({ requestId: 'web-test-1' }));
    assert.equal(again.duplicate, true);
    assert.equal(again.token, placed.token);
    const row = await byToken(placed.token);
    assert.equal(row.get('channel'), 'online');
    assert.equal(row.get('source'), 'counter');
    assert.equal(row.get('status'), 'PLACED');
    assert.equal(row.get('billOpen'), true);
    assert.equal(row.get('cashier'), undefined);
    // Staff can read it; the public cannot query orders.
    await rejects(
      new Parse.Query('Order').equalTo('objectId', row.id).find(),
      /needs to be authenticated/,
    );
    const tracked = await pub('getOnlineOrder', { token: placed.token });
    assert.equal(tracked.status, 'PLACED');
    assert.equal(tracked.orderType, 'pickup');
    assert.equal(tracked.lines[0].quantity, 2);
    assert.equal(JSON.stringify(tracked).includes('0772'), false, 'no phone number in the answer');
    // The customer cancels while the kitchen has not started.
    await pub('cancelOnlineOrder', { token: placed.token });
    assert.equal((await pub('getOnlineOrder', { token: placed.token })).status, 'CANCELLED');
    await rejects(pub('cancelOnlineOrder', { token: placed.token }), /has started/);
    await rejects(pub('getOnlineOrder', { token: 'f'.repeat(32) }), /Order not found/);
  });

  test('a delivery paid cash to the rider; the counter gives it a rider', async () => {
    await rejects(pub('placeOnlineOrder', order({ orderType: 'delivery' })), /delivery address/);
    const placed = await pub(
      'placeOnlineOrder',
      order({
        orderType: 'delivery',
        deliveryAddress: 'Plot 4, Ntinda',
        customerPhone: '0772 222 333',
      }),
    );
    const row = await byToken(placed.token);
    assert.equal(row.get('orderType'), 'delivery');
    assert.equal(row.get('cashStatus'), 'NOT_COLLECTED');
    assert.equal(row.get('amountToCollect'), row.get('total'));
    assert.ok(row.get('deliveryFee') >= 0);
    const riders = await run('getAssignableRiders', {}, s.owner);
    const rider = riders.find((r) => r.onShift && r.available) || riders[0];
    if (rider) {
      await run('assignOrderRider', { orderId: row.id, riderId: rider.id }, s.owner);
      assert.equal((await byToken(placed.token)).get('createdBy').id, rider.id);
    }
  });

  test('deliveries are priced per km from the branch pin; staff maps open there', async () => {
    const { branches } = await run('adminListBranches', {}, s.owner);
    const main = branches.find((b) => b.main);
    const edit = (extra) =>
      run(
        'adminSaveBranch',
        { id: main.id, name: main.name, address: main.address, phone: main.phone, ...extra },
        s.owner,
      );
    await rejects(edit({ location: { lat: 200, lng: 0 } }), /not a valid location/);
    const pin = { lat: 0.3136, lng: 32.5811 };
    assert.deepEqual((await edit({ location: pin })).location, pin);
    // The main branch's team: their maps open at its pin.
    assert.deepEqual((await run('getMyProfile', {}, s.dina)).config.mapCenter, pin);

    await rejects(
      run('adminSaveOnlineOrdering', { onlineDeliveryPerKm: -5 }, s.owner),
      /0 or more/,
    );
    const saved = await run('adminSaveOnlineOrdering', { onlineDeliveryPerKm: 1000 }, s.owner);
    assert.equal(saved.onlineDeliveryPerKm, 1000);
    const menu = await pub('getOnlineMenu', { branchId: main.id });
    assert.equal(menu.deliveryPerKm, 1000);
    assert.deepEqual(menu.origin, pin);
    const delivery = order({
      orderType: 'delivery',
      deliveryAddress: 'Kololo',
      customerPhone: '0772 888 111',
      branchId: main.id,
    });
    await rejects(pub('placeOnlineOrder', delivery), /Pin your location/);
    // 0.027° north ≈ 3.0 km: 3,000 at 1,000 a km.
    const placed = await pub('placeOnlineOrder', {
      ...delivery,
      location: { lat: 0.3406, lng: 32.5811 },
    });
    const row = await byToken(placed.token);
    assert.equal(row.get('deliveryKm'), 3);
    assert.equal(row.get('deliveryFee'), 3000);
    assert.equal(row.get('total'), row.get('subtotal') + 3000);
    assert.equal(placed.total, row.get('total'));
    assert.equal((await pub('getOnlineOrder', { token: placed.token })).deliveryKm, 3);

    // Back to the flat fee; the pin stays unless removed.
    await run('adminSaveOnlineOrdering', { onlineDeliveryPerKm: 0 }, s.owner);
    assert.equal((await pub('getOnlineMenu', {})).origin, null);
    assert.equal((await edit({ location: null })).location, null);
  });

  test('mobile money by merchant code: the cashier checks the transaction ID', async () => {
    const menu = await pub('getOnlineMenu', {});
    const account = menu.mobileMoney.find((a) => !a.auto);
    const placed = await pub(
      'placeOnlineOrder',
      order({
        paymentMethod: 'mobile_money',
        paymentProvider: account.provider,
        paymentReference: 'WEB12345',
        customerPhone: '0772 444 555',
      }),
    );
    const row = await byToken(placed.token);
    assert.equal(row.get('paymentStatus'), 'PENDING_VERIFICATION');
    assert.equal(row.get('paymentReference'), 'WEB12345');
    assert.equal(row.get('billOpen'), undefined);
    assert.equal(row.get('amountToCollect'), 0);
  });

  test('a customer finds their order again with the number they ordered with', async () => {
    await rejects(pub('getMyOnlineOrders', { phone: '12' }), /number you ordered with/);
    const placed = await pub(
      'placeOnlineOrder',
      order({ customerPhone: '+256 772 909 808', device: 'd-first-phone' }),
    );
    const tokens = async (phone) =>
      (await pub('getMyOnlineOrders', { phone, device: 'd-other-phone' })).orders.map(
        (o) => o.token,
      );
    // Another browser (Safari private tab): written another way, still found.
    assert.ok((await tokens('0772 909808')).includes(placed.token));
    assert.equal((await tokens('0772 000 111')).includes(placed.token), false);
  });

  test('staff pause online orders when the kitchen is full', async () => {
    const cashier = await login('carl', PINS.carl);
    await run('setOnlineOpen', { open: false }, cashier);
    assert.equal((await pub('getOnlineMenu', {})).open, false);
    await rejects(
      pub('placeOnlineOrder', order({ customerPhone: '0772 666 777' })),
      /not taking online orders right now/,
    );
    await run('setOnlineOpen', { open: true }, cashier);
    await run('adminSaveOnlineOrdering', { onlineOrders: false }, s.owner);
    assert.equal((await pub('getOnlineMenu', {})).enabled, false);
    assert.equal((await run('getMyProfile', {}, s.owner)).config.online, null);
  });
});

describe('eat in: guests order from the QR code on their table (tables.js)', () => {
  const M = { useMasterKey: true };
  // RelayEats Hosted: the public menu names its restaurant.
  const pub = (name, params = {}) => run(name, { restaurant: CODE, ...params });
  let dish;
  let t1;
  let t2;
  let placed;
  const at = (table, extra = {}) => ({
    table: table.token,
    items: [{ id: dish.id, quantity: 1 }],
    ...extra,
  });

  test('the owner adds tables, each with its own QR code, and switches table orders on', async () => {
    const off = await pub('getOnlineMenu', { table: 'a'.repeat(24) });
    assert.equal(off.enabled, false);
    assert.equal(off.atTable, true);
    await rejects(run('adminSaveTable', { name: ' ' }, s.owner), /name or number/);
    t1 = await run('adminSaveTable', { name: 'Table 1' }, s.owner);
    t2 = await run('adminSaveTable', { name: 'Table 2' }, s.owner);
    await rejects(run('adminSaveTable', { name: 'table 1' }, s.owner), /already a table/);
    assert.match(t1.token, /^[a-f0-9]{24}$/);
    assert.notEqual(t1.token, t2.token);
    const { tables } = await run('adminListTables', {}, s.owner);
    assert.deepEqual(
      tables.map((t) => t.name),
      ['Table 1', 'Table 2'],
    );
    // Table orders on, online pick-up / delivery still off.
    const saved = await run('adminSaveOnlineOrdering', { onlineTables: true }, s.owner);
    assert.equal(saved.onlineTables, true);
    assert.equal(saved.onlineOrders, false);
    assert.equal((await run('getMyProfile', {}, s.owner)).config.online.open, true);
    // Clients never read tables (their codes) directly.
    await rejects(
      new Parse.Query('DiningTable').find({ sessionToken: s.dina.getSessionToken() }),
      /Permission denied|not allowed|unauthorized/i,
    );
  });

  test('a guest scans the table: its menu, no sign-in, nothing to pay yet', async () => {
    const menu = await pub('getOnlineMenu', { table: t1.token });
    assert.equal(menu.enabled, true);
    assert.deepEqual(menu.table, { name: 'Table 1' });
    dish = menu.items.find((item) => item.accompanimentGroups.every((g) => g.min === 0));
    assert.ok(dish);
    await rejects(pub('getOnlineMenu', { table: 'b'.repeat(24) }), /no longer in use/);
    assert.equal((await pub('getOnlineMenu', {})).enabled, false);
    await rejects(
      pub('placeOnlineOrder', { ...at(t1), table: undefined, orderType: 'pickup' }),
      /does not take online orders/,
    );
    await rejects(pub('placeOnlineOrder', at(t1, { customerPhone: '12' })), /phone number/);

    placed = await pub('placeOnlineOrder', at(t1, { notes: 'no onions', device: 'd-phone-one' }));
    const row = await new Parse.Query('Order').equalTo('onlineToken', placed.token).first(M);
    assert.equal(row.get('orderType'), 'eat_in');
    assert.equal(row.get('channel'), 'table');
    assert.equal(row.get('tableLabel'), 'Table 1');
    assert.equal(row.get('table').id, t1.id);
    assert.equal(row.get('customerName'), 'Table 1 guest');
    assert.equal(row.get('status'), 'PLACED');
    // Paid later, like an open bill at the counter.
    assert.equal(row.get('billOpen'), true);
    assert.equal(row.get('cashStatus'), 'UNPAID');
    assert.equal(row.get('amountToCollect'), row.get('total'));
    assert.equal(row.get('cashier'), undefined);
    const tracked = await pub('getOnlineOrder', { token: placed.token });
    assert.equal(tracked.table, 'Table 1');
    assert.equal(tracked.billOpen, true);
    assert.equal(tracked.orderType, 'eat_in');
  });

  test('a phone that lost its links finds its orders again; a table shows its open orders', async () => {
    const tokens = async (params) =>
      (await pub('getMyOnlineOrders', params)).orders.map((o) => o.token);
    // The same phone (network address and browser), its saved id gone.
    assert.ok((await tokens({})).includes(placed.token));
    assert.ok((await tokens({ device: 'd-phone-one' })).includes(placed.token));
    // Another phone that looks the same but has its own id: not its order.
    assert.equal((await tokens({ device: 'd-phone-two' })).includes(placed.token), false);
    // Anyone scanning the table sees what is still open at it.
    assert.ok((await tokens({ device: 'd-phone-two', table: t1.token })).includes(placed.token));
    assert.equal(
      (await tokens({ device: 'd-phone-two', table: t2.token })).includes(placed.token),
      false,
    );
    const listed = (await pub('getMyOnlineOrders', {})).orders[0];
    assert.deepEqual(Object.keys(listed).sort(), ['orderCode', 'placedAt', 'token']);
  });

  test('the guests move: the board moves the order (and its bill) to their new table', async () => {
    const row = await new Parse.Query('Order').equalTo('onlineToken', placed.token).first(M);
    const { tables } = await run('getTables', {}, s.owner);
    assert.ok(tables.some((t) => t.id === t2.id));
    assert.equal('token' in tables[0], false);
    assert.deepEqual(await run('moveOrderTable', { orderId: row.id, tableId: t2.id }, s.owner), {
      table: 'Table 2',
    });
    await rejects(
      run('moveOrderTable', { orderId: row.id, tableId: t2.id }, s.owner),
      /already at Table 2/,
    );
    const moved = await new Parse.Query('Order').get(row.id, M);
    assert.equal(moved.get('tableLabel'), 'Table 2');
    assert.equal(moved.get('table').id, t2.id);
    assert.equal((await pub('getOnlineOrder', { token: placed.token })).table, 'Table 2');
    const delivery = await new Parse.Query('Order').equalTo('orderType', 'delivery').first(M);
    await rejects(
      run('moveOrderTable', { orderId: delivery.id, tableId: t1.id }, s.owner),
      /Only eat-in orders/,
    );
  });

  test('served before paying: it waits on the board for payment, then closes', async () => {
    const row = await new Parse.Query('Order').equalTo('onlineToken', placed.token).first(M);
    for (const action of ['accept', 'ready'])
      await run('transitionOrder', { orderId: row.id, action }, s.owner);
    assert.deepEqual(
      await run('transitionOrder', { orderId: row.id, action: 'complete' }, s.owner),
      { status: 'READY', served: true },
    );
    let fresh = await new Parse.Query('Order').get(row.id, M);
    assert.equal(fresh.get('status'), 'READY');
    assert.ok(fresh.get('servedAt'));
    assert.equal(fresh.get('billOpen'), true);
    assert.equal((await pub('getOnlineOrder', { token: placed.token })).served, true);
    await rejects(
      run('transitionOrder', { orderId: row.id, action: 'complete' }, s.owner),
      /waiting for payment/,
    );
    // Paid in cash: finished.
    await run('takeCounterPayment', { orderId: row.id, paymentMethod: 'cash' }, s.owner);
    fresh = await new Parse.Query('Order').get(row.id, M);
    assert.equal(fresh.get('status'), 'DELIVERED');
    assert.equal(fresh.get('billOpen'), false);
    assert.equal(fresh.get('cashStatus'), 'IN_TILL');
  });

  test('a new code retires the old card; closed tables and switching off stop orders', async () => {
    const renewed = await run(
      'adminSaveTable',
      { id: t1.id, name: 'Table 1', newCode: true },
      s.owner,
    );
    assert.notEqual(renewed.token, t1.token);
    await rejects(pub('getOnlineMenu', { table: t1.token }), /no longer in use/);
    t1 = renewed;
    await run('adminSaveTable', { id: t2.id, name: 'Table 2', active: false }, s.owner);
    await rejects(pub('placeOnlineOrder', at(t2)), /no longer in use/);
    assert.equal(
      (await run('getTables', {}, s.owner)).tables.some((t) => t.id === t2.id),
      false,
    );
    await run('adminSaveOnlineOrdering', { onlineTables: false }, s.owner);
    await rejects(pub('placeOnlineOrder', at(t1)), /from the table/);
    assert.equal((await run('getMyProfile', {}, s.owner)).config.online, null);
  });
});
