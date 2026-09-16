// Ticket 3 — fund size. The unit of the enrichment feed's `aum` field is the whole ticket:
// this number used to be withheld because reading it as ₹1 lakh put every fund out by 10x,
// and a fund size wrong by an order of magnitude on an investment platform is worse than a
// missing one. These are the two probes that settled it, pinned so the constant cannot drift
// back without a test going red.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { aumCrore, applyCached } = require("../src/mf/kuvera");
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

test("every field the filters read is copied onto the INDEX row", () => {
  // The bug this pins: `aum` was attached on the way OUT (enrichRows) but not by
  // applyCached, which decorates the ~11k rows query() filters over. Live, that gave a
  // catalogue where every row showed an AUM and `minAum=1` still matched nothing.
  //
  // Hand-built rows cannot catch it — they already carry the field. So this asserts the
  // contract at applyCached itself: anything query() filters or sorts on has to be set
  // there, or it is invisible at filter time.
  assert.strictEqual(applyCached({ scheme_bse_code: "__no_such_scheme__" }), false);

  const src = fs.readFileSync(path.join(__dirname, "..", "src", "mf", "kuvera.js"), "utf8");
  const start = src.indexOf("function applyCached");
  const body = src.slice(start, src.indexOf("\n}", start));

  for (const field of ["risk", "riskRank", "ageYears", "returns", "aum"]) {
    assert.ok(body.includes(`row.${field} =`), `applyCached must set row.${field} — query() filters or sorts on it`);
  }
});
