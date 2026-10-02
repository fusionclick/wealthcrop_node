// Engineer B's transaction flows end to end: HTTP → auth → gates → the BSE payload, with BSE
// and Laravel stubbed so nothing real is ever placed. Audit #11, #18, #20, #22, #42, #46,
// #48, #49. Same harness shape as order.e2e.test.js.
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const UCC = "USRWC009";
const TOKEN = "Bearer test-token-0123456789abcdef";

// ── Laravel stub ─────────────────────────────────────────────────────────────────────────
const investor = (over = {}) => ({
  status: true,
  data: {
    kyc: { ucc_code: UCC, kyc_status: "verified" },
    email: "a@b.com",
    phone: "9999999999",
    riskProfile: { profile: "Aggressive", score: 82 },
    profile: { pan_number: "ABCPE1234F", pan_verified: true },
    bank_accounts: [{ bank_name: "HDFC Bank", ifsc_code: "HDFC0001234", account_number: "50100123456789" }],
    ...over,
  },
});
let investorBody = investor();
let storedRows = [];
let mandates = [];
let consentAvailable = true;
let posts = [];
let threshold = 0;
let approvalDecision = () => ({ status: true, decision: "allow" });
let basketPlanBody = null;

const laravel = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    const path = req.url.replace(/\?.*$/, "");
    const send = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method === "POST") posts.push({ path, body });
    if (path.endsWith("/investor-data")) return send(200, investorBody);
    if (path.endsWith("/bse/get-order")) return send(200, { status: true, data: storedRows });
    if (path.endsWith("/order-approval-policy")) return send(200, { status: true, data: { threshold } });
    if (path.endsWith("/order-approvals/check")) return send(200, approvalDecision(body));
    if (path.endsWith("/mandates") && req.method === "GET") return send(200, { status: true, data: mandates });
    if (path.endsWith("/mandates")) {
      const row = { ...(mandates.find((m) => body.exch_mandate_id && m.exch_mandate_id === body.exch_mandate_id) || {}), ...body };
      mandates = [row, ...mandates.filter((m) => m !== row && !(body.exch_mandate_id && m.exch_mandate_id === body.exch_mandate_id))];
      return send(200, { status: true, data: row });
    }
    if (/\/baskets\/\d+\/checkout$/.test(path)) {
      return basketPlanBody ? send(200, { status: true, data: basketPlanBody }) : send(404, { status: false });
    }
    if (path.endsWith('/consents')) return send(200, { status: consentAvailable });
    if (/\/(bse\/order-status|bse\/order)$/.test(path)) return send(200, { status: true });
    return send(404, { status: false });
  });
});
const postsTo = (suffix) => posts.filter((p) => p.path.endsWith(suffix));

// ── BSE stub ─────────────────────────────────────────────────────────────────────────────
const OPEN = { scheme_transaction_effective_start_date: "2010-07-19T00:00:00", scheme_transaction_effective_end_date: "2037-12-31T00:00:00" };
const money = (min) => ({ scheme_transaction_single_details: { scheme_transaction_amt: { scheme_transaction_min_amt: min, scheme_transaction_max_amt: 100000000 } } });
const master = (code, amc, { closedSwitchIn = false } = {}) => ({
  scheme_name: `${amc} FUND ${code}`,
  scheme_isin: code === "007G" ? "INF879O01027" : `INF${code}`,
  scheme_bse_code: code,
  scheme_amc_name: amc,
  scheme_category: "Equity",
  is_active: true,
  lumpsum: [
    { scheme_transaction_type: "Purchase", ...OPEN, ...money(5000) },
    { scheme_transaction_type: "Redemption", ...OPEN, ...money(500) },
    { scheme_transaction_type: "Switch-OUT", ...OPEN },
    closedSwitchIn
      ? { scheme_transaction_type: "Switch-IN", scheme_transaction_effective_start_date: "2010-01-01T00:00:00", scheme_transaction_effective_end_date: "2020-01-01T00:00:00" }
      : { scheme_transaction_type: "Switch-IN", ...OPEN },
  ],
});
const MASTER = {
  "007G": master("007G", "PPFAS Mutual Fund"),
  "008G": master("008G", "PPFAS Mutual Fund"),
  "009H": master("009H", "HDFC Mutual Fund"),
  "010C": master("010C", "PPFAS Mutual Fund", { closedSwitchIn: true }),
};

let bse; // every BSE call: [method, payload]
let orderList = [];
let xspList = [];
let bseAnswer = {}; // method -> response body
let app, server, base, controller;

before(async () => {
  await new Promise((r) => laravel.listen(0, "127.0.0.1", r));
  process.env.LARAVEL_INVESTOR_URL = `http://127.0.0.1:${laravel.address().port}/investor-data`;

  // Today's NAV for the SWP value check, without reaching AMFI from a test. Replaced before
  // anything requires navStore, which reads it once.
  const amfi = require("../src/mf/amfiNav");
  amfi.getAmfiNavs = async () => ({ at: Date.now(), navs: { INF879O01027: { nav: 88.2569, date: "01-Oct-2026" } }, schemes: [], codes: {} });

  const express = require("express");
  const rootRoute = require("../src/route/root-route/rootRoute");
  controller = require("../src/controllers/StarMFController");
  controller.loginFunc = async () => ({ status: "success" });
  controller.accessToken = "stub-token";
  controller.masterDataService.getSchemeMasterList = async (_t, req) => {
    const hit = MASTER[String(req?.data?.search?.value || "").toUpperCase()];
    return { data: { lists: hit ? [hit] : [] } };
  };
  controller.lookupDepository = async () => ({ depository: "C", dp_id: "12345678", client_id: "12345678" });
  controller.lookupUcc = async () => ({ holding_nature: "SI", holder: [{ identifier: [{ identifier_type: "pan", identifier_number: "ABCPE1234F" }] }] });
  const record = (method, fallback) => async (_t, payload) => {
    bse.push([method, payload]);
    return bseAnswer[method] || fallback();
  };
  controller.trxnService.purchaseNewOrder = record("purchaseNewOrder", () => ({
    status: "success",
    data: { items: [{ id: 7000 + bse.length, mem_ord_ref_id: "REF" }] },
  }));
  controller.trxnService.getAllOrders = record("getAllOrders", () => ({ status: "success", data: { lists: orderList } }));
  controller.trxnService.getAllXsp = record("getAllXsp", () => ({ status: "success", data: { lists: xspList } }));
  controller.trxnService.xspRegister = record("xspRegister", () => ({ status: "success", data: { reg_no: "NEWSIP1" } }));
  controller.trxnService.cancelPurchaseOrder = record("cancelPurchaseOrder", () => ({ status: "success", data: {} }));
  controller.mandatteService.registerMandate = record("registerMandate", () => ({ status: "success", data: { exch_mandate_id: 501342 } }));
  controller.mandatteService.getMandate = record("getMandate", () => ({ status: "success", data: { exch_mandate_id: 501342, status: "APPROVED" } }));
  controller.mandatteService.linkMandate = record("linkMandate", () => ({ status: "success" }));

  app = express();
  app.use(express.json());
  app.use("/api", rootRoute);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  laravel.close();
});

beforeEach(() => {
  bse = [];
  posts = [];
  bseAnswer = {};
  investorBody = investor();
  storedRows = [];
  mandates = [];
  orderList = [];
  xspList = [];
  basketPlanBody = null;
  approvalDecision = () => ({ status: true, decision: "allow" });
});

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "WealthCropBrowser/1.0", Authorization: TOKEN },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const ACKS = () => require("../src/mf/suitability").REQUIRED_ACKS;
const order = (o, data = {}) => ({ data: { orders: [{ mem_ord_ref_id: "REF1", cur: "INR", ...o }], acknowledged: ACKS(), ...data } });
const sent = (method) => bse.filter(([m]) => m === method).map(([, p]) => p);
const unverified = () => investor({ profile: { pan_number: "ABCPE1234F", pan_verified: false } });

describe("Audit #42 — withdrawals need a verified PAN", () => {
  it("a redemption is refused before BSE when the PAN is not verified", async () => {
    investorBody = unverified();
    const r = await post("/purchaseNewOrder", order({ type: "r", scheme: "007G", amount: 2000, folio: "F1" }));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "pan_not_verified");
    assert.match(r.body.message, /verified PAN/);
    assert.deepEqual(sent("purchaseNewOrder"), []);
  });

  it("an SWP is refused the same way", async () => {
    investorBody = unverified();
    const r = await post("/xspRegister", { data: { sxp_type: "swp", scheme: "007G", folio: "F1", amount: 1000, freq: "m", txn_date: 10, start_date: "2026-11-10", end_date: "2027-11-10", acknowledged: ACKS() } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "pan_not_verified");
    assert.deepEqual(sent("xspRegister"), []);
  });

  it("a verified PAN redeems as before, and a purchase never asks", async () => {
    const r = await post("/purchaseNewOrder", order({ type: "r", scheme: "007G", amount: 2000, folio: "F1" }));
    assert.equal(r.status, 200);
    investorBody = unverified();
    const buy = await post("/purchaseNewOrder", order({ type: "p", scheme: "007G", amount: 6000 }));
    assert.equal(buy.status, 200, "buying is not a withdrawal");
  });
});

describe("Audit #18 — an SWP instalment worth more than the folio is refused", () => {
  const swp = (amount) => ({
    data: { sxp_type: "swp", scheme: "007G", folio: "F1", amount, freq: "m", txn_date: 10, start_date: "2026-11-10", end_date: "2027-11-10", acknowledged: ACKS() },
  });
  beforeEach(() => {
    // 300 + 100 bought, 80 redeemed: 320 units held, ₹28,242.21 at ₹88.2569.
    orderList = [
      { scheme: "007G", scheme_isin: "INF879O01027", folio_num: "F1", trxn_type: "P", units: 300, amount: 21000, status: "ALLOTTED" },
      { scheme: "007G", scheme_isin: "INF879O01027", folio_num: "F1", trxn_type: "P", units: 100, amount: 7500, status: "ALLOTTED" },
      { scheme: "007G", scheme_isin: "INF879O01027", folio_num: "F1", trxn_type: "R", units: 80, amount: 6000, status: "ALLOTTED" },
    ];
  });

  it("refuses ₹30,000 a month out of a ₹28,242 folio, before BSE", async () => {
    const r = await post("/xspRegister", swp(30000));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "swp_exceeds_holding");
    assert.match(r.body.message, /₹28,242\.21/);
    assert.deepEqual(sent("xspRegister"), []);
  });

  it("lets an instalment the folio can pay through to BSE", async () => {
    const r = await post("/xspRegister", swp(2000));
    assert.equal(r.status, 200);
    assert.equal(sent("xspRegister").length, 1);
  });

  it("counts units net of redemptions (a sold unit is not held)", async () => {
    const r = await post("/xspRegister", { data: { ...swp(0).data, amount: undefined, isunits: true, units: 350 } });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /You hold 320 units/);
  });
});

describe("Audit #46 — switch rules on the server", () => {
  const sw = (dest) => order({ type: "sw", scheme: "007G", dest_scheme: dest, folio: "F1", all_units: true });

  it("within one AMC it goes to BSE", async () => {
    const r = await post("/purchaseNewOrder", sw("008G"));
    assert.equal(r.status, 200);
    assert.equal(sent("purchaseNewOrder")[0].data.orders[0].dest_scheme, "008G");
  });

  it("across AMCs it is refused before BSE", async () => {
    const r = await post("/purchaseNewOrder", sw("009H"));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "switch_not_allowed");
    assert.deepEqual(sent("purchaseNewOrder"), []);
  });

  it("a destination closed to switches in is refused", async () => {
    const r = await post("/purchaseNewOrder", sw("010C"));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /accept switches in/);
  });

  it("a hidden destination is refused like a hidden purchase", async () => {
    const { resetHiddenCache } = require("../src/mf/hidden");
    resetHiddenCache({ codes: ["008G"] });
    const r = await post("/purchaseNewOrder", sw("008G"));
    resetHiddenCache();
    assert.equal(r.status, 403);
    assert.match(r.body.message, /not available for investment/);
    assert.deepEqual(sent("purchaseNewOrder"), []);
  });
});

describe("Audit #49 — cancelling a pending lumpsum order", () => {
  beforeEach(() => {
    storedRows = [
      { bse_order_id: 5001, order_type: "purchase", inv_amo: 5000, status: "pending" },
      { bse_order_id: 5002, order_type: "redeem", inv_amo: 5000, status: "pending" },
      { bse_order_id: 5003, order_type: "purchase", inv_amo: 5000, status: "completed" },
    ];
  });

  it("sends BSE the template's shape and records the order as cancelled", async () => {
    const r = await post("/cancelPurchaseOrder", { data: { id: 5001 } });
    assert.equal(r.status, 200);
    const [payload] = sent("cancelPurchaseOrder");
    assert.deepEqual(payload.data, { id: 5001, investor: { ucc: UCC, pan_holders: ["ABCPE1234F"], holding_nature: "SI" }, remark: "Cancelled by investor" });
    const [sync] = postsTo("/bse/order-status");
    assert.deepEqual(sync.body.updates[0], { bse_order_id: 5001, state: "cancelled", bse_status: "CANCELLED", remarks: "Cancelled by investor" });
  });

  it("refuses an order that is not the caller's, not a purchase, or already final — before BSE", async () => {
    assert.equal((await post("/cancelPurchaseOrder", { data: { id: 7777 } })).status, 404);
    assert.equal((await post("/cancelPurchaseOrder", { data: { id: 5002 } })).status, 409);
    assert.equal((await post("/cancelPurchaseOrder", { data: { id: 5003 } })).status, 409);
    assert.deepEqual(sent("cancelPurchaseOrder"), []);
  });

  it("a cancel BSE refuses is an error, and nothing is recorded", async () => {
    bseAnswer.cancelPurchaseOrder = { status: "error", messages: [{ field: "order", errcode: "not_allowed" }] };
    const r = await post("/cancelPurchaseOrder", { data: { id: 5001 } });
    assert.equal(r.status, 502);
    assert.deepEqual(postsTo("/bse/order-status"), []);
  });
});

describe("Audit #22 — mandate registration", () => {
  const register = (over = {}) =>
    post("/mandate_register/upi-autopay", { authorized: true, mode: "upi", vpa: "investor@okhdfcbank", data: { amount: 100000, acknowledged: ACKS() }, ...over });

  it("refuses a mandate without checkout acknowledgements before contacting BSE", async () => {
    const r = await register({ data: { amount: 100000, acknowledged: [] } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "disclaimer_not_acknowledged");
    assert.deepEqual(sent("registerMandate"), []);
  });

  it("does not register a mandate when consent persistence fails", async () => {
    consentAvailable = false;
    try {
      const r = await register();
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'consent_unavailable');
      assert.deepEqual(sent('registerMandate'), []);
    } finally { consentAvailable = true; }
  });

  it("UPI needs a real UPI ID, checked before BSE", async () => {
    for (const vpa of ["", "investor"]) {
      const r = await register({ vpa });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "vpa_invalid");
    }
    assert.deepEqual(sent("registerMandate"), []);
  });

  it("a channel outside the four, or no bank account on file, is refused", async () => {
    assert.equal((await register({ mode: "cheque" })).body.code, "mandate_mode_invalid");
    investorBody = investor({ bank_accounts: [] });
    assert.equal((await register()).body.code, "bank_missing");
    assert.deepEqual(sent("registerMandate"), []);
  });

  it("success only when BSE says so: an error body is a 502 and is filed as failed", async () => {
    bseAnswer.registerMandate = { status: "error", messages: [{ field: "ifsc", errcode: "invalid" }] };
    const r = await register();
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "mandate_failed");
    assert.match(r.body.message, /ifsc/);
    const [filed] = postsTo("/mandates");
    assert.equal(filed.body.status, "failed");
    assert.match(filed.body.note, /ifsc/);
  });

  it("hands back BSE's approval link (through our proxy), files it pending and links the SIP", async () => {
    bseAnswer.registerMandate = {
      status: "success",
      data: { exch_mandate_id: 501342, mandate_auth_link: "https://starmfv2demo.bseindia.com/mandate/approve/501342" },
    };
    xspList = [{ reg_no: "NEWSIP1", ucc: UCC, sxp_type: "SIP", status: "ACTIVE" }];
    const r = await register({ mode: "netbanking", vpa: undefined, sip_reg_no: "NEWSIP1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.exch_mandate_id, "501342");
    assert.equal(r.body.data.state, "pending");
    assert.equal(r.body.data.approval_link, "/api/bse/pg/mandate/approve/501342");
    assert.equal(r.body.data.linked, true);

    const [payload] = sent("registerMandate");
    assert.equal(payload.data.type, "X", "NetBanking is the e-NACH template");
    assert.equal(payload.data.investor.ucc, UCC);
    const [link] = sent("linkMandate");
    assert.deepEqual(link.data, { reg_no: "NEWSIP1", exch_mandate_id: 501342 });
    const filed = postsTo("/mandates").map((p) => p.body);
    assert.equal(filed[0].status, "pending");
    assert.equal(filed[0].sip_reg_no, "NEWSIP1");
    assert.equal(filed.at(-1).linked, true);
  });

  it("a SIP that is not the caller's is never linked", async () => {
    xspList = [{ reg_no: "THEIRS", ucc: "OTHER01", sxp_type: "SIP", status: "ACTIVE" }];
    const r = await register({ sip_reg_no: "THEIRS" });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.linked, false);
    assert.deepEqual(sent("linkMandate"), []);
  });

  it("/mandateStatus reads BSE for a pending mandate and files the change", async () => {
    mandates = [{ exch_mandate_id: "501342", mode: "upi", status: "pending", amount: 100000, linked: false }];
    const r = await post("/mandateStatus", {});
    assert.equal(r.status, 200);
    assert.equal(r.body.data.mandates[0].status, "approved");
    assert.deepEqual(sent("getMandate")[0].data, { exch_mandate_id: 501342 });
    assert.equal(postsTo("/mandates")[0].body.status, "approved");
  });

  it("the routes that used to send demo payloads act only on the caller's own mandate", async () => {
    const r = await post("/getMandate", { data: { exch_mandate_id: 20 } });
    assert.equal(r.status, 404);
    assert.equal((await post("/registerMandateNach", {})).status, 501);
    assert.deepEqual(sent("getMandate"), []);
  });

  it("a SIP can name the investor's own ACTIVE mandate — and only that", async () => {
    const sip = (id) => ({ data: { scheme: "007G", amount: 5000, freq: "m", txn_date: 10, start_date: "2026-11-10", end_date: "2029-11-10", exch_mandate_id: id, acknowledged: ACKS() } });
    mandates = [{ exch_mandate_id: "501342", mode: "upi", status: "approved", amount: 100000 }];
    assert.equal((await post("/xspRegister", sip(501342))).status, 200);
    assert.equal(sent("xspRegister")[0].data.exch_mandate_id, 501342);

    mandates = [{ exch_mandate_id: "501342", mode: "upi", status: "pending", amount: 100000 }];
    const r = await post("/xspRegister", sip(501342));
    assert.equal(r.status, 400);
    assert.equal(sent("xspRegister").length, 1, "a pending mandate cannot pay a SIP");
  });
});

describe("Audit #20 — cancelled SIPs stay listed when Manage SIPs asks", () => {
  it("only the include_cancelled reader gets them", async () => {
    xspList = [
      { reg_no: "LIVE1", ucc: UCC, sxp_type: "SIP", status: "ACTIVE" },
      { reg_no: "GONE1", ucc: UCC, sxp_type: "SIP", status: "CANCELLED" },
      { reg_no: "DEAD1", ucc: UCC, sxp_type: "SIP", status: "EXPIRED" },
    ];
    const plain = await post("/getAllXsp", { data: {} });
    assert.deepEqual(plain.body.data.lists.map((r) => r.reg_no), ["LIVE1"]);
    const all = await post("/getAllXsp", { data: { include_cancelled: true } });
    assert.deepEqual(all.body.data.lists.map((r) => r.reg_no), ["LIVE1", "GONE1"]);
  });
});

describe("Audit #48 — reading order history reports settled orders to Laravel", () => {
  it("a stored pending order BSE has allotted is reported once, as completed", async () => {
    storedRows = [
      { bse_order_id: 900, order_type: "purchase", inv_amo: 5000, status: "pending" },
      { bse_order_id: 901, order_type: "purchase", inv_amo: 5000, status: "completed" },
    ];
    orderList = [
      { id: 900, status: "ALLOTTED", scheme: "007G" },
      { id: 901, status: "ALLOTTED", scheme: "007G" },
    ];
    const r = await post("/orderHistory", {});
    assert.equal(r.status, 200);
    // Not awaited by the handler (a page load does not wait on email) — give it a moment.
    for (let i = 0; i < 50 && !postsTo("/bse/order-status").length; i++) await new Promise((s) => setTimeout(s, 20));
    const [sync] = postsTo("/bse/order-status");
    assert.deepEqual(sync.body.updates, [{ bse_order_id: 900, state: "completed", bse_status: "ALLOTTED", remarks: "" }]);
  });
});

describe("Audit #49 — an approval keeps the order so it can be placed again", () => {
  it("the gate sends the order's details, and the approval it spends", async () => {
    let seen = null;
    approvalDecision = (body) => ((seen = body), { status: true, decision: "allow" });
    const r = await post("/purchaseNewOrder", order({ type: "p", scheme: "007G", amount: 6000 }, { approval_id: 12 }));
    assert.equal(r.status, 200);
    assert.deepEqual(seen.intent, { scheme: "007G", amount: 6000 });
    assert.equal(seen.approval_id, 12);
    assert.equal(seen.scheme_name, "PPFAS Mutual Fund FUND 007G", "the name reaches the admin queue now");
  });
});

describe("Audit #11 — basket checkout", () => {
  const plan = (legs) => ({ id: 3, name: "Mix", legs });
  const two = [
    { code: "007G", name: "Fund A", asset_type: "mutual_fund", weight: 60 },
    { code: "008G", name: "Fund B", asset_type: "mutual_fund", weight: 40 },
  ];
  const checkout = (amount, over = {}) => post("/basketCheckout", { data: { basket_id: 3, amount, acknowledged: ACKS(), ...over } });

  it("places one purchase per fund, split by weight, and records each in Laravel", async () => {
    basketPlanBody = plan(two);
    const r = await checkout(20000);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.placed, 2);
    assert.deepEqual(sent("purchaseNewOrder").map((p) => [p.data.orders[0].scheme, p.data.orders[0].amount]), [["007G", 12000], ["008G", 8000]]);
    const recorded = postsTo("/bse/order").map((p) => [p.body.scheme_bse_code, p.body.inv_amo, p.body.order_type]);
    assert.deepEqual(recorded, [["007G", 12000, "purchase"], ["008G", 8000, "purchase"]]);
  });

  it("refuses up front, placing nothing, when any fund's share is below its minimum", async () => {
    basketPlanBody = plan(two);
    const r = await checkout(9000); // ₹5,400 + ₹3,600 against a ₹5,000 minimum
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "basket_leg_refused");
    assert.deepEqual(r.body.data.legs.map((l) => l.result), ["not_placed", "refused"]);
    assert.match(r.body.data.legs[1].reason, /Minimum investment/);
    assert.deepEqual(sent("purchaseNewOrder"), []);
  });

  it("one acknowledgement covers the basket, and without it nothing runs", async () => {
    basketPlanBody = plan(two);
    const r = await checkout(20000, { acknowledged: [] });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "disclaimer_not_acknowledged");
    assert.deepEqual(sent("purchaseNewOrder"), []);
  });

  it("a leg held for approval or refused by its own gates is reported per fund", async () => {
    basketPlanBody = plan(two);
    approvalDecision = (body) =>
      body.scheme_code === "008G"
        ? { status: true, decision: "rejected", message: "Not approved by compliance." }
        : { status: true, decision: "allow" };
    const r = await checkout(20000);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.legs.map((l) => l.result), ["placed", "refused"]);
    assert.match(r.body.data.legs[1].reason, /Not approved/);
    assert.equal(sent("purchaseNewOrder").length, 1);
  });

  it("someone else's basket, or one holding stocks, is refused", async () => {
    assert.equal((await checkout(20000)).status, 404);
    basketPlanBody = plan([...two, { code: "INFY", name: "Infosys", asset_type: "stock", weight: 0 }]);
    const r = await checkout(20000);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Only mutual funds/);
    assert.deepEqual(sent("purchaseNewOrder"), []);
  });
});
