const { test, describe, it } = require("node:test");
const assert = require("node:assert");

const {
  schemeTransactions,
  txnSummary,
  lockInOf,
  payoutOf,
  mapScheme,
  returnsBoth,
  rollingReturns,
  alphaBeta,
} = require("../src/mf/scheme");
const { query } = require("../src/mf/catalogue");
const { normaliseRisk, RISK_LEVELS } = require("../src/mf/kuvera");
const { resolveBenchmark } = require("../src/mf/benchmark");

// A row in BSE's real master shape — copied from a live starmfv2demo response
// (fields:["ALL"]), not invented. Every nested path below is one BSE actually sends.
const lumpRow = (type, minAmt, { end = "2037-12-31T00:00:00", maxAmt = 100000000000 } = {}) => ({
  scheme_transaction_type: type,
  scheme_transaction_cutoff_time: "14:30:00",
  scheme_transaction_effective_start_date: "2010-07-19T00:00:00",
  scheme_transaction_effective_end_date: end,
  scheme_transaction_mode_allowed: [{ scheme_transaction_mode_demat_physical_allowed: "Demat" }],
  scheme_transaction_single_details: {
    scheme_transaction_amt: {
      scheme_transaction_min_amt: minAmt,
      scheme_transaction_min_adtnl_amt: minAmt,
      scheme_transaction_max_amt: maxAmt,
      scheme_transaction_mult_amt: 1,
    },
  },
});

const sxpRow = (type, freq, minAmt, dates, { registration = true } = {}) => ({
  scheme_transaction_type: type,
  scheme_sxp_frequency: freq,
  scheme_sxp_frequency_detail: { scheme_sxp_frequency_type: "dates", scheme_sxp_frequency_values: dates },
  scheme_transaction_allowed_options: {
    scheme_sxp_registration_allowed: registration,
    scheme_sxp_paused: true,
    scheme_sxp_first_order_today_allowed: true,
  },
  scheme_transaction_effective_start_date: "2015-12-04T00:00:00",
  scheme_transaction_effective_end_date: "2037-12-31T00:00:00",
  scheme_transaction_mode_allowed: [{ scheme_transaction_mode_demat_physical_allowed: "Demat" }],
  systematic_transaction_detail: [
    {
      scheme_sxp_installment_numbers: { scheme_sxp_min_installments: 12, scheme_sxp_max_installments: 9999 },
      scheme_transaction_amt: { scheme_transaction_min_amt: minAmt, scheme_transaction_max_amt: 999999999, scheme_transaction_mult_amt: 1 },
    },
  ],
});

const FULL_SCHEME = {
  name: "SBI ESG EXCLUSIONARY STRATEGY FUND REGULAR IDCW PAYOUT",
  scheme_isin: "INF200K01198",
  scheme_bse_code: "007-DP",
  scheme_option: "IDCW Payout",
  scheme_category: "Equity",
  scheme_benchmark: "NIFTY 100 ESG TRI",
  scheme_lockin_period: 3,
  scheme_lockin_period_type: "Years",
  lumpsum: [lumpRow("Purchase", 1000), lumpRow("Redemption", 1000), lumpRow("Switch-IN", 1000), lumpRow("Switch-OUT", 1000)],
  systematic: [
    sxpRow("SIP", "Monthly", 500, [1, 2, 3, 10, 15]),
    sxpRow("SIP", "Weekly", 1000, [1, 2, 3, 4, 5]),
    // BSE genuinely sends these unsorted.
    sxpRow("SWP", "Monthly", 500, [17, 1, 24, 7]),
    sxpRow("STP-IN", "Monthly", 500, [8, 11, 21]),
  ],
};

describe("scheme transaction attributes (ticket 2/3)", () => {
  it("reads every transaction type BSE publishes, with its own minimum", () => {
    const t = schemeTransactions(FULL_SCHEME);
    assert.equal(t.lumpsum.allowed, true);
    assert.equal(t.lumpsum.minAmount, 1000);
    assert.equal(t.redemption.minAmount, 1000);
    assert.equal(t.switchIn.allowed, true);
    assert.equal(t.sip.allowed, true);
    assert.equal(t.swp.allowed, true);
    assert.equal(t.stpIn.allowed, true);
    assert.equal(t.stpOut, undefined, "a type BSE did not send must be absent, not false");

    // The SIP minimum is the cheapest way in across the frequencies BSE allows.
    assert.equal(t.sip.minAmount, 500);
    assert.equal(t.sip.frequencies.length, 2);
    assert.deepEqual(
      t.sip.frequencies.map((f) => f.frequency).sort(),
      ["Monthly", "Weekly"]
    );
  });

  it("sorts the SIP dates BSE sends out of order", () => {
    const swp = schemeTransactions(FULL_SCHEME).swp;
    assert.deepEqual(swp.frequencies[0].dates, [1, 7, 17, 24]);
  });

  it("carries installment limits, which SIP registration needs", () => {
    const sip = schemeTransactions(FULL_SCHEME).sip.frequencies.find((f) => f.frequency === "Monthly");
    assert.equal(sip.minInstallments, 12);
    assert.equal(sip.maxInstallments, 9999);
  });

  it("closes a transaction whose BSE window has expired", () => {
    const dead = { lumpsum: [lumpRow("Purchase", 1000, { end: "2025-06-20T00:00:00" })] };
    assert.equal(schemeTransactions(dead).lumpsum.allowed, false);
  });

  it("treats registration_allowed:false as not available", () => {
    const off = { systematic: [sxpRow("SIP", "Monthly", 500, [1], { registration: false })] };
    assert.equal(schemeTransactions(off).sip.allowed, false);
  });

  it("summarises for list rows without claiming unknowns are false", () => {
    assert.deepEqual(txnSummary(schemeTransactions(FULL_SCHEME)), {
      lumpsum: true,
      sip: true,
      swp: true,
      stp: true,
      switchAllowed: true,
      redemption: true,
    });
    // A scheme BSE said nothing about: every flag null, none of them false.
    const blank = txnSummary(schemeTransactions({}));
    assert.deepEqual(Object.values(blank), [null, null, null, null, null, null]);
  });

  it("puts the real minimums on the mapped row — the 500/5000 placeholders are gone", () => {
    const m = mapScheme(FULL_SCHEME);
    assert.equal(m.minSip, 500);
    assert.equal(m.minLumpsum, 1000);
    assert.equal(m.minRedeem, 1000);
    assert.equal(m.txn.sip, true);
    assert.equal(m.txn.swp, true);
    assert.equal(m.payout, "IDCW Payout");
    assert.equal(m.lockIn.label, "3 years");
    assert.equal(m.benchmark, "NIFTY 100 ESG TRI");
    // Nothing known => null, never a made-up floor.
    const bare = mapScheme({ scheme_name: "X" });
    assert.equal(bare.minSip, null);
    assert.equal(bare.minLumpsum, null);
  });

  it("does not print a lock-in that does not exist", () => {
    assert.equal(lockInOf({ scheme_lockin_period: 0, scheme_lockin_period_type: "Years" }), null);
    assert.equal(lockInOf({}), null);
    assert.equal(lockInOf({ scheme_lockin_period: 1, scheme_lockin_period_type: "Year" }).label, "1 year");
    assert.equal(lockInOf({ scheme_lockin_period: 90, scheme_lockin_period_type: "Days" }).label, "90 days");
  });

  it("normalises the payout option", () => {
    assert.equal(payoutOf({ scheme_option: "IDCW Reinvestment" }), "IDCW Reinvestment");
    assert.equal(payoutOf({ scheme_option: "Growth" }), "Growth");
    assert.equal(payoutOf({}), null);
  });
});

describe("SEBI risk levels (ticket 4)", () => {
  it("maps only the six defined levels and nothing else", () => {
    assert.equal(normaliseRisk("Very High Risk"), "Very High");
    assert.equal(normaliseRisk("Low to Moderate Risk"), "Low to Moderate");
    assert.equal(normaliseRisk("moderately high"), "Moderately High");
    assert.equal(RISK_LEVELS.length, 6);
    // Anything unrecognised must be null. Mapping "Unrated" to the nearest level would put
    // a wrong SEBI badge on a real fund.
    for (const junk of ["", null, "Unrated", "N/A", "3", "Medium", "Speculative"]) {
      assert.equal(normaliseRisk(junk), null, `${junk} must not map to a risk level`);
    }
  });
});

describe("returns engine (tickets 6/7/8)", () => {
  // Five years of daily NAV compounding at a steady 10% p.a.
  const DAY = 86400;
  const today = Math.floor(Date.UTC(2026, 8, 15) / 1000);
  const steady = [];
  for (let i = 5 * 365; i >= 0; i--) {
    steady.push({ timestamp: today - i * DAY, nav: 100 * Math.pow(1.1, (5 * 365 - i) / 365) });
  }

  it("reports absolute and CAGR side by side, and they differ over multi-year windows", () => {
    const r = returnsBoth(steady);
    assert.ok(Math.abs(r.cagr["1Y"] - 10) < 0.2, `1Y CAGR ~10, got ${r.cagr["1Y"]}`);
    assert.ok(Math.abs(r.cagr["3Y"] - 10) < 0.2, `3Y CAGR ~10, got ${r.cagr["3Y"]}`);
    assert.ok(Math.abs(r.absolute["3Y"] - 33.1) < 1, `3Y absolute ~33.1, got ${r.absolute["3Y"]}`);
    assert.ok(r.absolute["3Y"] > r.cagr["3Y"], "absolute must exceed CAGR on a rising fund");
  });

  it("refuses to annualise a window shorter than a year", () => {
    const r = returnsBoth(steady);
    assert.equal(r.cagr["1M"], null, "a month of gains must not be printed as 'p.a.'");
    assert.equal(r.cagr["3M"], null);
    assert.ok(r.absolute["1M"] != null, "the absolute figure is still fine");
  });

  it("returns null for a window the fund has not lived through", () => {
    const young = steady.slice(-200);
    const r = returnsBoth(young);
    assert.equal(r.absolute["3Y"], null);
    assert.equal(r.cagr["5Y"], null);
    assert.equal(r.absolute["1M"] != null, true);
  });

  it("gives an empty series no numbers at all", () => {
    const r = returnsBoth([]);
    assert.deepEqual(r.absolute, {});
    assert.equal(r.inception, null);
  });

  it("rolls returns over every window, not one lucky entry date", () => {
    const roll = rollingReturns(steady, ["1Y", "3Y"]);
    assert.ok(roll["1Y"].windows > 100, "expected many 1Y windows across five years");
    assert.ok(Math.abs(roll["1Y"].average - 10) < 0.5);
    assert.equal(roll["1Y"].positivePct, 100, "a steadily rising fund is positive in every window");
    assert.ok(roll["1Y"].min <= roll["1Y"].median && roll["1Y"].median <= roll["1Y"].max);
    assert.equal(roll["3Y"].annualised, true);
  });

  it("says null rather than inventing a window it cannot form", () => {
    assert.equal(rollingReturns(steady, ["10Y"])["10Y"], null);
    assert.deepEqual(rollingReturns([], ["1Y"]), {});
  });

  it("measures beta against a benchmark, and refuses without one", () => {
    // Fund = exactly twice the benchmark's daily move => beta 2.
    const bench = steady.map((p, i) => ({ timestamp: p.timestamp, nav: 100 * Math.pow(1.05, i / 365) }));
    const levered = [{ timestamp: bench[0].timestamp, nav: 100 }];
    for (let i = 1; i < bench.length; i++) {
      const r = bench[i].nav / bench[i - 1].nav - 1;
      levered.push({ timestamp: bench[i].timestamp, nav: levered[i - 1].nav * (1 + 2 * r) });
    }
    const ab = alphaBeta(levered, bench);
    assert.ok(Math.abs(ab.beta - 2) < 0.05, `beta ~2, got ${ab.beta}`);
    assert.ok(ab.alpha != null && ab.benchmarkReturn != null);
    assert.equal(ab.days, bench.length);

    // No benchmark, or barely any overlap => no number. The old code answered anyway, from
    // a hardcoded 0.12 "benchmark return" and a hardcoded 0.16 "market volatility".
    assert.equal(alphaBeta(levered, []), null);
    assert.equal(alphaBeta([], bench), null);
    assert.equal(alphaBeta(levered, bench.slice(0, 40)), null, "40 shared days is not a beta");
  });

  it("only maps benchmarks it can name with certainty", () => {
    assert.equal(resolveBenchmark("NIFTY 50 TRI").symbol, "^NSEI");
    assert.equal(resolveBenchmark("Nifty Bank TRI").symbol, "^NSEBANK");
    // Narrow before broad: "NIFTY 500" must not be swallowed by the "NIFTY 50" pattern.
    assert.equal(resolveBenchmark("NIFTY 500 TRI").symbol, "^CRSLDX");
    assert.equal(resolveBenchmark("S&P BSE Sensex TRI").symbol, "^BSESN");
    // An index we cannot name gets no alpha/beta rather than the wrong benchmark's.
    assert.equal(resolveBenchmark("CRISIL Short Term Bond Fund Index"), null);
    assert.equal(resolveBenchmark(""), null);
  });
});

describe("catalogue filtering and ranking (ticket 11)", () => {
  const row = (over = {}) => ({
    name: "Fund",
    scheme_isin: "INF1",
    scheme_bse_code: "1-GR",
    subType: "Equity • Flexi Cap",
    category: "Equity",
    txn: { lumpsum: true, sip: true, swp: null, stp: null, switchAllowed: null, redemption: true },
    returns: { "1Y": 10, "3Y": 12, "5Y": null },
    risk: "Very High",
    riskRank: 6,
    ageYears: 8,
    fundRating: 4,
    ...over,
  });

  const list = [
    row({ name: "A", risk: "Very High", ageYears: 12, returns: { "1Y": 22, "3Y": 15, "5Y": 14 }, fundRating: 5 }),
    row({ name: "B", risk: "Low", ageYears: 3, returns: { "1Y": 6, "3Y": 5, "5Y": 5 }, riskRank: 1, txn: { lumpsum: true, sip: true, swp: true, stp: true, switchAllowed: true, redemption: true } }),
    row({ name: "C", risk: "Moderate", ageYears: 1, returns: { "1Y": 14, "3Y": null, "5Y": null }, riskRank: 3 }),
    row({ name: "D", risk: null, ageYears: null, returns: { "1Y": null, "3Y": null, "5Y": null }, riskRank: null }),
  ];

  it("filters on risk, and a scheme with unknown risk is never swept in", () => {
    const { lists, total } = query(list, { risk: "Very High,Moderate", length: 50 });
    assert.deepEqual(lists.map((f) => f.name), ["A", "C"]);
    assert.equal(total, 2);
  });

  it("requires ALL the transaction types asked for", () => {
    assert.deepEqual(query(list, { txn: "sip,swp", length: 50 }).lists.map((f) => f.name), ["B"]);
    // `null` means BSE did not say and must not count as available.
    assert.equal(query(list, { txn: "stp", length: 50 }).total, 1);
  });

  it("combines filters and keeps `total` equal to what it returns", () => {
    const { lists, total } = query(list, { minAge: 2, minReturn: 10, returnPeriod: "1Y", length: 50 });
    assert.deepEqual(lists.map((f) => f.name), ["A"]);
    assert.equal(total, lists.length);
  });

  it("ranks by a metric, sinking unknowns to the bottom in both directions", () => {
    const desc = query(list, { sort: "returns_1y", order: "desc", length: 50 }).lists.map((f) => f.name);
    assert.deepEqual(desc, ["A", "C", "B", "D"]);
    const asc = query(list, { sort: "returns_1y", order: "asc", length: 50 }).lists.map((f) => f.name);
    assert.deepEqual(asc, ["B", "C", "A", "D"], "D has no 1Y return, so it stays last either way");
  });

  it("paginates the ranked set, not the page", () => {
    const page = query(list, { sort: "age", order: "desc", start: 1, length: 2 });
    assert.deepEqual(page.lists.map((f) => f.name), ["B", "C"]);
    assert.equal(page.total, 4, "total is the filtered set, not the slice");
  });
});
