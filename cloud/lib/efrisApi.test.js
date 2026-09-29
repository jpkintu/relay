import crypto from 'crypto';
import zlib from 'zlib';
import forge from 'node-forge';
import { describe, expect, test } from 'vitest';
import {
  aesEncrypt,
  buildInvoice,
  decryptSymmetricKey,
  lineTotal,
  openContent,
  privateKeyPem,
  taxIn,
  TAX,
  ugandaTime,
} from './efrisApi.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const b64 = (text) => Buffer.from(text).toString('base64');

describe('private keys', () => {
  test('a PEM private key is taken as it is', () => {
    const loaded = privateKeyPem(b64(pem));
    expect(crypto.createPrivateKey(loaded).asymmetricKeyDetails.modulusLength).toBe(2048);
  });

  test('a .pfx keystore opens with its password, and not without it', () => {
    const key = forge.pki.privateKeyFromPem(pem);
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: '1000029771' }]);
    cert.setIssuer([{ name: 'commonName', value: '1000029771' }]);
    cert.sign(key);
    const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], 'secret-pass', { algorithm: '3des' });
    const file = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
    const loaded = privateKeyPem(file, 'secret-pass');
    const signature = crypto.sign('sha1', Buffer.from('x'), loaded);
    expect(crypto.verify('sha1', Buffer.from('x'), publicKey, signature)).toBe(true);
    expect(() => privateKeyPem(file, 'wrong')).toThrow(/password/);
  });

  test('something else is refused', () => {
    expect(() => privateKeyPem(b64('hello'))).toThrow();
    expect(() => privateKeyPem('')).toThrow(/Choose/);
  });
});

describe('the symmetric key (T104)', () => {
  const aes = crypto.randomBytes(16);
  const encrypt = (plain) =>
    crypto
      .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, plain)
      .toString('base64');

  test('a base64 encoded key', () => {
    expect(decryptSymmetricKey(encrypt(Buffer.from(aes.toString('base64'))), pem)).toEqual(aes);
  });

  test('a raw key', () => {
    const raw = Buffer.from('0123456789abcdef');
    expect(decryptSymmetricKey(encrypt(raw), pem)).toEqual(raw);
  });

  test('a key for another certificate is explained', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const otherPem = other.export({ type: 'pkcs8', format: 'pem' });
    expect(() => decryptSymmetricKey(encrypt(aes), otherPem)).toThrow(/EFRIS portal/);
  });
});

describe('answers', () => {
  const key = crypto.randomBytes(16);
  const json = { invoiceNo: '322000150744' };

  test('encrypted', () => {
    const content = aesEncrypt(Buffer.from(JSON.stringify(json)), key).toString('base64');
    expect(openContent({ content, dataDescription: { codeType: '1' } }, key)).toEqual(json);
  });

  test('encrypted and zipped, either way round', () => {
    const zippedFirst = aesEncrypt(zlib.gzipSync(JSON.stringify(json)), key).toString('base64');
    expect(openContent({ content: zippedFirst, dataDescription: { codeType: '1' } }, key)).toEqual(
      json,
    );
    const zippedLast = zlib
      .gzipSync(aesEncrypt(Buffer.from(JSON.stringify(json)), key))
      .toString('base64');
    expect(openContent({ content: zippedLast, dataDescription: { codeType: '1' } }, key)).toEqual(
      json,
    );
  });

  test('plain', () => {
    expect(openContent({ content: b64(JSON.stringify(json)) }, null)).toEqual(json);
    expect(openContent({ content: '' }, null)).toBe(null);
  });
});

describe('money', () => {
  test('VAT inside a VAT-inclusive price', () => {
    expect(taxIn(25000, TAX.standard)).toBe(3813.56);
    expect(taxIn(25000, TAX.exempt)).toBe(0);
  });

  test('line totals truncate like EFRIS', () => {
    expect(lineTotal(3, 3333.333)).toBe(9999.99);
    expect(lineTotal(2, 12500)).toBe(25000);
  });

  test('Uganda time for requests', () => {
    expect(ugandaTime(new Date('2026-09-29T21:05:09Z'))).toBe('2026-09-30 00:05:09');
  });
});

describe('buildInvoice', () => {
  const settings = {
    tin: '1000029771',
    legalName: 'Mama Rose Kitchen Ltd',
    emailAddress: 'owner@example.com',
    deviceNo: 'TCS9e0df01728335239',
    commodityCategoryId: '90101501',
    unitOfMeasure: 'PP',
    taxCategory: 'standard',
    invoiceKind: 'invoice',
  };
  const invoice = buildInvoice({
    settings,
    reference: 'ORD-20260929-0001',
    operator: 'Carol',
    buyer: { name: 'Jane', phone: '0772000111' },
    lines: [
      { code: 'M1', name: 'Chicken stew', qty: 2, unitPrice: 25000 },
      { code: 'DELIVERY', name: 'Delivery', qty: 1, unitPrice: 3000 },
    ],
    payment: 'mobile_money',
    issuedAt: new Date('2026-09-29T09:00:00Z'),
  });

  test('lines, taxes and totals agree the way EFRIS checks them', () => {
    const lines = invoice.goodsDetails;
    expect(lines.map((l) => [l.orderNumber, l.total, l.tax])).toEqual([
      ['0', '50000.00', '7627.12'],
      ['1', '3000.00', '457.63'],
    ]);
    const [tax] = invoice.taxDetails;
    expect(tax).toMatchObject({
      taxCategoryCode: '01',
      grossAmount: '53000.00',
      taxAmount: '8084.75',
      netAmount: '44915.25',
    });
    expect(Number(tax.netAmount) + Number(tax.taxAmount)).toBe(Number(tax.grossAmount));
    expect(invoice.summary).toMatchObject({
      grossAmount: '53000.00',
      taxAmount: '8084.75',
      itemCount: '2',
      modeCode: '1',
    });
    expect(invoice.payWay).toEqual([
      { paymentMode: '105', paymentAmount: '53000.00', orderNumber: 'a' },
    ]);
  });

  test('seller, buyer and the reference that stops double issuing', () => {
    expect(invoice.sellerDetails).toMatchObject({
      tin: '1000029771',
      referenceNo: 'ORD-20260929-0001',
      isCheckReferenceNo: '1',
    });
    expect(invoice.basicInformation).toMatchObject({
      invoiceKind: '1',
      invoiceType: '1',
      deviceNo: 'TCS9e0df01728335239',
      issuedDate: '2026-09-29 12:00:00',
    });
    expect(invoice.buyerDetails).toMatchObject({
      buyerType: '1',
      buyerLegalName: 'Jane',
      buyerMobilePhone: '0772000111',
    });
  });

  test('a receipt without VAT', () => {
    const receipt = buildInvoice({
      settings: { ...settings, taxCategory: 'exempt', invoiceKind: 'receipt' },
      reference: 'R',
      lines: [{ code: 'M1', name: 'Rolex', qty: 1, unitPrice: 6000 }],
      payment: 'cash',
    });
    expect(receipt.basicInformation.invoiceKind).toBe('2');
    expect(receipt.goodsDetails[0]).toMatchObject({ taxRate: '-', tax: '0.00' });
    expect(receipt.taxDetails[0]).toMatchObject({ taxCategoryCode: '03', netAmount: '6000.00' });
    expect(receipt.buyerDetails.buyerLegalName).toBe('Walk-in customer');
    expect(receipt.payWay[0].paymentMode).toBe('102');
  });
});
