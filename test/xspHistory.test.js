// BSE's sxp_trxn_history treats `no_of_txn` as MANDATORY. It was sent only when the caller
// asked for a number, so every "Recent SIP payments" load came back
// `msgid 522, errcode "required", field "NoOfTxn"` and the panel read "No SIP installments
// recorded yet" however many instalments the SIP actually had.
//
// Probed both ways against the live demo host: without it 522/502, with it success.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const controller = require("../src/controllers/StarMFController");

const realHandle = controller.handleTrxnRequest;
const realWithOwned = controller.withOwnedSip;
let sent;

const stub = () => {
  sent = null;
  // Skip the ownership lookup: this is about the payload, not about who owns the SIP.
  controller.withOwnedSip = async (req, res, fn) =>
    fn({ status: "ACTIVE", sxp_type: "SIP" }, req.body?.data?.reg_no, req.body?.data || {});
  controller.handleTrxnRequest = async (method, reqObj, res) => {
    sent = { method, reqObj };
    return res.json({ status: "success", data: { lists: [] } });
  };
};

const fakeRes = () => {
  const out = { code: 200, body: null };
  out.status = (c) => ((out.code = c), out);
  out.json = (b) => ((out.body = b), out);
  return out;
};

describe("sxp_trxn_history always carries the field BSE requires", () => {
  afterEach(() => {
    controller.handleTrxnRequest = realHandle;
    controller.withOwnedSip = realWithOwned;
  });

  it("sends a default no_of_txn when the caller asks for no particular number", async () => {
    stub();
    await controller.getXspTrxnHistory({ ucc: "X", body: { data: { reg_no: "REG1" } } }, fakeRes());

    assert.equal(sent.method, "getXspTrxnHistory");
    const filter = sent.reqObj.data.filter_param;
    assert.ok("no_of_txn" in filter, "omitting it is msgid 522 and a 502");
    assert.ok(filter.no_of_txn > 0);
  });

  it("respects a number the caller does ask for", async () => {
    stub();
    await controller.getXspTrxnHistory({ ucc: "X", body: { data: { reg_no: "REG1", no_of_txn: 5 } } }, fakeRes());
    assert.equal(sent.reqObj.data.filter_param.no_of_txn, 5);
  });

  it("a nonsense count falls back rather than being passed through", async () => {
    for (const bad of [0, -3, "abc", null]) {
      stub();
      await controller.getXspTrxnHistory({ ucc: "X", body: { data: { reg_no: "REG1", no_of_txn: bad } } }, fakeRes());
      assert.ok(sent.reqObj.data.filter_param.no_of_txn > 0, `no_of_txn=${bad} must not reach BSE`);
    }
  });

  it("the optional date filters are still optional", async () => {
    stub();
    await controller.getXspTrxnHistory({ ucc: "X", body: { data: { reg_no: "REG1" } } }, fakeRes());
    const filter = sent.reqObj.data.filter_param;
    assert.ok(!("from_date" in filter), "an empty string date used to reach BSE as an invalid enum");
    assert.ok(!("to_date" in filter));
  });
});
