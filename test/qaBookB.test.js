// The QA book's answers for the transaction flows (Audit #11, #22, #46, #49), so each can be
// shown working on a machine BSE will not talk to — and never answered outside QA.
const test = require("node:test");
const assert = require("node:assert");

const load = () => {
  delete require.cache[require.resolve("../src/mf/qaFixtures")];
  return require("../src/mf/qaFixtures");
};
const QA = "QAUCC0001";
const ordersReq = { data: { filter_param: { ucc: [QA], open_close: "o" } } };

test("the book's scheme master answers only in QA, and only for its own scheme", () => {
  delete process.env.MF_QA_UCC;
  assert.equal(load().qaScheme("PP001ZG-GR"), null, "never outside QA");

  process.env.MF_QA_UCC = QA;
  const qa = load();
  const row = qa.qaScheme("pp001zg-gr");
  assert.equal(row.scheme_bse_code, "PP001ZG-GR");
  assert.equal(row.scheme_amc_name, "PPFAS Mutual Fund", "AMFI's banner, so a same-AMC switch matches the catalogue");
  assert.equal(qa.qaScheme("HDLFDDN-DR"), null, "the debt fund stays unknown on purpose");
  assert.equal(qa.qaScheme("122639"), null, "an AMFI code is not the book's");

  const { schemeTransactions, mapScheme } = require("../src/mf/scheme");
  assert.equal(mapScheme(row).txn.swp, true, "the SWP option shows for the book's equity fund");
  assert.equal(schemeTransactions(row).switchOut.allowed, true);
  assert.equal(schemeTransactions(row).lumpsum.minAmount, null, "no minimum is claimed for the AMC");
});

test("a purchase into a scheme outside the book is filed under its own code, unallotted", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();
  const res = qa.answer("purchaseNewOrder", { data: { orders: [{ type: "p", investor: { ucc: QA }, scheme: "143269", amount: 4000 }] } });
  const row = qa.answer("getAllOrders", ordersReq).data.lists.find((o) => o.id === res.data.items[0].id);
  assert.equal(row.scheme, "143269");
  assert.equal(row.units, 0);
  assert.equal(row.status, "ACCEPTED");
});

test("a pending purchase can be cancelled once; a settled one answers not_allowed", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();
  const placed = qa.answer("purchaseNewOrder", { data: { orders: [{ type: "p", investor: { ucc: QA }, scheme: "PP001ZG-GR", amount: 5000 }] } });
  const id = placed.data.items[0].id;
  const cancel = (oid) => qa.answer("cancelPurchaseOrder", { data: { id: oid, investor: { ucc: QA, pan_holders: [], holding_nature: "" } } });

  assert.equal(cancel(id).status, "success");
  assert.equal(qa.answer("getAllOrders", ordersReq).data.lists.find((o) => o.id === id).status, "CANCELLED");
  assert.equal(cancel(id).status, "error", "twice is not allowed");
  assert.equal(cancel(900001).status, "error", "an allotted order cannot be cancelled");
});

test("a mandate registers PENDING, links to a SIP, and reads APPROVED on the first status check", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();
  const upi = qa.answer("registerMandate", { data: { investor: { ucc: QA }, type: "U", mode: "DD", amount: 100000 } });
  assert.equal(upi.data.status, "PENDING");
  assert.equal(upi.data.mandate_auth_link, undefined, "UPI AutoPay is approved in the UPI app, not on a page");

  const enach = qa.answer("registerMandate", { data: { investor: { ucc: QA }, type: "X", mode: "DD", amount: 100000 } });
  assert.ok(enach.data.mandate_auth_link, "an e-mandate comes back with somewhere to approve it");

  const id = enach.data.exch_mandate_id;
  const sip = qa.answer("getAllXsp", { data: { search: { value: QA } } }).data.lists.find((r) => r.sxp_type === "SIP");
  assert.equal(qa.answer("linkMandate", { data: { reg_no: sip.reg_no, exch_mandate_id: id } }).status, "success");
  // A mandate id on its own (no client code in the payload) still finds the book.
  assert.equal(qa.answer("getMandate", { data: { exch_mandate_id: id } }).data.status, "APPROVED");
  assert.equal(qa.answer("getMandate", { data: { exch_mandate_id: 123 } }), null, "not ours: BSE's to answer");
});

test("a new SIP carries a mandate only when one was named", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();
  const plain = qa.answer("xspRegister", { data: { ucc: QA, sxp_type: "SIP", src_scheme: "PP001ZG-GR", amount: 1000 } });
  const row = qa.answer("getAllXsp", { data: { search: { value: QA } } }).data.lists.find((r) => r.reg_no === plain.data.reg_no);
  assert.equal(row.mandate_status, undefined, "no mandate, no 'APPROVED' chip");
});
