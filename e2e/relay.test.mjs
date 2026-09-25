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

  test('paying less than the total needs a note', async () => {
    await rejects(order({ amountToCollect: 20000 }), /Add a note/);
    const short = await order({
      amountToCollect: 25000,
      shortfallNote: 'Regular, pays balance tomorrow',
    });
    const row = await get(short.id);
    assert.equal(row.get('amountToCollect'), 25000);
    await run('transitionOrder', { orderId: short.id, action: 'cancel', reason: 'test' }, s.rider2);
  });

  test('B2: an order that would take the rider over the cash limit is blocked', async () => {
    await settings({ maxRiderFloat: 20000 });
    try {
      await rejects(order(), /Hand over cash first/);
      const mm = await order({
        paymentMethod: 'mobile_money',
        paymentProvider: 'mtn',
        paymentReference: 'B2TEST001',
      });
      await run('transitionOrder', { orderId: mm.id, action: 'cancel', reason: 'test' }, s.rider2);
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
