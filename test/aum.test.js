// Ticket 3 — fund size. The unit of the enrichment feed's `aum` field is the whole ticket:
// this number used to be withheld because reading it as ₹1 lakh put every fund out by 10x,
// and a fund size wrong by an order of magnitude on an investment platform is worse than a
// missing one. These are the two probes that settled it, pinned so the constant cannot drift
// back without a test going red.
const test = require("node:test");
const assert = require("node:assert");

const { aumCrore } = require("../src/mf/kuvera");
const { query } = require("../src/mf/catalogue");

test("the feed's unit is ₹10 lakh, so raw/10 is ₹ crore", () => {
  // Parag Parikh Flexi Cap (PP001ZG-GR). Published ₹1,48,429 Cr — ETMoney, and the
  // mutualfundsindia factsheet's peer table (148,429.00).
  assert.strictEqual(aumCrore(1484290), 148429);

  // SBI Liquid (SB072SF-DR). Published ₹92,191.69 Cr — Paytm Money, 31 Aug 2026.
  assert.strictEqual(aumCrore(921916), 92191.6);
});

test("a missing or nonsense fund size is null, never ₹0 Cr", () => {
  // "₹0 Cr" next to a fund someone is about to buy reads as a real and alarming number.
  assert.strictEqual(aumCrore(0), null);
  assert.strictEqual(aumCrore(-5), null);
  assert.strictEqual(aumCrore(null), null);
  assert.strictEqual(aumCrore(undefined), null);
  assert.strictEqual(aumCrore("not a number"), null);
});

test("fund size filters and ranks, and an unsized fund is excluded from a band", () => {
  const rows = [
    { name: "Big", aum: 148429 },
    { name: "Mid", aum: 9000 },
    { name: "Small", aum: 120 },
    { name: "Unknown", aum: null },
  ];

  // Ticket 11 — a fund with no published size is excluded from an explicit band rather than
  // treated as zero, which would quietly park every unsized fund in the "smallest" bucket.
  const band = query(rows, { minAum: 1000, maxAum: 200000, length: 10 });
  assert.deepStrictEqual(band.lists.map((f) => f.name), ["Big", "Mid"]);

  const ranked = query(rows, { sort: "aum", order: "desc", length: 10 });
  assert.strictEqual(ranked.lists[0].name, "Big");
  // Unknown sorts last rather than winning a "largest fund" ranking.
  assert.strictEqual(ranked.lists.at(-1).name, "Unknown");
});
