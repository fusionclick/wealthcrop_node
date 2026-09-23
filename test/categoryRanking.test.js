// "Category average" and "Rank within category" read NA on every fund on production, because
// the peer lookup they depended on downloaded five NAV histories inside the page request and
// was switched off when it timed out at nginx. The replacement reads the master index, which
// already carries trailing returns for every enriched scheme.
//
// What these tests pin is the honesty of the numbers, not the arithmetic: a rank is only
// meaningful if the field is real (not one fund), if it is measured on the same feed for
// everyone, and if an unknown return is left out rather than counted as zero.
const test = require("node:test");
const assert = require("node:assert");

const { categoryRanking } = require("../src/mf/catalogue");

const fund = (code, subType, returns) => ({
  scheme_bse_code: code,
  scheme_isin: `INF${code}`,
  subType,
  category: "Equity",
  returns,
});

// One category of six, one of two. Returns are chosen so ME sits third on 1Y and first on 3Y.
const INDEX = [
  fund("ME", "Equity • Flexi Cap Fund", { "1Y": 10, "3Y": 30, "5Y": 20, inception: 15 }),
  fund("A", "Equity • Flexi Cap Fund", { "1Y": 30, "3Y": 10, "5Y": 10, inception: 10 }),
  fund("B", "Equity • Flexi Cap Fund", { "1Y": 20, "3Y": 20, "5Y": null, inception: 20 }),
  fund("C", "Equity • Flexi Cap Fund", { "1Y": 5, "3Y": 5, "5Y": null, inception: 5 }),
  fund("D", "Equity • Flexi Cap Fund", { "1Y": 0, "3Y": 0, "5Y": null, inception: 0 }),
  fund("E", "Equity • Flexi Cap Fund", { "1Y": -10, "3Y": -10, "5Y": null, inception: -10 }),
  fund("X", "Equity • Small Cap Fund", { "1Y": 99, "3Y": 99, "5Y": 99, inception: 99 }),
  fund("Y", "Equity • Small Cap Fund", { "1Y": 98, "3Y": 98, "5Y": 98, inception: 98 }),
];

test("ranks the scheme against its own category, not the whole catalogue", () => {
  const r = categoryRanking(INDEX[0], INDEX);

  assert.strictEqual(r.peers, 6, "only the Flexi Cap rows are peers");
  assert.strictEqual(r.categoryLabel, "Equity • Flexi Cap Fund");

  // 30 and 20 beat 10 on 1Y; nothing beats 30 on 3Y.
  assert.strictEqual(r.rank["1Y"], 3);
  assert.strictEqual(r.rank["3Y"], 1);

  // The 99s next door must not drag the average: (10+30+20+5+0-10)/6 = 9.17.
  assert.strictEqual(r.categoryAvg["1Y"], 9.17);
});

test("a period only a couple of funds report is left out, not averaged", () => {
  // Two 5Y figures among six funds is a coincidence, not a category average, and a "Rank 1"
  // drawn from it would be the most flattering number on the page.
  const r = categoryRanking(INDEX[0], INDEX);
  assert.strictEqual(r.categoryAvg["5Y"], undefined);
  assert.strictEqual(r.rank["5Y"], undefined);
});

test("a category too thin to compare against yields nothing at all", () => {
  // "Rank 1 of 2" reads as a win. Two funds are not a league table.
  const r = categoryRanking(INDEX[6], INDEX);
  assert.deepStrictEqual(r.rank, {});
  assert.deepStrictEqual(r.categoryAvg, {});
  assert.strictEqual(r.peers, 0);
});

test("since-inception is published under the key the page reads (ALL)", () => {
  const r = categoryRanking(INDEX[0], INDEX);
  assert.strictEqual(r.categoryAvg.ALL, r.categoryAvg.inception);
  assert.strictEqual(r.rank.ALL, r.rank.inception);
});

test("a scheme missing from the index gets the category average but no rank", () => {
  // Enrichment can be cold for one scheme while its category is full. The average is still a
  // fact about the category; a rank for a fund with no return would have to be invented.
  const stranger = { scheme_bse_code: "ZZ", scheme_isin: "INFZZ", subType: "Equity • Flexi Cap Fund" };
  const r = categoryRanking(stranger, INDEX);
  assert.strictEqual(r.categoryAvg["1Y"], 9.17);
  assert.strictEqual(r.rank["1Y"], undefined);
});

test("no category on the scheme means no claim about it", () => {
  const r = categoryRanking({ scheme_bse_code: "ME" }, INDEX);
  assert.strictEqual(r.peers, 0);
  assert.deepStrictEqual(r.categoryAvg, {});
});
