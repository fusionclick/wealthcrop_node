// Audit #22 — mandate_register built server-side from BSE's own templates
// (src/requestData/mandateRequestData.js). BSE is not reachable from a dev machine, so these
// pin the payload against the templates instead; live behaviour NEEDS VERIFICATION on the
// whitelisted host.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const templates = require("../src/requestData/mandateRequestData");
const { MODES, validVpa, buildMandateRegisterPayload, mandateState, mandateOutcome } = require("../src/mf/mandate");

const BANK = { bank_name: "HDFC Bank", ifsc_code: "hdfc0001234", account_number: "50100123456789" };
const build = (mode, over = {}) =>
  buildMandateRegisterPayload({
    mode,
    vpa: "investor@okhdfcbank",
    amount: 100000,
    bank: BANK,
    ucc: "UCC0001",
    memberCode: 91010,
    refId: "MND1",
    today: new Date("2026-10-02T10:00:00Z"),
    ...over,
  }).data;

// Every key we send must exist in the template it was built from — "do not invent fields".
const keysOf = (o, prefix = "") =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
const has = (obj, path) => path.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), obj) !== undefined;

describe("mandate_register payload", () => {
  it("UPI AutoPay is the UPI template: type U, mode DD, the investor's own VPA", () => {
    const p = build("upi");
    assert.equal(p.type, "U");
    assert.equal(p.mode, "DD");
    assert.deepEqual(p.investor_bank_details.vpa, ["investor@okhdfcbank"]);
    for (const key of keysOf(p)) assert.ok(has(templates.registerMandateUPI.data, key), `${key} is not in registerMandateUPI`);
  });

  it("NetBanking, debit card and Aadhaar are the e-NACH template, with no VPA", () => {
    for (const mode of ["netbanking", "debit_card", "aadhaar"]) {
      const p = build(mode);
      assert.equal(p.type, "X", mode);
      assert.equal(p.mode, "DD", mode);
      assert.equal("vpa" in p.investor_bank_details, false, `${mode} sent a VPA`);
      for (const key of keysOf(p)) assert.ok(has(templates.registerMandateEnach.data, key), `${mode}: ${key} is not in registerMandateEnach`);
    }
    assert.deepEqual(Object.keys(MODES).sort(), ["aadhaar", "debit_card", "netbanking", "upi"]);
  });

  it("the session's UCC and member, the investor's own bank, the template's frequency and request type", () => {
    const p = build("netbanking");
    assert.deepEqual(p.investor, { ucc: "UCC0001" });
    assert.equal(p.member, "91010", "member is a string everywhere else in BSE v2");
    assert.equal(p.investor_bank_details.ifsc, "HDFC0001234");
    assert.equal(p.investor_bank_details.no, "50100123456789");
    assert.equal(p.investor_bank_details.name, "HDFC Bank");
    assert.equal(p.frequency, templates.registerMandateEnach.data.frequency);
    assert.equal(p.request_type, "Entry", "the old browser payload invented REGISTRATION");
    assert.equal(p.amount, 100000);
    assert.equal(p.start_date, "2026-10-02");
    assert.equal(p.reg_date, "2026-10-02");
    assert.equal(p.valid_till, "2036-10-02");
  });

  it("never sends the template's demo UMRN / sponsor codes, a branch, or a sample EUIN", () => {
    const p = build("upi");
    assert.deepEqual(p.mem_mandate_info, { member_mandate_id: "MND1" });
    assert.equal("branch" in p.investor_bank_details, false);
    assert.equal(p.mem_details.euin_flag, true, "execution-only, like every order");
    assert.equal(p.mem_details.euin, undefined);
    assert.doesNotMatch(JSON.stringify(p), /UMRN|SPN|UTIL|PARTNER|E000001|ARN0001/);
  });

  it("carries no empty strings — one poisons a whole BSE request", () => {
    const noName = build("aadhaar", { bank: { ...BANK, bank_name: "" } });
    assert.equal("name" in noName.investor_bank_details, false, "an empty bank name must be omitted, not sent blank");
    const walk = (o) => Object.values(o).flatMap((v) => (v && typeof v === "object" ? walk(v) : [v]));
    assert.equal(walk(build("upi")).includes(""), false);
  });
});

describe("UPI ID check", () => {
  it("accepts handle@psp and refuses what the old page sent", () => {
    for (const ok of ["investor@okhdfcbank", "a.b-c_d@ybl", "9999999999@paytm"]) assert.equal(validVpa(ok), true, ok);
    for (const bad of ["", "   ", "investor", "@okhdfcbank", "investor@", "in vestor@ybl", "a@b"]) assert.equal(validVpa(bad), false, bad);
  });
});

describe("what BSE answered", () => {
  it("reads the mandate id and the approval link from wherever BSE puts them", () => {
    const out = mandateOutcome({ status: "success", data: { exch_mandate_id: 501342, mandate_auth_link: "https://bank.example/approve?x=1" } });
    assert.equal(out.exch_mandate_id, "501342");
    assert.equal(out.approval_link, "https://bank.example/approve?x=1");
    assert.equal(out.state, "pending");
    assert.equal(mandateOutcome({ status: "success", data: { items: [{ id: 7, redirect_url: "/x" }] } }).exch_mandate_id, "7");
  });

  it("is never 'approved' on a guess — the envelope's success is not the mandate's status", () => {
    assert.equal(mandateState({ status: "success" }), "pending");
    assert.equal(mandateState({}), "pending");
    assert.equal(mandateState({ mandate_status: "APPROVED" }), "approved");
    assert.equal(mandateState({ is_verified: true }), "approved");
    assert.equal(mandateState({ status: "REJECTED" }), "rejected");
    assert.equal(mandateState({ status: "ACTIVE", cancelled_at: "2026-10-01" }), "cancelled");
  });

  it("ignores a link-looking key that holds no URL", () => {
    assert.equal(mandateOutcome({ data: { exch_mandate_id: 1, link_status: "pending" } }).approval_link, null);
    assert.equal(mandateOutcome({ data: { exch_mandate_id: 1, auth_url: "javascript:alert(1)" } }).approval_link, null);
  });
});
