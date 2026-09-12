// orderHistory: every order this UCC placed, whatever happened to it.
//
// getClientPortfolio asks the same BSE endpoint but keeps only allotted, open orders —
// it is building a holdings list. History wants the opposite, so it fetches the open and
// closed legs separately (BSE's order_list always wants an `open_close`, and its own
// sample only ever sends "o") and merges them. That merge is the logic worth pinning:
// dedupe, sort, and what happens when one leg fails.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const controller = require("../src/controllers/StarMFController");

const realHandle = controller.handleTrxnRequest;
let calls;

// Stand in for BSE. `byLeg` maps open_close -> rows, or a function that throws/fails.
const stubBse = (byLeg) => {
  calls = [];
  controller.handleTrxnRequest = async (method, reqObj, res) => {
    const leg = reqObj?.data?.filter_param?.open_close;
    calls.push({ method, leg, filter: reqObj?.data?.filter_param });
    const value = byLeg[leg];
    if (value === "fail") return res.status(502).json({ status: "error", message: "BSE down" });
    return res.json({ status: "success", data: { lists: value || [] } });
  };
};

const fakeRes = () => {
  const out = { code: 200, body: null };
  out.status = (code) => ((out.code = code), out);
  out.json = (body) => ((out.body = body), out);
  return out;
};

const run = async (req = { ucc: "USRWC003", body: {} }) => {
  const res = fakeRes();
  await controller.orderHistory(req, res);
  return res;
};

const order = (id, date, extra = {}) => ({
  id,
  order_date: date,
  src_scheme_name: `FUND ${id}`,
  scheme: `S${id}`,
  amount: 5000,
  status: "ALLOTTED",
  ...extra,
});

afterEach(() => {
  controller.handleTrxnRequest = realHandle;
});

describe("orderHistory", () => {
  beforeEach(() => {
    calls = [];
  });

  it("asks BSE for both the open and the closed leg, scoped to this UCC", async () => {
    stubBse({ o: [order(1, "2026-09-01")], c: [order(2, "2026-08-01")] });
    const res = await run();

    assert.deepEqual(calls.map((c) => c.leg).sort(), ["c", "o"]);
    assert.equal(calls[0].method, "getAllOrders");
    // Without the UCC scope this would return the whole member book.
    assert.deepEqual(calls[0].filter.ucc, ["USRWC003"]);
    assert.equal(res.body.data.count, 2);
  });

  it("returns rejected and cancelled orders — the whole point of a history", async () => {
    stubBse({
      o: [order(1, "2026-09-01", { status: "PENDING" })],
      c: [
        order(2, "2026-08-01", { status: "REJECTED", remarks: "Insufficient funds" }),
        order(3, "2026-07-01", { status: "CANCELLED" }),
      ],
    });
    const res = await run();

    const statuses = res.body.data.orders.map((o) => o.status);
    assert.deepEqual(statuses, ["PENDING", "REJECTED", "CANCELLED"]);
    // BSE puts the reason in `remarks`; it is the only place the investor can read why.
    assert.equal(res.body.data.orders[1].remarks, "Insufficient funds");
  });

  it("shows an order once when it is settling and appears on both legs", async () => {
    const dupe = order(7, "2026-09-05");
    stubBse({ o: [dupe], c: [{ ...dupe }] });
    const res = await run();

    assert.equal(res.body.data.count, 1, "same order id must not be listed twice");
  });

  it("sorts newest first, with undated rows last rather than jumbled into the top", async () => {
    stubBse({
      o: [order(1, "2026-01-15"), order(2, null)],
      c: [order(3, "2026-09-09"), order(4, "2026-05-02")],
    });
    const res = await run();

    assert.deepEqual(res.body.data.orders.map((o) => o.id), [3, 4, 1, 2]);
  });

  it("still answers with the open leg when the closed leg fails", async () => {
    stubBse({ o: [order(1, "2026-09-01")], c: "fail" });
    const res = await run();

    assert.equal(res.code, 200, "one dead leg must not fail the whole page");
    assert.equal(res.body.data.count, 1);
  });

  it("reads BSE's field aliases rather than guessing one spelling", async () => {
    stubBse({
      o: [
        {
          order_id: 99,
          trxn_date: "2026-09-01",
          scheme_name: "ALIAS FUND",
          trxn_type: "PURCHASE",
          folio_num: "12345/67",
          units: 12.5,
          nav: 400,
          amount: 5000,
          status: "ALLOTTED",
        },
      ],
      c: [],
    });
    const res = await run();
    const o = res.body.data.orders[0];

    assert.equal(o.id, 99);
    assert.equal(o.date, "2026-09-01");
    assert.equal(o.scheme_name, "ALIAS FUND");
    assert.equal(o.type, "PURCHASE");
    assert.equal(o.folio, "12345/67", "folio_num, not folio — getClientPortfolio hit this exact bug");
    assert.equal(o.units, 12.5);
  });

  it("refuses without a UCC instead of asking BSE for the whole member book", async () => {
    stubBse({ o: [], c: [] });
    const res = await run({ body: {} });

    assert.equal(res.code, 400);
    assert.match(res.body.message, /ucc is required/);
    assert.equal(calls.length, 0, "no BSE call should have been made");
  });
});
