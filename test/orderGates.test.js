// Audit #18, #42, #46, #48, #49, #11 — the pure rules behind the transaction gates. The
// HTTP-level behaviour is in transactions.e2e.test.js; these pin the decisions themselves.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const templates = require("../src/requestData/orderRequestData");
const { switchRefusal, panVerified, buildCancelOrderPayload } = require("../src/mf/order");
const { netUnits, swpOverValue } = require("../src/mf/xsp");
const { orderState, statusChanges } = require("../src/mf/storedOrders");
const { splitByWeight } = require("../src/mf/basket");

const OPEN = { scheme_transaction_effective_start_date: "2010-01-01T00:00:00", scheme_transaction_effective_end_date: "2037-12-31T00:00:00" };
const scheme = (amc, lumpsum = ["Purchase", "Switch-IN", "Switch-OUT"]) => ({
  scheme_bse_code: `${amc}-1`,
  scheme_amc_name: amc,
  is_active: true,
  lumpsum: lumpsum.map((t) => (typeof t === "string" ? { scheme_transaction_type: t, ...OPEN } : t)),
});

describe("Audit #46 — switch rules", () => {
  it("a switch within one fund house goes through", () => {
    assert.equal(switchRefusal(scheme("PPFAS Mutual Fund"), scheme("PPFAS MUTUAL FUND")), null);
  });

  it("across fund houses it is refused", () => {
    assert.match(switchRefusal(scheme("PPFAS Mutual Fund"), scheme("HDFC Mutual Fund")), /same fund house/);
  });

  it("an AMC BSE did not publish on either side is left to BSE", () => {
    assert.equal(switchRefusal({ ...scheme(""), scheme_amc_name: "" }, scheme("HDFC Mutual Fund")), null);
  });

  it("codes are compared with codes, never with names", () => {
    const a = { ...scheme("PPFAS Mutual Fund"), amc_code: "PPFAS" };
    const b = { ...scheme("PPFAS Mutual Fund"), amc_code: "HDFC" };
    assert.match(switchRefusal(a, b), /same fund house/);
  });

  it("a closed Switch-OUT on the source or Switch-IN on the destination refuses; silence does not", () => {
    const closed = { scheme_transaction_type: "Switch-OUT", scheme_transaction_effective_start_date: "2010-01-01", scheme_transaction_effective_end_date: "2020-01-01" };
    assert.match(switchRefusal(scheme("X", ["Purchase", closed]), scheme("X")), /switching out/);
    const closedIn = { ...closed, scheme_transaction_type: "Switch-IN" };
    assert.match(switchRefusal(scheme("X"), scheme("X", ["Purchase", closedIn])), /accept switches in/);
    assert.equal(switchRefusal(scheme("X", ["Purchase"]), scheme("X", ["Purchase"])), null);
  });

  it("a destination that does not exist or is not open for purchase is refused", () => {
    assert.match(switchRefusal(scheme("X"), null), /not open/);
    assert.match(switchRefusal(scheme("X"), { ...scheme("X"), is_active: false }), /not open/);
  });
});

describe("Audit #42 — a verified PAN", () => {
  it("only investor-data's pan_verified flag counts", () => {
    for (const v of [true, 1, "1", "true"]) assert.equal(panVerified({ profile: { pan_verified: v } }), true, String(v));
    for (const v of [false, 0, "0", null, undefined]) assert.equal(panVerified({ profile: { pan_verified: v } }), false, String(v));
    assert.equal(panVerified({}), false, "no profile at all is not verified");
    assert.equal(panVerified({ kyc: { kyc_status: "verified" } }), false, "KYC alone is not the PAN flag");
  });
});

describe("Audit #49 — cancelling an order", () => {
  it("is the template's shape, with the session's UCC and BSE's own holder record", () => {
    const info = { holding_nature: "SI", holder: [{ identifier: [{ identifier_type: "pan", identifier_number: "ABCPE1234F" }] }] };
    const { data } = buildCancelOrderPayload("5001433387", { ucc: "UCC1", info, remark: "  changed my mind " });
    assert.deepEqual(Object.keys(data).sort(), Object.keys(templates.cancelPurchaseOrder.data).sort());
    assert.deepEqual(Object.keys(data.investor).sort(), Object.keys(templates.cancelPurchaseOrder.data.investor).sort());
    assert.equal(data.id, 5001433387);
    assert.deepEqual(data.investor, { ucc: "UCC1", pan_holders: ["ABCPE1234F"], holding_nature: "SI" });
    assert.equal(data.remark, "changed my mind");
  });

  it("without a UCC record it sends the template's own empty values, and a default remark", () => {
    const { data } = buildCancelOrderPayload(42, { ucc: "UCC1", info: null });
    assert.deepEqual(data.investor, { ucc: "UCC1", pan_holders: [], holding_nature: "" });
    assert.equal(data.remark, "Cancelled by investor");
  });
});

describe("Audit #18 — an SWP cannot pay out more than the folio is worth", () => {
  const rows = [
    { trxn_type: "P", units: 205.761, amount: 10000 },
    { trxn_type: "P", units: 239.521, amount: 12000 },
    { trxn_type: "R", units: 78.585, amount: 4000 },
  ];

  it("units held are net of what was sold", () => {
    assert.equal(Math.round(netUnits(rows) * 1000) / 1000, 366.697);
    assert.equal(netUnits(rows, "amount"), 18000);
    assert.equal(netUnits([{ trxn_type: "SWP", units: 5 }, { trxn_type: "P", units: 10 }]), 5);
  });

  it("refuses an instalment above the holding's value, and says both numbers", () => {
    const msg = swpOverValue(40000, 33572.75);
    assert.match(msg, /₹40,000/);
    assert.match(msg, /₹33,572\.75/);
    assert.equal(swpOverValue(33572.75, 33572.75), null, "exactly the value is still payable once");
    assert.equal(swpOverValue(2000, 33572.75), null);
  });

  it("an unknown value never refuses — BSE checks every instalment anyway", () => {
    assert.equal(swpOverValue(40000, null), null);
    assert.equal(swpOverValue(40000, 0), null);
  });
});

describe("Audit #48 — order status sync", () => {
  it("maps BSE's words onto pending → completed | rejected | cancelled", () => {
    assert.equal(orderState("ALLOTTED"), "completed");
    assert.equal(orderState("Rejected"), "rejected");
    assert.equal(orderState("PAYMENT FAILED"), "rejected");
    assert.equal(orderState("CANCELLED"), "cancelled");
    assert.equal(orderState("ALLOTMENT CANCELLED"), "cancelled", "cancel wins over allot");
    for (const moving of ["PENDING", "ACCEPTED", "PAID", "", null]) assert.equal(orderState(moving), null, String(moving));
  });

  it("reports only stored orders whose BSE status moved to a final state they do not have yet", () => {
    const stored = [
      { id: 1, status: "pending" },
      { id: 2, status: "completed" },
      { id: 3, status: "pending" },
      { id: 4, status: "pending" },
      { id: null, status: "pending" },
    ];
    const live = [
      { id: 1, status: "ALLOTTED" },
      { id: 2, status: "ALLOTTED" },
      { id: 3, status: "ACCEPTED" },
      { id: 4, status: "REJECTED", remarks: "Payment not received within cut-off" },
    ];
    assert.deepEqual(statusChanges(stored, live), [
      { bse_order_id: 1, state: "completed", bse_status: "ALLOTTED", remarks: "" },
      { bse_order_id: 4, state: "rejected", bse_status: "REJECTED", remarks: "Payment not received within cut-off" },
    ]);
  });
});

describe("Audit #11 — splitting a basket amount by its weights", () => {
  it("adds back to the amount to the paisa", () => {
    const parts = splitByWeight(1000, [33.33, 33.33, 33.34]);
    assert.equal(Math.round(parts.reduce((a, b) => a + b, 0) * 100), 100000);
    assert.deepEqual(splitByWeight(6000, [50, 30, 20]), [3000, 1800, 1200]);
  });

  it("uses the weights' own sum, so 100 ± 0.01 still splits the whole amount", () => {
    const parts = splitByWeight(999.99, [60, 39.99]);
    assert.equal(Math.round(parts.reduce((a, b) => a + b, 0) * 100), 99999);
  });

  it("nothing to split is all zeros, never NaN", () => {
    assert.deepEqual(splitByWeight(0, [50, 50]), [0, 0]);
    assert.deepEqual(splitByWeight(100, [0, 0]), [0, 0]);
  });
});
