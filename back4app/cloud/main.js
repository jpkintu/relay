// Relay, designed and developed by Embiro Concepts. See NOTICE.
// GENERATED FILE: do not edit. Source: cloud/ in the Relay repository.
// Rebuild with `npm run build:cloud`. Upload this single file as the
// Back4App app's Cloud Code main.js (see docs/ROADMAP.md §2).
"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// cloud/lib/dates.js
var require_dates = __commonJS({
  "cloud/lib/dates.js"(exports2, module2) {
    "use strict";
    function isValidTimeZone(timeZone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone }).format(/* @__PURE__ */ new Date());
        return true;
      } catch {
        return false;
      }
    }
    var formatters = /* @__PURE__ */ new Map();
    function partsOf(date, timeZone) {
      let format = formatters.get(timeZone);
      if (!format) {
        format = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
        formatters.set(timeZone, format);
      }
      const out = {};
      for (const part of format.formatToParts(date)) out[part.type] = part.value;
      return out;
    }
    function dateKey(date, timeZone) {
      const p = partsOf(date, timeZone);
      return `${p.year}${p.month}${p.day}`;
    }
    function isoDay(date, timeZone) {
      const p = partsOf(date, timeZone);
      return `${p.year}-${p.month}-${p.day}`;
    }
    function localClock(date, timeZone) {
      const p = partsOf(date, timeZone);
      const day = isoDay(date, timeZone);
      const weekday = ((/* @__PURE__ */ new Date(`${day}T00:00:00Z`)).getUTCDay() + 6) % 7;
      return { hour: Number(p.hour) % 24, weekday };
    }
    function offsetMs(instant, timeZone) {
      const p = partsOf(new Date(instant), timeZone);
      const local = Date.UTC(p.year, p.month - 1, p.day, Number(p.hour) % 24, p.minute, p.second);
      return local - Math.floor(instant / 1e3) * 1e3;
    }
    var DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
    function isDay(value) {
      const match = DAY_PATTERN.exec(String(value || ""));
      if (!match) return false;
      const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
      return date.toISOString().slice(0, 10) === value;
    }
    function startOfDay(day, timeZone) {
      const guess = Date.parse(`${day}T00:00:00Z`);
      let instant = guess - offsetMs(guess, timeZone);
      const corrected = guess - offsetMs(instant, timeZone);
      if (corrected !== instant) instant = corrected;
      return new Date(instant);
    }
    function addDays(day, count) {
      const date = /* @__PURE__ */ new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + count);
      return date.toISOString().slice(0, 10);
    }
    function daysBetween(from, to) {
      return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
    }
    function bucketOfDay(day, period) {
      if (period === "month") return day.slice(0, 7);
      if (period === "week") {
        const weekday = ((/* @__PURE__ */ new Date(`${day}T00:00:00Z`)).getUTCDay() + 6) % 7;
        return addDays(day, -weekday);
      }
      return day;
    }
    var bucketOf = (date, timeZone, period) => bucketOfDay(isoDay(date, timeZone), period);
    function bucketKeys(from, to, period) {
      const keys = [];
      for (let day = from; day <= to; day = addDays(day, 1)) {
        const key = bucketOfDay(day, period);
        if (keys[keys.length - 1] !== key) keys.push(key);
      }
      return keys;
    }
    function resolveRange(params, timeZone, { defaultDays = 30, maxDays = 366 } = {}) {
      const today = isoDay(/* @__PURE__ */ new Date(), timeZone);
      const to = params?.to || today;
      const from = params?.from || addDays(to, -(defaultDays - 1));
      if (!isDay(from) || !isDay(to)) return { error: "Dates must look like 2026-09-01" };
      if (from > to) return { error: "The start date is after the end date" };
      const days = daysBetween(from, to) + 1;
      if (days > maxDays) return { error: `Choose at most ${maxDays} days` };
      return {
        from,
        to,
        days,
        start: startOfDay(from, timeZone),
        end: startOfDay(addDays(to, 1), timeZone)
      };
    }
    function previousRange(range, timeZone) {
      const to = addDays(range.from, -1);
      const from = addDays(to, -(range.days - 1));
      return resolveRange({ from, to }, timeZone, { maxDays: range.days });
    }
    module2.exports = {
      isValidTimeZone,
      dateKey,
      isoDay,
      localClock,
      isDay,
      startOfDay,
      addDays,
      daysBetween,
      bucketOf,
      bucketOfDay,
      bucketKeys,
      resolveRange,
      previousRange
    };
  }
});

// cloud/lib/core.js
var require_core = __commonJS({
  "cloud/lib/core.js"(exports2, module2) {
    "use strict";
    var { dateKey } = require_dates();
    var MASTER = { useMasterKey: true };
    var ROLE_NAMES = ["admin", "cashier", "rider"];
    var DEFAULT_CONFIG = {
      restaurantName: "Restaurant",
      currencySymbol: "UGX",
      currencyCode: "UGX",
      timezone: "Africa/Kampala",
      defaultDeliveryFee: 3e3,
      maxRiderFloat: 2e5,
      allowBatching: false,
      commissionRounding: "none",
      requireCashierConfirmForPickup: false,
      airtelMerchantCode: "",
      airtelMerchantName: "",
      mtnMerchantCode: "",
      mtnMerchantName: ""
    };
    var forbidden = (message) => new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, message);
    var invalid = (message) => new Parse.Error(Parse.Error.SCRIPT_FAILED, message);
    function requireUser(request) {
      if (!request.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, "Sign in required");
      if (request.user.get("active") === false) throw forbidden("Account is inactive");
      return request.user;
    }
    async function getRoleName(user) {
      const query = new Parse.Query(Parse.Role);
      query.containedIn("name", ROLE_NAMES);
      query.equalTo("users", user);
      const names = (await query.find(MASTER)).map((role) => role.getName());
      return ROLE_NAMES.find((name) => names.includes(name)) || null;
    }
    async function requireRole(request, allowed) {
      const user = requireUser(request);
      const role = await getRoleName(user);
      if (!allowed.includes(role)) throw forbidden(`${allowed.join(" or ")} role required`);
      return { user, role };
    }
    var isRider = async (user) => await getRoleName(user) === "rider";
    var isStaff = async (user) => ["cashier", "admin"].includes(await getRoleName(user));
    var adminOnly = async (request) => (await requireRole(request, ["admin"])).user;
    async function ensureRole(name) {
      const query = new Parse.Query(Parse.Role);
      query.equalTo("name", name);
      let role = await query.first(MASTER);
      if (!role) {
        const acl = new Parse.ACL();
        acl.setRoleReadAccess("admin", true);
        acl.setRoleWriteAccess("admin", true);
        role = new Parse.Role(name, acl);
        await role.save(null, MASTER);
      }
      return role;
    }
    function readAcl(owner, roles = ["cashier", "admin"]) {
      const acl = new Parse.ACL();
      if (owner) acl.setReadAccess(owner, true);
      for (const role of roles) acl.setRoleReadAccess(role, true);
      return acl;
    }
    function userAcl(user, role) {
      const acl = new Parse.ACL();
      acl.setReadAccess(user, true);
      acl.setWriteAccess(user, true);
      acl.setRoleReadAccess("admin", true);
      acl.setRoleWriteAccess("admin", true);
      if (role === "rider") acl.setRoleReadAccess("cashier", true);
      return acl;
    }
    async function audit(actor, action, object, before, after) {
      const log = new Parse.Object("AuditLog");
      log.set({
        actor,
        action,
        entityType: object.className,
        entityId: object.id,
        beforeJson: JSON.stringify(before || {}),
        afterJson: JSON.stringify(after || {})
      });
      log.setACL(readAcl(null, ["admin"]));
      await log.save(null, MASTER);
    }
    async function loadConfig() {
      const object = await new Parse.Query("Configuration").first(MASTER);
      const values = { ...DEFAULT_CONFIG };
      if (object) {
        for (const key of Object.keys(DEFAULT_CONFIG)) {
          const value = object.get(key);
          if (value !== void 0 && value !== null && value !== "") values[key] = value;
        }
      }
      return { object, values };
    }
    function countUsers() {
      const query = new Parse.Query(Parse.User);
      query.exists("username");
      return query.count(MASTER);
    }
    async function nextSequence(key) {
      const find = () => {
        const query = new Parse.Query("Counter");
        query.equalTo("key", key);
        query.ascending("createdAt");
        return query.first(MASTER);
      };
      if (!await find()) {
        const created = new Parse.Object("Counter");
        created.set({ key, value: 0 });
        created.setACL(new Parse.ACL());
        await created.save(null, MASTER);
      }
      const counter = await find();
      counter.increment("value");
      await counter.save(null, MASTER);
      return counter.get("value");
    }
    async function nextDailyCode(prefix, digits, timezone) {
      const day = dateKey(/* @__PURE__ */ new Date(), timezone);
      const sequence = await nextSequence(`${prefix}:${day}`);
      return `${prefix}-${day}-${String(sequence).padStart(digits, "0")}`;
    }
    async function nextStaffCode(role) {
      const prefix = role === "rider" ? "R" : "C";
      const sequence = await nextSequence(`staff:${prefix}`);
      return `${prefix}-${String(sequence).padStart(3, "0")}`;
    }
    module2.exports = {
      MASTER,
      DEFAULT_CONFIG,
      forbidden,
      invalid,
      requireUser,
      getRoleName,
      requireRole,
      isRider,
      isStaff,
      adminOnly,
      ensureRole,
      readAcl,
      userAcl,
      audit,
      loadConfig,
      countUsers,
      nextDailyCode,
      nextStaffCode
    };
  }
});

// cloud/security.js
var require_security = __commonJS({
  "cloud/security.js"(exports2, module2) {
    "use strict";
    var {
      MASTER,
      forbidden,
      countUsers,
      getRoleName,
      readAcl,
      userAcl,
      adminOnly,
      audit,
      nextStaffCode
    } = require_core();
    var PROTECTED_CLASSES = [
      "Order",
      "OrderItem",
      "CashHandover",
      "Shift",
      "AuditLog",
      "Configuration",
      "MenuItem",
      "MenuCategory",
      "Accompaniment",
      "Customer",
      "Counter",
      "DemoOrder"
    ];
    var PRIVATE_CLASSES = ["Counter", "DemoOrder", "Configuration"];
    var SELF_EDITABLE_USER_FIELDS = ["password", "email"];
    for (const className of PROTECTED_CLASSES) {
      Parse.Cloud.beforeSave(className, (request) => {
        if (!request.master) throw forbidden("Changes must go through the app");
      });
      Parse.Cloud.beforeDelete(className, (request) => {
        if (!request.master) throw forbidden("Changes must go through the app");
      });
    }
    Parse.Cloud.beforeSave(Parse.User, async (request) => {
      if (request.master) return;
      if (!request.original) {
        if (await countUsers() > 0)
          throw forbidden("Accounts are created by the restaurant administrator");
        for (const key of ["active", "commissionType", "commissionPerOrder", "commissionPercent"])
          request.object.unset(key);
        for (const key of ["riderCode", "cashierCode"]) request.object.unset(key);
        return;
      }
      const blocked = request.object.dirtyKeys().filter((key) => !SELF_EDITABLE_USER_FIELDS.includes(key));
      if (blocked.length) throw forbidden(`You cannot change ${blocked.join(", ")}`);
    });
    Parse.Cloud.afterSave(Parse.User, async (request) => {
      if (request.master || request.original) return;
      request.object.setACL(userAcl(request.object, null));
      await request.object.save(null, MASTER);
    });
    function classLevelPermissions(className) {
      const read = PRIVATE_CLASSES.includes(className) ? {} : { requiresAuthentication: true };
      return {
        get: read,
        find: read,
        count: read,
        create: {},
        update: {},
        delete: {},
        addField: {},
        protectedFields: {}
      };
    }
    var S = "String";
    var N = "Number";
    var B = "Boolean";
    var D = "Date";
    var user = ["Pointer", "_User"];
    var SCHEMAS = {
      Order: {
        orderCode: S,
        channel: S,
        createdBy: user,
        customerName: S,
        customerPhone: S,
        deliveryAddress: S,
        subtotal: N,
        deliveryFee: N,
        total: N,
        paymentMethod: S,
        amountCollected: N,
        paymentCollectedBy: user,
        status: S,
        restaurantStatus: S,
        cashStatus: S,
        commissionAmount: N,
        commissionPaid: B,
        pickedUpAt: D,
        deliveredAt: D,
        settledAt: D,
        customer: ["Pointer", "Customer"],
        deliveryNotes: S,
        amountToCollect: N,
        shortfallNote: S,
        clientId: S,
        acceptedAt: D,
        readyAt: D,
        cancelledReason: S,
        cancelledBy: user,
        cancelledAt: D,
        disputeFlag: B,
        disputeNote: S,
        disputedBy: user,
        disputedAt: D,
        disputeResolution: S,
        paymentProvider: S,
        paymentReference: S,
        paymentStatus: S,
        paymentCheckedBy: user,
        paymentCheckedAt: D,
        paymentRejectReason: S
      },
      OrderItem: {
        order: ["Pointer", "Order"],
        itemNameSnapshot: S,
        unitPriceSnapshot: N,
        quantity: N,
        lineTotal: N,
        notes: S,
        menuItem: ["Pointer", "MenuItem"],
        accompanimentIds: "Array",
        accompanimentNames: "Array"
      },
      CashHandover: {
        handoverCode: S,
        rider: user,
        cashier: user,
        amount: N,
        countedAmount: N,
        orderCount: N,
        orders: "Array",
        status: S,
        handedOverAt: D,
        confirmedAt: D,
        disputedAt: D,
        disputeReason: S,
        notes: S,
        resolutionNote: S,
        resolvedBy: user,
        resolvedAt: D
      },
      Shift: {
        operator: user,
        kind: S,
        status: S,
        openingFloat: N,
        startedAt: D,
        endedAt: D,
        closingFloat: N,
        acknowledgedCash: B,
        expectedTill: N,
        physicalCount: N,
        variance: N
      },
      AuditLog: { actor: user, action: S, entityType: S, entityId: S, beforeJson: S, afterJson: S },
      Configuration: {
        restaurantName: S,
        currencySymbol: S,
        currencyCode: S,
        timezone: S,
        defaultDeliveryFee: N,
        maxRiderFloat: N,
        allowBatching: B,
        commissionRounding: S,
        requireCashierConfirmForPickup: B,
        airtelMerchantCode: S,
        airtelMerchantName: S,
        mtnMerchantCode: S,
        mtnMerchantName: S
      },
      MenuItem: {
        title: S,
        price: N,
        category: S,
        active: B,
        availableToday: B,
        sortOrder: N,
        accompanimentGroups: "Array"
      },
      Accompaniment: { title: S, active: B, available: B, sortOrder: N },
      Customer: {
        key: S,
        name: S,
        nameLower: S,
        phone: S,
        addresses: "Array",
        orderCount: N,
        lastOrderAt: D,
        lastOrder: ["Pointer", "Order"]
      },
      MenuCategory: { title: S, active: B, sortOrder: N },
      Counter: { key: S, value: N },
      DemoOrder: {
        orderCode: S,
        customerName: S,
        deliveryAddress: S,
        riderName: S,
        itemSummary: S,
        subtotal: N,
        deliveryFee: N,
        total: N,
        status: S,
        restaurantStatus: S,
        isDemo: B
      }
    };
    async function applySchemas() {
      const existing = new Map((await Parse.Schema.all()).map((schema) => [schema.className, schema]));
      const created = [];
      for (const className of PROTECTED_CLASSES) {
        const schema = new Parse.Schema(className);
        const current = existing.get(className);
        const known = current ? Object.keys(current.fields || {}) : [];
        for (const [field, type] of Object.entries(SCHEMAS[className])) {
          if (known.includes(field)) continue;
          if (Array.isArray(type)) schema.addField(field, type[0], { targetClass: type[1] });
          else schema.addField(field, type);
        }
        schema.setCLP(classLevelPermissions(className));
        if (current) await schema.update();
        else {
          await schema.save();
          created.push(className);
        }
      }
      return created;
    }
    async function eachObject(className, visit, configure) {
      const query = new Parse.Query(className);
      if (configure) configure(query);
      let count = 0;
      await query.each(
        async (object) => {
          if (await visit(object)) count += 1;
        },
        { ...MASTER, batchSize: 200 }
      );
      return count;
    }
    async function saveAcl(object, acl) {
      if (JSON.stringify(object.getACL()?.toJSON()) === JSON.stringify(acl.toJSON())) return false;
      object.setACL(acl);
      await object.save(null, MASTER);
      return true;
    }
    async function applySecurity() {
      const updated = { createdClasses: await applySchemas() };
      updated.Order = await eachObject("Order", (o) => saveAcl(o, readAcl(o.get("createdBy"))));
      updated.OrderItem = await eachObject(
        "OrderItem",
        (item) => saveAcl(item, readAcl(item.get("order")?.get("createdBy"))),
        (query) => query.include("order")
      );
      updated.CashHandover = await eachObject(
        "CashHandover",
        (h) => saveAcl(h, readAcl(h.get("rider")))
      );
      updated.Shift = await eachObject(
        "Shift",
        (s) => saveAcl(s, readAcl(s.get("operator"), ["admin"]))
      );
      for (const className of [
        "MenuItem",
        "MenuCategory",
        "Accompaniment",
        "Customer",
        "Configuration",
        "AuditLog"
      ])
        updated[className] = await eachObject(className, (o) => saveAcl(o, readAcl(null, ["admin"])));
      updated._User = await eachObject(Parse.User, async (user2) => {
        const role = await getRoleName(user2);
        let changed = false;
        const codeField = role === "rider" ? "riderCode" : role === "cashier" ? "cashierCode" : null;
        if (codeField && !user2.get(codeField)) {
          user2.set(codeField, await nextStaffCode(role));
          changed = true;
        }
        const acl = userAcl(user2, role);
        if (JSON.stringify(user2.getACL()?.toJSON()) !== JSON.stringify(acl.toJSON())) {
          user2.setACL(acl);
          changed = true;
        }
        if (changed) await user2.save(null, MASTER);
        return changed;
      });
      return updated;
    }
    Parse.Cloud.job("applySecurity", async () => {
      const updated = await applySecurity();
      return `Security applied: ${JSON.stringify(updated)}`;
    });
    Parse.Cloud.define("adminApplySecurity", async (request) => {
      const actor = await adminOnly(request);
      const updated = await applySecurity();
      await audit(actor, "security.applied", { className: "Security", id: "all" }, null, updated);
      return updated;
    });
    module2.exports = { applySecurity };
  }
});

// cloud/customers.js
var require_customers = __commonJS({
  "cloud/customers.js"(exports2, module2) {
    "use strict";
    var { MASTER, invalid, requireRole, readAcl } = require_core();
    var MAX_ADDRESSES = 5;
    var customerKey = (name, phone) => phone ? `tel:${phone}` : `name:${name.toLowerCase()}`;
    async function recordCustomerOrder(order) {
      const name = order.get("customerName");
      const phone = order.get("customerPhone") || "";
      const key = customerKey(name, phone);
      const query = new Parse.Query("Customer");
      query.equalTo("key", key);
      query.ascending("createdAt");
      const customer = await query.first(MASTER) || new Parse.Object("Customer");
      const address = { text: order.get("deliveryAddress"), notes: order.get("deliveryNotes") || "" };
      const addresses = [
        address,
        ...(customer.get("addresses") || []).filter(
          (saved) => saved.text.toLowerCase() !== address.text.toLowerCase()
        )
      ].slice(0, MAX_ADDRESSES);
      customer.set({
        key,
        name,
        nameLower: name.toLowerCase(),
        phone,
        addresses,
        orderCount: (customer.get("orderCount") || 0) + 1,
        lastOrderAt: /* @__PURE__ */ new Date(),
        lastOrder: order
      });
      customer.setACL(readAcl(null, ["admin"]));
      await customer.save(null, MASTER);
      return customer;
    }
    var escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    Parse.Cloud.define("searchCustomers", async (request) => {
      await requireRole(request, ["rider", "cashier", "admin"]);
      const text = String(request.params.q || "").trim().toLowerCase().slice(0, 40);
      if (text.length < 2) throw invalid("Type at least 2 characters");
      const byName = new Parse.Query("Customer");
      byName.matches("nameLower", escapeRegex(text));
      const queries = [byName];
      const digits = text.replace(/[^\d]/g, "");
      if (digits.length >= 3) {
        const byPhone = new Parse.Query("Customer");
        byPhone.matches("phone", escapeRegex(digits));
        queries.push(byPhone);
      }
      const query = Parse.Query.or(...queries);
      query.descending("orderCount");
      query.limit(5);
      const customers = await query.find(MASTER);
      const lastOrders = customers.map((c) => c.get("lastOrder")).filter(Boolean);
      const itemQuery = new Parse.Query("OrderItem");
      itemQuery.containedIn("order", lastOrders);
      itemQuery.limit(1e3);
      const items = lastOrders.length ? await itemQuery.find(MASTER) : [];
      return customers.map((customer) => {
        const lastId = customer.get("lastOrder")?.id;
        return {
          id: customer.id,
          name: customer.get("name"),
          phone: customer.get("phone") || "",
          addresses: customer.get("addresses") || [],
          orderCount: customer.get("orderCount") || 0,
          lastOrderAt: customer.get("lastOrderAt") || null,
          lastOrder: items.filter((item) => item.get("order")?.id === lastId && item.get("menuItem")).map((item) => ({
            menuItemId: item.get("menuItem").id,
            title: item.get("itemNameSnapshot"),
            quantity: item.get("quantity"),
            notes: item.get("notes") || "",
            accompanimentIds: item.get("accompanimentIds") || [],
            accompanimentNames: item.get("accompanimentNames") || []
          }))
        };
      });
    });
    module2.exports = { recordCustomerOrder };
  }
});

// cloud/lib/mobileMoney.js
var require_mobileMoney = __commonJS({
  "cloud/lib/mobileMoney.js"(exports2, module2) {
    "use strict";
    var PROVIDERS = [
      {
        provider: "airtel",
        label: "Airtel Money",
        codeField: "airtelMerchantCode",
        nameField: "airtelMerchantName"
      },
      {
        provider: "mtn",
        label: "MTN MoMo",
        codeField: "mtnMerchantCode",
        nameField: "mtnMerchantName"
      }
    ];
    function merchantAccounts(config) {
      return PROVIDERS.filter((p) => String(config[p.codeField] || "").trim()).map((p) => ({
        provider: p.provider,
        label: p.label,
        code: String(config[p.codeField]).trim(),
        name: String(config[p.nameField] || "").trim()
      }));
    }
    function cleanReference(value) {
      return String(value ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 40);
    }
    function referenceProblem(reference) {
      if (!reference) return "Enter the transaction ID from the customer\u2019s payment message";
      if (!/^[A-Z0-9.-]{4,40}$/.test(reference))
        return "A transaction ID has 4 to 40 letters or digits";
      return "";
    }
    module2.exports = { PROVIDERS, merchantAccounts, cleanReference, referenceProblem };
  }
});

// cloud/payments.js
var require_payments = __commonJS({
  "cloud/payments.js"(exports2, module2) {
    "use strict";
    var {
      MASTER,
      invalid,
      forbidden,
      requireRole,
      getRoleName,
      requireUser,
      audit,
      loadConfig
    } = require_core();
    var { merchantAccounts, cleanReference, referenceProblem } = require_mobileMoney();
    var { dateKey } = require_dates();
    var PENDING = "PENDING_VERIFICATION";
    async function checkMobileMoney(config, providerParam, referenceParam, excludeOrderId) {
      const accounts = merchantAccounts(config);
      if (!accounts.length)
        throw invalid("Mobile money is not set up. Ask the owner to add merchant codes in Settings");
      const provider = String(providerParam || "");
      if (!accounts.some((account) => account.provider === provider))
        throw invalid(`Choose ${accounts.map((a) => a.label).join(" or ")}`);
      const reference = cleanReference(referenceParam);
      const problem = referenceProblem(reference);
      if (problem) throw invalid(problem);
      const query = new Parse.Query("Order");
      query.equalTo("paymentProvider", provider);
      query.equalTo("paymentReference", reference);
      query.notEqualTo("paymentStatus", "REJECTED");
      if (excludeOrderId) query.notEqualTo("objectId", excludeOrderId);
      const duplicate = await query.first(MASTER);
      if (duplicate)
        throw invalid(`This transaction ID was already used on ${duplicate.get("orderCode")}`);
      return { provider, reference };
    }
    Parse.Cloud.define("verifyPayment", async (request) => {
      const { user: actor } = await requireRole(request, ["cashier", "admin"]);
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      if (order.get("paymentStatus") !== PENDING)
        throw invalid("This payment is not waiting for a check");
      const received = request.params.received === true;
      const reason = String(request.params.reason || "").trim().slice(0, 200);
      if (!received && reason.length < 3) throw invalid("Say why the payment was not accepted");
      order.set({
        paymentStatus: received ? "VERIFIED" : "REJECTED",
        paymentCheckedBy: actor,
        paymentCheckedAt: /* @__PURE__ */ new Date(),
        paymentRejectReason: received ? "" : reason
      });
      await order.save(null, MASTER);
      await audit(
        actor,
        received ? "payment.verified" : "payment.rejected",
        order,
        { paymentStatus: PENDING },
        {
          paymentStatus: order.get("paymentStatus"),
          provider: order.get("paymentProvider"),
          reference: order.get("paymentReference"),
          amount: order.get("total"),
          reason
        }
      );
      return { paymentStatus: order.get("paymentStatus") };
    });
    Parse.Cloud.define("resubmitPayment", async (request) => {
      const actor = requireUser(request);
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      const role = await getRoleName(actor);
      if (order.get("createdBy")?.id !== actor.id && !["cashier", "admin"].includes(role))
        throw forbidden("Not allowed");
      if (order.get("status") === "CANCELLED") throw invalid("This order was cancelled");
      if (![PENDING, "REJECTED"].includes(order.get("paymentStatus")))
        throw invalid("This payment cannot be changed");
      const { values: config } = await loadConfig();
      const { provider, reference } = await checkMobileMoney(
        config,
        request.params.provider,
        request.params.reference,
        order.id
      );
      const before = {
        provider: order.get("paymentProvider"),
        reference: order.get("paymentReference"),
        paymentStatus: order.get("paymentStatus")
      };
      order.set({
        paymentProvider: provider,
        paymentReference: reference,
        paymentStatus: PENDING,
        paymentRejectReason: ""
      });
      await order.save(null, MASTER);
      await audit(actor, "payment.resubmitted", order, before, { provider, reference });
      return { paymentStatus: PENDING };
    });
    var nameOf = (user) => user ? [user.get("riderCode") || user.get("cashierCode"), user.get("name")].filter(Boolean).join(" \xB7 ") : "";
    function paymentRow(order) {
      return {
        id: order.id,
        code: order.get("orderCode"),
        customer: order.get("customerName"),
        rider: nameOf(order.get("createdBy")),
        provider: order.get("paymentProvider"),
        reference: order.get("paymentReference"),
        amount: order.get("total"),
        paymentStatus: order.get("paymentStatus"),
        orderStatus: order.get("status"),
        createdAt: order.createdAt,
        checkedAt: order.get("paymentCheckedAt") || null,
        checkedBy: nameOf(order.get("paymentCheckedBy")),
        rejectReason: order.get("paymentRejectReason") || ""
      };
    }
    Parse.Cloud.define("getMobileMoneyLedger", async (request) => {
      await requireRole(request, ["cashier", "admin"]);
      const { values: config } = await loadConfig();
      const pendingQuery = new Parse.Query("Order");
      pendingQuery.equalTo("paymentStatus", PENDING);
      pendingQuery.include(["createdBy"]);
      pendingQuery.ascending("createdAt");
      pendingQuery.limit(500);
      const checkedQuery = new Parse.Query("Order");
      checkedQuery.containedIn("paymentStatus", ["VERIFIED", "REJECTED"]);
      checkedQuery.greaterThanOrEqualTo("paymentCheckedAt", new Date(Date.now() - 48 * 3600 * 1e3));
      checkedQuery.include(["createdBy", "paymentCheckedBy"]);
      checkedQuery.descending("paymentCheckedAt");
      checkedQuery.limit(1e3);
      const [pending, checked] = await Promise.all([
        pendingQuery.find(MASTER),
        checkedQuery.find(MASTER)
      ]);
      const today = dateKey(/* @__PURE__ */ new Date(), config.timezone);
      const checkedToday = checked.filter(
        (order) => dateKey(order.get("paymentCheckedAt"), config.timezone) === today
      );
      const verified = checkedToday.filter((order) => order.get("paymentStatus") === "VERIFIED");
      const totals = merchantAccounts(config).map((account) => {
        const rows = verified.filter((order) => order.get("paymentProvider") === account.provider);
        return {
          ...account,
          count: rows.length,
          amount: rows.reduce((sum, order) => sum + Number(order.get("total") || 0), 0)
        };
      });
      return {
        pending: pending.map(paymentRow),
        verified: verified.map(paymentRow),
        rejected: checkedToday.filter((order) => order.get("paymentStatus") === "REJECTED").map(paymentRow),
        totals
      };
    });
    module2.exports = { checkMobileMoney, PENDING };
  }
});

// cloud/lib/money.js
var require_money = __commonJS({
  "cloud/lib/money.js"(exports2, module2) {
    "use strict";
    var COMMISSION_TYPES = ["per_order", "percent", "hybrid"];
    var ROUNDING_STEPS = { none: 0, up_100: 100, up_500: 500, up_1000: 1e3 };
    function roundCommission(amount, rounding = "none") {
      const whole = Math.round(Number(amount) || 0);
      const step = ROUNDING_STEPS[rounding] || 0;
      return step ? Math.ceil(whole / step) * step : whole;
    }
    function computeCommission({ type, perOrder, percent, subtotal, rounding }) {
      const flat = Number(perOrder) || 0;
      const share = (Number(subtotal) || 0) * (Number(percent) || 0) / 100;
      const raw = type === "percent" ? share : type === "hybrid" ? flat + share : flat;
      return roundCommission(raw, rounding);
    }
    function sumBy(rows, pick) {
      return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
    }
    module2.exports = { COMMISSION_TYPES, ROUNDING_STEPS, roundCommission, computeCommission, sumBy };
  }
});

// cloud/lib/accompaniments.js
var require_accompaniments = __commonJS({
  "cloud/lib/accompaniments.js"(exports2, module2) {
    "use strict";
    var MAX_GROUPS = 6;
    var MAX_OPTIONS = 20;
    function normalizeGroups(raw, knownIds) {
      if (raw === void 0 || raw === null) return [];
      if (!Array.isArray(raw) || raw.length > MAX_GROUPS)
        throw new Error(`Use at most ${MAX_GROUPS} accompaniment groups`);
      return raw.map((group, index) => {
        const label = String(group?.label || "").trim() || `Choice ${index + 1}`;
        if (label.length > 40)
          throw new Error("Accompaniment group names must be 40 characters or less");
        const options = [...new Set((group?.options || []).map(String))];
        if (!options.length) throw new Error(`"${label}" needs at least one accompaniment`);
        if (options.length > MAX_OPTIONS)
          throw new Error(`"${label}" can offer at most ${MAX_OPTIONS} accompaniments`);
        const unknown = options.filter((id) => !knownIds.has(id));
        if (unknown.length)
          throw new Error(`"${label}" refers to an accompaniment that does not exist`);
        const max = Number(group?.max ?? options.length);
        const min = Number(group?.min ?? 0);
        if (!Number.isInteger(max) || max < 1 || max > options.length)
          throw new Error(`"${label}": "pick at most" must be between 1 and ${options.length}`);
        if (!Number.isInteger(min) || min < 0 || min > max)
          throw new Error(`"${label}": "pick at least" must be between 0 and ${max}`);
        return { label, options, min, max };
      });
    }
    function availableGroups(groups, isAvailable) {
      return (groups || []).map((group) => {
        const options = group.options.filter((id) => isAvailable(id));
        return {
          label: group.label,
          options,
          min: Math.min(group.min, options.length),
          max: Math.min(group.max, options.length)
        };
      }).filter((group) => group.options.length > 0);
    }
    function selectionError(groups, selectedIds) {
      const selected = (selectedIds || []).map(String);
      if (new Set(selected).size !== selected.length) return "The same accompaniment was chosen twice";
      const counts = groups.map(() => 0);
      for (const id of selected) {
        const index = groups.findIndex((group) => group.options.includes(id));
        if (index === -1) return "An accompaniment is not available for this dish";
        counts[index] += 1;
      }
      for (const [index, group] of groups.entries()) {
        if (counts[index] > group.max)
          return group.max === 1 ? `Choose only one ${group.label.toLowerCase()} option` : `Choose at most ${group.max} from ${group.label}`;
        if (counts[index] < group.min) return `Choose at least ${group.min} from ${group.label}`;
      }
      return "";
    }
    module2.exports = { normalizeGroups, availableGroups, selectionError };
  }
});

// cloud/orders.js
var require_orders = __commonJS({
  "cloud/orders.js"(exports2, module2) {
    "use strict";
    var {
      MASTER,
      invalid,
      forbidden,
      requireUser,
      requireRole,
      getRoleName,
      readAcl,
      audit,
      loadConfig,
      nextDailyCode
    } = require_core();
    var { computeCommission, sumBy } = require_money();
    var { availableGroups, selectionError } = require_accompaniments();
    var { recordCustomerOrder } = require_customers();
    var { checkMobileMoney, PENDING } = require_payments();
    var CHANNELS = ["walkin", "phone", "whatsapp", "other"];
    var PAYMENT_METHODS = ["cash", "mobile_money", "card", "prepaid"];
    var MAX_LINES = 30;
    var clean = (value, max) => String(value ?? "").trim().slice(0, max);
    var cleanPhone = (value) => clean(value, 30).replace(/[^\d+]/g, "");
    async function riderFloat(rider) {
      const query = new Parse.Query("Order");
      query.equalTo("createdBy", rider);
      query.equalTo("status", "DELIVERED");
      query.containedIn("cashStatus", ["WITH_RIDER", "HANDOVER_PENDING"]);
      query.limit(1e3);
      return sumBy(await query.find(MASTER), (order) => order.get("amountCollected"));
    }
    async function servableAccompaniments() {
      const query = new Parse.Query("Accompaniment");
      query.equalTo("active", true);
      query.equalTo("available", true);
      query.limit(1e3);
      return new Map((await query.find(MASTER)).map((row) => [row.id, row]));
    }
    async function priceLines(items) {
      if (!Array.isArray(items) || !items.length) throw invalid("Add at least one item");
      if (items.length > MAX_LINES) throw invalid(`An order can have at most ${MAX_LINES} lines`);
      const menuQuery = new Parse.Query("MenuItem");
      menuQuery.containedIn(
        "objectId",
        items.map((line) => String(line.id))
      );
      const [menu, accompaniments] = await Promise.all([
        menuQuery.find(MASTER),
        servableAccompaniments()
      ]);
      const byId = new Map(menu.map((item) => [item.id, item]));
      return items.map((line) => {
        const saved = byId.get(String(line.id));
        const qty = Number(line.quantity);
        if (!saved || !saved.get("active") || !saved.get("availableToday"))
          throw invalid(`${saved?.get("title") || "An item"} is not available`);
        if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw invalid("Invalid quantity");
        const title = saved.get("title");
        const groups = availableGroups(
          saved.get("accompanimentGroups") || [],
          (id) => accompaniments.has(id)
        );
        const chosen = (Array.isArray(line.accompaniments) ? line.accompaniments : []).map(String);
        const problem = selectionError(groups, chosen);
        if (problem) throw invalid(`${title}: ${problem}`);
        return {
          menuItem: saved,
          name: title,
          price: Number(saved.get("price")),
          qty,
          notes: clean(line.notes, 140),
          accompanimentIds: chosen,
          accompanimentNames: chosen.map((id) => accompaniments.get(id).get("title"))
        };
      });
    }
    Parse.Cloud.define("createOrder", async (request) => {
      const { user: rider } = await requireRole(request, ["rider"]);
      const p = request.params;
      const clientId = clean(p.clientId, 64);
      if (clientId) {
        const existingQuery = new Parse.Query("Order");
        existingQuery.equalTo("createdBy", rider);
        existingQuery.equalTo("clientId", clientId);
        const existing = await existingQuery.first(MASTER);
        if (existing)
          return {
            id: existing.id,
            orderCode: existing.get("orderCode"),
            total: existing.get("total"),
            duplicate: true
          };
      }
      const customerName = clean(p.customerName, 80);
      const deliveryAddress = clean(p.deliveryAddress, 200);
      if (!customerName || !deliveryAddress) throw invalid("Customer and address are required");
      const channel = p.channel || "walkin";
      const paymentMethod = p.paymentMethod || "cash";
      if (!CHANNELS.includes(channel)) throw invalid("Invalid channel");
      if (!PAYMENT_METHODS.includes(paymentMethod)) throw invalid("Invalid payment method");
      const activeQuery = new Parse.Query("Order");
      activeQuery.equalTo("createdBy", rider);
      activeQuery.notContainedIn("status", ["DELIVERED", "CANCELLED"]);
      const [lines, { values: config }, activeCount, float] = await Promise.all([
        priceLines(p.items),
        loadConfig(),
        activeQuery.count(MASTER),
        riderFloat(rider)
      ]);
      if (!config.allowBatching && activeCount)
        throw invalid("Finish your current order before creating another");
      const subtotal = sumBy(lines, (line) => line.price * line.qty);
      const fee = Math.max(0, Math.round(Number(p.deliveryFee ?? config.defaultDeliveryFee) || 0));
      const total = subtotal + fee;
      const isCash = paymentMethod === "cash";
      const amountToCollect = isCash ? Math.round(Number(p.amountToCollect ?? total)) : 0;
      if (!Number.isFinite(amountToCollect) || amountToCollect < 0)
        throw invalid("Enter the amount to collect");
      const shortfallNote = clean(p.shortfallNote, 200);
      if (isCash && amountToCollect < total && shortfallNote.length < 5)
        throw invalid("The customer is paying less than the total. Add a note explaining why");
      const momo = paymentMethod === "mobile_money" ? await checkMobileMoney(config, p.paymentProvider, p.paymentReference) : null;
      const projected = float + (isCash ? amountToCollect : 0);
      if (config.maxRiderFloat > 0 && projected > config.maxRiderFloat)
        throw invalid(
          `Hand over cash first: this order would put ${config.currencySymbol} ${projected.toLocaleString("en-US")} with you (limit ${config.currencySymbol} ${config.maxRiderFloat.toLocaleString("en-US")})`
        );
      const order = new Parse.Object("Order");
      order.set({
        orderCode: await nextDailyCode("ORD", 4, config.timezone),
        clientId,
        channel,
        createdBy: rider,
        customerName,
        customerPhone: cleanPhone(p.customerPhone),
        deliveryAddress,
        deliveryNotes: clean(p.deliveryNotes, 200),
        subtotal,
        deliveryFee: fee,
        total,
        paymentMethod,
        amountToCollect,
        shortfallNote: isCash && amountToCollect < total ? shortfallNote : "",
        amountCollected: 0,
        status: "PLACED",
        restaurantStatus: "pending",
        cashStatus: isCash ? "NOT_COLLECTED" : "NOT_APPLICABLE",
        commissionAmount: 0,
        commissionPaid: false,
        disputeFlag: false,
        ...momo && {
          paymentProvider: momo.provider,
          paymentReference: momo.reference,
          paymentStatus: PENDING
        }
      });
      order.setACL(readAcl(rider));
      await order.save(null, MASTER);
      const children = lines.map((line) => {
        const item = new Parse.Object("OrderItem");
        item.set({
          order,
          menuItem: line.menuItem,
          itemNameSnapshot: line.name,
          unitPriceSnapshot: line.price,
          quantity: line.qty,
          lineTotal: line.price * line.qty,
          notes: line.notes,
          accompanimentIds: line.accompanimentIds,
          accompanimentNames: line.accompanimentNames
        });
        item.setACL(readAcl(rider));
        return item;
      });
      await Parse.Object.saveAll(children, MASTER);
      const customer = await recordCustomerOrder(order);
      if (customer) {
        order.set("customer", customer);
        await order.save(null, MASTER);
      }
      await audit(rider, "order.placed", order, null, { status: "PLACED", total });
      return { id: order.id, orderCode: order.get("orderCode"), total };
    });
    var TRANSITIONS = {
      accept: { from: ["PLACED"], to: "ACCEPTED", kitchen: "accepted", who: "staff" },
      prepare: { from: ["ACCEPTED"], to: "PREPARING", kitchen: "preparing", who: "staff" },
      ready: { from: ["ACCEPTED", "PREPARING"], to: "READY", kitchen: "ready", who: "staff" },
      pickup: { from: ["READY"], to: "PICKED_UP", kitchen: "picked_up", who: "owner" },
      deliver: { from: ["PICKED_UP"], to: "DELIVERED", kitchen: "picked_up", who: "owner" },
      reject: { from: ["PLACED"], to: "CANCELLED", kitchen: "rejected", who: "staff" },
      cancel: {
        from: ["PLACED", "ACCEPTED", "PREPARING", "READY"],
        to: "CANCELLED",
        kitchen: "cancelled",
        who: "owner"
      }
    };
    Parse.Cloud.define("transitionOrder", async (request) => {
      const actor = requireUser(request);
      const p = request.params;
      const rule = TRANSITIONS[p.action];
      const order = await new Parse.Query("Order").get(p.orderId, MASTER);
      if (!rule || !rule.from.includes(order.get("status"))) throw invalid("Invalid status transition");
      const role = await getRoleName(actor);
      const staff = ["cashier", "admin"].includes(role);
      const owner = order.get("createdBy")?.id === actor.id;
      if (rule.who === "staff" && !staff) throw forbidden("Staff access required");
      if (rule.who === "owner" && !owner && !staff) throw forbidden("Not allowed");
      const { values: config } = await loadConfig();
      if (p.action === "pickup" && !staff && config.requireCashierConfirmForPickup)
        throw forbidden("The cashier confirms pickup when handing over the bag");
      if (p.action === "accept" && [PENDING, "REJECTED"].includes(order.get("paymentStatus")))
        throw invalid("Confirm the mobile money payment before accepting this order");
      if (p.action === "cancel" && !staff && order.get("status") !== "PLACED")
        throw forbidden("The kitchen has accepted this order. Ask the cashier to cancel it");
      const before = {
        status: order.get("status"),
        restaurantStatus: order.get("restaurantStatus"),
        paymentMethod: order.get("paymentMethod")
      };
      order.set({ status: rule.to, restaurantStatus: rule.kitchen });
      const now = /* @__PURE__ */ new Date();
      if (p.action === "accept") order.set("acceptedAt", now);
      if (p.action === "ready") order.set("readyAt", now);
      if (p.action === "pickup") order.set("pickedUpAt", now);
      if (p.action === "cancel" || p.action === "reject") {
        const reason = clean(p.reason, 200);
        if (reason.length < 3) throw invalid("Give a reason");
        order.set({
          cancelledReason: reason,
          cancelledBy: actor,
          cancelledAt: now,
          cashStatus: "NOT_APPLICABLE"
        });
      }
      if (p.action === "deliver") {
        const method = p.paymentMethod || order.get("paymentMethod");
        if (!PAYMENT_METHODS.includes(method)) throw invalid("Invalid payment method");
        const paidByMomo = order.get("paymentMethod") === "mobile_money";
        if (paidByMomo && method !== "mobile_money")
          throw invalid("This order was paid by mobile money");
        if (!paidByMomo && method === "mobile_money") {
          const momo = await checkMobileMoney(config, p.paymentProvider, p.paymentReference, order.id);
          order.set({
            paymentProvider: momo.provider,
            paymentReference: momo.reference,
            paymentStatus: PENDING
          });
        }
        const isCash = method === "cash";
        const total = order.get("total");
        const amount = isCash ? Number(p.amountCollected ?? order.get("amountToCollect") ?? total) : 0;
        if (!Number.isFinite(amount) || amount < 0) throw invalid("Enter the amount collected");
        const note = clean(p.shortfallNote, 200) || order.get("shortfallNote") || "";
        if (isCash && amount < total && note.length < 5)
          throw invalid("Collected amount is below the total. Add a note explaining why");
        const rider = await order.get("createdBy").fetch(MASTER);
        order.set({
          paymentMethod: method,
          deliveredAt: now,
          amountCollected: Math.round(amount),
          shortfallNote: isCash && amount < total ? note : "",
          paymentCollectedBy: actor,
          commissionAmount: computeCommission({
            type: rider.get("commissionType") || "per_order",
            perOrder: rider.get("commissionPerOrder"),
            percent: rider.get("commissionPercent"),
            subtotal: order.get("subtotal"),
            rounding: config.commissionRounding
          }),
          cashStatus: isCash ? "WITH_RIDER" : "NOT_APPLICABLE"
        });
      }
      await order.save(null, MASTER);
      await audit(actor, `order.${p.action}`, order, before, {
        status: rule.to,
        paymentMethod: order.get("paymentMethod"),
        reason: order.get("cancelledReason")
      });
      return { status: rule.to };
    });
    Parse.Cloud.define("flagOrderIssue", async (request) => {
      const actor = requireUser(request);
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      const role = await getRoleName(actor);
      if (order.get("createdBy")?.id !== actor.id && !["cashier", "admin"].includes(role))
        throw forbidden("Not allowed");
      const note = clean(request.params.note, 300);
      if (note.length < 5) throw invalid("Describe the problem");
      order.set({ disputeFlag: true, disputeNote: note, disputedBy: actor, disputedAt: /* @__PURE__ */ new Date() });
      await order.save(null, MASTER);
      await audit(actor, "order.issue_flagged", order, null, { note });
      return { ok: true };
    });
    Parse.Cloud.define("resolveOrderIssue", async (request) => {
      const { user: actor } = await requireRole(request, ["admin"]);
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      if (!order.get("disputeFlag")) throw invalid("This order has no open issue");
      const resolution = clean(request.params.resolution, 300);
      if (resolution.length < 5) throw invalid("Describe how it was resolved");
      order.set({ disputeFlag: false, disputeResolution: resolution });
      await order.save(null, MASTER);
      await audit(
        actor,
        "order.issue_resolved",
        order,
        { note: order.get("disputeNote") },
        { resolution }
      );
      return { ok: true };
    });
    module2.exports = { riderFloat, servableAccompaniments };
  }
});

// cloud/menu.js
var require_menu = __commonJS({
  "cloud/menu.js"() {
    "use strict";
    var { MASTER, invalid, requireRole, audit, loadConfig } = require_core();
    var { availableGroups } = require_accompaniments();
    var { servableAccompaniments } = require_orders();
    Parse.Cloud.define("getOperationalMenu", async (request) => {
      await requireRole(request, ["rider", "cashier", "admin"]);
      const query = new Parse.Query("MenuItem");
      query.equalTo("active", true);
      query.equalTo("availableToday", true);
      query.ascending("sortOrder");
      query.limit(500);
      const [menu, accompaniments, { values: config }] = await Promise.all([
        query.find(MASTER),
        servableAccompaniments(),
        loadConfig()
      ]);
      return {
        items: menu.map((item) => ({
          id: item.id,
          title: item.get("title"),
          category: item.get("category") || "Mains",
          price: item.get("price"),
          accompanimentGroups: availableGroups(
            item.get("accompanimentGroups") || [],
            (id) => accompaniments.has(id)
          ).map((group) => ({
            ...group,
            options: group.options.map((id) => ({ id, title: accompaniments.get(id).get("title") }))
          }))
        })),
        deliveryFee: config.defaultDeliveryFee,
        currencySymbol: config.currencySymbol
      };
    });
    Parse.Cloud.define("getStock", async (request) => {
      await requireRole(request, ["cashier", "admin"]);
      const items = new Parse.Query("MenuItem");
      items.equalTo("active", true);
      items.ascending("sortOrder");
      items.limit(500);
      const extras = new Parse.Query("Accompaniment");
      extras.equalTo("active", true);
      extras.ascending("sortOrder");
      extras.limit(500);
      const [menu, accompaniments] = await Promise.all([items.find(MASTER), extras.find(MASTER)]);
      return {
        items: menu.map((item) => ({
          id: item.id,
          title: item.get("title"),
          category: item.get("category") || "Mains",
          available: item.get("availableToday") !== false
        })),
        accompaniments: accompaniments.map((row) => ({
          id: row.id,
          title: row.get("title"),
          available: row.get("available") !== false
        }))
      };
    });
    Parse.Cloud.define("setAvailability", async (request) => {
      const { user: actor } = await requireRole(request, ["cashier", "admin"]);
      const { type, id } = request.params;
      const available = request.params.available === true;
      const className = { menuItem: "MenuItem", accompaniment: "Accompaniment" }[type];
      if (!className) throw invalid("Unknown item type");
      const field = type === "menuItem" ? "availableToday" : "available";
      const row = await new Parse.Query(className).get(String(id), MASTER);
      const before = { [field]: row.get(field) };
      row.set(field, available);
      await row.save(null, MASTER);
      await audit(actor, `stock.${available ? "available" : "sold_out"}`, row, before, {
        [field]: available
      });
      return { id: row.id, available };
    });
  }
});

// cloud/cash.js
var require_cash = __commonJS({
  "cloud/cash.js"() {
    "use strict";
    var {
      MASTER,
      invalid,
      requireRole,
      adminOnly,
      readAcl,
      audit,
      loadConfig,
      nextDailyCode
    } = require_core();
    var { sumBy } = require_money();
    Parse.Cloud.define("createHandover", async (request) => {
      const { user: rider } = await requireRole(request, ["rider"]);
      const ids = request.params.orderIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
        throw invalid("Select unique orders");
      const query = new Parse.Query("Order");
      query.containedIn("objectId", ids);
      query.equalTo("createdBy", rider);
      query.equalTo("status", "DELIVERED");
      query.equalTo("cashStatus", "WITH_RIDER");
      const [orders, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
      if (orders.length !== ids.length) throw invalid("Invalid handover orders");
      const amount = sumBy(orders, (order) => order.get("amountCollected"));
      const row = new Parse.Object("CashHandover");
      row.set({
        handoverCode: await nextDailyCode("HO", 3, config.timezone),
        rider,
        amount,
        orderCount: orders.length,
        orders,
        status: "pending",
        handedOverAt: /* @__PURE__ */ new Date(),
        notes: String(request.params.notes || "")
      });
      row.setACL(readAcl(rider));
      await row.save(null, MASTER);
      orders.forEach((order) => order.set("cashStatus", "HANDOVER_PENDING"));
      await Parse.Object.saveAll(orders, MASTER);
      await audit(rider, "cash.handover_created", row, null, { amount });
      return { id: row.id, amount };
    });
    Parse.Cloud.define("confirmHandover", async (request) => {
      const { user: cashier } = await requireRole(request, ["cashier", "admin"]);
      const row = await new Parse.Query("CashHandover").get(request.params.handoverId, MASTER);
      if (row.get("status") !== "pending") throw invalid("Already resolved");
      const counted = Number(request.params.countedAmount);
      if (!Number.isFinite(counted) || counted !== Number(row.get("amount")))
        throw invalid("Counted cash must match the claim; dispute any variance");
      const orders = await Promise.all((row.get("orders") || []).map((ptr) => ptr.fetch(MASTER)));
      if (orders.some((order) => order.get("cashStatus") !== "HANDOVER_PENDING"))
        throw invalid("Orders are no longer pending this handover");
      orders.forEach((order) => order.set({ cashStatus: "RECONCILED", settledAt: /* @__PURE__ */ new Date() }));
      await Parse.Object.saveAll(orders, MASTER);
      row.set({ status: "confirmed", cashier, confirmedAt: /* @__PURE__ */ new Date(), countedAmount: counted });
      await row.save(null, MASTER);
      await audit(
        cashier,
        "cash.handover_confirmed",
        row,
        { status: "pending" },
        { status: "confirmed", countedAmount: counted }
      );
      return { status: "confirmed" };
    });
    Parse.Cloud.define("disputeHandover", async (request) => {
      const { user: cashier } = await requireRole(request, ["cashier", "admin"]);
      const row = await new Parse.Query("CashHandover").get(request.params.handoverId, MASTER);
      if (row.get("status") !== "pending") throw invalid("Only pending handovers can be disputed");
      const reason = String(request.params.reason || "").trim();
      const counted = Number(request.params.countedAmount);
      if (reason.length < 5 || !Number.isFinite(counted) || counted < 0)
        throw invalid("Enter a reason and physical cash count");
      row.set({
        status: "disputed",
        cashier,
        disputeReason: reason,
        countedAmount: counted,
        disputedAt: /* @__PURE__ */ new Date()
      });
      await row.save(null, MASTER);
      await audit(
        cashier,
        "cash.handover_disputed",
        row,
        { status: "pending", amount: row.get("amount") },
        { status: "disputed", countedAmount: counted, reason }
      );
      return { status: "disputed" };
    });
    Parse.Cloud.define("reopenHandover", async (request) => {
      const actor = await adminOnly(request);
      const row = await new Parse.Query("CashHandover").get(request.params.handoverId, MASTER);
      if (row.get("status") !== "disputed") throw invalid("Only disputed handovers can be reopened");
      const note = String(request.params.note || "").trim();
      if (note.length < 5) throw invalid("Enter a resolution note");
      row.set({ status: "pending", resolutionNote: note, resolvedBy: actor, resolvedAt: /* @__PURE__ */ new Date() });
      await row.save(null, MASTER);
      await audit(
        actor,
        "cash.dispute_reopened",
        row,
        { status: "disputed", reason: row.get("disputeReason") },
        { status: "pending", note }
      );
      return { status: "pending" };
    });
  }
});

// cloud/shifts.js
var require_shifts = __commonJS({
  "cloud/shifts.js"() {
    "use strict";
    var {
      MASTER,
      invalid,
      forbidden,
      requireUser,
      getRoleName,
      readAcl,
      audit
    } = require_core();
    var { sumBy } = require_money();
    var { riderFloat } = require_orders();
    async function expectedTill(cashier, shift) {
      const query = new Parse.Query("CashHandover");
      query.equalTo("cashier", cashier);
      query.equalTo("status", "confirmed");
      query.greaterThanOrEqualTo("confirmedAt", shift.get("startedAt"));
      query.limit(1e3);
      const handovers = await query.find(MASTER);
      return Number(shift.get("openingFloat") || 0) + sumBy(handovers, (h) => h.get("amount"));
    }
    function openShiftQuery(user) {
      const query = new Parse.Query("Shift");
      query.equalTo("operator", user);
      query.equalTo("status", "open");
      query.descending("startedAt");
      return query;
    }
    Parse.Cloud.define("getMyShift", async (request) => {
      const user = requireUser(request);
      const shift = await openShiftQuery(user).first(MASTER);
      if (!shift) return { shift: null };
      const isCashier = shift.get("kind") === "cashier";
      return {
        shift: {
          id: shift.id,
          kind: shift.get("kind"),
          startedAt: shift.get("startedAt"),
          openingFloat: shift.get("openingFloat"),
          expectedTill: isCashier ? await expectedTill(user, shift) : null,
          float: isCashier ? null : await riderFloat(user)
        }
      };
    });
    Parse.Cloud.define("startShift", async (request) => {
      const user = requireUser(request);
      const role = await getRoleName(user);
      const { kind } = request.params;
      const allowed = kind === "rider" && role === "rider" || kind === "cashier" && ["cashier", "admin"].includes(role);
      if (!allowed) throw forbidden("Not allowed to start this shift");
      if (await openShiftQuery(user).first(MASTER)) throw invalid("Close the current shift first");
      const opening = Number(request.params.openingFloat || 0);
      if (!Number.isFinite(opening) || opening < 0) throw invalid("Invalid opening cash");
      const row = new Parse.Object("Shift");
      row.set({
        operator: user,
        kind,
        status: "open",
        openingFloat: kind === "cashier" ? opening : 0,
        startedAt: /* @__PURE__ */ new Date()
      });
      row.setACL(readAcl(user, ["admin"]));
      await row.save(null, MASTER);
      await audit(user, "shift.started", row, null, { kind, openingFloat: row.get("openingFloat") });
      return { id: row.id };
    });
    Parse.Cloud.define("endShift", async (request) => {
      const user = requireUser(request);
      const row = await new Parse.Query("Shift").get(request.params.shiftId, MASTER);
      if (row.get("operator")?.id !== user.id || row.get("status") !== "open")
        throw forbidden("No open shift found");
      const isCashier = row.get("kind") === "cashier";
      const balance = isCashier ? 0 : await riderFloat(user);
      if (balance > 0 && request.params.acknowledgeCash !== true)
        throw invalid("Cash remains with you. Acknowledge it before ending your shift");
      let expected = null;
      let counted = null;
      let variance = null;
      if (isCashier) {
        expected = await expectedTill(user, row);
        counted = Number(request.params.physicalCount);
        if (!Number.isFinite(counted) || counted < 0) throw invalid("Enter physical till count");
        variance = counted - expected;
      }
      row.set({
        status: "closed",
        endedAt: /* @__PURE__ */ new Date(),
        closingFloat: balance,
        acknowledgedCash: balance > 0,
        expectedTill: expected,
        physicalCount: counted,
        variance
      });
      await row.save(null, MASTER);
      await audit(
        user,
        "shift.closed",
        row,
        { status: "open" },
        { balance, expectedTill: expected, physicalCount: counted, variance }
      );
      return { balance, expectedTill: expected, variance };
    });
  }
});

// cloud/lib/seed.js
var require_seed = __commonJS({
  "cloud/lib/seed.js"(exports2, module2) {
    "use strict";
    var SEED_MENU = [
      { key: "1", title: "Smoky chicken bowl", price: 18500, category: "Mains" },
      { key: "2", title: "Beef rolex deluxe", price: 12e3, category: "Mains" },
      { key: "3", title: "Garden rice plate", price: 14500, category: "Mains" },
      { key: "4", title: "Passion fruit juice", price: 6e3, category: "Drinks" },
      { key: "5", title: "Iced hibiscus", price: 5500, category: "Drinks" },
      { key: "6", title: "Breakfast chapati", price: 8e3, category: "Breakfast" }
    ];
    module2.exports = { SEED_MENU };
  }
});

// cloud/admin.js
var require_admin = __commonJS({
  "cloud/admin.js"(exports2, module2) {
    "use strict";
    var {
      MASTER,
      invalid,
      forbidden,
      requireUser,
      adminOnly,
      ensureRole,
      readAcl,
      userAcl,
      audit,
      loadConfig,
      countUsers,
      nextStaffCode
    } = require_core();
    var { COMMISSION_TYPES } = require_money();
    var { isValidTimeZone } = require_dates();
    var { SEED_MENU } = require_seed();
    var { normalizeGroups } = require_accompaniments();
    var { applySecurity } = require_security();
    var ROLE_NAMES = ["admin", "cashier", "rider"];
    var STAFF_ROLES = ["rider", "cashier"];
    var merchantField = (value, max) => String(value ?? "").trim().slice(0, max);
    var codeField = (role) => role === "rider" ? "riderCode" : "cashierCode";
    async function adminRoleExists() {
      const query = new Parse.Query(Parse.Role);
      query.equalTo("name", "admin");
      return !!await query.first(MASTER);
    }
    async function canBootstrapOwner() {
      return !await adminRoleExists() && await countUsers() === 1;
    }
    async function makeOwner(user, actor) {
      const role = await ensureRole("admin");
      role.getUsers().add(user);
      await role.save(null, MASTER);
      await Promise.all(STAFF_ROLES.map(ensureRole));
      if (!await new Parse.Query("MenuItem").first(MASTER)) {
        const seed = SEED_MENU.map((entry, index) => {
          const item = new Parse.Object("MenuItem");
          item.set({
            title: entry.title,
            price: entry.price,
            category: entry.category,
            active: true,
            availableToday: true,
            sortOrder: index
          });
          item.setACL(readAcl(null, ["admin"]));
          return item;
        });
        await Parse.Object.saveAll(seed, MASTER);
      }
      await applySecurity();
      await audit(actor, "owner.initialized", role, null, { userId: user.id });
    }
    Parse.Cloud.define("bootstrapOwner", async (request) => {
      const user = requireUser(request);
      if (await adminRoleExists()) throw forbidden("Owner already configured");
      if (await countUsers() !== 1)
        throw forbidden("Owner setup requires exactly one existing account");
      await makeOwner(user, user);
      return { ok: true };
    });
    async function createOrResetOwner(params) {
      const username = String(params.username || "").trim().toLowerCase();
      const password = String(params.password || "");
      if (!/^[-a-z0-9_.@]{3,64}$/.test(username) || password.length < 8)
        throw invalid("Give a username (3+ characters) and a password of at least 8 characters");
      const query = new Parse.Query(Parse.User);
      query.equalTo("username", username);
      let user = await query.first(MASTER);
      const created = !user;
      if (!user) {
        user = new Parse.User();
        user.set({ username, password, active: true });
        if (params.email) user.set("email", String(params.email).trim());
        user.set("name", String(params.name || username).trim());
        await user.signUp(null, MASTER);
      } else {
        user.set({ password, active: true });
        await user.save(null, MASTER);
      }
      user.setACL(userAcl(user, "admin"));
      await user.save(null, MASTER);
      await makeOwner(user, user);
      return { username, created, role: "admin" };
    }
    Parse.Cloud.define("recoverOwner", async (request) => {
      if (!request.master) throw forbidden("Master key required");
      return createOrResetOwner(request.params);
    });
    Parse.Cloud.job("createOwner", async (request) => {
      const result = await createOrResetOwner(request.params || {});
      return `Owner ${result.created ? "created" : "password reset"}: ${result.username}`;
    });
    async function roleMembership() {
      const query = new Parse.Query(Parse.Role);
      query.containedIn("name", ROLE_NAMES);
      const held = {};
      for (const role of await query.find(MASTER)) {
        const users = await role.getUsers().query().limit(1e3).find(MASTER);
        for (const user of users) (held[user.id] ||= []).push(role.getName());
      }
      const members = {};
      for (const [id, names] of Object.entries(held))
        members[id] = ROLE_NAMES.find((name) => names.includes(name));
      return members;
    }
    Parse.Cloud.define("adminListSetup", async (request) => {
      await adminOnly(request);
      const userQuery = new Parse.Query(Parse.User);
      userQuery.ascending("createdAt");
      userQuery.limit(1e3);
      const menuQuery = new Parse.Query("MenuItem");
      menuQuery.ascending("sortOrder");
      menuQuery.limit(1e3);
      const categoryQuery = new Parse.Query("MenuCategory");
      categoryQuery.ascending("sortOrder");
      categoryQuery.limit(1e3);
      const accompanimentQuery = new Parse.Query("Accompaniment");
      accompanimentQuery.ascending("sortOrder");
      accompanimentQuery.limit(1e3);
      const [users, menu, categories, members, { object: config, values }, accompaniments] = await Promise.all([
        userQuery.find(MASTER),
        menuQuery.find(MASTER),
        categoryQuery.find(MASTER),
        roleMembership(),
        loadConfig(),
        accompanimentQuery.find(MASTER)
      ]);
      return {
        team: users.map((user) => ({
          id: user.id,
          name: user.get("name") || user.getUsername(),
          username: user.getUsername(),
          phone: user.get("phone") || "",
          active: user.get("active") !== false,
          role: members[user.id] || "unassigned",
          code: user.get("riderCode") || user.get("cashierCode") || "",
          commissionType: user.get("commissionType") || "per_order",
          commissionPerOrder: user.get("commissionPerOrder") || 0,
          commissionPercent: user.get("commissionPercent") || 0
        })),
        menu: menu.map((item) => ({
          id: item.id,
          title: item.get("title"),
          price: item.get("price"),
          category: item.get("category"),
          active: item.get("active") !== false,
          availableToday: item.get("availableToday") !== false,
          accompanimentGroups: item.get("accompanimentGroups") || []
        })),
        accompaniments: accompaniments.map((row) => ({
          id: row.id,
          title: row.get("title"),
          active: row.get("active") !== false,
          available: row.get("available") !== false
        })),
        categories: categories.map((category) => ({
          id: category.id,
          title: category.get("title"),
          active: category.get("active") !== false
        })),
        settings: config ? { id: config.id, ...values } : null
      };
    });
    Parse.Cloud.define("adminCreateTeamMember", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      const roleName = p.role;
      if (!STAFF_ROLES.includes(roleName)) throw invalid("Invalid role");
      const name = String(p.name || "").trim();
      const username = String(p.username || "").trim().toLowerCase();
      const pin = String(p.pin || "");
      if (!name || !/^[-a-z0-9_.]{3,32}$/.test(username) || pin.length < 4 || pin.length > 32)
        throw invalid("Enter a name, valid username and PIN of at least 4 characters");
      const user = new Parse.User();
      user.set({
        username,
        password: pin,
        name,
        phone: String(p.phone || ""),
        active: true,
        commissionType: "per_order",
        commissionPerOrder: 0,
        commissionPercent: 0,
        [codeField(roleName)]: await nextStaffCode(roleName)
      });
      await user.signUp(null, MASTER);
      user.setACL(userAcl(user, roleName));
      await user.save(null, MASTER);
      const role = await ensureRole(roleName);
      role.getUsers().add(user);
      await role.save(null, MASTER);
      await audit(actor, "team.created", user, null, { name, role: roleName });
      return { id: user.id, name, username, role: roleName, code: user.get(codeField(roleName)) };
    });
    Parse.Cloud.define("adminUpdateMember", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      const user = await new Parse.Query(Parse.User).get(p.id, MASTER);
      if (user.id === actor.id && p.active === false) throw forbidden("You cannot deactivate yourself");
      const snapshot = () => ({
        active: user.get("active"),
        commissionType: user.get("commissionType"),
        commissionPerOrder: user.get("commissionPerOrder"),
        commissionPercent: user.get("commissionPercent")
      });
      const before = snapshot();
      if (typeof p.active === "boolean") user.set("active", p.active);
      if (p.commissionType !== void 0) {
        if (!COMMISSION_TYPES.includes(p.commissionType)) throw invalid("Invalid commission type");
        user.set("commissionType", p.commissionType);
      }
      for (const key of ["commissionPerOrder", "commissionPercent"])
        if (p[key] !== void 0) {
          const value = Number(p[key]);
          const max = key === "commissionPercent" ? 100 : 1e6;
          if (!Number.isFinite(value) || value < 0 || value > max)
            throw invalid("Invalid commission value");
          user.set(key, value);
        }
      await user.save(null, MASTER);
      await audit(actor, "team.updated", user, before, snapshot());
      return { ok: true };
    });
    Parse.Cloud.define("adminChangeRole", async (request) => {
      const actor = await adminOnly(request);
      const { userId, role: next } = request.params;
      if (!STAFF_ROLES.includes(next)) throw invalid("Only rider and cashier roles can be assigned");
      const user = await new Parse.Query(Parse.User).get(userId, MASTER);
      if (user.id === actor.id) throw forbidden("You cannot change your own role");
      const query = new Parse.Query(Parse.Role);
      query.containedIn("name", ROLE_NAMES);
      const roles = await query.find(MASTER);
      const isMember = (role) => role.getUsers().query().get(userId, MASTER).then(() => true).catch(() => false);
      const adminRole = roles.find((role) => role.getName() === "admin");
      if (adminRole && await isMember(adminRole))
        throw forbidden("Admin roles cannot be changed here");
      let before = "unassigned";
      for (const role of roles.filter((r) => STAFF_ROLES.includes(r.getName()))) {
        if (await isMember(role)) {
          before = role.getName();
          role.getUsers().remove(user);
          await role.save(null, MASTER);
        }
      }
      const destination = await ensureRole(next);
      destination.getUsers().add(user);
      await destination.save(null, MASTER);
      if (!user.get(codeField(next))) user.set(codeField(next), await nextStaffCode(next));
      user.setACL(userAcl(user, next));
      await user.save(null, MASTER);
      await audit(actor, "team.role_changed", user, { role: before }, { role: next });
      return { role: next };
    });
    Parse.Cloud.define("adminSaveCategory", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      const title = String(p.title || "").trim();
      if (!title || title.length > 80) throw invalid("Category title is required");
      const category = p.id ? await new Parse.Query("MenuCategory").get(p.id, MASTER) : new Parse.Object("MenuCategory");
      const before = p.id ? category.toJSON() : null;
      category.set({ title, active: p.active !== false, sortOrder: Number(p.sortOrder) || 0 });
      category.setACL(readAcl(null, ["admin"]));
      await category.save(null, MASTER);
      await audit(actor, "menu.category_saved", category, before, {
        title,
        active: category.get("active")
      });
      return { id: category.id };
    });
    Parse.Cloud.define("adminSaveMenuItem", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      const item = p.id ? await new Parse.Query("MenuItem").get(p.id, MASTER) : new Parse.Object("MenuItem");
      const title = String(p.title || "").trim();
      const price = Number(p.price);
      if (!title || !Number.isFinite(price) || price < 0)
        throw invalid("A title and nonnegative price are required");
      const before = p.id ? item.toJSON() : null;
      item.set({
        title,
        price,
        category: String(p.category || "Mains").trim(),
        active: p.active !== false,
        availableToday: p.availableToday !== false
      });
      if (p.accompanimentGroups !== void 0) {
        const known = new Parse.Query("Accompaniment");
        known.limit(1e3);
        const ids = new Set((await known.find(MASTER)).map((row) => row.id));
        try {
          item.set("accompanimentGroups", normalizeGroups(p.accompanimentGroups, ids));
        } catch (e) {
          throw invalid(e.message);
        }
      }
      item.setACL(readAcl(null, ["admin"]));
      await item.save(null, MASTER);
      await audit(actor, "menu.saved", item, before, { title, price });
      return { id: item.id };
    });
    Parse.Cloud.define("adminSaveAccompaniment", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      const title = String(p.title || "").trim();
      if (!title || title.length > 60) throw invalid("An accompaniment name is required");
      const row = p.id ? await new Parse.Query("Accompaniment").get(p.id, MASTER) : new Parse.Object("Accompaniment");
      const before = p.id ? row.toJSON() : null;
      row.set({
        title,
        active: p.active !== false,
        available: p.available !== false,
        sortOrder: Number(p.sortOrder) || 0
      });
      row.setACL(readAcl(null, ["admin"]));
      await row.save(null, MASTER);
      await audit(actor, "menu.accompaniment_saved", row, before, {
        title,
        active: row.get("active"),
        available: row.get("available")
      });
      return { id: row.id };
    });
    Parse.Cloud.define("adminSaveSettings", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      const { object: existing, values: current } = await loadConfig();
      const config = existing || new Parse.Object("Configuration");
      const before = existing ? existing.toJSON() : null;
      const fee = Number(p.defaultDeliveryFee);
      const max = Number(p.maxRiderFloat);
      if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(max) || max < 0)
        throw invalid("Fee and float limit must be nonnegative");
      const timezone = String(p.timezone || current.timezone).trim();
      if (!isValidTimeZone(timezone)) throw invalid("Unknown timezone, e.g. Africa/Kampala");
      config.set({
        restaurantName: String(p.restaurantName || current.restaurantName).trim(),
        currencySymbol: String(p.currencySymbol || current.currencySymbol).trim(),
        currencyCode: String(p.currencyCode || current.currencyCode).trim().toUpperCase(),
        timezone,
        defaultDeliveryFee: fee,
        maxRiderFloat: max,
        allowBatching: !!p.allowBatching,
        requireCashierConfirmForPickup: !!p.requireCashierConfirmForPickup,
        airtelMerchantCode: merchantField(p.airtelMerchantCode, 30),
        airtelMerchantName: merchantField(p.airtelMerchantName, 60),
        mtnMerchantCode: merchantField(p.mtnMerchantCode, 30),
        mtnMerchantName: merchantField(p.mtnMerchantName, 60)
      });
      config.setACL(readAcl(null, ["admin"]));
      await config.save(null, MASTER);
      await audit(actor, "configuration.saved", config, before, config.toJSON());
      return { id: config.id };
    });
    module2.exports = { canBootstrapOwner };
  }
});

// cloud/preview.js
var require_preview = __commonJS({
  "cloud/preview.js"(exports2, module2) {
    "use strict";
    var { MASTER, forbidden, invalid } = require_core();
    var { SEED_MENU } = require_seed();
    var previewEnabled = () => process.env.RELAY_ENABLE_PREVIEW === "true";
    var DEMO_FEE = 3e3;
    function requirePreview() {
      if (!previewEnabled()) throw forbidden("Preview mode is disabled");
    }
    Parse.Cloud.define("createPreviewOrder", async (request) => {
      requirePreview();
      const p = request.params;
      if (!String(p.customerName || "").trim() || !String(p.deliveryAddress || "").trim())
        throw invalid("Customer and address are required");
      if (!Array.isArray(p.items) || !p.items.length) throw invalid("Add at least one item");
      let subtotal = 0;
      const itemSummary = p.items.map((line) => {
        const menu = SEED_MENU.find((item) => item.key === String(line.id));
        const qty = Number(line.quantity);
        if (!menu || !Number.isInteger(qty) || qty < 1 || qty > 50) throw invalid("Invalid item");
        subtotal += menu.price * qty;
        return `${qty}\xD7 ${menu.title}`;
      }).join(" \xB7 ");
      const row = new Parse.Object("DemoOrder");
      row.set({
        orderCode: `DEMO-${String(Date.now()).slice(-6)}`,
        customerName: String(p.customerName).trim().slice(0, 80),
        deliveryAddress: String(p.deliveryAddress).trim().slice(0, 160),
        riderName: "Preview rider",
        itemSummary,
        subtotal,
        deliveryFee: DEMO_FEE,
        total: subtotal + DEMO_FEE,
        status: "PLACED",
        restaurantStatus: "pending",
        isDemo: true
      });
      row.setACL(new Parse.ACL());
      await row.save(null, MASTER);
      return { id: row.id, orderCode: row.get("orderCode"), total: row.get("total") };
    });
    Parse.Cloud.define("getPreviewOrders", async () => {
      requirePreview();
      const query = new Parse.Query("DemoOrder");
      query.notContainedIn("status", ["PICKED_UP", "DELIVERED", "CANCELLED"]);
      query.descending("createdAt");
      query.limit(30);
      let rows = await query.find(MASTER);
      if (!rows.length) {
        const seeds = [
          ["DEMO-0218", "Joel M.", "2\xD7 Smoky chicken bowl \xB7 1\xD7 Juice", 43e3, "PLACED"],
          ["DEMO-0217", "Sarah N.", "2\xD7 Garden rice plate", 32e3, "PREPARING"],
          ["DEMO-0214", "Joseph K.", "1\xD7 Chicken bowl \xB7 1\xD7 Hibiscus", 24500, "READY"]
        ];
        rows = seeds.map(([code, customer, items, total, status]) => {
          const row = new Parse.Object("DemoOrder");
          row.set({
            orderCode: code,
            customerName: customer,
            deliveryAddress: "Kampala Central",
            riderName: "R-014 \xB7 Amina",
            itemSummary: items,
            total,
            status,
            restaurantStatus: String(status).toLowerCase(),
            isDemo: true
          });
          row.setACL(new Parse.ACL());
          return row;
        });
        await Parse.Object.saveAll(rows, MASTER);
      }
      return rows.map((row) => ({
        id: row.id,
        code: row.get("orderCode"),
        rider: row.get("riderName"),
        customer: row.get("customerName"),
        items: row.get("itemSummary"),
        total: row.get("total"),
        status: row.get("status")
      }));
    });
    var DEMO_TRANSITIONS = {
      accept: ["PLACED", "ACCEPTED"],
      prepare: ["ACCEPTED", "PREPARING"],
      ready: ["PREPARING", "READY"],
      pickup: ["READY", "PICKED_UP"]
    };
    Parse.Cloud.define("transitionPreviewOrder", async (request) => {
      requirePreview();
      const row = await new Parse.Query("DemoOrder").get(request.params.orderId, MASTER);
      const rule = DEMO_TRANSITIONS[request.params.action];
      if (!rule || row.get("status") !== rule[0]) throw invalid("Invalid preview transition");
      row.set({ status: rule[1], restaurantStatus: rule[1].toLowerCase() });
      await row.save(null, MASTER);
      return { status: rule[1] };
    });
    module2.exports = { previewEnabled };
  }
});

// cloud/lib/reports.js
var require_reports = __commonJS({
  "cloud/lib/reports.js"(exports2, module2) {
    "use strict";
    var round = (value) => Math.round(Number(value) || 0);
    var isDelivered = (fact) => fact.status === "DELIVERED";
    var OPEN = ["PLACED", "ACCEPTED", "PREPARING", "READY", "PICKED_UP"];
    function growth(current, previous) {
      if (!previous) return null;
      return Math.round((current - previous) / previous * 1e3) / 10;
    }
    function summarize(facts) {
      const delivered = facts.filter(isDelivered);
      const revenue = delivered.reduce((n, f) => n + round(f.total), 0);
      const commission = delivered.reduce((n, f) => n + round(f.commission), 0);
      const perCustomer = /* @__PURE__ */ new Map();
      for (const fact of delivered) {
        if (!fact.customerKey) continue;
        perCustomer.set(fact.customerKey, (perCustomer.get(fact.customerKey) || 0) + 1);
      }
      const minutes = delivered.filter((f) => f.deliveredAt && f.createdAt).map((f) => (f.deliveredAt - f.createdAt) / 6e4);
      return {
        orders: facts.length,
        delivered: delivered.length,
        cancelled: facts.filter((f) => f.status === "CANCELLED").length,
        rejected: facts.filter((f) => f.restaurantStatus === "rejected").length,
        open: facts.filter((f) => OPEN.includes(f.status)).length,
        revenue,
        foodSales: delivered.reduce((n, f) => n + round(f.subtotal), 0),
        deliveryFees: delivered.reduce((n, f) => n + round(f.deliveryFee), 0),
        commission,
        net: revenue - commission,
        avgOrder: delivered.length ? Math.round(revenue / delivered.length) : 0,
        cashSales: delivered.filter((f) => f.method === "cash").reduce((n, f) => n + round(f.total), 0),
        mobileMoneySales: delivered.filter((f) => f.method === "mobile_money").reduce((n, f) => n + round(f.total), 0),
        customers: perCustomer.size,
        repeatCustomers: [...perCustomer.values()].filter((count) => count > 1).length,
        avgDeliveryMinutes: minutes.length ? Math.round(minutes.reduce((n, m) => n + m, 0) / minutes.length) : null
      };
    }
    function series(facts, keys, keyOf) {
      const rows = new Map(
        keys.map((key) => [key, { key, orders: 0, delivered: 0, revenue: 0, commission: 0 }])
      );
      for (const fact of facts) {
        const row = rows.get(keyOf(fact));
        if (!row) continue;
        row.orders += 1;
        if (!isDelivered(fact)) continue;
        row.delivered += 1;
        row.revenue += round(fact.total);
        row.commission += round(fact.commission);
      }
      let previous = null;
      return [...rows.values()].map((row) => {
        const out = {
          ...row,
          avgOrder: row.delivered ? Math.round(row.revenue / row.delivered) : 0,
          revenueChange: previous ? growth(row.revenue, previous.revenue) : null,
          commissionChange: previous ? growth(row.commission, previous.commission) : null
        };
        previous = row;
        return out;
      });
    }
    function itemSales(lines) {
      const byName = /* @__PURE__ */ new Map();
      for (const line of lines) {
        const row = byName.get(line.name) || { name: line.name, qty: 0, revenue: 0, orders: 0 };
        row.qty += round(line.qty);
        row.revenue += round(line.total);
        row.orders += 1;
        byName.set(line.name, row);
      }
      const revenue = [...byName.values()].reduce((n, row) => n + row.revenue, 0);
      return [...byName.values()].map((row) => ({
        ...row,
        share: revenue ? Math.round(row.revenue / revenue * 1e3) / 10 : 0,
        avgPrice: row.qty ? Math.round(row.revenue / row.qty) : 0
      })).sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name));
    }
    function accompanimentCounts(lines) {
      const counts = /* @__PURE__ */ new Map();
      for (const line of lines)
        for (const name of line.accompaniments || [])
          counts.set(name, (counts.get(name) || 0) + round(line.qty));
      return [...counts.entries()].map(([name, servings]) => ({ name, servings })).sort((a, b) => b.servings - a.servings || a.name.localeCompare(b.name));
    }
    function riderStats(facts) {
      const byRider = /* @__PURE__ */ new Map();
      for (const fact of facts) {
        if (!fact.riderId) continue;
        const row = byRider.get(fact.riderId) || {
          riderId: fact.riderId,
          rider: fact.rider,
          orders: 0,
          delivered: 0,
          cancelled: 0,
          revenue: 0,
          commission: 0,
          minutes: []
        };
        row.orders += 1;
        if (fact.status === "CANCELLED") row.cancelled += 1;
        if (isDelivered(fact)) {
          row.delivered += 1;
          row.revenue += round(fact.total);
          row.commission += round(fact.commission);
          if (fact.deliveredAt && fact.createdAt)
            row.minutes.push((fact.deliveredAt - fact.createdAt) / 6e4);
        }
        byRider.set(fact.riderId, row);
      }
      return [...byRider.values()].map(({ minutes, ...row }) => ({
        ...row,
        avgDeliveryMinutes: minutes.length ? Math.round(minutes.reduce((n, m) => n + m, 0) / minutes.length) : null
      })).sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
    }
    function timeOfDay(facts, clockOf) {
      const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, revenue: 0 }));
      const weekdays = Array.from({ length: 7 }, (_, weekday) => ({ weekday, orders: 0, revenue: 0 }));
      for (const fact of facts) {
        const { hour, weekday } = clockOf(fact);
        hours[hour].orders += 1;
        weekdays[weekday].orders += 1;
        if (isDelivered(fact)) {
          hours[hour].revenue += round(fact.total);
          weekdays[weekday].revenue += round(fact.total);
        }
      }
      return { hours, weekdays };
    }
    function paymentMix(facts) {
      const byKey = /* @__PURE__ */ new Map();
      for (const fact of facts.filter(isDelivered)) {
        const key = fact.method === "mobile_money" ? fact.provider || "mobile_money" : "cash";
        const row = byKey.get(key) || { key, orders: 0, amount: 0 };
        row.orders += 1;
        row.amount += round(fact.total);
        byKey.set(key, row);
      }
      return [...byKey.values()].sort((a, b) => b.amount - a.amount);
    }
    function channelMix(facts) {
      const byKey = /* @__PURE__ */ new Map();
      for (const fact of facts.filter(isDelivered)) {
        const key = fact.channel || "unknown";
        const row = byKey.get(key) || { key, orders: 0, amount: 0 };
        row.orders += 1;
        row.amount += round(fact.total);
        byKey.set(key, row);
      }
      return [...byKey.values()].sort((a, b) => b.amount - a.amount);
    }
    module2.exports = {
      growth,
      summarize,
      series,
      itemSales,
      accompanimentCounts,
      riderStats,
      timeOfDay,
      paymentMix,
      channelMix
    };
  }
});

// cloud/reports.js
var require_reports2 = __commonJS({
  "cloud/reports.js"() {
    "use strict";
    var { MASTER, invalid, requireRole, loadConfig } = require_core();
    var { merchantAccounts } = require_mobileMoney();
    var { resolveRange, previousRange, bucketOf, bucketKeys, localClock } = require_dates();
    var R = require_reports();
    var MAX_ROWS = 2e3;
    var PERIODS = ["day", "week", "month"];
    var nameOf = (user) => user ? [user.get("riderCode") || user.get("cashierCode"), user.get("name") || user.get("username")].filter(Boolean).join(" \xB7 ") : "";
    async function findAll(query) {
      const rows = [];
      await query.eachBatch((batch) => void rows.push(...batch), { ...MASTER, batchSize: 1e3 });
      return rows;
    }
    function rangeOf(params, config, options) {
      const range = resolveRange(params, config.timezone, options);
      if (range.error) throw invalid(range.error);
      return range;
    }
    var riderPointer = (id) => {
      if (!id) return null;
      if (typeof id !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(id)) throw invalid("Unknown rider");
      return Parse.User.createWithoutData(id);
    };
    var METHODS = ["all", "cash", "mobile_money"];
    function methodOf(params) {
      const method = params.method || "all";
      if (!METHODS.includes(method)) throw invalid("Payment type must be cash or mobile_money");
      return method;
    }
    function periodOf(params, range) {
      if (params.period) {
        if (!PERIODS.includes(params.period)) throw invalid("Group by day, week or month");
        return params.period;
      }
      return range.days <= 31 ? "day" : range.days <= 120 ? "week" : "month";
    }
    function ordersIn(range, field, riderId) {
      const query = new Parse.Query("Order");
      query.greaterThanOrEqualTo(field, range.start);
      query.lessThan(field, range.end);
      const rider = riderPointer(riderId);
      if (rider) query.equalTo("createdBy", rider);
      query.include("createdBy");
      return query;
    }
    function factOf(order) {
      const rider = order.get("createdBy");
      const phone = order.get("customerPhone");
      const name = String(order.get("customerName") || "").toLowerCase();
      return {
        id: order.id,
        code: order.get("orderCode"),
        status: order.get("status"),
        restaurantStatus: order.get("restaurantStatus"),
        channel: order.get("channel"),
        customer: order.get("customerName") || "",
        customerKey: order.get("customer")?.id || (phone ? `tel:${phone}` : name && `name:${name}`),
        riderId: rider?.id || "",
        rider: nameOf(rider),
        total: Number(order.get("total") || 0),
        subtotal: Number(order.get("subtotal") || 0),
        deliveryFee: Number(order.get("deliveryFee") || 0),
        commission: Number(order.get("commissionAmount") || 0),
        method: order.get("paymentMethod"),
        provider: order.get("paymentProvider") || "",
        reference: order.get("paymentReference") || "",
        paymentStatus: order.get("paymentStatus") || "",
        amountCollected: Number(order.get("amountCollected") || 0),
        cashStatus: order.get("cashStatus") || "",
        createdAt: order.createdAt,
        deliveredAt: order.get("deliveredAt") || null
      };
    }
    var byNewest = (field) => (a, b) => (b[field] || 0) - (a[field] || 0);
    var rangeInfo = (range) => ({ from: range.from, to: range.to, days: range.days });
    Parse.Cloud.define("getReportOptions", async (request) => {
      await requireRole(request, ["cashier", "admin"]);
      const query = new Parse.Query(Parse.User);
      query.exists("riderCode");
      query.ascending("riderCode");
      query.limit(1e3);
      const riders = await query.find(MASTER);
      return {
        riders: riders.map((user) => ({
          id: user.id,
          label: nameOf(user),
          active: user.get("active") !== false
        }))
      };
    });
    Parse.Cloud.define("getPaymentsLedger", async (request) => {
      await requireRole(request, ["cashier", "admin"]);
      const p = request.params;
      const { values: config } = await loadConfig();
      const range = rangeOf(p, config, { defaultDays: 7 });
      const method = methodOf(p);
      const wantCash = method !== "mobile_money";
      const wantMomo = method !== "cash";
      const cashQuery = ordersIn(range, "deliveredAt", p.riderId);
      cashQuery.equalTo("paymentMethod", "cash");
      cashQuery.equalTo("status", "DELIVERED");
      const momoQuery = ordersIn(range, "createdAt", p.riderId);
      momoQuery.equalTo("paymentMethod", "mobile_money");
      momoQuery.include("paymentCheckedBy");
      const handoverQuery = new Parse.Query("CashHandover");
      handoverQuery.greaterThanOrEqualTo("createdAt", new Date(range.start.getTime() - 7 * 864e5));
      handoverQuery.lessThan("createdAt", new Date(range.end.getTime() + 7 * 864e5));
      if (p.riderId) handoverQuery.equalTo("rider", riderPointer(p.riderId));
      handoverQuery.include(["rider", "cashier"]);
      const [cashOrders, momoOrders, handovers] = await Promise.all([
        wantCash ? findAll(cashQuery) : [],
        wantMomo ? findAll(momoQuery) : [],
        wantCash ? findAll(handoverQuery) : []
      ]);
      const handoverOf = /* @__PURE__ */ new Map();
      for (const handover of handovers)
        for (const order of handover.get("orders") || [])
          if (handover.get("status") !== "disputed" || !handoverOf.has(order.id))
            handoverOf.set(order.id, handover.get("handoverCode"));
      const cashRows = cashOrders.map((order) => {
        const f = factOf(order);
        return {
          id: f.id,
          kind: "cash",
          at: f.deliveredAt,
          code: f.code,
          riderId: f.riderId,
          rider: f.rider,
          customer: f.customer,
          amount: f.amountCollected,
          orderTotal: f.total,
          status: f.cashStatus,
          provider: "",
          reference: handoverOf.get(order.id) || "",
          note: order.get("shortfallNote") || ""
        };
      });
      const momoRows = momoOrders.map((order) => {
        const f = factOf(order);
        return {
          id: f.id,
          kind: "mobile_money",
          at: f.createdAt,
          code: f.code,
          riderId: f.riderId,
          rider: f.rider,
          customer: f.customer,
          amount: f.total,
          orderTotal: f.total,
          orderStatus: f.status,
          status: f.paymentStatus,
          provider: f.provider,
          reference: f.reference,
          note: order.get("paymentRejectReason") || (f.status === "CANCELLED" ? "Order cancelled" : nameOf(order.get("paymentCheckedBy")))
        };
      });
      const sum = (rows, test) => rows.filter(test).reduce((n, row) => n + row.amount, 0);
      const count = (rows, test) => rows.filter(test).length;
      const liveMomo = momoRows.filter((r) => r.orderStatus !== "CANCELLED" || r.status === "VERIFIED");
      const handoverRows = handovers.filter((h) => h.createdAt >= range.start && h.createdAt < range.end).sort((a, b) => b.createdAt - a.createdAt).map((h) => ({
        id: h.id,
        code: h.get("handoverCode"),
        riderId: h.get("rider")?.id || "",
        rider: nameOf(h.get("rider")),
        cashier: nameOf(h.get("cashier")),
        amount: Number(h.get("amount") || 0),
        countedAmount: h.get("countedAmount") ?? null,
        orderCount: h.get("orderCount") || 0,
        status: h.get("status"),
        reason: h.get("disputeReason") || "",
        createdAt: h.createdAt,
        confirmedAt: h.get("confirmedAt") || null
      }));
      const transactions = [...cashRows, ...momoRows].sort(byNewest("at"));
      return {
        range: rangeInfo(range),
        method,
        summary: {
          total: sum(cashRows, () => true) + sum(liveMomo, (r) => r.status === "VERIFIED"),
          cash: {
            count: cashRows.length,
            collected: sum(cashRows, () => true),
            withRiders: sum(cashRows, (r) => r.status === "WITH_RIDER"),
            handoverPending: sum(cashRows, (r) => r.status === "HANDOVER_PENDING"),
            reconciled: sum(cashRows, (r) => r.status === "RECONCILED")
          },
          mobileMoney: {
            count: momoRows.length,
            verified: sum(momoRows, (r) => r.status === "VERIFIED"),
            verifiedCount: count(momoRows, (r) => r.status === "VERIFIED"),
            pending: sum(liveMomo, (r) => r.status === "PENDING_VERIFICATION"),
            pendingCount: count(liveMomo, (r) => r.status === "PENDING_VERIFICATION"),
            rejected: sum(momoRows, (r) => r.status === "REJECTED"),
            rejectedCount: count(momoRows, (r) => r.status === "REJECTED"),
            byProvider: merchantAccounts(config).map((account) => {
              const rows = momoRows.filter(
                (r) => r.provider === account.provider && r.status === "VERIFIED"
              );
              return { ...account, count: rows.length, amount: sum(rows, () => true) };
            })
          },
          handovers: {
            count: handoverRows.length,
            confirmed: handoverRows.filter((h) => h.status === "confirmed").reduce((n, h) => n + h.amount, 0),
            pending: handoverRows.filter((h) => h.status === "pending").reduce((n, h) => n + h.amount, 0),
            disputed: handoverRows.filter((h) => h.status === "disputed").length
          }
        },
        transactions: transactions.slice(0, MAX_ROWS),
        truncated: transactions.length > MAX_ROWS,
        handovers: handoverRows
      };
    });
    var ORDER_STATUSES = ["open", "DELIVERED", "CANCELLED", "PICKED_UP"];
    Parse.Cloud.define("adminSearchOrders", async (request) => {
      await requireRole(request, ["admin"]);
      const p = request.params;
      const { values: config } = await loadConfig();
      const range = rangeOf(p, config, { defaultDays: 7 });
      const method = methodOf(p);
      const query = ordersIn(range, "createdAt", p.riderId);
      if (method !== "all") query.equalTo("paymentMethod", method);
      if (p.status) {
        if (!ORDER_STATUSES.includes(p.status)) throw invalid("Unknown status filter");
        if (p.status === "open")
          query.containedIn("status", ["PLACED", "ACCEPTED", "PREPARING", "READY", "PICKED_UP"]);
        else query.equalTo("status", p.status);
      }
      const facts = (await findAll(query)).map(factOf).sort(byNewest("createdAt"));
      return {
        range: rangeInfo(range),
        summary: R.summarize(facts),
        rows: facts.slice(0, MAX_ROWS).map(({ customerKey: _key, ...row }) => row),
        truncated: facts.length > MAX_ROWS
      };
    });
    Parse.Cloud.define("getCommissionLedger", async (request) => {
      await requireRole(request, ["admin"]);
      const p = request.params;
      const { values: config } = await loadConfig();
      const range = rangeOf(p, config, { defaultDays: 7 });
      const query = ordersIn(range, "deliveredAt", p.riderId);
      query.equalTo("status", "DELIVERED");
      const facts = (await findAll(query)).map(factOf).sort(byNewest("deliveredAt"));
      const riders = R.riderStats(facts).sort((a, b) => b.commission - a.commission);
      return {
        range: rangeInfo(range),
        total: facts.reduce((n, f) => n + f.commission, 0),
        deliveries: facts.length,
        riders: riders.map(({ riderId, rider, delivered, revenue, commission }) => ({
          riderId,
          rider,
          deliveries: delivered,
          sales: revenue,
          commission
        })),
        rows: facts.slice(0, MAX_ROWS).map((f) => ({
          id: f.id,
          code: f.code,
          riderId: f.riderId,
          rider: f.rider,
          customer: f.customer,
          total: f.total,
          subtotal: f.subtotal,
          commission: f.commission,
          method: f.method,
          deliveredAt: f.deliveredAt
        })),
        truncated: facts.length > MAX_ROWS
      };
    });
    async function earningsFacts(range, riderId) {
      const query = ordersIn(range, "deliveredAt", riderId);
      query.equalTo("status", "DELIVERED");
      return (await findAll(query)).map(factOf);
    }
    Parse.Cloud.define("getRiderEarnings", async (request) => {
      const { user, role } = await requireRole(request, ["rider", "admin"]);
      const p = request.params;
      const riderId = role === "admin" ? p.riderId || user.id : user.id;
      const { values: config } = await loadConfig();
      const range = rangeOf(p, config, { defaultDays: 56 });
      const period = periodOf(p, range);
      const before = previousRange(range, config.timezone);
      const [facts, previousFacts] = await Promise.all([
        earningsFacts(range, riderId),
        earningsFacts(before, riderId)
      ]);
      const totals = (rows) => ({
        deliveries: rows.length,
        earnings: rows.reduce((n, f) => n + f.commission, 0),
        sales: rows.reduce((n, f) => n + f.total, 0),
        cash: rows.filter((f) => f.method === "cash").reduce((n, f) => n + f.amountCollected, 0)
      });
      const current = totals(facts);
      const previous = totals(previousFacts);
      const keyOf = (f) => bucketOf(f.deliveredAt, config.timezone, period);
      return {
        range: rangeInfo(range),
        previousRange: rangeInfo(before),
        period,
        summary: {
          ...current,
          avgPerDelivery: current.deliveries ? Math.round(current.earnings / current.deliveries) : 0,
          earningsChange: R.growth(current.earnings, previous.earnings),
          deliveriesChange: R.growth(current.deliveries, previous.deliveries)
        },
        previous,
        series: R.series(facts, bucketKeys(range.from, range.to, period), keyOf).map((row) => ({
          key: row.key,
          deliveries: row.delivered,
          earnings: row.commission,
          sales: row.revenue,
          change: row.commissionChange
        })),
        deliveries: facts.sort(byNewest("deliveredAt")).slice(0, 300).map((f) => ({
          id: f.id,
          code: f.code,
          customer: f.customer,
          total: f.total,
          commission: f.commission,
          method: f.method,
          deliveredAt: f.deliveredAt
        }))
      };
    });
    async function orderLines(orderIds) {
      const lines = [];
      for (let i = 0; i < orderIds.length; i += 500) {
        const query = new Parse.Query("OrderItem");
        query.containedIn(
          "order",
          orderIds.slice(i, i + 500).map((id) => Parse.Object.extend("Order").createWithoutData(id))
        );
        for (const item of await findAll(query))
          lines.push({
            name: item.get("itemNameSnapshot") || "Item",
            qty: Number(item.get("quantity") || 0),
            total: Number(item.get("lineTotal") || 0),
            accompaniments: item.get("accompanimentNames") || []
          });
      }
      return lines;
    }
    Parse.Cloud.define("getOperationsReport", async (request) => {
      await requireRole(request, ["admin"]);
      const p = request.params;
      const { values: config } = await loadConfig();
      const tz = config.timezone;
      const range = rangeOf(p, config, { defaultDays: 30 });
      const period = periodOf(p, range);
      const before = previousRange(range, tz);
      const [facts, previousFacts] = await Promise.all([
        findAll(ordersIn(range, "createdAt", p.riderId)).then((rows) => rows.map(factOf)),
        findAll(ordersIn(before, "createdAt", p.riderId)).then((rows) => rows.map(factOf))
      ]);
      const delivered = facts.filter((f) => f.status === "DELIVERED");
      const lines = await orderLines(delivered.map((f) => f.id));
      const summary = R.summarize(facts);
      const previous = R.summarize(previousFacts);
      const change = {};
      for (const key of [
        "revenue",
        "orders",
        "delivered",
        "avgOrder",
        "commission",
        "net",
        "customers"
      ])
        change[key] = R.growth(summary[key], previous[key]);
      const keyOf = (bucket) => (f) => bucketOf(f.createdAt, tz, bucket);
      return {
        range: rangeInfo(range),
        previousRange: rangeInfo(before),
        period,
        summary,
        previous,
        change,
        series: R.series(facts, bucketKeys(range.from, range.to, period), keyOf(period)),
        monthly: R.series(facts, bucketKeys(range.from, range.to, "month"), keyOf("month")),
        items: R.itemSales(lines),
        accompaniments: R.accompanimentCounts(lines).slice(0, 30),
        riders: R.riderStats(facts),
        payments: R.paymentMix(facts),
        channels: R.channelMix(facts),
        ...R.timeOfDay(facts, (f) => localClock(f.createdAt, tz))
      };
    });
  }
});

// cloud/profile.js
var require_profile = __commonJS({
  "cloud/profile.js"() {
    "use strict";
    var { MASTER, requireUser, getRoleName, loadConfig, countUsers } = require_core();
    var { canBootstrapOwner } = require_admin();
    var { previewEnabled } = require_preview();
    var { merchantAccounts } = require_mobileMoney();
    function publicConfig(values) {
      return {
        restaurantName: values.restaurantName,
        currencySymbol: values.currencySymbol,
        currencyCode: values.currencyCode,
        timezone: values.timezone,
        defaultDeliveryFee: values.defaultDeliveryFee,
        maxRiderFloat: values.maxRiderFloat,
        allowBatching: values.allowBatching,
        commissionRounding: values.commissionRounding,
        requireCashierConfirmForPickup: values.requireCashierConfirmForPickup,
        mobileMoney: merchantAccounts(values)
      };
    }
    Parse.Cloud.define("getAppInfo", async () => {
      const [{ values }, users] = await Promise.all([loadConfig(), countUsers()]);
      return {
        restaurantName: values.restaurantName,
        currencySymbol: values.currencySymbol,
        currencyCode: values.currencyCode,
        timezone: values.timezone,
        ownerSetupOpen: users === 0,
        previewEnabled: previewEnabled()
      };
    });
    Parse.Cloud.define("getMyProfile", async (request) => {
      const user = requireUser(request);
      await user.fetch(MASTER);
      const [role, { values }] = await Promise.all([getRoleName(user), loadConfig()]);
      return {
        id: user.id,
        username: user.getUsername(),
        name: user.get("name") || user.getUsername(),
        phone: user.get("phone") || "",
        role,
        code: user.get("riderCode") || user.get("cashierCode") || "",
        commission: role === "rider" ? {
          type: user.get("commissionType") || "per_order",
          perOrder: user.get("commissionPerOrder") || 0,
          percent: user.get("commissionPercent") || 0
        } : null,
        canInitialize: role === null && await canBootstrapOwner(),
        config: publicConfig(values)
      };
    });
  }
});

// cloud/main.js
require_security();
require_customers();
require_payments();
require_orders();
require_menu();
require_cash();
require_shifts();
require_admin();
require_preview();
require_reports2();
require_profile();
