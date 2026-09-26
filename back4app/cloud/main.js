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
      mtnMerchantName: "",
      // Hour of the day (restaurant time) to remind riders to hand over cash.
      cashReminderHour: 20,
      // Warn riders when their cash reaches this % of maxRiderFloat.
      floatWarningPercent: 80
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
    async function riderFloat(rider) {
      const query = new Parse.Query("Order");
      query.equalTo("createdBy", rider);
      query.equalTo("status", "DELIVERED");
      query.containedIn("cashStatus", ["WITH_RIDER", "HANDOVER_PENDING"]);
      query.limit(1e3);
      const orders = await query.find(MASTER);
      return orders.reduce((sum, order) => sum + (Number(order.get("amountCollected")) || 0), 0);
    }
    async function requireCashierShift(user, role) {
      if (role !== "cashier") return;
      const query = new Parse.Query("Shift");
      query.equalTo("operator", user);
      query.equalTo("kind", "cashier");
      query.equalTo("status", "open");
      if (!await query.first(MASTER))
        throw invalid("Start your shift and count the cash in the till first");
    }
    var personName = (user) => user ? [user.get("riderCode") || user.get("cashierCode"), user.get("name") || user.get("username")].filter(Boolean).join(" \xB7 ") : "";
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
      const value = Number(counter.get("value"));
      if (Number.isInteger(value) && value > 0) return value;
      const stored = Number((await find()).get("value"));
      if (Number.isInteger(stored) && stored > 0) return stored;
      const reset = await find();
      reset.set("value", 1);
      await reset.save(null, MASTER);
      return 1;
    }
    async function uniqueCode(key, format, taken) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const code = format(await nextSequence(key));
        if (!await taken(code)) return code;
      }
      throw new Error(`Could not allocate a unique code for ${key}`);
    }
    var codeTakenIn = (className, field) => async (code) => {
      const query = new Parse.Query(className);
      query.equalTo(field, code);
      try {
        return !!await query.first(MASTER);
      } catch (error) {
        const detail = error?.message && typeof error.message === "object" ? error.message : error;
        if (detail?.code === "42703" || /does not exist/.test(String(detail?.message))) return false;
        throw error;
      }
    };
    async function nextDailyCode(prefix, digits, timezone, { className, field, date } = {}) {
      const day = dateKey(date || /* @__PURE__ */ new Date(), timezone);
      const taken = className ? codeTakenIn(className, field) : async () => false;
      return uniqueCode(
        `${prefix}:${day}`,
        (n) => `${prefix}-${day}-${String(n).padStart(digits, "0")}`,
        taken
      );
    }
    async function nextStaffCode(role) {
      const prefix = role === "rider" ? "R" : "C";
      return uniqueCode(
        `staff:${prefix}`,
        (n) => `${prefix}-${String(n).padStart(3, "0")}`,
        codeTakenIn(Parse.User, role === "rider" ? "riderCode" : "cashierCode")
      );
    }
    async function claimOnce(key) {
      return await nextSequence(key) === 1;
    }
    var PIN_ATTEMPTS = 5;
    var PIN_LOCK_MINUTES = 15;
    async function verifyPin(user, pin) {
      const fresh = await new Parse.Query(Parse.User).get(user.id, MASTER);
      const lockedUntil = fresh.get("pinLockedUntil");
      if (lockedUntil && lockedUntil > /* @__PURE__ */ new Date()) {
        const minutes = Math.ceil((lockedUntil - /* @__PURE__ */ new Date()) / 6e4);
        throw invalid(`Too many wrong PINs. Try again in ${minutes} min`);
      }
      const value = String(pin ?? "");
      if (!value) throw invalid("Enter your PIN to continue");
      try {
        await Parse.User.verifyPassword(fresh.get("username"), value);
      } catch {
        const failures = Number(fresh.get("pinFailures") || 0) + 1;
        const locked = failures >= PIN_ATTEMPTS;
        fresh.set("pinFailures", locked ? 0 : failures);
        if (locked) fresh.set("pinLockedUntil", new Date(Date.now() + PIN_LOCK_MINUTES * 6e4));
        await fresh.save(null, MASTER);
        throw invalid(
          locked ? `Wrong PIN. Locked for ${PIN_LOCK_MINUTES} min` : `Wrong PIN (${PIN_ATTEMPTS - failures} tries left)`
        );
      }
      if (fresh.get("pinFailures")) {
        fresh.set("pinFailures", 0);
        await fresh.save(null, MASTER);
      }
    }
    async function takeOrder(order, actor, role) {
      if (role !== "cashier") return;
      const holder = order.get("cashier");
      if (holder) {
        if (holder.id === actor.id) return;
        throw forbidden(
          `${order.get("cashierName") || "Another cashier"} is handling this order. Ask them to transfer it to you`
        );
      }
      if (!await claimOnce(`order-cashier:${order.id}:${order.get("cashierRound") || 0}`)) {
        const latest = await new Parse.Query("Order").get(order.id, MASTER);
        const name = latest.get("cashierName");
        throw forbidden(
          name ? `${name} just took this order. Ask them to transfer it to you` : "Another cashier is taking this order. Refresh and try again"
        );
      }
      const me = await actor.fetch(MASTER);
      order.set({ cashier: me, cashierName: personName(me), assignedAt: /* @__PURE__ */ new Date() });
    }
    var isBrokenCode = (code) => typeof code === "string" && /object|undefined|NaN/.test(code);
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
      riderFloat,
      personName,
      requireCashierShift,
      isBrokenCode,
      nextStaffCode,
      nextSequence,
      claimOnce,
      verifyPin,
      takeOrder
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
      loadConfig,
      nextStaffCode,
      nextDailyCode,
      isBrokenCode
    } = require_core();
    var PROTECTED_CLASSES = [
      "Order",
      "OrderItem",
      "CashHandover",
      "TillPayout",
      "Shift",
      "AuditLog",
      "Configuration",
      "MenuItem",
      "MenuCategory",
      "Accompaniment",
      "Customer",
      "Counter",
      "DemoOrder",
      "Notification",
      "PushSubscription",
      "Secret"
    ];
    var PRIVATE_CLASSES = ["Counter", "DemoOrder", "Configuration", "PushSubscription", "Secret"];
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
        paymentRejectReason: S,
        disputeResolvedBy: user,
        disputeResolvedAt: D,
        cashier: user,
        cashierName: S,
        assignedAt: D,
        cashierRound: N,
        handoverRound: N,
        commissionBase: N,
        deliveryPay: N,
        commissionPayout: ["Pointer", "TillPayout"]
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
        resolvedAt: D,
        requestId: S,
        reviewRound: N,
        tillAt: D,
        returnedOrders: "Array",
        returnedAmount: N,
        resolution: S,
        shortage: N,
        shortageStatus: S,
        shortagePayout: ["Pointer", "TillPayout"],
        receivedByOwner: B
      },
      TillPayout: {
        payoutCode: S,
        kind: S,
        rider: user,
        amount: N,
        earned: N,
        deductions: N,
        orders: "Array",
        shortages: "Array",
        note: S,
        paidBy: user,
        shift: ["Pointer", "Shift"],
        paidAt: D
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
        variance: N,
        varianceNote: S,
        cashIn: N,
        paidOut: N
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
        mtnMerchantName: S,
        cashReminderHour: N,
        floatWarningPercent: N
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
      },
      PushSubscription: {
        user,
        endpoint: S,
        p256dh: S,
        auth: S,
        userAgent: S,
        lastSeenAt: D
      },
      Secret: { key: S, value: "Object" },
      Notification: {
        recipient: user,
        kind: S,
        tone: S,
        title: S,
        body: S,
        link: S,
        order: ["Pointer", "Order"],
        key: S,
        readAt: D
      }
    };
    var USER_FIELDS = { pinFailures: N, pinLockedUntil: D, payRound: N };
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
      const userFields = Object.keys(existing.get("_User")?.fields || {});
      const missing = Object.entries(USER_FIELDS).filter(([field]) => !userFields.includes(field));
      if (missing.length) {
        const schema = new Parse.Schema("_User");
        for (const [field, type] of missing) schema.addField(field, type);
        await schema.update();
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
      updated.TillPayout = await eachObject(
        "TillPayout",
        (row) => saveAcl(row, readAcl(row.get("rider") || null))
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
        if (codeField && (!user2.get(codeField) || isBrokenCode(user2.get(codeField)))) {
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
      updated.repairedCodes = await repairCodes();
      return updated;
    }
    async function repairCodes() {
      const { values: config } = await loadConfig();
      let repaired = 0;
      for (const [className, field, prefix, digits] of [
        ["Order", "orderCode", "ORD", 4],
        ["CashHandover", "handoverCode", "HO", 3]
      ]) {
        const broken = [];
        await eachObject(className, async (object) => {
          if (isBrokenCode(object.get(field))) broken.push(object);
          return false;
        });
        broken.sort((a, b) => a.createdAt - b.createdAt);
        for (const object of broken) {
          const before = object.get(field);
          object.set(
            field,
            await nextDailyCode(prefix, digits, config.timezone, {
              className,
              field,
              date: object.createdAt
            })
          );
          await object.save(null, MASTER);
          await audit(
            null,
            "code.repaired",
            object,
            { [field]: before },
            { [field]: object.get(field) }
          );
          repaired += 1;
        }
      }
      return repaired;
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

// node_modules/bn.js/lib/bn.js
var require_bn = __commonJS({
  "node_modules/bn.js/lib/bn.js"(exports2, module2) {
    (function(module3, exports3) {
      "use strict";
      function assert(val, msg) {
        if (!val) throw new Error(msg || "Assertion failed");
      }
      function inherits(ctor, superCtor) {
        ctor.super_ = superCtor;
        var TempCtor = function() {
        };
        TempCtor.prototype = superCtor.prototype;
        ctor.prototype = new TempCtor();
        ctor.prototype.constructor = ctor;
      }
      function BN(number, base, endian) {
        if (BN.isBN(number)) {
          return number;
        }
        this.negative = 0;
        this.words = null;
        this.length = 0;
        this.red = null;
        if (number !== null) {
          if (base === "le" || base === "be") {
            endian = base;
            base = 10;
          }
          this._init(number || 0, base || 10, endian || "be");
        }
      }
      if (typeof module3 === "object") {
        module3.exports = BN;
      } else {
        exports3.BN = BN;
      }
      BN.BN = BN;
      BN.wordSize = 26;
      var Buffer2;
      try {
        if (typeof window !== "undefined" && typeof window.Buffer !== "undefined") {
          Buffer2 = window.Buffer;
        } else {
          Buffer2 = require("buffer").Buffer;
        }
      } catch (e) {
      }
      BN.isBN = function isBN(num) {
        if (num instanceof BN) {
          return true;
        }
        return num !== null && typeof num === "object" && num.constructor.wordSize === BN.wordSize && Array.isArray(num.words);
      };
      BN.max = function max(left, right) {
        if (left.cmp(right) > 0) return left;
        return right;
      };
      BN.min = function min(left, right) {
        if (left.cmp(right) < 0) return left;
        return right;
      };
      BN.prototype._init = function init(number, base, endian) {
        if (typeof number === "number") {
          return this._initNumber(number, base, endian);
        }
        if (typeof number === "object") {
          return this._initArray(number, base, endian);
        }
        if (base === "hex") {
          base = 16;
        }
        assert(base === (base | 0) && base >= 2 && base <= 36);
        number = number.toString().replace(/\s+/g, "");
        var start = 0;
        if (number[0] === "-") {
          start++;
          this.negative = 1;
        }
        if (start < number.length) {
          if (base === 16) {
            this._parseHex(number, start, endian);
          } else {
            this._parseBase(number, base, start);
            if (endian === "le") {
              this._initArray(this.toArray(), base, endian);
            }
          }
        }
      };
      BN.prototype._initNumber = function _initNumber(number, base, endian) {
        if (number < 0) {
          this.negative = 1;
          number = -number;
        }
        if (number < 67108864) {
          this.words = [number & 67108863];
          this.length = 1;
        } else if (number < 4503599627370496) {
          this.words = [
            number & 67108863,
            number / 67108864 & 67108863
          ];
          this.length = 2;
        } else {
          assert(number < 9007199254740992);
          this.words = [
            number & 67108863,
            number / 67108864 & 67108863,
            1
          ];
          this.length = 3;
        }
        if (endian !== "le") return;
        this._initArray(this.toArray(), base, endian);
      };
      BN.prototype._initArray = function _initArray(number, base, endian) {
        assert(typeof number.length === "number");
        if (number.length <= 0) {
          this.words = [0];
          this.length = 1;
          return this;
        }
        this.length = Math.ceil(number.length / 3);
        this.words = new Array(this.length);
        for (var i = 0; i < this.length; i++) {
          this.words[i] = 0;
        }
        var j, w;
        var off = 0;
        if (endian === "be") {
          for (i = number.length - 1, j = 0; i >= 0; i -= 3) {
            w = number[i] | number[i - 1] << 8 | number[i - 2] << 16;
            this.words[j] |= w << off & 67108863;
            this.words[j + 1] = w >>> 26 - off & 67108863;
            off += 24;
            if (off >= 26) {
              off -= 26;
              j++;
            }
          }
        } else if (endian === "le") {
          for (i = 0, j = 0; i < number.length; i += 3) {
            w = number[i] | number[i + 1] << 8 | number[i + 2] << 16;
            this.words[j] |= w << off & 67108863;
            this.words[j + 1] = w >>> 26 - off & 67108863;
            off += 24;
            if (off >= 26) {
              off -= 26;
              j++;
            }
          }
        }
        return this.strip();
      };
      function parseHex4Bits(string, index) {
        var c = string.charCodeAt(index);
        if (c >= 65 && c <= 70) {
          return c - 55;
        } else if (c >= 97 && c <= 102) {
          return c - 87;
        } else {
          return c - 48 & 15;
        }
      }
      function parseHexByte(string, lowerBound, index) {
        var r = parseHex4Bits(string, index);
        if (index - 1 >= lowerBound) {
          r |= parseHex4Bits(string, index - 1) << 4;
        }
        return r;
      }
      BN.prototype._parseHex = function _parseHex(number, start, endian) {
        this.length = Math.ceil((number.length - start) / 6);
        this.words = new Array(this.length);
        for (var i = 0; i < this.length; i++) {
          this.words[i] = 0;
        }
        var off = 0;
        var j = 0;
        var w;
        if (endian === "be") {
          for (i = number.length - 1; i >= start; i -= 2) {
            w = parseHexByte(number, start, i) << off;
            this.words[j] |= w & 67108863;
            if (off >= 18) {
              off -= 18;
              j += 1;
              this.words[j] |= w >>> 26;
            } else {
              off += 8;
            }
          }
        } else {
          var parseLength = number.length - start;
          for (i = parseLength % 2 === 0 ? start + 1 : start; i < number.length; i += 2) {
            w = parseHexByte(number, start, i) << off;
            this.words[j] |= w & 67108863;
            if (off >= 18) {
              off -= 18;
              j += 1;
              this.words[j] |= w >>> 26;
            } else {
              off += 8;
            }
          }
        }
        this.strip();
      };
      function parseBase(str, start, end, mul) {
        var r = 0;
        var len = Math.min(str.length, end);
        for (var i = start; i < len; i++) {
          var c = str.charCodeAt(i) - 48;
          r *= mul;
          if (c >= 49) {
            r += c - 49 + 10;
          } else if (c >= 17) {
            r += c - 17 + 10;
          } else {
            r += c;
          }
        }
        return r;
      }
      BN.prototype._parseBase = function _parseBase(number, base, start) {
        this.words = [0];
        this.length = 1;
        for (var limbLen = 0, limbPow = 1; limbPow <= 67108863; limbPow *= base) {
          limbLen++;
        }
        limbLen--;
        limbPow = limbPow / base | 0;
        var total = number.length - start;
        var mod = total % limbLen;
        var end = Math.min(total, total - mod) + start;
        var word = 0;
        for (var i = start; i < end; i += limbLen) {
          word = parseBase(number, i, i + limbLen, base);
          this.imuln(limbPow);
          if (this.words[0] + word < 67108864) {
            this.words[0] += word;
          } else {
            this._iaddn(word);
          }
        }
        if (mod !== 0) {
          var pow = 1;
          word = parseBase(number, i, number.length, base);
          for (i = 0; i < mod; i++) {
            pow *= base;
          }
          this.imuln(pow);
          if (this.words[0] + word < 67108864) {
            this.words[0] += word;
          } else {
            this._iaddn(word);
          }
        }
        this.strip();
      };
      BN.prototype.copy = function copy(dest) {
        dest.words = new Array(this.length);
        for (var i = 0; i < this.length; i++) {
          dest.words[i] = this.words[i];
        }
        dest.length = this.length;
        dest.negative = this.negative;
        dest.red = this.red;
      };
      BN.prototype.clone = function clone() {
        var r = new BN(null);
        this.copy(r);
        return r;
      };
      BN.prototype._expand = function _expand(size) {
        while (this.length < size) {
          this.words[this.length++] = 0;
        }
        return this;
      };
      BN.prototype.strip = function strip() {
        while (this.length > 1 && this.words[this.length - 1] === 0) {
          this.length--;
        }
        return this._normSign();
      };
      BN.prototype._normSign = function _normSign() {
        if (this.length === 1 && this.words[0] === 0) {
          this.negative = 0;
        }
        return this;
      };
      BN.prototype.inspect = function inspect() {
        return (this.red ? "<BN-R: " : "<BN: ") + this.toString(16) + ">";
      };
      var zeros = [
        "",
        "0",
        "00",
        "000",
        "0000",
        "00000",
        "000000",
        "0000000",
        "00000000",
        "000000000",
        "0000000000",
        "00000000000",
        "000000000000",
        "0000000000000",
        "00000000000000",
        "000000000000000",
        "0000000000000000",
        "00000000000000000",
        "000000000000000000",
        "0000000000000000000",
        "00000000000000000000",
        "000000000000000000000",
        "0000000000000000000000",
        "00000000000000000000000",
        "000000000000000000000000",
        "0000000000000000000000000"
      ];
      var groupSizes = [
        0,
        0,
        25,
        16,
        12,
        11,
        10,
        9,
        8,
        8,
        7,
        7,
        7,
        7,
        6,
        6,
        6,
        6,
        6,
        6,
        6,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5
      ];
      var groupBases = [
        0,
        0,
        33554432,
        43046721,
        16777216,
        48828125,
        60466176,
        40353607,
        16777216,
        43046721,
        1e7,
        19487171,
        35831808,
        62748517,
        7529536,
        11390625,
        16777216,
        24137569,
        34012224,
        47045881,
        64e6,
        4084101,
        5153632,
        6436343,
        7962624,
        9765625,
        11881376,
        14348907,
        17210368,
        20511149,
        243e5,
        28629151,
        33554432,
        39135393,
        45435424,
        52521875,
        60466176
      ];
      BN.prototype.toString = function toString(base, padding) {
        base = base || 10;
        padding = padding | 0 || 1;
        var out;
        if (base === 16 || base === "hex") {
          out = "";
          var off = 0;
          var carry = 0;
          for (var i = 0; i < this.length; i++) {
            var w = this.words[i];
            var word = ((w << off | carry) & 16777215).toString(16);
            carry = w >>> 24 - off & 16777215;
            off += 2;
            if (off >= 26) {
              off -= 26;
              i--;
            }
            if (carry !== 0 || i !== this.length - 1) {
              out = zeros[6 - word.length] + word + out;
            } else {
              out = word + out;
            }
          }
          if (carry !== 0) {
            out = carry.toString(16) + out;
          }
          while (out.length % padding !== 0) {
            out = "0" + out;
          }
          if (this.negative !== 0) {
            out = "-" + out;
          }
          return out;
        }
        if (base === (base | 0) && base >= 2 && base <= 36) {
          var groupSize = groupSizes[base];
          var groupBase = groupBases[base];
          out = "";
          var c = this.clone();
          c.negative = 0;
          while (!c.isZero()) {
            var r = c.modn(groupBase).toString(base);
            c = c.idivn(groupBase);
            if (!c.isZero()) {
              out = zeros[groupSize - r.length] + r + out;
            } else {
              out = r + out;
            }
          }
          if (this.isZero()) {
            out = "0" + out;
          }
          while (out.length % padding !== 0) {
            out = "0" + out;
          }
          if (this.negative !== 0) {
            out = "-" + out;
          }
          return out;
        }
        assert(false, "Base should be between 2 and 36");
      };
      BN.prototype.toNumber = function toNumber() {
        var ret = this.words[0];
        if (this.length === 2) {
          ret += this.words[1] * 67108864;
        } else if (this.length === 3 && this.words[2] === 1) {
          ret += 4503599627370496 + this.words[1] * 67108864;
        } else if (this.length > 2) {
          assert(false, "Number can only safely store up to 53 bits");
        }
        return this.negative !== 0 ? -ret : ret;
      };
      BN.prototype.toJSON = function toJSON() {
        return this.toString(16);
      };
      BN.prototype.toBuffer = function toBuffer(endian, length) {
        assert(typeof Buffer2 !== "undefined");
        return this.toArrayLike(Buffer2, endian, length);
      };
      BN.prototype.toArray = function toArray(endian, length) {
        return this.toArrayLike(Array, endian, length);
      };
      BN.prototype.toArrayLike = function toArrayLike(ArrayType, endian, length) {
        var byteLength = this.byteLength();
        var reqLength = length || Math.max(1, byteLength);
        assert(byteLength <= reqLength, "byte array longer than desired length");
        assert(reqLength > 0, "Requested array length <= 0");
        this.strip();
        var littleEndian = endian === "le";
        var res = new ArrayType(reqLength);
        var b, i;
        var q = this.clone();
        if (!littleEndian) {
          for (i = 0; i < reqLength - byteLength; i++) {
            res[i] = 0;
          }
          for (i = 0; !q.isZero(); i++) {
            b = q.andln(255);
            q.iushrn(8);
            res[reqLength - i - 1] = b;
          }
        } else {
          for (i = 0; !q.isZero(); i++) {
            b = q.andln(255);
            q.iushrn(8);
            res[i] = b;
          }
          for (; i < reqLength; i++) {
            res[i] = 0;
          }
        }
        return res;
      };
      if (Math.clz32) {
        BN.prototype._countBits = function _countBits(w) {
          return 32 - Math.clz32(w);
        };
      } else {
        BN.prototype._countBits = function _countBits(w) {
          var t = w;
          var r = 0;
          if (t >= 4096) {
            r += 13;
            t >>>= 13;
          }
          if (t >= 64) {
            r += 7;
            t >>>= 7;
          }
          if (t >= 8) {
            r += 4;
            t >>>= 4;
          }
          if (t >= 2) {
            r += 2;
            t >>>= 2;
          }
          return r + t;
        };
      }
      BN.prototype._zeroBits = function _zeroBits(w) {
        if (w === 0) return 26;
        var t = w;
        var r = 0;
        if ((t & 8191) === 0) {
          r += 13;
          t >>>= 13;
        }
        if ((t & 127) === 0) {
          r += 7;
          t >>>= 7;
        }
        if ((t & 15) === 0) {
          r += 4;
          t >>>= 4;
        }
        if ((t & 3) === 0) {
          r += 2;
          t >>>= 2;
        }
        if ((t & 1) === 0) {
          r++;
        }
        return r;
      };
      BN.prototype.bitLength = function bitLength() {
        var w = this.words[this.length - 1];
        var hi = this._countBits(w);
        return (this.length - 1) * 26 + hi;
      };
      function toBitArray(num) {
        var w = new Array(num.bitLength());
        for (var bit = 0; bit < w.length; bit++) {
          var off = bit / 26 | 0;
          var wbit = bit % 26;
          w[bit] = (num.words[off] & 1 << wbit) >>> wbit;
        }
        return w;
      }
      BN.prototype.zeroBits = function zeroBits() {
        if (this.isZero()) return 0;
        var r = 0;
        for (var i = 0; i < this.length; i++) {
          var b = this._zeroBits(this.words[i]);
          r += b;
          if (b !== 26) break;
        }
        return r;
      };
      BN.prototype.byteLength = function byteLength() {
        return Math.ceil(this.bitLength() / 8);
      };
      BN.prototype.toTwos = function toTwos(width) {
        if (this.negative !== 0) {
          return this.abs().inotn(width).iaddn(1);
        }
        return this.clone();
      };
      BN.prototype.fromTwos = function fromTwos(width) {
        if (this.testn(width - 1)) {
          return this.notn(width).iaddn(1).ineg();
        }
        return this.clone();
      };
      BN.prototype.isNeg = function isNeg() {
        return this.negative !== 0;
      };
      BN.prototype.neg = function neg() {
        return this.clone().ineg();
      };
      BN.prototype.ineg = function ineg() {
        if (!this.isZero()) {
          this.negative ^= 1;
        }
        return this;
      };
      BN.prototype.iuor = function iuor(num) {
        while (this.length < num.length) {
          this.words[this.length++] = 0;
        }
        for (var i = 0; i < num.length; i++) {
          this.words[i] = this.words[i] | num.words[i];
        }
        return this.strip();
      };
      BN.prototype.ior = function ior(num) {
        assert((this.negative | num.negative) === 0);
        return this.iuor(num);
      };
      BN.prototype.or = function or(num) {
        if (this.length > num.length) return this.clone().ior(num);
        return num.clone().ior(this);
      };
      BN.prototype.uor = function uor(num) {
        if (this.length > num.length) return this.clone().iuor(num);
        return num.clone().iuor(this);
      };
      BN.prototype.iuand = function iuand(num) {
        var b;
        if (this.length > num.length) {
          b = num;
        } else {
          b = this;
        }
        for (var i = 0; i < b.length; i++) {
          this.words[i] = this.words[i] & num.words[i];
        }
        this.length = b.length;
        return this.strip();
      };
      BN.prototype.iand = function iand(num) {
        assert((this.negative | num.negative) === 0);
        return this.iuand(num);
      };
      BN.prototype.and = function and(num) {
        if (this.length > num.length) return this.clone().iand(num);
        return num.clone().iand(this);
      };
      BN.prototype.uand = function uand(num) {
        if (this.length > num.length) return this.clone().iuand(num);
        return num.clone().iuand(this);
      };
      BN.prototype.iuxor = function iuxor(num) {
        var a;
        var b;
        if (this.length > num.length) {
          a = this;
          b = num;
        } else {
          a = num;
          b = this;
        }
        for (var i = 0; i < b.length; i++) {
          this.words[i] = a.words[i] ^ b.words[i];
        }
        if (this !== a) {
          for (; i < a.length; i++) {
            this.words[i] = a.words[i];
          }
        }
        this.length = a.length;
        return this.strip();
      };
      BN.prototype.ixor = function ixor(num) {
        assert((this.negative | num.negative) === 0);
        return this.iuxor(num);
      };
      BN.prototype.xor = function xor(num) {
        if (this.length > num.length) return this.clone().ixor(num);
        return num.clone().ixor(this);
      };
      BN.prototype.uxor = function uxor(num) {
        if (this.length > num.length) return this.clone().iuxor(num);
        return num.clone().iuxor(this);
      };
      BN.prototype.inotn = function inotn(width) {
        assert(typeof width === "number" && width >= 0);
        var bytesNeeded = Math.ceil(width / 26) | 0;
        var bitsLeft = width % 26;
        this._expand(bytesNeeded);
        if (bitsLeft > 0) {
          bytesNeeded--;
        }
        for (var i = 0; i < bytesNeeded; i++) {
          this.words[i] = ~this.words[i] & 67108863;
        }
        if (bitsLeft > 0) {
          this.words[i] = ~this.words[i] & 67108863 >> 26 - bitsLeft;
          i++;
        }
        for (; i < this.length; i++) {
          this.words[i] = 0;
        }
        return this.strip();
      };
      BN.prototype.notn = function notn(width) {
        return this.clone().inotn(width);
      };
      BN.prototype.setn = function setn(bit, val) {
        assert(typeof bit === "number" && bit >= 0);
        var off = bit / 26 | 0;
        var wbit = bit % 26;
        this._expand(off + 1);
        if (val) {
          this.words[off] = this.words[off] | 1 << wbit;
        } else {
          this.words[off] = this.words[off] & ~(1 << wbit);
        }
        return this.strip();
      };
      BN.prototype.iadd = function iadd(num) {
        var r;
        if (this.negative !== 0 && num.negative === 0) {
          this.negative = 0;
          r = this.isub(num);
          this.negative ^= 1;
          return this._normSign();
        } else if (this.negative === 0 && num.negative !== 0) {
          num.negative = 0;
          r = this.isub(num);
          num.negative = 1;
          return r._normSign();
        }
        var a, b;
        if (this.length > num.length) {
          a = this;
          b = num;
        } else {
          a = num;
          b = this;
        }
        var carry = 0;
        for (var i = 0; i < b.length; i++) {
          r = (a.words[i] | 0) + (b.words[i] | 0) + carry;
          this.words[i] = r & 67108863;
          carry = r >>> 26;
        }
        for (; carry !== 0 && i < a.length; i++) {
          r = (a.words[i] | 0) + carry;
          this.words[i] = r & 67108863;
          carry = r >>> 26;
        }
        this.length = a.length;
        if (carry !== 0) {
          this.words[this.length] = carry;
          this.length++;
        } else if (a !== this) {
          for (; i < a.length; i++) {
            this.words[i] = a.words[i];
          }
        }
        return this;
      };
      BN.prototype.add = function add(num) {
        var res;
        if (num.negative !== 0 && this.negative === 0) {
          num.negative = 0;
          res = this.sub(num);
          num.negative ^= 1;
          return res;
        } else if (num.negative === 0 && this.negative !== 0) {
          this.negative = 0;
          res = num.sub(this);
          this.negative = 1;
          return res;
        }
        if (this.length > num.length) return this.clone().iadd(num);
        return num.clone().iadd(this);
      };
      BN.prototype.isub = function isub(num) {
        if (num.negative !== 0) {
          num.negative = 0;
          var r = this.iadd(num);
          num.negative = 1;
          return r._normSign();
        } else if (this.negative !== 0) {
          this.negative = 0;
          this.iadd(num);
          this.negative = 1;
          return this._normSign();
        }
        var cmp = this.cmp(num);
        if (cmp === 0) {
          this.negative = 0;
          this.length = 1;
          this.words[0] = 0;
          return this;
        }
        var a, b;
        if (cmp > 0) {
          a = this;
          b = num;
        } else {
          a = num;
          b = this;
        }
        var carry = 0;
        for (var i = 0; i < b.length; i++) {
          r = (a.words[i] | 0) - (b.words[i] | 0) + carry;
          carry = r >> 26;
          this.words[i] = r & 67108863;
        }
        for (; carry !== 0 && i < a.length; i++) {
          r = (a.words[i] | 0) + carry;
          carry = r >> 26;
          this.words[i] = r & 67108863;
        }
        if (carry === 0 && i < a.length && a !== this) {
          for (; i < a.length; i++) {
            this.words[i] = a.words[i];
          }
        }
        this.length = Math.max(this.length, i);
        if (a !== this) {
          this.negative = 1;
        }
        return this.strip();
      };
      BN.prototype.sub = function sub(num) {
        return this.clone().isub(num);
      };
      function smallMulTo(self, num, out) {
        out.negative = num.negative ^ self.negative;
        var len = self.length + num.length | 0;
        out.length = len;
        len = len - 1 | 0;
        var a = self.words[0] | 0;
        var b = num.words[0] | 0;
        var r = a * b;
        var lo = r & 67108863;
        var carry = r / 67108864 | 0;
        out.words[0] = lo;
        for (var k = 1; k < len; k++) {
          var ncarry = carry >>> 26;
          var rword = carry & 67108863;
          var maxJ = Math.min(k, num.length - 1);
          for (var j = Math.max(0, k - self.length + 1); j <= maxJ; j++) {
            var i = k - j | 0;
            a = self.words[i] | 0;
            b = num.words[j] | 0;
            r = a * b + rword;
            ncarry += r / 67108864 | 0;
            rword = r & 67108863;
          }
          out.words[k] = rword | 0;
          carry = ncarry | 0;
        }
        if (carry !== 0) {
          out.words[k] = carry | 0;
        } else {
          out.length--;
        }
        return out.strip();
      }
      var comb10MulTo = function comb10MulTo2(self, num, out) {
        var a = self.words;
        var b = num.words;
        var o = out.words;
        var c = 0;
        var lo;
        var mid;
        var hi;
        var a0 = a[0] | 0;
        var al0 = a0 & 8191;
        var ah0 = a0 >>> 13;
        var a1 = a[1] | 0;
        var al1 = a1 & 8191;
        var ah1 = a1 >>> 13;
        var a2 = a[2] | 0;
        var al2 = a2 & 8191;
        var ah2 = a2 >>> 13;
        var a3 = a[3] | 0;
        var al3 = a3 & 8191;
        var ah3 = a3 >>> 13;
        var a4 = a[4] | 0;
        var al4 = a4 & 8191;
        var ah4 = a4 >>> 13;
        var a5 = a[5] | 0;
        var al5 = a5 & 8191;
        var ah5 = a5 >>> 13;
        var a6 = a[6] | 0;
        var al6 = a6 & 8191;
        var ah6 = a6 >>> 13;
        var a7 = a[7] | 0;
        var al7 = a7 & 8191;
        var ah7 = a7 >>> 13;
        var a8 = a[8] | 0;
        var al8 = a8 & 8191;
        var ah8 = a8 >>> 13;
        var a9 = a[9] | 0;
        var al9 = a9 & 8191;
        var ah9 = a9 >>> 13;
        var b0 = b[0] | 0;
        var bl0 = b0 & 8191;
        var bh0 = b0 >>> 13;
        var b1 = b[1] | 0;
        var bl1 = b1 & 8191;
        var bh1 = b1 >>> 13;
        var b2 = b[2] | 0;
        var bl2 = b2 & 8191;
        var bh2 = b2 >>> 13;
        var b3 = b[3] | 0;
        var bl3 = b3 & 8191;
        var bh3 = b3 >>> 13;
        var b4 = b[4] | 0;
        var bl4 = b4 & 8191;
        var bh4 = b4 >>> 13;
        var b5 = b[5] | 0;
        var bl5 = b5 & 8191;
        var bh5 = b5 >>> 13;
        var b6 = b[6] | 0;
        var bl6 = b6 & 8191;
        var bh6 = b6 >>> 13;
        var b7 = b[7] | 0;
        var bl7 = b7 & 8191;
        var bh7 = b7 >>> 13;
        var b8 = b[8] | 0;
        var bl8 = b8 & 8191;
        var bh8 = b8 >>> 13;
        var b9 = b[9] | 0;
        var bl9 = b9 & 8191;
        var bh9 = b9 >>> 13;
        out.negative = self.negative ^ num.negative;
        out.length = 19;
        lo = Math.imul(al0, bl0);
        mid = Math.imul(al0, bh0);
        mid = mid + Math.imul(ah0, bl0) | 0;
        hi = Math.imul(ah0, bh0);
        var w0 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w0 >>> 26) | 0;
        w0 &= 67108863;
        lo = Math.imul(al1, bl0);
        mid = Math.imul(al1, bh0);
        mid = mid + Math.imul(ah1, bl0) | 0;
        hi = Math.imul(ah1, bh0);
        lo = lo + Math.imul(al0, bl1) | 0;
        mid = mid + Math.imul(al0, bh1) | 0;
        mid = mid + Math.imul(ah0, bl1) | 0;
        hi = hi + Math.imul(ah0, bh1) | 0;
        var w1 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w1 >>> 26) | 0;
        w1 &= 67108863;
        lo = Math.imul(al2, bl0);
        mid = Math.imul(al2, bh0);
        mid = mid + Math.imul(ah2, bl0) | 0;
        hi = Math.imul(ah2, bh0);
        lo = lo + Math.imul(al1, bl1) | 0;
        mid = mid + Math.imul(al1, bh1) | 0;
        mid = mid + Math.imul(ah1, bl1) | 0;
        hi = hi + Math.imul(ah1, bh1) | 0;
        lo = lo + Math.imul(al0, bl2) | 0;
        mid = mid + Math.imul(al0, bh2) | 0;
        mid = mid + Math.imul(ah0, bl2) | 0;
        hi = hi + Math.imul(ah0, bh2) | 0;
        var w2 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w2 >>> 26) | 0;
        w2 &= 67108863;
        lo = Math.imul(al3, bl0);
        mid = Math.imul(al3, bh0);
        mid = mid + Math.imul(ah3, bl0) | 0;
        hi = Math.imul(ah3, bh0);
        lo = lo + Math.imul(al2, bl1) | 0;
        mid = mid + Math.imul(al2, bh1) | 0;
        mid = mid + Math.imul(ah2, bl1) | 0;
        hi = hi + Math.imul(ah2, bh1) | 0;
        lo = lo + Math.imul(al1, bl2) | 0;
        mid = mid + Math.imul(al1, bh2) | 0;
        mid = mid + Math.imul(ah1, bl2) | 0;
        hi = hi + Math.imul(ah1, bh2) | 0;
        lo = lo + Math.imul(al0, bl3) | 0;
        mid = mid + Math.imul(al0, bh3) | 0;
        mid = mid + Math.imul(ah0, bl3) | 0;
        hi = hi + Math.imul(ah0, bh3) | 0;
        var w3 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w3 >>> 26) | 0;
        w3 &= 67108863;
        lo = Math.imul(al4, bl0);
        mid = Math.imul(al4, bh0);
        mid = mid + Math.imul(ah4, bl0) | 0;
        hi = Math.imul(ah4, bh0);
        lo = lo + Math.imul(al3, bl1) | 0;
        mid = mid + Math.imul(al3, bh1) | 0;
        mid = mid + Math.imul(ah3, bl1) | 0;
        hi = hi + Math.imul(ah3, bh1) | 0;
        lo = lo + Math.imul(al2, bl2) | 0;
        mid = mid + Math.imul(al2, bh2) | 0;
        mid = mid + Math.imul(ah2, bl2) | 0;
        hi = hi + Math.imul(ah2, bh2) | 0;
        lo = lo + Math.imul(al1, bl3) | 0;
        mid = mid + Math.imul(al1, bh3) | 0;
        mid = mid + Math.imul(ah1, bl3) | 0;
        hi = hi + Math.imul(ah1, bh3) | 0;
        lo = lo + Math.imul(al0, bl4) | 0;
        mid = mid + Math.imul(al0, bh4) | 0;
        mid = mid + Math.imul(ah0, bl4) | 0;
        hi = hi + Math.imul(ah0, bh4) | 0;
        var w4 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w4 >>> 26) | 0;
        w4 &= 67108863;
        lo = Math.imul(al5, bl0);
        mid = Math.imul(al5, bh0);
        mid = mid + Math.imul(ah5, bl0) | 0;
        hi = Math.imul(ah5, bh0);
        lo = lo + Math.imul(al4, bl1) | 0;
        mid = mid + Math.imul(al4, bh1) | 0;
        mid = mid + Math.imul(ah4, bl1) | 0;
        hi = hi + Math.imul(ah4, bh1) | 0;
        lo = lo + Math.imul(al3, bl2) | 0;
        mid = mid + Math.imul(al3, bh2) | 0;
        mid = mid + Math.imul(ah3, bl2) | 0;
        hi = hi + Math.imul(ah3, bh2) | 0;
        lo = lo + Math.imul(al2, bl3) | 0;
        mid = mid + Math.imul(al2, bh3) | 0;
        mid = mid + Math.imul(ah2, bl3) | 0;
        hi = hi + Math.imul(ah2, bh3) | 0;
        lo = lo + Math.imul(al1, bl4) | 0;
        mid = mid + Math.imul(al1, bh4) | 0;
        mid = mid + Math.imul(ah1, bl4) | 0;
        hi = hi + Math.imul(ah1, bh4) | 0;
        lo = lo + Math.imul(al0, bl5) | 0;
        mid = mid + Math.imul(al0, bh5) | 0;
        mid = mid + Math.imul(ah0, bl5) | 0;
        hi = hi + Math.imul(ah0, bh5) | 0;
        var w5 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w5 >>> 26) | 0;
        w5 &= 67108863;
        lo = Math.imul(al6, bl0);
        mid = Math.imul(al6, bh0);
        mid = mid + Math.imul(ah6, bl0) | 0;
        hi = Math.imul(ah6, bh0);
        lo = lo + Math.imul(al5, bl1) | 0;
        mid = mid + Math.imul(al5, bh1) | 0;
        mid = mid + Math.imul(ah5, bl1) | 0;
        hi = hi + Math.imul(ah5, bh1) | 0;
        lo = lo + Math.imul(al4, bl2) | 0;
        mid = mid + Math.imul(al4, bh2) | 0;
        mid = mid + Math.imul(ah4, bl2) | 0;
        hi = hi + Math.imul(ah4, bh2) | 0;
        lo = lo + Math.imul(al3, bl3) | 0;
        mid = mid + Math.imul(al3, bh3) | 0;
        mid = mid + Math.imul(ah3, bl3) | 0;
        hi = hi + Math.imul(ah3, bh3) | 0;
        lo = lo + Math.imul(al2, bl4) | 0;
        mid = mid + Math.imul(al2, bh4) | 0;
        mid = mid + Math.imul(ah2, bl4) | 0;
        hi = hi + Math.imul(ah2, bh4) | 0;
        lo = lo + Math.imul(al1, bl5) | 0;
        mid = mid + Math.imul(al1, bh5) | 0;
        mid = mid + Math.imul(ah1, bl5) | 0;
        hi = hi + Math.imul(ah1, bh5) | 0;
        lo = lo + Math.imul(al0, bl6) | 0;
        mid = mid + Math.imul(al0, bh6) | 0;
        mid = mid + Math.imul(ah0, bl6) | 0;
        hi = hi + Math.imul(ah0, bh6) | 0;
        var w6 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w6 >>> 26) | 0;
        w6 &= 67108863;
        lo = Math.imul(al7, bl0);
        mid = Math.imul(al7, bh0);
        mid = mid + Math.imul(ah7, bl0) | 0;
        hi = Math.imul(ah7, bh0);
        lo = lo + Math.imul(al6, bl1) | 0;
        mid = mid + Math.imul(al6, bh1) | 0;
        mid = mid + Math.imul(ah6, bl1) | 0;
        hi = hi + Math.imul(ah6, bh1) | 0;
        lo = lo + Math.imul(al5, bl2) | 0;
        mid = mid + Math.imul(al5, bh2) | 0;
        mid = mid + Math.imul(ah5, bl2) | 0;
        hi = hi + Math.imul(ah5, bh2) | 0;
        lo = lo + Math.imul(al4, bl3) | 0;
        mid = mid + Math.imul(al4, bh3) | 0;
        mid = mid + Math.imul(ah4, bl3) | 0;
        hi = hi + Math.imul(ah4, bh3) | 0;
        lo = lo + Math.imul(al3, bl4) | 0;
        mid = mid + Math.imul(al3, bh4) | 0;
        mid = mid + Math.imul(ah3, bl4) | 0;
        hi = hi + Math.imul(ah3, bh4) | 0;
        lo = lo + Math.imul(al2, bl5) | 0;
        mid = mid + Math.imul(al2, bh5) | 0;
        mid = mid + Math.imul(ah2, bl5) | 0;
        hi = hi + Math.imul(ah2, bh5) | 0;
        lo = lo + Math.imul(al1, bl6) | 0;
        mid = mid + Math.imul(al1, bh6) | 0;
        mid = mid + Math.imul(ah1, bl6) | 0;
        hi = hi + Math.imul(ah1, bh6) | 0;
        lo = lo + Math.imul(al0, bl7) | 0;
        mid = mid + Math.imul(al0, bh7) | 0;
        mid = mid + Math.imul(ah0, bl7) | 0;
        hi = hi + Math.imul(ah0, bh7) | 0;
        var w7 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w7 >>> 26) | 0;
        w7 &= 67108863;
        lo = Math.imul(al8, bl0);
        mid = Math.imul(al8, bh0);
        mid = mid + Math.imul(ah8, bl0) | 0;
        hi = Math.imul(ah8, bh0);
        lo = lo + Math.imul(al7, bl1) | 0;
        mid = mid + Math.imul(al7, bh1) | 0;
        mid = mid + Math.imul(ah7, bl1) | 0;
        hi = hi + Math.imul(ah7, bh1) | 0;
        lo = lo + Math.imul(al6, bl2) | 0;
        mid = mid + Math.imul(al6, bh2) | 0;
        mid = mid + Math.imul(ah6, bl2) | 0;
        hi = hi + Math.imul(ah6, bh2) | 0;
        lo = lo + Math.imul(al5, bl3) | 0;
        mid = mid + Math.imul(al5, bh3) | 0;
        mid = mid + Math.imul(ah5, bl3) | 0;
        hi = hi + Math.imul(ah5, bh3) | 0;
        lo = lo + Math.imul(al4, bl4) | 0;
        mid = mid + Math.imul(al4, bh4) | 0;
        mid = mid + Math.imul(ah4, bl4) | 0;
        hi = hi + Math.imul(ah4, bh4) | 0;
        lo = lo + Math.imul(al3, bl5) | 0;
        mid = mid + Math.imul(al3, bh5) | 0;
        mid = mid + Math.imul(ah3, bl5) | 0;
        hi = hi + Math.imul(ah3, bh5) | 0;
        lo = lo + Math.imul(al2, bl6) | 0;
        mid = mid + Math.imul(al2, bh6) | 0;
        mid = mid + Math.imul(ah2, bl6) | 0;
        hi = hi + Math.imul(ah2, bh6) | 0;
        lo = lo + Math.imul(al1, bl7) | 0;
        mid = mid + Math.imul(al1, bh7) | 0;
        mid = mid + Math.imul(ah1, bl7) | 0;
        hi = hi + Math.imul(ah1, bh7) | 0;
        lo = lo + Math.imul(al0, bl8) | 0;
        mid = mid + Math.imul(al0, bh8) | 0;
        mid = mid + Math.imul(ah0, bl8) | 0;
        hi = hi + Math.imul(ah0, bh8) | 0;
        var w8 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w8 >>> 26) | 0;
        w8 &= 67108863;
        lo = Math.imul(al9, bl0);
        mid = Math.imul(al9, bh0);
        mid = mid + Math.imul(ah9, bl0) | 0;
        hi = Math.imul(ah9, bh0);
        lo = lo + Math.imul(al8, bl1) | 0;
        mid = mid + Math.imul(al8, bh1) | 0;
        mid = mid + Math.imul(ah8, bl1) | 0;
        hi = hi + Math.imul(ah8, bh1) | 0;
        lo = lo + Math.imul(al7, bl2) | 0;
        mid = mid + Math.imul(al7, bh2) | 0;
        mid = mid + Math.imul(ah7, bl2) | 0;
        hi = hi + Math.imul(ah7, bh2) | 0;
        lo = lo + Math.imul(al6, bl3) | 0;
        mid = mid + Math.imul(al6, bh3) | 0;
        mid = mid + Math.imul(ah6, bl3) | 0;
        hi = hi + Math.imul(ah6, bh3) | 0;
        lo = lo + Math.imul(al5, bl4) | 0;
        mid = mid + Math.imul(al5, bh4) | 0;
        mid = mid + Math.imul(ah5, bl4) | 0;
        hi = hi + Math.imul(ah5, bh4) | 0;
        lo = lo + Math.imul(al4, bl5) | 0;
        mid = mid + Math.imul(al4, bh5) | 0;
        mid = mid + Math.imul(ah4, bl5) | 0;
        hi = hi + Math.imul(ah4, bh5) | 0;
        lo = lo + Math.imul(al3, bl6) | 0;
        mid = mid + Math.imul(al3, bh6) | 0;
        mid = mid + Math.imul(ah3, bl6) | 0;
        hi = hi + Math.imul(ah3, bh6) | 0;
        lo = lo + Math.imul(al2, bl7) | 0;
        mid = mid + Math.imul(al2, bh7) | 0;
        mid = mid + Math.imul(ah2, bl7) | 0;
        hi = hi + Math.imul(ah2, bh7) | 0;
        lo = lo + Math.imul(al1, bl8) | 0;
        mid = mid + Math.imul(al1, bh8) | 0;
        mid = mid + Math.imul(ah1, bl8) | 0;
        hi = hi + Math.imul(ah1, bh8) | 0;
        lo = lo + Math.imul(al0, bl9) | 0;
        mid = mid + Math.imul(al0, bh9) | 0;
        mid = mid + Math.imul(ah0, bl9) | 0;
        hi = hi + Math.imul(ah0, bh9) | 0;
        var w9 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w9 >>> 26) | 0;
        w9 &= 67108863;
        lo = Math.imul(al9, bl1);
        mid = Math.imul(al9, bh1);
        mid = mid + Math.imul(ah9, bl1) | 0;
        hi = Math.imul(ah9, bh1);
        lo = lo + Math.imul(al8, bl2) | 0;
        mid = mid + Math.imul(al8, bh2) | 0;
        mid = mid + Math.imul(ah8, bl2) | 0;
        hi = hi + Math.imul(ah8, bh2) | 0;
        lo = lo + Math.imul(al7, bl3) | 0;
        mid = mid + Math.imul(al7, bh3) | 0;
        mid = mid + Math.imul(ah7, bl3) | 0;
        hi = hi + Math.imul(ah7, bh3) | 0;
        lo = lo + Math.imul(al6, bl4) | 0;
        mid = mid + Math.imul(al6, bh4) | 0;
        mid = mid + Math.imul(ah6, bl4) | 0;
        hi = hi + Math.imul(ah6, bh4) | 0;
        lo = lo + Math.imul(al5, bl5) | 0;
        mid = mid + Math.imul(al5, bh5) | 0;
        mid = mid + Math.imul(ah5, bl5) | 0;
        hi = hi + Math.imul(ah5, bh5) | 0;
        lo = lo + Math.imul(al4, bl6) | 0;
        mid = mid + Math.imul(al4, bh6) | 0;
        mid = mid + Math.imul(ah4, bl6) | 0;
        hi = hi + Math.imul(ah4, bh6) | 0;
        lo = lo + Math.imul(al3, bl7) | 0;
        mid = mid + Math.imul(al3, bh7) | 0;
        mid = mid + Math.imul(ah3, bl7) | 0;
        hi = hi + Math.imul(ah3, bh7) | 0;
        lo = lo + Math.imul(al2, bl8) | 0;
        mid = mid + Math.imul(al2, bh8) | 0;
        mid = mid + Math.imul(ah2, bl8) | 0;
        hi = hi + Math.imul(ah2, bh8) | 0;
        lo = lo + Math.imul(al1, bl9) | 0;
        mid = mid + Math.imul(al1, bh9) | 0;
        mid = mid + Math.imul(ah1, bl9) | 0;
        hi = hi + Math.imul(ah1, bh9) | 0;
        var w10 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w10 >>> 26) | 0;
        w10 &= 67108863;
        lo = Math.imul(al9, bl2);
        mid = Math.imul(al9, bh2);
        mid = mid + Math.imul(ah9, bl2) | 0;
        hi = Math.imul(ah9, bh2);
        lo = lo + Math.imul(al8, bl3) | 0;
        mid = mid + Math.imul(al8, bh3) | 0;
        mid = mid + Math.imul(ah8, bl3) | 0;
        hi = hi + Math.imul(ah8, bh3) | 0;
        lo = lo + Math.imul(al7, bl4) | 0;
        mid = mid + Math.imul(al7, bh4) | 0;
        mid = mid + Math.imul(ah7, bl4) | 0;
        hi = hi + Math.imul(ah7, bh4) | 0;
        lo = lo + Math.imul(al6, bl5) | 0;
        mid = mid + Math.imul(al6, bh5) | 0;
        mid = mid + Math.imul(ah6, bl5) | 0;
        hi = hi + Math.imul(ah6, bh5) | 0;
        lo = lo + Math.imul(al5, bl6) | 0;
        mid = mid + Math.imul(al5, bh6) | 0;
        mid = mid + Math.imul(ah5, bl6) | 0;
        hi = hi + Math.imul(ah5, bh6) | 0;
        lo = lo + Math.imul(al4, bl7) | 0;
        mid = mid + Math.imul(al4, bh7) | 0;
        mid = mid + Math.imul(ah4, bl7) | 0;
        hi = hi + Math.imul(ah4, bh7) | 0;
        lo = lo + Math.imul(al3, bl8) | 0;
        mid = mid + Math.imul(al3, bh8) | 0;
        mid = mid + Math.imul(ah3, bl8) | 0;
        hi = hi + Math.imul(ah3, bh8) | 0;
        lo = lo + Math.imul(al2, bl9) | 0;
        mid = mid + Math.imul(al2, bh9) | 0;
        mid = mid + Math.imul(ah2, bl9) | 0;
        hi = hi + Math.imul(ah2, bh9) | 0;
        var w11 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w11 >>> 26) | 0;
        w11 &= 67108863;
        lo = Math.imul(al9, bl3);
        mid = Math.imul(al9, bh3);
        mid = mid + Math.imul(ah9, bl3) | 0;
        hi = Math.imul(ah9, bh3);
        lo = lo + Math.imul(al8, bl4) | 0;
        mid = mid + Math.imul(al8, bh4) | 0;
        mid = mid + Math.imul(ah8, bl4) | 0;
        hi = hi + Math.imul(ah8, bh4) | 0;
        lo = lo + Math.imul(al7, bl5) | 0;
        mid = mid + Math.imul(al7, bh5) | 0;
        mid = mid + Math.imul(ah7, bl5) | 0;
        hi = hi + Math.imul(ah7, bh5) | 0;
        lo = lo + Math.imul(al6, bl6) | 0;
        mid = mid + Math.imul(al6, bh6) | 0;
        mid = mid + Math.imul(ah6, bl6) | 0;
        hi = hi + Math.imul(ah6, bh6) | 0;
        lo = lo + Math.imul(al5, bl7) | 0;
        mid = mid + Math.imul(al5, bh7) | 0;
        mid = mid + Math.imul(ah5, bl7) | 0;
        hi = hi + Math.imul(ah5, bh7) | 0;
        lo = lo + Math.imul(al4, bl8) | 0;
        mid = mid + Math.imul(al4, bh8) | 0;
        mid = mid + Math.imul(ah4, bl8) | 0;
        hi = hi + Math.imul(ah4, bh8) | 0;
        lo = lo + Math.imul(al3, bl9) | 0;
        mid = mid + Math.imul(al3, bh9) | 0;
        mid = mid + Math.imul(ah3, bl9) | 0;
        hi = hi + Math.imul(ah3, bh9) | 0;
        var w12 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w12 >>> 26) | 0;
        w12 &= 67108863;
        lo = Math.imul(al9, bl4);
        mid = Math.imul(al9, bh4);
        mid = mid + Math.imul(ah9, bl4) | 0;
        hi = Math.imul(ah9, bh4);
        lo = lo + Math.imul(al8, bl5) | 0;
        mid = mid + Math.imul(al8, bh5) | 0;
        mid = mid + Math.imul(ah8, bl5) | 0;
        hi = hi + Math.imul(ah8, bh5) | 0;
        lo = lo + Math.imul(al7, bl6) | 0;
        mid = mid + Math.imul(al7, bh6) | 0;
        mid = mid + Math.imul(ah7, bl6) | 0;
        hi = hi + Math.imul(ah7, bh6) | 0;
        lo = lo + Math.imul(al6, bl7) | 0;
        mid = mid + Math.imul(al6, bh7) | 0;
        mid = mid + Math.imul(ah6, bl7) | 0;
        hi = hi + Math.imul(ah6, bh7) | 0;
        lo = lo + Math.imul(al5, bl8) | 0;
        mid = mid + Math.imul(al5, bh8) | 0;
        mid = mid + Math.imul(ah5, bl8) | 0;
        hi = hi + Math.imul(ah5, bh8) | 0;
        lo = lo + Math.imul(al4, bl9) | 0;
        mid = mid + Math.imul(al4, bh9) | 0;
        mid = mid + Math.imul(ah4, bl9) | 0;
        hi = hi + Math.imul(ah4, bh9) | 0;
        var w13 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w13 >>> 26) | 0;
        w13 &= 67108863;
        lo = Math.imul(al9, bl5);
        mid = Math.imul(al9, bh5);
        mid = mid + Math.imul(ah9, bl5) | 0;
        hi = Math.imul(ah9, bh5);
        lo = lo + Math.imul(al8, bl6) | 0;
        mid = mid + Math.imul(al8, bh6) | 0;
        mid = mid + Math.imul(ah8, bl6) | 0;
        hi = hi + Math.imul(ah8, bh6) | 0;
        lo = lo + Math.imul(al7, bl7) | 0;
        mid = mid + Math.imul(al7, bh7) | 0;
        mid = mid + Math.imul(ah7, bl7) | 0;
        hi = hi + Math.imul(ah7, bh7) | 0;
        lo = lo + Math.imul(al6, bl8) | 0;
        mid = mid + Math.imul(al6, bh8) | 0;
        mid = mid + Math.imul(ah6, bl8) | 0;
        hi = hi + Math.imul(ah6, bh8) | 0;
        lo = lo + Math.imul(al5, bl9) | 0;
        mid = mid + Math.imul(al5, bh9) | 0;
        mid = mid + Math.imul(ah5, bl9) | 0;
        hi = hi + Math.imul(ah5, bh9) | 0;
        var w14 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w14 >>> 26) | 0;
        w14 &= 67108863;
        lo = Math.imul(al9, bl6);
        mid = Math.imul(al9, bh6);
        mid = mid + Math.imul(ah9, bl6) | 0;
        hi = Math.imul(ah9, bh6);
        lo = lo + Math.imul(al8, bl7) | 0;
        mid = mid + Math.imul(al8, bh7) | 0;
        mid = mid + Math.imul(ah8, bl7) | 0;
        hi = hi + Math.imul(ah8, bh7) | 0;
        lo = lo + Math.imul(al7, bl8) | 0;
        mid = mid + Math.imul(al7, bh8) | 0;
        mid = mid + Math.imul(ah7, bl8) | 0;
        hi = hi + Math.imul(ah7, bh8) | 0;
        lo = lo + Math.imul(al6, bl9) | 0;
        mid = mid + Math.imul(al6, bh9) | 0;
        mid = mid + Math.imul(ah6, bl9) | 0;
        hi = hi + Math.imul(ah6, bh9) | 0;
        var w15 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w15 >>> 26) | 0;
        w15 &= 67108863;
        lo = Math.imul(al9, bl7);
        mid = Math.imul(al9, bh7);
        mid = mid + Math.imul(ah9, bl7) | 0;
        hi = Math.imul(ah9, bh7);
        lo = lo + Math.imul(al8, bl8) | 0;
        mid = mid + Math.imul(al8, bh8) | 0;
        mid = mid + Math.imul(ah8, bl8) | 0;
        hi = hi + Math.imul(ah8, bh8) | 0;
        lo = lo + Math.imul(al7, bl9) | 0;
        mid = mid + Math.imul(al7, bh9) | 0;
        mid = mid + Math.imul(ah7, bl9) | 0;
        hi = hi + Math.imul(ah7, bh9) | 0;
        var w16 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w16 >>> 26) | 0;
        w16 &= 67108863;
        lo = Math.imul(al9, bl8);
        mid = Math.imul(al9, bh8);
        mid = mid + Math.imul(ah9, bl8) | 0;
        hi = Math.imul(ah9, bh8);
        lo = lo + Math.imul(al8, bl9) | 0;
        mid = mid + Math.imul(al8, bh9) | 0;
        mid = mid + Math.imul(ah8, bl9) | 0;
        hi = hi + Math.imul(ah8, bh9) | 0;
        var w17 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w17 >>> 26) | 0;
        w17 &= 67108863;
        lo = Math.imul(al9, bl9);
        mid = Math.imul(al9, bh9);
        mid = mid + Math.imul(ah9, bl9) | 0;
        hi = Math.imul(ah9, bh9);
        var w18 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w18 >>> 26) | 0;
        w18 &= 67108863;
        o[0] = w0;
        o[1] = w1;
        o[2] = w2;
        o[3] = w3;
        o[4] = w4;
        o[5] = w5;
        o[6] = w6;
        o[7] = w7;
        o[8] = w8;
        o[9] = w9;
        o[10] = w10;
        o[11] = w11;
        o[12] = w12;
        o[13] = w13;
        o[14] = w14;
        o[15] = w15;
        o[16] = w16;
        o[17] = w17;
        o[18] = w18;
        if (c !== 0) {
          o[19] = c;
          out.length++;
        }
        return out;
      };
      if (!Math.imul) {
        comb10MulTo = smallMulTo;
      }
      function bigMulTo(self, num, out) {
        out.negative = num.negative ^ self.negative;
        out.length = self.length + num.length;
        var carry = 0;
        var hncarry = 0;
        for (var k = 0; k < out.length - 1; k++) {
          var ncarry = hncarry;
          hncarry = 0;
          var rword = carry & 67108863;
          var maxJ = Math.min(k, num.length - 1);
          for (var j = Math.max(0, k - self.length + 1); j <= maxJ; j++) {
            var i = k - j;
            var a = self.words[i] | 0;
            var b = num.words[j] | 0;
            var r = a * b;
            var lo = r & 67108863;
            ncarry = ncarry + (r / 67108864 | 0) | 0;
            lo = lo + rword | 0;
            rword = lo & 67108863;
            ncarry = ncarry + (lo >>> 26) | 0;
            hncarry += ncarry >>> 26;
            ncarry &= 67108863;
          }
          out.words[k] = rword;
          carry = ncarry;
          ncarry = hncarry;
        }
        if (carry !== 0) {
          out.words[k] = carry;
        } else {
          out.length--;
        }
        return out.strip();
      }
      function jumboMulTo(self, num, out) {
        var fftm = new FFTM();
        return fftm.mulp(self, num, out);
      }
      BN.prototype.mulTo = function mulTo(num, out) {
        var res;
        var len = this.length + num.length;
        if (this.length === 10 && num.length === 10) {
          res = comb10MulTo(this, num, out);
        } else if (len < 63) {
          res = smallMulTo(this, num, out);
        } else if (len < 1024) {
          res = bigMulTo(this, num, out);
        } else {
          res = jumboMulTo(this, num, out);
        }
        return res;
      };
      function FFTM(x, y) {
        this.x = x;
        this.y = y;
      }
      FFTM.prototype.makeRBT = function makeRBT(N) {
        var t = new Array(N);
        var l = BN.prototype._countBits(N) - 1;
        for (var i = 0; i < N; i++) {
          t[i] = this.revBin(i, l, N);
        }
        return t;
      };
      FFTM.prototype.revBin = function revBin(x, l, N) {
        if (x === 0 || x === N - 1) return x;
        var rb = 0;
        for (var i = 0; i < l; i++) {
          rb |= (x & 1) << l - i - 1;
          x >>= 1;
        }
        return rb;
      };
      FFTM.prototype.permute = function permute(rbt, rws, iws, rtws, itws, N) {
        for (var i = 0; i < N; i++) {
          rtws[i] = rws[rbt[i]];
          itws[i] = iws[rbt[i]];
        }
      };
      FFTM.prototype.transform = function transform(rws, iws, rtws, itws, N, rbt) {
        this.permute(rbt, rws, iws, rtws, itws, N);
        for (var s = 1; s < N; s <<= 1) {
          var l = s << 1;
          var rtwdf = Math.cos(2 * Math.PI / l);
          var itwdf = Math.sin(2 * Math.PI / l);
          for (var p = 0; p < N; p += l) {
            var rtwdf_ = rtwdf;
            var itwdf_ = itwdf;
            for (var j = 0; j < s; j++) {
              var re = rtws[p + j];
              var ie = itws[p + j];
              var ro = rtws[p + j + s];
              var io = itws[p + j + s];
              var rx = rtwdf_ * ro - itwdf_ * io;
              io = rtwdf_ * io + itwdf_ * ro;
              ro = rx;
              rtws[p + j] = re + ro;
              itws[p + j] = ie + io;
              rtws[p + j + s] = re - ro;
              itws[p + j + s] = ie - io;
              if (j !== l) {
                rx = rtwdf * rtwdf_ - itwdf * itwdf_;
                itwdf_ = rtwdf * itwdf_ + itwdf * rtwdf_;
                rtwdf_ = rx;
              }
            }
          }
        }
      };
      FFTM.prototype.guessLen13b = function guessLen13b(n, m) {
        var N = Math.max(m, n) | 1;
        var odd = N & 1;
        var i = 0;
        for (N = N / 2 | 0; N; N = N >>> 1) {
          i++;
        }
        return 1 << i + 1 + odd;
      };
      FFTM.prototype.conjugate = function conjugate(rws, iws, N) {
        if (N <= 1) return;
        for (var i = 0; i < N / 2; i++) {
          var t = rws[i];
          rws[i] = rws[N - i - 1];
          rws[N - i - 1] = t;
          t = iws[i];
          iws[i] = -iws[N - i - 1];
          iws[N - i - 1] = -t;
        }
      };
      FFTM.prototype.normalize13b = function normalize13b(ws, N) {
        var carry = 0;
        for (var i = 0; i < N / 2; i++) {
          var w = Math.round(ws[2 * i + 1] / N) * 8192 + Math.round(ws[2 * i] / N) + carry;
          ws[i] = w & 67108863;
          if (w < 67108864) {
            carry = 0;
          } else {
            carry = w / 67108864 | 0;
          }
        }
        return ws;
      };
      FFTM.prototype.convert13b = function convert13b(ws, len, rws, N) {
        var carry = 0;
        for (var i = 0; i < len; i++) {
          carry = carry + (ws[i] | 0);
          rws[2 * i] = carry & 8191;
          carry = carry >>> 13;
          rws[2 * i + 1] = carry & 8191;
          carry = carry >>> 13;
        }
        for (i = 2 * len; i < N; ++i) {
          rws[i] = 0;
        }
        assert(carry === 0);
        assert((carry & ~8191) === 0);
      };
      FFTM.prototype.stub = function stub(N) {
        var ph = new Array(N);
        for (var i = 0; i < N; i++) {
          ph[i] = 0;
        }
        return ph;
      };
      FFTM.prototype.mulp = function mulp(x, y, out) {
        var N = 2 * this.guessLen13b(x.length, y.length);
        var rbt = this.makeRBT(N);
        var _ = this.stub(N);
        var rws = new Array(N);
        var rwst = new Array(N);
        var iwst = new Array(N);
        var nrws = new Array(N);
        var nrwst = new Array(N);
        var niwst = new Array(N);
        var rmws = out.words;
        rmws.length = N;
        this.convert13b(x.words, x.length, rws, N);
        this.convert13b(y.words, y.length, nrws, N);
        this.transform(rws, _, rwst, iwst, N, rbt);
        this.transform(nrws, _, nrwst, niwst, N, rbt);
        for (var i = 0; i < N; i++) {
          var rx = rwst[i] * nrwst[i] - iwst[i] * niwst[i];
          iwst[i] = rwst[i] * niwst[i] + iwst[i] * nrwst[i];
          rwst[i] = rx;
        }
        this.conjugate(rwst, iwst, N);
        this.transform(rwst, iwst, rmws, _, N, rbt);
        this.conjugate(rmws, _, N);
        this.normalize13b(rmws, N);
        out.negative = x.negative ^ y.negative;
        out.length = x.length + y.length;
        return out.strip();
      };
      BN.prototype.mul = function mul(num) {
        var out = new BN(null);
        out.words = new Array(this.length + num.length);
        return this.mulTo(num, out);
      };
      BN.prototype.mulf = function mulf(num) {
        var out = new BN(null);
        out.words = new Array(this.length + num.length);
        return jumboMulTo(this, num, out);
      };
      BN.prototype.imul = function imul(num) {
        return this.clone().mulTo(num, this);
      };
      BN.prototype.imuln = function imuln(num) {
        assert(typeof num === "number");
        assert(num < 67108864);
        var carry = 0;
        for (var i = 0; i < this.length; i++) {
          var w = (this.words[i] | 0) * num;
          var lo = (w & 67108863) + (carry & 67108863);
          carry >>= 26;
          carry += w / 67108864 | 0;
          carry += lo >>> 26;
          this.words[i] = lo & 67108863;
        }
        if (carry !== 0) {
          this.words[i] = carry;
          this.length++;
        }
        if (num === 0) {
          this.length = 1;
          this._normSign();
        }
        return this;
      };
      BN.prototype.muln = function muln(num) {
        return this.clone().imuln(num);
      };
      BN.prototype.sqr = function sqr() {
        return this.mul(this);
      };
      BN.prototype.isqr = function isqr() {
        return this.imul(this.clone());
      };
      BN.prototype.pow = function pow(num) {
        var w = toBitArray(num);
        if (w.length === 0) return new BN(1);
        var res = this;
        for (var i = 0; i < w.length; i++, res = res.sqr()) {
          if (w[i] !== 0) break;
        }
        if (++i < w.length) {
          for (var q = res.sqr(); i < w.length; i++, q = q.sqr()) {
            if (w[i] === 0) continue;
            res = res.mul(q);
          }
        }
        return res;
      };
      BN.prototype.iushln = function iushln(bits) {
        assert(typeof bits === "number" && bits >= 0);
        var r = bits % 26;
        var s = (bits - r) / 26;
        var carryMask = 67108863 >>> 26 - r << 26 - r;
        var i;
        if (r !== 0) {
          var carry = 0;
          for (i = 0; i < this.length; i++) {
            var newCarry = this.words[i] & carryMask;
            var c = (this.words[i] | 0) - newCarry << r;
            this.words[i] = c | carry;
            carry = newCarry >>> 26 - r;
          }
          if (carry) {
            this.words[i] = carry;
            this.length++;
          }
        }
        if (s !== 0) {
          for (i = this.length - 1; i >= 0; i--) {
            this.words[i + s] = this.words[i];
          }
          for (i = 0; i < s; i++) {
            this.words[i] = 0;
          }
          this.length += s;
        }
        return this.strip();
      };
      BN.prototype.ishln = function ishln(bits) {
        assert(this.negative === 0);
        return this.iushln(bits);
      };
      BN.prototype.iushrn = function iushrn(bits, hint, extended) {
        assert(typeof bits === "number" && bits >= 0);
        var h;
        if (hint) {
          h = (hint - hint % 26) / 26;
        } else {
          h = 0;
        }
        var r = bits % 26;
        var s = Math.min((bits - r) / 26, this.length);
        var mask = 67108863 ^ 67108863 >>> r << r;
        var maskedWords = extended;
        h -= s;
        h = Math.max(0, h);
        if (maskedWords) {
          for (var i = 0; i < s; i++) {
            maskedWords.words[i] = this.words[i];
          }
          maskedWords.length = s;
        }
        if (s === 0) {
        } else if (this.length > s) {
          this.length -= s;
          for (i = 0; i < this.length; i++) {
            this.words[i] = this.words[i + s];
          }
        } else {
          this.words[0] = 0;
          this.length = 1;
        }
        var carry = 0;
        for (i = this.length - 1; i >= 0 && (carry !== 0 || i >= h); i--) {
          var word = this.words[i] | 0;
          this.words[i] = carry << 26 - r | word >>> r;
          carry = word & mask;
        }
        if (maskedWords && carry !== 0) {
          maskedWords.words[maskedWords.length++] = carry;
        }
        if (this.length === 0) {
          this.words[0] = 0;
          this.length = 1;
        }
        return this.strip();
      };
      BN.prototype.ishrn = function ishrn(bits, hint, extended) {
        assert(this.negative === 0);
        return this.iushrn(bits, hint, extended);
      };
      BN.prototype.shln = function shln(bits) {
        return this.clone().ishln(bits);
      };
      BN.prototype.ushln = function ushln(bits) {
        return this.clone().iushln(bits);
      };
      BN.prototype.shrn = function shrn(bits) {
        return this.clone().ishrn(bits);
      };
      BN.prototype.ushrn = function ushrn(bits) {
        return this.clone().iushrn(bits);
      };
      BN.prototype.testn = function testn(bit) {
        assert(typeof bit === "number" && bit >= 0);
        var r = bit % 26;
        var s = (bit - r) / 26;
        var q = 1 << r;
        if (this.length <= s) return false;
        var w = this.words[s];
        return !!(w & q);
      };
      BN.prototype.imaskn = function imaskn(bits) {
        assert(typeof bits === "number" && bits >= 0);
        var r = bits % 26;
        var s = (bits - r) / 26;
        assert(this.negative === 0, "imaskn works only with positive numbers");
        if (this.length <= s) {
          return this;
        }
        if (r !== 0) {
          s++;
        }
        this.length = Math.min(s, this.length);
        if (r !== 0) {
          var mask = 67108863 ^ 67108863 >>> r << r;
          this.words[this.length - 1] &= mask;
        }
        if (this.length === 0) {
          this.words[0] = 0;
          this.length = 1;
        }
        return this.strip();
      };
      BN.prototype.maskn = function maskn(bits) {
        return this.clone().imaskn(bits);
      };
      BN.prototype.iaddn = function iaddn(num) {
        assert(typeof num === "number");
        assert(num < 67108864);
        if (num < 0) return this.isubn(-num);
        if (this.negative !== 0) {
          if (this.length === 1 && (this.words[0] | 0) < num) {
            this.words[0] = num - (this.words[0] | 0);
            this.negative = 0;
            return this;
          }
          this.negative = 0;
          this.isubn(num);
          this.negative = 1;
          return this;
        }
        return this._iaddn(num);
      };
      BN.prototype._iaddn = function _iaddn(num) {
        this.words[0] += num;
        for (var i = 0; i < this.length && this.words[i] >= 67108864; i++) {
          this.words[i] -= 67108864;
          if (i === this.length - 1) {
            this.words[i + 1] = 1;
          } else {
            this.words[i + 1]++;
          }
        }
        this.length = Math.max(this.length, i + 1);
        return this;
      };
      BN.prototype.isubn = function isubn(num) {
        assert(typeof num === "number");
        assert(num < 67108864);
        if (num < 0) return this.iaddn(-num);
        if (this.negative !== 0) {
          this.negative = 0;
          this.iaddn(num);
          this.negative = 1;
          return this;
        }
        this.words[0] -= num;
        if (this.length === 1 && this.words[0] < 0) {
          this.words[0] = -this.words[0];
          this.negative = 1;
        } else {
          for (var i = 0; i < this.length && this.words[i] < 0; i++) {
            this.words[i] += 67108864;
            this.words[i + 1] -= 1;
          }
        }
        return this.strip();
      };
      BN.prototype.addn = function addn(num) {
        return this.clone().iaddn(num);
      };
      BN.prototype.subn = function subn(num) {
        return this.clone().isubn(num);
      };
      BN.prototype.iabs = function iabs() {
        this.negative = 0;
        return this;
      };
      BN.prototype.abs = function abs() {
        return this.clone().iabs();
      };
      BN.prototype._ishlnsubmul = function _ishlnsubmul(num, mul, shift) {
        var len = num.length + shift;
        var i;
        this._expand(len);
        var w;
        var carry = 0;
        for (i = 0; i < num.length; i++) {
          w = (this.words[i + shift] | 0) + carry;
          var right = (num.words[i] | 0) * mul;
          w -= right & 67108863;
          carry = (w >> 26) - (right / 67108864 | 0);
          this.words[i + shift] = w & 67108863;
        }
        for (; i < this.length - shift; i++) {
          w = (this.words[i + shift] | 0) + carry;
          carry = w >> 26;
          this.words[i + shift] = w & 67108863;
        }
        if (carry === 0) return this.strip();
        assert(carry === -1);
        carry = 0;
        for (i = 0; i < this.length; i++) {
          w = -(this.words[i] | 0) + carry;
          carry = w >> 26;
          this.words[i] = w & 67108863;
        }
        this.negative = 1;
        return this.strip();
      };
      BN.prototype._wordDiv = function _wordDiv(num, mode) {
        var shift = this.length - num.length;
        var a = this.clone();
        var b = num;
        var bhi = b.words[b.length - 1] | 0;
        var bhiBits = this._countBits(bhi);
        shift = 26 - bhiBits;
        if (shift !== 0) {
          b = b.ushln(shift);
          a.iushln(shift);
          bhi = b.words[b.length - 1] | 0;
        }
        var m = a.length - b.length;
        var q;
        if (mode !== "mod") {
          q = new BN(null);
          q.length = m + 1;
          q.words = new Array(q.length);
          for (var i = 0; i < q.length; i++) {
            q.words[i] = 0;
          }
        }
        var diff = a.clone()._ishlnsubmul(b, 1, m);
        if (diff.negative === 0) {
          a = diff;
          if (q) {
            q.words[m] = 1;
          }
        }
        for (var j = m - 1; j >= 0; j--) {
          var qj = (a.words[b.length + j] | 0) * 67108864 + (a.words[b.length + j - 1] | 0);
          qj = Math.min(qj / bhi | 0, 67108863);
          a._ishlnsubmul(b, qj, j);
          while (a.negative !== 0) {
            qj--;
            a.negative = 0;
            a._ishlnsubmul(b, 1, j);
            if (!a.isZero()) {
              a.negative ^= 1;
            }
          }
          if (q) {
            q.words[j] = qj;
          }
        }
        if (q) {
          q.strip();
        }
        a.strip();
        if (mode !== "div" && shift !== 0) {
          a.iushrn(shift);
        }
        return {
          div: q || null,
          mod: a
        };
      };
      BN.prototype.divmod = function divmod(num, mode, positive) {
        assert(!num.isZero());
        if (this.isZero()) {
          return {
            div: new BN(0),
            mod: new BN(0)
          };
        }
        var div, mod, res;
        if (this.negative !== 0 && num.negative === 0) {
          res = this.neg().divmod(num, mode);
          if (mode !== "mod") {
            div = res.div.neg();
          }
          if (mode !== "div") {
            mod = res.mod.neg();
            if (positive && mod.negative !== 0) {
              mod.iadd(num);
            }
          }
          return {
            div,
            mod
          };
        }
        if (this.negative === 0 && num.negative !== 0) {
          res = this.divmod(num.neg(), mode);
          if (mode !== "mod") {
            div = res.div.neg();
          }
          return {
            div,
            mod: res.mod
          };
        }
        if ((this.negative & num.negative) !== 0) {
          res = this.neg().divmod(num.neg(), mode);
          if (mode !== "div") {
            mod = res.mod.neg();
            if (positive && mod.negative !== 0) {
              mod.isub(num);
            }
          }
          return {
            div: res.div,
            mod
          };
        }
        if (num.length > this.length || this.cmp(num) < 0) {
          return {
            div: new BN(0),
            mod: this
          };
        }
        if (num.length === 1) {
          if (mode === "div") {
            return {
              div: this.divn(num.words[0]),
              mod: null
            };
          }
          if (mode === "mod") {
            return {
              div: null,
              mod: new BN(this.modn(num.words[0]))
            };
          }
          return {
            div: this.divn(num.words[0]),
            mod: new BN(this.modn(num.words[0]))
          };
        }
        return this._wordDiv(num, mode);
      };
      BN.prototype.div = function div(num) {
        return this.divmod(num, "div", false).div;
      };
      BN.prototype.mod = function mod(num) {
        return this.divmod(num, "mod", false).mod;
      };
      BN.prototype.umod = function umod(num) {
        return this.divmod(num, "mod", true).mod;
      };
      BN.prototype.divRound = function divRound(num) {
        var dm = this.divmod(num);
        if (dm.mod.isZero()) return dm.div;
        var mod = dm.mod.abs();
        var half = num.abs().iushrn(1);
        var r2 = num.words[0] & 1;
        var cmp = mod.cmp(half);
        if (cmp < 0 || r2 === 1 && cmp === 0) return dm.div;
        var up = new BN(1);
        up.negative = this.negative ^ num.negative;
        return dm.div.iadd(up);
      };
      BN.prototype.modn = function modn(num) {
        assert(num <= 67108863);
        var p = (1 << 26) % num;
        var acc = 0;
        for (var i = this.length - 1; i >= 0; i--) {
          acc = (p * acc + (this.words[i] | 0)) % num;
        }
        return acc;
      };
      BN.prototype.idivn = function idivn(num) {
        assert(num <= 67108863);
        var carry = 0;
        for (var i = this.length - 1; i >= 0; i--) {
          var w = (this.words[i] | 0) + carry * 67108864;
          this.words[i] = w / num | 0;
          carry = w % num;
        }
        return this.strip();
      };
      BN.prototype.divn = function divn(num) {
        return this.clone().idivn(num);
      };
      BN.prototype.egcd = function egcd(p) {
        assert(p.negative === 0);
        assert(!p.isZero());
        var x = this;
        var y = p.clone();
        if (x.negative !== 0) {
          x = x.umod(p);
        } else {
          x = x.clone();
        }
        var A = new BN(1);
        var B = new BN(0);
        var C = new BN(0);
        var D = new BN(1);
        var g = 0;
        while (x.isEven() && y.isEven()) {
          x.iushrn(1);
          y.iushrn(1);
          ++g;
        }
        var yp = y.clone();
        var xp = x.clone();
        while (!x.isZero()) {
          for (var i = 0, im = 1; (x.words[0] & im) === 0 && i < 26; ++i, im <<= 1) ;
          if (i > 0) {
            x.iushrn(i);
            while (i-- > 0) {
              if (A.isOdd() || B.isOdd()) {
                A.iadd(yp);
                B.isub(xp);
              }
              A.iushrn(1);
              B.iushrn(1);
            }
          }
          for (var j = 0, jm = 1; (y.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1) ;
          if (j > 0) {
            y.iushrn(j);
            while (j-- > 0) {
              if (C.isOdd() || D.isOdd()) {
                C.iadd(yp);
                D.isub(xp);
              }
              C.iushrn(1);
              D.iushrn(1);
            }
          }
          if (x.cmp(y) >= 0) {
            x.isub(y);
            A.isub(C);
            B.isub(D);
          } else {
            y.isub(x);
            C.isub(A);
            D.isub(B);
          }
        }
        return {
          a: C,
          b: D,
          gcd: y.iushln(g)
        };
      };
      BN.prototype._invmp = function _invmp(p) {
        assert(p.negative === 0);
        assert(!p.isZero());
        var a = this;
        var b = p.clone();
        if (a.negative !== 0) {
          a = a.umod(p);
        } else {
          a = a.clone();
        }
        var x1 = new BN(1);
        var x2 = new BN(0);
        var delta = b.clone();
        while (a.cmpn(1) > 0 && b.cmpn(1) > 0) {
          for (var i = 0, im = 1; (a.words[0] & im) === 0 && i < 26; ++i, im <<= 1) ;
          if (i > 0) {
            a.iushrn(i);
            while (i-- > 0) {
              if (x1.isOdd()) {
                x1.iadd(delta);
              }
              x1.iushrn(1);
            }
          }
          for (var j = 0, jm = 1; (b.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1) ;
          if (j > 0) {
            b.iushrn(j);
            while (j-- > 0) {
              if (x2.isOdd()) {
                x2.iadd(delta);
              }
              x2.iushrn(1);
            }
          }
          if (a.cmp(b) >= 0) {
            a.isub(b);
            x1.isub(x2);
          } else {
            b.isub(a);
            x2.isub(x1);
          }
        }
        var res;
        if (a.cmpn(1) === 0) {
          res = x1;
        } else {
          res = x2;
        }
        if (res.cmpn(0) < 0) {
          res.iadd(p);
        }
        return res;
      };
      BN.prototype.gcd = function gcd(num) {
        if (this.isZero()) return num.abs();
        if (num.isZero()) return this.abs();
        var a = this.clone();
        var b = num.clone();
        a.negative = 0;
        b.negative = 0;
        for (var shift = 0; a.isEven() && b.isEven(); shift++) {
          a.iushrn(1);
          b.iushrn(1);
        }
        do {
          while (a.isEven()) {
            a.iushrn(1);
          }
          while (b.isEven()) {
            b.iushrn(1);
          }
          var r = a.cmp(b);
          if (r < 0) {
            var t = a;
            a = b;
            b = t;
          } else if (r === 0 || b.cmpn(1) === 0) {
            break;
          }
          a.isub(b);
        } while (true);
        return b.iushln(shift);
      };
      BN.prototype.invm = function invm(num) {
        return this.egcd(num).a.umod(num);
      };
      BN.prototype.isEven = function isEven() {
        return (this.words[0] & 1) === 0;
      };
      BN.prototype.isOdd = function isOdd() {
        return (this.words[0] & 1) === 1;
      };
      BN.prototype.andln = function andln(num) {
        return this.words[0] & num;
      };
      BN.prototype.bincn = function bincn(bit) {
        assert(typeof bit === "number");
        var r = bit % 26;
        var s = (bit - r) / 26;
        var q = 1 << r;
        if (this.length <= s) {
          this._expand(s + 1);
          this.words[s] |= q;
          return this;
        }
        var carry = q;
        for (var i = s; carry !== 0 && i < this.length; i++) {
          var w = this.words[i] | 0;
          w += carry;
          carry = w >>> 26;
          w &= 67108863;
          this.words[i] = w;
        }
        if (carry !== 0) {
          this.words[i] = carry;
          this.length++;
        }
        return this;
      };
      BN.prototype.isZero = function isZero() {
        return this.length === 1 && this.words[0] === 0;
      };
      BN.prototype.cmpn = function cmpn(num) {
        var negative = num < 0;
        if (this.negative !== 0 && !negative) return -1;
        if (this.negative === 0 && negative) return 1;
        this.strip();
        var res;
        if (this.length > 1) {
          res = 1;
        } else {
          if (negative) {
            num = -num;
          }
          assert(num <= 67108863, "Number is too big");
          var w = this.words[0] | 0;
          res = w === num ? 0 : w < num ? -1 : 1;
        }
        if (this.negative !== 0) return -res | 0;
        return res;
      };
      BN.prototype.cmp = function cmp(num) {
        if (this.negative !== 0 && num.negative === 0) return -1;
        if (this.negative === 0 && num.negative !== 0) return 1;
        var res = this.ucmp(num);
        if (this.negative !== 0) return -res | 0;
        return res;
      };
      BN.prototype.ucmp = function ucmp(num) {
        if (this.length > num.length) return 1;
        if (this.length < num.length) return -1;
        var res = 0;
        for (var i = this.length - 1; i >= 0; i--) {
          var a = this.words[i] | 0;
          var b = num.words[i] | 0;
          if (a === b) continue;
          if (a < b) {
            res = -1;
          } else if (a > b) {
            res = 1;
          }
          break;
        }
        return res;
      };
      BN.prototype.gtn = function gtn(num) {
        return this.cmpn(num) === 1;
      };
      BN.prototype.gt = function gt(num) {
        return this.cmp(num) === 1;
      };
      BN.prototype.gten = function gten(num) {
        return this.cmpn(num) >= 0;
      };
      BN.prototype.gte = function gte(num) {
        return this.cmp(num) >= 0;
      };
      BN.prototype.ltn = function ltn(num) {
        return this.cmpn(num) === -1;
      };
      BN.prototype.lt = function lt(num) {
        return this.cmp(num) === -1;
      };
      BN.prototype.lten = function lten(num) {
        return this.cmpn(num) <= 0;
      };
      BN.prototype.lte = function lte(num) {
        return this.cmp(num) <= 0;
      };
      BN.prototype.eqn = function eqn(num) {
        return this.cmpn(num) === 0;
      };
      BN.prototype.eq = function eq(num) {
        return this.cmp(num) === 0;
      };
      BN.red = function red(num) {
        return new Red(num);
      };
      BN.prototype.toRed = function toRed(ctx) {
        assert(!this.red, "Already a number in reduction context");
        assert(this.negative === 0, "red works only with positives");
        return ctx.convertTo(this)._forceRed(ctx);
      };
      BN.prototype.fromRed = function fromRed() {
        assert(this.red, "fromRed works only with numbers in reduction context");
        return this.red.convertFrom(this);
      };
      BN.prototype._forceRed = function _forceRed(ctx) {
        this.red = ctx;
        return this;
      };
      BN.prototype.forceRed = function forceRed(ctx) {
        assert(!this.red, "Already a number in reduction context");
        return this._forceRed(ctx);
      };
      BN.prototype.redAdd = function redAdd(num) {
        assert(this.red, "redAdd works only with red numbers");
        return this.red.add(this, num);
      };
      BN.prototype.redIAdd = function redIAdd(num) {
        assert(this.red, "redIAdd works only with red numbers");
        return this.red.iadd(this, num);
      };
      BN.prototype.redSub = function redSub(num) {
        assert(this.red, "redSub works only with red numbers");
        return this.red.sub(this, num);
      };
      BN.prototype.redISub = function redISub(num) {
        assert(this.red, "redISub works only with red numbers");
        return this.red.isub(this, num);
      };
      BN.prototype.redShl = function redShl(num) {
        assert(this.red, "redShl works only with red numbers");
        return this.red.shl(this, num);
      };
      BN.prototype.redMul = function redMul(num) {
        assert(this.red, "redMul works only with red numbers");
        this.red._verify2(this, num);
        return this.red.mul(this, num);
      };
      BN.prototype.redIMul = function redIMul(num) {
        assert(this.red, "redMul works only with red numbers");
        this.red._verify2(this, num);
        return this.red.imul(this, num);
      };
      BN.prototype.redSqr = function redSqr() {
        assert(this.red, "redSqr works only with red numbers");
        this.red._verify1(this);
        return this.red.sqr(this);
      };
      BN.prototype.redISqr = function redISqr() {
        assert(this.red, "redISqr works only with red numbers");
        this.red._verify1(this);
        return this.red.isqr(this);
      };
      BN.prototype.redSqrt = function redSqrt() {
        assert(this.red, "redSqrt works only with red numbers");
        this.red._verify1(this);
        return this.red.sqrt(this);
      };
      BN.prototype.redInvm = function redInvm() {
        assert(this.red, "redInvm works only with red numbers");
        this.red._verify1(this);
        return this.red.invm(this);
      };
      BN.prototype.redNeg = function redNeg() {
        assert(this.red, "redNeg works only with red numbers");
        this.red._verify1(this);
        return this.red.neg(this);
      };
      BN.prototype.redPow = function redPow(num) {
        assert(this.red && !num.red, "redPow(normalNum)");
        this.red._verify1(this);
        return this.red.pow(this, num);
      };
      var primes = {
        k256: null,
        p224: null,
        p192: null,
        p25519: null
      };
      function MPrime(name, p) {
        this.name = name;
        this.p = new BN(p, 16);
        this.n = this.p.bitLength();
        this.k = new BN(1).iushln(this.n).isub(this.p);
        this.tmp = this._tmp();
      }
      MPrime.prototype._tmp = function _tmp() {
        var tmp = new BN(null);
        tmp.words = new Array(Math.ceil(this.n / 13));
        return tmp;
      };
      MPrime.prototype.ireduce = function ireduce(num) {
        var r = num;
        var rlen;
        do {
          this.split(r, this.tmp);
          r = this.imulK(r);
          r = r.iadd(this.tmp);
          rlen = r.bitLength();
        } while (rlen > this.n);
        var cmp = rlen < this.n ? -1 : r.ucmp(this.p);
        if (cmp === 0) {
          r.words[0] = 0;
          r.length = 1;
        } else if (cmp > 0) {
          r.isub(this.p);
        } else {
          if (r.strip !== void 0) {
            r.strip();
          } else {
            r._strip();
          }
        }
        return r;
      };
      MPrime.prototype.split = function split(input, out) {
        input.iushrn(this.n, 0, out);
      };
      MPrime.prototype.imulK = function imulK(num) {
        return num.imul(this.k);
      };
      function K256() {
        MPrime.call(
          this,
          "k256",
          "ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff fffffffe fffffc2f"
        );
      }
      inherits(K256, MPrime);
      K256.prototype.split = function split(input, output) {
        var mask = 4194303;
        var outLen = Math.min(input.length, 9);
        for (var i = 0; i < outLen; i++) {
          output.words[i] = input.words[i];
        }
        output.length = outLen;
        if (input.length <= 9) {
          input.words[0] = 0;
          input.length = 1;
          return;
        }
        var prev = input.words[9];
        output.words[output.length++] = prev & mask;
        for (i = 10; i < input.length; i++) {
          var next = input.words[i] | 0;
          input.words[i - 10] = (next & mask) << 4 | prev >>> 22;
          prev = next;
        }
        prev >>>= 22;
        input.words[i - 10] = prev;
        if (prev === 0 && input.length > 10) {
          input.length -= 10;
        } else {
          input.length -= 9;
        }
      };
      K256.prototype.imulK = function imulK(num) {
        num.words[num.length] = 0;
        num.words[num.length + 1] = 0;
        num.length += 2;
        var lo = 0;
        for (var i = 0; i < num.length; i++) {
          var w = num.words[i] | 0;
          lo += w * 977;
          num.words[i] = lo & 67108863;
          lo = w * 64 + (lo / 67108864 | 0);
        }
        if (num.words[num.length - 1] === 0) {
          num.length--;
          if (num.words[num.length - 1] === 0) {
            num.length--;
          }
        }
        return num;
      };
      function P224() {
        MPrime.call(
          this,
          "p224",
          "ffffffff ffffffff ffffffff ffffffff 00000000 00000000 00000001"
        );
      }
      inherits(P224, MPrime);
      function P192() {
        MPrime.call(
          this,
          "p192",
          "ffffffff ffffffff ffffffff fffffffe ffffffff ffffffff"
        );
      }
      inherits(P192, MPrime);
      function P25519() {
        MPrime.call(
          this,
          "25519",
          "7fffffffffffffff ffffffffffffffff ffffffffffffffff ffffffffffffffed"
        );
      }
      inherits(P25519, MPrime);
      P25519.prototype.imulK = function imulK(num) {
        var carry = 0;
        for (var i = 0; i < num.length; i++) {
          var hi = (num.words[i] | 0) * 19 + carry;
          var lo = hi & 67108863;
          hi >>>= 26;
          num.words[i] = lo;
          carry = hi;
        }
        if (carry !== 0) {
          num.words[num.length++] = carry;
        }
        return num;
      };
      BN._prime = function prime(name) {
        if (primes[name]) return primes[name];
        var prime2;
        if (name === "k256") {
          prime2 = new K256();
        } else if (name === "p224") {
          prime2 = new P224();
        } else if (name === "p192") {
          prime2 = new P192();
        } else if (name === "p25519") {
          prime2 = new P25519();
        } else {
          throw new Error("Unknown prime " + name);
        }
        primes[name] = prime2;
        return prime2;
      };
      function Red(m) {
        if (typeof m === "string") {
          var prime = BN._prime(m);
          this.m = prime.p;
          this.prime = prime;
        } else {
          assert(m.gtn(1), "modulus must be greater than 1");
          this.m = m;
          this.prime = null;
        }
      }
      Red.prototype._verify1 = function _verify1(a) {
        assert(a.negative === 0, "red works only with positives");
        assert(a.red, "red works only with red numbers");
      };
      Red.prototype._verify2 = function _verify2(a, b) {
        assert((a.negative | b.negative) === 0, "red works only with positives");
        assert(
          a.red && a.red === b.red,
          "red works only with red numbers"
        );
      };
      Red.prototype.imod = function imod(a) {
        if (this.prime) return this.prime.ireduce(a)._forceRed(this);
        return a.umod(this.m)._forceRed(this);
      };
      Red.prototype.neg = function neg(a) {
        if (a.isZero()) {
          return a.clone();
        }
        return this.m.sub(a)._forceRed(this);
      };
      Red.prototype.add = function add(a, b) {
        this._verify2(a, b);
        var res = a.add(b);
        if (res.cmp(this.m) >= 0) {
          res.isub(this.m);
        }
        return res._forceRed(this);
      };
      Red.prototype.iadd = function iadd(a, b) {
        this._verify2(a, b);
        var res = a.iadd(b);
        if (res.cmp(this.m) >= 0) {
          res.isub(this.m);
        }
        return res;
      };
      Red.prototype.sub = function sub(a, b) {
        this._verify2(a, b);
        var res = a.sub(b);
        if (res.cmpn(0) < 0) {
          res.iadd(this.m);
        }
        return res._forceRed(this);
      };
      Red.prototype.isub = function isub(a, b) {
        this._verify2(a, b);
        var res = a.isub(b);
        if (res.cmpn(0) < 0) {
          res.iadd(this.m);
        }
        return res;
      };
      Red.prototype.shl = function shl(a, num) {
        this._verify1(a);
        return this.imod(a.ushln(num));
      };
      Red.prototype.imul = function imul(a, b) {
        this._verify2(a, b);
        return this.imod(a.imul(b));
      };
      Red.prototype.mul = function mul(a, b) {
        this._verify2(a, b);
        return this.imod(a.mul(b));
      };
      Red.prototype.isqr = function isqr(a) {
        return this.imul(a, a.clone());
      };
      Red.prototype.sqr = function sqr(a) {
        return this.mul(a, a);
      };
      Red.prototype.sqrt = function sqrt(a) {
        if (a.isZero()) return a.clone();
        var mod3 = this.m.andln(3);
        assert(mod3 % 2 === 1);
        if (mod3 === 3) {
          var pow = this.m.add(new BN(1)).iushrn(2);
          return this.pow(a, pow);
        }
        var q = this.m.subn(1);
        var s = 0;
        while (!q.isZero() && q.andln(1) === 0) {
          s++;
          q.iushrn(1);
        }
        assert(!q.isZero());
        var one = new BN(1).toRed(this);
        var nOne = one.redNeg();
        var lpow = this.m.subn(1).iushrn(1);
        var z = this.m.bitLength();
        z = new BN(2 * z * z).toRed(this);
        while (this.pow(z, lpow).cmp(nOne) !== 0) {
          z.redIAdd(nOne);
        }
        var c = this.pow(z, q);
        var r = this.pow(a, q.addn(1).iushrn(1));
        var t = this.pow(a, q);
        var m = s;
        while (t.cmp(one) !== 0) {
          var tmp = t;
          for (var i = 0; tmp.cmp(one) !== 0; i++) {
            tmp = tmp.redSqr();
          }
          assert(i < m);
          var b = this.pow(c, new BN(1).iushln(m - i - 1));
          r = r.redMul(b);
          c = b.redSqr();
          t = t.redMul(c);
          m = i;
        }
        return r;
      };
      Red.prototype.invm = function invm(a) {
        var inv = a._invmp(this.m);
        if (inv.negative !== 0) {
          inv.negative = 0;
          return this.imod(inv).redNeg();
        } else {
          return this.imod(inv);
        }
      };
      Red.prototype.pow = function pow(a, num) {
        if (num.isZero()) return new BN(1).toRed(this);
        if (num.cmpn(1) === 0) return a.clone();
        var windowSize = 4;
        var wnd = new Array(1 << windowSize);
        wnd[0] = new BN(1).toRed(this);
        wnd[1] = a;
        for (var i = 2; i < wnd.length; i++) {
          wnd[i] = this.mul(wnd[i - 1], a);
        }
        var res = wnd[0];
        var current = 0;
        var currentLen = 0;
        var start = num.bitLength() % 26;
        if (start === 0) {
          start = 26;
        }
        for (i = num.length - 1; i >= 0; i--) {
          var word = num.words[i];
          for (var j = start - 1; j >= 0; j--) {
            var bit = word >> j & 1;
            if (res !== wnd[0]) {
              res = this.sqr(res);
            }
            if (bit === 0 && current === 0) {
              currentLen = 0;
              continue;
            }
            current <<= 1;
            current |= bit;
            currentLen++;
            if (currentLen !== windowSize && (i !== 0 || j !== 0)) continue;
            res = this.mul(res, wnd[current]);
            currentLen = 0;
            current = 0;
          }
          start = 26;
        }
        return res;
      };
      Red.prototype.convertTo = function convertTo(num) {
        var r = num.umod(this.m);
        return r === num ? r.clone() : r;
      };
      Red.prototype.convertFrom = function convertFrom(num) {
        var res = num.clone();
        res.red = null;
        return res;
      };
      BN.mont = function mont(num) {
        return new Mont(num);
      };
      function Mont(m) {
        Red.call(this, m);
        this.shift = this.m.bitLength();
        if (this.shift % 26 !== 0) {
          this.shift += 26 - this.shift % 26;
        }
        this.r = new BN(1).iushln(this.shift);
        this.r2 = this.imod(this.r.sqr());
        this.rinv = this.r._invmp(this.m);
        this.minv = this.rinv.mul(this.r).isubn(1).div(this.m);
        this.minv = this.minv.umod(this.r);
        this.minv = this.r.sub(this.minv);
      }
      inherits(Mont, Red);
      Mont.prototype.convertTo = function convertTo(num) {
        return this.imod(num.ushln(this.shift));
      };
      Mont.prototype.convertFrom = function convertFrom(num) {
        var r = this.imod(num.mul(this.rinv));
        r.red = null;
        return r;
      };
      Mont.prototype.imul = function imul(a, b) {
        if (a.isZero() || b.isZero()) {
          a.words[0] = 0;
          a.length = 1;
          return a;
        }
        var t = a.imul(b);
        var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
        var u = t.isub(c).iushrn(this.shift);
        var res = u;
        if (u.cmp(this.m) >= 0) {
          res = u.isub(this.m);
        } else if (u.cmpn(0) < 0) {
          res = u.iadd(this.m);
        }
        return res._forceRed(this);
      };
      Mont.prototype.mul = function mul(a, b) {
        if (a.isZero() || b.isZero()) return new BN(0)._forceRed(this);
        var t = a.mul(b);
        var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
        var u = t.isub(c).iushrn(this.shift);
        var res = u;
        if (u.cmp(this.m) >= 0) {
          res = u.isub(this.m);
        } else if (u.cmpn(0) < 0) {
          res = u.iadd(this.m);
        }
        return res._forceRed(this);
      };
      Mont.prototype.invm = function invm(a) {
        var res = this.imod(a._invmp(this.m).mul(this.r2));
        return res._forceRed(this);
      };
    })(typeof module2 === "undefined" || module2, exports2);
  }
});

// node_modules/inherits/inherits_browser.js
var require_inherits_browser = __commonJS({
  "node_modules/inherits/inherits_browser.js"(exports2, module2) {
    if (typeof Object.create === "function") {
      module2.exports = function inherits(ctor, superCtor) {
        if (superCtor) {
          ctor.super_ = superCtor;
          ctor.prototype = Object.create(superCtor.prototype, {
            constructor: {
              value: ctor,
              enumerable: false,
              writable: true,
              configurable: true
            }
          });
        }
      };
    } else {
      module2.exports = function inherits(ctor, superCtor) {
        if (superCtor) {
          ctor.super_ = superCtor;
          var TempCtor = function() {
          };
          TempCtor.prototype = superCtor.prototype;
          ctor.prototype = new TempCtor();
          ctor.prototype.constructor = ctor;
        }
      };
    }
  }
});

// node_modules/inherits/inherits.js
var require_inherits = __commonJS({
  "node_modules/inherits/inherits.js"(exports2, module2) {
    try {
      util = require("util");
      if (typeof util.inherits !== "function") throw "";
      module2.exports = util.inherits;
    } catch (e) {
      module2.exports = require_inherits_browser();
    }
    var util;
  }
});

// node_modules/safer-buffer/safer.js
var require_safer = __commonJS({
  "node_modules/safer-buffer/safer.js"(exports2, module2) {
    "use strict";
    var buffer = require("buffer");
    var Buffer2 = buffer.Buffer;
    var safer = {};
    var key;
    for (key in buffer) {
      if (!buffer.hasOwnProperty(key)) continue;
      if (key === "SlowBuffer" || key === "Buffer") continue;
      safer[key] = buffer[key];
    }
    var Safer = safer.Buffer = {};
    for (key in Buffer2) {
      if (!Buffer2.hasOwnProperty(key)) continue;
      if (key === "allocUnsafe" || key === "allocUnsafeSlow") continue;
      Safer[key] = Buffer2[key];
    }
    safer.Buffer.prototype = Buffer2.prototype;
    if (!Safer.from || Safer.from === Uint8Array.from) {
      Safer.from = function(value, encodingOrOffset, length) {
        if (typeof value === "number") {
          throw new TypeError('The "value" argument must not be of type number. Received type ' + typeof value);
        }
        if (value && typeof value.length === "undefined") {
          throw new TypeError("The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value);
        }
        return Buffer2(value, encodingOrOffset, length);
      };
    }
    if (!Safer.alloc) {
      Safer.alloc = function(size, fill, encoding) {
        if (typeof size !== "number") {
          throw new TypeError('The "size" argument must be of type number. Received type ' + typeof size);
        }
        if (size < 0 || size >= 2 * (1 << 30)) {
          throw new RangeError('The value "' + size + '" is invalid for option "size"');
        }
        var buf = Buffer2(size);
        if (!fill || fill.length === 0) {
          buf.fill(0);
        } else if (typeof encoding === "string") {
          buf.fill(fill, encoding);
        } else {
          buf.fill(fill);
        }
        return buf;
      };
    }
    if (!safer.kStringMaxLength) {
      try {
        safer.kStringMaxLength = process.binding("buffer").kStringMaxLength;
      } catch (e) {
      }
    }
    if (!safer.constants) {
      safer.constants = {
        MAX_LENGTH: safer.kMaxLength
      };
      if (safer.kStringMaxLength) {
        safer.constants.MAX_STRING_LENGTH = safer.kStringMaxLength;
      }
    }
    module2.exports = safer;
  }
});

// node_modules/asn1.js/lib/asn1/base/reporter.js
var require_reporter = __commonJS({
  "node_modules/asn1.js/lib/asn1/base/reporter.js"(exports2) {
    "use strict";
    var inherits = require_inherits();
    function Reporter(options) {
      this._reporterState = {
        obj: null,
        path: [],
        options: options || {},
        errors: []
      };
    }
    exports2.Reporter = Reporter;
    Reporter.prototype.isError = function isError(obj) {
      return obj instanceof ReporterError;
    };
    Reporter.prototype.save = function save() {
      const state = this._reporterState;
      return { obj: state.obj, pathLen: state.path.length };
    };
    Reporter.prototype.restore = function restore(data) {
      const state = this._reporterState;
      state.obj = data.obj;
      state.path = state.path.slice(0, data.pathLen);
    };
    Reporter.prototype.enterKey = function enterKey(key) {
      return this._reporterState.path.push(key);
    };
    Reporter.prototype.exitKey = function exitKey(index) {
      const state = this._reporterState;
      state.path = state.path.slice(0, index - 1);
    };
    Reporter.prototype.leaveKey = function leaveKey(index, key, value) {
      const state = this._reporterState;
      this.exitKey(index);
      if (state.obj !== null)
        state.obj[key] = value;
    };
    Reporter.prototype.path = function path() {
      return this._reporterState.path.join("/");
    };
    Reporter.prototype.enterObject = function enterObject() {
      const state = this._reporterState;
      const prev = state.obj;
      state.obj = {};
      return prev;
    };
    Reporter.prototype.leaveObject = function leaveObject(prev) {
      const state = this._reporterState;
      const now = state.obj;
      state.obj = prev;
      return now;
    };
    Reporter.prototype.error = function error(msg) {
      let err;
      const state = this._reporterState;
      const inherited = msg instanceof ReporterError;
      if (inherited) {
        err = msg;
      } else {
        err = new ReporterError(state.path.map(function(elem) {
          return "[" + JSON.stringify(elem) + "]";
        }).join(""), msg.message || msg, msg.stack);
      }
      if (!state.options.partial)
        throw err;
      if (!inherited)
        state.errors.push(err);
      return err;
    };
    Reporter.prototype.wrapResult = function wrapResult(result) {
      const state = this._reporterState;
      if (!state.options.partial)
        return result;
      return {
        result: this.isError(result) ? null : result,
        errors: state.errors
      };
    };
    function ReporterError(path, msg) {
      this.path = path;
      this.rethrow(msg);
    }
    inherits(ReporterError, Error);
    ReporterError.prototype.rethrow = function rethrow(msg) {
      this.message = msg + " at: " + (this.path || "(shallow)");
      if (Error.captureStackTrace)
        Error.captureStackTrace(this, ReporterError);
      if (!this.stack) {
        try {
          throw new Error(this.message);
        } catch (e) {
          this.stack = e.stack;
        }
      }
      return this;
    };
  }
});

// node_modules/asn1.js/lib/asn1/base/buffer.js
var require_buffer = __commonJS({
  "node_modules/asn1.js/lib/asn1/base/buffer.js"(exports2) {
    "use strict";
    var inherits = require_inherits();
    var Reporter = require_reporter().Reporter;
    var Buffer2 = require_safer().Buffer;
    function DecoderBuffer(base, options) {
      Reporter.call(this, options);
      if (!Buffer2.isBuffer(base)) {
        this.error("Input not Buffer");
        return;
      }
      this.base = base;
      this.offset = 0;
      this.length = base.length;
    }
    inherits(DecoderBuffer, Reporter);
    exports2.DecoderBuffer = DecoderBuffer;
    DecoderBuffer.isDecoderBuffer = function isDecoderBuffer(data) {
      if (data instanceof DecoderBuffer) {
        return true;
      }
      const isCompatible = typeof data === "object" && Buffer2.isBuffer(data.base) && data.constructor.name === "DecoderBuffer" && typeof data.offset === "number" && typeof data.length === "number" && typeof data.save === "function" && typeof data.restore === "function" && typeof data.isEmpty === "function" && typeof data.readUInt8 === "function" && typeof data.skip === "function" && typeof data.raw === "function";
      return isCompatible;
    };
    DecoderBuffer.prototype.save = function save() {
      return { offset: this.offset, reporter: Reporter.prototype.save.call(this) };
    };
    DecoderBuffer.prototype.restore = function restore(save) {
      const res = new DecoderBuffer(this.base);
      res.offset = save.offset;
      res.length = this.offset;
      this.offset = save.offset;
      Reporter.prototype.restore.call(this, save.reporter);
      return res;
    };
    DecoderBuffer.prototype.isEmpty = function isEmpty() {
      return this.offset === this.length;
    };
    DecoderBuffer.prototype.readUInt8 = function readUInt8(fail) {
      if (this.offset + 1 <= this.length)
        return this.base.readUInt8(this.offset++, true);
      else
        return this.error(fail || "DecoderBuffer overrun");
    };
    DecoderBuffer.prototype.skip = function skip(bytes, fail) {
      if (!(this.offset + bytes <= this.length))
        return this.error(fail || "DecoderBuffer overrun");
      const res = new DecoderBuffer(this.base);
      res._reporterState = this._reporterState;
      res.offset = this.offset;
      res.length = this.offset + bytes;
      this.offset += bytes;
      return res;
    };
    DecoderBuffer.prototype.raw = function raw(save) {
      return this.base.slice(save ? save.offset : this.offset, this.length);
    };
    function EncoderBuffer(value, reporter) {
      if (Array.isArray(value)) {
        this.length = 0;
        this.value = value.map(function(item) {
          if (!EncoderBuffer.isEncoderBuffer(item))
            item = new EncoderBuffer(item, reporter);
          this.length += item.length;
          return item;
        }, this);
      } else if (typeof value === "number") {
        if (!(0 <= value && value <= 255))
          return reporter.error("non-byte EncoderBuffer value");
        this.value = value;
        this.length = 1;
      } else if (typeof value === "string") {
        this.value = value;
        this.length = Buffer2.byteLength(value);
      } else if (Buffer2.isBuffer(value)) {
        this.value = value;
        this.length = value.length;
      } else {
        return reporter.error("Unsupported type: " + typeof value);
      }
    }
    exports2.EncoderBuffer = EncoderBuffer;
    EncoderBuffer.isEncoderBuffer = function isEncoderBuffer(data) {
      if (data instanceof EncoderBuffer) {
        return true;
      }
      const isCompatible = typeof data === "object" && data.constructor.name === "EncoderBuffer" && typeof data.length === "number" && typeof data.join === "function";
      return isCompatible;
    };
    EncoderBuffer.prototype.join = function join(out, offset) {
      if (!out)
        out = Buffer2.alloc(this.length);
      if (!offset)
        offset = 0;
      if (this.length === 0)
        return out;
      if (Array.isArray(this.value)) {
        this.value.forEach(function(item) {
          item.join(out, offset);
          offset += item.length;
        });
      } else {
        if (typeof this.value === "number")
          out[offset] = this.value;
        else if (typeof this.value === "string")
          out.write(this.value, offset);
        else if (Buffer2.isBuffer(this.value))
          this.value.copy(out, offset);
        offset += this.length;
      }
      return out;
    };
  }
});

// node_modules/minimalistic-assert/index.js
var require_minimalistic_assert = __commonJS({
  "node_modules/minimalistic-assert/index.js"(exports2, module2) {
    module2.exports = assert;
    function assert(val, msg) {
      if (!val)
        throw new Error(msg || "Assertion failed");
    }
    assert.equal = function assertEqual(l, r, msg) {
      if (l != r)
        throw new Error(msg || "Assertion failed: " + l + " != " + r);
    };
  }
});

// node_modules/asn1.js/lib/asn1/base/node.js
var require_node = __commonJS({
  "node_modules/asn1.js/lib/asn1/base/node.js"(exports2, module2) {
    "use strict";
    var Reporter = require_reporter().Reporter;
    var EncoderBuffer = require_buffer().EncoderBuffer;
    var DecoderBuffer = require_buffer().DecoderBuffer;
    var assert = require_minimalistic_assert();
    var tags = [
      "seq",
      "seqof",
      "set",
      "setof",
      "objid",
      "bool",
      "gentime",
      "utctime",
      "null_",
      "enum",
      "int",
      "objDesc",
      "bitstr",
      "bmpstr",
      "charstr",
      "genstr",
      "graphstr",
      "ia5str",
      "iso646str",
      "numstr",
      "octstr",
      "printstr",
      "t61str",
      "unistr",
      "utf8str",
      "videostr"
    ];
    var methods = [
      "key",
      "obj",
      "use",
      "optional",
      "explicit",
      "implicit",
      "def",
      "choice",
      "any",
      "contains"
    ].concat(tags);
    var overrided = [
      "_peekTag",
      "_decodeTag",
      "_use",
      "_decodeStr",
      "_decodeObjid",
      "_decodeTime",
      "_decodeNull",
      "_decodeInt",
      "_decodeBool",
      "_decodeList",
      "_encodeComposite",
      "_encodeStr",
      "_encodeObjid",
      "_encodeTime",
      "_encodeNull",
      "_encodeInt",
      "_encodeBool"
    ];
    function Node(enc, parent, name) {
      const state = {};
      this._baseState = state;
      state.name = name;
      state.enc = enc;
      state.parent = parent || null;
      state.children = null;
      state.tag = null;
      state.args = null;
      state.reverseArgs = null;
      state.choice = null;
      state.optional = false;
      state.any = false;
      state.obj = false;
      state.use = null;
      state.useDecoder = null;
      state.key = null;
      state["default"] = null;
      state.explicit = null;
      state.implicit = null;
      state.contains = null;
      if (!state.parent) {
        state.children = [];
        this._wrap();
      }
    }
    module2.exports = Node;
    var stateProps = [
      "enc",
      "parent",
      "children",
      "tag",
      "args",
      "reverseArgs",
      "choice",
      "optional",
      "any",
      "obj",
      "use",
      "alteredUse",
      "key",
      "default",
      "explicit",
      "implicit",
      "contains"
    ];
    Node.prototype.clone = function clone() {
      const state = this._baseState;
      const cstate = {};
      stateProps.forEach(function(prop) {
        cstate[prop] = state[prop];
      });
      const res = new this.constructor(cstate.parent);
      res._baseState = cstate;
      return res;
    };
    Node.prototype._wrap = function wrap() {
      const state = this._baseState;
      methods.forEach(function(method) {
        this[method] = function _wrappedMethod() {
          const clone = new this.constructor(this);
          state.children.push(clone);
          return clone[method].apply(clone, arguments);
        };
      }, this);
    };
    Node.prototype._init = function init(body) {
      const state = this._baseState;
      assert(state.parent === null);
      body.call(this);
      state.children = state.children.filter(function(child) {
        return child._baseState.parent === this;
      }, this);
      assert.equal(state.children.length, 1, "Root node can have only one child");
    };
    Node.prototype._useArgs = function useArgs(args) {
      const state = this._baseState;
      const children = args.filter(function(arg) {
        return arg instanceof this.constructor;
      }, this);
      args = args.filter(function(arg) {
        return !(arg instanceof this.constructor);
      }, this);
      if (children.length !== 0) {
        assert(state.children === null);
        state.children = children;
        children.forEach(function(child) {
          child._baseState.parent = this;
        }, this);
      }
      if (args.length !== 0) {
        assert(state.args === null);
        state.args = args;
        state.reverseArgs = args.map(function(arg) {
          if (typeof arg !== "object" || arg.constructor !== Object)
            return arg;
          const res = {};
          Object.keys(arg).forEach(function(key) {
            if (key == (key | 0))
              key |= 0;
            const value = arg[key];
            res[value] = key;
          });
          return res;
        });
      }
    };
    overrided.forEach(function(method) {
      Node.prototype[method] = function _overrided() {
        const state = this._baseState;
        throw new Error(method + " not implemented for encoding: " + state.enc);
      };
    });
    tags.forEach(function(tag) {
      Node.prototype[tag] = function _tagMethod() {
        const state = this._baseState;
        const args = Array.prototype.slice.call(arguments);
        assert(state.tag === null);
        state.tag = tag;
        this._useArgs(args);
        return this;
      };
    });
    Node.prototype.use = function use(item) {
      assert(item);
      const state = this._baseState;
      assert(state.use === null);
      state.use = item;
      return this;
    };
    Node.prototype.optional = function optional() {
      const state = this._baseState;
      state.optional = true;
      return this;
    };
    Node.prototype.def = function def(val) {
      const state = this._baseState;
      assert(state["default"] === null);
      state["default"] = val;
      state.optional = true;
      return this;
    };
    Node.prototype.explicit = function explicit(num) {
      const state = this._baseState;
      assert(state.explicit === null && state.implicit === null);
      state.explicit = num;
      return this;
    };
    Node.prototype.implicit = function implicit(num) {
      const state = this._baseState;
      assert(state.explicit === null && state.implicit === null);
      state.implicit = num;
      return this;
    };
    Node.prototype.obj = function obj() {
      const state = this._baseState;
      const args = Array.prototype.slice.call(arguments);
      state.obj = true;
      if (args.length !== 0)
        this._useArgs(args);
      return this;
    };
    Node.prototype.key = function key(newKey) {
      const state = this._baseState;
      assert(state.key === null);
      state.key = newKey;
      return this;
    };
    Node.prototype.any = function any() {
      const state = this._baseState;
      state.any = true;
      return this;
    };
    Node.prototype.choice = function choice(obj) {
      const state = this._baseState;
      assert(state.choice === null);
      state.choice = obj;
      this._useArgs(Object.keys(obj).map(function(key) {
        return obj[key];
      }));
      return this;
    };
    Node.prototype.contains = function contains(item) {
      const state = this._baseState;
      assert(state.use === null);
      state.contains = item;
      return this;
    };
    Node.prototype._decode = function decode(input, options) {
      const state = this._baseState;
      if (state.parent === null)
        return input.wrapResult(state.children[0]._decode(input, options));
      let result = state["default"];
      let present = true;
      let prevKey = null;
      if (state.key !== null)
        prevKey = input.enterKey(state.key);
      if (state.optional) {
        let tag = null;
        if (state.explicit !== null)
          tag = state.explicit;
        else if (state.implicit !== null)
          tag = state.implicit;
        else if (state.tag !== null)
          tag = state.tag;
        if (tag === null && !state.any) {
          const save = input.save();
          try {
            if (state.choice === null)
              this._decodeGeneric(state.tag, input, options);
            else
              this._decodeChoice(input, options);
            present = true;
          } catch (e) {
            present = false;
          }
          input.restore(save);
        } else {
          present = this._peekTag(input, tag, state.any);
          if (input.isError(present))
            return present;
        }
      }
      let prevObj;
      if (state.obj && present)
        prevObj = input.enterObject();
      if (present) {
        if (state.explicit !== null) {
          const explicit = this._decodeTag(input, state.explicit);
          if (input.isError(explicit))
            return explicit;
          input = explicit;
        }
        const start = input.offset;
        if (state.use === null && state.choice === null) {
          let save;
          if (state.any)
            save = input.save();
          const body = this._decodeTag(
            input,
            state.implicit !== null ? state.implicit : state.tag,
            state.any
          );
          if (input.isError(body))
            return body;
          if (state.any)
            result = input.raw(save);
          else
            input = body;
        }
        if (options && options.track && state.tag !== null)
          options.track(input.path(), start, input.length, "tagged");
        if (options && options.track && state.tag !== null)
          options.track(input.path(), input.offset, input.length, "content");
        if (state.any) {
        } else if (state.choice === null) {
          result = this._decodeGeneric(state.tag, input, options);
        } else {
          result = this._decodeChoice(input, options);
        }
        if (input.isError(result))
          return result;
        if (!state.any && state.choice === null && state.children !== null) {
          state.children.forEach(function decodeChildren(child) {
            child._decode(input, options);
          });
        }
        if (state.contains && (state.tag === "octstr" || state.tag === "bitstr")) {
          const data = new DecoderBuffer(result);
          result = this._getUse(state.contains, input._reporterState.obj)._decode(data, options);
        }
      }
      if (state.obj && present)
        result = input.leaveObject(prevObj);
      if (state.key !== null && (result !== null || present === true))
        input.leaveKey(prevKey, state.key, result);
      else if (prevKey !== null)
        input.exitKey(prevKey);
      return result;
    };
    Node.prototype._decodeGeneric = function decodeGeneric(tag, input, options) {
      const state = this._baseState;
      if (tag === "seq" || tag === "set")
        return null;
      if (tag === "seqof" || tag === "setof")
        return this._decodeList(input, tag, state.args[0], options);
      else if (/str$/.test(tag))
        return this._decodeStr(input, tag, options);
      else if (tag === "objid" && state.args)
        return this._decodeObjid(input, state.args[0], state.args[1], options);
      else if (tag === "objid")
        return this._decodeObjid(input, null, null, options);
      else if (tag === "gentime" || tag === "utctime")
        return this._decodeTime(input, tag, options);
      else if (tag === "null_")
        return this._decodeNull(input, options);
      else if (tag === "bool")
        return this._decodeBool(input, options);
      else if (tag === "objDesc")
        return this._decodeStr(input, tag, options);
      else if (tag === "int" || tag === "enum")
        return this._decodeInt(input, state.args && state.args[0], options);
      if (state.use !== null) {
        return this._getUse(state.use, input._reporterState.obj)._decode(input, options);
      } else {
        return input.error("unknown tag: " + tag);
      }
    };
    Node.prototype._getUse = function _getUse(entity, obj) {
      const state = this._baseState;
      state.useDecoder = this._use(entity, obj);
      assert(state.useDecoder._baseState.parent === null);
      state.useDecoder = state.useDecoder._baseState.children[0];
      if (state.implicit !== state.useDecoder._baseState.implicit) {
        state.useDecoder = state.useDecoder.clone();
        state.useDecoder._baseState.implicit = state.implicit;
      }
      return state.useDecoder;
    };
    Node.prototype._decodeChoice = function decodeChoice(input, options) {
      const state = this._baseState;
      let result = null;
      let match = false;
      Object.keys(state.choice).some(function(key) {
        const save = input.save();
        const node = state.choice[key];
        try {
          const value = node._decode(input, options);
          if (input.isError(value))
            return false;
          result = { type: key, value };
          match = true;
        } catch (e) {
          input.restore(save);
          return false;
        }
        return true;
      }, this);
      if (!match)
        return input.error("Choice not matched");
      return result;
    };
    Node.prototype._createEncoderBuffer = function createEncoderBuffer(data) {
      return new EncoderBuffer(data, this.reporter);
    };
    Node.prototype._encode = function encode(data, reporter, parent) {
      const state = this._baseState;
      if (state["default"] !== null && state["default"] === data)
        return;
      const result = this._encodeValue(data, reporter, parent);
      if (result === void 0)
        return;
      if (this._skipDefault(result, reporter, parent))
        return;
      return result;
    };
    Node.prototype._encodeValue = function encode(data, reporter, parent) {
      const state = this._baseState;
      if (state.parent === null)
        return state.children[0]._encode(data, reporter || new Reporter());
      let result = null;
      this.reporter = reporter;
      if (state.optional && data === void 0) {
        if (state["default"] !== null)
          data = state["default"];
        else
          return;
      }
      let content = null;
      let primitive = false;
      if (state.any) {
        result = this._createEncoderBuffer(data);
      } else if (state.choice) {
        result = this._encodeChoice(data, reporter);
      } else if (state.contains) {
        content = this._getUse(state.contains, parent)._encode(data, reporter);
        primitive = true;
      } else if (state.children) {
        content = state.children.map(function(child) {
          if (child._baseState.tag === "null_")
            return child._encode(null, reporter, data);
          if (child._baseState.key === null)
            return reporter.error("Child should have a key");
          const prevKey = reporter.enterKey(child._baseState.key);
          if (typeof data !== "object")
            return reporter.error("Child expected, but input is not object");
          const res = child._encode(data[child._baseState.key], reporter, data);
          reporter.leaveKey(prevKey);
          return res;
        }, this).filter(function(child) {
          return child;
        });
        content = this._createEncoderBuffer(content);
      } else {
        if (state.tag === "seqof" || state.tag === "setof") {
          if (!(state.args && state.args.length === 1))
            return reporter.error("Too many args for : " + state.tag);
          if (!Array.isArray(data))
            return reporter.error("seqof/setof, but data is not Array");
          const child = this.clone();
          child._baseState.implicit = null;
          content = this._createEncoderBuffer(data.map(function(item) {
            const state2 = this._baseState;
            return this._getUse(state2.args[0], data)._encode(item, reporter);
          }, child));
        } else if (state.use !== null) {
          result = this._getUse(state.use, parent)._encode(data, reporter);
        } else {
          content = this._encodePrimitive(state.tag, data);
          primitive = true;
        }
      }
      if (!state.any && state.choice === null) {
        const tag = state.implicit !== null ? state.implicit : state.tag;
        const cls = state.implicit === null ? "universal" : "context";
        if (tag === null) {
          if (state.use === null)
            reporter.error("Tag could be omitted only for .use()");
        } else {
          if (state.use === null)
            result = this._encodeComposite(tag, primitive, cls, content);
        }
      }
      if (state.explicit !== null)
        result = this._encodeComposite(state.explicit, false, "context", result);
      return result;
    };
    Node.prototype._encodeChoice = function encodeChoice(data, reporter) {
      const state = this._baseState;
      const node = state.choice[data.type];
      if (!node) {
        assert(
          false,
          data.type + " not found in " + JSON.stringify(Object.keys(state.choice))
        );
      }
      return node._encode(data.value, reporter);
    };
    Node.prototype._encodePrimitive = function encodePrimitive(tag, data) {
      const state = this._baseState;
      if (/str$/.test(tag))
        return this._encodeStr(data, tag);
      else if (tag === "objid" && state.args)
        return this._encodeObjid(data, state.reverseArgs[0], state.args[1]);
      else if (tag === "objid")
        return this._encodeObjid(data, null, null);
      else if (tag === "gentime" || tag === "utctime")
        return this._encodeTime(data, tag);
      else if (tag === "null_")
        return this._encodeNull();
      else if (tag === "int" || tag === "enum")
        return this._encodeInt(data, state.args && state.reverseArgs[0]);
      else if (tag === "bool")
        return this._encodeBool(data);
      else if (tag === "objDesc")
        return this._encodeStr(data, tag);
      else
        throw new Error("Unsupported tag: " + tag);
    };
    Node.prototype._isNumstr = function isNumstr(str) {
      return /^[0-9 ]*$/.test(str);
    };
    Node.prototype._isPrintstr = function isPrintstr(str) {
      return /^[A-Za-z0-9 '()+,-./:=?]*$/.test(str);
    };
  }
});

// node_modules/asn1.js/lib/asn1/constants/der.js
var require_der = __commonJS({
  "node_modules/asn1.js/lib/asn1/constants/der.js"(exports2) {
    "use strict";
    function reverse(map) {
      const res = {};
      Object.keys(map).forEach(function(key) {
        if ((key | 0) == key)
          key = key | 0;
        const value = map[key];
        res[value] = key;
      });
      return res;
    }
    exports2.tagClass = {
      0: "universal",
      1: "application",
      2: "context",
      3: "private"
    };
    exports2.tagClassByName = reverse(exports2.tagClass);
    exports2.tag = {
      0: "end",
      1: "bool",
      2: "int",
      3: "bitstr",
      4: "octstr",
      5: "null_",
      6: "objid",
      7: "objDesc",
      8: "external",
      9: "real",
      10: "enum",
      11: "embed",
      12: "utf8str",
      13: "relativeOid",
      16: "seq",
      17: "set",
      18: "numstr",
      19: "printstr",
      20: "t61str",
      21: "videostr",
      22: "ia5str",
      23: "utctime",
      24: "gentime",
      25: "graphstr",
      26: "iso646str",
      27: "genstr",
      28: "unistr",
      29: "charstr",
      30: "bmpstr"
    };
    exports2.tagByName = reverse(exports2.tag);
  }
});

// node_modules/asn1.js/lib/asn1/encoders/der.js
var require_der2 = __commonJS({
  "node_modules/asn1.js/lib/asn1/encoders/der.js"(exports2, module2) {
    "use strict";
    var inherits = require_inherits();
    var Buffer2 = require_safer().Buffer;
    var Node = require_node();
    var der = require_der();
    function DEREncoder(entity) {
      this.enc = "der";
      this.name = entity.name;
      this.entity = entity;
      this.tree = new DERNode();
      this.tree._init(entity.body);
    }
    module2.exports = DEREncoder;
    DEREncoder.prototype.encode = function encode(data, reporter) {
      return this.tree._encode(data, reporter).join();
    };
    function DERNode(parent) {
      Node.call(this, "der", parent);
    }
    inherits(DERNode, Node);
    DERNode.prototype._encodeComposite = function encodeComposite(tag, primitive, cls, content) {
      const encodedTag = encodeTag(tag, primitive, cls, this.reporter);
      if (content.length < 128) {
        const header2 = Buffer2.alloc(2);
        header2[0] = encodedTag;
        header2[1] = content.length;
        return this._createEncoderBuffer([header2, content]);
      }
      let lenOctets = 1;
      for (let i = content.length; i >= 256; i >>= 8)
        lenOctets++;
      const header = Buffer2.alloc(1 + 1 + lenOctets);
      header[0] = encodedTag;
      header[1] = 128 | lenOctets;
      for (let i = 1 + lenOctets, j = content.length; j > 0; i--, j >>= 8)
        header[i] = j & 255;
      return this._createEncoderBuffer([header, content]);
    };
    DERNode.prototype._encodeStr = function encodeStr(str, tag) {
      if (tag === "bitstr") {
        return this._createEncoderBuffer([str.unused | 0, str.data]);
      } else if (tag === "bmpstr") {
        const buf = Buffer2.alloc(str.length * 2);
        for (let i = 0; i < str.length; i++) {
          buf.writeUInt16BE(str.charCodeAt(i), i * 2);
        }
        return this._createEncoderBuffer(buf);
      } else if (tag === "numstr") {
        if (!this._isNumstr(str)) {
          return this.reporter.error("Encoding of string type: numstr supports only digits and space");
        }
        return this._createEncoderBuffer(str);
      } else if (tag === "printstr") {
        if (!this._isPrintstr(str)) {
          return this.reporter.error("Encoding of string type: printstr supports only latin upper and lower case letters, digits, space, apostrophe, left and rigth parenthesis, plus sign, comma, hyphen, dot, slash, colon, equal sign, question mark");
        }
        return this._createEncoderBuffer(str);
      } else if (/str$/.test(tag)) {
        return this._createEncoderBuffer(str);
      } else if (tag === "objDesc") {
        return this._createEncoderBuffer(str);
      } else {
        return this.reporter.error("Encoding of string type: " + tag + " unsupported");
      }
    };
    DERNode.prototype._encodeObjid = function encodeObjid(id, values, relative) {
      if (typeof id === "string") {
        if (!values)
          return this.reporter.error("string objid given, but no values map found");
        if (!values.hasOwnProperty(id))
          return this.reporter.error("objid not found in values map");
        id = values[id].split(/[\s.]+/g);
        for (let i = 0; i < id.length; i++)
          id[i] |= 0;
      } else if (Array.isArray(id)) {
        id = id.slice();
        for (let i = 0; i < id.length; i++)
          id[i] |= 0;
      }
      if (!Array.isArray(id)) {
        return this.reporter.error("objid() should be either array or string, got: " + JSON.stringify(id));
      }
      if (!relative) {
        if (id[1] >= 40)
          return this.reporter.error("Second objid identifier OOB");
        id.splice(0, 2, id[0] * 40 + id[1]);
      }
      let size = 0;
      for (let i = 0; i < id.length; i++) {
        let ident = id[i];
        for (size++; ident >= 128; ident >>= 7)
          size++;
      }
      const objid = Buffer2.alloc(size);
      let offset = objid.length - 1;
      for (let i = id.length - 1; i >= 0; i--) {
        let ident = id[i];
        objid[offset--] = ident & 127;
        while ((ident >>= 7) > 0)
          objid[offset--] = 128 | ident & 127;
      }
      return this._createEncoderBuffer(objid);
    };
    function two(num) {
      if (num < 10)
        return "0" + num;
      else
        return num;
    }
    DERNode.prototype._encodeTime = function encodeTime(time, tag) {
      let str;
      const date = new Date(time);
      if (tag === "gentime") {
        str = [
          two(date.getUTCFullYear()),
          two(date.getUTCMonth() + 1),
          two(date.getUTCDate()),
          two(date.getUTCHours()),
          two(date.getUTCMinutes()),
          two(date.getUTCSeconds()),
          "Z"
        ].join("");
      } else if (tag === "utctime") {
        str = [
          two(date.getUTCFullYear() % 100),
          two(date.getUTCMonth() + 1),
          two(date.getUTCDate()),
          two(date.getUTCHours()),
          two(date.getUTCMinutes()),
          two(date.getUTCSeconds()),
          "Z"
        ].join("");
      } else {
        this.reporter.error("Encoding " + tag + " time is not supported yet");
      }
      return this._encodeStr(str, "octstr");
    };
    DERNode.prototype._encodeNull = function encodeNull() {
      return this._createEncoderBuffer("");
    };
    DERNode.prototype._encodeInt = function encodeInt(num, values) {
      if (typeof num === "string") {
        if (!values)
          return this.reporter.error("String int or enum given, but no values map");
        if (!values.hasOwnProperty(num)) {
          return this.reporter.error("Values map doesn't contain: " + JSON.stringify(num));
        }
        num = values[num];
      }
      if (typeof num !== "number" && !Buffer2.isBuffer(num)) {
        const numArray = num.toArray();
        if (!num.sign && numArray[0] & 128) {
          numArray.unshift(0);
        }
        num = Buffer2.from(numArray);
      }
      if (Buffer2.isBuffer(num)) {
        let size2 = num.length;
        if (num.length === 0)
          size2++;
        const out2 = Buffer2.alloc(size2);
        num.copy(out2);
        if (num.length === 0)
          out2[0] = 0;
        return this._createEncoderBuffer(out2);
      }
      if (num < 128)
        return this._createEncoderBuffer(num);
      if (num < 256)
        return this._createEncoderBuffer([0, num]);
      let size = 1;
      for (let i = num; i >= 256; i >>= 8)
        size++;
      const out = new Array(size);
      for (let i = out.length - 1; i >= 0; i--) {
        out[i] = num & 255;
        num >>= 8;
      }
      if (out[0] & 128) {
        out.unshift(0);
      }
      return this._createEncoderBuffer(Buffer2.from(out));
    };
    DERNode.prototype._encodeBool = function encodeBool(value) {
      return this._createEncoderBuffer(value ? 255 : 0);
    };
    DERNode.prototype._use = function use(entity, obj) {
      if (typeof entity === "function")
        entity = entity(obj);
      return entity._getEncoder("der").tree;
    };
    DERNode.prototype._skipDefault = function skipDefault(dataBuffer, reporter, parent) {
      const state = this._baseState;
      let i;
      if (state["default"] === null)
        return false;
      const data = dataBuffer.join();
      if (state.defaultBuffer === void 0)
        state.defaultBuffer = this._encodeValue(state["default"], reporter, parent).join();
      if (data.length !== state.defaultBuffer.length)
        return false;
      for (i = 0; i < data.length; i++)
        if (data[i] !== state.defaultBuffer[i])
          return false;
      return true;
    };
    function encodeTag(tag, primitive, cls, reporter) {
      let res;
      if (tag === "seqof")
        tag = "seq";
      else if (tag === "setof")
        tag = "set";
      if (der.tagByName.hasOwnProperty(tag))
        res = der.tagByName[tag];
      else if (typeof tag === "number" && (tag | 0) === tag)
        res = tag;
      else
        return reporter.error("Unknown tag: " + tag);
      if (res >= 31)
        return reporter.error("Multi-octet tag encoding unsupported");
      if (!primitive)
        res |= 32;
      res |= der.tagClassByName[cls || "universal"] << 6;
      return res;
    }
  }
});

// node_modules/asn1.js/lib/asn1/encoders/pem.js
var require_pem = __commonJS({
  "node_modules/asn1.js/lib/asn1/encoders/pem.js"(exports2, module2) {
    "use strict";
    var inherits = require_inherits();
    var DEREncoder = require_der2();
    function PEMEncoder(entity) {
      DEREncoder.call(this, entity);
      this.enc = "pem";
    }
    inherits(PEMEncoder, DEREncoder);
    module2.exports = PEMEncoder;
    PEMEncoder.prototype.encode = function encode(data, options) {
      const buf = DEREncoder.prototype.encode.call(this, data);
      const p = buf.toString("base64");
      const out = ["-----BEGIN " + options.label + "-----"];
      for (let i = 0; i < p.length; i += 64)
        out.push(p.slice(i, i + 64));
      out.push("-----END " + options.label + "-----");
      return out.join("\n");
    };
  }
});

// node_modules/asn1.js/lib/asn1/encoders/index.js
var require_encoders = __commonJS({
  "node_modules/asn1.js/lib/asn1/encoders/index.js"(exports2) {
    "use strict";
    var encoders = exports2;
    encoders.der = require_der2();
    encoders.pem = require_pem();
  }
});

// node_modules/asn1.js/lib/asn1/decoders/der.js
var require_der3 = __commonJS({
  "node_modules/asn1.js/lib/asn1/decoders/der.js"(exports2, module2) {
    "use strict";
    var inherits = require_inherits();
    var bignum = require_bn();
    var DecoderBuffer = require_buffer().DecoderBuffer;
    var Node = require_node();
    var der = require_der();
    function DERDecoder(entity) {
      this.enc = "der";
      this.name = entity.name;
      this.entity = entity;
      this.tree = new DERNode();
      this.tree._init(entity.body);
    }
    module2.exports = DERDecoder;
    DERDecoder.prototype.decode = function decode(data, options) {
      if (!DecoderBuffer.isDecoderBuffer(data)) {
        data = new DecoderBuffer(data, options);
      }
      return this.tree._decode(data, options);
    };
    function DERNode(parent) {
      Node.call(this, "der", parent);
    }
    inherits(DERNode, Node);
    DERNode.prototype._peekTag = function peekTag(buffer, tag, any) {
      if (buffer.isEmpty())
        return false;
      const state = buffer.save();
      const decodedTag = derDecodeTag(buffer, 'Failed to peek tag: "' + tag + '"');
      if (buffer.isError(decodedTag))
        return decodedTag;
      buffer.restore(state);
      return decodedTag.tag === tag || decodedTag.tagStr === tag || decodedTag.tagStr + "of" === tag || any;
    };
    DERNode.prototype._decodeTag = function decodeTag(buffer, tag, any) {
      const decodedTag = derDecodeTag(
        buffer,
        'Failed to decode tag of "' + tag + '"'
      );
      if (buffer.isError(decodedTag))
        return decodedTag;
      let len = derDecodeLen(
        buffer,
        decodedTag.primitive,
        'Failed to get length of "' + tag + '"'
      );
      if (buffer.isError(len))
        return len;
      if (!any && decodedTag.tag !== tag && decodedTag.tagStr !== tag && decodedTag.tagStr + "of" !== tag) {
        return buffer.error('Failed to match tag: "' + tag + '"');
      }
      if (decodedTag.primitive || len !== null)
        return buffer.skip(len, 'Failed to match body of: "' + tag + '"');
      const state = buffer.save();
      const res = this._skipUntilEnd(
        buffer,
        'Failed to skip indefinite length body: "' + this.tag + '"'
      );
      if (buffer.isError(res))
        return res;
      len = buffer.offset - state.offset;
      buffer.restore(state);
      return buffer.skip(len, 'Failed to match body of: "' + tag + '"');
    };
    DERNode.prototype._skipUntilEnd = function skipUntilEnd(buffer, fail) {
      for (; ; ) {
        const tag = derDecodeTag(buffer, fail);
        if (buffer.isError(tag))
          return tag;
        const len = derDecodeLen(buffer, tag.primitive, fail);
        if (buffer.isError(len))
          return len;
        let res;
        if (tag.primitive || len !== null)
          res = buffer.skip(len);
        else
          res = this._skipUntilEnd(buffer, fail);
        if (buffer.isError(res))
          return res;
        if (tag.tagStr === "end")
          break;
      }
    };
    DERNode.prototype._decodeList = function decodeList(buffer, tag, decoder, options) {
      const result = [];
      while (!buffer.isEmpty()) {
        const possibleEnd = this._peekTag(buffer, "end");
        if (buffer.isError(possibleEnd))
          return possibleEnd;
        const res = decoder.decode(buffer, "der", options);
        if (buffer.isError(res) && possibleEnd)
          break;
        result.push(res);
      }
      return result;
    };
    DERNode.prototype._decodeStr = function decodeStr(buffer, tag) {
      if (tag === "bitstr") {
        const unused = buffer.readUInt8();
        if (buffer.isError(unused))
          return unused;
        return { unused, data: buffer.raw() };
      } else if (tag === "bmpstr") {
        const raw = buffer.raw();
        if (raw.length % 2 === 1)
          return buffer.error("Decoding of string type: bmpstr length mismatch");
        let str = "";
        for (let i = 0; i < raw.length / 2; i++) {
          str += String.fromCharCode(raw.readUInt16BE(i * 2));
        }
        return str;
      } else if (tag === "numstr") {
        const numstr = buffer.raw().toString("ascii");
        if (!this._isNumstr(numstr)) {
          return buffer.error("Decoding of string type: numstr unsupported characters");
        }
        return numstr;
      } else if (tag === "octstr") {
        return buffer.raw();
      } else if (tag === "objDesc") {
        return buffer.raw();
      } else if (tag === "printstr") {
        const printstr = buffer.raw().toString("ascii");
        if (!this._isPrintstr(printstr)) {
          return buffer.error("Decoding of string type: printstr unsupported characters");
        }
        return printstr;
      } else if (/str$/.test(tag)) {
        return buffer.raw().toString();
      } else {
        return buffer.error("Decoding of string type: " + tag + " unsupported");
      }
    };
    DERNode.prototype._decodeObjid = function decodeObjid(buffer, values, relative) {
      let result;
      const identifiers = [];
      let ident = 0;
      let subident = 0;
      while (!buffer.isEmpty()) {
        subident = buffer.readUInt8();
        ident <<= 7;
        ident |= subident & 127;
        if ((subident & 128) === 0) {
          identifiers.push(ident);
          ident = 0;
        }
      }
      if (subident & 128)
        identifiers.push(ident);
      const first = identifiers[0] / 40 | 0;
      const second = identifiers[0] % 40;
      if (relative)
        result = identifiers;
      else
        result = [first, second].concat(identifiers.slice(1));
      if (values) {
        let tmp = values[result.join(" ")];
        if (tmp === void 0)
          tmp = values[result.join(".")];
        if (tmp !== void 0)
          result = tmp;
      }
      return result;
    };
    DERNode.prototype._decodeTime = function decodeTime(buffer, tag) {
      const str = buffer.raw().toString();
      let year;
      let mon;
      let day;
      let hour;
      let min;
      let sec;
      if (tag === "gentime") {
        year = str.slice(0, 4) | 0;
        mon = str.slice(4, 6) | 0;
        day = str.slice(6, 8) | 0;
        hour = str.slice(8, 10) | 0;
        min = str.slice(10, 12) | 0;
        sec = str.slice(12, 14) | 0;
      } else if (tag === "utctime") {
        year = str.slice(0, 2) | 0;
        mon = str.slice(2, 4) | 0;
        day = str.slice(4, 6) | 0;
        hour = str.slice(6, 8) | 0;
        min = str.slice(8, 10) | 0;
        sec = str.slice(10, 12) | 0;
        if (year < 70)
          year = 2e3 + year;
        else
          year = 1900 + year;
      } else {
        return buffer.error("Decoding " + tag + " time is not supported yet");
      }
      return Date.UTC(year, mon - 1, day, hour, min, sec, 0);
    };
    DERNode.prototype._decodeNull = function decodeNull() {
      return null;
    };
    DERNode.prototype._decodeBool = function decodeBool(buffer) {
      const res = buffer.readUInt8();
      if (buffer.isError(res))
        return res;
      else
        return res !== 0;
    };
    DERNode.prototype._decodeInt = function decodeInt(buffer, values) {
      const raw = buffer.raw();
      let res = new bignum(raw);
      if (values)
        res = values[res.toString(10)] || res;
      return res;
    };
    DERNode.prototype._use = function use(entity, obj) {
      if (typeof entity === "function")
        entity = entity(obj);
      return entity._getDecoder("der").tree;
    };
    function derDecodeTag(buf, fail) {
      let tag = buf.readUInt8(fail);
      if (buf.isError(tag))
        return tag;
      const cls = der.tagClass[tag >> 6];
      const primitive = (tag & 32) === 0;
      if ((tag & 31) === 31) {
        let oct = tag;
        tag = 0;
        while ((oct & 128) === 128) {
          oct = buf.readUInt8(fail);
          if (buf.isError(oct))
            return oct;
          tag <<= 7;
          tag |= oct & 127;
        }
      } else {
        tag &= 31;
      }
      const tagStr = der.tag[tag];
      return {
        cls,
        primitive,
        tag,
        tagStr
      };
    }
    function derDecodeLen(buf, primitive, fail) {
      let len = buf.readUInt8(fail);
      if (buf.isError(len))
        return len;
      if (!primitive && len === 128)
        return null;
      if ((len & 128) === 0) {
        return len;
      }
      const num = len & 127;
      if (num > 4)
        return buf.error("length octect is too long");
      len = 0;
      for (let i = 0; i < num; i++) {
        len <<= 8;
        const j = buf.readUInt8(fail);
        if (buf.isError(j))
          return j;
        len |= j;
      }
      return len;
    }
  }
});

// node_modules/asn1.js/lib/asn1/decoders/pem.js
var require_pem2 = __commonJS({
  "node_modules/asn1.js/lib/asn1/decoders/pem.js"(exports2, module2) {
    "use strict";
    var inherits = require_inherits();
    var Buffer2 = require_safer().Buffer;
    var DERDecoder = require_der3();
    function PEMDecoder(entity) {
      DERDecoder.call(this, entity);
      this.enc = "pem";
    }
    inherits(PEMDecoder, DERDecoder);
    module2.exports = PEMDecoder;
    PEMDecoder.prototype.decode = function decode(data, options) {
      const lines = data.toString().split(/[\r\n]+/g);
      const label = options.label.toUpperCase();
      const re = /^-----(BEGIN|END) ([^-]+)-----$/;
      let start = -1;
      let end = -1;
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(re);
        if (match === null)
          continue;
        if (match[2] !== label)
          continue;
        if (start === -1) {
          if (match[1] !== "BEGIN")
            break;
          start = i;
        } else {
          if (match[1] !== "END")
            break;
          end = i;
          break;
        }
      }
      if (start === -1 || end === -1)
        throw new Error("PEM section not found for: " + label);
      const base64 = lines.slice(start + 1, end).join("");
      base64.replace(/[^a-z0-9+/=]+/gi, "");
      const input = Buffer2.from(base64, "base64");
      return DERDecoder.prototype.decode.call(this, input, options);
    };
  }
});

// node_modules/asn1.js/lib/asn1/decoders/index.js
var require_decoders = __commonJS({
  "node_modules/asn1.js/lib/asn1/decoders/index.js"(exports2) {
    "use strict";
    var decoders = exports2;
    decoders.der = require_der3();
    decoders.pem = require_pem2();
  }
});

// node_modules/asn1.js/lib/asn1/api.js
var require_api = __commonJS({
  "node_modules/asn1.js/lib/asn1/api.js"(exports2) {
    "use strict";
    var encoders = require_encoders();
    var decoders = require_decoders();
    var inherits = require_inherits();
    var api = exports2;
    api.define = function define(name, body) {
      return new Entity(name, body);
    };
    function Entity(name, body) {
      this.name = name;
      this.body = body;
      this.decoders = {};
      this.encoders = {};
    }
    Entity.prototype._createNamed = function createNamed(Base) {
      const name = this.name;
      function Generated(entity) {
        this._initNamed(entity, name);
      }
      inherits(Generated, Base);
      Generated.prototype._initNamed = function _initNamed(entity, name2) {
        Base.call(this, entity, name2);
      };
      return new Generated(this);
    };
    Entity.prototype._getDecoder = function _getDecoder(enc) {
      enc = enc || "der";
      if (!this.decoders.hasOwnProperty(enc))
        this.decoders[enc] = this._createNamed(decoders[enc]);
      return this.decoders[enc];
    };
    Entity.prototype.decode = function decode(data, enc, options) {
      return this._getDecoder(enc).decode(data, options);
    };
    Entity.prototype._getEncoder = function _getEncoder(enc) {
      enc = enc || "der";
      if (!this.encoders.hasOwnProperty(enc))
        this.encoders[enc] = this._createNamed(encoders[enc]);
      return this.encoders[enc];
    };
    Entity.prototype.encode = function encode(data, enc, reporter) {
      return this._getEncoder(enc).encode(data, reporter);
    };
  }
});

// node_modules/asn1.js/lib/asn1/base/index.js
var require_base = __commonJS({
  "node_modules/asn1.js/lib/asn1/base/index.js"(exports2) {
    "use strict";
    var base = exports2;
    base.Reporter = require_reporter().Reporter;
    base.DecoderBuffer = require_buffer().DecoderBuffer;
    base.EncoderBuffer = require_buffer().EncoderBuffer;
    base.Node = require_node();
  }
});

// node_modules/asn1.js/lib/asn1/constants/index.js
var require_constants = __commonJS({
  "node_modules/asn1.js/lib/asn1/constants/index.js"(exports2) {
    "use strict";
    var constants = exports2;
    constants._reverse = function reverse(map) {
      const res = {};
      Object.keys(map).forEach(function(key) {
        if ((key | 0) == key)
          key = key | 0;
        const value = map[key];
        res[value] = key;
      });
      return res;
    };
    constants.der = require_der();
  }
});

// node_modules/asn1.js/lib/asn1.js
var require_asn1 = __commonJS({
  "node_modules/asn1.js/lib/asn1.js"(exports2) {
    "use strict";
    var asn1 = exports2;
    asn1.bignum = require_bn();
    asn1.define = require_api().define;
    asn1.base = require_base();
    asn1.constants = require_constants();
    asn1.decoders = require_decoders();
    asn1.encoders = require_encoders();
  }
});

// node_modules/safe-buffer/index.js
var require_safe_buffer = __commonJS({
  "node_modules/safe-buffer/index.js"(exports2, module2) {
    var buffer = require("buffer");
    var Buffer2 = buffer.Buffer;
    function copyProps(src, dst) {
      for (var key in src) {
        dst[key] = src[key];
      }
    }
    if (Buffer2.from && Buffer2.alloc && Buffer2.allocUnsafe && Buffer2.allocUnsafeSlow) {
      module2.exports = buffer;
    } else {
      copyProps(buffer, exports2);
      exports2.Buffer = SafeBuffer;
    }
    function SafeBuffer(arg, encodingOrOffset, length) {
      return Buffer2(arg, encodingOrOffset, length);
    }
    SafeBuffer.prototype = Object.create(Buffer2.prototype);
    copyProps(Buffer2, SafeBuffer);
    SafeBuffer.from = function(arg, encodingOrOffset, length) {
      if (typeof arg === "number") {
        throw new TypeError("Argument must not be a number");
      }
      return Buffer2(arg, encodingOrOffset, length);
    };
    SafeBuffer.alloc = function(size, fill, encoding) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      var buf = Buffer2(size);
      if (fill !== void 0) {
        if (typeof encoding === "string") {
          buf.fill(fill, encoding);
        } else {
          buf.fill(fill);
        }
      } else {
        buf.fill(0);
      }
      return buf;
    };
    SafeBuffer.allocUnsafe = function(size) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      return Buffer2(size);
    };
    SafeBuffer.allocUnsafeSlow = function(size) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      return buffer.SlowBuffer(size);
    };
  }
});

// node_modules/jws/lib/data-stream.js
var require_data_stream = __commonJS({
  "node_modules/jws/lib/data-stream.js"(exports2, module2) {
    var Buffer2 = require_safe_buffer().Buffer;
    var Stream = require("stream");
    var util = require("util");
    function DataStream(data) {
      this.buffer = null;
      this.writable = true;
      this.readable = true;
      if (!data) {
        this.buffer = Buffer2.alloc(0);
        return this;
      }
      if (typeof data.pipe === "function") {
        this.buffer = Buffer2.alloc(0);
        data.pipe(this);
        return this;
      }
      if (data.length || typeof data === "object") {
        this.buffer = data;
        this.writable = false;
        process.nextTick(function() {
          this.emit("end", data);
          this.readable = false;
          this.emit("close");
        }.bind(this));
        return this;
      }
      throw new TypeError("Unexpected data type (" + typeof data + ")");
    }
    util.inherits(DataStream, Stream);
    DataStream.prototype.write = function write(data) {
      this.buffer = Buffer2.concat([this.buffer, Buffer2.from(data)]);
      this.emit("data", data);
    };
    DataStream.prototype.end = function end(data) {
      if (data)
        this.write(data);
      this.emit("end", data);
      this.emit("close");
      this.writable = false;
      this.readable = false;
    };
    module2.exports = DataStream;
  }
});

// node_modules/ecdsa-sig-formatter/src/param-bytes-for-alg.js
var require_param_bytes_for_alg = __commonJS({
  "node_modules/ecdsa-sig-formatter/src/param-bytes-for-alg.js"(exports2, module2) {
    "use strict";
    function getParamSize(keySize) {
      var result = (keySize / 8 | 0) + (keySize % 8 === 0 ? 0 : 1);
      return result;
    }
    var paramBytesForAlg = {
      ES256: getParamSize(256),
      ES384: getParamSize(384),
      ES512: getParamSize(521)
    };
    function getParamBytesForAlg(alg) {
      var paramBytes = paramBytesForAlg[alg];
      if (paramBytes) {
        return paramBytes;
      }
      throw new Error('Unknown algorithm "' + alg + '"');
    }
    module2.exports = getParamBytesForAlg;
  }
});

// node_modules/ecdsa-sig-formatter/src/ecdsa-sig-formatter.js
var require_ecdsa_sig_formatter = __commonJS({
  "node_modules/ecdsa-sig-formatter/src/ecdsa-sig-formatter.js"(exports2, module2) {
    "use strict";
    var Buffer2 = require_safe_buffer().Buffer;
    var getParamBytesForAlg = require_param_bytes_for_alg();
    var MAX_OCTET = 128;
    var CLASS_UNIVERSAL = 0;
    var PRIMITIVE_BIT = 32;
    var TAG_SEQ = 16;
    var TAG_INT = 2;
    var ENCODED_TAG_SEQ = TAG_SEQ | PRIMITIVE_BIT | CLASS_UNIVERSAL << 6;
    var ENCODED_TAG_INT = TAG_INT | CLASS_UNIVERSAL << 6;
    function base64Url(base64) {
      return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }
    function signatureAsBuffer(signature) {
      if (Buffer2.isBuffer(signature)) {
        return signature;
      } else if ("string" === typeof signature) {
        return Buffer2.from(signature, "base64");
      }
      throw new TypeError("ECDSA signature must be a Base64 string or a Buffer");
    }
    function derToJose(signature, alg) {
      signature = signatureAsBuffer(signature);
      var paramBytes = getParamBytesForAlg(alg);
      var maxEncodedParamLength = paramBytes + 1;
      var inputLength = signature.length;
      var offset = 0;
      if (signature[offset++] !== ENCODED_TAG_SEQ) {
        throw new Error('Could not find expected "seq"');
      }
      var seqLength = signature[offset++];
      if (seqLength === (MAX_OCTET | 1)) {
        seqLength = signature[offset++];
      }
      if (inputLength - offset < seqLength) {
        throw new Error('"seq" specified length of "' + seqLength + '", only "' + (inputLength - offset) + '" remaining');
      }
      if (signature[offset++] !== ENCODED_TAG_INT) {
        throw new Error('Could not find expected "int" for "r"');
      }
      var rLength = signature[offset++];
      if (inputLength - offset - 2 < rLength) {
        throw new Error('"r" specified length of "' + rLength + '", only "' + (inputLength - offset - 2) + '" available');
      }
      if (maxEncodedParamLength < rLength) {
        throw new Error('"r" specified length of "' + rLength + '", max of "' + maxEncodedParamLength + '" is acceptable');
      }
      var rOffset = offset;
      offset += rLength;
      if (signature[offset++] !== ENCODED_TAG_INT) {
        throw new Error('Could not find expected "int" for "s"');
      }
      var sLength = signature[offset++];
      if (inputLength - offset !== sLength) {
        throw new Error('"s" specified length of "' + sLength + '", expected "' + (inputLength - offset) + '"');
      }
      if (maxEncodedParamLength < sLength) {
        throw new Error('"s" specified length of "' + sLength + '", max of "' + maxEncodedParamLength + '" is acceptable');
      }
      var sOffset = offset;
      offset += sLength;
      if (offset !== inputLength) {
        throw new Error('Expected to consume entire buffer, but "' + (inputLength - offset) + '" bytes remain');
      }
      var rPadding = paramBytes - rLength, sPadding = paramBytes - sLength;
      var dst = Buffer2.allocUnsafe(rPadding + rLength + sPadding + sLength);
      for (offset = 0; offset < rPadding; ++offset) {
        dst[offset] = 0;
      }
      signature.copy(dst, offset, rOffset + Math.max(-rPadding, 0), rOffset + rLength);
      offset = paramBytes;
      for (var o = offset; offset < o + sPadding; ++offset) {
        dst[offset] = 0;
      }
      signature.copy(dst, offset, sOffset + Math.max(-sPadding, 0), sOffset + sLength);
      dst = dst.toString("base64");
      dst = base64Url(dst);
      return dst;
    }
    function countPadding(buf, start, stop) {
      var padding = 0;
      while (start + padding < stop && buf[start + padding] === 0) {
        ++padding;
      }
      var needsSign = buf[start + padding] >= MAX_OCTET;
      if (needsSign) {
        --padding;
      }
      return padding;
    }
    function joseToDer(signature, alg) {
      signature = signatureAsBuffer(signature);
      var paramBytes = getParamBytesForAlg(alg);
      var signatureBytes = signature.length;
      if (signatureBytes !== paramBytes * 2) {
        throw new TypeError('"' + alg + '" signatures must be "' + paramBytes * 2 + '" bytes, saw "' + signatureBytes + '"');
      }
      var rPadding = countPadding(signature, 0, paramBytes);
      var sPadding = countPadding(signature, paramBytes, signature.length);
      var rLength = paramBytes - rPadding;
      var sLength = paramBytes - sPadding;
      var rsBytes = 1 + 1 + rLength + 1 + 1 + sLength;
      var shortLength = rsBytes < MAX_OCTET;
      var dst = Buffer2.allocUnsafe((shortLength ? 2 : 3) + rsBytes);
      var offset = 0;
      dst[offset++] = ENCODED_TAG_SEQ;
      if (shortLength) {
        dst[offset++] = rsBytes;
      } else {
        dst[offset++] = MAX_OCTET | 1;
        dst[offset++] = rsBytes & 255;
      }
      dst[offset++] = ENCODED_TAG_INT;
      dst[offset++] = rLength;
      if (rPadding < 0) {
        dst[offset++] = 0;
        offset += signature.copy(dst, offset, 0, paramBytes);
      } else {
        offset += signature.copy(dst, offset, rPadding, paramBytes);
      }
      dst[offset++] = ENCODED_TAG_INT;
      dst[offset++] = sLength;
      if (sPadding < 0) {
        dst[offset++] = 0;
        signature.copy(dst, offset, paramBytes);
      } else {
        signature.copy(dst, offset, paramBytes + sPadding);
      }
      return dst;
    }
    module2.exports = {
      derToJose,
      joseToDer
    };
  }
});

// node_modules/buffer-equal-constant-time/index.js
var require_buffer_equal_constant_time = __commonJS({
  "node_modules/buffer-equal-constant-time/index.js"(exports2, module2) {
    "use strict";
    var Buffer2 = require("buffer").Buffer;
    var SlowBuffer = require("buffer").SlowBuffer;
    module2.exports = bufferEq;
    function bufferEq(a, b) {
      if (!Buffer2.isBuffer(a) || !Buffer2.isBuffer(b)) {
        return false;
      }
      if (a.length !== b.length) {
        return false;
      }
      var c = 0;
      for (var i = 0; i < a.length; i++) {
        c |= a[i] ^ b[i];
      }
      return c === 0;
    }
    bufferEq.install = function() {
      Buffer2.prototype.equal = SlowBuffer.prototype.equal = function equal(that) {
        return bufferEq(this, that);
      };
    };
    var origBufEqual = Buffer2.prototype.equal;
    var origSlowBufEqual = SlowBuffer.prototype.equal;
    bufferEq.restore = function() {
      Buffer2.prototype.equal = origBufEqual;
      SlowBuffer.prototype.equal = origSlowBufEqual;
    };
  }
});

// node_modules/jwa/index.js
var require_jwa = __commonJS({
  "node_modules/jwa/index.js"(exports2, module2) {
    var Buffer2 = require_safe_buffer().Buffer;
    var crypto = require("crypto");
    var formatEcdsa = require_ecdsa_sig_formatter();
    var util = require("util");
    var MSG_INVALID_ALGORITHM = '"%s" is not a valid algorithm.\n  Supported algorithms are:\n  "HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512" and "none".';
    var MSG_INVALID_SECRET = "secret must be a string or buffer";
    var MSG_INVALID_VERIFIER_KEY = "key must be a string or a buffer";
    var MSG_INVALID_SIGNER_KEY = "key must be a string, a buffer or an object";
    var supportsKeyObjects = typeof crypto.createPublicKey === "function";
    if (supportsKeyObjects) {
      MSG_INVALID_VERIFIER_KEY += " or a KeyObject";
      MSG_INVALID_SECRET += "or a KeyObject";
    }
    function checkIsPublicKey(key) {
      if (Buffer2.isBuffer(key)) {
        return;
      }
      if (typeof key === "string") {
        return;
      }
      if (!supportsKeyObjects) {
        throw typeError(MSG_INVALID_VERIFIER_KEY);
      }
      if (typeof key !== "object") {
        throw typeError(MSG_INVALID_VERIFIER_KEY);
      }
      if (typeof key.type !== "string") {
        throw typeError(MSG_INVALID_VERIFIER_KEY);
      }
      if (typeof key.asymmetricKeyType !== "string") {
        throw typeError(MSG_INVALID_VERIFIER_KEY);
      }
      if (typeof key.export !== "function") {
        throw typeError(MSG_INVALID_VERIFIER_KEY);
      }
    }
    function checkIsPrivateKey(key) {
      if (Buffer2.isBuffer(key)) {
        return;
      }
      if (typeof key === "string") {
        return;
      }
      if (typeof key === "object") {
        return;
      }
      throw typeError(MSG_INVALID_SIGNER_KEY);
    }
    function checkIsSecretKey(key) {
      if (Buffer2.isBuffer(key)) {
        return;
      }
      if (typeof key === "string") {
        return key;
      }
      if (!supportsKeyObjects) {
        throw typeError(MSG_INVALID_SECRET);
      }
      if (typeof key !== "object") {
        throw typeError(MSG_INVALID_SECRET);
      }
      if (key.type !== "secret") {
        throw typeError(MSG_INVALID_SECRET);
      }
      if (typeof key.export !== "function") {
        throw typeError(MSG_INVALID_SECRET);
      }
    }
    function fromBase64(base64) {
      return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }
    function toBase64(base64url) {
      base64url = base64url.toString();
      var padding = 4 - base64url.length % 4;
      if (padding !== 4) {
        for (var i = 0; i < padding; ++i) {
          base64url += "=";
        }
      }
      return base64url.replace(/\-/g, "+").replace(/_/g, "/");
    }
    function typeError(template) {
      var args = [].slice.call(arguments, 1);
      var errMsg = util.format.bind(util, template).apply(null, args);
      return new TypeError(errMsg);
    }
    function bufferOrString(obj) {
      return Buffer2.isBuffer(obj) || typeof obj === "string";
    }
    function normalizeInput(thing) {
      if (!bufferOrString(thing))
        thing = JSON.stringify(thing);
      return thing;
    }
    function createHmacSigner(bits) {
      return function sign(thing, secret) {
        checkIsSecretKey(secret);
        thing = normalizeInput(thing);
        var hmac = crypto.createHmac("sha" + bits, secret);
        var sig = (hmac.update(thing), hmac.digest("base64"));
        return fromBase64(sig);
      };
    }
    var bufferEqual;
    var timingSafeEqual = "timingSafeEqual" in crypto ? function timingSafeEqual2(a, b) {
      if (a.byteLength !== b.byteLength) {
        return false;
      }
      return crypto.timingSafeEqual(a, b);
    } : function timingSafeEqual2(a, b) {
      if (!bufferEqual) {
        bufferEqual = require_buffer_equal_constant_time();
      }
      return bufferEqual(a, b);
    };
    function createHmacVerifier(bits) {
      return function verify(thing, signature, secret) {
        var computedSig = createHmacSigner(bits)(thing, secret);
        return timingSafeEqual(Buffer2.from(signature), Buffer2.from(computedSig));
      };
    }
    function createKeySigner(bits) {
      return function sign(thing, privateKey) {
        checkIsPrivateKey(privateKey);
        thing = normalizeInput(thing);
        var signer = crypto.createSign("RSA-SHA" + bits);
        var sig = (signer.update(thing), signer.sign(privateKey, "base64"));
        return fromBase64(sig);
      };
    }
    function createKeyVerifier(bits) {
      return function verify(thing, signature, publicKey) {
        checkIsPublicKey(publicKey);
        thing = normalizeInput(thing);
        signature = toBase64(signature);
        var verifier = crypto.createVerify("RSA-SHA" + bits);
        verifier.update(thing);
        return verifier.verify(publicKey, signature, "base64");
      };
    }
    function createPSSKeySigner(bits) {
      return function sign(thing, privateKey) {
        checkIsPrivateKey(privateKey);
        thing = normalizeInput(thing);
        var signer = crypto.createSign("RSA-SHA" + bits);
        var sig = (signer.update(thing), signer.sign({
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
        }, "base64"));
        return fromBase64(sig);
      };
    }
    function createPSSKeyVerifier(bits) {
      return function verify(thing, signature, publicKey) {
        checkIsPublicKey(publicKey);
        thing = normalizeInput(thing);
        signature = toBase64(signature);
        var verifier = crypto.createVerify("RSA-SHA" + bits);
        verifier.update(thing);
        return verifier.verify({
          key: publicKey,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
        }, signature, "base64");
      };
    }
    function createECDSASigner(bits) {
      var inner = createKeySigner(bits);
      return function sign() {
        var signature = inner.apply(null, arguments);
        signature = formatEcdsa.derToJose(signature, "ES" + bits);
        return signature;
      };
    }
    function createECDSAVerifer(bits) {
      var inner = createKeyVerifier(bits);
      return function verify(thing, signature, publicKey) {
        signature = formatEcdsa.joseToDer(signature, "ES" + bits).toString("base64");
        var result = inner(thing, signature, publicKey);
        return result;
      };
    }
    function createNoneSigner() {
      return function sign() {
        return "";
      };
    }
    function createNoneVerifier() {
      return function verify(thing, signature) {
        return signature === "";
      };
    }
    module2.exports = function jwa(algorithm) {
      var signerFactories = {
        hs: createHmacSigner,
        rs: createKeySigner,
        ps: createPSSKeySigner,
        es: createECDSASigner,
        none: createNoneSigner
      };
      var verifierFactories = {
        hs: createHmacVerifier,
        rs: createKeyVerifier,
        ps: createPSSKeyVerifier,
        es: createECDSAVerifer,
        none: createNoneVerifier
      };
      var match = algorithm.match(/^(RS|PS|ES|HS)(256|384|512)$|^(none)$/);
      if (!match)
        throw typeError(MSG_INVALID_ALGORITHM, algorithm);
      var algo = (match[1] || match[3]).toLowerCase();
      var bits = match[2];
      return {
        sign: signerFactories[algo](bits),
        verify: verifierFactories[algo](bits)
      };
    };
  }
});

// node_modules/jws/lib/tostring.js
var require_tostring = __commonJS({
  "node_modules/jws/lib/tostring.js"(exports2, module2) {
    var Buffer2 = require("buffer").Buffer;
    module2.exports = function toString(obj) {
      if (typeof obj === "string")
        return obj;
      if (typeof obj === "number" || Buffer2.isBuffer(obj))
        return obj.toString();
      return JSON.stringify(obj);
    };
  }
});

// node_modules/jws/lib/sign-stream.js
var require_sign_stream = __commonJS({
  "node_modules/jws/lib/sign-stream.js"(exports2, module2) {
    var Buffer2 = require_safe_buffer().Buffer;
    var DataStream = require_data_stream();
    var jwa = require_jwa();
    var Stream = require("stream");
    var toString = require_tostring();
    var util = require("util");
    function base64url(string, encoding) {
      return Buffer2.from(string, encoding).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    }
    function jwsSecuredInput(header, payload, encoding) {
      encoding = encoding || "utf8";
      var encodedHeader = base64url(toString(header), "binary");
      var encodedPayload = base64url(toString(payload), encoding);
      return util.format("%s.%s", encodedHeader, encodedPayload);
    }
    function jwsSign(opts) {
      var header = opts.header;
      var payload = opts.payload;
      var secretOrKey = opts.secret || opts.privateKey;
      var encoding = opts.encoding;
      var algo = jwa(header.alg);
      var securedInput = jwsSecuredInput(header, payload, encoding);
      var signature = algo.sign(securedInput, secretOrKey);
      return util.format("%s.%s", securedInput, signature);
    }
    function SignStream(opts) {
      var secret = opts.secret;
      secret = secret == null ? opts.privateKey : secret;
      secret = secret == null ? opts.key : secret;
      if (/^hs/i.test(opts.header.alg) === true && secret == null) {
        throw new TypeError("secret must be a string or buffer or a KeyObject");
      }
      var secretStream = new DataStream(secret);
      this.readable = true;
      this.header = opts.header;
      this.encoding = opts.encoding;
      this.secret = this.privateKey = this.key = secretStream;
      this.payload = new DataStream(opts.payload);
      this.secret.once("close", function() {
        if (!this.payload.writable && this.readable)
          this.sign();
      }.bind(this));
      this.payload.once("close", function() {
        if (!this.secret.writable && this.readable)
          this.sign();
      }.bind(this));
    }
    util.inherits(SignStream, Stream);
    SignStream.prototype.sign = function sign() {
      try {
        var signature = jwsSign({
          header: this.header,
          payload: this.payload.buffer,
          secret: this.secret.buffer,
          encoding: this.encoding
        });
        this.emit("done", signature);
        this.emit("data", signature);
        this.emit("end");
        this.readable = false;
        return signature;
      } catch (e) {
        this.readable = false;
        this.emit("error", e);
        this.emit("close");
      }
    };
    SignStream.sign = jwsSign;
    module2.exports = SignStream;
  }
});

// node_modules/jws/lib/verify-stream.js
var require_verify_stream = __commonJS({
  "node_modules/jws/lib/verify-stream.js"(exports2, module2) {
    var Buffer2 = require_safe_buffer().Buffer;
    var DataStream = require_data_stream();
    var jwa = require_jwa();
    var Stream = require("stream");
    var toString = require_tostring();
    var util = require("util");
    var JWS_REGEX = /^[a-zA-Z0-9\-_]+?\.[a-zA-Z0-9\-_]+?\.([a-zA-Z0-9\-_]+)?$/;
    function isObject(thing) {
      return Object.prototype.toString.call(thing) === "[object Object]";
    }
    function safeJsonParse(thing) {
      if (isObject(thing))
        return thing;
      try {
        return JSON.parse(thing);
      } catch (e) {
        return void 0;
      }
    }
    function headerFromJWS(jwsSig) {
      var encodedHeader = jwsSig.split(".", 1)[0];
      return safeJsonParse(Buffer2.from(encodedHeader, "base64").toString("binary"));
    }
    function securedInputFromJWS(jwsSig) {
      return jwsSig.split(".", 2).join(".");
    }
    function signatureFromJWS(jwsSig) {
      return jwsSig.split(".")[2];
    }
    function payloadFromJWS(jwsSig, encoding) {
      encoding = encoding || "utf8";
      var payload = jwsSig.split(".")[1];
      return Buffer2.from(payload, "base64").toString(encoding);
    }
    function isValidJws(string) {
      return JWS_REGEX.test(string) && !!headerFromJWS(string);
    }
    function jwsVerify(jwsSig, algorithm, secretOrKey) {
      if (!algorithm) {
        var err = new Error("Missing algorithm parameter for jws.verify");
        err.code = "MISSING_ALGORITHM";
        throw err;
      }
      jwsSig = toString(jwsSig);
      var signature = signatureFromJWS(jwsSig);
      var securedInput = securedInputFromJWS(jwsSig);
      var algo = jwa(algorithm);
      return algo.verify(securedInput, signature, secretOrKey);
    }
    function jwsDecode(jwsSig, opts) {
      opts = opts || {};
      jwsSig = toString(jwsSig);
      if (!isValidJws(jwsSig))
        return null;
      var header = headerFromJWS(jwsSig);
      if (!header)
        return null;
      var payload = payloadFromJWS(jwsSig);
      if (header.typ === "JWT" || opts.json)
        payload = JSON.parse(payload, opts.encoding);
      return {
        header,
        payload,
        signature: signatureFromJWS(jwsSig)
      };
    }
    function VerifyStream(opts) {
      opts = opts || {};
      var secretOrKey = opts.secret;
      secretOrKey = secretOrKey == null ? opts.publicKey : secretOrKey;
      secretOrKey = secretOrKey == null ? opts.key : secretOrKey;
      if (/^hs/i.test(opts.algorithm) === true && secretOrKey == null) {
        throw new TypeError("secret must be a string or buffer or a KeyObject");
      }
      var secretStream = new DataStream(secretOrKey);
      this.readable = true;
      this.algorithm = opts.algorithm;
      this.encoding = opts.encoding;
      this.secret = this.publicKey = this.key = secretStream;
      this.signature = new DataStream(opts.signature);
      this.secret.once("close", function() {
        if (!this.signature.writable && this.readable)
          this.verify();
      }.bind(this));
      this.signature.once("close", function() {
        if (!this.secret.writable && this.readable)
          this.verify();
      }.bind(this));
    }
    util.inherits(VerifyStream, Stream);
    VerifyStream.prototype.verify = function verify() {
      try {
        var valid = jwsVerify(this.signature.buffer, this.algorithm, this.key.buffer);
        var obj = jwsDecode(this.signature.buffer, this.encoding);
        this.emit("done", valid, obj);
        this.emit("data", valid);
        this.emit("end");
        this.readable = false;
        return valid;
      } catch (e) {
        this.readable = false;
        this.emit("error", e);
        this.emit("close");
      }
    };
    VerifyStream.decode = jwsDecode;
    VerifyStream.isValid = isValidJws;
    VerifyStream.verify = jwsVerify;
    module2.exports = VerifyStream;
  }
});

// node_modules/jws/index.js
var require_jws = __commonJS({
  "node_modules/jws/index.js"(exports2) {
    var SignStream = require_sign_stream();
    var VerifyStream = require_verify_stream();
    var ALGORITHMS = [
      "HS256",
      "HS384",
      "HS512",
      "RS256",
      "RS384",
      "RS512",
      "PS256",
      "PS384",
      "PS512",
      "ES256",
      "ES384",
      "ES512"
    ];
    exports2.ALGORITHMS = ALGORITHMS;
    exports2.sign = SignStream.sign;
    exports2.verify = VerifyStream.verify;
    exports2.decode = VerifyStream.decode;
    exports2.isValid = VerifyStream.isValid;
    exports2.createSign = function createSign(opts) {
      return new SignStream(opts);
    };
    exports2.createVerify = function createVerify(opts) {
      return new VerifyStream(opts);
    };
  }
});

// node_modules/web-push/src/web-push-constants.js
var require_web_push_constants = __commonJS({
  "node_modules/web-push/src/web-push-constants.js"(exports2, module2) {
    "use strict";
    var WebPushConstants = {};
    WebPushConstants.supportedContentEncodings = {
      AES_GCM: "aesgcm",
      AES_128_GCM: "aes128gcm"
    };
    WebPushConstants.supportedUrgency = {
      VERY_LOW: "very-low",
      LOW: "low",
      NORMAL: "normal",
      HIGH: "high"
    };
    module2.exports = WebPushConstants;
  }
});

// node_modules/web-push/src/urlsafe-base64-helper.js
var require_urlsafe_base64_helper = __commonJS({
  "node_modules/web-push/src/urlsafe-base64-helper.js"(exports2, module2) {
    "use strict";
    function validate(base64) {
      return /^[A-Za-z0-9\-_]+$/.test(base64);
    }
    module2.exports = {
      validate
    };
  }
});

// node_modules/web-push/src/vapid-helper.js
var require_vapid_helper = __commonJS({
  "node_modules/web-push/src/vapid-helper.js"(exports2, module2) {
    "use strict";
    var crypto = require("crypto");
    var asn1 = require_asn1();
    var jws = require_jws();
    var { URL: URL2 } = require("url");
    var WebPushConstants = require_web_push_constants();
    var urlBase64Helper = require_urlsafe_base64_helper();
    var DEFAULT_EXPIRATION_SECONDS = 12 * 60 * 60;
    var MAX_EXPIRATION_SECONDS = 24 * 60 * 60;
    var ECPrivateKeyASN = asn1.define("ECPrivateKey", function() {
      this.seq().obj(
        this.key("version").int(),
        this.key("privateKey").octstr(),
        this.key("parameters").explicit(0).objid().optional(),
        this.key("publicKey").explicit(1).bitstr().optional()
      );
    });
    function toPEM(key) {
      return ECPrivateKeyASN.encode({
        version: 1,
        privateKey: key,
        parameters: [1, 2, 840, 10045, 3, 1, 7]
        // prime256v1
      }, "pem", {
        label: "EC PRIVATE KEY"
      });
    }
    function generateVAPIDKeys() {
      const curve = crypto.createECDH("prime256v1");
      curve.generateKeys();
      let publicKeyBuffer = curve.getPublicKey();
      let privateKeyBuffer = curve.getPrivateKey();
      if (privateKeyBuffer.length < 32) {
        const padding = Buffer.alloc(32 - privateKeyBuffer.length);
        padding.fill(0);
        privateKeyBuffer = Buffer.concat([padding, privateKeyBuffer]);
      }
      if (publicKeyBuffer.length < 65) {
        const padding = Buffer.alloc(65 - publicKeyBuffer.length);
        padding.fill(0);
        publicKeyBuffer = Buffer.concat([padding, publicKeyBuffer]);
      }
      return {
        publicKey: publicKeyBuffer.toString("base64url"),
        privateKey: privateKeyBuffer.toString("base64url")
      };
    }
    function validateSubject(subject) {
      if (!subject) {
        throw new Error("No subject set in vapidDetails.subject.");
      }
      if (typeof subject !== "string" || subject.length === 0) {
        throw new Error("The subject value must be a string containing an https: URL or mailto: address. " + subject);
      }
      let subjectParseResult = null;
      try {
        subjectParseResult = new URL2(subject);
      } catch (err) {
        throw new Error("Vapid subject is not a valid URL. " + subject);
      }
      if (!["https:", "mailto:"].includes(subjectParseResult.protocol)) {
        throw new Error("Vapid subject is not an https: or mailto: URL. " + subject);
      }
      if (subjectParseResult.hostname === "localhost") {
        console.warn("Vapid subject points to a localhost web URI, which is unsupported by Apple's push notification server and will result in a BadJwtToken error when sending notifications.");
      }
    }
    function validatePublicKey(publicKey) {
      if (!publicKey) {
        throw new Error("No key set vapidDetails.publicKey");
      }
      if (typeof publicKey !== "string") {
        throw new Error("Vapid public key is must be a URL safe Base 64 encoded string.");
      }
      if (!urlBase64Helper.validate(publicKey)) {
        throw new Error('Vapid public key must be a URL safe Base 64 (without "=")');
      }
      publicKey = Buffer.from(publicKey, "base64url");
      if (publicKey.length !== 65) {
        throw new Error("Vapid public key should be 65 bytes long when decoded.");
      }
    }
    function validatePrivateKey(privateKey) {
      if (!privateKey) {
        throw new Error("No key set in vapidDetails.privateKey");
      }
      if (typeof privateKey !== "string") {
        throw new Error("Vapid private key must be a URL safe Base 64 encoded string.");
      }
      if (!urlBase64Helper.validate(privateKey)) {
        throw new Error('Vapid private key must be a URL safe Base 64 (without "=")');
      }
      privateKey = Buffer.from(privateKey, "base64url");
      if (privateKey.length !== 32) {
        throw new Error("Vapid private key should be 32 bytes long when decoded.");
      }
    }
    function getFutureExpirationTimestamp(numSeconds) {
      const futureExp = /* @__PURE__ */ new Date();
      futureExp.setSeconds(futureExp.getSeconds() + numSeconds);
      return Math.floor(futureExp.getTime() / 1e3);
    }
    function validateExpiration(expiration) {
      if (!Number.isInteger(expiration)) {
        throw new Error("`expiration` value must be a number");
      }
      if (expiration < 0) {
        throw new Error("`expiration` must be a positive integer");
      }
      const maxExpirationTimestamp = getFutureExpirationTimestamp(MAX_EXPIRATION_SECONDS);
      if (expiration >= maxExpirationTimestamp) {
        throw new Error("`expiration` value is greater than maximum of 24 hours");
      }
    }
    function getVapidHeaders(audience, subject, publicKey, privateKey, contentEncoding, expiration) {
      if (!audience) {
        throw new Error("No audience could be generated for VAPID.");
      }
      if (typeof audience !== "string" || audience.length === 0) {
        throw new Error("The audience value must be a string containing the origin of a push service. " + audience);
      }
      try {
        new URL2(audience);
      } catch (err) {
        throw new Error("VAPID audience is not a url. " + audience);
      }
      validateSubject(subject);
      validatePublicKey(publicKey);
      validatePrivateKey(privateKey);
      privateKey = Buffer.from(privateKey, "base64url");
      if (expiration) {
        validateExpiration(expiration);
      } else {
        expiration = getFutureExpirationTimestamp(DEFAULT_EXPIRATION_SECONDS);
      }
      const header = {
        typ: "JWT",
        alg: "ES256"
      };
      const jwtPayload = {
        aud: audience,
        exp: expiration,
        sub: subject
      };
      const jwt = jws.sign({
        header,
        payload: jwtPayload,
        privateKey: toPEM(privateKey)
      });
      if (contentEncoding === WebPushConstants.supportedContentEncodings.AES_128_GCM) {
        return {
          Authorization: "vapid t=" + jwt + ", k=" + publicKey
        };
      }
      if (contentEncoding === WebPushConstants.supportedContentEncodings.AES_GCM) {
        return {
          Authorization: "WebPush " + jwt,
          "Crypto-Key": "p256ecdsa=" + publicKey
        };
      }
      throw new Error("Unsupported encoding type specified.");
    }
    module2.exports = {
      generateVAPIDKeys,
      getFutureExpirationTimestamp,
      getVapidHeaders,
      validateSubject,
      validatePublicKey,
      validatePrivateKey,
      validateExpiration
    };
  }
});

// node_modules/http_ece/ece.js
var require_ece = __commonJS({
  "node_modules/http_ece/ece.js"(exports2, module2) {
    "use strict";
    var crypto = require("crypto");
    var AES_GCM = "aes-128-gcm";
    var PAD_SIZE = { "aes128gcm": 1, "aesgcm": 2 };
    var TAG_LENGTH = 16;
    var KEY_LENGTH = 16;
    var NONCE_LENGTH = 12;
    var SHA_256_LENGTH = 32;
    var MODE_ENCRYPT = "encrypt";
    var MODE_DECRYPT = "decrypt";
    var keylog;
    if (process.env.ECE_KEYLOG === "1") {
      keylog = function(m, k) {
        console.warn(m + " [" + k.length + "]: " + k.toString("base64url"));
        return k;
      };
    } else {
      keylog = function(m, k) {
        return k;
      };
    }
    function decode(b) {
      if (typeof b === "string") {
        return Buffer.from(b, "base64url");
      }
      return b;
    }
    function HMAC_hash(key, input) {
      var hmac = crypto.createHmac("sha256", key);
      hmac.update(input);
      return hmac.digest();
    }
    function HKDF_extract(salt, ikm) {
      keylog("salt", salt);
      keylog("ikm", ikm);
      return keylog("extract", HMAC_hash(salt, ikm));
    }
    function HKDF_expand(prk, info2, l) {
      keylog("prk", prk);
      keylog("info", info2);
      var output = Buffer.alloc(0);
      var T = Buffer.alloc(0);
      info2 = Buffer.from(info2, "ascii");
      var counter = 0;
      var cbuf = Buffer.alloc(1);
      while (output.length < l) {
        cbuf.writeUIntBE(++counter, 0, 1);
        T = HMAC_hash(prk, Buffer.concat([T, info2, cbuf]));
        output = Buffer.concat([output, T]);
      }
      return keylog("expand", output.slice(0, l));
    }
    function HKDF(salt, ikm, info2, len) {
      return HKDF_expand(HKDF_extract(salt, ikm), info2, len);
    }
    function info(base, context) {
      var result = Buffer.concat([
        Buffer.from("Content-Encoding: " + base + "\0", "ascii"),
        context
      ]);
      keylog("info " + base, result);
      return result;
    }
    function lengthPrefix(buffer) {
      var b = Buffer.concat([Buffer.alloc(2), buffer]);
      b.writeUIntBE(buffer.length, 0, 2);
      return b;
    }
    function extractDH(header, mode) {
      var key = header.privateKey;
      var senderPubKey, receiverPubKey;
      if (mode === MODE_ENCRYPT) {
        senderPubKey = key.getPublicKey();
        receiverPubKey = header.dh;
      } else if (mode === MODE_DECRYPT) {
        senderPubKey = header.dh;
        receiverPubKey = key.getPublicKey();
      } else {
        throw new Error("Unknown mode only " + MODE_ENCRYPT + " and " + MODE_DECRYPT + " supported");
      }
      return {
        secret: key.computeSecret(header.dh),
        context: Buffer.concat([
          Buffer.from(header.keylabel, "ascii"),
          Buffer.from([0]),
          lengthPrefix(receiverPubKey),
          // user agent
          lengthPrefix(senderPubKey)
          // application server
        ])
      };
    }
    function extractSecretAndContext(header, mode) {
      var result = { secret: null, context: Buffer.alloc(0) };
      if (header.key) {
        result.secret = header.key;
        if (result.secret.length !== KEY_LENGTH) {
          throw new Error("An explicit key must be " + KEY_LENGTH + " bytes");
        }
      } else if (header.dh) {
        result = extractDH(header, mode);
      } else if (typeof header.keyid !== void 0) {
        result.secret = header.keymap[header.keyid];
      }
      if (!result.secret) {
        throw new Error("Unable to determine key");
      }
      keylog("secret", result.secret);
      keylog("context", result.context);
      if (header.authSecret) {
        result.secret = HKDF(
          header.authSecret,
          result.secret,
          info("auth", Buffer.alloc(0)),
          SHA_256_LENGTH
        );
        keylog("authsecret", result.secret);
      }
      return result;
    }
    function webpushSecret(header, mode) {
      if (!header.authSecret) {
        throw new Error("No authentication secret for webpush");
      }
      keylog("authsecret", header.authSecret);
      var remotePubKey, senderPubKey, receiverPubKey;
      if (mode === MODE_ENCRYPT) {
        senderPubKey = header.privateKey.getPublicKey();
        remotePubKey = receiverPubKey = header.dh;
      } else if (mode === MODE_DECRYPT) {
        remotePubKey = senderPubKey = header.keyid;
        receiverPubKey = header.privateKey.getPublicKey();
      } else {
        throw new Error("Unknown mode only " + MODE_ENCRYPT + " and " + MODE_DECRYPT + " supported");
      }
      keylog("remote pubkey", remotePubKey);
      keylog("sender pubkey", senderPubKey);
      keylog("receiver pubkey", receiverPubKey);
      return keylog(
        "secret dh",
        HKDF(
          header.authSecret,
          header.privateKey.computeSecret(remotePubKey),
          Buffer.concat([
            Buffer.from("WebPush: info\0"),
            receiverPubKey,
            senderPubKey
          ]),
          SHA_256_LENGTH
        )
      );
    }
    function extractSecret(header, mode, keyLookupCallback) {
      if (keyLookupCallback) {
        if (!isFunction(keyLookupCallback)) {
          throw new Error("Callback is not a function");
        }
      }
      if (header.key) {
        if (header.key.length !== KEY_LENGTH) {
          throw new Error("An explicit key must be " + KEY_LENGTH + " bytes");
        }
        return keylog("secret key", header.key);
      }
      if (!header.privateKey) {
        if (!keyLookupCallback) {
          var key = header.keymap && header.keymap[header.keyid];
        } else {
          var key = keyLookupCallback(header.keyid);
        }
        if (!key) {
          throw new Error('No saved key (keyid: "' + header.keyid + '")');
        }
        return key;
      }
      return webpushSecret(header, mode);
    }
    function deriveKeyAndNonce(header, mode, lookupKeyCallback) {
      if (!header.salt) {
        throw new Error("must include a salt parameter for " + header.version);
      }
      var keyInfo;
      var nonceInfo;
      var secret;
      if (header.version === "aesgcm") {
        var s = extractSecretAndContext(header, mode, lookupKeyCallback);
        keyInfo = info("aesgcm", s.context);
        nonceInfo = info("nonce", s.context);
        secret = s.secret;
      } else if (header.version === "aes128gcm") {
        keyInfo = Buffer.from("Content-Encoding: aes128gcm\0");
        nonceInfo = Buffer.from("Content-Encoding: nonce\0");
        secret = extractSecret(header, mode, lookupKeyCallback);
      } else {
        throw new Error("Unable to set context for mode " + header.version);
      }
      var prk = HKDF_extract(header.salt, secret);
      var result = {
        key: HKDF_expand(prk, keyInfo, KEY_LENGTH),
        nonce: HKDF_expand(prk, nonceInfo, NONCE_LENGTH)
      };
      keylog("key", result.key);
      keylog("nonce base", result.nonce);
      return result;
    }
    function parseParams(params) {
      var header = {};
      header.version = params.version || "aes128gcm";
      header.rs = parseInt(params.rs, 10);
      if (isNaN(header.rs)) {
        header.rs = 4096;
      }
      var overhead = PAD_SIZE[header.version];
      if (header.version === "aes128gcm") {
        overhead += TAG_LENGTH;
      }
      if (header.rs <= overhead) {
        throw new Error("The rs parameter has to be greater than " + overhead);
      }
      if (params.salt) {
        header.salt = decode(params.salt);
        if (header.salt.length !== KEY_LENGTH) {
          throw new Error("The salt parameter must be " + KEY_LENGTH + " bytes");
        }
      }
      header.keyid = params.keyid;
      if (params.key) {
        header.key = decode(params.key);
      } else {
        header.privateKey = params.privateKey;
        if (!header.privateKey) {
          header.keymap = params.keymap;
        }
        if (header.version !== "aes128gcm") {
          header.keylabel = params.keylabel || "P-256";
        }
        if (params.dh) {
          header.dh = decode(params.dh);
        }
      }
      if (params.authSecret) {
        header.authSecret = decode(params.authSecret);
      }
      return header;
    }
    function generateNonce(base, counter) {
      var nonce = Buffer.from(base);
      var m = nonce.readUIntBE(nonce.length - 6, 6);
      var x = ((m ^ counter) & 16777215) + ((m / 16777216 ^ counter / 16777216) & 16777215) * 16777216;
      nonce.writeUIntBE(x, nonce.length - 6, 6);
      keylog("nonce" + counter, nonce);
      return nonce;
    }
    function readHeader(buffer, header) {
      var idsz = buffer.readUIntBE(20, 1);
      header.salt = buffer.slice(0, KEY_LENGTH);
      header.rs = buffer.readUIntBE(KEY_LENGTH, 4);
      header.keyid = buffer.slice(21, 21 + idsz);
      return 21 + idsz;
    }
    function unpadLegacy(data, version) {
      var padSize = PAD_SIZE[version];
      var pad = data.readUIntBE(0, padSize);
      if (pad + padSize > data.length) {
        throw new Error("padding exceeds block size");
      }
      keylog("padding", data.slice(0, padSize + pad));
      var padCheck = Buffer.alloc(pad);
      padCheck.fill(0);
      if (padCheck.compare(data.slice(padSize, padSize + pad)) !== 0) {
        throw new Error("invalid padding");
      }
      return data.slice(padSize + pad);
    }
    function unpad(data, last) {
      var i = data.length - 1;
      while (i >= 0) {
        if (data[i]) {
          if (last) {
            if (data[i] !== 2) {
              throw new Error("last record needs to start padding with a 2");
            }
          } else {
            if (data[i] !== 1) {
              throw new Error("last record needs to start padding with a 2");
            }
          }
          return data.slice(0, i);
        }
        --i;
      }
      throw new Error("all zero plaintext");
    }
    function decryptRecord(key, counter, buffer, header, last) {
      keylog("decrypt", buffer);
      var nonce = generateNonce(key.nonce, counter);
      var gcm = crypto.createDecipheriv(AES_GCM, key.key, nonce);
      gcm.setAuthTag(buffer.slice(buffer.length - TAG_LENGTH));
      var data = gcm.update(buffer.slice(0, buffer.length - TAG_LENGTH));
      data = Buffer.concat([data, gcm.final()]);
      keylog("decrypted", data);
      if (header.version !== "aes128gcm") {
        return unpadLegacy(data, header.version);
      }
      return unpad(data, last);
    }
    function decrypt(buffer, params, keyLookupCallback) {
      var header = parseParams(params);
      if (header.version === "aes128gcm") {
        var headerLength = readHeader(buffer, header);
        buffer = buffer.slice(headerLength);
      }
      var key = deriveKeyAndNonce(header, MODE_DECRYPT, keyLookupCallback);
      var start = 0;
      var result = Buffer.alloc(0);
      var chunkSize = header.rs;
      if (header.version !== "aes128gcm") {
        chunkSize += TAG_LENGTH;
      }
      for (var i = 0; start < buffer.length; ++i) {
        var end = start + chunkSize;
        if (header.version !== "aes128gcm" && end === buffer.length) {
          throw new Error("Truncated payload");
        }
        end = Math.min(end, buffer.length);
        if (end - start <= TAG_LENGTH) {
          throw new Error("Invalid block: too small at " + i);
        }
        var block = decryptRecord(
          key,
          i,
          buffer.slice(start, end),
          header,
          end >= buffer.length
        );
        result = Buffer.concat([result, block]);
        start = end;
      }
      return result;
    }
    function encryptRecord(key, counter, buffer, pad, header, last) {
      keylog("encrypt", buffer);
      pad = pad || 0;
      var nonce = generateNonce(key.nonce, counter);
      var gcm = crypto.createCipheriv(AES_GCM, key.key, nonce);
      var ciphertext = [];
      var padSize = PAD_SIZE[header.version];
      var padding = Buffer.alloc(pad + padSize);
      padding.fill(0);
      if (header.version !== "aes128gcm") {
        padding.writeUIntBE(pad, 0, padSize);
        keylog("padding", padding);
        ciphertext.push(gcm.update(padding));
        ciphertext.push(gcm.update(buffer));
        if (!last && padding.length + buffer.length < header.rs) {
          throw new Error("Unable to pad to record size");
        }
      } else {
        ciphertext.push(gcm.update(buffer));
        padding.writeUIntBE(last ? 2 : 1, 0, 1);
        keylog("padding", padding);
        ciphertext.push(gcm.update(padding));
      }
      gcm.final();
      var tag = gcm.getAuthTag();
      if (tag.length !== TAG_LENGTH) {
        throw new Error("invalid tag generated");
      }
      ciphertext.push(tag);
      return keylog("encrypted", Buffer.concat(ciphertext));
    }
    function writeHeader(header) {
      var ints = Buffer.alloc(5);
      var keyid = Buffer.from(header.keyid || []);
      if (keyid.length > 255) {
        throw new Error("keyid is too large");
      }
      ints.writeUIntBE(header.rs, 0, 4);
      ints.writeUIntBE(keyid.length, 4, 1);
      return Buffer.concat([header.salt, ints, keyid]);
    }
    function encrypt(buffer, params, keyLookupCallback) {
      if (!Buffer.isBuffer(buffer)) {
        throw new Error("buffer argument must be a Buffer");
      }
      var header = parseParams(params);
      if (!header.salt) {
        header.salt = crypto.randomBytes(KEY_LENGTH);
      }
      var result;
      if (header.version === "aes128gcm") {
        if (header.privateKey && !header.keyid) {
          header.keyid = header.privateKey.getPublicKey();
        }
        result = writeHeader(header);
      } else {
        result = Buffer.alloc(0);
      }
      var key = deriveKeyAndNonce(header, MODE_ENCRYPT, keyLookupCallback);
      var start = 0;
      var padSize = PAD_SIZE[header.version];
      var overhead = padSize;
      if (header.version === "aes128gcm") {
        overhead += TAG_LENGTH;
      }
      var pad = isNaN(parseInt(params.pad, 10)) ? 0 : parseInt(params.pad, 10);
      var counter = 0;
      var last = false;
      while (!last) {
        var recordPad = Math.min(header.rs - overhead - 1, pad);
        if (header.version !== "aes128gcm") {
          recordPad = Math.min((1 << padSize * 8) - 1, recordPad);
        }
        if (pad > 0 && recordPad === 0) {
          ++recordPad;
        }
        pad -= recordPad;
        var end = start + header.rs - overhead - recordPad;
        if (header.version !== "aes128gcm") {
          last = end > buffer.length;
        } else {
          last = end >= buffer.length;
        }
        last = last && pad <= 0;
        var block = encryptRecord(
          key,
          counter,
          buffer.slice(start, end),
          recordPad,
          header,
          last
        );
        result = Buffer.concat([result, block]);
        start = end;
        ++counter;
      }
      return result;
    }
    function isFunction(object) {
      return typeof object === "function";
    }
    module2.exports = {
      decrypt,
      encrypt
    };
  }
});

// node_modules/web-push/src/encryption-helper.js
var require_encryption_helper = __commonJS({
  "node_modules/web-push/src/encryption-helper.js"(exports2, module2) {
    "use strict";
    var crypto = require("crypto");
    var ece = require_ece();
    var encrypt = function(userPublicKey, userAuth, payload, contentEncoding) {
      if (!userPublicKey) {
        throw new Error("No user public key provided for encryption.");
      }
      if (typeof userPublicKey !== "string") {
        throw new Error("The subscription p256dh value must be a string.");
      }
      if (Buffer.from(userPublicKey, "base64url").length !== 65) {
        throw new Error("The subscription p256dh value should be 65 bytes long.");
      }
      if (!userAuth) {
        throw new Error("No user auth provided for encryption.");
      }
      if (typeof userAuth !== "string") {
        throw new Error("The subscription auth key must be a string.");
      }
      if (Buffer.from(userAuth, "base64url").length < 16) {
        throw new Error("The subscription auth key should be at least 16 bytes long");
      }
      if (typeof payload !== "string" && !Buffer.isBuffer(payload)) {
        throw new Error("Payload must be either a string or a Node Buffer.");
      }
      if (typeof payload === "string" || payload instanceof String) {
        payload = Buffer.from(payload);
      }
      const localCurve = crypto.createECDH("prime256v1");
      const localPublicKey = localCurve.generateKeys();
      const salt = crypto.randomBytes(16).toString("base64url");
      const cipherText = ece.encrypt(payload, {
        version: contentEncoding,
        dh: userPublicKey,
        privateKey: localCurve,
        salt,
        authSecret: userAuth
      });
      return {
        localPublicKey,
        salt,
        cipherText
      };
    };
    module2.exports = {
      encrypt
    };
  }
});

// node_modules/web-push/src/web-push-error.js
var require_web_push_error = __commonJS({
  "node_modules/web-push/src/web-push-error.js"(exports2, module2) {
    "use strict";
    function WebPushError(message, statusCode, headers, body, endpoint) {
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
      this.message = message;
      this.statusCode = statusCode;
      this.headers = headers;
      this.body = body;
      this.endpoint = endpoint;
    }
    require("util").inherits(WebPushError, Error);
    module2.exports = WebPushError;
  }
});

// node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/ms/index.js"(exports2, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return Math.round(ms / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms / s) + "s";
      }
      return ms + "ms";
    }
    function fmtLong(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return plural(ms, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms, msAbs, s, "second");
      }
      return ms + " ms";
    }
    function plural(ms, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms / n) + " " + name + (isPlural ? "s" : "");
    }
  }
});

// node_modules/debug/src/common.js
var require_common = __commonJS({
  "node_modules/debug/src/common.js"(exports2, module2) {
    function setup(env) {
      createDebug.debug = createDebug;
      createDebug.default = createDebug;
      createDebug.coerce = coerce;
      createDebug.disable = disable;
      createDebug.enable = enable;
      createDebug.enabled = enabled;
      createDebug.humanize = require_ms();
      createDebug.destroy = destroy;
      Object.keys(env).forEach((key) => {
        createDebug[key] = env[key];
      });
      createDebug.names = [];
      createDebug.skips = [];
      createDebug.formatters = {};
      function selectColor(namespace) {
        let hash = 0;
        for (let i = 0; i < namespace.length; i++) {
          hash = (hash << 5) - hash + namespace.charCodeAt(i);
          hash |= 0;
        }
        return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
      }
      createDebug.selectColor = selectColor;
      function createDebug(namespace) {
        let prevTime;
        let enableOverride = null;
        let namespacesCache;
        let enabledCache;
        function debug(...args) {
          if (!debug.enabled) {
            return;
          }
          const self = debug;
          const curr = Number(/* @__PURE__ */ new Date());
          const ms = curr - (prevTime || curr);
          self.diff = ms;
          self.prev = prevTime;
          self.curr = curr;
          prevTime = curr;
          args[0] = createDebug.coerce(args[0]);
          if (typeof args[0] !== "string") {
            args.unshift("%O");
          }
          let index = 0;
          args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
            if (match === "%%") {
              return "%";
            }
            index++;
            const formatter = createDebug.formatters[format];
            if (typeof formatter === "function") {
              const val = args[index];
              match = formatter.call(self, val);
              args.splice(index, 1);
              index--;
            }
            return match;
          });
          createDebug.formatArgs.call(self, args);
          const logFn = self.log || createDebug.log;
          logFn.apply(self, args);
        }
        debug.namespace = namespace;
        debug.useColors = createDebug.useColors();
        debug.color = createDebug.selectColor(namespace);
        debug.extend = extend;
        debug.destroy = createDebug.destroy;
        Object.defineProperty(debug, "enabled", {
          enumerable: true,
          configurable: false,
          get: () => {
            if (enableOverride !== null) {
              return enableOverride;
            }
            if (namespacesCache !== createDebug.namespaces) {
              namespacesCache = createDebug.namespaces;
              enabledCache = createDebug.enabled(namespace);
            }
            return enabledCache;
          },
          set: (v) => {
            enableOverride = v;
          }
        });
        if (typeof createDebug.init === "function") {
          createDebug.init(debug);
        }
        return debug;
      }
      function extend(namespace, delimiter) {
        const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
        newDebug.log = this.log;
        return newDebug;
      }
      function enable(namespaces) {
        createDebug.save(namespaces);
        createDebug.namespaces = namespaces;
        createDebug.names = [];
        createDebug.skips = [];
        const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
        for (const ns of split) {
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      }
      function matchesTemplate(search, template) {
        let searchIndex = 0;
        let templateIndex = 0;
        let starIndex = -1;
        let matchIndex = 0;
        while (searchIndex < search.length) {
          if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
            if (template[templateIndex] === "*") {
              starIndex = templateIndex;
              matchIndex = searchIndex;
              templateIndex++;
            } else {
              searchIndex++;
              templateIndex++;
            }
          } else if (starIndex !== -1) {
            templateIndex = starIndex + 1;
            matchIndex++;
            searchIndex = matchIndex;
          } else {
            return false;
          }
        }
        while (templateIndex < template.length && template[templateIndex] === "*") {
          templateIndex++;
        }
        return templateIndex === template.length;
      }
      function disable() {
        const namespaces = [
          ...createDebug.names,
          ...createDebug.skips.map((namespace) => "-" + namespace)
        ].join(",");
        createDebug.enable("");
        return namespaces;
      }
      function enabled(name) {
        for (const skip of createDebug.skips) {
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
        for (const ns of createDebug.names) {
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
        return false;
      }
      function coerce(val) {
        if (val instanceof Error) {
          return val.stack || val.message;
        }
        return val;
      }
      function destroy() {
        console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
      }
      createDebug.enable(createDebug.load());
      return createDebug;
    }
    module2.exports = setup;
  }
});

// node_modules/debug/src/browser.js
var require_browser = __commonJS({
  "node_modules/debug/src/browser.js"(exports2, module2) {
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.storage = localstorage();
    exports2.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports2.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module2.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports2.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports2.storage.setItem("debug", namespaces);
        } else {
          exports2.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports2.storage.getItem("debug") || exports2.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  }
});

// node_modules/debug/src/node.js
var require_node2 = __commonJS({
  "node_modules/debug/src/node.js"(exports2, module2) {
    var tty = require("tty");
    var util = require("util");
    exports2.init = init;
    exports2.log = log;
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports2.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = require("supports-color");
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports2.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports2.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports2.inspectOpts ? Boolean(exports2.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module2.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports2.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports2.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug) {
      debug.inspectOpts = {};
      const keys = Object.keys(exports2.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug.inspectOpts[keys[i]] = exports2.inspectOpts[keys[i]];
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  }
});

// node_modules/debug/src/index.js
var require_src = __commonJS({
  "node_modules/debug/src/index.js"(exports2, module2) {
    if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
      module2.exports = require_browser();
    } else {
      module2.exports = require_node2();
    }
  }
});

// node_modules/agent-base/dist/helpers.js
var require_helpers = __commonJS({
  "node_modules/agent-base/dist/helpers.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    } : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.req = exports2.json = exports2.toBuffer = void 0;
    var http = __importStar(require("http"));
    var https = __importStar(require("https"));
    async function toBuffer(stream) {
      let length = 0;
      const chunks = [];
      for await (const chunk of stream) {
        length += chunk.length;
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    }
    exports2.toBuffer = toBuffer;
    async function json(stream) {
      const buf = await toBuffer(stream);
      const str = buf.toString("utf8");
      try {
        return JSON.parse(str);
      } catch (_err) {
        const err = _err;
        err.message += ` (input: ${str})`;
        throw err;
      }
    }
    exports2.json = json;
    function req(url, opts = {}) {
      const href = typeof url === "string" ? url : url.href;
      const req2 = (href.startsWith("https:") ? https : http).request(url, opts);
      const promise = new Promise((resolve, reject) => {
        req2.once("response", resolve).once("error", reject).end();
      });
      req2.then = promise.then.bind(promise);
      return req2;
    }
    exports2.req = req;
  }
});

// node_modules/agent-base/dist/index.js
var require_dist = __commonJS({
  "node_modules/agent-base/dist/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    } : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Agent = void 0;
    var net = __importStar(require("net"));
    var http = __importStar(require("http"));
    var https_1 = require("https");
    __exportStar(require_helpers(), exports2);
    var INTERNAL = Symbol("AgentBaseInternalState");
    var Agent = class extends http.Agent {
      constructor(opts) {
        super(opts);
        this[INTERNAL] = {};
      }
      /**
       * Determine whether this is an `http` or `https` request.
       */
      isSecureEndpoint(options) {
        if (options) {
          if (typeof options.secureEndpoint === "boolean") {
            return options.secureEndpoint;
          }
          if (typeof options.protocol === "string") {
            return options.protocol === "https:";
          }
        }
        const { stack } = new Error();
        if (typeof stack !== "string")
          return false;
        return stack.split("\n").some((l) => l.indexOf("(https.js:") !== -1 || l.indexOf("node:https:") !== -1);
      }
      // In order to support async signatures in `connect()` and Node's native
      // connection pooling in `http.Agent`, the array of sockets for each origin
      // has to be updated synchronously. This is so the length of the array is
      // accurate when `addRequest()` is next called. We achieve this by creating a
      // fake socket and adding it to `sockets[origin]` and incrementing
      // `totalSocketCount`.
      incrementSockets(name) {
        if (this.maxSockets === Infinity && this.maxTotalSockets === Infinity) {
          return null;
        }
        if (!this.sockets[name]) {
          this.sockets[name] = [];
        }
        const fakeSocket = new net.Socket({ writable: false });
        this.sockets[name].push(fakeSocket);
        this.totalSocketCount++;
        return fakeSocket;
      }
      decrementSockets(name, socket) {
        if (!this.sockets[name] || socket === null) {
          return;
        }
        const sockets = this.sockets[name];
        const index = sockets.indexOf(socket);
        if (index !== -1) {
          sockets.splice(index, 1);
          this.totalSocketCount--;
          if (sockets.length === 0) {
            delete this.sockets[name];
          }
        }
      }
      // In order to properly update the socket pool, we need to call `getName()` on
      // the core `https.Agent` if it is a secureEndpoint.
      getName(options) {
        const secureEndpoint = this.isSecureEndpoint(options);
        if (secureEndpoint) {
          return https_1.Agent.prototype.getName.call(this, options);
        }
        return super.getName(options);
      }
      createSocket(req, options, cb) {
        const connectOpts = {
          ...options,
          secureEndpoint: this.isSecureEndpoint(options)
        };
        const name = this.getName(connectOpts);
        const fakeSocket = this.incrementSockets(name);
        Promise.resolve().then(() => this.connect(req, connectOpts)).then((socket) => {
          this.decrementSockets(name, fakeSocket);
          if (socket instanceof http.Agent) {
            try {
              return socket.addRequest(req, connectOpts);
            } catch (err) {
              return cb(err);
            }
          }
          this[INTERNAL].currentSocket = socket;
          super.createSocket(req, options, cb);
        }, (err) => {
          this.decrementSockets(name, fakeSocket);
          cb(err);
        });
      }
      createConnection() {
        const socket = this[INTERNAL].currentSocket;
        this[INTERNAL].currentSocket = void 0;
        if (!socket) {
          throw new Error("No socket was returned in the `connect()` function");
        }
        return socket;
      }
      get defaultPort() {
        return this[INTERNAL].defaultPort ?? (this.protocol === "https:" ? 443 : 80);
      }
      set defaultPort(v) {
        if (this[INTERNAL]) {
          this[INTERNAL].defaultPort = v;
        }
      }
      get protocol() {
        return this[INTERNAL].protocol ?? (this.isSecureEndpoint() ? "https:" : "http:");
      }
      set protocol(v) {
        if (this[INTERNAL]) {
          this[INTERNAL].protocol = v;
        }
      }
    };
    exports2.Agent = Agent;
  }
});

// node_modules/https-proxy-agent/dist/parse-proxy-response.js
var require_parse_proxy_response = __commonJS({
  "node_modules/https-proxy-agent/dist/parse-proxy-response.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parseProxyResponse = void 0;
    var debug_1 = __importDefault(require_src());
    var debug = (0, debug_1.default)("https-proxy-agent:parse-proxy-response");
    function parseProxyResponse(socket) {
      return new Promise((resolve, reject) => {
        let buffersLength = 0;
        const buffers = [];
        function read() {
          const b = socket.read();
          if (b)
            ondata(b);
          else
            socket.once("readable", read);
        }
        function cleanup() {
          socket.removeListener("end", onend);
          socket.removeListener("error", onerror);
          socket.removeListener("readable", read);
        }
        function onend() {
          cleanup();
          debug("onend");
          reject(new Error("Proxy connection ended before receiving CONNECT response"));
        }
        function onerror(err) {
          cleanup();
          debug("onerror %o", err);
          reject(err);
        }
        function ondata(b) {
          buffers.push(b);
          buffersLength += b.length;
          const buffered = Buffer.concat(buffers, buffersLength);
          const endOfHeaders = buffered.indexOf("\r\n\r\n");
          if (endOfHeaders === -1) {
            debug("have not received end of HTTP headers yet...");
            read();
            return;
          }
          const headerParts = buffered.slice(0, endOfHeaders).toString("ascii").split("\r\n");
          const firstLine = headerParts.shift();
          if (!firstLine) {
            socket.destroy();
            return reject(new Error("No header received from proxy CONNECT response"));
          }
          const firstLineParts = firstLine.split(" ");
          const statusCode = +firstLineParts[1];
          const statusText = firstLineParts.slice(2).join(" ");
          const headers = {};
          for (const header of headerParts) {
            if (!header)
              continue;
            const firstColon = header.indexOf(":");
            if (firstColon === -1) {
              socket.destroy();
              return reject(new Error(`Invalid header from proxy CONNECT response: "${header}"`));
            }
            const key = header.slice(0, firstColon).toLowerCase();
            const value = header.slice(firstColon + 1).trimStart();
            const current = headers[key];
            if (typeof current === "string") {
              headers[key] = [current, value];
            } else if (Array.isArray(current)) {
              current.push(value);
            } else {
              headers[key] = value;
            }
          }
          debug("got proxy server response: %o %o", firstLine, headers);
          cleanup();
          resolve({
            connect: {
              statusCode,
              statusText,
              headers
            },
            buffered
          });
        }
        socket.on("error", onerror);
        socket.on("end", onend);
        read();
      });
    }
    exports2.parseProxyResponse = parseProxyResponse;
  }
});

// node_modules/https-proxy-agent/dist/index.js
var require_dist2 = __commonJS({
  "node_modules/https-proxy-agent/dist/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    } : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.HttpsProxyAgent = void 0;
    var net = __importStar(require("net"));
    var tls = __importStar(require("tls"));
    var assert_1 = __importDefault(require("assert"));
    var debug_1 = __importDefault(require_src());
    var agent_base_1 = require_dist();
    var url_1 = require("url");
    var parse_proxy_response_1 = require_parse_proxy_response();
    var debug = (0, debug_1.default)("https-proxy-agent");
    var setServernameFromNonIpHost = (options) => {
      if (options.servername === void 0 && options.host && !net.isIP(options.host)) {
        return {
          ...options,
          servername: options.host
        };
      }
      return options;
    };
    var HttpsProxyAgent = class extends agent_base_1.Agent {
      constructor(proxy, opts) {
        super(opts);
        this.options = { path: void 0 };
        this.proxy = typeof proxy === "string" ? new url_1.URL(proxy) : proxy;
        this.proxyHeaders = opts?.headers ?? {};
        debug("Creating new HttpsProxyAgent instance: %o", this.proxy.href);
        const host = (this.proxy.hostname || this.proxy.host).replace(/^\[|\]$/g, "");
        const port = this.proxy.port ? parseInt(this.proxy.port, 10) : this.proxy.protocol === "https:" ? 443 : 80;
        this.connectOpts = {
          // Attempt to negotiate http/1.1 for proxy servers that support http/2
          ALPNProtocols: ["http/1.1"],
          ...opts ? omit(opts, "headers") : null,
          host,
          port
        };
      }
      /**
       * Called when the node-core HTTP client library is creating a
       * new HTTP request.
       */
      async connect(req, opts) {
        const { proxy } = this;
        if (!opts.host) {
          throw new TypeError('No "host" provided');
        }
        let socket;
        if (proxy.protocol === "https:") {
          debug("Creating `tls.Socket`: %o", this.connectOpts);
          socket = tls.connect(setServernameFromNonIpHost(this.connectOpts));
        } else {
          debug("Creating `net.Socket`: %o", this.connectOpts);
          socket = net.connect(this.connectOpts);
        }
        const headers = typeof this.proxyHeaders === "function" ? this.proxyHeaders() : { ...this.proxyHeaders };
        const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
        let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r
`;
        if (proxy.username || proxy.password) {
          const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
          headers["Proxy-Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;
        }
        headers.Host = `${host}:${opts.port}`;
        if (!headers["Proxy-Connection"]) {
          headers["Proxy-Connection"] = this.keepAlive ? "Keep-Alive" : "close";
        }
        for (const name of Object.keys(headers)) {
          payload += `${name}: ${headers[name]}\r
`;
        }
        const proxyResponsePromise = (0, parse_proxy_response_1.parseProxyResponse)(socket);
        socket.write(`${payload}\r
`);
        const { connect, buffered } = await proxyResponsePromise;
        req.emit("proxyConnect", connect);
        this.emit("proxyConnect", connect, req);
        if (connect.statusCode === 200) {
          req.once("socket", resume);
          if (opts.secureEndpoint) {
            debug("Upgrading socket connection to TLS");
            return tls.connect({
              ...omit(setServernameFromNonIpHost(opts), "host", "path", "port"),
              socket
            });
          }
          return socket;
        }
        socket.destroy();
        const fakeSocket = new net.Socket({ writable: false });
        fakeSocket.readable = true;
        req.once("socket", (s) => {
          debug("Replaying proxy buffer for failed request");
          (0, assert_1.default)(s.listenerCount("data") > 0);
          s.push(buffered);
          s.push(null);
        });
        return fakeSocket;
      }
    };
    HttpsProxyAgent.protocols = ["http", "https"];
    exports2.HttpsProxyAgent = HttpsProxyAgent;
    function resume(socket) {
      socket.resume();
    }
    function omit(obj, ...keys) {
      const ret = {};
      let key;
      for (key in obj) {
        if (!keys.includes(key)) {
          ret[key] = obj[key];
        }
      }
      return ret;
    }
  }
});

// node_modules/web-push/src/web-push-lib.js
var require_web_push_lib = __commonJS({
  "node_modules/web-push/src/web-push-lib.js"(exports2, module2) {
    "use strict";
    var url = require("url");
    var https = require("https");
    var WebPushError = require_web_push_error();
    var vapidHelper = require_vapid_helper();
    var encryptionHelper = require_encryption_helper();
    var webPushConstants = require_web_push_constants();
    var urlBase64Helper = require_urlsafe_base64_helper();
    var DEFAULT_TTL = 2419200;
    var gcmAPIKey = "";
    var vapidDetails;
    function WebPushLib() {
    }
    WebPushLib.prototype.setGCMAPIKey = function(apiKey) {
      if (apiKey === null) {
        gcmAPIKey = null;
        return;
      }
      if (typeof apiKey === "undefined" || typeof apiKey !== "string" || apiKey.length === 0) {
        throw new Error("The GCM API Key should be a non-empty string or null.");
      }
      gcmAPIKey = apiKey;
    };
    WebPushLib.prototype.setVapidDetails = function(subject, publicKey, privateKey) {
      if (arguments.length === 1 && arguments[0] === null) {
        vapidDetails = null;
        return;
      }
      vapidHelper.validateSubject(subject);
      vapidHelper.validatePublicKey(publicKey);
      vapidHelper.validatePrivateKey(privateKey);
      vapidDetails = {
        subject,
        publicKey,
        privateKey
      };
    };
    WebPushLib.prototype.generateRequestDetails = function(subscription, payload, options) {
      if (!subscription || !subscription.endpoint) {
        throw new Error("You must pass in a subscription with at least an endpoint.");
      }
      if (typeof subscription.endpoint !== "string" || subscription.endpoint.length === 0) {
        throw new Error("The subscription endpoint must be a string with a valid URL.");
      }
      if (payload) {
        if (typeof subscription !== "object" || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
          throw new Error("To send a message with a payload, the subscription must have 'auth' and 'p256dh' keys.");
        }
      }
      let currentGCMAPIKey = gcmAPIKey;
      let currentVapidDetails = vapidDetails;
      let timeToLive = DEFAULT_TTL;
      let extraHeaders = {};
      let contentEncoding = webPushConstants.supportedContentEncodings.AES_128_GCM;
      let urgency = webPushConstants.supportedUrgency.NORMAL;
      let topic;
      let proxy;
      let agent;
      let timeout;
      if (options) {
        const validOptionKeys = [
          "headers",
          "gcmAPIKey",
          "vapidDetails",
          "TTL",
          "contentEncoding",
          "urgency",
          "topic",
          "proxy",
          "agent",
          "timeout"
        ];
        const optionKeys = Object.keys(options);
        for (let i = 0; i < optionKeys.length; i += 1) {
          const optionKey = optionKeys[i];
          if (!validOptionKeys.includes(optionKey)) {
            throw new Error("'" + optionKey + "' is an invalid option. The valid options are ['" + validOptionKeys.join("', '") + "'].");
          }
        }
        if (options.headers) {
          extraHeaders = options.headers;
          let duplicates = Object.keys(extraHeaders).filter(function(header) {
            return typeof options[header] !== "undefined";
          });
          if (duplicates.length > 0) {
            throw new Error("Duplicated headers defined [" + duplicates.join(",") + "]. Please either define the header in thetop level options OR in the 'headers' key.");
          }
        }
        if (options.gcmAPIKey) {
          currentGCMAPIKey = options.gcmAPIKey;
        }
        if (options.vapidDetails !== void 0) {
          currentVapidDetails = options.vapidDetails;
        }
        if (options.TTL !== void 0) {
          timeToLive = Number(options.TTL);
          if (timeToLive < 0) {
            throw new Error("TTL should be a number and should be at least 0");
          }
        }
        if (options.contentEncoding) {
          if (options.contentEncoding === webPushConstants.supportedContentEncodings.AES_128_GCM || options.contentEncoding === webPushConstants.supportedContentEncodings.AES_GCM) {
            contentEncoding = options.contentEncoding;
          } else {
            throw new Error("Unsupported content encoding specified.");
          }
        }
        if (options.urgency) {
          if (options.urgency === webPushConstants.supportedUrgency.VERY_LOW || options.urgency === webPushConstants.supportedUrgency.LOW || options.urgency === webPushConstants.supportedUrgency.NORMAL || options.urgency === webPushConstants.supportedUrgency.HIGH) {
            urgency = options.urgency;
          } else {
            throw new Error("Unsupported urgency specified.");
          }
        }
        if (options.topic) {
          if (!urlBase64Helper.validate(options.topic)) {
            throw new Error("Unsupported characters set use the URL or filename-safe Base64 characters set");
          }
          if (options.topic.length > 32) {
            throw new Error("use maximum of 32 characters from the URL or filename-safe Base64 characters set");
          }
          topic = options.topic;
        }
        if (options.proxy) {
          if (typeof options.proxy === "string" || typeof options.proxy.host === "string") {
            proxy = options.proxy;
          } else {
            console.warn("Attempt to use proxy option, but invalid type it should be a string or proxy options object.");
          }
        }
        if (options.agent) {
          if (options.agent instanceof https.Agent) {
            if (proxy) {
              console.warn("Agent option will be ignored because proxy option is defined.");
            }
            agent = options.agent;
          } else {
            console.warn("Wrong type for the agent option, it should be an instance of https.Agent.");
          }
        }
        if (typeof options.timeout === "number") {
          timeout = options.timeout;
        }
      }
      if (typeof timeToLive === "undefined") {
        timeToLive = DEFAULT_TTL;
      }
      const requestDetails = {
        method: "POST",
        headers: {
          TTL: timeToLive
        }
      };
      Object.keys(extraHeaders).forEach(function(header) {
        requestDetails.headers[header] = extraHeaders[header];
      });
      let requestPayload = null;
      if (payload) {
        const encrypted = encryptionHelper.encrypt(subscription.keys.p256dh, subscription.keys.auth, payload, contentEncoding);
        requestDetails.headers["Content-Length"] = encrypted.cipherText.length;
        requestDetails.headers["Content-Type"] = "application/octet-stream";
        if (contentEncoding === webPushConstants.supportedContentEncodings.AES_128_GCM) {
          requestDetails.headers["Content-Encoding"] = webPushConstants.supportedContentEncodings.AES_128_GCM;
        } else if (contentEncoding === webPushConstants.supportedContentEncodings.AES_GCM) {
          requestDetails.headers["Content-Encoding"] = webPushConstants.supportedContentEncodings.AES_GCM;
          requestDetails.headers.Encryption = "salt=" + encrypted.salt;
          requestDetails.headers["Crypto-Key"] = "dh=" + encrypted.localPublicKey.toString("base64url");
        }
        requestPayload = encrypted.cipherText;
      } else {
        requestDetails.headers["Content-Length"] = 0;
      }
      const isGCM = subscription.endpoint.startsWith("https://android.googleapis.com/gcm/send");
      const isFCM = subscription.endpoint.startsWith("https://fcm.googleapis.com/fcm/send");
      if (isGCM) {
        if (!currentGCMAPIKey) {
          console.warn("Attempt to send push notification to GCM endpoint, but no GCM key is defined. Please use setGCMApiKey() or add 'gcmAPIKey' as an option.");
        } else {
          requestDetails.headers.Authorization = "key=" + currentGCMAPIKey;
        }
      } else if (currentVapidDetails) {
        const parsedUrl = url.parse(subscription.endpoint);
        const audience = parsedUrl.protocol + "//" + parsedUrl.host;
        const vapidHeaders = vapidHelper.getVapidHeaders(
          audience,
          currentVapidDetails.subject,
          currentVapidDetails.publicKey,
          currentVapidDetails.privateKey,
          contentEncoding
        );
        requestDetails.headers.Authorization = vapidHeaders.Authorization;
        if (contentEncoding === webPushConstants.supportedContentEncodings.AES_GCM) {
          if (requestDetails.headers["Crypto-Key"]) {
            requestDetails.headers["Crypto-Key"] += ";" + vapidHeaders["Crypto-Key"];
          } else {
            requestDetails.headers["Crypto-Key"] = vapidHeaders["Crypto-Key"];
          }
        }
      } else if (isFCM && currentGCMAPIKey) {
        requestDetails.headers.Authorization = "key=" + currentGCMAPIKey;
      }
      requestDetails.headers.Urgency = urgency;
      if (topic) {
        requestDetails.headers.Topic = topic;
      }
      requestDetails.body = requestPayload;
      requestDetails.endpoint = subscription.endpoint;
      if (proxy) {
        requestDetails.proxy = proxy;
      }
      if (agent) {
        requestDetails.agent = agent;
      }
      if (timeout) {
        requestDetails.timeout = timeout;
      }
      return requestDetails;
    };
    WebPushLib.prototype.sendNotification = function(subscription, payload, options) {
      let requestDetails;
      try {
        requestDetails = this.generateRequestDetails(subscription, payload, options);
      } catch (err) {
        return Promise.reject(err);
      }
      return new Promise(function(resolve, reject) {
        const httpsOptions = {};
        const urlParts = url.parse(requestDetails.endpoint);
        httpsOptions.hostname = urlParts.hostname;
        httpsOptions.port = urlParts.port;
        httpsOptions.path = urlParts.path;
        httpsOptions.headers = requestDetails.headers;
        httpsOptions.method = requestDetails.method;
        if (requestDetails.timeout) {
          httpsOptions.timeout = requestDetails.timeout;
        }
        if (requestDetails.agent) {
          httpsOptions.agent = requestDetails.agent;
        }
        if (requestDetails.proxy) {
          const { HttpsProxyAgent } = require_dist2();
          httpsOptions.agent = new HttpsProxyAgent(requestDetails.proxy);
        }
        const pushRequest = https.request(httpsOptions, function(pushResponse) {
          let responseText = "";
          pushResponse.on("data", function(chunk) {
            responseText += chunk;
          });
          pushResponse.on("end", function() {
            if (pushResponse.statusCode < 200 || pushResponse.statusCode > 299) {
              reject(new WebPushError(
                "Received unexpected response code",
                pushResponse.statusCode,
                pushResponse.headers,
                responseText,
                requestDetails.endpoint
              ));
            } else {
              resolve({
                statusCode: pushResponse.statusCode,
                body: responseText,
                headers: pushResponse.headers
              });
            }
          });
        });
        if (requestDetails.timeout) {
          pushRequest.on("timeout", function() {
            pushRequest.destroy(new Error("Socket timeout"));
          });
        }
        pushRequest.on("error", function(e) {
          reject(e);
        });
        if (requestDetails.body) {
          pushRequest.write(requestDetails.body);
        }
        pushRequest.end();
      });
    };
    module2.exports = WebPushLib;
  }
});

// node_modules/web-push/src/index.js
var require_src2 = __commonJS({
  "node_modules/web-push/src/index.js"(exports2, module2) {
    "use strict";
    var vapidHelper = require_vapid_helper();
    var encryptionHelper = require_encryption_helper();
    var WebPushLib = require_web_push_lib();
    var WebPushError = require_web_push_error();
    var WebPushConstants = require_web_push_constants();
    var webPush = new WebPushLib();
    module2.exports = {
      WebPushError,
      supportedContentEncodings: WebPushConstants.supportedContentEncodings,
      encrypt: encryptionHelper.encrypt,
      getVapidHeaders: vapidHelper.getVapidHeaders,
      generateVAPIDKeys: vapidHelper.generateVAPIDKeys,
      setGCMAPIKey: webPush.setGCMAPIKey,
      setVapidDetails: webPush.setVapidDetails,
      generateRequestDetails: webPush.generateRequestDetails,
      sendNotification: webPush.sendNotification.bind(webPush)
    };
  }
});

// cloud/push.js
var require_push = __commonJS({
  "cloud/push.js"(exports2, module2) {
    "use strict";
    var webpush = require_src2();
    var { MASTER, invalid, requireUser } = require_core();
    var PUSH_HOST_SUFFIXES = [
      "fcm.googleapis.com",
      "android.googleapis.com",
      "push.services.mozilla.com",
      "notify.windows.com",
      "push.apple.com"
    ];
    var CONTACT = process.env.RELAY_PUSH_CONTACT || "https://github.com/jpkintu/relay";
    var SEND_TIMEOUT_MS = 5e3;
    function allowedEndpoint(endpoint) {
      let url;
      try {
        url = new URL(endpoint);
      } catch {
        return false;
      }
      const testHosts = (process.env.RELAY_PUSH_TEST_HOSTS || "").split(",").filter(Boolean);
      if (testHosts.includes(url.host)) return true;
      return url.protocol === "https:" && PUSH_HOST_SUFFIXES.some(
        (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
      );
    }
    var cachedKeys = null;
    async function vapidKeys() {
      if (cachedKeys) return cachedKeys;
      const find = () => {
        const query = new Parse.Query("Secret");
        query.equalTo("key", "vapid");
        query.ascending("createdAt");
        return query.first(MASTER);
      };
      let row = await find();
      if (!row) {
        const created = new Parse.Object("Secret");
        created.set({ key: "vapid", value: webpush.generateVAPIDKeys() });
        created.setACL(new Parse.ACL());
        await created.save(null, MASTER);
        row = await find();
      }
      cachedKeys = row.get("value");
      return cachedKeys;
    }
    Parse.Cloud.define("getPushConfig", async (request) => {
      requireUser(request);
      return { publicKey: (await vapidKeys()).publicKey };
    });
    Parse.Cloud.define("savePushSubscription", async (request) => {
      const user = requireUser(request);
      const sub = request.params.subscription || {};
      const endpoint = String(sub.endpoint || "");
      const p256dh = String(sub.keys?.p256dh || "");
      const auth = String(sub.keys?.auth || "");
      if (!allowedEndpoint(endpoint)) throw invalid("Unsupported push service");
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth))
        throw invalid("Invalid push subscription keys");
      const query = new Parse.Query("PushSubscription");
      query.equalTo("endpoint", endpoint);
      const row = await query.first(MASTER) || new Parse.Object("PushSubscription");
      row.set({
        user: Parse.User.createWithoutData(user.id),
        endpoint,
        p256dh,
        auth,
        userAgent: String(request.params.userAgent || "").slice(0, 200),
        lastSeenAt: /* @__PURE__ */ new Date()
      });
      row.setACL(new Parse.ACL());
      await row.save(null, MASTER);
      return { ok: true };
    });
    Parse.Cloud.define("removePushSubscription", async (request) => {
      const user = requireUser(request);
      const query = new Parse.Query("PushSubscription");
      query.equalTo("endpoint", String(request.params.endpoint || ""));
      query.equalTo("user", user);
      const row = await query.first(MASTER);
      if (row) await row.destroy(MASTER);
      return { ok: !!row };
    });
    async function pushNotifications(rows) {
      try {
        if (!rows.length) return 0;
        const byUser = /* @__PURE__ */ new Map();
        for (const row of rows) byUser.set(row.get("recipient").id, row);
        const query = new Parse.Query("PushSubscription");
        query.containedIn(
          "user",
          [...byUser.keys()].map((id) => Parse.User.createWithoutData(id))
        );
        query.limit(1e3);
        const subs = await query.find(MASTER);
        if (!subs.length) return 0;
        const keys = await vapidKeys();
        const options = {
          vapidDetails: { subject: CONTACT, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 6 * 3600,
          timeout: SEND_TIMEOUT_MS
        };
        const results = await Promise.allSettled(
          subs.map(async (sub) => {
            const row = byUser.get(sub.get("user").id);
            const tone = row.get("tone");
            const payload = JSON.stringify({
              id: row.id,
              title: row.get("title"),
              body: row.get("body"),
              link: row.get("link"),
              tone
            });
            try {
              await webpush.sendNotification(
                {
                  endpoint: sub.get("endpoint"),
                  keys: { p256dh: sub.get("p256dh"), auth: sub.get("auth") }
                },
                payload,
                // "high" wakes a sleeping phone straight away.
                { ...options, urgency: tone === "update" ? "normal" : "high" }
              );
              return true;
            } catch (error) {
              if ([404, 410].includes(error?.statusCode)) await sub.destroy(MASTER);
              throw error;
            }
          })
        );
        for (const result of results)
          if (result.status === "rejected" && ![404, 410].includes(result.reason?.statusCode))
            console.error("push not delivered:", result.reason?.statusCode || result.reason?.message);
        return results.filter((r) => r.status === "fulfilled").length;
      } catch (error) {
        console.error("push failed", error);
        return 0;
      }
    }
    module2.exports = { pushNotifications, allowedEndpoint };
  }
});

// cloud/lib/alerts.js
var require_alerts = __commonJS({
  "cloud/lib/alerts.js"(exports2, module2) {
    "use strict";
    function floatLevel(float, max, warnPercent = 80) {
      const limit = Number(max) || 0;
      const cash = Number(float) || 0;
      if (limit <= 0) return null;
      if (cash >= limit) return "reached";
      const percent = Math.min(Math.max(Number(warnPercent) || 80, 1), 99);
      if (cash >= limit * percent / 100) return "near";
      return null;
    }
    function handoverReminderDue(float, localHour, reminderHour = 20) {
      const hour = Number(reminderHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
      return (Number(float) || 0) > 0 && localHour >= hour;
    }
    module2.exports = { floatLevel, handoverReminderDue };
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

// cloud/cash.js
var require_cash = __commonJS({
  "cloud/cash.js"(exports2, module2) {
    "use strict";
    var {
      MASTER,
      invalid,
      requireRole,
      adminOnly,
      readAcl,
      audit,
      loadConfig,
      nextDailyCode,
      requireCashierShift,
      claimOnce,
      verifyPin,
      personName
    } = require_core();
    var { sumBy } = require_money();
    var { money, notifyUser, notifyStaff, notifyAdmins } = require_notifications();
    var STALE_HOURS = 4;
    var clean = (value, max) => String(value ?? "").trim().slice(0, max);
    var handoverKey = (order) => `handover-order:${order.id}:${order.get("handoverRound") || 0}`;
    var reviewKey = (row) => `handover-review:${row.id}:${row.get("reviewRound") || 0}`;
    async function releaseOrders(orders) {
      await Promise.all(
        orders.map((order) => {
          const ref = new Parse.Object("Order");
          ref.id = order.id;
          ref.increment("handoverRound");
          return ref.save(null, MASTER);
        })
      );
    }
    async function newHandover({ rider, orders, config, notes, requestId, cashier }) {
      const row = new Parse.Object("CashHandover");
      row.set({
        handoverCode: await nextDailyCode("HO", 3, config.timezone, {
          className: "CashHandover",
          field: "handoverCode"
        }),
        rider,
        amount: sumBy(orders, (order) => order.get("amountCollected")),
        orderCount: orders.length,
        orders,
        status: "pending",
        handedOverAt: /* @__PURE__ */ new Date(),
        notes: clean(notes, 200),
        requestId: requestId || "",
        reviewRound: 0,
        ...cashier && { cashier }
      });
      row.setACL(readAcl(rider));
      return row;
    }
    async function claimOrders(orders) {
      const results = await Promise.all(orders.map((order) => claimOnce(handoverKey(order))));
      if (results.every(Boolean)) return;
      await releaseOrders(orders.filter((_, i) => results[i]));
      throw invalid("Some of these orders are already being handed over. Refresh and try again");
    }
    Parse.Cloud.define("createHandover", async (request) => {
      const { user: rider } = await requireRole(request, ["rider"]);
      const p = request.params;
      const ids = p.orderIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
        throw invalid("Select unique orders");
      const requestId = clean(p.requestId, 64);
      if (requestId) {
        const existing = await new Parse.Query("CashHandover").equalTo("rider", rider).equalTo("requestId", requestId).first(MASTER);
        if (existing) return { id: existing.id, amount: existing.get("amount"), duplicate: true };
      }
      await verifyPin(rider, p.pin);
      const query = new Parse.Query("Order");
      query.containedIn("objectId", ids);
      query.equalTo("createdBy", rider);
      query.equalTo("status", "DELIVERED");
      query.equalTo("cashStatus", "WITH_RIDER");
      const [orders, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
      if (orders.length !== ids.length) throw invalid("Invalid handover orders");
      await claimOrders(orders);
      const row = await newHandover({ rider, orders, config, notes: p.notes, requestId });
      await row.save(null, MASTER);
      orders.forEach((order) => order.set("cashStatus", "HANDOVER_PENDING"));
      await Parse.Object.saveAll(orders, MASTER);
      const amount = row.get("amount");
      await audit(rider, "cash.handover_created", row, null, { amount });
      await notifyStaff({
        kind: "cash.handover",
        tone: "new",
        title: `Cash handover ${row.get("handoverCode")}`,
        body: `${personName(rider)} \xB7 ${money(config, amount)} \xB7 ${orders.length} ${orders.length === 1 ? "order" : "orders"}`,
        link: "/cashier/handovers"
      });
      return { id: row.id, amount };
    });
    async function startReview(row) {
      if (row.get("status") !== "pending") throw invalid("This handover was already dealt with");
      if (!await claimOnce(reviewKey(row)))
        throw invalid("Another cashier is already counting this handover");
    }
    async function loadOrders(row) {
      return Promise.all((row.get("orders") || []).map((ptr) => ptr.fetch(MASTER)));
    }
    Parse.Cloud.define("confirmHandover", async (request) => {
      const { user: cashier, role } = await requireRole(request, ["cashier", "admin"]);
      await requireCashierShift(cashier, role);
      const p = request.params;
      const row = await new Parse.Query("CashHandover").get(p.handoverId, MASTER);
      const orders = await loadOrders(row);
      const receivedIds = Array.isArray(p.receivedOrderIds) ? p.receivedOrderIds.map(String) : orders.map((order) => order.id);
      const received = orders.filter((order) => receivedIds.includes(order.id));
      const returned = orders.filter((order) => !receivedIds.includes(order.id));
      if (!received.length) throw invalid("Tick at least one order you received cash for");
      if (received.length !== new Set(receivedIds).size)
        throw invalid("Those orders are not in this handover");
      const due = sumBy(received, (order) => order.get("amountCollected"));
      const counted = Number(p.countedAmount);
      if (!Number.isFinite(counted) || counted !== due)
        throw invalid("Counted cash must match the ticked orders; dispute any missing cash");
      if (orders.some((order) => order.get("cashStatus") !== "HANDOVER_PENDING"))
        throw invalid("Orders are no longer pending this handover");
      await startReview(row);
      const now = /* @__PURE__ */ new Date();
      received.forEach((order) => order.set({ cashStatus: "RECONCILED", settledAt: now }));
      returned.forEach(
        (order) => order.set({
          cashStatus: "WITH_RIDER",
          handoverRound: Number(order.get("handoverRound") || 0) + 1
        })
      );
      await Parse.Object.saveAll(orders, MASTER);
      row.set({
        status: "confirmed",
        cashier,
        confirmedAt: now,
        tillAt: now,
        countedAmount: counted,
        returnedOrders: returned,
        returnedAmount: sumBy(returned, (order) => order.get("amountCollected"))
      });
      await row.save(null, MASTER);
      await audit(
        cashier,
        "cash.handover_confirmed",
        row,
        { status: "pending", amount: row.get("amount") },
        { status: "confirmed", countedAmount: counted, returned: returned.map((o) => o.id) }
      );
      const { values: config } = await loadConfig();
      const by = personName(await cashier.fetch(MASTER));
      await notifyUser(row.get("rider"), {
        kind: "cash.handover_confirmed",
        tone: returned.length ? "alert" : "update",
        title: `Handover ${row.get("handoverCode")} confirmed`,
        body: returned.length ? `${money(config, counted)} received by ${by}. ${returned.length} ${returned.length === 1 ? "order was" : "orders were"} not received (${money(config, row.get("returnedAmount"))}) and ${returned.length === 1 ? "is" : "are"} back with you: hand ${returned.length === 1 ? "it" : "them"} over again.` : `${money(config, counted)} received by ${by}.`,
        link: "/rider/cash"
      });
      return { status: "confirmed", returned: returned.length };
    });
    Parse.Cloud.define("disputeHandover", async (request) => {
      const { user: cashier, role } = await requireRole(request, ["cashier", "admin"]);
      await requireCashierShift(cashier, role);
      const row = await new Parse.Query("CashHandover").get(request.params.handoverId, MASTER);
      const reason = clean(request.params.reason, 300);
      const counted = Number(request.params.countedAmount);
      if (reason.length < 5 || !Number.isFinite(counted) || counted < 0)
        throw invalid("Enter a reason and physical cash count");
      if (counted >= Number(row.get("amount")))
        throw invalid("The count matches the claim: confirm the handover instead");
      await startReview(row);
      const now = /* @__PURE__ */ new Date();
      row.set({
        status: "disputed",
        cashier,
        disputeReason: reason,
        countedAmount: counted,
        disputedAt: now,
        tillAt: now
      });
      await row.save(null, MASTER);
      await audit(
        cashier,
        "cash.handover_disputed",
        row,
        { status: "pending", amount: row.get("amount") },
        { status: "disputed", countedAmount: counted, reason }
      );
      const { values: config } = await loadConfig();
      const disputed = {
        kind: "cash.handover_disputed",
        tone: "alert",
        title: `Handover ${row.get("handoverCode")} disputed`,
        body: `Counted ${money(config, counted)} of ${money(config, row.get("amount"))}: ${reason}`
      };
      await notifyUser(row.get("rider"), { ...disputed, link: "/rider/cash" });
      await notifyAdmins({ ...disputed, link: "/admin/payments", except: cashier });
      return { status: "disputed" };
    });
    var RESOLUTIONS = ["write_off", "deduct", "reopen"];
    Parse.Cloud.define("adminResolveHandover", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      if (!RESOLUTIONS.includes(p.action)) throw invalid("Choose how to resolve it");
      const row = await new Parse.Query("CashHandover").get(p.handoverId, MASTER);
      if (row.get("status") !== "disputed") throw invalid("Only disputed handovers can be resolved");
      const note = clean(p.note, 300);
      if (note.length < 5) throw invalid("Enter a resolution note");
      const shortage = Math.max(0, Number(row.get("amount")) - Number(row.get("countedAmount") || 0));
      const now = /* @__PURE__ */ new Date();
      const base = { resolutionNote: note, resolvedBy: actor, resolvedAt: now, resolution: p.action };
      if (p.action === "reopen") {
        if (row.has("tillAt")) row.unset("tillAt");
        row.set({
          ...base,
          status: "pending",
          reviewRound: Number(row.get("reviewRound") || 0) + 1
        });
      } else {
        const orders = await loadOrders(row);
        orders.forEach((order) => order.set({ cashStatus: "RECONCILED", settledAt: now }));
        await Parse.Object.saveAll(orders, MASTER);
        row.set({
          ...base,
          status: "confirmed",
          confirmedAt: now,
          shortage,
          shortageStatus: p.action === "deduct" ? "owed" : "written_off"
        });
      }
      await row.save(null, MASTER);
      await audit(
        actor,
        `cash.dispute_${p.action}`,
        row,
        { status: "disputed", reason: row.get("disputeReason") },
        { status: row.get("status"), shortage, note }
      );
      const { values: config } = await loadConfig();
      const messages = {
        write_off: `Resolved: the ${money(config, shortage)} shortage was written off.`,
        deduct: `Resolved: the ${money(config, shortage)} shortage will come off your next pay.`,
        reopen: "The cashier will count it again."
      };
      await notifyUser(row.get("rider"), {
        kind: "cash.dispute_resolved",
        tone: "update",
        title: `Handover ${row.get("handoverCode")}`,
        body: `${messages[p.action]} ${note}`,
        link: "/rider/cash"
      });
      if (p.action === "reopen") await notifyStaffAbout(row, "reopened for counting again", config);
      return { status: row.get("status"), shortage };
    });
    Parse.Cloud.define("reopenHandover", async (request) => {
      const actor = await adminOnly(request);
      const row = await new Parse.Query("CashHandover").get(request.params.handoverId, MASTER);
      if (row.get("status") !== "disputed") throw invalid("Only disputed handovers can be reopened");
      const note = clean(request.params.note, 300);
      if (note.length < 5) throw invalid("Enter a resolution note");
      row.set({
        status: "pending",
        resolutionNote: note,
        resolvedBy: actor,
        resolvedAt: /* @__PURE__ */ new Date(),
        resolution: "reopen",
        reviewRound: Number(row.get("reviewRound") || 0) + 1
      });
      if (row.has("tillAt")) row.unset("tillAt");
      await row.save(null, MASTER);
      await audit(actor, "cash.dispute_reopened", row, { status: "disputed" }, { status: "pending" });
      return { status: "pending" };
    });
    async function notifyStaffAbout(row, what, config) {
      await notifyStaff({
        kind: "cash.handover",
        tone: "alert",
        title: `Handover ${row.get("handoverCode")} ${what}`,
        body: `${personName(await row.get("rider").fetch(MASTER))} \xB7 ${money(config, row.get("amount"))}`,
        link: "/cashier/handovers"
      });
    }
    Parse.Cloud.define("adminReceiveCash", async (request) => {
      const actor = await adminOnly(request);
      const p = request.params;
      const note = clean(p.note, 200);
      if (note.length < 5) throw invalid('Say where the cash is (e.g. "Owner took it to the bank")');
      const rider = await new Parse.Query(Parse.User).get(String(p.riderId), MASTER);
      const query = new Parse.Query("Order");
      query.equalTo("createdBy", rider);
      query.equalTo("status", "DELIVERED");
      query.equalTo("cashStatus", "WITH_RIDER");
      if (Array.isArray(p.orderIds)) query.containedIn("objectId", p.orderIds.map(String));
      query.limit(500);
      const [orders, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
      if (!orders.length) throw invalid("This rider holds no cash to receive");
      await claimOrders(orders);
      const row = await newHandover({ rider, orders, config, notes: note, cashier: actor });
      const now = /* @__PURE__ */ new Date();
      row.set({
        status: "confirmed",
        confirmedAt: now,
        countedAmount: row.get("amount"),
        receivedByOwner: true
      });
      await row.save(null, MASTER);
      orders.forEach((order) => order.set({ cashStatus: "RECONCILED", settledAt: now }));
      await Parse.Object.saveAll(orders, MASTER);
      await audit(actor, "cash.received_by_owner", row, null, { amount: row.get("amount"), note });
      await notifyUser(rider, {
        kind: "cash.handover_confirmed",
        tone: "update",
        title: `${money(config, row.get("amount"))} received by the owner`,
        body: note,
        link: "/rider/cash"
      });
      return { id: row.id, amount: row.get("amount") };
    });
    function handoverJSON(row) {
      return {
        id: row.id,
        code: row.get("handoverCode"),
        status: row.get("status"),
        amount: Number(row.get("amount") || 0),
        orderCount: row.get("orderCount") || 0,
        countedAmount: row.get("countedAmount") ?? null,
        returnedAmount: Number(row.get("returnedAmount") || 0),
        returnedCount: (row.get("returnedOrders") || []).length,
        disputeReason: row.get("disputeReason") || "",
        resolution: row.get("resolution") || "",
        resolutionNote: row.get("resolutionNote") || "",
        shortage: Number(row.get("shortage") || 0),
        shortageStatus: row.get("shortageStatus") || "",
        handedOverAt: row.get("handedOverAt"),
        confirmedAt: row.get("confirmedAt") || null,
        receivedByOwner: row.get("receivedByOwner") === true
      };
    }
    Parse.Cloud.define("getMyHandovers", async (request) => {
      const { user: rider } = await requireRole(request, ["rider"]);
      const query = new Parse.Query("CashHandover");
      query.equalTo("rider", rider);
      query.descending("handedOverAt");
      query.limit(20);
      return (await query.find(MASTER)).map(handoverJSON);
    });
    async function pendingHandovers() {
      const query = new Parse.Query("CashHandover");
      query.equalTo("status", "pending");
      query.include("rider");
      query.ascending("handedOverAt");
      query.limit(200);
      return query.find(MASTER);
    }
    var STALE_CHECK_MS = Number(process.env.RELAY_STALE_CHECK_MS ?? 18e4);
    var lastStaleCheck = 0;
    async function staleHandoverAlerts(config) {
      if (Date.now() - lastStaleCheck < STALE_CHECK_MS) return 0;
      lastStaleCheck = Date.now();
      const cutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1e3);
      let sent = 0;
      for (const row of await pendingHandovers()) {
        if (row.get("handedOverAt") > cutoff) break;
        const hours = Math.floor((Date.now() - row.get("handedOverAt")) / 36e5);
        sent += await notifyStaff({
          kind: "cash.handover_stale",
          tone: "alert",
          key: `handover-stale:${row.id}`,
          title: `Handover ${row.get("handoverCode")} waiting ${hours} h`,
          body: `${personName(row.get("rider"))} \xB7 ${money(config, row.get("amount"))} has not been counted yet.`,
          link: "/cashier/handovers"
        });
      }
      return sent;
    }
    module2.exports = { STALE_HOURS, staleHandoverAlerts, handoverJSON };
  }
});

// cloud/notifications.js
var require_notifications = __commonJS({
  "cloud/notifications.js"(exports2, module2) {
    "use strict";
    var {
      MASTER,
      requireUser,
      getRoleName,
      loadConfig,
      readAcl,
      riderFloat,
      personName
    } = require_core();
    var { floatLevel, handoverReminderDue } = require_alerts();
    var { dateKey, localClock } = require_dates();
    var { pushNotifications } = require_push();
    var money = (config, amount) => `${config.currencySymbol} ${Math.round(Number(amount) || 0).toLocaleString("en-US")}`;
    async function roleUsers(names) {
      const query = new Parse.Query(Parse.Role);
      query.containedIn("name", names);
      const roles = await query.find(MASTER);
      const lists = await Promise.all(
        roles.map((role) => role.getUsers().query().limit(1e3).find(MASTER))
      );
      const byId = /* @__PURE__ */ new Map();
      for (const user of lists.flat()) if (user.get("active") !== false) byId.set(user.id, user);
      return [...byId.values()];
    }
    async function notifyUsers(users, payload) {
      try {
        const recipients = /* @__PURE__ */ new Map();
        for (const user of users) if (user?.id) recipients.set(user.id, user);
        if (payload.except) recipients.delete(payload.except.id);
        const rows = [];
        for (const user of recipients.values()) {
          if (payload.key) {
            const existing = new Parse.Query("Notification");
            existing.equalTo("recipient", user);
            existing.equalTo("key", payload.key);
            if (await existing.first(MASTER)) continue;
          }
          const row = new Parse.Object("Notification");
          row.set({
            recipient: Parse.User.createWithoutData(user.id),
            kind: payload.kind,
            tone: payload.tone || "update",
            title: String(payload.title).slice(0, 120),
            body: String(payload.body || "").slice(0, 300),
            link: payload.link || "",
            key: payload.key || ""
          });
          if (payload.order) row.set("order", payload.order);
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
    var notifyUser = (user, payload) => notifyUsers([user], payload);
    var notifyStaff = async (payload) => notifyUsers(await roleUsers(["cashier", "admin"]), payload);
    var notifyAdmins = async (payload) => notifyUsers(await roleUsers(["admin"]), payload);
    async function cashLimitAlert(rider, config, float) {
      const cash = float ?? await riderFloat(rider);
      const level = floatLevel(cash, config.maxRiderFloat, config.floatWarningPercent);
      if (!level) return 0;
      const day = dateKey(/* @__PURE__ */ new Date(), config.timezone);
      const amounts = `${money(config, cash)} of your ${money(config, config.maxRiderFloat)} limit`;
      return notifyUser(rider, {
        kind: `cash.limit_${level}`,
        tone: "alert",
        key: `cash-${level}:${day}`,
        link: "/rider/cash",
        ...level === "reached" ? {
          title: "Cash limit reached",
          body: `You hold ${amounts}. Hand over cash: new orders are blocked until you do.`
        } : {
          title: "Cash limit almost reached",
          body: `You hold ${amounts}. Hand over cash soon.`
        }
      });
    }
    async function handoverReminder(rider, config, float) {
      const now = /* @__PURE__ */ new Date();
      if (!handoverReminderDue(float, localClock(now, config.timezone).hour, config.cashReminderHour))
        return 0;
      return notifyUser(rider, {
        kind: "cash.handover_reminder",
        tone: "alert",
        key: `handover-reminder:${dateKey(now, config.timezone)}`,
        link: "/rider/cash",
        title: "Hand over today's cash",
        body: `You still hold ${money(config, float)}. Hand it over to the cashier before you finish.`
      });
    }
    function toJSON(row) {
      return {
        id: row.id,
        kind: row.get("kind"),
        tone: row.get("tone"),
        title: row.get("title"),
        body: row.get("body"),
        link: row.get("link"),
        read: !!row.get("readAt"),
        createdAt: row.createdAt
      };
    }
    Parse.Cloud.define("getNotifications", async (request) => {
      const user = requireUser(request);
      const role = await getRoleName(user);
      if (role === "rider") {
        const { values: config } = await loadConfig();
        const float = await riderFloat(user);
        await cashLimitAlert(user, config, float);
        await handoverReminder(user, config, float);
      } else if (role === "cashier" || role === "admin") {
        const { staleHandoverAlerts } = require_cash();
        await staleHandoverAlerts((await loadConfig()).values);
      }
      const listQuery = new Parse.Query("Notification");
      listQuery.equalTo("recipient", user);
      listQuery.doesNotExist("readAt");
      listQuery.descending("createdAt");
      listQuery.limit(40);
      const unreadQuery = new Parse.Query("Notification");
      unreadQuery.equalTo("recipient", user);
      unreadQuery.doesNotExist("readAt");
      const [rows, unread] = await Promise.all([listQuery.find(MASTER), unreadQuery.count(MASTER)]);
      return { items: rows.map(toJSON), unread };
    });
    Parse.Cloud.define("markNotificationsRead", async (request) => {
      const user = requireUser(request);
      const query = new Parse.Query("Notification");
      query.equalTo("recipient", user);
      query.doesNotExist("readAt");
      if (!request.params.all) {
        const ids = Array.isArray(request.params.ids) ? request.params.ids.map(String) : [];
        if (!ids.length) return { updated: 0 };
        query.containedIn("objectId", ids.slice(0, 200));
      }
      query.limit(500);
      const rows = await query.find(MASTER);
      const now = /* @__PURE__ */ new Date();
      rows.forEach((row) => row.set("readAt", now));
      if (rows.length) await Parse.Object.saveAll(rows, MASTER);
      return { updated: rows.length };
    });
    module2.exports = {
      money,
      personName,
      notifyUser,
      notifyUsers,
      notifyStaff,
      notifyAdmins,
      cashLimitAlert
    };
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
      loadConfig,
      requireCashierShift,
      takeOrder
    } = require_core();
    var { merchantAccounts, cleanReference, referenceProblem } = require_mobileMoney();
    var { dateKey } = require_dates();
    var { notifyUser, notifyStaff, personName } = require_notifications();
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
      const { user: actor, role } = await requireRole(request, ["cashier", "admin"]);
      await requireCashierShift(actor, role);
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      if (order.get("paymentStatus") !== PENDING)
        throw invalid("This payment is not waiting for a check");
      const received = request.params.received === true;
      const reason = String(request.params.reason || "").trim().slice(0, 200);
      if (!received && reason.length < 3) throw invalid("Say why the payment was not accepted");
      await takeOrder(order, actor, role);
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
      const code = order.get("orderCode");
      await notifyUser(order.get("createdBy"), {
        kind: received ? "payment.verified" : "payment.rejected",
        tone: received ? "update" : "alert",
        title: received ? `Payment confirmed for ${code}` : `Payment not received for ${code}`,
        body: received ? "The kitchen can start on it." : `${reason}. Correct the transaction ID or cancel the order.`,
        link: `/rider/order/${order.id}`,
        order
      });
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
      await notifyStaff({
        kind: "payment.resubmitted",
        tone: "new",
        title: `New transaction ID for ${order.get("orderCode")}`,
        body: `${personName(await actor.fetch(MASTER))} \xB7 ${reference}`,
        link: "/cashier/payments",
        order,
        except: actor
      });
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
        rejectReason: order.get("paymentRejectReason") || "",
        holderId: order.get("cashier")?.id || "",
        holderName: order.get("cashierName") || ""
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
      nextDailyCode,
      riderFloat,
      personName,
      requireCashierShift,
      takeOrder
    } = require_core();
    var { computeCommission, sumBy } = require_money();
    var { availableGroups, selectionError } = require_accompaniments();
    var { recordCustomerOrder } = require_customers();
    var { checkMobileMoney, PENDING } = require_payments();
    var { money, notifyUser, notifyStaff, notifyAdmins, cashLimitAlert } = require_notifications();
    var CHANNELS = ["walkin", "phone", "whatsapp", "other"];
    var PAYMENT_METHODS = ["cash", "mobile_money", "card", "prepaid"];
    var MAX_LINES = 30;
    var clean = (value, max) => String(value ?? "").trim().slice(0, max);
    var cleanPhone = (value) => clean(value, 30).replace(/[^\d+]/g, "");
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
      activeQuery.limit(200);
      const [lines, { values: config }, active, float] = await Promise.all([
        priceLines(p.items),
        loadConfig(),
        activeQuery.find(MASTER),
        riderFloat(rider)
      ]);
      if (!config.allowBatching && active.length)
        throw invalid("Finish your current order before creating another");
      const toCollect = cashToCollect(active);
      if (config.maxRiderFloat > 0 && float + toCollect >= config.maxRiderFloat)
        throw invalid(cashLimitMessage(config, float, toCollect));
      const subtotal = sumBy(lines, (line) => line.price * line.qty);
      const fee = Math.max(0, Math.round(Number(p.deliveryFee ?? config.defaultDeliveryFee) || 0));
      const total = subtotal + fee;
      const isCash = paymentMethod === "cash";
      if (isCash && p.amountToCollect !== void 0 && Number(p.amountToCollect) !== total)
        throw invalid("The customer must pay the full total");
      const amountToCollect = isCash ? total : 0;
      const momo = paymentMethod === "mobile_money" ? await checkMobileMoney(config, p.paymentProvider, p.paymentReference) : null;
      const order = new Parse.Object("Order");
      order.set({
        orderCode: await nextDailyCode("ORD", 4, config.timezone, {
          className: "Order",
          field: "orderCode"
        }),
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
      await notifyStaff({
        kind: "order.new",
        tone: "new",
        title: `New order ${order.get("orderCode")}`,
        body: [
          personName(rider),
          customerName,
          money(config, total),
          momo ? "mobile money to check" : "cash"
        ].join(" \xB7 "),
        link: "/cashier",
        order
      });
      const exposure = float + toCollect + (isCash ? amountToCollect : 0);
      return {
        id: order.id,
        orderCode: order.get("orderCode"),
        total,
        // This order takes the rider to or over the limit: it goes ahead, but the
        // next one is blocked until the cash is handed over.
        cashLimitReached: config.maxRiderFloat > 0 && exposure >= config.maxRiderFloat
      };
    });
    var cashToCollect = (orders) => sumBy(
      orders.filter((order) => order.get("paymentMethod") === "cash"),
      (order) => order.get("amountToCollect") ?? order.get("total")
    );
    function cashLimitMessage(config, held, toCollect) {
      const parts = [];
      if (held > 0) parts.push(`you hold ${money(config, held)}`);
      if (toCollect > 0) parts.push(`${money(config, toCollect)} is still to collect on open orders`);
      return `Cash limit reached: ${parts.join(" and ") || "no cash room left"} (limit ${money(config, config.maxRiderFloat)}). ${toCollect > 0 ? "Deliver and hand over" : "Hand over"} cash before taking new orders`;
    }
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
      if (staff && !owner) await requireCashierShift(actor, role);
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
        const due = Number(order.get("amountToCollect") || order.get("total"));
        const amount = isCash ? Number(p.amountCollected ?? due) : 0;
        if (isCash && amount !== due) throw invalid(`Collect the full ${money(config, due)}`);
        const rider = await order.get("createdBy").fetch(MASTER);
        const commission = computeCommission({
          type: rider.get("commissionType") || "per_order",
          perOrder: rider.get("commissionPerOrder"),
          percent: rider.get("commissionPercent"),
          subtotal: order.get("subtotal"),
          rounding: config.commissionRounding
        });
        const deliveryPay = Number(order.get("deliveryFee") || 0);
        order.set({
          paymentMethod: method,
          deliveredAt: now,
          amountCollected: Math.round(amount),
          paymentCollectedBy: actor,
          commissionBase: commission,
          deliveryPay,
          commissionAmount: commission + deliveryPay,
          commissionPaid: false,
          cashStatus: isCash ? "WITH_RIDER" : "NOT_APPLICABLE"
        });
      }
      if (staff && !owner) await takeOrder(order, actor, role);
      await order.save(null, MASTER);
      await audit(actor, `order.${p.action}`, order, before, {
        status: rule.to,
        paymentMethod: order.get("paymentMethod"),
        reason: order.get("cancelledReason")
      });
      await notifyTransition(order, p.action, { staff, owner, actor, config });
      return { status: rule.to };
    });
    var RIDER_MESSAGES = {
      accept: (code) => [`${code} accepted`, "The kitchen has started on it."],
      prepare: (code) => [`${code} is being prepared`, ""],
      ready: (code) => [`${code} is ready for pickup`, "Collect it from the counter."],
      pickup: (code) => [`${code} handed to you`, "Deliver it and record the payment."],
      deliver: (code) => [`${code} marked delivered`, ""],
      reject: (code, reason) => [`${code} was rejected`, reason],
      cancel: (code, reason) => [`${code} was cancelled`, reason]
    };
    async function notifyTransition(order, action, { staff, owner, actor, config }) {
      const code = order.get("orderCode");
      const rider = order.get("createdBy");
      if (staff && !owner && RIDER_MESSAGES[action]) {
        const [title, detail] = RIDER_MESSAGES[action](code, order.get("cancelledReason") || "");
        await notifyUser(rider, {
          kind: `order.${action}`,
          tone: ["ready", "reject", "cancel"].includes(action) ? "alert" : "update",
          title,
          body: [order.get("customerName"), detail].filter(Boolean).join(" \xB7 "),
          link: `/rider/order/${order.id}`,
          order
        });
      }
      if (owner && action === "cancel")
        await notifyStaff({
          kind: "order.cancelled_by_rider",
          tone: "update",
          title: `${code} cancelled by the rider`,
          body: order.get("cancelledReason") || "",
          link: "/cashier",
          order,
          except: actor
        });
      if (action === "deliver" && order.get("paymentMethod") === "cash")
        await cashLimitAlert(await rider.fetch(MASTER), config);
    }
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
      await notifyAdmins({
        kind: "order.issue",
        tone: "alert",
        title: `Problem reported on ${order.get("orderCode")}`,
        body: `${personName(await actor.fetch(MASTER))}: ${note}`,
        link: "/admin/problems",
        order,
        except: actor
      });
      return { ok: true };
    });
    Parse.Cloud.define("resolveOrderIssue", async (request) => {
      const { user: actor } = await requireRole(request, ["admin"]);
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      if (!order.get("disputeFlag")) throw invalid("This order has no open issue");
      const resolution = clean(request.params.resolution, 300);
      if (resolution.length < 5) throw invalid("Describe how it was resolved");
      order.set({
        disputeFlag: false,
        disputeResolution: resolution,
        disputeResolvedBy: actor,
        disputeResolvedAt: /* @__PURE__ */ new Date()
      });
      await order.save(null, MASTER);
      await audit(
        actor,
        "order.issue_resolved",
        order,
        { note: order.get("disputeNote") },
        { resolution }
      );
      const resolved = {
        kind: "order.issue_resolved",
        tone: "update",
        title: `Problem on ${order.get("orderCode")} resolved`,
        body: resolution,
        order,
        except: actor
      };
      const rider = order.get("createdBy");
      const reporter = order.get("disputedBy");
      await notifyUser(rider, { ...resolved, link: `/rider/order/${order.id}` });
      if (reporter && reporter.id !== rider?.id) await notifyUser(reporter, { ...resolved, link: "" });
      return { ok: true };
    });
    Parse.Cloud.define("adminListIssues", async (request) => {
      await requireRole(request, ["admin"]);
      const state = request.params.state || "open";
      if (!["open", "resolved", "all"].includes(state)) throw invalid("Unknown issue filter");
      const query = new Parse.Query("Order");
      query.exists("disputeNote");
      if (state === "open") query.equalTo("disputeFlag", true);
      if (state === "resolved") query.notEqualTo("disputeFlag", true);
      query.include(["createdBy", "disputedBy", "disputeResolvedBy"]);
      query.descending("disputedAt");
      query.limit(300);
      const [rows, open] = await Promise.all([
        query.find(MASTER),
        new Parse.Query("Order").equalTo("disputeFlag", true).count(MASTER)
      ]);
      return {
        open,
        issues: rows.map((order) => ({
          id: order.id,
          code: order.get("orderCode"),
          customer: order.get("customerName"),
          customerPhone: order.get("customerPhone") || "",
          rider: personName(order.get("createdBy")),
          status: order.get("status"),
          total: order.get("total"),
          note: order.get("disputeNote"),
          reportedBy: personName(order.get("disputedBy")),
          reportedAt: order.get("disputedAt") || null,
          open: order.get("disputeFlag") === true,
          resolution: order.get("disputeResolution") || "",
          resolvedBy: personName(order.get("disputeResolvedBy")),
          resolvedAt: order.get("disputeResolvedAt") || null
        }))
      };
    });
    var KITCHEN_OPEN = ["PLACED", "ACCEPTED", "PREPARING", "READY"];
    async function onShiftCashiers() {
      const query = new Parse.Query("Shift");
      query.equalTo("kind", "cashier");
      query.equalTo("status", "open");
      query.include("operator");
      query.limit(100);
      const shifts = await query.find(MASTER);
      const seen = /* @__PURE__ */ new Set();
      const people = [];
      for (const shift of shifts) {
        const person = shift.get("operator");
        if (!person || seen.has(person.id) || person.get("active") === false) continue;
        if (await getRoleName(person) !== "cashier") continue;
        seen.add(person.id);
        people.push(person);
      }
      return people;
    }
    Parse.Cloud.define("getOnShiftCashiers", async (request) => {
      const { user } = await requireRole(request, ["cashier", "admin"]);
      return (await onShiftCashiers()).filter((person) => person.id !== user.id).map((person) => ({ id: person.id, name: personName(person) }));
    });
    Parse.Cloud.define("transferOrder", async (request) => {
      const { user: actor, role } = await requireRole(request, ["cashier", "admin"]);
      await requireCashierShift(actor, role);
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      if (!KITCHEN_OPEN.includes(order.get("status")))
        throw invalid("Only orders still in the kitchen can be transferred");
      const holder = order.get("cashier");
      if (role === "cashier" && holder && holder.id !== actor.id)
        throw forbidden(`${order.get("cashierName")} is handling this order`);
      const toId = String(request.params.toUserId || "");
      let target = null;
      if (toId) {
        target = (await onShiftCashiers()).find((person) => person.id === toId);
        if (!target) throw invalid("That colleague is not on shift");
        if (holder?.id === target.id) throw invalid(`${personName(target)} already has this order`);
      }
      const before = { cashier: order.get("cashierName") || "" };
      order.set("cashierRound", Number(order.get("cashierRound") || 0) + 1);
      if (target)
        order.set({ cashier: target, cashierName: personName(target), assignedAt: /* @__PURE__ */ new Date() });
      else order.set("cashierName", "");
      if (!target && holder) order.unset("cashier");
      await order.save(null, MASTER);
      await audit(actor, "order.transferred", order, before, { cashier: order.get("cashierName") });
      const code = order.get("orderCode");
      const from = personName(await actor.fetch(MASTER));
      if (target)
        await notifyUser(target, {
          kind: "order.transferred",
          tone: "new",
          title: `${code} passed to you`,
          body: `${from} transferred it \xB7 ${order.get("customerName")}`,
          link: "/cashier",
          order
        });
      return { cashier: order.get("cashierName") || "" };
    });
    module2.exports = { riderFloat, servableAccompaniments, KITCHEN_OPEN };
  }
});

// cloud/menu.js
var require_menu = __commonJS({
  "cloud/menu.js"() {
    "use strict";
    var {
      MASTER,
      invalid,
      requireRole,
      audit,
      loadConfig,
      requireCashierShift
    } = require_core();
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
      const { user: actor, role } = await requireRole(request, ["cashier", "admin"]);
      await requireCashierShift(actor, role);
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

// cloud/payouts.js
var require_payouts = __commonJS({
  "cloud/payouts.js"(exports2, module2) {
    "use strict";
    var {
      MASTER,
      invalid,
      requireRole,
      readAcl,
      audit,
      loadConfig,
      nextDailyCode,
      requireCashierShift,
      claimOnce,
      verifyPin,
      personName,
      getRoleName
    } = require_core();
    var { sumBy } = require_money();
    var { money, notifyUser, notifyAdmins } = require_notifications();
    var { resolveRange } = require_dates();
    var clean = (value, max) => String(value ?? "").trim().slice(0, max);
    async function riderPayState(rider) {
      const orderQuery = new Parse.Query("Order");
      orderQuery.equalTo("createdBy", rider);
      orderQuery.equalTo("status", "DELIVERED");
      orderQuery.notEqualTo("commissionPaid", true);
      orderQuery.greaterThan("commissionAmount", 0);
      orderQuery.ascending("deliveredAt");
      orderQuery.limit(1e3);
      const shortageQuery = new Parse.Query("CashHandover");
      shortageQuery.equalTo("rider", rider);
      shortageQuery.equalTo("shortageStatus", "owed");
      shortageQuery.limit(200);
      const [orders, shortages] = await Promise.all([
        orderQuery.find(MASTER),
        shortageQuery.find(MASTER)
      ]);
      const earned = sumBy(orders, (order) => order.get("commissionAmount"));
      const deductions = sumBy(shortages, (row) => row.get("shortage"));
      return { orders, shortages, earned, deductions, owed: earned - deductions };
    }
    async function openCashierShift(user) {
      return new Parse.Query("Shift").equalTo("operator", user).equalTo("kind", "cashier").equalTo("status", "open").first(MASTER);
    }
    function payoutJSON(row) {
      return {
        id: row.id,
        code: row.get("payoutCode"),
        kind: row.get("kind"),
        amount: Number(row.get("amount") || 0),
        earned: Number(row.get("earned") || 0),
        deductions: Number(row.get("deductions") || 0),
        orderCount: (row.get("orders") || []).length,
        note: row.get("note") || "",
        rider: row.get("rider") ? personName(row.get("rider")) : "",
        paidBy: row.get("paidBy") ? personName(row.get("paidBy")) : "",
        fromTill: !!row.get("shift"),
        paidAt: row.get("paidAt")
      };
    }
    Parse.Cloud.define("getRiderPay", async (request) => {
      await requireRole(request, ["cashier", "admin"]);
      const role = await new Parse.Query(Parse.Role).equalTo("name", "rider").first(MASTER);
      const riders = role ? await role.getUsers().query().limit(500).find(MASTER) : [];
      const rows = await Promise.all(
        riders.map(async (rider) => {
          const state = await riderPayState(rider);
          return {
            riderId: rider.id,
            rider: personName(rider),
            active: rider.get("active") !== false,
            deliveries: state.orders.length,
            earned: state.earned,
            deductions: state.deductions,
            owed: state.owed
          };
        })
      );
      return rows.filter((row) => row.earned > 0 || row.deductions > 0).sort((a, b) => b.owed - a.owed);
    });
    Parse.Cloud.define("getMyPay", async (request) => {
      const { user: rider } = await requireRole(request, ["rider"]);
      const state = await riderPayState(rider);
      const payouts = await new Parse.Query("TillPayout").equalTo("rider", rider).include("paidBy").descending("paidAt").limit(10).find(MASTER);
      return {
        deliveries: state.orders.length,
        earned: state.earned,
        deductions: state.deductions,
        owed: state.owed,
        payouts: payouts.map(payoutJSON)
      };
    });
    async function newPayout(fields, config) {
      const row = new Parse.Object("TillPayout");
      row.set({
        payoutCode: await nextDailyCode("PO", 3, config.timezone, {
          className: "TillPayout",
          field: "payoutCode"
        }),
        paidAt: /* @__PURE__ */ new Date(),
        ...fields
      });
      row.setACL(readAcl(fields.rider || null));
      return row;
    }
    Parse.Cloud.define("payRider", async (request) => {
      const { user: actor, role } = await requireRole(request, ["cashier", "admin"]);
      await requireCashierShift(actor, role);
      await verifyPin(actor, request.params.pin);
      const rider = await new Parse.Query(Parse.User).get(String(request.params.riderId), MASTER);
      if (await getRoleName(rider) !== "rider") throw invalid("Choose a rider");
      const round = Number(rider.get("payRound") || 0);
      if (!await claimOnce(`pay-rider:${rider.id}:${round}`))
        throw invalid("This rider is already being paid. Refresh in a moment");
      try {
        const state = await riderPayState(rider);
        if (state.owed <= 0)
          throw invalid(
            state.deductions > state.earned ? "Nothing to pay: the rider\u2019s shortages are more than their earnings" : "Nothing to pay"
          );
        const { values: config } = await loadConfig();
        const shift = role === "cashier" ? await openCashierShift(actor) : null;
        const row = await newPayout(
          {
            kind: "rider",
            rider,
            amount: state.owed,
            earned: state.earned,
            deductions: state.deductions,
            orders: state.orders,
            shortages: state.shortages,
            paidBy: actor,
            ...shift && { shift }
          },
          config
        );
        await row.save(null, MASTER);
        state.orders.forEach((order) => order.set({ commissionPaid: true, commissionPayout: row }));
        state.shortages.forEach((h) => h.set({ shortageStatus: "deducted", shortagePayout: row }));
        await Parse.Object.saveAll([...state.orders, ...state.shortages], MASTER);
        await audit(actor, "payout.rider", row, null, {
          amount: state.owed,
          earned: state.earned,
          deductions: state.deductions,
          orders: state.orders.length
        });
        await notifyUser(rider, {
          kind: "payout.rider",
          tone: "update",
          title: `You were paid ${money(config, state.owed)}`,
          body: `${state.orders.length} ${state.orders.length === 1 ? "delivery" : "deliveries"}${state.deductions ? ` less ${money(config, state.deductions)} shortage` : ""} \xB7 paid by ${personName(await actor.fetch(MASTER))}`,
          link: "/rider/earnings"
        });
        return { id: row.id, amount: state.owed };
      } finally {
        rider.increment("payRound");
        await rider.save(null, MASTER);
      }
    });
    Parse.Cloud.define("recordTillPayout", async (request) => {
      const { user: cashier } = await requireRole(request, ["cashier"]);
      const shift = await openCashierShift(cashier);
      if (!shift) throw invalid("Start your shift and count the cash in the till first");
      const amount = Math.round(Number(request.params.amount));
      const note = clean(request.params.note, 200);
      if (!Number.isFinite(amount) || amount <= 0) throw invalid("Enter the amount taken out");
      if (note.length < 5) throw invalid("Say what the money was for");
      await verifyPin(cashier, request.params.pin);
      const { values: config } = await loadConfig();
      const row = await newPayout({ kind: "expense", amount, note, paidBy: cashier, shift }, config);
      await row.save(null, MASTER);
      await audit(cashier, "payout.expense", row, null, { amount, note });
      await notifyAdmins({
        kind: "payout.expense",
        tone: "update",
        title: `${money(config, amount)} paid out of the till`,
        body: `${personName(await cashier.fetch(MASTER))}: ${note}`,
        link: "/admin/payments"
      });
      return { id: row.id, amount };
    });
    Parse.Cloud.define("getTillPayouts", async (request) => {
      const { user, role } = await requireRole(request, ["cashier", "admin"]);
      const query = new Parse.Query("TillPayout");
      if (role === "admin") {
        const { values: config } = await loadConfig();
        const range = resolveRange(request.params, config.timezone, { defaultDays: 7 });
        if (range.error) throw invalid(range.error);
        query.greaterThanOrEqualTo("paidAt", range.start);
        query.lessThan("paidAt", range.end);
      } else {
        const shift = await openCashierShift(user);
        if (!shift) return { payouts: [], total: 0 };
        query.equalTo("shift", shift);
      }
      query.include(["rider", "paidBy"]);
      query.descending("paidAt");
      query.limit(500);
      const payouts = (await query.find(MASTER)).map(payoutJSON);
      return { payouts, total: payouts.reduce((n, p) => n + p.amount, 0) };
    });
    module2.exports = { riderPayState };
  }
});

// cloud/cashcheck.js
var require_cashcheck = __commonJS({
  "cloud/cashcheck.js"(exports2, module2) {
    "use strict";
    var { MASTER, adminOnly, loadConfig } = require_core();
    var { sumBy } = require_money();
    var { dateKey } = require_dates();
    var { money, notifyAdmins } = require_notifications();
    var OPEN_SHIFT_HOURS = 16;
    async function findAll(query) {
      query.limit(5e3);
      return query.find(MASTER);
    }
    async function runCashCheck() {
      const { values: config } = await loadConfig();
      const since = new Date(Date.now() - 60 * 24 * 3600 * 1e3);
      const problems = [];
      const add = (kind, message) => problems.push({ kind, message });
      const handovers = await findAll(
        new Parse.Query("CashHandover").greaterThanOrEqualTo("handedOverAt", since)
      );
      const inHandover = /* @__PURE__ */ new Map();
      const confirmedOrders = /* @__PURE__ */ new Set();
      for (const row of handovers) {
        const ids = (row.get("orders") || []).map((ptr) => ptr.id);
        const returned = new Set((row.get("returnedOrders") || []).map((ptr) => ptr.id));
        if (["pending", "disputed"].includes(row.get("status")))
          for (const id of ids) inHandover.set(id, [...inHandover.get(id) || [], row]);
        if (row.get("status") === "confirmed") {
          for (const id of ids) if (!returned.has(id)) confirmedOrders.add(id);
        }
      }
      const orders = await findAll(
        new Parse.Query("Order").equalTo("status", "DELIVERED").equalTo("paymentMethod", "cash").greaterThanOrEqualTo("deliveredAt", since)
      );
      const byId = new Map(orders.map((order) => [order.id, order]));
      for (const order of orders) {
        const code = order.get("orderCode");
        const status = order.get("cashStatus");
        const waiting = inHandover.get(order.id) || [];
        if (status === "HANDOVER_PENDING" && waiting.length !== 1)
          add(
            "order_handover",
            waiting.length ? `${code} is in ${waiting.length} handovers at once` : `${code} is marked as handed over but is in no waiting handover`
          );
        if (status === "RECONCILED" && !confirmedOrders.has(order.id))
          add("order_reconciled", `${code} is marked as received but no confirmed handover has it`);
        if (status === "WITH_RIDER" && waiting.length)
          add("order_with_rider", `${code} is with the rider but also in a waiting handover`);
      }
      for (const row of handovers) {
        if (row.get("status") !== "pending") continue;
        const code = row.get("handoverCode");
        const rowOrders = (row.get("orders") || []).map((ptr) => byId.get(ptr.id)).filter(Boolean);
        if (rowOrders.some((order) => order.get("cashStatus") !== "HANDOVER_PENDING"))
          add("handover_orders", `${code} has orders that are no longer waiting for it`);
        const sum = sumBy(rowOrders, (order) => order.get("amountCollected"));
        if (rowOrders.length === (row.get("orders") || []).length && sum !== row.get("amount"))
          add(
            "handover_amount",
            `${code} claims ${money(config, row.get("amount"))} but its orders add up to ${money(config, sum)}`
          );
      }
      const staleShifts = await findAll(
        new Parse.Query("Shift").equalTo("status", "open").lessThan("startedAt", new Date(Date.now() - OPEN_SHIFT_HOURS * 3600 * 1e3)).include("operator")
      );
      for (const shift of staleShifts)
        add(
          "shift_open",
          `${shift.get("operator")?.get("name") || "A team member"}'s ${shift.get("kind")} shift has been open for over ${OPEN_SHIFT_HOURS} hours`
        );
      const checkedAt = /* @__PURE__ */ new Date();
      if (problems.length)
        await notifyAdmins({
          kind: "cash.check",
          tone: "alert",
          key: `cash-check:${dateKey(checkedAt, config.timezone)}:${problems.length}`,
          title: `Cash check: ${problems.length} ${problems.length === 1 ? "problem" : "problems"}`,
          body: problems.slice(0, 3).map((p) => p.message).join(" \xB7 "),
          link: "/admin/payments"
        });
      return { checkedAt, ok: !problems.length, problems };
    }
    Parse.Cloud.job("cashCheck", async () => {
      const result = await runCashCheck();
      return result.ok ? "Cash records agree" : `${result.problems.length} problems found`;
    });
    Parse.Cloud.define("adminRunCashCheck", async (request) => {
      await adminOnly(request);
      return runCashCheck();
    });
    module2.exports = { runCashCheck };
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
      audit,
      riderFloat,
      adminOnly,
      loadConfig,
      personName,
      verifyPin
    } = require_core();
    var { money, notifyAdmins } = require_notifications();
    var { resolveRange } = require_dates();
    var { sumBy } = require_money();
    async function tillSummary(cashier, shift) {
      const start = shift.get("startedAt");
      const end = shift.get("endedAt") || new Date(Date.now() + 6e4);
      const counted = new Parse.Query("CashHandover");
      counted.equalTo("cashier", cashier);
      counted.greaterThanOrEqualTo("tillAt", start);
      counted.lessThan("tillAt", end);
      const legacy = new Parse.Query("CashHandover");
      legacy.equalTo("cashier", cashier);
      legacy.equalTo("status", "confirmed");
      legacy.doesNotExist("tillAt");
      legacy.notEqualTo("receivedByOwner", true);
      legacy.greaterThanOrEqualTo("confirmedAt", start);
      legacy.lessThan("confirmedAt", end);
      const handoverQuery = Parse.Query.or(counted, legacy);
      handoverQuery.limit(1e3);
      const payoutQuery = new Parse.Query("TillPayout");
      payoutQuery.equalTo("shift", shift);
      payoutQuery.limit(1e3);
      const [handovers, payouts] = await Promise.all([
        handoverQuery.find(MASTER),
        payoutQuery.find(MASTER)
      ]);
      const openingFloat = Number(shift.get("openingFloat") || 0);
      const cashIn = sumBy(handovers, (h) => h.get("countedAmount") ?? h.get("amount"));
      const paidOut = sumBy(payouts, (row) => row.get("amount"));
      return { openingFloat, cashIn, paidOut, expected: openingFloat + cashIn - paidOut };
    }
    function heldOrdersQuery(cashier) {
      const query = new Parse.Query("Order");
      query.equalTo("cashier", cashier);
      query.containedIn("status", ["PLACED", "ACCEPTED", "PREPARING", "READY"]);
      return query;
    }
    async function riderOutstanding(rider) {
      const openQuery = new Parse.Query("Order");
      openQuery.equalTo("createdBy", rider);
      openQuery.notContainedIn("status", ["DELIVERED", "CANCELLED"]);
      const cashQuery = new Parse.Query("Order");
      cashQuery.equalTo("createdBy", rider);
      cashQuery.equalTo("status", "DELIVERED");
      cashQuery.containedIn("cashStatus", ["WITH_RIDER", "HANDOVER_PENDING"]);
      cashQuery.limit(1e3);
      const [openOrders, cashOrders] = await Promise.all([
        openQuery.count(MASTER),
        cashQuery.find(MASTER)
      ]);
      const sum = (status) => sumBy(
        cashOrders.filter((o) => o.get("cashStatus") === status),
        (o) => o.get("amountCollected")
      );
      return { openOrders, cashWithRider: sum("WITH_RIDER"), cashPending: sum("HANDOVER_PENDING") };
    }
    function outstandingProblem({ openOrders, cashWithRider, cashPending }) {
      if (openOrders)
        return `Finish or cancel your ${openOrders} open order${openOrders === 1 ? "" : "s"} before ending your shift`;
      if (cashWithRider) return "Hand over the cash you are holding before ending your shift";
      if (cashPending)
        return "Wait for the cashier to confirm your cash handover before ending your shift";
      return "";
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
      const till = isCashier ? await tillSummary(user, shift) : null;
      return {
        shift: {
          id: shift.id,
          kind: shift.get("kind"),
          startedAt: shift.get("startedAt"),
          openingFloat: shift.get("openingFloat"),
          expectedTill: till ? till.expected : null,
          cashIn: till ? till.cashIn : null,
          paidOut: till ? till.paidOut : null,
          heldOrders: isCashier ? await heldOrdersQuery(user).count(MASTER) : null,
          float: isCashier ? null : await riderFloat(user),
          outstanding: isCashier ? null : await riderOutstanding(user)
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
      const raw = request.params.openingFloat;
      if (kind === "cashier" && (raw === void 0 || raw === null || raw === ""))
        throw invalid("Count the cash in the till and enter it to start your shift");
      const opening = Number(raw || 0);
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
      if (!isCashier) {
        const problem = outstandingProblem(await riderOutstanding(user));
        if (problem) throw invalid(problem);
      } else {
        const held = await heldOrdersQuery(user).count(MASTER);
        if (held)
          throw invalid(
            `You still hold ${held} kitchen order${held === 1 ? "" : "s"}. Finish or transfer ${held === 1 ? "it" : "them"} before ending your shift`
          );
      }
      const balance = 0;
      let expected = null;
      let counted = null;
      let variance = null;
      let till = null;
      if (isCashier) {
        till = await tillSummary(user, row);
        expected = till.expected;
        const rawCount = request.params.physicalCount;
        counted = Number(rawCount);
        if (rawCount === void 0 || rawCount === "" || !Number.isFinite(counted) || counted < 0)
          throw invalid("Enter physical till count");
        variance = counted - expected;
      }
      const varianceNote = String(request.params.varianceNote || "").trim().slice(0, 500);
      if (variance && varianceNote.length < 10)
        throw invalid("The till is off: explain the difference before ending your shift");
      await verifyPin(user, request.params.pin);
      row.set({
        ...till && { cashIn: till.cashIn, paidOut: till.paidOut },
        status: "closed",
        endedAt: /* @__PURE__ */ new Date(),
        closingFloat: balance,
        acknowledgedCash: balance > 0,
        expectedTill: expected,
        physicalCount: counted,
        variance,
        varianceNote: variance ? varianceNote : ""
      });
      await row.save(null, MASTER);
      await audit(
        user,
        "shift.closed",
        row,
        { status: "open" },
        { balance, expectedTill: expected, physicalCount: counted, variance, varianceNote }
      );
      if (variance) {
        const { values: config } = await loadConfig();
        await notifyAdmins({
          kind: "shift.variance",
          tone: "alert",
          title: `Till ${variance > 0 ? "over" : "short"} by ${money(config, Math.abs(variance))}`,
          body: `${personName(await user.fetch(MASTER))}: counted ${money(config, counted)}, expected ${money(config, expected)}. "${varianceNote}"`,
          link: "/admin/payments",
          except: user
        });
      }
      return { balance, expectedTill: expected, variance };
    });
    Parse.Cloud.define("getShiftReport", async (request) => {
      await adminOnly(request);
      const { values: config } = await loadConfig();
      const range = resolveRange(request.params, config.timezone, { defaultDays: 7 });
      if (range.error) throw invalid(range.error);
      const query = new Parse.Query("Shift");
      query.equalTo("kind", "cashier");
      query.greaterThanOrEqualTo("startedAt", range.start);
      query.lessThan("startedAt", range.end);
      query.include("operator");
      query.descending("startedAt");
      query.limit(500);
      const rows = await query.find(MASTER);
      const shifts = await Promise.all(
        rows.map(async (shift) => {
          const open = shift.get("status") === "open";
          const till = open ? await tillSummary(shift.get("operator"), shift) : null;
          return {
            id: shift.id,
            cashier: personName(shift.get("operator")),
            status: shift.get("status"),
            startedAt: shift.get("startedAt"),
            endedAt: shift.get("endedAt") || null,
            openingFloat: Number(shift.get("openingFloat") || 0),
            cashIn: till ? till.cashIn : shift.get("cashIn") ?? null,
            paidOut: till ? till.paidOut : shift.get("paidOut") ?? null,
            expectedTill: till ? till.expected : shift.get("expectedTill") ?? null,
            physicalCount: shift.get("physicalCount") ?? null,
            variance: shift.get("variance") ?? null,
            varianceNote: shift.get("varianceNote") || ""
          };
        })
      );
      return {
        range: { from: range.from, to: range.to },
        shifts,
        totalVariance: shifts.reduce((n, s) => n + (Number(s.variance) || 0), 0)
      };
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
      const reminderHour = Number(p.cashReminderHour ?? current.cashReminderHour);
      if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23)
        throw invalid("Cash reminder hour must be 0-23");
      const warnPercent = Number(p.floatWarningPercent ?? current.floatWarningPercent);
      if (!Number.isFinite(warnPercent) || warnPercent < 50 || warnPercent > 99)
        throw invalid("Cash warning must be between 50% and 99% of the limit");
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
        mtnMerchantName: merchantField(p.mtnMerchantName, 60),
        cashReminderHour: reminderHour,
        floatWarningPercent: warnPercent
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
        confirmedAt: h.get("confirmedAt") || null,
        returnedAmount: Number(h.get("returnedAmount") || 0),
        shortage: Number(h.get("shortage") || 0),
        shortageStatus: h.get("shortageStatus") || "",
        resolutionNote: h.get("resolutionNote") || "",
        receivedByOwner: h.get("receivedByOwner") === true
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
    var {
      MASTER,
      DEFAULT_CONFIG,
      requireUser,
      getRoleName,
      loadConfig,
      countUsers
    } = require_core();
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
        floatWarningPercent: values.floatWarningPercent,
        mobileMoney: merchantAccounts(values),
        // False until the owner saves a restaurant name in Settings.
        restaurantNameSet: values.restaurantName !== DEFAULT_CONFIG.restaurantName
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
require_push();
require_notifications();
require_customers();
require_payments();
require_orders();
require_menu();
require_cash();
require_payouts();
require_cashcheck();
require_shifts();
require_admin();
require_preview();
require_reports2();
require_profile();
