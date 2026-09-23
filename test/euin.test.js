// AMFI's rule, in bold in the compliance spec: never send EUINDecl "Y" together with a
// non-empty EUIN. The two statements contradict each other — "no employee advised this" and
// "this employee advised it" — and the pair is what puts trail commission eligibility at
// risk on an audit.
//
// Before this, a purchase carried no mem_details at all (BSE reads that as "not declared",
// which is NOT execution-only), and two other sites carried EUINs belonging to nobody here.
const test = require("node:test");
const assert = require("node:assert");

const { memDetails, assertEuinSane, withMemDetails } = require("../src/mf/euin");
const { normalizeOrder } = require("../src/mf/order");
const { buildXspRegisterPayload } = require("../src/mf/xsp");

test("with no employee, the trade is declared execution-only", () => {
  const m = memDetails({ omitEmpty: false });
  assert.strictEqual(m.euin, "", "an execution-only declaration must carry an EMPTY euin");
  assert.strictEqual(m.euin_flag, true, "the declaration itself must be set");
});

test("no empty string ever reaches BSE — one of them poisons a whole sxp_register", () => {
  // The declaration is carried by euin_flag. Dropping an empty euin says the same thing and
  // keeps the payload legal for the fussiest endpoint on this API.
  const m = memDetails();
  assert.strictEqual(m.euin_flag, true);
  assert.ok(!("euin" in m), "an empty euin must be omitted, not sent blank");
  for (const [k, v] of Object.entries(m)) {
    assert.notStrictEqual(v, "", `mem_details.${k} is an empty string`);
  }
  // Omitting it must never be mistaken for the illegal pair.
  assert.doesNotThrow(() => assertEuinSane(m));
});

test("naming an employee switches the declaration off — both can never be true", () => {
  const m = memDetails({ euin: "E123456" });
  assert.strictEqual(m.euin, "E123456");
  assert.strictEqual(m.euin_flag, false, "a trade an employee advised is not execution-only");
});

test("the illegal pair is refused even when a caller builds it by hand", () => {
  // memDetails() cannot produce this, but a caller spreading its own object over the top
  // can — which is exactly how a fabricated EUIN reached the exchange before.
  assert.throws(
    () => assertEuinSane({ euin: "E123456", euin_flag: true }),
    /EUIN declaration conflict/,
  );
  // BSE also accepts the declaration as the string "Y"; that spelling must be caught too.
  assert.throws(() => assertEuinSane({ euin: "E123456", euin_flag: "Y" }), /conflict/);
  // The two legal shapes pass.
  assert.doesNotThrow(() => assertEuinSane({ euin: "", euin_flag: true }));
  assert.doesNotThrow(() => assertEuinSane({ euin: "E123456", euin_flag: false }));
});

test("every purchase payload carries the declaration", () => {
  const order = normalizeOrder(
    { type: "p", scheme: "PP001ZG-GR", amount: 5000 },
    { ucc: "UCC1", memberCode: "91010", mobile: "9999999999" },
  );
  assert.strictEqual(order.mem_details.euin_flag, true);
  assert.strictEqual(order.mem_details.euin, "", "AMFI's wording is EUIN = \"\" with the declaration set");
});

test("the browser cannot name an employee on its own order", () => {
  // An EUIN attributes the trade and earns that employee the commission. If the payload
  // could carry one, any caller could attribute any order to anyone.
  const order = normalizeOrder(
    { type: "p", scheme: "PP001ZG-GR", amount: 5000, euin: "E999999", mem_details: { euin: "E999999", euin_flag: true } },
    { ucc: "UCC1", memberCode: "91010", mobile: "9999999999" },
  );
  assert.strictEqual(order.mem_details.euin, "", "a browser-supplied EUIN was accepted");
  assert.strictEqual(order.mem_details.euin_flag, true);
  assert.doesNotThrow(() => assertEuinSane(order.mem_details));
});

test("a SIP registration carries NO mem_details — BSE rejects the field there", () => {
  // Probed live 2026-09-24: mem_details.euin_flag returns 579 "invalid" on sxp_register, and
  // one bad field poisons the whole request, so sending it would break every registration.
  // Pinned as a test because the obvious "fix" for the missing declaration is to add it back.
  const { data } = buildXspRegisterPayload(
    { type: "sip", scheme: "PP001ZG-GR", amount: 1000, start_date: "2026-11-05", freq: "m", ninstallments: 12 },
    { ucc: "UCC1", memberCode: "91010" },
  );
  assert.ok(!("mem_details" in data), "sxp_register cannot carry mem_details — BSE answers 579");
  assert.ok(!("euin_flag" in data), "a top-level euin_flag is ignored by BSE, so it is a lie to send one");
});

test("withMemDetails verifies what it attaches", () => {
  const out = withMemDetails({ amount: 1 });
  assert.strictEqual(out.amount, 1);
  assert.strictEqual(out.mem_details.euin_flag, true);
});
