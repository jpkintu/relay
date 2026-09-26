// In-app notifications.
//
// Each notification is stored per recipient (Notification class, readable
// only by that user). The app polls getNotifications, plays a sound for new
// ones and can show a phone/desktop alert. `tone` picks the sound:
//   new    a new order or cash handover for the kitchen
//   update a change on something you are following
//   alert  needs action: cash limit, reminders, rejected payments, problems
//
// Sending never fails the action that triggered it: errors are logged.

const {
  MASTER,
  requireUser,
  getRoleName,
  loadConfig,
  readAcl,
  riderFloat,
  personName,
} = require('./lib/core');
const { floatLevel, handoverReminderDue } = require('./lib/alerts');
const { dateKey, localClock } = require('./lib/dates');
const { pushNotifications } = require('./push');

const money = (config, amount) =>
  `${config.currencySymbol} ${Math.round(Number(amount) || 0).toLocaleString('en-US')}`;

async function roleUsers(names) {
  const query = new Parse.Query(Parse.Role);
  query.containedIn('name', names);
  const roles = await query.find(MASTER);
  const lists = await Promise.all(
    roles.map((role) => role.getUsers().query().limit(1000).find(MASTER)),
  );
  const byId = new Map();
  for (const user of lists.flat()) if (user.get('active') !== false) byId.set(user.id, user);
  return [...byId.values()];
}

// payload: { kind, tone, title, body, link, order, key }. With `key`, a
// recipient gets that notification at most once (used for reminders).
async function notifyUsers(users, payload) {
  try {
    const recipients = new Map();
    for (const user of users) if (user?.id) recipients.set(user.id, user);
    if (payload.except) recipients.delete(payload.except.id);
    const rows = [];
    for (const user of recipients.values()) {
      if (payload.key) {
        const existing = new Parse.Query('Notification');
        existing.equalTo('recipient', user);
        existing.equalTo('key', payload.key);
        if (await existing.first(MASTER)) continue;
      }
      const row = new Parse.Object('Notification');
      row.set({
        recipient: Parse.User.createWithoutData(user.id),
        kind: payload.kind,
        tone: payload.tone || 'update',
        title: String(payload.title).slice(0, 120),
        body: String(payload.body || '').slice(0, 300),
        link: payload.link || '',
        key: payload.key || '',
      });
      if (payload.order) row.set('order', payload.order);
      row.setACL(readAcl(user, []));
      rows.push(row);
    }
    if (rows.length) {
      await Parse.Object.saveAll(rows, MASTER);
      await pushNotifications(rows);
    }
    return rows.length;
  } catch (error) {
    console.error(`notify ${payload.kind} failed`, error);
    return 0;
  }
}

const notifyUser = (user, payload) => notifyUsers([user], payload);
const notifyStaff = async (payload) => notifyUsers(await roleUsers(['cashier', 'admin']), payload);
const notifyAdmins = async (payload) => notifyUsers(await roleUsers(['admin']), payload);

// Warns the rider once a day when their cash nears or reaches the limit.
async function cashLimitAlert(rider, config, float) {
  const cash = float ?? (await riderFloat(rider));
  const level = floatLevel(cash, config.maxRiderFloat, config.floatWarningPercent);
  if (!level) return 0;
  const day = dateKey(new Date(), config.timezone);
  const amounts = `${money(config, cash)} of your ${money(config, config.maxRiderFloat)} limit`;
  return notifyUser(rider, {
    kind: `cash.limit_${level}`,
    tone: 'alert',
    key: `cash-${level}:${day}`,
    link: '/rider/cash',
    ...(level === 'reached'
      ? {
          title: 'Cash limit reached',
          body: `You hold ${amounts}. Hand over cash: new orders are blocked until you do.`,
        }
      : {
          title: 'Cash limit almost reached',
          body: `You hold ${amounts}. Hand over cash soon.`,
        }),
  });
}

// End-of-day reminder, created the first time the rider's app checks in
// after the reminder hour while they still hold cash.
async function handoverReminder(rider, config, float) {
  const now = new Date();
  if (!handoverReminderDue(float, localClock(now, config.timezone).hour, config.cashReminderHour))
    return 0;
  return notifyUser(rider, {
    kind: 'cash.handover_reminder',
    tone: 'alert',
    key: `handover-reminder:${dateKey(now, config.timezone)}`,
    link: '/rider/cash',
    title: "Hand over today's cash",
    body: `You still hold ${money(config, float)}. Hand it over to the cashier before you finish.`,
  });
}

function toJSON(row) {
  return {
    id: row.id,
    kind: row.get('kind'),
    tone: row.get('tone'),
    title: row.get('title'),
    body: row.get('body'),
    link: row.get('link'),
    read: !!row.get('readAt'),
    createdAt: row.createdAt,
  };
}

Parse.Cloud.define('getNotifications', async (request) => {
  const user = requireUser(request);
  const role = await getRoleName(user);
  if (role === 'rider') {
    const { values: config } = await loadConfig();
    const float = await riderFloat(user);
    await cashLimitAlert(user, config, float);
    await handoverReminder(user, config, float);
  } else if (role === 'cashier' || role === 'admin') {
    // Loaded here: cash.js itself sends notifications.
    const { staleHandoverAlerts } = require('./cash');
    await staleHandoverAlerts((await loadConfig()).values);
  }
  // The bell lists unread notifications only; reading one clears it.
  const listQuery = new Parse.Query('Notification');
  listQuery.equalTo('recipient', user);
  listQuery.doesNotExist('readAt');
  listQuery.descending('createdAt');
  listQuery.limit(40);
  const unreadQuery = new Parse.Query('Notification');
  unreadQuery.equalTo('recipient', user);
  unreadQuery.doesNotExist('readAt');
  const [rows, unread] = await Promise.all([listQuery.find(MASTER), unreadQuery.count(MASTER)]);
  return { items: rows.map(toJSON), unread };
});

// { ids: [...] } marks those; { all: true } marks everything read.
Parse.Cloud.define('markNotificationsRead', async (request) => {
  const user = requireUser(request);
  const query = new Parse.Query('Notification');
  query.equalTo('recipient', user);
  query.doesNotExist('readAt');
  if (!request.params.all) {
    const ids = Array.isArray(request.params.ids) ? request.params.ids.map(String) : [];
    if (!ids.length) return { updated: 0 };
    query.containedIn('objectId', ids.slice(0, 200));
  }
  query.limit(500);
  const rows = await query.find(MASTER);
  const now = new Date();
  rows.forEach((row) => row.set('readAt', now));
  if (rows.length) await Parse.Object.saveAll(rows, MASTER);
  return { updated: rows.length };
});

module.exports = {
  money,
  personName,
  notifyUser,
  notifyUsers,
  notifyStaff,
  notifyAdmins,
  cashLimitAlert,
};
