// QA 13.7 — the admin's Min Lumpsum / Min SIP had no consumer at all: saved, served over
// /platform-settings, and read by nothing. These pin down that the floor now applies, and
// the two ways it must NOT apply — it can never lower the AMC's own minimum, and an
// unreachable Laravel must not start blocking valid orders.
const test = require("node:test");
const assert = require("node:assert");

const { checkSchemeLimits } = require("../src/mf/order");
const { NONE, peekLimits, applyFloor } = require("../src/mf/platformLimits");
const { listCacheKey } = require("../src/mf/scheme");

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

// QA 6.2 — enforcement without display is a trap: the fund page kept advertising BSE's
// minimum while the admin's higher floor was what actually applied, so an investor typed the
// amount the page asked for and was refused. applyFloor is what makes the two agree.
test("the floor raises what the page shows, for lumpsum and SIP only", () => {
  const mapped = { minLumpsum: 1000, minSip: 500 };
  const txns = {
    lumpsum: { minAmount: 1000 },
    sip: { minAmount: 500, frequencies: [{ minAmount: 500 }, { minAmount: 1000 }] },
    redemption: { minAmount: 100 },
    swp: { minAmount: 1000, frequencies: [{ minAmount: 1000 }] },
  };

  applyFloor({ minLumpsum: 25000, minSip: 2500 }, mapped, txns);

  assert.strictEqual(mapped.minLumpsum, 25000);
  assert.strictEqual(mapped.minSip, 2500);
  assert.strictEqual(txns.lumpsum.minAmount, 25000);
  assert.strictEqual(txns.sip.minAmount, 2500);
  assert.deepStrictEqual(txns.sip.frequencies.map((f) => f.minAmount), [2500, 2500]);
  // Money coming OUT is none of this setting's business.
  assert.strictEqual(txns.redemption.minAmount, 100);
  assert.strictEqual(txns.swp.minAmount, 1000);
});

test("the floor never lowers the AMC's own minimum", () => {
  const mapped = { minLumpsum: 5000, minSip: 1000 };
  applyFloor({ minLumpsum: 1000, minSip: 500 }, mapped, null);
  assert.strictEqual(mapped.minLumpsum, 5000);
  assert.strictEqual(mapped.minSip, 1000);
});

test("no house rule leaves an unpublished minimum unpublished", () => {
  // null means "BSE did not say" and the UI omits the line. A floor of 0 must not turn that
  // into a confident 0, which would read as "no minimum".
  const mapped = { minLumpsum: null, minSip: null };
  applyFloor(NONE, mapped, null);
  assert.strictEqual(mapped.minLumpsum, null);
  assert.strictEqual(mapped.minSip, null);

  // But a real floor on a scheme BSE said nothing about IS the minimum.
  const other = { minLumpsum: null, minSip: null };
  applyFloor({ minLumpsum: 25000, minSip: 2500 }, other, null);
  assert.strictEqual(other.minLumpsum, 25000);
  assert.strictEqual(other.minSip, 2500);
});

// The list path (POST /master-scheme-list) floors its rows too, so an Explore card and the
// fund page it opens quote the same minimum. Both of these pin down why that took care.
test("flooring a page does not touch the shared master index row", () => {
  // catalogue.js returns `rows.slice(...)` — a new array holding THE SAME objects as the
  // process-wide index. applyFloor writes in place, so the controller copies each row first.
  // Without the copy the index itself is raised, permanently, and raised again on every
  // later read — the advertised minimum would climb each time the admin touched the setting.
  const indexRow = { scheme_bse_code: "02", minLumpsum: 100, minSip: 100, txn: { sip: true } };
  const index = [indexRow];

  const page = index.slice(0, 1).map((row) => {
    const copy = { ...row };
    applyFloor({ minLumpsum: 1000, minSip: 500 }, copy);
    return copy;
  });

  assert.strictEqual(page[0].minLumpsum, 1000);
  assert.strictEqual(page[0].minSip, 500);
  // The AMC's own numbers are still what the index holds.
  assert.strictEqual(indexRow.minLumpsum, 100);
  assert.strictEqual(indexRow.minSip, 100);

  // Flooring the same index a second time must produce the same answer, never 1000 -> 10000.
  const again = index.slice(0, 1).map((row) => {
    const copy = { ...row };
    applyFloor({ minLumpsum: 1000, minSip: 500 }, copy);
    return copy;
  });
  assert.strictEqual(again[0].minLumpsum, 1000);
});

test("the list cache key carries the floor, so a settings change cannot be served stale", () => {
  // The cache holds a page for 5 minutes and up to 24h as stale-if-error. The floor is baked
  // into the rows, so without it in the key a changed minimum could be served for a day.
  const q = { category: "equity", start: 0, length: 20 };
  const low = listCacheKey(q, { minLumpsum: 1000, minSip: 500 });
  const high = listCacheKey(q, { minLumpsum: 25000, minSip: 2500 });

  assert.notStrictEqual(low, high);
  // Same query, same floor, same entry — the key must not be accidentally unique.
  assert.strictEqual(low, listCacheKey({ ...q }, { minLumpsum: 1000, minSip: 500 }));
  // And a caller that passes no limits still gets a stable key rather than "undefined".
  assert.strictEqual(listCacheKey(q), listCacheKey(q, null));
});
