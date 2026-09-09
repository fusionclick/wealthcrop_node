const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mapBseError, mapBseErrors } = require("../src/mf/bseFieldErrors");

describe("BSE add_ucc error mapping", () => {
  it("explains alpha_special instead of printing the code", () => {
    // Verbatim from the live BSE response that reached the KYC screen as the bare word
    // "alpha_special" over "Check the field and try again".
    const raw = {
      msgid: 0,
      errcode: "alpha_special",
      field: "person.first_name",
      vals: ["Holder name should only contain lettersandspaces and special characters( “.”, “‘“)", "Minhal128"],
    };
    const e = mapBseError(raw);
    assert.equal(e.field, "person.first_name", "the field must survive — the UI routes on it");
    assert.doesNotMatch(e.message, /alpha_special/, "never show the raw code");
    assert.match(e.message, /only letters/i);
    assert.match(e.fix, /PAN|digits/i);
  });

  it("keys on errcode too, because msgid is 0 for this family", () => {
    // A msgid-only table can never match alpha_special.
    assert.doesNotMatch(mapBseError({ msgid: 0, errcode: "alpha_special", field: "x" }).message, /alpha_special/);
  });

  it("keeps the two msgid entries that already worked", () => {
    assert.match(mapBseError({ msgid: 560, field: "z" }).message, /pincode/i);
    assert.equal(mapBseError({ msgid: 560, field: "z" }).field, "address.pincode");
    assert.match(mapBseError({ msgid: 526 }).message, /Address line 1/i);
  });

  it("falls back to BSE's own sentence, then to the field name", () => {
    // Unknown code but BSE explained itself: use its words, tidied.
    const e = mapBseError({ msgid: 999, errcode: "whatever", field: "bank.ifsc", vals: ["IFSC  is   invalid", "ABCD"] });
    assert.equal(e.message, "IFSC is invalid");
    assert.match(e.fix, /ABCD/, "the rejected value helps more than 'check the field'");
    // Nothing at all to go on: still say which field, never print the code alone.
    const bare = mapBseError({ msgid: 999, errcode: "mystery", field: "bank.ifsc" });
    assert.match(bare.message, /bank\.ifsc/);
    assert.doesNotMatch(bare.message, /^mystery$/);
    // Completely empty input must not throw.
    assert.doesNotThrow(() => mapBseError({}));
    assert.equal(mapBseError({}).field, null);
  });

  it("tidies BSE's run-together words and curly quotes", () => {
    const e = mapBseError({ errcode: "x", field: "f", vals: ["lettersandspaces “ok”"] });
    assert.match(e.message, /letters and spaces/);
    assert.doesNotMatch(e.message, /[‘’“”]/);
  });

  it("maps a whole response", () => {
    assert.equal(mapBseErrors([{ msgid: 560 }, { msgid: 526 }]).length, 2);
    assert.deepEqual(mapBseErrors([]), []);
  });
});
