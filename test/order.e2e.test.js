// End-to-end order path: HTTP request -> auth middleware -> validation -> UCC
// binding -> BSE payload. BSE and the Laravel investor lookup are stubbed, so this
// asserts exactly what our backend would send without placing a real order.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const UCC = "USRWC003";
const TOKEN = "Bearer test-token-0123456789abcdef";

// Stub Laravel /investor-data before the app reads config.
let investorResponse = {
  status: true,
  data: { kyc: { ucc_code: UCC, kyc_status: "verified" }, email: "a@b.com", phone: "9999999999" },
};
let investorStatus = 200;
const authServer = http.createServer((req, res) => {
  res.writeHead(investorStatus, { "Content-Type": "application/json" });
  res.end(JSON.stringify(investorResponse));
});

let app, sent, bseResponse;

before(async () => {
  await new Promise((r) => authServer.listen(0, "127.0.0.1", r));
  process.env.LARAVEL_INVESTOR_URL = `http://127.0.0.1:${authServer.address().port}/investor-data`;

  const express = require("express");
  const rootRoute = require("../src/route/root-route/rootRoute");
  const controller = require("../src/controllers/StarMFController");

  controller.loginFunc = async () => ({ status: "success" });
  controller.accessToken = "stub-token";
  // Scheme the order references — mirrors a real BSE master row.
  controller.masterDataService.getSchemeMasterList = async () => ({
    data: { count: 1, lists: [{ scheme_name: "SBI ESG GROWTH", scheme_isin: "INF200K01214", scheme_bse_code: "007G", min_lumpsum_amount: 5000, min_redemption_amount: 1000, purchase_allowed: "Y", scheme_status: "active" }] },
  });
  controller.trxnService.purchaseNewOrder = async (_t, payload) => {
    sent = payload;
    return bseResponse;
  };

  app = express();
  app.use(express.json());
  app.use("/api", rootRoute);
});

after(() => authServer.close());

// Minimal request helper — Node 22 has global fetch.
let server, base;
async function boot() {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
async function post(path, body, token = TOKEN) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;
  const r = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const buy = (over = {}) => ({
  data: { orders: [{ type: "p", scheme: "007G", amount: 5000, cur: "INR", mem_ord_ref_id: "REF1", ...over }] },
});
const sell = (over = {}) => ({
  data: { orders: [{ type: "r", scheme: "007G", amount: 2000, folio: "F123", mem_ord_ref_id: "REF2", ...over }] },
});

describe("order path end to end", () => {
  before(async () => {
    await boot();
    bseResponse = { status: "success", data: { items: [{ id: "ORD1", mem_ord_ref_id: "REF1" }] } };
  });
  after(() => server.close());

  it("rejects an unauthenticated buy before touching BSE", async () => {
    sent = null;
    const r = await post("/purchaseNewOrder", buy(), null);
    assert.equal(r.status, 401);
    assert.equal(sent, null, "BSE must not be called without auth");
  });

  it("rejects a bad token", async () => {
    investorStatus = 401;
    investorResponse = { status: false };
    sent = null;
    const r = await post("/purchaseNewOrder", buy());
    assert.equal(r.status, 401);
    assert.equal(sent, null);
    investorStatus = 200;
    investorResponse = {
      status: true,
      data: { kyc: { ucc_code: UCC, kyc_status: "verified" }, email: "a@b.com", phone: "9999999999" },
    };
  });

  it("places a buy and sends the right payload to BSE", async () => {
    sent = null;
    const r = await post("/purchaseNewOrder", buy());
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "success");
    assert.equal(r.body.data.items[0].id, "ORD1", "order id returned to the UI");

    const order = sent.data.orders[0];
    assert.equal(order.type, "p");
    assert.equal(order.scheme, "007G");
    assert.equal(order.amount, 5000);
    assert.equal(order.investor.ucc, UCC, "UCC comes from the verified investor");
    assert.equal(order.member, "91010");
    assert.equal(order.cur, "INR");
    assert.ok(order.mem_ord_ref_id, "carries a member order reference");
  });

  it("overrides a spoofed UCC with the authenticated investor's", async () => {
    sent = null;
    const r = await post("/purchaseNewOrder", buy({ investor: { ucc: "ATTACKER1" } }));
    // The UCC guard runs before the order is built.
    assert.equal(r.status, 403, "mismatched UCC is refused");
    assert.equal(sent, null, "nothing reaches BSE");
  });

  it("enforces the scheme minimum", async () => {
    sent = null;
    const r = await post("/purchaseNewOrder", buy({ amount: 100 }));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Minimum investment/i);
    assert.equal(sent, null, "under-minimum order never reaches BSE");
  });

  it("rejects malformed buys", async () => {
    for (const [payload, why] of [
      [{ data: { orders: [] } }, "empty orders"],
      [buy({ amount: 0 }), "zero amount"],
      [buy({ amount: -500 }), "negative amount"],
      [buy({ scheme: "" }), "missing scheme"],
      [buy({ type: "x" }), "unknown type"],
    ]) {
      sent = null;
      const r = await post("/purchaseNewOrder", payload);
      assert.equal(r.status, 400, `should reject: ${why}`);
      assert.equal(sent, null, `must not reach BSE: ${why}`);
    }
  });

  it("places a sell (redemption) with folio", async () => {
    sent = null;
    const r = await post("/purchaseNewOrder", sell());
    assert.equal(r.status, 200);
    const order = sent.data.orders[0];
    assert.equal(order.type, "r");
    assert.equal(order.amount, 2000);
    assert.equal(order.folio, "F123");
    assert.equal(order.investor.ucc, UCC);
  });

  it("supports redeem-all and zeroes the amount", async () => {
    sent = null;
    const r = await post("/purchaseNewOrder", sell({ all_units: true, amount: 999 }));
    assert.equal(r.status, 200);
    assert.equal(sent.data.orders[0].all_units, true);
    assert.equal(sent.data.orders[0].amount, 0, "all_units redemption must not carry an amount");
  });

  it("rejects a sell without a folio and under the minimum", async () => {
    sent = null;
    let r = await post("/purchaseNewOrder", sell({ folio: "" }));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /folio/i);
    assert.equal(sent, null);

    r = await post("/purchaseNewOrder", sell({ amount: 10 }));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Minimum redemption/i);
  });

  it("surfaces a BSE rejection instead of reporting success", async () => {
    bseResponse = { status: "error", messages: [{ msg: "Scheme suspended" }] };
    const r = await post("/purchaseNewOrder", buy());
    assert.notEqual(r.body.status, "success", "a BSE error must not read as success");
    bseResponse = { status: "success", data: { items: [{ id: "ORD1" }] } };
  });
});
