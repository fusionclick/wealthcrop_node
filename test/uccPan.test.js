// add_ucc must never invent a PAN.
//
// PAN is optional on the KYC form (an investor can save a partial profile and come back),
// so a request with no PAN now genuinely reaches addUcc. It used to substitute a literal
// "NYTPA0008A" in three places — a stranger's PAN registered at BSE against a real
// investor's name, bank and address. The guard runs before any BSE call, so nothing here
// needs stubbing: if a request gets past it, this test has already failed.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const controller = require("../src/controllers/StarMFController");

const VALID = {
  client_code: "TST1234567",
  first_name: "Ravi Kumar",
  dob: "1995-04-12",
  email: "ravi@example.com",
  address: { line1: "Flat 12, Green Park Society", pincode: "411001" },
  bank: { ifsc: "SBIN0001234", acc_no: "123456789012" },
};

// Minimal res double — addUcc only ever calls res.status().json() on the reject paths.
const fakeRes = () => {
  const out = { code: null, body: null };
  out.status = (code) => {
    out.code = code;
    return out;
  };
  out.json = (body) => {
    out.body = body;
    return out;
  };
  return out;
};

const submit = async (pan) => {
  const res = fakeRes();
  await controller.addUcc({ body: { ...VALID, pan } }, res);
  return res;
};

describe("add_ucc PAN guard", () => {
  it("refuses a missing PAN instead of substituting one", async () => {
    for (const pan of [undefined, "", "   ", null]) {
      const res = await submit(pan);
      assert.equal(res.code, 400, `PAN ${JSON.stringify(pan)} must be rejected`);
      assert.equal(res.body.field, "person.pan");
      assert.match(res.body.message, /PAN is required/);
    }
  });

  it("refuses a malformed PAN", async () => {
    for (const pan of ["ABCDE123", "ABCDE12345", "12345ABCDF", "ABCPE1234"]) {
      const res = await submit(pan);
      assert.equal(res.code, 400, `${pan} must be rejected`);
      assert.match(res.body.message, /ABCDE1234F/);
    }
  });

  it("refuses a non-individual PAN — this payload is hardcoded Individual/SI", async () => {
    // 4th character is the holder type: C company, H HUF, F firm, T trust.
    for (const pan of ["ABCCE1234F", "ABCHE1234F", "ABCFE1234F", "ABCTE1234F"]) {
      const res = await submit(pan);
      assert.equal(res.code, 400, `${pan} must be rejected`);
      assert.match(res.body.message, /individual PAN \(4th letter P\)/);
    }
  });

  it("accepts a well-formed individual PAN, in any case, and gets past the guard", async () => {
    // Past the guard it reaches the BSE call, which is unstubbed here and will fail — the
    // point is only that it is NOT a 400 from person.pan.
    for (const pan of ["ABCPE1234F", "abcpe1234f", " ABCPE1234F "]) {
      const res = await submit(pan);
      assert.notEqual(res.body?.field, "person.pan", `${pan} should pass the PAN guard`);
    }
  });

  it("no fallback PAN survives anywhere in the payload", () => {
    const src = fs.readFileSync(require.resolve("../src/controllers/StarMFController"), "utf8");
    // The three sites were identifier_number (holder), identifier_number (fatca) and
    // tax_id_no. A `pan ||` anywhere in the body means a fallback crept back in.
    assert.doesNotMatch(src, /"(identifier_number|tax_id_no)":\s*pan\s*\|\|/);
    assert.equal((src.match(/holderPan/g) || []).length >= 3, true, "all three sites use the validated PAN");
  });
});
