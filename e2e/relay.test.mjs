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
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ParseServer } from 'parse-server';

const require = createRequire(import.meta.url);
const Parse = require('parse/node');

// Check for stale handovers on every staff poll (the app throttles it).
process.env.RELAY_STALE_CHECK_MS = '0';

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

let httpServer;
let parseServer;

before(async () => {
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
const run = (name, params, user) => {
  const pin = PINS[user?.get('username')];
  const withPin =
    PIN_STEPS.includes(name) && params && !('pin' in params) && pin ? { ...params, pin } : params;
  return Parse.Cloud.run(name, withPin, user ? as(user) : {});
};
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

  test('creates a new owner even though accounts already exist', async () => {
    const result = await Parse.Cloud.run(
      'recoverOwner',
      { username: 'Boss', password: 'boss-pass-1', email: 'boss@example.com' },
      master,
    );
    assert.deepEqual(result, { username: 'boss', created: true, role: 'admin' });
    const boss = await login('boss', 'boss-pass-1');
    assert.equal((await run('getMyProfile', {}, boss)).role, 'admin');
  });

  test('resets the password of an existing account', async () => {
    const result = await Parse.Cloud.run(
      'recoverOwner',
      { username: 'boss', password: 'new-boss-pass' },
      master,
    );
    assert.equal(result.created, false);
    await rejects(login('boss', 'boss-pass-1'), /Invalid username\/password/);
    const boss = await login('boss', 'new-boss-pass');
    assert.equal((await run('getMyProfile', {}, boss)).role, 'admin');
  });

  test('rejects weak passwords', async () => {
    await rejects(
      Parse.Cloud.run('recoverOwner', { username: 'boss', password: 'short' }, master),
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
      { provider: 'airtel', label: 'Airtel Money', code: '654321', name: 'Relay Foods' },
      { provider: 'mtn', label: 'MTN MoMo', code: '123456', name: 'Relay Foods' },
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
    await rejects(run('getReportOptions', {}, s.rider), /cashier or admin role required/);
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
    await rejects(run('getPaymentsLedger', range, s.rider), /cashier or admin role required/);
    await rejects(
      run('getPaymentsLedger', { from: '2026-02-30', to: '2026-03-01' }, s.owner),
      /Dates must look like/,
    );
    await rejects(run('getPaymentsLedger', { ...range, method: 'card' }, s.owner), /Payment type/);
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
    await rejects(run('adminSearchOrders', range, s.cashier), /admin role required/);
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
    await rejects(run('getCommissionLedger', range, s.rider), /admin role required/);
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
    await rejects(run('getRiderEarnings', range, s.cashier), /rider or admin role required/);
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
    await rejects(run('getOperationsReport', range, s.cashier), /admin role required/);
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
    const rita = await first(Parse.User, (q) => q.equalTo('username', 'rita'));
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
  const before = await run('getMyProfile', {}, s.owner);
  assert.equal(before.config.restaurantNameSet, false);
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
    const niaUser = await new Parse.Query(Parse.User).equalTo('username', 'nia').first(M);
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
        res.status(req.params.name === 'gone' ? 410 : 201).end();
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
    await rejects(run('getShiftReport', {}, s.cleo), /admin role required/);
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
    const me = await new Parse.Query(Parse.User).get(s.pia.id, M);
    me.set('pinLockedUntil', new Date(Date.now() - 1000));
    await me.save(null, M);
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
