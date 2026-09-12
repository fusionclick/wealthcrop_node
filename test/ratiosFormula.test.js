// The advanced-ratio definitions, pinned to numbers derived by hand.
//
// mf.test.js already checks that these are measured rather than invented (vol > 0,
// drawdown negative, sortino != sharpe). That catches a stub; it does not catch a wrong
// formula, and four of the five choices below are ones a reasonable person would "fix"
// in the wrong direction. Each is worth a number, not an inequality:
//
//   1. volatility divides by N, not N-1 (population, not sample)
//   2. Sharpe/Sortino use the ARITHMETIC mean annualised (mean x 252), which is the
//      definition the ratio is built on — not the CAGR the "1Y" card shows
//   3. downside deviation divides by N too, not by the count of below-target days
//   4. the Sortino target is the daily risk-free rate, not zero
//   5. max drawdown is measured over the same window as the rest, not over all history
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { ratiosFromSeries } = require("../src/mf/scheme");

/**
 * A series whose daily returns alternate exactly +1% / -1%, so every statistic can be
 * worked out on paper:
 *
 *   mean   = 0                       (126 of each)
 *   stdev  = 0.01                    (population; every deviation from 0 is +/-0.01)
 *   vol    = 0.01 x sqrt(252)        = 15.87%
 *   ann    = 0 x 252                 = 0%
 *   sharpe = (0 - 0.07) / 0.158745   = -0.44
 *
 *   hurdle = 0.07 / 252              = 0.000277...
 *   only the -1% days fall below it, so 126 terms of (-0.01 - hurdle)^2
 *   ddev   = sqrt(126 x (-0.01027..)^2 / 252) x sqrt(252) = 11.54%
 *   sortino= (0 - 0.07) / 0.115367   = -0.61
 */
const alternating = () => {
  const rows = [{ timestamp: 0, nav: 100 }];
  for (let i = 1; i <= 252; i++) {
    rows.push({ timestamp: 86400 * i, nav: rows[i - 1].nav * (1 + (i % 2 ? 0.01 : -0.01)) });
  }
  return rows;
};

describe("advanced ratio formulas", () => {
  it("matches the hand-computed values for a series with known statistics", () => {
    const r = ratiosFromSeries(alternating());

    assert.equal(r.volatility, 15.87, "0.01 x sqrt(252); 15.90 would mean it switched to N-1");
    assert.equal(r.sharpe, -0.44, "(0 - 7%) / 15.87%");
    assert.equal(r.sortino, -0.61, "(0 - 7%) / 11.54% downside deviation");
    assert.equal(r.riskFreeRate, 7);
    assert.equal(r.window, 252);
  });

  it("sortino divides by N, so downside deviation stays below total volatility", () => {
    const r = ratiosFromSeries(alternating());
    // Dividing by the count of below-target days instead would give 14.45% here — above
    // 11.54%, and it would push sortino (-0.61) closer to sharpe (-0.44) rather than away.
    // Sortino must be the more punishing of the two for a loss-making fund.
    assert.ok(Math.abs(r.sortino) > Math.abs(r.sharpe), "downside dev < total vol");
  });

  it("the Sortino target is the risk-free rate, not zero", () => {
    // Every return is exactly +0.02%/day, which is positive but BELOW the daily risk-free
    // hurdle. Against a zero target nothing is "downside", downside deviation is 0 and
    // sortino would be null. Against the risk-free target every day counts.
    const rows = [{ timestamp: 0, nav: 100 }];
    for (let i = 1; i <= 252; i++) rows.push({ timestamp: 86400 * i, nav: rows[i - 1].nav * 1.0002 });
    const r = ratiosFromSeries(rows);

    assert.notEqual(r.sortino, null, "a fund that never beats the risk-free rate has a sortino");
    assert.ok(r.sortino < 0, "underperforming the hurdle every single day is negative");
  });

  it("max drawdown is the worst peak-to-trough inside the measured window", () => {
    // Flat for a year, then a clean 20% fall on the last day and no recovery.
    const rows = [];
    for (let i = 0; i < 260; i++) rows.push({ timestamp: 86400 * i, nav: 100 });
    rows.push({ timestamp: 86400 * 260, nav: 80 });
    assert.equal(ratiosFromSeries(rows).maxDrawdown, -20);

    // A crash that happened BEFORE the window must not be reported as current risk.
    const old = [{ timestamp: 0, nav: 100 }, { timestamp: 86400, nav: 50 }];
    for (let i = 2; i < 400; i++) old.push({ timestamp: 86400 * i, nav: 50 });
    assert.equal(ratiosFromSeries(old).maxDrawdown, null, "no fall inside the last 252 days");
  });

  it("says nothing rather than guessing when there is too little history", () => {
    assert.deepEqual(ratiosFromSeries([]), {});
    assert.deepEqual(ratiosFromSeries([{ timestamp: 1, nav: 10 }]), {});
    // 19 returns is under the 20-point floor.
    const short = Array.from({ length: 20 }, (_, i) => ({ timestamp: 86400 * i, nav: 100 + i }));
    assert.deepEqual(ratiosFromSeries(short), {});
  });
});
