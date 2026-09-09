const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { bseMessages } = require("../src/controllers/StarMFController");

describe("BSE order rejections", () => {
  it("explains id_not_exist on the ucc field instead of repeating it", () => {
    // Verbatim from the live order_new rejection the investor saw as "ucc is id_not_exist".
    // The code reads as "no such UCC", which is not what happened: get_ucc returns the
    // record. BSE refuses because the UCC is still PENDING_VERIFICATION — registered but
    // not cleared to transact. (MIN2082973 answers PENDING_VERIFICATION on get_ucc and
    // id_not_exist on order_new; USRWC56442, which is ACTIVE, trades fine.)
    const msg = bseMessages({
      messages: [{ msgid: 505, errcode: "id_not_exist", field: "308262.ucc", vals: ["MIN2082973"] }],
    });
    assert.doesNotMatch(msg, /id_not_exist/, "the raw code must not reach the investor");
    assert.match(msg, /not approved for transactions yet/i);
    assert.match(msg, /activat/i, "says what is missing, not just that it failed");
  });

  it("the same code on another field still says something sane", () => {
    const msg = bseMessages({ messages: [{ errcode: "id_not_exist", field: "order.scheme" }] });
    assert.match(msg, /scheme is not recognised by BSE/);
  });

  it("existing mappings are untouched", () => {
    assert.match(bseMessages({ messages: [{ errcode: "required", field: "x.folio" }] }), /folio is required/);
    assert.match(bseMessages({ messages: [{ errcode: "record_not_found", field: "a.b" }] }), /was not found on BSE/);
    assert.match(bseMessages({ messages: [{ field: "q.phys_ucc", errcode: "not_allowed" }] }), /held physically/);
    // BSE's own sentence still wins over any table.
    assert.equal(bseMessages({ messages: [{ message: "Straight from BSE" }] }), "Straight from BSE");
    // And a vals sentence is still appended to the generic form.
    assert.match(
      bseMessages({ messages: [{ errcode: "invalid", field: "x.y", vals: ["No valid responses generated"] }] }),
      /y is invalid — No valid responses generated/
    );
    assert.equal(bseMessages({}), "");
  });
});
