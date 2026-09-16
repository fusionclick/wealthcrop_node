// Ticket 5 — Alpha and Beta. They were blank for every scheme because `scheme_benchmark`
// comes back empty from BSE, so there was nothing to measure against. The fallback is the
// index SEBI prescribes for the scheme's category. These checks pin the two things that
// would make that dishonest: measuring a fund against an index it does not track, and
// measuring a debt fund against an equity index.
const test = require("node:test");
const assert = require("node:assert");

const { categoryBenchmark, resolveBenchmark, INDEX_MAP } = require("../src/mf/benchmark");

test("equity categories map to the index their factsheet uses", () => {
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Large Cap"), "Nifty 100");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Flexi Cap"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Multi Cap"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • ELSS"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Mid Cap"), "Nifty Midcap 50");
  assert.strictEqual(categoryBenchmark("Equity", "Sectoral", "SBI Banking & Financial Services Fund"), "Nifty Bank");
});

test("large & mid is not swallowed by the large cap rule", () => {
  // "Large & Mid Cap" contains "large cap"; order in the table is what stops it matching
  // Nifty 100, which tracks only the top 100 and would understate the mid-cap half.
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Large & Mid Cap"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Large Mid Cap"), "Nifty 500");
});

test("small cap gets NO benchmark rather than a wrong one", () => {
  // Its Tier-1 benchmark is Nifty Smallcap 250, which the price source does not publish.
  // Measuring a small cap fund against Nifty 500 would produce a beta that means nothing.
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Small Cap"), null);
});

test("debt, hybrid, gold and international get nothing", () => {
  for (const c of [
    "Debt • Liquid", "Debt • Gilt", "Debt • Corporate Bond", "Debt • Overnight",
    "Hybrid • Balanced Advantage", "Hybrid • Arbitrage",
    "Commodity • Gold", "Equity • International", "Other • Fund of Funds",
  ]) {
    assert.strictEqual(categoryBenchmark("", c), null, `${c} must not get an equity benchmark`);
  }
});

test("an unknown or empty category yields nothing", () => {
  assert.strictEqual(categoryBenchmark(), null);
  assert.strictEqual(categoryBenchmark("", ""), null);
  assert.strictEqual(categoryBenchmark("Something Unclassifiable"), null);
});

test("every index the category table names is one the price source can actually resolve", () => {
  // The whole point of the table is that these resolve; a typo here would silently mean no
  // Alpha/Beta for a whole category, which is exactly the bug being fixed.
  for (const name of ["Nifty 100", "Nifty 500", "Nifty Midcap 50", "Nifty Bank"]) {
    const hit = resolveBenchmark(name);
    assert.ok(hit, `${name} must resolve to an index symbol`);
    assert.ok(INDEX_MAP.some(([, sym]) => sym === hit.symbol), `${name} -> ${hit.symbol} must be in INDEX_MAP`);
  }
});
