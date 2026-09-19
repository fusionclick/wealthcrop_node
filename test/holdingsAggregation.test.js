// getClientPortfolio builds HOLDINGS, and a holding is a position — not a transaction.
//
// BSE's order_list hands back one row per order, and those used to be mapped straight
// through. Three purchases into one folio therefore drew three identical lines in the
// portfolio and three identical entries in the Redeem and Switch dropdowns, each carrying a
// third of the money. This pins the folding, and the sign: a redemption has to come OFF the
// position, or selling would report more invested than before.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const controller = require("../src/controllers/StarMFController");

const realHandle = controller.handleTrxnRequest;

const stubBse = (rows) => {
  controller.handleTrxnRequest = async (method, reqObj, res) =>
    res.json({ status: "success", data: { lists: rows } });
};

const fakeRes = () => {
  const out = { code: 200, body: null };
  out.status = (code) => ((out.code = code), out);
  out.json = (body) => ((out.body = body), out);
  return out;
};

const holdings = async () => {
  const res = fakeRes();
  await controller.getClientPortfolio({ ucc: "QAUCC0001", body: {} }, res);
  return res.body?.data?.holdings || [];
};

const order = (over = {}) => ({
  scheme: "HDLFDDN-DR",
  src_scheme_name: "HDFC LIQUID FUND",
  folio_num: "QA1000002",
  status: "ALLOTTED",
  trxn_type: "P",
  amount: 10000,
  units: 200,
  nav: 50,
  ...over,
});

describe("holdings fold onto scheme + folio", () => {
  afterEach(() => {
    controller.handleTrxnRequest = realHandle;
  });

  it("three purchases in one folio are one holding carrying the total", async () => {
    stubBse([order({ amount: 10000, units: 200 }), order({ amount: 12000, units: 240 }), order({ amount: 4000, units: 80 })]);

    const rows = await holdings();
    assert.equal(rows.length, 1, "one folio is one line, not three");
    assert.equal(rows[0].inv_amo, 26000);
    assert.equal(rows[0].units, 520);
    assert.equal(rows[0].folio, "QA1000002");
    assert.equal(rows[0].orders, 3, "the count is kept so the UI can say how it got there");
  });

  it("a redemption reduces the position instead of inflating it", async () => {
    stubBse([
      order({ amount: 10000, units: 200 }),
      order({ amount: 12000, units: 240 }),
      order({ amount: 4000, units: 80, trxn_type: "R" }),
    ]);

    const [row] = await holdings();
    assert.equal(row.inv_amo, 18000, "22,000 in and 4,000 back out");
    assert.equal(row.units, 360);
  });

  it("the same fund in two folios stays two holdings", async () => {
    stubBse([order({ folio_num: "F1", amount: 5000 }), order({ folio_num: "F2", amount: 7000 })]);

    const rows = await holdings();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.inv_amo).sort((a, b) => a - b), [5000, 7000]);
  });

  it("a folio sold down to nothing is not offered as a holding", async () => {
    // Redeeming everything must not leave a Redeem button for units that are gone.
    stubBse([order({ amount: 10000, units: 200 }), order({ amount: 10000, units: 200, trxn_type: "R" })]);

    assert.equal((await holdings()).length, 0);
  });

  it("different funds never fold together", async () => {
    stubBse([order(), order({ scheme: "PP001ZG-GR", src_scheme_name: "PPFAS", folio_num: "QA1000002" })]);
    assert.equal((await holdings()).length, 2);
  });

  it("an unpaid order is still not a holding", async () => {
    stubBse([order(), order({ status: "PENDING", amount: 9999 })]);

    const rows = await holdings();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inv_amo, 10000, "the pending order's money is not invested yet");
  });

  it("prices the position instead of hard-coding a zero return", async () => {
    // `ret_percentage` used to be the literal 0 on every row, and everything downstream
    // reads it — the Returns tile, sort-by-returns, and through `invested + returns` the
    // value handed to XIRR. So the portfolio reported a flat 0% and a confident ~0% p.a.
    //
    // order_list's own `nav` is the ALLOTMENT nav, the price that was paid, so it can never
    // show a gain. The valuation comes from the AMFI NAV store instead. No store is
    // reachable from a test run, which is exactly the case worth pinning: unknown must
    // report null, because "not known" and "no gain" are different answers.
    stubBse([order({ amount: 10000, units: 200, nav: 50 })]);

    const [row] = await holdings();
    assert.ok("current_nav" in row, "the UI needs to know whether a price was found at all");
    assert.ok("current_value" in row);
    assert.equal(row.current_value, null);
    assert.equal(row.ret_percentage, null, "never 0 — that is a claim, not a missing value");
    assert.equal(row.inv_amo, 10000, "and the cost is still reported");
  });
});
