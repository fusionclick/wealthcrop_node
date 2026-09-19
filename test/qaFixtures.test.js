const test = require("node:test");
const assert = require("node:assert");

const load = () => {
  delete require.cache[require.resolve("../src/mf/qaFixtures")];
  return require("../src/mf/qaFixtures");
};

const QA = "QAUCC0001";
const ordersReq = (ucc) => ({ data: { filter_param: { ucc: [ucc], open_close: "o" } } });
const xspReq = (ucc) => ({ data: { filter_param: {}, search: { value: ucc } } });

test("off by default — an unset MF_QA_UCC changes nothing", () => {
  delete process.env.MF_QA_UCC;
  const qa = load();
  assert.equal(qa.enabled(), false);
  assert.equal(qa.answer("getAllOrders", ordersReq(QA)), null);
  assert.equal(qa.answer("getAllXsp", xspReq(QA)), null);
});

test("a UCC that is not listed still goes to BSE", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  assert.equal(qa.answer("getAllOrders", ordersReq("REALUSER99")), null);
});

test("holdings have folios, and the rejected order is not one of them", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  const rows = qa.answer("getAllOrders", ordersReq(QA)).data.lists;

  assert.ok(rows.length >= 8, "history needs more than one row to be worth testing");
  const held = rows.filter((o) => ["ALLOTTED", "ACCEPTED", "PAID"].includes(o.status));
  assert.ok(held.length > 0);
  assert.ok(held.every((o) => o.folio_num), "every holding must carry a folio — redeem refuses without one");

  // The whole point of the rejected row: history shows it, the portfolio must not.
  const rejected = rows.find((o) => o.status === "REJECTED");
  assert.ok(rejected, "history should include a failed order");
  assert.equal(rejected.units, 0);
});

test("purchases are spread over time, so XIRR is a real rate and not a divide by zero", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  const dates = qa
    .answer("getAllOrders", ordersReq(QA))
    .data.lists.map((o) => o.order_date);
  assert.ok(new Set(dates).size > 3, "cash flows sharing one date do not produce an XIRR");
});

test("sxp list carries the ucc scopeXspResponse filters on, and an active SIP", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  const rows = qa.answer("getAllXsp", xspReq(QA)).data.lists;
  assert.ok(rows.every((r) => r.ucc === QA), "a row without the ucc is dropped before it reaches the page");
  assert.ok(rows.some((r) => r.sxp_type === "SIP" && r.status === "ACTIVE"));
  assert.ok(rows.some((r) => r.sxp_type === "SWP"));
  assert.ok(rows.some((r) => r.sxp_type.startsWith("STP")));
});

test("cancel flips the SIP and the list stops calling it active", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();

  const reg = qa.answer("getAllXsp", xspReq(QA)).data.lists.find((r) => r.sxp_type === "SIP").reg_no;
  // Cancel carries only a registration number — no ucc anywhere in the payload.
  const res = qa.answer("cancelXsp", { data: { reg_no: reg } });
  assert.equal(res.status, "success");
  assert.equal(qa.answer("getAllXsp", xspReq(QA)).data.lists.find((r) => r.reg_no === reg).status, "CANCELLED");
});

test("registering adds a row the list returns", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();

  const before = qa.answer("getAllXsp", xspReq(QA)).data.lists.length;
  const res = qa.answer("xspRegister", {
    data: { ucc: QA, sxp_type: "SWP", src_scheme: "HDLFDDN-DR", amount: 1500 },
  });
  assert.ok(res.data.reg_no);
  const after = qa.answer("getAllXsp", xspReq(QA)).data.lists;
  assert.equal(after.length, before + 1);
  assert.equal(after.find((r) => r.reg_no === res.data.reg_no).amount, 1500);
});

test("a redeem shows up in history instead of vanishing into a toast", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();

  const before = qa.answer("getAllOrders", ordersReq(QA)).data.lists.length;
  const res = qa.answer("purchaseNewOrder", {
    data: { orders: [{ type: "r", investor: { ucc: QA }, scheme: "PP001ZG-GR", amount: 2500, mem_ord_ref_id: "123456" }] },
  });
  assert.ok(res.data.items[0].id, "the frontend reads items[0].id and skips the receipt without it");
  const rows = qa.answer("getAllOrders", ordersReq(QA)).data.lists;
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].trxn_type, "R");
});

test("an unknown service method is never answered from the book", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  assert.equal(qa.answer("createPhysicalUcc", { data: { ucc: QA } }), null);
});

test("an order id from the book is answered here, not sent to BSE", () => {
  process.env.MF_QA_UCC = QA;
  const qa = load();
  qa.reset();

  const first = qa.answer("getAllOrders", ordersReq(QA)).data.lists[0];
  // The detail lookup carries only an id — no client code anywhere in the payload.
  const detail = qa.answer("getOrder", { data: { id: first.id } });
  assert.ok(detail, "an id we invented cannot be resolved at BSE, so it must resolve here");
  assert.equal(detail.data.id, first.id);

  // An id that is not ours still goes to BSE.
  assert.equal(qa.answer("getOrder", { data: { id: 123456789 } }), null);
});
