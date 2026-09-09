const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildXspRegisterPayload, validateSip, installmentsBetween } = require("../src/mf/xsp");

const CTX = { ucc: "USR1", memberCode: "91010", email: "a@b.com", dpId: "12345678", clientId: "87654321" };
const INTENT = { scheme: "007G", amount: 500, freq: "m", txn_date: 5, start_date: "2026-11-05", end_date: "2029-11-05" };

// Every rule below was established by sending the variant to the live BSE host and reading
// the error back, not by reading a spec. A registration succeeded as sxp_id
// 202600000125896 once all of them held at once.
describe("sxp_register payload", () => {
  it("is flat under data, never an array wrapper", () => {
    const p = buildXspRegisterPayload(INTENT, CTX);
    assert.equal(Array.isArray(p.data), false);
    assert.equal(typeof p.data.src_scheme, "string");
    // data.sxps[] / data.orders[] look accepted only because BSE then finds no fields and
    // reports the first missing one — a nonsense wrapper key behaved identically.
    for (const k of ["sxps", "sxp", "orders", "xsps"]) assert.equal(k in p.data, false);
  });

  it("always sends ninstallments — 0 or absent is ninstallments_invalid_for_freq", () => {
    const p = buildXspRegisterPayload(INTENT, CTX);
    assert.equal(p.data.ninstallments, 36, "3 years monthly");
    assert.ok(p.data.ninstallments > 0);
    // Derived from the dates the investor actually picked, per frequency.
    assert.equal(installmentsBetween("2026-11-05", "2027-11-05", "m"), 12);
    assert.equal(installmentsBetween("2026-11-05", "2027-11-05", "q"), 4);
    assert.equal(installmentsBetween("2026-11-05", "2027-11-05", "w"), 52);
    // An explicit count from the caller wins over the dates.
    assert.equal(buildXspRegisterPayload({ ...INTENT, ninstallments: 6 }, CTX).data.ninstallments, 6);
    // Never zero, even if the dates make no sense — BSE rejects 0 outright.
    assert.ok(buildXspRegisterPayload({ ...INTENT, end_date: "" }, CTX).data.ninstallments > 0);
  });

  it("sends no mobnum at all, anywhere", () => {
    // sxp_register answers `invalid`/mobnum (msgid 579) for every number tried, including
    // the investor's real one that order_new accepts and the 9999999999 placeholder.
    // Omitting the field is what made the call succeed, so this is not a defaulting bug.
    const p = buildXspRegisterPayload({ ...INTENT, mobnum: "8617029131" }, CTX);
    assert.equal("mobnum" in p.data, false);
    assert.equal("mobnum" in p.data.holder[0], false);
    assert.equal(JSON.stringify(p).includes("mobnum"), false);
  });

  it("txn_date is a number and member a string — the other way round is invalid_json", () => {
    const p = buildXspRegisterPayload({ ...INTENT, txn_date: "5" }, CTX);
    assert.equal(typeof p.data.txn_date, "number");
    assert.equal(typeof p.data.member, "string");
  });

  it("txn_date is taken from start_date, so the two cannot disagree", () => {
    // BSE ties them together: start 2026-11-10 with txn_date 5 was rejected
    // (invalid_txn_date, msgid 3809) even 62 days out, while start 2026-10-05 / txn 5,
    // 2026-09-25 / txn 25 and 2026-09-10 / txn 10 all registered. There is no minimum
    // notice period — the only rule is that they match. Deriving makes it structural.
    const p = buildXspRegisterPayload({ ...INTENT, start_date: "2026-09-25", txn_date: 5 }, CTX);
    assert.equal(p.data.txn_date, 25, "the start date wins, not the stale dropdown value");
    assert.equal(p.data.start_date, "2026-09-25");
  });

  it("frequency stays lowercase", () => {
    // "MONTHLY" comes back `invalid`/freq.
    assert.equal(buildXspRegisterPayload(INTENT, CTX).data.freq, "m");
  });

  it("carries no empty-string values", () => {
    const empties = [];
    const walk = (o, path = "") =>
      Object.entries(o).forEach(([k, v]) => {
        if (v === "") empties.push(path + k);
        else if (v && typeof v === "object") walk(v, `${path}${k}.`);
      });
    // The worst case: an investor with no demat and no email on file.
    walk(buildXspRegisterPayload(INTENT, { ucc: "U", memberCode: "9", email: "", dpId: "", clientId: "" }));
    assert.deepEqual(empties, []);
  });

  it("UCC and member come from the session, never from the browser", () => {
    const p = buildXspRegisterPayload({ ...INTENT, investor: { ucc: "ATTACKER" }, member: "00000" }, CTX);
    assert.equal(p.data.investor.ucc, "USR1");
    assert.equal(p.data.member, "91010");
  });

  it("demat only when both dp_id and client_id are known", () => {
    assert.equal(buildXspRegisterPayload(INTENT, CTX).data.phys_or_demat, "D");
    const noDp = buildXspRegisterPayload(INTENT, { ...CTX, clientId: "" });
    assert.equal(noDp.data.phys_or_demat, "P");
    assert.equal("depository_acct" in noDp.data, false, "an empty depository block is invalid_json");
  });
});

describe("SIP validation", () => {
  it("refuses a SIP with no fund — the bug that made every registration fail", () => {
    assert.match(validateSip({ ...INTENT, scheme: "" }), /Choose a fund/);
    assert.match(validateSip({ ...INTENT, scheme: "   " }), /Choose a fund/);
  });

  it("checks the rest of the form before spending a BSE round trip", () => {
    assert.equal(validateSip(INTENT), null);
    assert.match(validateSip({ ...INTENT, amount: 0 }), /amount/);
    assert.match(validateSip({ ...INTENT, amount: 100 }, { minSip: 500 }), /Minimum/);
    assert.match(validateSip({ ...INTENT, freq: "yearly" }), /frequency/);
    assert.match(validateSip({ ...INTENT, start_date: "05/11/2026" }), /start date/);
    assert.match(validateSip({ ...INTENT, txn_date: 31 }), /between 1 and 28/);
    assert.match(validateSip({ ...INTENT, txn_date: "" }), /between 1 and 28/);
    assert.match(validateSip({ ...INTENT, txn_date: "abc" }), /between 1 and 28/);
    // A numeric string is fine: a <select> hands back "5" and the builder coerces it to a
    // number before BSE sees it. Rejecting it would block the real form.
    assert.equal(validateSip({ ...INTENT, txn_date: "5" }), null);
    assert.match(validateSip({ ...INTENT, end_date: "2020-01-01" }), /end date/);
    // The exact form state that produced the live 502: SIP date "5th", start date the 10th.
    assert.match(
      validateSip({ ...INTENT, start_date: "2026-09-10", txn_date: 5 }),
      /same day of the month/
    );
    // Matching is enough — no minimum lead time, so tomorrow is acceptable.
    assert.equal(validateSip({ ...INTENT, start_date: "2026-09-10", txn_date: 10 }), null);
  });
});
