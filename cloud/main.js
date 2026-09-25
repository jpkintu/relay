const MENU = {
  1: ['Smoky chicken bowl', 18500],
  2: ['Beef rolex deluxe', 12000],
  3: ['Garden rice plate', 14500],
  4: ['Passion fruit juice', 6000],
  5: ['Iced hibiscus', 5500],
  6: ['Breakfast chapati', 8000],
};
const requireUser = (request) => {
  if (!request.user) throw new Parse.Error(209, 'Sign in required');
  if (request.user.get('active') === false) throw new Parse.Error(119, 'Account is inactive');
  return request.user;
};
async function isRider(user) {
  const q = new Parse.Query(Parse.Role);
  q.equalTo('name', 'rider');
  q.equalTo('users', user);
  return !!(await q.first({ useMasterKey: true }));
}
async function isStaff(user) {
  const q = new Parse.Query(Parse.Role);
  q.containedIn('name', ['cashier', 'admin']);
  q.equalTo('users', user);
  return !!(await q.first({ useMasterKey: true }));
}
async function audit(actor, action, object, before, after) {
  const log = new Parse.Object('AuditLog');
  log.set({
    actor,
    action,
    entityType: object.className,
    entityId: object.id,
    beforeJson: JSON.stringify(before || {}),
    afterJson: JSON.stringify(after || {}),
  });
  const acl = new Parse.ACL();
  acl.setRoleReadAccess('admin', true);
  log.setACL(acl);
  await log.save(null, { useMasterKey: true });
}
function orderAcl(user) {
  const acl = new Parse.ACL(user);
  for (const role of ['cashier', 'admin']) {
    acl.setRoleReadAccess(role, true);
    acl.setRoleWriteAccess(role, true);
  }
  return acl;
}

Parse.Cloud.define('createOrder', async (request) => {
  const rider = requireUser(request),
    p = request.params;
  if (!(await isRider(rider))) throw new Parse.Error(119, 'Rider role required');
  if (rider.get('active') === false) throw new Parse.Error(119, 'Account is inactive');
  if (!String(p.customerName || '').trim() || !String(p.deliveryAddress || '').trim())
    throw new Parse.Error(141, 'Customer and address are required');
  if (!Array.isArray(p.items) || !p.items.length)
    throw new Parse.Error(141, 'Add at least one item');
  const activeQ = new Parse.Query('Order');
  activeQ.equalTo('createdBy', rider);
  activeQ.notContainedIn('status', ['DELIVERED', 'CANCELLED']);
  const floatQ = new Parse.Query('Order');
  floatQ.equalTo('createdBy', rider);
  floatQ.equalTo('status', 'DELIVERED');
  floatQ.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  floatQ.limit(1000);
  const ids = p.items.map((line) => String(line.id));
  const menuQuery = new Parse.Query('MenuItem');
  menuQuery.containedIn('objectId', ids);
  const [savedMenu, config] = await Promise.all([
    menuQuery.find({ useMasterKey: true }),
    new Parse.Query('Configuration').first({ useMasterKey: true }),
  ]);
  const byId = new Map(savedMenu.map((m) => [m.id, m]));
  const [activeCount, cashOrders] = await Promise.all([
    activeQ.count({ useMasterKey: true }),
    floatQ.find({ useMasterKey: true }),
  ]);
  if (!config?.get('allowBatching') && activeCount)
    throw new Parse.Error(141, 'Finish your current order before creating another');
  const float = cashOrders.reduce((sum, o) => sum + Number(o.get('amountCollected') || 0), 0);
  if (config?.get('maxRiderFloat') > 0 && float >= config.get('maxRiderFloat'))
    throw new Parse.Error(141, 'Hand over cash before creating another order');
  let subtotal = 0;
  const lines = p.items.map((line) => {
    const saved = byId.get(String(line.id)),
      qty = Number(line.quantity);
    if (
      !saved ||
      !saved.get('active') ||
      !saved.get('availableToday') ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 50
    )
      throw new Parse.Error(141, 'Invalid or unavailable item');
    const name = saved.get('title'),
      price = Number(saved.get('price'));
    subtotal += price * qty;
    return { name, price, qty };
  });
  const fee = Math.max(0, Number(p.deliveryFee ?? config?.get('defaultDeliveryFee') ?? 3000) || 0),
    total = subtotal + fee,
    order = new Parse.Object('Order');
  order.set({
    orderCode: `ORD-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(Date.now()).slice(-4)}`,
    channel: p.channel || 'walkin',
    createdBy: rider,
    customerName: String(p.customerName).trim(),
    customerPhone: String(p.customerPhone || ''),
    deliveryAddress: String(p.deliveryAddress).trim(),
    subtotal,
    deliveryFee: fee,
    total,
    paymentMethod: p.paymentMethod || 'cash',
    amountCollected: 0,
    status: 'PLACED',
    restaurantStatus: 'pending',
    cashStatus: p.paymentMethod === 'cash' ? 'NOT_COLLECTED' : 'NOT_APPLICABLE',
    commissionAmount: 0,
    commissionPaid: false,
  });
  order.setACL(orderAcl(rider));
  await order.save(null, { useMasterKey: true });
  const children = lines.map((line) => {
    const item = new Parse.Object('OrderItem');
    item.set({
      order,
      itemNameSnapshot: line.name,
      unitPriceSnapshot: line.price,
      quantity: line.qty,
      lineTotal: line.price * line.qty,
      notes: '',
    });
    item.setACL(orderAcl(rider));
    return item;
  });
  await Parse.Object.saveAll(children, { useMasterKey: true });
  await audit(rider, 'order.placed', order, null, { status: 'PLACED', total });
  return { id: order.id, orderCode: order.get('orderCode'), total };
});

Parse.Cloud.define('transitionOrder', async (request) => {
  const actor = requireUser(request),
    order = await new Parse.Query('Order').get(request.params.orderId, { useMasterKey: true }),
    action = request.params.action;
  const rules = {
      accept: ['PLACED', 'ACCEPTED', 'accepted'],
      prepare: ['ACCEPTED', 'PREPARING', 'preparing'],
      ready: ['PREPARING', 'READY', 'ready'],
      pickup: ['READY', 'PICKED_UP', 'picked_up'],
      deliver: ['PICKED_UP', 'DELIVERED', 'picked_up'],
    },
    rule = rules[action];
  if (!rule || order.get('status') !== rule[0])
    throw new Parse.Error(141, 'Invalid status transition');
  if (['accept', 'prepare', 'ready'].includes(action) && !(await isStaff(actor)))
    throw new Parse.Error(119, 'Staff access required');
  if (
    ['pickup', 'deliver'].includes(action) &&
    order.get('createdBy').id !== actor.id &&
    !(await isStaff(actor))
  )
    throw new Parse.Error(119, 'Not allowed');
  const before = { status: order.get('status'), restaurantStatus: order.get('restaurantStatus') };
  order.set({ status: rule[1], restaurantStatus: rule[2] });
  if (action === 'pickup') order.set('pickedUpAt', new Date());
  if (action === 'deliver') {
    const amount = Number(request.params.amountCollected ?? order.get('total'));
    if (amount < order.get('total')) throw new Parse.Error(141, 'Collected amount is below total');
    const rider = await order.get('createdBy').fetch({ useMasterKey: true });
    const kind = rider.get('commissionType') || 'per_order',
      base = Number(rider.get('commissionPerOrder') || 0),
      percent = Number(rider.get('commissionPercent') || 0);
    const commission =
      kind === 'percent'
        ? (order.get('subtotal') * percent) / 100
        : kind === 'hybrid'
          ? base + (order.get('subtotal') * percent) / 100
          : base;
    order.set({
      deliveredAt: new Date(),
      amountCollected: order.get('paymentMethod') === 'cash' ? amount : 0,
      paymentCollectedBy: actor,
      commissionAmount: Math.round(commission),
      cashStatus: order.get('paymentMethod') === 'cash' ? 'WITH_RIDER' : 'NOT_APPLICABLE',
    });
  }
  await order.save(null, { useMasterKey: true });
  await audit(actor, `order.${action}`, order, before, { status: rule[1] });
  return { status: rule[1] };
});

Parse.Cloud.define('createHandover', async (request) => {
  const rider = requireUser(request),
    ids = request.params.orderIds;
  if (!(await isRider(rider))) throw new Parse.Error(119, 'Rider role required');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw new Parse.Error(141, 'Select unique orders');
  const q = new Parse.Query('Order');
  q.containedIn('objectId', ids);
  q.equalTo('createdBy', rider);
  q.equalTo('status', 'DELIVERED');
  q.equalTo('cashStatus', 'WITH_RIDER');
  const orders = await q.find({ useMasterKey: true });
  if (orders.length !== ids.length) throw new Parse.Error(141, 'Invalid handover orders');
  const amount = orders.reduce((s, o) => s + Number(o.get('amountCollected') || 0), 0),
    row = new Parse.Object('CashHandover');
  row.set({
    handoverCode: `HO-${String(Date.now()).slice(-6)}`,
    rider,
    amount,
    orderCount: orders.length,
    orders,
    status: 'pending',
    handedOverAt: new Date(),
    notes: String(request.params.notes || ''),
  });
  row.setACL(orderAcl(rider));
  await row.save(null, { useMasterKey: true });
  orders.forEach((o) => o.set('cashStatus', 'HANDOVER_PENDING'));
  await Parse.Object.saveAll(orders, { useMasterKey: true });
  await audit(rider, 'cash.handover_created', row, null, { amount });
  return { id: row.id, amount };
});

Parse.Cloud.define('confirmHandover', async (request) => {
  const cashier = requireUser(request);
  if (!(await isStaff(cashier))) throw new Parse.Error(119, 'Staff access required');
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, {
    useMasterKey: true,
  });
  if (row.get('status') !== 'pending') throw new Parse.Error(141, 'Already resolved');
  const counted = Number(request.params.countedAmount);
  if (!Number.isFinite(counted) || counted !== Number(row.get('amount')))
    throw new Parse.Error(141, 'Counted cash must match the claim; dispute any variance');
  const pointers = row.get('orders') || [];
  const orders = await Promise.all(pointers.map((ptr) => ptr.fetch({ useMasterKey: true })));
  if (orders.some((o) => o.get('cashStatus') !== 'HANDOVER_PENDING'))
    throw new Parse.Error(141, 'Orders are no longer pending this handover');
  orders.forEach((order) => order.set({ cashStatus: 'RECONCILED', settledAt: new Date() }));
  await Parse.Object.saveAll(orders, { useMasterKey: true });
  row.set({ status: 'confirmed', cashier, confirmedAt: new Date(), countedAmount: counted });
  await row.save(null, { useMasterKey: true });
  await audit(
    cashier,
    'cash.handover_confirmed',
    row,
    { status: 'pending' },
    { status: 'confirmed', countedAmount: counted },
  );
  return { status: 'confirmed' };
});

Parse.Cloud.define('disputeHandover', async (request) => {
  const cashier = requireUser(request);
  if (!(await isStaff(cashier))) throw new Parse.Error(119, 'Staff access required');
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, {
    useMasterKey: true,
  });
  if (row.get('status') !== 'pending')
    throw new Parse.Error(141, 'Only pending handovers can be disputed');
  const reason = String(request.params.reason || '').trim(),
    counted = Number(request.params.countedAmount);
  if (reason.length < 5 || !Number.isFinite(counted) || counted < 0)
    throw new Parse.Error(141, 'Enter a reason and physical cash count');
  row.set({
    status: 'disputed',
    cashier,
    disputeReason: reason,
    countedAmount: counted,
    disputedAt: new Date(),
  });
  await row.save(null, { useMasterKey: true });
  await audit(
    cashier,
    'cash.handover_disputed',
    row,
    { status: 'pending', amount: row.get('amount') },
    { status: 'disputed', countedAmount: counted, reason },
  );
  return { status: 'disputed' };
});

Parse.Cloud.define('reopenHandover', async (request) => {
  const actor = await adminOnly(request);
  const row = await new Parse.Query('CashHandover').get(request.params.handoverId, {
    useMasterKey: true,
  });
  if (row.get('status') !== 'disputed')
    throw new Parse.Error(141, 'Only disputed handovers can be reopened');
  const note = String(request.params.note || '').trim();
  if (note.length < 5) throw new Parse.Error(141, 'Enter a resolution note');
  row.set({ status: 'pending', resolutionNote: note, resolvedBy: actor, resolvedAt: new Date() });
  await row.save(null, { useMasterKey: true });
  await audit(
    actor,
    'cash.dispute_reopened',
    row,
    { status: 'disputed', reason: row.get('disputeReason') },
    { status: 'pending', note },
  );
  return { status: 'pending' };
});

// Preview data is intentionally isolated from operational orders. It uses the
// same status model and database, so the live preview always exercises backend code.
Parse.Cloud.define('createPreviewOrder', async (request) => {
  const p = request.params;
  if (!String(p.customerName || '').trim() || !String(p.deliveryAddress || '').trim())
    throw new Parse.Error(141, 'Customer and address are required');
  if (!Array.isArray(p.items) || !p.items.length)
    throw new Parse.Error(141, 'Add at least one item');
  let subtotal = 0;
  const itemSummary = p.items
    .map((line) => {
      const menu = MENU[String(line.id)],
        qty = Number(line.quantity);
      if (!menu || !Number.isInteger(qty) || qty < 1) throw new Parse.Error(141, 'Invalid item');
      subtotal += menu[1] * qty;
      return `${qty}× ${menu[0]}`;
    })
    .join(' · ');
  const row = new Parse.Object('DemoOrder'),
    fee = 3000;
  row.set({
    orderCode: `DEMO-${String(Date.now()).slice(-6)}`,
    customerName: String(p.customerName).trim(),
    deliveryAddress: String(p.deliveryAddress).trim(),
    riderName: 'Preview rider',
    itemSummary,
    subtotal,
    deliveryFee: fee,
    total: subtotal + fee,
    status: 'PLACED',
    restaurantStatus: 'pending',
    isDemo: true,
  });
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  row.setACL(acl);
  await row.save(null, { useMasterKey: true });
  return { id: row.id, orderCode: row.get('orderCode'), total: row.get('total') };
});
Parse.Cloud.define('getPreviewOrders', async () => {
  const q = new Parse.Query('DemoOrder');
  q.notContainedIn('status', ['PICKED_UP', 'DELIVERED', 'CANCELLED']);
  q.descending('createdAt');
  q.limit(30);
  let rows = await q.find({ useMasterKey: true });
  if (!rows.length) {
    const seeds = [
      ['DEMO-0218', 'Joel M.', '2× Smoky chicken bowl · 1× Juice', 43000, 'PLACED'],
      ['DEMO-0217', 'Sarah N.', '2× Garden rice plate', 32000, 'PREPARING'],
      ['DEMO-0214', 'Joseph K.', '1× Chicken bowl · 1× Hibiscus', 24500, 'READY'],
    ];
    rows = seeds.map(([code, customer, items, total, status]) => {
      const row = new Parse.Object('DemoOrder');
      row.set({
        orderCode: code,
        customerName: customer,
        deliveryAddress: 'Kampala Central',
        riderName: 'R-014 · Amina',
        itemSummary: items,
        total,
        status,
        restaurantStatus: String(status).toLowerCase(),
        isDemo: true,
      });
      row.setACL(new Parse.ACL());
      return row;
    });
    await Parse.Object.saveAll(rows, { useMasterKey: true });
  }
  return rows.map((row) => ({
    id: row.id,
    code: row.get('orderCode'),
    rider: row.get('riderName'),
    customer: row.get('customerName'),
    items: row.get('itemSummary'),
    total: row.get('total'),
    status: row.get('status'),
  }));
});
Parse.Cloud.define('transitionPreviewOrder', async (request) => {
  const row = await new Parse.Query('DemoOrder').get(request.params.orderId, {
      useMasterKey: true,
    }),
    action = request.params.action,
    rules = {
      accept: ['PLACED', 'ACCEPTED'],
      prepare: ['ACCEPTED', 'PREPARING'],
      ready: ['PREPARING', 'READY'],
      pickup: ['READY', 'PICKED_UP'],
    },
    rule = rules[action];
  if (!rule || row.get('status') !== rule[0])
    throw new Parse.Error(141, 'Invalid preview transition');
  row.set('status', rule[1]);
  row.set('restaurantStatus', rule[1].toLowerCase());
  await row.save(null, { useMasterKey: true });
  return { status: rule[1] };
});

async function adminOnly(request) {
  const user = requireUser(request);
  const q = new Parse.Query(Parse.Role);
  q.equalTo('name', 'admin');
  q.equalTo('users', user);
  if (!(await q.first({ useMasterKey: true }))) throw new Parse.Error(119, 'Admin role required');
  return user;
}
async function ensureRole(name) {
  const q = new Parse.Query(Parse.Role);
  q.equalTo('name', name);
  let role = await q.first({ useMasterKey: true });
  if (!role) {
    const acl = new Parse.ACL();
    acl.setRoleReadAccess('admin', true);
    acl.setRoleWriteAccess('admin', true);
    role = new Parse.Role(name, acl);
    await role.save(null, { useMasterKey: true });
  }
  return role;
}
// Only the sole existing user can initialize the first owner role. Never allow
// arbitrary signed-in users to claim ownership of a populated restaurant.
Parse.Cloud.define('bootstrapOwner', async (request) => {
  const user = requireUser(request);
  const adminQuery = new Parse.Query(Parse.Role);
  adminQuery.equalTo('name', 'admin');
  const existing = await adminQuery.first({ useMasterKey: true });
  if (existing) throw new Parse.Error(119, 'Owner already configured');
  const users = await new Parse.Query(Parse.User).count({ useMasterKey: true });
  if (users !== 1) throw new Parse.Error(119, 'Owner setup requires exactly one existing account');
  const role = await ensureRole('admin');
  role.getUsers().add(user);
  await role.save(null, { useMasterKey: true });
  const q = new Parse.Query('MenuItem');
  if (!(await q.first({ useMasterKey: true }))) {
    const seed = Object.values(MENU).map(([title, price], i) => {
      const item = new Parse.Object('MenuItem');
      item.set({
        title,
        price,
        category: i < 3 ? 'Mains' : i < 5 ? 'Drinks' : 'Breakfast',
        active: true,
        availableToday: true,
        sortOrder: i,
      });
      const acl = new Parse.ACL();
      acl.setRoleReadAccess('admin', true);
      acl.setRoleWriteAccess('admin', true);
      item.setACL(acl);
      return item;
    });
    await Parse.Object.saveAll(seed, { useMasterKey: true });
  }
  await audit(user, 'owner.initialized', role, null, { userId: user.id });
  return { ok: true };
});

Parse.Cloud.define('adminListSetup', async (request) => {
  await adminOnly(request);
  const uq = new Parse.Query(Parse.User);
  uq.limit(100);
  const mq = new Parse.Query('MenuItem');
  mq.ascending('sortOrder');
  mq.limit(100);
  const cq = new Parse.Query('Configuration');
  const categoryQ = new Parse.Query('MenuCategory');
  categoryQ.ascending('sortOrder');
  const rq = new Parse.Query(Parse.Role);
  rq.containedIn('name', ['rider', 'cashier', 'admin']);
  const [users, menu, configs, roles, categories] = await Promise.all([
    uq.find({ useMasterKey: true }),
    mq.find({ useMasterKey: true }),
    cq.find({ useMasterKey: true }),
    rq.find({ useMasterKey: true }),
    categoryQ.find({ useMasterKey: true }),
  ]);
  const members = {};
  for (const role of roles) {
    const ids = (await role.getUsers().query().find({ useMasterKey: true })).map((u) => u.id);
    for (const id of ids) members[id] = role.getName();
  }
  return {
    team: users.map((u) => ({
      id: u.id,
      name: u.get('name') || u.getUsername(),
      username: u.getUsername(),
      phone: u.get('phone') || '',
      active: u.get('active') !== false,
      role: members[u.id] || 'unassigned',
      commissionType: u.get('commissionType') || 'per_order',
      commissionPerOrder: u.get('commissionPerOrder') || 0,
      commissionPercent: u.get('commissionPercent') || 0,
    })),
    menu: menu.map((m) => ({
      id: m.id,
      title: m.get('title'),
      price: m.get('price'),
      category: m.get('category'),
      active: m.get('active') !== false,
      availableToday: m.get('availableToday') !== false,
    })),
    categories: categories.map((c) => ({
      id: c.id,
      title: c.get('title'),
      active: c.get('active') !== false,
    })),
    settings: configs[0]
      ? {
          id: configs[0].id,
          restaurantName: configs[0].get('restaurantName'),
          currencySymbol: configs[0].get('currencySymbol'),
          defaultDeliveryFee: configs[0].get('defaultDeliveryFee'),
          maxRiderFloat: configs[0].get('maxRiderFloat'),
          allowBatching: configs[0].get('allowBatching'),
        }
      : null,
  };
});

Parse.Cloud.define('adminCreateTeamMember', async (request) => {
  const actor = await adminOnly(request),
    p = request.params;
  const roleName = p.role;
  if (!['rider', 'cashier'].includes(roleName)) throw new Parse.Error(141, 'Invalid role');
  const name = String(p.name || '').trim(),
    username = String(p.username || '')
      .trim()
      .toLowerCase(),
    pin = String(p.pin || '');
  if (!name || !/^[-a-z0-9_.]{3,32}$/.test(username) || pin.length < 4 || pin.length > 32)
    throw new Parse.Error(141, 'Enter a name, valid username and PIN of at least 4 characters');
  const user = new Parse.User();
  user.set({
    username,
    password: pin,
    name,
    phone: String(p.phone || ''),
    active: true,
    commissionType: 'per_order',
    commissionPerOrder: 0,
    commissionPercent: 0,
  });
  await user.signUp(null, { useMasterKey: true });
  const role = await ensureRole(roleName);
  role.getUsers().add(user);
  await role.save(null, { useMasterKey: true });
  await audit(actor, 'team.created', user, null, { name, role: roleName });
  return { id: user.id, name, username, role: roleName };
});

Parse.Cloud.define('adminUpdateMember', async (request) => {
  const actor = await adminOnly(request),
    p = request.params,
    u = await new Parse.Query(Parse.User).get(p.id, { useMasterKey: true });
  if (u.id === actor.id && p.active === false)
    throw new Parse.Error(119, 'You cannot deactivate yourself');
  const before = {
    active: u.get('active'),
    commissionType: u.get('commissionType'),
    commissionPerOrder: u.get('commissionPerOrder'),
    commissionPercent: u.get('commissionPercent'),
  };
  if (typeof p.active === 'boolean') u.set('active', p.active);
  if (p.commissionType !== undefined) {
    if (!['per_order', 'percent', 'hybrid'].includes(p.commissionType))
      throw new Parse.Error(141, 'Invalid commission type');
    u.set('commissionType', p.commissionType);
  }
  for (const key of ['commissionPerOrder', 'commissionPercent'])
    if (p[key] !== undefined) {
      const n = Number(p[key]);
      if (!Number.isFinite(n) || n < 0 || n > (key === 'commissionPercent' ? 100 : 1000000))
        throw new Parse.Error(141, 'Invalid commission value');
      u.set(key, n);
    }
  await u.save(null, { useMasterKey: true });
  await audit(actor, 'team.updated', u, before, {
    active: u.get('active'),
    commissionType: u.get('commissionType'),
    commissionPerOrder: u.get('commissionPerOrder'),
    commissionPercent: u.get('commissionPercent'),
  });
  return { ok: true };
});

Parse.Cloud.define('adminChangeRole', async (request) => {
  const actor = await adminOnly(request),
    { userId, role: next } = request.params;
  if (!['rider', 'cashier'].includes(next))
    throw new Parse.Error(141, 'Only rider and cashier roles can be assigned');
  const user = await new Parse.Query(Parse.User).get(userId, { useMasterKey: true });
  if (user.id === actor.id) throw new Parse.Error(119, 'You cannot change your own role');
  const q = new Parse.Query(Parse.Role);
  q.containedIn('name', ['admin', 'rider', 'cashier']);
  const roles = await q.find({ useMasterKey: true });
  const adminRole = roles.find((r) => r.getName() === 'admin');
  if (adminRole) {
    const member = await adminRole
      .getUsers()
      .query()
      .get(userId, { useMasterKey: true })
      .catch(() => null);
    if (member) throw new Parse.Error(119, 'Admin roles cannot be changed here');
  }
  let before = 'unassigned';
  for (const role of roles.filter((r) => ['rider', 'cashier'].includes(r.getName()))) {
    const existing = await role
      .getUsers()
      .query()
      .get(userId, { useMasterKey: true })
      .catch(() => null);
    if (existing) {
      before = role.getName();
      role.getUsers().remove(user);
      await role.save(null, { useMasterKey: true });
    }
  }
  const destination = await ensureRole(next);
  destination.getUsers().add(user);
  await destination.save(null, { useMasterKey: true });
  await audit(actor, 'team.role_changed', user, { role: before }, { role: next });
  return { role: next };
});

Parse.Cloud.define('adminSaveCategory', async (request) => {
  const actor = await adminOnly(request),
    p = request.params,
    title = String(p.title || '').trim();
  if (!title || title.length > 80) throw new Parse.Error(141, 'Category title is required');
  const category = p.id
    ? await new Parse.Query('MenuCategory').get(p.id, { useMasterKey: true })
    : new Parse.Object('MenuCategory');
  const before = p.id ? category.toJSON() : null;
  category.set({ title, active: p.active !== false, sortOrder: Number(p.sortOrder) || 0 });
  const acl = new Parse.ACL();
  acl.setRoleReadAccess('admin', true);
  acl.setRoleWriteAccess('admin', true);
  category.setACL(acl);
  await category.save(null, { useMasterKey: true });
  await audit(actor, 'menu.category_saved', category, before, {
    title,
    active: category.get('active'),
  });
  return { id: category.id };
});

Parse.Cloud.define('adminSaveMenuItem', async (request) => {
  const actor = await adminOnly(request),
    p = request.params,
    m = p.id
      ? await new Parse.Query('MenuItem').get(p.id, { useMasterKey: true })
      : new Parse.Object('MenuItem');
  const title = String(p.title || '').trim(),
    price = Number(p.price);
  if (!title || !Number.isFinite(price) || price < 0)
    throw new Parse.Error(141, 'A title and nonnegative price are required');
  const before = p.id ? m.toJSON() : null;
  m.set({
    title,
    price,
    category: String(p.category || 'Mains').trim(),
    active: p.active !== false,
    availableToday: p.availableToday !== false,
  });
  const acl = new Parse.ACL();
  acl.setRoleReadAccess('admin', true);
  acl.setRoleWriteAccess('admin', true);
  m.setACL(acl);
  await m.save(null, { useMasterKey: true });
  await audit(actor, 'menu.saved', m, before, { title, price });
  return { id: m.id };
});

Parse.Cloud.define('adminSaveSettings', async (request) => {
  const actor = await adminOnly(request),
    p = request.params,
    q = new Parse.Query('Configuration');
  let c = await q.first({ useMasterKey: true });
  const before = c ? c.toJSON() : null;
  if (!c) c = new Parse.Object('Configuration');
  const fee = Number(p.defaultDeliveryFee),
    max = Number(p.maxRiderFloat);
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(max) || max < 0)
    throw new Parse.Error(141, 'Fee and float limit must be nonnegative');
  c.set({
    restaurantName: String(p.restaurantName || 'Restaurant').trim(),
    currencySymbol: String(p.currencySymbol || 'UGX').trim(),
    defaultDeliveryFee: fee,
    maxRiderFloat: max,
    allowBatching: !!p.allowBatching,
  });
  const acl = new Parse.ACL();
  acl.setRoleReadAccess('admin', true);
  acl.setRoleWriteAccess('admin', true);
  c.setACL(acl);
  await c.save(null, { useMasterKey: true });
  await audit(actor, 'configuration.saved', c, before, c.toJSON());
  return { id: c.id };
});

Parse.Cloud.define('getOperationalMenu', async () => {
  const q = new Parse.Query('MenuItem');
  q.equalTo('active', true);
  q.equalTo('availableToday', true);
  q.limit(100);
  const [menu, settings] = await Promise.all([
    q.find({ useMasterKey: true }),
    new Parse.Query('Configuration').first({ useMasterKey: true }),
  ]);
  return {
    items: menu.map((m) => ({
      id: m.id,
      title: m.get('title'),
      category: m.get('category') || 'Mains',
      price: m.get('price'),
    })),
    deliveryFee: settings?.get('defaultDeliveryFee') ?? 3000,
    currencySymbol: settings?.get('currencySymbol') || 'UGX',
  };
});

async function shiftBalance(user) {
  const q = new Parse.Query('Order');
  q.equalTo('createdBy', user);
  q.equalTo('status', 'DELIVERED');
  q.containedIn('cashStatus', ['WITH_RIDER', 'HANDOVER_PENDING']);
  q.limit(1000);
  const orders = await q.find({ useMasterKey: true });
  return orders.reduce((sum, o) => sum + Number(o.get('amountCollected') || 0), 0);
}
Parse.Cloud.define('getMyShift', async (request) => {
  const user = requireUser(request);
  const q = new Parse.Query('Shift');
  q.equalTo('operator', user);
  q.equalTo('status', 'open');
  q.descending('startedAt');
  const shift = await q.first({ useMasterKey: true });
  if (!shift) return { shift: null };
  let expected = null;
  if (shift.get('kind') === 'cashier') {
    const hq = new Parse.Query('CashHandover');
    hq.equalTo('cashier', user);
    hq.equalTo('status', 'confirmed');
    hq.greaterThanOrEqualTo('confirmedAt', shift.get('startedAt'));
    hq.limit(1000);
    const handovers = await hq.find({ useMasterKey: true });
    expected =
      Number(shift.get('openingFloat') || 0) +
      handovers.reduce((sum, h) => sum + Number(h.get('amount') || 0), 0);
  }
  return {
    shift: {
      id: shift.id,
      kind: shift.get('kind'),
      startedAt: shift.get('startedAt'),
      openingFloat: shift.get('openingFloat'),
      expectedTill: expected,
      float: shift.get('kind') === 'rider' ? await shiftBalance(user) : null,
    },
  };
});
Parse.Cloud.define('startShift', async (request) => {
  const user = requireUser(request);
  const [rider, staff] = await Promise.all([isRider(user), isStaff(user)]);
  const kind = request.params.kind;
  if (
    (kind === 'rider' && !rider) ||
    (kind === 'cashier' && !staff) ||
    !['rider', 'cashier'].includes(kind)
  )
    throw new Parse.Error(119, 'Not allowed to start this shift');
  const q = new Parse.Query('Shift');
  q.equalTo('operator', user);
  q.equalTo('status', 'open');
  if (await q.first({ useMasterKey: true }))
    throw new Parse.Error(141, 'Close the current shift first');
  const opening = Number(request.params.openingFloat || 0);
  if (!Number.isFinite(opening) || opening < 0) throw new Parse.Error(141, 'Invalid opening cash');
  const row = new Parse.Object('Shift');
  row.set({
    operator: user,
    kind,
    status: 'open',
    openingFloat: kind === 'cashier' ? opening : 0,
    startedAt: new Date(),
  });
  row.setACL(orderAcl(user));
  await row.save(null, { useMasterKey: true });
  await audit(user, 'shift.started', row, null, { kind, openingFloat: row.get('openingFloat') });
  return { id: row.id };
});
Parse.Cloud.define('endShift', async (request) => {
  const user = requireUser(request),
    row = await new Parse.Query('Shift').get(request.params.shiftId, { useMasterKey: true });
  if (row.get('operator')?.id !== user.id || row.get('status') !== 'open')
    throw new Parse.Error(119, 'No open shift found');
  const balance = row.get('kind') === 'rider' ? await shiftBalance(user) : 0;
  if (balance > 0 && request.params.acknowledgeCash !== true)
    throw new Parse.Error(141, 'Cash remains with you. Acknowledge it before ending your shift');
  let expected = null,
    counted = null,
    variance = null;
  if (row.get('kind') === 'cashier') {
    const hq = new Parse.Query('CashHandover');
    hq.equalTo('cashier', user);
    hq.equalTo('status', 'confirmed');
    hq.greaterThanOrEqualTo('confirmedAt', row.get('startedAt'));
    hq.limit(1000);
    const handovers = await hq.find({ useMasterKey: true });
    expected =
      Number(row.get('openingFloat') || 0) +
      handovers.reduce((sum, h) => sum + Number(h.get('amount') || 0), 0);
    counted = Number(request.params.physicalCount);
    if (!Number.isFinite(counted) || counted < 0)
      throw new Parse.Error(141, 'Enter physical till count');
    variance = counted - expected;
  }
  row.set({
    status: 'closed',
    endedAt: new Date(),
    closingFloat: balance,
    acknowledgedCash: balance > 0,
    expectedTill: expected,
    physicalCount: counted,
    variance,
  });
  await row.save(null, { useMasterKey: true });
  await audit(
    user,
    'shift.closed',
    row,
    { status: 'open' },
    { balance, expectedTill: expected, physicalCount: counted, variance },
  );
  return { balance, expectedTill: expected, variance };
});
