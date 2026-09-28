// Relay Hosted: keeps restaurants apart (docs/HOSTED.md).
//
// Every Cloud function and job runs in a tenant context (the restaurant of the
// signed-in person, or the one a public request names, or none for platform
// work). In a tenant context, installed once at start:
//
//   - every query on a restaurant's classes gets `tenant = <restaurant>`
//     (Parse.Query#toJSON is what find, first, count, get, each and
//     sub-queries all serialise through);
//   - new records get their `tenant` set before they are saved;
//   - the role names admin / cashier / rider mean this restaurant's roles
//     (admin__<id> …) in role queries, new roles and ACLs, and read back as the
//     plain name, so the rest of the code needs no changes.
//
// Outside a tenant context (platform console, the loop in jobs) nothing is
// rewritten.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// Classes that belong to one restaurant.
const SCOPED = new Set([
  '_User',
  'Order',
  'OrderItem',
  'CashHandover',
  'TillPayout',
  'Shift',
  'AuditLog',
  'Configuration',
  'MenuItem',
  'MenuCategory',
  'Accompaniment',
  'Customer',
  'Counter',
  'DemoOrder',
  'Notification',
  'PushSubscription',
  'ZReport',
  'ErrorLog',
  'Secret',
  'AdminUnlock',
  'Invoice',
]);
// Secret rows shared by the whole platform (push keys, server address).
const GLOBAL_SECRETS = new Set(['vapid', 'serverAddress']);
const BASE_ROLES = ['admin', 'cashier', 'rider'];
const SEPARATOR = '__';

const current = () => storage.getStore()?.tenant || null;
const currentCode = () => storage.getStore()?.code || '';
// Runs `fn` for one restaurant (`tenant` = its id; `code` = its sign-in code).
const runAs = (tenant, fn, code = '') => storage.run({ tenant: tenant || null, code }, fn);
const withoutTenant = (fn) => storage.run({ tenant: null, code: '' }, fn);

const roleName = (base, tenant = current()) =>
  tenant && BASE_ROLES.includes(base) ? `${base}${SEPARATOR}${tenant}` : base;
const baseRole = (name) => String(name || '').split(SEPARATOR)[0];
// Usernames: unique per restaurant, stored as name@restaurant-code.
const fullUsername = (name, code = currentCode()) =>
  code && !String(name).includes('@') ? `${name}@${code}` : String(name);
const displayUsername = (name) => String(name || '').split('@')[0];
const pointer = (tenant) => ({ __type: 'Pointer', className: 'Restaurant', objectId: tenant });

function scopeRoleNames(where, tenant) {
  const name = where?.name;
  if (typeof name === 'string') where.name = roleName(name, tenant);
  else if (name && Array.isArray(name.$in))
    where.name = { ...name, $in: name.$in.map((entry) => roleName(entry, tenant)) };
}

function isGlobalSecret(where) {
  const key = where?.key;
  return typeof key === 'string' && GLOBAL_SECRETS.has(key);
}

let installed = false;
function install(Parse) {
  if (installed) return;
  installed = true;

  const toJSON = Parse.Query.prototype.toJSON;
  Parse.Query.prototype.toJSON = function scopedToJSON() {
    const json = toJSON.call(this);
    const tenant = current();
    if (!tenant) return json;
    if (this.className === '_Role') {
      json.where = { ...(json.where || {}) };
      scopeRoleNames(json.where, tenant);
    } else if (SCOPED.has(this.className)) {
      if (this.className === 'Secret' && isGlobalSecret(json.where)) return json;
      json.where = { ...(json.where || {}), tenant: pointer(tenant) };
    }
    return json;
  };

  const stamp = (object) => {
    const tenant = current();
    // New records only: an existing one keeps the restaurant it was made for.
    if (!tenant || !object || object.id || !SCOPED.has(object.className) || object.get('tenant'))
      return;
    if (object.className === 'Secret' && GLOBAL_SECRETS.has(object.get('key'))) return;
    object.set('tenant', Parse.Object.extend('Restaurant').createWithoutData(tenant));
  };
  const save = Parse.Object.prototype.save;
  Parse.Object.prototype.save = function scopedSave(...args) {
    stamp(this);
    return save.apply(this, args);
  };
  const saveAll = Parse.Object.saveAll;
  Parse.Object.saveAll = function scopedSaveAll(list, ...rest) {
    (list || []).forEach(stamp);
    return saveAll.call(this, list, ...rest);
  };

  // Usernames are stored as name@restaurant-code; screens show the name.
  const getUsername = Parse.User.prototype.getUsername;
  Parse.User.prototype.getUsername = function plainUsername() {
    return displayUsername(getUsername.call(this));
  };

  // Roles: this restaurant's role behind the plain name.
  const getName = Parse.Role.prototype.getName;
  Parse.Role.prototype.getName = function plainName() {
    return baseRole(getName.call(this));
  };
  for (const method of [
    'setRoleReadAccess',
    'setRoleWriteAccess',
    'getRoleReadAccess',
    'getRoleWriteAccess',
  ]) {
    const original = Parse.ACL.prototype[method];
    Parse.ACL.prototype[method] = function scopedRole(role, ...rest) {
      const name = role instanceof Parse.Role ? role.getName() : role;
      return original.call(this, roleName(name), ...rest);
    };
  }
}

// Restaurants by id or sign-in code, cached briefly (the platform console
// clears the cache when it changes one).
const cache = new Map();
const CACHE_MS = 30000;
async function lookUp(field, value) {
  const key = `${field}:${value}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.restaurant;
  const query = new Parse.Query('Restaurant');
  query.equalTo(field, value);
  const row = await withoutTenant(() => query.first({ useMasterKey: true })).catch(() => null);
  const restaurant = row ? { id: row.id, code: row.get('code'), name: row.get('name') } : null;
  cache.set(key, { restaurant, at: Date.now() });
  if (cache.size > 5000) cache.clear();
  return restaurant;
}
const clearCache = () => cache.clear();

// The restaurant a request is for: the signed-in person's, or the one a
// public request names by code ({ restaurant: 'mama-rose' }); null for none.
async function restaurantFor(request) {
  const tenant = request.user?.get?.('tenant');
  if (tenant) return lookUp('objectId', tenant.id);
  if (request.user) return null;
  const code = String(request.params?.restaurant || '')
    .trim()
    .toLowerCase();
  return /^[a-z0-9-]{3,30}$/.test(code) ? lookUp('code', code) : null;
}

module.exports = {
  install,
  restaurantFor,
  lookUp,
  clearCache,
  runAs,
  withoutTenant,
  current,
  currentCode,
  roleName,
  baseRole,
  fullUsername,
  displayUsername,
  SCOPED,
  BASE_ROLES,
};
