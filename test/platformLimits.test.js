// QA 13.7 — the admin's Min Lumpsum / Min SIP had no consumer at all: saved, served over
// /platform-settings, and read by nothing. These pin down that the floor now applies, and
// the two ways it must NOT apply — it can never lower the AMC's own minimum, and an
// unreachable Laravel must not start blocking valid orders.
const test = require("node:test");
const assert = require("node:assert");

const { checkSchemeLimits } = require("../src/mf/order");
const { NONE, peekLimits } = require("../src/mf/platformLimits");

// BSE nests its money rules inside lumpsum[], keyed by scheme_transaction_type, with the
// amounts one level further down again. Inventing a flatter shape here is what let the old
// guard "pass" its fixtures while never firing against the real payload.
const schemeWithMin = (minAmount) => ({
  scheme_bse_code: "TEST01",
  scheme_name: "Test Fund",
  purchase_allowed: "Y",
  lumpsum: [
    {
      scheme_transaction_type: "Purchase",
      scheme_transaction_single_details: {
        scheme_transaction_amt: { scheme_transaction_min_amt: minAmount },
      },
    },
  ],
});

const purchase = (amount) => ({ type: "p", amount, scheme: "TEST01" });

test("no house floor behaves exactly as before — the scheme's own minimum stands", () => {
  const scheme = schemeWithMin(1000);

  assert.strictEqual(checkSchemeLimits(purchase(1000), scheme, 0).ok, true);
  assert.strictEqual(checkSchemeLimits(purchase(999), scheme, 0).ok, false);
});

test("the house floor applies when it is higher than the scheme's", () => {
  const scheme = schemeWithMin(500);
  const res = checkSchemeLimits(purchase(1000), scheme, 5000);

  assert.strictEqual(res.ok, false);
  assert.match(res.error, /5000/, "the investor is told the figure that actually stopped them");
});

test("the house floor never LOWERS the AMC's minimum", () => {
  // An admin typing 100 into Min Lumpsum must not open a fund whose own minimum is 5,000.
  const scheme = schemeWithMin(5000);
  const res = checkSchemeLimits(purchase(1000), scheme, 100);

  assert.strictEqual(res.ok, false);
  assert.match(res.error, /5000/);
});

test("an order at exactly the house floor goes through", () => {
  assert.strictEqual(checkSchemeLimits(purchase(5000), schemeWithMin(500), 5000).ok, true);
});

test("a redemption is never held to the purchase floor", () => {
  // The exit has to work on the worst day; the caller passes 0 for anything that is not a
  // purchase, and the guard must not invent one.
  const scheme = { transactions: { redemption: { minAmount: 0 } }, scheme_bse_code: "TEST01" };
  assert.strictEqual(checkSchemeLimits({ type: "r", amount: 10 }, scheme, 5000).ok, true);
});

test("before the first successful read there is no house rule — it fails open", () => {
  // riskPolicy keeps the last good value and falls back to CONSERVATIVE defaults, because a
  // missing risk ceiling must never widen what may be bought. This is the opposite kind of
  // switch: it sits on top of a limit BSE already enforces, so guessing a floor we cannot
  // read would block orders that are perfectly valid.
  assert.deepStrictEqual(peekLimits(), NONE);
  assert.strictEqual(checkSchemeLimits(purchase(500), schemeWithMin(500), peekLimits().minLumpsum).ok, true);
});
