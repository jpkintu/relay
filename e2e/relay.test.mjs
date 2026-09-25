// End-to-end tests for cloud/: boots a real Parse Server in-process with the
// repo's Cloud Code and drives it through the Parse JS SDK as each role.
//
// Needs a database: PARSE_TEST_DATABASE_URI, e.g.
//   mongodb://localhost:27017/          (a fresh database name is appended)
//   postgres://postgres:postgres@localhost:5432/relaytest   (must be empty)

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import express from 'express';
import { ParseServer } from 'parse-server';

const require = createRequire(import.meta.url);
const Parse = require('parse/node');

const PORT = 1338;
const APP_ID = 'relay-e2e';
const MASTER_KEY = 'relay-e2e-master';
const SERVER_URL = `http://localhost:${PORT}/parse`;

function databaseUri() {
  const uri = process.env.PARSE_TEST_DATABASE_URI;
  if (!uri) throw new Error('Set PARSE_TEST_DATABASE_URI (see e2e/relay.test.mjs)');
  return uri.startsWith('mongodb') && uri.endsWith('/') ? `${uri}relay_e2e_${Date.now()}` : uri;
}

let httpServer;
let parseServer;

before(async () => {
  parseServer = new ParseServer({
    databaseURI: databaseUri(),
    cloud: path.resolve(import.meta.dirname, '../cloud/main.js'),
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
  });
  await parseServer.start();
  const app = express();
  app.use('/parse', parseServer.app);
  httpServer = app.listen(PORT);
  Parse.initialize(APP_ID, undefined, MASTER_KEY);
  Parse.serverURL = SERVER_URL;
});

after(async () => {
  httpServer?.close();
  await parseServer?.handleShutdown?.();
});

const as = (user) => ({ sessionToken: user.getSessionToken() });
const run = (name, params, user) => Parse.Cloud.run(name, params, user ? as(user) : {});
const login = (username, password) => Parse.User.logIn(username, password);

async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.match(String(error.message), pattern);
    return true;
  });
}

// Shared state across the ordered tests below.
const s = {};

describe('first owner setup', () => {
  test('sign-up is open while the database is empty', async () => {
    assert.equal((await run('getAppInfo')).ownerSetupOpen, true);
    s.owner = new Parse.User({ username: 'owner', password: 'owner-pass', email: 'o@example.com' });
    await s.owner.signUp();
  });

  test('the only account can initialize itself as owner', async () => {
    const before = await run('getMyProfile', {}, s.owner);
    assert.equal(before.role, null);
    assert.equal(before.canInitialize, true);
    await run('bootstrapOwner', {}, s.owner);
    const after = await run('getMyProfile', {}, s.owner);
    assert.equal(after.role, 'admin');
    assert.equal(after.canInitialize, false);
    assert.equal(after.config.currencySymbol, 'UGX');
  });

  test('public sign-up closes once any account exists', async () => {
    assert.equal((await run('getAppInfo')).ownerSetupOpen, false);
    await rejects(
      new Parse.User({ username: 'intruder', password: 'x1234' }).signUp(),
      /created by the restaurant administrator/,
    );
  });

  test('bootstrapOwner cannot be called again', async () => {
    await rejects(run('bootstrapOwner', {}, s.owner), /already configured/);
  });

  test('a user created outside the app (e.g. Google) gets no role and no owner setup', async () => {
    const outsider = new Parse.User({ username: 'google-user', password: 'g-pass-123' });
    await outsider.signUp(null, { useMasterKey: true });
    const signedIn = await login('google-user', 'g-pass-123');
    const profile = await run('getMyProfile', {}, signedIn);
    assert.equal(profile.role, null);
    assert.equal(profile.canInitialize, false);
    await rejects(run('bootstrapOwner', {}, signedIn), /already configured/);
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

  test('a rider can still change their own password', async () => {
    const me = Parse.User.createWithoutData(s.rider.id);
    me.set('password', '2468');
    await me.save(null, as(s.rider));
    s.rider = await login('rita', '2468');
  });

  test('user records are not publicly readable', async () => {
    const query = new Parse.Query(Parse.User);
    query.equalTo('username', 'rita');
    assert.equal(await query.first(), undefined);
    const byRider2 = new Parse.Query(Parse.User);
    byRider2.equalTo('username', 'rita');
    assert.equal(await byRider2.first(as(s.rider2)), undefined);
  });

  test('applySecurity runs for the owner and not for others', async () => {
    // google-user was created with the master key and a public-read ACL, like
    // accounts made before this release.
    const legacy = new Parse.Query(Parse.User).equalTo('username', 'google-user');
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
    await rejects(order.save(null, as(s.rider)), /must go through the app|Object not found/);
    await rejects(order.destroy(as(s.rider)), /must go through the app|Object not found/);
  });

  test('another rider cannot see the order', async () => {
    await rejects(new Parse.Query('Order').get(s.orderId, as(s.rider2)), /Object not found/);
  });

  test('clients cannot create business objects directly (S1)', async () => {
    const order = new Parse.Object('Order', { total: 1, status: 'DELIVERED' });
    await rejects(order.save(null, as(s.rider)), /must go through the app/);
    const config = new Parse.Object('Configuration', { maxRiderFloat: 0 });
    await rejects(config.save(null, as(s.owner)), /must go through the app/);
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
    // hybrid: 1000 + 10% of 37000 subtotal
    assert.equal(order.get('commissionAmount'), 4700);
  });

  test('cash handover is created by the rider and confirmed by the cashier', async () => {
    const handover = await run('createHandover', { orderIds: [s.orderId] }, s.rider);
    assert.equal(handover.amount, 40000);
    const row = await new Parse.Query('CashHandover').get(handover.id, as(s.cashier));
    assert.match(row.get('handoverCode'), /^HO-\d{8}-001$/);
    await rejects(
      run('confirmHandover', { handoverId: handover.id, countedAmount: 39000 }, s.cashier),
      /must match the claim/,
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
