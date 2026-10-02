// Audit #62 — portfolio-level risk and return, built from the scheme-level maths.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { portfolioSeries, sectorAllocation, portfolioMetrics } = require("../src/mf/portfolioMetrics");
const { ratiosFromSeries } = require("../src/mf/scheme");

const DAY = 86400;
const T0 = Date.parse("2025-01-01T00:00:00Z") / 1000;

/** n business-ish days of NAVs from a daily-return function. */
const series = (n, start, ret, from = T0) => {
  const out = [];
  let nav = start;
  for (let i = 0; i < n; i++) {
    out.push({ timestamp: from + i * DAY, nav });
    nav *= 1 + ret(i);
  }
  return out;
};

describe("portfolioSeries", () => {
  it("adds units × NAV per day and carries a fund's last NAV across its own holiday", () => {
    const a = [
      { timestamp: T0, nav: 10 },
      { timestamp: T0 + DAY, nav: 11 },
      { timestamp: T0 + 2 * DAY, nav: 12 },
    ];
    // Fund B skips day 2 (its AMC's holiday).
    const b = [
      { timestamp: T0, nav: 100 },
      { timestamp: T0 + 2 * DAY, nav: 90 },
    ];

    const out = portfolioSeries([{ units: 2, series: a }, { units: 1, series: b }]);

    assert.deepEqual(out.map((p) => p.nav), [2 * 10 + 100, 2 * 11 + 100, 2 * 12 + 90]);
  });

  it("starts when every fund exists — before that it would be a different portfolio", () => {
    const old = series(10, 10, () => 0.01);
    const young = series(4, 50, () => 0, T0 + 6 * DAY);

    const out = portfolioSeries([{ units: 1, series: old }, { units: 1, series: young }]);

    assert.equal(out.length, 4);
    assert.equal(out[0].timestamp, T0 + 6 * DAY);
  });
});

describe("portfolioMetrics", () => {
  const nifty = series(400, 20000, (i) => (i % 2 ? -0.01 : 0.011));
  const fund = series(400, 50, (i) => (i % 2 ? -0.008 : 0.009));
  const deps = {
    load: async (isin) => (isin === "INF000000001" ? { series: fund } : null),
    bench: async () => ({ series: nifty, label: "Nifty 50", isPriceIndex: true }),
    disclosure: async () => ({ sectors: [{ name: "Financials", pct: 40 }, { name: "IT", pct: 60 }] }),
  };

  it("measures the portfolio with scheme.js's own ratios, plus beta against the Nifty 50", async () => {
    const res = await portfolioMetrics(
      [
        { isin: "INF000000001", name: "Fund A", units: 100 },
        { isin: "", scheme_code: "NOISIN", name: "Fixture", units: 10 },
      ],
      deps
    );

    // One fund held: the portfolio IS that fund scaled, so every ratio must equal the
    // fund's own — which is exactly what reusing ratiosFromSeries guarantees.
    const own = ratiosFromSeries(fund);
    assert.equal(res.metrics.volatility, own.volatility);
    assert.equal(res.metrics.sharpe, own.sharpe);
    assert.equal(res.metrics.maxDrawdown, own.maxDrawdown);
    assert.equal(res.metrics.var95, own.var95);
    assert.ok(Number.isFinite(res.metrics.beta) && res.metrics.beta > 0, "beta comes from alphaBeta against the index");
    assert.equal(res.metrics.benchmark, "Nifty 50");
    assert.ok(res.metrics.annualisedReturn !== null);

    // A holding that cannot be priced is reported, not valued at a guess.
    assert.deepEqual(res.skipped, [{ name: "Fixture", reason: "No ISIN to price it by" }]);
    assert.equal(res.sectors.coveragePct, 100);
  });

  it("returns no metrics rather than invented ones when nothing can be priced", async () => {
    const res = await portfolioMetrics([{ isin: "INF999999999", name: "Unknown", units: 5 }], deps);

    assert.equal(res.metrics, null);
    assert.deepEqual(res.skipped, [{ name: "Unknown", reason: "No NAV history" }]);
  });
});

describe("sectorAllocation", () => {
  it("weights each fund's sectors by what is held in it, and says how much was covered", () => {
    const out = sectorAllocation([
      { value: 75, sectors: [{ name: "IT", pct: 100 }] },
      { value: 25, sectors: [{ name: "Banks", pct: 100 }] },
      { value: 100, sectors: [] }, // no disclosure uploaded
    ]);

    assert.deepEqual(out.rows, [
      { name: "IT", pct: 75 },
      { name: "Banks", pct: 25 },
    ]);
    assert.equal(out.coveragePct, 50);
  });
});
