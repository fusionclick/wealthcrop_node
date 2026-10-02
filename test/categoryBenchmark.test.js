// Ticket 5 — Alpha and Beta. They were blank for every scheme because `scheme_benchmark`
// comes back empty from BSE, so there was nothing to measure against. The fallback is the
// index SEBI prescribes for the scheme's category. These checks pin the two things that
// would make that dishonest: measuring a fund against an index it does not track, and
// measuring a debt fund against an equity index.
const test = require("node:test");
const assert = require("node:assert");

const { categoryBenchmark, benchmarkFor, resolveBenchmark, INDEX_MAP } = require("../src/mf/benchmark");

test("equity categories map to the index their factsheet uses", () => {
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Large Cap"), "Nifty 100");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Flexi Cap"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Multi Cap"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • ELSS"), "Nifty 500");
  // Audit #5 — Midcap 150 (the Tier-1 benchmark) was re-probed and IS served daily now.
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Mid Cap"), "Nifty Midcap 150");
  assert.strictEqual(categoryBenchmark("Equity", "Sectoral", "SBI Banking & Financial Services Fund"), "Nifty Bank");
  // The only other sector series that come back daily.
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Sectoral / Thematic", "SBI TECHNOLOGY OPPORTUNITIES FUND"), "Nifty IT");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Sectoral / Thematic", "TATA DIGITAL INDIA FUND"), "Nifty IT");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Sectoral / Thematic", "NIPPON INDIA PHARMA FUND"), "Nifty Pharma");
});

test("an AMC called 'Bank of …' is not a banking fund", () => {
  // The bare word "bank" used to measure Bank of India's flexi cap fund against Nifty Bank.
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Flexi Cap", "BANK OF INDIA FLEXI CAP FUND"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Small Cap", "BANK OF INDIA SMALL CAP FUND"), "Nifty Smallcap 250");
});

test("an index fund is measured against the index it tracks — only when that IS its mandate", () => {
  const { trackedIndex } = require("../src/mf/benchmark");
  assert.strictEqual(trackedIndex("UTI NIFTY 50 INDEX FUND - DIRECT PLAN - GROWTH"), "Nifty 50");
  assert.strictEqual(trackedIndex("FRANKLIN INDIA NSE NIFTY 50 INDEX FUND - DIRECT IDCW PAYOUT"), "Nifty 50");
  assert.strictEqual(trackedIndex("SBI NIFTY NEXT 50 INDEX FUND"), "Nifty Next 50");
  assert.strictEqual(trackedIndex("MOTILAL OSWAL NIFTY MIDCAP 150 INDEX FUND"), "Nifty Midcap 150");
  // A factor index built on top of a parent index is a different series.
  assert.strictEqual(trackedIndex("BANDHAN NIFTY 100 LOW VOLATILITY 30 INDEX FUND"), null);
  assert.strictEqual(trackedIndex("DSP NIFTY 50 EQUAL WEIGHT INDEX FUND"), null);
  // An active fund names no index.
  assert.strictEqual(trackedIndex("FRANKLIN INDIA BLUECHIP FUND"), null);
  assert.deepStrictEqual(benchmarkFor({ name: "UTI NIFTY 50 INDEX FUND", category: "Index Funds" }), { name: "Nifty 50", source: "index" });
});

test("large & mid is not swallowed by the large cap rule", () => {
  // "Large & Mid Cap" contains "large cap"; order in the table is what stops it matching
  // Nifty 100, which tracks only the top 100 and would understate the mid-cap half.
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Large & Mid Cap"), "Nifty 500");
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Large Mid Cap"), "Nifty 500");
});

test("small cap is measured against Smallcap 250, never a broader index", () => {
  // Audit #5 — its Tier-1 benchmark, Nifty Smallcap 250, was re-probed on 2026-10-02 and the
  // price source serves it daily from 2016 (NIFTYSMLCAP250.NS). Before that it got nothing,
  // which was right then: measuring a small cap fund against Nifty 500 means nothing.
  assert.strictEqual(categoryBenchmark("Equity", "Equity • Small Cap"), "Nifty Smallcap 250");
  assert.notStrictEqual(categoryBenchmark("Equity", "Equity • Small Cap"), "Nifty 500");
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
  for (const name of ["Nifty 100", "Nifty 500", "Nifty Midcap 150", "Nifty Smallcap 250", "Nifty Bank", "Nifty IT", "Nifty Pharma"]) {
    const hit = resolveBenchmark(name);
    assert.ok(hit, `${name} must resolve to an index symbol`);
    assert.ok(INDEX_MAP.some(([, sym]) => sym === hit.symbol), `${name} -> ${hit.symbol} must be in INDEX_MAP`);
  }
});

// ── The BSE switchover ─────────────────────────────────────────────────────────────────
// BSE publishes `scheme_benchmark` and mapScheme already reads it into `benchmark`. It is
// empty on the host this platform currently reaches, which is the only reason the category
// fallback exists. These pin the precedence so the day a host that populates it is
// connected, every scheme upgrades to its AMC's own benchmark with no code change.

test("a scheme's OWN benchmark beats the category fallback", () => {
  const pick = benchmarkFor({
    benchmark: "NIFTY 50 TRI",           // what BSE's scheme_benchmark would carry
    category: "Equity",
    subType: "Equity • Large Cap",        // category alone would have said Nifty 100
  });

  assert.strictEqual(pick.name, "NIFTY 50 TRI");
  assert.strictEqual(pick.source, "scheme");
});

test("a blank or whitespace benchmark from BSE falls through to the category", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const pick = benchmarkFor({ benchmark: blank, category: "Equity", subType: "Equity • Large Cap" });
    assert.strictEqual(pick.name, "Nifty 100");
    assert.strictEqual(pick.source, "category");
  }
});

test("no benchmark and no usable category means no benchmark at all", () => {
  const pick = benchmarkFor({ benchmark: "", category: "Debt", subType: "Debt • Liquid" });
  assert.strictEqual(pick.name, null);
  assert.strictEqual(pick.source, null);
});
