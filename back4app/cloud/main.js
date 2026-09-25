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
    function dateKey(date, timeZone) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date);
      const get = (type) => parts.find((part) => part.type === type).value;
      return `${get("year")}${get("month")}${get("day")}`;
    }
    module2.exports = { isValidTimeZone, dateKey };
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
      commissionRounding: "none"
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
        settledAt: D
      },
      OrderItem: {
        order: ["Pointer", "Order"],
        itemNameSnapshot: S,
        unitPriceSnapshot: N,
        quantity: N,
        lineTotal: N,
        notes: S
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
        commissionRounding: S
      },
      MenuItem: { title: S, price: N, category: S, active: B, availableToday: B, sortOrder: N },
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
      for (const className of ["MenuItem", "MenuCategory", "Configuration", "AuditLog"])
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
      isStaff,
      readAcl,
      audit,
      loadConfig,
      nextDailyCode
    } = require_core();
    var { computeCommission, sumBy } = require_money();
    var CHANNELS = ["walkin", "phone", "whatsapp", "other"];
    var PAYMENT_METHODS = ["cash", "mobile_money", "card", "prepaid"];
    async function riderFloat(rider) {
      const query = new Parse.Query("Order");
      query.equalTo("createdBy", rider);
      query.equalTo("status", "DELIVERED");
      query.containedIn("cashStatus", ["WITH_RIDER", "HANDOVER_PENDING"]);
      query.limit(1e3);
      return sumBy(await query.find(MASTER), (order) => order.get("amountCollected"));
    }
    Parse.Cloud.define("createOrder", async (request) => {
      const { user: rider } = await requireRole(request, ["rider"]);
      const p = request.params;
      if (!String(p.customerName || "").trim() || !String(p.deliveryAddress || "").trim())
        throw invalid("Customer and address are required");
      if (!Array.isArray(p.items) || !p.items.length) throw invalid("Add at least one item");
      const channel = p.channel || "walkin";
      const paymentMethod = p.paymentMethod || "cash";
      if (!CHANNELS.includes(channel)) throw invalid("Invalid channel");
      if (!PAYMENT_METHODS.includes(paymentMethod)) throw invalid("Invalid payment method");
      const activeQuery = new Parse.Query("Order");
      activeQuery.equalTo("createdBy", rider);
      activeQuery.notContainedIn("status", ["DELIVERED", "CANCELLED"]);
      const menuQuery = new Parse.Query("MenuItem");
      menuQuery.containedIn(
        "objectId",
        p.items.map((line) => String(line.id))
      );
      const [savedMenu, { values: config }, activeCount, float] = await Promise.all([
        menuQuery.find(MASTER),
        loadConfig(),
        activeQuery.count(MASTER),
        riderFloat(rider)
      ]);
      if (!config.allowBatching && activeCount)
        throw invalid("Finish your current order before creating another");
      if (config.maxRiderFloat > 0 && float >= config.maxRiderFloat)
        throw invalid("Hand over cash before creating another order");
      const byId = new Map(savedMenu.map((item) => [item.id, item]));
      const lines = p.items.map((line) => {
        const saved = byId.get(String(line.id));
        const qty = Number(line.quantity);
        if (!saved || !saved.get("active") || !saved.get("availableToday") || !Number.isInteger(qty) || qty < 1 || qty > 50)
          throw invalid("Invalid or unavailable item");
        return { name: saved.get("title"), price: Number(saved.get("price")), qty };
      });
      const subtotal = sumBy(lines, (line) => line.price * line.qty);
      const fee = Math.max(0, Number(p.deliveryFee ?? config.defaultDeliveryFee) || 0);
      const total = subtotal + fee;
      const order = new Parse.Object("Order");
      order.set({
        orderCode: await nextDailyCode("ORD", 4, config.timezone),
        channel,
        createdBy: rider,
        customerName: String(p.customerName).trim(),
        customerPhone: String(p.customerPhone || ""),
        deliveryAddress: String(p.deliveryAddress).trim(),
        subtotal,
        deliveryFee: fee,
        total,
        paymentMethod,
        amountCollected: 0,
        status: "PLACED",
        restaurantStatus: "pending",
        cashStatus: paymentMethod === "cash" ? "NOT_COLLECTED" : "NOT_APPLICABLE",
        commissionAmount: 0,
        commissionPaid: false
      });
      order.setACL(readAcl(rider));
      await order.save(null, MASTER);
      const children = lines.map((line) => {
        const item = new Parse.Object("OrderItem");
        item.set({
          order,
          itemNameSnapshot: line.name,
          unitPriceSnapshot: line.price,
          quantity: line.qty,
          lineTotal: line.price * line.qty,
          notes: ""
        });
        item.setACL(readAcl(rider));
        return item;
      });
      await Parse.Object.saveAll(children, MASTER);
      await audit(rider, "order.placed", order, null, { status: "PLACED", total });
      return { id: order.id, orderCode: order.get("orderCode"), total };
    });
    var TRANSITIONS = {
      accept: ["PLACED", "ACCEPTED", "accepted"],
      prepare: ["ACCEPTED", "PREPARING", "preparing"],
      ready: ["PREPARING", "READY", "ready"],
      pickup: ["READY", "PICKED_UP", "picked_up"],
      deliver: ["PICKED_UP", "DELIVERED", "picked_up"]
    };
    Parse.Cloud.define("transitionOrder", async (request) => {
      const actor = requireUser(request);
      const { action } = request.params;
      const order = await new Parse.Query("Order").get(request.params.orderId, MASTER);
      const rule = TRANSITIONS[action];
      if (!rule || order.get("status") !== rule[0]) throw invalid("Invalid status transition");
      const staff = await isStaff(actor);
      if (["accept", "prepare", "ready"].includes(action) && !staff)
        throw forbidden("Staff access required");
      if (["pickup", "deliver"].includes(action) && order.get("createdBy").id !== actor.id && !staff)
        throw forbidden("Not allowed");
      const before = { status: order.get("status"), restaurantStatus: order.get("restaurantStatus") };
      order.set({ status: rule[1], restaurantStatus: rule[2] });
      if (action === "pickup") order.set("pickedUpAt", /* @__PURE__ */ new Date());
      if (action === "deliver") {
        const amount = Number(request.params.amountCollected ?? order.get("total"));
        if (!Number.isFinite(amount) || amount < order.get("total"))
          throw invalid("Collected amount is below total");
        const [rider, { values: config }] = await Promise.all([
          order.get("createdBy").fetch(MASTER),
          loadConfig()
        ]);
        const isCash = order.get("paymentMethod") === "cash";
        order.set({
          deliveredAt: /* @__PURE__ */ new Date(),
          amountCollected: isCash ? amount : 0,
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
      await audit(actor, `order.${action}`, order, before, { status: rule[1] });
      return { status: rule[1] };
    });
    Parse.Cloud.define("getOperationalMenu", async (request) => {
      requireUser(request);
      const query = new Parse.Query("MenuItem");
      query.equalTo("active", true);
      query.equalTo("availableToday", true);
      query.ascending("sortOrder");
      query.limit(500);
      const [menu, { values: config }] = await Promise.all([query.find(MASTER), loadConfig()]);
      return {
        items: menu.map((item) => ({
          id: item.id,
          title: item.get("title"),
          category: item.get("category") || "Mains",
          price: item.get("price")
        })),
        deliveryFee: config.defaultDeliveryFee,
        currencySymbol: config.currencySymbol
      };
    });
    module2.exports = { riderFloat };
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
    var { applySecurity } = require_security();
    var ROLE_NAMES = ["admin", "cashier", "rider"];
    var STAFF_ROLES = ["rider", "cashier"];
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
      const [users, menu, categories, members, { object: config, values }] = await Promise.all([
        userQuery.find(MASTER),
        menuQuery.find(MASTER),
        categoryQuery.find(MASTER),
        roleMembership(),
        loadConfig()
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
          availableToday: item.get("availableToday") !== false
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
      item.setACL(readAcl(null, ["admin"]));
      await item.save(null, MASTER);
      await audit(actor, "menu.saved", item, before, { title, price });
      return { id: item.id };
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
        allowBatching: !!p.allowBatching
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

// cloud/profile.js
var require_profile = __commonJS({
  "cloud/profile.js"() {
    "use strict";
    var { MASTER, requireUser, getRoleName, loadConfig, countUsers } = require_core();
    var { canBootstrapOwner } = require_admin();
    var { previewEnabled } = require_preview();
    function publicConfig(values) {
      return {
        restaurantName: values.restaurantName,
        currencySymbol: values.currencySymbol,
        currencyCode: values.currencyCode,
        timezone: values.timezone,
        defaultDeliveryFee: values.defaultDeliveryFee,
        maxRiderFloat: values.maxRiderFloat,
        allowBatching: values.allowBatching
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
require_orders();
require_cash();
require_shifts();
require_admin();
require_preview();
require_profile();
