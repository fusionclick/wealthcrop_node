// Audit #31-#33 — the compliance half of the order gate, end to end: HTTP -> auth -> gate ->
// consent trail -> BSE payload. Laravel and BSE are stubbed (same harness as
// order.e2e.test.js), so this asserts what our backend would SEND without placing an order.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const UCC = "USRWC003";
const TOKEN = "Bearer test-token-0123456789abcdef";
const RM = { euin: "E654321", name: "Asha Rao" };

// ── Laravel stub: investor lookup, distributor settings, consent log ──────────────────
const consentPosts = [];
let consentAvailable = true;
let distributor = {
  legal_entity: "Example Distributors Pvt Ltd",
  arn: "ARN-000001",
  sub_br_code: "",
  commission_url: "http://laravel.test/commission-structure",
  commission_version: "",
  rms: [RM, { euin: "not-an-euin", name: "Typo" }],
};
const laravel = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.includes("/distributor")) return res.end(JSON.stringify({ status: true, data: distributor }));
    if (req.url.includes("/consents")) {
      consentPosts.push(JSON.parse(raw || "{}"));
      return res.end(JSON.stringify({ status: consentAvailable }));
    }
    res.end(
      JSON.stringify({
        status: true,
        data: {
          kyc: { ucc_code: UCC, kyc_status: "verified" },
          email: "a@b.com",
          phone: "9999999999",
          riskProfile: { profile: "Aggressive", score: 82 },
        },
      })
    );
  });
});

let base, server, sent, controller;
const ACKS = () => require("../src/mf/suitability").REQUIRED_ACKS;

before(async () => {
  await new Promise((r) => laravel.listen(0, "127.0.0.1", r));
  // Before anything pulls in config.js — otherwise every call here goes to the real host.
  process.env.LARAVEL_INVESTOR_URL = `http://127.0.0.1:${laravel.address().port}/investor-data`;

  const express = require("express");
  const rootRoute = require("../src/route/root-route/rootRoute");
  controller = require("../src/controllers/StarMFController");
  controller.loginFunc = async () => ({ status: "success" });
  controller.accessToken = "stub-token";
  // A riskometer level on the row, so the gate never reaches for the enrichment feed.
  const row = (code, name) => ({
    scheme_name: name,
    scheme_isin: `INF200K0${code}`,
    scheme_bse_code: code,
    purchase_allowed: "Y",
    scheme_status: "active",
    scheme_riskometer: "Moderate",
    lumpsum: [],
  });
  controller.masterDataService.getSchemeMasterList = async (_t, reqObj) => {
    const code = reqObj?.data?.search?.value;
    const rows = [row("007G", "SBI ESG FUND REGULAR GROWTH"), row("007DG", "SBI ESG FUND DIRECT PLAN GROWTH")];
    return { data: { lists: rows.filter((r) => r.scheme_bse_code === code) } };
  };
  controller.lookupDepository = async () => ({ depository: "C", dp_id: "12345678", client_id: "12345678" });
  controller.lookupUcc = async () => ({ is_client_demat: true });
  controller.trxnService.purchaseNewOrder = async (_t, payload) => {
    sent = payload;
    return { status: "success", data: { items: [{ id: "ORD1", mem_ord_ref_id: "REF1" }] } };
  };

  const app = express();
  app.use(express.json());
  app.use("/api", rootRoute);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server?.close();
  laravel.close();
});

async function call(method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "User-Agent": "WealthCropBrowser/1.0", Authorization: TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

const buy = (acknowledged, over = {}) => ({
  data: {
    orders: [{ type: "p", scheme: "007G", amount: 5000, cur: "INR", mem_ord_ref_id: "REF1", ...over }],
    acknowledged,
  },
});
const rmAcks = (euin = RM.euin) => [...ACKS().filter((k) => k !== "execution_only"), `rm_assisted:${euin}`];

describe("Audit #33: the consent matrix, as the order path writes it", () => {
  before(async () => {
    // What every checkout does first: it loads /disclaimers, which warms the register.
    const d = await call("GET", "/disclaimers");
    assert.equal(d.status, 200);
  });

  it("/disclaimers publishes the RM register (well-formed EUINs only) and the configured entity", async () => {
    const { body } = await call("GET", "/disclaimers");
    assert.deepEqual(body.data.rms, [RM]);
    assert.match(body.data.disclaimers.rm_assisted, /Example Distributors Pvt Ltd/);
    assert.match(body.data.disclaimers.execution_only, /Example Distributors Pvt Ltd/);
    assert.equal(body.data.distributor.line, "Example Distributors Pvt Ltd | AMFI-registered Mutual Fund Distributor | ARN: ARN-000001");
    // Audit #32: the link is always there; this says the rates behind it are not published.
    assert.equal(body.data.commission_published, false);
  });

  it("an execution-only buy logs execution_only WITH the order reference", async () => {
    consentPosts.length = 0;
    const r = await call("POST", "/purchaseNewOrder", buy(ACKS()));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = consentPosts.at(-1).consents;
    const decl = rows.find((c) => c.type === "execution_only");
    // It read data.mem_ord_ref_id, which a lumpsum never has — every row was order_id NULL.
    assert.equal(decl.order_id, "REF1");
    assert.equal(decl.euin_declared, true);
    assert.equal(decl.euin_number, null);
    assert.ok(rows.every((c) => c.order_id === "REF1"));
    assert.equal(rows.find((c) => c.type === "regular_plan_commission").commission_version, null,
      "no published table means no version to claim");
    assert.equal(sent.data.orders[0].mem_details.euin_flag, true);
    assert.equal(sent.data.orders[0].mem_details.euin, "");
  });

  it("an RM-assisted buy sends that EUIN with the declaration off, and logs rm_assisted", async () => {
    consentPosts.length = 0;
    sent = null;
    const r = await call("POST", "/purchaseNewOrder", buy(rmAcks()));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sent.data.orders[0].mem_details.euin, RM.euin);
    assert.equal(sent.data.orders[0].mem_details.euin_flag, false, "EUINDecl must be N next to a named EUIN");
    const decl = consentPosts.at(-1).consents[0];
    assert.equal(decl.type, "rm_assisted");
    assert.equal(decl.euin_number, RM.euin);
    assert.equal(decl.euin_declared, false);
    assert.equal(decl.order_id, "REF1");
  });

  it("an EUIN that is not on the register never reaches BSE", async () => {
    sent = null;
    const r = await call("POST", "/purchaseNewOrder", buy(rmAcks("E999999")));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "rm_not_registered");
    assert.equal(sent, null);
  });

  it("execution-only and RM-assisted together is a contradiction, refused", async () => {
    sent = null;
    const r = await call("POST", "/purchaseNewOrder", buy([...ACKS(), `rm_assisted:${RM.euin}`]));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "rm_declaration_conflict");
    assert.equal(sent, null);
  });

  it("does not submit an order when consent storage does not acknowledge persistence", async () => {
    sent = null;
    consentAvailable = false;
    try {
      const r = await call("POST", "/purchaseNewOrder", buy(ACKS()));
      assert.equal(r.status, 503);
      assert.equal(r.body.code, "consent_unavailable");
      assert.equal(sent, null);
    } finally { consentAvailable = true; }
  });
});

describe("published NAVs and shared allocation calculations", () => {
  it("quotes only requested ISINs and rejects malformed quote requests", async () => {
    const navStore = require('../src/mf/navStore');
    const original = navStore.getNavs;
    navStore.getNavs = async () => ({ navs: { INF123456789: { nav: 100, date: '2026-10-01' }, INF987654321: { nav: 200 } } });
    try {
      const quote = await call('POST', '/nav-quotes', { isins: ['INF123456789'] });
      assert.equal(quote.status, 200);
      assert.deepEqual(Object.keys(quote.body.data), ['INF123456789']);
      assert.equal(quote.body.data.INF123456789.nav, 100);
      assert.equal((await call('POST', '/nav-quotes', { isins: ['bad'] })).status, 422);
    } finally { navStore.getNavs = original; }
  });
  it("recalculates a bounded allocation without needing an investor login", async () => {
    const response = await fetch(`${base}/allocation-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ risk: 'Conservative', lifeStage: 'mid', horizonYears: 2, monthlyAmount: 5000 }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(Object.values(result.data.allocation).reduce((sum, n) => sum + n, 0), 100);
    assert.equal((await call('POST', '/allocation-review', { risk: 'invalid' })).status, 422);
  });
});

describe("Audit #31: a Direct plan cannot be bought through a distributor", () => {
  it("refuses a Direct plan purchase before BSE sees it", async () => {
    sent = null;
    const r = await call("POST", "/purchaseNewOrder", buy(ACKS(), { scheme: "007DG" }));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "direct_plan_not_offered");
    assert.equal(sent, null);
  });
});

describe("Audit #32: a SIP top-up takes the disclaimer gate", () => {
  const MINE = { reg_no: "REG-MINE", ucc: UCC, sxp_type: "SIP", status: "active", src_scheme: "007G", amount: 5000 };
  const fakeRes = () => {
    const out = { code: 200, body: null };
    return {
      out,
      json: (b) => ((out.body = b), out),
      status: (c) => ((out.code = c), { json: (b) => ((out.body = b), out) }),
    };
  };
  const reqFor = (data) => ({
    ucc: UCC,
    headers: { authorization: TOKEN },
    investor: { email: "a@b.com", kyc: {}, riskProfile: { profile: "Aggressive" } },
    body: { data: { reg_no: "REG-MINE", amount: 2000, freq: "y", ...data } },
  });
  let topups;
  before(() => {
    controller.callTrxn = async (method) =>
      method === "getAllXsp" ? { status: "success", data: { lists: [MINE] } } : { status: "success" };
    controller.sipLimitsFor = async () => ({ minAmount: 1000 });
    controller.handleTrxnRequest = async (method, reqObj, res) => {
      if (method === "topupXsp") topups.push(reqObj);
      return res.json({ status: "success" });
    };
  });

  it("refuses a top-up that carries no acknowledgement — it used to skip the gate entirely", async () => {
    topups = [];
    const res = fakeRes();
    await controller.topupXsp(reqFor({}), res);
    assert.equal(res.out.code, 403);
    assert.equal(res.out.body.code, "disclaimer_not_acknowledged");
    assert.equal(topups.length, 0);
  });

  it("an acknowledged top-up goes through", async () => {
    topups = [];
    const res = fakeRes();
    await controller.topupXsp(reqFor({ acknowledged: ACKS() }), res);
    assert.equal(res.out.code, 200);
    assert.equal(topups.length, 1);
    assert.equal(topups[0].data.reg_num, "REG-MINE");
  });
});
