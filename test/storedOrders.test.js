// QA 3.4 — "nothing gets updated in /user/mutual_fund/orders, only in /user/order".
//
// orderHistory read BSE's order_list and nothing else. An order is written to Laravel's
// `bse_orders` the moment it is accepted, but BSE can take a settlement cycle to publish it
// — and on a demo UCC may never. /user/order reads Laravel directly, so the same investor
// saw the order on one page and not the other, in the same minute.
const test = require("node:test");
const assert = require("node:assert");

const { orderKey, normaliseType } = require("../src/mf/storedOrders");

test("BSE's own id is the identity when there is one", () => {
  assert.strictEqual(orderKey({ id: 12345 }), "12345");
  assert.strictEqual(orderKey({ order_id: 999 }), "999");
  // The stored row carries it as bse_order_id, mapped to `id` before this runs, so a row
  // present in both lists collapses to one.
  assert.strictEqual(orderKey({ id: 12345 }), orderKey({ order_id: 12345 }));
});

test("a row with no id falls back to the same composite orderHistory dedupes on", () => {
  const a = { scheme_bse_code: "ABC01", date: "2026-09-29", amount: 5000 };
  const b = { scheme: "ABC01", order_date: "2026-09-29", amount: 5000 };
  assert.strictEqual(orderKey(a), orderKey(b), "both spellings must produce one key");
});

test("two different orders never collapse into one", () => {
  const base = { scheme_bse_code: "ABC01", date: "2026-09-29", amount: 5000 };
  assert.notStrictEqual(orderKey(base), orderKey({ ...base, amount: 6000 }));
  assert.notStrictEqual(orderKey(base), orderKey({ ...base, scheme_bse_code: "XYZ99" }));
  assert.notStrictEqual(orderKey(base), orderKey({ ...base, date: "2026-09-30" }));
});

test("Laravel's words and BSE's words end up as the same type", () => {
  // Laravel stores purchase|redeem|sip; BSE answers Purchase|Redemption. Both land in one
  // list now, and a list that calls the same thing two names is worse than no list.
  assert.strictEqual(normaliseType("purchase"), "Purchase");
  assert.strictEqual(normaliseType("redeem"), "Redemption");
  assert.strictEqual(normaliseType("REDEEM"), "Redemption");
  assert.strictEqual(normaliseType("sip"), "SIP");
});

test("an unrecognised type is passed through, not guessed", () => {
  // Guessing would be a claim about which way the money moved.
  assert.strictEqual(normaliseType("ZZ9"), "ZZ9");
  assert.strictEqual(normaliseType(""), "");
  assert.strictEqual(normaliseType(null), "");
});

test("no bearer means no stored orders, and never a throw", () => {
  // BSE is the authority on what happened to an order. If we cannot ask Laravel, the caller
  // still renders BSE's list exactly as it did before this module existed.
  const { storedOrders } = require("../src/mf/storedOrders");
  return storedOrders({ headers: {} }).then((rows) => {
    assert.deepStrictEqual(rows, []);
  });
});
